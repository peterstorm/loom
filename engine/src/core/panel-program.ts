/**
 * The architecture panel's dispatch program: the reducer that orders the
 * candidate and judge fan-outs, engine operations and finalization over plain spawn
 * outcomes, and the reader of the journal `/loom --panel` keeps
 * (its run's panel-program.json). `helper panel-program architecture` replays that
 * journal through the reducer and prints the next action (ADR-0096).
 *
 * The Refutation Panel does not run here: its program is `persistent-panel`,
 * inside the Wave Gate and standalone review.
 *
 * Pure module: no I/O, no clock, no randomness.
 */
import { PANEL_LENSES, architectureCriterion, type ArchitectureCriterion, type PanelLens } from "./panel-contract";
import type { LlmProfileId } from "./model-profiles";
import { fail, isRecord, ok, type ParseResult } from "./panel-kernel";
import { parseErr, parseOk, type LineParseResult } from "./parse-result";
import type { NonEmpty } from "./orchestration-contract";

const mapNonEmpty = <Input, Output>(
  values: NonEmpty<Input>,
  transform: (value: Input, index: number) => Output,
): NonEmpty<Output> => {
  const [first, ...rest] = values;
  return [transform(first, 0), ...rest.map((value, index) => transform(value, index + 1))];
};

/**
 * Semantic profiles used by the panel program. Harness-specific model targets
 * are deliberately outside this pure module.
 */
export const PANEL_PROGRAM_MODEL_PROFILES = Object.freeze({
  architecture: "panel-design",
  architectureFinalization: "architecture-finalize",
  design: "panel-design",
  judging: "panel-judge",
} as const satisfies Readonly<Record<string, LlmProfileId>>);

export type PanelProgramModelProfileId =
  (typeof PANEL_PROGRAM_MODEL_PROFILES)[keyof typeof PANEL_PROGRAM_MODEL_PROFILES];

interface SpawnRequestFields {
  readonly id: string;
  readonly agent: string;
  readonly modelProfile: PanelProgramModelProfileId;
  readonly attempt: 1 | 2;
  readonly outputContract: string;
}

export type InteractiveSpawnRequest = Readonly<SpawnRequestFields & {
  readonly interaction: "interactive";
}>;

export type HeadlessSpawnRequest = Readonly<SpawnRequestFields & {
  readonly interaction: "headless";
}>;

/**
 * The shared dispatch ADT. Interaction is discriminating so an interactive
 * request cannot be placed in a parallel batch at compile time.
 */
export type SpawnRequest = InteractiveSpawnRequest | HeadlessSpawnRequest;

/** The architecture panel's engine operations: the vocabulary the type and the journal parser share. */
const ARCHITECTURE_OPERATIONS = Object.freeze([
  "architecture-prepare-candidates",
  "architecture-prepare-judges",
  "architecture-aggregate",
] as const);

export type ArchitectureEngineOperation = (typeof ARCHITECTURE_OPERATIONS)[number];

export type EngineOperationAction = Readonly<{
  type: "engine-operation";
  id: ArchitectureEngineOperation;
  operation: ArchitectureEngineOperation;
  outputContract: string;
}>;

/** Parallel batches are non-empty and can contain only headless requests. */
export type SpawnBatchAction = Readonly<{
  type: "spawn-batch";
  execution: "parallel";
  requests: NonEmpty<HeadlessSpawnRequest>;
}>;

/** Interactive work is represented separately and can never enter a batch. */
export type AwaitUserAction = Readonly<{
  type: "await-user";
  request: InteractiveSpawnRequest;
}>;

export type DoneAction = Readonly<{ type: "done"; panel: "architecture"; outcome: "completed" }>;

export type BlockedAction = Readonly<{
  type: "blocked";
  panel: "architecture";
  stage: string;
  reason: string;
}>;

export type PanelProgramAction =
  | EngineOperationAction
  | SpawnBatchAction
  | AwaitUserAction
  | DoneAction
  | BlockedAction;

export type SpawnOutcomeEvent = Readonly<{
  type: "spawn-outcome";
  requestId: string;
  attempt: 1 | 2;
  outcome: "succeeded" | "failed";
  error?: string;
}>;

