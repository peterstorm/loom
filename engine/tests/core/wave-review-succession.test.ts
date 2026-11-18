/**
 * A Successor Carry (ADR-0091, loom#213 Cause 5): a fresh Wave Gate start
 * carries the accepted review of every Task whose review subject is
 * unchanged since the retired run it succeeds accepted it, along a protected
 * lineage, and reviews every other Task in full.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS, BASE_WAVE_REVIEW_AGENTS } from "../../src/core/agent-catalog-projections";
import { advisoryDisposition, anchorDigest } from "../../src/core/advisory-disposition";
import { attributeFindings, reviewRunError } from "../../src/core/findings";
import { parseRegisteredFacadeProgram } from "../../src/handlers/helpers/programs/registration";
import type { CurrentAcceptedReviewAuthority, Finding } from "../../src/core/findings-shape";
import { parseArtifactDigest, parseOrchestrationRunId } from "../../src/core/orchestration-contract";
import { REVIEWER_PROTOCOL_V2, WAVE_REVIEWER_PROTOCOL_V4, type ReviewerProtocolDescriptor } from "../../src/core/reviewer-contract";
import { acceptedSubjectDigest } from "../../src/core/review-subject";
import { reviewedWorkspaceObservation, type ReviewedWorkspaceObservation } from "../../src/core/reviewed-workspace";
import type { RegisteredWaveGateProgram, WaveGateSuccessionAudit } from "../../src/core/wave-gate-program";
import {
  installWaveGateRegistration,
  retireReopenedWaveReview,
  successionPredecessorOf,
  supersedeAbandonedWaveGateReview,
} from "../../src/core/wave-gate-registration";
import {
  derivedWaveTaskReview,
  issuedWaveReviewRosters,
  taskReviewScope,
  waveGateAuthorityDigest,
  waveReviewPriorFindings,
  waveTaskSubjectDigest,
} from "../../src/core/wave-review-authority";
import { parseWaveGateSuccessionAudit } from "../../src/core/wave-review-carry-audit";
import {
  carriedAcceptanceProblem,
  planSuccessorCarry,
  waveAcceptanceProblem,
  type CarryDrift,
  type SuccessorCarryInput,
} from "../../src/core/wave-review-carry";
import { parseTaskGraph } from "../../src/state-file-wire";
import type { RetiredWaveReviewRun, Task, TaskCommonMetadata, TaskGraph } from "../../src/types";
import { contract } from "../fixtures/contract-status-fixtures";
import { findingFixture } from "../fixtures/finding";
import { ownerObligation } from "../fixtures/owner-obligation";
import { activeWaveGateFixture, graphFixture, satisfiedProof, taskFixture } from "../fixtures/task-lifecycle";
import { value } from "../fixtures/parse-result";
import { withOrigin } from "../fixtures/wave-gate-origin";

const V4 = WAVE_REVIEWER_PROTOCOL_V4;
const ROSTER = BASE_WAVE_REVIEW_AGENTS;
const DIGEST_A = "a".repeat(64);
const PACKET = "1".repeat(64);
const PREVIOUS: RetiredWaveReviewRun = {
  schemaVersion: 1, kind: "retired-wave-review-run", runId: value(parseOrchestrationRunId("run.previous")), wave: 1,
  authorityDigest: value(parseArtifactDigest(DIGEST_A)), retirement: "abandoned",
};
const PREVIOUS_AUTHORITY = { runId: "run.previous", authorityDigest: DIGEST_A };

const observe = (task: Task, content = "export const x = 1;\n"): ReviewedWorkspaceObservation => {
  const scope = taskReviewScope(task);
  return value(reviewedWorkspaceObservation(task.id, scope, scope.map((path) => ({ path, bytes: Buffer.from(`${path}:${content}`) }))));
};

const implemented = (id: string, extra: Partial<TaskCommonMetadata> = {}): Task => {
  const file = `src/${id.toLowerCase()}.ts`;
  return taskFixture({ id, description: `${id} work`, agent: "code-implementer-agent", wave: 1, depends_on: [],
    status: "implemented", proof: satisfiedProof([file]), file_list: [file], files_modified: [file],
    spec_anchors: [], spec_contributions: [], test_result: { verdict: "trusted-pass" },
    review_generation: 0, review_status: "passed", findings: [], critical_findings: [], advisory_findings: [], ...extra });
};

/**
 * The acceptance a run recorded of `task` as `graph` presented it: the Subject
 * Digest of its packets, sealed with the Findings the acceptance left.
 */
