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

import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathExistsFailClosed, taskGraphPath } from "./config";
import {
  parseCanonicalTaskGraphPointer,
  parseSessionId,
  sessionScopedPath,
} from "./machine";
import type { ActiveWaveGateRegistration, CompletedWaveGateRegistration, TaskGraph } from "./types";
import type { DomainResult } from "./core/orchestration-contract";
import type { WaveCompletionCommit, WaveCompletionCommitError } from "./core/wave-gate-machine";
import { assertPiCliMutationCompatible, captureLoomRuntimeIdentity } from "./runtime-compatibility";
import { waveGateAuthorityDigest } from "./core/wave-review-authority";
import {
  anchoredDirectoryHasIdentity,
  anchoredDirectoryIdentity,
  closeAnchorGuarded,
  openDirectoryNoFollow,
  readDirectoryFileNoFollow,
  resolveBaseDirectory,
  withAnchoredDirectoryHandleLock,
  writeDirectoryFileAtomicModeNoFollow,
  type AnchoredDirectory,
  type AnchoredDirectoryIdentity,
} from "./orchestration/no-follow-fs";
import {
  findLegacyWaveGateCompletionReplay,
  deriveLegacyWaveGateCompatibilityAuthority,
  type LegacyWaveGateCompatibilityAuthority,
  type LegacyWaveGateCompletionReplayError,
} from "./core/legacy-archive";
import {
  parseActiveWaveGateRegistration,
  parseActiveWaveGateTerminalOutcome,
  parseLegacyWaveGateMigrationAuthority,
  parseTaskGraph,
  type ParsedTaskGraph,
} from "./state-file-wire";

export { TASK_ID_PATTERN } from "./core/task-id";

// The State File wire grammar is re-exported here so every historical importer
// of `state-manager` keeps its exact import surface; only the dependency arrow
// moved (the grammar is pure and owns no filesystem authority).
export {
  parseActiveWaveGateRegistration,
  parseCompletedWaveGateRegistration,
  parseTaskGraph,
  taskDependencyErrors,
  taskGraphLifecycleErrors,
  taskIdError,
  taskUnionError,
  orphanExecutionReservationError,
  parseLegacyWaveGateMigrationAuthority,
} from "./state-file-wire";
export type {
  ParsedLegacyWaveGateMigrationAuthority,
  ParsedTask,
  ParsedTaskGraph,
} from "./state-file-wire";

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

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
  const sessionFile = sessionScopedPath(parsed, ".task_graph");
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
  const sessionFile = sessionScopedPath(parsed, ".task_graph");
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

export type RegisteredWaveGateCompletionReplayError = Readonly<{
  kind: "registered-wave-gate-completion-replay-rejected";
  message: string;
}>;

type AbandonedWaveGateRegistration = Extract<
  ActiveWaveGateRegistration,
  { terminalOutcome: { kind: "terminal-abandoned" } }
>;

export type ActiveWaveGateAbandonmentResult =
  | Readonly<{ kind: "stamped"; registration: AbandonedWaveGateRegistration }>
  | Readonly<{ kind: "replayed"; registration: AbandonedWaveGateRegistration }>
  | Readonly<{
      kind: "not-targeted";
      reason: "registration-absent" | "authority-mismatch" | "terminal-conflict";
    }>;

export function findRegisteredWaveGateCompletionReplay(
  graph: TaskGraph,
  authority: ActiveWaveGateRegistration,
): DomainResult<CompletedWaveGateRegistration | null, RegisteredWaveGateCompletionReplayError> {
  const reject = (message: string): DomainResult<never, RegisteredWaveGateCompletionReplayError> =>
    Object.freeze({
      ok: false,
      error: Object.freeze({ kind: "registered-wave-gate-completion-replay-rejected", message }),
    });
  if (authority.terminalOutcome !== null) {
    return reject(`Pre-read Wave Gate run ${authority.runId} was already terminal rather than active`);
  }
  const history = graph.wave_gate_history ?? [];
  const sameRun = history.find((entry) => entry.runId === authority.runId);
  const sameWave = history.find((entry) => entry.wave === authority.wave);
  const candidate = sameRun ?? sameWave;
  if (candidate === undefined) return Object.freeze({ ok: true, value: null });
  if (
    candidate.runId !== authority.runId || candidate.wave !== authority.wave ||
    candidate.authorityDigest !== authority.authorityDigest || candidate.revision !== authority.revision + 1
  ) {
    return reject(
      `Wave ${authority.wave} terminal history conflicts with pre-read active run ${authority.runId} ` +
      `(expected digest ${authority.authorityDigest} and revision ${authority.revision + 1})`,
    );
  }
  if (
    candidate.completionReceipt.runId !== authority.runId ||
    candidate.completionReceipt.committedRevision !== candidate.revision
  ) {
    return reject(`Wave ${authority.wave} terminal history carries a contradictory completion receipt`);
  }
  return Object.freeze({ ok: true, value: candidate });
}