export type EngineOutcomeEvent = Readonly<{
  type: "engine-outcome";
  operationId: ArchitectureEngineOperation;
  outcome: "succeeded" | "failed";
  error?: string;
}>;

export type PanelProgramError =
  | Readonly<{ kind: "unknown-outcome"; requestId: string }>
  | Readonly<{ kind: "duplicate-outcome"; requestId: string }>
  | Readonly<{
      kind: "stale-attempt-outcome";
      requestId: string;
      expectedAttempt: 1 | 2;
      receivedAttempt: 1 | 2;
    }>
  | Readonly<{ kind: "unknown-operation-outcome"; operationId: ArchitectureEngineOperation }>
  | Readonly<{ kind: "duplicate-operation-outcome"; operationId: ArchitectureEngineOperation }>
  | Readonly<{ kind: "unexpected-event"; panel: "architecture"; stage: string }>;

export type ProgramResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: PanelProgramError }>;

const success = <T>(value: T): ProgramResult<T> => ({ ok: true, value });
const reject = <T>(error: PanelProgramError): ProgramResult<T> => ({ ok: false, error });

/** The dispatch input: lenses and criteria already parsed into their closed vocabularies. */
export interface ArchitectureProgramInput {
  readonly candidateLenses: readonly PanelLens[];
  readonly judgeCriteria: readonly ArchitectureCriterion[];
}

interface ArchitectureStateBase {
  readonly panel: "architecture";
  readonly input: Readonly<{
    candidateLenses: NonEmpty<PanelLens>;
    judgeCriteria: NonEmpty<ArchitectureCriterion>;
  }>;
  readonly completedRequestIds: readonly string[];
  readonly completedOperationIds: readonly ArchitectureEngineOperation[];
}

interface PendingSlot<Request extends SpawnRequest> {
  readonly request: Request;
  readonly status: "pending" | "succeeded";
}

type HeadlessSlot = PendingSlot<HeadlessSpawnRequest>;
type InteractiveSlot = PendingSlot<InteractiveSpawnRequest>;

export type ArchitectureProgramState =
  | Readonly<ArchitectureStateBase & { stage: "candidates"; slots: NonEmpty<HeadlessSlot> }>
  | Readonly<ArchitectureStateBase & {
      stage: "prepare-judges";
      operation: "architecture-prepare-judges";
    }>
  | Readonly<ArchitectureStateBase & { stage: "judges"; slots: NonEmpty<HeadlessSlot> }>
  | Readonly<ArchitectureStateBase & {
      stage: "aggregate";
      operation: "architecture-aggregate";
    }>
  | Readonly<ArchitectureStateBase & { stage: "finalize"; slot: InteractiveSlot }>
  | Readonly<ArchitectureStateBase & { stage: "complete" }>
  | Readonly<ArchitectureStateBase & { stage: "blocked"; reason: string }>;

export type ArchitectureProgramEvent =
  | SpawnOutcomeEvent
  | EngineOutcomeEvent;

export type ProgramStep<State> = Readonly<{
  state: State;
  /** Null means the program is still waiting for other slots in this batch. */
  action: PanelProgramAction | null;
}>;

const headlessRequest = (
  id: string,
  agent: string,
  modelProfile: PanelProgramModelProfileId,
  attempt: 1 | 2,
  outputContract: string,
): HeadlessSpawnRequest => ({
  id,
  agent,
  interaction: "headless",
  modelProfile,
  attempt,
  outputContract,
});

const finalizerRequest = (attempt: 1 | 2): InteractiveSpawnRequest => ({
  id: "architecture:finalize",
  agent: "architecture-agent",
  interaction: "interactive",
  modelProfile: PANEL_PROGRAM_MODEL_PROFILES.architectureFinalization,
  attempt,
  outputContract: "selected architecture plan with panel decision record",
});

