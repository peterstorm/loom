/**
 * Reopening sweeps the Wave's Distill Task back (ADR-0068 §7): whenever a Task
 * is returned to revalidation — Task Reopening, Contract Revision, or a
 * reopened completed Wave — that Wave's settled Distill Task returns with it,
 * in the same transition and the same audit, so re-implemented code is
 * distilled again.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { createReopenTaskOperation } from "../../src/handlers/helpers/reopen-task";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import type { AcceptanceContract, FrozenPathObservation } from "../../src/core/acceptance-contract";
import { reviseAcceptanceContract, revisionOutcomeMessage } from "../../src/core/contract-revision";
import { distillDispatchBlockers } from "../../src/core/distill-task";
import { DISTILL_AGENT } from "../../src/core/model-profiles";
import { parseArtifactDigest, parseOrchestrationRunId } from "../../src/core/orchestration-contract";
import {
  parseTaskReopeningArgs,
  reopenImplementedTasks,
  sweptDistillTaskIdsOf,
  type TaskReopening,
} from "../../src/core/task-reopening";
import {
  reopenableWave,
  returnWaveTasksToRevalidation,
  revalidationTargets,
  sweptAmongReturned,
} from "../../src/core/task-revalidation";
import { checkImplementationProof } from "../../src/core/wave-gate-checks";
import { newWaveGate } from "../../src/core/wave-gate-model";
import type { WaveReviewContextAuthority } from "../../src/core/wave-review-authority";
import {
  deriveWaveReopeningProof,
  reopenCompletedWave,
} from "../../src/handlers/helpers/reopen-completed-wave";
import { parseTaskGraph } from "../../src/state-file-wire";
import type { Task, TaskGraph, TaskStatus } from "../../src/types";
import { digest, seen } from "../fixtures/acceptance-fixtures";
import { value } from "../fixtures/parse-result";
import {
  activeWaveGateFixture,
  completedWaveGateFixture,
  distillTaskFixture,
  protectedGraphFixture,
  satisfiedProof,
  taskFixture,
} from "../fixtures/task-lifecycle";

const fileOf = (id: string): string => `src/${id.toLowerCase()}.ts`;

const authored = (id: string, wave: number, status: TaskStatus, extra: Partial<Task> = {}): Task => taskFixture({
  id, description: id, agent: "code-implementer-agent", wave, depends_on: [],
  file_list: [fileOf(id)], spec_anchors: [], spec_contributions: [],
  status,
  ...(status === "pending" ? {} : { proof: satisfiedProof([fileOf(id)]) }),
  review_status: status === "pending" ? "pending" : "passed",
  review_generation: 2,
  ...extra,
});

const distill = (id: string, wave: number, scope: readonly string[], status: TaskStatus): Task =>
  distillTaskFixture({ id, wave, scope, status });

const byId = (graph: TaskGraph, id: string): Task => graph.tasks.find((candidate) => candidate.id === id)!;
const statuses = (graph: TaskGraph): Record<string, string> =>
  Object.fromEntries(graph.tasks.map(({ id, status }) => [id, status]));

const ABANDONED = activeWaveGateFixture({
  runId: "run.wave-1-abandoned", wave: 1, authorityDigest: "a".repeat(64), revision: 1,
  terminalOutcome: { kind: "terminal-abandoned", reason: "fix the advisory first", supersededBy: null },
});

/** Wave 1 current: implemented T1 and T2, their Distill Task T9, an abandoned gate; pending T3 in Wave 2 with its own pending Distill Task T10. */
const paused = (distillStatus: TaskStatus = "implemented", overrides: Record<string, unknown> = {}): TaskGraph =>
  protectedGraphFixture({
    spec_trace_version: 2, current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
    spec_file: null, plan_file: null, current_wave: 1, executing_tasks: [],
    tasks: [
      authored("T1", 1, "implemented"),
      authored("T2", 1, "implemented"),
      authored("T3", 2, "pending"),
      distill("T9", 1, [fileOf("T1"), fileOf("T2")], distillStatus),
      distill("T10", 2, [fileOf("T3")], "pending"),
    ],
    wave_gates: { "1": { ...newWaveGate(), impl_complete: true, tests_passed: true, reviews_complete: true }, "2": newWaveGate() },
    active_wave_gate: ABANDONED,
    ...overrides,
  });

