/**
 * Sub-domain volume of the orchestration shared kernel. The module-level
 * contract lives in index.ts (facade); this file owns one region of the
 * kernel and exports its internals so sibling volumes can import them.
 * Pure module: no I/O, no clock, no randomness.
 */
import { parseReviewPath } from '../review-packet';
import { type RepositoryPath } from '../repository-path';
import { posix } from 'node:path';
import { canonicalRecord, describeUnknown, failure, parseArtifactDigest, parseEffectId, parseOrchestrationRunId, parseRequestId, success, type ArtifactDigest, type DomainResult, type EffectId, type NonEmpty, type OrchestrationRunId, type RequestId } from './identity';
import { digestRawTranscriptBytes, parseRawTranscriptBytes, readDenseDataArray, readExactDataRecord } from './bytes';
import { parseStoredAgentRequestAuthority, parseArtifactRef, type AgentRequestAuthority, type ArtifactRef } from './roster';

export type PublishArtifactSet = Readonly<{
  kind: "publish-artifact-set";
  effectId: EffectId;
  runId: OrchestrationRunId;
  artifacts: NonEmpty<ArtifactRef>;
}>;
export type CommitProtectedWaveState = Readonly<{
  kind: "commit-protected-wave-state";
  effectId: EffectId;
  runId: OrchestrationRunId;
  expectedRevision: number;
  stateDigest: ArtifactDigest;
}>;
export type ReserveAgentRequests = Readonly<{
  kind: "reserve-agent-requests";
  effectId: EffectId;
  runId: OrchestrationRunId;
  requests: NonEmpty<AgentRequestAuthority>;
}>;
export type CaptureRawTranscript = Readonly<{
  kind: "capture-raw-transcript";
  effectId: EffectId;
  runId: OrchestrationRunId;
  request: AgentRequestAuthority;
  bytes: readonly number[];
}>;
export type InspectGitRemediation = Readonly<{
  kind: "inspect-git-remediation";
  effectId: EffectId;
  runId: OrchestrationRunId;
  paths: readonly RepositoryPath[];
}>;
export type InstallVerifiedIndex = Readonly<{
  kind: "install-verified-index";
  effectId: EffectId;
  runId: OrchestrationRunId;
  indexDigest: ArtifactDigest;
  witnessDigest: ArtifactDigest;
}>;

export type EffectIntent =
  | PublishArtifactSet
  | CommitProtectedWaveState
  | ReserveAgentRequests
  | CaptureRawTranscript
  | InspectGitRemediation
  | InstallVerifiedIndex;

export type ArtifactSetPublished = Readonly<{
  kind: "artifact-set-published";
  effectId: EffectId;
  runId: OrchestrationRunId;
  artifacts: NonEmpty<ArtifactRef>;
}>;
export type ProtectedWaveStateCommitted = Readonly<{
  kind: "protected-wave-state-committed";
  effectId: EffectId;
  runId: OrchestrationRunId;
  committedRevision: number;
  stateDigest: ArtifactDigest;
}>;
export type AgentRequestsReserved = Readonly<{
  kind: "agent-requests-reserved";
  effectId: EffectId;
  runId: OrchestrationRunId;
  requestIds: NonEmpty<RequestId>;
}>;
export type RawTranscriptCaptured = Readonly<{
  kind: "raw-transcript-captured";
  effectId: EffectId;
  runId: OrchestrationRunId;
  requestId: RequestId;
  artifact: ArtifactRef;
}>;
export type GitRemediationInspected = Readonly<{
  kind: "git-remediation-inspected";
  effectId: EffectId;
  runId: OrchestrationRunId;
  witnessDigest: ArtifactDigest;
  paths: readonly RepositoryPath[];
}>;
export type VerifiedIndexInstalled = Readonly<{
  kind: "verified-index-installed";
  effectId: EffectId;
  runId: OrchestrationRunId;
  indexDigest: ArtifactDigest;
  witnessDigest: ArtifactDigest;
}>;

export type EffectReceipt =
  | ArtifactSetPublished
  | ProtectedWaveStateCommitted
  | AgentRequestsReserved
  | RawTranscriptCaptured
  | GitRemediationInspected
  | VerifiedIndexInstalled;

export type ArtifactSlotAssignment = Readonly<{
  index: number;
  artifact: ArtifactRef;
}>;

export type ArtifactSlotConflict = Readonly<{
  path: string;
  first: ArtifactSlotAssignment;
  duplicate: ArtifactSlotAssignment;
}>;