function sealedAcceptance(graph: TaskGraph, task: Task, runId = "run.previous", authorityDigest = DIGEST_A): CurrentAcceptedReviewAuthority {
  const bytes = observe(task);
  const review = derivedWaveTaskReview(graph, 2, task);
  if (review.kind !== "roster") throw new Error(`fixture Task ${task.id} must be reviewed`);
  return {
    generation: task.review_generation ?? 0, packet_id: PACKET, head_sha: bytes.headSha, scope: bytes.scope,
    run_id: runId, authority_digest: authorityDigest, reviewer_protocol: V4,
    subject_digest: acceptedSubjectDigest(waveTaskSubjectDigest(graph, task, review, V4, bytes), task),
  };
}

/** Six implemented Tasks of Wave 1, each accepted by the retired run `run.previous`. */
function retiredWave(seed: Readonly<{ t1?: Partial<TaskCommonMetadata>; graph?: Partial<TaskGraph> }> = {}): TaskGraph {
  const unsealed: TaskGraph = {
    ...graphFixture(["T1", "T2", "T3", "T4", "T5", "T6"].map((id) => implemented(id, id === "T1" ? seed.t1 : {}))),
    spec_trace_version: 2,
    ...seed.graph,
  };
  return {
    ...unsealed,
    tasks: unsealed.tasks.map((task) => ({ ...task, accepted_review_authority: sealedAcceptance(unsealed, task) })),
    retired_wave_review_runs: [PREVIOUS],
  };
}

/** The predecessor's fresh registration; vary its origin with `withOrigin`. */
const previousRegistration = (
  extra: Readonly<{ authorityDigest?: string; reviewerProtocol?: ReviewerProtocolDescriptor }> = {},
): RegisteredWaveGateProgram => ({
  schemaVersion: 2, reviewerProtocol: extra.reviewerProtocol ?? V4, kind: "wave-gate", input: { wave: 1 },
  taskIds: ["T1", "T2", "T3", "T4", "T5", "T6"], authorityDigest: extra.authorityDigest ?? DIGEST_A,
});

function succeed(graph: TaskGraph, overrides: Partial<SuccessorCarryInput> = {}) {
  return planSuccessorCarry({
    graph,
    taskIds: graph.tasks.map(({ id }) => id),
    protocol: V4,
    predecessor: PREVIOUS,
    previous: { ok: true, value: previousRegistration() },
    workspaces: graph.tasks.map((task) => observe(task)),
    ...overrides,
  });
}

const carriedIds = (graph: TaskGraph, overrides: Partial<SuccessorCarryInput> = {}): readonly string[] =>
  succeed(graph, overrides).succession?.carry.carried.map(({ taskId }) => taskId) ?? [];

const withTask = (graph: TaskGraph, id: string, change: (task: Task) => Task): TaskGraph =>
  ({ ...graph, tasks: graph.tasks.map((task) => (task.id === id ? change(task) : task)) });