const REASON = "comment-analyzer-1: fix the contradicting comment";
const request = (...taskIds: readonly string[]) =>
  value(parseTaskReopeningArgs(["--wave", "1", ...taskIds.flatMap((id) => ["--task", id]), "--reason", REASON]));

const reopening = (graph: TaskGraph, ...taskIds: readonly string[]): TaskReopening => {
  const result = reopenImplementedTasks(graph, request(...taskIds));
  if (!result.ok) throw new Error(`expected a reopening, got ${result.error.kind}: ${result.error.message}`);
  return result.value;
};
const committed = (graph: TaskGraph, ...taskIds: readonly string[]): Extract<TaskReopening, { kind: "reopened" }> => {
  const outcome = reopening(graph, ...taskIds);
  if (outcome.kind !== "reopened") throw new Error("expected a committed reopening");
  return outcome;
};

describe("revalidationTargets: the one sweep rule every reopening shares", () => {
  const tasks = paused().tasks;

  it("adds the settled Distill Task of each named Task's Wave, in TaskGraph order", () => {
    expect(revalidationTargets(tasks, ["T2"])).toEqual({ taskIds: ["T2", "T9"], sweptDistillTaskIds: ["T9"] });
    expect(revalidationTargets(tasks, ["T2", "T1"])).toEqual({ taskIds: ["T1", "T2", "T9"], sweptDistillTaskIds: ["T9"] });
  });

  it("sweeps nothing for the Distill Task named itself, a pending one, or no Task", () => {
    expect(revalidationTargets(tasks, ["T9"])).toEqual({ taskIds: ["T9"], sweptDistillTaskIds: [] });
    expect(revalidationTargets(tasks, ["T3"])).toEqual({ taskIds: ["T3"], sweptDistillTaskIds: [] });
    expect(revalidationTargets(tasks, [])).toEqual({ taskIds: [], sweptDistillTaskIds: [] });
  });

  it("for any named Tasks, returns each of them, plus only settled Distill Tasks of their Waves, none named", () => {
    const ids = tasks.map(({ id }) => id);
    fc.assert(fc.property(fc.subarray(ids), (named) => {
      const { taskIds, sweptDistillTaskIds } = revalidationTargets(tasks, named);
      expect(taskIds).toEqual(ids.filter((id) => named.includes(id) || sweptDistillTaskIds.includes(id)));
      const waves = new Set(tasks.filter(({ id }) => named.includes(id)).map(({ wave }) => wave));
      for (const id of sweptDistillTaskIds) {
        const swept = tasks.find((task) => task.id === id)!;
        expect(named).not.toContain(id);
        expect(swept).toMatchObject({ agent: DISTILL_AGENT, status: "implemented" });
        expect(waves.has(swept.wave)).toBe(true);
      }
      // Idempotent: the swept set needs no second sweep.
      expect(revalidationTargets(tasks, taskIds).sweptDistillTaskIds).toEqual([]);
    }));
  });
});

