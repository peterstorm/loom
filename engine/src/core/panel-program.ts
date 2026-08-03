import { PANEL_LENSES, type PanelLens } from "./panel-contract";
import type { LlmProfileId } from "./model-profiles";
import { REVIEW_LENSES, type ReviewLens } from "./review-panel";
import { fail, ok, type ParseResult } from "./panel-kernel";

/** A non-empty immutable sequence. Parallel fan-out actions use this type. */
export type NonEmpty<T> = readonly [T, ...T[]];

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
  design: "panel-design",
  judging: "panel-judge",
  refutation: "refutation",
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

export type ArchitectureEngineOperation =
  | "architecture-prepare-candidates"
  | "architecture-prepare-judges"
  | "architecture-aggregate";

export type RefutationEngineOperation =
  | "refutation-prepare-verifiers"
  | "refutation-tally";

export type PanelEngineOperation = ArchitectureEngineOperation | RefutationEngineOperation;

export type EngineOperationAction = Readonly<{
  type: "engine-operation";
  id: PanelEngineOperation;
  operation: PanelEngineOperation;
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

export type DoneAction =
  | Readonly<{ type: "done"; panel: "architecture"; outcome: "completed" }>
  | Readonly<{
      type: "done";
      panel: "refutation";
      outcome: "completed" | "skipped-no-critical-findings";
    }>;

export type BlockedAction = Readonly<{
  type: "blocked";
  panel: "architecture" | "refutation";
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

export type EngineOutcomeEvent<Operation extends PanelEngineOperation = PanelEngineOperation> = Readonly<{
  type: "engine-outcome";
  operationId: Operation;
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
  | Readonly<{ kind: "unknown-operation-outcome"; operationId: PanelEngineOperation }>
  | Readonly<{ kind: "duplicate-operation-outcome"; operationId: PanelEngineOperation }>
  | Readonly<{ kind: "unexpected-event"; panel: "architecture" | "refutation"; stage: string }>;

export type ProgramResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: PanelProgramError }>;

const success = <T>(value: T): ProgramResult<T> => ({ ok: true, value });
const reject = <T>(error: PanelProgramError): ProgramResult<T> => ({ ok: false, error });

export interface ArchitectureProgramInput {
  readonly candidateLenses: readonly PanelLens[];
  readonly judgeCriteria: readonly string[];
}

interface ArchitectureStateBase {
  readonly panel: "architecture";
  readonly input: Readonly<{
    candidateLenses: NonEmpty<PanelLens>;
    judgeCriteria: NonEmpty<string>;
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
  | Readonly<ArchitectureStateBase & { stage: "interview"; slot: InteractiveSlot }>
  | Readonly<ArchitectureStateBase & {
      stage: "prepare-candidates";
      operation: "architecture-prepare-candidates";
    }>
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
  | EngineOutcomeEvent<ArchitectureEngineOperation>;

export interface RefutationProgramInput {
  readonly criticalFindingIds: readonly string[];
  readonly lenses: readonly ReviewLens[];
}

interface RefutationStateBase {
  readonly panel: "refutation";
  readonly input: Readonly<{
    criticalFindingIds: readonly string[];
    lenses: readonly ReviewLens[];
  }>;
  readonly completedRequestIds: readonly string[];
  readonly completedOperationIds: readonly RefutationEngineOperation[];
}

export type RefutationProgramState =
  | Readonly<RefutationStateBase & { stage: "skipped" }>
  | Readonly<RefutationStateBase & {
      stage: "prepare-verifiers";
      operation: "refutation-prepare-verifiers";
    }>
  | Readonly<RefutationStateBase & { stage: "verifiers"; slots: NonEmpty<HeadlessSlot> }>
  | Readonly<RefutationStateBase & { stage: "tally"; operation: "refutation-tally" }>
  | Readonly<RefutationStateBase & { stage: "complete" }>
  | Readonly<RefutationStateBase & { stage: "blocked"; reason: string }>;

export type RefutationProgramEvent =
  | SpawnOutcomeEvent
  | EngineOutcomeEvent<RefutationEngineOperation>;

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

const interviewRequest = (attempt: 1 | 2): InteractiveSpawnRequest => ({
  id: "architecture:interview",
  agent: "arch-interviewer-agent",
  interaction: "interactive",
  modelProfile: PANEL_PROGRAM_MODEL_PROFILES.architecture,
  attempt,
  outputContract: "validated architecture interview digest",
});

const finalizerRequest = (attempt: 1 | 2): InteractiveSpawnRequest => ({
  id: "architecture:finalize",
  agent: "architecture-agent",
  interaction: "interactive",
  modelProfile: PANEL_PROGRAM_MODEL_PROFILES.architecture,
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

const judgeRequests = (criteria: NonEmpty<string>, attempt: 1 | 2 = 1): NonEmpty<HeadlessSpawnRequest> =>
  mapNonEmpty(criteria, (criterion, index) => headlessRequest(
    `architecture:judge:${index + 1}`,
    "arch-judge-agent",
    PANEL_PROGRAM_MODEL_PROFILES.judging,
    attempt,
    `canonical judge verdict for criterion ${JSON.stringify(criterion)} covering every candidate exactly once`,
  ));

const verifierRequests = (lenses: NonEmpty<ReviewLens>, attempt: 1 | 2 = 1): NonEmpty<HeadlessSpawnRequest> =>
  mapNonEmpty(lenses, (lens, index) => headlessRequest(
    `refutation:verifier:${index + 1}`,
    "review-verifier-agent",
    PANEL_PROGRAM_MODEL_PROFILES.refutation,
    attempt,
    `canonical refutation verdict for lens ${lens} covering every critical finding exactly once`,
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
  id: PanelEngineOperation,
  outputContract: string,
): EngineOperationAction => ({ type: "engine-operation", id, operation: id, outputContract });

function distinctNonEmpty<T extends string>(
  values: readonly T[],
  label: string,
): ParseResult<NonEmpty<T>> {
  const errors: string[] = [];
  if (values.length === 0) errors.push(`${label} must be non-empty`);
  if (new Set(values).size !== values.length) errors.push(`${label} must be distinct`);
  if (values.some((value) => value.trim().length === 0)) errors.push(`${label} must not contain empty values`);
  if (errors.length > 0) return fail(errors);
  const copy = [...values];
  const first = copy[0];
  return first === undefined ? fail([`${label} failed its internal non-empty check`]) : ok([first, ...copy.slice(1)]);
}

/** Parse configuration and emit the first architecture action. */
export function startArchitectureProgram(
  input: ArchitectureProgramInput,
): ParseResult<ProgramStep<ArchitectureProgramState>> {
  const lenses = distinctNonEmpty(input.candidateLenses, "candidate lenses");
  const criteria = distinctNonEmpty(input.judgeCriteria, "judge criteria");
  const unknownLenses = lenses.ok
    ? lenses.value.filter((lens) => !(PANEL_LENSES as readonly string[]).includes(lens))
    : [];
  if (!lenses.ok || !criteria.ok || unknownLenses.length > 0) {
    return fail([
      ...(lenses.ok ? [] : lenses.errors),
      ...(criteria.ok ? [] : criteria.errors),
      ...unknownLenses.map((lens) => `unknown architecture design lens: ${lens}`),
    ]);
  }

  const parsedInput = {
    candidateLenses: lenses.value,
    judgeCriteria: criteria.value,
  } as const;
  const request = interviewRequest(1);
  const state: ArchitectureProgramState = {
    panel: "architecture",
    stage: "interview",
    input: parsedInput,
    completedRequestIds: [],
    completedOperationIds: [],
    slot: { request, status: "pending" },
  };
  return ok({ state, action: awaitUser(request) });
}

/**
 * Production entry after the interactive interview has been validated and the
 * exact lenses/criteria have been derived. This avoids re-running the interview
 * merely to obtain values the executable dispatch program already receives.
 */
export function startArchitectureDispatchProgram(
  input: ArchitectureProgramInput,
): ParseResult<ProgramStep<ArchitectureProgramState>> {
  const started = startArchitectureProgram(input);
  if (!started.ok) return started;
  const requests = candidateRequests(started.value.state.input.candidateLenses);
  const state: ArchitectureProgramState = {
    panel: "architecture",
    stage: "candidates",
    input: started.value.state.input,
    completedRequestIds: ["architecture:interview"],
    completedOperationIds: ["architecture-prepare-candidates"],
    slots: pendingSlots(requests),
  };
  return ok({ state, action: batch(requests) });
}

/** Alias that emphasizes parse-don't-validate construction. */
export const parseArchitectureProgram = startArchitectureProgram;

/** Parse configuration and emit the first refutation action (or an exact skip). */
export function startRefutationProgram(
  input: RefutationProgramInput,
): ParseResult<ProgramStep<RefutationProgramState>> {
  const findingErrors: string[] = [];
  if (new Set(input.criticalFindingIds).size !== input.criticalFindingIds.length) {
    findingErrors.push("critical finding ids must be distinct");
  }
  if (input.criticalFindingIds.some((id) => id.trim().length === 0)) {
    findingErrors.push("critical finding ids must not contain empty values");
  }
  if (findingErrors.length > 0) return fail(findingErrors);

  const criticalFindingIds = [...input.criticalFindingIds];
  if (criticalFindingIds.length === 0) {
    const state: RefutationProgramState = {
      panel: "refutation",
      stage: "skipped",
      input: { criticalFindingIds, lenses: [] },
      completedRequestIds: [],
      completedOperationIds: [],
    };
    return ok({
      state,
      action: { type: "done", panel: "refutation", outcome: "skipped-no-critical-findings" },
    });
  }

  const lenses = distinctNonEmpty(input.lenses, "refutation lenses");
  if (!lenses.ok) return fail(lenses.errors);
  const unknownLenses = lenses.value.filter(
    (lens) => !(REVIEW_LENSES as readonly string[]).includes(lens),
  );
  if (unknownLenses.length > 0) {
    return fail(unknownLenses.map((lens) => `unknown refutation lens: ${lens}`));
  }
  const state: RefutationProgramState = {
    panel: "refutation",
    stage: "prepare-verifiers",
    input: { criticalFindingIds, lenses: lenses.value },
    completedRequestIds: [],
    completedOperationIds: [],
    operation: "refutation-prepare-verifiers",
  };
  return ok({
    state,
    action: operation(
      "refutation-prepare-verifiers",
      "validated critical-finding brief, manifest, and ordered refutation lenses",
    ),
  });
}

export function startRefutationDispatchProgram(
  input: RefutationProgramInput,
): ParseResult<ProgramStep<RefutationProgramState>> {
  const started = startRefutationProgram(input);
  if (!started.ok || started.value.state.stage === "skipped") return started;
  const parsedLenses = distinctNonEmpty(input.lenses, "refutation lenses");
  if (!parsedLenses.ok) return fail(parsedLenses.errors);
  const requests = verifierRequests(parsedLenses.value);
  const state: RefutationProgramState = {
    panel: "refutation",
    stage: "verifiers",
    input: started.value.state.input,
    completedRequestIds: [],
    completedOperationIds: ["refutation-prepare-verifiers"],
    slots: pendingSlots(requests),
  };
  return ok({ state, action: batch(requests) });
}

/** Alias that emphasizes parse-don't-validate construction. */
export const parseRefutationProgram = startRefutationProgram;

interface SlotSettlement<Request extends SpawnRequest> {
  readonly slots: NonEmpty<PendingSlot<Request>>;
  readonly outcome: "waiting" | "retry" | "complete" | "blocked";
  readonly retry?: Request;
  readonly reason?: string;
}

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

  const slot = slots[index]!;
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
  expected: PanelEngineOperation,
  completed: readonly PanelEngineOperation[],
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

const unexpected = <T>(
  panel: "architecture" | "refutation",
  stage: string,
): ProgramResult<T> => reject({ kind: "unexpected-event", panel, stage });

const blocked = (
  panel: "architecture" | "refutation",
  stage: string,
  reason: string,
): BlockedAction => ({ type: "blocked", panel, stage, reason });

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
    case "interview": {
      if (event.type !== "spawn-outcome") return unexpected("architecture", state.stage);
      const settled = settleSlots([state.slot], state.completedRequestIds, event);
      if (!settled.ok) return settled;
      const result = settled.value;
      if (result.outcome === "retry") {
        const retry = result.retry;
        if (retry?.interaction !== "interactive") return unexpected("architecture", state.stage);
        return success({ state: { ...state, slot: result.slots[0] as InteractiveSlot }, action: awaitUser(retry) });
      }
      if (result.outcome === "blocked") {
        const reason = result.reason!;
        return success({ state: { ...state, stage: "blocked", reason }, action: blocked("architecture", "interview", reason) });
      }
      if (result.outcome === "waiting") return success({ state, action: null });
      const next: ArchitectureProgramState = {
        panel: state.panel,
        input: state.input,
        stage: "prepare-candidates",
        operation: "architecture-prepare-candidates",
        completedRequestIds: [...state.completedRequestIds, state.slot.request.id],
        completedOperationIds: state.completedOperationIds,
      };
      return success({
        state: next,
        action: operation("architecture-prepare-candidates", "validated interview and exact candidate manifest"),
      });
    }

    case "prepare-candidates": {
      if (event.type !== "engine-outcome") return unexpected("architecture", state.stage);
      const outcome = operationOutcome(state.operation, state.completedOperationIds, event);
      if (!outcome.ok) return outcome;
      if (outcome.value !== "succeeded") {
        const reason = outcome.value.failed;
        return success({ state: { ...state, stage: "blocked", reason }, action: blocked("architecture", state.stage, reason) });
      }
      const requests = candidateRequests(state.input.candidateLenses);
      const next: ArchitectureProgramState = {
        panel: state.panel,
        input: state.input,
        stage: "candidates",
        slots: pendingSlots(requests),
        completedRequestIds: state.completedRequestIds,
        completedOperationIds: [...state.completedOperationIds, state.operation],
      };
      return success({ state: next, action: batch(requests) });
    }

    case "candidates": {
      if (event.type !== "spawn-outcome") return unexpected("architecture", state.stage);
      const settled = settleSlots(state.slots, state.completedRequestIds, event);
      if (!settled.ok) return settled;
      const result = settled.value;
      if (result.outcome === "retry") {
        const retry = result.retry;
        if (retry?.interaction !== "headless") return unexpected("architecture", state.stage);
        return success({ state: { ...state, slots: result.slots }, action: batch([retry]) });
      }
      if (result.outcome === "blocked") {
        const reason = result.reason!;
        return success({ state: { ...state, stage: "blocked", reason }, action: blocked("architecture", "candidates", reason) });
      }
      if (result.outcome === "waiting") return success({ state: { ...state, slots: result.slots }, action: null });
      const next: ArchitectureProgramState = {
        panel: state.panel,
        input: state.input,
        stage: "prepare-judges",
        operation: "architecture-prepare-judges",
        completedRequestIds: [...state.completedRequestIds, ...state.slots.map((slot) => slot.request.id)],
        completedOperationIds: state.completedOperationIds,
      };
      return success({
        state: next,
        action: operation("architecture-prepare-judges", "validated candidate set and exact ordered judge criteria"),
      });
    }

    case "prepare-judges": {
      if (event.type !== "engine-outcome") return unexpected("architecture", state.stage);
      const outcome = operationOutcome(state.operation, state.completedOperationIds, event);
      if (!outcome.ok) return outcome;
      if (outcome.value !== "succeeded") {
        const reason = outcome.value.failed;
        return success({ state: { ...state, stage: "blocked", reason }, action: blocked("architecture", state.stage, reason) });
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

    case "judges": {
      if (event.type !== "spawn-outcome") return unexpected("architecture", state.stage);
      const settled = settleSlots(state.slots, state.completedRequestIds, event);
      if (!settled.ok) return settled;
      const result = settled.value;
      if (result.outcome === "retry") {
        const retry = result.retry;
        if (retry?.interaction !== "headless") return unexpected("architecture", state.stage);
        return success({ state: { ...state, slots: result.slots }, action: batch([retry]) });
      }
      if (result.outcome === "blocked") {
        const reason = result.reason!;
        return success({ state: { ...state, stage: "blocked", reason }, action: blocked("architecture", "judges", reason) });
      }
      if (result.outcome === "waiting") return success({ state: { ...state, slots: result.slots }, action: null });
      const next: ArchitectureProgramState = {
        panel: state.panel,
        input: state.input,
        stage: "aggregate",
        operation: "architecture-aggregate",
        completedRequestIds: [...state.completedRequestIds, ...state.slots.map((slot) => slot.request.id)],
        completedOperationIds: state.completedOperationIds,
      };
      return success({
        state: next,
        action: operation("architecture-aggregate", "deterministic total ranking over every candidate and criterion"),
      });
    }

    case "aggregate": {
      if (event.type !== "engine-outcome") return unexpected("architecture", state.stage);
      const outcome = operationOutcome(state.operation, state.completedOperationIds, event);
      if (!outcome.ok) return outcome;
      if (outcome.value !== "succeeded") {
        const reason = outcome.value.failed;
        return success({ state: { ...state, stage: "blocked", reason }, action: blocked("architecture", state.stage, reason) });
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
      if (event.type !== "spawn-outcome") return unexpected("architecture", state.stage);
      const settled = settleSlots([state.slot], state.completedRequestIds, event);
      if (!settled.ok) return settled;
      const result = settled.value;
      if (result.outcome === "retry") {
        const retry = result.retry;
        if (retry?.interaction !== "interactive") return unexpected("architecture", state.stage);
        return success({ state: { ...state, slot: result.slots[0] as InteractiveSlot }, action: awaitUser(retry) });
      }
      if (result.outcome === "blocked") {
        const reason = result.reason!;
        return success({ state: { ...state, stage: "blocked", reason }, action: blocked("architecture", "finalize", reason) });
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
      return unexpected("architecture", state.stage);
  }
}

/** The refutation panel reducer. Its states and events are intentionally separate. */
export function reduceRefutationProgram(
  state: RefutationProgramState,
  event: RefutationProgramEvent,
): ProgramResult<ProgramStep<RefutationProgramState>> {
  if (event.type === "spawn-outcome" && state.completedRequestIds.includes(event.requestId)) {
    return reject({ kind: "duplicate-outcome", requestId: event.requestId });
  }
  if (event.type === "engine-outcome" && state.completedOperationIds.includes(event.operationId)) {
    return reject({ kind: "duplicate-operation-outcome", operationId: event.operationId });
  }

  switch (state.stage) {
    case "prepare-verifiers": {
      if (event.type !== "engine-outcome") return unexpected("refutation", state.stage);
      const outcome = operationOutcome(state.operation, state.completedOperationIds, event);
      if (!outcome.ok) return outcome;
      if (outcome.value !== "succeeded") {
        const reason = outcome.value.failed;
        return success({ state: { ...state, stage: "blocked", reason }, action: blocked("refutation", state.stage, reason) });
      }
      const parsedLenses = distinctNonEmpty(state.input.lenses, "refutation lenses");
      if (!parsedLenses.ok) return unexpected("refutation", state.stage);
      const requests = verifierRequests(parsedLenses.value);
      const next: RefutationProgramState = {
        panel: state.panel,
        input: state.input,
        stage: "verifiers",
        slots: pendingSlots(requests),
        completedRequestIds: state.completedRequestIds,
        completedOperationIds: [...state.completedOperationIds, state.operation],
      };
      return success({ state: next, action: batch(requests) });
    }

    case "verifiers": {
      if (event.type !== "spawn-outcome") return unexpected("refutation", state.stage);
      const settled = settleSlots(state.slots, state.completedRequestIds, event);
      if (!settled.ok) return settled;
      const result = settled.value;
      if (result.outcome === "retry") {
        const retry = result.retry;
        if (retry?.interaction !== "headless") return unexpected("refutation", state.stage);
        return success({ state: { ...state, slots: result.slots }, action: batch([retry]) });
      }
      if (result.outcome === "blocked") {
        const reason = result.reason!;
        return success({ state: { ...state, stage: "blocked", reason }, action: blocked("refutation", "verifiers", reason) });
      }
      if (result.outcome === "waiting") return success({ state: { ...state, slots: result.slots }, action: null });
      const next: RefutationProgramState = {
        panel: state.panel,
        input: state.input,
        stage: "tally",
        operation: "refutation-tally",
        completedRequestIds: [...state.completedRequestIds, ...state.slots.map((slot) => slot.request.id)],
        completedOperationIds: state.completedOperationIds,
      };
      return success({
        state: next,
        action: operation("refutation-tally", "deterministic adjudication of every critical finding"),
      });
    }

    case "tally": {
      if (event.type !== "engine-outcome") return unexpected("refutation", state.stage);
      const outcome = operationOutcome(state.operation, state.completedOperationIds, event);
      if (!outcome.ok) return outcome;
      if (outcome.value !== "succeeded") {
        const reason = outcome.value.failed;
        return success({ state: { ...state, stage: "blocked", reason }, action: blocked("refutation", state.stage, reason) });
      }
      return success({
        state: {
          panel: state.panel,
          input: state.input,
          stage: "complete",
          completedRequestIds: state.completedRequestIds,
          completedOperationIds: [...state.completedOperationIds, state.operation],
        },
        action: { type: "done", panel: "refutation", outcome: "completed" },
      });
    }

    case "skipped":
    case "complete":
    case "blocked":
      return unexpected("refutation", state.stage);
  }
}

// This helper is intentionally exported only as a type-shape constructor aid:
// reducers never accept arbitrary requests, so callers cannot alter ordering,
// agents, profiles, interaction, retries, or contracts.
export const isParallelSpawnBatch = (action: PanelProgramAction): action is SpawnBatchAction =>
  action.type === "spawn-batch" && action.requests.length > 0 &&
  action.requests.every((request) => request.interaction === "headless");

