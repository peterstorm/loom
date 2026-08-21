/**
 * Fugue program runtime — the imperative shell that drives Loom's pure domain
 * reducers through Fugue 0.4.0's public state-machine kernel.
 *
 * Only Fugue's main public export is used (`Machine`, `JobLike`,
 * `runStateMachine`, `replayEvents`, `toJson`/`fromJson`); no private or
 * `/advanced` import, and no Redis/BullMQ. Durability is a local run
 * directory: an append-only event log plus a checkpoint projection.
 *
 * The kernel's ordering contract is load-bearing here. `runStateMachine`
 * appends the event BEFORE it checkpoints the post-state, so a crash between
 * the two leaves one immutable event whose dedup key a retry re-derives — the
 * journal recognises it, refuses the duplicate, and the checkpoint catches up.
 * Terminal-failed states are never checkpointed, so a failed run can never be
 * resumed into a state its own machine rejected.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withLock } from "../utils/lock";
import {
  fromJson,
  replayEvents,
  runStateMachine,
  toJson,
  type JobLike,
  type Machine,
  type RecordedEvent,
  type TraceEvent,
} from "@fuguejs/framework";

export const PROGRAM_JOURNAL_SCHEMA_VERSION = 1;

/** A durably recorded domain event. `sequence` is the append order, not a clock. */
export type ProgramEventRecord = Readonly<{
  schemaVersion: typeof PROGRAM_JOURNAL_SCHEMA_VERSION;
  sequence: number;
  dedupKey: string;
  recordedAtMs: number;
  event: unknown;
}>;

/**
 * Durable storage port behind the Fugue `JobLike`. `appendEvent` MUST be
 * idempotent on `dedupKey`: a second append carrying a key already present is
 * a no-op, which is what makes the kernel's append→checkpoint window safe.
 * T7's anchored `RunDirHandle` satisfies this same port.
 */
export interface ProgramJournal {
  appendEvent(record: ProgramEventRecord): Promise<void>;
  readEvents(): Promise<readonly ProgramEventRecord[]>;
  readCheckpoint(): Promise<string | null>;
  writeCheckpoint(json: string): Promise<void>;
  writeProgress(percent: number): Promise<void>;
}

export type ProgramRuntimeError = Readonly<{
  kind: "program-runtime-rejected";
  message: string;
}>;

export type ProgramRuntimeResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: ProgramRuntimeError }>;

const runtimeFailure = <T>(message: string): ProgramRuntimeResult<T> =>
  Object.freeze({ ok: false as const, error: Object.freeze({ kind: "program-runtime-rejected" as const, message }) });

const runtimeSuccess = <T>(value: T): ProgramRuntimeResult<T> => Object.freeze({ ok: true as const, value });

/** Stable digest used for dedup keys and checkpoint fingerprints. */
export function programDigest(value: unknown): string {
  return createHash("sha256").update(toJson(value)).digest("hex");
}

/**
 * Collision-resistant per-transition dedup key injected into the kernel. The
 * kernel's own fallback is a plain string concat; a run directory is a durable
 * audit surface, so it gets a hash instead.
 */
export function computeProgramDedupKey(prevStateKey: string, attemptNumber: number, event: unknown): string {
  return programDigest({ prevStateKey, attemptNumber, event });
}

function eventTypeOf(event: unknown): string {
  if (typeof event !== "object" || event === null) return "<event>";
  const record = event as Record<string, unknown>;
  const label = record["type"] ?? record["kind"];
  return typeof label === "string" ? label : "<event>";
}

// ---------------------------------------------------------------------------
// Journals
// ---------------------------------------------------------------------------

const EVENTS_DIR = "events";
const CHECKPOINT_FILE = "checkpoint.json";
const PROGRESS_FILE = "progress.json";

function eventFileName(sequence: number, dedupKey: string): string {
  return `${String(sequence).padStart(6, "0")}-${dedupKey}.json`;
}

