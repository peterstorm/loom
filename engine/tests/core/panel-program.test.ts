import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  PANEL_PROGRAM_MODEL_PROFILES,
  architecturePanelCheckpoint,
  completePersistentArchitecturePanel,
  completePersistentRefutationPanel,
  isParallelSpawnBatch,
  panelRequestIdentity,
  parseArchitecturePanelAuthority,
  parseArchitecturePanelCheckpoint,
  parsePanelPersistenceReceipt,
  parsePersistentArchitecturePanelEvent,
  parsePersistentArchitecturePanelHistory,
  parsePersistentRefutationPanelEvent,
  parsePersistentRefutationPanelHistory,
  parseRefutationPanelAuthority,
  parseRefutationPanelCheckpoint,
  planArchitecturePanelPersistence,
  planRefutationPanelPersistence,
  reducePersistentArchitecturePanel,
  reducePersistentRefutationPanel,
  refutationPanelCheckpoint,
  replayPersistentArchitecturePanel,
  replayPersistentRefutationPanel,
  resumePersistentArchitecturePanel,
  reduceArchitectureProgram,
  reduceRefutationProgram,
  startArchitectureProgram,
  startPersistentArchitecturePanel,
  startPersistentRefutationPanel,
  startRefutationProgram,
  selectAcceptedArchitectureCandidates,
  selectAcceptedArchitectureJudges,
  selectAcceptedRefutationVerdicts,
  submitArchitectureCandidateResult,
  submitArchitectureJudgeResult,
  submitRefutationVerdict,
  type ArchitecturePanelAuthority,
  type ArchitecturePanelState,
  type PersistentArchitecturePanelEvent,
  type PersistentArchitecturePanelHistory,
  type PersistentArchitectureStep,
  type PersistentRefutationPanelEvent,
  type PersistentRefutationPanelHistory,
  type PersistentRefutationStep,
  type RefutationPanelAuthority,
  type RefutationPanelState,
  type ArchitectureEngineOperation,
  type ArchitectureProgramState,
  type HeadlessSpawnRequest,
  type ProgramStep,
  type RefutationProgramEvent,
  type RefutationProgramState,
  type SpawnBatchAction,
} from "../../src/core/panel-program";
import { parseWaveFindingId, type BriefFinding } from "../../src/core/review-panel";
import {
  createAtomicInitialPublicationClaimPort,
  createInitialBatchPublicationReconciler,
  createInitialPublicationEffectPort,
  createPublicationAuthorityResolver,
  parseAgentRequestAuthority,
  parseAgentRosterSlot,
  parseBatchPublishedReceipt,
  parseContextDigest,
  parseEffectId,
  parseOrchestrationRunId,
  parseRequestId,
  parseSlotId,
  prepareInitialBatchPublicationIntent,
  spawnBatchAction as issueSpawnBatchAction,
  type AgentRequestAuthority,
  type EffectId,
  type OrchestrationRunId,
  type SpawnRequest as IssuedSpawnRequest,
  type TrustedPublicationRegistrationLoader,
} from "../../src/core/orchestration-contract";

const waveId = (raw: string) => {
  const parsed = parseWaveFindingId(raw);
  if (parsed === null) throw new Error(`invalid test wave finding id: ${raw}`);
  return parsed;
};

const architectureInput = {
  candidateLenses: ["simplicity-first", "type-driven-fp"] as const,
  judgeCriteria: ["simplicity", "pure functional core", "codebase fit + effort"] as const,
};

const refutationInput = {
  criticalFindingIds: [waveId("T1:code-reviewer-1"), waveId("T2:security-agent-1")],
  lenses: ["reproduction", "intent", "blast-radius"] as const,
};

function parsed<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected ParseResult success");
  return result.value;
}

