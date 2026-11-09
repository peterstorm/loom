/**
 * Report derivation: `REPORT.md`, `FINDINGS-DETAIL.md` and
 * `NEEDS-VALIDATION.md` are rendered from validated records, never written
 * beside them.
 *
 * That is the point of this volume. Upstream derived its prose from the same
 * records but left the derivation to the orchestrator, so prose and JSON could
 * disagree — and a reader believes prose. Here the only inputs are the
 * metadata, the ledger and the findings list; the output is a total function of
 * them, so `engine/tests/security/security-reports.test.ts` can assert that
 * every published fingerprint appears exactly once, that rejected claims never
 * appear as findings, and that two renders of the same run are byte-identical.
 *
 * The report also ends on the handoff (ADR-0064): an audit never patches, so the
 * last section derives the disposition set `/review-and-fix` consumes and names
 * the exact command that loads it.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import type { SecurityRunMetadata } from "./security-audit-contract";
import { summarizeCoverage, type CoverageLedger } from "./security-coverage";
import { dispositionHandoffPaths, renderDispositionHandoff, securityDisposition } from "./security-disposition";
import { sortByFingerprint, type ConfirmedFinding, type NeedsValidationFinding, type SecurityFinding } from "./security-findings";

export type ReportInput = Readonly<{
  metadata: SecurityRunMetadata;
  ledger: CoverageLedger;
  findings: readonly SecurityFinding[];
  /** Non-finding notes a hunter raised; parent bookkeeping, never a severity. */
  hardening?: readonly string[];
  /** The final coverage critic's own verdict, quoted as-is. */
  criticStop?: boolean | null;
  /** Where the published records live. REQUIRED: the handoff prints the command
   *  that loads them, and a report rendered without it would name the working
   *  directory as the decision set's home. */
  locator: string;
}>;

/** The boundary of the unit that filed a fingerprint, or `unmapped` when no
 *  settled unit carries it. */
const boundaryOf = (ledger: CoverageLedger, fingerprint: string): string =>
  ledger.find((unit) => unit.result_fingerprints.includes(fingerprint))?.boundary ?? "unmapped";

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

const confirmedOf = (findings: readonly SecurityFinding[]): readonly ConfirmedFinding[] =>
  sortByFingerprint(findings.filter((finding): finding is ConfirmedFinding => finding.verdict === "confirmed"));

const needsValidationOf = (findings: readonly SecurityFinding[]): readonly NeedsValidationFinding[] =>
  sortByFingerprint(findings.filter((finding): finding is NeedsValidationFinding => finding.verdict === "needs_validation"));

const rejectedOf = (findings: readonly SecurityFinding[]): readonly SecurityFinding[] =>
  sortByFingerprint(findings.filter((finding) => finding.verdict === "rejected"));

const scopeLine = (metadata: SecurityRunMetadata): string =>
  metadata.scope.kind === "diff"
    ? `${metadata.scope.baseRef ?? "?"}..${metadata.scope.headRef ?? "?"}`
    : `${metadata.scopePaths.length} path(s)`;

const coverageTable = (ledger: CoverageLedger): string => {
  const summary = summarizeCoverage(ledger);
  const rows = Object.entries(summary.byStatus)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `| ${status} | ${count} |`);
  return [
    `Total units: ${summary.total}`,
    "",
    "| Status | Units |",
    "|---|---|",
    ...rows,
  ].join("\n");
};

const incompleteNotice = (metadata: SecurityRunMetadata): string =>
  metadata.runStatus === "incomplete" && metadata.incompleteReason !== null
    ? `\n**Run status: incomplete — \`${metadata.incompleteReason}\`.** This is a partial pass: deferred and out-of-scope units are listed below and are not evidence of coverage.\n`
    : "";

