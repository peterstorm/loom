/**
 * Anchored run-directory handle.
 *
 * The handle exposes a FIXED set of operations over one proven run directory
 * and has no arbitrary path API: a caller can publish a context, reserve a
 * transcript slot, or record a receipt, but it cannot ask the handle to write
 * "some path". That is the point — every write lands in a slot the layout
 * already names, so a compromised or buggy caller cannot redirect bytes.
 *
 * Layout:
 *   authority.json                     immutable run/roster/root authority
 *   checkpoint.json                    atomic projection, not primary history
 *   events/<sequence>-<dedup>.json     immutable domain events
 *   requests/<request-id>.json         immutable request authority
 *   requests/correlators/<digest>.json immutable native-id/request binding
 *   contexts/<digest>.json             complete immutable context packets
 *   transcripts/<slot>/attempt-<n>.raw exact harness bytes
 *   receipts/<effect-id>.json          typed effect/publication receipts
 *   artifacts/...                      domain artifacts and final outputs
 *
 * Immutable artifacts are written with O_EXCL through a descriptor anchored at
 * their parent, so republishing a slot fails loudly instead of silently
 * rewriting history.
 */

import { createHash } from "node:crypto";
import { closeSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  canonicalRecord,
  canonicalStructuralEquals,
  parseAgentRequestAuthority,
  parseArtifactByteLength,
  type AgentRequestAuthority,
  type ArtifactDigest,
  type ArtifactRef,
  type DomainResult,
  type EffectId,
  type EffectReceipt,
  type OrchestrationRunId,
} from "../core/orchestration-contract";
import { captureKey, type CaptureKey } from "../core/harness-capture";
import type { ContextPacket } from "./context-packets";
import { parseContextPacket } from "./context-packets";
import {
  ensureRelativeDirectoryNoFollow,
  listDirectoryNamesNoFollow,
  openDirectoryNoFollow,
  procFdChild,
  readDirectoryFileNoFollow,
  publishStagedRunFile,
  readRunBytesNoFollow,
  readRunFileNoFollow,
  removeRunFileNoFollow,
  withAnchoredDirectoryLock,
  writeDirectoryFileExclusiveNoFollow,
  writeRunBytesExclusiveNoFollow,
  writeRunBytesNoFollow,
  writeRunFileExclusiveNoFollow,
  writeRunFileNoFollow,
} from "./no-follow-fs";
import {
  parseProgramEventRecord,
  type ProgramEventRecord,
  type ProgramJournal,
} from "./fugue-program-runtime";

export const RUN_DIRECTORY_SCHEMA_VERSION = 1;

const EVENTS = "events";
const REQUESTS = "requests";
const CORRELATORS = "correlators";
const CONTEXTS = "contexts";
const TRANSCRIPTS = "transcripts";
const RECEIPTS = "receipts";
const ARTIFACTS = "artifacts";
const AUTHORITY_FILE = "authority.json";
const PROGRAM_FILE = "program.json";
const CHECKPOINT_FILE = "checkpoint.json";
const PROGRESS_FILE = "progress.json";

const FIXED_SUBDIRECTORIES: readonly string[] = [
  EVENTS,
  REQUESTS,
  join(REQUESTS, CORRELATORS),
  CONTEXTS,
  TRANSCRIPTS,
  RECEIPTS,
  ARTIFACTS,
];

export type RunDirectoryError = Readonly<{
  kind: "invalid-run-directory";
  field: string;
  message: string;
}>;

const failure = <T>(field: string, message: string): DomainResult<T, RunDirectoryError> =>
  ({ ok: false, error: canonicalRecord({ kind: "invalid-run-directory" as const, field, message }) });

const success = <T>(value: T): DomainResult<T, RunDirectoryError> => ({ ok: true, value });

/** Immutable run authority, written once when the directory is created. */
export type RunAuthority = Readonly<{
  schemaVersion: typeof RUN_DIRECTORY_SCHEMA_VERSION;
  runId: OrchestrationRunId;
  runsRoot: string;
  runDirectory: string;
}>;

export type ContextPublishedReceipt = Readonly<{
  kind: "context-published";
  runId: OrchestrationRunId;
  digest: ContextPacket["digest"];
  slotPath: string;
}>;

export type TranscriptReserved = Readonly<{
  kind: "transcript-reserved";
  runId: OrchestrationRunId;
  requestId: AgentRequestAuthority["requestId"];
  slotPath: string;
}>;

export type HarnessCorrelatorBinding = Readonly<{
  schemaVersion: typeof RUN_DIRECTORY_SCHEMA_VERSION;
  harness: "pi" | "claude";
  nativeId: string;
  requestId: AgentRequestAuthority["requestId"];
  attempt: AgentRequestAuthority["attempt"];
}>;

declare const ARTIFACT_RELATIVE_PATH: unique symbol;
export type ArtifactRelativePath = string & { readonly [ARTIFACT_RELATIVE_PATH]: true };

/** Bytes staged for publication under one parsed artifact-relative slot. */
export type StagedArtifact = Readonly<{
  relativePath: ArtifactRelativePath;
  bytes: readonly number[];
}>;

