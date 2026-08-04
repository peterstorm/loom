import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

type Handler = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown;

class FakePi {
  readonly handlers = new Map<string, Handler[]>();

  on(event: string, handler: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  registerCommand(): void {}

  async emit(event: string, payload: Record<string, unknown>, context: Record<string, unknown>): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.handlers.get(event) ?? []) results.push(await handler(payload, context));
    return results;
  }
}

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "loom-pi-review-events-"));
const statePath = join(temp, "active_task_graph.json");
const subagentDir = join(temp, "subagents");
const piAgentDir = join(temp, "pi-agent");
const previousStatePath = process.env.LOOM_STATE_PATH;
const previousPiDir = process.env.PI_CODING_AGENT_DIR;
const previousSubagentDir = process.env.LOOM_SUBAGENT_DIR;
process.env.LOOM_STATE_PATH = statePath;
process.env.PI_CODING_AGENT_DIR = piAgentDir;
process.env.LOOM_SUBAGENT_DIR = subagentDir;
execFileSync("bash", [join(ROOT, "scripts/sync-pi-agents.sh")], {
  cwd: ROOT,
  env: { ...process.env, PI_CODING_AGENT_DIR: piAgentDir },
});

const initialGraph = () => ({
  current_phase: "execute",
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: null,
  current_wave: 1,
  executing_tasks: [],
  wave_gates: {},
  tasks: [{
    id: "T1",
    description: "capture Pi review",
    agent: "code-implementer-agent",
    wave: 1,
    status: "implemented",
    depends_on: [],
    review_status: "pending",
  }],
});