/** `REPORT.md` — the reader-facing summary. */
export function renderReport(input: ReportInput): string {
  const { metadata, ledger, findings } = input;
  const confirmed = confirmedOf(findings);
  const needsValidation = needsValidationOf(findings);
  const rejected = rejectedOf(findings);
  const summary = summarizeCoverage(ledger);

  const confirmedTable =
    confirmed.length === 0
      ? "_No confirmed findings._"
      : [
          "| Severity | Title | Boundary | Observed result |",
          "|---|---|---|---|",
          ...confirmed.map(
            (finding) =>
              `| ${finding.severity.overall_severity} | ${cell(finding.title)} | ${cell(boundaryOf(ledger, finding.fingerprint))} | ${cell(finding.execution.observed_result)} |`,
          ),
        ].join("\n");

  const findingSections = confirmed.map((finding, index) =>
    [
      `### ${index + 1}. ${finding.title} (${finding.severity.overall_severity})`,
      "",
      `- Fingerprint: \`${finding.fingerprint}\``,
      `- Confirmed by bounded local result; confidence ${finding.confidence.score} — ${finding.confidence.reason}`,
      `- Root cause: ${finding.root_cause}`,
      `- Intended behavior: ${finding.intended_behavior}`,
      `- Attacker: ${finding.execution.attacker_perspective}`,
      `- Observed result: ${finding.execution.observed_result}`,
      `- Likelihood: ${finding.severity.likelihood.score} — ${finding.severity.likelihood.reason}`,
      `- Impact: ${finding.severity.impact.score} — ${finding.severity.impact.reason}`,
      `- Smallest effective fix: ${finding.remediation.strategy}`,
      "",
      "Trace:",
      ...finding.trace.map((step) => `- ${step.kind} ${step.file}:${step.line} (${step.scope}) — ${step.description}`),
    ].join("\n"),
  );

  const needsValidationTable =
    needsValidation.length === 0
      ? "_No unresolved leads._"
      : [
          "| Lead | Boundary | Exact blocker |",
          "|---|---|---|",
          ...needsValidation.map(
            (finding) =>
              `| ${cell(finding.title)} | ${cell(boundaryOf(ledger, finding.fingerprint))} | ${cell(finding.blockers.join("; "))} |`,
          ),
        ].join("\n");

  const deferred = ledger.filter((unit) => unit.status === "deferred" || unit.status === "out_of_scope");
  const deferredSection =
    deferred.length === 0
      ? "_No deferred or out-of-scope units._"
      : deferred.map((unit) => `- \`${unit.coverage_id}\` (${unit.status}): ${unit.unresolved.join("; ")}`).join("\n");

  return [
    `# Security audit — ${metadata.repo}`,
    "",
    `- Profile: ${metadata.profile}`,
    `- Scope: ${scopeLine(metadata)}`,
    `- Source ref: ${metadata.sourceRef.commit}${metadata.sourceRef.worktreeDirty ? " (dirty worktree — generated or modified files are not part of the reviewed revision)" : ""}`,
    `- Budget: ${metadata.budget === null ? "unset" : `${metadata.budget} agent invocations`}`,
    `- Execution policy: ${metadata.executionPolicy}`,
    `- Prior runs read: ${metadata.priorRuns.length === 0 ? "none" : metadata.priorRuns.join(", ")}`,
    `- Selected lenses: ${metadata.selectedCompanions.join(", ") || "ATTACK-CLASSES.md"}`,
    incompleteNotice(metadata),
    "## Security posture",
    "",
    `${confirmed.length} confirmed, ${needsValidation.length} needing validation, ${rejected.length} rejected. ` +
      `${summary.byStatus.covered} of ${summary.total} coverage units are covered; ${summary.byStatus.deferred} deferred, ${summary.byStatus.blocked} blocked.`,
    "",
    "## Confirmed findings",
    "",
    confirmedTable,
    "",
    ...findingSections.flatMap((section) => [section, ""]),
    "## Needs validation",
    "",
    needsValidationTable,
    "",
    "## Hardening notes and positive patterns",
    "",
    input.hardening === undefined || input.hardening.length === 0
      ? "_None recorded._"
      : input.hardening.map((note) => `- ${note}`).join("\n"),
    "",
    "## Coverage",
    "",
    coverageTable(ledger),
    "",
    `Final coverage critic: ${input.criticStop === true ? "reported no remaining work" : input.criticStop === false ? "reported remaining work" : "not run"}.`,
    "",
    "Deferred and out-of-scope units:",
    "",
    deferredSection,
    "",
    rejected.length === 0
      ? ""
      : `Rejected claims (retained so a later run must bring changed evidence): ${rejected.map((finding) => `\`${finding.fingerprint}\``).join(", ")}.`,
    "",
    handoffSection(input),
  ].join("\n");
}

/** The handoff is DERIVED like everything else here: the report's decision set
 *  and `disposition.json` come from one function, so the prose cannot describe
 *  decisions the loader will not receive (INV-S6). */
function handoffSection(input: ReportInput): string {
  const derived = securityDisposition({
    metadata: input.metadata,
    locator: input.locator,
    findings: input.findings,
  });
  if (!derived.ok) return ["## Disposition handoff", "", derived.error.message].join("\n");
  // A run with nothing to remediate prints no command; a run with decisions
  // prints the exact one, against the paths the handler writes.
  const paths = input.findings.length === 0
    ? null
    : dispositionHandoffPaths(input.locator, input.metadata.runId);
  return renderDispositionHandoff(derived.value, paths);
}

/** `FINDINGS-DETAIL.md` — full traces and reproductions for medium and above. */
export function renderFindingsDetail(input: ReportInput): string {
  const detail = confirmedOf(input.findings).filter(
    (finding) => finding.severity.overall_severity !== "informational" && finding.severity.overall_severity !== "low",
  );
  if (detail.length === 0) return `# Findings detail — ${input.metadata.repo}\n\n_No medium-or-higher confirmed finding._\n`;

  return [
    `# Findings detail — ${input.metadata.repo}`,
    "",
    ...detail.flatMap((finding, index) => [
      `## ${index + 1}. ${finding.title}`,
      "",
      `Fingerprint: \`${finding.fingerprint}\` — severity ${finding.severity.overall_severity}.`,
      "",
      finding.description,
      "",
      "### Trace",
      "",
      ...finding.trace.map((step) => `1. \`${step.kind}\` ${step.file}:${step.line} — ${step.scope}: ${step.description}`),
      "",
      "### Evidence",
      "",
      ...finding.evidence.map((entry) => `- ${entry.file}:${entry.line} — ${entry.description}`),
      "",
      "### Reproduction",
      "",
      `Attacker: ${finding.execution.attacker_perspective}`,
      "",
      "Input:",
      "",
      ...finding.execution.payloads.map((payload) => `    ${payload}`),
      "",
      "Steps:",
      "",
      ...finding.execution.instructions.map((instruction) => `1. ${instruction}`),
      "",
      `Observed result: ${finding.execution.observed_result}`,
      "",
      "### Conditions",
      "",
      finding.conditions.length === 0
        ? "_None beyond the demonstrated path._"
        : finding.conditions.map((condition) => `- ${condition.kind}: ${condition.description}`).join("\n"),
      "",
      "### Fix",
      "",
      finding.remediation.strategy,
      "",
      ...(finding.remediation.code_changes === undefined
        ? []
        : [
            "Changed files:",
            "",
            ...finding.remediation.code_changes.map(
              (change) => `- \`${change.file_name}\`\n\n\`\`\`\n${change.fixed_code}\n\`\`\``,
            ),
            "",
          ]),
    ]),
  ].join("\n");
}