const candidateRequests = (lenses: NonEmpty<PanelLens>, attempt: 1 | 2 = 1): NonEmpty<HeadlessSpawnRequest> =>
  mapNonEmpty(lenses, (lens, index) => headlessRequest(
    `architecture:candidate:${index + 1}`,
    "arch-designer-agent",
    PANEL_PROGRAM_MODEL_PROFILES.design,
    attempt,
    `non-empty architecture candidate for design lens ${lens}`,
  ));

const judgeRequests = (criteria: NonEmpty<ArchitectureCriterion>, attempt: 1 | 2 = 1): NonEmpty<HeadlessSpawnRequest> =>
  mapNonEmpty(criteria, (criterion, index) => headlessRequest(
    `architecture:judge:${index + 1}`,
    "arch-judge-agent",
    PANEL_PROGRAM_MODEL_PROFILES.judging,
    attempt,
    `canonical judge verdict for criterion ${JSON.stringify(criterion)} covering every candidate exactly once`,
  ));

const batch = (requests: NonEmpty<HeadlessSpawnRequest>): SpawnBatchAction => ({
  type: "spawn-batch",
  execution: "parallel",
  requests,
});

const pendingSlots = <Request extends SpawnRequest>(
  requests: NonEmpty<Request>,
): NonEmpty<PendingSlot<Request>> => {
  const [first, ...rest] = requests;
  return [
    { request: first, status: "pending" },
    ...rest.map((request) => ({ request, status: "pending" as const })),
  ];
};

const awaitUser = (request: InteractiveSpawnRequest): AwaitUserAction => ({
  type: "await-user",
  request,
});

const operation = (
  id: ArchitectureEngineOperation,
  outputContract: string,
): EngineOperationAction => ({ type: "engine-operation", id, operation: id, outputContract });

function distinctNonEmpty<T extends string>(
  values: readonly T[],
  label: string,
): ParseResult<NonEmpty<T>> {
  const errors: string[] = [];
  if (values.length === 0) errors.push(`${label} must be non-empty`);
  if (new Set(values).size !== values.length) errors.push(`${label} must be distinct`);
  if (errors.length > 0) return fail(errors);
  const copy = [...values];
  const first = copy[0];
  return first === undefined ? fail([`${label} failed its internal non-empty check`]) : ok([first, ...copy.slice(1)]);
}

/**
 * Parse the dispatch configuration: distinct and non-empty lenses and criteria.
 * Vocabulary membership is already in the input's types: the journal parser
 * (`parseArchitecturePanelJournal`) is where untrusted lenses and criteria
 * become a `PanelLens` and an `ArchitectureCriterion`.
 */
function parseArchitectureProgramInput(input: ArchitectureProgramInput): ParseResult<ArchitectureStateBase["input"]> {
  const lenses = distinctNonEmpty(input.candidateLenses, "candidate lenses");
  const criteria = distinctNonEmpty(input.judgeCriteria, "judge criteria");
  if (!lenses.ok || !criteria.ok) {
    return fail([...(lenses.ok ? [] : lenses.errors), ...(criteria.ok ? [] : criteria.errors)]);
  }
  return ok({ candidateLenses: lenses.value, judgeCriteria: criteria.value });
}

/**
 * The program's entry. `/loom --panel` runs the interactive interview and
 * prepares the candidate manifest before the program starts, so the program
 * begins at the candidate fan-out with both recorded as complete: a replayed
 * outcome for either is a duplicate.
 */
export function startArchitectureDispatchProgram(
  input: ArchitectureProgramInput,
): ParseResult<ProgramStep<ArchitectureProgramState>> {
  const parsed = parseArchitectureProgramInput(input);
  if (!parsed.ok) return parsed;
  const requests = candidateRequests(parsed.value.candidateLenses);
  const state: ArchitectureProgramState = {
    panel: "architecture",
    stage: "candidates",
    input: parsed.value,
    completedRequestIds: ["architecture:interview"],
    completedOperationIds: ["architecture-prepare-candidates"],
    slots: pendingSlots(requests),
  };
  return ok({ state, action: batch(requests) });
}

