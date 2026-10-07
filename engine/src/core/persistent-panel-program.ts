/**
 * The persistent panel program kernel: the durable half of the panel kernel
 * every persistent (schema v2) panel program instantiates.
 *
 * A program is a `PanelProgramDefinition` — its start, its next action, its
 * strict durable event parser, its unguarded stage transition, and its
 * authority codec. Everything else is stated once here:
 *
 *   - the reducer guard (`reducePanelProgram`): only a proved, non-terminal
 *     state and a strictly parsed durable event reach a transition, and a
 *     thrown invariant violation fails closed while KEEPING its message;
 *   - replay-equals-state (`replayPanelProgram`, `parsePanelProgramHistory`):
 *     one strict parse-and-reduce of an event prefix from the program's start;
 *   - the checkpoint record (`panelProgramCheckpoint`,
 *     `parsePanelProgramCheckpoint`) and the journal/checkpoint persistence
 *     plan with its dedup key (`planPanelProgramPersistence`);
 *   - submission recording (`reduceParsedPanelEvent`) and `resumePanelProgram`.
 *
 * Membership is proved, never asserted: each program carries a
 * `PanelProofs` domain (`createPanelProofs`), and a state, event, recorded
 * step or history the kernel accepts must have been minted in THAT domain by
 * the program's own start, parse, reduction, replay or checkpoint parse. A
 * domain is private to the module that creates it, so another module's
 * values can never pass as its own. `core/persistent-panel` instantiates the
 * architecture and refutation programs over one private domain; the kernel's
 * own tests drive a trivial third program with none of either panel.
 *
 * Durable bytes are the programs' own: every checkpoint and effect is built
 * with the key order its persisted form has always had, because checkpoint
 * parsing compares the recorded state with the replayed one as JSON text.
 *
 * Pure module: no I/O, no clock, no randomness.
 */
import { sha256Hex } from "./digest";
import { safeArray, safeRecord } from "./exact-data";
import {
  panelError,
  persistentFailure,
  persistentSuccess,
  type PersistentPanelError,
  type PersistentPanelResult,
} from "./panel-authority";
import type { OrchestrationRunId, PublicationAuthorityResolver } from "./orchestration-contract";

/** The panels a persistent program can report as: the durable error's closed panel vocabulary. */
export type PanelKind = PersistentPanelError["panel"];

// ---------------------------------------------------------------------------
// Membership proofs
// ---------------------------------------------------------------------------

export type PanelProofTag = `${PanelKind}:${"state" | "event" | "recorded-step" | "history"}`;

/** One membership domain: which values a module minted, tagged with panel and
 *  role so a refutation state can never pass as an architecture one. */
export type PanelProofs = Readonly<{
  prove: <T extends object>(tag: PanelProofTag, value: T) => T;
  proven: (tag: PanelProofTag, value: unknown) => boolean;
}>;

/** A fresh membership domain. Keep it module-private: whoever holds it can mint. */
export function createPanelProofs(): PanelProofs {
  const minted = new WeakMap<object, PanelProofTag>();
  return Object.freeze({
    prove: <T extends object>(tag: PanelProofTag, value: T): T => {
      minted.set(value, tag);
      return value;
    },
    proven: (tag: PanelProofTag, value: unknown): boolean =>
      typeof value === "object" && value !== null && minted.get(value) === tag,
  });
}

// ---------------------------------------------------------------------------
// Structural equality
// ---------------------------------------------------------------------------

/**
 * The roster's DERIVED lookup views. `ExactRoster.byId` and `CompleteRoster.bySlot`
 * are built by the roster parser from `orderedSlots`/`ordered` and by nothing
 * else, so they carry no information a comparison of those arrays does not
 * already have.
 */
const DERIVED_ROSTER_VIEWS: ReadonlySet<string> = new Set(["byId", "bySlot"]);

/**
 * Structural equality for any two panel values compared by content: a durable
 * checkpoint's state, a replayed event prefix, a deterministic aggregate, and a
 * panel authority projection all come through here.
 *
 * The derived roster views are dropped from BOTH sides, because including them
 * made the comparison depend on how a `Map` happens to serialize — and it did,
 * silently and wrongly. A checkpoint written before the roster view became a
 * real `Map` holds the literal text `"byId":{"size":3}`: `JSON.stringify` had
 * dropped every function-valued key of the old fake-`ReadonlyMap` record and
 * left only its size, so this check was proving that two rosters had the same
 * NUMBER of slots and nothing whatsoever about which slots they were.
 *
 * Dropping the derived keys compares the arrays they are projected from, which
 * is strictly stronger, and makes the check independent of any serialization
 * choice for `Map` — including the correct one.
 */
