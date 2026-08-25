import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import upgradeSpecTrace from "../../../src/handlers/helpers/upgrade-spec-trace";
import { prepareSpecTraceUpgrade } from "../../../src/core/spec-trace-migration";
import { createRunDirectory } from "../../../src/orchestration/run-directory-handle";
import { StateManager, parseTaskGraph } from "../../../src/state-manager";
import type { TaskGraph } from "../../../src/types";
import { pendingTaskProof } from "../../fixtures/task-lifecycle";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  delete process.env.LOOM_STATE_PATH;
  delete process.env.LOOM_SUBAGENT_DIR;
});

const finding = {
  id: "code-reviewer-1",
  agent: "code-reviewer",
  severity: "advisory" as const,
  file: null,
  line: null,
  claim: "preserved review evidence",
};

function legacyGraph(): TaskGraph {
  return {
    current_phase: "execute",
    current_wave: 1,
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: "spec.md",
    plan_file: "plan.md",
    executing_tasks: [],
    wave_gates: {},
    tasks: [
      {
        id: "T1", description: "partial", agent: "code-implementer-agent", wave: 1,
        status: "pending", proof: pendingTaskProof(), depends_on: [], spec_anchors: [], review_status: "pending",
        review_generation: 3, findings: [finding], critical_findings: [],
        advisory_findings: [finding.claim], refuted_findings: [], resolved_findings: [],
      },
      {
        id: "T2", description: "complete", agent: "code-implementer-agent", wave: 1,
        status: "pending", proof: pendingTaskProof(), depends_on: [], spec_anchors: ["FR-1"], review_status: "pending",
        review_generation: 7, findings: [], critical_findings: [], advisory_findings: [],
        refuted_findings: [], resolved_findings: [],
      },
    ],
    orphaned_wave_gate_history: [{
      schemaVersion: 1,
      kind: "orphaned-wave-gate-retirement",
      runId: "run.old" as never,
      wave: 1,
      authorityDigest: "a".repeat(64) as never,
      revision: 0,
      reason: "authoritative-run-directory-missing",
      runsRoot: "/runs",
      runDirectory: "/runs/run.old",
      replacementRunId: "run.replacement" as never,
      replacementAuthorityDigest: "b".repeat(64) as never,
    }],
  };
}

const input = {
  spec_trace_version: 2,
  tasks: [
    { id: "T1", spec_anchors: [], spec_contributions: ["FR-1"] },
    { id: "T2", spec_anchors: ["FR-1"], spec_contributions: [] },
  ],
} as const;

describe("spec trace migration core", () => {
  it("preserves implementation/review/Finding/audit fields and is idempotent", () => {
    const before = legacyGraph();
    const upgraded = prepareSpecTraceUpgrade(before, input);
    expect(upgraded.ok).toBe(true);
    if (!upgraded.ok) return;
    expect(upgraded.value.kind).toBe("upgraded");
    const after = upgraded.value.graph;
    expect(after.spec_trace_version).toBe(2);
    expect(after.tasks[0]?.spec_contributions).toEqual(["FR-1"]);
    expect(after.tasks.map(({ spec_anchors: _a, spec_contributions: _c, ...rest }) => rest))
      .toEqual(before.tasks.map(({ spec_anchors: _a, spec_contributions: _c, ...rest }) => rest));
    expect(after.orphaned_wave_gate_history).toBe(before.orphaned_wave_gate_history);

    const replay = prepareSpecTraceUpgrade(after, input);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.kind).toBe("already-v2");
      expect(replay.value.graph).toBe(after);
    }
    const stale = prepareSpecTraceUpgrade(after, {
      ...input,
      tasks: input.tasks.map((task) => task.id === "T1"
        ? { ...task, spec_contributions: [] }
        : task),
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.message).toContain("already v2 with different trace ownership");
  });

  it.each([
    ["partial", { spec_trace_version: 2, tasks: [input.tasks[0]] }, "missing existing Tasks"],
    ["foreign", { spec_trace_version: 2, tasks: [...input.tasks, { id: "T9", spec_anchors: [], spec_contributions: [] }] }, "foreign Tasks"],
    ["reordered", { spec_trace_version: 2, tasks: [...input.tasks].reverse() }, "roster order"],
  ])("refuses a %s roster", (_label, migration, message) => {
    const result = prepareSpecTraceUpgrade(legacyGraph(), migration);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(message);
  });

  it("refuses protected implementation reservations even before a roster file appears", () => {
    const result = prepareSpecTraceUpgrade({ ...legacyGraph(), executing_tasks: ["T1"] }, input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("protected implementation reservations are active: T1");
  });

  it("refuses active Wave Gate authority with the exact engine-owned prerequisite", () => {
    const graph = {
      ...legacyGraph(),
      active_wave_gate: {
        schemaVersion: 1 as const,
        kind: "active-wave-gate" as const,
        runId: "run.active" as never,
        wave: 1,
        authorityDigest: "c".repeat(64) as never,
        revision: 0,
        terminalOutcome: null,
      },
    };
    const result = prepareSpecTraceUpgrade(graph, input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Finish run run.active through the registered engine-owned Wave Gate");
    }
  });
});

