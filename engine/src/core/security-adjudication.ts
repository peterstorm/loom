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
import { compareStrings } from "./ordering";
import { catalogProfileOfAgent, parseLlmProfileId, type LlmProfileId } from "./model-profiles";
import { failure, parseOrchestrationRunId, parseRequestId, parseSlotId, success, type DomainResult } from "./orchestration-contract/identity";
import { isSecurityFingerprint, isVisibleText, isWireRecord, type WireViolation } from "./security-audit-contract";
import { catalogAgentOfOwner, coverageSettled, type CoverageLedger } from "./security-coverage";
import {
  sortByFingerprint,
  type ConfirmedFinding,
  type NeedsValidationFinding,
  type RejectedFinding,
  type SecurityFinding,
} from "./security-findings";

/** The program that issues every verifier spawn a ballot may come from. */
export const SECURITY_VERIFICATION_PROGRAM = "security-verification" as const;
/** The one catalog role a ballot may be cast by. */
export const SECURITY_VERIFIER_ROLE = "security-verifier-agent" as const;

/**
 * Where a ballot came from, taken from AUTHORITY only (ADR-0067 D3): the
 * minted request the verifier spawn answered and the digest of its captured
 * transcript. Nothing here is read from the verifier's payload, so a ballot
 * cannot carry a role or profile its spawn did not have.
 */
export type BallotBinding = Readonly<{
  program: typeof SECURITY_VERIFICATION_PROGRAM;
  /** The verification run that issued the request. */
  runId: string;
  requestId: string;
  slotId: string;
  attempt: 1 | 2;
  role: typeof SECURITY_VERIFIER_ROLE;
  /** The catalog profile the request was MINTED under. */
  profile: LlmProfileId;
  /** SHA-256 of the captured transcript bytes the verdict was admitted from
   *  (the capture receipt's digest). */
  captureDigest: string;
}>;

/** One verifier's ballot about one fingerprint, bound to the spawn that cast it.
 *  `agent` and `profile` are read from `binding`, never from a payload. */
export type VerificationVerdict = Readonly<{
  fingerprint: string;
  /** loom's refutation ballot: `critical` = the claim blocks; `advisory` = it
   *  does not survive as a confirmed finding. */
  vote: "critical" | "advisory";
  reason: string;
  /** The one fact absent when the vote is advisory for lack of proof. */
  missingFact: string | null;
  /** The audit wave the verification run was issued for. */
  wave: number;
  binding: BallotBinding;
}>;

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

/** One verdict decides: a single `critical` survives, and any `advisory`
 *  without a `critical` beside it demotes. Ties break toward the blocking vote
 *  ONLY when a critical exists — a panel that splits is a panel that could not
 *  refute, and the claim stands as confirmed. */
const decide = (
  first: VerificationVerdict,
  rest: readonly VerificationVerdict[],
): VerificationVerdict => [first, ...rest].find((verdict) => verdict.vote === "critical") ?? first;

export type AdjudicationInput = Readonly<{
  findings: readonly SecurityFinding[];
  verdicts: readonly VerificationVerdict[];
  /** Every catalog profile that hunted in this run, derived from the ledger's
   *  owned units (`huntingProfiles`). A vote cast on one of these profiles
   *  verifies nothing; an empty list means the run cannot say who hunted, so
   *  no confirmed claim is publishable. */
  huntProfiles: readonly string[];
}>;

/**
 * Apply every verdict. `gaps` are not failures of the audit — they are the
 * findings the run must not publish as confirmed; `publish` refuses on a
 * non-empty `gaps` so an unverified claim cannot slip out as a result.
 */