export type EffectReceiptError = Readonly<{
  kind: "effect-receipt-mismatch";
  effectId: EffectId | null;
  field: string;
  message: string;
  artifactSlotConflict?: ArtifactSlotConflict;
}>;

export type ReconciliationParseError = Readonly<{
  field: string;
  message: string;
  artifactSlotConflict?: ArtifactSlotConflict;
}>;

export function reconciliationFailure<T>(
  field: string,
  message: string,
  artifactSlotConflict?: ArtifactSlotConflict,
): DomainResult<T, ReconciliationParseError> {
  return failure(canonicalRecord({
    field,
    message,
    ...(artifactSlotConflict === undefined ? {} : { artifactSlotConflict }),
  }));
}

export function reconciliationRecord(
  raw: unknown,
  allowed: readonly string[],
  prefix: string,
): DomainResult<Readonly<Record<string, unknown>>, ReconciliationParseError> {
  const record = readExactDataRecord(raw, allowed, prefix);
  return record.ok
    ? record
    : reconciliationFailure(
        record.error.field === null ? prefix : `${prefix}.${record.error.field}`,
        record.error.message,
      );
}

export function parseBaseEffect(
  raw: Readonly<Record<string, unknown>>,
  prefix: string,
): DomainResult<Readonly<{ effectId: EffectId; runId: OrchestrationRunId }>, ReconciliationParseError> {
  const effectId = parseEffectId(raw.effectId);
  const runId = parseOrchestrationRunId(raw.runId);
  if (!effectId.ok) return reconciliationFailure(`${prefix}.effectId`, effectId.error.message);
  if (!runId.ok) return reconciliationFailure(`${prefix}.runId`, runId.error.message);
  return success(canonicalRecord({ effectId: effectId.value, runId: runId.value }));
}

export function parseArtifactArray(raw: unknown, prefix: string): DomainResult<NonEmpty<ArtifactRef>, ReconciliationParseError> {
  const entries = readDenseDataArray(raw, prefix);
  if (!entries.ok || entries.value.length === 0) {
    return reconciliationFailure(prefix, entries.ok ? `${prefix} must be a non-empty array` : entries.error.message);
  }
  const artifacts: ArtifactRef[] = [];
  const assignments = new Map<string, ArtifactSlotAssignment>();
  for (let index = 0; index < entries.value.length; index++) {
    const parsed = parseArtifactRef(entries.value[index]);
    if (!parsed.ok) return reconciliationFailure(`${prefix}[${index}].${parsed.error.field}`, parsed.error.message);
    const assignment = canonicalRecord({ index, artifact: parsed.value });
    const first = assignments.get(parsed.value.slot.path);
    if (first !== undefined) {
      const conflict = canonicalRecord({
        path: parsed.value.slot.path,
        first,
        duplicate: assignment,
      });
      return reconciliationFailure(
        `${prefix}[${index}].slot.path`,
        `${prefix} assigns immutable artifact slot '${parsed.value.slot.path}' at both entries ${first.index} and ${index}`,
        conflict,
      );
    }
    assignments.set(parsed.value.slot.path, assignment);
    artifacts.push(parsed.value);
  }
  return success(Object.freeze(artifacts) as NonEmpty<ArtifactRef>);
}

export function parseRepositoryPathValue(raw: unknown, prefix: string): DomainResult<RepositoryPath, ReconciliationParseError> {
  const path = reconciliationRecord(raw, ["relative", "absolute"], prefix);
  if (!path.ok) return path;
  const relative = parseReviewPath(path.value.relative, `${prefix}.relative`);
  if (!relative.ok) return reconciliationFailure(`${prefix}.relative`, relative.errors.join("; "));
  const absolute = path.value.absolute;
  if (typeof absolute !== "string" || !posix.isAbsolute(absolute) || posix.normalize(absolute) !== absolute || absolute === "/") {
    return reconciliationFailure(`${prefix}.absolute`, `${prefix}.absolute must be a canonical absolute path`);
  }
  if (!absolute.endsWith(`/${relative.value}`)) {
    return reconciliationFailure(`${prefix}.absolute`, `${prefix}.absolute must identify the same relative path`);
  }
  return success(canonicalRecord({ relative: relative.value, absolute }));
}

