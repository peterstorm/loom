/**
 * The security-audit run directory's entry names, and which of them are
 * AUTHORITY: the entries a run's verdict is read from, which only the parent
 * session's writes may change (ADR-0064, ADR-0065 D6).
 *
 * The ONE owner of these names. Every consumer imports them from here:
 *
 *  - the `helper security-audit` CLI and its read seam
 *    (`handlers/helpers/security-audit.ts`, `security-audit-run.ts`) — the
 *    `--force` reset, the fresh-run writes and every reader;
 *  - the disposition handoff (`core/security-disposition.ts`), which names the
 *    handoff file and the `standalone-disposition` runs root;
 *  - the `security-verification` program, whose runs live under
 *    `verification-runs/`;
 *  - the subagent write guard (`core/subagent-authority.ts`), which refuses a
 *    subagent's writes onto `SECURITY_AUDIT_AUTHORITY_ENTRIES`.
 *
 * So an entry added to the run directory is protected the moment it is named.
 * `agents/<owner>/{scratch,artifacts}` are deliberately absent: they are the
 * hunter's own working space.
 *
 * Pure data, no imports.
 */

/** Every document a run directory may hold, by role. */
export const SECURITY_AUDIT_RUN_FILES = Object.freeze({
  run: "run.json",
  ledger: "ledger.json",
  findings: "findings.json",
  verdicts: "verdicts.json",
  lenses: "lenses.json",
  published: "security-findings.json",
  disposition: "disposition.json",
  /** The `standalone-disposition` start input: `disposition` writes it, and the
   *  handoff command in the report reads exactly this file. */
  dispositionHandoff: "standalone-disposition.json",
  report: "REPORT.md",
  details: "FINDINGS-DETAIL.md",
  needsValidation: "NEEDS-VALIDATION.md",
} as const);

/** The directory inside an audit run that holds its `security-verification`
 *  facade runs (`<audit>/verification-runs/run.verify-w<wave>-<id>`, ADR-0065
 *  D1). `start` creates it. */
export const SECURITY_AUDIT_VERIFICATION_RUNS_DIR = "verification-runs";

/** The directory inside an audit run that the disposition handoff names as the
 *  `standalone-disposition` runs root (`<audit>/disposition-runs/run.disposition-<runId>`). */
export const SECURITY_AUDIT_DISPOSITION_RUNS_DIR = "disposition-runs";

/**
 * The run-directory entries no subagent may write: every run document (the
 * derived prose included — a forged REPORT.md misleads its reader as surely as
 * a forged ledger) and both facade runs roots the audit names (a forged
 * verification or remediation run is forged authority).
 */
export const SECURITY_AUDIT_AUTHORITY_ENTRIES: readonly string[] = Object.freeze([
  ...Object.values(SECURITY_AUDIT_RUN_FILES),
  SECURITY_AUDIT_VERIFICATION_RUNS_DIR,
  SECURITY_AUDIT_DISPOSITION_RUNS_DIR,
]);