/** Untrusted shell input; `publishArtifactSet` parses it before any write. */
export type StagedArtifactInput = Readonly<{
  relativePath: unknown;
  bytes: readonly number[];
}>;

export function parseArtifactRelativePath(raw: unknown): DomainResult<ArtifactRelativePath, RunDirectoryError> {
  if (typeof raw !== "string" || raw.length === 0 || raw.startsWith("/") || raw.endsWith("/") || raw.includes("\\")) {
    return failure("artifacts", "artifact path must be a non-empty POSIX-relative path");
  }
  const components = raw.split("/");
  if (components.some((component) => component.length === 0 || component === "." || component === "..")) {
    return failure("artifacts", "artifact path must not contain empty, dot, or traversal components");
  }
  return success(raw as ArtifactRelativePath);
}

export function createStagedArtifact(
  relativePath: unknown,
  bytes: readonly number[],
): DomainResult<StagedArtifact, RunDirectoryError> {
  const parsedPath = parseArtifactRelativePath(relativePath);
  if (!parsedPath.ok) return parsedPath;
  if (!Array.isArray(bytes) || !bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    return failure("artifacts", "staged artifact bytes must be integers from 0 through 255");
  }
  return success(Object.freeze({ relativePath: parsedPath.value, bytes: Object.freeze([...bytes]) }));
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * A run directory must be a direct child of its runs-root and must already
 * exist. Both are resolved and compared as strings, and every later access
 * re-opens the path through `O_NOFOLLOW` descriptors, so a component swapped
 * to a symlink after this check still cannot be followed.
 */
export function parseRunDirectoryIdentity(
  runsRoot: string,
  runDirectory: string,
): DomainResult<Readonly<{ runsRoot: string; runDirectory: string; runId: OrchestrationRunId }>, RunDirectoryError> {
  const root = resolve(runsRoot);
  const directory = resolve(runDirectory);
  if (join(root, basename(directory)) !== directory) {
    return failure("runDirectory", `run directory must be a direct child of ${root}`);
  }
  const stats = ((): ReturnType<typeof statSync> | undefined => {
    try {
      return statSync(directory);
    } catch {
      return undefined;
    }
  })();
  if (stats === undefined || !stats.isDirectory()) {
    return failure("runDirectory", `run directory does not exist: ${directory}`);
  }
  return success(canonicalRecord({
    runsRoot: root,
    runDirectory: directory,
    runId: basename(directory) as OrchestrationRunId,
  }));
}

// ---------------------------------------------------------------------------
// Handle
// ---------------------------------------------------------------------------

export interface RunDirHandle extends ProgramJournal {
  readonly runId: OrchestrationRunId;
  readonly runDirectory: string;
  readAuthority(): DomainResult<RunAuthority, RunDirectoryError>;
  registerProgram(registration: unknown): Promise<DomainResult<OrchestrationRunId, RunDirectoryError>>;
  readProgramRegistration(): DomainResult<unknown | null, RunDirectoryError>;
  publishContext(packet: ContextPacket): Promise<DomainResult<ContextPublishedReceipt, RunDirectoryError>>;
  readContext(digest: ContextPacket["digest"]): DomainResult<ContextPacket, RunDirectoryError>;
  reserveRequest(authority: AgentRequestAuthority): Promise<DomainResult<TranscriptReserved, RunDirectoryError>>;
  readIssuedRequests(): DomainResult<readonly AgentRequestAuthority[], RunDirectoryError>;
  readCapturedAttempts(): DomainResult<ReadonlySet<CaptureKey>, RunDirectoryError>;
  recordHarnessCorrelator(
    binding: HarnessCorrelatorBinding,
  ): Promise<DomainResult<HarnessCorrelatorBinding, RunDirectoryError>>;
  readHarnessCorrelator(
    harness: HarnessCorrelatorBinding["harness"],
    nativeId: string,
  ): DomainResult<HarnessCorrelatorBinding | null, RunDirectoryError>;
  captureTranscript(
    authority: AgentRequestAuthority,
    bytes: readonly number[],
  ): Promise<DomainResult<ArtifactRef, RunDirectoryError>>;
  /** Read captured bytes back exactly, for parity and byte-equality proofs. */
  readTranscriptBytes(authority: AgentRequestAuthority): DomainResult<Uint8Array, RunDirectoryError>;
  publishArtifactSet(staged: readonly StagedArtifactInput[]): Promise<DomainResult<readonly ArtifactRef[], RunDirectoryError>>;
  recordReceipt(receipt: EffectReceipt): Promise<DomainResult<EffectId, RunDirectoryError>>;
  /** `success(null)` = never recorded; a failure = recorded but unreadable. */
  readReceipt(effectId: EffectId): DomainResult<EffectReceipt | null, RunDirectoryError>;
}

/**
 * Create run subdirectories through descriptors anchored at the run directory.
 *
 * `mkdirSync(path, { recursive: true })` hands the whole path to the kernel,
 * which resolves every intermediate component with ordinary symlink-following
 * semantics. A component swapped to a symlink — the adversary this module's
 * O_NOFOLLOW primitives exist to refuse — would therefore have directories
 * created at the link's TARGET, and that side effect lands before the anchored
 * write that would have refused it. `ensureRelativeDirectoryNoFollow` walks one
 * component at a time under O_NOFOLLOW instead, so directory creation is held
 * to the same anchoring as every read and write here.
 */
function ensureRunSubdirectories(runDirectory: string, targets: readonly string[]): void {
  const rootFd = openDirectoryNoFollow(runDirectory);
  try {
    for (const target of targets) ensureRelativeDirectoryNoFollow(rootFd, runDirectory, target);
  } finally {
    closeSync(rootFd);
  }
}

function ensureFixedLayout(runDirectory: string): void {
  ensureRunSubdirectories(runDirectory, FIXED_SUBDIRECTORIES.map((child) => join(runDirectory, child)));
}

function digestOf(bytes: readonly number[]): ArtifactDigest {
  return createHash("sha256").update(Uint8Array.from(bytes)).digest("hex") as ArtifactDigest;
}

function readJsonNoFollow(path: string): unknown {
  return JSON.parse(readRunFileNoFollow(path)) as unknown;
}

/** The event records only; the retained descriptor also contains the lock. */
function eventFileNames(directoryFd: number): readonly string[] {
  return listDirectoryNamesNoFollow(directoryFd).filter((name) => name.endsWith(".json"));
}

const EVENT_FILE = /^(\d{6,})-([A-Za-z0-9:_-]{1,256})\.json$/;

function readEventRecords(directoryFd: number): readonly ProgramEventRecord[] {
  const seenDedup = new Set<string>();
  return Object.freeze(eventFileNames(directoryFd).map((name, index) => {
    const match = EVENT_FILE.exec(name);
    if (match === null) throw new Error(`Corrupt program event filename ${name}`);
    const filenameSequence = Number(match[1]);
    const filenameDedup = match[2]!;
    if (!Number.isSafeInteger(filenameSequence) || filenameSequence !== index) {
      throw new Error(`Corrupt program event ${name}: sequence prefix is not contiguous from zero`);
    }
    const raw = JSON.parse(readDirectoryFileNoFollow(directoryFd, name).toString("utf-8")) as unknown;
    const record = parseProgramEventRecord(raw, name);
    if (record.sequence !== filenameSequence || record.dedupKey !== filenameDedup) {
      throw new Error(`Corrupt program event ${name}: filename does not match record identity`);
    }
    if (seenDedup.has(record.dedupKey)) {
      throw new Error(`Corrupt program event ${name}: duplicate dedup key ${record.dedupKey}`);
    }
    seenDedup.add(record.dedupKey);
    return record;
  }));
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Remove staged bytes that will never be promoted; a leftover is inert but noisy. */
function discardStaged(entries: readonly Readonly<{ staged: string }>[]): void {
  for (const entry of entries) {
    try {
      removeRunFileNoFollow(entry.staged);
    } catch {
      // The set is already abandoned; a leftover staged file publishes nothing.
    }
  }
}

function transcriptSlotPath(runDirectory: string, authority: AgentRequestAuthority): string {
  return join(runDirectory, TRANSCRIPTS, authority.slotId, `attempt-${authority.attempt}.raw`);
}

function correlatorPath(directory: string, harness: HarnessCorrelatorBinding["harness"], nativeId: string): string {
  const key = createHash("sha256").update(`${harness}\0${nativeId}`).digest("hex");
  return join(directory, REQUESTS, CORRELATORS, `${key}.json`);
}

function parseHarnessCorrelatorBinding(raw: unknown): DomainResult<HarnessCorrelatorBinding, RunDirectoryError> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return failure("correlator", "harness correlator binding must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (record["schemaVersion"] !== RUN_DIRECTORY_SCHEMA_VERSION ||
      (record["harness"] !== "pi" && record["harness"] !== "claude") ||
      typeof record["nativeId"] !== "string" || record["nativeId"].length === 0 ||
      typeof record["requestId"] !== "string" || record["requestId"].length === 0 ||
      (record["attempt"] !== 1 && record["attempt"] !== 2)) {
    return failure("correlator", "harness correlator binding violates its field contract");
  }
  return success(canonicalRecord({
    schemaVersion: RUN_DIRECTORY_SCHEMA_VERSION,
    harness: record["harness"],
    nativeId: record["nativeId"],
    requestId: record["requestId"] as AgentRequestAuthority["requestId"],
    attempt: record["attempt"],
  }));
}

/**
 * Open a handle over an existing run directory, creating the fixed layout if
 * this is its first use. The authority file is written exactly once: a second
 * open of the same directory reads it rather than replacing it.
 */
export function openRunDirectory(
  runsRoot: string,
  runDirectory: string,
): DomainResult<RunDirHandle, RunDirectoryError> {
  const identity = parseRunDirectoryIdentity(runsRoot, runDirectory);
  if (!identity.ok) return identity;
  const { runId, runDirectory: directory } = identity.value;

  // Prove every hop is a real directory BEFORE creating anything: `resolve`
  // is pure path math and `statSync` follows links, so a symlinked run
  // directory would otherwise have the fixed layout built through it.
  try {
    closeSync(openDirectoryNoFollow(directory));
  } catch (error) {
    return failure("runDirectory", `run directory is not safely reachable: ${(error as Error).message}`);
  }
  ensureFixedLayout(directory);

  const authorityPath = join(directory, AUTHORITY_FILE);
  const authority: RunAuthority = canonicalRecord({
    schemaVersion: RUN_DIRECTORY_SCHEMA_VERSION,
    runId,
    runsRoot: identity.value.runsRoot,
    runDirectory: directory,
  });
  try {
    writeRunFileExclusiveNoFollow(authorityPath, JSON.stringify(authority, null, 2));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      return failure("authority", `cannot claim run authority: ${(error as Error).message}`);
    }
  }

  return success(buildHandle(runId, directory, authorityPath));
}

