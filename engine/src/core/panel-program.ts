import { createHash } from "node:crypto";
import {
  PANEL_LENSES,
  aggregateVerdicts,
  architectureCriterion,
  candidateFilename,
  parseJudgeVerdict,
  type ArchitectureCriterion,
  type CandidateFilename,
  type CandidateRanking,
  type JudgeVerdict,
  type PanelLens,
} from "./panel-contract";
import type { LlmProfileId } from "./model-profiles";
import {
  REVIEW_LENSES,
  defaultRefutationThreshold,
  parseRefutationVerdict,
  parseReviewLens,
  parseWaveFindingId,
  tallyRefutations,
  type BriefFinding,
  type FindingOutcome,
  type RefutationVerdict,
  type ReviewLens,
  type WaveFindingId,
} from "./review-panel";
import { fail, ok, sanitizeProse, type ParseResult, type VerdictEnvelope } from "./panel-kernel";
import { parseReviewPath } from "./review-packet";
import {
  acceptedAgentResult,
  parseCompleteRoster,
  parseArtifactDigest,
  parseEffectId,
  parseExactRoster,
  parseOrchestrationRunId,
  parseIssuedSpawnRequest,
  parseRequestId,
  parseSlotId,
  semanticRetryDiagnostic,
  terminalBlockedDiagnostic,
  type AcceptedAgentResult,
  type AgentRequestAuthority,
  type ArtifactDigest,
  type BlockedDiagnostic,
  type AgentRosterSlot,
  type CompleteRoster,
  type DomainResult,
  type EffectId,
  type ExactRoster,
  type OrchestrationRunId,
  type PublicationAuthorityResolver,
  type RequestId,
  type SemanticAttempt,
  type SlotId,
  type SpawnRequest as IssuedSpawnRequest,
  type TerminalBlockedDiagnostic,
} from "./orchestration-contract";

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
  architectureFinalization: "architecture-finalize",
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
  readonly criticalFindingIds: readonly WaveFindingId[];
  readonly lenses: readonly ReviewLens[];
}

