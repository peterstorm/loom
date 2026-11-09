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
 * Severity ownership (ADR-0064 D3): the hunt records a five-level
 * `overall_severity`, but loom's `critical|advisory` ballot is the decision.
 * Demotion never silently rewrites severity — a demoted claim becomes
 * `needs_validation`, which by grammar carries no severity at all.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { match } from "ts-pattern";
import { compareStrings } from "./ordering";
import { catalogProfileOfAgent, LLM_PROFILE_IDS, type LlmProfileId } from "./model-profiles";
import { failure, success, type DomainResult } from "./orchestration-contract/identity";
import { isSecurityAgentId, isSecurityFingerprint, isVisibleText, isWireRecord, type WireViolation } from "./security-audit-contract";
import { catalogAgentOfOwner, coverageSettled, type CoverageLedger } from "./security-coverage";
import {
  sortByFingerprint,
  type ConfirmedFinding,
  type NeedsValidationFinding,
  type RejectedFinding,
  type SecurityFinding,
} from "./security-findings";

/** One verifier's ballot about one fingerprint. */
export type VerificationVerdict = Readonly<{
  schemaVersion: 1;
  kind: "security-verdict";
  fingerprint: string;
  /** loom's refutation ballot: `critical` = the claim blocks; `advisory` = it
   *  does not survive as a confirmed finding. */
  vote: "critical" | "advisory";
  reason: string;
  /** The one fact absent when the vote is advisory for lack of proof. */
  missingFact: string | null;
  /** The verifier's agent name and catalog profile, recorded so `publish` can
   *  prove the vote came from a catalog profile that did not hunt. The parser
   *  requires `profile` to be the catalog profile of `agent`, so a ballot cannot
   *  claim a profile its own agent does not sit on. */
  agent: string;
  profile: string;
  wave: number;
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

/** Every verdict for one fingerprint, in a deterministic order (agent, then wave). */
const verdictsFor = (
  verdicts: readonly VerificationVerdict[],
  fingerprint: string,
): readonly VerificationVerdict[] =>
  verdicts
    .filter((verdict) => verdict.fingerprint === fingerprint)
    .sort((left, right) => compareStrings(left.agent, right.agent) || left.wave - right.wave);

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
    const [first, ...rest] = verdicts.filter((verdict) => !input.huntProfiles.includes(verdict.profile));
    if (first === undefined) {
      gaps.push({ kind: "same-profile", fingerprint: finding.fingerprint, profile: verdicts[0].profile });
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

/** The keys a ballot may carry. Exported so the agent-doc test pins the verifier
 *  document to THIS list rather than to a hand-copied one: a doc that names a
 *  key this list omits describes a ballot the engine refuses wholesale. */
export const VERDICT_KEYS: readonly string[] = [
  "schemaVersion", "kind", "fingerprint", "vote", "reason", "missingFact", "agent", "profile", "wave",
];

/**
 * Parse the ballots a verifier returns.
 *
 * Fail-closed and total: an unknown key is a violation (a verifier inventing a
 * field means the contract drifted), every field is checked, and the result is
 * sorted by (fingerprint, agent, wave) so two runs casting the same ballots
 * produce the same bytes.
 *
 * `missingFact` is load-bearing: an `advisory` vote WITH one demotes the claim
 * to a lead, WITHOUT one it is rejected. `null` and `""` both mean "no missing
 * fact", so a verifier cannot demote by accidentally sending an empty string.
 */
export function parseVerificationVerdicts(raw: unknown): DomainResult<readonly VerificationVerdict[], VerdictError> {
  if (!Array.isArray(raw as unknown)) {
    return failure({
      kind: "invalid-verdicts" as const,
      violations: [{ path: "verdicts", message: "expected a top-level array" }],
    });
  }
  const entries = raw as readonly unknown[];
  const violations: VerdictViolation[] = [];
  const verdicts: VerificationVerdict[] = [];

  entries.forEach((entry, index) => {
    const base = `verdicts[${index}]`;
    if (!isWireRecord(entry)) {
      violations.push({ path: base, message: "expected an object" });
      return;
    }
    const local: VerdictViolation[] = [];
    const record = entry;
    for (const key of Object.keys(record)) {
      if (!VERDICT_KEYS.includes(key)) local.push({ path: `${base}.${key}`, message: "unknown field" });
    }
    if (record.schemaVersion !== 1) local.push({ path: `${base}.schemaVersion`, message: "expected 1" });
    if (record.kind !== "security-verdict") local.push({ path: `${base}.kind`, message: "expected security-verdict" });
    if (!isSecurityFingerprint(record.fingerprint)) local.push({ path: `${base}.fingerprint`, message: "invalid fingerprint" });
    if (record.vote !== "critical" && record.vote !== "advisory") {
      local.push({ path: `${base}.vote`, message: "expected critical or advisory" });
    }
    if (!isVisibleText(record.reason)) local.push({ path: `${base}.reason`, message: "requires visible prose" });
    if (record.missingFact !== null && !isVisibleText(record.missingFact)) {
      local.push({ path: `${base}.missingFact`, message: "expected null or visible prose" });
    }
    if (!isSecurityAgentId(record.agent)) local.push({ path: `${base}.agent`, message: "expected a catalog agent id" });
    // The profile is not free prose: it must be a catalog profile, and it must
    // be the one this agent's policy assigns it. Otherwise a hunter writes
    // `profile: "refutation"` on its own ballot and INV-S3 is satisfied by a
    // capital letter.
    const catalogProfile = catalogProfileOfAgent(record.agent);
    if (catalogProfile === null) {
      local.push({ path: `${base}.agent`, message: "expected an agent in the catalog" });
    } else if (!(LLM_PROFILE_IDS as readonly string[]).includes(String(record.profile))) {
      local.push({ path: `${base}.profile`, message: "expected a catalog profile" });
    } else if (record.profile !== catalogProfile) {
      local.push({ path: `${base}.profile`, message: `agent ${String(record.agent)} sits on profile ${catalogProfile}` });
    }
    if (typeof record.wave !== "number" || !Number.isInteger(record.wave) || record.wave < 1) {
      local.push({ path: `${base}.wave`, message: "expected a positive integer" });
    }
    // Accumulate per entry, so one bad ballot does not pass because another
    // entry's violation was already recorded.
    if (local.length > 0) {
      violations.push(...local);
      return;
    }

    const missingFact = record.missingFact;
    verdicts.push({
      schemaVersion: 1,
      kind: "security-verdict",
      fingerprint: record.fingerprint as string,
      vote: record.vote as "critical" | "advisory",
      reason: record.reason as string,
      missingFact: typeof missingFact === "string" && missingFact.trim() !== "" ? missingFact : null,
      agent: record.agent as string,
      profile: record.profile as string,
      wave: record.wave as number,
    });
  });

  if (violations.length > 0) return failure({ kind: "invalid-verdicts" as const, violations });
  return success([...verdicts].sort((left, right) =>
    compareStrings(left.fingerprint, right.fingerprint) ||
    compareStrings(left.agent, right.agent) ||
    left.wave - right.wave));
}
