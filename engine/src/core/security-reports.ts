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
 * The report also ends on the handoff (ADR-0066): an audit never patches, so the
 * last section prints the disposition set `/review-and-fix` consumes and names
 * the exact command that loads it. The disposition is derived ONCE, by
 * `derivePublication`, and handed to the renderer: the report's handoff and
 * `disposition.json` come from one derivation, and a disposition that cannot
 * be derived refuses the publication instead of rendering as an error sentence.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import type { LoomCommands } from "./loom-cli-command";
import type { SecurityRunMetadata } from "./security-audit-contract";
import { success, type DomainResult } from "./orchestration-contract/identity";
import { incompleteReasonSource, summarizeCoverage, unitOfFingerprint, type CoverageLedger } from "./security-coverage";
import {
  renderDispositionHandoff,
  securityDisposition,
  type DispositionError,
  type SecurityDisposition,
} from "./security-disposition";
import {
  sortByFingerprint,
  type ConfirmedFinding,
  type EvidenceEntry,
  type NeedsValidationFinding,
  type SecurityFinding,
  type TraceStep,
} from "./security-findings";

export type ReportInput = Readonly<{
  metadata: SecurityRunMetadata;
  ledger: CoverageLedger;
  findings: readonly SecurityFinding[];
  /** Non-finding notes a hunter raised; parent bookkeeping, never a severity. */
  hardening?: readonly string[];
  /** The final coverage critic's own verdict, quoted as-is. */
  criticStop?: boolean | null;
  /** The printed commands of the Loom package the handoff command runs through. */
  commands: LoomCommands;
  /** The decision set this publication hands off, derived once by
   *  `derivePublication` from these same findings. It carries the locator the
   *  handoff command names, so the report needs no second copy of it. */
  disposition: SecurityDisposition;
}>;

/** What the detail documents read: the run's name and its records. */
export type DetailInput = Pick<ReportInput, "metadata" | "findings">;

/** The boundary of the unit that filed a fingerprint — live or archived, as
 *  the ledger's `unitOfFingerprint` answers — or `unmapped` when none did. */
const boundaryOf = (ledger: CoverageLedger, fingerprint: string): string =>
  unitOfFingerprint(ledger, fingerprint)?.boundary ?? "unmapped";

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

const confirmedOf = (findings: readonly SecurityFinding[]): readonly ConfirmedFinding[] =>
  sortByFingerprint(findings.filter((finding): finding is ConfirmedFinding => finding.verdict === "confirmed"));

const needsValidationOf = (findings: readonly SecurityFinding[]): readonly NeedsValidationFinding[] =>
  sortByFingerprint(findings.filter((finding): finding is NeedsValidationFinding => finding.verdict === "needs_validation"));

const rejectedOf = (findings: readonly SecurityFinding[]): readonly SecurityFinding[] =>
  sortByFingerprint(findings.filter((finding) => finding.verdict === "rejected"));

/** A diff scope names both refs by construction (the scope is a union), so the
 *  line never has a placeholder to print. */
const scopeLine = (metadata: SecurityRunMetadata): string =>
  metadata.scope.kind === "diff"
    ? `${metadata.scope.baseRef}..${metadata.scope.headRef}`
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

/** The incomplete-run notice. The token is upstream's closed vocabulary; when no
 *  deferred unit recorded one, `runStatusOf` reports the class a deferral
 *  belongs to, and the notice says that token was INFERRED — the deferrals' own
 *  recorded reasons, listed under "Deferred and out-of-scope units", stay the
 *  authority on why. */
const incompleteNotice = (metadata: SecurityRunMetadata, ledger: CoverageLedger): string => {
  if (metadata.runStatus !== "incomplete" || metadata.incompleteReason === null) return "";
  const inferred = incompleteReasonSource(ledger) === "inferred"
    ? " (inferred: no deferred unit recorded an upstream reason; each deferral's own reason is listed below)"
    : "";
  return `\n**Run status: incomplete — \`${metadata.incompleteReason}\`${inferred}.** This is a partial pass: deferred and out-of-scope units are listed below and are not evidence of coverage.\n`;
};