/**
 * The handle is assembled from one group of operations per concern rather than
 * written as a single object literal. Each group closes over the same proven
 * run identity, so composition changes nothing about what the handle can do —
 * it only keeps each concern small enough to read on its own.
 */
function buildHandle(runId: OrchestrationRunId, directory: string, authorityPath: string): RunDirHandle {
  return Object.freeze({
    runId,
    runDirectory: directory,
    readAuthority: (): DomainResult<RunAuthority, RunDirectoryError> =>
      readRunAuthority(runId, authorityPath),
    ...programOperations(runId, directory),
    ...journalOperations(directory),
    ...contextOperations(runId, directory),
    ...requestOperations(runId, directory),
    ...artifactOperations(runId, directory),
    ...receiptOperations(directory),
  });
}

function readRunAuthority(
  runId: OrchestrationRunId,
  authorityPath: string,
): DomainResult<RunAuthority, RunDirectoryError> {
  const raw = ((): unknown => {
    try {
      return readJsonNoFollow(authorityPath);
    } catch (error) {
      return { __unreadable: (error as Error).message };
    }
  })();
  if (typeof raw !== "object" || raw === null) return failure("authority", "run authority is unreadable");
  const record = raw as Record<string, unknown>;
  if (record["schemaVersion"] !== RUN_DIRECTORY_SCHEMA_VERSION || record["runId"] !== runId) {
    return failure("authority", "run authority does not describe this run");
  }
  return success(canonicalRecord({
    schemaVersion: RUN_DIRECTORY_SCHEMA_VERSION,
    runId,
    runsRoot: record["runsRoot"] as string,
    runDirectory: record["runDirectory"] as string,
  }));
}