export function parseRepositoryPathArray(raw: unknown, prefix: string): DomainResult<readonly RepositoryPath[], ReconciliationParseError> {
  const entries = readDenseDataArray(raw, prefix);
  if (!entries.ok) return reconciliationFailure(prefix, entries.error.message);
  const paths: RepositoryPath[] = [];
  for (let index = 0; index < entries.value.length; index++) {
    const parsed = parseRepositoryPathValue(entries.value[index], `${prefix}[${index}]`);
    if (!parsed.ok) return parsed;
    paths.push(parsed.value);
  }
  if (new Set(paths.map(({ relative }) => relative)).size !== paths.length) {
    return reconciliationFailure(prefix, `${prefix} must not contain duplicate paths`);
  }
  return success(Object.freeze(paths));
}

export const EFFECT_INTENT_FIELDS = [
  "kind", "effectId", "runId", "artifacts", "expectedRevision", "stateDigest", "requests",
  "request", "bytes", "paths", "indexDigest", "witnessDigest",
] as const;
export const EFFECT_RECEIPT_FIELDS = [
  "kind", "effectId", "runId", "artifacts", "committedRevision", "stateDigest", "requestIds",
  "requestId", "artifact", "witnessDigest", "paths", "indexDigest",
] as const;

export function parseEffectIntent(raw: unknown): DomainResult<EffectIntent, ReconciliationParseError> {
  const envelope = reconciliationRecord(raw, EFFECT_INTENT_FIELDS, "intent");
  if (!envelope.ok) return envelope;
  const base = parseBaseEffect(envelope.value, "intent");
  if (!base.ok) return base;
  switch (envelope.value.kind) {
    case "publish-artifact-set": {
      const intent = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "artifacts"], "intent");
      if (!intent.ok) return intent;
      const artifacts = parseArtifactArray(intent.value.artifacts, "intent.artifacts");
      if (!artifacts.ok) return artifacts;
      const foreign = artifacts.value.find((artifact) => artifact.runId !== base.value.runId);
      if (foreign !== undefined) return reconciliationFailure("intent.artifacts.runId", "every artifact must belong to the effect run");
      return success(canonicalRecord({ kind: "publish-artifact-set", ...base.value, artifacts: artifacts.value }));
    }
    case "commit-protected-wave-state": {
      const intent = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "expectedRevision", "stateDigest"], "intent");
      if (!intent.ok) return intent;
      const revision = intent.value.expectedRevision;
      if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
        return reconciliationFailure("intent.expectedRevision", "expectedRevision must be a non-negative safe integer");
      }
      const stateDigest = parseArtifactDigest(intent.value.stateDigest);
      if (!stateDigest.ok) return reconciliationFailure("intent.stateDigest", stateDigest.error.message);
      return success(canonicalRecord({ kind: "commit-protected-wave-state", ...base.value, expectedRevision: revision, stateDigest: stateDigest.value }));
    }
    case "reserve-agent-requests": {
      const intent = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "requests"], "intent");
      if (!intent.ok) return intent;
      const entries = readDenseDataArray(intent.value.requests, "intent.requests");
      if (!entries.ok || entries.value.length === 0) {
        return reconciliationFailure("intent.requests", entries.ok ? "requests must be non-empty" : entries.error.message);
      }
      const requests: AgentRequestAuthority[] = [];
      for (let index = 0; index < entries.value.length; index++) {
        const parsed = parseStoredAgentRequestAuthority(entries.value[index]);
        if (!parsed.ok) return reconciliationFailure(`intent.requests[${index}]`, parsed.error.violations.map(({ message }) => message).join("; "));
        if (parsed.value.runId !== base.value.runId) return reconciliationFailure(`intent.requests[${index}].runId`, "request belongs to another run");
        requests.push(parsed.value);
      }
      if (new Set(requests.map(({ requestId }) => requestId)).size !== requests.length) return reconciliationFailure("intent.requests.requestId", "request IDs must be unique");
      return success(canonicalRecord({ kind: "reserve-agent-requests", ...base.value, requests: Object.freeze(requests) as NonEmpty<AgentRequestAuthority> }));
    }
    case "capture-raw-transcript": {
      const intent = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "request", "bytes"], "intent");
      if (!intent.ok) return intent;
      const request = parseStoredAgentRequestAuthority(intent.value.request);
      if (!request.ok) return reconciliationFailure("intent.request", request.error.violations.map(({ message }) => message).join("; "));
      if (request.value.runId !== base.value.runId) return reconciliationFailure("intent.request.runId", "request belongs to another run");
      const bytes = parseRawTranscriptBytes(intent.value.bytes);
      if (!bytes.ok) return reconciliationFailure("intent.bytes", bytes.error.message);
      return success(canonicalRecord({ kind: "capture-raw-transcript", ...base.value, request: request.value, bytes: bytes.value }));
    }
    case "inspect-git-remediation": {
      const intent = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "paths"], "intent");
      if (!intent.ok) return intent;
      const paths = parseRepositoryPathArray(intent.value.paths, "intent.paths");
      if (!paths.ok) return paths;
      return success(canonicalRecord({ kind: "inspect-git-remediation", ...base.value, paths: paths.value }));
    }
    case "install-verified-index": {
      const intent = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "indexDigest", "witnessDigest"], "intent");
      if (!intent.ok) return intent;
      const indexDigest = parseArtifactDigest(intent.value.indexDigest);
      const witnessDigest = parseArtifactDigest(intent.value.witnessDigest);
      if (!indexDigest.ok) return reconciliationFailure("intent.indexDigest", indexDigest.error.message);
      if (!witnessDigest.ok) return reconciliationFailure("intent.witnessDigest", witnessDigest.error.message);
      return success(canonicalRecord({ kind: "install-verified-index", ...base.value, indexDigest: indexDigest.value, witnessDigest: witnessDigest.value }));
    }
    default:
      return reconciliationFailure("intent.kind", `unknown effect intent kind ${describeUnknown(envelope.value.kind)}`);
  }
}