describe("a fresh start carries every unchanged Task's accepted review from the retired run it succeeds", () => {
  it("carries every Task of an unchanged Wave as a whole-roster acceptance along the predecessor's lineage", () => {
    const plan = succeed(retiredWave());
    expect(plan.notCarried).toEqual([]);
    expect(plan.succession).toEqual({
      previousRunId: "run.previous", previousAuthorityDigest: DIGEST_A, kind: "abandoned",
      carry: {
        lineage: [PREVIOUS_AUTHORITY],
        carried: ["T1", "T2", "T3", "T4", "T5", "T6"].map((taskId) =>
          ({ kind: "accepted-task", taskId, roster: ROSTER, acceptance: PREVIOUS_AUTHORITY })),
      },
    });
  });

  it("an unchanged Task carries although its sibling changed; the changed one is reviewed in full and named", () => {
    const graph = retiredWave();
    const t6 = graph.tasks[5]!;
    const plan = succeed(graph, { workspaces: graph.tasks.map((task) => (task === t6 ? observe(task, "changed") : observe(task))) });
    expect(plan.succession?.carry.carried.map(({ taskId }) => taskId)).toEqual(["T1", "T2", "T3", "T4", "T5"]);
    expect(plan.notCarried).toEqual([{ taskId: "T6", reason: { kind: "drift", fields: ["head", "subject"] } }]);
    // The batch then issues spec-check plus T6's roster only.
    expect(issuedWaveReviewRosters(graph.tasks.map(({ id }) => ({ taskId: id, roster: ROSTER })),
      plan.succession === undefined ? undefined : { kind: "succession", audit: plan.succession.carry }))
      .toEqual([{ taskId: "T6", roster: ROSTER }]);
  });

  it("a reopened Task holds no acceptance and is named; a run that carries nothing records no succession", () => {
    const graph = withTask(retiredWave(), "T6", (task) => ({ ...task, accepted_review_authority: undefined, review_status: "pending" }));
    expect(succeed(graph).notCarried).toEqual([{ taskId: "T6", reason: { kind: "nothing-accepted" } }]);
    const none = graph.tasks.map((task) => observe(task, "changed"));
    expect(succeed(graph, { workspaces: none }).succession).toBeUndefined();
  });

  it("an acceptance recorded before the Subject Digest is reviewed in full once, with a typed reason", () => {
    const graph = withTask(retiredWave(), "T1", (task) => {
      const { subject_digest: _legacy, ...accepted } = task.accepted_review_authority as CurrentAcceptedReviewAuthority;
      return { ...task, accepted_review_authority: accepted };
    });
    expect(succeed(graph).notCarried).toEqual([{ taskId: "T1", reason: { kind: "legacy-acceptance" } }]);
  });

  it("a review still collecting evidence when its run ended is reissued", () => {
    const graph = withTask(retiredWave(), "T1", (task) => ({ ...task, review_run: { generation: 0, packet_id: PACKET,
      head_sha: "c".repeat(40), expected_agents: ROSTER, prior_finding_ids: [], evidence: [] } }));
    expect(succeed(graph).notCarried).toEqual([{ taskId: "T1", reason: { kind: "review-unsettled" } }]);
  });

  it("names the predecessor it could not read, or whose registration is another run authority, for every reviewed Task", () => {
    const graph = retiredWave();
    const unreadable = succeed(graph, { previous: { ok: false, error: "run directory is gone" } });
    expect(unreadable.succession).toBeUndefined();
    expect(unreadable.notCarried).toHaveLength(6);
    expect(unreadable.notCarried[0]).toEqual({ taskId: "T1", reason: { kind: "predecessor-unreadable", error: "run directory is gone" } });
    const other = succeed(graph, { previous: { ok: true, value: previousRegistration({ authorityDigest: "b".repeat(64) }) } });
    expect(other.notCarried[0]?.reason.kind).toBe("predecessor-unreadable");
    const v2 = succeed(graph, { previous: { ok: true, value: previousRegistration({ reviewerProtocol: REVIEWER_PROTOCOL_V2 }) } });
    expect(v2.notCarried[0]).toEqual({ taskId: "T1", reason: { kind: "predecessor-protocol" } });
  });
});