function atomicWriteFile(path: string, contents: string): void {
  const temporary = `${path}.tmp.${process.pid}`;
  writeFileSync(temporary, contents);
  try {
    renameSync(temporary, path);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function parseProgramEventRecord(raw: unknown, source: string): ProgramEventRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Corrupt program event ${source}: not an object`);
  }
  const record = raw as Record<string, unknown>;
  if (record["schemaVersion"] !== PROGRAM_JOURNAL_SCHEMA_VERSION ||
      typeof record["sequence"] !== "number" || !Number.isInteger(record["sequence"]) || record["sequence"] < 0 ||
      typeof record["dedupKey"] !== "string" || !/^[A-Za-z0-9:_-]{1,256}$/.test(record["dedupKey"]) ||
      typeof record["recordedAtMs"] !== "number" || !Number.isFinite(record["recordedAtMs"]) ||
      !("event" in record)) {
    throw new Error(`Corrupt program event ${source}: field contract violated`);
  }
  return Object.freeze({
    schemaVersion: PROGRAM_JOURNAL_SCHEMA_VERSION,
    sequence: record["sequence"],
    dedupKey: record["dedupKey"],
    recordedAtMs: record["recordedAtMs"],
    event: record["event"],
  });
}

/**
 * Local run-directory journal for tests, dry runs, and benchmarks.
 *
 * Production orchestration uses `RunDirHandle`'s `journalOperations`, which
 * serializes appends through `withAnchoredDirectoryLock` and opens every path
 * component with O_NOFOLLOW. This implementation uses `withLock` from
 * `utils/lock.ts` (directory-based, no O_NOFOLLOW) and `mkdirSync` with
 * `recursive: true` (follows symlinks), so it does NOT carry the same
 * security guarantees — acceptable because it never runs against a production
 * run directory.
 *
 * Events are immutable files whose names carry both append order and dedup
 * key, so duplicate detection needs no index and survives a crash at any
 * point.
 */
export function createFileProgramJournal(directory: string): ProgramJournal {
  const eventsDirectory = join(directory, EVENTS_DIR);
  const checkpointPath = join(directory, CHECKPOINT_FILE);
  const progressPath = join(directory, PROGRESS_FILE);
  mkdirSync(eventsDirectory, { recursive: true });

  const eventFiles = (): readonly string[] =>
    readdirSync(eventsDirectory).filter((name) => name.endsWith(".json")).sort();

  return Object.freeze({
    /**
     * Serialized for the same reason as the anchored handle's journal: the
     * sequence prefix is the append ORDER, and it is derived from a directory
     * listing that two appenders carrying different dedup keys can observe
     * identically. Their filenames differ, so nothing refuses the second write
     * and both records claim the same sequence — after which `readEvents`'s
     * filename sort ranks them by dedup-key text rather than by happens-before,
     * and replay folds a history the run never had.
     */
    async appendEvent(record: ProgramEventRecord): Promise<void> {
      await withLock(join(eventsDirectory, "append"), () => {
        const existing = eventFiles();
        if (existing.some((name) => name.endsWith(`-${record.dedupKey}.json`))) return;
        const sequenced = Object.freeze({ ...record, sequence: existing.length });
        atomicWriteFile(join(eventsDirectory, eventFileName(sequenced.sequence, sequenced.dedupKey)), toJson(sequenced));
      });
    },
    async readEvents(): Promise<readonly ProgramEventRecord[]> {
      return Object.freeze(eventFiles().map((name) =>
        parseProgramEventRecord(fromJson(readFileSync(join(eventsDirectory, name), "utf-8")), name)));
    },
    async readCheckpoint(): Promise<string | null> {
      try {
        return readFileSync(checkpointPath, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
        throw error;
      }
    },
    async writeCheckpoint(json: string): Promise<void> {
      atomicWriteFile(checkpointPath, json);
    },
    async writeProgress(percent: number): Promise<void> {
      atomicWriteFile(progressPath, toJson({ percent }));
    },
  });
}

/** In-memory journal for tests and dry runs; enforces the same dedup contract. */
export function createInMemoryProgramJournal(): ProgramJournal {
  const events: ProgramEventRecord[] = [];
  const seen = new Set<string>();
  let checkpoint: string | null = null;

  return Object.freeze({
    async appendEvent(record: ProgramEventRecord): Promise<void> {
      if (seen.has(record.dedupKey)) return;
      seen.add(record.dedupKey);
      events.push(Object.freeze({ ...record, sequence: events.length }));
    },
    async readEvents(): Promise<readonly ProgramEventRecord[]> {
      return Object.freeze([...events]);
    },
    async readCheckpoint(): Promise<string | null> {
      return checkpoint;
    },
    async writeCheckpoint(json: string): Promise<void> {
      checkpoint = json;
    },
    async writeProgress(): Promise<void> {
      // Progress is a projection; in-memory runs have no consumer for it.
    },
  });
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

export type ProgramData<S, C> = Readonly<{ state: S; context: C }>;

/**
 * Checkpoint codec. Encoding goes through Fugue's `toJson` so Map/Set/Date
 * survive; decoding NEVER trusts the bytes — the caller's parser must rebuild
 * typed values, and a rejected checkpoint is an error rather than a cast.
 */
export type ProgramCheckpointCodec<S, C> = Readonly<{
  encode: (data: ProgramData<S, C>) => string;
  decode: (json: string) => ProgramRuntimeResult<ProgramData<S, C>>;
}>;

export function createCheckpointCodec<S, C>(
  parse: (raw: unknown) => ProgramRuntimeResult<ProgramData<S, C>>,
): ProgramCheckpointCodec<S, C> {
  return Object.freeze({
    encode: (data: ProgramData<S, C>): string => toJson({ schemaVersion: PROGRAM_JOURNAL_SCHEMA_VERSION, data }),
    decode: (json: string): ProgramRuntimeResult<ProgramData<S, C>> => {
      const decoded = ((): unknown => {
        try {
          return fromJson(json);
        } catch (error) {
          return Object.freeze({ __malformed: error instanceof Error ? error.message : String(error) });
        }
      })();
      if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
        return runtimeFailure("checkpoint is not a JSON object");
      }
      const record = decoded as Record<string, unknown>;
      if (typeof record["__malformed"] === "string") {
        return runtimeFailure(`checkpoint is not readable JSON: ${record["__malformed"]}`);
      }
      if (record["schemaVersion"] !== PROGRAM_JOURNAL_SCHEMA_VERSION) {
        return runtimeFailure(`checkpoint schema version must be ${PROGRAM_JOURNAL_SCHEMA_VERSION}`);
      }
      return parse(record["data"]);
    },
  });
}

// ---------------------------------------------------------------------------
// Machine adapter
// ---------------------------------------------------------------------------

/**
 * A Loom domain reducer expressed for the Fugue kernel. Domain reducers reject
 * illegal events instead of throwing, so the adapter needs an explicit landing
 * state for a rejection: silently keeping the prior state would let a rejected
 * event look like a successful self-loop in the audit log.
 */
export type ProgramMachineSpec<S, E, C> = Readonly<{
  reduce: (state: S, event: E, context: C) => ProgramRuntimeResult<ProgramData<S, C>>;
  onRejected: (state: S, context: C, message: string) => ProgramData<S, C>;
  isTerminal: (state: S) => boolean;
  isFailed: (state: S) => boolean;
  isHalted?: (state: S) => boolean;
  progress: (state: S) => number;
  stateKey: (state: S) => string;
}>;

/**
 * Adapt a domain reducer to Fugue's `Machine`. `stateKey` is mandatory in the
 * kernel because `JSON.stringify` is unreliable for Map/Set state; the spec
 * must supply one, and it is reused for dedup slots and trace projection.
 */
export function toProgramMachine<S, E, C>(spec: ProgramMachineSpec<S, E, C>): Machine<S, E, C> {
  return Object.freeze({
    transition: (state: S, event: E, context: C): { state: S; context: C } => {
      const reduced = spec.reduce(state, event, context);
      const next = reduced.ok ? reduced.value : spec.onRejected(state, context, reduced.error.message);
      return { state: next.state, context: next.context };
    },
    isTerminal: spec.isTerminal,
    isFailed: spec.isFailed,
    ...(spec.isHalted === undefined ? {} : { isHalted: spec.isHalted }),
    stateProgress: spec.progress,
    stateKey: spec.stateKey,
  });
}

// ---------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------

/**
 * `JobLike` over a `ProgramJournal`. The kernel reads `job.data` exactly once
 * at loop entry, so the resumed checkpoint must already be installed when this
 * is constructed — hence `resumeProgram` below rather than a lazy read.
 */
export function createProgramJob<S, E, C>(args: Readonly<{
  journal: ProgramJournal;
  codec: ProgramCheckpointCodec<S, C>;
  initial: ProgramData<S, C>;
}>): JobLike<S, E, C> & Readonly<{ current: () => ProgramData<S, C> }> {
  let current: ProgramData<S, C> = args.initial;

  return Object.freeze({
    get data(): { readonly state: S; readonly context: C } {
      return current;
    },
    current: (): ProgramData<S, C> => current,
    async updateData(next: { state: S; context: C }): Promise<void> {
      const frozen: ProgramData<S, C> = Object.freeze({ state: next.state, context: next.context });
      await args.journal.writeCheckpoint(args.codec.encode(frozen));
      current = frozen;
    },
    async updateProgress(percent: number): Promise<void> {
      await args.journal.writeProgress(percent);
    },
    async appendEvent(event: E, dedupKey?: string): Promise<void> {
      await args.journal.appendEvent(Object.freeze({
        schemaVersion: PROGRAM_JOURNAL_SCHEMA_VERSION,
        sequence: 0,
        dedupKey: dedupKey ?? programDigest(event),
        recordedAtMs: Date.now(),
        event,
      }));
    },
  });
}

// ---------------------------------------------------------------------------
// Replay and resume
// ---------------------------------------------------------------------------

/** Envelope shape `replayEvents` unwraps automatically. */
function toRecordedEvents(records: readonly ProgramEventRecord[]): readonly RecordedEvent<unknown>[] {
  return records.map((record) => Object.freeze({ recordedAtMs: record.recordedAtMs, event: record.event }));
}

/**
 * Rebuild state from the durable event prefix. Pure with respect to the world:
 * `replayEvents` folds the recorded events through the machine and re-invokes
 * no executor, so replay proves state without repeating a single effect.
 */
export function replayProgram<S, E, C>(
  machine: Machine<S, E, C>,
  genesis: ProgramData<S, C>,
  records: readonly ProgramEventRecord[],
): ProgramData<S, C> {
  const replayed = replayEvents(toRecordedEvents(records), machine, { state: genesis.state, context: genesis.context });
  return Object.freeze({ state: replayed.state, context: replayed.context });
}

/**
 * Resolve the data a run should resume from and prove the two durable
 * representations agree. The event log is authoritative: the checkpoint is a
 * projection that a crash may legitimately leave one transition behind, and
 * that lag is expected rather than corruption. A checkpoint that instead
 * disagrees with the replayed prefix is corruption and fails closed.
 */
export function resumeProgram<S, E, C>(args: Readonly<{
  machine: Machine<S, E, C>;
  codec: ProgramCheckpointCodec<S, C>;
  genesis: ProgramData<S, C>;
  records: readonly ProgramEventRecord[];
  checkpoint: string | null;
}>): ProgramRuntimeResult<ProgramData<S, C>> {
  const replayed = replayProgram(args.machine, args.genesis, args.records);
  if (args.checkpoint === null) return runtimeSuccess(replayed);

  const decoded = args.codec.decode(args.checkpoint);
  if (!decoded.ok) return decoded;

  const replayedKey = args.machine.stateKey(replayed.state);
  const checkpointKey = args.machine.stateKey(decoded.value.state);
  if (replayedKey === checkpointKey) return runtimeSuccess(replayed);

  const lagging = replayLagsCheckpoint(args, decoded.value, checkpointKey);
  return lagging
    ? runtimeSuccess(replayed)
    : runtimeFailure(
      `checkpoint state disagrees with the replayed event prefix (checkpoint ${checkpointKey}, replay ${replayedKey})`,
    );
}

/**
 * A checkpoint written before its event landed is the one benign divergence:
 * it must match the replay of a strict prefix of the log.
 */
function replayLagsCheckpoint<S, E, C>(
  args: Readonly<{ machine: Machine<S, E, C>; genesis: ProgramData<S, C>; records: readonly ProgramEventRecord[] }>,
  checkpointData: ProgramData<S, C>,
  checkpointKey: string,
): boolean {
  return args.records.some((_, index) => {
    const prefix = replayProgram(args.machine, args.genesis, args.records.slice(0, index));
    return args.machine.stateKey(prefix.state) === checkpointKey &&
      args.machine.stateKey(checkpointData.state) === checkpointKey;
  });
}

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

/**
 * Trace projection. Carries ids, keys, counts and outcomes only — never prose
 * or context bytes, so a trace can be retained without becoming a second,
 * unaudited copy of the payloads a run moved.
 */
export type ProgramTraceRecord = Readonly<{
  schemaVersion: typeof PROGRAM_JOURNAL_SCHEMA_VERSION;
  runId: string;
  fromStateKey: string;
  toStateKey: string;
  eventType: string;
  outcome: "success" | "retry" | "skipped" | "failed";
  durationMs: number;
  timestampMs: number;
}>;

export function projectProgramTrace<S, E>(
  runId: string,
  stateKey: (state: S) => string,
  trace: TraceEvent<S, E>,
): ProgramTraceRecord {
  return Object.freeze({
    schemaVersion: PROGRAM_JOURNAL_SCHEMA_VERSION,
    runId,
    fromStateKey: stateKey(trace.state),
    toStateKey: stateKey(trace.nextState),
    eventType: trace.event === undefined ? "<aborted>" : eventTypeOf(trace.event),
    outcome: trace.outcome,
    durationMs: trace.durationMs,
    timestampMs: trace.timestamp.getTime(),
  });
}

// ---------------------------------------------------------------------------
// Driving a program
// ---------------------------------------------------------------------------

export type ProgramRunOutcome<S, C> = Readonly<{
  data: ProgramData<S, C>;
  traces: readonly ProgramTraceRecord[];
  halted: boolean;
  terminal: boolean;
}>;

/**
 * Drive one program to its next resting point: terminal, halted at a gate, or
 * a thrown terminal-failure. The executor supplies the next event; the kernel
 * owns append-before-checkpoint ordering, dedup, and HALT.
 */
export async function runProgram<S, E, C>(args: Readonly<{
  runId: string;
  machine: Machine<S, E, C>;
  journal: ProgramJournal;
  codec: ProgramCheckpointCodec<S, C>;
  resumed: ProgramData<S, C>;
  executor: (state: S, context: C) => Promise<E>;
  errorEventOf: (classified: Readonly<{ retriable: boolean; message: string }>) => E;
  now?: () => number;
}>): Promise<ProgramRuntimeResult<ProgramRunOutcome<S, C>>> {
  const job = createProgramJob<S, E, C>({ journal: args.journal, codec: args.codec, initial: args.resumed });
  const traces: ProgramTraceRecord[] = [];

  try {
    const finished = await runStateMachine(job, args.machine, args.executor, {
      errorEventOf: args.errorEventOf,
      computeDedupKey: computeProgramDedupKey,
      ...(args.now === undefined ? {} : { now: args.now }),
      onTrace: (trace) => {
        traces.push(projectProgramTrace(args.runId, args.machine.stateKey, trace));
      },
    });
    const data: ProgramData<S, C> = Object.freeze({ state: finished.state, context: finished.context });
    return runtimeSuccess(Object.freeze({
      data,
      traces: Object.freeze([...traces]),
      halted: args.machine.isHalted?.(data.state) === true && !args.machine.isTerminal(data.state),
      terminal: args.machine.isTerminal(data.state),
    }));
  } catch (error) {
    return runtimeFailure(error instanceof Error ? error.message : String(error));
  }
}