export class StateManager {
  private readonly path: string;
  private readonly authority: TaskGraphFileAuthority;

  constructor(
    path: string,
    authority: TaskGraphFileAuthority = captureTaskGraphFileAuthority(path, false),
  ) {
    this.path = authority.path;
    this.authority = authority;
  }

  static fromSession(sessionId?: string): StateManager | null {
    const authority = resolveTaskGraphFileAuthority(sessionId);
    return authority === null ? null : new StateManager(authority.path, authority);
  }

  /** Pi parent adapter seam; see resolveLocalSessionTaskGraphAuthority. */
  static fromLocalSession(sessionId: string): StateManager | null {
    const authority = resolveLocalSessionTaskGraphAuthority(sessionId);
    return authority === null ? null : new StateManager(authority.path, authority);
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
    const bytes = readDirectoryFileNoFollow(directory, this.authority.leaf);
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

  /** Install one fresh protected active-run anchor, idempotently for exact replay. */
  async registerActiveWaveGate(
    rawRegistration: unknown,
    publishedTaskIds: readonly string[],
  ): Promise<ActiveWaveGateRegistration> {
    const parsed = parseActiveWaveGateRegistration(rawRegistration);
    if (!parsed.ok) throw new Error(`Invalid active Wave Gate registration: ${parsed.error}`);
    const registration = parsed.value;
    return this.updateAndReturn((state) => {
      if (state.current_phase !== "execute") {
        throw new Error(`Cannot register Wave Gate run outside execute Phase (current: ${state.current_phase})`);
      }
      if (state.current_wave !== registration.wave) {
        throw new Error(`Cannot register Wave Gate wave ${registration.wave}; protected current_wave is ${state.current_wave ?? "missing"}`);
      }
      if (registration.revision !== 0 || registration.terminalOutcome !== null) {
        throw new Error("A fresh active Wave Gate registration must start at revision 0 without a terminal outcome");
      }
      const completed = state.wave_gate_history ?? [];
      if (completed.some((entry) => entry.runId === registration.runId)) {
        throw new Error(`Wave Gate run ${registration.runId} is already terminal`);
      }
      if (completed.some((entry) => entry.wave >= registration.wave)) {
        throw new Error(`Wave ${registration.wave} is already completed or older than terminal Wave history`);
      }
      const existing = state.active_wave_gate;
      if (existing !== undefined) {
        const exactReplay = existing.runId === registration.runId &&
          existing.wave === registration.wave &&
          existing.authorityDigest === registration.authorityDigest && existing.runsRoot === registration.runsRoot &&
          existing.revision === registration.revision && existing.terminalOutcome === null;
        if (exactReplay) return { state, value: existing };
        if (existing.terminalOutcome === null) {
          throw new Error(`Active Wave Gate run ${existing.runId} already owns wave ${existing.wave}`);
        }
        if (existing.terminalOutcome.kind !== "terminal-abandoned") {
          throw new Error(
            `Legacy terminal Wave Gate run ${existing.runId} must be explicitly migrated to terminal history before registering another run`,
          );
        }
        if (existing.terminalOutcome.supersededBy !== null &&
            existing.terminalOutcome.supersededBy !== registration.runId) {
          throw new Error(
            `Abandoned Wave Gate run ${existing.runId} authorizes successor ${existing.terminalOutcome.supersededBy}, ` +
            `not ${registration.runId}`,
          );
        }
        // An operator-abandoned tombstone is not authority for the Wave: the
        // fresh registration supersedes it below. Roster and digest are still
        // re-proven against the locked state, and the tombstone is NOT
        // archived into wave_gate_history — that history poisons later starts
        // for the same Wave, and an abandoned run was never completed.
      }
      const lockedTaskIds = state.tasks
        .filter((task) => task.wave === registration.wave)
        .map(({ id }) => id);
      const rosterMatches = lockedTaskIds.length === publishedTaskIds.length &&
        lockedTaskIds.every((taskId, index) => taskId === publishedTaskIds[index]);
      const lockedDigest = waveGateAuthorityDigest(registration.wave, lockedTaskIds, state);
      if (!rosterMatches || lockedDigest !== registration.authorityDigest) {
        throw new Error(
          "Protected Wave authority changed after Run Directory publication; active Wave Gate was not installed",
        );
      }
      return { state: { ...state, active_wave_gate: registration }, value: registration };
    });
  }

  /**
   * Stamp the operator's terminal abandonment onto the protected registration.
   *
   * `helper orchestration abandon` writes an immutable marker inside the Run
   * Directory; this stamps the SAME terminal decision onto the active
   * registration under the TaskGraph lock, so a tombstoned registration stops
   * being active authority and a fresh `start` can supersede it. The outcome
   * is re-proven through `parseActiveWaveGateTerminalOutcome` rather than
   * constructed directly: the stored form is parser-proven, and the state
   * boundary refuses to persist what its own parser would reject.
   *
   * A non-targeted result names why no protected registration changed. Exact
   * repeat is a distinct replay result, not another apparent write.
   */
  async abandonActiveWaveGateRegistration(
    abandonment: Readonly<{
      runsRoot: string;
      runId: ActiveWaveGateRegistration["runId"];
      reason: string;
      supersededBy: ActiveWaveGateRegistration["runId"] | null;
    }>,
  ): Promise<ActiveWaveGateAbandonmentResult> {
    return this.updateAndReturn<ActiveWaveGateAbandonmentResult>((state) => {
      const active = state.active_wave_gate;
      if (active === undefined) {
        return { state, value: Object.freeze({ kind: "not-targeted" as const, reason: "registration-absent" as const }) };
      }
      if (active.runsRoot !== abandonment.runsRoot || active.runId !== abandonment.runId) {
        return { state, value: Object.freeze({ kind: "not-targeted" as const, reason: "authority-mismatch" as const }) };
      }
      if (active.terminalOutcome !== null) {
        if (active.terminalOutcome.kind === "terminal-abandoned" &&
            active.terminalOutcome.reason === abandonment.reason &&
            active.terminalOutcome.supersededBy === abandonment.supersededBy) {
          const registration: AbandonedWaveGateRegistration = Object.freeze({
            ...active,
            terminalOutcome: active.terminalOutcome,
          });
          return { state, value: Object.freeze({ kind: "replayed" as const, registration }) };
        }
        return { state, value: Object.freeze({ kind: "not-targeted" as const, reason: "terminal-conflict" as const }) };
      }
      const outcome = parseActiveWaveGateTerminalOutcome(
        { kind: "terminal-abandoned", reason: abandonment.reason, supersededBy: abandonment.supersededBy },
        active.runId,
      );
      if (!outcome.ok || outcome.value?.kind !== "terminal-abandoned") {
        throw new Error(`Invalid Wave Gate abandonment stamp: ${outcome.ok ? "unexpected outcome" : outcome.error}`);
      }
      const stamped = Object.freeze({ ...active, terminalOutcome: outcome.value });
      return {
        // Terminalizing the gate retires its correlated live-suite authority in
        // the same locked transition. Retaining it would make the produced
        // graph unparseable: live suites require a nonterminal active gate.
        state: { ...state, active_wave_gate: stamped, active_wave_completion_suite: undefined },
        value: Object.freeze({ kind: "stamped" as const, registration: stamped }),
      };
    });
  }

  /** Explicit anti-corruption migration for a historical graph that predates
   * active registrations. No run id, Wave, or digest is invented implicitly. */
  async migrateLegacyWaveGateRegistration(raw: unknown): Promise<ActiveWaveGateRegistration> {
    const parsed = parseLegacyWaveGateMigrationAuthority(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    const { registration, compatibility } = parsed.value;
    return this.updateAndReturn((state) => {
      const terminalReplay = findLegacyWaveGateCompletionReplay(state, compatibility);
      if (!terminalReplay.ok) throw new Error(terminalReplay.error.message);
      if (terminalReplay.value !== null) {
        throw new Error(`Legacy Wave ${registration.wave} is already completed by run ${terminalReplay.value.runId}`);
      }
      const existing = state.active_wave_gate;
      if (existing !== undefined) {
        const exactReplay = existing.runId === registration.runId &&
          existing.wave === registration.wave &&
          existing.authorityDigest === registration.authorityDigest &&
          existing.revision === 0 && existing.terminalOutcome === null;
        if (exactReplay) return { state, value: existing };
        throw new Error("Legacy migration is allowed only when active Wave Gate authority is absent");
      }
      if (state.current_phase !== "execute" || state.current_wave !== registration.wave) {
        throw new Error("Legacy migration must exactly match protected execute/current_wave authority");
      }
      if (state.tasks.every((task) => task.wave !== registration.wave)) {
        throw new Error(`Legacy migration wave ${registration.wave} has no protected Tasks`);
      }
      return { state: { ...state, active_wave_gate: registration }, value: registration };
    });
  }

  /** Lock, re-derive completion through the caller's pure domain function,
   * persist terminal history + advancement together, and return its receipt. */
  async commitActiveWaveGateCompletion(
    derive: (lockedState: TaskGraph) => DomainResult<WaveCompletionCommit, WaveCompletionCommitError>,
  ): Promise<WaveCompletionCommit> {
    return this.updateAndReturn((state) => {
      const active = state.active_wave_gate;
      if (state.current_phase !== "execute" || state.current_wave === undefined || active === undefined) {
        throw new Error("Protected execute/current Wave Gate authority is missing");
      }
      if (active.wave !== state.current_wave || active.terminalOutcome !== null) {
        throw new Error("Protected active/current Wave Gate authority is contradictory or terminal");
      }
      const committed = derive(state);
      if (!committed.ok) throw new Error(committed.error.message);
      const terminal = committed.value.completedRegistration;
      if (
        terminal.runId !== active.runId || terminal.wave !== active.wave ||
        terminal.authorityDigest !== active.authorityDigest || terminal.revision !== active.revision + 1 ||
        committed.value.receipt !== terminal.completionReceipt
      ) {
        throw new Error("Completion result does not terminalize the exact locked active registration");
      }
      const activeSuite = state.active_wave_completion_suite;
      const suiteArchivedExactly = activeSuite === undefined
        ? terminal.schemaVersion === 1
        : terminal.schemaVersion === 2 && terminal.completionSuite === activeSuite;
      if (!suiteArchivedExactly) {
        throw new Error("Completion must archive the exact active Wave completion suite using the matching history schema");
      }
      if (committed.value.graph.active_wave_gate !== undefined ||
          committed.value.graph.active_wave_completion_suite !== undefined) {
        throw new Error("Completion must retire active gate and completion-suite authority before the next Wave can register");
      }
      return { state: committed.value.graph, value: committed.value };
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
    assertPiCliMutationCompatible(process.env, captureLoomRuntimeIdentity(PACKAGE_ROOT));
    const directory = this.openAuthorityDirectory();
    return withStateDirectoryAsync(directory, `TaskGraph atomic write of ${this.path}`, () =>
      withAnchoredDirectoryHandleLock(directory, ".task_graph", () => {
        const produced = produce(directory);
        if (produced.persist === false) return produced.value;
        const parsed = parseTaskGraph(produced.state);
        if (!parsed.ok) throw new Error(`Refusing to persist invalid task graph (${parsed.error}): ${this.path}`);
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

/** @deprecated Legacy wave-gate compatibility migration — archived in
 *  ./core/legacy-archive (Section C). New completions use the registered
 *  Wave Gate authority (active_wave_gate); this type + derive path survive
 *  only for graphs that predate registration. Deprecation horizon: retire
 *  once no pre-registration graph can still be completed. */
export {
  deriveLegacyWaveGateCompatibilityAuthority,
  findLegacyWaveGateCompletionReplay,
};
export type {
  LegacyWaveGateCompatibilityAuthority,
  LegacyWaveGateCompletionReplayError,
};