export function jsonEqual(left: unknown, right: unknown): boolean {
  const withoutDerivedViews = (value: unknown): string | undefined =>
    JSON.stringify(value, (key, entry: unknown) => (DERIVED_ROSTER_VIEWS.has(key) ? undefined : entry));
  try { return withoutDerivedViews(left) === withoutDerivedViews(right); } catch { return false; }
}

// ---------------------------------------------------------------------------
// The program definition
// ---------------------------------------------------------------------------

/** One program step: the next state, its action, and the durable event a submission recorded. */
export type PanelStep<State, Action, Event> = Readonly<{ state: State; action: Action | null; recordedEvent?: Event }>;

/** What the kernel needs of a panel authority and state: the run, the state's
 *  authority, and its stage (`done` and `terminal-blocked` admit no transition). */
export type PanelAuthority = Readonly<{ runId: OrchestrationRunId }>;
export type PanelState<Authority> = Readonly<{ authority: Authority; stage: string }>;

/**
 * What one panel contributes to the program kernel: its membership domain,
 * start, next action, strict durable event parser, unguarded stage
 * transition, and authority codec. Everything else — the reducer guard,
 * replay-equals-state, the recorded-step and history proofs, the checkpoint
 * record, the persistence plan and its dedup key — is the kernel's, once.
 */
export type PanelProgramDefinition<P extends PanelKind, Authority extends PanelAuthority, AuthorityInput,
  State extends PanelState<Authority>, Action, Event> = Readonly<{
  panel: P;
  proofs: PanelProofs;
  start: (authority: Authority) => PanelStep<State, Action, Event>;
  action: (state: State) => Action | null;
  parseEvent: (state: State, raw: unknown, resolver: PublicationAuthorityResolver) => PersistentPanelResult<Event>;
  /** The stage transition over an already-guarded state and event. */
  transition: (state: State, event: Event) => PersistentPanelResult<PanelStep<State, Action, Event>>;
  parseAuthority: (raw: AuthorityInput) => PersistentPanelResult<Authority>;
  authorityJson: (authority: Authority) => AuthorityInput;
}>;

/**
 * The reducer prelude and its fail-closed boundary: only a proved,
 * non-terminal state and a strictly parsed durable event reach the program's
 * transition. The catch KEEPS the thrown message: a transition's roster
 * invariant throws a specific violation naming the slot and attempt, and
 * collapsing that into the malformed-event sentence would make a code
 * regression indistinguishable from bad input — exactly as `panel-kernel`'s
 * analogous catch already keeps it.
 */
export function reducePanelProgram<P extends PanelKind, A extends PanelAuthority, I, S extends PanelState<A>, Ac, E>(
  program: PanelProgramDefinition<P, A, I, S, Ac, E>,
  state: S,
  event: E,
): PersistentPanelResult<PanelStep<S, Ac, E>> {
  const { panel, proofs } = program;
  try {
    if (!proofs.proven(`${panel}:state`, state)) return persistentFailure(panelError(panel, "malformed-checkpoint", `${panel} reducer requires a parser-produced state`));
    if (state.stage === "done" || state.stage === "terminal-blocked") return persistentFailure(panelError(panel, "terminal-state", `${panel} panel is ${state.stage} and cannot transition`));
    if (!proofs.proven(`${panel}:event`, event)) return persistentFailure(panelError(panel, "malformed-event", `${panel} reducer requires a strictly parsed durable event`));
    return program.transition(state, event);
  } catch (error) {
    return persistentFailure(panelError(
      panel,
      "malformed-event",
      `${panel} event could not be safely reduced: ${error instanceof Error ? error.message : String(error)}`,
    ));
  }
}

/** A proved state's step: its own next action. */
export function resumePanelProgram<P extends PanelKind, A extends PanelAuthority, I, S extends PanelState<A>, Ac, E>(
  program: PanelProgramDefinition<P, A, I, S, Ac, E>,
  state: S,
): PersistentPanelResult<PanelStep<S, Ac, E>> {
  return program.proofs.proven(`${program.panel}:state`, state)
    ? persistentSuccess(Object.freeze({ state, action: program.action(state) }))
    : persistentFailure(panelError(program.panel, "malformed-checkpoint", `${program.panel} state must come from start, reduction, replay, or checkpoint parsing`));
}

