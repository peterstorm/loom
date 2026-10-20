/**
 * `validate-task-execution` refuses a Claude Code spawn that names a Loom
 * Agent other than `loom:<agent>` BEFORE anything reserves (#117). The harness
 * rejects such a name only after the PreToolUse gates admit it, and an
 * admitted implementation spawn has already reserved Task authority by then,
 * so the Task strands as executing with no agent until the reservation grace
 * period reclaims it. Pi's `subagent` tool resolves bare names and is untouched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createValidateTaskExecutionHandler } from "../../../src/handlers/pre-tool-use/validate-task-execution";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";

/** T1 is dispatchable in Wave 1, so an admitted spawn would reserve it. */
const TASK_GRAPH = JSON.stringify({
  current_phase: "execute",
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: null,
  current_wave: 1,
  executing_tasks: [],
  tasks: [{ id: "T1", description: "wave-1 task", agent: "code-implementer-agent", status: "pending", wave: 1, depends_on: [] }],
  wave_gates: {},
});

let root = "";
let statePath = "";
let previousStatePath: string | undefined;

beforeEach(() => {
  root = canonicalTempDir("loom-claude-agent-namespace-");
  statePath = join(root, "active_task_graph.json");
  writeFileSync(statePath, TASK_GRAPH);
  previousStatePath = process.env.LOOM_STATE_PATH;
  process.env.LOOM_STATE_PATH = statePath;
});

afterEach(() => {
  if (previousStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = previousStatePath;
  rmSync(root, { recursive: true, force: true });
});

// No sibling vetoes: the namespace refusal must precede them and the reservation alike.
const gate = createValidateTaskExecutionHandler([]);
const spawn = (tool: string, subagentType: string) =>
  gate(JSON.stringify({ tool_name: tool, tool_input: { subagent_type: subagentType, prompt: "Task ID: T1", description: "T1" } }), []);

describe("validate-task-execution Claude agent namespace", () => {
  it.each(["Task", "Agent"])("refuses a bare Loom Agent on %s before reserving anything", async (tool) => {
    const before = readFileSync(statePath);

    const result = await spawn(tool, "code-implementer-agent");

    expect(result.kind).toBe("block");
    if (result.kind === "block") expect(result.message).toContain('spawn subagent_type "loom:code-implementer-agent"');
    expect(readFileSync(statePath)).toEqual(before);
  });

  it("refuses a foreign namespace on a Claude spawn tool", async () => {
    const result = await spawn("Agent", "elsewhere:code-implementer-agent");
    expect(result.kind).toBe("block");
  });

  it("does not apply the Claude namespace rule to Pi's subagent tool", async () => {
    const result = await spawn("subagent", "code-implementer-agent");
    // The spawn proceeds to the gate's own rules (here: admitted and reserved), never the namespace refusal.
    if (result.kind === "block") expect(result.message).not.toContain("plugin namespace");
  });

  it("lets the plugin-namespaced name through to the reservation", async () => {
    const result = await spawn("Agent", "loom:code-implementer-agent");
    if (result.kind === "block") expect(result.message).not.toContain("plugin namespace");
    expect(result.kind).not.toBe("block");
  });
});
