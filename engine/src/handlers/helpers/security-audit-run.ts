/**
 * The security-audit run directory as a READ seam shared by its two shells:
 * the `helper security-audit` CLI and the `security-verification` facade
 * program (ADR-0065), which authenticates the audit it verifies.
 *
 * Document names come from their one owner, `core/audit-run-authority.ts`
 * (shared with the subagent write guard). `readAuditSnapshot` reads the four documents adjudication and
 * verification read, ONCE, no-follow, each parsed by the core that owns it,
 * and digests the exact ledger and findings bytes — the identity a
 * verification run is issued against.
 */

import { join, resolve } from "node:path";
import { sha256Hex } from "../../core/digest";
import { failure, success, type DomainResult } from "../../core/orchestration-contract/identity";
import { parseSecurityRunMetadata, type SecurityRunMetadata } from "../../core/security-audit-contract";
import { parseLedger, type CoverageLedger } from "../../core/security-coverage";
import { parseSecurityFindings, type SecurityFinding } from "../../core/security-findings";
import { parseVerificationVerdicts, type VerificationVerdict } from "../../core/security-adjudication";
import type { AuditReference } from "../../core/security-verification";
import { SECURITY_AUDIT_RUN_FILES, SECURITY_AUDIT_VERIFICATION_RUNS_DIR } from "../../core/audit-run-authority";
import { readRunFileNoFollow } from "../../orchestration/no-follow-fs";

/** The four documents adjudication reads, read once, plus the audit's identity. */
export type AuditSnapshot = Readonly<{
  run: SecurityRunMetadata;
  ledger: CoverageLedger;
  findings: readonly SecurityFinding[];
  verdicts: readonly VerificationVerdict[];
  /** The canonical locator, run id and the digests of the exact ledger and
   *  findings bytes this snapshot read. */
  reference: AuditReference;
}>;

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Render a core refusal as one line: violations, issues, a message, or JSON. */
function describeAuditRefusal(error: unknown): string {
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const record = error as Readonly<Record<string, unknown>>;
    if (Array.isArray(record.violations)) {
      return record.violations.map((violation: unknown) => {
        const fields = typeof violation === "object" && violation !== null ? violation as Readonly<Record<string, unknown>> : {};
        return `${typeof fields.path === "string" ? fields.path : "$"}: ${typeof fields.message === "string" ? fields.message : "invalid"}`;
      }).join("\n");
    }
    if (Array.isArray(record.issues)) return record.issues.map(String).join("\n");
    if (typeof record.message === "string") return record.message;
  }
  return JSON.stringify(error);
}

type ReadDocument = Readonly<{ text: string; value: unknown }>;

/** One document's exact text and its JSON, or a refusal naming the file. */
function readDocument(root: string, file: string): DomainResult<ReadDocument, string> {
  const path = join(root, file);
  let text: string;
  try {
    text = readRunFileNoFollow(path);
  } catch (error) {
    // `start` writes every snapshot document, so absence means the file was
    // lost — never "no findings" or "no ballots".
    return failure((error as NodeJS.ErrnoException).code === "ENOENT"
      ? `${path} is missing — a run directory always holds it`
      : `cannot read ${path}: ${describe(error)}`);
  }
  try {
    return success({ text, value: JSON.parse(text) as unknown });
  } catch (error) {
    return failure(`${path} is not valid JSON: ${describe(error)}`);
  }
}

/** Parse one read document with the core that owns it, naming the file. */
function parsed<T>(root: string, file: string, document: ReadDocument, parse: (raw: unknown) => DomainResult<T, unknown>): DomainResult<T, string> {
  const result = parse(document.value);
  return result.ok ? success(result.value) : failure(`${join(root, file)} is malformed —\n${describeAuditRefusal(result.error)}`);
}

/** Read and parse every snapshot document, in a fixed order, stopping at the first refusal. */
function readSnapshotDocuments(root: string): DomainResult<Readonly<{
  run: SecurityRunMetadata; ledger: CoverageLedger; findings: readonly SecurityFinding[];
  verdicts: readonly VerificationVerdict[]; ledgerText: string; findingsText: string;
}>, string> {
  const files = SECURITY_AUDIT_RUN_FILES;
  const run = readDocument(root, files.run);
  if (!run.ok) return run;
  const ledger = readDocument(root, files.ledger);
  if (!ledger.ok) return ledger;
  const findings = readDocument(root, files.findings);
  if (!findings.ok) return findings;
  const verdicts = readDocument(root, files.verdicts);
  if (!verdicts.ok) return verdicts;
  const runValue = parsed(root, files.run, run.value, parseSecurityRunMetadata);
  if (!runValue.ok) return runValue;
  const ledgerValue = parsed(root, files.ledger, ledger.value, parseLedger);
  if (!ledgerValue.ok) return ledgerValue;
  const findingsValue = parsed(root, files.findings, findings.value, parseSecurityFindings);
  if (!findingsValue.ok) return findingsValue;
  const verdictsValue = parsed(root, files.verdicts, verdicts.value, parseVerificationVerdicts);
  if (!verdictsValue.ok) return verdictsValue;
  return success({ run: runValue.value, ledger: ledgerValue.value, findings: findingsValue.value,
    verdicts: verdictsValue.value, ledgerText: ledger.value.text, findingsText: findings.value.text });
}

/** Read an audit run directory's snapshot. Fail-closed: a missing or malformed
 *  document stops the read with the file named. */
export function readAuditSnapshot(locator: string): DomainResult<AuditSnapshot, string> {
  const root = resolve(locator);
  const documents = readSnapshotDocuments(root);
  if (!documents.ok) return documents;
  const { ledgerText, findingsText, ...snapshot } = documents.value;
  return success({
    ...snapshot,
    reference: {
      locator: root,
      runId: snapshot.run.runId,
      ledgerDigest: sha256Hex(ledgerText),
      findingsDigest: sha256Hex(findingsText),
    },
  });
}

/** Where an audit's verification runs live. */
export const verificationRunsRoot = (locator: string): string => join(resolve(locator), SECURITY_AUDIT_VERIFICATION_RUNS_DIR);
