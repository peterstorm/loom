/**
 * Adjudication: which candidate becomes a published finding, and on what vote.
 *
 * A hunter's candidate is a claim, not a result. Three independent facts decide
 * whether the run may publish it as `confirmed`:
 *
 *   1. a verification verdict exists for its fingerprint (INV-S3);
 *   2. that verdict was cast on a CATALOG profile different from the one that
 *      hunted — a model agreeing with itself is not verification. Both sides of
 *      that comparison are catalog profile ids (`focused-review`, `refutation`),
 *      never the run's budget profile (`quick | standard | deep`): comparing the
 *      two vocabularies made the guard vacuous, because a hunter's ballot is
 *      never literally the string "standard";
 *   3. the verdict is `critical` (loom's ballot: this claim blocks). An
 *      `advisory` vote means the claim does not survive as confirmed: with a
 *      named missing fact it becomes a lead, without one it is rejected.
 *
 * Severity ownership (ADR-0066 D3): the hunt records a five-level
 * `overall_severity`, but loom's `critical|advisory` ballot is the decision.
 * Demotion never silently rewrites severity — a demoted claim becomes
 * `needs_validation`, which by grammar carries no severity at all.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { match } from "ts-pattern";
import { z } from "zod/v4";
import { compareStrings } from "./ordering";
import { catalogProfileOfAgent, parseLlmProfileId, type LlmProfileId } from "./model-profiles";
import {
  failure,
  isNonEmpty,
  parseArtifactDigest,
  parseOrchestrationRunId,
  parseRequestId,
  parseSlotId,
  success,
  type DomainResult,
} from "./orchestration-contract/identity";
import { SECURITY_VERIFICATION_PROGRAM } from "./orchestration-contract/programs";
import {
  expecting,
  fingerprintSchema,
  isVisibleText,
  parseWire,
  parsedBy,
  positiveIntegerSchema,
  type WireViolation,
} from "./security-audit-contract";
import { catalogAgentOfOwner, coverageSettled, type CoverageLedger } from "./security-coverage";
import {
  sortByFingerprint,
  type ConfirmedFinding,
  type NeedsValidationFinding,
  type RejectedFinding,
  type SecurityFinding,
} from "./security-findings";

/** The one catalog role a ballot may be cast by. */
export const SECURITY_VERIFIER_ROLE = "security-verifier-agent" as const;
/** The catalog profile every ballot is cast on: the one the Agent Catalog
 *  assigns `SECURITY_VERIFIER_ROLE`. A binding naming any other profile names a
 *  spawn the verifier role never ran under. */
const SECURITY_VERIFIER_PROFILE = catalogProfileOfAgent(SECURITY_VERIFIER_ROLE);

/** Why `profile` cannot be the profile a ballot was cast on, or null when it is
 *  the one the catalog assigns the verifier role. Read by the binding parser and
 *  by the verifier-side binder, so the two refuse the same profiles. */
export const catalogVerifierProfileProblem = (profile: LlmProfileId): string | null =>
  profile === SECURITY_VERIFIER_PROFILE
    ? null
    : `profile ${profile} is not ${String(SECURITY_VERIFIER_PROFILE)}, the profile the catalog assigns ${SECURITY_VERIFIER_ROLE}`;

declare const missingFactBrand: unique symbol;
/** The one fact a demoting vote names: visible prose, never blank. Only
 *  the vote schema's `missingFact` produces it, so adjudication reads a field that cannot be
 *  blank by type instead of re-checking it. */
export type MissingFact = string & Readonly<{ [missingFactBrand]: true }>;

/** The vote grammar's one rule for a missing fact: visible prose. A blank
 *  string is refused (it is not "no missing fact" — that is `null`), so nothing
 *  downstream normalizes it. Present on purpose: an absent fact is a verifier
 *  that never answered the question, not one that answered "none". */
const missingFactSchema = z
  .custom<MissingFact>((value) => isVisibleText(value), {
    error: (issue) => (issue.input === undefined ? "required (null when none)" : "expected null or visible prose"),
  })
  .nullable();

/**
 * The four fields a verifier itself decides about one fingerprint — no agent,
 * profile or wave. Shared by the persisted ballot and the verifier's own result
 * wire (`core/security-verification`), so the two cannot disagree about what a
 * well-formed vote is.
 *
 * `missingFact` is load-bearing: an `advisory` vote WITH one demotes the claim
 * to a lead, WITHOUT one it is rejected.
 */
