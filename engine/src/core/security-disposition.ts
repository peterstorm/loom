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
 *
 * `source.resultDigest` is the digest of the DECISION SET — the sorted entries
 * (origin, fingerprint, decision, reason) — not of any file's bytes. That is
 * what the field means wherever a standalone disposition is referenced: the
 * lineage loader takes a disposition reference's `resultDigest` as the
 * disposition's own digest (`--disposition-digest`), so the name is the
 * loader's contract, not this module's to rename. The published records are
 * still bound: every entry's origin digests its full record, so a changed
 * record changes the set's digest. Run metadata that changes no decision (the
 * profile, `run.json` fields) is deliberately outside it — a decision set is
 * the same decision set whatever the run printed beside it.
 *
 * The handoff is CONSUMABLE, not merely descriptive: `standaloneDispositionStart`
 * produces the exact bytes `helper orchestration start standalone-disposition`
 * parses (`{ source, record, previous }`, with the record in the standalone
 * lineage grammar), and `dispositionHandoffPaths` is the one owner of where
 * those bytes live and which command reads them. Before that the printed
 * command named neither the runs root nor the input file, and the record's own
 * shape carried keys the loader rejects — a handoff nobody could execute.
 */

import { match } from "ts-pattern";
import { canonicalDigest } from "./digest";
import { loomHelperCommand } from "./loom-cli-command";
import { compareStrings } from "./ordering";
import { failure, success, type ArtifactDigest, type DomainResult } from "./orchestration-contract/identity";
import { standaloneDispositionSchema } from "./standalone-lineage-contract";
import type { SecurityRunMetadata } from "./security-audit-contract";
import type { SecurityFinding } from "./security-findings";
import { SECURITY_AUDIT_DISPOSITION_RUNS_DIR, SECURITY_AUDIT_RUN_FILES } from "./audit-run-authority";
import { quoteShellArgument } from "./shell-quoting";

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
   *  records, and the digest of this decision set — `canonicalDigest(entries)`.
   *  Each entry's origin digests its full record, so the digest moves when any
   *  published record does; it is not a digest of a file's bytes. */
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

/** Where the consumable handoff lives, and the command that loads it. One
 *  owner: the handler writes these paths and the report prints them, so the
 *  prose cannot name a file the handler did not write. */
export type DispositionHandoffPaths = Readonly<{
  /** The `standalone-disposition` start input, written beside the record. */
  inputFile: string;
  runsRoot: string;
  /** The name of the remediation run: the direct child of `runsRoot` it owns,
   *  and the `--run` the handoff command passes. */
  runName: string;
  /** `runsRoot/runName`. */
  runDir: string;
}>;

export function dispositionHandoffPaths(locator: string, runId: string): DispositionHandoffPaths {
  // Plain joins: this module is pure and may not import `node:path`, and the
  // locator is already an absolute canonical path (the loader rejects anything
  // with `.`/`..`/empty segments).
  const root = locator.replace(/\/$/, "");
  const runsRoot = `${root}/${SECURITY_AUDIT_DISPOSITION_RUNS_DIR}`;
  const runName = `run.disposition-${runId}`;
  return {
    inputFile: `${root}/${SECURITY_AUDIT_RUN_FILES.dispositionHandoff}`,
    runsRoot,
    runName,
    runDir: `${runsRoot}/${runName}`,
  };
}

/** The bytes `helper orchestration start standalone-disposition` parses. The
 *  record is validated with the loader's OWN schema before it leaves here: a
 *  handoff that only looks consumable is the defect this type exists to stop. */
export type StandaloneDispositionStart = Readonly<{
  source: SecurityDisposition["source"];
  record: Readonly<{
    schemaVersion: 1;
    source: SecurityDisposition["source"];
    provenance: "DECLARED";
    revision: Readonly<{ kind: "initial" }>;
    entries: readonly Readonly<{ origin: ArtifactDigest; decision: SecurityDispositionDecision; reason: string }>[];
  }>;
  previous: null;
}>;

export function standaloneDispositionStart(
  disposition: SecurityDisposition,
): DomainResult<StandaloneDispositionStart, DispositionError> {
  const record = {
    schemaVersion: 1 as const,
    source: disposition.source,
    provenance: "DECLARED" as const,
    revision: { kind: "initial" as const },
    entries: disposition.entries.map((entry) => ({
      origin: entry.origin,
      decision: entry.decision,
      reason: entry.reason,
    })),
  };
  const parsed = standaloneDispositionSchema.safeParse(record);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.length === 0 ? "$" : issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    return failure(invalid(`the disposition is not one /review-and-fix can consume: ${issues}`));
  }
  return success({ source: disposition.source, record, previous: null });
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
      resultDigest: canonicalDigest(entries),
    },
    profile: input.metadata.profile,
    entries,
  });
}

/** The handoff as prose, for the report and the `disposition` operation: what
 *  leaves the audit, and the exact command that consumes it — through the Loom
 *  package at `packageRoot` — at the paths the disposition's own source
 *  derives. An operator should not have to read this module to know what to
 *  run next, nor translate the line before running it. */
export function renderDispositionHandoff(packageRoot: string, disposition: SecurityDisposition): string {
  const handoff = dispositionHandoffPaths(disposition.source.locator, disposition.source.runId);
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
      : [
        `    ${loomHelperCommand(packageRoot)} orchestration start standalone-disposition --runs-root ${quoteShellArgument(handoff.runsRoot)} \\`,
        `      --run ${quoteShellArgument(handoff.runName)} < ${quoteShellArgument(handoff.inputFile)}`,
        "",
      ]),
    `Decision set: disposition.json (${disposition.source.resultDigest}).`,
  ].join("\n");
}
