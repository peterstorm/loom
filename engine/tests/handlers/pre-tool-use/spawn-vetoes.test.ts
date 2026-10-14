/**
 * The reservation-taking spawn gate runs every read-only sibling veto first,
 * so a vetoed spawn can no longer strand an execution reservation for the
 * reclamation grace (the G1 live pilot lost ten minutes to one).
 */
import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookHandler, HookResult } from "../../../src/types";
import { firstSpawnVeto, SPAWN_VETOES } from "../../../src/handlers/pre-tool-use/spawn-vetoes";
import { createValidateTaskExecutionHandler } from "../../../src/handlers/pre-tool-use/validate-task-execution";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { taskFixture } from "../../fixtures/task-lifecycle";
import type { TaskGraph } from "../../../src/types";

const returning = (result: HookResult, calls: string[], name: string) => ({
  name,
  handler: (async () => { calls.push(name); return result; }) as HookHandler,
});

describe("firstSpawnVeto", () => {
  it("runs the sibling gates in order: phase order, template, model, skill", () => {
    expect(SPAWN_VETOES.map(({ name }) => name)).toEqual([
      "validate-phase-order", "validate-template-substitution", "validate-agent-model", "validate-agent-skill",
    ]);
  });

  it("admits a spawn every veto allows or passes through, running each once", async () => {
    const calls: string[] = [];
    const vetoes = [
      returning({ kind: "allow" }, calls, "a"),
      returning({ kind: "passthrough", systemMessage: "note" }, calls, "b"),
    ];
    expect(await firstSpawnVeto("{}", vetoes)).toBeNull();
    expect(calls).toEqual(["a", "b"]);
  });

  it("returns the first block or error and runs nothing after it", async () => {
    for (const refusal of [{ kind: "block", message: "no skill" }, { kind: "error", message: "unreadable" }] as const) {
      const calls: string[] = [];
      const vetoes = [
        returning({ kind: "allow" }, calls, "a"),
        returning(refusal, calls, "b"),
        returning({ kind: "block", message: "later" }, calls, "c"),
      ];
      expect(await firstSpawnVeto("{}", vetoes)).toEqual(refusal);
      expect(calls).toEqual(["a", "b"]);
    }
  });
});

describe("validate-task-execution — no reservation behind a veto", () => {
  const roots: string[] = [];
  const previous = process.env.LOOM_STATE_PATH;
  afterEach(() => {
    if (previous === undefined) delete process.env.LOOM_STATE_PATH;
    else process.env.LOOM_STATE_PATH = previous;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function stateFile(): string {
    const root = canonicalTempDir("loom-spawn-veto-");
    roots.push(root);
    const statePath = join(root, "active_task_graph.json");
    const graph: TaskGraph = {
      current_phase: "execute", phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: null,
      tasks: [taskFixture({ id: "T1", description: "task T1", agent: "code-implementer-agent", wave: 1, status: "pending", depends_on: [] })],
      wave_gates: { "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false } },
      current_wave: 1, executing_tasks: [],
    };
    writeFileSync(statePath, JSON.stringify(graph));
    process.env.LOOM_STATE_PATH = statePath;
    return statePath;
  }

  const spawn = JSON.stringify({
    tool_name: "Agent",
    tool_input: { subagent_type: "loom:code-implementer-agent", prompt: "**Task ID:** T1", description: "T1" },
  });

  it("returns the veto and leaves the State File byte-identical", async () => {
    const statePath = stateFile();
    const before = readFileSync(statePath);
    const veto: HookResult = { kind: "block", message: "BLOCKED: Prompt doesn't reference required skill(s)." };
    const handler = createValidateTaskExecutionHandler([{ name: "validate-agent-skill", handler: async () => veto }]);
    expect(await handler(spawn, [])).toEqual(veto);
    expect(readFileSync(statePath).equals(before)).toBe(true);
  });

  it("reaches task-execution validation when every veto admits the spawn", async () => {
    stateFile();
    const handler = createValidateTaskExecutionHandler([{ name: "admit", handler: async () => ({ kind: "allow" }) }]);
    const unbound = JSON.stringify({
      tool_name: "Agent",
      tool_input: { subagent_type: "loom:code-implementer-agent", prompt: "implement this without a binding", description: "" },
    });
    expect(await handler(unbound, [])).toMatchObject({ kind: "block", message: expect.stringContaining("no extractable Task ID") });
  });
});