export const verifierVoteShape = {
  fingerprint: fingerprintSchema,
  /** loom's refutation ballot: `critical` = the claim blocks; `advisory` = it
   *  does not survive as a confirmed finding. */
  vote: z.enum(["critical", "advisory"], expecting("expected critical or advisory")),
  reason: z.custom<string>((value) => isVisibleText(value), expecting("requires visible prose")),
  /** The one fact absent when the vote is advisory for lack of proof. */
  missingFact: missingFactSchema,
};
export type VerifierVote = Readonly<z.output<z.ZodObject<typeof verifierVoteShape>>>;

/**
 * Where a ballot came from, taken from AUTHORITY only (ADR-0067 D3): the
 * minted request the verifier spawn answered and the digest of its captured
 * transcript. Nothing here is read from the verifier's payload, so a ballot
 * cannot carry a role or profile its spawn did not have.
 *
 * The profile is the one the catalog assigns the verifier role: a binding
 * naming another names a spawn that role never ran under — a tampered
 * `verdicts.json`. If the catalog ever re-profiles the verifier, ballots cast
 * under the old profile are refused, never counted under a profile the catalog
 * no longer gives that role. A missing or malformed binding is a refusal (D5).
 */
const ballotBindingSchema = z
  .strictObject(
    {
      /** The program that issues every verifier spawn a ballot may come from
       *  (owned by the orchestration contract's program vocabulary). */
      program: z.literal(SECURITY_VERIFICATION_PROGRAM, expecting(`expected ${SECURITY_VERIFICATION_PROGRAM}`)),
      /** The verification run that issued the request. Each identity field is
       *  read by the identity grammar's own parser (`parsedBy`). */
      runId: parsedBy(parseOrchestrationRunId),
      requestId: parsedBy(parseRequestId),
      slotId: parsedBy(parseSlotId),
      attempt: z.literal([1, 2], expecting("expected 1 or 2")),
      role: z.literal(SECURITY_VERIFIER_ROLE, expecting(`expected ${SECURITY_VERIFIER_ROLE}`)),
      /** The catalog profile the request was MINTED under. */
      profile: parsedBy(parseLlmProfileId, "expected a catalog profile").superRefine((profile, ctx) => {
        const problem = catalogVerifierProfileProblem(profile);
        if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
      }),
      /** SHA-256 of the captured transcript bytes the verdict was admitted from
       *  (the capture receipt's digest). */
      captureDigest: parsedBy(parseArtifactDigest, "expected a sha256 capture digest"),
    },
    { error: (issue) => (issue.code === "invalid_type" ? "expected the binding a verification run published" : undefined) },
  )
  .readonly();
export type BallotBinding = z.output<typeof ballotBindingSchema>;

/** One verifier's ballot about one fingerprint, bound to the spawn that cast it.
 *  `agent` and `profile` are read from `binding`, never from a payload. */
const verificationVerdictSchema = z
  .strictObject({
    ...verifierVoteShape,
    /** The audit wave the verification run was issued for. */
    wave: positiveIntegerSchema,
    binding: ballotBindingSchema,
  })
  .readonly();
export type VerificationVerdict = z.output<typeof verificationVerdictSchema>;

export type VerificationGap =
  | Readonly<{ kind: "unverified"; fingerprint: string }>
  /** Every ballot came from a profile that hunted. */
  | Readonly<{ kind: "same-profile"; fingerprint: string; profile: string }>
  /** The ledger records no hunting profile for this claim, so "a different
   *  profile verified it" cannot be established at all. Fail closed: an
   *  unattributable claim is not a verified one. */
  | Readonly<{ kind: "unattributed"; fingerprint: string }>;

export type Adjudication = Readonly<{
  /** Findings that may be published as confirmed, unchanged. */
  confirmed: readonly ConfirmedFinding[];
  /** Advisory votes demoted to leads, with the verifier's missing fact attached. */
  demoted: readonly NeedsValidationFinding[];
  /** Advisory votes with no missing fact: rejected, retaining the verifier's reason. */
  rejected: readonly RejectedFinding[];
  /** Confirmed candidates that could not be adjudicated at all. */
  gaps: readonly VerificationGap[];
}>;

/** The one ballot order: fingerprint, issuing run, request, wave. */
const compareVerdicts = (left: VerificationVerdict, right: VerificationVerdict): number =>
  compareStrings(left.fingerprint, right.fingerprint) ||
  compareStrings(left.binding.runId, right.binding.runId) ||
  compareStrings(left.binding.requestId, right.binding.requestId) ||
  left.wave - right.wave;

/** Every verdict for one fingerprint, in the one ballot order. */
const verdictsFor = (
  verdicts: readonly VerificationVerdict[],
  fingerprint: string,
): readonly VerificationVerdict[] =>
  verdicts.filter((verdict) => verdict.fingerprint === fingerprint).sort(compareVerdicts);

