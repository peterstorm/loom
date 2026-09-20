/** Bounded byte observation and both-attempt packet construction for explicit standalone successors. */
import { lstatSync, type Stats } from "node:fs";
import { createHash } from "node:crypto";
import { readRunBytesNoFollow } from "../../../orchestration/no-follow-fs";
import { encodeByteSection, serializeStandaloneReviewerContextPacketV3, type ByteSection, type StandaloneReviewerContextPacketV3 } from "../../../core/context-packets";
import { parseBoundedReviewerJson } from "../../../core/reviewer-protocol";
import { canonicalStructuralEquals, parseRequestId, parseOrchestrationRunId, AGENT_REQUIRED_SKILLS } from "../../../core/orchestration-contract";
import { STANDALONE_LINEAGE_LIMITS, standaloneSuccessorSelectionSchema, type StandaloneSnapshot } from "../../../core/standalone-lineage-contract";
import type { PreparedStandaloneSuccessor } from "../../../core/standalone-lineage";
import { buildStandaloneSuccessorReviewerContext } from "../../../core/standalone-successor-reviewer";
import type { ProgramParse } from "./program-result";
import type { RunDirHandle } from "../../../orchestration/run-directory-handle";

// Byte-section arrays amplify JSON. Refuse before allocating arrays, including inherited packet bytes.
export const SUCCESSOR_CONTEXT_PAYLOAD_BYTES = 4_194_304;
export const SUCCESSOR_SOURCE_BYTES = 2_097_152;
export const SUCCESSOR_SOURCE_FILE_BYTES = 524_288;
/** New successor/source reads opt in; historical driver and Wave defaults are unchanged. */
export function boundedStandaloneReadHandle(handle: RunDirHandle): RunDirHandle {
  const maximum = STANDALONE_LINEAGE_LIMITS.retainedBytes;
  return Object.freeze({ ...handle,
    readCheckpoint: () => handle.readCheckpoint(maximum),
    readProgramRegistration: () => handle.readProgramRegistration(maximum),
    readIssuedRequests: () => handle.readIssuedRequests(16_384, 128),
    readCapturedAttempts: () => handle.readCapturedAttempts(128),
    readTranscriptBytes: (request: Parameters<RunDirHandle["readTranscriptBytes"]>[0]) => handle.readTranscriptBytes(request, maximum),
    readContext: (digest: Parameters<RunDirHandle["readContext"]>[0]) => handle.readContext(digest, maximum),
    readStandaloneSuccessorContext: (digest: Parameters<RunDirHandle["readContext"]>[0]) => handle.readStandaloneSuccessorContext(digest, maximum),
    readReceipt: (effect: Parameters<RunDirHandle["readReceipt"]>[0]) => handle.readReceipt(effect, maximum),
  });
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fail = (message: string): ProgramParse<never> => ({ ok: false, message });
const sameStat = (a: Stats, b: Stats) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode && a.ctimeMs === b.ctimeMs && a.mtimeMs === b.mtimeMs;
type SourceObservationOperations = Readonly<{
  lstat: (path: string) => Stats;
  read: (path: string, maximumBytes: number) => Buffer;
}>;
const sourceObservationOperations: SourceObservationOperations = Object.freeze({
  lstat: lstatSync,
  read: readRunBytesNoFollow,
});
const sourceChanged = (path: string) => new Error(`successor source ${path} changed during observation`);
const authorityChanged = () => new Error("successor Git/reviewer authority changed during observation");
function confirmAnchoredAbsence(path: string, operations: SourceObservationOperations): void {
  try {
    operations.read(path, 0);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
    // A bounded 0-byte probe refuses an appeared file with a plain message, not
    // an errno: that is appearance evidence, not a filesystem fault. Real I/O
    // causes (EACCES, EIO, ELOOP) carry a code and are rethrown so the operator
    // sees the actual fault instead of race diagnosis.
    if ((cause as NodeJS.ErrnoException).code === undefined) throw sourceChanged(path);
    throw cause;
  }
  throw sourceChanged(path);
}
function observeSourceFile(path: string, remaining: number, operations: SourceObservationOperations,
  initialStats: Map<string, Stats | null>): FrozenSourceEntry {
  let before: Stats;
  try {
    before = operations.lstat(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    confirmAnchoredAbsence(path, operations);
    initialStats.set(path, null);
    return Object.freeze({ path, kind: "absent" as const, digest: null, byteLength: 0 });
  }
  if (!before.isFile()) throw new Error(`successor source ${path} is not a regular no-follow file`);
  let bytes: Buffer;
  try {
    bytes = operations.read(path, Math.min(remaining, SUCCESSOR_SOURCE_FILE_BYTES));
    if (!sameStat(before, operations.lstat(path))) throw sourceChanged(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw sourceChanged(path);
    throw cause;
  }
  initialStats.set(path, before);
  return Object.freeze({ path, kind: "binary" as const, digest: hash(bytes), byteLength: bytes.length,
    contentBase64: bytes.toString("base64"), mode: (before.mode & 0o111) === 0 ? "100644" as const : "100755" as const });
}

function confirmSourceStats(scope: readonly string[], initialStats: Map<string, Stats | null>, operations: SourceObservationOperations): void {
  for (const path of scope) {
    const before = initialStats.get(path);
    if (before === null) {
      confirmAnchoredAbsence(path, operations);
      continue;
    }
    if (before === undefined) throw new Error(`successor source ${path} lacks an initial observation`);
    try {
      if (!sameStat(before, operations.lstat(path))) throw sourceChanged(path);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") throw sourceChanged(path);
      throw cause;
    }
  }
}

type FrozenSourceEntry = Readonly<{ path: string; kind: "absent"; digest: null; byteLength: 0 }> | Readonly<{
  path: string; kind: "binary"; digest: string; byteLength: number; contentBase64: string; mode: "100644" | "100755";
}>;

export function observeStableStandaloneSuccessorSource<T>(scope: readonly string[], observeAuthority: () => Readonly<{
  headRevision: string;
  value: T;
  stability?: Readonly<{ witness: unknown; observe: () => unknown }>;
}>, operations: SourceObservationOperations = sourceObservationOperations): ProgramParse<Readonly<{
  source: ByteSection;
  observation: T;
}>> {
  if (scope.length > STANDALONE_LINEAGE_LIMITS.paths) return fail("successor source exceeds path budget");
  try {
    let remaining = SUCCESSOR_SOURCE_BYTES;
    const initialStats = new Map<string, Stats | null>();
    const files = scope.map((path) => {
      const entry = observeSourceFile(path, remaining, operations, initialStats);
      remaining -= entry.byteLength;
      return entry;
    });
    // One Git command sequence can straddle a ref/index transition without
    // changing scoped file stats. Production observes a compact witness at
    // derivation and again AFTER this final whole-scope pass, so drift during
    // either pass is detected before anything is encoded; generic callers
    // repeat their complete observation.
    const observed = observeAuthority();
    confirmSourceStats(scope, initialStats, operations);
    confirmSourceStats(scope, initialStats, operations);
    const stable = observed.stability === undefined
      ? canonicalStructuralEquals(observed, observeAuthority())
      : canonicalStructuralEquals(observed.stability.witness, observed.stability.observe());
    if (!stable) throw authorityChanged();
    const section = encodeByteSection("standalone-frozen-source", JSON.stringify({
      schemaVersion: 2,
      headRevision: observed.headRevision,
      files,
    }));
    return section.ok
      ? { ok: true, value: Object.freeze({ source: section.value, observation: observed.value }) }
      : fail(section.error.message);
  } catch (cause) { return fail(`successor source unavailable: ${cause instanceof Error ? cause.message : String(cause)}`); }
}

export function observeStandaloneSuccessorSource(scope: readonly string[], readHeadRevision: () => string,
  operations: SourceObservationOperations = sourceObservationOperations): ProgramParse<ByteSection> {
  const observed = observeStableStandaloneSuccessorSource(scope, () => ({
    headRevision: readHeadRevision(),
    value: null,
  }), operations);
  return observed.ok ? { ok: true, value: observed.value.source } : observed;
}

export function successorSourceSnapshot(section: ByteSection, scope: readonly string[]): ProgramParse<StandaloneSnapshot> {
  if (section.label !== "standalone-frozen-source" || section.byteLength !== section.bytes.byteLength || hash(Uint8Array.from(section.bytes)) !== section.digest) {
    return fail("frozen successor source section identity differs from its exact bytes");
  }
  const decoded = parseBoundedReviewerJson(Uint8Array.from(section.bytes), SUCCESSOR_CONTEXT_PAYLOAD_BYTES);
  if (!decoded.ok) return fail(decoded.error.message);
  const raw = decoded.value;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !("files" in raw) || !("headRevision" in raw) ||
      !("schemaVersion" in raw) || raw.schemaVersion !== 2 || Object.keys(raw).length !== 3 ||
      typeof raw.headRevision !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(raw.headRevision) ||
      !Array.isArray(raw.files) || raw.files.length !== scope.length) return fail("frozen successor source is malformed");
  const snapshot: unknown[] = [];
  let remaining = SUCCESSOR_SOURCE_BYTES;
  for (const [index, entry] of raw.files.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry) || entry.path !== scope[index]) return fail("frozen successor source scope differs");
    if (entry.kind === "absent" && Object.keys(entry).length === 4 && entry.digest === null && entry.byteLength === 0) {
      snapshot.push({ kind: "absent", path: entry.path }); continue;
    }
    if (entry.kind !== "binary" || Object.keys(entry).length !== 6 || typeof entry.contentBase64 !== "string" ||
        entry.contentBase64.length > Math.ceil(remaining / 3) * 4 || !Number.isSafeInteger(entry.byteLength) ||
        entry.byteLength < 0 || entry.byteLength > Math.min(remaining, SUCCESSOR_SOURCE_FILE_BYTES) || (entry.mode !== "100644" && entry.mode !== "100755")) return fail("frozen successor source exceeds budget or has invalid byte/mode facts");
    const bytes = Buffer.from(entry.contentBase64, "base64");
    if (bytes.toString("base64") !== entry.contentBase64 || bytes.length !== entry.byteLength || hash(bytes) !== entry.digest) return fail("frozen successor source bytes differ from digest/length");
    remaining -= bytes.length;
    snapshot.push({ kind: "present", path: entry.path, digest: entry.digest, mode: entry.mode });
  }
  const parsed = standaloneSuccessorSelectionSchema.safeParse({ runId: "source-observation", snapshot, reviewers: ["code-reviewer"] });
  return parsed.success ? { ok: true, value: parsed.data.snapshot } : fail("frozen successor source has invalid paths");
}