export function parseEffectReceipt(raw: unknown): DomainResult<EffectReceipt, ReconciliationParseError> {
  const envelope = reconciliationRecord(raw, EFFECT_RECEIPT_FIELDS, "receipt");
  if (!envelope.ok) return envelope;
  const base = parseBaseEffect(envelope.value, "receipt");
  if (!base.ok) return base;
  switch (envelope.value.kind) {
    case "artifact-set-published": {
      const receipt = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "artifacts"], "receipt");
      if (!receipt.ok) return receipt;
      const artifacts = parseArtifactArray(receipt.value.artifacts, "receipt.artifacts");
      if (!artifacts.ok) return artifacts;
      return success(canonicalRecord({ kind: "artifact-set-published", ...base.value, artifacts: artifacts.value }));
    }
    case "protected-wave-state-committed": {
      const receipt = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "committedRevision", "stateDigest"], "receipt");
      if (!receipt.ok) return receipt;
      const revision = receipt.value.committedRevision;
      if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
        return reconciliationFailure("receipt.committedRevision", "committedRevision must be a non-negative safe integer");
      }
      const stateDigest = parseArtifactDigest(receipt.value.stateDigest);
      if (!stateDigest.ok) return reconciliationFailure("receipt.stateDigest", stateDigest.error.message);
      return success(canonicalRecord({ kind: "protected-wave-state-committed", ...base.value, committedRevision: revision, stateDigest: stateDigest.value }));
    }
    case "agent-requests-reserved": {
      const receipt = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "requestIds"], "receipt");
      if (!receipt.ok) return receipt;
      const entries = readDenseDataArray(receipt.value.requestIds, "receipt.requestIds");
      if (!entries.ok || entries.value.length === 0) {
        return reconciliationFailure("receipt.requestIds", entries.ok ? "requestIds must be non-empty" : entries.error.message);
      }
      const requestIds: RequestId[] = [];
      for (let index = 0; index < entries.value.length; index++) {
        const parsed = parseRequestId(entries.value[index]);
        if (!parsed.ok) return reconciliationFailure(`receipt.requestIds[${index}]`, parsed.error.message);
        requestIds.push(parsed.value);
      }
      if (new Set(requestIds).size !== requestIds.length) return reconciliationFailure("receipt.requestIds", "requestIds must be unique");
      return success(canonicalRecord({ kind: "agent-requests-reserved", ...base.value, requestIds: Object.freeze(requestIds) as NonEmpty<RequestId> }));
    }
    case "raw-transcript-captured": {
      const receipt = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "requestId", "artifact"], "receipt");
      if (!receipt.ok) return receipt;
      const requestId = parseRequestId(receipt.value.requestId);
      const artifact = parseArtifactRef(receipt.value.artifact);
      if (!requestId.ok) return reconciliationFailure("receipt.requestId", requestId.error.message);
      if (!artifact.ok) return reconciliationFailure(`receipt.artifact.${artifact.error.field}`, artifact.error.message);
      return success(canonicalRecord({ kind: "raw-transcript-captured", ...base.value, requestId: requestId.value, artifact: artifact.value }));
    }
    case "git-remediation-inspected": {
      const receipt = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "witnessDigest", "paths"], "receipt");
      if (!receipt.ok) return receipt;
      const witnessDigest = parseArtifactDigest(receipt.value.witnessDigest);
      const paths = parseRepositoryPathArray(receipt.value.paths, "receipt.paths");
      if (!witnessDigest.ok) return reconciliationFailure("receipt.witnessDigest", witnessDigest.error.message);
      if (!paths.ok) return paths;
      return success(canonicalRecord({ kind: "git-remediation-inspected", ...base.value, witnessDigest: witnessDigest.value, paths: paths.value }));
    }
    case "verified-index-installed": {
      const receipt = reconciliationRecord(envelope.value, ["kind", "effectId", "runId", "indexDigest", "witnessDigest"], "receipt");
      if (!receipt.ok) return receipt;
      const indexDigest = parseArtifactDigest(receipt.value.indexDigest);
      const witnessDigest = parseArtifactDigest(receipt.value.witnessDigest);
      if (!indexDigest.ok) return reconciliationFailure("receipt.indexDigest", indexDigest.error.message);
      if (!witnessDigest.ok) return reconciliationFailure("receipt.witnessDigest", witnessDigest.error.message);
      return success(canonicalRecord({ kind: "verified-index-installed", ...base.value, indexDigest: indexDigest.value, witnessDigest: witnessDigest.value }));
    }
    default:
      return reconciliationFailure("receipt.kind", `unknown effect receipt kind ${describeUnknown(envelope.value.kind)}`);
  }
}