type AdjudicationInput = Readonly<{
  findings: readonly SecurityFinding[];
  verdicts: readonly VerificationVerdict[];
  /** Every catalog profile that hunted in this run, derived from the ledger by
   *  `huntingProfiles` — never caller-supplied, which is why this step is
   *  reached only through `adjudicateRun`. A vote cast on one of these profiles
   *  verifies nothing; an empty list means the run cannot say who hunted, so
   *  no confirmed claim is publishable. */
  huntProfiles: readonly LlmProfileId[];
}>;

/**
 * Apply every verdict. `gaps` are not failures of the audit — they are the
 * findings the run must not publish as confirmed; `publish` refuses on a
 * non-empty `gaps` so an unverified claim cannot slip out as a result.
 *
 * The deciding ballot among the independent ones: the first `critical` if any
 * (a panel that splits could not refute, so the claim stands), else the first.
 */
function adjudicateCandidates(input: AdjudicationInput): Adjudication {
  const confirmed: ConfirmedFinding[] = [];
  const demoted: NeedsValidationFinding[] = [];
  const rejected: RejectedFinding[] = [];
  const gaps: VerificationGap[] = [];

  for (const finding of sortByFingerprint(input.findings)) {
    if (finding.verdict !== "confirmed") continue;
    if (input.huntProfiles.length === 0) {
      gaps.push({ kind: "unattributed", fingerprint: finding.fingerprint });
      continue;
    }
    const verdicts = verdictsFor(input.verdicts, finding.fingerprint);
    if (verdicts.length === 0) {
      gaps.push({ kind: "unverified", fingerprint: finding.fingerprint });
      continue;
    }
    // The profile is the MINTED request's (ADR-0067 D5), never a payload field.
    const independent = verdicts.filter((verdict) => !input.huntProfiles.includes(verdict.binding.profile));
    if (!isNonEmpty(independent)) {
      gaps.push({ kind: "same-profile", fingerprint: finding.fingerprint, profile: verdicts[0].binding.profile });
      continue;
    }
    const decision = independent.find((verdict) => verdict.vote === "critical") ?? independent[0];
    if (decision.vote === "critical") {
      confirmed.push(finding);
      continue;
    }
    if (decision.missingFact !== null) {
      demoted.push(toLead(finding, decision.missingFact));
      continue;
    }
    rejected.push(toRejected(finding, decision));
  }

  return {
    confirmed: sortByFingerprint(confirmed),
    demoted: sortByFingerprint(demoted),
    rejected: sortByFingerprint(rejected),
    gaps,
  };
}

const toLead = (finding: ConfirmedFinding, missingFact: MissingFact): NeedsValidationFinding => ({
  verdict: "needs_validation",
  fingerprint: finding.fingerprint,
  title: finding.title,
  description: finding.description,
  claimed_root_cause: finding.root_cause,
  trace: finding.trace,
  evidence: finding.evidence,
  blockers: [missingFact],
  validation_plan: { local: finding.execution.instructions.join("; ") },
});

const toRejected = (finding: ConfirmedFinding, verdict: VerificationVerdict): RejectedFinding => ({
  verdict: "rejected",
  fingerprint: finding.fingerprint,
  title: finding.title,
  description: finding.description,
  claimed_root_cause: finding.root_cause,
  trace: finding.trace,
  evidence: finding.evidence,
  reason: verdict.reason,
});

/** The full decision about a run: findings and blockers come from ONE
 *  computation, so they cannot disagree. */
export type RunAdjudication = Readonly<{
  adjudication: Adjudication;
  /** The document `publish` writes: adjudicated records plus untouched passthroughs. */
  findings: readonly SecurityFinding[];
  /** Blocking reasons that prevent publication. Empty means the run may publish
   *  what it has. */
  blockers: readonly string[];
}>;

/** Why a confirmed claim failed to earn a ballot, in the words the operator reads
 *  at publish time. Exhaustive over the gap union, so a new gap kind cannot be
 *  added without deciding what it blocks. */
const blockerFor = (gap: VerificationGap): string =>
  match(gap)
    .with({ kind: "unverified" }, (value) => `confirmed claim ${value.fingerprint} has no verification verdict`)
    .with({ kind: "same-profile" }, (value) => `confirmed claim ${value.fingerprint} was verified only on the hunt profile ${value.profile}`)
    .with({ kind: "unattributed" }, (value) => `confirmed claim ${value.fingerprint} has no recorded hunting profile, so no ballot can be shown to come from another one`)
    .exhaustive();

/** A hunter the Agent Catalog cannot place: the run knows the owner that hunted
 *  but cannot say which model profile it ran under. */
export type HuntingProfileError = Readonly<{ kind: "unresolvable-hunter"; agentId: string }>;

