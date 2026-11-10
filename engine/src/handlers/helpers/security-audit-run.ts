/**
 * The security-audit run directory as the ONE READ seam shared by its two
 * shells: the `helper security-audit` CLI and the `security-verification`
 * facade program (ADR-0067), which authenticates the audit it verifies.
 *
 * Every read of a run document goes through `readRunDocument` (or, for the
 * snapshot, the same `readDocument` + `parseDocument` pair), and every core
 * refusal is rendered by `describeAuditRefusal`, so a document's failure modes
 * — missing, unreadable, not JSON, refused by its core, or a core that threw —
 * read the same whichever path reached it. The CLI's `Store` keeps only the
 * writes.
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
import { isWireRecord, parseSecurityRunMetadata, type SecurityRunMetadata } from "../../core/security-audit-contract";
import { parseLedger, type CoverageLedger } from "../../core/security-coverage";
import { parseSecurityFindings, type SecurityFinding } from "../../core/security-findings";
import { parseVerificationVerdicts, type VerificationVerdict } from "../../core/security-adjudication";
import { parseAuditReference, type AuditReference } from "../../core/security-verification";
import { SECURITY_AUDIT_RUN_FILES, SECURITY_AUDIT_VERIFICATION_RUNS_DIR } from "../../core/audit-run-authority";
import { readRunFileNoFollow } from "../../utils/no-follow-fs";

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

/**
 * Render any core refusal as readable prose: a string as-is, a list of
 * `violations` (`path: message` per line), a list of `issues`, a `message`, a
 * tagged refusal (`{ kind, …facts }` reads as `kind: fact=value …`, because a
 * refusal is prose the operator has to act on), or — for anything else — its
 * JSON. The one renderer: a refusal reads the same whichever path met it.
 */
export function describeAuditRefusal(error: unknown): string {
  if (typeof error === "string") return error;
  if (isWireRecord(error)) {
    if (Array.isArray(error.violations)) {
      return error.violations.map((violation: unknown) => {
        const fields = isWireRecord(violation) ? violation : {};
        return `${typeof fields.path === "string" ? fields.path : "$"}: ${typeof fields.message === "string" ? fields.message : "invalid"}`;
      }).join("\n");
    }
    if (Array.isArray(error.issues)) return error.issues.map(String).join("\n");
    if (typeof error.message === "string") return error.message;
    if (typeof error.kind === "string") {
      const facts = Object.entries(error)
        .filter(([key]) => key !== "kind")
        .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`);
      return facts.length === 0 ? error.kind : `${error.kind}: ${facts.join(" ")}`;
    }
  }
  return JSON.stringify(error);
}

/** One run-relative text file (a hunter's artifact, say), read no-follow, or
 *  a refusal naming it. Not a run document: its absence is not damage. */
export function readRunText(root: string, file: string): DomainResult<string, string> {
  const path = join(root, file);
  try {
    return success(readRunFileNoFollow(path));
  } catch (error) {
    return failure(`cannot read ${path}: ${describe(error)}`);
  }
}

type ReadDocument = Readonly<{ text: string; value: unknown }>;

/** One document's exact text and its JSON, or a refusal naming the file. */
function readDocument(root: string, file: string): DomainResult<ReadDocument, string> {
  const path = join(root, file);
  let text: string;
  try {
    text = readRunFileNoFollow(path);
  } catch (error) {
    // The run wrote every document it reads back, so absence means the file
    // was lost — never "no findings" or "no ballots".
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

/** Parse one read document with the core that owns it, naming the file. A
 *  core that THROWS met a shape it did not model: that is caught here too,
 *  rather than escaping as an unnamed `Hook error:` with no run context. */
function parseDocument<T>(root: string, file: string, document: ReadDocument, parse: (raw: unknown) => DomainResult<T, unknown>): DomainResult<T, string> {
  const path = join(root, file);
  let result: DomainResult<T, unknown>;
  try {
    result = parse(document.value);
  } catch (error) {
    return failure(`${path} is malformed — unexpected ${describe(error)}`);
  }
  return result.ok ? success(result.value) : failure(`${path} is malformed —\n${describeAuditRefusal(result.error)}`);
}

/** Read one run document: no-follow, strict JSON, and parsed by the core that
 *  owns it — every failure naming the file. */
export function readRunDocument<T>(root: string, file: string, parse: (raw: unknown) => DomainResult<T, unknown>): DomainResult<T, string> {
  const document = readDocument(root, file);
  return document.ok ? parseDocument(root, file, document.value, parse) : document;
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
  const runValue = parseDocument(root, files.run, run.value, parseSecurityRunMetadata);
  if (!runValue.ok) return runValue;
  const ledgerValue = parseDocument(root, files.ledger, ledger.value, parseLedger);
  if (!ledgerValue.ok) return ledgerValue;
  const findingsValue = parseDocument(root, files.findings, findings.value, parseSecurityFindings);
  if (!findingsValue.ok) return findingsValue;
  const verdictsValue = parseDocument(root, files.verdicts, verdicts.value, parseVerificationVerdicts);
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
  // The reference is minted through the same parser as the wire: a run whose
  // canonical locator or run id is outside the reference grammar cannot name
  // itself to a verification run, so it is refused here with the file named.
  const reference = parseAuditReference({
    locator: root,
    runId: snapshot.run.runId,
    ledgerDigest: sha256Hex(ledgerText),
    findingsDigest: sha256Hex(findingsText),
  });
  if (!reference.ok) return failure(`${join(root, SECURITY_AUDIT_RUN_FILES.run)} cannot name its audit — ${reference.error}`);
  return success({ ...snapshot, reference: reference.value });
}

/** Where an audit's verification runs live. */
export const verificationRunsRoot = (locator: string): string => join(resolve(locator), SECURITY_AUDIT_VERIFICATION_RUNS_DIR);

/** The file a finished verification run publishes, owned beside the runs
 *  root it lives under: the program writes it, `verify --from`
 *  (`security-verification-proofs.ts`) reads exactly it, and the program's
 *  `done` action names it as the outcome artifact slot the session completion
 *  binding reads. */
export const SECURITY_VERIFICATION_RESULT_FILE = "result.json";