describe("Task Reopening sweeps the Wave's Distill Task back", () => {
  it("returns the named sibling and the Distill Task in one transition, and leaves every other Task alone", () => {
    const before = paused();
    const outcome = committed(before, "T1");
    expect(statuses(outcome.graph)).toEqual({ T1: "pending", T2: "implemented", T3: "pending", T9: "pending", T10: "pending" });
    expect(byId(outcome.graph, "T9")).toMatchObject({ status: "pending", revalidation_required: true, review_status: "pending" });
    expect(byId(outcome.graph, "T9").proof).toEqual(byId(before, "T9").proof);
    for (const id of ["T2", "T3", "T10"]) expect(byId(outcome.graph, id)).toEqual(byId(before, id));
    expect(outcome.graph.active_wave_gate).toBeUndefined();
  });

  it("audits the swept Distill Task among the reopened Tasks and, apart, as engine-swept", () => {
    const outcome = committed(paused(), "T1");
    expect(outcome.audit).toEqual({
      schemaVersion: 1, kind: "implemented-tasks-reopened", wave: 1,
      reopenedTaskIds: ["T1", "T9"], sweptDistillTaskIds: ["T9"], reason: REASON, abandonedRunId: ABANDONED.runId,
    });
    expect(sweptDistillTaskIdsOf(outcome.audit)).toEqual(["T9"]);
    expect(outcome.graph.task_reopening_history).toEqual([outcome.audit]);
  });

  it("round-trips the swept graph and its audit through the State File parser", () => {
    const { graph, audit } = committed(paused(), "T1");
    const parsed = parseTaskGraph(JSON.parse(JSON.stringify(graph)));
    expect(parsed.ok, parsed.ok ? "" : String(parsed.error)).toBe(true);
    if (parsed.ok) expect(parsed.value.task_reopening_history).toEqual([audit]);
  });

  it("round-trips an audit that swept nothing with no swept field at all", () => {
    const { graph, audit } = committed(paused(), "T9");
    expect(audit).not.toHaveProperty("sweptDistillTaskIds");
    expect(sweptDistillTaskIdsOf(audit)).toEqual([]);
    const parsed = value(parseTaskGraph(JSON.parse(JSON.stringify(graph))));
    expect(parsed.task_reopening_history).toEqual([audit]);
    expect(parsed.task_reopening_history?.[0]).not.toHaveProperty("sweptDistillTaskIds");
  });

  describe("the State File refuses a malformed sweptDistillTaskIds", () => {
    /** The committed T1 reopening (reopened T1 and T9, swept T9) with its audit rewritten. */
    const loadWith = (rewrite: (audit: Record<string, unknown>) => Record<string, unknown>) => {
      const raw = JSON.parse(JSON.stringify(committed(paused(), "T1", "T2").graph));
      raw.task_reopening_history = [rewrite(raw.task_reopening_history[0])];
      return parseTaskGraph(raw);
    };
    const refusal = (sweptDistillTaskIds: unknown): string => {
      const parsed = loadWith((audit) => ({ ...audit, sweptDistillTaskIds }));
      if (parsed.ok) throw new Error("expected the State File to refuse the audit");
      return parsed.error;
    };
    const FIELD = "task_reopening_history[0].sweptDistillTaskIds";

    it("loads the audit as written, and one written before the field existed", () => {
      expect(loadWith((audit) => audit)).toMatchObject({ ok: true });
      const legacy = loadWith(({ sweptDistillTaskIds: _swept, ...audit }) => audit);
      expect(legacy).toMatchObject({ ok: true });
      if (legacy.ok) expect(legacy.value.task_reopening_history?.[0]).not.toHaveProperty("sweptDistillTaskIds");
    });

    it.each<readonly [string, unknown, string]>([
      ["an empty list", [], `${FIELD} must be a non-empty array when present`],
      ["a value that is not a list", "T9", `${FIELD} must be a non-empty array when present`],
      ["null", null, `${FIELD} must be a non-empty array when present`],
      ["an id that is not a Task id", ["nine"], `${FIELD}: id must match T\\d+, got "nine"`],
      ["a repeated id", ["T9", "T9"], `${FIELD} names a Task more than once`],
      ["an id the audit did not reopen", ["T10"], `${FIELD}: T10 is not among task_reopening_history[0].reopenedTaskIds`],
      ["a reopened Task that is not a Distill Task", ["T1"], `${FIELD}: T1 is not a Distill Task`],
    ])("refuses %s", (_label, swept, message) => {
      expect(refusal(swept)).toContain(message);
    });

    it("refuses a sweep with no Task it was swept with", () => {
      const parsed = loadWith((audit) => ({ ...audit, reopenedTaskIds: ["T9"], sweptDistillTaskIds: ["T9"] }));
      expect(parsed).toMatchObject({
        ok: false,
        error: expect.stringContaining(`${FIELD} names every reopened Task; a Distill Task is swept only with another Task of its Wave`),
      });
    });
  });

  it("blocks the next Wave Gate on both, and withholds the Distill Task until the sibling settles", () => {
    const { graph } = committed(paused(), "T1");
    const wave = graph.tasks.filter((task) => task.wave === 1);
    const proof = checkImplementationProof(wave);
    expect(proof.passed).toBe(false);
    if (!proof.passed) expect(proof.reason).toMatch(/T1 \(status=pending.*T9 \(status=pending/);
    expect(distillDispatchBlockers(graph.tasks, new Set(), byId(graph, "T9"))).toEqual(["T1"]);
  });

  it("reopens the Distill Task named alone like any Task, sweeping nothing else", () => {
    const before = paused();
    const outcome = committed(before, "T9");
    expect(statuses(outcome.graph)).toEqual({ T1: "implemented", T2: "implemented", T3: "pending", T9: "pending", T10: "pending" });
    expect(outcome.audit.reopenedTaskIds).toEqual(["T9"]);
    expect(outcome.audit.sweptDistillTaskIds).toBeUndefined();
    expect(distillDispatchBlockers(outcome.graph.tasks, new Set(), byId(outcome.graph, "T9"))).toEqual([]);
  });

  it("records it as swept only when the operator did not name it", () => {
    const outcome = committed(paused(), "T9", "T1");
    expect(outcome.audit.reopenedTaskIds).toEqual(["T1", "T9"]);
    expect(outcome.audit.sweptDistillTaskIds).toBeUndefined();
  });

  it("sweeps nothing when the Distill Task is still pending: it already owes its pass", () => {
    const before = paused("pending");
    const outcome = committed(before, "T1");
    expect(outcome.audit.reopenedTaskIds).toEqual(["T1"]);
    expect(outcome.audit.sweptDistillTaskIds).toBeUndefined();
    expect(byId(outcome.graph, "T9")).toEqual(byId(before, "T9"));
  });

  it("for any named Tasks, the audit's swept ids are exactly the reopened ids the operator did not name", () => {
    const implemented: readonly string[] = ["T1", "T2", "T9"];
    fc.assert(fc.property(fc.subarray([...implemented], { minLength: 1 }), (named) => {
      const { audit } = committed(paused(), ...named);
      expect(sweptDistillTaskIdsOf(audit)).toEqual(audit.reopenedTaskIds.filter((id) => !named.includes(id)));
      expect(audit.reopenedTaskIds).toEqual(expect.arrayContaining(named));
      // Absent, never empty: the State File refuses `[]`.
      expect(audit.sweptDistillTaskIds?.length ?? 1).toBeGreaterThan(0);
    }));
  });

  it("replaying the request that swept changes nothing", () => {
    const { graph, audit } = committed(paused(), "T1");
    expect(reopening(graph, "T1")).toEqual({ kind: "already-reopened", audit });
    // Naming the swept Distill Task too is the same committed reopening.
    expect(reopening(graph, "T1", "T9")).toEqual({ kind: "already-reopened", audit });
    // Adding a sibling the audit never reopened is a new request, judged afresh.
    expect(reopenImplementedTasks(graph, request("T1", "T2"))).toMatchObject({ ok: false, error: { kind: "not-implemented" } });
    expect(committed(graph, "T2").audit.reopenedTaskIds).toEqual(["T2"]);
  });

  it("is not a replay of a reopening that named other non-Distill Tasks", () => {
    const { graph } = committed(paused(), "T1", "T2");
    const result = reopenImplementedTasks(graph, request("T1"));
    expect(result).toMatchObject({ ok: false, error: { kind: "not-implemented" } });
  });

  it("reads the swept ids from the audit, not from the roster: a named Distill Task is not skippable on replay", () => {
    // The operator named T9 here, so the audit records no sweep. A request
    // naming only T1 would have swept T9 and written a different audit; it
    // is judged afresh, not answered as this reopening's replay.
    const { graph, audit } = committed(paused(), "T1", "T9");
    expect(audit.sweptDistillTaskIds).toBeUndefined();
    expect(reopening(graph, "T9", "T1")).toEqual({ kind: "already-reopened", audit });
    expect(reopenImplementedTasks(graph, request("T1"))).toMatchObject({ ok: false, error: { kind: "not-implemented" } });
  });

  it("a request naming only the swept Distill Task is not a replay of the reopening that swept it", () => {
    const { graph } = committed(paused(), "T1");
    expect(reopenImplementedTasks(graph, request("T9"))).toMatchObject({ ok: false, error: { kind: "not-implemented" } });
  });

  it("sweeps again when a re-implemented sibling is reopened after the Distill Task re-settled", () => {
    const first = committed(paused(), "T1").graph;
    const resettled: TaskGraph = {
      ...first,
      tasks: first.tasks.map((entry) => {
        if (entry.id === "T1") return authored("T1", 1, "implemented", { review_generation: 3 });
        return entry.id === "T9" ? distill("T9", 1, [fileOf("T1"), fileOf("T2")], "implemented") : entry;
      }),
    };
    const second = committed(resettled, "T1");
    expect(second.audit.reopenedTaskIds).toEqual(["T1", "T9"]);
    expect(second.graph.task_reopening_history).toHaveLength(2);
  });

  it("the shared transition returns exactly what it reports", () => {
    const reopenable = value(reopenableWave(paused()));
    const { graph, returned } = returnWaveTasksToRevalidation(reopenable, ["T2"]);
    expect(returned).toEqual({ taskIds: ["T2", "T9"], sweptDistillTaskIds: ["T9"] });
    expect(graph.tasks.filter(({ revalidation_required }) => revalidation_required === true).map(({ id }) => id))
      .toEqual(returned.taskIds);
    expect(graph.wave_gates["1"]).toMatchObject({ impl_complete: false, tests_passed: null, reviews_complete: false });
  });
});

describe("helper orchestration reopen-task over a Wave with a Distill Task", () => {
  const cleanup: string[] = [];
  let previousStatePath: string | undefined;
  afterEach(() => {
    vi.restoreAllMocks();
    if (previousStatePath === undefined) delete process.env.LOOM_STATE_PATH;
    else process.env.LOOM_STATE_PATH = previousStatePath;
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("persists the sweep and tells the operator which Task the engine added", async () => {
    previousStatePath = process.env.LOOM_STATE_PATH;
    const root = canonicalTempDir("loom-reopen-distill-");
    cleanup.push(root);
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    mkdirSync(join(root, ".claude", "state"), { recursive: true });
    writeFileSync(statePath, JSON.stringify(paused("implemented", { active_wave_gate: undefined })));
    process.env.LOOM_STATE_PATH = statePath;
    const written: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const args = ["--wave", "1", "--task", "T1", "--reason", REASON];
    expect(await createReopenTaskOperation(() => false)(args)).toEqual({ kind: "allow" });
    const stored = protectedGraphFixture(JSON.parse(readFileSync(statePath, "utf8")));
    expect(statuses(stored)).toEqual({ T1: "pending", T2: "implemented", T3: "pending", T9: "pending", T10: "pending" });
    expect(stored.task_reopening_history?.[0]?.reopenedTaskIds).toEqual(["T1", "T9"]);
    expect(written.join("")).toContain("Wave 1: T1, T9 reopened for re-implementation. The engine reopened T9 with them");

    // Replaying the command changes no byte and reports the same audit.
    const before = readFileSync(statePath);
    expect(await createReopenTaskOperation(() => false)(args)).toEqual({ kind: "allow" });
    expect(readFileSync(statePath)).toEqual(before);
    expect(written.join("")).toContain("Wave 1: T1, T9 already reopened; nothing changed.");
  });
});

describe("Contract Revision sweeps the current Wave's Distill Task back", () => {
  const TYPES = "src/payload-contract.ts";
  const ACCEPTANCE = "tests/payload.acceptance.test.ts";
  const CONTRACT: AcceptanceContract = {
    schemaVersion: 1, id: "CT-1", title: "Payload", statement: "One valid call wins.", contractTask: "T1",
    types: { kind: "file", path: TYPES },
    acceptance: [{ path: ACCEPTANCE, anchors: ["AS-001"] }],
    supportedDomain: null,
    freeze: {
      state: "frozen", wave: 1,
      paths: [{ path: TYPES, sha256: digest("a") }, { path: ACCEPTANCE, sha256: digest("b") }],
      roster: [{ file: ACCEPTANCE, name: "payload > AS-001: one call wins", anchors: ["AS-001"] }],
    },
    revisions: [],
  };
  const REVISED: ReadonlyMap<string, FrozenPathObservation> = new Map([[TYPES, seen(digest("c"))], [ACCEPTANCE, seen(digest("b"))]]);

  /** Wave 1 (the contract Wave) completed; Wave 2 current with claimant T2, bystander T3 and their Distill Task T9. */
  const populated = (claimant: TaskStatus, distillStatus: TaskStatus): TaskGraph => protectedGraphFixture({
    spec_trace_version: 2, current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
    spec_file: null, plan_file: null, current_wave: 2, executing_tasks: [],
    tasks: [
      authored("T1", 1, "completed", { file_list: [TYPES, ACCEPTANCE], proof: satisfiedProof([TYPES, ACCEPTANCE]) }),
      authored("T2", 2, claimant, { depends_on: ["T1"], spec_anchors: ["AS-001"] }),
      authored("T3", 2, "implemented", { depends_on: ["T1"] }),
      distill("T9", 2, [fileOf("T2"), fileOf("T3")], distillStatus),
    ],
    wave_gates: { "1": newWaveGate(), "2": { ...newWaveGate(), impl_complete: true, tests_passed: true } },
    wave_gate_history: [completedWaveGateFixture({ runId: "run.wave-1", wave: 1 })],
    acceptance_contracts: [CONTRACT],
  });

  const revised = (graph: TaskGraph) => {
    const result = reviseAcceptanceContract(graph, { contract: "CT-1", reason: "AS-001 asserted the wrong variant" }, REVISED);
    if (!result.ok) throw new Error(`expected a revision, got ${result.error.kind}: ${result.error.message}`);
    return result.value;
  };

  it("returns the implemented claimant and the Distill Task, audits both, and leaves the bystander implemented", () => {
    const outcome = revised(populated("implemented", "implemented"));
    expect(statuses(outcome.graph)).toEqual({ T1: "completed", T2: "pending", T3: "implemented", T9: "pending" });
    expect(byId(outcome.graph, "T9")).toMatchObject({ revalidation_required: true });
    expect(outcome.revision.revalidatedTaskIds).toEqual(["T2", "T9"]);
    expect(revisionOutcomeMessage(outcome)).toContain("T2, T9 returned to revalidation");
    expect(parseTaskGraph(JSON.parse(JSON.stringify(outcome.graph)))).toMatchObject({ ok: true });
  });

  it("sweeps nothing when no claimant is returned", () => {
    const before = populated("pending", "pending");
    const outcome = revised(before);
    expect(outcome.revision.revalidatedTaskIds).toEqual([]);
    expect(byId(outcome.graph, "T9")).toEqual(byId(before, "T9"));
  });
});

describe("reopening a completed Wave sweeps its Distill Task back", () => {
  const AUTHORITY = "a".repeat(64);
  const HEAD = "b".repeat(64);
  const artifactDigest = (raw: string) => value(parseArtifactDigest(raw));
  const runId = value(parseOrchestrationRunId("wave-run"));
  const reviewedTask = (id: string): Task => authored(id, 3, "completed", { review_generation: 7 });
  const graph = (): TaskGraph => ({
    current_phase: "execute", current_wave: 4, phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: null,
    tasks: [
      reviewedTask("T19"), reviewedTask("T22"), authored("T23", 4, "pending", { review_generation: 0 }),
      distill("T30", 3, [fileOf("T19"), fileOf("T22")], "completed"),
    ],
    wave_gates: { "3": { impl_complete: true, tests_passed: true, reviews_complete: true, blocked: false } },
    wave_gate_history: [completedWaveGateFixture({ runId: "wave-run", wave: 3, authorityDigest: AUTHORITY })],
  });
  const request = (...taskIds: readonly string[]) => ({ runId: "wave-run", wave: 3, authorityDigest: AUTHORITY, taskIds });

  const context = (taskId: string, workspaceHeadSha?: string): WaveReviewContextAuthority => ({
    runId, wave: 3, authorityDigest: artifactDigest(AUTHORITY), batchEpoch: artifactDigest(HEAD),
    subject: { role: "code-reviewer", taskId },
    taskRun: {
      taskId, generation: 7, packetId: artifactDigest(AUTHORITY), headSha: artifactDigest(HEAD),
      ...(workspaceHeadSha === undefined ? {} : { workspaceHeadSha: artifactDigest(workspaceHeadSha) }),
    },
    task: {
      id: taskId, description: taskId, agent: "code-implementer-agent", reviewGeneration: 7, planContext: null,
      specAnchors: [], specContributions: [], declaredFiles: [fileOf(taskId)], modifiedFiles: [],
      proof: null, testResult: null, priorFindings: [],
    },
    specCheckScope: null, packetId: artifactDigest(AUTHORITY), specFile: null, planFile: null, specCheckDocuments: null,
  });
  const CONTEXTS = [context("T19", HEAD), context("T22", HEAD)];
  const drifting = (...drifted: readonly string[]) => (tasks: readonly Task[]) =>
    tasks.map(({ id }) => ({ taskId: id, headSha: drifted.includes(id) ? AUTHORITY : HEAD }));

  it("needs no packet authority for the Distill Task and never observes its workspace", () => {
    const observedIds: string[] = [];
    const proof = deriveWaveReopeningProof(graph(), request("T22", "T30"), CONTEXTS, (tasks) => {
      observedIds.push(...tasks.map(({ id }) => id));
      return drifting("T22")(tasks);
    });
    expect(observedIds).toEqual(["T19", "T22"]);
    expect(proof).toEqual({ mode: "modern-exact-workspace-drift", taskIds: ["T22", "T30"] });
  });

  it("names no Task when nothing drifted: the Distill Task alone is never proven drifted", () => {
    expect(deriveWaveReopeningProof(graph(), request("T22"), CONTEXTS, drifting()).taskIds).toEqual([]);
  });

  it("names every Task of the Wave, Distill Task included, when byte authority is unverifiable", () => {
    const proof = deriveWaveReopeningProof(graph(), request("T19"), [context("T19"), context("T22")], () => []);
    expect(proof).toEqual({ mode: "legacy-workspace-authority-unverifiable", taskIds: ["T19", "T22", "T30"] });
  });

  it("returns the drifted sibling and the completed Distill Task to revalidation and audits both", () => {
    const proof = deriveWaveReopeningProof(graph(), request("T22", "T30"), CONTEXTS, drifting("T22"));
    const reopened = reopenCompletedWave(graph(), request("T22", "T30"), proof);
    expect(statuses(reopened)).toEqual({ T19: "completed", T22: "pending", T23: "pending", T30: "pending" });
    expect(byId(reopened, "T30")).toMatchObject({ revalidation_required: true });
    expect(reopened.wave_reopening_history?.[0]).toMatchObject({
      proofMode: "modern-exact-workspace-drift", reopenedTaskIds: ["T22", "T30"], sweptDistillTaskIds: ["T30"],
    });
    expect(reopened.current_wave).toBe(3);
    expect(distillDispatchBlockers(reopened.tasks, new Set(), byId(reopened, "T30"))).toEqual(["T22"]);
  });

  it("audits the Distill Task as swept, never as proven drift, and the audit survives the State File", () => {
    const proof = deriveWaveReopeningProof(graph(), request("T22", "T30"), CONTEXTS, drifting("T22"));
    const reopened = reopenCompletedWave(graph(), request("T22", "T30"), proof);
    const audit = reopened.wave_reopening_history?.[0];
    const parsed = parseTaskGraph(JSON.parse(JSON.stringify({ ...reopened, spec_trace_version: 2 })));
    expect(parsed.ok, parsed.ok ? "" : parsed.error).toBe(true);
    if (parsed.ok) expect(parsed.value.wave_reopening_history).toEqual([audit]);
  });

  it("marks the Distill Task swept under unverifiable legacy authority too, and nothing when it returns alone", () => {
    const legacy = deriveWaveReopeningProof(graph(), request("T19"), [context("T19"), context("T22")], () => []);
    const reopened = reopenCompletedWave(graph(), request("T19", "T22", "T30"), legacy);
    expect(reopened.wave_reopening_history?.[0]).toMatchObject({
      proofMode: "legacy-workspace-authority-unverifiable", reopenedTaskIds: ["T19", "T22", "T30"], sweptDistillTaskIds: ["T30"],
    });
    const alone = reopenCompletedWave(graph(), request("T30"), { mode: "modern-exact-workspace-drift", taskIds: ["T30"] });
    expect(alone.wave_reopening_history?.[0]).not.toHaveProperty("sweptDistillTaskIds");
  });

  it("sweptAmongReturned names exactly the listed Distill Tasks that have a listed sibling", () => {
    const tasks = graph().tasks;
    expect(sweptAmongReturned(tasks, ["T22", "T30"])).toEqual(["T30"]);
    expect(sweptAmongReturned(tasks, ["T19", "T22"])).toEqual([]);
    expect(sweptAmongReturned(tasks, ["T30"])).toEqual([]);
    expect(sweptAmongReturned(tasks, ["T23", "T30"])).toEqual([]);
    expect(sweptAmongReturned(tasks, [])).toEqual([]);
  });

  it.each<readonly [string, unknown, string]>([
    ["an empty list", [], "wave_reopening_history[0].sweptDistillTaskIds must be a non-empty array when present"],
    ["a repeated id", ["T30", "T30"], "wave_reopening_history[0].sweptDistillTaskIds names a Task more than once"],
    ["an id the audit did not reopen", ["T19"], "wave_reopening_history[0].sweptDistillTaskIds: T19 is not among wave_reopening_history[0].reopenedTaskIds"],
    ["every reopened id", ["T22", "T30"], "wave_reopening_history[0].sweptDistillTaskIds names every reopened Task"],
  ])("the State File refuses a completed-Wave audit whose swept ids are %s", (_label, swept, message) => {
    const proof = deriveWaveReopeningProof(graph(), request("T22", "T30"), CONTEXTS, drifting("T22"));
    const raw = JSON.parse(JSON.stringify({ ...reopenCompletedWave(graph(), request("T22", "T30"), proof), spec_trace_version: 2 }));
    raw.wave_reopening_history[0].sweptDistillTaskIds = swept;
    expect(parseTaskGraph(raw)).toMatchObject({ ok: false, error: expect.stringContaining(message) });
  });

  it("refuses an operator payload that leaves the Distill Task out, naming the engine-derived set", () => {
    const proof = deriveWaveReopeningProof(graph(), request("T22"), CONTEXTS, drifting("T22"));
    expect(() => reopenCompletedWave(graph(), request("T22"), proof)).toThrow("exactly equal engine-derived modern-exact-workspace-drift: T22, T30");
  });

  it("refuses a hand-built proof that would leave the Distill Task standing", () => {
    const forged = { mode: "modern-exact-workspace-drift" as const, taskIds: ["T22"] };
    const before = graph();
    expect(() => reopenCompletedWave(before, request("T22"), forged)).toThrow("must also name the Wave's Distill Task T30");
    expect(before.wave_reopening_history).toBeUndefined();
  });
});