describe("the lineage a Successor Carry admits", () => {
  const earliest = { runId: "run.earliest", authorityDigest: "c".repeat(64) };
  const acceptedEarlier = (): TaskGraph => {
    const graph = retiredWave();
    return withTask(graph, "T1", (task) => ({ ...task, accepted_review_authority: sealedAcceptance(graph, task, earliest.runId, earliest.authorityDigest) }));
  };

  it("carries an acceptance the predecessor itself carried, and extends that run's lineage", () => {
    const predecessorCarried = withOrigin(previousRegistration(), { succession: { previousRunId: earliest.runId, previousAuthorityDigest: earliest.authorityDigest,
      kind: "completed-reopened", carry: { lineage: [earliest], carried: [{ kind: "accepted-task", taskId: "T1", roster: ROSTER, acceptance: earliest }] } } });
    const plan = succeed(acceptedEarlier(), { previous: { ok: true, value: predecessorCarried } });
    expect(plan.succession?.carry.lineage).toEqual([earliest, PREVIOUS_AUTHORITY]);
    expect(plan.succession?.carry.carried[0]).toEqual({ kind: "accepted-task", taskId: "T1", roster: ROSTER, acceptance: earliest });
  });

  it("refuses an acceptance from a run the predecessor never carried", () => {
    expect(succeed(acceptedEarlier()).notCarried).toEqual([{ taskId: "T1", reason: { kind: "acceptance-off-lineage", runId: "run.earliest" } }]);
  });
});

describe("the Subject Digest: an unchanged subject carries, and any single change to it does not", () => {
  /** One change to T1's review subject, the drift it reports, and whether it changes every Task's subject. */
  type Mutation = Readonly<{ name: string; drift: readonly CarryDrift[]; apply: (graph: TaskGraph) => TaskGraph; waveWide?: true }>;
  const onT1 = (change: Partial<TaskCommonMetadata> | ((task: Task) => Task)) => (graph: TaskGraph): TaskGraph =>
    withTask(graph, "T1", (task) => (typeof change === "function" ? change(task) : ({ ...task, ...change } as Task)));
  const finding: Finding = attributeFindings([{ severity: "advisory", file: null, line: null, claim: "added later" }], "code-reviewer")[0]!;
  const MUTATIONS: readonly Mutation[] = [
    { name: "description", drift: ["subject"], apply: onT1({ description: "T1 work, rewritten" }) },
    { name: "plan context", drift: ["subject"], apply: onT1({ plan_context: "a new plan excerpt" }) },
    { name: "Requirement anchors", drift: ["subject"], apply: onT1({ spec_anchors: ["FR-001"] }) },
    { name: "Requirement contributions", drift: ["subject"], apply: onT1({ spec_contributions: ["FR-001"] }) },
    { name: "proof", drift: ["subject"], apply: onT1((task) => ({ ...task, proof: satisfiedProof(["src/t1.ts", "src/other.ts"]) } as Task)) },
    { name: "test result", drift: ["subject"], apply: onT1({ test_result: { verdict: "trusted-fail" } }) },
    { name: "a Finding added", drift: ["subject"], apply: onT1({ findings: [finding], advisory_findings: [finding.claim] }) },
    { name: "Review Generation", drift: ["generation", "subject"], apply: onT1({ review_generation: 1 }) },
    { name: "agent", drift: ["subject"], apply: onT1({ agent: "frontend-agent" }) },
    // The reviewed scope is file_list ∪ files_modified, so emptying either one alone keeps the scope and bytes.
    { name: "declared files", drift: ["subject"], apply: onT1({ file_list: [] }) },
    { name: "modified files", drift: ["subject"], apply: onT1({ files_modified: [] }) },
    // The packets cite the plan file, so moving it changes every Task's subject.
    { name: "plan file", drift: ["subject"], apply: (graph) => ({ ...graph, plan_file: "/plans/other.md" }), waveWide: true },
    // The roster the Subject Digest binds now has the architecture reviewer.
    { name: "owner map", drift: ["subject"], apply: (graph) => ({ ...graph, owner_obligations: [ownerObligation({
      invariant: "INV-1", title: "t1", statement: "Every entry point reads t1 through src/t1.ts.", owner: "src/t1.ts",
      siblings: [], matrixTest: "tests/t1.matrix.test.ts", mutation: { kind: "verify" } })] }) },
    { name: "contract surface", drift: ["subject"], apply: (graph) => ({ ...graph, acceptance_contracts: [contract({
      id: "CT-1", contractTask: "T1", surface: { types: "src/t1.ts", acceptance: "tests/t1.acceptance.test.ts" },
      anchors: ["AS-001"], freeze: { state: "awaiting-red" } })] }) },
  ];

  it("the unchanged subject carries", () => {
    expect(carriedIds(retiredWave())).toContain("T1");
  });

  it.each(MUTATIONS)("a change of $name blocks T1's carry with typed drift", ({ apply, drift, waveWide }) => {
    const plan = succeed(apply(retiredWave()));
    expect(plan.notCarried).toContainEqual({ taskId: "T1", reason: { kind: "drift", fields: drift } });
    expect(plan.succession?.carry.carried.map(({ taskId }) => taskId))
      .toEqual(waveWide === true ? undefined : ["T2", "T3", "T4", "T5", "T6"]);
  });

  it("property: an unchanged subject carries, and any single mutation of it does not", () => {
    fc.assert(fc.property(fc.option(fc.constantFrom(...MUTATIONS), { nil: undefined }), fc.string({ minLength: 1 }), (mutation, text) => {
      const described = mutation?.name === "description" ? onT1({ description: `T1 work: ${text}` }) : mutation?.apply;
      const graph = described === undefined ? retiredWave() : described(retiredWave());
      expect(carriedIds(graph).includes("T1")).toBe(mutation === undefined);
    }), { numRuns: 60 });
  });

  it("a Refutation Panel moving a Finding from active to refuted leaves the seal intact", () => {
    const critical = attributeFindings([{ severity: "critical", file: null, line: null, claim: "refuted later" }], "code-reviewer")[0]!;
    const accepted = retiredWave({ t1: { findings: [critical], critical_findings: [critical.claim], review_status: "blocked" } });
    const refuted = withTask(accepted, "T1", (task) => ({ ...task, findings: [], critical_findings: [], review_status: "passed",
      refuted_findings: [{ finding: critical, refutations: [{ lens: "reachability", reason: "unreachable" }] }] }));
    expect(carriedIds(refuted)).toContain("T1");
  });
});

