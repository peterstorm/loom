/**
 * Anchored atomic State File manager — the authority machine.
 *
 * Successful State File publications install mode 0444. Hooks and whitelisted
 * helpers stage validated bytes, set that mode before publication, and rename
 * through the anchored parent capability and lock — the retained parent
 * descriptor on Linux, the `O_NOFOLLOW_ANY`-proven real path on darwin. Loading
 * re-proves path and content authority; it does not attest the current file mode.
 * Replaces: state-file-write.sh, resolve-task-graph.sh, loom-config.sh
 *
 * The pure at-rest wire grammar (every `(unknown → ParseResult)` parser for the
 * State File's shapes) lives in `state-file-wire.ts` and is re-exported below,
 * so this module's import surface is unchanged; only the dependency arrow
 * moved. This file owns what reads and writes bytes: session/pointer authority
 * resolution, no-follow directory anchoring, the TaskGraph lock, and the
 * StateManager transaction boundary.
 */

import { engineRevisionWriteRefusal } from "./core/engine-revision-pin";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathExistsFailClosed, taskGraphPath } from "./config";
import { TASK_GRAPH_LOCK_NAME } from "./core/engine-runtime-paths";
import {
  parseCanonicalTaskGraphPointer,
  parseSessionId,
  sessionScopedPath,
  TASK_GRAPH_POINTER_SUFFIX,
} from "./machine";
import type { ActiveWaveGateRegistration, TaskGraph } from "./types";
import type { DomainResult } from "./core/orchestration-contract";
import type { WaveCompletionCommit, WaveCompletionCommitError } from "./core/wave-gate-machine";
import {
  assertPiCliMutationCompatible,
  captureLoomRuntimeIdentityAt,
  STRICT_RUNTIME_WRITE_BOUNDARY,
  type RuntimeWriteBoundary,
} from "./runtime-compatibility";
import { installWaveGateRegistration, type WaveGateInstallProgram } from "./core/wave-gate-registration";
import { lockedWaveGateCompletion } from "./core/wave-gate-machine";
import {
  anchoredDirectoryHasIdentity,
  anchoredDirectoryIdentity,
  closeAnchorGuarded,
  openDirectoryNoFollow,
  publishDirectoryFileExclusiveNoFollow,
  readDirectoryFileNoFollow,
  removeDirectoryRegularFileNoFollow,
  resolveBaseDirectory,
  withAnchoredDirectoryHandleLock,
  writeDirectoryFileAtomicModeNoFollow,
  type AnchoredDirectory,
  type AnchoredDirectoryIdentity,
} from "./utils/no-follow-fs";
import {
  parseTaskGraph,
  type ParsedTaskGraph,
} from "./state-file-wire";