export function sameArtifact(left: ArtifactRef, right: ArtifactRef): boolean {
  return left.runId === right.runId && left.slot.path === right.slot.path &&
    left.digest === right.digest && left.byteLength === right.byteLength;
}

export function samePath(left: RepositoryPath, right: RepositoryPath): boolean {
  return left.relative === right.relative && left.absolute === right.absolute;
}

/**
 * Does `receipt` fail to answer `intent`? `null` means it answers exactly.
 *
 * The `default` arm is not dead code waiting for a bug — it is the arm a NEW
 * `EffectIntent` variant lands in before anyone writes its case. `strict` alone
 * does not catch the omission (`noImplicitReturns` is off), so without it this
 * function would return `undefined`, and `reconcileEffectReceipt` — which reads
 * `.field`/`.message` off any non-null answer — would throw a `TypeError`
 * instead of producing the domain-level mismatch it exists to produce. The
 * `never` binding makes the omission a compile error; the returned mismatch is
 * the fail-closed answer if one ever reaches it at runtime, matching the
 * `default: return reconciliationFailure(...)` its sibling parsers in this file
 * already end with.
 */
export function receiptPayloadMismatch(intent: EffectIntent, receipt: EffectReceipt): ReconciliationParseError | null {
  switch (intent.kind) {
    case "publish-artifact-set":
      if (receipt.kind !== "artifact-set-published") return { field: "receipt.kind", message: `expected artifact-set-published, received ${receipt.kind}` };
      if (intent.artifacts.length !== receipt.artifacts.length) return { field: "receipt.artifacts", message: "artifact count mismatch" };
      for (let index = 0; index < intent.artifacts.length; index++) {
        const expected = intent.artifacts[index]!;
        const actual = receipt.artifacts[index]!;
        if (expected.runId !== actual.runId) return { field: `receipt.artifacts[${index}].runId`, message: "artifact run mismatch" };
        if (expected.slot.path !== actual.slot.path) return { field: `receipt.artifacts[${index}].slot`, message: "artifact slot mismatch" };
        if (expected.digest !== actual.digest) return { field: `receipt.artifacts[${index}].digest`, message: "artifact digest mismatch" };
        if (expected.byteLength !== actual.byteLength) return { field: `receipt.artifacts[${index}].byteLength`, message: "artifact byteLength mismatch" };
      }
      return null;
    case "commit-protected-wave-state":
      if (receipt.kind !== "protected-wave-state-committed") return { field: "receipt.kind", message: `expected protected-wave-state-committed, received ${receipt.kind}` };
      if (receipt.committedRevision !== intent.expectedRevision + 1) return { field: "receipt.committedRevision", message: "committed revision does not advance expected revision" };
      if (receipt.stateDigest !== intent.stateDigest) return { field: "receipt.stateDigest", message: "state digest mismatch" };
      return null;
    case "reserve-agent-requests":
      if (receipt.kind !== "agent-requests-reserved") return { field: "receipt.kind", message: `expected agent-requests-reserved, received ${receipt.kind}` };
      if (receipt.requestIds.length !== intent.requests.length) return { field: "receipt.requestIds", message: "reserved request count mismatch" };
      for (let index = 0; index < intent.requests.length; index++) {
        if (receipt.requestIds[index] !== intent.requests[index]!.requestId) return { field: `receipt.requestIds[${index}]`, message: "reserved request identity or order mismatch" };
      }
      return null;
    case "capture-raw-transcript": {
      if (receipt.kind !== "raw-transcript-captured") return { field: "receipt.kind", message: `expected raw-transcript-captured, received ${receipt.kind}` };
      if (receipt.requestId !== intent.request.requestId) return { field: "receipt.requestId", message: "captured request identity mismatch" };
      if (receipt.artifact.runId !== intent.runId) return { field: "receipt.artifact.runId", message: "captured artifact run mismatch" };
      if (receipt.artifact.slot.path !== intent.request.outputSlot.path) return { field: "receipt.artifact.slot", message: "captured artifact slot mismatch" };
      if (receipt.artifact.byteLength !== intent.bytes.length) return { field: "receipt.artifact.byteLength", message: "captured byteLength mismatch" };
      const contentDigest = digestRawTranscriptBytes(intent.bytes);
      if (!contentDigest.ok || receipt.artifact.digest !== contentDigest.value) return { field: "receipt.artifact.digest", message: "captured digest mismatch" };
      return null;
    }
    case "inspect-git-remediation":
      if (receipt.kind !== "git-remediation-inspected") return { field: "receipt.kind", message: `expected git-remediation-inspected, received ${receipt.kind}` };
      if (receipt.paths.length !== intent.paths.length) return { field: "receipt.paths", message: "inspected path count mismatch" };
      for (let index = 0; index < intent.paths.length; index++) {
        if (!samePath(intent.paths[index]!, receipt.paths[index]!)) return { field: `receipt.paths[${index}]`, message: "inspected path identity or order mismatch" };
      }
      return null;
    case "install-verified-index":
      if (receipt.kind !== "verified-index-installed") return { field: "receipt.kind", message: `expected verified-index-installed, received ${receipt.kind}` };
      if (receipt.indexDigest !== intent.indexDigest) return { field: "receipt.indexDigest", message: "installed index digest mismatch" };
      if (receipt.witnessDigest !== intent.witnessDigest) return { field: "receipt.witnessDigest", message: "installed witness digest mismatch" };
      return null;
    default: {
      const unhandled: never = intent;
      return {
        field: "intent.kind",
        message: `no reconciliation rule for effect intent ${String((unhandled as { kind?: unknown }).kind)}`,
      };
    }
  }
}

