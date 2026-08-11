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
import { closeSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  canonicalRecord,
  parseArtifactByteLength,
  type AgentRequestAuthority,
  type ArtifactDigest,
  type ArtifactRef,
  type DomainResult,
  type EffectId,
  type EffectReceipt,
  type OrchestrationRunId,
} from "../core/orchestration-contract";
import type { ContextPacket } from "./context-packets";
import { parseContextPacket } from "./context-packets";
import {
  openDirectoryNoFollow,
  procFdChild,
  publishStagedRunFile,
  readRunBytesNoFollow,
  readRunFileNoFollow,
  removeRunFileNoFollow,
  writeRunBytesExclusiveNoFollow,
  writeRunBytesNoFollow,
  writeRunFileExclusiveNoFollow,
  writeRunFileNoFollow,
} from "./no-follow-fs";
import type { ProgramEventRecord, ProgramJournal } from "./fugue-program-runtime";

export const RUN_DIRECTORY_SCHEMA_VERSION = 1;

const EVENTS = "events";
const REQUESTS = "requests";
const CONTEXTS = "contexts";
const TRANSCRIPTS = "transcripts";
const RECEIPTS = "receipts";
const ARTIFACTS = "artifacts";
const AUTHORITY_FILE = "authority.json";
const CHECKPOINT_FILE = "checkpoint.json";
const PROGRESS_FILE = "progress.json";

const FIXED_SUBDIRECTORIES: readonly string[] = [EVENTS, REQUESTS, CONTEXTS, TRANSCRIPTS, RECEIPTS, ARTIFACTS];

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

/** Bytes staged for publication under one already-named artifact slot. */
export type StagedArtifact = Readonly<{
  relativePath: string;
  bytes: readonly number[];
}>;

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
  publishContext(packet: ContextPacket): Promise<DomainResult<ContextPublishedReceipt, RunDirectoryError>>;
  readContext(digest: ContextPacket["digest"]): DomainResult<ContextPacket, RunDirectoryError>;
  reserveRequest(authority: AgentRequestAuthority): Promise<DomainResult<TranscriptReserved, RunDirectoryError>>;
  captureTranscript(
    authority: AgentRequestAuthority,
    bytes: readonly number[],
  ): Promise<DomainResult<ArtifactRef, RunDirectoryError>>;
  /** Read captured bytes back exactly, for parity and byte-equality proofs. */
  readTranscriptBytes(authority: AgentRequestAuthority): DomainResult<Uint8Array, RunDirectoryError>;
  publishArtifactSet(staged: readonly StagedArtifact[]): Promise<DomainResult<readonly ArtifactRef[], RunDirectoryError>>;
  recordReceipt(receipt: EffectReceipt): Promise<DomainResult<EffectId, RunDirectoryError>>;
  readReceipt(effectId: EffectId): EffectReceipt | null;
}

function ensureFixedLayout(runDirectory: string): void {
  for (const child of FIXED_SUBDIRECTORIES) mkdirSync(join(runDirectory, child), { recursive: true, mode: 0o700 });
}

function digestOf(bytes: readonly number[]): ArtifactDigest {
  return createHash("sha256").update(Uint8Array.from(bytes)).digest("hex") as ArtifactDigest;
}

function listNoFollow(directory: string): readonly string[] {
  const fd = openDirectoryNoFollow(directory);
  try {
    return readdirSync(`/proc/self/fd/${fd}`).sort();
  } finally {
    closeSync(fd);
  }
}

