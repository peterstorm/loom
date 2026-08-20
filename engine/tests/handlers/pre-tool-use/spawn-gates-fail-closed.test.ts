import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import validateTaskExecution from "../../../src/handlers/pre-tool-use/validate-task-execution";
import validatePhaseOrder from "../../../src/handlers/pre-tool-use/validate-phase-order";
import validateTemplateSubstitution from "../../../src/handlers/pre-tool-use/validate-template-substitution";
import validateAgentModel from "../../../src/handlers/pre-tool-use/validate-agent-model";
import validateAgentSkill from "../../../src/handlers/pre-tool-use/validate-agent-skill";
import { FAIL_CLOSED_ROUTES } from "../../../src/handler-routes";
import { TASK_GRAPH_PATH } from "../../../src/config";
import type { HookHandler } from "../../../src/types";

/**
 * Round-17/18: the Task-spawn gates must fail CLOSED on malformed hook input.
 * An uncaught JSON.parse crash exits 1 (NON-blocking for PreToolUse) and lets
 * a Task spawn skip wave-order / phase-order / template-substitution / model /
 * skill enforcement — the exact fail-open guard-state-file was hardened against
 * in round 11. The deeper corrupt-task-graph crash (mgr.load()) is covered by
 * these routes being in FAIL_CLOSED_ROUTES (cli.ts exits 2 on a top-level
 * crash for them), pinned in cli-fail-polarity.test.ts.
 */
