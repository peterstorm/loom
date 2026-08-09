import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { evaluateTaskProof } from "../src/core/proof-obligations";

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
    status: "pending",
    depends_on: [],
    review_status: "pending",
    file_list: ["pi/extension.ts"],
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

const completedWithoutTestsProof = {
  state: "satisfied",
  obligations: [{ kind: "task-completed" }],
  results: [{
    state: "satisfied",
    obligation: { kind: "task-completed" },
    evidence: { kind: "task-completed" },
  }],
  evidence: [{ kind: "task-completed" }],
};

const reviewResult = (
  task: string,
  claim: string,
  resultOverrides: Record<string, unknown> = {},
) => ({
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
      ...resultOverrides,
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

  it("fails review evidence when a located Pi finding is outside the packet scope", async () => {
    const pi = await extension();
    const context = {
      sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad40a" },
    };
    const result = reviewResult("Task: T1", "finding escaped the packet");
    const message = result.details.results[0]!.messages[0]!.content[0]!;
    message.text = message.text.replace('"file":"pi/extension.ts"', '"file":"README.md"');

    await pi.emit("tool_result", result, context);

    const taskState = JSON.parse(readFileSync(statePath, "utf-8")).tasks[0];
    expect(taskState.review_status).toBe("evidence_capture_failed");
    expect(taskState.findings).toBeUndefined();
    expect(taskState.critical_findings).toBeUndefined();
    expect(taskState.review_error).toContain("README.md");
  });

  it("keeps standalone spawn and completion isolated from an active task graph", async () => {
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad410";
    const context = { sessionManager: { getSessionId: () => session } };
    const toolCallId = "call-standalone-active-graph";
    const taskPrompt = "LOOM_REVIEW_CONTEXT: standalone\nReview the frozen scope";
    const before = readFileSync(statePath, "utf-8");

    const call = await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId,
      input: { agent: "code-reviewer", task: taskPrompt, agentScope: "user" },
    }, context);
    expect(call).toEqual([undefined]);
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    expect(() => readFileSync(join(subagentDir, `${session}.task_graph`), "utf-8")).toThrow();

    await pi.emit("tool_result", {
      ...reviewResult(taskPrompt, "must remain run-scoped"),
      toolCallId,
    }, context);
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    expect(() => readFileSync(join(subagentDir, `${session}.active`), "utf-8")).toThrow();
  });

  it("uses the reserved standalone classification when result-time task text loses the marker", async () => {
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad414";
    const context = { sessionManager: { getSessionId: () => session } };
    const toolCallId = "call-standalone-result-text-drift";
    const before = readFileSync(statePath, "utf-8");

    const call = await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId,
      input: {
        agent: "code-reviewer",
        task: "LOOM_REVIEW_CONTEXT: standalone\nReview the frozen scope",
        agentScope: "user",
      },
    }, context);
    expect(call).toEqual([undefined]);

    await pi.emit("tool_result", {
      ...reviewResult("Task: T1", "must remain standalone despite result drift"),
      toolCallId,
    }, context);

    expect(readFileSync(statePath, "utf-8")).toBe(before);
  });

  it("attributes review findings to the reserved task instead of substituted result text", async () => {
    const planPath = join(temp, "reserved-review-task-plan.md");
    writeFileSync(planPath, "# Plan\n");
    writeState({
      ...initialGraph(),
      phase_artifacts: { architecture: planPath },
      skipped_phases: ["plan-alignment"],
      plan_file: planPath,
      tasks: [
        initialGraph().tasks[0],
        { ...initialGraph().tasks[0], id: "T2", description: "other review task" },
      ],
    });
    const pi = await extension();
    const context = {
      cwd: ROOT,
      sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad415" },
    };
    const toolCallId = "call-reserved-review-task";
    const call = await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId,
      input: {
        agent: "code-reviewer",
        task: "Task ID: T1\nReview the implementation and emit Machine Summary findings.",
        agentScope: "user",
      },
    }, context);
    expect(call).toEqual([undefined]);

    await pi.emit("tool_result", {
      ...reviewResult("Prior output mentioned Task: T2", "bind this finding to T1"),
      toolCallId,
    }, context);

    const [t1, t2] = JSON.parse(readFileSync(statePath, "utf-8")).tasks;
    expect(t1.critical_findings).toEqual(["bind this finding to T1"]);
    expect(t2.critical_findings).toBeUndefined();
    expect(t2.review_status).toBe("pending");
  });

  it("does not register review or verifier prompts as implementation execution", async () => {
    const planPath = join(temp, "review-not-execution-plan.md");
    writeFileSync(planPath, "# Plan\n");
    writeState({
      ...initialGraph(),
      phase_artifacts: { architecture: planPath },
      plan_file: planPath,
      skipped_phases: ["plan-alignment"],
    });
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad413";
    const context = { sessionManager: { getSessionId: () => session } };
    const toolCallId = "call-review-not-execution";
    const prompt = "Task: T1\nReview the implementation and emit Machine Summary findings.";
    const call = await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId,
      input: { agent: "code-reviewer", task: prompt, agentScope: "user" },
    }, context);
    expect(call).toEqual([undefined]);
    const afterStart = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(afterStart.executing_tasks).toEqual([]);
    expect(afterStart.tasks[0].start_sha).toBeUndefined();

    await pi.emit("tool_result", {
      ...reviewResult(prompt, "review completed"),
      toolCallId,
    }, context);
    expect(() => readFileSync(join(subagentDir, `${session}.active`), "utf-8")).toThrow();
  });

  it("resolves a task graph path established after the Pi extension module was imported", async () => {
    const pi = await extension();
    const latePath = join(temp, "late-pi-task-graph.json");
    const previous = process.env.LOOM_STATE_PATH;
    writeFileSync(latePath, JSON.stringify(initialGraph(), null, 2));
    process.env.LOOM_STATE_PATH = latePath;
    try {
      const outputs = await pi.emit("before_agent_start", {
        prompt: "",
        systemPrompt: "",
      }, {
        sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad416" },
      });
      expect(outputs).toContainEqual(expect.objectContaining({
        message: expect.objectContaining({ customType: "loom-context" }),
      }));
    } finally {
      if (previous === undefined) delete process.env.LOOM_STATE_PATH;
      else process.env.LOOM_STATE_PATH = previous;
      rmSync(latePath, { force: true });
    }
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
        toolCallId: "call-valid-standalone-verifier",
        input: {
          agent: "review-verifier-agent",
          task: "LOOM_REVIEW_CONTEXT: standalone\nAdjudicate the supplied manifest",
          agentScope: "user",
        },
      }, context);

      expect(results).toEqual([undefined]);
      const roster = readFileSync(join(subagentDir, `${session}.active`), "utf-8")
        .split("\n").filter(Boolean);
      expect(roster).toHaveLength(1);
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
        toolCallId: "call-lifecycle-directory-failure",
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

  it("does not mutate task state when lifecycle reservation fails", async () => {
    const planPath = join(temp, "transactional-start-plan.md");
    writeFileSync(planPath, "# Plan\n");
    writeState({
      ...initialGraph(),
      phase_artifacts: { architecture: planPath },
      skipped_phases: ["plan-alignment"],
      plan_file: planPath,
      tasks: [{
        id: "T1", description: "implementation", agent: "code-implementer-agent",
        wave: 1, status: "pending", depends_on: [],
      }],
    });
    const before = readFileSync(statePath, "utf-8");
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad40e";
    const activePath = join(subagentDir, `${session}.active`);
    mkdirSync(activePath, { recursive: true });
    try {
      const results = await pi.emit("tool_call", {
        toolName: "subagent",
        toolCallId: "call-lifecycle-failure",
        input: {
          agent: "code-implementer-agent",
          task: "Task ID: T1\nUse the code-implementer skill. Implement the assigned plan, write tests, and run bun test.",
          agentScope: "user",
        },
      }, { sessionManager: { getSessionId: () => session } });

      expect(results).toContainEqual(expect.objectContaining({
        block: true,
        reason: expect.stringContaining("Cannot record Loom subagent lifecycle evidence"),
      }));
      expect(readFileSync(statePath, "utf-8")).toBe(before);
    } finally {
      rmSync(activePath, { recursive: true, force: true });
    }
  });

  it("injects and consumes a distinct write grant for every parallel implementation child", async () => {
    const planPath = join(temp, "parallel-write-grants-plan.md");
    writeFileSync(planPath, "# Plan\n");
    writeState({
      ...initialGraph(),
      phase_artifacts: { architecture: planPath },
      skipped_phases: ["plan-alignment"],
      plan_file: planPath,
      tasks: [
        { id: "T1", description: "one", agent: "code-implementer-agent", wave: 1, status: "pending", depends_on: [], file_list: ["pi/extension.ts"] },
        { id: "T2", description: "two", agent: "code-implementer-agent", wave: 1, status: "pending", depends_on: [], file_list: ["README.md"] },
      ],
    });
    const pi = await extension();
    const parentSession = "019fca39-f989-7510-8e62-50dadbcad420";
    const input = {
      agentScope: "user",
      tasks: [
        { agent: "code-implementer-agent", task: "Task ID: T1\nUse the code-implementer skill. Implement and test." },
        { agent: "code-implementer-agent", task: "Task ID: T2\nUse the code-implementer skill. Implement and test." },
      ],
    };
    const call = await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId: "call-parallel-write-grants",
      input,
    }, { cwd: ROOT, sessionManager: { getSessionId: () => parentSession } });
    expect(call).toEqual([undefined]);
    const prompts = input.tasks.map((item) => item.task);
    expect(prompts.every((prompt) => /LOOM_PI_WRITE_GRANT:[0-9a-f]{64}/.test(prompt))).toBe(true);
    expect(new Set(prompts.map((prompt) => prompt.match(/LOOM_PI_WRITE_GRANT:([0-9a-f]{64})/)?.[1])).size).toBe(2);

    const childSessions = [
      "019fca39-f989-7510-8e62-50dadbcad421",
      "019fca39-f989-7510-8e62-50dadbcad422",
    ];
    for (const [index, childSession] of childSessions.entries()) {
      await pi.emit("before_agent_start", {
        prompt: `Task: ${prompts[index]}`,
        systemPrompt: "<!-- LOOM_PI_AGENT_ID:code-implementer-agent -->",
      }, { cwd: ROOT, sessionManager: { getSessionId: () => childSession } });
      expect(readFileSync(join(subagentDir, `${childSession}.active`), "utf-8").trim())
        .toMatch(/^pi-grant-[0-9a-f]{16}$/);
      const edit = await pi.emit("tool_call", {
        toolName: "edit", input: { path: "README.md", edits: [] },
      }, { cwd: ROOT, sessionManager: { getSessionId: () => childSession } });
      expect(edit).toEqual([undefined]);
    }

    const replaySession = "019fca39-f989-7510-8e62-50dadbcad424";
    await pi.emit("before_agent_start", {
      prompt: `Task: ${prompts[0]}`,
      systemPrompt: "<!-- LOOM_PI_AGENT_ID:code-implementer-agent -->",
    }, {
      cwd: ROOT, sessionManager: { getSessionId: () => replaySession },
    });
    expect(() => readFileSync(join(subagentDir, `${replaySession}.active`), "utf-8")).toThrow();

    const ungranted = await pi.emit("tool_call", {
      toolName: "edit", input: { path: "README.md", edits: [] },
    }, { cwd: ROOT, sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad423" } });
    expect(ungranted).toContainEqual(expect.objectContaining({ block: true }));

    for (const childSession of childSessions) {
      await pi.emit("session_shutdown", {}, {
        cwd: ROOT, sessionManager: { getSessionId: () => childSession },
      });
      expect(() => readFileSync(join(subagentDir, `${childSession}.active`), "utf-8")).toThrow();
    }
  });

  it("gives repeated agent types distinct roster entries and removes each exact spawn", async () => {
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad40f";
    const context = { sessionManager: { getSessionId: () => session } };
    const backup = `${statePath}.same-type-backup`;
    renameSync(statePath, backup);
    const toolCallId = "call-same-type";
    const tasks = ["Judge manifest through lens one", "Judge manifest through lens two"];
    try {
      const call = await pi.emit("tool_call", {
        toolName: "subagent",
        toolCallId,
        input: {
          agentScope: "user",
          tasks: tasks.map((task) => ({ agent: "review-verifier-agent", task })),
        },
      }, context);
      expect(call).toEqual([undefined]);
      const activePath = join(subagentDir, `${session}.active`);
      const roster = readFileSync(activePath, "utf-8").split("\n").filter(Boolean);
      expect(roster).toHaveLength(2);
      expect(new Set(roster).size).toBe(2);

      await pi.emit("tool_result", {
        toolName: "subagent",
        toolCallId,
        content: [],
        details: {
          results: tasks.map((task) => ({
            agent: "review-verifier-agent", task, exitCode: 0, messages: [],
          })),
        },
      }, context);
      expect(() => readFileSync(activePath, "utf-8")).toThrow();
    } finally {
      rmSync(join(subagentDir, `${session}.active`), { force: true });
      renameSync(backup, statePath);
    }
  });

  it("cleans a chain roster slot even when Pi substitutes {previous} in result.task", async () => {
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad411";
    const context = { sessionManager: { getSessionId: () => session } };
    const backup = `${statePath}.chain-backup`;
    renameSync(statePath, backup);
    const toolCallId = "call-chain-previous";
    try {
      const call = await pi.emit("tool_call", {
        toolName: "subagent",
        toolCallId,
        input: {
          agentScope: "user",
          chain: [
            { agent: "review-verifier-agent", task: "Judge the manifest" },
            { agent: "review-verifier-agent", task: "Use {previous} and judge again" },
          ],
        },
      }, context);
      expect(call).toEqual([undefined]);
      const activePath = join(subagentDir, `${session}.active`);
      expect(readFileSync(activePath, "utf-8").split("\n").filter(Boolean)).toHaveLength(2);

      await pi.emit("tool_result", {
        toolName: "subagent",
        toolCallId,
        content: [],
        details: {
          results: [
            { agent: "review-verifier-agent", task: "Judge the manifest", exitCode: 0, messages: [] },
            { agent: "review-verifier-agent", task: "Use prior verifier output and judge again", exitCode: 0, messages: [] },
          ],
        },
      }, context);
      expect(() => readFileSync(activePath, "utf-8")).toThrow();
    } finally {
      rmSync(join(subagentDir, `${session}.active`), { force: true });
      renameSync(backup, statePath);
    }
  });

  it("rolls back roster and task-graph pointer when task validation blocks after reservation", async () => {
    writeState({
      ...initialGraph(),
      tasks: [
        { id: "T1", description: "wave one", agent: "code-implementer-agent", wave: 1, status: "pending", depends_on: [], file_list: ["pi/extension.ts"] },
        { id: "T2", description: "wave two", agent: "code-implementer-agent", wave: 2, status: "pending", depends_on: [], file_list: ["pi/extension.ts"] },
      ],
    });
    const before = readFileSync(statePath, "utf-8");
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad412";
    const result = await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId: "call-post-reservation-block",
      input: {
        agentScope: "user",
        tasks: [
          { agent: "code-implementer-agent", task: "Task ID: T1\nUse the code-implementer skill. Implement and test." },
          { agent: "code-implementer-agent", task: "Task ID: T2\nUse the code-implementer skill. Implement and test." },
        ],
      },
    }, { sessionManager: { getSessionId: () => session } });

    expect(result).toContainEqual(expect.objectContaining({ block: true }));
    expect(readFileSync(statePath, "utf-8")).toBe(before);
    expect(() => readFileSync(join(subagentDir, `${session}.active`), "utf-8")).toThrow();
    expect(() => readFileSync(join(subagentDir, `${session}.task_graph`), "utf-8")).toThrow();
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
    const { classifyTaskExecutionSpawn, validateTaskExecutionBatch } = await import("../src/core/validate-task-execution");

    const result = await validateTaskExecutionBatch([
      classifyTaskExecutionSpawn({ agentType: "code-implementer-agent", prompt: "Task ID: T1", description: "" }),
      classifyTaskExecutionSpawn({ agentType: "code-implementer-agent", prompt: "Task ID: T2", description: "" }),
    ]);

    expect(result.kind).toBe("block");
    expect(JSON.parse(readFileSync(statePath, "utf-8"))).toEqual(before);
  });

  it("blocks duplicate and overlapping parallel implementation ownership through the shared core", async () => {
    const planPath = join(temp, "ownership-plan.md");
    writeFileSync(planPath, "# Plan\n");
    const tasks = [
      { id: "T1", description: "one", agent: "code-implementer-agent", wave: 1, status: "pending", depends_on: [], file_list: ["pi/extension.ts"] },
      { id: "T2", description: "two", agent: "code-implementer-agent", wave: 1, status: "pending", depends_on: [], file_list: ["pi/extension.ts"] },
    ];
    const base = {
      ...initialGraph(),
      phase_artifacts: { architecture: planPath },
      skipped_phases: ["plan-alignment"],
      plan_file: planPath,
      tasks,
    };
    const pi = await extension();
    const context = {
      cwd: ROOT,
      sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad425" },
    };

    writeState({ ...base, executing_tasks: ["T1"] });
    let result = await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId: "call-duplicate-owner",
      input: {
        agent: "code-implementer-agent",
        task: "Task ID: T1\nUse the code-implementer skill. Implement and test.",
        agentScope: "user",
      },
    }, context);
    expect(result).toContainEqual(expect.objectContaining({
      block: true,
      reason: expect.stringContaining("already executing"),
    }));

    writeState({ ...base, executing_tasks: [] });
    result = await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId: "call-overlapping-owners",
      input: {
        agentScope: "user",
        tasks: tasks.map((task) => ({
          agent: "code-implementer-agent",
          task: `Task ID: ${task.id}\nUse the code-implementer skill. Implement and test.`,
        })),
      },
    }, context);
    expect(result).toContainEqual(expect.objectContaining({
      block: true,
      reason: expect.stringContaining("both declare pi/extension.ts"),
    }));
    expect(JSON.parse(readFileSync(statePath, "utf-8")).executing_tasks).toEqual([]);
  });

  it("releases reserved roster and execution state even when details.results is missing", async () => {
    const planPath = join(temp, "malformed-result-plan.md");
    writeFileSync(planPath, "# Plan\n");
    writeState({
      ...initialGraph(),
      phase_artifacts: { architecture: planPath },
      skipped_phases: ["plan-alignment"],
      plan_file: planPath,
      tasks: [{
        id: "T1", description: "implementation", agent: "code-implementer-agent",
        wave: 1, status: "pending", depends_on: [], file_list: ["pi/extension.ts"],
      }],
    });
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad42a";
    const toolCallId = "call-malformed-result-cleanup";
    const context = { cwd: ROOT, sessionManager: { getSessionId: () => session } };
    const call = await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId,
      input: {
        agent: "code-implementer-agent",
        task: "Task ID: T1\nUse the code-implementer skill. Implement and test.",
        agentScope: "user",
      },
    }, context);
    expect(call).toEqual([undefined]);
    expect(JSON.parse(readFileSync(statePath, "utf-8")).executing_tasks).toEqual(["T1"]);
    expect(readFileSync(join(subagentDir, `${session}.active`), "utf-8").trim()).not.toBe("");

    await pi.emit("tool_result", {
      toolName: "subagent", toolCallId, content: [], details: {},
    }, context);

    expect(JSON.parse(readFileSync(statePath, "utf-8")).executing_tasks).toEqual([]);
    expect(() => readFileSync(join(subagentDir, `${session}.active`), "utf-8")).toThrow();
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
    ["completed", [{
      id: "T1", description: "done", agent: "code-implementer-agent", wave: 1,
      status: "completed", depends_on: [], new_tests_required: false,
      proof: completedWithoutTestsProof,
    }], ["T1"]],
    ["trusted", [{
      id: "T1", description: "trusted", agent: "code-implementer-agent", wave: 1,
      status: "pending", depends_on: [], test_result: { verdict: "trusted-pass" },
      new_tests_required: false, artifact_baseline: [], attempt_artifact_baseline: [],
    }], ["T1"]],
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

  it("records failed review capture while continuing with a healthy sibling", async () => {
    const pi = await extension();
    const context = { sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad40a" } };
    const failed = reviewResult("Task: T1", "failed result must not gate", { exitCode: 1 }).details.results[0];
    const healthy = reviewResult("Task: T1", "healthy sibling stored").details.results[0];
    healthy.agent = "silent-failure-hunter";
    await pi.emit("tool_result", {
      toolName: "subagent",
      content: [],
      details: { results: [failed, healthy] },
    }, context);

    const taskState = JSON.parse(readFileSync(statePath, "utf-8")).tasks[0];
    expect(taskState.critical_findings).toEqual(["healthy sibling stored"]);
    expect(taskState.critical_findings).not.toContain("failed result must not gate");
    expect(taskState.review_status).toBe("evidence_capture_failed");
    expect(taskState.review_evidence_failures).toEqual(["code-reviewer"]);
    expect(taskState.review_error).toContain("failed before evidence capture completed");
  });

  it("does not advance a failed phase agent even when its messages contain a valid artifact", async () => {
    const planPath = join(temp, "failed-phase-plan.md");
    writeFileSync(planPath, "# Plan\n");
    writeState({ ...initialGraph(), current_phase: "architecture", phase_artifacts: {}, plan_file: null });
    const before = readFileSync(statePath, "utf-8");
    const pi = await extension();
    const context = { sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad40a" } };
    await pi.emit("tool_result", {
      toolName: "subagent",
      content: [],
      details: {
        results: [{
          agent: "architecture-agent",
          task: "finalize architecture",
          exitCode: 1,
          messages: [{
            role: "assistant",
            content: [{ type: "toolCall", name: "write", arguments: { path: planPath } }],
          }],
        }],
      },
    }, context);
    expect(readFileSync(statePath, "utf-8")).toBe(before);
  });

  it("replaces stale spec evidence after an abort and clears failed implementation execution", async () => {
    writeState({
      ...initialGraph(),
      executing_tasks: ["T1"],
      tasks: [{ ...initialGraph().tasks[0], status: "pending" }],
      spec_check: {
        wave: 1, run_at: "earlier", verdict: "PASSED", critical_count: 0, high_count: 0,
        critical_findings: [], high_findings: [], medium_findings: [],
      },
    });
    const pi = await extension();
    const context = { sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad40a" } };
    await pi.emit("tool_result", {
      toolName: "subagent",
      content: [],
      details: {
        results: [
          {
            agent: "code-implementer-agent",
            task: "Task ID: T1",
            exitCode: 1,
            messages: [{ role: "assistant", content: [{ type: "text", text: "tests passed" }] }],
          },
          {
            agent: "spec-check-invoker",
            task: "spec check",
            exitCode: 0,
            stopReason: "aborted",
            messages: [{ role: "assistant", content: [{ type: "text", text: "SPEC_CHECK_WAVE: 1\nSPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: PASSED" }] }],
          },
        ],
      },
    }, context);

    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.executing_tasks).toEqual([]);
    expect(state.tasks[0].status).toBe("pending");
    expect(state.spec_check).toMatchObject({
      wave: 1,
      verdict: "EVIDENCE_CAPTURE_FAILED",
      error: expect.stringContaining("spec-check-invoker failed before evidence capture completed"),
    });
  });

  it("invalidates stale implementation, review, spec, and wave evidence after failed changed bytes", async () => {
    const artifactRelative = `.tmp-pi-failed-attempt-${process.pid}.ts`;
    const artifactPath = join(ROOT, artifactRelative);
    const planPath = join(temp, "failed-changed-attempt-plan.md");
    writeFileSync(planPath, "# Plan\n");
    writeFileSync(artifactPath, "export const value = 1;\n");
    const greenProof = evaluateTaskProof(
      { newTestsRequired: false, declaredArtifacts: [artifactRelative] },
      { taskCompleted: true, filesModified: [artifactRelative] },
    );
    expect(greenProof.state).toBe("satisfied");
    writeState({
      ...initialGraph(),
      phase_artifacts: { architecture: planPath },
      skipped_phases: ["plan-alignment"],
      plan_file: planPath,
      executing_tasks: [],
      wave_gates: {
        "1": { impl_complete: true, tests_passed: true, reviews_complete: true, blocked: false },
      },
      spec_check: {
        wave: 1, run_at: "earlier", verdict: "PASSED", critical_count: 0, high_count: 0,
        critical_findings: [], high_findings: [], medium_findings: [],
      },
      tasks: [{
        ...initialGraph().tasks[0],
        status: "implemented",
        proof: greenProof,
        test_result: { verdict: "trusted-pass" },
        test_evidence: "trusted green run",
        new_tests_required: false,
        review_status: "passed",
        review_error: undefined,
        review_evidence_failures: undefined,
        file_list: [artifactRelative],
        files_modified: [artifactRelative],
      }],
    });
    const pi = await extension();
    const context = {
      cwd: ROOT,
      sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad42b" },
    };
    const toolCallId = "call-failed-changed-attempt";
    try {
      const call = await pi.emit("tool_call", {
        toolName: "subagent",
        toolCallId,
        input: {
          agent: "code-implementer-agent",
          task: "Task ID: T1\nUse the code-implementer skill. Implement and test.",
          agentScope: "user",
        },
      }, context);
      expect(call).toEqual([undefined]);
      writeFileSync(artifactPath, "export const value = 2;\n");

      await pi.emit("tool_result", {
        toolName: "subagent",
        toolCallId,
        content: [],
        details: {
          results: [{
            agent: "code-implementer-agent",
            task: "Task ID: T1",
            exitCode: 1,
            messages: [],
          }],
        },
      }, context);

      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(state.executing_tasks).toEqual([]);
      expect(state.tasks[0]).toMatchObject({
        status: "pending",
        review_status: "pending",
        review_generation: 1,
        test_result: { verdict: "untrusted", passed: false, label: "pi-implementation-failed" },
      });
      expect(state.tasks[0].review_error).toBeUndefined();
      expect(state.tasks[0].review_evidence_failures).toBeUndefined();
      expect(state.spec_check).toBeUndefined();
      expect(state.wave_gates["1"]).toMatchObject({
        impl_complete: false,
        tests_passed: null,
        reviews_complete: false,
      });
    } finally {
      rmSync(artifactPath, { force: true });
    }
  });

  it("guards Bash state writes when only the child session pointer binds a graph", async () => {
    const sessionId = "019fca39-f989-7510-8e62-50dadbcad42c";
    const pointer = join(subagentDir, `${sessionId}.task_graph`);
    rmSync(statePath, { force: true });
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(pointer, join(temp, "parent", ".pi", "state", "active_task_graph.json"));
    try {
      const pi = await extension();
      const results = await pi.emit("tool_call", {
        toolName: "bash",
        input: { command: "printf compromised > .claude/state/active_task_graph.json" },
      }, { sessionManager: { getSessionId: () => sessionId } });

      expect(results).toContainEqual(expect.objectContaining({
        block: true,
        reason: expect.stringContaining("loom-guarded state"),
      }));
    } finally {
      rmSync(pointer, { force: true });
      writeState(initialGraph());
    }
  });

  it("continues processing later Pi results when the first result throws", async () => {
    const pi = await extension();
    const context = { sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad40a" } };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const second = reviewResult("Task: T1", "second result still stored").details.results[0];
      await pi.emit("tool_result", {
        toolName: "subagent",
        content: [],
        details: {
          results: [
            { agent: null, task: "bad first result", exitCode: 0, messages: [] },
            second,
          ],
        },
      }, context);

      expect(stderr.mock.calls.map(([text]) => String(text)).join(""))
        .toContain("subagent-stop processing failed");
      expect(JSON.parse(readFileSync(statePath, "utf-8")).tasks[0].critical_findings)
        .toEqual(["second result still stored"]);
    } finally {
      stderr.mockRestore();
    }
  });

  it("marks a Pi spec-check count/findings mismatch as evidence capture failed", async () => {
    const pi = await extension();
    const context = { sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad40a" } };
    await pi.emit("tool_result", {
      toolName: "subagent",
      content: [],
      details: {
        results: [{
          agent: "spec-check-invoker",
          task: "spec check",
          exitCode: 0,
          messages: [{
            role: "assistant",
            content: [{
              type: "text",
              text: "SPEC_CHECK_WAVE: 1\nSPEC_CHECK_CRITICAL_COUNT: 0\nSPEC_CHECK_HIGH_COUNT: 0\nSPEC_CHECK_VERDICT: PASSED\nCRITICAL: hidden drift",
            }],
          }],
        }],
      },
    }, context);

    const specCheck = JSON.parse(readFileSync(statePath, "utf-8")).spec_check;
    expect(specCheck.verdict).toBe("EVIDENCE_CAPTURE_FAILED");
    expect(specCheck.error).toContain("does not match");
    expect(specCheck.critical_count).toBeUndefined();
  });

  it("warns when an implementation result has neither task id nor executing task", async () => {
    const pi = await extension();
    const context = { sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad40a" } };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await pi.emit("tool_result", {
        toolName: "subagent",
        content: [],
        details: {
          results: [{
            agent: "code-implementer-agent", task: "no task identifier", exitCode: 0, messages: [],
          }],
        },
      }, context);
      expect(stderr.mock.calls.map(([text]) => String(text)).join(""))
        .toContain("executing_tasks is empty — task status was NOT recorded");
    } finally {
      stderr.mockRestore();
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