function writeState(state: unknown): void {
  try { chmodSync(statePath, 0o644); } catch { /* first write */ }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

mkdirSync(dirname(statePath), { recursive: true });
writeState(initialGraph());
beforeEach(() => writeState(initialGraph()));

afterAll(() => {
  if (previousStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = previousStatePath;
  if (previousPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousPiDir;
  if (previousSubagentDir === undefined) delete process.env.LOOM_SUBAGENT_DIR;
  else process.env.LOOM_SUBAGENT_DIR = previousSubagentDir;
  rmSync(temp, { recursive: true, force: true });
});

const reviewResult = (task: string, claim: string) => ({
  toolName: "subagent",
  isError: false,
  input: {},
  content: [],
  details: {
    results: [{
      agent: "code-reviewer",
      task,
      exitCode: 0,
      messages: [{
        role: "assistant",
        content: [{
          type: "text",
          text: [
            "### Machine Summary",
            "CRITICAL_COUNT: 1",
            "ADVISORY_COUNT: 0",
            `CRITICAL: ${claim}`,
            "```findings",
            JSON.stringify([{ severity: "critical", file: "pi/extension.ts", line: 367, claim }]),
            "```",
          ].join("\n"),
        }],
      }],
    }],
  },
});

describe("Pi extension review tool_result integration", () => {
  const extension = async () => {
    const extensionSpecifier = "../../pi/extension.ts";
    const module = await import(/* @vite-ignore */ extensionSpecifier) as {
      default: (pi: unknown) => void;
    };
    const pi = new FakePi();
    module.default(pi as never);
    return pi;
  };

  it("stores wave findings, leaves standalone review state untouched, and enforces Pi agent scope", async () => {
    // A runtime-resolved ESM import avoids Vitest-only module APIs and keeps
    // this real extension boundary executable under both Vitest and Bun.
    const pi = await extension();
    expect(pi.handlers.get("tool_result")).toHaveLength(2);

    const context = {
      sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad40a" },
    };
    const scopeResults = await pi.emit("tool_call", {
      toolName: "subagent",
      input: {
        agent: "code-reviewer",
        task: "LOOM_REVIEW_CONTEXT: standalone\nReview the diff",
        agentScope: "both",
      },
    }, context);
    expect(scopeResults).toContainEqual(expect.objectContaining({
      block: true,
      reason: expect.stringContaining("agentScope='user'"),
    }));

    await pi.emit("tool_result", reviewResult("Task: T1", "Pi event shape drops findings"), context);

    const captured = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(captured.tasks[0]).toMatchObject({
      review_status: "blocked",
      critical_findings: ["Pi event shape drops findings"],
      advisory_findings: [],
    });
    expect(captured.tasks[0].findings).toEqual([{
      id: "code-reviewer-1",
      agent: "code-reviewer",
      severity: "critical",
      file: "pi/extension.ts",
      line: 367,
      claim: "Pi event shape drops findings",
    }]);

    await pi.emit(
      "tool_result",
      reviewResult("LOOM_REVIEW_CONTEXT: standalone\nTask: T1", "must not reach task state"),
      context,
    );
    expect(JSON.parse(readFileSync(statePath, "utf-8"))).toEqual(captured);
  });

  it("allows a valid user-scoped Loom spawn and records lifecycle evidence", async () => {
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad40b";
    const context = { sessionManager: { getSessionId: () => session } };
    const backup = `${statePath}.valid-spawn-backup`;
    renameSync(statePath, backup);
    try {
      const results = await pi.emit("tool_call", {
        toolName: "subagent",
        input: {
          agent: "review-verifier-agent",
          task: "LOOM_REVIEW_CONTEXT: standalone\nAdjudicate the supplied manifest",
          agentScope: "user",
        },
      }, context);

      expect(results).toEqual([undefined]);
      expect(readFileSync(join(subagentDir, `${session}.active`), "utf-8"))
        .toContain("review-verifier-agent");
    } finally {
      rmSync(join(subagentDir, `${session}.active`), { force: true });
      renameSync(backup, statePath);
    }
  });

  it("blocks a Loom spawn when lifecycle evidence cannot be recorded", async () => {
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad40c";
    const context = { sessionManager: { getSessionId: () => session } };
    const stateBackup = `${statePath}.tracking-failure-backup`;
    renameSync(statePath, stateBackup);
    rmSync(subagentDir, { recursive: true, force: true });
    writeFileSync(subagentDir, "not a directory");
    try {
      const results = await pi.emit("tool_call", {
        toolName: "subagent",
        input: {
          agent: "review-verifier-agent",
          task: "LOOM_REVIEW_CONTEXT: standalone\nAdjudicate the supplied manifest",
          agentScope: "user",
        },
      }, context);

      expect(results).toContainEqual(expect.objectContaining({
        block: true,
        reason: expect.stringContaining("Cannot record Loom subagent lifecycle evidence"),
      }));
    } finally {
      rmSync(subagentDir, { force: true });
      mkdirSync(subagentDir, { recursive: true });
      renameSync(stateBackup, statePath);
    }
  });

  it("validates a task batch completely before one atomic registration", async () => {
    const graph = {
      ...initialGraph(),
      tasks: [
        { id: "T1", description: "valid", agent: "code-implementer-agent", wave: 1, status: "pending", depends_on: [] },
        { id: "T2", description: "later wave", agent: "code-implementer-agent", wave: 2, status: "pending", depends_on: [] },
      ],
    };
    writeState(graph);
    const before = JSON.parse(readFileSync(statePath, "utf-8"));
    const { validateTaskExecutionBatch } = await import("../src/core/validate-task-execution");

    const result = await validateTaskExecutionBatch([
      { prompt: "Task ID: T1", description: "" },
      { prompt: "Task ID: T2", description: "" },
    ]);

    expect(result.kind).toBe("block");
    expect(JSON.parse(readFileSync(statePath, "utf-8"))).toEqual(before);
  });

  it("reports missing result evidence instead of treating it as an empty success", async () => {
    const pi = await extension();
    const context = { sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad40a" } };
    const before = readFileSync(statePath, "utf-8");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await pi.emit("tool_result", { toolName: "subagent", content: [] }, context);
      await pi.emit("tool_result", { toolName: "subagent", content: [], details: {} }, context);
      await pi.emit("tool_result", { toolName: "subagent", content: [], details: { results: "bad" } }, context);
      const output = stderr.mock.calls.map(([text]) => String(text)).join("");
      expect(output).toContain("missing details.results");
      expect(output).toContain("unrecognized details.results shape");
      expect(readFileSync(statePath, "utf-8")).toBe(before);
    } finally {
      stderr.mockRestore();
    }
  });

  it.each([
    ["missing", [], ["T1"]],
    ["completed", [{ id: "T1", description: "done", agent: "code-implementer-agent", wave: 1, status: "completed", depends_on: [] }], ["T1"]],
    ["trusted", [{ id: "T1", description: "trusted", agent: "code-implementer-agent", wave: 1, status: "pending", depends_on: [], test_result: { verdict: "trusted-pass" } }], ["T1"]],
  ])("clears executing_tasks for a stopped %s task without overwriting state", async (_label, tasks, executing) => {
    writeState({ ...initialGraph(), tasks, executing_tasks: executing });
    const pi = await extension();
    const context = { sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad40a" } };
    await pi.emit("tool_result", {
      toolName: "subagent",
      content: [],
      details: { results: [{ agent: "code-implementer-agent", task: "Task ID: T1", exitCode: 0, messages: [] }] },
    }, context);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.executing_tasks).toEqual([]);
    if (_label === "trusted") expect(state.tasks[0].test_result).toEqual({ verdict: "trusted-pass" });
    if (_label === "completed") expect(state.tasks[0].status).toBe("completed");
  });

  it("reports a Loom completion that cannot resolve orchestration state", async () => {
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad40d";
    const context = { sessionManager: { getSessionId: () => session } };
    const backup = `${statePath}.graphless-completion-backup`;
    renameSync(statePath, backup);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await pi.emit("tool_result", {
        toolName: "subagent",
        content: [],
        details: {
          results: [{
            agent: "code-implementer-agent", task: "Task ID: T1", exitCode: 0, messages: [],
          }],
        },
      }, context);

      expect(stderr.mock.calls.map(([text]) => String(text)).join(""))
        .toContain(`${JSON.stringify(session)}; code-implementer-agent completion was NOT applied`);
    } finally {
      stderr.mockRestore();
      renameSync(backup, statePath);
    }
  });

  it("passes external Pi agents through outside Loom orchestration and blocks them during it", async () => {
    const pi = await extension();
    const context = { sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad40a" } };
    const event = { toolName: "subagent", input: { agent: "external-agent", task: "outside workflow" } };
    const active = await pi.emit("tool_call", event, context);
    expect(active).toContainEqual(expect.objectContaining({ block: true }));

    const backup = `${statePath}.backup`;
    renameSync(statePath, backup);
    try {
      const inactive = await pi.emit("tool_call", event, context);
      expect(inactive).toEqual([undefined]);
    } finally {
      renameSync(backup, statePath);
    }
  });
});
