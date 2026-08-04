import { describe, expect, it } from "vitest";
import {
  PANEL_PROGRAM_MODEL_PROFILES,
  isParallelSpawnBatch,
  reduceArchitectureProgram,
  reduceRefutationProgram,
  startArchitectureProgram,
  startRefutationProgram,
  type ArchitectureEngineOperation,
  type ArchitectureProgramState,
  type HeadlessSpawnRequest,
  type ProgramResult,
  type ProgramStep,
  type RefutationProgramEvent,
  type RefutationProgramState,
  type SpawnBatchAction,
} from "../../src/core/panel-program";

const architectureInput = {
  candidateLenses: ["simplicity-first", "type-driven-fp"] as const,
  judgeCriteria: ["simplicity", "pure functional core", "codebase fit + effort"] as const,
};

const refutationInput = {
  criticalFindingIds: ["T1:code-reviewer-1", "T2:security-agent-1"],
  lenses: ["reproduction", "intent", "blast-radius"] as const,
};

function parsed<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected ParseResult success");
  return result.value;
}

function reduced<T>(result: ProgramResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected reducer success, got ${result.error.kind}`);
  return result.value;
}

function architectureStart(): ProgramStep<ArchitectureProgramState> {
  return parsed(startArchitectureProgram(architectureInput));
}

function refutationStart(): ProgramStep<RefutationProgramState> {
  return parsed(startRefutationProgram(refutationInput));
}

const spawnSucceeded = (requestId: string, attempt: 1 | 2 = 1) => ({
  type: "spawn-outcome" as const,
  requestId,
  attempt,
  outcome: "succeeded" as const,
});

const engineSucceeded = (operationId: ArchitectureEngineOperation) => ({
  type: "engine-outcome" as const,
  operationId,
  outcome: "succeeded" as const,
});

function enterCandidates(): ProgramStep<ArchitectureProgramState> {
  const start = architectureStart();
  const prepared = reduced(reduceArchitectureProgram(
    start.state,
    spawnSucceeded("architecture:interview"),
  ));
  return reduced(reduceArchitectureProgram(
    prepared.state,
    engineSucceeded("architecture-prepare-candidates"),
  ));
}

function enterJudges(): ProgramStep<ArchitectureProgramState> {
  let step = enterCandidates();
  for (const id of ["architecture:candidate:1", "architecture:candidate:2"]) {
    step = reduced(reduceArchitectureProgram(step.state, spawnSucceeded(id)));
  }
  return reduced(reduceArchitectureProgram(
    step.state,
    engineSucceeded("architecture-prepare-judges"),
  ));
}

function enterVerifiers(): ProgramStep<RefutationProgramState> {
  const start = refutationStart();
  return reduced(reduceRefutationProgram(start.state, {
    type: "engine-outcome",
    operationId: "refutation-prepare-verifiers",
    outcome: "succeeded",
  }));
}

describe("architecture panel program", () => {
  it("emits the exact interview → candidates → judges → aggregate → finalize ordering", () => {
    let step = architectureStart();
    expect(step.action).toMatchObject({
      type: "await-user",
      request: {
        id: "architecture:interview",
        agent: "arch-interviewer-agent",
        interaction: "interactive",
        modelProfile: PANEL_PROGRAM_MODEL_PROFILES.architecture,
        attempt: 1,
      },
    });

    step = reduced(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:interview")));
    expect(step.action).toMatchObject({ type: "engine-operation", operation: "architecture-prepare-candidates" });

    step = reduced(reduceArchitectureProgram(step.state, engineSucceeded("architecture-prepare-candidates")));
    expect(step.action?.type).toBe("spawn-batch");
    if (step.action?.type !== "spawn-batch") throw new Error("expected candidate batch");
    expect(step.action.requests.map((request) => request.id)).toEqual([
      "architecture:candidate:1",
      "architecture:candidate:2",
    ]);
    expect(step.action.requests.map((request) => request.outputContract)).toEqual([
      "non-empty architecture candidate for design lens simplicity-first",
      "non-empty architecture candidate for design lens type-driven-fp",
    ]);
    expect(step.action.requests.every((request) =>
      request.interaction === "headless" &&
      request.modelProfile === PANEL_PROGRAM_MODEL_PROFILES.design,
    )).toBe(true);
    expect(isParallelSpawnBatch(step.action)).toBe(true);

    // Completion order is deliberately opposite to dispatch order.
    step = reduced(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:candidate:2")));
    expect(step.action).toBeNull();
    step = reduced(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:candidate:1")));
    expect(step.action).toMatchObject({ type: "engine-operation", operation: "architecture-prepare-judges" });

    step = reduced(reduceArchitectureProgram(step.state, engineSucceeded("architecture-prepare-judges")));
    expect(step.action?.type).toBe("spawn-batch");
    if (step.action?.type !== "spawn-batch") throw new Error("expected judge batch");
    expect(step.action.requests).toHaveLength(3);
    expect(step.action.requests.every((request) =>
      request.interaction === "headless" &&
      request.modelProfile === PANEL_PROGRAM_MODEL_PROFILES.judging,
    )).toBe(true);

    for (const id of ["architecture:judge:3", "architecture:judge:1", "architecture:judge:2"]) {
      step = reduced(reduceArchitectureProgram(step.state, spawnSucceeded(id)));
    }
    expect(step.action).toMatchObject({ type: "engine-operation", operation: "architecture-aggregate" });

    step = reduced(reduceArchitectureProgram(step.state, engineSucceeded("architecture-aggregate")));
    expect(step.action).toMatchObject({
      type: "await-user",
      request: {
        id: "architecture:finalize",
        agent: "architecture-agent",
        interaction: "interactive",
        modelProfile: PANEL_PROGRAM_MODEL_PROFILES.architectureFinalization,
      },
    });

    step = reduced(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:finalize")));
    expect(step.state.stage).toBe("complete");
    expect(step.action).toEqual({ type: "done", panel: "architecture", outcome: "completed" });
  });

  it("does not make aggregate reachable until every judge slot succeeds", () => {
    let step = enterJudges();
    step = reduced(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:judge:1")));
    step = reduced(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:judge:3")));
    expect(step.state.stage).toBe("judges");
    expect(step.action).toBeNull();

    const early = reduceArchitectureProgram(step.state, engineSucceeded("architecture-aggregate"));
    expect(early).toEqual({
      ok: false,
      error: { kind: "unexpected-event", panel: "architecture", stage: "judges" },
    });

    step = reduced(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:judge:2")));
    expect(step.state.stage).toBe("aggregate");
  });

  it("retries only the failed slot once, then blocks", () => {
    let step = enterCandidates();
    step = reduced(reduceArchitectureProgram(step.state, {
      type: "spawn-outcome",
      requestId: "architecture:candidate:2",
      attempt: 1,
      outcome: "failed",
      error: "empty artifact",
    }));
    expect(step.action).toMatchObject({
      type: "spawn-batch",
      requests: [{ id: "architecture:candidate:2", attempt: 2 }],
    });

    step = reduced(reduceArchitectureProgram(step.state, {
      type: "spawn-outcome",
      requestId: "architecture:candidate:2",
      attempt: 2,
      outcome: "failed",
      error: "still empty",
    }));
    expect(step.state.stage).toBe("blocked");
    expect(step.action).toEqual({
      type: "blocked",
      panel: "architecture",
      stage: "candidates",
      reason: "still empty",
    });
  });

  it("rejects duplicate, unknown, and stale-attempt outcomes without changing state", () => {
    let step = enterCandidates();
    step = reduced(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:candidate:1")));

    expect(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:candidate:1"))).toEqual({
      ok: false,
      error: { kind: "duplicate-outcome", requestId: "architecture:candidate:1" },
    });
    expect(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:candidate:99"))).toEqual({
      ok: false,
      error: { kind: "unknown-outcome", requestId: "architecture:candidate:99" },
    });

    step = reduced(reduceArchitectureProgram(step.state, {
      type: "spawn-outcome",
      requestId: "architecture:candidate:2",
      attempt: 1,
      outcome: "failed",
    }));
    expect(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:candidate:2", 1))).toEqual({
      ok: false,
      error: {
        kind: "stale-attempt-outcome",
        requestId: "architecture:candidate:2",
        expectedAttempt: 2,
        receivedAttempt: 1,
      },
    });

    // A settled slot stays a duplicate after the program advances stages.
    let advanced = enterCandidates();
    advanced = reduced(reduceArchitectureProgram(advanced.state, spawnSucceeded("architecture:candidate:1")));
    advanced = reduced(reduceArchitectureProgram(advanced.state, spawnSucceeded("architecture:candidate:2")));
    expect(reduceArchitectureProgram(advanced.state, spawnSucceeded("architecture:candidate:1"))).toEqual({
      ok: false,
      error: { kind: "duplicate-outcome", requestId: "architecture:candidate:1" },
    });
  });

  it("is deterministic for every candidate and judge completion order", () => {
    const run = (
      candidateOrder: readonly string[],
      judgeOrder: readonly string[],
    ): ProgramStep<ArchitectureProgramState> => {
      let step = enterCandidates();
      for (const id of candidateOrder) step = reduced(reduceArchitectureProgram(step.state, spawnSucceeded(id)));
      step = reduced(reduceArchitectureProgram(step.state, engineSucceeded("architecture-prepare-judges")));
      for (const id of judgeOrder) step = reduced(reduceArchitectureProgram(step.state, spawnSucceeded(id)));
      return step;
    };

    const forward = run(
      ["architecture:candidate:1", "architecture:candidate:2"],
      ["architecture:judge:1", "architecture:judge:2", "architecture:judge:3"],
    );
    const reverse = run(
      ["architecture:candidate:2", "architecture:candidate:1"],
      ["architecture:judge:3", "architecture:judge:2", "architecture:judge:1"],
    );
    expect(reverse).toEqual(forward);
    expect(forward.action).toMatchObject({ type: "engine-operation", operation: "architecture-aggregate" });
  });
});

describe("refutation panel program", () => {
  it("skips exactly when there are no critical findings", () => {
    const step = parsed(startRefutationProgram({
      criticalFindingIds: [],
      // A skip does not require or retain a verifier panel.
      lenses: [],
    }));
    expect(step.state.stage).toBe("skipped");
    expect(step.action).toEqual({
      type: "done",
      panel: "refutation",
      outcome: "skipped-no-critical-findings",
    });
  });

  it("emits prepare → non-empty verifier batch → tally → done in exact order", () => {
    let step = refutationStart();
    expect(step.action).toMatchObject({ type: "engine-operation", operation: "refutation-prepare-verifiers" });

    step = enterVerifiers();
    expect(step.action?.type).toBe("spawn-batch");
    if (step.action?.type !== "spawn-batch") throw new Error("expected verifier batch");
    expect(step.action.requests.map((request) => request.id)).toEqual([
      "refutation:verifier:1",
      "refutation:verifier:2",
      "refutation:verifier:3",
    ]);
    expect(step.action.requests.every((request) =>
      request.interaction === "headless" &&
      request.agent === "review-verifier-agent" &&
      request.modelProfile === PANEL_PROGRAM_MODEL_PROFILES.refutation &&
      request.outputContract.length > 0,
    )).toBe(true);

    step = reduced(reduceRefutationProgram(step.state, spawnSucceeded("refutation:verifier:2")));
    step = reduced(reduceRefutationProgram(step.state, spawnSucceeded("refutation:verifier:1")));
    expect(step.action).toBeNull();

    const earlyTally = reduceRefutationProgram(step.state, {
      type: "engine-outcome",
      operationId: "refutation-tally",
      outcome: "succeeded",
    });
    expect(earlyTally).toEqual({
      ok: false,
      error: { kind: "unexpected-event", panel: "refutation", stage: "verifiers" },
    });

    step = reduced(reduceRefutationProgram(step.state, spawnSucceeded("refutation:verifier:3")));
    expect(step.action).toMatchObject({ type: "engine-operation", operation: "refutation-tally" });
    step = reduced(reduceRefutationProgram(step.state, {
      type: "engine-outcome",
      operationId: "refutation-tally",
      outcome: "succeeded",
    }));
    expect(step.state.stage).toBe("complete");
    expect(step.action).toEqual({ type: "done", panel: "refutation", outcome: "completed" });
  });

  it("retries one verifier once and preserves deterministic completion", () => {
    let retried = enterVerifiers();
    retried = reduced(reduceRefutationProgram(retried.state, {
      type: "spawn-outcome",
      requestId: "refutation:verifier:1",
      attempt: 1,
      outcome: "failed",
    }));
    expect(retried.action).toMatchObject({
      type: "spawn-batch",
      requests: [{ id: "refutation:verifier:1", attempt: 2 }],
    });
    retried = reduced(reduceRefutationProgram(retried.state, spawnSucceeded("refutation:verifier:3")));
    retried = reduced(reduceRefutationProgram(retried.state, spawnSucceeded("refutation:verifier:1", 2)));
    retried = reduced(reduceRefutationProgram(retried.state, spawnSucceeded("refutation:verifier:2")));

    let ordinary = enterVerifiers();
    for (const id of ["refutation:verifier:1", "refutation:verifier:2", "refutation:verifier:3"]) {
      ordinary = reduced(reduceRefutationProgram(ordinary.state, spawnSucceeded(id)));
    }
    expect(retried.action).toEqual(ordinary.action);
    expect(retried.state.stage).toBe("tally");
  });
});

describe("panel program construction invariants", () => {
  it("rejects empty and duplicate fan-out definitions at construction", () => {
    const empty = startArchitectureProgram({ candidateLenses: [], judgeCriteria: [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.errors).toContain("candidate lenses must be non-empty");
      expect(empty.errors).toContain("judge criteria must be non-empty");
    }

    const duplicate = startRefutationProgram({
      criticalFindingIds: ["T1:f-1"],
      lenses: ["intent", "intent"],
    });
    expect(duplicate).toEqual({ ok: false, errors: ["refutation lenses must be distinct"] });
  });

  it("makes an interactive request unrepresentable in a parallel batch", () => {
    const headless: HeadlessSpawnRequest = {
      id: "headless",
      agent: "arch-designer-agent",
      modelProfile: PANEL_PROGRAM_MODEL_PROFILES.design,
      interaction: "headless",
      attempt: 1,
      outputContract: "candidate",
    };
    const valid: SpawnBatchAction = { type: "spawn-batch", execution: "parallel", requests: [headless] };
    expect(isParallelSpawnBatch(valid)).toBe(true);

    const interactive = architectureStart().action;
    if (interactive?.type !== "await-user") throw new Error("expected interactive request");
    const invalidRequests = [interactive.request] as const;
    // @ts-expect-error interactive requests cannot inhabit a parallel batch
    const invalid: SpawnBatchAction = { type: "spawn-batch", execution: "parallel", requests: invalidRequests };
    expect(isParallelSpawnBatch(invalid)).toBe(false);
  });

  it("rejects events from one panel's operation vocabulary in the other reducer", () => {
    const architecture = architectureStart();
    const wrong: RefutationProgramEvent = {
      type: "engine-outcome",
      operationId: "refutation-tally",
      outcome: "succeeded",
    };
    // The event unions are separate; this assertion checks the runtime boundary
    // for untrusted callers that deserialize an event before dispatch.
    // @ts-expect-error a refutation event cannot be passed to the architecture reducer
    expect(reduceArchitectureProgram(architecture.state, wrong)).toEqual({
      ok: false,
      error: { kind: "unexpected-event", panel: "architecture", stage: "interview" },
    });
  });
});
