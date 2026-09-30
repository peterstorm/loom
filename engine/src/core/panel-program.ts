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
import type { LlmProfileId, PayloadProducerKind, PayloadProducerKindName } from "./model-profiles";
import {
  REVIEW_LENSES,
  defaultRefutationThreshold,
  parseRefutationVerdict,
  parseReviewLens,
  parseWaveFindingId,
  parseCurrentBriefFinding,
  tallyRefutations,
  type BriefFinding,
  type FindingOutcome,
  type RefutationVerdict,
  type ReviewLens,
  type WaveFindingId,
} from "./review-panel";
import { fail, ok, sanitizeProse, type ParseResult, type VerdictEnvelope } from "./panel-kernel";
import { parseReviewPath } from "./review-packet";
import { success as domainSuccess, failure as domainFailure } from "./orchestration-contract/identity";
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
  canonicalRecord,
  parseArtifactByteLength,
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
  // Criteria are checked against the CLOSED vocabulary, exactly as lenses are
  // against `PANEL_LENSES`. Distinct-and-non-blank was the whole bar here while
  // the v2 persistent path minted every criterion through `architectureCriterion`
  // — and this entry point is not legacy-only: `startArchitectureDispatchProgram`
  // calls it while rehydrating a persisted journal, which is untrusted input by
  // the same argument `architectureCriterion`'s own doc gives for checkpoints.
  const unknownCriteria = criteria.ok
    ? criteria.value.filter((criterion) => architectureCriterion(criterion) === null)
    : [];
  if (!lenses.ok || !criteria.ok || unknownLenses.length > 0 || unknownCriteria.length > 0) {
    return fail([
      ...(lenses.ok ? [] : lenses.errors),
      ...(criteria.ok ? [] : criteria.errors),
      ...unknownLenses.map((lens) => `unknown architecture design lens: ${lens}`),
      ...unknownCriteria.map((criterion) => `unknown architecture judge criterion: ${criterion}`),
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
 * The two request identities a refutation verifier slot owns — attempt 1 and its
 * single retry — derived from the run, the lens, and the finding set.
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
 * A roster is paired POSITIONALLY with an ordered list — `candidateLenses`,
 * `judgeCriteria`, or the refutation `lenses`. Slot `i` answers for entry `i`,
 * and the roster carries nothing that independently names its entry, so equal
 * cardinality is the whole of what the pairing itself can prove. This function is
 * therefore the only sanctioned way to cross from a slot to its entry.
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

type ParsedPanelRunId = ReturnType<typeof parseOrchestrationRunId>;
type ParsedExactRoster = ReturnType<typeof parseExactRoster>;

/** Parse the panel's closed vocabulary entries and collect their exact errors,
 * in the authority parser's canonical order (the joined diagnostic message is
 * part of the contract the fixtures pin). */
function architectureVocabularyEntries(
  lenses: readonly [string, ...string[]] | null,
  criteria: readonly [string, ...string[]] | null,
): {
  readonly parsedLenses: readonly PanelLens[];
  readonly mintedCriteria: readonly ArchitectureCriterion[];
  readonly errors: readonly string[];
} {
  const errors: string[] = [];
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
  return { parsedLenses, mintedCriteria, errors };
}

/** Roster-shape, roster-authority, and cross-roster errors for the
 * architecture authority, in the parser's canonical diagnostic order. */
function architectureRosterAuthorityErrors(args: Readonly<{
  runId: ParsedPanelRunId;
  lenses: readonly [string, ...string[]] | null;
  criteria: readonly [string, ...string[]] | null;
  candidateRoster: ParsedExactRoster;
  judgeRoster: ParsedExactRoster;
}>): readonly string[] {
  const errors: string[] = [];
  if (!args.candidateRoster.ok) errors.push(...args.candidateRoster.error.violations.map(({ kind }) => `candidate roster: ${kind}`));
  if (!args.judgeRoster.ok) errors.push(...args.judgeRoster.error.violations.map(({ kind }) => `judge roster: ${kind}`));
  if (args.runId.ok && args.lenses !== null && args.candidateRoster.ok) {
    errors.push(...rosterAuthorityErrors(
      args.candidateRoster.value,
      args.runId.value,
      "architecture-panel",
      "arch-designer-agent",
      args.lenses,
      "candidate",
    ));
  }
  if (args.runId.ok && args.criteria !== null && args.judgeRoster.ok) {
    errors.push(...rosterAuthorityErrors(
      args.judgeRoster.value,
      args.runId.value,
      "architecture-panel",
      "arch-judge-agent",
      args.criteria,
      "judge",
    ));
  }
  if (args.candidateRoster.ok && args.judgeRoster.ok) errors.push(...crossRosterErrors(args.candidateRoster.value, args.judgeRoster.value));
  return errors;
}

export function parseArchitecturePanelAuthority(raw: ArchitecturePanelAuthorityInput): PersistentPanelResult<ArchitecturePanelAuthority> {
  try {
    const input = safeRecord(raw, ["runId", "candidateLenses", "judgeCriteria", "candidateSlots", "judgeSlots"]);
    if (input === null) return persistentFailure(panelError("architecture", "invalid-authority", "architecture authority must be an exact data record"));
    const runId = parseOrchestrationRunId(input.runId);
    const lenses = nonEmptyDistinctStrings(input.candidateLenses);
    const criteria = nonEmptyDistinctStrings(input.judgeCriteria);
    const candidateRoster = parseExactRoster(input.candidateSlots);
    const judgeRoster = parseExactRoster(input.judgeSlots);
    const vocab = architectureVocabularyEntries(lenses, criteria);
    const errors: string[] = [];
    if (!runId.ok) errors.push(runId.error.message);
    errors.push(...vocab.errors);
    errors.push(...architectureRosterAuthorityErrors({ runId, lenses, criteria, candidateRoster, judgeRoster }));
    if (errors.length > 0 || !runId.ok || lenses === null || criteria === null || !candidateRoster.ok || !judgeRoster.ok || vocab.parsedLenses.length === 0) {
      return persistentFailure(panelError("architecture", "invalid-authority", errors.join("; ") || "architecture authority is invalid"));
    }
    const canonicalLenses = Object.freeze(vocab.parsedLenses) as readonly [PanelLens, ...PanelLens[]];
    const canonicalCriteria = Object.freeze(vocab.mintedCriteria) as unknown as readonly [ArchitectureCriterion, ...ArchitectureCriterion[]];
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

/** Parse the strict canonical critical-Finding list for the refutation
 * authority, collecting per-entry errors in list order (the joined
 * diagnostic message is part of the contract the fixtures pin). */
function refutationFindings(raw: readonly unknown[] | null): {
  readonly findings: readonly BriefFinding[];
  readonly errors: readonly string[];
} {
  const findings: BriefFinding[] = [];
  if (raw === null || raw.length === 0) {
    return { findings, errors: ["refutation findings must be a non-empty canonical critical Finding list"] };
  }
  const errors: string[] = [];
  raw.forEach((entry, index) => {
    const parsed = parseStrictBriefFinding(entry);
    if (parsed.ok) findings.push(parsed.value);
    else errors.push(`findings[${index}]: ${parsed.error.message}`);
  });
  return { findings, errors };
}

function parseStrictBriefFinding(raw: unknown): DomainResult<BriefFinding, Readonly<{ message: string }>> {
  const finding = safeRecord(raw, ["id", "taskId", "agent", "severity", "file", "line", "claim", "protocolVersion", "basis", "reason"]);
  if (finding === null) return { ok: false, error: { message: "Finding must be an exact data record" } };
  if (["protocolVersion", "basis", "reason"].some((key) => Object.hasOwn(finding, key))) {
    const parsed = parseCurrentBriefFinding(finding);
    if (!parsed.ok) return { ok: false, error: { message: parsed.errors.join("; ") } };
    return parsed.value.severity === "critical"
      ? { ok: true, value: parsed.value }
      : { ok: false, error: { message: "Finding severity must be critical" } };
  }
  const id = parseWaveFindingId(finding.id);
  const taskId = typeof finding.taskId === "string" ? sanitizeProse(finding.taskId) : "";
  const agent = typeof finding.agent === "string" ? sanitizeProse(finding.agent) : "";
  const claim = typeof finding.claim === "string" ? sanitizeProse(finding.claim) : "";
  const file = finding.file === null ? null : parseReviewPath(finding.file, "Finding file");
  let line: number | null | undefined;
  if (finding.line === null) {
    line = null;
  } else if (typeof finding.line === "number" && Number.isSafeInteger(finding.line) && finding.line > 0) {
    line = finding.line;
  } else {
    line = undefined;
  }
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
 * The criterion a judge slot answers for, refused rather than assumed.
 *
 * Both judge paths — the event reducer and the direct submission — used to do
 * `judgeRoster.orderedSlots.findIndex(...)` and then `judgeCriteria[index]!`,
 * which is precisely the pattern `boundEntryForSlot`'s doc exists to forbid: an
 * unknown slot yields -1, indexing with -1 yields `undefined`, and the `!` hands
 * that downstream as if it were a real criterion. The verdict parser would then
 * check the submission against `undefined` and admit whatever it was given.
 */
function boundJudgeCriterion(
  authority: ArchitecturePanelAuthority,
  slotId: SlotId,
): PersistentPanelResult<ArchitectureCriterion> {
  const criterion = boundEntryForSlot(authority.judgeRoster, authority.judgeCriteria, slotId);
  return criterion === null
    ? persistentFailure(panelError("architecture", "request-binding-mismatch", `slot ${slotId} is bound to no judge criterion`, { slotId }))
    : persistentSuccess(criterion);
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
    const parsedFindings = refutationFindings(rawFindings);
    const findings = [...parsedFindings.findings];
    const errors: string[] = [];
    if (!runId.ok) errors.push(runId.error.message);
    if (!identityRunId.ok) errors.push(identityRunId.error.message);
    errors.push(...parsedFindings.errors);
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

// ---------------------------------------------------------------------------
// Panel verdict source selection and durable provenance (AD-8, FR-006/009/011/012)
// ---------------------------------------------------------------------------
//
// Judge v1 and refutation v1 enter their panels through the SAME deterministic
// selection seam the reviewer capture path uses: the emission observation is
// folded and bound ONCE (the kernel's `selectVerdictSource`, reached through
// the injected port), the selection runs BEFORE the authoritative parse
// (AD-8), and the accepted source is returned by the same decision — never
// reconstructed by a caller from the input records. The panel parsers keep
// their criterion/lens bindings and complete candidate/finding coverage
// (FR-012): a selection can choose WHICH bytes are parsed, never what they
// must bind to — a source cannot override issuance.
//
// Purity boundary: this module is a declared pure module, so it never imports
// the emission transport modules (`emission-ingestion`/`emission-tool`/
// `harness-capture`). The kernel capabilities arrive as the injected port —
// the shell that owns the emission transport supplies the ONE production
// adapter. The structural types below mirror the kernel's frozen contract
// shapes; a kernel drift fails to compile at the adapter, never silently
// here. The core keeps every decision arm: which bytes won, the retained
// refusal, the durable provenance, the record protocol, and the AD-9 exact
// replay (re-certification is checked HERE against the minted digest the
// port returns — the port can return a refusal, never a verdict).

/** The closed schema-version vocabulary of the frozen emission registry
 *  (structural mirror of the kernel's `EmissionSchemaVersion`). */
type PanelVerdictSchemaVersion = "v1" | "v2" | "v3";

const VERDICT_SCHEMA_VERSIONS: readonly string[] = ["v1", "v2", "v3"];

/** The frozen emission tool-name vocabulary (structural mirror of the
 *  kernel's `EmissionToolName`). */
type PanelVerdictEmissionToolName =
  | "loom_emit_reviewer_payload"
  | "loom_emit_judge_verdict"
  | "loom_emit_refutation_verdict";

/** Structural mirror of the kernel's issued emission binding: the
 *  authenticated issuance (AD-6 — never output shape) the selection folds
 *  against. */
export type PanelVerdictEmissionBinding = Readonly<{
  requestId: RequestId;
  kind: PayloadProducerKind;
  version: PanelVerdictSchemaVersion;
  toolName: PanelVerdictEmissionToolName;
  schemaDigest: ArtifactDigest;
}>;

/** The verdict-kind-refined binding view: a binding minted for one producer
 *  kind cannot be passed where another is expected (the kernel's
 *  `IssuedEmissionBindingOf` path scoping, mirrored). */
export type PanelVerdictEmissionBindingOf<K extends PayloadProducerKindName> = PanelVerdictEmissionBinding &
  Readonly<{ kind: Readonly<{ kind: K }> }>;

/** Structural mirror of the kernel's emission tool call: the contract fields
 *  only, never adapter provenance beyond them. The request id is the kernel's
 *  plain string here (the binding carries the branded identity); a parsed
 *  record stores its canonical minted id in the same field. */
export type PanelVerdictEmissionCall = Readonly<{
  requestId: string;
  toolCallId: string;
  kind: PayloadProducerKind;
  version: PanelVerdictSchemaVersion;
  arguments: unknown;
}>;

/** Structural mirror of the kernel's closed emission observation (AD-8):
 *  absent, one complete call, multiple distinct calls, or unusable with a
 *  reason — an incomplete or failed observation is representable as itself,
 *  never reclassified as absence. */
export type PanelVerdictEmissionObservation =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "single-call"; call: PanelVerdictEmissionCall }>
  | Readonly<{ kind: "multiple-calls"; calls: readonly PanelVerdictEmissionCall[] }>
  | Readonly<{ kind: "unusable"; reason: string }>;

/** The emission edge's parse refusal, widened to the durable code string the
 *  provenance form carries (the kernel's closed code vocabulary has no
 *  runtime enumeration to mirror; the code is never re-ingested). */
export type PanelVerdictEmissionRefusal = Readonly<{ code: string; message: string }>;

/** Structural mirror of the kernel's closed observation-refusal vocabulary. */
export type PanelVerdictObservationRefusal = Readonly<{
  code: "unusable-observation" | "wrong-request" | "unexpected-kind" | "unexpected-version";
  message: string;
}>;

/** The kernel's verdict-source selection, mirrored: which bytes won, from
 *  what source, with the retained refusal when extraction ran over a refused
 *  call (FR-006) and the observed calls when the fold refused an ambiguity
 *  (FR-007). */
export type PanelVerdictSourceSelection =
  | Readonly<{ kind: "emission-tool-arguments"; rawJson: string; source: "emission-tool"; call: PanelVerdictEmissionCall }>
  | Readonly<{ kind: "final-message-extraction"; rawJson: string; source: "extraction" }>
  | Readonly<{ kind: "extraction-over-refused-call"; rawJson: string; source: "extraction"; emissionRefusal: PanelVerdictEmissionRefusal }>
  | Readonly<{ kind: "duplicate-emission-call"; calls: readonly PanelVerdictEmissionCall[] }>
  | Readonly<{ kind: "observation-refused"; refusal: PanelVerdictObservationRefusal }>;

/**
 * The injected kernel port — the purity boundary's ONE seam. The shell that
 * owns the emission transport supplies the fold (the kernel's ONE
 * verdict-source selection) and the AD-9 replay capability that re-certifies
 * a record's emission claims against the frozen registry and re-folds the
 * single accepted call. The replay returns the minted schema digest beside
 * the re-folded selection so THIS core performs the certification
 * cross-check; a capability failure is a typed refusal, never a verdict.
 */
export type PanelVerdictEmissionPort = Readonly<{
  fold: (submission: Readonly<{
    binding: PanelVerdictEmissionBindingOf<"judge-verdict" | "refutation-verdict">;
    observation: PanelVerdictEmissionObservation;
    rawJson: string;
  }>) => PanelVerdictSourceSelection;
  replayAcceptedCall: (
    claims: Readonly<{ requestId: RequestId; kind: "judge-verdict" | "refutation-verdict"; version: PanelVerdictSchemaVersion }>,
    call: PanelVerdictEmissionCall,
    rawJson: string,
  ) => DomainResult<Readonly<{ schemaDigest: ArtifactDigest; selection: PanelVerdictSourceSelection }>, string>;
}>;

/** One issued verdict-kind emission submission input, as the caller hands it
 *  to the panel seam: the issued binding (authenticated issuance, AD-6 —
 *  never output shape), the emission observation, and the kernel port that
 *  folds the observation. */
export type PanelVerdictEmissionSelectionOf<K extends "judge-verdict" | "refutation-verdict"> = Readonly<{
  binding: PanelVerdictEmissionBindingOf<K>;
  observation: PanelVerdictEmissionObservation;
  port: PanelVerdictEmissionPort;
}>;

export type PanelVerdictEmissionSelection = PanelVerdictEmissionSelectionOf<"judge-verdict" | "refutation-verdict">;

/**
 * The durable accepted-source record of one panel verdict (FR-009/FR-011) —
 * the same provenance vocabulary the reviewer capture seam's source records
 * use, so one ingestion-time shape serves every producer path. The emission
 * arm carries the accepted call's identity and the issued schema identity;
 * the extraction arm carries the retained single-call refusal that led to the
 * fallback (FR-006) when there was one — and nothing when there was not.
 */
export type PanelVerdictSource = Readonly<{
  source: "emission-tool" | "extraction";
  toolCallId?: string;
  producerKind?: string;
  emissionSchemaVersion?: PanelVerdictSchemaVersion;
  schemaDigest?: string;
  emissionRefusal?: Readonly<{ code: string; message: string }>;
}>;

/** The zero-emission-baseline accepted source: extraction with no refusal. */
const EXTRACTION_VERDICT_SOURCE: PanelVerdictSource = canonicalRecord({ source: "extraction" as const });

type RejectedVerdictSelection = Extract<PanelVerdictSourceSelection, { kind: "duplicate-emission-call" | "observation-refused" }>;
type AcceptedVerdictSelection = Extract<PanelVerdictSourceSelection, { kind: "emission-tool-arguments" | "final-message-extraction" | "extraction-over-refused-call" }>;

const isRejectedVerdictSelection = (selection: PanelVerdictSourceSelection): selection is RejectedVerdictSelection =>
  selection.kind === "duplicate-emission-call" || selection.kind === "observation-refused";

/** The provenance the selection decision itself returns for an accepted arm —
 *  derived ONCE here, so the persistent accepted events and the legacy source
 *  records cannot disagree about what was accepted or why. */
export function panelVerdictSourceProvenance(
  expected: PanelVerdictEmissionBinding,
  accepted: AcceptedVerdictSelection,
): PanelVerdictSource {
  switch (accepted.kind) {
    case "emission-tool-arguments":
      return canonicalRecord({
        source: "emission-tool" as const,
        toolCallId: accepted.call.toolCallId,
        producerKind: accepted.call.kind.kind,
        emissionSchemaVersion: expected.version,
        schemaDigest: expected.schemaDigest,
      });
    case "final-message-extraction":
      return EXTRACTION_VERDICT_SOURCE;
    case "extraction-over-refused-call":
      return canonicalRecord({
        source: "extraction" as const,
        emissionRefusal: canonicalRecord({ code: accepted.emissionRefusal.code, message: accepted.emissionRefusal.message }),
      });
  }
}

/**
 * The durable source arm of an accepted panel verdict event, PARSED not
 * assumed. `undefined` is the historical projection: genuinely pre-feature
 * accepted events were extraction (the plan's parser-compatible historical
 * rule). A PRESENT arm must be exact — malformed present-day source fields are
 * NOT historical absence and refuse here, so a corrupted arm can never be
 * replayed as a silently-downgraded extraction acceptance.
 */
export function projectPanelVerdictSourceArm(raw: unknown): DomainResult<PanelVerdictSource, string> {
  if (raw === undefined) return domainSuccess(EXTRACTION_VERDICT_SOURCE);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return domainFailure("panel verdict source must be an exact data record when present");
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (record["source"] === "emission-tool") {
    if (keys !== "emissionSchemaVersion,producerKind,schemaDigest,source,toolCallId") {
      return domainFailure("an emission-tool panel verdict source must carry exactly its call identity and issued schema identity");
    }
    const toolCallId = record["toolCallId"];
    const producerKind = record["producerKind"];
    const emissionSchemaVersion = record["emissionSchemaVersion"];
    const schemaDigest = parseArtifactDigest(record["schemaDigest"]);
    if (typeof toolCallId !== "string" || toolCallId.length === 0 ||
        typeof producerKind !== "string" || producerKind.length === 0 ||
        typeof emissionSchemaVersion !== "string" || !VERDICT_SCHEMA_VERSIONS.includes(emissionSchemaVersion) ||
        !schemaDigest.ok) {
      return domainFailure("an emission-tool panel verdict source carries a malformed call or schema identity");
    }
    return domainSuccess(canonicalRecord({
      source: "emission-tool" as const,
      toolCallId,
      producerKind,
      emissionSchemaVersion: emissionSchemaVersion as PanelVerdictSchemaVersion,
      schemaDigest: schemaDigest.value,
    }));
  }
  if (record["source"] === "extraction") {
    if (keys === "source") return domainSuccess(EXTRACTION_VERDICT_SOURCE);
    if (keys === "emissionRefusal,source") {
      const refusal = record["emissionRefusal"];
      if (typeof refusal !== "object" || refusal === null || Array.isArray(refusal)) {
        return domainFailure("a retained emission refusal must be an exact data record");
      }
      const refusalRecord = refusal as Record<string, unknown>;
      if (Object.keys(refusalRecord).sort().join(",") !== "code,message" ||
          typeof refusalRecord["code"] !== "string" || refusalRecord["code"].length === 0 ||
          typeof refusalRecord["message"] !== "string" || refusalRecord["message"].length === 0) {
        return domainFailure("a retained emission refusal must carry exactly a non-empty code and message");
      }
      return domainSuccess(canonicalRecord({
        source: "extraction" as const,
        emissionRefusal: canonicalRecord({ code: refusalRecord["code"], message: refusalRecord["message"] }),
      }));
    }
    return domainFailure("an extraction panel verdict source carries only its optional retained emission refusal");
  }
  return domainFailure(`panel verdict source must be "emission-tool" or "extraction"`);
}

/** The typed rejection a refused selection arm produces — the SAME vocabulary
 *  the reviewer capture runtime uses for the identical arms, so a duplicate or
 *  misbound observation consumes one attempt and names what was observed. The
 *  `kind` is the PersistentPanelError kind; the rejection event derives its
 *  category from it (`rejectionEvent`), the legacy path reads the message. */
export function panelVerdictSelectionRejection(
  selection: RejectedVerdictSelection,
): Readonly<{ kind: "request-binding-mismatch" | "malformed-result"; message: string }> {
  if (selection.kind === "duplicate-emission-call") {
    return canonicalRecord({
      kind: "malformed-result" as const,
      message: `result carried ${selection.calls.length} distinct emission tool calls (${selection.calls.map(({ toolCallId }) => toolCallId).join(", ")}); exactly one successfully executed call is allowed`,
    });
  }
  return canonicalRecord({
    kind: selection.refusal.code === "unusable-observation" ? "malformed-result" as const : "request-binding-mismatch" as const,
    message: `${selection.refusal.code}: ${selection.refusal.message}`,
  });
}

/** The retained single-call refusal beside a parse that also refused: BOTH
 *  causes in one diagnostic (AD-9 — one rejection, not two). */
export function describePanelRefusalPair(
  emissionRefusal: Readonly<{ code: string; message: string }>,
  parseDetail: string,
): string {
  return `emission arguments were refused [${emissionRefusal.code}]: ${emissionRefusal.message}; authoritative verdict parse was refused: ${parseDetail}`;
}

/** The emission-provenance prefix of an emission-arm parse failure: the
 *  accepted call stays named even when its payload refused the joins. */
export function describePanelVerdictEmissionParseFailure(
  toolCallId: string,
  label: string,
  detail: string,
): string {
  return `emission tool call ${toolCallId} produced a ${label} that refuses its authoritative parse: ${detail}`;
}

/**
 * The issuance join between an emission selection input and the submitted
 * request: the binding must certify THIS slot's request. A binding for another
 * request is a caller defect, not an attempt observation — a typed failure
 * before any selection, never a rejection event consuming the attempt.
 */
function panelVerdictEmissionIssuanceProblem<K extends "judge-verdict" | "refutation-verdict">(
  emission: PanelVerdictEmissionSelectionOf<K> | undefined,
  expectedRequestId: RequestId,
  panel: "architecture" | "refutation",
): PersistentPanelError | null {
  if (emission === undefined || emission.binding.requestId === expectedRequestId) return null;
  return panelError(panel, "invalid-authority",
    `issued emission binding certifies request ${emission.binding.requestId}, not the submitted request ${expectedRequestId}`);
}

interface VerdictSubmissionFoldInput<Verdict> {
  readonly label: "judge verdict" | "refutation verdict";
  readonly expectedRequestId: RequestId;
  readonly emission: PanelVerdictEmissionSelection | undefined;
  readonly rawJson: unknown;
  /** The seam's own authoritative parse — the criterion/lens binding and the
   *  complete candidate/finding coverage live HERE and nowhere else; the
   *  selection can choose which bytes reach it, never what they bind to. */
  readonly parse: (rawJson: unknown) => ParseResult<Verdict>;
  readonly classifyRaw: (raw: unknown) => "request-binding-mismatch" | "malformed-result";
  readonly foreignAuthorityMessage: string;
}

type VerdictSubmissionFold<Verdict> =
  | Readonly<{ kind: "accepted"; value: Verdict; source: PanelVerdictSource }>
  | Readonly<{ kind: "rejected"; errorKind: "request-binding-mismatch" | "malformed-result"; message: string }>;

/**
 * The ONE verdict-submission fold both panel verdict submissions share:
 * selection before the authoritative parse (AD-8), the accepted source
 * returned by the same decision, and the extraction arms parsed byte-verbatim
 * on the caller's raw input. Without an emission input the fold is today's
 * baseline exactly — the accepted source is extraction and every diagnostic is
 * byte-identical to the pre-selection seam.
 */
function foldVerdictSubmission<Verdict>(input: VerdictSubmissionFoldInput<Verdict>): VerdictSubmissionFold<Verdict> {
  let selection: PanelVerdictSourceSelection | null = null;
  if (input.emission !== undefined) {
    // The port receives the caller's raw input ONLY to fill the extraction
    // arms' byte-verbatim echo (`final-message-extraction` /
    // `extraction-over-refused-call`); the fold itself never parses it, and
    // the parse target for those arms is resolved back to `input.rawJson`
    // below — never to this echo. A non-string caller input is carried as ""
    // so the echo stays a string without ever becoming the parse target: the
    // caller's own input keeps refusing with its baseline diagnostic.
    selection = input.emission.port.fold({
      binding: input.emission.binding,
      observation: input.emission.observation,
      rawJson: typeof input.rawJson === "string" ? input.rawJson : "",
    });
    if (isRejectedVerdictSelection(selection)) {
      const rejection = panelVerdictSelectionRejection(selection);
      return canonicalRecord({ kind: "rejected" as const, errorKind: rejection.kind, message: rejection.message });
    }
  }
  const accepted = selection;
  const parseTarget = accepted !== null && accepted.kind === "emission-tool-arguments" ? accepted.rawJson : input.rawJson;
  const parsed = input.parse(parseTarget);
  if (!parsed.ok) {
    const errorKind = input.classifyRaw(parseTarget);
    const base = errorKind === "request-binding-mismatch" ? input.foreignAuthorityMessage : parsed.errors.join("; ");
    let message = base;
    if (accepted !== null && accepted.kind === "emission-tool-arguments") {
      message = describePanelVerdictEmissionParseFailure(accepted.call.toolCallId, input.label, base);
    } else if (accepted !== null && accepted.kind === "extraction-over-refused-call") {
      message = describePanelRefusalPair(accepted.emissionRefusal, base);
    }
    return canonicalRecord({ kind: "rejected" as const, errorKind, message });
  }
  if (accepted === null) {
    return canonicalRecord({ kind: "accepted" as const, value: parsed.value, source: EXTRACTION_VERDICT_SOURCE });
  }
  if (input.emission === undefined) {
    // Unreachable — a non-null selection exists only under an emission input.
    // The guard carries the invariant instead of a non-null assertion.
    throw new Error("panel verdict invariant: a selection exists without an issued emission binding");
  }
  return canonicalRecord({ kind: "accepted" as const, value: parsed.value, source: panelVerdictSourceProvenance(input.emission.binding, accepted) });
}

/**
 * The durable per-attempt record of ONE panel attempt's accepted verdict
 * source (the legacy panel path's channel for FR-009/FR-011 provenance). The
 * emission arm carries the ACCEPTED CALL — the exact replay authority AD-9's
 * replay row names — so every later per-attempt scan (reconciliation,
 * deterministic tally/aggregate) re-runs the SAME selection seam over it and
 * reproduces the same selected bytes instead of re-parsing pre-selection
 * transcript bytes as if they had never been selected.
 */
export type PanelVerdictSourceRecord = Readonly<{
  schemaVersion: 1;
  kind: "panel-verdict-source";
  requestId: RequestId;
  slotId: SlotId;
  attempt: SemanticAttempt;
  source: PanelVerdictSource;
  /** The accepted call — present exactly when the source is emission-tool. */
  acceptedCall?: PanelVerdictEmissionCall;
  /** The digest identity of the bytes the seam authoritatively parsed: the
   *  selected rawJson for the emission arm, the attempt's own raw bytes for
   *  the extraction arms. */
  payloadDigest: ArtifactDigest;
  payloadByteLength: number;
}>;

/** The ONE constructor of a durable panel verdict source record. */
export function panelVerdictSourceRecord(args: {
  requestId: RequestId;
  slotId: SlotId;
  attempt: SemanticAttempt;
  source: PanelVerdictSource;
  acceptedCall?: PanelVerdictEmissionCall;
  payloadDigest: ArtifactDigest;
  payloadByteLength: number;
}): DomainResult<PanelVerdictSourceRecord, string> {
  if (args.source.source === "emission-tool") {
    if (args.acceptedCall === undefined) {
      return domainFailure("an emission-tool panel verdict source record requires the accepted call");
    }
  } else if (args.acceptedCall !== undefined) {
    return domainFailure("an extraction panel verdict source record must not carry an accepted call");
  }
  if (!Number.isSafeInteger(args.payloadByteLength) || args.payloadByteLength <= 0) {
    return domainFailure("a panel verdict source record payload byte length must be a positive safe integer");
  }
  return domainSuccess(canonicalRecord({
    schemaVersion: 1 as const,
    kind: "panel-verdict-source" as const,
    requestId: args.requestId,
    slotId: args.slotId,
    attempt: args.attempt,
    source: args.source,
    ...(args.acceptedCall === undefined ? {} : { acceptedCall: args.acceptedCall }),
    payloadDigest: args.payloadDigest,
    payloadByteLength: args.payloadByteLength,
  }));
}

/** Parse a durable record back: exact shape, branded identities, the accepted
 *  call's contract fields, and every cross-check that makes a tampered record
 *  refuse instead of replaying. Absent source is NOT the historical projection
 *  here — a record always carries its accepted source. */
/** Parse and certify the acceptedCall field of an emission-tool panel verdict
 * source record against the record's own identity and source arm. Every
 * diagnostic keeps the exact message the fixtures pin. */
function parsePanelVerdictAcceptedCall(args: Readonly<{
  acceptedCallRaw: unknown;
  requestId: RequestId;
  source: PanelVerdictSource;
}>): DomainResult<PanelVerdictEmissionCall, string> {
  const callRecord = safeRecord(args.acceptedCallRaw, ["requestId", "toolCallId", "kind", "version", "arguments"]);
  if (callRecord === null) return domainFailure("the accepted call must be an exact emission tool call record");
  const callRequestId = parseRequestId(callRecord["requestId"]);
  const toolCallId = callRecord["toolCallId"];
  const kind = callRecord["kind"];
  const kindName = typeof kind === "object" && kind !== null && !Array.isArray(kind)
    ? (kind as Record<string, unknown>)["kind"]
    : undefined;
  const version = callRecord["version"];
  if (!callRequestId.ok) return domainFailure(`the accepted call request id is invalid: ${callRequestId.error.message}`);
  if (typeof toolCallId !== "string" || toolCallId.length === 0) return domainFailure("the accepted call carries no tool-call identity");
  if (typeof kindName !== "string" || (kindName !== "judge-verdict" && kindName !== "refutation-verdict")) {
    // The verdict panels only ever accept verdict-kind calls: the submission
    // bindings are verdict-kind refinements and the kernel selection refuses
    // an unexpected kind, so a record claiming anything else is not a panel
    // verdict record and refuses at the parse boundary.
    return domainFailure(`the accepted call names producer kind ${JSON.stringify(kindName ?? null)}, which is not a panel verdict kind`);
  }
  if (version !== "v1" && version !== "v2" && version !== "v3") {
    return domainFailure(`the accepted call carries schema version ${JSON.stringify(version ?? null)}, which is not in the closed schema-version vocabulary`);
  }
  if (callRecord["arguments"] === undefined) return domainFailure("the accepted call carries no arguments");
  const acceptedCall: PanelVerdictEmissionCall = canonicalRecord({
    requestId: callRequestId.value,
    toolCallId,
    kind: canonicalRecord({ kind: kindName }),
    version,
    arguments: callRecord["arguments"],
  });
  if (acceptedCall.requestId !== args.requestId) return domainFailure("the accepted call was observed under a different request than the record's request");
  if (args.source.toolCallId !== toolCallId) return domainFailure("the accepted call's identity disagrees with the record's source arm");
  if (args.source.producerKind !== kindName) return domainFailure("the accepted call's producer kind disagrees with the record's source arm");
  if (args.source.emissionSchemaVersion !== version) return domainFailure("the accepted call's schema version disagrees with the record's source arm");
  return domainSuccess(acceptedCall);
}

export function parsePanelVerdictSourceRecord(raw: unknown): DomainResult<PanelVerdictSourceRecord, string> {
  const record = safeRecord(raw, ["schemaVersion", "kind", "requestId", "slotId", "attempt", "source", "acceptedCall", "payloadDigest", "payloadByteLength"]);
  if (record === null || record["schemaVersion"] !== 1 || record["kind"] !== "panel-verdict-source") {
    return domainFailure("panel verdict source record must be an exact schemaVersion 1 panel-verdict-source data record");
  }
  const requestId = parseRequestId(record["requestId"]);
  const slotId = parseSlotId(record["slotId"]);
  const attempt = record["attempt"] === 1 || record["attempt"] === 2 ? record["attempt"] : null;
  const payloadDigest = parseArtifactDigest(record["payloadDigest"]);
  const payloadByteLength = parseArtifactByteLength(record["payloadByteLength"]);
  if (record["source"] === undefined) return domainFailure("panel verdict source record must carry its accepted source");
  const source = projectPanelVerdictSourceArm(record["source"]);
  if (!requestId.ok) return domainFailure(`panel verdict source record request id is invalid: ${requestId.error.message}`);
  if (!slotId.ok) return domainFailure(`panel verdict source record slot id is invalid: ${slotId.error.message}`);
  if (attempt === null) return domainFailure("panel verdict source record attempt must be 1 or 2");
  if (!payloadDigest.ok) return domainFailure(`panel verdict source record payload digest is invalid: ${payloadDigest.error.message}`);
  if (!payloadByteLength.ok) return domainFailure(`panel verdict source record payload byte length is invalid: ${payloadByteLength.error.message}`);
  if (!source.ok) return domainFailure(`panel verdict source record source is invalid: ${source.error}`);

  const acceptedCallRaw = record["acceptedCall"];
  if (source.value.source === "emission-tool") {
    if (acceptedCallRaw === undefined) {
      return domainFailure("an emission-tool panel verdict source record requires the accepted call");
    }
    const call = parsePanelVerdictAcceptedCall({ acceptedCallRaw, requestId: requestId.value, source: source.value });
    if (!call.ok) return call;
    return domainSuccess(canonicalRecord({
      schemaVersion: 1 as const,
      kind: "panel-verdict-source" as const,
      requestId: requestId.value,
      slotId: slotId.value,
      attempt,
      source: source.value,
      acceptedCall: call.value,
      payloadDigest: payloadDigest.value,
      payloadByteLength: payloadByteLength.value,
    }));
  }
  if (acceptedCallRaw !== undefined) {
    return domainFailure("an extraction panel verdict source record must not carry an accepted call");
  }
  return domainSuccess(canonicalRecord({
    schemaVersion: 1 as const,
    kind: "panel-verdict-source" as const,
    requestId: requestId.value,
    slotId: slotId.value,
    attempt,
    source: source.value,
    payloadDigest: payloadDigest.value,
    payloadByteLength: payloadByteLength.value,
  }));
}

/**
 * The EXACT REPLAY of one durable record's accepted selection (AD-9's replay
 * row): the emission arm re-certifies its claims against the frozen registry
 * THROUGH THE INJECTED PORT, re-folds the single accepted call, and re-runs
 * the SAME selection — so a re-scan reproduces the accepted bytes and call
 * identity instead of re-parsing the pre-selection transcript bytes. The
 * certification cross-check stays HERE: the port returns the minted schema
 * digest beside the re-folded selection, and this core refuses a record whose
 * digest does not certify it. The caller verifies the returned selection's
 * bytes against the record's payload digest (it owns the bytes); extraction
 * arms replay verbatim with the retained refusal in place.
 */
export function replayPanelVerdictSourceSelection(
  record: PanelVerdictSourceRecord,
  rawJson: string,
  port: PanelVerdictEmissionPort,
): DomainResult<PanelVerdictSourceSelection, string> {
  if (record.source.source === "extraction") {
    // The durable refusal re-enters the selection vocabulary verbatim: the
    // provenance form widened the parse's code to a validated non-empty
    // string (the shared provenance vocabulary) and this arm carries it
    // unchanged — the code is never re-ingested by any parse.
    return record.source.emissionRefusal === undefined
      ? domainSuccess(canonicalRecord({ kind: "final-message-extraction" as const, rawJson, source: "extraction" as const }))
      : domainSuccess(canonicalRecord({
          kind: "extraction-over-refused-call" as const,
          rawJson,
          source: "extraction" as const,
          emissionRefusal: record.source.emissionRefusal,
        }));
  }
  const call = record.acceptedCall;
  if (call === undefined) {
    return domainFailure("an emission-tool panel verdict source record carries no accepted call to replay");
  }
  // The record's emission claims select a VERDICT registry cell: a
  // panel-verdict-source record for another producer kind is not replayable
  // through this seam. The parse already refused non-verdict accepted calls;
  // this check narrows the durable provenance string for the port's claims.
  if (record.source.producerKind !== "judge-verdict" && record.source.producerKind !== "refutation-verdict") {
    return domainFailure(`the record's producer kind ${record.source.producerKind} is not a panel verdict kind`);
  }
  const claimsVersion = record.source.emissionSchemaVersion;
  if (claimsVersion === undefined) {
    // Unreachable for a PARSED record (the exact-key-set validation requires
    // the version); the guard covers a constructor-built record instead of a
    // non-null assertion.
    return domainFailure("an emission-tool panel verdict source record carries no issued schema version");
  }
  const replayed = port.replayAcceptedCall(
    canonicalRecord({
      requestId: record.requestId,
      kind: record.source.producerKind,
      version: claimsVersion,
    }),
    call,
    rawJson,
  );
  if (!replayed.ok) {
    return domainFailure(`the record's emission claims select no frozen registry cell: ${replayed.error}`);
  }
  if (replayed.value.schemaDigest !== record.source.schemaDigest) {
    return domainFailure(`the record's schema digest does not certify the frozen registry digest ${replayed.value.schemaDigest}`);
  }
  const selection = replayed.value.selection;
  if (selection.kind !== "emission-tool-arguments") {
    return domainFailure(`replaying the record's accepted call did not reproduce the accepted emission selection (${selection.kind})`);
  }
  if (selection.call.toolCallId !== record.source.toolCallId) {
    return domainFailure(`the replayed call identity ${selection.call.toolCallId} does not match the recorded ${record.source.toolCallId}`);
  }
  return domainSuccess(selection);
}

export type PersistentArchitecturePanelEvent =
  | Readonly<{ schemaVersion: 1; type: "architecture-candidate-accepted"; request: PanelRequestIdentity; value: ArchitectureCandidateResult }>
  | Readonly<{ schemaVersion: 1; type: "architecture-candidate-rejected"; request: PanelRequestIdentity; attempt: SemanticAttempt; category: "malformed-result" | "result-binding-mismatch"; message: string }>
  | Readonly<{ schemaVersion: 1; type: "architecture-judge-accepted"; request: PanelRequestIdentity; value: JudgeVerdict; source: PanelVerdictSource }>
  | Readonly<{ schemaVersion: 1; type: "architecture-judge-rejected"; request: PanelRequestIdentity; attempt: SemanticAttempt; category: "malformed-result" | "result-binding-mismatch"; message: string }>
  | Readonly<{ schemaVersion: 1; type: "architecture-ranking-completed"; ranking: readonly CandidateRanking[] }>;

export type PersistentRefutationPanelEvent =
  | Readonly<{ schemaVersion: 1; type: "refutation-verdict-accepted"; request: PanelRequestIdentity; value: VerdictEnvelope<RefutationVerdict>; source: PanelVerdictSource }>
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
  switch (state.stage) {
    case "awaiting-candidates": {
      const requests = pendingAuthorities(state.authority.candidateRoster, state.slots);
      return requests === null ? null : Object.freeze({ kind: "spawn-architecture-candidates", runId: state.authority.runId, requests });
    }
    case "awaiting-judges": {
      const requests = pendingAuthorities(state.authority.judgeRoster, state.slots);
      return requests === null ? null : Object.freeze({ kind: "spawn-architecture-judges", runId: state.authority.runId, requests });
    }
    case "ready-to-aggregate": return Object.freeze({ kind: "architecture-aggregate-ready", runId: state.authority.runId });
    case "terminal-blocked": return Object.freeze({ kind: "architecture-blocked", runId: state.authority.runId, diagnostic: state.diagnostic });
    case "done": return Object.freeze({ kind: "architecture-done", runId: state.authority.runId, ranking: state.ranking });
  }
}

function refutationAction(state: RefutationPanelState): RefutationPanelAction | null {
  switch (state.stage) {
    case "awaiting-verdicts": {
      const requests = pendingAuthorities(state.authority.verifierRoster, state.slots);
      return requests === null ? null : Object.freeze({ kind: "spawn-refutation-verifiers", runId: state.authority.runId, requests });
    }
    case "ready-to-tally": return Object.freeze({ kind: "refutation-tally-ready", runId: state.authority.runId });
    case "terminal-blocked": return Object.freeze({ kind: "refutation-blocked", runId: state.authority.runId, diagnostic: state.diagnostic });
    case "done": return Object.freeze({ kind: "refutation-done", runId: state.authority.runId, decision: state.decision });
  }
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
function jsonEqual(left: unknown, right: unknown): boolean {
  const withoutDerivedViews = (value: unknown): string | undefined =>
    JSON.stringify(value, (key, entry: unknown) => (DERIVED_ROSTER_VIEWS.has(key) ? undefined : entry));
  try { return withoutDerivedViews(left) === withoutDerivedViews(right); } catch { return false; }
}

export function parsePersistentArchitecturePanelEvent(
  state: ArchitecturePanelState,
  raw: unknown,
  resolver: PublicationAuthorityResolver,
): PersistentPanelResult<PersistentArchitecturePanelEvent> {
  if (!architectureStateProofs.has(state)) return persistentFailure(panelError("architecture", "malformed-checkpoint", "event parsing requires a parser-produced architecture state"));
  const envelope = safeRecord(raw, ["schemaVersion", "type", "request", "value", "attempt", "category", "message", "ranking", "source"]);
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
    const exact = safeRecord(raw, ["schemaVersion", "type", "request", "value", "source"]);
    if (exact === null || state.stage !== "awaiting-judges") return persistentFailure(panelError("architecture", "unexpected-event", `judge result is not accepted during ${state.stage}`));
    const resolved = resolvePanelRequest("architecture", state.authority.judgeRoster, exact.request, resolver);
    if (!resolved.ok) return resolved;
    const located = locateProgress(state.authority.judgeRoster, state.slots, resolved.value.expected.requestId);
    if (!located.ok) return located;
    const criterion = boundJudgeCriterion(state.authority, resolved.value.expected.slotId);
    if (!criterion.ok) return criterion;
    const value = parseCanonicalJudge(exact.value, state.authority, criterion.value);
    if (!value.ok) return persistentFailure(panelError("architecture", "request-binding-mismatch", value.error.message, { requestId: resolved.value.expected.requestId, slotId: resolved.value.expected.slotId }));
    // The accepted event's source arm: absent is the historical projection
    // (genuinely pre-feature accepted events were extraction); present must be
    // exact — malformed present-day source fields are NOT historical absence.
    const source = projectPanelVerdictSourceArm(exact.source);
    if (!source.ok) return persistentFailure(panelError("architecture", "malformed-event", source.error));
    return persistentSuccess(architectureEvent(Object.freeze({ schemaVersion: 1, type: "architecture-judge-accepted", request: resolved.value.identity, value: value.value, source: source.value })));
  }
  // One branch per rejection kind rather than a shared stage-guard prelude and
  // a re-test of the same conditions below it: the paired form left a third
  // "wrong stage" arm that the guards had already made unreachable, and the
  // re-test was the only thing narrowing `state` for its own roster.
  if (envelope.type === "architecture-candidate-rejected") {
    const exact = safeRecord(raw, ["schemaVersion", "type", "request", "attempt", "category", "message"]);
    if (exact === null) return persistentFailure(panelError("architecture", "malformed-event", "architecture rejection event contains unknown or missing fields"));
    if (state.stage !== "awaiting-candidates") {
      return persistentFailure(panelError("architecture", "unexpected-event", `candidate rejection is not accepted during ${state.stage}`));
    }
    const rejection = parseRejection(exact, "architecture", state.authority.candidateRoster, state.slots, resolver);
    if (!rejection.ok) return rejection;
    return persistentSuccess(architectureEvent(Object.freeze({ schemaVersion: 1, type: envelope.type, ...rejection.value })));
  }
  if (envelope.type === "architecture-judge-rejected") {
    const exact = safeRecord(raw, ["schemaVersion", "type", "request", "attempt", "category", "message"]);
    if (exact === null) return persistentFailure(panelError("architecture", "malformed-event", "architecture rejection event contains unknown or missing fields"));
    if (state.stage !== "awaiting-judges") {
      return persistentFailure(panelError("architecture", "unexpected-event", `judge rejection is not accepted during ${state.stage}`));
    }
    const rejection = parseRejection(exact, "architecture", state.authority.judgeRoster, state.slots, resolver);
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
  const envelope = safeRecord(raw, ["schemaVersion", "type", "request", "value", "attempt", "category", "message", "decision", "source"]);
  if (envelope === null || envelope.schemaVersion !== 1 || typeof envelope.type !== "string") return persistentFailure(panelError("refutation", "malformed-event", "refutation event must be an exact schemaVersion 1 data record"));
  if (envelope.type === "refutation-verdict-accepted") {
    const exact = safeRecord(raw, ["schemaVersion", "type", "request", "value", "source"]);
    if (exact === null || state.stage !== "awaiting-verdicts") return persistentFailure(panelError("refutation", "unexpected-event", `verdict is not accepted during ${state.stage}`));
    const resolved = resolvePanelRequest("refutation", state.authority.verifierRoster, exact.request, resolver);
    if (!resolved.ok) return resolved;
    const located = locateProgress(state.authority.verifierRoster, state.slots, resolved.value.expected.requestId);
    if (!located.ok) return located;
    const boundLens = boundRefutationLens(state.authority, resolved.value.expected.slotId);
    if (!boundLens.ok) return boundLens;
    const value = parseCanonicalRefutation(exact.value, state.authority, boundLens.value);
    if (!value.ok) return persistentFailure(panelError("refutation", "request-binding-mismatch", value.error.message, { requestId: resolved.value.expected.requestId, slotId: resolved.value.expected.slotId }));
    // The same source-arm projection the judge events use (AD-8 historical
    // projection; malformed present-day arms refuse).
    const source = projectPanelVerdictSourceArm(exact.source);
    if (!source.ok) return persistentFailure(panelError("refutation", "malformed-event", source.error));
    return persistentSuccess(refutationEvent(Object.freeze({ schemaVersion: 1, type: "refutation-verdict-accepted", request: resolved.value.identity, value: value.value, source: source.value })));
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

function reduceArchitectureCandidateAccepted(state: ArchitecturePanelState, event: Extract<PersistentArchitecturePanelEvent, { type: "architecture-candidate-accepted" }>): PersistentPanelResult<PersistentArchitectureStep> {
  if (state.stage !== "awaiting-candidates") return persistentFailure(panelError("architecture", "unexpected-event", `candidate result is not accepted during ${state.stage}`));
  const result = durableAccepted(event.request, event.value);
  const settled = settleAccepted(state.authority.candidateRoster, state.slots, result);
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

function reduceArchitectureCandidateRejected(state: ArchitecturePanelState, event: Extract<PersistentArchitecturePanelEvent, { type: "architecture-candidate-rejected" }>): PersistentPanelResult<PersistentArchitectureStep> {
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

function reduceArchitectureJudgeRejected(state: ArchitecturePanelState, event: Extract<PersistentArchitecturePanelEvent, { type: "architecture-judge-rejected" }>): PersistentPanelResult<PersistentArchitectureStep> {
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

function reduceArchitectureJudgeAccepted(state: ArchitecturePanelState, event: Extract<PersistentArchitecturePanelEvent, { type: "architecture-judge-accepted" }>): PersistentPanelResult<PersistentArchitectureStep> {
  if (state.stage !== "awaiting-judges") return persistentFailure(panelError("architecture", "unexpected-event", `judge result is not accepted during ${state.stage}`));
  const result = durableAccepted(event.request, event.value);
  const settled = settleAccepted(state.authority.judgeRoster, state.slots, result);
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

export function reducePersistentArchitecturePanel(state: ArchitecturePanelState, event: PersistentArchitecturePanelEvent): PersistentPanelResult<PersistentArchitectureStep> {
  try {
    if (!architectureStateProofs.has(state)) return persistentFailure(panelError("architecture", "malformed-checkpoint", "architecture reducer requires a parser-produced state"));
    if (state.stage === "done" || state.stage === "terminal-blocked") return terminalArchitecture(state);
    if (typeof event !== "object" || event === null || !architectureEventProofs.has(event)) return persistentFailure(panelError("architecture", "malformed-event", "architecture reducer requires a strictly parsed durable event"));
    switch (event.type) {
      case "architecture-candidate-accepted":
        return reduceArchitectureCandidateAccepted(state, event);
      case "architecture-candidate-rejected":
        return reduceArchitectureCandidateRejected(state, event);
      case "architecture-judge-rejected":
        return reduceArchitectureJudgeRejected(state, event);
      case "architecture-judge-accepted":
        return reduceArchitectureJudgeAccepted(state, event);
      case "architecture-ranking-completed": {
        if (state.stage !== "ready-to-aggregate") return persistentFailure(panelError("architecture", "unexpected-event", `ranking is not available during ${state.stage}`));
        const next = architectureState(Object.freeze({ ...state, stage: "done" as const, ranking: event.ranking }));
        return persistentSuccess(Object.freeze({ state: next, action: architectureAction(next) }));
      }
    }
  } catch (error) {
    // The message is KEPT. `requireRosterEntry`/`requireRosterAttempt` throw a
    // specific invariant violation naming the slot and attempt, and a bare
    // `catch {}` collapsed that into the same sentence a genuinely malformed
    // event produces — an operator could not tell a code regression from bad
    // input. Fail-closed is unchanged; only the diagnostic survives, exactly as
    // `panel-kernel`’s analogous catch already does.
    return persistentFailure(panelError(
      "architecture",
      "malformed-event",
      `architecture event could not be safely reduced: ${error instanceof Error ? error.message : String(error)}`,
    ));
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
      const settled = settleAccepted(state.authority.verifierRoster, state.slots, result);
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
  } catch (error) {
    // Same reason as the architecture reducer above: the thrown invariant names
    // the slot and attempt, and discarding it made a regression indistinguishable
    // from malformed input.
    return persistentFailure(panelError(
      "refutation",
      "malformed-event",
      `refutation event could not be safely reduced: ${error instanceof Error ? error.message : String(error)}`,
    ));
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

export function submitArchitectureJudgeResult(
  state: ArchitecturePanelState,
  resolver: PublicationAuthorityResolver,
  requestIdentity: unknown,
  rawJson: unknown,
  emission?: PanelVerdictEmissionSelectionOf<"judge-verdict">,
): PersistentPanelResult<PersistentArchitectureStep> {
  if (state.stage !== "awaiting-judges") return persistentFailure(panelError("architecture", "unexpected-event", `judge cannot be submitted during ${state.stage}`));
  const resolved = resolvePanelRequest("architecture", state.authority.judgeRoster, requestIdentity, resolver);
  if (!resolved.ok) return resolved;
  const located = locateProgress(state.authority.judgeRoster, state.slots, resolved.value.expected.requestId);
  if (!located.ok) return located;
  const bound = boundJudgeCriterion(state.authority, resolved.value.expected.slotId);
  if (!bound.ok) return bound;
  // AD-8: the verdict-source selection runs BEFORE the authoritative parse —
  // `foldVerdictSubmission` selects which bytes reach `parseJudgeVerdict`, and
  // the parse keeps its criterion binding and complete candidate coverage (the
  // source can never override issuance). Without an emission input the fold is
  // this seam's pre-selection behavior exactly.
  const issuanceProblem = panelVerdictEmissionIssuanceProblem(emission, resolved.value.expected.requestId, "architecture");
  if (issuanceProblem !== null) return persistentFailure(issuanceProblem);
  const fold = foldVerdictSubmission({
    label: "judge verdict",
    expectedRequestId: resolved.value.expected.requestId,
    emission,
    rawJson,
    parse: (target): ParseResult<JudgeVerdict> => typeof target === "string"
      ? parseJudgeVerdict(target, bound.value, state.authority.candidateIds)
      : fail(["judge result must be raw JSON text"]),
    classifyRaw: (target) => publicResultClaimsForeignAuthority(
      target,
      bound.value,
      "rankings",
      "candidate",
      ["candidate", "score", "fatal_flaw", "strongest_idea"],
      state.authority.candidateIds,
    ) ? "request-binding-mismatch" : "malformed-result",
    foreignAuthorityMessage: "judge criterion or candidate claims do not match the canonical request slot",
  });
  if (fold.kind === "rejected") {
    return reduceParsedArchitecture(state, rejectionEvent("architecture", "judge", resolved.value.identity, resolved.value.expected, panelError("architecture", fold.errorKind, fold.message)) as PersistentArchitecturePanelEvent, resolver);
  }
  return reduceParsedArchitecture(state, Object.freeze({ schemaVersion: 1, type: "architecture-judge-accepted", request: resolved.value.identity, value: fold.value, source: fold.source }), resolver);
}

export function submitRefutationVerdict(
  state: RefutationPanelState,
  resolver: PublicationAuthorityResolver,
  requestIdentity: unknown,
  rawJson: unknown,
  emission?: PanelVerdictEmissionSelectionOf<"refutation-verdict">,
): PersistentPanelResult<PersistentRefutationStep> {
  if (state.stage !== "awaiting-verdicts") return persistentFailure(panelError("refutation", "unexpected-event", `verdict cannot be submitted during ${state.stage}`));
  const resolved = resolvePanelRequest("refutation", state.authority.verifierRoster, requestIdentity, resolver);
  if (!resolved.ok) return resolved;
  const located = locateProgress(state.authority.verifierRoster, state.slots, resolved.value.expected.requestId);
  if (!located.ok) return located;
  const boundLens = boundRefutationLens(state.authority, resolved.value.expected.slotId);
  if (!boundLens.ok) return boundLens;
  const lens = boundLens.value;
  const findingIds = state.authority.findings.map(({ id }) => id);
  // AD-8, as the judge seam above: selection before the authoritative parse;
  // the parse keeps its lens binding and complete finding coverage (FR-012).
  const issuanceProblem = panelVerdictEmissionIssuanceProblem(emission, resolved.value.expected.requestId, "refutation");
  if (issuanceProblem !== null) return persistentFailure(issuanceProblem);
  const fold = foldVerdictSubmission({
    label: "refutation verdict",
    expectedRequestId: resolved.value.expected.requestId,
    emission,
    rawJson,
    parse: (target): ParseResult<VerdictEnvelope<RefutationVerdict>> => typeof target === "string"
      ? parseRefutationVerdict(target, lens, findingIds)
      : fail(["refutation result must be raw JSON text"]),
    classifyRaw: (target) => publicResultClaimsForeignAuthority(
      target,
      lens,
      "verdicts",
      "finding_id",
      ["finding_id", "verdict", "reasoning"],
      findingIds,
    ) ? "request-binding-mismatch" : "malformed-result",
    foreignAuthorityMessage: "refutation criterion or Finding claims do not match the canonical request slot",
  });
  if (fold.kind === "rejected") {
    return reduceParsedRefutation(state, rejectionEvent("refutation", "verdict", resolved.value.identity, resolved.value.expected, panelError("refutation", fold.errorKind, fold.message)) as PersistentRefutationPanelEvent, resolver);
  }
  return reduceParsedRefutation(state, Object.freeze({ schemaVersion: 1, type: "refutation-verdict-accepted", request: resolved.value.identity, value: fold.value, source: fold.source }), resolver);
}

/**
 * Records a capture rejection for one refutation verdict: the attempt's bytes
 * never landed (the harness terminally rejected the capture, e.g. a child that
 * exited without a final payload), so there is no verdict to parse and the
 * slot advances to its attempt-2 retry with the capture diagnostic as the
 * rejection message. `submitRefutationVerdict` cannot record this — its
 * diagnostic is derived from parsing bytes that never landed — so the resume
 * that detects the tombstone calls this with the capture runtime's own
 * diagnostic instead. The category is `malformed-result` because the verdict
 * was malformed by absence: it never existed as a valid payload.
 */
export function rejectRefutationVerdict(state: RefutationPanelState, resolver: PublicationAuthorityResolver, requestIdentity: unknown, diagnostic: string): PersistentPanelResult<PersistentRefutationStep> {
  if (state.stage !== "awaiting-verdicts") return persistentFailure(panelError("refutation", "unexpected-event", `a capture rejection cannot be recorded during ${state.stage}`));
  const resolved = resolvePanelRequest("refutation", state.authority.verifierRoster, requestIdentity, resolver);
  if (!resolved.ok) return resolved;
  const located = locateProgress(state.authority.verifierRoster, state.slots, resolved.value.expected.requestId);
  if (!located.ok) return located;
  return reduceParsedRefutation(state, rejectionEvent("refutation", "verdict", resolved.value.identity, located.value.expected, panelError("refutation", "malformed-result", diagnostic)) as PersistentRefutationPanelEvent, resolver);
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
  } catch (error) {
    // The message is KEPT, for the reason the sibling reducers above document:
    // a bare `catch {}` makes a code regression indistinguishable from bad
    // input. Fail-closed is unchanged; only the diagnostic survives.
    return persistentFailure(panelError("architecture", "invalid-aggregate", `judge roster could not be safely aggregated: ${error instanceof Error ? error.message : String(error)}`));
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
  } catch (error) {
    // Same reasoning as `aggregateArchitecturePanel` above: keep the message.
    return persistentFailure(panelError("refutation", "invalid-aggregate", `verifier roster could not be safely tallied: ${error instanceof Error ? error.message : String(error)}`));
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

const _architectureLensRemainsDisjoint: Exclude<PanelLens, ReviewLens> = "simplicity-first";
const _refutationLensRemainsDisjoint: Exclude<ReviewLens, PanelLens> = "reproduction";
void _architectureLensRemainsDisjoint;
void _refutationLensRemainsDisjoint;
