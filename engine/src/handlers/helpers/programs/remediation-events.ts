import type { CompletionCheckId } from "../../../core/completion-suite";
import {
  parseRegisteredRemediationCheckObservation,
  type AuthorizedRemediationCheck,
  type CandidateRepositoryWitness,
  type EngineObservedRepairedCheck,
} from "../../../core/defect-family-accounting";
import type { ArtifactDigest, DomainResult } from "../../../core/orchestration-contract";
import { sha256Bytes } from "../../../core/digest";
import { MAX_STRUCTURED_REPORT_BYTES, parseStructuredTestReportBytes } from "../../../core/structured-test-report";
import type {
  RemediationCheckExecution,
  RemediationReportObservation,
} from "../../../orchestration/completion-check-runner";
import { parseRunEventResourcePolicy } from "../../../orchestration/run-directory-handle";

export const MAX_REMEDIATION_REPORT_BASE64_LENGTH = 4 * Math.ceil(MAX_STRUCTURED_REPORT_BYTES / 3);

/** V2 only: 12 MiB admits one 8 MiB base64 report plus envelope; the whole
 * retained journal is limited to 64 MiB / 1024 records, before JSON decoding. */
export const REMEDIATION_EVENT_RESOURCE_POLICY = (() => {
  const parsed = parseRunEventResourcePolicy({
    maxEventBytes: 12 * 1024 * 1024,
    maxJournalBytes: 64 * 1024 * 1024,
    maxRecords: 1024,
  });
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
})();

export type DurableRemediationReport =
  | Readonly<{ kind: "missing"; path: string }>
  | Readonly<{ kind: "unreadable"; path: string; message: string }>
  | Readonly<{
      kind: "produced";
      path: string;
      digest: ArtifactDigest;
      byteLength: number;
      mode: number;
      encoding: "base64";
      bytes: string;
    }>;

export type RemediationCheckObservedEvent = Readonly<{
  kind: "remediation-check-observed";
  schemaVersion: 1;
  registrationDigest: ArtifactDigest;
  authorityDigest: ArtifactDigest;
  candidateWitnessDigest: ArtifactDigest;
  checkId: CompletionCheckId;
  process: RemediationCheckExecution["process"];
  report: DurableRemediationReport | null;
  beforeCandidateDigest: ArtifactDigest;
  afterCandidateDigest: ArtifactDigest | null;
}>;

export type RemediationCheckReplay =
  | Readonly<{ kind: "passed"; observation: EngineObservedRepairedCheck }>
  | Readonly<{ kind: "terminal-failure"; checkId: CompletionCheckId; message: string }>;

export type RemediationEventError = Readonly<{
  kind: "invalid-remediation-check-event";
  message: string;
}>;

const success = <T>(value: T): DomainResult<T, RemediationEventError> =>
  Object.freeze({ ok: true, value });
const failure = <T>(message: string): DomainResult<T, RemediationEventError> =>
  Object.freeze({ ok: false, error: Object.freeze({ kind: "invalid-remediation-check-event", message }) });

function exactRecord(raw: unknown, fields: readonly string[], label: string): DomainResult<Readonly<Record<string, unknown>>, RemediationEventError> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return failure(`${label} must be a plain object`);
  const keys = Reflect.ownKeys(raw);
  if (keys.some((key) => typeof key !== "string")) return failure(`${label} must not contain symbol fields`);
  const names = keys as string[];
  if (names.length !== fields.length || fields.some((field) => !names.includes(field))) {
    return failure(`${label} must contain exactly ${fields.join(", ")}`);
  }
  const copy = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, field);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return failure(`${label}.${field} must be an enumerable own-data field`);
    }
    copy[field] = descriptor.value;
  }
  return success(Object.freeze(copy));
}

