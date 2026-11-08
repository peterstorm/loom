/**
 * The security-audit → disposition handoff.
 *
 * An audit never patches. `confirmed` records leave the run as a DECLARATION of
 * what survived refutation, and remediation happens in
 * `/review-and-fix` under `standalone-disposition`, which needs a decision per
 * finding — not prose. This module is that decision set, derived from the
 * published records rather than authored beside them, so the two cannot
 * disagree (INV-S6: reports derive from validated records byte-identically).
 *
 * The mapping is forced by the trichotomy and has no room for policy:
 *
 *   confirmed       → accepted   (a different profile refuted it and failed)
 *   needs_validation → deferred  (the one fact that would settle it is absent)
 *   rejected        → dismissed  (a verifier's reason stands against the claim)
 *
 * `deferred` here is exactly what a `needs_validation` record is for, so the
 * handoff introduces no new vocabulary: an operator reading the disposition
 * reads the same three words the audit used.
 *
 * Origins are minted from (run, fingerprint, record bytes), which makes them
 * stable across a re-publish of unchanged records and different when a record
 * changed — an origin that survived an edit would let a repaired finding keep
 * its old decision, which is precisely the bug a digest chain prevents.
 */

import { match } from "ts-pattern";
import { canonicalDigest } from "./digest";
import { compareStrings } from "./ordering";
import type { ArtifactDigest } from "./orchestration-contract/identity";
import { failure, success, type DomainResult } from "./orchestration-contract/identity";
import type { SecurityRunMetadata } from "./security-audit-contract";
import type { SecurityFinding } from "./security-findings";

export const SECURITY_DISPOSITION_DECISIONS = ["accepted", "deferred", "dismissed"] as const;
export type SecurityDispositionDecision = (typeof SECURITY_DISPOSITION_DECISIONS)[number];

/** One finding's disposition, keyed by the origin the handoff mints. */
export type SecurityDispositionEntry = Readonly<{
  origin: ArtifactDigest;
  fingerprint: string;
  decision: SecurityDispositionDecision;
  reason: string;
}>;

export type SecurityDisposition = Readonly<{
  schemaVersion: 1;
  kind: "security-audit-disposition";
  provenance: "DECLARED";
  /** The publication this decision set disposes: the run that holds the
   *  records, and the digest of the exact published bytes. */
  source: Readonly<{ locator: string; runId: string; resultDigest: ArtifactDigest }>;
  profile: string;
  entries: readonly SecurityDispositionEntry[];
}>;

export type DispositionError = Readonly<{
  kind: "invalid-security-disposition";
  message: string;
}>;

const invalid = (message: string): DispositionError => ({ kind: "invalid-security-disposition", message });

/** The one constructor of a finding origin, so `disposition` and any future
 *  verifier that re-derives an origin agree. */
export function securityFindingOrigin(runId: string, finding: SecurityFinding): ArtifactDigest {
  return canonicalDigest({
    kind: "security-audit-finding",
    runId,
    fingerprint: finding.fingerprint,
    record: finding,
  });
}

/** The decision the trichotomy forces for a record. */
export function decisionForFinding(finding: SecurityFinding): SecurityDispositionDecision {
  return match(finding)
    .with({ verdict: "confirmed" }, () => "accepted" as const)
    .with({ verdict: "needs_validation" }, () => "deferred" as const)
    .with({ verdict: "rejected" }, () => "dismissed" as const)
    .exhaustive();
}

/** Why the record earned that decision, taken from the record itself: a
 *  confirmed claim cites its demonstrated impact, a lead names the fact it is
 *  missing, a rejection cites the refutation. */
export function reasonForFinding(finding: SecurityFinding): string {
  return match(finding)
    .with({ verdict: "confirmed" }, (confirmed) => `${confirmed.severity.overall_severity} impact: ${confirmed.severity.impact.reason}`)
    .with({ verdict: "needs_validation" }, (lead) => lead.blockers.join("; "))
    .with({ verdict: "rejected" }, (rejected) => rejected.reason)
    .exhaustive();
}

/**
 * Build the disposition set for a published run.
 *
 * A clean run is a legitimate outcome: zero published records produce a
 * zero-entry decision set (nothing to remediate), not a refusal — otherwise the
 * best possible audit ends with an internal error where the next command
 * should be. A duplicate fingerprint is still refused: records concatenated
 * twice give one origin two decisions, which cannot be applied.
 */
export function securityDisposition(input: Readonly<{
  metadata: SecurityRunMetadata;
  locator: string;
  findings: readonly SecurityFinding[];
}>): DomainResult<SecurityDisposition, DispositionError> {
  const seen = new Set<string>();
  for (const finding of input.findings) {
    if (seen.has(finding.fingerprint)) {
      return failure(invalid(`duplicate fingerprint ${finding.fingerprint} in the published records`));
    }
    seen.add(finding.fingerprint);
  }

  const entries = input.findings
    .map((finding): SecurityDispositionEntry => ({
      origin: securityFindingOrigin(input.metadata.runId, finding),
      fingerprint: finding.fingerprint,
      decision: decisionForFinding(finding),
      reason: reasonForFinding(finding),
    }))
    .sort((left, right) => compareStrings(left.fingerprint, right.fingerprint));

  return success({
    schemaVersion: 1,
    kind: "security-audit-disposition",
    provenance: "DECLARED",
    source: {
      locator: input.locator,
      runId: input.metadata.runId,
      resultDigest: canonicalDigest(entries.map((entry) => ({
        origin: entry.origin,
        fingerprint: entry.fingerprint,
        decision: entry.decision,
        reason: entry.reason,
      }))),
    },
    profile: input.metadata.profile,
    entries,
  });
}

/** The handoff as prose, for the report: what leaves the audit, and the exact
 *  command that consumes it. An operator should not have to read this module to
 *  know what to run next. */
export function renderDispositionHandoff(disposition: SecurityDisposition): string {
  const count = (decision: SecurityDispositionDecision): number =>
    disposition.entries.filter((entry) => entry.decision === decision).length;
  return [
    "## Disposition handoff",
    "",
    ...(disposition.entries.length === 0
      ? ["0 findings: nothing to remediate."]
      : [`${count("accepted")} accepted, ${count("deferred")} deferred, ${count("dismissed")} dismissed.`]),
    "The audit never patches: remediation runs under `/review-and-fix`.",
    "",
    ...(disposition.entries.length === 0
      ? []
      : [`    helper orchestration start standalone-disposition --run ${disposition.source.locator}`, ""]),
    `Decision set: disposition.json (${disposition.source.resultDigest}).`,
  ].join("\n");
}
