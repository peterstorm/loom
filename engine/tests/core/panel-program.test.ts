import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  AWAIT_PANEL_RESULTS,
  PANEL_PROGRAM_MODEL_PROFILES,
  describeDispatchReplayError,
  isParallelSpawnBatch,
  nextDispatchProgramAction,
  reduceArchitectureProgram,
  reduceRefutationProgram,
  startArchitectureProgram,
  startRefutationProgram,
  type ArchitectureEngineOperation,
  type ArchitectureProgramState,
  type HeadlessSpawnRequest,
  type ProgramStep,
  type RefutationProgramEvent,
  type RefutationProgramState,
  type SpawnBatchAction,
} from "../../src/core/panel-program";
import {
  deriveRefutationVerifierBinding,
  parseArchitecturePanelAuthority,
  parseRefutationPanelAuthority,
  type ArchitecturePanelAuthority,
  type RefutationPanelAuthority,
} from "../../src/core/panel-authority";
import {
  createPanelPublications,
  PANEL_FIXTURE_FINDINGS as findings,
  PANEL_HARNESS_BINDINGS as panelBindings,
  panelRosterSlot as rosterSlot,
  semanticVerifierSlots,
  type ArchitecturePanelFixture as ArchitectureFixture,
  type RefutationPanelFixture as RefutationFixture,
} from "../fixtures/panel-authority";
import { value } from "../fixtures/parse-result";
import {
  architecturePanelCheckpoint,
  completePersistentArchitecturePanel,
  completePersistentRefutationPanel,
  panelRequestIdentity,
  parseArchitecturePanelCheckpoint,
  parsePanelPersistenceReceipt,
  parsePersistentArchitecturePanelEvent,
  parsePersistentArchitecturePanelHistory,
  parsePersistentRefutationPanelEvent,
  parsePersistentRefutationPanelHistory,
  parseRefutationPanelCheckpoint,
  planArchitecturePanelPersistence,
  planRefutationPanelPersistence,
  reducePersistentArchitecturePanel,
  refutationPanelCheckpoint,
  replayPersistentArchitecturePanel,
  replayPersistentRefutationPanel,
  resumePersistentArchitecturePanel,
  startPersistentArchitecturePanel,
  startPersistentRefutationPanel,
  selectAcceptedArchitectureCandidates,
  selectAcceptedArchitectureJudges,
  selectAcceptedRefutationVerdicts,
  submitArchitectureCandidateResult,
  submitArchitectureJudgeResult,
  submitRefutationVerdict,
  type ArchitecturePanelState,
  type PersistentArchitecturePanelEvent,
  type PersistentArchitecturePanelHistory,
  type PersistentArchitectureStep,
  type PersistentRefutationPanelEvent,
  type PersistentRefutationPanelHistory,
  type PersistentRefutationStep,
} from "../../src/core/persistent-panel";
import { parseWaveFindingId, projectFindingForPanel, type BriefFinding } from "../../src/core/review-panel";
import { REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../src/core/reviewer-contract";
import { attributeFindings } from "../../src/core/findings";
import { createPublicationAuthorityResolver, parseOrchestrationRunId } from "../../src/core/orchestration-contract";

/** This suite's private publication store: its resolver reads only the panels issued here. */
const { architecturePanelFixture, issuePanelRequests: issue, refutationPanelFixture, resolver: publicationResolver, withRewrittenPanelRegistration } =
  createPanelPublications();

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

function architectureStart(): ProgramStep<ArchitectureProgramState> {
  return value(startArchitectureProgram(architectureInput));
}

function refutationStart(): ProgramStep<RefutationProgramState> {
  return value(startRefutationProgram(refutationInput));
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
  const prepared = value(reduceArchitectureProgram(
    start.state,
    spawnSucceeded("architecture:interview"),
  ));
  return value(reduceArchitectureProgram(
    prepared.state,
    engineSucceeded("architecture-prepare-candidates"),
  ));
}

function enterJudges(): ProgramStep<ArchitectureProgramState> {
  let step = enterCandidates();
  for (const id of ["architecture:candidate:1", "architecture:candidate:2"]) {
    step = value(reduceArchitectureProgram(step.state, spawnSucceeded(id)));
  }
  return value(reduceArchitectureProgram(
    step.state,
    engineSucceeded("architecture-prepare-judges"),
  ));
}

function enterVerifiers(): ProgramStep<RefutationProgramState> {
  const start = refutationStart();
  return value(reduceRefutationProgram(start.state, {
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

    step = value(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:interview")));
    expect(step.action).toMatchObject({ type: "engine-operation", operation: "architecture-prepare-candidates" });

    step = value(reduceArchitectureProgram(step.state, engineSucceeded("architecture-prepare-candidates")));
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
    step = value(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:candidate:2")));
    expect(step.action).toBeNull();
    step = value(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:candidate:1")));
    expect(step.action).toMatchObject({ type: "engine-operation", operation: "architecture-prepare-judges" });

    step = value(reduceArchitectureProgram(step.state, engineSucceeded("architecture-prepare-judges")));
    expect(step.action?.type).toBe("spawn-batch");
    if (step.action?.type !== "spawn-batch") throw new Error("expected judge batch");
    expect(step.action.requests).toHaveLength(3);
    expect(step.action.requests.every((request) =>
      request.interaction === "headless" &&
      request.modelProfile === PANEL_PROGRAM_MODEL_PROFILES.judging,
    )).toBe(true);

    for (const id of ["architecture:judge:3", "architecture:judge:1", "architecture:judge:2"]) {
      step = value(reduceArchitectureProgram(step.state, spawnSucceeded(id)));
    }
    expect(step.action).toMatchObject({ type: "engine-operation", operation: "architecture-aggregate" });

    step = value(reduceArchitectureProgram(step.state, engineSucceeded("architecture-aggregate")));
    expect(step.action).toMatchObject({
      type: "await-user",
      request: {
        id: "architecture:finalize",
        agent: "architecture-agent",
        interaction: "interactive",
        modelProfile: PANEL_PROGRAM_MODEL_PROFILES.architectureFinalization,
      },
    });

    step = value(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:finalize")));
    expect(step.state.stage).toBe("complete");
    expect(step.action).toEqual({ type: "done", panel: "architecture", outcome: "completed" });
  });

  it("blocks on failed prepare and aggregate engine operations with the original reason", () => {
    const afterInterview = value(reduceArchitectureProgram(
      architectureStart().state,
      spawnSucceeded("architecture:interview"),
    ));
    const prepareFailed = value(reduceArchitectureProgram(afterInterview.state, {
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
      aggregate = value(reduceArchitectureProgram(aggregate.state, spawnSucceeded(id)));
    }
    const aggregateFailed = value(reduceArchitectureProgram(aggregate.state, {
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
    step = value(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:judge:1")));
    step = value(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:judge:3")));
    expect(step.state.stage).toBe("judges");
    expect(step.action).toBeNull();

    const early = reduceArchitectureProgram(step.state, engineSucceeded("architecture-aggregate"));
    expect(early).toEqual({
      ok: false,
      error: { kind: "unexpected-event", panel: "architecture", stage: "judges" },
    });

    step = value(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:judge:2")));
    expect(step.state.stage).toBe("aggregate");
  });

  it("retries only the failed slot once, then blocks", () => {
    let step = enterCandidates();
    step = value(reduceArchitectureProgram(step.state, {
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

    step = value(reduceArchitectureProgram(step.state, {
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
    step = value(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:candidate:1")));

    expect(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:candidate:1"))).toEqual({
      ok: false,
      error: { kind: "duplicate-outcome", requestId: "architecture:candidate:1" },
    });
    expect(reduceArchitectureProgram(step.state, spawnSucceeded("architecture:candidate:99"))).toEqual({
      ok: false,
      error: { kind: "unknown-outcome", requestId: "architecture:candidate:99" },
    });

    step = value(reduceArchitectureProgram(step.state, {
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
    advanced = value(reduceArchitectureProgram(advanced.state, spawnSucceeded("architecture:candidate:1")));
    advanced = value(reduceArchitectureProgram(advanced.state, spawnSucceeded("architecture:candidate:2")));
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
      for (const id of candidateOrder) step = value(reduceArchitectureProgram(step.state, spawnSucceeded(id)));
      step = value(reduceArchitectureProgram(step.state, engineSucceeded("architecture-prepare-judges")));
      for (const id of judgeOrder) step = value(reduceArchitectureProgram(step.state, spawnSucceeded(id)));
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
    const step = value(startRefutationProgram({
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

    step = value(reduceRefutationProgram(step.state, spawnSucceeded("refutation:verifier:2")));
    step = value(reduceRefutationProgram(step.state, spawnSucceeded("refutation:verifier:1")));
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

    step = value(reduceRefutationProgram(step.state, spawnSucceeded("refutation:verifier:3")));
    expect(step.action).toMatchObject({ type: "engine-operation", operation: "refutation-tally" });
    step = value(reduceRefutationProgram(step.state, {
      type: "engine-outcome",
      operationId: "refutation-tally",
      outcome: "succeeded",
    }));
    expect(step.state.stage).toBe("complete");
    expect(step.action).toEqual({ type: "done", panel: "refutation", outcome: "completed" });
  });

  it("blocks on failed prepare and tally engine operations with the original reason", () => {
    const prepareFailed = value(reduceRefutationProgram(refutationStart().state, {
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
      tally = value(reduceRefutationProgram(tally.state, spawnSucceeded(id)));
    }
    const tallyFailed = value(reduceRefutationProgram(tally.state, {
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
    retried = value(reduceRefutationProgram(retried.state, {
      type: "spawn-outcome",
      requestId: "refutation:verifier:1",
      attempt: 1,
      outcome: "failed",
    }));
    expect(retried.action).toMatchObject({
      type: "spawn-batch",
      requests: [{ id: "refutation:verifier:1", attempt: 2 }],
    });
    retried = value(reduceRefutationProgram(retried.state, spawnSucceeded("refutation:verifier:3")));
    retried = value(reduceRefutationProgram(retried.state, spawnSucceeded("refutation:verifier:1", 2)));
    retried = value(reduceRefutationProgram(retried.state, spawnSucceeded("refutation:verifier:2")));

    let ordinary = enterVerifiers();
    for (const id of ["refutation:verifier:1", "refutation:verifier:2", "refutation:verifier:3"]) {
      ordinary = value(reduceRefutationProgram(ordinary.state, spawnSucceeded(id)));
    }
    expect(retried.action).toEqual(ordinary.action);
    expect(retried.state.stage).toBe("tally");
  });
});

// ---------------------------------------------------------------------------
// Persistent authority-bound programs
// ---------------------------------------------------------------------------

const unavailableResolver = createPublicationAuthorityResolver(() => ({
  ok: false,
  error: { kind: "publication-authority-unavailable", field: "registration", message: "registration unavailable after restart" },
}));
const hexDigest = (seed: string): string => createHash("sha256").update(seed).digest("hex");

const architectureFixture = (suffix: string): ArchitectureFixture => architecturePanelFixture(`run.architecture.${suffix}`);

const REFUTATION_LENSES = ["reproduction", "intent", "blast-radius"] as const;
const refutationFixture = (suffix: string, entries: readonly [BriefFinding, BriefFinding] = findings): RefutationFixture =>
  refutationPanelFixture(`run.refutation.${suffix}`, REFUTATION_LENSES, entries);

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
    step = value(submitCandidate(step.state, fixture, index));
    events.push(step.recordedEvent!);
  }
  for (const index of [1, 0]) {
    step = value(submitJudge(step.state, fixture, index));
    events.push(step.recordedEvent!);
  }
  step = value(completePersistentArchitecturePanel(step.state, publicationResolver));
  events.push(step.recordedEvent!);
  return { step, events };
}

function fullRefutationHistory(fixture: RefutationFixture) {
  let step = startPersistentRefutationPanel(fixture.authority);
  const events: PersistentRefutationPanelEvent[] = [];
  for (const index of [2, 0, 1]) {
    step = value(submitRefutationVerdict(
      step.state,
      publicationResolver,
      panelRequestIdentity(fixture.requests[index]!),
      verdictJson(fixture.authority, index, votes[index]!),
    ));
    events.push(step.recordedEvent!);
  }
  step = value(completePersistentRefutationPanel(step.state, publicationResolver));
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

    // A criterion outside the closed interview vocabulary is not a criterion:
    // the brand is minted by lookup, not asserted (see architectureCriterion).
    expect(parseArchitecturePanelAuthority({
      runId: architecture.authority.runId,
      candidateLenses: architecture.authority.candidateLenses,
      judgeCriteria: [...architecture.authority.judgeCriteria.slice(0, -1), "my own taste"],
      candidateSlots: architecture.authority.candidateRoster.orderedSlots,
      judgeSlots: architecture.authority.judgeRoster.orderedSlots,
    })).toMatchObject({
      ok: false,
      error: {
        kind: "invalid-authority",
        message: expect.stringContaining("outside the validated interview vocabulary"),
      },
    });

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

  // Cardinality and canonical ordinal identity are both required. A complete
  // roster in the wrong order is not evidence for the semantic list it is
  // paired with.
  it("refuses a roster whose slot count disagrees with the ordered list it is paired with", () => {
    const refutation = refutationFixture("cardinality-authority");
    const architecture = architectureFixture("cardinality-authority");

    expect(parseRefutationPanelAuthority({
      runId: refutation.authority.runId,
      findings: refutation.authority.findings,
      lenses: refutation.authority.lenses.slice(0, 1),
      verifierSlots: refutation.authority.verifierRoster.orderedSlots,
    })).toMatchObject({
      ok: false,
      error: { kind: "invalid-authority", message: expect.stringContaining("exactly 1 slot") },
    });

    expect(parseArchitecturePanelAuthority({
      runId: architecture.authority.runId,
      candidateLenses: architecture.authority.candidateLenses.slice(0, 1),
      judgeCriteria: architecture.authority.judgeCriteria,
      candidateSlots: architecture.authority.candidateRoster.orderedSlots,
      judgeSlots: architecture.authority.judgeRoster.orderedSlots,
    })).toMatchObject({
      ok: false,
      error: { kind: "invalid-authority", message: expect.stringContaining("exactly 1 slot") },
    });
  });

  it("refuses reordered candidate, judge, and refutation rosters with exact slot diagnostics", () => {
    const architecture = architectureFixture("reordered-authority");
    const refutation = refutationFixture("reordered-authority");
    const architectureInput = {
      runId: architecture.authority.runId,
      candidateLenses: architecture.authority.candidateLenses,
      judgeCriteria: architecture.authority.judgeCriteria,
    };

    const candidates = parseArchitecturePanelAuthority({
      ...architectureInput,
      candidateSlots: [...architecture.authority.candidateRoster.orderedSlots].reverse(),
      judgeSlots: architecture.authority.judgeRoster.orderedSlots,
    });
    expect(candidates).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("candidate slot 1") },
    });

    const judges = parseArchitecturePanelAuthority({
      ...architectureInput,
      candidateSlots: architecture.authority.candidateRoster.orderedSlots,
      judgeSlots: [...architecture.authority.judgeRoster.orderedSlots].reverse(),
    });
    expect(judges).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("judge slot 1") },
    });

    const verifiers = parseRefutationPanelAuthority({
      runId: refutation.authority.runId,
      findings: refutation.authority.findings,
      lenses: refutation.authority.lenses,
      verifierSlots: [...refutation.authority.verifierRoster.orderedSlots].reverse(),
    });
    expect(verifiers).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("verifier slot 1") },
    });
  });

  it("refuses an ordinal-shaped verifier roster when semantics are derivable", () => {
    const refutation = refutationFixture("ordinal-relabel");
    const ordinalSlots = [1, 2, 3].map((index) =>
      rosterSlot(refutation.authority.runId, "verifier", index, "refutation-panel", "review-verifier-agent"));
    // An ordinal-shaped roster carries no anchor to the semantic lens/finding
    // set, so a reordered (but internally distinct) lens list must NOT relabel
    // it as authoritative evidence for different semantics.
    const reordered = [
      refutation.authority.lenses[1],
      refutation.authority.lenses[0],
      refutation.authority.lenses[2],
    ] as const;

    expect(parseRefutationPanelAuthority({
      runId: refutation.authority.runId,
      findings: refutation.authority.findings,
      lenses: reordered,
      verifierSlots: ordinalSlots,
    })).toMatchObject({ ok: false, error: { kind: "invalid-authority" } });
  });

  it("refuses a roster slot holding an attempt bound to a different slot", () => {
    const refutation = refutationFixture("cross-slot-attempt");
    const slots = refutation.authority.verifierRoster.orderedSlots;
    const foreign = slots[1]!;
    // A slot whose second attempt answers for its neighbour: `locateProgress`
    // would resolve it, and the result would then be paired with whichever
    // ordinal the OTHER slot occupies.
    const tampered = [
      { ...slots[0]!, attempts: [slots[0]!.attempts[0], foreign.attempts[1]] },
      ...slots.slice(1),
    ];

    expect(parseRefutationPanelAuthority({
      runId: refutation.authority.runId,
      findings: refutation.authority.findings,
      lenses: refutation.authority.lenses,
      verifierSlots: tampered,
    })).toMatchObject({ ok: false, error: { kind: "invalid-authority" } });
  });

  it("uses shared identity/path/prose parsers and stores only canonical sanitized Findings", () => {
    const fixture = refutationFixture("sanitized-authority");
    const only = [{ ...findings[0], agent: "code-reviewer", claim: " {claim} text ", file: "src/a.ts" }];
    const onlyId = parseWaveFindingId(only[0]!.id);
    if (onlyId === null) throw new Error("invalid test wave finding id");
    // The roster must derive from the same (single) finding set passed below:
    // semantic slot identities bind each lens to the exact findings parsed.
    const slots = semanticVerifierSlots(
      fixture.authority.runId,
      fixture.authority.lenses,
      [onlyId],
    );
    const parsedAuthority = value(parseRefutationPanelAuthority({
      runId: fixture.authority.runId,
      findings: only,
      lenses: fixture.authority.lenses,
      verifierSlots: slots,
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
    step = value(submitArchitectureCandidateResult(
      step.state,
      publicationResolver,
      panelRequestIdentity(fixture.candidates[0]!),
      candidatePayload(fixture.authority, 1),
    ));
    expect(step.state.stage).toBe("awaiting-candidates");
    expect(selectAcceptedArchitectureCandidates(step.state)).toEqual([]);
    expect(step.action).toMatchObject({ requests: [{ attempt: 2, slotId: fixture.authority.candidateRoster.orderedSlots[0]!.slotId }] });

    const retry = issue([fixture.authority.candidateRoster.orderedSlots[0]!.attempts[1]])[0]!;
    step = value(submitArchitectureCandidateResult(
      step.state,
      publicationResolver,
      panelRequestIdentity(retry),
      candidatePayload(fixture.authority, 0),
    ));
    step = value(submitCandidate(step.state, fixture, 1));
    expect(step.state.stage).toBe("awaiting-judges");

    step = value(submitArchitectureJudgeResult(
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

    let step = value(submitArchitectureCandidateResult(
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
      step = value(submitCandidate(step.state, fixture, index));
      events.push(step.recordedEvent!);
    }

    const awaitingJudgeState = step.state;
    step = value(submitArchitectureJudgeResult(
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
    step = value(submitArchitectureJudgeResult(
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
    expect(value(replayPersistentArchitecturePanel(
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

    const accepted = value(submitCandidate(started.state, fixture, 0)).state;
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
      step = value(submit());
      events.push(step.recordedEvent!);
      const jsonEvents = JSON.parse(JSON.stringify(events));
      const firstReplay = value(replayPersistentArchitecturePanel(fixture.authority, jsonEvents, publicationResolver));
      const secondReplay = value(replayPersistentArchitecturePanel(fixture.authority, jsonEvents, publicationResolver));
      expect(firstReplay.state).toEqual(step.state);
      expect(secondReplay.state).toEqual(firstReplay.state);
      const checkpoint = value(architecturePanelCheckpoint(step.state, events, publicationResolver));
      const resumed = value(parseArchitecturePanelCheckpoint(JSON.parse(JSON.stringify(checkpoint)), publicationResolver));
      expect(JSON.parse(JSON.stringify(resumed.state))).toEqual(JSON.parse(JSON.stringify(step.state)));
    }
    expect(step.state.stage).toBe("done");
    expect(events.at(-1)).not.toHaveProperty("roster");
  });

  it("strictly rejects forged completion payloads and checkpoint structural disagreement", () => {
    const fixture = architectureFixture("checkpoint-disagreement");
    const accepted = value(submitCandidate(startPersistentArchitecturePanel(fixture.authority).state, fixture, 0));
    const event = accepted.recordedEvent!;
    const checkpoint = value(architecturePanelCheckpoint(accepted.state, [event], publicationResolver));
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
    ready = value(submitCandidate(ready.state, fixture, 1));
    ready = value(submitJudge(ready.state, fixture, 0));
    ready = value(submitJudge(ready.state, fixture, 1));
    expect(parsePersistentArchitecturePanelEvent(ready.state, {
      schemaVersion: 1,
      type: "architecture-ranking-completed",
      ranking: [],
    }, publicationResolver)).toMatchObject({ ok: false, error: { kind: "invalid-aggregate" } });
  });

  it("reloads a checkpoint whose candidate and judge roster views are both legacy serializations", () => {
    const fixture = architectureFixture("legacy-roster-view");
    const { step, events } = fullArchitectureHistory(fixture);
    const durable = () => JSON.parse(JSON.stringify(value(architecturePanelCheckpoint(step.state, events, publicationResolver))));
    // Both issued rosters carry the derived `byId` view, so both are compared
    // through the roster's canonical form — `{}` and `{"size":N}` agree.
    const legacy = durable();
    for (const field of ["candidateRoster", "judgeRoster"] as const) {
      const roster = legacy.state.authority[field];
      expect(roster.byId).toEqual({});
      roster.byId = { size: roster.orderedSlots.length };
    }
    expect(value(parseArchitecturePanelCheckpoint(legacy, publicationResolver)).state.stage).toBe("done");
    // The slots each view derives from stay recorded content.
    for (const field of ["candidateRoster", "judgeRoster"] as const) {
      const reordered = durable();
      reordered.state.authority[field].orderedSlots.reverse();
      expect(parseArchitecturePanelCheckpoint(reordered, publicationResolver)).toMatchObject({ ok: false,
        error: { kind: "malformed-checkpoint", message: expect.stringContaining("disagrees") } });
    }
  });

  it("keeps reduction total for malformed and cross-stage events", () => {
    const fixture = architectureFixture("transition-totality");
    const { step: done, events } = fullArchitectureHistory(fixture);
    const states: ArchitecturePanelState[] = [
      startPersistentArchitecturePanel(fixture.authority).state,
      value(replayPersistentArchitecturePanel(fixture.authority, events.slice(0, 2), publicationResolver)).state,
      value(replayPersistentArchitecturePanel(fixture.authority, events.slice(0, 4), publicationResolver)).state,
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
    const step = value(submitCandidate(startPersistentArchitecturePanel(fixture.authority).state, fixture, 0));
    const history = value(parsePersistentArchitecturePanelHistory(fixture.authority, [], publicationResolver));
    const effects = value(planArchitecturePanelPersistence(step, history, publicationResolver));
    expect(effects.map(({ kind }) => kind)).toEqual([
      "append-architecture-panel-event",
      "replace-architecture-panel-checkpoint",
    ]);

    // FR-021: a crash after the immutable append but before checkpoint replace
    // resumes from that append and plans only the next deterministic sequence.
    const append = effects[0];
    if (append.kind !== "append-architecture-panel-event") throw new Error("expected append effect first");
    const interruptedHistory = value(parsePersistentArchitecturePanelHistory(
      fixture.authority,
      [JSON.parse(JSON.stringify(append.event))],
      publicationResolver,
    ));
    const resumed = value(replayPersistentArchitecturePanel(
      fixture.authority,
      interruptedHistory.events,
      publicationResolver,
    ));
    expect(resumed.state).toEqual(step.state);
    const afterResume = value(submitCandidate(resumed.state, fixture, 1));
    const resumedEffects = value(planArchitecturePanelPersistence(
      afterResume,
      interruptedHistory,
      publicationResolver,
    ));
    expect(resumedEffects.map(({ sequence }) => sequence)).toEqual([2, 2]);
    const replacement = resumedEffects[1];
    if (replacement.kind !== "replace-architecture-panel-checkpoint") throw new Error("expected checkpoint replacement second");
    expect(JSON.parse(JSON.stringify(value(parseArchitecturePanelCheckpoint(
      JSON.parse(JSON.stringify(replacement.checkpoint)),
      publicationResolver,
    )).state))).toEqual(JSON.parse(JSON.stringify(afterResume.state)));

    for (const effect of effects) {
      expect(value(parsePanelPersistenceReceipt({
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
    const first = value(submitCandidate(initial.state, fixture, 0));
    const second = value(submitCandidate(first.state, fixture, 1));
    const emptyHistory = value(parsePersistentArchitecturePanelHistory(fixture.authority, [], publicationResolver));

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
  it("structurally hashes verifier authority so delimiter-bearing finding sets cannot collide", () => {
    const runId = value(parseOrchestrationRunId("run.refutation.structural-hash"));
    const firstA = parseWaveFindingId("T:a|b");
    const firstB = parseWaveFindingId("X:c");
    const secondA = parseWaveFindingId("T:a");
    const secondB = parseWaveFindingId("b|X:c");
    if (firstA === null || firstB === null || secondA === null || secondB === null) throw new Error("fixture id parse failed");

    const first = deriveRefutationVerifierBinding(runId, "reproduction", [firstA, firstB]);
    const second = deriveRefutationVerifierBinding(runId, "reproduction", [secondA, secondB]);

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) expect(first.value.slotId).not.toBe(second.value.slotId);
  });

  it("binds each lens to its canonical request slot and distinguishes binding mismatches from malformed submissions", () => {
    const fixture = refutationFixture("slot-binding");
    let step = startPersistentRefutationPanel(fixture.authority);
    const events: PersistentRefutationPanelEvent[] = [];
    step = value(submitRefutationVerdict(
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
    step = value(submitRefutationVerdict(step.state, publicationResolver, panelRequestIdentity(retry), "not-json"));
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
    const checkpoint = value(refutationPanelCheckpoint(step.state, events, publicationResolver));
    expect(value(parseRefutationPanelCheckpoint(
      JSON.parse(JSON.stringify(checkpoint)),
      publicationResolver,
    )).state.stage).toBe("terminal-blocked");
  });

  it("replays the complete roster after JSON restart and preserves strict-majority audit evidence", () => {
    const fixture = refutationFixture("restart");
    let step = startPersistentRefutationPanel(fixture.authority);
    const events: PersistentRefutationPanelEvent[] = [];
    for (const index of [2, 0, 1]) {
      step = value(submitRefutationVerdict(
        step.state,
        publicationResolver,
        panelRequestIdentity(fixture.requests[index]!),
        verdictJson(fixture.authority, index, votes[index]!),
      ));
      events.push(step.recordedEvent!);
      expect(value(replayPersistentRefutationPanel(
        fixture.authority,
        JSON.parse(JSON.stringify(events)),
        publicationResolver,
      )).state).toEqual(step.state);
    }
    step = value(completePersistentRefutationPanel(step.state, publicationResolver));
    events.push(step.recordedEvent!);
    const restarted = value(replayPersistentRefutationPanel(
      fixture.authority,
      JSON.parse(JSON.stringify(events)),
      publicationResolver,
    ));
    expect(restarted.state).toEqual(step.state);
    expect(restarted.state).toMatchObject({
      stage: "done",
      decision: { threshold: 2, refuted: [{ finding: { id: findings[0].id } }], retained: [{ finding: { id: findings[1].id } }] },
    });
    const checkpoint = value(refutationPanelCheckpoint(step.state, events, publicationResolver));
    expect(JSON.parse(JSON.stringify(value(
      parseRefutationPanelCheckpoint(JSON.parse(JSON.stringify(checkpoint)), publicationResolver),
    ).state))).toEqual(JSON.parse(JSON.stringify(step.state)));
    expect(events.at(-1)).not.toHaveProperty("roster");
  });

  it("rejects caller and persisted thresholds above the derived strict majority", () => {
    const fixture = refutationFixture("strict-majority-threshold");
    let ready = startPersistentRefutationPanel(fixture.authority);
    for (const index of [0, 1, 2]) {
      ready = value(submitRefutationVerdict(
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

    const completed = value(completePersistentRefutationPanel(ready.state, publicationResolver));
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
      step = value(submitRefutationVerdict(
        step.state,
        publicationResolver,
        panelRequestIdentity(fixture.requests[index]!),
        verdictJson(fixture.authority, index, tieVotes[index]!),
      ));
    }
    step = value(completePersistentRefutationPanel(step.state, publicationResolver));
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
    let blocked = value(submitRefutationVerdict(
      startPersistentRefutationPanel(blockedFixture.authority).state,
      publicationResolver,
      panelRequestIdentity(blockedFixture.requests[0]!),
      "{}",
    ));
    const retry = issue([blockedFixture.authority.verifierRoster.orderedSlots[0]!.attempts[1]])[0]!;
    blocked = value(submitRefutationVerdict(
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
          step = value(submitRefutationVerdict(
            step.state,
            publicationResolver,
            panelRequestIdentity(fixture.requests[index]!),
            verdictJson(fixture.authority, index, votes[index]!),
          ));
        }
        step = value(completePersistentRefutationPanel(step.state, publicationResolver));
        expect(step.state).toEqual(canonical);
      },
    ), { numRuns: 30 });
  });

  it("keeps malformed, duplicate, stale, and incomplete evidence closed without losing siblings", () => {
    const fixture = refutationFixture("negative-evidence");
    let step = value(submitRefutationVerdict(
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

    const malformed = value(submitRefutationVerdict(
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
    const first = value(submitRefutationVerdict(
      initial.state,
      publicationResolver,
      panelRequestIdentity(fixture.requests[0]!),
      verdictJson(fixture.authority, 0, votes[0]!),
    ));
    const second = value(submitRefutationVerdict(
      first.state,
      publicationResolver,
      panelRequestIdentity(fixture.requests[1]!),
      verdictJson(fixture.authority, 1, votes[1]!),
    ));
    const emptyHistory = value(parsePersistentRefutationPanelHistory(fixture.authority, [], publicationResolver));
    const effects = value(planRefutationPanelPersistence(first, emptyHistory, publicationResolver));
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
      expect(value(parsePanelPersistenceReceipt(receipt, effect))).toEqual(receipt);
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

function mixedRefutationFixture(suffix: string, confidence = 50): RefutationFixture {
  const example = REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!;
  if (example.severity !== "critical") throw new Error("expected critical example");
  const current = attributeFindings([{ protocolVersion: 2, ...example, claim: "  exact {claim}\n<script> | ```\u001b ",
    basis: { ...example.basis, truthConfidence: confidence, severityRationale: "  exact rationale\n " } }], "code-reviewer")[0]!;
  return refutationFixture(suffix, [projectFindingForPanel("T1", current), findings[1]]);
}

describe("current and historical Findings through the full persistent panel", () => {
  it("publishes journal/checkpoint effects and reloads every prefix through full-basis done", () => {
    const fixture = mixedRefutationFixture("current-prefixes");
    let step = startPersistentRefutationPanel(fixture.authority);
    const events: PersistentRefutationPanelEvent[] = [];
    for (const index of [2, 0, 1, 3]) {
      const history = value(parsePersistentRefutationPanelHistory(fixture.authority, JSON.parse(JSON.stringify(events)), publicationResolver));
      step = index === 3 ? value(completePersistentRefutationPanel(step.state, publicationResolver))
        : value(submitRefutationVerdict(step.state, publicationResolver, panelRequestIdentity(fixture.requests[index]!), verdictJson(fixture.authority, index, votes[index]!)));
      const effects = value(planRefutationPanelPersistence(step, history, publicationResolver));
      events.push(step.recordedEvent!);
      expect(effects.map(({ sequence }) => sequence)).toEqual([events.length, events.length]);
      const replacement = effects[1];
      if (replacement.kind !== "replace-refutation-panel-checkpoint") throw new Error("checkpoint expected");
      expect(replacement.checkpoint.schemaVersion).toBe(2);
      const snapshot = JSON.stringify(replacement.checkpoint);
      const reloaded = value(parseRefutationPanelCheckpoint(JSON.parse(snapshot), publicationResolver));
      expect(JSON.stringify(reloaded.state)).toBe(JSON.stringify(step.state));
      expect(JSON.stringify(value(replayPersistentRefutationPanel(fixture.authority, JSON.parse(JSON.stringify(events)), publicationResolver)).state))
        .toBe(JSON.stringify(step.state));
      expect(reloaded.state.authority.findings).toEqual(fixture.authority.findings);
      expect(Object.isFrozen(reloaded.state.authority.findings[0]?.basis?.evidence)).toBe(true);
      expect(reloaded.state.authority.findings[1]).not.toHaveProperty("protocolVersion");
      for (const effect of effects) {
        expect(parsePanelPersistenceReceipt({ schemaVersion: 1, kind: "panel-persistence-recorded", panel: "refutation",
          runId: effect.runId, sequence: effect.sequence, dedupKey: effect.dedupKey }, effect).ok).toBe(true);
      }
    }
    if (step.state.stage !== "done") throw new Error("done expected");
    expect(step.state.decision.threshold).toBe(2);
    expect(step.state.decision.outcomes).toHaveLength(2);
    expect(step.state.decision.refuted).toHaveLength(1);
    expect(step.state.decision.retained).toHaveLength(1);
    expect(step.state.decision.refuted[0]?.finding).toEqual(fixture.authority.findings[0]);
    expect(step.state.decision.retained[0]?.finding).toEqual(fixture.authority.findings[1]);
  });

  it.each(["protocol", "basis", "nested", "claim", "consequence", "advisory"])("refuses %s authority tampering during completed checkpoint reload", (mutation) => {
    const fixture = mixedRefutationFixture(`current-tamper-${mutation}`);
    const { step, events } = fullRefutationHistory(fixture);
    const checkpoint = JSON.parse(JSON.stringify(value(refutationPanelCheckpoint(step.state, events, publicationResolver))));
    const entry = checkpoint.authority.findings[0];
    if (mutation === "protocol") delete entry.protocolVersion;
    if (mutation === "basis") delete entry.basis;
    if (mutation === "nested") entry.basis.evidence.surplus = true;
    if (mutation === "claim") entry.claim += " altered";
    if (mutation === "consequence") entry.basis.consequence.impact += " altered";
    if (mutation === "advisory") { entry.severity = "advisory"; entry.reason = "downgraded"; }
    expect(parseRefutationPanelCheckpoint(checkpoint, publicationResolver).ok).toBe(false);
  });

  it("reloads a checkpoint whose recorded roster view is a legacy serialization, yet refuses recorded roster slots that disagree", () => {
    const fixture = mixedRefutationFixture("legacy-roster-view");
    const { step, events } = fullRefutationHistory(fixture);
    const durable = () => JSON.parse(JSON.stringify(value(refutationPanelCheckpoint(step.state, events, publicationResolver))));
    // The roster's derived `byId` view is compared through the roster's own
    // canonical form: `{}` today, `{"size":N}` from the fake-Map record that
    // older checkpoints still carry — the same roster either way.
    const legacy = durable();
    expect(legacy.state.authority.verifierRoster.byId).toEqual({});
    legacy.state.authority.verifierRoster.byId = { size: legacy.state.authority.verifierRoster.orderedSlots.length };
    expect(value(parseRefutationPanelCheckpoint(legacy, publicationResolver)).state.stage).toBe("done");
    // The slots the view derives from are recorded content: reordering them is disagreement.
    const reordered = durable();
    reordered.state.authority.verifierRoster.orderedSlots.reverse();
    expect(parseRefutationPanelCheckpoint(reordered, publicationResolver)).toMatchObject({ ok: false,
      error: { kind: "malformed-checkpoint", message: "refutation checkpoint state disagrees with its immutable event prefix" } });
  });

  it.each(["outcomes", "retained", "refuted"])("compares whole nested %s Finding values in tally events, not just IDs/claims", (partition) => {
    const fixture = mixedRefutationFixture(`current-event-${partition}`);
    const { step, events } = fullRefutationHistory(fixture);
    const raw = JSON.parse(JSON.stringify(events));
    const decision = raw.at(-1).decision;
    const target = partition === "retained" ? decision.retained[0].finding : decision[partition][0].finding;
    target.claim += " changed";
    if (target.protocolVersion === 2) { delete target.protocolVersion; delete target.basis; }
    expect(replayPersistentRefutationPanel(fixture.authority, raw, publicationResolver).ok).toBe(false);
    expect(step.state.stage).toBe("done");
  });

  it("refuses an independently minted history for a changed current basis at persistence planning", () => {
    const original = mixedRefutationFixture("current-parent-join", 50);
    const changed = mixedRefutationFixture("current-parent-join", 51);
    const history = value(parsePersistentRefutationPanelHistory(original.authority, [], publicationResolver));
    const step = value(submitRefutationVerdict(startPersistentRefutationPanel(changed.authority).state,
      publicationResolver, panelRequestIdentity(changed.requests[0]!), verdictJson(changed.authority, 0, votes[0]!)));
    expect(planRefutationPanelPersistence(step, history, publicationResolver)).toMatchObject({ ok: false, error: { kind: "malformed-history" } });
  });

  it("confidence changes never change majority votes, counts, surviving severity or uncertainty", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 100 }), (confidence) => {
      const fixture = mixedRefutationFixture(`current-confidence-${confidence}`, confidence);
      let step = startPersistentRefutationPanel(fixture.authority);
      const tied = [["refuted", "uncertain"], ["upheld", "uncertain"], ["uncertain", "uncertain"]] as const;
      for (const index of [0, 1, 2]) step = value(submitRefutationVerdict(step.state, publicationResolver,
        panelRequestIdentity(fixture.requests[index]!), verdictJson(fixture.authority, index, tied[index]!)));
      step = value(completePersistentRefutationPanel(step.state, publicationResolver));
      if (step.state.stage !== "done") throw new Error("done expected");
      expect(step.state.decision.threshold).toBe(2);
      expect(step.state.decision.refuted).toHaveLength(0);
      expect(step.state.decision.retained.map(({ finding }) => finding.severity)).toEqual(["critical", "critical"]);
      expect(step.state.decision.retained[0]?.finding.basis?.truthConfidence).toBe(confidence);
    }), { seed: 4402, numRuns: 25 });
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
    const tamper = (original: Readonly<Record<string, unknown>>) => ({
      ...original,
      issuedRequests: (original.issuedRequests as readonly Record<string, unknown>[]).map((entry, index) =>
        index === request.issuance.batchIndex
          ? { ...entry, authority: { ...(entry.authority as Record<string, unknown>), ...override } }
          : entry),
    });

    const submitted = withRewrittenPanelRegistration(request, tamper, () => submitArchitectureCandidateResult(
      startPersistentArchitecturePanel(fixture.authority).state,
      publicationResolver,
      identity,
      candidatePayload(fixture.authority, 0),
    ));

    expect(submitted.ok).toBe(false);
    if (submitted.ok) return;
    expect(submitted.error.kind).toBe("request-rehydration-failed");
    expect(submitted.error).toMatchObject({ requestId: request.authority.requestId });
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

describe("nextDispatchProgramAction: the dispatch program's one journal replay", () => {
  const architectureInput = { candidateLenses: ["type-driven-fp"], judgeCriteria: ["simplicity"] } as const;
  const refutationInput = { criticalFindingIds: [findings[0].id], lenses: ["reproduction"] } as const;
  const verifierSucceeded = { type: "spawn-outcome", requestId: "refutation:verifier:1", attempt: 1, outcome: "succeeded" } as const;

  it("starts each panel's dispatch program at its first spawn batch", () => {
    expect(nextDispatchProgramAction({ panel: "architecture", input: architectureInput, events: [] }))
      .toMatchObject({ ok: true, value: { type: "spawn-batch", requests: [{ id: "architecture:candidate:1" }] } });
    expect(nextDispatchProgramAction({ panel: "refutation", input: refutationInput, events: [] }))
      .toMatchObject({ ok: true, value: { type: "spawn-batch", requests: [{ id: "refutation:verifier:1" }] } });
  });

  it("folds events in order and awaits results while a batch has unsettled requests", () => {
    expect(nextDispatchProgramAction({ panel: "refutation", input: refutationInput, events: [verifierSucceeded] }))
      .toMatchObject({ ok: true, value: { type: "engine-operation", operation: "refutation-tally" } });
    const twoLenses = { ...refutationInput, lenses: ["reproduction", "intent"] } as const;
    expect(nextDispatchProgramAction({ panel: "refutation", input: twoLenses, events: [verifierSucceeded] }))
      .toEqual({ ok: true, value: AWAIT_PANEL_RESULTS });
  });

  it("refuses in the program's own typed vocabulary, which a caller can branch on", () => {
    const started = nextDispatchProgramAction({ panel: "architecture", input: { candidateLenses: [], judgeCriteria: ["simplicity"] }, events: [] });
    expect(started).toEqual({ ok: false, error: { kind: "start-refused", errors: ["candidate lenses must be non-empty"] } });
    const duplicate = nextDispatchProgramAction({ panel: "refutation", input: refutationInput, events: [verifierSucceeded, verifierSucceeded] });
    expect(duplicate).toEqual({ ok: false, error: { kind: "event-refused", error: { kind: "duplicate-outcome", requestId: "refutation:verifier:1" } } });
    if (started.ok || duplicate.ok) throw new Error("unreachable");
    expect(describeDispatchReplayError(started.error)).toBe("candidate lenses must be non-empty");
    expect(describeDispatchReplayError(duplicate.error)).toBe(JSON.stringify({ kind: "duplicate-outcome", requestId: "refutation:verifier:1" }));
  });
});