function durableReport(report: RemediationReportObservation | null): DurableRemediationReport | null {
  if (report === null) return null;
  if (report.outcome.kind === "missing") return Object.freeze({ kind: "missing", path: report.outcome.path });
  if (report.outcome.kind === "unreadable") {
    return Object.freeze({ kind: "unreadable", path: report.outcome.path, message: report.outcome.message });
  }
  if (!("bytes" in report)) throw new Error("produced remediation report lost its stable bytes");
  if (report.bytes.byteLength > MAX_STRUCTURED_REPORT_BYTES || report.outcome.byteLength > MAX_STRUCTURED_REPORT_BYTES) {
    return Object.freeze({ kind: "unreadable", path: report.outcome.path, message: "structured report exceeds byte limit before persistence" });
  }
  const bytes = Uint8Array.from(report.bytes);
  return Object.freeze({
    kind: "produced",
    path: report.outcome.path,
    digest: report.outcome.digest,
    byteLength: report.outcome.byteLength,
    mode: report.mode,
    encoding: "base64",
    bytes: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
  });
}

/** Clone raw runner facts immediately into the immutable durable event shape. */
export function remediationCheckObservedEvent(
  execution: RemediationCheckExecution,
  before: CandidateRepositoryWitness,
  after: CandidateRepositoryWitness | null,
): RemediationCheckObservedEvent {
  return Object.freeze({
    kind: "remediation-check-observed",
    schemaVersion: 1,
    registrationDigest: execution.scope.registrationDigest,
    authorityDigest: execution.authorityDigest,
    candidateWitnessDigest: execution.scope.candidateWitnessDigest,
    checkId: execution.checkId,
    process: Object.freeze({ ...execution.process }),
    report: durableReport(execution.report),
    beforeCandidateDigest: before.digest,
    afterCandidateDigest: after?.digest ?? null,
  });
}

function terminal(checkId: CompletionCheckId, message: string): DomainResult<RemediationCheckReplay, RemediationEventError> {
  return success(Object.freeze({ kind: "terminal-failure", checkId, message }));
}