function programOperations(runId: OrchestrationRunId, directory: string) {
  return {
    async registerProgram(registration: unknown): Promise<DomainResult<OrchestrationRunId, RunDirectoryError>> {
      const body = JSON.stringify(registration);
      const path = join(directory, PROGRAM_FILE);
      try {
        writeRunFileExclusiveNoFollow(path, body);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return failure("program", `cannot register orchestration program: ${(error as Error).message}`);
        }
        if (readRunFileNoFollow(path) !== body) {
          return failure("program", "run is already registered under different program authority");
        }
      }
      return success(runId);
    },

    readProgramRegistration(): DomainResult<unknown | null, RunDirectoryError> {
      try {
        return success(JSON.parse(readRunFileNoFollow(join(directory, PROGRAM_FILE))) as unknown);
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
          ? success(null)
          : failure("program", `orchestration program registration is unreadable: ${(error as Error).message}`);
      }
    },
  };
}

/** Append-only event log plus the checkpoint and progress projections. */
function journalOperations(directory: string) {
  return {
    /**
     * The sequence prefix is the append ORDER, and O_EXCL on the filename
     * cannot arbitrate it: two appenders carrying different dedup keys observe
     * the same directory snapshot, compute the same `events.length`, and write
     * two differently-named files that both claim that sequence. `readEvents`
     * then reconstructs order by sorting filenames, so a collision degrades
     * ordering to a comparison of dedup-key text — unrelated to happens-before
     * — and `replayProgram`/`resumeProgram` fold in that wrong order.
     *
     * The read-count-write is therefore serialized. Exclusivity on the
     * filename still carries idempotency (the dedup key), and the lock carries
     * the ordering claim that a derived count cannot make on its own.
     */
    async appendEvent(record: ProgramEventRecord): Promise<void> {
      const parsedInput = parseProgramEventRecord(record, "append input");
      await withAnchoredDirectoryLock(join(directory, EVENTS), "append.lock", (eventsFd) => {
        const events = readEventRecords(eventsFd);
        if (events.some((event) => event.dedupKey === parsedInput.dedupKey)) return;
        const sequence = events.length;
        const sequenced = Object.freeze({ ...parsedInput, sequence });
        writeDirectoryFileExclusiveNoFollow(
          eventsFd,
          `${String(sequence).padStart(6, "0")}-${sequenced.dedupKey}.json`,
          JSON.stringify(sequenced),
        );
      });
    },

    async readEvents(): Promise<readonly ProgramEventRecord[]> {
      return withAnchoredDirectoryLock(
        join(directory, EVENTS),
        "append.lock",
        (eventsFd) => readEventRecords(eventsFd),
      );
    },

    /**
     * `null` means the run never wrote a checkpoint. Anything that exists but
     * cannot be READ is a failure, exactly as `readReceipt` treats a receipt:
     * `resumeProgram` short-circuits on `null` and skips the
     * checkpoint-vs-replay corruption check entirely, so collapsing "absent"
     * into "unreadable" would turn an ELOOP from a checkpoint path swapped to a
     * symlink — the very attack the no-follow reads exist to refuse — into a
     * clean resume.
     */
    async readCheckpoint(): Promise<string | null> {
      try {
        return readRunFileNoFollow(join(directory, CHECKPOINT_FILE));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },

    /** Checkpoints are a projection, so they are replaced through a staged rename. */
    async writeCheckpoint(json: string): Promise<void> {
      const staged = join(directory, `${CHECKPOINT_FILE}.staged`);
      writeRunFileNoFollow(staged, json);
      publishStagedRunFile(staged, join(directory, CHECKPOINT_FILE));
    },

    async writeProgress(percent: number): Promise<void> {
      writeRunFileNoFollow(join(directory, PROGRESS_FILE), JSON.stringify({ percent }));
    },
  };
}

/** Content-addressed context packets. */
function contextOperations(runId: OrchestrationRunId, directory: string) {
  return {
    async publishContext(packet: ContextPacket): Promise<DomainResult<ContextPublishedReceipt, RunDirectoryError>> {
      const path = join(directory, CONTEXTS, `${packet.digest}.json`);
      const body = JSON.stringify(packet);
      try {
        writeRunFileExclusiveNoFollow(path, body);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return failure("context", `cannot publish context packet: ${(error as Error).message}`);
        }
        // Content-addressed: an identical digest must carry identical bytes.
        if (readRunFileNoFollow(path) !== body) {
          return failure("context", "a different context packet already occupies this digest");
        }
      }
      return success(canonicalRecord({
        kind: "context-published" as const,
        runId,
        digest: packet.digest,
        slotPath: path,
      }));
    },

    readContext(digest: ContextPacket["digest"]): DomainResult<ContextPacket, RunDirectoryError> {
      const raw = ((): unknown => {
        try {
          return readJsonNoFollow(join(directory, CONTEXTS, `${digest}.json`));
        } catch (error) {
          return { __unreadable: (error as Error).message };
        }
      })();
      const parsed = parseContextPacket(raw);
      if (!parsed.ok) return failure("context", parsed.error.message);
      if (parsed.value.digest !== digest) return failure("context", "stored context packet digest does not match its slot");
      return success(parsed.value);
    },
  };
}

