/**
 * Standalone reviewer capture: the exact captured reviewer bytes, and the request-bound
 * capture boundary. Harnesses submit only an issued request identity and raw bytes;
 * attribution and destination are resolved from frozen authority, and only parser-bound
 * capture authority and prepared captures (process-local membership) can complete.
 */
import { canonicalDigest, sha256Bytes, sha256Hex } from "./digest";
import {
  acceptedAgentResult, canonicalRecord, parseArtifactRef, parseEffectId, reconcileEffectReceipt, sameAgentRequestAuthority,
  type AcceptedAgentResult, type AgentRequestAuthority, type ArtifactRef, type CaptureRawTranscript, type DomainResult,
  type RawTranscriptCaptured, type SemanticPayloadParseError, type SpawnRequest,
} from "./orchestration-contract";
import { failure, success } from "./orchestration-contract/identity";
import { isRecord } from "./panel-kernel";
import type { FrozenStandaloneReviewAuthority } from "./standalone-review-model";
import { exactKeys } from "./standalone-review-scope";

interface RawReviewerBytes {
  readonly encoding: "base64";
  readonly data: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface CapturedReviewerResult {
  readonly schemaVersion: 1;
  readonly kind: "captured-reviewer-result";
  readonly artifact: ArtifactRef;
  /** Canonical byte representation; invalid UTF-8 is never replacement-decoded. */
  readonly rawBytes: RawReviewerBytes;
}

function parseReviewerBytes(raw: unknown): DomainResult<Uint8Array, SemanticPayloadParseError> {
  if (raw instanceof Uint8Array) {
    return raw.byteLength === 0
      ? failure({ message: "captured reviewer bytes must be non-empty" })
      : success(Uint8Array.from(raw));
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((byte) =>
    typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    return failure({ message: "captured reviewer bytes must be a non-empty byte array" });
  }
  return success(Uint8Array.from(raw as readonly number[]));
}

function canonicalRawReviewerBytes(bytes: Uint8Array): RawReviewerBytes {
  return canonicalRecord({
    encoding: "base64" as const,
    data: Buffer.from(bytes).toString("base64"),
    byteLength: bytes.byteLength,
    sha256: sha256Bytes(bytes),
  });
}

function parseRawReviewerBytes(raw: unknown): DomainResult<RawReviewerBytes, SemanticPayloadParseError> {
  if (!isRecord(raw)) return failure({ message: "captured reviewer rawBytes must be an object" });
  const errors = exactKeys(raw, ["encoding", "data", "byteLength", "sha256"], "captured reviewer rawBytes");
  if (errors.length > 0 || raw.encoding !== "base64" || typeof raw.data !== "string" ||
      typeof raw.byteLength !== "number" || !Number.isSafeInteger(raw.byteLength) || raw.byteLength <= 0 ||
      typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha256)) {
    return failure({ message: errors.join("; ") || "captured reviewer rawBytes metadata is invalid" });
  }
  const bytes = Buffer.from(raw.data, "base64");
  if (bytes.toString("base64") !== raw.data) return failure({ message: "captured reviewer rawBytes data is not canonical base64" });
  const canonical = canonicalRawReviewerBytes(bytes);
  if (canonical.byteLength !== raw.byteLength || canonical.sha256 !== raw.sha256) {
    return failure({ message: "captured reviewer rawBytes metadata does not match its exact decoded bytes" });
  }
  return success(canonical);
}

export function capturedReviewerResultFromBytes(
  rawArtifact: unknown,
  rawBytes: unknown,
): DomainResult<CapturedReviewerResult, SemanticPayloadParseError> {
  const artifact = parseArtifactRef(rawArtifact);
  if (!artifact.ok) return failure({ message: `captured reviewer artifact is invalid: ${artifact.error.message}` });
  const bytes = parseReviewerBytes(rawBytes);
  if (!bytes.ok) return bytes;
  const encoded = canonicalRawReviewerBytes(bytes.value);
  if (artifact.value.byteLength !== encoded.byteLength) {
    return failure({ message: "captured reviewer artifact byteLength does not match exact raw bytes" });
  }
  if (artifact.value.digest !== encoded.sha256) {
    return failure({ message: "captured reviewer artifact digest does not match exact raw bytes" });
  }
  return success(canonicalRecord({
    schemaVersion: 1,
    kind: "captured-reviewer-result",
    artifact: artifact.value,
    rawBytes: encoded,
  }));
}

export function capturedReviewerResultFromText(
  rawArtifact: unknown,
  rawOutput: unknown,
): DomainResult<CapturedReviewerResult, SemanticPayloadParseError> {
  return typeof rawOutput === "string" && rawOutput.length > 0
    ? capturedReviewerResultFromBytes(rawArtifact, Buffer.from(rawOutput, "utf-8"))
    : failure({ message: "captured reviewer rawOutput must be a non-empty string" });
}

/** Payload parser supplied directly to T1's parseCompleteRoster. */
export function parseCapturedReviewerResult(raw: unknown): DomainResult<CapturedReviewerResult, SemanticPayloadParseError> {
  if (!isRecord(raw)) return failure({ message: "captured reviewer result must be an object" });
  const errors = exactKeys(raw, ["schemaVersion", "kind", "artifact", "rawBytes"], "captured reviewer result");
  if (errors.length > 0) return failure({ message: errors.join("; ") });
  if (raw.schemaVersion !== 1 || raw.kind !== "captured-reviewer-result") {
    return failure({ message: "captured reviewer result schemaVersion or kind is invalid" });
  }
  const encoded = parseRawReviewerBytes(raw.rawBytes);
  if (!encoded.ok) return encoded;
  return capturedReviewerResultFromBytes(raw.artifact, Buffer.from(encoded.value.data, "base64"));
}

export function decodeCapturedReviewerText(captured: CapturedReviewerResult): DomainResult<string, SemanticPayloadParseError> {
  try {
    return success(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(captured.rawBytes.data, "base64")));
  } catch {
    return failure({ message: "captured reviewer bytes are not valid UTF-8 semantic output" });
  }
}

