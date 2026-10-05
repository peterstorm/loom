/**
 * The legacy panel program's Run Directory shell (AD-8/AD-9, FR-006/009/011/012).
 *
 * Every decision — registration, the verdict-source selection policy,
 * submission settlement, and deterministic operations — lives in the pure
 * core/legacy-panel-decisions module and takes already-read evidence. This
 * module only moves bytes across the Run Directory:
 * `resolvePanelAttemptVerdictSource` reads one attempt's durable
 * panel-verdict-source record (after the issuance joins hold) and hands it to
 * the core's selection; `settlePanelAttemptSubmission` settles the attempt and
 * publishes the write-ahead source record the settlement owes; and
 * `panelOperationEvidence` is the Run Directory adapter of a deterministic
 * operation's capture lookup.
 */
import type { AgentRequestAuthority, DomainResult } from "../../../core/orchestration-contract";
import type { PanelVerdictSource, PanelVerdictSourceRecord } from "../../../core/panel-verdict-source";
import { captureKey } from "../../../core/harness-capture";
import {
  joinPanelAttemptIssuance,
  logicalPanelRequestId,
  parsePanelVerdictSourceRecordBytes,
  selectPanelAttemptVerdictSource,
  settlePanelAttempt,
  type PanelAttempt,
  type PanelAttemptVerdictSource,
  type PanelOperationEvidence,
  type PanelSubmission,
} from "../../../core/legacy-panel-decisions";
import type { RunDirHandle } from "../../../orchestration/run-directory-handle";
import type { ProgramParse } from "./program-result";

// ---------------------------------------------------------------------------
// Verdict-source shell: the durable record's read and write-ahead publication
// ---------------------------------------------------------------------------

const PANEL_VERDICT_SOURCES_BOUND_BYTES = 65_536;

const panelVerdictSourceArtifactPath = (requestId: string): string => `panel-verdict-sources/${requestId}.json`;

const bytesEqual = (left: Uint8Array, right: readonly number[]): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

function readPanelVerdictSourceRecord(handle: RunDirHandle, request: AgentRequestAuthority): DomainResult<PanelVerdictSourceRecord | null, string> {
  const bytes = handle.readArtifactBytes(panelVerdictSourceArtifactPath(request.requestId), PANEL_VERDICT_SOURCES_BOUND_BYTES);
  if (!bytes.ok) return { ok: false, error: `the durable panel verdict source for request ${request.requestId} is unreadable: ${bytes.error.message}` };
  return parsePanelVerdictSourceRecordBytes(request.requestId, bytes.value);
}

/**
 * Resolve ONE panel attempt's verdict source from its Run Directory. The
 * issuance joins are checked before the durable record is read: a caller
 * defect never reads (or consumes) attempt evidence.
 */
export function resolvePanelAttemptVerdictSource(args: PanelAttempt & Readonly<{ handle: RunDirHandle }>): DomainResult<PanelAttemptVerdictSource, string> {
  const joined = joinPanelAttemptIssuance({ request: args.request, raw: args.raw, emission: args.emission });
  if (!joined.ok) return joined;
  const record = readPanelVerdictSourceRecord(args.handle, args.request);
  if (!record.ok) return record;
  return selectPanelAttemptVerdictSource(joined.value, record.value);
}

/** Publish one attempt's accepted source record BEFORE its outcome is declared
 *  (write-ahead, the capture seam's exact posture): an identical prior record
 *  proceeds, a DIFFERENT one refuses — the recorded selection is authoritative
 *  and is never rewritten. */