interface RefutationStateBase {
  readonly panel: "refutation";
  readonly input: Readonly<{
    criticalFindingIds: readonly WaveFindingId[];
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
        if (retry.interaction !== "interactive") return unexpected("architecture", state.stage);
        return success({ state: { ...state, slot: result.slots[0] as InteractiveSlot }, action: awaitUser(retry) });
      }
      if (result.outcome === "blocked") {
        const reason = result.reason;
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
        if (retry.interaction !== "headless") return unexpected("architecture", state.stage);
        return success({ state: { ...state, slots: result.slots }, action: batch([retry]) });
      }
      if (result.outcome === "blocked") {
        const reason = result.reason;
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
        if (retry.interaction !== "headless") return unexpected("architecture", state.stage);
        return success({ state: { ...state, slots: result.slots }, action: batch([retry]) });
      }
      if (result.outcome === "blocked") {
        const reason = result.reason;
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
        if (retry.interaction !== "interactive") return unexpected("architecture", state.stage);
        return success({ state: { ...state, slot: result.slots[0] as InteractiveSlot }, action: awaitUser(retry) });
      }
      if (result.outcome === "blocked") {
        const reason = result.reason;
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
        if (retry.interaction !== "headless") return unexpected("refutation", state.stage);
        return success({ state: { ...state, slots: result.slots }, action: batch([retry]) });
      }
      if (result.outcome === "blocked") {
        const reason = result.reason;
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

// ---------------------------------------------------------------------------
// Durable authority-bound panel programs (schema v2)
// ---------------------------------------------------------------------------
//
// New panel sessions persist only JSON data. Runtime issuance proofs are
// rehydrated from T1's independently loaded publication authority before a
// durable event reaches either pure reducer. Runtime executors consume this
// closed persistence and replay contract rather than inventing another one.

const persistentSuccess = <T>(value: T): PersistentPanelResult<T> =>
  Object.freeze({ ok: true, value });
const persistentFailure = <T = never>(error: PersistentPanelError): PersistentPanelResult<T> =>
  Object.freeze({ ok: false, error: Object.freeze(error) });

export type PersistentPanelError = Readonly<{
  kind:
    | "invalid-authority"
    | "malformed-result"
    | "malformed-event"
    | "malformed-history"
    | "malformed-checkpoint"
    | "unknown-request"
    | "duplicate-result"
    | "stale-request"
    | "request-binding-mismatch"
    | "request-rehydration-failed"
    | "unexpected-event"
    | "terminal-state"
    | "incomplete-roster"
    | "invalid-aggregate"
    | "persistence-receipt-mismatch";
  panel: "architecture" | "refutation";
  message: string;
  requestId?: string;
  slotId?: string;
  rehydration?: Readonly<{ kind: "invalid-accepted-agent-result"; field?: string; message: string }>;
}>;

export type PersistentPanelResult<T> = DomainResult<T, PersistentPanelError>;

const boundedPanelMessage = (message: string): string => message.length <= 4_096
  ? message
  : `${message.slice(0, 4_083)}…[truncated]`;

const panelError = (
  panel: PersistentPanelError["panel"],
  kind: PersistentPanelError["kind"],
  message: string,
  request?: Readonly<{
    requestId?: string;
    slotId?: string;
    rehydration?: PersistentPanelError["rehydration"];
  }>,
): PersistentPanelError => Object.freeze({ kind, panel, message: boundedPanelMessage(message), ...request });

function safeArray(raw: unknown): readonly unknown[] | null {
  try {
    if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) return null;
    const length = Object.getOwnPropertyDescriptor(raw, "length");
    if (length === undefined || !("value" in length) || !Number.isSafeInteger(length.value) ||
        length.value < 0 || length.value > 65_536) return null;
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== length.value + 1 || keys[length.value] !== "length") return null;
    const values: unknown[] = [];
    for (let index = 0; index < length.value; index++) {
      if (keys[index] !== String(index)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
      values.push(descriptor.value);
    }
    return Object.freeze(values);
  } catch {
    return null;
  }
}

function safeRecord(
  raw: unknown,
  fields: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(raw);
    if (keys.some((key) => typeof key !== "string") ||
        (keys as string[]).some((key) => !fields.includes(key))) return null;
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
      Object.defineProperty(snapshot, key, { value: descriptor.value, enumerable: true });
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function nonEmptyDistinctStrings(raw: unknown): readonly [string, ...string[]] | null {
  const values = safeArray(raw);
  if (values === null || values.length === 0 ||
      values.some((value) => typeof value !== "string" || value.trim() !== value || value.length === 0)) return null;
  const strings = values as string[];
  if (new Set(strings).size !== strings.length) return null;
  return Object.freeze([...strings]) as readonly [string, ...string[]];
}

function authorityMatches(left: AgentRequestAuthority, right: AgentRequestAuthority): boolean {
  return left.runId === right.runId && left.requestId === right.requestId &&
    left.slotId === right.slotId && left.program === right.program && left.role === right.role &&
    left.attempt === right.attempt && left.modelProfile === right.modelProfile &&
    left.requiredSkill === right.requiredSkill && left.contextDigest === right.contextDigest &&
    left.outputSlot.path === right.outputSlot.path &&
    left.harnessBinding.pi.harness === right.harnessBinding.pi.harness &&
    left.harnessBinding.pi.provider === right.harnessBinding.pi.provider &&
    left.harnessBinding.pi.model === right.harnessBinding.pi.model &&
    left.harnessBinding.pi.thinking === right.harnessBinding.pi.thinking &&
    left.harnessBinding.claude.harness === right.harnessBinding.claude.harness &&
    left.harnessBinding.claude.model === right.harnessBinding.claude.model;
}

/**
 * `expectedLength` is the length of the ordered list this roster is paired
 * with — `candidateLenses`, `judgeCriteria`, or the refutation `lenses`. The
 * pairing is POSITIONAL: slot `i` answers for entry `i`, and the roster carries
 * nothing that independently names its entry, so equal cardinality is the whole
 * of what can be proven here. Everything downstream must therefore resolve its
 * entry through `boundEntryForSlot`, which fails closed on a slot the roster
 * does not actually hold, rather than indexing a parallel array and asserting
 * the result is present.
 */
export type RefutationVerifierBinding = Readonly<{
  slotId: SlotId;
  requestIds: readonly [RequestId, RequestId];
}>;

/** Single source of truth for semantic refutation verifier request authority. */
export function deriveRefutationVerifierBinding(
  runId: OrchestrationRunId,
  lens: ReviewLens,
  findingIds: NonEmpty<WaveFindingId>,
): ParseResult<RefutationVerifierBinding> {
  const slotHash = createHash("sha256")
    .update(JSON.stringify([runId, lens, findingIds]))
    .digest("hex")
    .slice(0, 32);
  const slotId = parseSlotId(`refutation-slot:${slotHash}`);
  const firstRequestId = parseRequestId(`refutation-request:${slotHash}:1`);
  const secondRequestId = parseRequestId(`refutation-request:${slotHash}:2`);
  const errors = [
    slotId.ok ? null : slotId.error.message,
    firstRequestId.ok ? null : firstRequestId.error.message,
    secondRequestId.ok ? null : secondRequestId.error.message,
  ].filter((message): message is string => message !== null);
  if (!slotId.ok || !firstRequestId.ok || !secondRequestId.ok) return fail(errors);
  return ok(Object.freeze({
    slotId: slotId.value,
    requestIds: Object.freeze([firstRequestId.value, secondRequestId.value] as const),
  }));
}

type CanonicalPanelSlotBinding = RefutationVerifierBinding;

function parseCanonicalPanelSlotBinding(
  runId: OrchestrationRunId,
  stage: "candidate" | "judge" | "verifier",
  ordinal: number,
  semanticEntry: string,
  findingIds: readonly string[] = [],
): CanonicalPanelSlotBinding | null {
  const legacySlot = parseSlotId(`${stage}:${ordinal}`);
  const legacyRequests = ([1, 2] as const).map((attempt) =>
    parseRequestId(`${runId}:${stage}:${ordinal}:${attempt}`));
  if (!legacySlot.ok || !legacyRequests[0].ok || !legacyRequests[1].ok) return null;

  if (stage !== "verifier" || findingIds.length === 0) {
    return Object.freeze({
      slotId: legacySlot.value,
      requestIds: Object.freeze([legacyRequests[0].value, legacyRequests[1].value]) as readonly [RequestId, RequestId],
    });
  }

  // Refutation identities derive from the semantic lens and exact finding set
  // rather than a caller-selected ordinal. Recompute the same authority used
  // by every producer so swapping complete slots cannot relabel verdicts.
  const lens = parseReviewLens(semanticEntry);
  const parsedFindingIds = findingIds.map(parseWaveFindingId);
  const [firstFindingId, ...otherFindingIds] = parsedFindingIds;
  if (lens === null || firstFindingId === null || firstFindingId === undefined ||
      otherFindingIds.some((findingId) => findingId === null)) return null;
  const binding = deriveRefutationVerifierBinding(
    runId,
    lens,
    [firstFindingId, ...(otherFindingIds as WaveFindingId[])],
  );
  return binding.ok ? binding.value : null;
}

function rosterAuthorityErrors(
  roster: ExactRoster,
  runId: OrchestrationRunId,
  program: "architecture-panel" | "refutation-panel",
  role: "arch-designer-agent" | "arch-judge-agent" | "review-verifier-agent",
  semanticEntries: readonly string[],
  stage: "candidate" | "judge" | "verifier",
  findingIds: readonly string[] = [],
  semanticRunId: OrchestrationRunId = runId,
): readonly string[] {
  const errors: string[] = [];
  if (roster.runId !== runId) errors.push("roster run does not match panel run");
  if (roster.program !== program) errors.push(`roster program must be ${program}`);
  if (roster.orderedSlots.length !== semanticEntries.length) {
    errors.push(`roster must contain exactly ${semanticEntries.length} slot(s)`);
  }
  for (const [index, slot] of roster.orderedSlots.entries()) {
    if (slot.attempts.some((request) => request.role !== role)) errors.push(`slot ${slot.slotId} must be assigned to ${role}`);
    if (slot.attempts.some((request) => request.slotId !== slot.slotId)) {
      errors.push(`slot ${slot.slotId} holds an attempt bound to a different slot`);
    }
    const semanticEntry = semanticEntries[index];
    if (semanticEntry === undefined) continue;
    const expected = parseCanonicalPanelSlotBinding(semanticRunId, stage, index + 1, semanticEntry, findingIds);
    if (expected === null) {
      // The semantic entry cannot derive a canonical slot binding (e.g. a
      // legacy lens no longer in the current table). Admit ONLY the exact
      // run-bound legacy ordinal identity below; a weaker, shapeless ordinal
      // match would re-pair this slot with whatever semantic entry now lives
      // at its position.
      const legacySlot = parseSlotId(`${stage}:${index + 1}`);
      const legacyRequests = ([1, 2] as const).map((attempt) =>
        parseRequestId(`${runId}:${stage}:${index + 1}:${attempt}`));
      const legacy = legacySlot.ok && legacyRequests[0].ok && legacyRequests[1].ok
        ? Object.freeze({
            slotId: legacySlot.value,
            requestIds: Object.freeze([legacyRequests[0].value, legacyRequests[1].value]) as readonly [RequestId, RequestId],
          })
        : null;
      const legacyMatches = legacy !== null &&
        slot.slotId === legacy.slotId &&
        slot.attempts.every((request, attemptIndex) => request.requestId === legacy.requestIds[attemptIndex]);
      if (!legacyMatches) {
        errors.push(
          `${stage} slot ${index + 1} for ${JSON.stringify(semanticEntry)} has non-canonical slot/request identity`,
        );
      }
      continue;
    }
    const bindingMatches = (binding: CanonicalPanelSlotBinding): boolean =>
      slot.slotId === binding.slotId &&
      slot.attempts.every((request, attemptIndex) => request.requestId === binding.requestIds[attemptIndex]);
    // The semantic slot binding is DERIVED from the semantic entry (and, for
    // verifier slots, the exact finding set). Require it whenever it is
    // derivable — ordering/labeling a roster by loose ordinal shape would let
    // a reordered lens or finding list silently relabel previously issued
    // requests as authoritative evidence for different semantics.
    if (!bindingMatches(expected)) {
      errors.push(
        `${stage} slot ${index + 1} for ${JSON.stringify(semanticEntry)} has non-canonical slot/request identity`,
      );
    }
  }
  return errors;
}

/**
 * The ordered entry slot `slotId` answers for, or `null` when the roster holds
 * no such slot.
 *
 * `orderedSlots.findIndex(...)` returns -1 for an unknown slot, and indexing a
 * parallel array with -1 yields `undefined` — which a `!` assertion then passes
 * downstream as if it were a real lens, criterion, or candidate id. Returning
 * `null` makes that case a refusal the caller must handle instead of a lie the
 * type system was told to ignore.
 */
function boundEntryForSlot<T>(
  roster: ExactRoster,
  ordered: readonly T[],
  slotId: SlotId,
): T | null {
  const index = roster.orderedSlots.findIndex((slot) => slot.slotId === slotId);
  if (index < 0 || index >= ordered.length) return null;
  return ordered[index] ?? null;
}

function crossRosterErrors(left: ExactRoster, right: ExactRoster): readonly string[] {
  const errors: string[] = [];
  const slots = new Set(left.orderedSlots.map(({ slotId }) => slotId));
  const requests = new Set(left.orderedSlots.flatMap(({ attempts }) => attempts.map(({ requestId }) => requestId)));
  const contexts = new Set(left.orderedSlots.flatMap(({ attempts }) => attempts.map(({ contextDigest }) => contextDigest)));
  const outputs = new Set(left.orderedSlots.flatMap(({ attempts }) => attempts.map(({ outputSlot }) => outputSlot.path)));
  for (const slot of right.orderedSlots) {
    if (slots.has(slot.slotId)) errors.push(`slot id is reused across architecture phases: ${slot.slotId}`);
    for (const request of slot.attempts) {
      if (requests.has(request.requestId)) errors.push(`request id is reused across architecture phases: ${request.requestId}`);
      if (contexts.has(request.contextDigest)) errors.push(`context is reused across architecture phases: ${request.contextDigest}`);
      if (outputs.has(request.outputSlot.path)) errors.push(`output slot is reused across architecture phases: ${request.outputSlot.path}`);
    }
  }
  return errors;
}

export type ArchitecturePanelAuthority = Readonly<{
  schemaVersion: 2;
  panel: "architecture";
  runId: OrchestrationRunId;
  candidateLenses: readonly [PanelLens, ...PanelLens[]];
  candidateIds: readonly [CandidateFilename, ...CandidateFilename[]];
  judgeCriteria: readonly [ArchitectureCriterion, ...ArchitectureCriterion[]];
  candidateRoster: ExactRoster;
  judgeRoster: ExactRoster;
}>;

export type ArchitecturePanelAuthorityInput = Readonly<{
  runId: unknown;
  candidateLenses: unknown;
  judgeCriteria: unknown;
  candidateSlots: unknown;
  judgeSlots: unknown;
}>;

export function parseArchitecturePanelAuthority(raw: ArchitecturePanelAuthorityInput): PersistentPanelResult<ArchitecturePanelAuthority> {
  try {
    const input = safeRecord(raw, ["runId", "candidateLenses", "judgeCriteria", "candidateSlots", "judgeSlots"]);
    if (input === null) return persistentFailure(panelError("architecture", "invalid-authority", "architecture authority must be an exact data record"));
    const runId = parseOrchestrationRunId(input.runId);
    const lenses = nonEmptyDistinctStrings(input.candidateLenses);
    const criteria = nonEmptyDistinctStrings(input.judgeCriteria);
    const candidateRoster = parseExactRoster(input.candidateSlots);
    const judgeRoster = parseExactRoster(input.judgeSlots);
    const errors: string[] = [];
    if (!runId.ok) errors.push(runId.error.message);
    if (lenses === null) errors.push("candidate lenses must be a non-empty distinct ordered list");
    if (criteria === null) errors.push("judge criteria must be a non-empty distinct ordered list");
    const parsedLenses = lenses?.filter((lens): lens is PanelLens => (PANEL_LENSES as readonly string[]).includes(lens)) ?? [];
    if (lenses !== null && parsedLenses.length !== lenses.length) errors.push("candidate lenses contain an unknown architecture lens");
    // Criteria are minted through the closed vocabulary, not asserted into
    // the brand: a checkpoint criterion outside deriveJudgeCriteria's
    // vocabulary cannot come from a validated digest and is rejected.
    const mintedCriteria = criteria === null
      ? []
      : criteria.flatMap((criterion) => {
          const minted = architectureCriterion(criterion);
          return minted === null ? [] : [minted];
        });
    if (criteria !== null && mintedCriteria.length !== criteria.length) {
      errors.push("judge criteria contain a criterion outside the validated interview vocabulary");
    }
    if (!candidateRoster.ok) errors.push(...candidateRoster.error.violations.map(({ kind }) => `candidate roster: ${kind}`));
    if (!judgeRoster.ok) errors.push(...judgeRoster.error.violations.map(({ kind }) => `judge roster: ${kind}`));
    if (runId.ok && lenses !== null && candidateRoster.ok) {
      errors.push(...rosterAuthorityErrors(
        candidateRoster.value,
        runId.value,
        "architecture-panel",
        "arch-designer-agent",
        lenses,
        "candidate",
      ));
    }
    if (runId.ok && criteria !== null && judgeRoster.ok) {
      errors.push(...rosterAuthorityErrors(
        judgeRoster.value,
        runId.value,
        "architecture-panel",
        "arch-judge-agent",
        criteria,
        "judge",
      ));
    }
    if (candidateRoster.ok && judgeRoster.ok) errors.push(...crossRosterErrors(candidateRoster.value, judgeRoster.value));
    if (errors.length > 0 || !runId.ok || lenses === null || criteria === null || !candidateRoster.ok || !judgeRoster.ok || parsedLenses.length === 0) {
      return persistentFailure(panelError("architecture", "invalid-authority", errors.join("; ") || "architecture authority is invalid"));
    }
    const canonicalLenses = Object.freeze(parsedLenses) as readonly [PanelLens, ...PanelLens[]];
    const canonicalCriteria = Object.freeze(mintedCriteria) as unknown as readonly [ArchitectureCriterion, ...ArchitectureCriterion[]];
    return persistentSuccess(Object.freeze({
      schemaVersion: 2 as const,
      panel: "architecture" as const,
      runId: runId.value,
      candidateLenses: canonicalLenses,
      candidateIds: Object.freeze(canonicalLenses.map(candidateFilename)) as readonly [CandidateFilename, ...CandidateFilename[]],
      judgeCriteria: canonicalCriteria,
      candidateRoster: candidateRoster.value,
      judgeRoster: judgeRoster.value,
    }));
  } catch {
    return persistentFailure(panelError("architecture", "invalid-authority", "architecture authority could not be safely inspected"));
  }
}

function parseStrictBriefFinding(raw: unknown): DomainResult<BriefFinding, Readonly<{ message: string }>> {
  const finding = safeRecord(raw, ["id", "taskId", "agent", "severity", "file", "line", "claim"]);
  if (finding === null) return { ok: false, error: { message: "Finding must be an exact data record" } };
  const id = parseWaveFindingId(finding.id);
  const taskId = typeof finding.taskId === "string" ? sanitizeProse(finding.taskId) : "";
  const agent = typeof finding.agent === "string" ? sanitizeProse(finding.agent) : "";
  const claim = typeof finding.claim === "string" ? sanitizeProse(finding.claim) : "";
  const file = finding.file === null ? null : parseReviewPath(finding.file, "Finding file");
  const line = finding.line === null
    ? null
    : typeof finding.line === "number" && Number.isSafeInteger(finding.line) && finding.line > 0
      ? finding.line
      : undefined;
  const errors: string[] = [];
  if (id === null) errors.push("Finding id must be a wave-scoped task-id:finding-id without whitespace or extra colons");
  if (taskId.length === 0) errors.push("Finding taskId must be non-empty after sanitization");
  if (agent.length === 0) errors.push("Finding agent must be non-empty after sanitization");
  if (claim.length === 0) errors.push("Finding claim must be non-empty after sanitization");
  if (finding.severity !== "critical") errors.push("Finding severity must be critical");
  if (file !== null && !file.ok) errors.push(...file.errors);
  if (line === undefined) errors.push("Finding line must be null or a positive safe integer");
  if (id !== null && taskId.length > 0 && !id.startsWith(`${taskId}:`)) errors.push(`Finding id must be scoped by task ${taskId}`);
  if (errors.length > 0 || id === null || line === undefined || (file !== null && !file.ok)) {
    return { ok: false, error: { message: errors.join("; ") } };
  }
  const parsedFile = file === null ? null : file.value;
  return { ok: true, value: Object.freeze({
    id,
    taskId,
    agent,
    severity: "critical" as const,
    file: parsedFile,
    line,
    claim,
  }) };
}

export type RefutationPanelAuthority = Readonly<{
  schemaVersion: 2;
  panel: "refutation";
  runId: OrchestrationRunId;
  /** Semantic panel instance identity; Wave panels bind this to readiness. */
  identityRunId: OrchestrationRunId;
  findings: readonly [BriefFinding, ...BriefFinding[]];
  lenses: readonly [ReviewLens, ...ReviewLens[]];
  verifierRoster: ExactRoster;
}>;

export type RefutationPanelAuthorityInput = Readonly<{
  runId: unknown;
  identityRunId?: unknown;
  findings: unknown;
  lenses: unknown;
  verifierSlots: unknown;
}>;

/**
 * Resolve the lens a verifier slot answers for, refusing a slot the verifier
 * roster does not hold instead of pairing the result with `undefined`.
 */
function boundRefutationLens(
  authority: RefutationPanelAuthority,
  slotId: SlotId,
): PersistentPanelResult<ReviewLens> {
  const lens = boundEntryForSlot(authority.verifierRoster, authority.lenses, slotId);
  return lens === null
    ? persistentFailure(panelError("refutation", "request-binding-mismatch", `slot ${slotId} is bound to no refutation lens`, { slotId }))
    : persistentSuccess(lens);
}

/**
 * Resolve the lens and candidate id a designer slot answers for. Both come from
 * the same ordinal, so they are resolved together — pairing a lens from one
 * position with a candidate id from another is the mismatch this prevents.
 */
function boundCandidateEntry(
  authority: ArchitecturePanelAuthority,
  slotId: SlotId,
): PersistentPanelResult<Readonly<{ lens: PanelLens; candidate: CandidateFilename }>> {
  const lens = boundEntryForSlot(authority.candidateRoster, authority.candidateLenses, slotId);
  const candidate = boundEntryForSlot(authority.candidateRoster, authority.candidateIds, slotId);
  return lens === null || candidate === null
    ? persistentFailure(panelError("architecture", "request-binding-mismatch", `slot ${slotId} is bound to no candidate lens`, { slotId }))
    : persistentSuccess(Object.freeze({ lens, candidate }));
}

export function parseRefutationPanelAuthority(raw: RefutationPanelAuthorityInput): PersistentPanelResult<RefutationPanelAuthority> {
  try {
    const input = safeRecord(raw, ["runId", "identityRunId", "findings", "lenses", "verifierSlots"]) ??
      safeRecord(raw, ["runId", "findings", "lenses", "verifierSlots"]);
    if (input === null) return persistentFailure(panelError("refutation", "invalid-authority", "refutation authority must be an exact data record"));
    const runId = parseOrchestrationRunId(input.runId);
    const identityRunId = parseOrchestrationRunId(input.identityRunId ?? input.runId);
    const rawFindings = safeArray(input.findings);
    const lenses = nonEmptyDistinctStrings(input.lenses);
    const roster = parseExactRoster(input.verifierSlots);
    const findings: BriefFinding[] = [];
    const errors: string[] = [];
    if (!runId.ok) errors.push(runId.error.message);
    if (!identityRunId.ok) errors.push(identityRunId.error.message);
    if (rawFindings === null || rawFindings.length === 0) {
      errors.push("refutation findings must be a non-empty canonical critical Finding list");
    } else {
      rawFindings.forEach((entry, index) => {
        const parsed = parseStrictBriefFinding(entry);
        if (parsed.ok) findings.push(parsed.value);
        else errors.push(`findings[${index}]: ${parsed.error.message}`);
      });
    }
    if (new Set(findings.map(({ id }) => id)).size !== findings.length) errors.push("refutation findings must be distinct");
    if (lenses === null) errors.push("refutation lenses must be a non-empty distinct ordered list");
    const parsedLenses = lenses?.filter((lens): lens is ReviewLens => (REVIEW_LENSES as readonly string[]).includes(lens)) ?? [];
    if (lenses !== null && parsedLenses.length !== lenses.length) errors.push("refutation lenses contain an unknown review lens");
    if (!roster.ok) errors.push(...roster.error.violations.map(({ kind }) => `verifier roster: ${kind}`));
    if (runId.ok && lenses !== null && roster.ok) {
      errors.push(...rosterAuthorityErrors(
        roster.value,
        runId.value,
        "refutation-panel",
        "review-verifier-agent",
        lenses,
        "verifier",
        findings.map(({ id }) => id),
        identityRunId.ok ? identityRunId.value : runId.value,
      ));
    }
    if (errors.length > 0 || !runId.ok || !identityRunId.ok || !roster.ok || parsedLenses.length === 0 || findings.length === 0) {
      return persistentFailure(panelError("refutation", "invalid-authority", errors.join("; ") || "refutation authority is invalid"));
    }
    return persistentSuccess(Object.freeze({
      schemaVersion: 2 as const,
      panel: "refutation" as const,
      runId: runId.value,
      identityRunId: identityRunId.value,
      findings: Object.freeze(findings) as readonly [BriefFinding, ...BriefFinding[]],
      lenses: Object.freeze(parsedLenses) as readonly [ReviewLens, ...ReviewLens[]],
      verifierRoster: roster.value,
    }));
  } catch {
    return persistentFailure(panelError("refutation", "invalid-authority", "refutation authority could not be safely inspected"));
  }
}

export type ArchitectureCandidateResult = Readonly<{ lens: PanelLens; candidate: CandidateFilename; artifact: string }>;

export type PanelRequestIdentity = Readonly<{
  schemaVersion: 1;
  kind: "panel-request-identity";
  requestId: RequestId;
  issuance: Readonly<{
    schemaVersion: 1;
    kind: "issued-spawn-request-proof";
    runId: OrchestrationRunId;
    effectId: EffectId;
    publicationDigest: ArtifactDigest;
    batchIndex: number;
  }>;
}>;

export type DurableAcceptedPanelResult<T> = Readonly<{
  schemaVersion: 1;
  kind: "panel-result-accepted";
  request: PanelRequestIdentity;
  value: T;
}>;

type OpenSlot<Result> =
  | Readonly<{ slotId: SlotId; status: "pending"; nextAttempt: SemanticAttempt }>
  | Readonly<{ slotId: SlotId; status: "accepted"; result: DurableAcceptedPanelResult<Result> }>;

type AcceptedSlot<Result> = Extract<OpenSlot<Result>, Readonly<{ status: "accepted" }>>;
type CompleteSlotProgress<Result> = NonEmpty<AcceptedSlot<Result>>;

declare const ARCHITECTURE_PANEL_STATE: unique symbol;
declare const REFUTATION_PANEL_STATE: unique symbol;

type ArchitecturePanelStateBrand = Readonly<{ [ARCHITECTURE_PANEL_STATE]: "ArchitecturePanelState" }>;
type RefutationPanelStateBrand = Readonly<{ [REFUTATION_PANEL_STATE]: "RefutationPanelState" }>;

interface PersistentArchitectureBase {
  readonly panel: "architecture";
  readonly authority: ArchitecturePanelAuthority;
}

type ArchitecturePanelStateData =
  | Readonly<PersistentArchitectureBase & { stage: "awaiting-candidates"; slots: NonEmpty<OpenSlot<ArchitectureCandidateResult>> }>
  | Readonly<PersistentArchitectureBase & {
      stage: "awaiting-judges";
      candidateSlots: CompleteSlotProgress<ArchitectureCandidateResult>;
      slots: NonEmpty<OpenSlot<JudgeVerdict>>;
    }>
  | Readonly<PersistentArchitectureBase & {
      stage: "ready-to-aggregate";
      candidateSlots: CompleteSlotProgress<ArchitectureCandidateResult>;
      judgeSlots: CompleteSlotProgress<JudgeVerdict>;
    }>
  | Readonly<PersistentArchitectureBase & {
      stage: "done";
      candidateSlots: CompleteSlotProgress<ArchitectureCandidateResult>;
      judgeSlots: CompleteSlotProgress<JudgeVerdict>;
      ranking: readonly CandidateRanking[];
    }>
  | Readonly<PersistentArchitectureBase & {
      stage: "terminal-blocked";
      failedStage: "candidates";
      slots: NonEmpty<OpenSlot<ArchitectureCandidateResult>>;
      diagnostic: TerminalBlockedDiagnostic;
    }>
  | Readonly<PersistentArchitectureBase & {
      stage: "terminal-blocked";
      failedStage: "judges";
      candidateSlots: CompleteSlotProgress<ArchitectureCandidateResult>;
      slots: NonEmpty<OpenSlot<JudgeVerdict>>;
      diagnostic: TerminalBlockedDiagnostic;
    }>;

/** Opaque parser/reducer-produced view. Slot progress is its sole result authority. */
export type ArchitecturePanelState = ArchitecturePanelStateData & ArchitecturePanelStateBrand;

interface PersistentRefutationBase {
  readonly panel: "refutation";
  readonly authority: RefutationPanelAuthority;
  readonly slots: NonEmpty<OpenSlot<VerdictEnvelope<RefutationVerdict>>>;
}

export type RefutationDecision = Readonly<{
  threshold: number;
  lenses: readonly ReviewLens[];
  verdicts: readonly VerdictEnvelope<RefutationVerdict>[];
  outcomes: readonly FindingOutcome[];
  retained: readonly FindingOutcome[];
  refuted: readonly FindingOutcome[];
}>;

type RefutationPanelStateData =
  | Readonly<PersistentRefutationBase & { stage: "awaiting-verdicts" }>
  | Readonly<PersistentRefutationBase & { stage: "ready-to-tally" }>
  | Readonly<PersistentRefutationBase & { stage: "done"; decision: RefutationDecision }>
  | Readonly<PersistentRefutationBase & { stage: "terminal-blocked"; diagnostic: TerminalBlockedDiagnostic }>;

/** Opaque parser/reducer-produced view. Slot progress is its sole result authority. */
export type RefutationPanelState = RefutationPanelStateData & RefutationPanelStateBrand;

export type ArchitecturePanelAction =
  | Readonly<{ kind: "spawn-architecture-candidates"; runId: OrchestrationRunId; requests: NonEmpty<AgentRequestAuthority> }>
  | Readonly<{ kind: "spawn-architecture-judges"; runId: OrchestrationRunId; requests: NonEmpty<AgentRequestAuthority> }>
  | Readonly<{ kind: "architecture-aggregate-ready"; runId: OrchestrationRunId }>
  | Readonly<{ kind: "architecture-blocked"; runId: OrchestrationRunId; diagnostic: BlockedDiagnostic }>
  | Readonly<{ kind: "architecture-done"; runId: OrchestrationRunId; ranking: readonly CandidateRanking[] }>;

export type RefutationPanelAction =
  | Readonly<{ kind: "spawn-refutation-verifiers"; runId: OrchestrationRunId; requests: NonEmpty<AgentRequestAuthority> }>
  | Readonly<{ kind: "refutation-tally-ready"; runId: OrchestrationRunId }>
  | Readonly<{ kind: "refutation-blocked"; runId: OrchestrationRunId; diagnostic: BlockedDiagnostic }>
  | Readonly<{ kind: "refutation-done"; runId: OrchestrationRunId; decision: RefutationDecision }>;

export type PersistentArchitecturePanelEvent =
  | Readonly<{ schemaVersion: 1; type: "architecture-candidate-accepted"; request: PanelRequestIdentity; value: ArchitectureCandidateResult }>
  | Readonly<{ schemaVersion: 1; type: "architecture-candidate-rejected"; request: PanelRequestIdentity; attempt: SemanticAttempt; category: "malformed-result" | "result-binding-mismatch"; message: string }>
  | Readonly<{ schemaVersion: 1; type: "architecture-judge-accepted"; request: PanelRequestIdentity; value: JudgeVerdict }>
  | Readonly<{ schemaVersion: 1; type: "architecture-judge-rejected"; request: PanelRequestIdentity; attempt: SemanticAttempt; category: "malformed-result" | "result-binding-mismatch"; message: string }>
  | Readonly<{ schemaVersion: 1; type: "architecture-ranking-completed"; ranking: readonly CandidateRanking[] }>;

export type PersistentRefutationPanelEvent =
  | Readonly<{ schemaVersion: 1; type: "refutation-verdict-accepted"; request: PanelRequestIdentity; value: VerdictEnvelope<RefutationVerdict> }>
  | Readonly<{ schemaVersion: 1; type: "refutation-verdict-rejected"; request: PanelRequestIdentity; attempt: SemanticAttempt; category: "malformed-result" | "result-binding-mismatch"; message: string }>
  | Readonly<{ schemaVersion: 1; type: "refutation-tally-completed"; decision: RefutationDecision }>;

export type PersistentArchitectureStep = Readonly<{ state: ArchitecturePanelState; action: ArchitecturePanelAction | null; recordedEvent?: PersistentArchitecturePanelEvent }>;
export type PersistentRefutationStep = Readonly<{ state: RefutationPanelState; action: RefutationPanelAction | null; recordedEvent?: PersistentRefutationPanelEvent }>;

declare const PERSISTENT_ARCHITECTURE_HISTORY: unique symbol;
declare const PERSISTENT_REFUTATION_HISTORY: unique symbol;

export type PersistentArchitecturePanelHistory = Readonly<{
  panel: "architecture";
  authority: ArchitecturePanelAuthority;
  events: readonly PersistentArchitecturePanelEvent[];
  readonly [PERSISTENT_ARCHITECTURE_HISTORY]: "PersistentArchitecturePanelHistory";
}>;
export type PersistentRefutationPanelHistory = Readonly<{
  panel: "refutation";
  authority: RefutationPanelAuthority;
  events: readonly PersistentRefutationPanelEvent[];
  readonly [PERSISTENT_REFUTATION_HISTORY]: "PersistentRefutationPanelHistory";
}>;

const architectureStateProofs = new WeakSet<object>();
const refutationStateProofs = new WeakSet<object>();
const architectureEventProofs = new WeakSet<object>();
const refutationEventProofs = new WeakSet<object>();
const architectureRecordedStepProofs = new WeakSet<object>();
const refutationRecordedStepProofs = new WeakSet<object>();
const architectureHistoryProofs = new WeakSet<object>();
const refutationHistoryProofs = new WeakSet<object>();
const architectureJudgeRosterProofs = new WeakMap<object, ArchitecturePanelAuthority>();
const refutationRosterProofs = new WeakMap<object, RefutationPanelAuthority>();

function architectureState<T extends ArchitecturePanelStateData>(state: T): T & ArchitecturePanelStateBrand {
  architectureStateProofs.add(state);
  return state as T & ArchitecturePanelStateBrand;
}
function refutationState<T extends RefutationPanelStateData>(state: T): T & RefutationPanelStateBrand {
  refutationStateProofs.add(state);
  return state as T & RefutationPanelStateBrand;
}
function architectureEvent<T extends PersistentArchitecturePanelEvent>(event: T): T {
  architectureEventProofs.add(event);
  return event;
}
function refutationEvent<T extends PersistentRefutationPanelEvent>(event: T): T {
  refutationEventProofs.add(event);
  return event;
}
function architectureRecordedStep(step: PersistentArchitectureStep & Readonly<{ recordedEvent: PersistentArchitecturePanelEvent }>): PersistentArchitectureStep {
  architectureRecordedStepProofs.add(step);
  return step;
}
function refutationRecordedStep(step: PersistentRefutationStep & Readonly<{ recordedEvent: PersistentRefutationPanelEvent }>): PersistentRefutationStep {
  refutationRecordedStepProofs.add(step);
  return step;
}

function initialSlots<Result>(roster: ExactRoster): NonEmpty<OpenSlot<Result>> {
  return Object.freeze(roster.orderedSlots.map(({ slotId }) => Object.freeze({ slotId, status: "pending" as const, nextAttempt: 1 as const }))) as unknown as NonEmpty<OpenSlot<Result>>;
}

function pendingAuthorities<Result>(roster: ExactRoster, slots: NonEmpty<OpenSlot<Result>>): NonEmpty<AgentRequestAuthority> | null {
  const requests = slots.flatMap((progress) => progress.status === "accepted" ? [] : [requireRosterAttempt(roster, progress.slotId, progress.nextAttempt)]);
  return requests.length === 0 ? null : Object.freeze(requests) as unknown as NonEmpty<AgentRequestAuthority>;
}

function architectureAction(state: ArchitecturePanelState): ArchitecturePanelAction | null {
  if (state.stage === "awaiting-candidates") {
    const requests = pendingAuthorities(state.authority.candidateRoster, state.slots);
    return requests === null ? null : Object.freeze({ kind: "spawn-architecture-candidates", runId: state.authority.runId, requests });
  }
  if (state.stage === "awaiting-judges") {
    const requests = pendingAuthorities(state.authority.judgeRoster, state.slots);
    return requests === null ? null : Object.freeze({ kind: "spawn-architecture-judges", runId: state.authority.runId, requests });
  }
  if (state.stage === "ready-to-aggregate") return Object.freeze({ kind: "architecture-aggregate-ready", runId: state.authority.runId });
  if (state.stage === "terminal-blocked") return Object.freeze({ kind: "architecture-blocked", runId: state.authority.runId, diagnostic: state.diagnostic });
  return Object.freeze({ kind: "architecture-done", runId: state.authority.runId, ranking: state.ranking });
}

function refutationAction(state: RefutationPanelState): RefutationPanelAction | null {
  if (state.stage === "awaiting-verdicts") {
    const requests = pendingAuthorities(state.authority.verifierRoster, state.slots);
    return requests === null ? null : Object.freeze({ kind: "spawn-refutation-verifiers", runId: state.authority.runId, requests });
  }
  if (state.stage === "ready-to-tally") return Object.freeze({ kind: "refutation-tally-ready", runId: state.authority.runId });
  if (state.stage === "terminal-blocked") return Object.freeze({ kind: "refutation-blocked", runId: state.authority.runId, diagnostic: state.diagnostic });
  return Object.freeze({ kind: "refutation-done", runId: state.authority.runId, decision: state.decision });
}

export function startPersistentArchitecturePanel(authority: ArchitecturePanelAuthority): PersistentArchitectureStep {
  const state = architectureState(Object.freeze({
    panel: "architecture" as const, authority, stage: "awaiting-candidates" as const,
    slots: initialSlots<ArchitectureCandidateResult>(authority.candidateRoster),
  }));
  return Object.freeze({ state, action: architectureAction(state) });
}

export function startPersistentRefutationPanel(authority: RefutationPanelAuthority): PersistentRefutationStep {
  const state = refutationState(Object.freeze({
    panel: "refutation" as const, authority, stage: "awaiting-verdicts" as const,
    slots: initialSlots<VerdictEnvelope<RefutationVerdict>>(authority.verifierRoster),
  }));
  return Object.freeze({ state, action: refutationAction(state) });
}

export function resumePersistentArchitecturePanel(state: ArchitecturePanelState): PersistentPanelResult<PersistentArchitectureStep> {
  return architectureStateProofs.has(state)
    ? persistentSuccess(Object.freeze({ state, action: architectureAction(state) }))
    : persistentFailure(panelError("architecture", "malformed-checkpoint", "architecture state must come from start, reduction, replay, or checkpoint parsing"));
}
export function resumePersistentRefutationPanel(state: RefutationPanelState): PersistentPanelResult<PersistentRefutationStep> {
  return refutationStateProofs.has(state)
    ? persistentSuccess(Object.freeze({ state, action: refutationAction(state) }))
    : persistentFailure(panelError("refutation", "malformed-checkpoint", "refutation state must come from start, reduction, replay, or checkpoint parsing"));
}

function findRosterRequest(roster: ExactRoster, requestId: string): AgentRequestAuthority | null {
  for (const slot of roster.orderedSlots) {
    const found = slot.attempts.find((request) => request.requestId === requestId);
    if (found !== undefined) return found;
  }
  return null;
}

/** Proven roster access, the kernel's `requireEntry` analogue. The parser
 *  builds `byId` from the same `orderedSlots` it validates, so every slot has
 *  an entry — the compiler cannot see the link. A miss here is a broken
 *  invariant (never a degraded input): throw with an invariant message, which
 *  the reducers' try/catch converts into a fail-closed malformed-event rather
 *  than a non-null assertion passing a lie downstream. */
function requireRosterEntry(roster: ExactRoster, slotId: SlotId): AgentRosterSlot {
  const slot = roster.byId.get(slotId);
  if (slot === undefined) throw new Error(`panel program invariant: roster has no slot '${slotId}' after parse`);
  return slot;
}

/** Proven attempt access: parseExactRoster enforces exactly two attempts per
 *  slot, so attempt 1|2 always resolves. Miss = broken invariant, thrown. */
function requireRosterAttempt(roster: ExactRoster, slotId: SlotId, attempt: number): AgentRequestAuthority {
  const request = requireRosterEntry(roster, slotId).attempts[attempt - 1];
  if (request === undefined) {
    throw new Error(`panel program invariant: slot '${slotId}' has no attempt ${attempt} after parse`);
  }
  return request;
}

/** Proven request lookup: the caller has already located this request (a
 *  settled outcome), so absence would be a broken invariant, not a degraded
 *  input — throw instead of asserting. */
function requireRosterRequest(roster: ExactRoster, requestId: string): AgentRequestAuthority {
  const found = findRosterRequest(roster, requestId);
  if (found === null) throw new Error(`panel program invariant: request '${requestId}' is not in the roster`);
  return found;
}

function locateProgress<Result>(
  roster: ExactRoster,
  slots: NonEmpty<OpenSlot<Result>>,
  requestId: string,
): PersistentPanelResult<Readonly<{ index: number; slot: OpenSlot<Result>; expected: AgentRequestAuthority }>> {
  const panel = roster.program === "architecture-panel" ? "architecture" : "refutation";
  const authority = findRosterRequest(roster, requestId);
  if (authority === null) return persistentFailure(panelError(panel, "unknown-request", `request ${requestId} is not in the active canonical roster`, { requestId }));
  const index = slots.findIndex(({ slotId }) => slotId === authority.slotId);
  if (index < 0) return persistentFailure(panelError(panel, "unknown-request", `request ${requestId} does not belong to the active panel stage`, { requestId, slotId: authority.slotId }));
  const progress = slots[index]!;
  if (progress.status === "accepted") return persistentFailure(panelError(panel, "duplicate-result", `slot ${progress.slotId} already has an accepted result`, { requestId, slotId: progress.slotId }));
  const expected = requireRosterAttempt(roster, progress.slotId, progress.nextAttempt);
  if (expected.requestId !== requestId) return persistentFailure(panelError(panel, "stale-request", `slot ${progress.slotId} expects attempt ${progress.nextAttempt}, not request ${requestId}`, { requestId, slotId: progress.slotId }));
  return persistentSuccess(Object.freeze({ index, slot: progress, expected }));
}

export function panelRequestIdentity(request: IssuedSpawnRequest): PanelRequestIdentity {
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "panel-request-identity" as const,
    requestId: request.authority.requestId,
    issuance: Object.freeze({ ...request.issuance }),
  });
}