export function reconcileEffectReceipt(
  rawIntent: unknown,
  rawReceipt: unknown,
): DomainResult<EffectReceipt, EffectReceiptError> {
  const intent = parseEffectIntent(rawIntent);
  if (!intent.ok) {
    return failure(canonicalRecord({
      kind: "effect-receipt-mismatch",
      effectId: null,
      field: intent.error.field,
      message: intent.error.message,
      ...(intent.error.artifactSlotConflict === undefined
        ? {}
        : { artifactSlotConflict: intent.error.artifactSlotConflict }),
    }));
  }
  const receipt = parseEffectReceipt(rawReceipt);
  if (!receipt.ok) {
    return failure(canonicalRecord({
      kind: "effect-receipt-mismatch",
      effectId: intent.value.effectId,
      field: receipt.error.field,
      message: receipt.error.message,
      ...(receipt.error.artifactSlotConflict === undefined
        ? {}
        : { artifactSlotConflict: receipt.error.artifactSlotConflict }),
    }));
  }
  if (intent.value.effectId !== receipt.value.effectId) {
    return failure(canonicalRecord({ kind: "effect-receipt-mismatch", effectId: intent.value.effectId, field: "receipt.effectId", message: "effect identity mismatch" }));
  }
  if (intent.value.runId !== receipt.value.runId) {
    return failure(canonicalRecord({ kind: "effect-receipt-mismatch", effectId: intent.value.effectId, field: "receipt.runId", message: "run identity mismatch" }));
  }
  const mismatch = receiptPayloadMismatch(intent.value, receipt.value);
  return mismatch === null
    ? success(receipt.value)
    : failure(canonicalRecord({
        kind: "effect-receipt-mismatch",
        effectId: intent.value.effectId,
        field: mismatch.field,
        message: mismatch.message,
      }));
}