describe("completion admits a carried acceptance only along a protected succession", () => {
  const carried = (): RegisteredWaveGateProgram =>
    withOrigin(previousRegistration({ authorityDigest: "d".repeat(64) }), { succession: succeed(retiredWave()).succession! });
  const t1 = (): Task => retiredWave().tasks[0]!;

  it("admits an acceptance on the lineage while the predecessor is a protected retired run of the Wave", () => {
    expect(waveAcceptanceProblem(t1(), carried(), "run.next", [PREVIOUS])).toBeNull();
  });

  it("refuses a forged succession whose predecessor no protected record retired, or retired otherwise", () => {
    expect(waveAcceptanceProblem(t1(), carried(), "run.next", [])).toContain("no protected retired run");
    expect(waveAcceptanceProblem(t1(), carried(), "run.next", [{ ...PREVIOUS, retirement: "completed-reopened" }]))
      .toContain("no protected retired run");
    expect(waveAcceptanceProblem(t1(), carried(), "run.next", [{ ...PREVIOUS, wave: 2 }])).toContain("no protected retired run");
  });

  it("fails closed on a succession registered without an exact Wave", () => {
    const nullWave = { ...carried(), input: { wave: null } } as RegisteredWaveGateProgram;
    expect(waveAcceptanceProblem(t1(), nullWave, "run.next", [PREVIOUS])).toContain("no protected retired run");
  });

  it("refuses an acceptance off the recorded lineage", () => {
    const forged = { ...t1(), accepted_review_authority: { ...(t1().accepted_review_authority as CurrentAcceptedReviewAuthority), run_id: "run.forged" } };
    expect(waveAcceptanceProblem(forged, carried(), "run.next", [PREVIOUS]))
      .toContain("neither this run's nor carried along its recorded lineage");
  });
});