describe("upgrade-spec-trace helper", () => {
  function fixture(): { root: string; statePath: string } {
    const root = mkdtempSync(join(tmpdir(), "loom-upgrade-spec-trace-"));
    cleanup.push(root);
    const statePath = join(root, "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify(legacyGraph()));
    chmodSync(statePath, 0o444);
    process.env.LOOM_STATE_PATH = statePath;
    return { root, statePath };
  }

  async function activeFixture(options: Readonly<{
    marker?: "valid" | "foreign" | "superseded" | "superseded-missing";
    programDigest?: string;
  }> = {}): Promise<{ root: string; statePath: string; runsRoot: string; graph: TaskGraph }> {
    const { root, statePath } = fixture();
    const runsRoot = join(root, "wave-gate-runs");
    mkdirSync(runsRoot);
    const opened = createRunDirectory(runsRoot, "run.active");
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error(opened.error.message);
    const authorityDigest = "c".repeat(64);
    const registered = await opened.value.registerProgram({
      schemaVersion: 1,
      kind: "wave-gate",
      input: { wave: 1 },
      taskIds: ["T1", "T2"],
      authorityDigest: options.programDigest ?? authorityDigest,
    });
    expect(registered.ok).toBe(true);
    if (options.marker === "valid") {
      const abandoned = await opened.value.abandonRun({
        supersededBy: null,
        reason: "legacy spec scope cannot reach the correct Requirement ownership",
      });
      expect(abandoned.ok).toBe(true);
    } else if (options.marker === "foreign") {
      writeFileSync(join(opened.value.runDirectory, "abandoned.json"), JSON.stringify({
        schemaVersion: 1,
        kind: "run-abandoned",
        runId: "run.foreign",
        supersededBy: null,
        reason: "wrong run",
      }));
    } else if (options.marker === "superseded" || options.marker === "superseded-missing") {
      if (options.marker === "superseded") mkdirSync(join(runsRoot, "run.replacement"));
      const abandoned = await opened.value.abandonRun({
        supersededBy: "run.replacement",
        reason: "legacy scope requires a replacement run",
      });
      expect(abandoned.ok).toBe(true);
    }

    const graph: TaskGraph = {
      ...legacyGraph(),
      active_wave_gate: {
        schemaVersion: 1,
        kind: "active-wave-gate",
        runId: "run.active" as never,
        wave: 1,
        authorityDigest: authorityDigest as never,
        revision: 4,
        runsRoot,
        terminalOutcome: null,
      },
      wave_review_epoch: {
        runId: "run.active" as never,
        wave: 1,
        batchEpoch: "d".repeat(64) as never,
      },
      spec_check: {
        wave: 1,
        run_at: "2026-03-22T00:00:00.000Z",
        verdict: "PASSED",
        critical_count: 0,
        high_count: 0,
        critical_findings: [],
        high_findings: [],
        medium_findings: [],
      },
    };
    chmodSync(statePath, 0o644);
    writeFileSync(statePath, JSON.stringify(graph));
    chmodSync(statePath, 0o444);
    return { root, statePath, runsRoot, graph };
  }

  it("commits through StateManager and leaves the exact audit evidence intact", async () => {
    const { statePath } = fixture();
    const result = await upgradeSpecTrace(JSON.stringify(input), []);
    expect(result.kind).toBe("passthrough");
    const after = JSON.parse(readFileSync(statePath, "utf8")) as TaskGraph;
    expect(after.spec_trace_version).toBe(2);
    expect(after.tasks[0]?.findings).toEqual([finding]);
    expect(after.orphaned_wave_gate_history?.[0]?.runId).toBe("run.old");
  });

  it("keeps default active authority refusal when the retirement flag is absent", async () => {
    const { statePath } = await activeFixture({ marker: "valid" });
    const before = readFileSync(statePath, "utf8");
    const result = await upgradeSpecTrace(JSON.stringify(input), []);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("Finish run run.active");
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses the retirement flag without an immutable abandonment marker", async () => {
    const { statePath } = await activeFixture();
    const before = readFileSync(statePath, "utf8");
    const result = await upgradeSpecTrace(JSON.stringify(input), ["--retire-abandoned-run"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("is not abandoned");
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it.each([
    ["foreign marker", { marker: "foreign" as const }, "marker does not describe this run"],
    ["wrong program authority", { programDigest: "e".repeat(64) }, "program authority does not match"],
    ["supersession mismatch", { marker: "superseded-missing" as const }, "supersession mismatch"],
  ])("refuses %s without mutating protected state", async (_label, options, message) => {
    const { statePath } = await activeFixture(options);
    const before = readFileSync(statePath, "utf8");
    const result = await upgradeSpecTrace(JSON.stringify(input), ["--retire-abandoned-run"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain(message);
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("retires the exact abandoned run, clears only stale scope, preserves evidence, and replays idempotently", async () => {
    const { statePath, runsRoot, graph } = await activeFixture({ marker: "valid" });
    const result = await upgradeSpecTrace(JSON.stringify(input), ["--retire-abandoned-run"]);
    expect(result.kind).toBe("passthrough");

    const stored = new StateManager(statePath).load();
    expect(stored.active_wave_gate).toBeUndefined();
    expect(stored.wave_review_epoch).toBeUndefined();
    expect(stored.spec_check).toBeUndefined();
    expect(stored.spec_trace_version).toBe(2);
    expect(stored.tasks[0]?.spec_contributions).toEqual(["FR-1"]);
    expect(stored.tasks.map(({ spec_anchors: _a, spec_contributions: _c, ...rest }) => rest))
      .toEqual(graph.tasks.map(({ spec_anchors: _a, spec_contributions: _c, ...rest }) => rest));
    expect(stored.orphaned_wave_gate_history).toEqual(graph.orphaned_wave_gate_history);
    expect(stored.wave_gates).toEqual(graph.wave_gates);
    expect(stored.spec_trace_wave_gate_retirements).toEqual([{
      schemaVersion: 1,
      kind: "spec-trace-wave-gate-retirement",
      runId: "run.active",
      wave: 1,
      authorityDigest: "c".repeat(64),
      revision: 4,
      runsRoot,
      reason: "legacy spec scope cannot reach the correct Requirement ownership",
      supersededBy: null,
    }]);
    expect(Object.isFrozen(stored.spec_trace_wave_gate_retirements)).toBe(true);
    expect(Object.isFrozen(stored.spec_trace_wave_gate_retirements?.[0])).toBe(true);
    expect(parseTaskGraph(JSON.parse(JSON.stringify(stored))).ok).toBe(true);

    const committedBytes = readFileSync(statePath, "utf8");
    const replay = await upgradeSpecTrace(JSON.stringify(input), ["--retire-abandoned-run"]);
    expect(replay.kind).toBe("passthrough");
    expect(readFileSync(statePath, "utf8")).toBe(committedBytes);
    expect(new StateManager(statePath).load().spec_trace_wave_gate_retirements).toHaveLength(1);

    const conflicting = await upgradeSpecTrace(JSON.stringify({
      ...input,
      tasks: input.tasks.map((task) => task.id === "T1" ? { ...task, spec_contributions: [] } : task),
    }), ["--retire-abandoned-run"]);
    expect(conflicting.kind).toBe("error");
    if (conflicting.kind === "error") expect(conflicting.message).toContain("already v2 with different trace ownership");
    expect(readFileSync(statePath, "utf8")).toBe(committedBytes);
  });

  it("preserves an exact verified superseding-run pointer in the retirement audit", async () => {
    const { statePath } = await activeFixture({ marker: "superseded" });
    const result = await upgradeSpecTrace(JSON.stringify(input), ["--retire-abandoned-run"]);
    expect(result.kind).toBe("passthrough");
    expect(new StateManager(statePath).load().spec_trace_wave_gate_retirements?.[0]).toMatchObject({
      reason: "legacy scope requires a replacement run",
      supersededBy: "run.replacement",
    });
  });

  it("preserves a spec-check that does not belong to the retired Wave", async () => {
    const { statePath, graph } = await activeFixture({ marker: "valid" });
    const unrelatedSpecCheck = {
      wave: 2,
      run_at: "2026-03-22T00:00:00.000Z",
      verdict: "PASSED" as const,
      critical_count: 0,
      high_count: 0,
      critical_findings: [],
      high_findings: [],
      medium_findings: [],
    };
    chmodSync(statePath, 0o644);
    writeFileSync(statePath, JSON.stringify({ ...graph, spec_check: unrelatedSpecCheck }));
    chmodSync(statePath, 0o444);

    const result = await upgradeSpecTrace(JSON.stringify(input), ["--retire-abandoned-run"]);
    expect(result.kind).toBe("passthrough");
    expect(new StateManager(statePath).load().spec_check).toEqual(unrelatedSpecCheck);
  });

  it("refuses while a project-bound subagent roster is active", async () => {
    const { root, statePath } = fixture();
    const subagents = join(root, "subagents");
    cleanup.push(subagents);
    mkdirSync(subagents);
    writeFileSync(join(subagents, "session.active"), "agent-1\tcode-implementer-agent\n");
    writeFileSync(join(subagents, "session.task_graph"), statePath);
    process.env.LOOM_SUBAGENT_DIR = subagents;

    const before = readFileSync(statePath, "utf8");
    const result = await upgradeSpecTrace(JSON.stringify(input), ["--retire-abandoned-run"]);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("subagent is active");
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });
});
