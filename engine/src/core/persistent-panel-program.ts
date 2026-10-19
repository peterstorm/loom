/**
 * The persistent panel program kernel: the durable half of the panel kernel
 * every persistent (schema v2) panel program instantiates.
 *
 * A program is a `PanelProgramDefinition` — its start, its next action, its
 * strict durable event parser, its unguarded stage transition, its
 * authority codec, and the canonical form of its state's JSON. Everything
 * else is stated once here:
 *
 *   - the reducer guard (`reducePanelProgram`): only a proved, non-terminal
 *     state and a strictly parsed durable event reach a transition, and a
 *     thrown invariant violation fails closed while KEEPING its message;
 *   - replay-equals-state (`replayPanelProgram`): one strict parse-and-reduce
 *     of an event prefix from the program's start;
 *   - the checkpoint record (`panelProgramCheckpoint`,
 *     `parsePanelProgramCheckpoint`), whose event prefix must replay to its
 *     recorded state — the form a panel persists in (ADR-0029);
 *   - submission recording (`reduceParsedPanelEvent`) and `resumePanelProgram`.
 *
 * Membership is proved, never asserted: each program carries a
 * `PanelProofs` domain (`createPanelProofs`), and a state, event or recorded
 * step the kernel accepts must have been minted in THAT domain by the
 * program's own start, parse, reduction, replay or checkpoint parse. A
 * domain is private to the module that creates it, so another module's
 * values can never pass as its own. `core/persistent-panel` instantiates the
 * refutation program over its private domain; the kernel's own tests drive a
 * trivial second program with none of the panel's semantics.
 *
 * Durable bytes are the programs' own: every checkpoint is built with the key
 * order its persisted form has always had, because checkpoint
 * parsing compares the recorded state with the replayed one as JSON text —
 * each first taken to the program's `canonicalStateJson`, so the kernel itself
 * knows no field of any program's state.
 *
 * Pure module: no I/O, no clock, no randomness.
 */
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

export type PanelProofTag = `${PanelKind}:${"state" | "event" | "recorded-step"}`;

/** One membership domain: which values a module minted, tagged with panel and
 *  role so a state can never pass as an event or a recorded step. */
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
 * Structural equality of two values as JSON text: a deterministic aggregate
 * against its persisted form, two authority projections, or two canonical
 * states. Nothing is filtered — a value that carries a derived view is
 * compared through its owner's canonical projection first (`statesAgree`
 * below does exactly that for program states). A value JSON cannot encode (a
 * cycle, a BigInt, a throwing accessor) equals nothing.
 */
export function jsonEqual(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
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
 * transition, authority codec, and the canonical form of its state's JSON.
 * Everything else — the reducer guard, replay-equals-state, the recorded-step
 * proof and the checkpoint record — is the kernel's, once.
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
  /** The authority codec's parse: UNTRUSTED input — a durable checkpoint's
   *  `authority` field arrives here as read back from disk, so the codec owns
   *  the whole parse and assumes no shape. */
  parseAuthority: (raw: unknown) => PersistentPanelResult<Authority>;
  /** The authority codec's durable form, which `parseAuthority` reads back. */
  authorityJson: (authority: Authority) => AuthorityInput;
  /** The canonical form of a state — a recorded checkpoint state read back
   *  from disk (JSON data) or a live replayed state alike — with every view
   *  the state DERIVES from its own content omitted, ready to serialize. The
   *  kernel compares states only through it, so which fields are derived is
   *  the program's knowledge (and its roster's), never the kernel's. */
  canonicalStateJson: (state: unknown) => unknown;
}>;

/**
 * Do a recorded and a replayed state agree? Both are taken to the program's
 * canonical form and compared as JSON text: the comparison is of durable
 * content only, independent of how any derived view happens to serialize.
 */
function statesAgree<P extends PanelKind, A extends PanelAuthority, I, S extends PanelState<A>, Ac, E>(
  program: PanelProgramDefinition<P, A, I, S, Ac, E>,
  recorded: unknown,
  replayed: S,
): boolean {
  return jsonEqual(program.canonicalStateJson(recorded), program.canonicalStateJson(replayed));
}

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
// Replay
// ---------------------------------------------------------------------------

type ReplayedPrefix<S, Ac, E> = Readonly<{ step: PanelStep<S, Ac, E>; events: readonly E[] }>;

/** Strictly parse and reduce an event prefix from the program's start: the ONE replay every resume and checkpoint trusts. */
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
  if (!statesAgree(program, state, replayed.value.step.state)) return persistentFailure(panelError(panel, "malformed-checkpoint", `${panel} checkpoint event prefix does not replay to the supplied state`));
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
  const authority = program.parseAuthority(checkpoint.authority);
  if (!authority.ok) return authority;
  const replayed = replayPrefix(program, authority.value, checkpoint.events, resolver);
  if (!replayed.ok) return replayed;
  if (!statesAgree(program, checkpoint.state, replayed.value.step.state)) return persistentFailure(panelError(panel, "malformed-checkpoint", `${panel} checkpoint state disagrees with its immutable event prefix`));
  return persistentSuccess(replayed.value.step);
}