function readReservedAuthority(
  directory: string,
  requestId: AgentRequestAuthority["requestId"],
): DomainResult<AgentRequestAuthority, RunDirectoryError> {
  const requestPath = join(directory, REQUESTS, `${requestId}.json`);
  let rawReservation: unknown;
  try {
    rawReservation = JSON.parse(readRunFileNoFollow(requestPath)) as unknown;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? failure("request", `request ${requestId} was never reserved`)
      : failure("request", `request ${requestId} authority is unreadable: ${(error as Error).message}`);
  }
  const reserved = parseAgentRequestAuthority(rawReservation);
  return reserved.ok
    ? success(reserved.value)
    : failure("request", `request ${requestId} authority is malformed: ${reserved.error.violations.map(({ message }) => message).join("; ")}`);
}

/** Request reservations and their exclusive transcript slots. */
function requestOperations(runId: OrchestrationRunId, directory: string) {
  return {
    /**
     * Reserve one request's authority and transcript slot before it can be
     * spawned. Exclusive creation makes the reservation the proof: a second
     * reservation of the same request cannot silently overwrite the first.
     */
    async reserveRequest(authority: AgentRequestAuthority): Promise<DomainResult<TranscriptReserved, RunDirectoryError>> {
      const parsed = parseAgentRequestAuthority(authority);
      if (!parsed.ok) {
        return failure("request", `request authority is malformed: ${parsed.error.violations.map(({ message }) => message).join("; ")}`);
      }
      const request = parsed.value;
      if (request.runId !== runId) return failure("request", "request authority belongs to a different run");
      const requestPath = join(directory, REQUESTS, `${request.requestId}.json`);
      const body = JSON.stringify(request);
      try {
        writeRunFileExclusiveNoFollow(requestPath, body);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return failure("request", `cannot reserve request authority: ${(error as Error).message}`);
        }
        if (readRunFileNoFollow(requestPath) !== body) {
          return failure("request", `request ${request.requestId} is already reserved under different authority`);
        }
      }
      // Anchored creation REFUSES a symlinked or otherwise unsafe component
      // rather than following it, so this is a reachable failure and belongs in
      // the result channel: a throw here would escape the DomainResult contract
      // every other refusal in this handle honours.
      try {
        ensureRunSubdirectories(directory, [join(directory, TRANSCRIPTS, request.slotId)]);
      } catch (error) {
        return failure("request", `cannot reserve transcript slot: ${(error as Error).message}`);
      }
      return success(canonicalRecord({
        kind: "transcript-reserved" as const,
        runId,
        requestId: request.requestId,
        slotPath: transcriptSlotPath(directory, request),
      }));
    },

    readIssuedRequests(): DomainResult<readonly AgentRequestAuthority[], RunDirectoryError> {
      let requestsFd: number | null = null;
      try {
        requestsFd = openDirectoryNoFollow(join(directory, REQUESTS));
        const issued: AgentRequestAuthority[] = [];
        for (const name of listDirectoryNamesNoFollow(requestsFd)) {
          if (!name.endsWith(".json")) continue;
          try {
            const parsed = parseAgentRequestAuthority(
              JSON.parse(readDirectoryFileNoFollow(requestsFd, name).toString("utf-8")) as unknown,
            );
            // Deliberate compatibility policy: only canonical request authority
            // files contribute to the issued set; sidecars and malformed entries
            // cannot authorize a capture.
            if (parsed.ok && parsed.value.runId === runId) issued.push(parsed.value);
          } catch {
            // A mapped malformed request becomes an audited unknown-request at
            // binding; it is never accepted as authority.
          }
        }
        return success(Object.freeze(issued));
      } catch (error) {
        return failure("request", `cannot inspect issued requests safely: ${(error as Error).message}`);
      } finally {
        if (requestsFd !== null) closeSync(requestsFd);
      }
    },

    readCapturedAttempts(): DomainResult<ReadonlySet<CaptureKey>, RunDirectoryError> {
      let transcriptsFd: number | null = null;
      try {
        transcriptsFd = openDirectoryNoFollow(join(directory, TRANSCRIPTS));
        const captured = new Set<CaptureKey>();
        for (const slot of listDirectoryNamesNoFollow(transcriptsFd)) {
          let slotFd: number | null = null;
          try {
            slotFd = openDirectoryNoFollow(join(directory, TRANSCRIPTS, slot));
            for (const name of listDirectoryNamesNoFollow(slotFd)) {
              const match = /^attempt-(1|2)\.raw$/.exec(name);
              if (match !== null) captured.add(captureKey(slot, Number(match[1]) as 1 | 2));
            }
          } catch {
            // Deliberate compatibility policy: an unreadable slot contributes
            // no duplicate key; the eventual exclusive no-follow write remains
            // the publication authority and refuses unsafe/existing targets.
          } finally {
            if (slotFd !== null) closeSync(slotFd);
          }
        }
        return success(captured);
      } catch (error) {
        return failure("transcript", `cannot inspect captured attempts safely: ${(error as Error).message}`);
      } finally {
        if (transcriptsFd !== null) closeSync(transcriptsFd);
      }
    },

    async recordHarnessCorrelator(
      binding: HarnessCorrelatorBinding,
    ): Promise<DomainResult<HarnessCorrelatorBinding, RunDirectoryError>> {
      const parsed = parseHarnessCorrelatorBinding(binding);
      if (!parsed.ok) return parsed;
      const reserved = readReservedAuthority(directory, parsed.value.requestId);
      if (!reserved.ok) return reserved;
      if (reserved.value.attempt !== parsed.value.attempt) {
        return failure("correlator", `correlator attempt does not match request ${parsed.value.requestId}`);
      }
      const path = correlatorPath(directory, parsed.value.harness, parsed.value.nativeId);
      const body = JSON.stringify(parsed.value);
      try {
        writeRunFileExclusiveNoFollow(path, body);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return failure("correlator", `cannot record harness correlator: ${(error as Error).message}`);
        }
        if (readRunFileNoFollow(path) !== body) {
          return failure("correlator", "native harness correlator is already bound to different request authority");
        }
      }
      return success(parsed.value);
    },

    readHarnessCorrelator(
      harness: HarnessCorrelatorBinding["harness"],
      nativeId: string,
    ): DomainResult<HarnessCorrelatorBinding | null, RunDirectoryError> {
      if ((harness !== "pi" && harness !== "claude") || nativeId.length === 0) return success(null);
      const path = correlatorPath(directory, harness, nativeId);
      let raw: unknown;
      try {
        raw = JSON.parse(readRunFileNoFollow(path)) as unknown;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
          ? success(null)
          : failure("correlator", `harness correlator authority is unreadable: ${(error as Error).message}`);
      }
      const parsed = parseHarnessCorrelatorBinding(raw);
      if (!parsed.ok) return parsed;
      return parsed.value.harness === harness && parsed.value.nativeId === nativeId
        ? success(parsed.value)
        : failure("correlator", "stored harness correlator does not match its immutable lookup identity");
    },

    /**
     * Write the exact harness bytes into the reserved attempt slot. The slot is
     * exclusive: a late or duplicate capture for an attempt that already landed
     * is refused rather than allowed to replace accepted evidence.
     */
    async captureTranscript(
      authority: AgentRequestAuthority,
      bytes: readonly number[],
    ): Promise<DomainResult<ArtifactRef, RunDirectoryError>> {
      return captureIntoSlot(runId, directory, authority, bytes);
    },

    readTranscriptBytes(authority: AgentRequestAuthority): DomainResult<Uint8Array, RunDirectoryError> {
      try {
        return success(new Uint8Array(readRunBytesNoFollow(transcriptSlotPath(directory, authority))));
      } catch (error) {
        return failure("transcript", `cannot read captured transcript: ${(error as Error).message}`);
      }
    },
  };
}

