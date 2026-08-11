import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { evaluateTaskProof } from "../src/core/proof-obligations";
import type { AgentRequestAuthority } from "../src/core/orchestration-contract";
import { openRunDirectory, type RunDirHandle } from "../src/orchestration/run-directory-handle";

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
const previousOrchestrationRunsRoot = process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
const previousOrchestrationRunDir = process.env.LOOM_ORCHESTRATION_RUN_DIR;
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
beforeEach(() => {
  writeState(initialGraph());
  delete process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
  delete process.env.LOOM_ORCHESTRATION_RUN_DIR;
});

afterAll(() => {
  if (previousStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = previousStatePath;
  if (previousPiDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousPiDir;
  if (previousSubagentDir === undefined) delete process.env.LOOM_SUBAGENT_DIR;
  else process.env.LOOM_SUBAGENT_DIR = previousSubagentDir;
  if (previousOrchestrationRunsRoot === undefined) delete process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
  else process.env.LOOM_ORCHESTRATION_RUNS_ROOT = previousOrchestrationRunsRoot;
  if (previousOrchestrationRunDir === undefined) delete process.env.LOOM_ORCHESTRATION_RUN_DIR;
  else process.env.LOOM_ORCHESTRATION_RUN_DIR = previousOrchestrationRunDir;
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

async function piCaptureRun(runSuffix: string): Promise<Readonly<{
  runsRoot: string;
  runDir: string;
  request: AgentRequestAuthority;
  handle: RunDirHandle;
}>> {
  const runsRoot = join(temp, `orchestration-runs-${runSuffix}`);
  const runDir = join(runsRoot, `run.${runSuffix}`);
  mkdirSync(runDir, { recursive: true });
  const opened = openRunDirectory(runsRoot, runDir);
  if (!opened.ok) throw new Error(opened.error.message);
  const request = {
    runId: `run.${runSuffix}`,
    requestId: "request:reviewer:1",
    slotId: "slot-1",
    program: "wave-gate",
    role: "code-reviewer",
    attempt: 1,
    modelProfile: "general-review",
    harnessBinding: {
      pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
      claude: { harness: "claude-code", model: "sonnet" },
    },
    requiredSkill: null,
    contextDigest: "a".repeat(64),
    outputSlot: { kind: "fixed-artifact-slot", path: "transcripts/slot-1/attempt-1.raw" },
  } as AgentRequestAuthority;
  const reserved = await opened.value.reserveRequest(request);
  if (!reserved.ok) throw new Error(reserved.error.message);
  return { runsRoot, runDir, request, handle: opened.value };
}

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

  it("captures Pi tool_result bytes through request-bound run authority", async () => {
    const pi = await extension();
    const extensionSpecifier = "../../pi/extension.ts";
    const module = await import(/* @vite-ignore */ extensionSpecifier) as {
      piSpawnRosterId: (toolCallId: unknown, index: number, agent: string) => string;
    };
    const staged = await piCaptureRun("pi-tool-result");
    const toolCallId = "call-request-bound-capture";
    const nativeId = module.piSpawnRosterId(toolCallId, 0, "code-reviewer");
    const correlated = await staged.handle.recordHarnessCorrelator({
      schemaVersion: 1,
      harness: "pi",
      nativeId,
      requestId: staged.request.requestId,
      attempt: staged.request.attempt,
    });
    expect(correlated.ok).toBe(true);
    process.env.LOOM_ORCHESTRATION_RUNS_ROOT = staged.runsRoot;
    process.env.LOOM_ORCHESTRATION_RUN_DIR = staged.runDir;
    const result = reviewResult("Task: T1", "request-bound finding");
    const expected = (result.details.results[0].messages[0].content[0] as { text: string }).text;

    await pi.emit("tool_result", { ...result, toolCallId }, {
      sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad499" },
    });

    expect(readFileSync(join(staged.runDir, "transcripts", "slot-1", "attempt-1.raw"), "utf-8")).toBe(expected);
    expect(JSON.parse(readFileSync(statePath, "utf-8")).tasks[0].critical_findings).toEqual(["request-bound finding"]);
  });

  it("does not apply Pi review evidence after request-bound capture rejection", async () => {
    const pi = await extension();
    const extensionSpecifier = "../../pi/extension.ts";
    const module = await import(/* @vite-ignore */ extensionSpecifier) as {
      piSpawnRosterId: (toolCallId: unknown, index: number, agent: string) => string;
    };
    const staged = await piCaptureRun("pi-rejected-capture");
    const toolCallId = "call-rejected-capture";
    const nativeId = module.piSpawnRosterId(toolCallId, 0, "code-reviewer");
    const correlated = await staged.handle.recordHarnessCorrelator({
      schemaVersion: 1,
      harness: "pi",
      nativeId,
      requestId: staged.request.requestId,
      attempt: staged.request.attempt,
    });
    expect(correlated.ok).toBe(true);
    const correlatorDir = join(staged.runDir, "requests", "correlators");
    writeFileSync(join(correlatorDir, readdirSync(correlatorDir)[0]!), "{broken", "utf-8");
    process.env.LOOM_ORCHESTRATION_RUNS_ROOT = staged.runsRoot;
    process.env.LOOM_ORCHESTRATION_RUN_DIR = staged.runDir;

    const responses = await pi.emit("tool_result", {
      ...reviewResult("Task: T1", "must not be applied"),
      toolCallId,
    }, {
      sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad498" },
    });

    expect(JSON.parse(readFileSync(statePath, "utf-8")).tasks[0].critical_findings ?? []).toEqual([]);
    expect(responses).toContainEqual(expect.objectContaining({
      isError: true,
      content: [expect.objectContaining({ text: expect.stringContaining("request-bound capture rejected") })],
    }));
  });

  it("runs later capability cleanup after an earlier cleanup action fails", async () => {
    const extensionSpecifier = "../../pi/extension.ts";
    const module = await import(/* @vite-ignore */ extensionSpecifier) as {
      runPiCleanupActions: (actions: readonly { label: string; run: () => void | Promise<void> }[]) => Promise<readonly string[]>;
    };
    const calls: string[] = [];

    const errors = await module.runPiCleanupActions([
      { label: "roster", run: () => { calls.push("roster"); throw new Error("lock unavailable"); } },
      { label: "revoke", run: () => { calls.push("revoke"); } },
      { label: "restore", run: async () => { calls.push("restore"); } },
    ]);

    expect(calls).toEqual(["roster", "revoke", "restore"]);
    expect(errors).toEqual(["roster: lock unavailable"]);
  });

  it("makes rejected child write grants an unconditional direct-edit denial", async () => {
    const extensionSpecifier = "../../pi/extension.ts";
    const module = await import(/* @vite-ignore */ extensionSpecifier) as {
      rejectedChildWriteGrantBlock: (rejected: boolean) => unknown;
    };
    expect(module.rejectedChildWriteGrantBlock(false)).toBeNull();
    expect(module.rejectedChildWriteGrantBlock(true)).toEqual({
      block: true,
      reason: "Loom Pi write grant was rejected for this session; direct edits remain blocked.",
    });
  });

  it("blocks later Edit and Write calls in the child session after grant rejection", async () => {
    const planPath = join(temp, "rejected-write-grant-plan.md");
    writeFileSync(planPath, "# Plan\n");
    writeState({
      ...initialGraph(),
      phase_artifacts: { architecture: planPath },
      skipped_phases: ["plan-alignment"],
      plan_file: planPath,
    });
    const pi = await extension();
    const parentSession = "019fca39-f989-7510-8e62-50dadbcad432";
    const childSession = "019fca39-f989-7510-8e62-50dadbcad433";
    const input = {
      agent: "code-implementer-agent",
      task: "Task ID: T1\nUse the code-implementer skill. Implement and test.",
      agentScope: "user",
    };
    expect(await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId: "call-rejected-write-grant",
      input,
    }, { cwd: ROOT, sessionManager: { getSessionId: () => parentSession } })).toEqual([undefined]);

    const rejected = await pi.emit("before_agent_start", {
      prompt: input.task,
      systemPrompt: "<!-- LOOM_PI_AGENT_ID:security-agent -->",
    }, { cwd: ROOT, sessionManager: { getSessionId: () => childSession } });
    expect(rejected).toContainEqual(expect.objectContaining({
      message: expect.objectContaining({ customType: "loom-write-grant-error" }),
    }));

    for (const toolName of ["edit", "write"] as const) {
      const result = await pi.emit("tool_call", {
        toolName,
        input: { path: "README.md" },
      }, { cwd: ROOT, sessionManager: { getSessionId: () => childSession } });
      expect(result).toContainEqual({
        block: true,
        reason: "Loom Pi write grant was rejected for this session; direct edits remain blocked.",
      });
    }
  });

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

  it("resolves Pi review generation against the task held under the update lock", async () => {
    const pi = await extension();
    const context = {
      sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad40a" },
    };
    const { StateManager } = await import("../src/state-manager");
    const originalUpdate = StateManager.prototype.update;
    const update = vi.spyOn(StateManager.prototype, "update").mockImplementation(async function (
      this: typeof StateManager.prototype,
      updater,
    ) {
      const current = JSON.parse(readFileSync(statePath, "utf-8"));
      current.tasks[0].review_generation = 1;
      writeState(current);
      return originalUpdate.call(this, updater);
    });
    try {
      await pi.emit("tool_result", reviewResult("Task: T1", "stale Pi review"), context);
      const stored = JSON.parse(readFileSync(statePath, "utf-8")).tasks[0];
      expect(stored.review_generation).toBe(1);
      expect(stored.review_status).toBe("pending");
      expect(stored.findings).toBeUndefined();
    } finally {
      update.mockRestore();
    }
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
    expect(readFileSync(join(subagentDir, `${session}.task_graph`), "utf-8")).toBe(statePath);

    await pi.emit("tool_result", {
      ...reviewResult(prompt, "review completed"),
      toolCallId,
    }, context);
    expect(() => readFileSync(join(subagentDir, `${session}.active`), "utf-8")).toThrow();
    expect(() => readFileSync(join(subagentDir, `${session}.task_graph`), "utf-8")).toThrow();
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

  it("continues result reconciliation when write-grant revocation fails", async () => {
    const planPath = join(temp, "result-revocation-failure-plan.md");
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
    const session = "019fca39-f989-7510-8e62-50dadbcad436";
    const context = { cwd: ROOT, sessionManager: { getSessionId: () => session } };
    const toolCallId = "call-result-revocation-failure";
    expect(await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId,
      input: {
        agent: "code-implementer-agent",
        task: "Task ID: T1\nUse the code-implementer skill. Implement and test.",
        agentScope: "user",
      },
    }, context)).toEqual([undefined]);

    const grantDir = join(subagentDir, "pi-write-grants");
    let responses: unknown[];
    try {
      chmodSync(grantDir, 0o500);
      responses = await pi.emit("tool_result", {
        toolName: "subagent",
        toolCallId,
        content: [],
        details: {
          results: [{
            agent: "code-implementer-agent", task: "Task ID: T1", exitCode: 1, messages: [],
          }],
        },
      }, context);
    } finally {
      chmodSync(grantDir, 0o700);
    }

    expect(responses!).toContainEqual(expect.objectContaining({
      isError: true,
      content: [expect.objectContaining({ text: expect.stringContaining("revoke write grant") })],
    }));
    expect(JSON.parse(readFileSync(statePath, "utf-8")).executing_tasks).toEqual([]);
    expect(() => readFileSync(join(subagentDir, `${session}.active`), "utf-8")).toThrow();
    await pi.emit("session_shutdown", {}, context);
  });

  it("revokes every outstanding grant when its parent session shutdown roster cleanup fails", async () => {
    const planPath = join(temp, "shutdown-revocation-plan.md");
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
    const parentSession = "019fca39-f989-7510-8e62-50dadbcad426";
    const childSession = "019fca39-f989-7510-8e62-50dadbcad427";
    const replaySession = "019fca39-f989-7510-8e62-50dadbcad428";
    const input = {
      agentScope: "user",
      tasks: [
        { agent: "code-implementer-agent", task: "Task ID: T1\nUse the code-implementer skill. Implement and test." },
        { agent: "code-implementer-agent", task: "Task ID: T2\nUse the code-implementer skill. Implement and test." },
      ],
    };
    expect(await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId: "call-shutdown-revocation",
      input,
    }, { cwd: ROOT, sessionManager: { getSessionId: () => parentSession } })).toEqual([undefined]);

    await pi.emit("before_agent_start", {
      prompt: `Task: ${input.tasks[0].task}`,
      systemPrompt: "<!-- LOOM_PI_AGENT_ID:code-implementer-agent -->",
    }, { cwd: ROOT, sessionManager: { getSessionId: () => childSession } });
    expect(readFileSync(join(subagentDir, `${childSession}.active`), "utf-8")).not.toBe("");

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let shutdownDiagnostic = "";
    try {
      chmodSync(subagentDir, 0o500);
      await pi.emit("session_shutdown", {}, {
        cwd: ROOT,
        sessionManager: { getSessionId: () => parentSession },
      });
      shutdownDiagnostic = stderr.mock.calls.map(([text]) => String(text)).join("");
    } finally {
      chmodSync(subagentDir, 0o700);
      stderr.mockRestore();
    }
    expect(shutdownDiagnostic).toContain("shutdown cleanup failed");

    const replay = await pi.emit("before_agent_start", {
      prompt: `Task: ${input.tasks[1].task}`,
      systemPrompt: "<!-- LOOM_PI_AGENT_ID:code-implementer-agent -->",
    }, { cwd: ROOT, sessionManager: { getSessionId: () => replaySession } });
    expect(replay).toContainEqual(expect.objectContaining({
      message: expect.objectContaining({ customType: "loom-write-grant-error" }),
    }));
    expect(() => readFileSync(join(subagentDir, `${replaySession}.active`), "utf-8")).toThrow();
    await pi.emit("session_shutdown", {}, {
      cwd: ROOT, sessionManager: { getSessionId: () => childSession },
    });
  });

  it("isolates parent reservations when another Pi session shuts down", async () => {
    const pi = await extension();
    const sessionA = "019fca39-f989-7510-8e62-50dadbcad434";
    const sessionB = "019fca39-f989-7510-8e62-50dadbcad435";
    const task = "LOOM_REVIEW_CONTEXT: standalone\nReview the frozen scope";
    for (const [session, toolCallId] of [[sessionA, "call-session-a"], [sessionB, "call-session-b"]] as const) {
      expect(await pi.emit("tool_call", {
        toolName: "subagent",
        toolCallId,
        input: { agent: "code-reviewer", task, agentScope: "user" },
      }, { cwd: ROOT, sessionManager: { getSessionId: () => session } })).toEqual([undefined]);
      expect(readFileSync(join(subagentDir, `${session}.active`), "utf-8").trim()).not.toBe("");
    }

    await pi.emit("session_shutdown", {}, {
      cwd: ROOT, sessionManager: { getSessionId: () => sessionA },
    });
    expect(() => readFileSync(join(subagentDir, `${sessionA}.active`), "utf-8")).toThrow();
    expect(readFileSync(join(subagentDir, `${sessionB}.active`), "utf-8").trim()).not.toBe("");

    await pi.emit("tool_result", {
      ...reviewResult(task, "standalone session B remains reserved"),
      toolCallId: "call-session-b",
    }, { cwd: ROOT, sessionManager: { getSessionId: () => sessionB } });
    expect(() => readFileSync(join(subagentDir, `${sessionB}.active`), "utf-8")).toThrow();
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
    const input = {
      agentScope: "user",
      tasks: [
        { agent: "code-implementer-agent", task: "Task ID: T1\nUse the code-implementer skill. Implement and test." },
        { agent: "code-implementer-agent", task: "Task ID: T2\nUse the code-implementer skill. Implement and test." },
      ],
    };
    const originalPrompts = input.tasks.map((item) => item.task);
    const result = await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId: "call-post-reservation-block",
      input,
    }, { sessionManager: { getSessionId: () => session } });

    expect(result).toContainEqual(expect.objectContaining({ block: true }));
    expect(input.tasks.map((item) => item.task)).toEqual(originalPrompts);
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
    const { classifyTaskExecutionSpawn } = await import("../src/core/validate-task-execution");
    const { validateTaskExecutionBatch } = await import("../src/handlers/task-execution");

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
      const missingEvent = await pi.emit("tool_result", { toolName: "subagent", content: [] }, context);
      const missingDetails = await pi.emit("tool_result", { toolName: "subagent", content: [], details: {} }, context);
      const malformed = await pi.emit("tool_result", {
        toolName: "subagent", content: [], details: { results: "bad" },
      }, context);
      const output = stderr.mock.calls.map(([text]) => String(text)).join("");
      expect(output).toContain("missing details.results");
      expect(output).toContain("unrecognized details.results shape");
      for (const responses of [missingEvent, missingDetails, malformed]) {
        expect(responses).toContainEqual(expect.objectContaining({ isError: true }));
      }
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

  it("persists malformed successful reviewer messages and continues with a healthy sibling", async () => {
    const pi = await extension();
    const context = { sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad430" } };
    const malformed = reviewResult("Task: T1", "must not parse").details.results[0];
    malformed.messages = [null] as unknown as typeof malformed.messages;
    const healthy = reviewResult("Task: T1", "healthy after malformed").details.results[0];
    healthy.agent = "silent-failure-hunter";

    await pi.emit("tool_result", {
      toolName: "subagent",
      content: [],
      details: { results: [malformed, healthy] },
    }, context);

    const task = JSON.parse(readFileSync(statePath, "utf-8")).tasks[0];
    expect(task.critical_findings).toEqual(["healthy after malformed"]);
    expect(task.review_status).toBe("evidence_capture_failed");
    expect(task.review_evidence_failures).toEqual(["code-reviewer"]);
    expect(task.review_error).toContain("Pi review messages are malformed");
  });

  it("marks an omitted reserved reviewer result as evidence_capture_failed", async () => {
    const planPath = join(temp, "truncated-review-results-plan.md");
    writeFileSync(planPath, "# Plan\n");
    writeState({
      ...initialGraph(),
      phase_artifacts: { architecture: planPath },
      skipped_phases: ["plan-alignment"],
      plan_file: planPath,
    });
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad431";
    const context = { sessionManager: { getSessionId: () => session } };
    const toolCallId = "call-truncated-review-results";
    const call = await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId,
      input: {
        agentScope: "user",
        tasks: [
          { agent: "code-reviewer", task: "Task ID: T1\nReview and emit Machine Summary findings." },
          { agent: "silent-failure-hunter", task: "Task ID: T1\nReview and emit Machine Summary findings." },
        ],
      },
    }, context);
    expect(call).toEqual([undefined]);

    await pi.emit("tool_result", {
      toolName: "subagent",
      toolCallId,
      content: [],
      details: { results: [reviewResult("Task: T1", "returned reviewer stored").details.results[0]] },
    }, context);

    const task = JSON.parse(readFileSync(statePath, "utf-8")).tasks[0];
    expect(task.critical_findings).toEqual(["returned reviewer stored"]);
    expect(task.review_status).toBe("evidence_capture_failed");
    expect(task.review_evidence_failures).toEqual(["silent-failure-hunter"]);
    expect(task.review_error).toContain("reserved reviewer result 2");
  });

  it("rejects surplus reserved results instead of applying them through compatibility dispatch", async () => {
    const planPath = join(temp, "surplus-review-results-plan.md");
    writeFileSync(planPath, "# Plan\n");
    writeState({
      ...initialGraph(),
      phase_artifacts: { architecture: planPath },
      skipped_phases: ["plan-alignment"],
      plan_file: planPath,
    });
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad437";
    const context = { sessionManager: { getSessionId: () => session } };
    const toolCallId = "call-surplus-review-results";
    expect(await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId,
      input: {
        agentScope: "user",
        agent: "code-reviewer",
        task: "Task ID: T1\nReview and emit Machine Summary findings.",
      },
    }, context)).toEqual([undefined]);

    const reserved = reviewResult("Task: T1", "reserved reviewer stored").details.results[0];
    const surplus = reviewResult("Task: T1", "surplus reviewer must be ignored").details.results[0];
    surplus.agent = "silent-failure-hunter";
    const responses = await pi.emit("tool_result", {
      toolName: "subagent",
      toolCallId,
      content: [],
      details: { results: [reserved, surplus] },
    }, context);

    const task = JSON.parse(readFileSync(statePath, "utf-8")).tasks[0];
    expect(task.critical_findings).toEqual(["reserved reviewer stored"]);
    expect(task.critical_findings).not.toContain("surplus reviewer must be ignored");
    expect(responses).toContainEqual(expect.objectContaining({
      isError: true,
      content: [expect.objectContaining({ text: expect.stringContaining("surplus evidence ignored") })],
    }));
  });

  it.each([
    ["missing details", {}],
    ["short results", { results: [] }],
    ["mismatched agent", {
      results: [{ agent: "code-reviewer", task: "spec check", exitCode: 0, messages: [] }],
    }],
  ])("replaces stale passing spec evidence for a reserved %s result", async (label, details) => {
    const planPath = join(temp, `reserved-spec-${label.replaceAll(" ", "-")}.md`);
    writeFileSync(planPath, "# Plan\n");
    writeState({
      ...initialGraph(),
      phase_artifacts: { architecture: planPath },
      skipped_phases: ["plan-alignment"],
      plan_file: planPath,
      spec_check: {
        wave: 1, run_at: "earlier", verdict: "PASSED", critical_count: 0, high_count: 0,
        critical_findings: [], high_findings: [], medium_findings: [],
      },
    });
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad432";
    const context = { cwd: ROOT, sessionManager: { getSessionId: () => session } };
    const toolCallId = `call-reserved-spec-${label.replaceAll(" ", "-")}`;
    expect(await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId,
      input: {
        agentScope: "user",
        agent: "spec-check-invoker",
        task: "Follow the preloaded spec-check skill with --wave 1 --tasks T1.",
      },
    }, context)).toEqual([undefined]);

    await pi.emit("tool_result", {
      toolName: "subagent",
      toolCallId,
      content: [],
      details,
    }, context);

    expect(JSON.parse(readFileSync(statePath, "utf-8")).spec_check).toMatchObject({
      wave: 1,
      verdict: "EVIDENCE_CAPTURE_FAILED",
      error: expect.stringContaining("reserved spec-check result 1"),
    });
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

  it("does not advance a successful phase agent from fallback artifacts when messages are malformed", async () => {
    const planPath = join(temp, "malformed-phase-plan.md");
    writeFileSync(planPath, "# Plan\n");
    writeState({
      ...initialGraph(),
      current_phase: "architecture",
      phase_artifacts: {},
      plan_file: planPath,
    });
    const pi = await extension();
    const context = { sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad40a" } };

    const responses = await pi.emit("tool_result", {
      toolName: "subagent",
      content: [],
      details: {
        results: [{
          agent: "architecture-agent",
          task: "finalize architecture",
          exitCode: 0,
          messages: [null],
        }],
      },
    }, context);

    expect(JSON.parse(readFileSync(statePath, "utf-8"))).toMatchObject({
      current_phase: "architecture",
      plan_file: planPath,
    });
    expect(responses).toContainEqual(expect.objectContaining({
      isError: true,
      content: [expect.objectContaining({ text: expect.stringContaining("phase artifact extraction failed") })],
    }));
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

  it.each([
    "printf 'bun test\\n654 pass\\n'",
    "bun test || true",
    "bun test | tee out.log",
  ])("keeps transcript fallback untrusted for test-looking command: %s", async (command) => {
    writeState({
      ...initialGraph(),
      executing_tasks: ["T1"],
      tasks: [{
        ...initialGraph().tasks[0],
        file_list: [],
        files_modified: ["engine/tests/fallback-proof.test.ts"],
        artifact_baseline: [],
        attempt_artifact_baseline: [{
          artifact: "engine/tests/fallback-proof.test.ts",
          snapshot: { kind: "missing" },
        }],
        new_tests_required: true,
      }],
    });
    const pi = await extension();
    const context = { sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad42d" } };
    await pi.emit("tool_result", {
      toolName: "subagent",
      content: [],
      details: {
        results: [{
          agent: "code-implementer-agent",
          task: "Task ID: T1",
          exitCode: 0,
          messages: [
            { role: "assistant", content: [{ type: "toolCall", id: "call-test", name: "bash", arguments: { command } }] },
            { role: "toolResult", toolCallId: "call-test", toolName: "bash", content: [{ type: "text", text: "654 pass\n0 fail\n" }] },
          ],
        }],
      },
    }, context);

    const task = JSON.parse(readFileSync(statePath, "utf-8")).tasks[0];
    expect(task.status).toBe("pending");
    expect(task.test_result).toEqual({
      verdict: "untrusted",
      passed: true,
      label: "transcript-regex (fallback)",
    });
    expect(task.proof.state).not.toBe("satisfied");
  });

  it("invalidates stale implemented evidence when a changed retry has malformed Pi messages", async () => {
    const artifactRelative = `.tmp-pi-malformed-attempt-${process.pid}.ts`;
    const artifactPath = join(ROOT, artifactRelative);
    const planPath = join(temp, "malformed-changed-attempt-plan.md");
    writeFileSync(planPath, "# Plan\n");
    writeFileSync(artifactPath, "export const value = 1;\n");
    const greenProof = evaluateTaskProof(
      { newTestsRequired: false, declaredArtifacts: [artifactRelative] },
      { taskCompleted: true, filesModified: [artifactRelative] },
    );
    writeState({
      ...initialGraph(),
      phase_artifacts: { architecture: planPath },
      skipped_phases: ["plan-alignment"],
      plan_file: planPath,
      wave_gates: { "1": { impl_complete: true, tests_passed: true, reviews_complete: true, blocked: false } },
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
        file_list: [artifactRelative],
        files_modified: [artifactRelative],
      }],
    });
    const pi = await extension();
    const context = {
      cwd: ROOT,
      sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad42e" },
    };
    const toolCallId = "call-malformed-changed-attempt";
    try {
      expect(await pi.emit("tool_call", {
        toolName: "subagent",
        toolCallId,
        input: {
          agent: "code-implementer-agent",
          task: "Task ID: T1\nUse the code-implementer skill. Implement and test.",
          agentScope: "user",
        },
      }, context)).toEqual([undefined]);
      writeFileSync(artifactPath, "export const value = 2;\n");

      await pi.emit("tool_result", {
        toolName: "subagent",
        toolCallId,
        content: [],
        details: {
          results: [{
            agent: "code-implementer-agent",
            task: "Task ID: T1",
            exitCode: 0,
            messages: [null],
          }],
        },
      }, context);

      const state = JSON.parse(readFileSync(statePath, "utf-8"));
      expect(state.executing_tasks).toEqual([]);
      expect(state.tasks[0]).toMatchObject({
        status: "pending",
        review_status: "pending",
        review_generation: 1,
        test_result: { verdict: "untrusted", passed: false, label: "pi-transcript-capture-failed" },
      });
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

  it("invalidates stale evidence without treating repository-wide failed-attempt paths as task attribution", async () => {
    const declaredRelative = `.tmp-pi-failed-declared-${process.pid}.ts`;
    const undeclaredRelative = `.tmp-pi-failed-undeclared-${process.pid}.ts`;
    const declaredPath = join(ROOT, declaredRelative);
    const undeclaredPath = join(ROOT, undeclaredRelative);
    const planPath = join(temp, "failed-undeclared-attempt-plan.md");
    writeFileSync(planPath, "# Plan\n");
    writeFileSync(declaredPath, "export const declared = true;\n");
    const greenProof = evaluateTaskProof(
      { newTestsRequired: false, declaredArtifacts: [declaredRelative] },
      { taskCompleted: true, filesModified: [declaredRelative] },
    );
    writeState({
      ...initialGraph(),
      phase_artifacts: { architecture: planPath },
      skipped_phases: ["plan-alignment"],
      plan_file: planPath,
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
        new_tests_required: false,
        review_status: "passed",
        file_list: [declaredRelative],
        files_modified: [declaredRelative],
      }],
    });
    const pi = await extension();
    const context = {
      cwd: ROOT,
      sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad42f" },
    };
    const toolCallId = "call-failed-undeclared-attempt";
    try {
      expect(await pi.emit("tool_call", {
        toolName: "subagent",
        toolCallId,
        input: {
          agent: "code-implementer-agent",
          task: "Task ID: T1\nUse the code-implementer skill. Implement and test.",
          agentScope: "user",
        },
      }, context)).toEqual([undefined]);
      writeFileSync(undeclaredPath, "export const undeclared = true;\n");

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
      expect(state.tasks[0]).toMatchObject({
        status: "pending",
        review_status: "pending",
        test_result: { verdict: "untrusted", passed: false, label: "pi-implementation-failed" },
      });
      expect(state.tasks[0].files_modified).toEqual([declaredRelative]);
      expect(state.tasks[0].files_modified).not.toContain(undeclaredRelative);
      expect(state.spec_check).toBeUndefined();
      expect(state.wave_gates["1"]).toMatchObject({
        impl_complete: false,
        tests_passed: null,
        reviews_complete: false,
      });
    } finally {
      rmSync(declaredPath, { force: true });
      rmSync(undeclaredPath, { force: true });
    }
  });

  it("does not let a failed parallel task inherit a sibling's new test", async () => {
    const siblingTestRelative = `engine/tests/.tmp-pi-sibling-${process.pid}.test.ts`;
    const siblingTestPath = join(ROOT, siblingTestRelative);
    const planPath = join(temp, "parallel-attribution-plan.md");
    writeFileSync(planPath, "# Plan\n");
    writeState({
      ...initialGraph(),
      phase_artifacts: { architecture: planPath },
      skipped_phases: ["plan-alignment"],
      plan_file: planPath,
      tasks: [
        {
          id: "T1", description: "fails", agent: "code-implementer-agent", wave: 1,
          status: "pending", depends_on: [], file_list: ["pi/extension.ts"], new_tests_required: true,
        },
        {
          id: "T2", description: "writes test", agent: "code-implementer-agent", wave: 1,
          status: "pending", depends_on: [], file_list: ["README.md"], new_tests_required: false,
        },
      ],
    });
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad437";
    const context = { cwd: ROOT, sessionManager: { getSessionId: () => session } };
    const toolCallId = "call-parallel-attribution";
    try {
      expect(await pi.emit("tool_call", {
        toolName: "subagent",
        toolCallId,
        input: {
          agentScope: "user",
          tasks: [
            { agent: "code-implementer-agent", task: "Task ID: T1\nUse the code-implementer skill. Implement and test." },
            { agent: "code-implementer-agent", task: "Task ID: T2\nUse the code-implementer skill. Implement and test." },
          ],
        },
      }, context)).toEqual([undefined]);
      writeFileSync(siblingTestPath, "import { expect, it } from 'vitest'; it('sibling', () => expect(true).toBe(true));\n");

      await pi.emit("tool_result", {
        toolName: "subagent",
        toolCallId,
        content: [],
        details: {
          results: [
            { agent: "code-implementer-agent", task: "Task ID: T1", exitCode: 1, messages: [] },
            { agent: "code-implementer-agent", task: "Task ID: T2", exitCode: 0, messages: [] },
          ],
        },
      }, context);

      const [failed] = JSON.parse(readFileSync(statePath, "utf-8")).tasks;
      expect(failed.status).toBe("pending");
      expect(failed.files_modified ?? []).not.toContain(siblingTestRelative);
      expect(failed.new_tests_written).not.toBe(true);
    } finally {
      rmSync(siblingTestPath, { force: true });
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

  it("blocks external subagents when only the child session pointer binds a graph", async () => {
    const sessionId = "019fca39-f989-7510-8e62-50dadbcad430";
    const pointer = join(subagentDir, `${sessionId}.task_graph`);
    rmSync(statePath, { force: true });
    mkdirSync(subagentDir, { recursive: true });
    writeFileSync(pointer, join(temp, "parent", ".pi", "state", "active_task_graph.json"));
    try {
      const pi = await extension();
      const results = await pi.emit("tool_call", {
        toolName: "subagent",
        toolCallId: "call-external-child",
        input: { agent: "external-agent", task: "run outside Loom" },
      }, { sessionManager: { getSessionId: () => sessionId } });

      expect(results).toContainEqual({
        block: true,
        reason: "External Pi subagents cannot run while a Loom task graph is active",
      });
    } finally {
      rmSync(pointer, { force: true });
      writeState(initialGraph());
    }
  });

  it("returns a caller-visible error when reserved implementation finalization has no state manager", async () => {
    const planPath = join(temp, "finalization-state-missing-plan.md");
    writeFileSync(planPath, "# Plan\n");
    writeState({
      ...initialGraph(),
      phase_artifacts: { architecture: planPath },
      skipped_phases: ["plan-alignment"],
      plan_file: planPath,
    });
    const pi = await extension();
    const context = {
      cwd: ROOT,
      sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad431" },
    };
    const toolCallId = "call-finalization-state-missing";
    expect(await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId,
      input: {
        agent: "code-implementer-agent",
        task: "Task ID: T1\nUse the code-implementer skill. Implement and test.",
        agentScope: "user",
      },
    }, context)).toEqual([undefined]);
    rmSync(statePath, { force: true });
    try {
      const responses = await pi.emit("tool_result", {
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

      expect(responses).toContainEqual(expect.objectContaining({
        isError: true,
        content: [expect.objectContaining({
          text: expect.stringContaining("cannot finalize reserved implementation attempts"),
        })],
      }));
    } finally {
      writeState(initialGraph());
    }
  });

  it("returns a caller-visible error when reserved implementation persistence throws", async () => {
    const planPath = join(temp, "finalization-update-failed-plan.md");
    writeFileSync(planPath, "# Plan\n");
    writeState({
      ...initialGraph(),
      phase_artifacts: { architecture: planPath },
      skipped_phases: ["plan-alignment"],
      plan_file: planPath,
    });
    const pi = await extension();
    const context = {
      cwd: ROOT,
      sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad432" },
    };
    const toolCallId = "call-finalization-update-failed";
    expect(await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId,
      input: {
        agent: "code-implementer-agent",
        task: "Task ID: T1\nUse the code-implementer skill. Implement and test.",
        agentScope: "user",
      },
    }, context)).toEqual([undefined]);

    const { StateManager } = await import("../src/state-manager");
    const update = vi.spyOn(StateManager.prototype, "update")
      .mockRejectedValueOnce(new Error("injected persistence failure"));
    try {
      const responses = await pi.emit("tool_result", {
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

      expect(responses).toContainEqual(expect.objectContaining({
        isError: true,
        content: [expect.objectContaining({
          text: expect.stringContaining("injected persistence failure"),
        })],
      }));
    } finally {
      update.mockRestore();
    }
  });

  it("continues processing later Pi results when the first result throws", async () => {
    const pi = await extension();
    const context = { sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad40a" } };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const second = reviewResult("Task: T1", "second result still stored").details.results[0];
      const responses = await pi.emit("tool_result", {
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
      expect(responses).toContainEqual(expect.objectContaining({
        isError: true,
        content: [expect.objectContaining({ text: expect.stringContaining("result 1") })],
      }));
      expect(JSON.parse(readFileSync(statePath, "utf-8")).tasks[0].critical_findings)
        .toEqual(["second result still stored"]);
    } finally {
      stderr.mockRestore();
    }
  });

  it("replaces stale passing spec evidence when successful Pi messages are malformed", async () => {
    writeState({
      ...initialGraph(),
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
        results: [{
          agent: "spec-check-invoker",
          task: "spec check",
          exitCode: 0,
          messages: [null],
        }],
      },
    }, context);

    expect(JSON.parse(readFileSync(statePath, "utf-8")).spec_check).toMatchObject({
      wave: 1,
      verdict: "EVIDENCE_CAPTURE_FAILED",
      error: expect.stringContaining("messages[0] must be an object"),
    });
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

  /**
   * `files_modified` comes from an agent's own transcript, so the paths in it
   * are untrusted input, and they go on to drive the wave-gate lint target set.
   * `canonicalRepositoryPaths` is the containment boundary; every existing
   * fixture handed it well-behaved in-repo relative paths, so the catch that
   * leaves the task pending was never entered.
   */
  describe("Pi-reported files_modified cannot escape the repository", () => {
    const piWriteMessage = (path: string) => ({
      role: "assistant",
      content: [{ type: "toolCall", id: "call-write-1", name: "write", arguments: { path } }],
    });

    const runImplementerWith = async (path: string, toolCallId: string) => {
      const planPath = join(temp, "files-modified-containment-plan.md");
      writeFileSync(planPath, "# Plan\n");
      writeState({
        ...initialGraph(),
        phase_artifacts: { architecture: planPath },
        skipped_phases: ["plan-alignment"],
        plan_file: planPath,
        executing_tasks: [],
      });
      const pi = await extension();
      const context = {
        cwd: ROOT,
        sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad42d" },
      };
      expect(await pi.emit("tool_call", {
        toolName: "subagent",
        toolCallId,
        input: {
          agent: "code-implementer-agent",
          task: "Task ID: T1\nUse the code-implementer skill. Implement and test.",
          agentScope: "user",
        },
      }, context)).toEqual([undefined]);

      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await pi.emit("tool_result", {
          toolName: "subagent",
          toolCallId,
          content: [],
          details: {
            results: [{
              agent: "code-implementer-agent",
              task: "Task ID: T1",
              exitCode: 0,
              messages: [piWriteMessage(path)],
            }],
          },
        }, context);
        return {
          state: JSON.parse(readFileSync(statePath, "utf-8")),
          audit: stderr.mock.calls.map(([text]) => String(text)).join(""),
        };
      } finally {
        stderr.mockRestore();
      }
    };

    it.each([
      ["a traversal path", "../outside-the-repo.ts"],
      ["a deep traversal path", "engine/../../outside-the-repo.ts"],
      ["an absolute path outside the repository", "/etc/passwd"],
    ])("leaves the task pending and audits %s", async (label, path) => {
      const { state, audit } = await runImplementerWith(path, `call-unsafe-${label.replace(/\s+/g, "-")}`);

      expect(state.tasks[0].status).toBe("pending");
      // The task must also leave the executing set, or the wave stalls on a
      // task nothing will ever complete.
      expect(state.executing_tasks).toEqual([]);
      expect(audit).toContain("unsafe modified-file evidence for T1");
      // Nothing from the refused transcript was persisted as evidence.
      expect(state.tasks[0].files_modified ?? []).not.toContain(path);
    });

    it("accepts an in-repository relative path through the same boundary", async () => {
      const { state, audit } = await runImplementerWith("pi/extension.ts", "call-safe-in-repo");

      expect(audit).not.toContain("unsafe modified-file evidence");
      expect(state.tasks[0].files_modified ?? []).toContain("pi/extension.ts");
    });
  });
});

describe("legacy Pi bridge", () => {
  it("returns a caller-visible failure for unsupported subagent dispatch", async () => {
    const bridgeSpecifier = "../../pi/loom-bridge.ts";
    const bridge = await import(/* @vite-ignore */ bridgeSpecifier) as {
      default: (pi: unknown) => void;
    };
    const pi = new FakePi();
    bridge.default(pi as never);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const results = await pi.emit("tool_result", {
        toolName: "subagent",
      }, {});
      expect(results).toContainEqual({
        content: [expect.objectContaining({ text: expect.stringContaining("unsupported legacy adapter") })],
        isError: true,
      });
    } finally {
      stderr.mockRestore();
    }
  });
});