function parsePanelRequestIdentity(raw: unknown): PersistentPanelResult<PanelRequestIdentity> {
  const identity = safeRecord(raw, ["schemaVersion", "kind", "requestId", "issuance"]);
  if (identity === null || identity.schemaVersion !== 1 || identity.kind !== "panel-request-identity") {
    return persistentFailure(panelError("architecture", "malformed-event", "panel request identity tag or schemaVersion is invalid"));
  }
  const requestId = parseRequestId(identity.requestId);
  const issuance = safeRecord(identity.issuance, ["schemaVersion", "kind", "runId", "effectId", "publicationDigest", "batchIndex"]);
  if (!requestId.ok || issuance === null || issuance.schemaVersion !== 1 || issuance.kind !== "issued-spawn-request-proof") {
    return persistentFailure(panelError("architecture", "malformed-event", requestId.ok ? "panel request issuance identity is invalid" : requestId.error.message));
  }
  const runId = parseOrchestrationRunId(issuance.runId);
  const effectId = parseEffectId(issuance.effectId);
  const publicationDigest = parseArtifactDigest(issuance.publicationDigest);
  const batchIndex = typeof issuance.batchIndex === "number" && Number.isSafeInteger(issuance.batchIndex) && issuance.batchIndex >= 0
    ? issuance.batchIndex
    : null;
  if (!runId.ok || !effectId.ok || !publicationDigest.ok || batchIndex === null) {
    return persistentFailure(panelError("architecture", "malformed-event", [
      runId.ok ? null : runId.error.message,
      effectId.ok ? null : effectId.error.message,
      publicationDigest.ok ? null : publicationDigest.error.message,
      batchIndex === null ? "panel request batchIndex must be a non-negative safe integer" : null,
    ].filter((message): message is string => message !== null).join("; ")));
  }
  return persistentSuccess(Object.freeze({
    schemaVersion: 1,
    kind: "panel-request-identity",
    requestId: requestId.value,
    issuance: Object.freeze({
      schemaVersion: 1,
      kind: "issued-spawn-request-proof",
      runId: runId.value,
      effectId: effectId.value,
      publicationDigest: publicationDigest.value,
      batchIndex,
    }),
  }));
}