describe("spawn-gate handlers — malformed stdin fails CLOSED", () => {
  // These parse stdin unconditionally (no task-graph precheck).
  const unconditional: ReadonlyArray<[string, HookHandler]> = [
    ["validate-task-execution", validateTaskExecution],
    ["validate-phase-order", validatePhaseOrder],
    ["validate-template-substitution", validateTemplateSubstitution],
  ];

  for (const [name, handler] of unconditional) {
    it(`${name}: unparseable stdin → block`, async () => {
      const result = await handler("{not json", []);
      expect(result.kind).toBe("block");
      if (result.kind === "block") {
        expect(result.message).toContain("malformed hook input");
      }
    });
  }

  it("validate-agent-model fails closed before task-graph creation", async () => {
    const result = await validateAgentModel("{not json", []);
    expect(result.kind).toBe("block");
    if (result.kind === "block") expect(result.message).toContain("malformed hook input");
  });

  it("validate-agent-model blocks unknown reserved names but allows external utilities", async () => {
    const unknown = await validateAgentModel(JSON.stringify({
      tool_name: "Agent",
      tool_input: { subagent_type: "loom:not-a-real-agent", model: "sonnet" },
    }), []);
    expect(unknown).toMatchObject({
      kind: "block",
      message: expect.stringContaining("no Loom model policy"),
    });

    const external = await validateAgentModel(JSON.stringify({
      tool_name: "Agent",
      tool_input: { subagent_type: "external-agent" },
    }), []);
    expect(external).toEqual({ kind: "allow" });
  });

  it("validate-agent-model rejects graphless Loom model inheritance", async () => {
    if (existsSync(TASK_GRAPH_PATH)) return;
    const priorHome = process.env.HOME;
    const home = join(tmpdir(), `graphless-model-policy-${process.pid}-${Date.now()}`);
    mkdirSync(join(home, ".claude", "agents"), { recursive: true });
    writeFileSync(
      join(home, ".claude", "agents", "code-reviewer.md"),
      "---\nname: code-reviewer\nmodel-profile: general-review\nmodel: sonnet\n---\n",
    );
    process.env.HOME = home;
    try {
      const result = await validateAgentModel(JSON.stringify({
        tool_name: "Agent",
        tool_input: { subagent_type: "loom:code-reviewer", prompt: "LOOM_REVIEW_CONTEXT: standalone" },
      }), []);
      expect(result.kind).toBe("block");
      if (result.kind === "block") expect(result.message).toContain("inheritance is forbidden");
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("validate-agent-model reports the concrete agent-definition read failure", async () => {
    const priorHome = process.env.HOME;
    const home = join(tmpdir(), `unreadable-model-policy-${process.pid}-${Date.now()}`);
    const definition = join(home, ".claude", "agents", "code-reviewer.md");
    mkdirSync(definition, { recursive: true });
    process.env.HOME = home;
    try {
      const result = await validateAgentModel(JSON.stringify({
        tool_name: "Agent",
        tool_input: { subagent_type: "code-reviewer", model: "sonnet" },
      }), []);
      expect(result.kind).toBe("block");
      if (result.kind === "block") {
        expect(result.message).toContain(`cannot read Claude Code agent definition 'code-reviewer' (${definition})`);
        expect(result.message).toMatch(/EISDIR|illegal operation on a directory/i);
      }
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("validate-agent-model distinguishes an unreadable Pi definition from absence", async () => {
    const priorDir = process.env.PI_CODING_AGENT_DIR;
    const piDir = join(tmpdir(), `unreadable-pi-model-policy-${process.pid}-${Date.now()}`);
    const definition = join(piDir, "agents", "code-reviewer.md");
    mkdirSync(join(piDir, "agents"), { recursive: true });
    symlinkSync("code-reviewer.md", definition);
    process.env.PI_CODING_AGENT_DIR = piDir;
    try {
      const result = await validateAgentModel(JSON.stringify({
        tool_name: "subagent",
        tool_input: { agent: "code-reviewer", agentScope: "user" },
      }), []);
      expect(result.kind).toBe("block");
      if (result.kind === "block") {
        expect(result.message).toContain(`Pi agent policy failed for 'code-reviewer' (${definition})`);
        expect(result.message).toMatch(/ELOOP|too many levels of symbolic links/i);
        expect(result.message).not.toContain("has no generated definition");
      }
    } finally {
      if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = priorDir;
      rmSync(piDir, { recursive: true, force: true });
    }
  });

  // Skill policy remains orchestration-gated; model policy above protects
  // pre-graph panel and standalone Loom spawns too.
  const orchestrationGated: ReadonlyArray<[string, HookHandler]> = [
    ["validate-agent-skill", validateAgentSkill],
  ];

  for (const [name, handler] of orchestrationGated) {
    it(`${name}: unparseable stdin with a task graph present → block`, async () => {
      const created = !existsSync(TASK_GRAPH_PATH);
      if (created) {
        mkdirSync(dirname(TASK_GRAPH_PATH), { recursive: true });
        writeFileSync(TASK_GRAPH_PATH, "{}");
      }
      try {
        const result = await handler("{not json", []);
        expect(result.kind).toBe("block");
        if (result.kind === "block") {
          expect(result.message).toContain("malformed hook input");
        }
      } finally {
        if (created) rmSync(TASK_GRAPH_PATH, { force: true });
      }
    });

    it(`${name}: unparseable stdin with NO task graph → allow (not orchestrating)`, async () => {
      if (existsSync(TASK_GRAPH_PATH)) return; // can't assert the no-graph path
      const result = await handler("{not json", []);
      expect(result.kind).toBe("allow");
    });
  }

  it("all five spawn gates are registered as fail-closed routes", () => {
    expect(FAIL_CLOSED_ROUTES.has("pre-tool-use/validate-task-execution")).toBe(true);
    expect(FAIL_CLOSED_ROUTES.has("pre-tool-use/validate-phase-order")).toBe(true);
    expect(FAIL_CLOSED_ROUTES.has("pre-tool-use/validate-template-substitution")).toBe(true);
    expect(FAIL_CLOSED_ROUTES.has("pre-tool-use/validate-agent-model")).toBe(true);
    expect(FAIL_CLOSED_ROUTES.has("pre-tool-use/validate-agent-skill")).toBe(true);
  });
});