/** Reparse exact embedded bytes and reconstruct opaque core evidence. */
export function replayRemediationCheckObservedEvent(
  raw: unknown,
  authorized: AuthorizedRemediationCheck,
  candidate: CandidateRepositoryWitness,
): DomainResult<RemediationCheckReplay, RemediationEventError> {
  const event = exactRecord(raw, [
    "kind", "schemaVersion", "registrationDigest", "authorityDigest", "candidateWitnessDigest",
    "checkId", "process", "report", "beforeCandidateDigest", "afterCandidateDigest",
  ], "remediation check event");
  if (!event.ok) return event;
  if (event.value.kind !== "remediation-check-observed" || event.value.schemaVersion !== 1 ||
      event.value.checkId !== authorized.command.checkId ||
      event.value.registrationDigest !== authorized.scope.registrationDigest ||
      event.value.authorityDigest !== authorized.authorityDigest ||
      event.value.candidateWitnessDigest !== candidate.digest ||
      event.value.beforeCandidateDigest !== candidate.digest || event.value.afterCandidateDigest !== candidate.digest) {
    return failure("remediation check event has foreign registration, check, authority, or candidate binding");
  }
  const processKind = typeof event.value.process === "object" && event.value.process !== null
    ? Object.getOwnPropertyDescriptor(event.value.process, "kind")?.value
    : undefined;
  const processFields = processKind === "spawn-failed"
    ? ["kind", "message"]
    : ["kind", "exitCode", "timedOut", "signal"];
  const process = exactRecord(event.value.process, processFields, "remediation check event.process");
  if (!process.ok) return process;
  if (process.value.kind === "spawn-failed") {
    return typeof process.value.message === "string" && process.value.message.length > 0
      ? terminal(authorized.command.checkId, `check spawn failed: ${process.value.message}`)
      : failure("spawn-failed process event requires a message");
  }
  if (process.value.kind !== "observed" ||
      (process.value.exitCode !== null && (!Number.isSafeInteger(process.value.exitCode) || typeof process.value.exitCode !== "number")) ||
      typeof process.value.timedOut !== "boolean" ||
      (process.value.signal !== null && typeof process.value.signal !== "string")) {
    return failure("observed process event is malformed");
  }
  if (process.value.exitCode !== 0 || process.value.timedOut || process.value.signal !== null) {
    return terminal(authorized.command.checkId, "check process did not exit normally with status zero");
  }
  if (event.value.report === null) return terminal(authorized.command.checkId, "check produced no report observation");
  const reportKind = typeof event.value.report === "object" && event.value.report !== null
    ? Object.getOwnPropertyDescriptor(event.value.report, "kind")?.value
    : undefined;
  const reportFields = reportKind === "produced"
    ? ["kind", "path", "digest", "byteLength", "mode", "encoding", "bytes"]
    : reportKind === "unreadable" ? ["kind", "path", "message"] : ["kind", "path"];
  const report = exactRecord(event.value.report, reportFields, "remediation check event.report");
  if (!report.ok) return report;
  if (report.value.kind === "missing") return terminal(authorized.command.checkId, "required structured report is missing or stale");
  if (report.value.kind === "unreadable") return terminal(authorized.command.checkId, "required structured report was unreadable");
  if (report.value.kind !== "produced" || report.value.encoding !== "base64" || typeof report.value.bytes !== "string") {
    return failure("produced remediation report encoding is invalid");
  }
  if (typeof report.value.byteLength !== "number" || !Number.isSafeInteger(report.value.byteLength) ||
      report.value.byteLength < 0 || report.value.byteLength > MAX_STRUCTURED_REPORT_BYTES ||
      report.value.bytes.length > MAX_REMEDIATION_REPORT_BASE64_LENGTH) {
    return failure("produced remediation report exceeds byte limit before base64 decoding");
  }
  // The final base64 quantum can represent up to two bytes beyond the raw
  // limit despite having an allowed encoded length; reject those before decode.
  const padding = report.value.bytes.endsWith("==") ? 2 : Number(report.value.bytes.endsWith("="));
  if (report.value.bytes.length / 4 * 3 - padding > MAX_STRUCTURED_REPORT_BYTES) {
    return failure("produced remediation report exceeds byte limit before base64 decoding");
  }
  let bytes: Buffer;
  try { bytes = Buffer.from(report.value.bytes, "base64"); } catch { return failure("report bytes are not base64"); }
  if (bytes.toString("base64") !== report.value.bytes) return failure("report bytes are not canonical base64");
  if (!Number.isSafeInteger(report.value.byteLength) || report.value.byteLength !== bytes.byteLength ||
      typeof report.value.digest !== "string" || report.value.digest !== sha256Bytes(bytes) ||
      !Number.isSafeInteger(report.value.mode) || typeof report.value.mode !== "number" || report.value.mode < 0 ||
      report.value.path !== authorized.command.reportPolicy.path) {
    return failure("produced remediation report path, byte length, digest, or mode is invalid");
  }
  const parsed = parseStructuredTestReportBytes(bytes);
  if (!parsed.ok) return terminal(authorized.command.checkId, parsed.error.message);
  const observed = parseRegisteredRemediationCheckObservation(authorized, candidate, candidate, {
    kind: "remediation-check-observed",
    checkId: authorized.command.checkId,
    registrationDigest: authorized.scope.registrationDigest,
    authorityDigest: authorized.authorityDigest,
    candidateWitnessDigest: candidate.digest,
    process: {
      exitCode: process.value.exitCode,
      timedOut: process.value.timedOut,
      signal: process.value.signal,
    },
    report: {
      path: report.value.path,
      digest: report.value.digest,
      byteLength: report.value.byteLength,
      mode: report.value.mode,
      summary: parsed.value,
    },
    beforeCandidateDigest: candidate.digest,
    afterCandidateDigest: candidate.digest,
  });
  return observed.ok
    ? success(Object.freeze({ kind: "passed", observation: observed.value }))
    : terminal(authorized.command.checkId, observed.error.failures.map(({ message }) => message).join("; "));
}