/** The catalog profiles that actually hunted, derived from the ledger's owned
 *  and archived units. Adjudication compares a ballot's profile against this
 *  set, so "verified by a different model" is read from the run's own record of
 *  who ran rather than from a second, caller-supplied field. Empty means the
 *  ledger names no hunter — a state adjudication refuses to treat as verified.
 *
 *  An owner id is an attempt identity (`security-hunter-agent--2`); its catalog
 *  agent is read back with `catalogAgentOfOwner`, the ledger's own grammar.
 *
 *  Fail closed on an owner the catalog cannot place. This function used to
 *  FILTER unresolvable owners out — so a hunter with no catalog row hunted,
 *  contributed nothing to the independence set, and a verifier on that hunter's
 *  own model profile was then counted as independent. An unanswerable question
 *  is a refusal, not an empty answer. Archived attempts count too: their owners
 *  hunted in an earlier wave of this same run. */
export function huntingProfiles(ledger: CoverageLedger): DomainResult<readonly LlmProfileId[], HuntingProfileError> {
  const profiles = new Set<LlmProfileId>();
  for (const unit of ledger) {
    for (const agentId of [unit.agent_id, ...unit.attempts.map((attempt) => attempt.agent_id)]) {
      if (agentId === null) continue;
      const profile = catalogProfileOfAgent(catalogAgentOfOwner(agentId));
      if (profile === null) return failure({ kind: "unresolvable-hunter" as const, agentId });
      profiles.add(profile);
    }
  }
  return success([...profiles].sort(compareStrings));
}

/**
 * Adjudicate a run ONCE, from its own records. The two facts INV-S3 rests on —
 * which profiles hunted and whether coverage settled — are derived HERE from the
 * ledger, not handed in by a caller, so the independence rule and its
 * fail-closed refusal live in one tested place.
 */
export function adjudicateRun(
  input: Readonly<{ ledger: CoverageLedger; findings: readonly SecurityFinding[]; verdicts: readonly VerificationVerdict[] }>,
): DomainResult<RunAdjudication, HuntingProfileError> {
  const huntProfiles = huntingProfiles(input.ledger);
  if (!huntProfiles.ok) return huntProfiles;
  const adjudication = adjudicateCandidates({ findings: input.findings, verdicts: input.verdicts, huntProfiles: huntProfiles.value });
  const blockers = adjudication.gaps.map(blockerFor);
  if (!coverageSettled(input.ledger)) blockers.push("coverage ledger still has planned, in-progress or blocked units");
  const passthrough = input.findings.filter((finding) => finding.verdict !== "confirmed");
  return success({
    adjudication,
    findings: sortByFingerprint([...adjudication.confirmed, ...adjudication.demoted, ...adjudication.rejected, ...passthrough]),
    blockers,
  });
}

// --- Wire parsing ---

/** The adjudication volume's name for the shared wire diagnostic. */
export type VerdictViolation = WireViolation;

export type VerdictError = Readonly<{ kind: "invalid-verdicts"; violations: readonly VerdictViolation[] }>;

/** A ballot's identity in `verdicts.json`: one request casts at most one
 *  ballot per fingerprint. */
const castKey = (verdict: VerificationVerdict): string =>
  JSON.stringify([verdict.fingerprint, verdict.binding.runId, verdict.binding.requestId]);

/**
 * The bound ballots `verdicts.json` holds (ADR-0067 D3/D5). Fail-closed: an
 * unknown key is a violation, every field is checked, and a ballot WITHOUT a
 * well-formed binding is a refusal — not an unverified gap — because a ballot
 * that cannot name the spawn that cast it is exactly the self-reported ballot
 * this shape exists to end.
 */
const verificationVerdictsSchema = z
  .array(verificationVerdictSchema, expecting("expected a top-level array"))
  .superRefine((verdicts, ctx) => {
    const cast = new Set<string>();
    verdicts.forEach((verdict, index) => {
      const key = castKey(verdict);
      if (cast.has(key)) {
        ctx.addIssue({ code: "custom", path: [index], message: `request ${verdict.binding.requestId} already cast a ballot on ${verdict.fingerprint}` });
      }
      cast.add(key);
    });
  });

/**
 * Parse the bound ballots `verdicts.json` holds. Total: every violation of
 * every ballot comes back, so one bad ballot never hides behind another's. The
 * result is sorted by (fingerprint, run, request, wave) so the same ballots
 * always produce the same bytes.
 */
export function parseVerificationVerdicts(raw: unknown): DomainResult<readonly VerificationVerdict[], VerdictError> {
  const parsed = parseWire(verificationVerdictsSchema, raw, "verdicts");
  return parsed.ok
    ? success([...parsed.value].sort(compareVerdicts))
    : failure({ kind: "invalid-verdicts" as const, violations: parsed.error });
}