export function adjudicateCandidates(input: AdjudicationInput): Adjudication {
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
    const [first, ...rest] = verdicts.filter((verdict) => !input.huntProfiles.includes(verdict.binding.profile));
    if (first === undefined) {
      gaps.push({ kind: "same-profile", fingerprint: finding.fingerprint, profile: verdicts[0].binding.profile });
      continue;
    }
    const decision = decide(first, rest);
    if (decision.vote === "critical") {
      confirmed.push(finding);
      continue;
    }
    if (decision.missingFact !== null && decision.missingFact.trim() !== "") {
      demoted.push(toLead(finding, decision));
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

const toLead = (finding: ConfirmedFinding, verdict: VerificationVerdict): NeedsValidationFinding => ({
  verdict: "needs_validation",
  fingerprint: finding.fingerprint,
  title: finding.title,
  description: finding.description,
  claimed_root_cause: finding.root_cause,
  trace: finding.trace,
  evidence: finding.evidence,
  blockers: [verdict.missingFact ?? verdict.reason],
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

/** The keys a persisted ballot carries in `verdicts.json`. */
export const VERDICT_KEYS: readonly string[] = ["fingerprint", "vote", "reason", "missingFact", "wave", "binding"];

/** The keys of a ballot's binding: every one read from authority at import. */
export const BALLOT_BINDING_KEYS: readonly string[] = [
  "program", "runId", "requestId", "slotId", "attempt", "role", "profile", "captureDigest",
];

/**
 * Parse the bound ballots `verdicts.json` holds (ADR-0067 D3/D5).
 *
 * Fail-closed and total: an unknown key is a violation, every field is
 * checked, and a ballot WITHOUT a well-formed binding is a refusal — not an
 * unverified gap — because a ballot that cannot name the spawn that cast it is
 * exactly the self-reported ballot this shape exists to end. One request casts
 * at most one ballot per fingerprint. The result is sorted by (fingerprint,
 * run, request, wave) so the same ballots always produce the same bytes.
 */
export function parseVerificationVerdicts(raw: unknown): DomainResult<readonly VerificationVerdict[], VerdictError> {
  if (!Array.isArray(raw)) {
    return failure({ kind: "invalid-verdicts" as const, violations: [{ path: "verdicts", message: "expected a top-level array" }] });
  }
  const violations: VerdictViolation[] = [];
  const verdicts: VerificationVerdict[] = [];
  const cast = new Set<string>();
  (raw as readonly unknown[]).forEach((entry, index) => {
    const parsed = parseVerdict(entry, `verdicts[${index}]`);
    if (!parsed.ok) {
      violations.push(...parsed.error);
      return;
    }
    const { fingerprint, binding } = parsed.value;
    const key = JSON.stringify([fingerprint, binding.runId, binding.requestId]);
    if (cast.has(key)) {
      violations.push({ path: `verdicts[${index}]`, message: `request ${binding.requestId} already cast a ballot on ${fingerprint}` });
      return;
    }
    cast.add(key);
    verdicts.push(parsed.value);
  });
  if (violations.length > 0) return failure({ kind: "invalid-verdicts" as const, violations });
  return success([...verdicts].sort(compareVerdicts));
}

/** One persisted ballot, or every violation it carries (accumulated per
 *  entry, so one bad ballot never hides behind another's). */
function parseVerdict(entry: unknown, base: string): DomainResult<VerificationVerdict, readonly VerdictViolation[]> {
  if (!isWireRecord(entry)) return failure([{ path: base, message: "expected an object" }]);
  const local = [...unknownKeyViolations(entry, VERDICT_KEYS, base), ...voteViolations(entry, base)];
  if (typeof entry.wave !== "number" || !Number.isInteger(entry.wave) || entry.wave < 1) {
    local.push({ path: `${base}.wave`, message: "expected a positive integer" });
  }
  const binding = parseBallotBinding(entry.binding, `${base}.binding`);
  if (!binding.ok) return failure([...local, ...binding.error]);
  if (local.length > 0) return failure(local);
  return success({
    fingerprint: String(entry.fingerprint),
    vote: entry.vote === "critical" ? "critical" : "advisory",
    reason: String(entry.reason),
    missingFact: normalizedMissingFact(entry.missingFact),
    wave: Number(entry.wave),
    binding: binding.value,
  });
}

/** `null` and blank both mean "no missing fact", so a verifier cannot demote a
 *  claim by accidentally sending an empty string. */
export const normalizedMissingFact = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/** Every key of `record` the shape does not declare, at `base`. */
export const unknownKeyViolations = (
  record: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  base: string,
): VerdictViolation[] =>
  Object.keys(record).filter((key) => !allowed.includes(key)).map((key) => ({ path: `${base}.${key}`, message: "unknown field" }));

/**
 * The four fields a verifier itself decides — fingerprint, vote, reason and
 * missing fact — checked at `base`. Shared by the persisted ballot and the
 * verifier's own result wire (`core/security-verification`), so the two cannot
 * disagree about what a well-formed vote is.
 *
 * `missingFact` is load-bearing: an `advisory` vote WITH one demotes the claim
 * to a lead, WITHOUT one it is rejected.
 */
export function voteViolations(record: Readonly<Record<string, unknown>>, base: string): VerdictViolation[] {
  const local: VerdictViolation[] = [];
  if (!isSecurityFingerprint(record.fingerprint)) local.push({ path: `${base}.fingerprint`, message: "invalid fingerprint" });
  if (record.vote !== "critical" && record.vote !== "advisory") {
    local.push({ path: `${base}.vote`, message: "expected critical or advisory" });
  }
  if (!isVisibleText(record.reason)) local.push({ path: `${base}.reason`, message: "requires visible prose" });
  if (record.missingFact !== null && !isVisibleText(record.missingFact)) {
    local.push({ path: `${base}.missingFact`, message: "expected null or visible prose" });
  }
  return local;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A ballot's binding: every identity in its grammar, the program and role the
 *  closed verification vocabulary, the profile a catalog profile, the capture
 *  digest a sha256. A missing or malformed binding is a refusal (D5). */
export function parseBallotBinding(raw: unknown, base: string): DomainResult<BallotBinding, readonly VerdictViolation[]> {
  if (!isWireRecord(raw)) return failure([{ path: base, message: "expected the binding a verification run published" }]);
  const local = unknownKeyViolations(raw, BALLOT_BINDING_KEYS, base);
  const runId = parseOrchestrationRunId(raw.runId);
  const requestId = parseRequestId(raw.requestId);
  const slotId = parseSlotId(raw.slotId);
  const profile = parseLlmProfileId(raw.profile);
  if (raw.program !== SECURITY_VERIFICATION_PROGRAM) local.push({ path: `${base}.program`, message: `expected ${SECURITY_VERIFICATION_PROGRAM}` });
  if (!runId.ok) local.push({ path: `${base}.runId`, message: runId.error.message });
  if (!requestId.ok) local.push({ path: `${base}.requestId`, message: requestId.error.message });
  if (!slotId.ok) local.push({ path: `${base}.slotId`, message: slotId.error.message });
  if (raw.attempt !== 1 && raw.attempt !== 2) local.push({ path: `${base}.attempt`, message: "expected 1 or 2" });
  if (raw.role !== SECURITY_VERIFIER_ROLE) local.push({ path: `${base}.role`, message: `expected ${SECURITY_VERIFIER_ROLE}` });
  if (!profile.ok) local.push({ path: `${base}.profile`, message: "expected a catalog profile" });
  if (typeof raw.captureDigest !== "string" || !SHA256_HEX.test(raw.captureDigest)) {
    local.push({ path: `${base}.captureDigest`, message: "expected a sha256 capture digest" });
  }
  if (local.length > 0 || !runId.ok || !requestId.ok || !slotId.ok || !profile.ok) return failure(local);
  return success({
    program: SECURITY_VERIFICATION_PROGRAM,
    runId: runId.value,
    requestId: requestId.value,
    slotId: slotId.value,
    attempt: raw.attempt === 2 ? 2 : 1,
    role: SECURITY_VERIFIER_ROLE,
    profile: profile.value,
    captureDigest: String(raw.captureDigest),
  });
}
