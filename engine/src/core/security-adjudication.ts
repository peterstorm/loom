/**
 * Adjudication: which candidate becomes a published finding, and on what vote.
 *
 * A hunter's candidate is a claim, not a result. Three independent facts decide
 * whether the run may publish it as `confirmed`:
 *
 *   1. a verification verdict exists for its fingerprint (INV-S3);
 *   2. that verdict was cast on a profile different from the hunter's — a model
 *      agreeing with itself is not verification;
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

import { compareStrings } from "./ordering";
import { failure, success, type DomainResult } from "./orchestration-contract/identity";
import { isSecurityAgentId, isSecurityFingerprint, isVisibleText } from "./security-audit-contract";
import type { SecurityFinding, NeedsValidationFinding, RejectedFinding, ConfirmedFinding } from "./security-findings";

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
   *  prove the vote came from a different profile than the hunt. */
  agent: string;
  profile: string;
  wave: number;
}>;

export type VerificationGap =
  | Readonly<{ kind: "unverified"; fingerprint: string }>
  | Readonly<{ kind: "same-profile"; fingerprint: string; profile: string }>;

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

const sortByFingerprint = <T extends { readonly fingerprint: string }>(items: readonly T[]): readonly T[] =>
  [...items].sort((left, right) => compareStrings(left.fingerprint, right.fingerprint));

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
  verdicts: readonly VerificationVerdict[],
): VerificationVerdict | null => verdicts.find((verdict) => verdict.vote === "critical") ?? verdicts[0] ?? null;

export type AdjudicationInput = Readonly<{
  findings: readonly SecurityFinding[];
  verdicts: readonly VerificationVerdict[];
  /** The profile the hunters ran on. A vote from this profile verifies nothing. */
  huntProfile: string;
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
    const verdicts = verdictsFor(input.verdicts, finding.fingerprint);
    if (verdicts.length === 0) {
      gaps.push({ kind: "unverified", fingerprint: finding.fingerprint });
      continue;
    }
    if (!verdicts.some((verdict) => verdict.profile !== input.huntProfile)) {
      gaps.push({ kind: "same-profile", fingerprint: finding.fingerprint, profile: input.huntProfile });
      continue;
    }
    const decision = decide(verdicts.filter((verdict) => verdict.profile !== input.huntProfile));
    if (decision === null) {
      gaps.push({ kind: "unverified", fingerprint: finding.fingerprint });
      continue;
    }
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

/** Blocking reasons that prevent publication, most severe first. Empty means
 *  the run may publish what it has. */
export function publicationBlockers(
  input: AdjudicationInput & Readonly<{ ledgerSettled: boolean }>,
): readonly string[] {
  const adjudication = adjudicateCandidates(input);
  const blockers: string[] = [];
  for (const gap of adjudication.gaps) {
    blockers.push(
      gap.kind === "unverified"
        ? `confirmed claim ${gap.fingerprint} has no verification verdict`
        : `confirmed claim ${gap.fingerprint} was verified only on the hunt profile ${gap.profile}`,
    );
  }
  if (!input.ledgerSettled) blockers.push("coverage ledger still has planned, in-progress or blocked units");
  return blockers;
}

/** The published findings list: adjudicated confirmed, demoted leads, then the
 *  run's own non-confirmed records (leads and rejections the hunters filed). */
export function publishedFindings(input: AdjudicationInput): readonly SecurityFinding[] {
  const adjudication = adjudicateCandidates({
    ...input,
    // Only confirmed claims are adjudicated; the rest pass through untouched.
    findings: input.findings.filter((finding) => finding.verdict === "confirmed"),
  });
  const passthrough = input.findings.filter((finding) => finding.verdict !== "confirmed");
  return sortByFingerprint([...adjudication.confirmed, ...adjudication.demoted, ...adjudication.rejected, ...passthrough]);
}

// --- Wire parsing ---

export type VerdictViolation = Readonly<{ path: string; message: string }>;

export type VerdictError = Readonly<{ kind: "invalid-verdicts"; violations: readonly VerdictViolation[] }>;

const VERDICT_KEYS: readonly string[] = [
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
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      violations.push({ path: base, message: "expected an object" });
      return;
    }
    const local: VerdictViolation[] = [];
    const record = entry as Record<string, unknown>;
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
    if (!isVisibleText(record.profile)) local.push({ path: `${base}.profile`, message: "expected a catalog profile" });
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