async function publishPanelVerdictSourceRecord(handle: RunDirHandle, request: AgentRequestAuthority, record: PanelVerdictSourceRecord): Promise<DomainResult<true, string>> {
  const serialized = `${JSON.stringify(record, null, 2)}\n`;
  const bytes = Object.freeze([...Buffer.from(serialized, "utf-8")]);
  if (bytes.length > PANEL_VERDICT_SOURCES_BOUND_BYTES) {
    return { ok: false, error: `the panel verdict source record for request ${request.requestId} exceeds the ${PANEL_VERDICT_SOURCES_BOUND_BYTES}-byte publication bound` };
  }
  const path = panelVerdictSourceArtifactPath(request.requestId);
  const prior = handle.readArtifactBytes(path, PANEL_VERDICT_SOURCES_BOUND_BYTES);
  if (!prior.ok) return { ok: false, error: prior.error.message };
  if (prior.value !== null) {
    return bytesEqual(prior.value, bytes)
      ? { ok: true, value: true }
      : { ok: false, error: `panel verdict source provenance for request ${request.requestId} is already published with a different accepted source; the recorded selection is authoritative and is never rewritten` };
  }
  const published = await handle.publishArtifactSet([{ relativePath: path, bytes }]);
  return published.ok ? { ok: true, value: true } : { ok: false, error: published.error.message };
}

/**
 * Settle ONE panel attempt's submission through the resolved verdict source:
 * the decision, then the write-ahead source record when the settlement owes
 * one.
 */
export async function settlePanelAttemptSubmission(
  args: PanelSubmission & Readonly<{ handle: RunDirHandle }>,
): Promise<DomainResult<Readonly<{ problem: string | null; source: PanelVerdictSource | null }>, string>> {
  const resolved = resolvePanelAttemptVerdictSource(args);
  if (!resolved.ok) return resolved;
  const settlement = settlePanelAttempt(args, resolved.value);
  if (!settlement.ok) return settlement;
  const { problem, source, publication } = settlement.value;
  if (publication !== null) {
    const published = await publishPanelVerdictSourceRecord(args.handle, args.request, publication);
    if (!published.ok) return published;
  }
  return { ok: true, value: Object.freeze({ problem, source }) };
}

// ---------------------------------------------------------------------------
// Deterministic operation evidence: the Run Directory capture lookup
// ---------------------------------------------------------------------------

/** The latest captured attempt of one logical panel request. */
function capturedPanelAttempt(
  handle: RunDirHandle,
  logicalRequestId: string,
): Readonly<{ ok: true; request: AgentRequestAuthority; raw: string }> | Readonly<{ ok: false; message: string }> {
  const issued = handle.readIssuedRequests();
  if (!issued.ok) return { ok: false, message: issued.error.message };
  const captured = handle.readCapturedAttempts();
  if (!captured.ok) return { ok: false, message: captured.error.message };
  const candidates = issued.value
    .filter((request) => logicalPanelRequestId(request.requestId, request.attempt) === logicalRequestId &&
      captured.value.has(captureKey(request.slotId, request.attempt)))
    .sort((left, right) => right.attempt - left.attempt);
  const request = candidates[0];
  if (request === undefined) return { ok: false, message: `operation is missing captured result for ${logicalRequestId}` };
  const bytes = handle.readTranscriptBytes(request);
  return bytes.ok
    ? { ok: true, request, raw: Buffer.from(bytes.value).toString("utf-8") }
    : { ok: false, message: bytes.error.message };
}

/** The Run Directory adapter of a deterministic operation's evidence lookup. */
export function panelOperationEvidence(handle: RunDirHandle): PanelOperationEvidence {
  return Object.freeze({
    capturedRaw: (logicalRequestId: string): ProgramParse<string> => {
      const captured = capturedPanelAttempt(handle, logicalRequestId);
      return captured.ok ? { ok: true, value: captured.raw } : captured;
    },
    parseTarget: (logicalRequestId: string): ProgramParse<string> => {
      const captured = capturedPanelAttempt(handle, logicalRequestId);
      if (!captured.ok) return captured;
      const resolved = resolvePanelAttemptVerdictSource({ handle, request: captured.request, raw: captured.raw });
      if (!resolved.ok) return { ok: false, message: resolved.error };
      return resolved.value.kind === "selected" && resolved.value.selection.kind === "emission-tool-arguments"
        ? { ok: true, value: resolved.value.selection.rawJson }
        : { ok: true, value: captured.raw };
    },
  });
}