const confirmedTable = (confirmed: readonly ConfirmedFinding[], ledger: CoverageLedger): string =>
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

const confirmedSection = (finding: ConfirmedFinding, index: number): string =>
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
  ].join("\n");

const needsValidationTable = (needsValidation: readonly NeedsValidationFinding[], ledger: CoverageLedger): string =>
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

const deferredSection = (ledger: CoverageLedger): string => {
  const deferred = ledger.filter((unit) => unit.status === "deferred" || unit.status === "out_of_scope");
  return deferred.length === 0
    ? "_No deferred or out-of-scope units._"
    : deferred.map((unit) => `- \`${unit.coverage_id}\` (${unit.status}): ${unit.unresolved.join("; ")}`).join("\n");
};

/** The run's identifying header lines, ending on the incomplete-run notice. */
const runHeader = (metadata: SecurityRunMetadata, ledger: CoverageLedger): readonly string[] => [
  `# Security audit — ${metadata.repo}`,
  "",
  `- Profile: ${metadata.profile}`,
  `- Scope: ${scopeLine(metadata)}`,
  `- Source ref: ${metadata.sourceRef.commit}${metadata.sourceRef.worktreeDirty ? " (dirty worktree — generated or modified files are not part of the reviewed revision)" : ""}`,
  `- Budget: ${metadata.budget === null ? "unset" : `${metadata.budget} agent invocations`}`,
  `- Execution policy: ${metadata.executionPolicy}`,
  `- Prior runs read: ${metadata.priorRuns.length === 0 ? "none" : metadata.priorRuns.join(", ")}`,
  `- Selected lenses: ${metadata.selectedCompanions.join(", ") || "ATTACK-CLASSES.md"}`,
  incompleteNotice(metadata, ledger),
];

const hardeningNotes = (hardening: readonly string[] | undefined): string =>
  hardening === undefined || hardening.length === 0
    ? "_None recorded._"
    : hardening.map((note) => `- ${note}`).join("\n");

/** The final coverage critic's verdict, quoted as-is. */
const criticVerdict = (criticStop: boolean | null | undefined): string => {
  if (criticStop === true) return "reported no remaining work";
  if (criticStop === false) return "reported remaining work";
  return "not run";
};

const rejectedNote = (rejected: readonly SecurityFinding[]): string =>
  rejected.length === 0
    ? ""
    : `Rejected claims (retained so a later run must bring changed evidence): ${rejected.map((finding) => `\`${finding.fingerprint}\``).join(", ")}.`;

/** `REPORT.md` — the reader-facing summary. */
export function renderReport(input: ReportInput): string {
  const { metadata, ledger, findings } = input;
  const confirmed = confirmedOf(findings);
  const needsValidation = needsValidationOf(findings);
  const rejected = rejectedOf(findings);
  const summary = summarizeCoverage(ledger);

  return [
    ...runHeader(metadata, ledger),
    "## Security posture",
    "",
    `${confirmed.length} confirmed, ${needsValidation.length} needing validation, ${rejected.length} rejected. ` +
      `${summary.byStatus.covered} of ${summary.total} coverage units are covered; ${summary.byStatus.deferred} deferred, ${summary.byStatus.blocked} blocked.`,
    "",
    "## Confirmed findings",
    "",
    confirmedTable(confirmed, ledger),
    "",
    ...confirmed.map(confirmedSection).flatMap((section) => [section, ""]),
    "## Needs validation",
    "",
    needsValidationTable(needsValidation, ledger),
    "",
    "## Hardening notes and positive patterns",
    "",
    hardeningNotes(input.hardening),
    "",
    "## Coverage",
    "",
    coverageTable(ledger),
    "",
    `Final coverage critic: ${criticVerdict(input.criticStop)}.`,
    "",
    "Deferred and out-of-scope units:",
    "",
    deferredSection(ledger),
    "",
    rejectedNote(rejected),
    "",
    renderDispositionHandoff(input.commands, input.disposition),
  ].join("\n");
}

/** A trace as the numbered list both detail documents print. */
const traceLines = (trace: readonly TraceStep[]): readonly string[] =>
  trace.map((step) => `1. \`${step.kind}\` ${step.file}:${step.line} — ${step.scope}: ${step.description}`);