function captureIntoSlot(
  runId: OrchestrationRunId,
  directory: string,
  authority: AgentRequestAuthority,
  bytes: readonly number[],
): DomainResult<ArtifactRef, RunDirectoryError> {
  const supplied = parseAgentRequestAuthority(authority);
  if (!supplied.ok) {
    return failure("request", `capture authority is malformed: ${supplied.error.violations.map(({ message }) => message).join("; ")}`);
  }
  if (supplied.value.runId !== runId) return failure("request", "capture authority belongs to a different run");
  const reserved = readReservedAuthority(directory, supplied.value.requestId);
  if (!reserved.ok) return reserved;
  if (!canonicalStructuralEquals(reserved.value, supplied.value)) {
    return failure("request", `request ${supplied.value.requestId} capture authority does not match its immutable reservation`);
  }
  try {
    writeRunBytesExclusiveNoFollow(transcriptSlotPath(directory, supplied.value), Uint8Array.from(bytes));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return failure("transcript", `attempt ${supplied.value.attempt} for slot ${supplied.value.slotId} is already captured`);
    }
    return failure("transcript", `cannot capture transcript: ${(error as Error).message}`);
  }
  const byteLength = parseArtifactByteLength(bytes.length);
  if (!byteLength.ok) return failure("transcript", byteLength.error.message);
  return success(canonicalRecord({
    runId,
    slot: canonicalRecord({
      kind: "fixed-artifact-slot" as const,
      path: `${TRANSCRIPTS}/${supplied.value.slotId}/attempt-${supplied.value.attempt}.raw`,
    }),
    digest: digestOf(bytes),
    byteLength: byteLength.value,
  }));
}

