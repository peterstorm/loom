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
import { mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SUBAGENT_SPAWN_TOOLS } from "../../../src/core/tool-vocabulary";
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

const lazyHandler = (
  load: () => Promise<Readonly<{ default: HookHandler }>>,
): HookHandler => async (stdin, args) => (await load()).default(stdin, args);

/** One spawn payload per gate, each chosen so a LIVE gate must block it. */
const GATES: ReadonlyArray<{
  readonly name: string;
  readonly handler: HookHandler;
  readonly toolInput: Record<string, unknown>;
  readonly expect: string;
  /** Optional per-spawn-tool expectation override (pi vs claude-code branches). */
  readonly expectByTool?: Readonly<Record<string, string>>;
}> = [
  {
    name: "validate-phase-order",
    handler: lazyHandler(() => import("../../../src/handlers/pre-tool-use/validate-phase-order")),
    toolInput: { subagent_type: "rogue-agent", prompt: "Run tests" },
    expect: "Unrecognized agent type",
  },
  {
    name: "validate-task-execution",
    handler: lazyHandler(() => import("../../../src/handlers/pre-tool-use/validate-task-execution")),
    toolInput: { subagent_type: "code-implementer-agent", prompt: "Task ID: T9", description: "wave-2 task" },
    expect: "current wave is 1",
  },
  {
    name: "validate-template-substitution",
    handler: lazyHandler(() => import("../../../src/handlers/pre-tool-use/validate-template-substitution")),
    toolInput: { prompt: "Implement the feature at {spec_file_path}" },
    expect: "unsubstituted template variables",
  },
  {
    name: "validate-agent-model",
    handler: lazyHandler(() => import("../../../src/handlers/pre-tool-use/validate-agent-model")),
    toolInput: { subagent_type: "loom:code-implementer-agent", prompt: "Implement T9" },
    expect: "model routing cannot prove a binding",
    // The pi path (subagent) and the claude-code path (Task/Agent) report
    // different contract violations for the same missing definition.
    expectByTool: {
      Task: "parent-model inheritance is forbidden",
      Agent: "parent-model inheritance is forbidden",
    },
  },
  {
    name: "validate-agent-skill",
    handler: lazyHandler(() => import("../../../src/handlers/pre-tool-use/validate-agent-skill")),
    toolInput: { subagent_type: "loom:arch-designer-agent", prompt: "Design one panel candidate." },
    expect: "architecture-tech-lead",
  },
];

describe("spawn gates honour every SUBAGENT_SPAWN_TOOLS name", () => {
  let previousRoot: string | undefined;
  let previousHome: string | undefined;
  let previousPiDir: string | undefined;
  let previousStatePath: string | undefined;
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
    mkdirSync(fakeHome, { recursive: true });
    // macOS tmpdir() sits behind the system /var → /private/var symlink; the
    // gates open the state dir through the anchored primitives, so the fixture
    // root must be canonical, mirroring production's base resolution.
    fakeHome = realpathSync.native(fakeHome);
    mkdirSync(join(fakeHome, ".claude/agents"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".claude/agents", "code-implementer-agent.md"),
      "---\nname: code-implementer-agent\nmodel-profile: implementation\nmodel: opus\n---\n",
    );
    process.env.HOME = fakeHome;

    // The same gate's PI branch (tool_name "subagent") resolves agent files
    // through PI_CODING_AGENT_DIR before falling back to $HOME/.pi/agent
    // (validate-agent-model's piAgentPath). An ambient pi agent session
    // inherits a real PI_CODING_AGENT_DIR with a real synced render, which
    // flips the subagent case to a different (also blocking) contract
    // message and fails the assertion. Pin the variable to the empty fake
    // agent dir so piAgentPath deterministically finds no render, exactly as
    // the HOME fake arranges for the claude-code branch.
    previousPiDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(fakeHome, ".pi", "agent");
    mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

    // Resolve every lazily loaded gate against this isolated graph. This keeps
    // the matrix live even inside an active Loom/Pi session without reading or
    // replacing that session's protected graph.
    previousStatePath = process.env.LOOM_STATE_PATH;
    process.env.LOOM_STATE_PATH = join(fakeHome, "active_task_graph.json");
    writeFileSync(process.env.LOOM_STATE_PATH, TASK_GRAPH);
  });

  afterAll(() => {
    if (previousRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = previousRoot;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousPiDir;
    if (previousStatePath === undefined) delete process.env.LOOM_STATE_PATH;
    else process.env.LOOM_STATE_PATH = previousStatePath;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  for (const gate of GATES) {
    for (const tool of SUBAGENT_SPAWN_TOOLS) {
      it(`${gate.name} blocks a "${tool}" spawn`, async () => {
        const result = await gate.handler(
          JSON.stringify({ tool_name: tool, tool_input: gate.toolInput }),
          [],
        );
        expect(result.kind, `${gate.name} did not gate tool_name "${tool}"`).toBe("block");
        const expected = gate.expectByTool?.[tool] ?? gate.expect;
        if (result.kind === "block") expect(result.message).toContain(expected);
      });
    }

    it(`${gate.name} ignores a tool that spawns nothing`, async () => {
      const result = await gate.handler(
        JSON.stringify({ tool_name: "Read", tool_input: gate.toolInput }),
        [],
      );
      expect(result.kind, `${gate.name} gated a non-spawn tool`).toBe("allow");
    });
  }
});