function reduced<T, E extends Readonly<{ kind: string }>>(
  result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: E }>,
): T {
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

  it("blocks on failed prepare and aggregate engine operations with the original reason", () => {
    const afterInterview = reduced(reduceArchitectureProgram(
      architectureStart().state,
      spawnSucceeded("architecture:interview"),
    ));
    const prepareFailed = reduced(reduceArchitectureProgram(afterInterview.state, {
      type: "engine-outcome",
      operationId: "architecture-prepare-candidates",
      outcome: "failed",
      error: "candidate manifest invalid",
    }));
    expect(prepareFailed.state).toMatchObject({ stage: "blocked", reason: "candidate manifest invalid" });
    expect(prepareFailed.action).toEqual({
      type: "blocked", panel: "architecture", stage: "prepare-candidates", reason: "candidate manifest invalid",
    });

    let aggregate = enterJudges();
    for (const id of ["architecture:judge:1", "architecture:judge:2", "architecture:judge:3"]) {
      aggregate = reduced(reduceArchitectureProgram(aggregate.state, spawnSucceeded(id)));
    }
    const aggregateFailed = reduced(reduceArchitectureProgram(aggregate.state, {
      type: "engine-outcome",
      operationId: "architecture-aggregate",
      outcome: "failed",
      error: "ranking invalid",
    }));
    expect(aggregateFailed.state).toMatchObject({ stage: "blocked", reason: "ranking invalid" });
    expect(aggregateFailed.action).toEqual({
      type: "blocked", panel: "architecture", stage: "aggregate", reason: "ranking invalid",
    });
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

  it("blocks on failed prepare and tally engine operations with the original reason", () => {
    const prepareFailed = reduced(reduceRefutationProgram(refutationStart().state, {
      type: "engine-outcome",
      operationId: "refutation-prepare-verifiers",
      outcome: "failed",
      error: "manifest invalid",
    }));
    expect(prepareFailed.state).toMatchObject({ stage: "blocked", reason: "manifest invalid" });
    expect(prepareFailed.action).toEqual({
      type: "blocked", panel: "refutation", stage: "prepare-verifiers", reason: "manifest invalid",
    });

    let tally = enterVerifiers();
    for (const id of ["refutation:verifier:1", "refutation:verifier:2", "refutation:verifier:3"]) {
      tally = reduced(reduceRefutationProgram(tally.state, spawnSucceeded(id)));
    }
    const tallyFailed = reduced(reduceRefutationProgram(tally.state, {
      type: "engine-outcome",
      operationId: "refutation-tally",
      outcome: "failed",
      error: "verdict set invalid",
    }));
    expect(tallyFailed.state).toMatchObject({ stage: "blocked", reason: "verdict set invalid" });
    expect(tallyFailed.action).toEqual({
      type: "blocked", panel: "refutation", stage: "tally", reason: "verdict set invalid",
    });
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

// ---------------------------------------------------------------------------
// Persistent authority-bound programs
// ---------------------------------------------------------------------------

const registrationBytes = new Map<string, readonly number[]>();
const bytes = (value: unknown): readonly number[] => [...new TextEncoder().encode(JSON.stringify(value))];
const registrationKey = ({ runId, effectId }: Readonly<{ runId: string; effectId: string }>) => `${runId}\u0000${effectId}`;
const registrationLoader: TrustedPublicationRegistrationLoader = (lookup) => {
  const found = registrationBytes.get(registrationKey(lookup));
  return found === undefined
    ? { ok: false, error: { kind: "publication-authority-unavailable", message: "not registered" } }
    : { ok: true, value: found };
};
const publicationResolver = createPublicationAuthorityResolver(registrationLoader);
const unavailableResolver = createPublicationAuthorityResolver(() => ({
  ok: false,
  error: { kind: "publication-authority-unavailable", field: "registration", message: "registration unavailable after restart" },
}));
const hexDigest = (seed: string): string => createHash("sha256").update(seed).digest("hex");
const panelBindings = {
  pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
  claude: { harness: "claude-code", model: "opus" },
} as const;

function authorityFor(
  runId: OrchestrationRunId,
  stage: string,
  slotIndex: number,
  attempt: 1 | 2,
  program: "architecture-panel" | "refutation-panel",
  role: "arch-designer-agent" | "arch-judge-agent" | "review-verifier-agent",
): AgentRequestAuthority {
  const profile = role === "arch-designer-agent" ? "panel-design" : role === "arch-judge-agent" ? "panel-judge" : "refutation";
  const skill = role === "arch-designer-agent" ? "architecture-tech-lead" : null;
  return parsed(parseAgentRequestAuthority({
    runId,
    requestId: parsed(parseRequestId(`${runId}:${stage}:${slotIndex}:${attempt}`)),
    slotId: parsed(parseSlotId(`${stage}:${slotIndex}`)),
    program,
    role,
    attempt,
    modelProfile: profile,
    harnessBinding: panelBindings,
    requiredSkill: skill,
    contextDigest: parsed(parseContextDigest(hexDigest(`${runId}:${stage}:${slotIndex}:${attempt}:context`))),
    outputSlot: `transcripts/${stage}-${slotIndex}-attempt-${attempt}.json`,
  }));
}

function rosterSlot(
  runId: OrchestrationRunId,
  stage: string,
  slotIndex: number,
  program: "architecture-panel" | "refutation-panel",
  role: "arch-designer-agent" | "arch-judge-agent" | "review-verifier-agent",
) {
  return parsed(parseAgentRosterSlot(
    authorityFor(runId, stage, slotIndex, 1, program, role),
    authorityFor(runId, stage, slotIndex, 2, program, role),
  ));
}

function publicationDigest(requests: readonly AgentRequestAuthority[], effectId: EffectId, runId: OrchestrationRunId): string {
  const canonical = {
    schemaVersion: 1,
    kind: "batch-published",
    effectId,
    runId,
    requestIds: requests.map(({ requestId }) => requestId),
    contextDigests: requests.map(({ contextDigest }) => contextDigest),
    issuedRequests: requests.map((authority) => ({
      authority,
      context: { digest: authority.contextDigest, slot: { kind: "fixed-artifact-slot", path: `contexts/${authority.contextDigest}.json` } },
    })),
  };
  return createHash("sha256").update(new TextEncoder().encode(JSON.stringify(canonical))).digest("hex");
}

let publicationSequence = 0;
function issue(requests: readonly AgentRequestAuthority[]): readonly IssuedSpawnRequest[] {
  publicationSequence += 1;
  const effectId = parsed(parseEffectId(`effect:panel-test:${publicationSequence}`));
  const runId = requests[0]!.runId;
  const rawRequests = requests.map((authority) => ({
    authority,
    context: { digest: authority.contextDigest, slot: `contexts/${authority.contextDigest}.json` },
  }));
  const rawReceipt = {
    schemaVersion: 1,
    kind: "batch-published",
    effectId,
    runId,
    requestIds: requests.map(({ requestId }) => requestId),
    contextDigests: requests.map(({ contextDigest }) => contextDigest),
    issuedRequests: rawRequests,
    publicationDigest: publicationDigest(requests, effectId, runId),
  };
  const receipt = parsed(parseBatchPublishedReceipt(rawReceipt));
  const intent = parsed(prepareInitialBatchPublicationIntent(runId, effectId, rawRequests));
  const reconcile = createInitialBatchPublicationReconciler(
    createInitialPublicationEffectPort(() => ({ ok: true, value: bytes(rawReceipt) })),
    createAtomicInitialPublicationClaimPort((request) => ({
      ok: true,
      value: { schemaVersion: 1, kind: "initial-publication-claimed", key: request.key, identity: request.identity },
    })),
  );
  const issuance = parsed(reconcile(intent));
  const action = parsed(issueSpawnBatchAction(issuance, rawRequests));
  registrationBytes.set(registrationKey(receipt), bytes(receipt));
  return action.requests;
}

type ArchitectureFixture = Readonly<{
  authority: ArchitecturePanelAuthority;
  candidates: readonly IssuedSpawnRequest[];
  judges: readonly IssuedSpawnRequest[];
}>;

function architectureFixture(suffix: string): ArchitectureFixture {
  const runId = parsed(parseOrchestrationRunId(`run.architecture.${suffix}`));
  const candidateSlots = [
    rosterSlot(runId, "candidate", 1, "architecture-panel", "arch-designer-agent"),
    rosterSlot(runId, "candidate", 2, "architecture-panel", "arch-designer-agent"),
  ];
  const judgeSlots = [
    rosterSlot(runId, "judge", 1, "architecture-panel", "arch-judge-agent"),
    rosterSlot(runId, "judge", 2, "architecture-panel", "arch-judge-agent"),
  ];
  const authority = parsed(parseArchitecturePanelAuthority({
    runId,
    candidateLenses: ["simplicity-first", "type-driven-fp"],
    judgeCriteria: ["simplicity", "pure functional core"],
    candidateSlots,
    judgeSlots,
  }));
  return { authority, candidates: issue(candidateSlots.map(({ attempts }) => attempts[0])), judges: issue(judgeSlots.map(({ attempts }) => attempts[0])) };
}

const findings: readonly [BriefFinding, BriefFinding] = [
  { id: waveId("T1:code-reviewer-1"), taskId: "T1", agent: "code-reviewer", severity: "critical", file: "src/a.ts", line: 10, claim: "first claim" },
  { id: waveId("T2:security-agent-1"), taskId: "T2", agent: "security-agent", severity: "critical", file: "src/b.ts", line: 20, claim: "second claim" },
];

type RefutationFixture = Readonly<{ authority: RefutationPanelAuthority; requests: readonly IssuedSpawnRequest[] }>;
function refutationFixture(suffix: string): RefutationFixture {
  const runId = parsed(parseOrchestrationRunId(`run.refutation.${suffix}`));
  const slots = [1, 2, 3].map((index) => rosterSlot(runId, "verifier", index, "refutation-panel", "review-verifier-agent"));
  const authority = parsed(parseRefutationPanelAuthority({
    runId,
    findings,
    lenses: ["reproduction", "intent", "blast-radius"],
    verifierSlots: slots,
  }));
  return { authority, requests: issue(slots.map(({ attempts }) => attempts[0])) };
}

function candidatePayload(authority: ArchitecturePanelAuthority, index: number) {
  return { lens: authority.candidateLenses[index], candidate: authority.candidateIds[index], artifact: `# Candidate ${index + 1}` };
}
function judgeJson(authority: ArchitecturePanelAuthority, index: number): string {
  return JSON.stringify({
    criterion: authority.judgeCriteria[index],
    rankings: authority.candidateIds.map((candidate, candidateIndex) => ({
      candidate,
      score: index === 0 ? 9 - candidateIndex : 7 + candidateIndex,
      fatal_flaw: null,
      strongest_idea: `idea ${candidateIndex + 1}`,
    })).sort((left, right) => right.score - left.score),
  });
}
function verdictJson(
  authority: RefutationPanelAuthority,
  index: number,
  votes: readonly ["refuted" | "upheld" | "uncertain", "refuted" | "upheld" | "uncertain"],
): string {
  return JSON.stringify({
    criterion: authority.lenses[index],
    verdicts: authority.findings.map((finding, findingIndex) => ({
      finding_id: finding.id,
      verdict: votes[findingIndex],
      reasoning: `${authority.lenses[index]} reason for ${finding.id}`,
    })),
  });
}

function submitCandidate(state: ArchitecturePanelState, fixture: ArchitectureFixture, index: number) {
  return submitArchitectureCandidateResult(state, publicationResolver, panelRequestIdentity(fixture.candidates[index]!), candidatePayload(fixture.authority, index));
}
function submitJudge(state: ArchitecturePanelState, fixture: ArchitectureFixture, index: number) {
  return submitArchitectureJudgeResult(state, publicationResolver, panelRequestIdentity(fixture.judges[index]!), judgeJson(fixture.authority, index));
}

const votes = [
  ["refuted", "upheld"],
  ["refuted", "upheld"],
  ["uncertain", "uncertain"],
] as const;

function fullArchitectureHistory(fixture: ArchitectureFixture) {
  let step = startPersistentArchitecturePanel(fixture.authority);
  const events: PersistentArchitecturePanelEvent[] = [];
  for (const index of [1, 0]) {
    step = reduced(submitCandidate(step.state, fixture, index));
    events.push(step.recordedEvent!);
  }
  for (const index of [1, 0]) {
    step = reduced(submitJudge(step.state, fixture, index));
    events.push(step.recordedEvent!);
  }
  step = reduced(completePersistentArchitecturePanel(step.state, publicationResolver));
  events.push(step.recordedEvent!);
  return { step, events };
}

function fullRefutationHistory(fixture: RefutationFixture) {
  let step = startPersistentRefutationPanel(fixture.authority);
  const events: PersistentRefutationPanelEvent[] = [];
  for (const index of [2, 0, 1]) {
    step = reduced(submitRefutationVerdict(
      step.state,
      publicationResolver,
      panelRequestIdentity(fixture.requests[index]!),
      verdictJson(fixture.authority, index, votes[index]!),
    ));
    events.push(step.recordedEvent!);
  }
  step = reduced(completePersistentRefutationPanel(step.state, publicationResolver));
  events.push(step.recordedEvent!);
  return { step, events };
}

describe("persistent panel authority", () => {
  it("fails closed for malformed Findings, unsafe paths, role/program/count mismatch, and cross-roster reuse", () => {
    const architecture = architectureFixture("negative-authority");
    const refutation = refutationFixture("negative-authority");
    for (const malformed of [
      { ...findings[0], id: "T1:" },
      { ...findings[0], taskId: "" },
      { ...findings[0], agent: "" },
      { ...findings[0], file: "../escape.ts" },
      { ...findings[0], claim: "" },
      { ...findings[0], line: 0 },
    ]) {
      expect(parseRefutationPanelAuthority({
        runId: refutation.authority.runId,
        findings: [malformed],
        lenses: refutation.authority.lenses,
        verifierSlots: refutation.authority.verifierRoster.orderedSlots,
      })).toMatchObject({ ok: false, error: { kind: "invalid-authority" } });
    }

    expect(parseArchitecturePanelAuthority({
      runId: architecture.authority.runId,
      candidateLenses: architecture.authority.candidateLenses,
      judgeCriteria: architecture.authority.judgeCriteria,
      candidateSlots: architecture.authority.judgeRoster.orderedSlots,
      judgeSlots: architecture.authority.candidateRoster.orderedSlots,
    })).toMatchObject({ ok: false, error: { kind: "invalid-authority" } });

    expect(parseArchitecturePanelAuthority({
      runId: architecture.authority.runId,
      candidateLenses: architecture.authority.candidateLenses,
      judgeCriteria: architecture.authority.judgeCriteria,
      candidateSlots: architecture.authority.candidateRoster.orderedSlots,
      judgeSlots: architecture.authority.candidateRoster.orderedSlots,
    })).toMatchObject({ ok: false, error: { kind: "invalid-authority" } });

    expect(parseRefutationPanelAuthority({
      runId: refutation.authority.runId,
      findings: [findings[0], { ...findings[1], id: findings[0].id, taskId: findings[0].taskId }],
      lenses: refutation.authority.lenses,
      verifierSlots: refutation.authority.verifierRoster.orderedSlots,
    })).toMatchObject({
      ok: false,
      error: { kind: "invalid-authority", message: expect.stringContaining("findings must be distinct") },
    });
  });

  it("uses shared identity/path/prose parsers and stores only canonical sanitized Findings", () => {
    const fixture = refutationFixture("sanitized-authority");
    const parsedAuthority = reduced(parseRefutationPanelAuthority({
      runId: fixture.authority.runId,
      findings: [{ ...findings[0], agent: "code-reviewer", claim: " {claim} text ", file: "src/a.ts" }],
      lenses: fixture.authority.lenses,
      verifierSlots: fixture.authority.verifierRoster.orderedSlots,
    }));
    expect(parsedAuthority.findings[0]).toMatchObject({
      id: findings[0].id,
      agent: "code-reviewer",
      claim: "claim text",
      file: "src/a.ts",
    });
  });
});

describe("persistent architecture panel", () => {
  it("binds candidate and criterion exactly to the canonical request slot; permutations consume only that slot retry", () => {
    const fixture = architectureFixture("slot-binding");
    let step = startPersistentArchitecturePanel(fixture.authority);
    step = reduced(submitArchitectureCandidateResult(
      step.state,
      publicationResolver,
      panelRequestIdentity(fixture.candidates[0]!),
      candidatePayload(fixture.authority, 1),
    ));
    expect(step.state.stage).toBe("awaiting-candidates");
    expect(selectAcceptedArchitectureCandidates(step.state)).toEqual([]);
    expect(step.action).toMatchObject({ requests: [{ attempt: 2, slotId: fixture.authority.candidateRoster.orderedSlots[0]!.slotId }] });

    const retry = issue([fixture.authority.candidateRoster.orderedSlots[0]!.attempts[1]])[0]!;
    step = reduced(submitArchitectureCandidateResult(
      step.state,
      publicationResolver,
      panelRequestIdentity(retry),
      candidatePayload(fixture.authority, 0),
    ));
    step = reduced(submitCandidate(step.state, fixture, 1));
    expect(step.state.stage).toBe("awaiting-judges");

    step = reduced(submitArchitectureJudgeResult(
      step.state,
      publicationResolver,
      panelRequestIdentity(fixture.judges[0]!),
      judgeJson(fixture.authority, 1),
    ));
    expect(step.state.stage).toBe("awaiting-judges");
    expect(selectAcceptedArchitectureJudges(step.state)).toEqual([]);
    expect(step.recordedEvent).toMatchObject({
      type: "architecture-judge-rejected",
      category: "result-binding-mismatch",
    });
    expect(step.recordedEvent?.type === "architecture-judge-rejected" ? step.recordedEvent.message : "").toContain("criterion");
    expect(step.action).toMatchObject({ requests: [{ attempt: 2, slotId: fixture.authority.judgeRoster.orderedSlots[0]!.slotId }] });
  });

  it("accepts only issued request identity plus raw output, preserves exact rehydration errors, and rejects duplicates", () => {
    const fixture = architectureFixture("submission-contract");
    const identity = JSON.parse(JSON.stringify(panelRequestIdentity(fixture.candidates[0]!)));
    const malformedIdentity = JSON.parse(JSON.stringify(identity));
    malformedIdentity.issuance.batchIndex = -1;
    expect(submitArchitectureCandidateResult(
      startPersistentArchitecturePanel(fixture.authority).state,
      publicationResolver,
      malformedIdentity,
      candidatePayload(fixture.authority, 0),
    )).toMatchObject({ ok: false, error: { kind: "malformed-event", message: expect.stringContaining("batchIndex") } });

    const unavailable = submitArchitectureCandidateResult(
      startPersistentArchitecturePanel(fixture.authority).state,
      unavailableResolver,
      identity,
      candidatePayload(fixture.authority, 0),
    );
    expect(unavailable).toMatchObject({
      ok: false,
      error: {
        kind: "request-rehydration-failed",
        requestId: fixture.candidates[0]!.authority.requestId,
        rehydration: { kind: "invalid-accepted-agent-result", field: "registration", message: "registration unavailable after restart" },
      },
    });

    let step = reduced(submitArchitectureCandidateResult(
      startPersistentArchitecturePanel(fixture.authority).state,
      publicationResolver,
      identity,
      candidatePayload(fixture.authority, 0),
    ));
    expect(step.recordedEvent).not.toHaveProperty("result");
    expect(step.recordedEvent).not.toHaveProperty("issuedRequest");
    const duplicate = submitArchitectureCandidateResult(step.state, publicationResolver, identity, candidatePayload(fixture.authority, 0));
    expect(duplicate).toMatchObject({ ok: false, error: { kind: "duplicate-result" } });
    expect(selectAcceptedArchitectureCandidates(step.state)).toHaveLength(1);
  });

  it("retries a malformed public judge submission once and terminal-blocks malformed JSON shape on attempt two", () => {
    const fixture = architectureFixture("judge-malformed-retry");
    let step = startPersistentArchitecturePanel(fixture.authority);
    const events: PersistentArchitecturePanelEvent[] = [];
    for (const index of [0, 1]) {
      step = reduced(submitCandidate(step.state, fixture, index));
      events.push(step.recordedEvent!);
    }

    const awaitingJudgeState = step.state;
    step = reduced(submitArchitectureJudgeResult(
      awaitingJudgeState,
      publicationResolver,
      panelRequestIdentity(fixture.judges[0]!),
      "not-json",
    ));
    events.push(step.recordedEvent!);
    expect(step.recordedEvent).toMatchObject({
      type: "architecture-judge-rejected",
      request: panelRequestIdentity(fixture.judges[0]!),
      attempt: 1,
      category: "malformed-result",
    });
    expect(step.recordedEvent).not.toHaveProperty("requestId");
    expect(parsePersistentArchitecturePanelEvent(
      awaitingJudgeState,
      JSON.parse(JSON.stringify(step.recordedEvent)),
      unavailableResolver,
    )).toMatchObject({
      ok: false,
      error: { kind: "request-rehydration-failed", requestId: fixture.judges[0]!.authority.requestId },
    });
    expect(step.state.stage).toBe("awaiting-judges");
    expect(step.action).toMatchObject({
      kind: "spawn-architecture-judges",
      requests: [{ attempt: 2, slotId: fixture.authority.judgeRoster.orderedSlots[0]!.slotId }],
    });
    expect(selectAcceptedArchitectureCandidates(step.state)).toHaveLength(2);
    expect(selectAcceptedArchitectureJudges(step.state)).toEqual([]);

    const retry = issue([fixture.authority.judgeRoster.orderedSlots[0]!.attempts[1]])[0]!;
    step = reduced(submitArchitectureJudgeResult(
      step.state,
      publicationResolver,
      panelRequestIdentity(retry),
      JSON.stringify({ criterion: fixture.authority.judgeCriteria[0], rankings: [] }),
    ));
    events.push(step.recordedEvent!);
    expect(step.recordedEvent).toMatchObject({
      type: "architecture-judge-rejected",
      attempt: 2,
      category: "malformed-result",
    });
    expect(step.state.stage).toBe("terminal-blocked");
    expect(step.action).toMatchObject({
      kind: "architecture-blocked",
      diagnostic: { retry: { eligible: false } },
    });
    expect(selectAcceptedArchitectureCandidates(step.state)).toHaveLength(2);
    expect(selectAcceptedArchitectureJudges(step.state)).toEqual([]);
    expect(reduced(replayPersistentArchitecturePanel(
      fixture.authority,
      JSON.parse(JSON.stringify(events)),
      publicationResolver,
    )).state).toEqual(step.state);
  });

  it("makes slot progress the only accepted-result authority at compile time and runtime", () => {
    const fixture = architectureFixture("single-slot-authority");
    const started = startPersistentArchitecturePanel(fixture.authority);
    if (started.state.stage !== "awaiting-candidates") throw new Error("expected candidate stage");
    const structuralState = {
      panel: "architecture" as const,
      authority: fixture.authority,
      stage: "awaiting-candidates" as const,
      slots: started.state.slots,
    };
    // @ts-expect-error persistent states require an inaccessible nominal parser/reducer proof
    const independentlyConstructed: ArchitecturePanelState = structuralState;
    void independentlyConstructed;
    expect(resumePersistentArchitecturePanel(structuralState as unknown as ArchitecturePanelState)).toMatchObject({
      ok: false,
      error: { kind: "malformed-checkpoint" },
    });

    const accepted = reduced(submitCandidate(started.state, fixture, 0)).state;
    expect(accepted).not.toHaveProperty("acceptedCandidates");
    expect(accepted).not.toHaveProperty("acceptedJudges");
    const selected = selectAcceptedArchitectureCandidates(accepted);
    expect(selected).toHaveLength(1);
    expect(Object.isFrozen(selected)).toBe(true);

    const refutation = startPersistentRefutationPanel(refutationFixture("single-slot-authority").authority).state;
    expect(refutation).not.toHaveProperty("acceptedVerdicts");
    expect(selectAcceptedRefutationVerdicts(refutation)).toEqual([]);
  });

  it("JSON replays every accepted/completion prefix and checkpoint idempotently through done", () => {
    const fixture = architectureFixture("restart");
    let step = startPersistentArchitecturePanel(fixture.authority);
    const events: PersistentArchitecturePanelEvent[] = [];
    const submissions = [
      () => submitCandidate(step.state, fixture, 1),
      () => submitCandidate(step.state, fixture, 0),
      () => submitJudge(step.state, fixture, 1),
      () => submitJudge(step.state, fixture, 0),
      () => completePersistentArchitecturePanel(step.state, publicationResolver),
    ];
    for (const submit of submissions) {
      step = reduced(submit());
      events.push(step.recordedEvent!);
      const jsonEvents = JSON.parse(JSON.stringify(events));
      const firstReplay = reduced(replayPersistentArchitecturePanel(fixture.authority, jsonEvents, publicationResolver));
      const secondReplay = reduced(replayPersistentArchitecturePanel(fixture.authority, jsonEvents, publicationResolver));
      expect(firstReplay.state).toEqual(step.state);
      expect(secondReplay.state).toEqual(firstReplay.state);
      const checkpoint = reduced(architecturePanelCheckpoint(step.state, events, publicationResolver));
      const resumed = reduced(parseArchitecturePanelCheckpoint(JSON.parse(JSON.stringify(checkpoint)), publicationResolver));
      expect(JSON.parse(JSON.stringify(resumed.state))).toEqual(JSON.parse(JSON.stringify(step.state)));
    }
    expect(step.state.stage).toBe("done");
    expect(events.at(-1)).not.toHaveProperty("roster");
  });

  it("strictly rejects forged completion payloads and checkpoint structural disagreement", () => {
    const fixture = architectureFixture("checkpoint-disagreement");
    const accepted = reduced(submitCandidate(startPersistentArchitecturePanel(fixture.authority).state, fixture, 0));
    const event = accepted.recordedEvent!;
    const checkpoint = reduced(architecturePanelCheckpoint(accepted.state, [event], publicationResolver));
    const forged = JSON.parse(JSON.stringify(checkpoint));
    forged.state.slots[0] = {
      slotId: forged.state.slots[0].slotId,
      status: "pending",
      nextAttempt: 1,
    };
    expect(parseArchitecturePanelCheckpoint(forged, publicationResolver)).toMatchObject({
      ok: false,
      error: { kind: "malformed-checkpoint", message: expect.stringContaining("disagrees") },
    });

    let ready = accepted;
    ready = reduced(submitCandidate(ready.state, fixture, 1));
    ready = reduced(submitJudge(ready.state, fixture, 0));
    ready = reduced(submitJudge(ready.state, fixture, 1));
    expect(parsePersistentArchitecturePanelEvent(ready.state, {
      schemaVersion: 1,
      type: "architecture-ranking-completed",
      ranking: [],
    }, publicationResolver)).toMatchObject({ ok: false, error: { kind: "invalid-aggregate" } });
  });

  it("keeps reduction total for malformed and cross-stage events", () => {
    const fixture = architectureFixture("transition-totality");
    const { step: done, events } = fullArchitectureHistory(fixture);
    const states: ArchitecturePanelState[] = [
      startPersistentArchitecturePanel(fixture.authority).state,
      reduced(replayPersistentArchitecturePanel(fixture.authority, events.slice(0, 2), publicationResolver)).state,
      reduced(replayPersistentArchitecturePanel(fixture.authority, events.slice(0, 4), publicationResolver)).state,
      done.state,
    ];
    const malformed = [{}, { schemaVersion: 1, type: "unknown" }, { schemaVersion: 1, type: "architecture-ranking-completed", ranking: [] }];
    for (const state of states) {
      for (const event of malformed) {
        expect(() => parsePersistentArchitecturePanelEvent(state, event, publicationResolver)).not.toThrow();
        expect(() => reducePersistentArchitecturePanel(state, event as PersistentArchitecturePanelEvent)).not.toThrow();
      }
    }
  });

  it("produces durable journal/checkpoint effects and accepts only exact receipts", () => {
    const fixture = architectureFixture("persistence-contract");
    const step = reduced(submitCandidate(startPersistentArchitecturePanel(fixture.authority).state, fixture, 0));
    const history = reduced(parsePersistentArchitecturePanelHistory(fixture.authority, [], publicationResolver));
    const effects = reduced(planArchitecturePanelPersistence(step, history, publicationResolver));
    expect(effects.map(({ kind }) => kind)).toEqual([
      "append-architecture-panel-event",
      "replace-architecture-panel-checkpoint",
    ]);

    // FR-021: a crash after the immutable append but before checkpoint replace
    // resumes from that append and plans only the next deterministic sequence.
    const append = effects[0];
    if (append.kind !== "append-architecture-panel-event") throw new Error("expected append effect first");
    const interruptedHistory = reduced(parsePersistentArchitecturePanelHistory(
      fixture.authority,
      [JSON.parse(JSON.stringify(append.event))],
      publicationResolver,
    ));
    const resumed = reduced(replayPersistentArchitecturePanel(
      fixture.authority,
      interruptedHistory.events,
      publicationResolver,
    ));
    expect(resumed.state).toEqual(step.state);
    const afterResume = reduced(submitCandidate(resumed.state, fixture, 1));
    const resumedEffects = reduced(planArchitecturePanelPersistence(
      afterResume,
      interruptedHistory,
      publicationResolver,
    ));
    expect(resumedEffects.map(({ sequence }) => sequence)).toEqual([2, 2]);
    const replacement = resumedEffects[1];
    if (replacement.kind !== "replace-architecture-panel-checkpoint") throw new Error("expected checkpoint replacement second");
    expect(JSON.parse(JSON.stringify(reduced(parseArchitecturePanelCheckpoint(
      JSON.parse(JSON.stringify(replacement.checkpoint)),
      publicationResolver,
    )).state))).toEqual(JSON.parse(JSON.stringify(afterResume.state)));

    for (const effect of effects) {
      expect(reduced(parsePanelPersistenceReceipt({
        schemaVersion: 1,
        kind: "panel-persistence-recorded",
        panel: "architecture",
        runId: effect.runId,
        sequence: effect.sequence,
        dedupKey: effect.dedupKey,
      }, effect))).toMatchObject({ dedupKey: effect.dedupKey });
      expect(parsePanelPersistenceReceipt({
        schemaVersion: 1,
        kind: "panel-persistence-recorded",
        panel: "architecture",
        runId: effect.runId,
        sequence: effect.sequence,
        dedupKey: `${effect.dedupKey}:forged`,
      }, effect)).toMatchObject({ ok: false, error: { kind: "persistence-receipt-mismatch" } });
    }
  });

  it("emits no persistence effects from structural steps/histories or a prefix that does not replay to the step state", () => {
    const fixture = architectureFixture("persistence-forgery");
    const initial = startPersistentArchitecturePanel(fixture.authority);
    const first = reduced(submitCandidate(initial.state, fixture, 0));
    const second = reduced(submitCandidate(first.state, fixture, 1));
    const emptyHistory = reduced(parsePersistentArchitecturePanelHistory(fixture.authority, [], publicationResolver));

    const structuralStep = Object.freeze({ ...first }) as PersistentArchitectureStep;
    expect(planArchitecturePanelPersistence(structuralStep, emptyHistory, publicationResolver)).toMatchObject({
      ok: false,
      error: { kind: "malformed-event" },
    });

    const structuralHistory = Object.freeze({
      panel: "architecture",
      authority: fixture.authority,
      events: [],
    }) as unknown as PersistentArchitecturePanelHistory;
    expect(planArchitecturePanelPersistence(first, structuralHistory, publicationResolver)).toMatchObject({
      ok: false,
      error: { kind: "malformed-history" },
    });

    expect(planArchitecturePanelPersistence(second, emptyHistory, publicationResolver)).toMatchObject({
      ok: false,
      error: {
        kind: "malformed-checkpoint",
        message: expect.stringContaining("does not replay exactly"),
      },
    });
    expect(architecturePanelCheckpoint(first.state, [], publicationResolver)).toMatchObject({
      ok: false,
      error: { kind: "malformed-checkpoint", message: expect.stringContaining("does not replay") },
    });
  });
});

describe("persistent refutation panel", () => {
  it("binds each lens to its canonical request slot and distinguishes binding mismatches from malformed submissions", () => {
    const fixture = refutationFixture("slot-binding");
    let step = startPersistentRefutationPanel(fixture.authority);
    const events: PersistentRefutationPanelEvent[] = [];
    step = reduced(submitRefutationVerdict(
      step.state,
      publicationResolver,
      panelRequestIdentity(fixture.requests[0]!),
      verdictJson(fixture.authority, 1, votes[1]!),
    ));
    events.push(step.recordedEvent!);
    expect(step.state.stage).toBe("awaiting-verdicts");
    expect(selectAcceptedRefutationVerdicts(step.state)).toEqual([]);
    expect(step.recordedEvent).toMatchObject({
      type: "refutation-verdict-rejected",
      category: "result-binding-mismatch",
    });
    expect(step.recordedEvent?.type === "refutation-verdict-rejected" ? step.recordedEvent.message : "").toContain("criterion");
    expect(step.action).toMatchObject({ requests: [{ attempt: 2, slotId: fixture.authority.verifierRoster.orderedSlots[0]!.slotId }] });

    const retry = issue([fixture.authority.verifierRoster.orderedSlots[0]!.attempts[1]])[0]!;
    step = reduced(submitRefutationVerdict(step.state, publicationResolver, panelRequestIdentity(retry), "not-json"));
    events.push(step.recordedEvent!);
    expect(step.state.stage).toBe("terminal-blocked");
    expect(step.action).toMatchObject({ diagnostic: { retry: { eligible: false } } });
    const replayResult = replayPersistentRefutationPanel(
      fixture.authority,
      JSON.parse(JSON.stringify(events)),
      publicationResolver,
    );
    if (!replayResult.ok) throw new Error(JSON.stringify(replayResult.error));
    expect(JSON.parse(JSON.stringify(replayResult.value.state))).toEqual(JSON.parse(JSON.stringify(step.state)));
    const checkpoint = reduced(refutationPanelCheckpoint(step.state, events, publicationResolver));
    expect(reduced(parseRefutationPanelCheckpoint(
      JSON.parse(JSON.stringify(checkpoint)),
      publicationResolver,
    )).state.stage).toBe("terminal-blocked");
  });

  it("replays the complete roster after JSON restart and preserves strict-majority audit evidence", () => {
    const fixture = refutationFixture("restart");
    let step = startPersistentRefutationPanel(fixture.authority);
    const events: PersistentRefutationPanelEvent[] = [];
    for (const index of [2, 0, 1]) {
      step = reduced(submitRefutationVerdict(
        step.state,
        publicationResolver,
        panelRequestIdentity(fixture.requests[index]!),
        verdictJson(fixture.authority, index, votes[index]!),
      ));
      events.push(step.recordedEvent!);
      expect(reduced(replayPersistentRefutationPanel(
        fixture.authority,
        JSON.parse(JSON.stringify(events)),
        publicationResolver,
      )).state).toEqual(step.state);
    }
    step = reduced(completePersistentRefutationPanel(step.state, publicationResolver));
    events.push(step.recordedEvent!);
    const restarted = reduced(replayPersistentRefutationPanel(
      fixture.authority,
      JSON.parse(JSON.stringify(events)),
      publicationResolver,
    ));
    expect(restarted.state).toEqual(step.state);
    expect(restarted.state).toMatchObject({
      stage: "done",
      decision: { threshold: 2, refuted: [{ finding: { id: findings[0].id } }], retained: [{ finding: { id: findings[1].id } }] },
    });
    const checkpoint = reduced(refutationPanelCheckpoint(step.state, events, publicationResolver));
    expect(JSON.parse(JSON.stringify(reduced(
      parseRefutationPanelCheckpoint(JSON.parse(JSON.stringify(checkpoint)), publicationResolver),
    ).state))).toEqual(JSON.parse(JSON.stringify(step.state)));
    expect(events.at(-1)).not.toHaveProperty("roster");
  });

  it("rejects caller and persisted thresholds above the derived strict majority", () => {
    const fixture = refutationFixture("strict-majority-threshold");
    let ready = startPersistentRefutationPanel(fixture.authority);
    for (const index of [0, 1, 2]) {
      ready = reduced(submitRefutationVerdict(
        ready.state,
        publicationResolver,
        panelRequestIdentity(fixture.requests[index]!),
        verdictJson(fixture.authority, index, votes[index]!),
      ));
    }
    expect(ready.state.stage).toBe("ready-to-tally");
    expect(completePersistentRefutationPanel(ready.state, publicationResolver, 3)).toMatchObject({
      ok: false,
      error: {
        kind: "invalid-aggregate",
        message: "threshold must equal the derived strict majority 2",
      },
    });

    const completed = reduced(completePersistentRefutationPanel(ready.state, publicationResolver));
    expect(completed.state).toMatchObject({
      stage: "done",
      decision: { threshold: 2, refuted: [{ finding: { id: findings[0].id } }] },
    });
    const raisedPersistedThreshold = JSON.parse(JSON.stringify(completed.recordedEvent));
    raisedPersistedThreshold.decision.threshold = 3;
    expect(parsePersistentRefutationPanelEvent(
      ready.state,
      raisedPersistedThreshold,
      publicationResolver,
    )).toMatchObject({
      ok: false,
      error: {
        kind: "invalid-aggregate",
        message: "threshold must equal the derived strict majority 2",
      },
    });
  });

  it("retains ties and uncertainty while preserving every ordered audit lens and reason", () => {
    const fixture = refutationFixture("tie-and-uncertainty");
    const tieVotes = [
      ["refuted", "uncertain"],
      ["upheld", "uncertain"],
      ["uncertain", "uncertain"],
    ] as const;
    let step = startPersistentRefutationPanel(fixture.authority);
    for (const index of [2, 0, 1]) {
      step = reduced(submitRefutationVerdict(
        step.state,
        publicationResolver,
        panelRequestIdentity(fixture.requests[index]!),
        verdictJson(fixture.authority, index, tieVotes[index]!),
      ));
    }
    step = reduced(completePersistentRefutationPanel(step.state, publicationResolver));
    expect(step.state).toMatchObject({
      stage: "done",
      decision: {
        threshold: 2,
        refuted: [],
        retained: [
          {
            finding: { id: findings[0].id },
            survives: true,
            refutations: [{ lens: "reproduction", reason: expect.any(String) }],
            upheldBy: ["intent"],
            uncertainFrom: ["blast-radius"],
          },
          {
            finding: { id: findings[1].id },
            survives: true,
            refutations: [],
            upheldBy: [],
            uncertainFrom: ["reproduction", "intent", "blast-radius"],
          },
        ],
      },
    });
  });

  it("keeps done and terminal-blocked outcomes monotonic under late results", () => {
    const completedFixture = refutationFixture("terminal-done");
    const completed = fullRefutationHistory(completedFixture).step;
    const completedBefore = JSON.stringify(completed.state);
    expect(submitRefutationVerdict(
      completed.state,
      publicationResolver,
      panelRequestIdentity(completedFixture.requests[0]!),
      verdictJson(completedFixture.authority, 0, votes[0]!),
    )).toMatchObject({ ok: false, error: { kind: "unexpected-event" } });
    expect(JSON.stringify(completed.state)).toBe(completedBefore);

    const blockedFixture = refutationFixture("terminal-blocked");
    let blocked = reduced(submitRefutationVerdict(
      startPersistentRefutationPanel(blockedFixture.authority).state,
      publicationResolver,
      panelRequestIdentity(blockedFixture.requests[0]!),
      "{}",
    ));
    const retry = issue([blockedFixture.authority.verifierRoster.orderedSlots[0]!.attempts[1]])[0]!;
    blocked = reduced(submitRefutationVerdict(
      blocked.state,
      publicationResolver,
      panelRequestIdentity(retry),
      "{}",
    ));
    const blockedBefore = JSON.stringify(blocked.state);
    expect(submitRefutationVerdict(
      blocked.state,
      publicationResolver,
      panelRequestIdentity(blockedFixture.requests[1]!),
      verdictJson(blockedFixture.authority, 1, votes[1]!),
    )).toMatchObject({ ok: false, error: { kind: "unexpected-event" } });
    expect(JSON.stringify(blocked.state)).toBe(blockedBefore);
  });

  it("is order-independent for generated completion permutations", () => {
    const fixture = refutationFixture("property");
    const canonical = fullRefutationHistory(fixture).step.state;
    fc.assert(fc.property(
      fc.shuffledSubarray([0, 1, 2], { minLength: 3, maxLength: 3 }),
      (order) => {
        let step = startPersistentRefutationPanel(fixture.authority);
        for (const index of order) {
          step = reduced(submitRefutationVerdict(
            step.state,
            publicationResolver,
            panelRequestIdentity(fixture.requests[index]!),
            verdictJson(fixture.authority, index, votes[index]!),
          ));
        }
        step = reduced(completePersistentRefutationPanel(step.state, publicationResolver));
        expect(step.state).toEqual(canonical);
      },
    ), { numRuns: 30 });
  });

  it("keeps malformed, duplicate, stale, and incomplete evidence closed without losing siblings", () => {
    const fixture = refutationFixture("negative-evidence");
    let step = reduced(submitRefutationVerdict(
      startPersistentRefutationPanel(fixture.authority).state,
      publicationResolver,
      panelRequestIdentity(fixture.requests[1]!),
      verdictJson(fixture.authority, 1, votes[1]!),
    ));
    const before = step.state;
    expect(submitRefutationVerdict(
      step.state,
      publicationResolver,
      panelRequestIdentity(fixture.requests[1]!),
      verdictJson(fixture.authority, 1, votes[1]!),
    )).toMatchObject({ ok: false, error: { kind: "duplicate-result" } });
    expect(step.state).toBe(before);
    expect(completePersistentRefutationPanel(step.state, publicationResolver)).toMatchObject({ ok: false, error: { kind: "incomplete-roster" } });

    const malformed = reduced(submitRefutationVerdict(
      step.state,
      publicationResolver,
      panelRequestIdentity(fixture.requests[0]!),
      "{}",
    ));
    expect(selectAcceptedRefutationVerdicts(malformed.state)).toHaveLength(1);
    expect(malformed.action).toMatchObject({ requests: [{ attempt: 2 }] });
    expect(submitRefutationVerdict(
      malformed.state,
      publicationResolver,
      panelRequestIdentity(fixture.requests[0]!),
      verdictJson(fixture.authority, 0, votes[0]!),
    )).toMatchObject({ ok: false, error: { kind: "stale-request" } });
  });

  it("produces symmetric refutation persistence effects, exact receipts, and rejects structural forgeries", () => {
    const fixture = refutationFixture("persistence-contract");
    const initial = startPersistentRefutationPanel(fixture.authority);
    const first = reduced(submitRefutationVerdict(
      initial.state,
      publicationResolver,
      panelRequestIdentity(fixture.requests[0]!),
      verdictJson(fixture.authority, 0, votes[0]!),
    ));
    const second = reduced(submitRefutationVerdict(
      first.state,
      publicationResolver,
      panelRequestIdentity(fixture.requests[1]!),
      verdictJson(fixture.authority, 1, votes[1]!),
    ));
    const emptyHistory = reduced(parsePersistentRefutationPanelHistory(fixture.authority, [], publicationResolver));
    const effects = reduced(planRefutationPanelPersistence(first, emptyHistory, publicationResolver));
    expect(effects.map(({ kind }) => kind)).toEqual([
      "append-refutation-panel-event",
      "replace-refutation-panel-checkpoint",
    ]);

    for (const effect of effects) {
      const receipt = {
        schemaVersion: 1,
        kind: "panel-persistence-recorded",
        panel: "refutation",
        runId: effect.runId,
        sequence: effect.sequence,
        dedupKey: effect.dedupKey,
      } as const;
      expect(reduced(parsePanelPersistenceReceipt(receipt, effect))).toEqual(receipt);
      expect(parsePanelPersistenceReceipt({ ...receipt, dedupKey: `${effect.dedupKey}:forged` }, effect)).toMatchObject({
        ok: false,
        error: { kind: "persistence-receipt-mismatch" },
      });
      expect(parsePanelPersistenceReceipt({ ...receipt, surplus: true }, effect)).toMatchObject({
        ok: false,
        error: { kind: "persistence-receipt-mismatch" },
      });
    }

    const structuralStep = Object.freeze({ ...first }) as PersistentRefutationStep;
    expect(planRefutationPanelPersistence(structuralStep, emptyHistory, publicationResolver)).toMatchObject({
      ok: false,
      error: { kind: "malformed-event" },
    });
    const structuralHistory = Object.freeze({
      panel: "refutation",
      authority: fixture.authority,
      events: [],
    }) as unknown as PersistentRefutationPanelHistory;
    expect(planRefutationPanelPersistence(first, structuralHistory, publicationResolver)).toMatchObject({
      ok: false,
      error: { kind: "malformed-history" },
    });
    expect(planRefutationPanelPersistence(second, emptyHistory, publicationResolver)).toMatchObject({
      ok: false,
      error: { kind: "malformed-checkpoint", message: expect.stringContaining("does not replay exactly") },
    });
    expect(refutationPanelCheckpoint(first.state, [], publicationResolver)).toMatchObject({
      ok: false,
      error: { kind: "malformed-checkpoint", message: expect.stringContaining("does not replay") },
    });
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
      criticalFindingIds: [waveId("T1:f-1")],
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

/**
 * Round-33: the request-binding boundary, driven with a registration that
 * genuinely diverges from the canonical roster.
 *
 * `resolvePanelRequest` re-derives every request from a registered publication
 * receipt rather than trusting the identity it was handed, and then compares the
 * result against the roster slot. Every existing test resolved through a
 * registration that agreed with the roster, so the divergence branch was never
 * taken. Note where the rejection actually lands: `parseIssuedSpawnRequest`
 * compares the roster authority against the registered one on the SAME field set
 * `authorityMatches` does, so a divergence is caught there as
 * `request-rehydration-failed`, and the later `request-binding-mismatch` check is
 * a redundant second net that this call path cannot reach. Pinning that keeps a
 * future narrowing of either comparison honest.
 */
describe("a registration diverging from the canonical roster is refused", () => {
  const divergences: readonly (readonly [string, Record<string, unknown>])[] = [
    ["role", { role: "arch-judge-agent" }],
    ["attempt", { attempt: 2 }],
    ["modelProfile", { modelProfile: "panel-judge" }],
    ["requiredSkill", { requiredSkill: null }],
    ["contextDigest", { contextDigest: hexDigest("foreign-context") }],
    ["slotId", { slotId: "slot:foreign" }],
    ["outputSlot", { outputSlot: { kind: "fixed-artifact-slot", path: "artifacts/foreign.md" } }],
    ["claude harness binding", {
      harnessBinding: { pi: panelBindings.pi, claude: { harness: "claude-code", model: "sonnet" } },
    }],
    ["pi harness binding", {
      harnessBinding: { pi: { ...panelBindings.pi, model: "gpt-5.5" }, claude: panelBindings.claude },
    }],
  ];

  it.each(divergences)("refuses a registration whose %s diverges from the roster", (_field, override) => {
    const fixture = architectureFixture(`divergent-${String(_field).replace(/\s+/g, "-")}`);
    const request = fixture.candidates[0]!;
    const identity = JSON.parse(JSON.stringify(panelRequestIdentity(request)));

    // Re-register the SAME publication identity with a tampered issued request,
    // so the identity still resolves but the authority behind it has moved.
    const key = registrationKey({ runId: request.issuance.runId, effectId: request.issuance.effectId });
    const original = JSON.parse(new TextDecoder().decode(Uint8Array.from(registrationBytes.get(key)!)));
    const tampered = {
      ...original,
      issuedRequests: original.issuedRequests.map((entry: Record<string, unknown>, index: number) =>
        index === request.issuance.batchIndex
          ? { ...entry, authority: { ...(entry.authority as Record<string, unknown>), ...override } }
          : entry),
    };
    registrationBytes.set(key, bytes(tampered));

    try {
      const submitted = submitArchitectureCandidateResult(
        startPersistentArchitecturePanel(fixture.authority).state,
        publicationResolver,
        identity,
        candidatePayload(fixture.authority, 0),
      );

      expect(submitted.ok).toBe(false);
      if (submitted.ok) return;
      expect(submitted.error.kind).toBe("request-rehydration-failed");
      expect(submitted.error).toMatchObject({ requestId: request.authority.requestId });
    } finally {
      registrationBytes.set(key, bytes(original));
    }
  });

  it("accepts the untampered registration the divergences are varied from", () => {
    const fixture = architectureFixture("divergent-control");
    const submitted = submitArchitectureCandidateResult(
      startPersistentArchitecturePanel(fixture.authority).state,
      publicationResolver,
      JSON.parse(JSON.stringify(panelRequestIdentity(fixture.candidates[0]!))),
      candidatePayload(fixture.authority, 0),
    );
    expect(submitted.ok).toBe(true);
  });

  it("refuses an identity whose requestId is absent from the canonical roster", () => {
    const fixture = architectureFixture("unknown-request");
    const identity = JSON.parse(JSON.stringify(panelRequestIdentity(fixture.candidates[0]!)));
    identity.requestId = "request:not-in-roster";

    const submitted = submitArchitectureCandidateResult(
      startPersistentArchitecturePanel(fixture.authority).state,
      publicationResolver,
      identity,
      candidatePayload(fixture.authority, 0),
    );

    expect(submitted.ok).toBe(false);
    if (submitted.ok) return;
    expect(submitted.error.kind).toBe("unknown-request");
  });
});