function rehydrationFailure(panel: "architecture" | "refutation", expected: AgentRequestAuthority, error: Readonly<{ kind: "invalid-accepted-agent-result"; field?: string; message: string }>): PersistentPanelResult<never> {
  const cause = Object.freeze({ kind: error.kind, ...(error.field === undefined ? {} : { field: error.field }), message: boundedPanelMessage(error.message) });
  return persistentFailure(panelError(panel, "request-rehydration-failed", `request ${expected.requestId} could not be rehydrated: ${cause.message}`, {
    requestId: expected.requestId, slotId: expected.slotId, rehydration: cause,
  }));
}

function resolvePanelRequest(
  panel: "architecture" | "refutation",
  roster: ExactRoster,
  identityRaw: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<Readonly<{ identity: PanelRequestIdentity; request: IssuedSpawnRequest; expected: AgentRequestAuthority }>> {
  const identity = parsePanelRequestIdentity(identityRaw);
  if (!identity.ok) return persistentFailure(panelError(panel, identity.error.kind, identity.error.message));
  const expected = findRosterRequest(roster, identity.value.requestId);
  if (expected === null) return persistentFailure(panelError(panel, "unknown-request", `request ${identity.value.requestId} is not in the canonical roster`, { requestId: identity.value.requestId }));
  const issued = parseIssuedSpawnRequest(resolver, {
    authority: expected,
    context: { digest: expected.contextDigest, slot: `contexts/${expected.contextDigest}.json` },
    issuance: identity.value.issuance,
  });
  if (!issued.ok) return rehydrationFailure(panel, expected, issued.error);
  if (!authorityMatches(issued.value.authority, expected)) {
    return persistentFailure(panelError(panel, "request-binding-mismatch", "rehydrated request does not match the exact canonical panel slot", { requestId: expected.requestId, slotId: expected.slotId }));
  }
  return persistentSuccess(Object.freeze({ identity: identity.value, request: issued.value, expected }));
}

function orderedAccepted<Result>(roster: ExactRoster, slots: NonEmpty<OpenSlot<Result>>): readonly DurableAcceptedPanelResult<Result>[] {
  return Object.freeze(roster.orderedSlots.flatMap(({ slotId }) => {
    const slot = slots.find((candidate) => candidate.slotId === slotId);
    return slot?.status === "accepted" ? [slot.result] : [];
  }));
}

function completeSlotProgress<Result>(slots: NonEmpty<OpenSlot<Result>>): CompleteSlotProgress<Result> | null {
  return slots.every((slot): slot is AcceptedSlot<Result> => slot.status === "accepted")
    ? slots as CompleteSlotProgress<Result>
    : null;
}

/** Canonical accepted candidate projection, derived only from slot progress. */
export function selectAcceptedArchitectureCandidates(
  state: ArchitecturePanelState,
): readonly DurableAcceptedPanelResult<ArchitectureCandidateResult>[] {
  const slots = state.stage === "awaiting-candidates" ||
      (state.stage === "terminal-blocked" && state.failedStage === "candidates")
    ? state.slots
    : state.candidateSlots;
  return orderedAccepted(state.authority.candidateRoster, slots);
}

/** Canonical accepted judge projection, derived only from slot progress. */
export function selectAcceptedArchitectureJudges(
  state: ArchitecturePanelState,
): readonly DurableAcceptedPanelResult<JudgeVerdict>[] {
  if (state.stage === "awaiting-candidates" ||
      (state.stage === "terminal-blocked" && state.failedStage === "candidates")) return Object.freeze([]);
  const slots = state.stage === "awaiting-judges" || state.stage === "terminal-blocked"
    ? state.slots
    : state.judgeSlots;
  return orderedAccepted(state.authority.judgeRoster, slots);
}

/** Canonical accepted verdict projection, derived only from slot progress. */
export function selectAcceptedRefutationVerdicts(
  state: RefutationPanelState,
): readonly DurableAcceptedPanelResult<VerdictEnvelope<RefutationVerdict>>[] {
  return orderedAccepted(state.authority.verifierRoster, state.slots);
}

function replaceSlot<Result>(slots: NonEmpty<OpenSlot<Result>>, index: number, replacement: OpenSlot<Result>): NonEmpty<OpenSlot<Result>> {
  return Object.freeze(slots.map((slot, candidateIndex) => candidateIndex === index ? replacement : slot)) as unknown as NonEmpty<OpenSlot<Result>>;
}

function settleAccepted<Result>(
  panel: "architecture" | "refutation",
  roster: ExactRoster,
  slots: NonEmpty<OpenSlot<Result>>,
  result: DurableAcceptedPanelResult<Result>,
): PersistentPanelResult<NonEmpty<OpenSlot<Result>>> {
  const located = locateProgress(roster, slots, result.request.requestId);
  if (!located.ok) return located;
  return persistentSuccess(replaceSlot(slots, located.value.index, Object.freeze({
    slotId: located.value.expected.slotId,
    status: "accepted" as const,
    result,
  })));
}

function retryDiagnostic(roster: ExactRoster, slotId: SlotId, category: "malformed-result" | "result-binding-mismatch", message: string): BlockedDiagnostic | null {
  const slot = roster.byId.get(slotId);
  if (slot === undefined) return null;
  const diagnostic = semanticRetryDiagnostic({ category, failedRequest: slot.attempts[0], retryRequest: slot.attempts[1], message });
  return diagnostic.ok ? diagnostic.value : null;
}

function settleRejected<Result>(
  panel: "architecture" | "refutation",
  roster: ExactRoster,
  slots: NonEmpty<OpenSlot<Result>>,
  event: Readonly<{ request: PanelRequestIdentity; attempt: SemanticAttempt; category: "malformed-result" | "result-binding-mismatch"; message: string }>,
): PersistentPanelResult<Readonly<{ slots?: NonEmpty<OpenSlot<Result>>; diagnostic: BlockedDiagnostic; terminal: boolean }>> {
  const located = locateProgress(roster, slots, event.request.requestId);
  if (!located.ok) return located;
  if (event.attempt !== located.value.expected.attempt) return persistentFailure(panelError(panel, "stale-request", `expected attempt ${located.value.expected.attempt}, received ${event.attempt}`, { requestId: event.request.requestId, slotId: located.value.expected.slotId }));
  const message = sanitizeProse(event.message);
  if (message.length === 0) return persistentFailure(panelError(panel, "malformed-result", "rejection message must be non-empty after sanitization"));
  if (event.attempt === 1) {
    const diagnostic = retryDiagnostic(roster, located.value.expected.slotId, event.category, message);
    if (diagnostic === null) return persistentFailure(panelError(panel, "invalid-authority", "cannot construct retry diagnostic"));
    return persistentSuccess(Object.freeze({
      slots: replaceSlot(slots, located.value.index, Object.freeze({ slotId: located.value.expected.slotId, status: "pending" as const, nextAttempt: 2 as const })),
      diagnostic, terminal: false,
    }));
  }
  const terminal = terminalBlockedDiagnostic({ category: event.category, failedRequest: located.value.expected as AgentRequestAuthority<2>, message });
  if (!terminal.ok) return persistentFailure(panelError(panel, "invalid-authority", terminal.error.message));
  return persistentSuccess(Object.freeze({ diagnostic: terminal.value, terminal: true }));
}

function parseCandidateClaim(raw: unknown, expectedLens: PanelLens, expectedCandidate: CandidateFilename): PersistentPanelResult<ArchitectureCandidateResult> {
  const candidate = safeRecord(raw, ["lens", "candidate", "artifact"]);
  const artifact = candidate !== null && typeof candidate.artifact === "string" ? candidate.artifact : "";
  if (candidate === null || typeof candidate.lens !== "string" || typeof candidate.candidate !== "string" || artifact.trim().length === 0) {
    return persistentFailure(panelError("architecture", "malformed-result", "candidate result must contain lens, candidate, and a non-empty artifact"));
  }
  if (candidate.lens !== expectedLens || candidate.candidate !== expectedCandidate) {
    return persistentFailure(panelError("architecture", "request-binding-mismatch", "caller candidate/lens claims do not match the canonical request slot"));
  }
  return persistentSuccess(Object.freeze({ lens: expectedLens, candidate: expectedCandidate, artifact }));
}

function parseCanonicalJudge(raw: unknown, authority: ArchitecturePanelAuthority, expectedCriterion: ArchitectureCriterion): DomainResult<JudgeVerdict, Readonly<{ message: string }>> {
  try {
    const record = safeRecord(raw, ["criterion", "entries"]);
    if (record === null || record.criterion !== expectedCriterion) return { ok: false, error: { message: `judge criterion must match canonical request slot '${expectedCriterion}'` } };
    const entries = safeArray(record.entries);
    if (entries === null) return { ok: false, error: { message: "judge entries must be an array" } };
    const external = {
      criterion: expectedCriterion,
      rankings: entries.map((entry) => {
        const ranking = safeRecord(entry, ["candidate", "score", "fatalFlaw", "strongestIdea"]);
        return ranking === null ? null : { candidate: ranking.candidate, score: ranking.score, fatal_flaw: ranking.fatalFlaw, strongest_idea: ranking.strongestIdea };
      }),
    };
    const parsed = parseJudgeVerdict(JSON.stringify(external), expectedCriterion, authority.candidateIds);
    return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, error: { message: parsed.errors.join("; ") } };
  } catch {
    return { ok: false, error: { message: "judge result could not be safely parsed" } };
  }
}