/** Stable identity retained by LC-2 when a sibling result is accepted early. */
export function fingerprintCapturedReviewerResult(result: CapturedReviewerResult): string {
  return canonicalDigest({
    runId: result.artifact.runId,
    slot: result.artifact.slot.path,
    digest: result.artifact.digest,
    byteLength: result.artifact.byteLength,
    rawBytes: result.rawBytes,
  });
}

export type StandaloneCaptureError = Readonly<{
  kind: "standalone-capture-rejected";
  message: string;
}>;

export interface StandaloneCaptureAuthority {
  readonly schemaVersion: 1;
  readonly kind: "standalone-capture-authority";
  readonly authority: FrozenStandaloneReviewAuthority;
  readonly issuedRequests: readonly SpawnRequest[];
}

/** T11 implements this port from durable reservation/publication receipts. */
type StandaloneIssuedRequestAuthorityResolver = (
  request: SpawnRequest,
) => DomainResult<SpawnRequest, StandaloneCaptureError>;

export interface PreparedStandaloneReviewerCapture {
  readonly kind: "prepared-standalone-reviewer-capture";
  readonly request: AgentRequestAuthority;
  readonly issuedRequest: SpawnRequest;
  readonly intent: CaptureRawTranscript;
  readonly expectedArtifact: ArtifactRef;
  readonly rawBytes: RawReviewerBytes;
}

const standaloneCaptureAuthorityCache = new WeakSet<object>();
const preparedStandaloneCaptureCache = new WeakSet<object>();
const captureFailure = (message: string): DomainResult<never, StandaloneCaptureError> =>
  failure(canonicalRecord({ kind: "standalone-capture-rejected", message }));


/** Bind only T1-issued requests to the frozen standalone authority. */
export function bindStandaloneCaptureAuthority(
  authority: FrozenStandaloneReviewAuthority,
  issuedRequests: readonly SpawnRequest[],
): DomainResult<StandaloneCaptureAuthority, StandaloneCaptureError> {
  if (!Array.isArray(issuedRequests) || issuedRequests.length === 0) return captureFailure("issued request set must be non-empty");
  const seenRequests = new Set<string>();
  const seenSlots = new Set<string>();
  const canonical: SpawnRequest[] = [];
  for (const request of issuedRequests) {
    const issuance = acceptedAgentResult(request, null);
    if (!issuance.ok) return captureFailure(issuance.error.message);
    const slot = authority.roster.byId.get(request.authority.slotId);
    const expected = request.authority.attempt === 1 ? slot?.attempts[0] : slot?.attempts[1];
    if (expected === undefined || !sameAgentRequestAuthority(request.authority, expected) || request.authority.runId !== authority.runId) {
      return captureFailure("issued request does not match frozen standalone run/agent/request/context/model/output authority");
    }
    if (seenRequests.has(request.authority.requestId) || seenSlots.has(request.authority.slotId)) {
      return captureFailure("issued request set contains duplicate request or semantic slot authority");
    }
    seenRequests.add(request.authority.requestId);
    seenSlots.add(request.authority.slotId);
    canonical.push(request);
  }
  const bound = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "standalone-capture-authority" as const,
    authority,
    issuedRequests: Object.freeze(canonical),
  });
  standaloneCaptureAuthorityCache.add(bound);
  return success(bound);
}

/** Rebuild request-bound capture authority only after durable issuance proof. */
export function parseStandaloneCaptureAuthority(
  authority: FrozenStandaloneReviewAuthority,
  rawIssuedRequests: unknown,
  resolveIssuedRequest: StandaloneIssuedRequestAuthorityResolver,
): DomainResult<StandaloneCaptureAuthority, StandaloneCaptureError> {
  if (!Array.isArray(rawIssuedRequests) || rawIssuedRequests.length === 0) {
    return captureFailure("persisted issued request set must be non-empty");
  }
  const parsedRequests: SpawnRequest[] = [];
  for (const rawRequest of rawIssuedRequests) {
    if (!isRecord(rawRequest)) return captureFailure("persisted issued request is malformed");
    const proof = resolveIssuedRequest(rawRequest as unknown as SpawnRequest);
    if (!proof.ok) return proof;
    if (JSON.stringify(proof.value) !== JSON.stringify(rawRequest)) {
      return captureFailure("persisted issued request differs from durable issuance authority");
    }
    parsedRequests.push(proof.value);
  }
  return bindStandaloneCaptureAuthority(authority, parsedRequests);
}