/**
 * How one settled slot leaves the panel — a DISCRIMINATED UNION.
 *
 * `retry` and `reason` are each meaningful for exactly one outcome, but they
 * used to hang off the record as independently-optional fields alongside a
 * plain `outcome` string. The type then said nothing the readers needed, so
 * all five call sites recovered the coupling by hand: `result.reason!` on the
 * blocked arm (five non-null assertions, each one a place the union could be
 * wrong with no compile error) and an `if (retry?.interaction !== ...)` dance
 * on the retry arm. Discriminating on `outcome` puts the payload where it
 * belongs and the assertions disappear.
 */
type SlotSettlement<Request extends SpawnRequest> =
  | Readonly<{ slots: NonEmpty<PendingSlot<Request>>; outcome: "waiting" }>
  | Readonly<{ slots: NonEmpty<PendingSlot<Request>>; outcome: "complete" }>
  | Readonly<{ slots: NonEmpty<PendingSlot<Request>>; outcome: "retry"; retry: Request }>
  | Readonly<{ slots: NonEmpty<PendingSlot<Request>>; outcome: "blocked"; reason: string }>;

function settleSlots<Request extends SpawnRequest>(
  slots: NonEmpty<PendingSlot<Request>>,
  completedRequestIds: readonly string[],
  event: SpawnOutcomeEvent,
): ProgramResult<SlotSettlement<Request>> {
  if (completedRequestIds.includes(event.requestId)) {
    return reject({ kind: "duplicate-outcome", requestId: event.requestId });
  }
  const index = slots.findIndex((slot) => slot.request.id === event.requestId);
  if (index < 0) return reject({ kind: "unknown-outcome", requestId: event.requestId });

  const slot = slots[index];
  if (slot.status === "succeeded") {
    return reject({ kind: "duplicate-outcome", requestId: event.requestId });
  }
  if (event.attempt !== slot.request.attempt) {
    return reject({
      kind: "stale-attempt-outcome",
      requestId: event.requestId,
      expectedAttempt: slot.request.attempt,
      receivedAttempt: event.attempt,
    });
  }

  if (event.outcome === "failed") {
    if (slot.request.attempt === 2) {
      return success({
        slots,
        outcome: "blocked",
        reason: event.error?.trim() || `${event.requestId} failed its second and final attempt`,
      });
    }
    const retry = { ...slot.request, attempt: 2 } as Request;
    const updated = mapNonEmpty(slots, (candidate, candidateIndex) =>
      candidateIndex === index ? { request: retry, status: "pending" as const } : candidate,
    );
    return success({ slots: updated, outcome: "retry", retry });
  }

  const updated = mapNonEmpty(slots, (candidate, candidateIndex) =>
    candidateIndex === index ? { ...candidate, status: "succeeded" as const } : candidate,
  );
  return success({
    slots: updated,
    outcome: updated.every((candidate) => candidate.status === "succeeded") ? "complete" : "waiting",
  });
}

function operationOutcome(
  expected: ArchitectureEngineOperation,
  completed: readonly ArchitectureEngineOperation[],
  event: EngineOutcomeEvent,
): ProgramResult<"succeeded" | Readonly<{ failed: string }>> {
  if (completed.includes(event.operationId)) {
    return reject({ kind: "duplicate-operation-outcome", operationId: event.operationId });
  }
  if (event.operationId !== expected) {
    return reject({ kind: "unknown-operation-outcome", operationId: event.operationId });
  }
  return event.outcome === "succeeded"
    ? success("succeeded")
    : success({ failed: event.error?.trim() || `${expected} failed` });
}

const unexpected = <T>(stage: string): ProgramResult<T> =>
  reject({ kind: "unexpected-event", panel: "architecture", stage });

const blocked = (stage: string, reason: string): BlockedAction =>
  ({ type: "blocked", panel: "architecture", stage, reason });

/** The two headless fan-out stages: their slots only ever hold headless requests. */
type FanOutState = Extract<ArchitectureProgramState, { stage: "candidates" | "judges" }>;

/**
 * One spawn outcome over a headless fan-out stage: a retry re-batches the one
 * failed request, a second failure blocks the stage, a partial batch waits,
 * and the last success hands every slot's request id to `advance`, which
 * names the stage that follows.
 */