export function admitStandaloneSuccessorPacketSize(packet: StandaloneReviewerContextPacketV3): ProgramParse<StandaloneReviewerContextPacketV3> {
  const serialized = serializeStandaloneReviewerContextPacketV3(packet);
  if (!serialized.ok) return fail(serialized.error.message);
  return Buffer.byteLength(serialized.value, "utf8") <= STANDALONE_LINEAGE_LIMITS.retainedBytes
    ? { ok: true, value: packet }
    : fail(`successor packet exceeds ${STANDALONE_LINEAGE_LIMITS.retainedBytes} serialized byte budget`);
}

export function standaloneSuccessorPackets(prepared: PreparedStandaloneSuccessor, currentSource: ByteSection,
  previousContexts: readonly ByteSection[]): ProgramParse<Readonly<{
    packets: readonly StandaloneReviewerContextPacketV3[]; contexts: readonly Readonly<{ attempts: readonly [string, string] }>[];
  }>> {
  const snapshot = successorSourceSnapshot(currentSource, prepared.snapshot.map(row => row.path));
  if (!snapshot.ok) return snapshot;
  if (!canonicalStructuralEquals(snapshot.value, prepared.snapshot)) return fail("packet source bytes differ from nominal successor snapshot");
  if (Buffer.byteLength(JSON.stringify(prepared)) + currentSource.byteLength + previousContexts.reduce((sum, row) => sum + row.byteLength, 0) > SUCCESSOR_CONTEXT_PAYLOAD_BYTES) {
    return fail("successor packet exceeds 4194304 payload byte budget before byte-array construction");
  }
  const run = parseOrchestrationRunId(prepared.runId);
  if (!run.ok) return fail(run.error.message);
  const packets: StandaloneReviewerContextPacketV3[] = [];
  const contexts: Readonly<{ attempts: readonly [string, string] }>[] = [];
  for (const role of prepared.reviewers) {
    const attempts: string[] = [];
    for (const attempt of [1, 2] as const) {
      const id = parseRequestId(`request:${hash(Buffer.from(`${prepared.runId}\0${role}\0${attempt}`))}`);
      if (!id.ok) return fail(id.error.message);
      const packet = buildStandaloneSuccessorReviewerContext(prepared, { runId: run.value, requestId: id.value, role, attempt,
        requiredSkill: AGENT_REQUIRED_SKILLS[role] ?? null }, [currentSource, ...previousContexts]);
      if (!packet.ok) return fail(packet.error.message);
      const bounded = admitStandaloneSuccessorPacketSize(packet.value);
      if (!bounded.ok) return bounded;
      packets.push(bounded.value); attempts.push(bounded.value.digest);
    }
    contexts.push(Object.freeze({ attempts: Object.freeze([attempts[0]!, attempts[1]!]) as readonly [string, string] }));
  }
  return { ok: true, value: Object.freeze({ packets: Object.freeze(packets), contexts: Object.freeze(contexts) }) };
}
