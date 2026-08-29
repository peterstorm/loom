import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { createRunDirectory } from "../../../src/orchestration/run-directory-handle";
import {
  handleWaveReviewContext,
  installWaveReviewRuns,
  waveRequests,
  waveSpecCheckScope,
} from "../../../src/handlers/helpers/programs/wave-gate";
import type { RegisteredWaveGateProgram } from "../../../src/handlers/helpers/programs/helpers";
import type { TaskGraph } from "../../../src/types";
import { parseTaskGraph, StateManager } from "../../../src/state-manager";
import type { AgentRequestAuthority } from "../../../src/core/orchestration-contract";
import { taskFixture } from "../../fixtures/task-lifecycle";
import { WAVE_REVIEW_AGENTS } from "../../../src/core/model-profiles";

const cleanup: string[] = [];
afterEach(() => { for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("registered Wave spec-check scope", () => {
  it("defensively freezes arbitrary trace and file arrays", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fc.integer({ min: 1, max: 1000 }).map((n) => `FR-${n}`), { maxLength: 8 }),
      fc.uniqueArray(fc.integer({ min: 1, max: 1000 }).map((n) => `src/file-${n}.ts`), { maxLength: 8 }),
      (anchors, files) => {
        const sourceAnchors = [...anchors];
        const sourceFiles = [...files];
        const scope = waveSpecCheckScope([taskFixture({
          id: "T1", description: "scope", agent: "code-implementer-agent", wave: 1,
          status: "pending", depends_on: [], spec_anchors: sourceAnchors,
          spec_contributions: [], file_list: sourceFiles,
        })]);
        sourceAnchors.push("FR-MUTATED");
        sourceFiles.push("src/mutated.ts");
        expect(scope[0]?.completionAnchors).toEqual(anchors);
        expect(scope[0]?.declaredFiles).toEqual(files);
        expect(Object.isFrozen(scope[0]?.completionAnchors)).toBe(true);
      },
    ));
  });

  it("freezes the exact current-Wave roster, completion claims, contributions, and declared files", () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-wave-spec-scope-"));
    cleanup.push(runsRoot);
    const created = createRunDirectory(runsRoot, "run.scope");
    if (!created.ok) throw new Error(created.error.message);

    const completionAnchors = ["FR-1"];
    const contributions = ["FR-1"];
    const declaredFiles = ["src/contribution.ts"];
    const graph: TaskGraph = {
      spec_trace_version: 2,
      current_phase: "execute",
      current_wave: 1,
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: "spec.md",
      plan_file: "plan.md",
      wave_gates: {},
      tasks: [
        taskFixture({
          id: "T1", description: "partial implementation", agent: "code-implementer-agent", wave: 1,
          status: "pending", depends_on: [], spec_anchors: [], spec_contributions: contributions,
          file_list: declaredFiles,
        }),
        taskFixture({
          id: "T2", description: "culminating implementation", agent: "code-implementer-agent", wave: 1,
          status: "pending", depends_on: [], spec_anchors: completionAnchors, spec_contributions: [],
          file_list: ["src/completion.ts"],
        }),
      ],
    };
    const registration: RegisteredWaveGateProgram = {
      schemaVersion: 1,
      kind: "wave-gate",
      input: { wave: 1 },
      taskIds: ["T1", "T2"],
      authorityDigest: "a".repeat(64),
    };
    const parsedGraph = parseTaskGraph(graph);
    expect(parsedGraph.ok).toBe(true);
    if (!parsedGraph.ok) return;
    const batch = waveRequests(created.value, registration, parsedGraph.value, 1);
    const specRequest = batch.requests.find(({ authority }) =>
      (authority as AgentRequestAuthority).role === "spec-check-invoker");
    expect(specRequest).toBeDefined();
    const authority = specRequest!.authority as AgentRequestAuthority;
    const context = handleWaveReviewContext(batch.packets, authority.contextDigest);
    expect(context.kind).toBe("loaded");
    if (context.kind !== "loaded" || context.value.subject.role !== "spec-check-invoker") return;
    const scope = context.value.specCheckScope;
    expect(scope).not.toBeNull();
    if (scope === null) return;
    expect(scope).toEqual([
      {
        id: "T1",
        description: "partial implementation",
        completionAnchors: [],
        contributions: ["FR-1"],
        declaredFiles: ["src/contribution.ts"],
      },
      {
        id: "T2",
        description: "culminating implementation",
        completionAnchors: ["FR-1"],
        contributions: [],
        declaredFiles: ["src/completion.ts"],
      },
    ]);

    completionAnchors.push("FR-MUTATED");
    contributions.push("FR-MUTATED");
    declaredFiles.push("src/mutated.ts");
    expect(scope[0]?.contributions).toEqual(["FR-1"]);
    expect(scope[0]?.declaredFiles).toEqual(["src/contribution.ts"]);
    expect(scope[1]?.completionAnchors).toEqual(["FR-1"]);
    expect(Object.isFrozen(scope)).toBe(true);
  });

  it("installs the exact pure preparation roster, contexts, epoch, and reviewer slots", async () => {
    const root = mkdtempSync(join(tmpdir(), "loom-wave-authority-install-"));
    cleanup.push(root);
    const runsRoot = join(root, "runs");
    mkdirSync(runsRoot);
    const created = createRunDirectory(runsRoot, "run.authority-install");
    if (!created.ok) throw new Error(created.error.message);
    const registration: RegisteredWaveGateProgram = {
      schemaVersion: 1,
      kind: "wave-gate",
      input: { wave: 1 },
      taskIds: ["T1"],
      authorityDigest: "a".repeat(64),
    };
    const parsed = parseTaskGraph({
      spec_trace_version: 2,
      current_phase: "execute",
      current_wave: 1,
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: "spec.md",
      plan_file: "plan.md",
      wave_gates: {},
      active_wave_gate: {
        schemaVersion: 1,
        kind: "active-wave-gate",
        runId: created.value.runId,
        wave: 1,
        authorityDigest: registration.authorityDigest,
        revision: 0,
        terminalOutcome: null,
      },
      tasks: [taskFixture({
        id: "T1",
        description: "review exact authority",
        agent: "code-implementer-agent",
        wave: 1,
        status: "implemented",
        depends_on: [],
        review_generation: 3,
        spec_anchors: ["FR-1"],
        spec_contributions: [],
        file_list: ["engine/src/core/wave-review-authority.ts"],
      })],
    });
    if (!parsed.ok) throw new Error(parsed.error);
    const statePath = join(root, "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify(parsed.value));
    const manager = new StateManager(statePath);

    const batch = waveRequests(created.value, registration, parsed.value, 1);
    const authorities = batch.requests.map(({ authority }) => authority as AgentRequestAuthority);
    expect(authorities.map(({ role }) => role)).toEqual([
      "spec-check-invoker",
      ...WAVE_REVIEW_AGENTS,
    ]);
    expect(authorities.map(({ modelProfile }) => modelProfile)).toEqual([
      "general-review",
      "general-review",
      "focused-review",
      "focused-review",
      "focused-review",
      "focused-review",
    ]);
    for (const authority of authorities) {
      const context = handleWaveReviewContext(batch.packets, authority.contextDigest);
      expect(context.kind).toBe("loaded");
      if (context.kind !== "loaded") continue;
      expect(context.value.runId).toBe(created.value.runId);
      expect(context.value.batchEpoch).toBe(batch.batchEpoch);
      expect(context.value.subject.role).toBe(authority.role);
      expect(context.value.taskRun?.taskId ?? null).toBe(
        authority.role === "spec-check-invoker" ? null : "T1",
      );
    }

    await installWaveReviewRuns(manager, registration, batch);

    const installed = manager.load();
    const specAuthority = authorities[0]!;
    expect(installed.wave_review_epoch).toEqual({
      runId: created.value.runId,
      wave: 1,
      batchEpoch: batch.batchEpoch,
      specCheckSlotAuthority: { slot_id: specAuthority.slotId, attempted: 1 },
    });
    const run = installed.tasks[0]!.review_run!;
    expect(run.generation).toBe(3);
    expect(run.expected_agents).toEqual(WAVE_REVIEW_AGENTS);
    expect(run.slot_authority).toEqual(WAVE_REVIEW_AGENTS.map((agent) => ({
      agent,
      slot_id: authorities.find(({ role }) => role === agent)!.slotId,
      attempted: 1,
    })));
    expect(run.packet_id).toBe(batch.taskRuns[0]!.packetId);
    expect(run.head_sha).toBe(batch.batchEpoch);
  });
});