describe("the locked registration install checks a succession's provenance", () => {
  const tombstoned = (): TaskGraph => {
    const { retired_wave_review_runs: _none, ...graph } = retiredWave();
    return { ...graph, active_wave_gate: activeWaveGateFixture({ runId: "run.previous", wave: 1, authorityDigest: DIGEST_A,
      terminalOutcome: { kind: "terminal-abandoned", reason: "fix T6", supersededBy: null } }) };
  };
  const taskIds = ["T1", "T2", "T3", "T4", "T5", "T6"];
  const install = (graph: TaskGraph, succession?: WaveGateSuccessionAudit) => installWaveGateRegistration(graph,
    activeWaveGateFixture({ runId: "run.next", wave: 1, authorityDigest: waveGateAuthorityDigest(1, taskIds, graph) }), taskIds, succession);

  it("names the abandoned tombstone, else the Wave's latest retired run, as the predecessor", () => {
    expect(successionPredecessorOf(tombstoned(), 1)).toEqual(PREVIOUS);
    const later = { ...PREVIOUS, runId: value(parseOrchestrationRunId("run.later")), retirement: "completed-reopened" as const };
    expect(successionPredecessorOf({ ...retiredWave(), retired_wave_review_runs: [PREVIOUS, later] }, 1)).toEqual(later);
    expect(successionPredecessorOf(retiredWave(), 2)).toBeNull();
  });

  it("installs over the tombstone it succeeds, records the retired run and keeps every acceptance", () => {
    const succession = succeed(tombstoned()).succession!;
    const decision = install(tombstoned(), succession);
    if (decision.kind !== "installed") throw new Error(JSON.stringify(decision));
    expect(decision.state.retired_wave_review_runs).toEqual([PREVIOUS]);
    expect(decision.state.tasks.map(({ accepted_review_authority }) => accepted_review_authority?.run_id)).toEqual(taskIds.map(() => "run.previous"));
    expect(parseTaskGraph(JSON.parse(JSON.stringify(decision.state))).ok).toBe(true);
  });

  it("refuses a succession naming another predecessor, or carrying an acceptance the Task no longer holds", () => {
    const succession = succeed(tombstoned()).succession!;
    const forged = install(tombstoned(), { ...succession, previousRunId: "run.forged" });
    expect(forged).toMatchObject({ kind: "refused", message: expect.stringContaining("protected predecessor is abandoned run run.previous") });
    const reopened = withTask(tombstoned(), "T1", (task) => ({ ...task, accepted_review_authority: undefined }));
    expect(install(reopened, succession)).toMatchObject({ kind: "refused", message: expect.stringContaining("Task T1") });
    const { active_wave_gate: _gone, ...noPredecessor } = tombstoned();
    expect(install(noPredecessor, succession)).toMatchObject({ kind: "refused", message: expect.stringContaining("predecessor is none") });
  });

  it("an install without a succession is exactly the install of before", () => {
    const graph = retiredWave();
    const registration = activeWaveGateFixture({ runId: "run.next", wave: 1, authorityDigest: waveGateAuthorityDigest(1, taskIds, graph) });
    expect(installWaveGateRegistration(graph, registration, taskIds)).toEqual({ kind: "installed", state: { ...graph, active_wave_gate: registration }, registration });
  });
});

describe("retiring a run records it as Successor Carry provenance", () => {
  it("superseding an abandoned tombstone records it once and keeps its acceptances and review status", () => {
    const graph: TaskGraph = { ...retiredWave(), retired_wave_review_runs: undefined,
      active_wave_gate: activeWaveGateFixture({ runId: "run.previous", wave: 1, authorityDigest: DIGEST_A,
        terminalOutcome: { kind: "terminal-abandoned", reason: "fix", supersededBy: null } }) };
    const retired = supersedeAbandonedWaveGateReview(graph, "run.previous", ["T1"]);
    expect(retired.retired_wave_review_runs).toEqual([PREVIOUS]);
    expect(retired.tasks[0]).toMatchObject({ review_status: "passed", accepted_review_authority: { run_id: "run.previous" } });
    expect(retired.active_wave_gate).toBeUndefined();
  });

  it("a reopened completed run is recorded as completed-reopened", () => {
    const { retired_wave_review_runs: _none, ...graph } = retiredWave();
    expect(retireReopenedWaveReview(graph, { runId: PREVIOUS.runId, wave: 1, authorityDigest: PREVIOUS.authorityDigest }).retired_wave_review_runs)
      .toEqual([{ ...PREVIOUS, retirement: "completed-reopened" }]);
  });
});

