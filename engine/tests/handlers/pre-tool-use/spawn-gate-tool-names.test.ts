/**
 * Every spawn gate must fire under EVERY name a harness gives the
 * subagent-spawning tool.
 *
 * Claude Code renamed that tool from `Task` to `Agent`; the handlers still
 * early-returned `allow` on anything but `Task`, so phase order, wave order,
 * template substitution, agent model, and agent skill all stopped enforcing —
 * with no error, no warning, and a plugin that looked healthy. The gate that
 * silently stops gating is the one nobody notices, so it gets a test that
 * names each tool explicitly rather than trusting the shared constant to be
 * read correctly at five call sites.
 *
 * Each case drives the handler to a BLOCK. A block proves the handler ran the
 * rule; `allow` is the shape a dead gate and a passing spawn share, so it
 * proves nothing.
 *
 * tests/machine/hooks-sync.test.ts pins the other half — that hooks.json's
 * matcher names exactly these tools, so the hook fires in the first place.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import validatePhaseOrder from "../../../src/handlers/pre-tool-use/validate-phase-order";
import validateTaskExecution from "../../../src/handlers/pre-tool-use/validate-task-execution";
import validateTemplateSubstitution from "../../../src/handlers/pre-tool-use/validate-template-substitution";
import validateAgentModel from "../../../src/handlers/pre-tool-use/validate-agent-model";
import validateAgentSkill from "../../../src/handlers/pre-tool-use/validate-agent-skill";
import { SUBAGENT_SPAWN_TOOLS } from "../../../src/core/tool-vocabulary";
import { TASK_GRAPH_PATH } from "../../../src/config";
import type { HookHandler } from "../../../src/types";

const REPO_ROOT = resolve(__dirname, "../../../..");

/** A graph that puts T9 a wave ahead of the current one — a clean wave-order block. */
const TASK_GRAPH = JSON.stringify({
  current_phase: "execute",
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: null,
  current_wave: 1,
  executing_tasks: [],
  tasks: [
    { id: "T9", description: "a wave-2 task", agent: "code-implementer-agent", status: "pending", wave: 2, depends_on: [] },
  ],
  wave_gates: {},
});

/** One spawn payload per gate, each chosen so a LIVE gate must block it. */
const GATES: ReadonlyArray<{
  readonly name: string;
  readonly handler: HookHandler;
  readonly toolInput: Record<string, unknown>;
  readonly expect: string;
}> = [
  {
    name: "validate-phase-order",
    handler: validatePhaseOrder,
    toolInput: { subagent_type: "rogue-agent", prompt: "Run tests" },
    expect: "Unrecognized agent type",
  },
  {
    name: "validate-task-execution",
    handler: validateTaskExecution,
    toolInput: { prompt: "Task ID: T9", description: "wave-2 task" },
    expect: "current wave is 1",
  },
  {
    name: "validate-template-substitution",
    handler: validateTemplateSubstitution,
    toolInput: { prompt: "Implement the feature at {spec_file_path}" },
    expect: "unsubstituted template variables",
  },
  {
    name: "validate-agent-model",
    handler: validateAgentModel,
    toolInput: { subagent_type: "loom:code-implementer-agent", prompt: "Implement T9" },
    expect: "missing `model` parameter",
  },
  {
    name: "validate-agent-skill",
    handler: validateAgentSkill,
    toolInput: { subagent_type: "loom:arch-designer-agent", prompt: "Design one panel candidate." },
    expect: "architecture-tech-lead",
  },
];

describe("spawn gates honour every SUBAGENT_SPAWN_TOOLS name", () => {
  let createdGraph = false;
  let previousRoot: string | undefined;
  let previousHome: string | undefined;
  let fakeHome = "";

  beforeAll(() => {
    previousRoot = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = REPO_ROOT;

    // validate-agent-model resolves agent files through $HOME/.claude/agents
    // (it does not consult CLAUDE_PLUGIN_ROOT the way validate-agent-skill
    // does), so give it one to find. Without a resolvable agent file that gate
    // allows everything and would pass this test for the wrong reason.
    previousHome = process.env.HOME;
    fakeHome = join(tmpdir(), `spawn-gate-home-${process.pid}-${Date.now()}`);
    mkdirSync(join(fakeHome, ".claude/agents"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".claude/agents", "code-implementer-agent.md"),
      "---\nname: code-implementer-agent\nmodel: sonnet\n---\n",
    );
    process.env.HOME = fakeHome;

    createdGraph = !existsSync(TASK_GRAPH_PATH);
    if (createdGraph) {
      mkdirSync(dirname(TASK_GRAPH_PATH), { recursive: true });
      writeFileSync(TASK_GRAPH_PATH, TASK_GRAPH);
    }
  });

  afterAll(() => {
    if (previousRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = previousRoot;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(fakeHome, { recursive: true, force: true });
    if (createdGraph) rmSync(TASK_GRAPH_PATH, { force: true });
  });

  for (const gate of GATES) {
    for (const tool of SUBAGENT_SPAWN_TOOLS) {
      it(`${gate.name} blocks a "${tool}" spawn`, async () => {
        if (!createdGraph) return; // a real orchestration is in flight; do not read its graph
        const result = await gate.handler(
          JSON.stringify({ tool_name: tool, tool_input: gate.toolInput }),
          [],
        );
        expect(result.kind, `${gate.name} did not gate tool_name "${tool}"`).toBe("block");
        if (result.kind === "block") expect(result.message).toContain(gate.expect);
      });
    }

    it(`${gate.name} ignores a tool that spawns nothing`, async () => {
      if (!createdGraph) return;
      const result = await gate.handler(
        JSON.stringify({ tool_name: "Read", tool_input: gate.toolInput }),
        [],
      );
      expect(result.kind, `${gate.name} gated a non-spawn tool`).toBe("allow");
    });
  }
});