function settleFanOut(
  state: FanOutState,
  event: ArchitectureProgramEvent,
  advance: (completedRequestIds: readonly string[]) => ProgramStep<ArchitectureProgramState>,
): ProgramResult<ProgramStep<ArchitectureProgramState>> {
  if (event.type !== "spawn-outcome") return unexpected(state.stage);
  const settled = settleSlots(state.slots, state.completedRequestIds, event);
  if (!settled.ok) return settled;
  const result = settled.value;
  switch (result.outcome) {
    case "retry":
      return success({ state: { ...state, slots: result.slots }, action: batch([result.retry]) });
    case "blocked":
      return success({
        state: { ...state, stage: "blocked", reason: result.reason },
        action: blocked(state.stage, result.reason),
      });
    case "waiting":
      return success({ state: { ...state, slots: result.slots }, action: null });
    case "complete":
      return success(advance([...state.completedRequestIds, ...state.slots.map((slot) => slot.request.id)]));
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

/** The architecture panel reducer. It does not delegate to a generic panel machine. */
export function reduceArchitectureProgram(
  state: ArchitectureProgramState,
  event: ArchitectureProgramEvent,
): ProgramResult<ProgramStep<ArchitectureProgramState>> {
  if (event.type === "spawn-outcome" && state.completedRequestIds.includes(event.requestId)) {
    return reject({ kind: "duplicate-outcome", requestId: event.requestId });
  }
  if (event.type === "engine-outcome" && state.completedOperationIds.includes(event.operationId)) {
    return reject({ kind: "duplicate-operation-outcome", operationId: event.operationId });
  }

  switch (state.stage) {
    case "candidates":
      return settleFanOut(state, event, (completedRequestIds) => ({
        state: {
          panel: state.panel,
          input: state.input,
          stage: "prepare-judges",
          operation: "architecture-prepare-judges",
          completedRequestIds,
          completedOperationIds: state.completedOperationIds,
        },
        action: operation("architecture-prepare-judges", "validated candidate set and exact ordered judge criteria"),
      }));

    case "prepare-judges": {
      if (event.type !== "engine-outcome") return unexpected(state.stage);
      const outcome = operationOutcome(state.operation, state.completedOperationIds, event);
      if (!outcome.ok) return outcome;
      if (outcome.value !== "succeeded") {
        const reason = outcome.value.failed;
        return success({ state: { ...state, stage: "blocked", reason }, action: blocked(state.stage, reason) });
      }
      const requests = judgeRequests(state.input.judgeCriteria);
      const next: ArchitectureProgramState = {
        panel: state.panel,
        input: state.input,
        stage: "judges",
        slots: pendingSlots(requests),
        completedRequestIds: state.completedRequestIds,
        completedOperationIds: [...state.completedOperationIds, state.operation],
      };
      return success({ state: next, action: batch(requests) });
    }

    case "judges":
      return settleFanOut(state, event, (completedRequestIds) => ({
        state: {
          panel: state.panel,
          input: state.input,
          stage: "aggregate",
          operation: "architecture-aggregate",
          completedRequestIds,
          completedOperationIds: state.completedOperationIds,
        },
        action: operation("architecture-aggregate", "deterministic total ranking over every candidate and criterion"),
      }));

    case "aggregate": {
      if (event.type !== "engine-outcome") return unexpected(state.stage);
      const outcome = operationOutcome(state.operation, state.completedOperationIds, event);
      if (!outcome.ok) return outcome;
      if (outcome.value !== "succeeded") {
        const reason = outcome.value.failed;
        return success({ state: { ...state, stage: "blocked", reason }, action: blocked(state.stage, reason) });
      }
      const request = finalizerRequest(1);
      const next: ArchitectureProgramState = {
        panel: state.panel,
        input: state.input,
        stage: "finalize",
        slot: { request, status: "pending" },
        completedRequestIds: state.completedRequestIds,
        completedOperationIds: [...state.completedOperationIds, state.operation],
      };
      return success({ state: next, action: awaitUser(request) });
    }

    case "finalize": {
      if (event.type !== "spawn-outcome") return unexpected(state.stage);
      const settled = settleSlots([state.slot], state.completedRequestIds, event);
      if (!settled.ok) return settled;
      const result = settled.value;
      if (result.outcome === "retry") {
        return success({ state: { ...state, slot: result.slots[0] }, action: awaitUser(result.retry) });
      }
      if (result.outcome === "blocked") {
        const reason = result.reason;
        return success({ state: { ...state, stage: "blocked", reason }, action: blocked("finalize", reason) });
      }
      if (result.outcome === "waiting") return success({ state, action: null });
      return success({
        state: {
          panel: state.panel,
          input: state.input,
          stage: "complete",
          completedRequestIds: [...state.completedRequestIds, state.slot.request.id],
          completedOperationIds: state.completedOperationIds,
        },
        action: { type: "done", panel: "architecture", outcome: "completed" },
      });
    }

    case "complete":
    case "blocked":
      return unexpected(state.stage);
  }
}

// ---------------------------------------------------------------------------
// The journal — what `/loom --panel` keeps in its run's panel-program.json
// ---------------------------------------------------------------------------

/** The one journal schema. Absence is the original on-disk spelling. */
const PANEL_PROGRAM_JOURNAL_SCHEMA_VERSION = 1;

/** The format tag a journal may carry. The spelling is wire data: journals written with it stay readable. */
const PANEL_PROGRAM_JOURNAL_FORMAT = "legacy-panel-program";

/** A parsed journal: the dispatch input and the event prefix to replay. */
export type ArchitecturePanelJournal = Readonly<{
  input: ArchitectureProgramInput;
  events: readonly ArchitectureProgramEvent[];
}>;

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const JOURNAL_INPUT_SHAPE = "architecture input requires exact PanelLens candidateLenses[] and judgeCriteria[]";

const panelLens = (entry: string): PanelLens | null =>
  PANEL_LENSES.find((candidate) => candidate === entry) ?? null;

/**
 * One journal input list: strings, each a member of its closed vocabulary
 * (`member` returns null for a non-member); the first that is not one is named
 * as an unknown `term`.
 */
function parseJournalTerms<Term>(
  value: unknown,
  member: (entry: string) => Term | null,
  term: "design lens" | "judge criterion",
): LineParseResult<readonly Term[]> {
  if (!isStrings(value)) return parseErr(JOURNAL_INPUT_SHAPE);
  const parsed: Term[] = [];
  for (const entry of value) {
    const known = member(entry);
    if (known === null) return parseErr(`unknown architecture ${term}: ${entry}`);
    parsed.push(known);
  }
  return parseOk(Object.freeze(parsed));
}

function parseJournalEvent(raw: unknown, index: number): LineParseResult<ArchitectureProgramEvent> {
  if (!isRecord(raw)) return parseErr(`events[${index}] must be an object`);
  const errorField = (): LineParseResult<Readonly<{ error?: string }>> =>
    raw.error === undefined ? parseOk({})
      : typeof raw.error === "string" ? parseOk({ error: raw.error })
      : parseErr(`events[${index}].error must be a string`);
  if (raw.type === "spawn-outcome") {
    if (typeof raw.requestId !== "string" || (raw.attempt !== 1 && raw.attempt !== 2)
      || (raw.outcome !== "succeeded" && raw.outcome !== "failed")) {
      return parseErr(`events[${index}] is not a valid spawn-outcome`);
    }
    const error = errorField();
    if (!error.ok) return error;
    return parseOk(Object.freeze({ type: "spawn-outcome" as const, requestId: raw.requestId, attempt: raw.attempt, outcome: raw.outcome, ...error.value }));
  }
  if (raw.type === "engine-outcome") {
    const operationId = ARCHITECTURE_OPERATIONS.find((operation) => operation === raw.operationId);
    if (operationId === undefined || (raw.outcome !== "succeeded" && raw.outcome !== "failed")) {
      return parseErr(`events[${index}] is not a valid architecture engine-outcome`);
    }
    const error = errorField();
    if (!error.ok) return error;
    return parseOk(Object.freeze({ type: "engine-outcome" as const, operationId, outcome: raw.outcome, ...error.value }));
  }
  return parseErr(`events[${index}].type must be spawn-outcome or engine-outcome`);
}

/**
 * Parse a caller-held journal. The document and its event prefix are never
 * rewritten; the optional `schemaVersion`, `format` and `panel` tags must name
 * this journal when present. Never throws: a hostile value comes back as a
 * diagnostic that carries the thrown cause.
 */
export function parseArchitecturePanelJournal(raw: unknown): LineParseResult<ArchitecturePanelJournal> {
  try {
    if (!isRecord(raw) || !isRecord(raw.input) || !Array.isArray(raw.events)) {
      return parseErr("Panel program requires {input, events: []}");
    }
    if (raw.schemaVersion !== undefined && raw.schemaVersion !== PANEL_PROGRAM_JOURNAL_SCHEMA_VERSION) {
      return parseErr(`Unsupported legacy panel journal schemaVersion: ${String(raw.schemaVersion)}`);
    }
    if (raw.format !== undefined && raw.format !== PANEL_PROGRAM_JOURNAL_FORMAT) {
      return parseErr(`Unsupported panel journal format: ${String(raw.format)}`);
    }
    if (raw.panel !== undefined && raw.panel !== "architecture") {
      return parseErr(`Panel journal declares '${String(raw.panel)}' but was opened as 'architecture'`);
    }
    const candidateLenses = parseJournalTerms(raw.input.candidateLenses, panelLens, "design lens");
    if (!candidateLenses.ok) return candidateLenses;
    const judgeCriteria = parseJournalTerms(raw.input.judgeCriteria, architectureCriterion, "judge criterion");
    if (!judgeCriteria.ok) return judgeCriteria;
    const events: ArchitectureProgramEvent[] = [];
    for (const [index, rawEvent] of raw.events.entries()) {
      const parsed = parseJournalEvent(rawEvent, index);
      if (!parsed.ok) return parsed;
      events.push(parsed.value);
    }
    return parseOk(Object.freeze({
      input: Object.freeze({ candidateLenses: candidateLenses.value, judgeCriteria: judgeCriteria.value }),
      events: Object.freeze(events),
    }));
  } catch (error) {
    // Bind the thrown cause: a shape TypeError is a real journal defect the
    // operator must be able to tell apart from a parser drift.
    return parseErr(`Panel program journal could not be safely inspected: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Replay — the journal folded through the program (ADR-0096)
// ---------------------------------------------------------------------------

/** Why a parsed journal does not replay: the start refused its input, or the reducer refused an event. */
export type ArchitectureReplayError =
  | Readonly<{ kind: "start-refused"; errors: readonly string[] }>
  | Readonly<{ kind: "event-refused"; error: PanelProgramError }>;

export type ArchitectureReplayResult =
  | Readonly<{ ok: true; value: ProgramStep<ArchitectureProgramState> }>
  | Readonly<{ ok: false; error: ArchitectureReplayError }>;

/**
 * Start the program from the journal's input and fold its events through the
 * reducer, in order: the step the last event leaves, or the first refusal.
 * `helper panel-program architecture` prints the step.
 */
export function replayArchitecturePanelJournal(journal: ArchitecturePanelJournal): ArchitectureReplayResult {
  const started = startArchitectureDispatchProgram(journal.input);
  if (!started.ok) return { ok: false, error: { kind: "start-refused", errors: started.errors } };
  let step = started.value;
  for (const event of journal.events) {
    const reduced = reduceArchitectureProgram(step.state, event);
    if (!reduced.ok) return { ok: false, error: { kind: "event-refused", error: reduced.error } };
    step = reduced.value;
  }
  return { ok: true, value: step };
}

/** The operator text for a replay refusal. */
export function describeArchitectureReplayError(error: ArchitectureReplayError): string {
  switch (error.kind) {
    case "start-refused":
      return error.errors.join("\n");
    case "event-refused":
      return `Panel program rejected event: ${JSON.stringify(error.error)}`;
    default: {
      const unreachable: never = error;
      return unreachable;
    }
  }
}