describe("the State File and registration parse the new authority", () => {
  const loads = (graph: unknown): boolean => parseTaskGraph(JSON.parse(JSON.stringify(graph))).ok;

  it("round-trips retired runs and sealed acceptances, and refuses a run retired twice or a malformed record", () => {
    expect(loads(retiredWave())).toBe(true);
    expect(loads({ ...retiredWave(), retired_wave_review_runs: [PREVIOUS, PREVIOUS] })).toBe(false);
    expect(loads({ ...retiredWave(), retired_wave_review_runs: [{ ...PREVIOUS, retirement: "orphaned" }] })).toBe(false);
    // Wire bytes no engine could write: a sealed digest that is no digest.
    const graph = retiredWave();
    expect(loads({ ...graph, tasks: graph.tasks.map((task) => (task.id === "T1"
      ? { ...task, accepted_review_authority: { ...task.accepted_review_authority, subject_digest: "not-a-digest" } }
      : task)) })).toBe(false);
  });

  it("refuses a live gate that names a retired run", () => {
    expect(loads({ ...retiredWave(), active_wave_gate: activeWaveGateFixture({ runId: "run.previous", wave: 1, authorityDigest: DIGEST_A }) })).toBe(false);
  });

  it("parses a succession, and refuses one carrying slots or whose lineage does not end with its predecessor", () => {
    const succession = succeed(retiredWave()).succession!;
    expect(parseWaveGateSuccessionAudit(JSON.parse(JSON.stringify(succession)))).toEqual({ ok: true, value: succession });
    const raw = JSON.parse(JSON.stringify(succession)) as { carry: { lineage: unknown[]; carried: unknown[] } };
    expect(parseWaveGateSuccessionAudit({ ...raw, carry: { ...raw.carry, carried: [{ kind: "accepted-slots", taskId: "T1", agents: ["code-reviewer"] }] } }).ok).toBe(false);
    const other = { runId: "run.other", authorityDigest: "e".repeat(64) };
    expect(parseWaveGateSuccessionAudit({ ...raw, carry: { ...raw.carry, lineage: [PREVIOUS_AUTHORITY, other] } }).ok).toBe(false);
    expect(parseWaveGateSuccessionAudit({ ...raw, kind: "restarted" }).ok).toBe(false);
  });

  it("parses a registration with a lone succession, and refuses one beside a restart or on a null-Wave input", () => {
    const registration = withOrigin(previousRegistration({ authorityDigest: "d".repeat(64) }), { succession: succeed(retiredWave()).succession! });
    const raw = JSON.parse(JSON.stringify(registration)) as Record<string, unknown>;
    expect(parseRegisteredFacadeProgram(raw)).toEqual({ kind: "registered", program: registration });
    const withRestart = parseRegisteredFacadeProgram({ ...raw, restart: { previousRunId: "run.previous", exhaustedSlots: ["T1/code-reviewer"] } });
    expect(withRestart.kind).toBe("invalid");
    const nullWave = parseRegisteredFacadeProgram({ ...raw, input: { wave: null } });
    expect(nullWave).toMatchObject({ kind: "invalid", message: expect.stringContaining("exact Wave") });
  });

  it("refuses a Review Run Subject Digest that is no digest, and one on a legacy Review Run", () => {
    const current = { generation: 0, packet_id: PACKET, head_sha: "c".repeat(40), expected_agents: ROSTER, prior_finding_ids: [],
      reviewer_protocol: V4, evidence: [], slot_authority: [], workspace_scope: ["src/t1.ts"], workspace_head_sha: "e".repeat(64),
      wave_gate_run_id: "run.next", wave_gate_authority_digest: DIGEST_A };
    expect(reviewRunError({ ...current, subject_digest: "not-a-digest" }, 0, [], "review_run")).toContain("subject_digest");
    const { reviewer_protocol: _legacy, ...legacy } = current;
    expect(reviewRunError({ ...legacy, slot_authority: undefined, subject_digest: "f".repeat(64) }, 0, [], "review_run"))
      .toContain("subject_digest");
  });

  it("a six-reviewer roster derived from an owner map carries with that roster", () => {
    const owned = (graph: TaskGraph): TaskGraph => ({ ...graph, plan_file: "/plan.md", owner_obligations: [ownerObligation({
      invariant: "INV-1", title: "t1", statement: "Every entry point reads t1 through src/t1.ts.", owner: "src/t1.ts",
      siblings: [], matrixTest: "tests/t1.matrix.test.ts", mutation: { kind: "verify" } })] });
    const unsealed = owned(graphFixture(["T1"].map((id) => implemented(id))));
    const graph: TaskGraph = { ...unsealed, retired_wave_review_runs: [PREVIOUS],
      tasks: unsealed.tasks.map((task) => ({ ...task, accepted_review_authority: sealedAcceptance(unsealed, task) })) };
    expect(succeed(graph).succession?.carry.carried).toEqual([
      { kind: "accepted-task", taskId: "T1", roster: ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS, acceptance: PREVIOUS_AUTHORITY }]);
  });
});