// The State File wire grammar is re-exported here so every historical importer
// of `state-manager` keeps its exact import surface; only the dependency arrow
// moved (the grammar is pure and owns no filesystem authority).
export {
  parseActiveWaveGateRegistration,
  parseCompletedWaveGateRegistration,
  parseTaskGraph,
  auditedSameWaveEdges,
  taskDependencyErrors,
  taskGraphLifecycleErrors,
  taskIdError,
  parseStoredTask,
  storedTaskErrors,
  orphanExecutionReservationError,
} from "./state-file-wire";
export type {
  ParsedTask,
  ParsedTaskGraph,
} from "./state-file-wire";

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * The engine this process writes State Files as (loom#198, Cause 4): its
 * package root and content-addressed runtime revision under the strict
 * boundary. Population and adoption pin this revision, and the write boundary
 * judges a graph's pin against it, whatever boundary the write itself uses.
 */
export function runningEngineIdentity(): Readonly<{ packageRoot: string; revision: string }> {
  return captureLoomRuntimeIdentityAt(PACKAGE_ROOT, STRICT_RUNTIME_WRITE_BOUNDARY);
}

type TaskGraphFileAuthority = Readonly<{
  kind: "task-graph-file-authority";
  path: string;
  directoryPath: string;
  directoryIdentity: AnchoredDirectoryIdentity;
  leaf: string;
}>;

type StateDirectoryOutcome<T> =
  | Readonly<{ kind: "returned"; value: T }>
  | Readonly<{ kind: "threw"; error: unknown }>;

function finishStateDirectoryOperation<T>(
  directory: AnchoredDirectory,
  operation: string,
  outcome: StateDirectoryOutcome<T>,
): T {
  const failure = closeAnchorGuarded(
    directory,
    outcome.kind === "threw" ? outcome.error : null,
    operation,
  );
  if (failure !== null) throw failure;
  if (outcome.kind === "threw") throw outcome.error;
  return outcome.value;
}

function withStateDirectory<T>(
  directory: AnchoredDirectory,
  operation: string,
  use: () => T,
): T {
  let outcome: StateDirectoryOutcome<T>;
  try {
    outcome = { kind: "returned", value: use() };
  } catch (error) {
    outcome = { kind: "threw", error };
  }
  return finishStateDirectoryOperation(directory, operation, outcome);
}

async function withStateDirectoryAsync<T>(
  directory: AnchoredDirectory,
  operation: string,
  use: () => Promise<T>,
): Promise<T> {
  let outcome: StateDirectoryOutcome<T>;
  try {
    outcome = { kind: "returned", value: await use() };
  } catch (error) {
    outcome = { kind: "threw", error };
  }
  return finishStateDirectoryOperation(directory, operation, outcome);
}

/**
 * Read one session pointer through its subagent base, resolved once.
 *
 * The subagent directory is the BASE for session-scoped files: its configured
 * path may traverse a system symlink (macOS resolves `/tmp` to
 * `/private/tmp`), so it is resolved here rather than walked strictly from the
 * filesystem root — the same reason `resolveBaseDirectory` resolves a
 * run base. ENOENT propagates: an absent base is the one absent answer, the
 * same one an absent pointer produces. The leaf itself is still read with no
 * component followed.
 */
function readSessionPointerNoFollow(sessionFile: string): string {
  const directory = openDirectoryNoFollow(resolveBaseDirectory(dirname(sessionFile)));
  return withStateDirectory(directory, `session pointer read of ${sessionFile}`, () =>
    readDirectoryFileNoFollow(directory, basename(sessionFile)).toString("utf8"));
}

function captureTaskGraphFileAuthority(path: string, requireExisting: boolean): TaskGraphFileAuthority {
  const parsedPath = parseCanonicalTaskGraphPointer(resolve(path));
  if (!parsedPath.ok) throw new Error(parsedPath.error);
  // Unlike the session pointer's subagent base, the graph parent is held to the
  // STRICT no-symlink rule: the pointer names an engine-issued location, so a
  // symlinked ancestor is hostile re-binding, not legitimate configuration —
  // openDirectoryNoFollow refuses it with ELOOP before any byte is read.
  const directoryPath = dirname(parsedPath.value);
  const directory = openDirectoryNoFollow(directoryPath);
  return withStateDirectory(directory, `TaskGraph authority capture for ${parsedPath.value}`, () => {
    if (requireExisting) readDirectoryFileNoFollow(directory, basename(parsedPath.value));
    return Object.freeze({
      kind: "task-graph-file-authority" as const,
      path: parsedPath.value,
      directoryPath,
      directoryIdentity: anchoredDirectoryIdentity(directory),
      leaf: basename(parsedPath.value),
    });
  });
}

function parseSessionPointerFile(sessionFile: string): string {
  const parsed = parseCanonicalTaskGraphPointer(readSessionPointerNoFollow(sessionFile));
  if (!parsed.ok) throw new Error(`session pointer ${sessionFile} is malformed: ${parsed.error}`);
  return parsed.value;
}

function optionalLocalTaskGraphAuthority(): TaskGraphFileAuthority | null {
  try {
    return captureTaskGraphFileAuthority(taskGraphPath(), true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function resolveTaskGraphFileAuthority(sessionId?: string): TaskGraphFileAuthority | null {
  if (sessionId === undefined) return optionalLocalTaskGraphAuthority();
  const parsed = parseSessionId(sessionId);
  if (parsed === null) {
    throw new Error(
      `resolveTaskGraph: invalid session id ${JSON.stringify(sessionId)} — refusing local task-graph fallback`,
    );
  }
  const sessionFile = sessionScopedPath(parsed, TASK_GRAPH_POINTER_SUFFIX);
  let pointedPath: string;
  try {
    pointedPath = parseSessionPointerFile(sessionFile);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const message = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? `session pointer ${sessionFile} is absent: ${cause}`
      : `cannot read session pointer ${sessionFile}: ${cause}`;
    throw new Error(`resolveTaskGraph: ${message} — refusing local task-graph fallback`);
  }
  return pointedTaskGraphAuthority(pointedPath, sessionFile);
}

/**
 * Capture no-follow file authority for a session pointer's target, or refuse
 * the local fallback with the exact same diagnostic from every caller. One
 * enforcement point for the translate-catch contract: ENOENT names a missing
 * graph, anything else names an inaccessible one.
 */
function pointedTaskGraphAuthority(pointedPath: string, sessionFile: string): TaskGraphFileAuthority {
  try {
    return captureTaskGraphFileAuthority(pointedPath, true);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const description = (error as NodeJS.ErrnoException).code === "ENOENT"
      ? `names missing graph '${pointedPath}'`
      : `names inaccessible graph '${pointedPath}': ${cause}`;
    throw new Error(
      `resolveTaskGraph: session pointer ${sessionFile} ${description} — refusing local task-graph fallback`,
    );
  }
}

/** Resolve a TaskGraph display path after proving no-follow file authority. */
export function resolveTaskGraph(sessionId?: string): string | null {
  return resolveTaskGraphFileAuthority(sessionId)?.path ?? null;
}

/** Explicit Pi-parent compatibility: only an absent pointer selects local authority. */
function resolveLocalSessionTaskGraphAuthority(sessionId: string): TaskGraphFileAuthority | null {
  const parsed = parseSessionId(sessionId);
  if (parsed === null) throw new Error(`resolveTaskGraph: invalid session id ${JSON.stringify(sessionId)}`);
  const sessionFile = sessionScopedPath(parsed, TASK_GRAPH_POINTER_SUFFIX);
  let pointedPath: string;
  try {
    pointedPath = parseSessionPointerFile(sessionFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return optionalLocalTaskGraphAuthority();
    throw new Error(
      `resolveTaskGraph: cannot read session pointer ${sessionFile}: ` +
      `${error instanceof Error ? error.message : String(error)} — refusing local task-graph fallback`,
    );
  }
  return pointedTaskGraphAuthority(pointedPath, sessionFile);
}

export class StateManager {
  private readonly path: string;
  private readonly authority: TaskGraphFileAuthority;
  /** The write boundary's revision policy: strict for every caller except
   *  implementation settlement, which restores the in-flight attempts'
   *  provably-clean runtime paths to their attempt-start bytes. See
   *  RuntimeWriteBoundary. */
  private readonly writeBoundary: RuntimeWriteBoundary;

  constructor(
    path: string,
    authority: TaskGraphFileAuthority = captureTaskGraphFileAuthority(path, false),
    writeBoundary: RuntimeWriteBoundary = STRICT_RUNTIME_WRITE_BOUNDARY,
  ) {
    this.path = authority.path;
    this.authority = authority;
    this.writeBoundary = writeBoundary;
  }

  static fromSession(sessionId?: string): StateManager | null {
    const authority = resolveTaskGraphFileAuthority(sessionId);
    return authority === null ? null : new StateManager(authority.path, authority);
  }

  /** Pi parent adapter seam; see resolveLocalSessionTaskGraphAuthority. */
  static fromLocalSession(
    sessionId: string,
    writeBoundary: RuntimeWriteBoundary = STRICT_RUNTIME_WRITE_BOUNDARY,
  ): StateManager | null {
    const authority = resolveLocalSessionTaskGraphAuthority(sessionId);
    return authority === null ? null : new StateManager(authority.path, authority, writeBoundary);
  }

  /**
   * `null` means the graph is genuinely ABSENT — ENOENT and nothing else.
   * Bare `existsSync` also returns `false` for EACCES/ELOOP/ENOTDIR/EIO, so an
   * unreadable graph used to be indistinguishable from a missing one and every
   * caller reported "no task graph at X" for a path that was really there.
   * A present-but-unreadable graph now yields a manager whose `load()` reports
   * the real access failure, the same way a corrupt one already does.
   */
  static fromPath(path: string): StateManager | null {
    return pathExistsFailClosed(path) ? new StateManager(path) : null;
  }

  private openAuthorityDirectory(): AnchoredDirectory {
    const directory = openDirectoryNoFollow(this.authority.directoryPath);
    if (anchoredDirectoryHasIdentity(directory, this.authority.directoryIdentity)) return directory;
    const authorityError = new Error(
      `TaskGraph parent authority changed after capture: ${this.authority.directoryPath}`,
    );
    throw closeAnchorGuarded(directory, authorityError, "TaskGraph parent authority rejection");
  }

  private loadFrom(directory: AnchoredDirectory): ParsedTaskGraph {
    return this.parseGraphBytes(readDirectoryFileNoFollow(directory, this.authority.leaf));
  }

  private parseGraphBytes(bytes: Buffer): ParsedTaskGraph {
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new Error(
        `Corrupt state file (invalid UTF-8): ${this.path} — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Corrupt state file (invalid JSON): ${this.path} — ${(e as Error).message}`);
    }
    const graph = parseTaskGraph(parsed);
    if (!graph.ok) throw new Error(`Corrupt state file (${graph.error}): ${this.path}`);
    return graph.value;
  }

  load(): ParsedTaskGraph {
    const directory = this.openAuthorityDirectory();
    return withStateDirectory(directory, `TaskGraph load of ${this.path}`, () => this.loadFrom(directory));
  }

  getPath(): string {
    return this.path;
  }

  /**
   * Atomically update state under the TaskGraph lock. The callback runs while
   * that lock is held: ordinary reducers should stay pure, while authority-
   * sensitive callers may re-observe external evidence there to compare and
   * commit one exact snapshot. Keep such observations bounded and fail closed.
   */
  async update(fn: (state: ParsedTaskGraph) => TaskGraph): Promise<void> {
    await this.updateAndReturn((state) => ({ state: fn(state), value: undefined }));
  }

  /** Atomic shell primitive returning the exact lock-time decision committed. */
  async updateAndReturn<T>(
    fn: (state: ParsedTaskGraph) => Readonly<{ state: TaskGraph; value: T }>,
  ): Promise<T> {
    return this.atomicWrite((directory) => {
      const current = this.loadFrom(directory);
      const produced = fn(current);
      return produced.state === current
        ? { ...produced, persist: false as const }
        : produced;
    });
  }

  /**
   * Replace state entirely (used by populate-task-graph and repair-task-graph).
   * A full replacement never reads the outgoing graph, so it deliberately does
   * not route through `updateAndReturn`: recovering a graph the load boundary
   * already rejects is the whole purpose of repair, and loading first would
   * make the corrupt file block its own repair. The replacement is still
   * validated by `atomicWrite` before it can reach disk.
   */
  async replace(state: TaskGraph): Promise<void> {
    await this.atomicWrite(() => ({ state, value: undefined }));
  }

  /**
   * Retire a finished graph: under the TaskGraph lock, load it, let the caller's
   * pure decision name the archive leaf (or refuse), publish the exact bytes to
   * that leaf beside the graph, then remove the live graph. The publish is
   * exclusive and whole (prepared bytes hard-linked into place: an existing
   * archive is never overwritten, and no partial archive is ever visible). The
   * archive is published before the removal, so a failure in between leaves
   * both, never neither.
   */
  async archiveAndRemove(
    decide: (graph: ParsedTaskGraph) => DomainResult<string, string>,
  ): Promise<DomainResult<string, string>> {
    assertPiCliMutationCompatible(process.env, captureLoomRuntimeIdentityAt(PACKAGE_ROOT, this.writeBoundary));
    const directory = this.openAuthorityDirectory();
    return withStateDirectoryAsync(directory, `TaskGraph archive of ${this.path}`, () =>
      withAnchoredDirectoryHandleLock(directory, TASK_GRAPH_LOCK_NAME, () => {
        // One read: the bytes archived are exactly the bytes judged.
        const bytes = readDirectoryFileNoFollow(directory, this.authority.leaf);
        const decision = decide(this.parseGraphBytes(bytes));
        if (!decision.ok) return decision;
        publishDirectoryFileExclusiveNoFollow(directory, decision.value, bytes);
        removeDirectoryRegularFileNoFollow(directory, this.authority.leaf);
        return decision;
      }));
  }

  /** lock → derive/parse → stage read-only bytes → anchored pathname rename → unlock */
  private async atomicWrite<T>(
    produce: (directory: AnchoredDirectory) => Readonly<{
      state: TaskGraph;
      value: T;
      /** Exact-state refusal/idempotent replay: keep bytes and metadata untouched. */
      persist?: false;
    }>,
  ): Promise<T> {
    // This is the final shared write boundary, including replacement/repair
    // paths. Check before lock creation so a skewed fresh CLI leaves the
    // protected graph byte-for-byte and metadata-for-metadata untouched.
    // Implementation settlement's restoring boundary hashes the in-flight
    // attempts' provably-clean runtime paths at their attempt-start bytes: the
    // attempt writing those files is the product, not runtime drift. Every
    // other path still hashes live, so any other drift refuses exactly as
    // before; the strict boundary is the full-domain live capture.
    const identity = captureLoomRuntimeIdentityAt(PACKAGE_ROOT, this.writeBoundary);
    assertPiCliMutationCompatible(process.env, identity);
    const directory = this.openAuthorityDirectory();
    return withStateDirectoryAsync(directory, `TaskGraph atomic write of ${this.path}`, () =>
      withAnchoredDirectoryHandleLock(directory, TASK_GRAPH_LOCK_NAME, () => {
        const produced = produce(directory);
        if (produced.persist === false) return produced.value;
        const parsed = parseTaskGraph(produced.state);
        if (!parsed.ok) throw new Error(`Refusing to persist invalid task graph (${parsed.error}): ${this.path}`);
        // A State File is only ever written by the engine revision it is pinned to (loom#198, Cause 4),
        // judged under the strict boundary the pin was minted under; a restoring boundary's identity differs by design.
        const pinRevision = this.writeBoundary.kind === "strict" ? identity.revision : runningEngineIdentity().revision;
        const pinRefusal = engineRevisionWriteRefusal(parsed.value, pinRevision);
        if (pinRefusal !== null) throw new Error(pinRefusal);
        writeDirectoryFileAtomicModeNoFollow(
          directory,
          this.authority.leaf,
          JSON.stringify(parsed.value, null, 2),
          0o444,
        );
        return produced.value;
      }));
  }
}

/**
 * Install one fresh protected active-run anchor under the TaskGraph lock,
 * idempotently for exact replay (`installWaveGateRegistration`). `program` is
 * the run's program registration (or the part the install reads): its
 * published Tasks, and the succession (ADR-0091) and narrowed reviews
 * (ADR-0094) it froze, which the install checks against protected state.
 */
export async function registerActiveWaveGate(
  manager: StateManager,
  registration: ActiveWaveGateRegistration,
  program: WaveGateInstallProgram,
): Promise<ActiveWaveGateRegistration> {
  return manager.updateAndReturn((state) => {
    const decision = installWaveGateRegistration(state, registration, program);
    if (decision.kind === "refused") throw new Error(decision.message);
    return { state: decision.kind === "installed" ? decision.state : state, value: decision.registration };
  });
}

/** Lock, re-derive completion through the caller's pure domain function
 * (`lockedWaveGateCompletion`), persist terminal history + advancement
 * together, and return its receipt. */
export async function commitActiveWaveGateCompletion(
  manager: StateManager,
  derive: (lockedState: TaskGraph) => DomainResult<WaveCompletionCommit, WaveCompletionCommitError>,
): Promise<WaveCompletionCommit> {
  return manager.updateAndReturn((state) => {
    const committed = lockedWaveGateCompletion(state, derive);
    if (!committed.ok) throw new Error(committed.error);
    return { state: committed.value.graph, value: committed.value };
  });
}