/** Evidence as the bullet list both detail documents print. */
const evidenceLines = (evidence: readonly EvidenceEntry[]): readonly string[] =>
  evidence.map((entry) => `- ${entry.file}:${entry.line} — ${entry.description}`);

const reproductionLines = (finding: ConfirmedFinding): readonly string[] => [
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
];

const fixLines = (finding: ConfirmedFinding): readonly string[] => [
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
];

const findingDetail = (finding: ConfirmedFinding, index: number): readonly string[] => [
  `## ${index + 1}. ${finding.title}`,
  "",
  `Fingerprint: \`${finding.fingerprint}\` — severity ${finding.severity.overall_severity}.`,
  "",
  finding.description,
  "",
  "### Trace",
  "",
  ...traceLines(finding.trace),
  "",
  "### Evidence",
  "",
  ...evidenceLines(finding.evidence),
  "",
  ...reproductionLines(finding),
  "",
  "### Conditions",
  "",
  finding.conditions.length === 0
    ? "_None beyond the demonstrated path._"
    : finding.conditions.map((condition) => `- ${condition.kind}: ${condition.description}`).join("\n"),
  "",
  ...fixLines(finding),
];

/** `FINDINGS-DETAIL.md` — full traces and reproductions for medium and above. */
export function renderFindingsDetail(input: DetailInput): string {
  const detail = confirmedOf(input.findings).filter(
    (finding) => finding.severity.overall_severity !== "informational" && finding.severity.overall_severity !== "low",
  );
  if (detail.length === 0) return `# Findings detail — ${input.metadata.repo}\n\n_No medium-or-higher confirmed finding._\n`;

  return [
    `# Findings detail — ${input.metadata.repo}`,
    "",
    ...detail.flatMap(findingDetail),
  ].join("\n");
}

/** `NEEDS-VALIDATION.md` — prioritised leads, no severity, exact blockers. */
export function renderNeedsValidation(input: DetailInput): string {
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
      ...traceLines(finding.trace),
      "",
      "Evidence:",
      "",
      ...evidenceLines(finding.evidence),
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
export type RunDocuments = Readonly<Record<"REPORT.md" | "FINDINGS-DETAIL.md" | "NEEDS-VALIDATION.md", string>>;

/** A run's publication: its decision set and the prose that describes it, from
 *  ONE derivation of the disposition. */
export type Publication = Readonly<{ disposition: SecurityDisposition; documents: RunDocuments }>;

export type PublicationInput = Omit<ReportInput, "disposition"> & Readonly<{
  /** Where the published records live: the handoff command loads them from
   *  here, so a publication derived without it would name the working
   *  directory as the decision set's home. */
  locator: string;
}>;

/**
 * Derive a run's publication: the disposition set (`securityDisposition`, the
 * same function `disposition.json` is written from) and the three prose
 * documents that print it. INV-S6 holds by construction — the report's
 * handoff is that disposition, not a second derivation of it — and a
 * disposition that cannot be derived (a duplicate fingerprint) is a refusal the
 * caller acts on, never prose inside a report that still publishes.
 */
export function derivePublication(input: PublicationInput): DomainResult<Publication, DispositionError> {
  const { locator, ...report } = input;
  const disposition = securityDisposition({ metadata: input.metadata, locator, findings: input.findings });
  if (!disposition.ok) return disposition;
  const reportInput: ReportInput = { ...report, disposition: disposition.value };
  return success({
    disposition: disposition.value,
    documents: {
      "REPORT.md": renderReport(reportInput),
      "FINDINGS-DETAIL.md": renderFindingsDetail(reportInput),
      "NEEDS-VALIDATION.md": renderNeedsValidation(reportInput),
    },
  });
}