/**
 * Request-bound direct capture boundary. Harnesses submit only the issued
 * request identity and exact bytes; all attribution and destination facts are
 * resolved from internal authority before an effect can be emitted.
 */
export function captureStandaloneReviewerBytes(
  captureAuthority: StandaloneCaptureAuthority,
  requestIdentity: unknown,
  rawBytes: unknown,
): DomainResult<PreparedStandaloneReviewerCapture, StandaloneCaptureError> {
  if (typeof captureAuthority !== "object" || captureAuthority === null || !standaloneCaptureAuthorityCache.has(captureAuthority)) {
    return captureFailure("capture requires parser-bound issued standalone request authority");
  }
  const request = captureAuthority.issuedRequests.find(({ authority }) => authority.requestId === requestIdentity);
  if (request === undefined) return captureFailure("request identity is missing, stale, foreign, or was not issued for this capture authority");
  const bytes = parseReviewerBytes(rawBytes);
  if (!bytes.ok) return captureFailure(bytes.error.message);
  const encoded = canonicalRawReviewerBytes(bytes.value);
  const artifact = parseArtifactRef({
    runId: request.authority.runId,
    slot: request.authority.outputSlot,
    digest: encoded.sha256,
    byteLength: encoded.byteLength,
  });
  // One canonical derivation shared by the core intent, the durable runtime
  // receipt and the witness reader: the attempt is part of every durable
  // capture receipt's identity, so a receipt reconciled directly against this
  // intent cannot diverge from the runtime-recorded form.
  const effectId = parseEffectId(`effect:capture:${sha256Hex(`${request.authority.requestId}:${request.authority.attempt}`)}`);
  if (!artifact.ok) return captureFailure(artifact.error.message);
  if (!effectId.ok) return captureFailure(effectId.error.message);
  const prepared = canonicalRecord({
    kind: "prepared-standalone-reviewer-capture" as const,
    request: request.authority,
    issuedRequest: request,
    intent: canonicalRecord({
      kind: "capture-raw-transcript" as const,
      effectId: effectId.value,
      runId: request.authority.runId,
      request: request.authority,
      bytes: Object.freeze([...bytes.value]),
    }),
    expectedArtifact: artifact.value,
    rawBytes: encoded,
  });
  preparedStandaloneCaptureCache.add(prepared);
  return success(prepared);
}

/** Rehydrate a prepared capture by re-deriving its byte identity and destination. */
export function parsePreparedStandaloneReviewerCapture(
  captureAuthority: StandaloneCaptureAuthority,
  raw: unknown,
): DomainResult<PreparedStandaloneReviewerCapture, StandaloneCaptureError> {
  if (!isRecord(raw) || raw.kind !== "prepared-standalone-reviewer-capture" ||
      !isRecord(raw.request) || typeof raw.request.requestId !== "string" || !isRecord(raw.rawBytes)) {
    return captureFailure("persisted prepared standalone capture is malformed");
  }
  const encoded = parseRawReviewerBytes(raw.rawBytes);
  if (!encoded.ok) return captureFailure(encoded.error.message);
  const rebuilt = captureStandaloneReviewerBytes(
    captureAuthority,
    raw.request.requestId,
    Buffer.from(encoded.value.data, "base64"),
  );
  if (!rebuilt.ok) return rebuilt;
  if (JSON.stringify(rebuilt.value.intent) !== JSON.stringify(raw.intent) ||
      JSON.stringify(rebuilt.value.expectedArtifact) !== JSON.stringify(raw.expectedArtifact)) {
    return captureFailure("persisted prepared capture intent or artifact destination was changed");
  }
  return rebuilt;
}

/** Complete capture only from T1's typed receipt reconciliation. */
export function completeStandaloneReviewerCapture(
  prepared: PreparedStandaloneReviewerCapture,
  rawReceipt: unknown,
): DomainResult<AcceptedAgentResult<CapturedReviewerResult>, StandaloneCaptureError> {
  if (typeof prepared !== "object" || prepared === null || !preparedStandaloneCaptureCache.has(prepared)) {
    return captureFailure("capture completion requires the exact prepared request/byte authority");
  }
  const reconciled = reconcileEffectReceipt(prepared.intent, rawReceipt);
  if (!reconciled.ok || reconciled.value.kind !== "raw-transcript-captured") {
    return captureFailure(reconciled.ok ? "capture receipt has the wrong effect kind" : reconciled.error.message);
  }
  const receipt: RawTranscriptCaptured = reconciled.value;
  const captured = capturedReviewerResultFromBytes(receipt.artifact, Buffer.from(prepared.rawBytes.data, "base64"));
  if (!captured.ok) return captureFailure(captured.error.message);
  const accepted = acceptedAgentResult(prepared.issuedRequest, captured.value);
  return accepted.ok ? success(accepted.value) : captureFailure(accepted.error.message);
}