/** `NEEDS-VALIDATION.md` — prioritised leads, no severity, exact blockers. */
export function renderNeedsValidation(input: ReportInput): string {
  const leads = needsValidationOf(input.findings);
  if (leads.length === 0) return `# Needs validation — ${input.metadata.repo}\n\n_No unresolved lead._\n`;

  return [
    `# Needs validation — ${input.metadata.repo}`,
    "",
    "Ordered by fingerprint. No severity is assigned: each lead is blocked on one exact fact, and the plan names how an owner resolves it without touching a live target.",
    "",
    ...leads.flatMap((finding, index) => [
      `## ${index + 1}. ${finding.title}`,
      "",
      `Fingerprint: \`${finding.fingerprint}\``,
      "",
      finding.description,
      "",
      `Claimed root cause: ${finding.claimed_root_cause}`,
      "",
      "Trace:",
      "",
      ...finding.trace.map((step) => `1. \`${step.kind}\` ${step.file}:${step.line} — ${step.scope}: ${step.description}`),
      "",
      "Evidence:",
      "",
      ...finding.evidence.map((entry) => `- ${entry.file}:${entry.line} — ${entry.description}`),
      "",
      "Blockers:",
      "",
      ...finding.blockers.map((blocker) => `- ${blocker}`),
      "",
      "Resolution plan:",
      "",
      ...(finding.validation_plan.local === undefined ? [] : [`- Local: ${finding.validation_plan.local}`]),
      ...(finding.validation_plan.deployment === undefined ? [] : [`- Owner-observed deployment fact: ${finding.validation_plan.deployment}`]),
      "",
    ]),
  ].join("\n");
}

/** The three derived prose documents, keyed by their fixed filenames. */
export function renderRunDocuments(input: ReportInput): Readonly<Record<string, string>> {
  return {
    "REPORT.md": renderReport(input),
    "FINDINGS-DETAIL.md": renderFindingsDetail(input),
    "NEEDS-VALIDATION.md": renderNeedsValidation(input),
  };
}