describe("an advisory disposition recorded after an acceptance never breaks its carry (ADR-0090, ADR-0091)", () => {
  // T1's acceptance left an active advisory; the operator decides it afterwards.
  const advice = findingFixture("code-reviewer-7", "advisory", "src/t1.ts");
  const advised = (): TaskGraph => retiredWave({ t1: { findings: [advice], advisory_findings: [advice.claim] } });
  const disposition = (decision: "fixed" | "deferred" | "dismissed", anchorHolds: boolean) => {
    const t1 = advised().tasks[0]!;
    const anchor = anchorDigest(advice.file, observe(t1, anchorHolds ? undefined : "other bytes").artifacts);
    return value(advisoryDisposition({ wave: 1, taskId: "T1", findingId: advice.id, decision, reason: "operator decision",
      target: null, anchor: decision === "fixed" ? null : anchor }));
  };

  it("a disposition leaves the Subject Digest and its seal untouched, so every Task still carries", () => {
    fc.assert(fc.property(
      fc.constantFrom("fixed" as const, "deferred" as const, "dismissed" as const), fc.boolean(),
      (decision, anchorHolds) => {
        const graph: TaskGraph = { ...advised(), advisory_dispositions: [disposition(decision, anchorHolds)] };
        const plan = succeed(graph);
        expect(plan.notCarried).toEqual([]);
        expect(plan.succession?.carry.carried.map(({ taskId }) => taskId)).toEqual(["T1", "T2", "T3", "T4", "T5", "T6"]);
      },
    ));
  });

  it("the batch install still honours the carried acceptance once the disposition is recorded", () => {
    const before = advised();
    const entry = succeed(before).succession!.carry.carried[0]!;
    const after: TaskGraph = { ...before, advisory_dispositions: [disposition("dismissed", true)] };
    const t1 = after.tasks[0]!;
    const review = derivedWaveTaskReview(after, 2, t1);
    if (review.kind !== "roster") throw new Error("T1 must be reviewed");
    const bytes = observe(t1);
    // The disposition does change what a fresh review of T1 would be issued...
    expect(waveReviewPriorFindings(before, before.tasks[0]!, bytes.artifacts, "fresh").ids).toEqual([advice.id]);
    expect(waveReviewPriorFindings(after, t1, bytes.artifacts, "fresh").ids).toEqual([]);
    // ...but T1 is issued to no reviewer, and its carried acceptance still holds.
    expect(carriedAcceptanceProblem(t1, entry,
      { protocol: V4, roster: review.roster, bytes, subject: waveTaskSubjectDigest(after, t1, review, V4, bytes) }, "succession"))
      .toBeNull();
  });

  it("a Finding added after the acceptance still breaks the seal, disposition or not", () => {
    const added = findingFixture("code-reviewer-6", "advisory", "src/t1.ts");
    const graph = withTask({ ...advised(), advisory_dispositions: [disposition("dismissed", true)] }, "T1",
      (task) => ({ ...task, findings: [...(task.findings ?? []), added] }));
    expect(succeed(graph).notCarried).toEqual([{ taskId: "T1", reason: { kind: "drift", fields: ["subject"] } }]);
  });
});