function readJsonNoFollow(path: string): unknown {
  return JSON.parse(readRunFileNoFollow(path)) as unknown;
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

function buildHandle(runId: OrchestrationRunId, directory: string, authorityPath: string): RunDirHandle {
  return Object.freeze({
    runId,
    runDirectory: directory,

    readAuthority(): DomainResult<RunAuthority, RunDirectoryError> {
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
    },

    // --- ProgramJournal -----------------------------------------------------

    async appendEvent(record: ProgramEventRecord): Promise<void> {
      const events = listNoFollow(join(directory, EVENTS));
      if (events.some((name) => name.endsWith(`-${record.dedupKey}.json`))) return;
      const sequence = String(events.length).padStart(6, "0");
      writeRunFileExclusiveNoFollow(
        join(directory, EVENTS, `${sequence}-${record.dedupKey}.json`),
        JSON.stringify({ ...record, sequence: events.length }),
      );
    },

    async readEvents(): Promise<readonly ProgramEventRecord[]> {
      return Object.freeze(listNoFollow(join(directory, EVENTS))
        .filter((name) => name.endsWith(".json"))
        .map((name) => readJsonNoFollow(join(directory, EVENTS, name)) as ProgramEventRecord));
    },

    async readCheckpoint(): Promise<string | null> {
      try {
        return readRunFileNoFollow(join(directory, CHECKPOINT_FILE));
      } catch {
        return null;
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

    // --- Fixed operations ---------------------------------------------------

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

    /**
     * Reserve one request's authority and transcript slot before it can be
     * spawned. Exclusive creation makes the reservation the proof: a second
     * reservation of the same request cannot silently overwrite the first.
     */
    async reserveRequest(authority: AgentRequestAuthority): Promise<DomainResult<TranscriptReserved, RunDirectoryError>> {
      const requestPath = join(directory, REQUESTS, `${authority.requestId}.json`);
      const body = JSON.stringify(authority);
      try {
        writeRunFileExclusiveNoFollow(requestPath, body);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return failure("request", `cannot reserve request authority: ${(error as Error).message}`);
        }
        if (readRunFileNoFollow(requestPath) !== body) {
          return failure("request", `request ${authority.requestId} is already reserved under different authority`);
        }
      }
      mkdirSync(join(directory, TRANSCRIPTS, authority.slotId), { recursive: true, mode: 0o700 });
      return success(canonicalRecord({
        kind: "transcript-reserved" as const,
        runId,
        requestId: authority.requestId,
        slotPath: transcriptSlotPath(directory, authority),
      }));
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
      const requestPath = join(directory, REQUESTS, `${authority.requestId}.json`);
      try {
        readRunFileNoFollow(requestPath);
      } catch {
        return failure("request", `request ${authority.requestId} was never reserved`);
      }
      const path = transcriptSlotPath(directory, authority);
      try {
        writeRunBytesExclusiveNoFollow(path, Uint8Array.from(bytes));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return failure("transcript", `attempt ${authority.attempt} for slot ${authority.slotId} is already captured`);
        }
        return failure("transcript", `cannot capture transcript: ${(error as Error).message}`);
      }
      const byteLength = parseArtifactByteLength(bytes.length);
      if (!byteLength.ok) return failure("transcript", byteLength.error.message);
      return success(canonicalRecord({
        runId,
        slot: canonicalRecord({ kind: "fixed-artifact-slot" as const, path: `${TRANSCRIPTS}/${authority.slotId}/attempt-${authority.attempt}.raw` }),
        digest: digestOf(bytes),
        byteLength: byteLength.value,
      }));
    },

    /**
     * Publish a whole artifact set or none of it. Every member is staged first
     * and only renamed into place once all of them are on disk, so a fault
     * mid-set never leaves a partially published set behind.
     */
    async publishArtifactSet(
      staged: readonly StagedArtifact[],
    ): Promise<DomainResult<readonly ArtifactRef[], RunDirectoryError>> {
      if (staged.length === 0) return failure("artifacts", "an artifact set must not be empty");
      const stagedPaths: { staged: string; final: string }[] = [];
      try {
        for (const artifact of staged) {
          const final = join(directory, ARTIFACTS, artifact.relativePath);
          mkdirSync(join(final, ".."), { recursive: true, mode: 0o700 });
          const stagedPath = `${final}.staged`;
          writeRunBytesNoFollow(stagedPath, Uint8Array.from(artifact.bytes));
          stagedPaths.push({ staged: stagedPath, final });
        }
      } catch (error) {
        discardStaged(stagedPaths);
        return failure("artifacts", `cannot stage artifact set: ${(error as Error).message}`);
      }

      // Check every target before promoting any of them. Renaming is the one
      // step that cannot be undone member-by-member, so the predictable reasons
      // it fails are ruled out while the set is still entirely staged — that is
      // what keeps "all or none" true rather than merely intended.
      const blocked = stagedPaths.find((entry) => isExistingDirectory(entry.final));
      if (blocked !== undefined) {
        discardStaged(stagedPaths);
        return failure("artifacts", `artifact slot is occupied by a directory: ${blocked.final}`);
      }

      // A failure here must still not report success. Any member already
      // promoted stays on disk but is inert: nothing treats a set as published
      // until its receipt is recorded, and the effect runner records that
      // receipt only on a successful return.
      for (const [index, entry] of stagedPaths.entries()) {
        try {
          publishStagedRunFile(entry.staged, entry.final);
        } catch (error) {
          discardStaged(stagedPaths.slice(index));
          return failure("artifacts", `cannot publish artifact set: ${(error as Error).message}`);
        }
      }

      const refs: ArtifactRef[] = [];
      for (const artifact of staged) {
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

    readTranscriptBytes(authority: AgentRequestAuthority): DomainResult<Uint8Array, RunDirectoryError> {
      try {
        return success(new Uint8Array(readRunBytesNoFollow(transcriptSlotPath(directory, authority))));
      } catch (error) {
        return failure("transcript", `cannot read captured transcript: ${(error as Error).message}`);
      }
    },

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

    readReceipt(effectId: EffectId): EffectReceipt | null {
      try {
        return readJsonNoFollow(join(directory, RECEIPTS, `${effectId}.json`)) as EffectReceipt;
      } catch {
        return null;
      }
    },
  });
}

export const RUN_DIRECTORY_LAYOUT = Object.freeze({
  events: EVENTS,
  requests: REQUESTS,
  contexts: CONTEXTS,
  transcripts: TRANSCRIPTS,
  receipts: RECEIPTS,
  artifacts: ARTIFACTS,
  authorityFile: AUTHORITY_FILE,
  checkpointFile: CHECKPOINT_FILE,
});

/** Exposed for the handle's own use and for callers proving anchored access. */
export { procFdChild };