function parseCanonicalRefutation(raw: unknown, authority: RefutationPanelAuthority, expectedLens: ReviewLens): DomainResult<VerdictEnvelope<RefutationVerdict>, Readonly<{ message: string }>> {
  try {
    const record = safeRecord(raw, ["criterion", "entries"]);
    if (record === null || record.criterion !== expectedLens) return { ok: false, error: { message: `refutation lens must match canonical request slot '${expectedLens}'` } };
    const entries = safeArray(record.entries);
    if (entries === null) return { ok: false, error: { message: "refutation entries must be an array" } };
    const external = {
      criterion: expectedLens,
      verdicts: entries.map((entry) => {
        const verdict = safeRecord(entry, ["findingId", "verdict", "reasoning"]);
        return verdict === null ? null : { finding_id: verdict.findingId, verdict: verdict.verdict, reasoning: verdict.reasoning };
      }),
    };
    const parsed = parseRefutationVerdict(JSON.stringify(external), expectedLens, authority.findings.map(({ id }) => id));
    return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, error: { message: parsed.errors.join("; ") } };
  } catch {
    return { ok: false, error: { message: "refutation result could not be safely parsed" } };
  }
}

function parseRejection<Result>(
  raw: Readonly<Record<string, unknown>>,
  panel: "architecture" | "refutation",
  roster: ExactRoster,
  slots: NonEmpty<OpenSlot<Result>>,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<Readonly<{ request: PanelRequestIdentity; attempt: SemanticAttempt; category: "malformed-result" | "result-binding-mismatch"; message: string }>> {
  const resolved = resolvePanelRequest(panel, roster, raw.request, resolver);
  if (!resolved.ok) return resolved;
  const located = locateProgress(roster, slots, resolved.value.expected.requestId);
  if (!located.ok) return located;
  const attempt = raw.attempt === 1 || raw.attempt === 2 ? raw.attempt : null;
  const category = raw.category === "malformed-result" || raw.category === "result-binding-mismatch" ? raw.category : null;
  const message = typeof raw.message === "string" ? sanitizeProse(raw.message) : "";
  if (attempt === null || category === null || message.length === 0) {
    return persistentFailure(panelError(panel, "malformed-event", "rejection event requires issued request identity, attempt, category, and non-empty sanitized message"));
  }
  if (attempt !== resolved.value.expected.attempt) {
    return persistentFailure(panelError(panel, "stale-request", `expected attempt ${resolved.value.expected.attempt}, received ${attempt}`, {
      requestId: resolved.value.expected.requestId,
      slotId: resolved.value.expected.slotId,
    }));
  }
  return persistentSuccess(Object.freeze({ request: resolved.value.identity, attempt, category, message }));
}

function jsonEqual(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

export function parsePersistentArchitecturePanelEvent(
  state: ArchitecturePanelState,
  raw: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<PersistentArchitecturePanelEvent> {
  if (!architectureStateProofs.has(state)) return persistentFailure(panelError("architecture", "malformed-checkpoint", "event parsing requires a parser-produced architecture state"));
  const envelope = safeRecord(raw, ["schemaVersion", "type", "request", "value", "attempt", "category", "message", "ranking"]);
  if (envelope === null || envelope.schemaVersion !== 1 || typeof envelope.type !== "string") return persistentFailure(panelError("architecture", "malformed-event", "architecture event must be an exact schemaVersion 1 data record"));
  if (envelope.type === "architecture-candidate-accepted") {
    const exact = safeRecord(raw, ["schemaVersion", "type", "request", "value"]);
    if (exact === null || state.stage !== "awaiting-candidates") return persistentFailure(panelError("architecture", "unexpected-event", `candidate result is not accepted during ${state.stage}`));
    const resolved = resolvePanelRequest("architecture", state.authority.candidateRoster, exact.request, resolver);
    if (!resolved.ok) return resolved;
    const located = locateProgress(state.authority.candidateRoster, state.slots, resolved.value.expected.requestId);
    if (!located.ok) return located;
    const bound = boundCandidateEntry(state.authority, resolved.value.expected.slotId);
    if (!bound.ok) return bound;
    const value = parseCandidateClaim(exact.value, bound.value.lens, bound.value.candidate);
    if (!value.ok) return value;
    return persistentSuccess(architectureEvent(Object.freeze({ schemaVersion: 1, type: "architecture-candidate-accepted", request: resolved.value.identity, value: value.value })));
  }
  if (envelope.type === "architecture-judge-accepted") {
    const exact = safeRecord(raw, ["schemaVersion", "type", "request", "value"]);
    if (exact === null || state.stage !== "awaiting-judges") return persistentFailure(panelError("architecture", "unexpected-event", `judge result is not accepted during ${state.stage}`));
    const resolved = resolvePanelRequest("architecture", state.authority.judgeRoster, exact.request, resolver);
    if (!resolved.ok) return resolved;
    const located = locateProgress(state.authority.judgeRoster, state.slots, resolved.value.expected.requestId);
    if (!located.ok) return located;
    const index = state.authority.judgeRoster.orderedSlots.findIndex(({ slotId }) => slotId === resolved.value.expected.slotId);
    const value = parseCanonicalJudge(exact.value, state.authority, state.authority.judgeCriteria[index]!);
    if (!value.ok) return persistentFailure(panelError("architecture", "request-binding-mismatch", value.error.message, { requestId: resolved.value.expected.requestId, slotId: resolved.value.expected.slotId }));
    return persistentSuccess(architectureEvent(Object.freeze({ schemaVersion: 1, type: "architecture-judge-accepted", request: resolved.value.identity, value: value.value })));
  }
  if (envelope.type === "architecture-candidate-rejected" || envelope.type === "architecture-judge-rejected") {
    const exact = safeRecord(raw, ["schemaVersion", "type", "request", "attempt", "category", "message"]);
    if (exact === null) return persistentFailure(panelError("architecture", "malformed-event", "architecture rejection event contains unknown or missing fields"));
    if (envelope.type === "architecture-candidate-rejected" && state.stage !== "awaiting-candidates") {
      return persistentFailure(panelError("architecture", "unexpected-event", `candidate rejection is not accepted during ${state.stage}`));
    }
    if (envelope.type === "architecture-judge-rejected" && state.stage !== "awaiting-judges") {
      return persistentFailure(panelError("architecture", "unexpected-event", `judge rejection is not accepted during ${state.stage}`));
    }
    const rejection = envelope.type === "architecture-candidate-rejected" && state.stage === "awaiting-candidates"
      ? parseRejection(exact, "architecture", state.authority.candidateRoster, state.slots, resolver)
      : state.stage === "awaiting-judges"
        ? parseRejection(exact, "architecture", state.authority.judgeRoster, state.slots, resolver)
        : persistentFailure(panelError("architecture", "unexpected-event", `rejection is not accepted during ${state.stage}`));
    if (!rejection.ok) return rejection;
    return persistentSuccess(architectureEvent(Object.freeze({ schemaVersion: 1, type: envelope.type, ...rejection.value })));
  }
  if (envelope.type === "architecture-ranking-completed") {
    const exact = safeRecord(raw, ["schemaVersion", "type", "ranking"]);
    if (exact === null || state.stage !== "ready-to-aggregate") return persistentFailure(panelError("architecture", "unexpected-event", `ranking is not available during ${state.stage}`));
    const proof = proveArchitectureJudgeRoster(state, resolver);
    if (!proof.ok) return proof;
    const ranking = aggregateArchitecturePanel(state.authority, proof.value);
    if (!ranking.ok) return ranking;
    if (!jsonEqual(exact.ranking, ranking.value)) return persistentFailure(panelError("architecture", "invalid-aggregate", "persisted ranking does not equal the deterministic complete-roster aggregate"));
    return persistentSuccess(architectureEvent(Object.freeze({ schemaVersion: 1, type: "architecture-ranking-completed", ranking: ranking.value })));
  }
  return persistentFailure(panelError("architecture", "malformed-event", `unknown architecture event type: ${envelope.type}`));
}

export function parsePersistentRefutationPanelEvent(
  state: RefutationPanelState,
  raw: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<PersistentRefutationPanelEvent> {
  if (!refutationStateProofs.has(state)) return persistentFailure(panelError("refutation", "malformed-checkpoint", "event parsing requires a parser-produced refutation state"));
  const envelope = safeRecord(raw, ["schemaVersion", "type", "request", "value", "attempt", "category", "message", "decision"]);
  if (envelope === null || envelope.schemaVersion !== 1 || typeof envelope.type !== "string") return persistentFailure(panelError("refutation", "malformed-event", "refutation event must be an exact schemaVersion 1 data record"));
  if (envelope.type === "refutation-verdict-accepted") {
    const exact = safeRecord(raw, ["schemaVersion", "type", "request", "value"]);
    if (exact === null || state.stage !== "awaiting-verdicts") return persistentFailure(panelError("refutation", "unexpected-event", `verdict is not accepted during ${state.stage}`));
    const resolved = resolvePanelRequest("refutation", state.authority.verifierRoster, exact.request, resolver);
    if (!resolved.ok) return resolved;
    const located = locateProgress(state.authority.verifierRoster, state.slots, resolved.value.expected.requestId);
    if (!located.ok) return located;
    const boundLens = boundRefutationLens(state.authority, resolved.value.expected.slotId);
    if (!boundLens.ok) return boundLens;
    const value = parseCanonicalRefutation(exact.value, state.authority, boundLens.value);
    if (!value.ok) return persistentFailure(panelError("refutation", "request-binding-mismatch", value.error.message, { requestId: resolved.value.expected.requestId, slotId: resolved.value.expected.slotId }));
    return persistentSuccess(refutationEvent(Object.freeze({ schemaVersion: 1, type: "refutation-verdict-accepted", request: resolved.value.identity, value: value.value })));
  }
  if (envelope.type === "refutation-verdict-rejected") {
    const exact = safeRecord(raw, ["schemaVersion", "type", "request", "attempt", "category", "message"]);
    if (exact === null) return persistentFailure(panelError("refutation", "malformed-event", "refutation rejection event contains unknown or missing fields"));
    if (state.stage !== "awaiting-verdicts") {
      return persistentFailure(panelError("refutation", "unexpected-event", `verdict rejection is not accepted during ${state.stage}`));
    }
    const rejection = parseRejection(exact, "refutation", state.authority.verifierRoster, state.slots, resolver);
    if (!rejection.ok) return rejection;
    return persistentSuccess(refutationEvent(Object.freeze({ schemaVersion: 1, type: "refutation-verdict-rejected", ...rejection.value })));
  }
  if (envelope.type === "refutation-tally-completed") {
    const exact = safeRecord(raw, ["schemaVersion", "type", "decision"]);
    if (exact === null || state.stage !== "ready-to-tally") return persistentFailure(panelError("refutation", "unexpected-event", `tally is not available during ${state.stage}`));
    const proof = proveRefutationRoster(state, resolver);
    if (!proof.ok) return proof;
    const rawDecision = safeRecord(exact.decision, ["threshold", "lenses", "verdicts", "outcomes", "retained", "refuted"]);
    const threshold = rawDecision?.threshold;
    if (typeof threshold !== "number") return persistentFailure(panelError("refutation", "invalid-aggregate", "persisted decision threshold is malformed"));
    const decision = tallyRefutationPanel(state.authority, proof.value, threshold);
    if (!decision.ok) return decision;
    if (!jsonEqual(exact.decision, decision.value)) return persistentFailure(panelError("refutation", "invalid-aggregate", "persisted decision does not equal the deterministic complete-roster tally"));
    return persistentSuccess(refutationEvent(Object.freeze({ schemaVersion: 1, type: "refutation-tally-completed", decision: decision.value })));
  }
  return persistentFailure(panelError("refutation", "malformed-event", `unknown refutation event type: ${envelope.type}`));
}

function durableAccepted<T>(request: PanelRequestIdentity, value: T): DurableAcceptedPanelResult<T> {
  return Object.freeze({ schemaVersion: 1, kind: "panel-result-accepted", request, value });
}

function terminalArchitecture(state: ArchitecturePanelState): PersistentPanelResult<PersistentArchitectureStep> {
  return persistentFailure(panelError("architecture", "terminal-state", `architecture panel is ${state.stage} and cannot transition`));
}
function terminalRefutation(state: RefutationPanelState): PersistentPanelResult<PersistentRefutationStep> {
  return persistentFailure(panelError("refutation", "terminal-state", `refutation panel is ${state.stage} and cannot transition`));
}

export function reducePersistentArchitecturePanel(state: ArchitecturePanelState, event: PersistentArchitecturePanelEvent): PersistentPanelResult<PersistentArchitectureStep> {
  try {
    if (!architectureStateProofs.has(state)) return persistentFailure(panelError("architecture", "malformed-checkpoint", "architecture reducer requires a parser-produced state"));
    if (state.stage === "done" || state.stage === "terminal-blocked") return terminalArchitecture(state);
    if (typeof event !== "object" || event === null || !architectureEventProofs.has(event)) return persistentFailure(panelError("architecture", "malformed-event", "architecture reducer requires a strictly parsed durable event"));
    if (event.type === "architecture-candidate-accepted") {
      if (state.stage !== "awaiting-candidates") return persistentFailure(panelError("architecture", "unexpected-event", `candidate result is not accepted during ${state.stage}`));
      const result = durableAccepted(event.request, event.value);
      const settled = settleAccepted("architecture", state.authority.candidateRoster, state.slots, result);
      if (!settled.ok) return settled;
      const complete = completeSlotProgress(settled.value);
      const next = complete !== null
        ? architectureState(Object.freeze({
            panel: "architecture" as const,
            authority: state.authority,
            stage: "awaiting-judges" as const,
            candidateSlots: complete,
            slots: initialSlots<JudgeVerdict>(state.authority.judgeRoster),
          }))
        : architectureState(Object.freeze({ ...state, slots: settled.value }));
      return persistentSuccess(Object.freeze({ state: next, action: next.stage === "awaiting-candidates" ? null : architectureAction(next) }));
    }
    if (event.type === "architecture-candidate-rejected") {
      if (state.stage !== "awaiting-candidates") return persistentFailure(panelError("architecture", "unexpected-event", `candidate rejection is not accepted during ${state.stage}`));
      const settled = settleRejected("architecture", state.authority.candidateRoster, state.slots, event);
      if (!settled.ok) return settled;
      if (settled.value.terminal) {
        const next = architectureState(Object.freeze({
          panel: "architecture" as const,
          authority: state.authority,
          stage: "terminal-blocked" as const,
          failedStage: "candidates" as const,
          slots: state.slots,
          diagnostic: settled.value.diagnostic as TerminalBlockedDiagnostic,
        }));
        return persistentSuccess(Object.freeze({ state: next, action: architectureAction(next) }));
      }
      const next = architectureState(Object.freeze({ ...state, slots: settled.value.slots! }));
      const retry = requireRosterAttempt(state.authority.candidateRoster, requireRosterRequest(state.authority.candidateRoster, event.request.requestId).slotId, 2);
      return persistentSuccess(Object.freeze({ state: next, action: Object.freeze({ kind: "spawn-architecture-candidates" as const, runId: state.authority.runId, requests: Object.freeze([retry]) as NonEmpty<AgentRequestAuthority> }) }));
    }
    if (event.type === "architecture-judge-accepted") {
      if (state.stage !== "awaiting-judges") return persistentFailure(panelError("architecture", "unexpected-event", `judge result is not accepted during ${state.stage}`));
      const result = durableAccepted(event.request, event.value);
      const settled = settleAccepted("architecture", state.authority.judgeRoster, state.slots, result);
      if (!settled.ok) return settled;
      const complete = completeSlotProgress(settled.value);
      const next = complete !== null
        ? architectureState(Object.freeze({
            panel: "architecture" as const,
            authority: state.authority,
            stage: "ready-to-aggregate" as const,
            candidateSlots: state.candidateSlots,
            judgeSlots: complete,
          }))
        : architectureState(Object.freeze({ ...state, slots: settled.value }));
      return persistentSuccess(Object.freeze({ state: next, action: next.stage === "awaiting-judges" ? null : architectureAction(next) }));
    }
    if (event.type === "architecture-judge-rejected") {
      if (state.stage !== "awaiting-judges") return persistentFailure(panelError("architecture", "unexpected-event", `judge rejection is not accepted during ${state.stage}`));
      const settled = settleRejected("architecture", state.authority.judgeRoster, state.slots, event);
      if (!settled.ok) return settled;
      if (settled.value.terminal) {
        const next = architectureState(Object.freeze({
          panel: "architecture" as const,
          authority: state.authority,
          stage: "terminal-blocked" as const,
          failedStage: "judges" as const,
          candidateSlots: state.candidateSlots,
          slots: state.slots,
          diagnostic: settled.value.diagnostic as TerminalBlockedDiagnostic,
        }));
        return persistentSuccess(Object.freeze({ state: next, action: architectureAction(next) }));
      }
      const next = architectureState(Object.freeze({ ...state, slots: settled.value.slots! }));
      const retry = requireRosterAttempt(state.authority.judgeRoster, requireRosterRequest(state.authority.judgeRoster, event.request.requestId).slotId, 2);
      return persistentSuccess(Object.freeze({ state: next, action: Object.freeze({ kind: "spawn-architecture-judges" as const, runId: state.authority.runId, requests: Object.freeze([retry]) as NonEmpty<AgentRequestAuthority> }) }));
    }
    if (state.stage !== "ready-to-aggregate") return persistentFailure(panelError("architecture", "unexpected-event", `ranking is not available during ${state.stage}`));
    const next = architectureState(Object.freeze({ ...state, stage: "done" as const, ranking: event.ranking }));
    return persistentSuccess(Object.freeze({ state: next, action: architectureAction(next) }));
  } catch {
    return persistentFailure(panelError("architecture", "malformed-event", "architecture event could not be safely reduced"));
  }
}

export function reducePersistentRefutationPanel(state: RefutationPanelState, event: PersistentRefutationPanelEvent): PersistentPanelResult<PersistentRefutationStep> {
  try {
    if (!refutationStateProofs.has(state)) return persistentFailure(panelError("refutation", "malformed-checkpoint", "refutation reducer requires a parser-produced state"));
    if (state.stage === "done" || state.stage === "terminal-blocked") return terminalRefutation(state);
    if (typeof event !== "object" || event === null || !refutationEventProofs.has(event)) return persistentFailure(panelError("refutation", "malformed-event", "refutation reducer requires a strictly parsed durable event"));
    if (event.type === "refutation-verdict-accepted") {
      if (state.stage !== "awaiting-verdicts") return persistentFailure(panelError("refutation", "unexpected-event", `verdict is not accepted during ${state.stage}`));
      const result = durableAccepted(event.request, event.value);
      const settled = settleAccepted("refutation", state.authority.verifierRoster, state.slots, result);
      if (!settled.ok) return settled;
      const complete = completeSlotProgress(settled.value);
      const next = complete !== null
        ? refutationState(Object.freeze({ panel: "refutation" as const, authority: state.authority, stage: "ready-to-tally" as const, slots: complete }))
        : refutationState(Object.freeze({ ...state, slots: settled.value }));
      return persistentSuccess(Object.freeze({ state: next, action: next.stage === "awaiting-verdicts" ? null : refutationAction(next) }));
    }
    if (event.type === "refutation-verdict-rejected") {
      if (state.stage !== "awaiting-verdicts") return persistentFailure(panelError("refutation", "unexpected-event", `verdict rejection is not accepted during ${state.stage}`));
      const settled = settleRejected("refutation", state.authority.verifierRoster, state.slots, event);
      if (!settled.ok) return settled;
      if (settled.value.terminal) {
        const next = refutationState(Object.freeze({
          panel: "refutation" as const,
          authority: state.authority,
          stage: "terminal-blocked" as const,
          slots: state.slots,
          diagnostic: settled.value.diagnostic as TerminalBlockedDiagnostic,
        }));
        return persistentSuccess(Object.freeze({ state: next, action: refutationAction(next) }));
      }
      const next = refutationState(Object.freeze({ ...state, slots: settled.value.slots! }));
      const retry = requireRosterAttempt(state.authority.verifierRoster, requireRosterRequest(state.authority.verifierRoster, event.request.requestId).slotId, 2);
      return persistentSuccess(Object.freeze({ state: next, action: Object.freeze({ kind: "spawn-refutation-verifiers" as const, runId: state.authority.runId, requests: Object.freeze([retry]) as NonEmpty<AgentRequestAuthority> }) }));
    }
    if (state.stage !== "ready-to-tally") return persistentFailure(panelError("refutation", "unexpected-event", `tally is not available during ${state.stage}`));
    const next = refutationState(Object.freeze({ ...state, stage: "done" as const, decision: event.decision }));
    return persistentSuccess(Object.freeze({ state: next, action: refutationAction(next) }));
  } catch {
    return persistentFailure(panelError("refutation", "malformed-event", "refutation event could not be safely reduced"));
  }
}

function rejectionEvent(panel: "architecture" | "refutation", stage: "candidate" | "judge" | "verdict", request: PanelRequestIdentity, expected: AgentRequestAuthority, error: PersistentPanelError): PersistentArchitecturePanelEvent | PersistentRefutationPanelEvent {
  const category: "malformed-result" | "result-binding-mismatch" = error.kind === "request-binding-mismatch"
    ? "result-binding-mismatch"
    : "malformed-result";
  const fields = { schemaVersion: 1 as const, request, attempt: expected.attempt, category, message: error.message };
  if (panel === "refutation") return Object.freeze({ type: "refutation-verdict-rejected" as const, ...fields });
  return stage === "candidate"
    ? Object.freeze({ type: "architecture-candidate-rejected" as const, ...fields })
    : Object.freeze({ type: "architecture-judge-rejected" as const, ...fields });
}

function reduceParsedArchitecture(state: ArchitecturePanelState, rawEvent: PersistentArchitecturePanelEvent, resolver: PublicationAuthorityResolver): PersistentPanelResult<PersistentArchitectureStep> {
  const parsed = parsePersistentArchitecturePanelEvent(state, rawEvent, resolver);
  if (!parsed.ok) return parsed;
  const reduced = reducePersistentArchitecturePanel(state, parsed.value);
  return reduced.ok
    ? persistentSuccess(architectureRecordedStep(Object.freeze({ ...reduced.value, recordedEvent: parsed.value })))
    : reduced;
}
function reduceParsedRefutation(state: RefutationPanelState, rawEvent: PersistentRefutationPanelEvent, resolver: PublicationAuthorityResolver): PersistentPanelResult<PersistentRefutationStep> {
  const parsed = parsePersistentRefutationPanelEvent(state, rawEvent, resolver);
  if (!parsed.ok) return parsed;
  const reduced = reducePersistentRefutationPanel(state, parsed.value);
  return reduced.ok
    ? persistentSuccess(refutationRecordedStep(Object.freeze({ ...reduced.value, recordedEvent: parsed.value })))
    : reduced;
}

export function submitArchitectureCandidateResult(state: ArchitecturePanelState, resolver: PublicationAuthorityResolver, requestIdentity: unknown, raw: unknown): PersistentPanelResult<PersistentArchitectureStep> {
  if (state.stage !== "awaiting-candidates") return persistentFailure(panelError("architecture", "unexpected-event", `candidate cannot be submitted during ${state.stage}`));
  const resolved = resolvePanelRequest("architecture", state.authority.candidateRoster, requestIdentity, resolver);
  if (!resolved.ok) return resolved;
  const located = locateProgress(state.authority.candidateRoster, state.slots, resolved.value.expected.requestId);
  if (!located.ok) return located;
  const bound = boundCandidateEntry(state.authority, resolved.value.expected.slotId);
  if (!bound.ok) return bound;
  const parsed = parseCandidateClaim(raw, bound.value.lens, bound.value.candidate);
  if (!parsed.ok) return reduceParsedArchitecture(state, rejectionEvent("architecture", "candidate", resolved.value.identity, resolved.value.expected, parsed.error) as PersistentArchitecturePanelEvent, resolver);
  return reduceParsedArchitecture(state, Object.freeze({ schemaVersion: 1, type: "architecture-candidate-accepted", request: resolved.value.identity, value: parsed.value }), resolver);
}

function publicResultClaimsForeignAuthority(
  rawJson: unknown,
  expectedCriterion: string,
  collectionField: "rankings" | "verdicts",
  identityField: "candidate" | "finding_id",
  entryFields: readonly string[],
  expectedIdentities: readonly string[],
): boolean {
  if (typeof rawJson !== "string") return false;
  try {
    const root = safeRecord(JSON.parse(rawJson) as unknown, ["criterion", collectionField]);
    if (root === null) return false;
    if (typeof root.criterion === "string" && root.criterion !== expectedCriterion) return true;
    const entries = safeArray(root[collectionField]);
    if (entries === null) return false;
    return entries.some((rawEntry) => {
      const entry = safeRecord(rawEntry, entryFields);
      const claimedIdentity = entry?.[identityField];
      return typeof claimedIdentity === "string" && !expectedIdentities.includes(claimedIdentity);
    });
  } catch {
    return false;
  }
}

export function submitArchitectureJudgeResult(state: ArchitecturePanelState, resolver: PublicationAuthorityResolver, requestIdentity: unknown, rawJson: unknown): PersistentPanelResult<PersistentArchitectureStep> {
  if (state.stage !== "awaiting-judges") return persistentFailure(panelError("architecture", "unexpected-event", `judge cannot be submitted during ${state.stage}`));
  const resolved = resolvePanelRequest("architecture", state.authority.judgeRoster, requestIdentity, resolver);
  if (!resolved.ok) return resolved;
  const located = locateProgress(state.authority.judgeRoster, state.slots, resolved.value.expected.requestId);
  if (!located.ok) return located;
  const index = state.authority.judgeRoster.orderedSlots.findIndex(({ slotId }) => slotId === resolved.value.expected.slotId);
  const criterion = state.authority.judgeCriteria[index]!;
  const parsed: ParseResult<JudgeVerdict> = typeof rawJson === "string" ? parseJudgeVerdict(rawJson, criterion, state.authority.candidateIds) : fail(["judge result must be raw JSON text"]);
  if (!parsed.ok) {
    const kind = publicResultClaimsForeignAuthority(
      rawJson,
      criterion,
      "rankings",
      "candidate",
      ["candidate", "score", "fatal_flaw", "strongest_idea"],
      state.authority.candidateIds,
    ) ? "request-binding-mismatch" : "malformed-result";
    const message = kind === "request-binding-mismatch"
      ? "judge criterion or candidate claims do not match the canonical request slot"
      : parsed.errors.join("; ");
    return reduceParsedArchitecture(state, rejectionEvent("architecture", "judge", resolved.value.identity, resolved.value.expected, panelError("architecture", kind, message)) as PersistentArchitecturePanelEvent, resolver);
  }
  return reduceParsedArchitecture(state, Object.freeze({ schemaVersion: 1, type: "architecture-judge-accepted", request: resolved.value.identity, value: parsed.value }), resolver);
}

export function submitRefutationVerdict(state: RefutationPanelState, resolver: PublicationAuthorityResolver, requestIdentity: unknown, rawJson: unknown): PersistentPanelResult<PersistentRefutationStep> {
  if (state.stage !== "awaiting-verdicts") return persistentFailure(panelError("refutation", "unexpected-event", `verdict cannot be submitted during ${state.stage}`));
  const resolved = resolvePanelRequest("refutation", state.authority.verifierRoster, requestIdentity, resolver);
  if (!resolved.ok) return resolved;
  const located = locateProgress(state.authority.verifierRoster, state.slots, resolved.value.expected.requestId);
  if (!located.ok) return located;
  const boundLens = boundRefutationLens(state.authority, resolved.value.expected.slotId);
  if (!boundLens.ok) return boundLens;
  const lens = boundLens.value;
  const findingIds = state.authority.findings.map(({ id }) => id);
  const parsed: ParseResult<VerdictEnvelope<RefutationVerdict>> = typeof rawJson === "string" ? parseRefutationVerdict(rawJson, lens, findingIds) : fail(["refutation result must be raw JSON text"]);
  if (!parsed.ok) {
    const kind = publicResultClaimsForeignAuthority(
      rawJson,
      lens,
      "verdicts",
      "finding_id",
      ["finding_id", "verdict", "reasoning"],
      findingIds,
    ) ? "request-binding-mismatch" : "malformed-result";
    const message = kind === "request-binding-mismatch"
      ? "refutation criterion or Finding claims do not match the canonical request slot"
      : parsed.errors.join("; ");
    return reduceParsedRefutation(state, rejectionEvent("refutation", "verdict", resolved.value.identity, resolved.value.expected, panelError("refutation", kind, message)) as PersistentRefutationPanelEvent, resolver);
  }
  return reduceParsedRefutation(state, Object.freeze({ schemaVersion: 1, type: "refutation-verdict-accepted", request: resolved.value.identity, value: parsed.value }), resolver);
}

function rehydrateAccepted<T>(panel: "architecture" | "refutation", roster: ExactRoster, accepted: readonly DurableAcceptedPanelResult<T>[], resolver: PublicationAuthorityResolver): PersistentPanelResult<readonly AcceptedAgentResult<T>[]> {
  const results: AcceptedAgentResult<T>[] = [];
  for (const durable of accepted) {
    const resolved = resolvePanelRequest(panel, roster, durable.request, resolver);
    if (!resolved.ok) return resolved;
    const acceptedResult = acceptedAgentResult(resolved.value.request, durable.value);
    if (!acceptedResult.ok) return rehydrationFailure(panel, resolved.value.expected, acceptedResult.error);
    results.push(acceptedResult.value);
  }
  return persistentSuccess(Object.freeze(results));
}

export function proveArchitectureCandidateRoster(state: ArchitecturePanelState, resolver: PublicationAuthorityResolver): PersistentPanelResult<CompleteRoster<AcceptedAgentResult<ArchitectureCandidateResult>>> {
  const accepted = rehydrateAccepted("architecture", state.authority.candidateRoster, selectAcceptedArchitectureCandidates(state), resolver);
  if (!accepted.ok) return accepted;
  const proven = parseCompleteRoster(resolver, state.authority.candidateRoster, accepted.value, (raw) => {
    const record = safeRecord(raw, ["lens", "candidate", "artifact"]);
    if (record === null || typeof record.lens !== "string" || typeof record.candidate !== "string" || typeof record.artifact !== "string" || record.artifact.length === 0) return { ok: false, error: { message: "candidate payload is malformed" } };
    const index = state.authority.candidateLenses.indexOf(record.lens as PanelLens);
    return index < 0 || state.authority.candidateIds[index] !== record.candidate
      ? { ok: false, error: { message: "candidate claims do not match panel authority" } }
      : { ok: true, value: { lens: state.authority.candidateLenses[index]!, candidate: state.authority.candidateIds[index]!, artifact: record.artifact } };
  });
  return proven.ok ? persistentSuccess(proven.value) : persistentFailure(panelError("architecture", "incomplete-roster", proven.error.violations.map(({ kind }) => kind).join("; ")));
}

export function proveArchitectureJudgeRoster(state: ArchitecturePanelState, resolver: PublicationAuthorityResolver): PersistentPanelResult<CompleteRoster<AcceptedAgentResult<JudgeVerdict>>> {
  const accepted = rehydrateAccepted("architecture", state.authority.judgeRoster, selectAcceptedArchitectureJudges(state), resolver);
  if (!accepted.ok) return accepted;
  const proven = parseCompleteRoster(resolver, state.authority.judgeRoster, accepted.value, (raw) => {
    const record = safeRecord(raw, ["criterion", "entries"]);
    const expected = record === null ? undefined : state.authority.judgeCriteria.find((criterion) => criterion === record.criterion);
    return expected === undefined ? { ok: false, error: { message: "judge criterion is not authoritative" } } : parseCanonicalJudge(raw, state.authority, expected);
  });
  if (!proven.ok) return persistentFailure(panelError("architecture", "incomplete-roster", proven.error.violations.map(({ kind }) => kind).join("; ")));
  architectureJudgeRosterProofs.set(proven.value, state.authority);
  return persistentSuccess(proven.value);
}

export function proveRefutationRoster(state: RefutationPanelState, resolver: PublicationAuthorityResolver): PersistentPanelResult<CompleteRoster<AcceptedAgentResult<VerdictEnvelope<RefutationVerdict>>>> {
  const accepted = rehydrateAccepted("refutation", state.authority.verifierRoster, selectAcceptedRefutationVerdicts(state), resolver);
  if (!accepted.ok) return accepted;
  const proven = parseCompleteRoster(resolver, state.authority.verifierRoster, accepted.value, (raw) => {
    const record = safeRecord(raw, ["criterion", "entries"]);
    const expected = record === null ? undefined : state.authority.lenses.find((lens) => lens === record.criterion);
    return expected === undefined ? { ok: false, error: { message: "refutation lens is not authoritative" } } : parseCanonicalRefutation(raw, state.authority, expected);
  });
  if (!proven.ok) return persistentFailure(panelError("refutation", "incomplete-roster", proven.error.violations.map(({ kind }) => kind).join("; ")));
  refutationRosterProofs.set(proven.value, state.authority);
  return persistentSuccess(proven.value);
}

function completeRosterMatches(roster: ExactRoster, complete: CompleteRoster<AcceptedAgentResult<unknown>>): boolean {
  return complete.ordered.length === roster.orderedSlots.length && roster.orderedSlots.every((slot, index) => {
    const result = complete.ordered[index];
    return result !== undefined && result.authority.slotId === slot.slotId && authorityMatches(result.authority, result.authority.attempt === 1 ? slot.attempts[0] : slot.attempts[1]);
  });
}

export function aggregateArchitecturePanel(authority: ArchitecturePanelAuthority, complete: CompleteRoster<AcceptedAgentResult<JudgeVerdict>>): PersistentPanelResult<readonly CandidateRanking[]> {
  try {
    if (architectureJudgeRosterProofs.get(complete) !== authority || !completeRosterMatches(authority.judgeRoster, complete as CompleteRoster<AcceptedAgentResult<unknown>>)) return persistentFailure(panelError("architecture", "incomplete-roster", "complete judge roster is unproved, stale, or belongs to another panel"));
    const aggregated = aggregateVerdicts(complete.ordered.map(({ value }) => value), authority.judgeCriteria, authority.candidateIds);
    return aggregated.ok ? persistentSuccess(Object.freeze([...aggregated.value])) : persistentFailure(panelError("architecture", "invalid-aggregate", aggregated.errors.join("; ")));
  } catch {
    return persistentFailure(panelError("architecture", "invalid-aggregate", "judge roster could not be safely aggregated"));
  }
}

export function tallyRefutationPanel(authority: RefutationPanelAuthority, complete: CompleteRoster<AcceptedAgentResult<VerdictEnvelope<RefutationVerdict>>>, requestedThreshold = defaultRefutationThreshold(authority.lenses.length)): PersistentPanelResult<RefutationDecision> {
  try {
    if (refutationRosterProofs.get(complete) !== authority || !completeRosterMatches(authority.verifierRoster, complete as CompleteRoster<AcceptedAgentResult<unknown>>)) return persistentFailure(panelError("refutation", "incomplete-roster", "complete verifier roster is unproved, stale, or belongs to another panel"));
    const strictMajority = defaultRefutationThreshold(authority.lenses.length);
    if (requestedThreshold !== strictMajority) return persistentFailure(panelError("refutation", "invalid-aggregate", `threshold must equal the derived strict majority ${strictMajority}`));
    const verdicts = complete.ordered.map(({ value }) => value);
    const tallied = tallyRefutations(verdicts, authority.lenses, authority.findings, strictMajority);
    if (!tallied.ok) return persistentFailure(panelError("refutation", "invalid-aggregate", tallied.errors.join("; ")));
    const outcomes = Object.freeze([...tallied.value]);
    return persistentSuccess(Object.freeze({ threshold: strictMajority, lenses: authority.lenses, verdicts: Object.freeze(verdicts), outcomes, retained: Object.freeze(outcomes.filter(({ survives }) => survives)), refuted: Object.freeze(outcomes.filter(({ survives }) => !survives)) }));
  } catch {
    return persistentFailure(panelError("refutation", "invalid-aggregate", "verifier roster could not be safely tallied"));
  }
}

export function completePersistentArchitecturePanel(state: ArchitecturePanelState, resolver: PublicationAuthorityResolver): PersistentPanelResult<PersistentArchitectureStep> {
  const proof = proveArchitectureJudgeRoster(state, resolver);
  if (!proof.ok) return proof;
  const ranking = aggregateArchitecturePanel(state.authority, proof.value);
  if (!ranking.ok) return ranking;
  return reduceParsedArchitecture(state, Object.freeze({ schemaVersion: 1, type: "architecture-ranking-completed", ranking: ranking.value }), resolver);
}

export function completePersistentRefutationPanel(state: RefutationPanelState, resolver: PublicationAuthorityResolver, threshold?: number): PersistentPanelResult<PersistentRefutationStep> {
  const proof = proveRefutationRoster(state, resolver);
  if (!proof.ok) return proof;
  const decision = tallyRefutationPanel(state.authority, proof.value, threshold);
  if (!decision.ok) return decision;
  return reduceParsedRefutation(state, Object.freeze({ schemaVersion: 1, type: "refutation-tally-completed", decision: decision.value }), resolver);
}

type ReplayedArchitecturePrefix = Readonly<{
  step: PersistentArchitectureStep;
  events: readonly PersistentArchitecturePanelEvent[];
}>;
type ReplayedRefutationPrefix = Readonly<{
  step: PersistentRefutationStep;
  events: readonly PersistentRefutationPanelEvent[];
}>;

function replayArchitecturePrefix(
  authority: ArchitecturePanelAuthority,
  rawEvents: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<ReplayedArchitecturePrefix> {
  const events = safeArray(rawEvents);
  if (events === null) return persistentFailure(panelError("architecture", "malformed-event", "architecture history must be a dense JSON event array"));
  const parsedEvents: PersistentArchitecturePanelEvent[] = [];
  let step = startPersistentArchitecturePanel(authority);
  for (const raw of events) {
    const parsed = parsePersistentArchitecturePanelEvent(step.state, raw, resolver);
    if (!parsed.ok) return parsed;
    const reduced = reducePersistentArchitecturePanel(step.state, parsed.value);
    if (!reduced.ok) return reduced;
    parsedEvents.push(parsed.value);
    step = reduced.value;
  }
  return persistentSuccess(Object.freeze({ step, events: Object.freeze(parsedEvents) }));
}

function replayRefutationPrefix(
  authority: RefutationPanelAuthority,
  rawEvents: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<ReplayedRefutationPrefix> {
  const events = safeArray(rawEvents);
  if (events === null) return persistentFailure(panelError("refutation", "malformed-event", "refutation history must be a dense JSON event array"));
  const parsedEvents: PersistentRefutationPanelEvent[] = [];
  let step = startPersistentRefutationPanel(authority);
  for (const raw of events) {
    const parsed = parsePersistentRefutationPanelEvent(step.state, raw, resolver);
    if (!parsed.ok) return parsed;
    const reduced = reducePersistentRefutationPanel(step.state, parsed.value);
    if (!reduced.ok) return reduced;
    parsedEvents.push(parsed.value);
    step = reduced.value;
  }
  return persistentSuccess(Object.freeze({ step, events: Object.freeze(parsedEvents) }));
}

export function replayPersistentArchitecturePanel(authority: ArchitecturePanelAuthority, rawEvents: unknown, resolver: PublicationAuthorityResolver): PersistentPanelResult<PersistentArchitectureStep> {
  const replayed = replayArchitecturePrefix(authority, rawEvents, resolver);
  return replayed.ok ? persistentSuccess(replayed.value.step) : replayed;
}

export function replayPersistentRefutationPanel(authority: RefutationPanelAuthority, rawEvents: unknown, resolver: PublicationAuthorityResolver): PersistentPanelResult<PersistentRefutationStep> {
  const replayed = replayRefutationPrefix(authority, rawEvents, resolver);
  return replayed.ok ? persistentSuccess(replayed.value.step) : replayed;
}

/** Parse and replay an immutable architecture event prefix into persistence authority. */
export function parsePersistentArchitecturePanelHistory(
  authority: ArchitecturePanelAuthority,
  rawEvents: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<PersistentArchitecturePanelHistory> {
  const replayed = replayArchitecturePrefix(authority, rawEvents, resolver);
  if (!replayed.ok) return replayed;
  const history = Object.freeze({
    panel: "architecture" as const,
    authority,
    events: replayed.value.events,
  }) as PersistentArchitecturePanelHistory;
  architectureHistoryProofs.add(history);
  return persistentSuccess(history);
}

/** Parse and replay an immutable refutation event prefix into persistence authority. */
export function parsePersistentRefutationPanelHistory(
  authority: RefutationPanelAuthority,
  rawEvents: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<PersistentRefutationPanelHistory> {
  const replayed = replayRefutationPrefix(authority, rawEvents, resolver);
  if (!replayed.ok) return replayed;
  const history = Object.freeze({
    panel: "refutation" as const,
    authority,
    events: replayed.value.events,
  }) as PersistentRefutationPanelHistory;
  refutationHistoryProofs.add(history);
  return persistentSuccess(history);
}

function architectureAuthorityJson(authority: ArchitecturePanelAuthority): ArchitecturePanelAuthorityInput {
  return Object.freeze({ runId: authority.runId, candidateLenses: authority.candidateLenses, judgeCriteria: authority.judgeCriteria, candidateSlots: authority.candidateRoster.orderedSlots, judgeSlots: authority.judgeRoster.orderedSlots });
}
function refutationAuthorityJson(authority: RefutationPanelAuthority): RefutationPanelAuthorityInput {
  return Object.freeze({
    runId: authority.runId,
    identityRunId: authority.identityRunId,
    findings: authority.findings,
    lenses: authority.lenses,
    verifierSlots: authority.verifierRoster.orderedSlots,
  });
}

export type ArchitecturePanelCheckpoint = Readonly<{ schemaVersion: 2; kind: "architecture-panel-checkpoint"; authority: ArchitecturePanelAuthorityInput; events: readonly PersistentArchitecturePanelEvent[]; state: unknown }>;
export type RefutationPanelCheckpoint = Readonly<{ schemaVersion: 2; kind: "refutation-panel-checkpoint"; authority: RefutationPanelAuthorityInput; events: readonly PersistentRefutationPanelEvent[]; state: unknown }>;

export function architecturePanelCheckpoint(
  state: ArchitecturePanelState,
  events: readonly PersistentArchitecturePanelEvent[],
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<ArchitecturePanelCheckpoint> {
  if (!architectureStateProofs.has(state)) return persistentFailure(panelError("architecture", "malformed-checkpoint", "checkpoint requires parser-produced architecture state"));
  const replayed = replayArchitecturePrefix(state.authority, events, resolver);
  if (!replayed.ok) return replayed;
  if (!jsonEqual(replayed.value.step.state, state)) return persistentFailure(panelError("architecture", "malformed-checkpoint", "architecture checkpoint event prefix does not replay to the supplied state"));
  const replayedState = JSON.parse(JSON.stringify(replayed.value.step.state)) as unknown;
  return persistentSuccess(Object.freeze({ schemaVersion: 2, kind: "architecture-panel-checkpoint", authority: architectureAuthorityJson(state.authority), events: replayed.value.events, state: replayedState }));
}
export function refutationPanelCheckpoint(
  state: RefutationPanelState,
  events: readonly PersistentRefutationPanelEvent[],
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<RefutationPanelCheckpoint> {
  if (!refutationStateProofs.has(state)) return persistentFailure(panelError("refutation", "malformed-checkpoint", "checkpoint requires parser-produced refutation state"));
  const replayed = replayRefutationPrefix(state.authority, events, resolver);
  if (!replayed.ok) return replayed;
  if (!jsonEqual(replayed.value.step.state, state)) return persistentFailure(panelError("refutation", "malformed-checkpoint", "refutation checkpoint event prefix does not replay to the supplied state"));
  const replayedState = JSON.parse(JSON.stringify(replayed.value.step.state)) as unknown;
  return persistentSuccess(Object.freeze({ schemaVersion: 2, kind: "refutation-panel-checkpoint", authority: refutationAuthorityJson(state.authority), events: replayed.value.events, state: replayedState }));
}

export function parseArchitecturePanelCheckpoint(raw: unknown, resolver: PublicationAuthorityResolver): PersistentPanelResult<PersistentArchitectureStep> {
  const checkpoint = safeRecord(raw, ["schemaVersion", "kind", "authority", "events", "state"]);
  if (checkpoint === null || checkpoint.schemaVersion !== 2 || checkpoint.kind !== "architecture-panel-checkpoint") return persistentFailure(panelError("architecture", "malformed-checkpoint", "architecture checkpoint must be an exact schemaVersion 2 record"));
  const authority = parseArchitecturePanelAuthority(checkpoint.authority as ArchitecturePanelAuthorityInput);
  if (!authority.ok) return authority;
  const replayed = replayPersistentArchitecturePanel(authority.value, checkpoint.events, resolver);
  if (!replayed.ok) return replayed;
  if (!jsonEqual(checkpoint.state, replayed.value.state)) return persistentFailure(panelError("architecture", "malformed-checkpoint", "architecture checkpoint state disagrees with its immutable event prefix"));
  return replayed;
}
export function parseRefutationPanelCheckpoint(raw: unknown, resolver: PublicationAuthorityResolver): PersistentPanelResult<PersistentRefutationStep> {
  const checkpoint = safeRecord(raw, ["schemaVersion", "kind", "authority", "events", "state"]);
  if (checkpoint === null || checkpoint.schemaVersion !== 2 || checkpoint.kind !== "refutation-panel-checkpoint") return persistentFailure(panelError("refutation", "malformed-checkpoint", "refutation checkpoint must be an exact schemaVersion 2 record"));
  const authority = parseRefutationPanelAuthority(checkpoint.authority as RefutationPanelAuthorityInput);
  if (!authority.ok) return authority;
  const replayed = replayPersistentRefutationPanel(authority.value, checkpoint.events, resolver);
  if (!replayed.ok) return replayed;
  if (!jsonEqual(checkpoint.state, replayed.value.state)) return persistentFailure(panelError("refutation", "malformed-checkpoint", "refutation checkpoint state disagrees with its immutable event prefix"));
  return replayed;
}

export type ArchitecturePanelPersistenceEffect =
  | Readonly<{ schemaVersion: 1; kind: "append-architecture-panel-event"; runId: OrchestrationRunId; sequence: number; dedupKey: string; event: PersistentArchitecturePanelEvent }>
  | Readonly<{ schemaVersion: 1; kind: "replace-architecture-panel-checkpoint"; runId: OrchestrationRunId; sequence: number; dedupKey: string; checkpoint: ArchitecturePanelCheckpoint }>;
export type RefutationPanelPersistenceEffect =
  | Readonly<{ schemaVersion: 1; kind: "append-refutation-panel-event"; runId: OrchestrationRunId; sequence: number; dedupKey: string; event: PersistentRefutationPanelEvent }>
  | Readonly<{ schemaVersion: 1; kind: "replace-refutation-panel-checkpoint"; runId: OrchestrationRunId; sequence: number; dedupKey: string; checkpoint: RefutationPanelCheckpoint }>;
export type PanelPersistenceReceipt = Readonly<{ schemaVersion: 1; kind: "panel-persistence-recorded"; panel: "architecture" | "refutation"; runId: OrchestrationRunId; sequence: number; dedupKey: string }>;

function persistenceKey(runId: OrchestrationRunId, sequence: number, payload: unknown): string {
  return `${runId}:${sequence}:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

export function planArchitecturePanelPersistence(
  step: PersistentArchitectureStep,
  history: PersistentArchitecturePanelHistory,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<readonly [ArchitecturePanelPersistenceEffect, ArchitecturePanelPersistenceEffect]> {
  const event = step.recordedEvent;
  if (event === undefined || !architectureRecordedStepProofs.has(step) ||
      !architectureStateProofs.has(step.state) || !architectureEventProofs.has(event)) {
    return persistentFailure(panelError("architecture", "malformed-event", "persistence planning requires a parser/reducer-produced architecture step and event"));
  }
  if (!architectureHistoryProofs.has(history) || history.panel !== "architecture" ||
      !jsonEqual(architectureAuthorityJson(history.authority), architectureAuthorityJson(step.state.authority))) {
    return persistentFailure(panelError("architecture", "malformed-history", "persistence planning requires a replay-proved architecture history for the same panel authority"));
  }
  const events = Object.freeze([...history.events, event]);
  const replayed = replayArchitecturePrefix(step.state.authority, events, resolver);
  if (!replayed.ok) return replayed;
  if (!jsonEqual(replayed.value.step.state, step.state)) {
    return persistentFailure(panelError("architecture", "malformed-checkpoint", "architecture event prefix does not replay exactly to the proposed checkpoint state"));
  }
  const checkpoint = architecturePanelCheckpoint(replayed.value.step.state, replayed.value.events, resolver);
  if (!checkpoint.ok) return checkpoint;
  const sequence = events.length;
  const append = Object.freeze({ schemaVersion: 1 as const, kind: "append-architecture-panel-event" as const, runId: step.state.authority.runId, sequence, dedupKey: persistenceKey(step.state.authority.runId, sequence, event), event });
  const replace = Object.freeze({ schemaVersion: 1 as const, kind: "replace-architecture-panel-checkpoint" as const, runId: step.state.authority.runId, sequence, dedupKey: persistenceKey(step.state.authority.runId, sequence, checkpoint.value), checkpoint: checkpoint.value });
  return persistentSuccess(Object.freeze([append, replace]) as readonly [ArchitecturePanelPersistenceEffect, ArchitecturePanelPersistenceEffect]);
}
export function planRefutationPanelPersistence(
  step: PersistentRefutationStep,
  history: PersistentRefutationPanelHistory,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<readonly [RefutationPanelPersistenceEffect, RefutationPanelPersistenceEffect]> {
  const event = step.recordedEvent;
  if (event === undefined || !refutationRecordedStepProofs.has(step) ||
      !refutationStateProofs.has(step.state) || !refutationEventProofs.has(event)) {
    return persistentFailure(panelError("refutation", "malformed-event", "persistence planning requires a parser/reducer-produced refutation step and event"));
  }
  if (!refutationHistoryProofs.has(history) || history.panel !== "refutation" ||
      !jsonEqual(refutationAuthorityJson(history.authority), refutationAuthorityJson(step.state.authority))) {
    return persistentFailure(panelError("refutation", "malformed-history", "persistence planning requires a replay-proved refutation history for the same panel authority"));
  }
  const events = Object.freeze([...history.events, event]);
  const replayed = replayRefutationPrefix(step.state.authority, events, resolver);
  if (!replayed.ok) return replayed;
  if (!jsonEqual(replayed.value.step.state, step.state)) {
    return persistentFailure(panelError("refutation", "malformed-checkpoint", "refutation event prefix does not replay exactly to the proposed checkpoint state"));
  }
  const checkpoint = refutationPanelCheckpoint(replayed.value.step.state, replayed.value.events, resolver);
  if (!checkpoint.ok) return checkpoint;
  const sequence = events.length;
  const append = Object.freeze({ schemaVersion: 1 as const, kind: "append-refutation-panel-event" as const, runId: step.state.authority.runId, sequence, dedupKey: persistenceKey(step.state.authority.runId, sequence, event), event });
  const replace = Object.freeze({ schemaVersion: 1 as const, kind: "replace-refutation-panel-checkpoint" as const, runId: step.state.authority.runId, sequence, dedupKey: persistenceKey(step.state.authority.runId, sequence, checkpoint.value), checkpoint: checkpoint.value });
  return persistentSuccess(Object.freeze([append, replace]) as readonly [RefutationPanelPersistenceEffect, RefutationPanelPersistenceEffect]);
}

export function parsePanelPersistenceReceipt(raw: unknown, expected: ArchitecturePanelPersistenceEffect | RefutationPanelPersistenceEffect): PersistentPanelResult<PanelPersistenceReceipt> {
  const panel = expected.kind.includes("architecture") ? "architecture" : "refutation";
  const receipt = safeRecord(raw, ["schemaVersion", "kind", "panel", "runId", "sequence", "dedupKey"]);
  if (receipt === null || receipt.schemaVersion !== 1 || receipt.kind !== "panel-persistence-recorded" || receipt.panel !== panel || receipt.runId !== expected.runId || receipt.sequence !== expected.sequence || receipt.dedupKey !== expected.dedupKey) {
    return persistentFailure(panelError(panel, "persistence-receipt-mismatch", "panel persistence receipt does not match the exact journal/checkpoint effect"));
  }
  return persistentSuccess(Object.freeze({ schemaVersion: 1, kind: "panel-persistence-recorded", panel, runId: expected.runId, sequence: expected.sequence, dedupKey: expected.dedupKey }));
}

export const architecturePanelMachine = Object.freeze({
  start: startPersistentArchitecturePanel,
  parseEvent: parsePersistentArchitecturePanelEvent,
  reduce: reducePersistentArchitecturePanel,
  replay: replayPersistentArchitecturePanel,
  parseCheckpoint: parseArchitecturePanelCheckpoint,
});
export const refutationPanelMachine = Object.freeze({
  start: startPersistentRefutationPanel,
  parseEvent: parsePersistentRefutationPanelEvent,
  reduce: reducePersistentRefutationPanel,
  replay: replayPersistentRefutationPanel,
  parseCheckpoint: parseRefutationPanelCheckpoint,
});

const _architectureLensRemainsDisjoint: Exclude<PanelLens, ReviewLens> = "simplicity-first";
const _refutationLensRemainsDisjoint: Exclude<ReviewLens, PanelLens> = "reproduction";
void _architectureLensRemainsDisjoint;
void _refutationLensRemainsDisjoint;