/** Parse a submitted event over `state`, reduce it, and prove the recorded step. */
export function reduceParsedPanelEvent<P extends PanelKind, A extends PanelAuthority, I, S extends PanelState<A>, Ac, E extends object>(
  program: PanelProgramDefinition<P, A, I, S, Ac, E>,
  state: S,
  rawEvent: E,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<PanelStep<S, Ac, E>> {
  const parsed = program.parseEvent(state, rawEvent, resolver);
  if (!parsed.ok) return parsed;
  const reduced = reducePanelProgram(program, state, parsed.value);
  return reduced.ok
    ? persistentSuccess(program.proofs.prove(`${program.panel}:recorded-step`, Object.freeze({ ...reduced.value, recordedEvent: parsed.value })))
    : reduced;
}

// ---------------------------------------------------------------------------
// Replay and histories
// ---------------------------------------------------------------------------

type ReplayedPrefix<S, Ac, E> = Readonly<{ step: PanelStep<S, Ac, E>; events: readonly E[] }>;

/** Strictly parse and reduce an event prefix from the program's start: the ONE replay every checkpoint, history and persistence plan trusts. */
function replayPrefix<P extends PanelKind, A extends PanelAuthority, I, S extends PanelState<A>, Ac, E>(
  program: PanelProgramDefinition<P, A, I, S, Ac, E>,
  authority: A,
  rawEvents: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<ReplayedPrefix<S, Ac, E>> {
  const events = safeArray(rawEvents);
  if (events === null) return persistentFailure(panelError(program.panel, "malformed-event", `${program.panel} history must be a dense JSON event array`));
  const parsedEvents: E[] = [];
  let step = program.start(authority);
  for (const raw of events) {
    const parsed = program.parseEvent(step.state, raw, resolver);
    if (!parsed.ok) return parsed;
    const reduced = reducePanelProgram(program, step.state, parsed.value);
    if (!reduced.ok) return reduced;
    parsedEvents.push(parsed.value);
    step = reduced.value;
  }
  return persistentSuccess(Object.freeze({ step, events: Object.freeze(parsedEvents) }));
}

/** The step an event prefix replays to from the program's start. */
export function replayPanelProgram<P extends PanelKind, A extends PanelAuthority, I, S extends PanelState<A>, Ac, E>(
  program: PanelProgramDefinition<P, A, I, S, Ac, E>,
  authority: A,
  rawEvents: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<PanelStep<S, Ac, E>> {
  const replayed = replayPrefix(program, authority, rawEvents, resolver);
  return replayed.ok ? persistentSuccess(replayed.value.step) : replayed;
}

export type PanelHistory<P extends PanelKind, A, E> = Readonly<{ panel: P; authority: A; events: readonly E[] }>;

/** Parse and replay an immutable event prefix into a proved history: the persistence authority. */
export function parsePanelProgramHistory<P extends PanelKind, A extends PanelAuthority, I, S extends PanelState<A>, Ac, E>(
  program: PanelProgramDefinition<P, A, I, S, Ac, E>,
  authority: A,
  rawEvents: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<PanelHistory<P, A, E>> {
  const replayed = replayPrefix(program, authority, rawEvents, resolver);
  if (!replayed.ok) return replayed;
  return persistentSuccess(program.proofs.prove(`${program.panel}:history`, Object.freeze({
    panel: program.panel,
    authority,
    events: replayed.value.events,
  })));
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

export type PanelCheckpoint<P extends PanelKind, I, E> = Readonly<{ schemaVersion: 2; kind: `${P}-panel-checkpoint`; authority: I; events: readonly E[]; state: unknown }>;

/** The durable checkpoint of a proved state: its event prefix must replay exactly to it. */
export function panelProgramCheckpoint<P extends PanelKind, A extends PanelAuthority, I, S extends PanelState<A>, Ac, E>(
  program: PanelProgramDefinition<P, A, I, S, Ac, E>,
  state: S,
  events: readonly E[],
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<PanelCheckpoint<P, I, E>> {
  const { panel } = program;
  if (!program.proofs.proven(`${panel}:state`, state)) return persistentFailure(panelError(panel, "malformed-checkpoint", `checkpoint requires parser-produced ${panel} state`));
  const authority = state.authority;
  const replayed = replayPrefix(program, authority, events, resolver);
  if (!replayed.ok) return replayed;
  if (!jsonEqual(replayed.value.step.state, state)) return persistentFailure(panelError(panel, "malformed-checkpoint", `${panel} checkpoint event prefix does not replay to the supplied state`));
  const replayedState = JSON.parse(JSON.stringify(replayed.value.step.state)) as unknown;
  return persistentSuccess(Object.freeze({
    schemaVersion: 2 as const,
    kind: `${panel}-panel-checkpoint` as const,
    authority: program.authorityJson(authority),
    events: replayed.value.events,
    state: replayedState,
  }));
}

/** Parse a durable checkpoint: its authority, then its event prefix replayed to exactly its recorded state. */
export function parsePanelProgramCheckpoint<P extends PanelKind, A extends PanelAuthority, I, S extends PanelState<A>, Ac, E>(
  program: PanelProgramDefinition<P, A, I, S, Ac, E>,
  raw: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<PanelStep<S, Ac, E>> {
  const { panel } = program;
  const checkpoint = safeRecord(raw, ["schemaVersion", "kind", "authority", "events", "state"]);
  if (checkpoint === null || checkpoint.schemaVersion !== 2 || checkpoint.kind !== `${panel}-panel-checkpoint`) return persistentFailure(panelError(panel, "malformed-checkpoint", `${panel} checkpoint must be an exact schemaVersion 2 record`));
  const authority = program.parseAuthority(checkpoint.authority as I);
  if (!authority.ok) return authority;
  const replayed = replayPrefix(program, authority.value, checkpoint.events, resolver);
  if (!replayed.ok) return replayed;
  if (!jsonEqual(checkpoint.state, replayed.value.step.state)) return persistentFailure(panelError(panel, "malformed-checkpoint", `${panel} checkpoint state disagrees with its immutable event prefix`));
  return persistentSuccess(replayed.value.step);
}

// ---------------------------------------------------------------------------
// Persistence plans
// ---------------------------------------------------------------------------

export type PanelPersistenceEffect<P extends PanelKind, I, E> =
  | Readonly<{ schemaVersion: 1; kind: `append-${P}-panel-event`; runId: OrchestrationRunId; sequence: number; dedupKey: string; event: E }>
  | Readonly<{ schemaVersion: 1; kind: `replace-${P}-panel-checkpoint`; runId: OrchestrationRunId; sequence: number; dedupKey: string; checkpoint: PanelCheckpoint<P, I, E> }>;

function persistenceKey(runId: OrchestrationRunId, sequence: number, payload: unknown): string {
  return `${runId}:${sequence}:${sha256Hex(JSON.stringify(payload))}`;
}

/**
 * The journal append and checkpoint replacement of one recorded step: the
 * step must be a proved recorded step over a proved history of the same panel
 * authority, and the history plus the step's event must replay exactly to the
 * step's state before either effect is planned.
 */
export function planPanelProgramPersistence<P extends PanelKind, A extends PanelAuthority, I, S extends PanelState<A>, Ac, E>(
  program: PanelProgramDefinition<P, A, I, S, Ac, E>,
  step: PanelStep<S, Ac, E>,
  history: PanelHistory<P, A, E>,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<readonly [PanelPersistenceEffect<P, I, E>, PanelPersistenceEffect<P, I, E>]> {
  const { panel, proofs } = program;
  const event = step.recordedEvent;
  if (event === undefined || !proofs.proven(`${panel}:recorded-step`, step) ||
      !proofs.proven(`${panel}:state`, step.state) || !proofs.proven(`${panel}:event`, event)) {
    return persistentFailure(panelError(panel, "malformed-event", `persistence planning requires a parser/reducer-produced ${panel} step and event`));
  }
  const authority = step.state.authority;
  if (!proofs.proven(`${panel}:history`, history) || history.panel !== panel ||
      !jsonEqual(program.authorityJson(history.authority), program.authorityJson(authority))) {
    return persistentFailure(panelError(panel, "malformed-history", `persistence planning requires a replay-proved ${panel} history for the same panel authority`));
  }
  const events = Object.freeze([...history.events, event]);
  const replayed = replayPrefix(program, authority, events, resolver);
  if (!replayed.ok) return replayed;
  if (!jsonEqual(replayed.value.step.state, step.state)) {
    return persistentFailure(panelError(panel, "malformed-checkpoint", `${panel} event prefix does not replay exactly to the proposed checkpoint state`));
  }
  const checkpoint = panelProgramCheckpoint(program, replayed.value.step.state, replayed.value.events, resolver);
  if (!checkpoint.ok) return checkpoint;
  const { runId } = authority;
  const sequence = events.length;
  const append = Object.freeze({ schemaVersion: 1 as const, kind: `append-${panel}-panel-event` as const, runId, sequence, dedupKey: persistenceKey(runId, sequence, event), event });
  const replace = Object.freeze({ schemaVersion: 1 as const, kind: `replace-${panel}-panel-checkpoint` as const, runId, sequence, dedupKey: persistenceKey(runId, sequence, checkpoint.value), checkpoint: checkpoint.value });
  return persistentSuccess(Object.freeze([append, replace]) as readonly [PanelPersistenceEffect<P, I, E>, PanelPersistenceEffect<P, I, E>]);
}