type StagedPair = Readonly<{ staged: string; final: string }>;

/** Write every member beside its final name; a fault discards the whole set. */
function stageArtifactSet(
  directory: string,
  staged: readonly StagedArtifactInput[],
): DomainResult<readonly StagedPair[], RunDirectoryError> {
  const parsedArtifacts: StagedArtifact[] = [];
  const destinations = new Set<string>();
  for (const artifact of staged) {
    const parsed = createStagedArtifact(artifact.relativePath, artifact.bytes);
    if (!parsed.ok) return parsed;
    if (destinations.has(parsed.value.relativePath)) {
      return failure("artifacts", `artifact destination is duplicated: ${parsed.value.relativePath}`);
    }
    destinations.add(parsed.value.relativePath);
    parsedArtifacts.push(parsed.value);
  }

  const stagedPaths: StagedPair[] = [];
  try {
    for (const artifact of parsedArtifacts) {
      const final = join(directory, ARTIFACTS, artifact.relativePath);
      ensureRunSubdirectories(directory, [resolve(final, "..")]);
      const stagedPath = `${final}.staged`;
      writeRunBytesNoFollow(stagedPath, Uint8Array.from(artifact.bytes));
      stagedPaths.push({ staged: stagedPath, final });
    }
  } catch (error) {
    discardStaged(stagedPaths);
    return failure("artifacts", `cannot stage artifact set: ${(error as Error).message}`);
  }
  return success(Object.freeze(stagedPaths));
}

/**
 * Read an already-occupied artifact slot for the byte comparison below.
 * `null` means the slot is free; a slot that exists but cannot be read is a
 * distinct, non-empty result so it can never be mistaken for a free slot.
 */
function occupiedArtifactBytes(path: string): Uint8Array | Readonly<{ __unreadable: string }> | null {
  try {
    return readRunBytesNoFollow(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? null
      : Object.freeze({ __unreadable: (error as Error).message });
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);

/**
 * True only when the staged bytes are provably identical to what already
 * occupies the slot. A staged file that cannot be read answers `false`, so an
 * unreadable member refuses the promotion instead of licensing an overwrite.
 */
function stagedBytesMatch(stagedPath: string, occupied: Uint8Array): boolean {
  try {
    return sameBytes(occupied, readRunBytesNoFollow(stagedPath));
  } catch {
    return false;
  }
}

/**
 * Promote a fully staged set. Every target is checked BEFORE any rename,
 * because renaming is the one step that cannot be undone member-by-member —
 * ruling out the predictable failures while the set is still entirely staged
 * is what keeps "all or none" true rather than merely intended.
 *
 * `renameSync` replaces an existing regular file, so the O_EXCL immutability
 * this module promises has to be enforced here explicitly: an occupied slot is
 * refused unless its bytes are already identical to what would be written, in
 * which case the promotion is a no-op replay rather than a rewrite of history.
 *
 * EXPORTED for tests. The rename loop's recovery arm handles the failures the
 * pre-checks cannot rule out — a concurrently removed parent, an EIO — which by
 * construction cannot be provoked through `publishArtifactSet` synchronously:
 * every failure reachable from outside is one the pre-checks turn into an
 * all-staged refusal first. Driving this function directly with explicit staged
 * pairs is therefore the only way to prove the partial-promotion arm behaves,
 * and an unproven recovery arm is how "all or none" quietly stops being true.
 */
export function promoteArtifactSet(
  stagedPaths: readonly StagedPair[],
): DomainResult<readonly StagedPair[], RunDirectoryError> {
  const blocked = stagedPaths.find((entry) => isExistingDirectory(entry.final));
  if (blocked !== undefined) {
    discardStaged(stagedPaths);
    return failure("artifacts", `artifact slot is occupied by a directory: ${blocked.final}`);
  }

  for (const entry of stagedPaths) {
    const occupied = occupiedArtifactBytes(entry.final);
    if (occupied === null) continue;
    const reason = !(occupied instanceof Uint8Array)
      ? `artifact slot is occupied by unreadable bytes: ${entry.final}`
      : !stagedBytesMatch(entry.staged, occupied)
        ? `a different artifact already occupies this slot: ${entry.final}`
        : null;
    if (reason !== null) {
      discardStaged(stagedPaths);
      return failure("artifacts", reason);
    }
  }

  // A failure here must still not report success. Any member already promoted
  // stays on disk but is inert: nothing treats a set as published until its
  // receipt is recorded, and the effect runner records that receipt only on a
  // successful return.
  for (const [index, entry] of stagedPaths.entries()) {
    try {
      publishStagedRunFile(entry.staged, entry.final);
    } catch (error) {
      discardStaged(stagedPaths.slice(index));
      return failure("artifacts", `cannot publish artifact set: ${(error as Error).message}`);
    }
  }
  return success(stagedPaths);
}

/** All-or-nothing artifact set publication. */
function artifactOperations(runId: OrchestrationRunId, directory: string) {
  return {
    /**
     * Publish a whole artifact set or none of it. Every member is staged first
     * and only renamed into place once all of them are on disk, so a fault
     * mid-set never leaves a partially published set behind.
     */
    async publishArtifactSet(
      staged: readonly StagedArtifactInput[],
    ): Promise<DomainResult<readonly ArtifactRef[], RunDirectoryError>> {
      if (staged.length === 0) return failure("artifacts", "an artifact set must not be empty");

      const stagedPaths = stageArtifactSet(directory, staged);
      if (!stagedPaths.ok) return stagedPaths;
      const promoted = promoteArtifactSet(stagedPaths.value);
      if (!promoted.ok) return promoted;

      const refs: ArtifactRef[] = [];
      for (const input of staged) {
        const parsed = createStagedArtifact(input.relativePath, input.bytes);
        if (!parsed.ok) return parsed;
        const artifact = parsed.value;
        const byteLength = parseArtifactByteLength(artifact.bytes.length);
        if (!byteLength.ok) return failure("artifacts", byteLength.error.message);
        refs.push(canonicalRecord({
          runId,
          slot: canonicalRecord({ kind: "fixed-artifact-slot" as const, path: `${ARTIFACTS}/${artifact.relativePath}` }),
          digest: digestOf(artifact.bytes),
          byteLength: byteLength.value,
        }));
      }
      return success(Object.freeze(refs));
    },
  };
}

/** Typed effect receipts, recorded once under their own effect id. */
function receiptOperations(directory: string) {
  return {
    async recordReceipt(receipt: EffectReceipt): Promise<DomainResult<EffectId, RunDirectoryError>> {
      const path = join(directory, RECEIPTS, `${receipt.effectId}.json`);
      const body = JSON.stringify(receipt);
      try {
        writeRunFileExclusiveNoFollow(path, body);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return failure("receipt", `cannot record receipt: ${(error as Error).message}`);
        }
        if (readRunFileNoFollow(path) !== body) {
          return failure("receipt", `effect ${receipt.effectId} already recorded a different receipt`);
        }
      }
      return success(receipt.effectId);
    },

    /**
     * `success(null)` means the effect never recorded a receipt; anything that
     * exists but cannot be read or parsed is a failure. Collapsing the two
     * would let a truncated receipt read as "never ran", and the effect runner
     * would re-execute an effect it already performed.
     */
    readReceipt(effectId: EffectId): DomainResult<EffectReceipt | null, RunDirectoryError> {
      const path = join(directory, RECEIPTS, `${effectId}.json`);
      try {
        return success(readJsonNoFollow(path) as EffectReceipt);
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
          ? success(null)
          : failure("receipt", `receipt for effect ${effectId} is unreadable: ${(error as Error).message}`);
      }
    },
  };
}

export const RUN_DIRECTORY_LAYOUT = Object.freeze({
  events: EVENTS,
  requests: REQUESTS,
  correlators: join(REQUESTS, CORRELATORS),
  contexts: CONTEXTS,
  transcripts: TRANSCRIPTS,
  receipts: RECEIPTS,
  artifacts: ARTIFACTS,
  authorityFile: AUTHORITY_FILE,
  programFile: PROGRAM_FILE,
  checkpointFile: CHECKPOINT_FILE,
});

/** Exposed for the handle's own use and for callers proving anchored access. */
export { procFdChild };
