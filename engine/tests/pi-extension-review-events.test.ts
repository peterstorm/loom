import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluateTaskProof } from "../src/core/proof-obligations";
import type { AgentRequestAuthority } from "../src/core/orchestration-contract";
import { openRunDirectory, type RunDirHandle } from "../src/orchestration/run-directory-handle";
import { buildContextPacket, encodeByteSection } from "../src/orchestration/context-packets";
import { registerSessionRunBinding } from "../src/orchestration/session-run-bindings";
import {
  captureLoomRuntimeIdentity,
  PI_EXTENSION_RUNTIME_REVISION_ENV,
  PI_EXTENSION_RUNTIME_ROOT_ENV,
} from "../src/runtime-compatibility";

type Handler = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown;

class FakePi {
  readonly handlers = new Map<string, Handler[]>();
  readonly commands = new Map<string, { handler: Handler }>();

  on(event: string, handler: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  registerCommand(name: string, command: { handler: Handler }): void {
    this.commands.set(name, command);
  }

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
const previousRuntimeRoot = process.env[PI_EXTENSION_RUNTIME_ROOT_ENV];
const previousRuntimeRevision = process.env[PI_EXTENSION_RUNTIME_REVISION_ENV];
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

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}

mkdirSync(dirname(statePath), { recursive: true });
writeState(initialGraph());
beforeEach(() => {
  writeState(initialGraph());
  delete process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
  delete process.env.LOOM_ORCHESTRATION_RUN_DIR;
  // Re-assert the fixture env per test: under `bun test` multiple files share
  // one process, and another file's per-test env mutation can leave these
  // pointing elsewhere between this file's tests.
  process.env.LOOM_STATE_PATH = statePath;
  process.env.PI_CODING_AGENT_DIR = piAgentDir;
  process.env.LOOM_SUBAGENT_DIR = subagentDir;
});

afterAll(() => {
  restoreEnv("LOOM_STATE_PATH", previousStatePath);
  restoreEnv("PI_CODING_AGENT_DIR", previousPiDir);
  restoreEnv("LOOM_SUBAGENT_DIR", previousSubagentDir);
  restoreEnv("LOOM_ORCHESTRATION_RUNS_ROOT", previousOrchestrationRunsRoot);
  restoreEnv("LOOM_ORCHESTRATION_RUN_DIR", previousOrchestrationRunDir);
  restoreEnv(PI_EXTENSION_RUNTIME_ROOT_ENV, previousRuntimeRoot);
  restoreEnv(PI_EXTENSION_RUNTIME_REVISION_ENV, previousRuntimeRevision);
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

async function piCaptureRun(runSuffix: string, contextText = "Pi capture context"): Promise<Readonly<{
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
  const requestId = "request:reviewer:1" as AgentRequestAuthority["requestId"];
  const section = encodeByteSection("test", contextText);
  if (!section.ok) throw new Error(section.error.message);
  const packet = buildContextPacket({
    requestId,
    role: "code-reviewer",
    requiredSkill: "none",
    outputContract: "review output",
    fixedContext: [section.value],
    variableContext: [],
  });
  if (!packet.ok) throw new Error(packet.error.message);
  const published = await opened.value.publishContext(packet.value);
  if (!published.ok) throw new Error(published.error.message);
  const request = {
    runId: `run.${runSuffix}`,
    requestId,
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
    contextDigest: packet.value.digest,
    outputSlot: { kind: "fixed-artifact-slot", path: "transcripts/slot-1/attempt-1.raw" },
  } as AgentRequestAuthority;
  const reserved = await opened.value.reserveRequest(request);
  if (!reserved.ok) throw new Error(reserved.error.message);
  return { runsRoot, runDir, request, handle: opened.value };
}

describe("Pi extension review tool_result integration", () => {
  /**
   * `piSpawnRosterId` off the SAME module `extension()` loads.
   *
   * Five cases re-declared the dynamic import inline, immediately after calling
   * `extension()`, purely to reach this one function — so "which extension
   * module is under test" had six answers in one file.
   */
  const rosterId = async (toolCallId: unknown, index: number, agent: string): Promise<string> => {
    const extensionSpecifier = "../../pi/extension.ts";
    const module = await import(/* @vite-ignore */ extensionSpecifier) as {
      piSpawnRosterId: (toolCallId: unknown, index: number, agent: string) => string;
    };
    return module.piSpawnRosterId(toolCallId, index, agent);
  };

  /**
   * Bind `session` to a staged run so the extension can resolve its authority.
   *
   * Nine cases repeated the same five-field call verbatim; the ONE that differs
   * — two reserved requests in one binding — says so by passing its ids.
   */
  const bindSession = async (
    session: string,
    staged: Readonly<{ request: AgentRequestAuthority; runsRoot: string; runDir: string }>,
    requestIds: readonly string[] = [staged.request.requestId],
  ) => registerSessionRunBinding(subagentDir, session, {
    runId: staged.request.runId,
    runsRoot: staged.runsRoot,
    runDirectory: staged.runDir,
    requestIds,
  });

  const extension = async () => {
    const extensionSpecifier = "../../pi/extension.ts";
    const module = await import(/* @vite-ignore */ extensionSpecifier) as {
      default: (pi: unknown) => void;
    };
    const pi = new FakePi();
    module.default(pi as never);
    return pi;
  };

  it("publishes the exact loaded runtime identity for fresh CLI mutation handshakes", async () => {
    await extension();
    const expected = captureLoomRuntimeIdentity(ROOT);

    expect(process.env[PI_EXTENSION_RUNTIME_ROOT_ENV]).toBe(expected.packageRoot);
    expect(process.env[PI_EXTENSION_RUNTIME_REVISION_ENV]).toBe(expected.revision);
  });

  it("blocks post-edit lint when project rules are inaccessible", async () => {
    const pi = await extension();
    const project = mkdtempSync(join(tmpdir(), "loom-pi-project-rules-"));
    const previousCwd = process.cwd();
    try {
      writeFileSync(join(project, "edited.ts"), "export const edited = true;\n");
      for (const relative of [".pi/linter/rules", ".claude/linter/rules"]) {
        const rulesPath = join(project, relative);
        mkdirSync(dirname(rulesPath), { recursive: true });
        symlinkSync(rulesPath, rulesPath);
      }
      process.chdir(project);

      const responses = await pi.emit("tool_result", {
        toolName: "edit",
        isError: false,
        input: { path: "edited.ts", edits: [] },
      }, { sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad4f1" } });

      expect(responses).toContainEqual(expect.objectContaining({
        isError: true,
        content: [expect.objectContaining({ text: expect.stringContaining("LINT ENGINE ERROR") })],
      }));
      expect(JSON.stringify(responses)).toContain("ELOOP");
    } finally {
      process.chdir(previousCwd);
      rmSync(project, { recursive: true, force: true });
    }
  });

  it("BLOCKS a subagent spawn when the checkout drifts from the loaded extension runtime", async () => {
    // The earliest of the three skew guards, and the only one whose blocking arm
    // had no test: the CLI-entry and state-write backstops are exercised against
    // a real mismatch, but every `tool_call` case ran with the extension's own
    // freshly-computed identity, so this branch never fired.
    //
    // Driving it needs a checkout that can change AFTER module load, so the
    // extension is imported from a disposable copy of the runtime source. The
    // copy lives beside the repo with node_modules symlinked in, because
    // `captureLoomRuntimeIdentity` walks `engine/src` and `pi` only — a symlink
    // outside those roots is never visited, and one inside them is refused.
    const skewRoot = mkdtempSync(join(tmpdir(), "loom-runtime-skew-"));
    const savedRuntimeRoot = process.env[PI_EXTENSION_RUNTIME_ROOT_ENV];
    const savedRuntimeRevision = process.env[PI_EXTENSION_RUNTIME_REVISION_ENV];
    try {
      for (const entry of ["engine/src", "pi", "package.json", "engine/package.json", "engine/bun.lock"]) {
        cpSync(join(ROOT, entry), join(skewRoot, entry), { recursive: true });
      }
      symlinkSync(join(ROOT, "node_modules"), join(skewRoot, "node_modules"), "dir");
      symlinkSync(join(ROOT, "engine", "node_modules"), join(skewRoot, "engine", "node_modules"), "dir");

      const module = await import(pathToFileURL(join(skewRoot, "pi", "extension.ts")).href) as {
        default: (pi: unknown) => void;
      };
      const pi = new FakePi();
      module.default(pi as never);

      // Same package root, different bytes — a `revision-mismatch`, which is the
      // skew an operator actually hits after pulling while Pi stays running.
      const drifted = join(skewRoot, "pi", "extension.ts");
      writeFileSync(drifted, `${readFileSync(drifted, "utf-8")}\n// drift\n`);

      const blocked = await pi.emit("tool_call", {
        toolName: "subagent",
        toolCallId: "call-runtime-skew",
        input: { agent: "code-reviewer", task: "Task: T1\nReview it.", agentScope: "user" },
      }, { cwd: skewRoot, sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad480" } });

      expect(blocked).toContainEqual({
        block: true,
        reason: expect.stringContaining("Loom runtime version skew detected"),
      });
      expect(blocked).toContainEqual({
        block: true,
        reason: expect.stringContaining("Run /reload in Pi"),
      });
    } finally {
      restoreEnv(PI_EXTENSION_RUNTIME_ROOT_ENV, savedRuntimeRoot);
      restoreEnv(PI_EXTENSION_RUNTIME_REVISION_ENV, savedRuntimeRevision);
      rmSync(skewRoot, { recursive: true, force: true });
    }
  });

  it("captures Pi tool_result bytes through request-bound run authority", async () => {
    const pi = await extension();
    const staged = await piCaptureRun("pi-tool-result");
    const toolCallId = "call-request-bound-capture";
    const nativeId = await rosterId(toolCallId, 0, "code-reviewer");
    const correlated = await staged.handle.recordHarnessCorrelator({
      schemaVersion: 1,
      harness: "pi",
      nativeId,
      requestId: staged.request.requestId,
      role: staged.request.role,
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
    expect(JSON.parse(readFileSync(statePath, "utf-8")).tasks[0].critical_findings).toBeUndefined();
  });

  it("retains malformed Pi transcript diagnostics in the capture rejection", async () => {
    const extensionSpecifier = "../../pi/extension.ts";
    const module = await import(/* @vite-ignore */ extensionSpecifier) as {
      capturePiSubagentResult: (
        toolCallId: unknown,
        resultIndex: number,
        agentType: string,
        messages: unknown,
      ) => Promise<{ kind: string; reason?: string; message?: string }>;
    };
    const staged = await piCaptureRun("pi-malformed-transcript-shape");
    process.env.LOOM_ORCHESTRATION_RUNS_ROOT = staged.runsRoot;
    process.env.LOOM_ORCHESTRATION_RUN_DIR = staged.runDir;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const outcome = await module.capturePiSubagentResult(
        "call-malformed-transcript",
        0,
        "code-reviewer",
        [null],
      );

      expect(outcome).toEqual({
        kind: "rejected",
        reason: "transcript-shape",
        message: "messages[0] must be an object",
      });
      expect(stderr.mock.calls.map(([text]) => String(text)).join(""))
        .toContain("rejected (transcript-shape): messages[0] must be an object");
    } finally {
      stderr.mockRestore();
    }
  });

  it("does not apply Pi review evidence after request-bound capture rejection", async () => {
    const pi = await extension();
    const staged = await piCaptureRun("pi-rejected-capture");
    const toolCallId = "call-rejected-capture";
    const nativeId = await rosterId(toolCallId, 0, "code-reviewer");
    const correlated = await staged.handle.recordHarnessCorrelator({
      schemaVersion: 1,
      harness: "pi",
      nativeId,
      requestId: staged.request.requestId,
      role: staged.request.role,
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
      content: [expect.objectContaining({ text: expect.stringContaining("request-bound capture failed") })],
    }));
  });

  it("does not mutate protected state for a run-bound Loom result with no correlator", async () => {
    const pi = await extension();
    const staged = await piCaptureRun("pi-missing-correlator");
    process.env.LOOM_ORCHESTRATION_RUNS_ROOT = staged.runsRoot;
    process.env.LOOM_ORCHESTRATION_RUN_DIR = staged.runDir;

    const responses = await pi.emit("tool_result", {
      ...reviewResult("Task: T1", "must remain untrusted"),
      toolCallId: "call-without-correlator",
    }, {
      sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad497" },
    });

    expect(JSON.parse(readFileSync(statePath, "utf-8")).tasks[0].critical_findings ?? []).toEqual([]);
    expect(responses).toContainEqual(expect.objectContaining({
      isError: true,
      content: [expect.objectContaining({ text: expect.stringContaining("no reservation") })],
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

  it("completes an unmarked ad-hoc spawn with no task graph instead of reporting lost evidence", async () => {
    // The reported failure: architecture-tech-lead ran fine graphlessly, then
    // its completion was reported as `no task graph for session ...; ... was
    // NOT applied`. There was never a graph to apply anything to.
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad420";
    const context = { sessionManager: { getSessionId: () => session } };
    const toolCallId = "call-ad-hoc-no-graph";
    // Names the declared deepen skill so the spawn passes the skill-prompt
    // gate, exactly like the graphless code-implementer spawn below.
    const taskPrompt = "Use the deepen skill in review mode. Consult on the launch profile. Do not modify files.";
    // The graph file is shared fixture state; restore it even on failure so a
    // concurrently running test file never observes it missing.
    rmSync(statePath, { force: true });
    try {
      const call = await pi.emit("tool_call", {
        toolName: "subagent",
        toolCallId,
        input: { agent: "architecture-tech-lead", task: taskPrompt, agentScope: "user" },
      }, context);
      expect(call).toEqual([undefined]);

      const responses = await pi.emit("tool_result", {
        ...reviewResult(taskPrompt, "ad-hoc consultation", { agent: "architecture-tech-lead" }),
        toolCallId,
      }, context);

      expect(responses).not.toContainEqual(expect.objectContaining({ isError: true }));
      expect(JSON.stringify(responses)).not.toContain("was NOT applied");
      expect(existsSync(statePath)).toBe(false);
    } finally {
      writeState(initialGraph());
    }
  });

  it("treats a graphless implementation spawn as a no-op instead of a finalization failure", async () => {
    // The result-side site the two-commit sequence exists for: an ad-hoc
    // code-implementer-agent spawned with no task graph has no attempt record to
    // finalize, so nothing was lost and there is nothing to report. Before, it
    // produced "cannot finalize reserved implementation attempts ... task graph
    // unavailable" and surfaced as an orchestration error to the caller.
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad470";
    const context = { cwd: ROOT, sessionManager: { getSessionId: () => session } };
    const toolCallId = "call-ad-hoc-impl-no-graph";
    const taskPrompt = "Use the code-implementer skill. Refactor the parser. No task graph here.";
    rmSync(statePath, { force: true });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await pi.emit("tool_call", {
        toolName: "subagent",
        toolCallId,
        input: { agent: "code-implementer-agent", task: taskPrompt, agentScope: "user" },
      }, context)).toEqual([undefined]);

      const responses = await pi.emit("tool_result", {
        toolName: "subagent",
        toolCallId,
        isError: false,
        input: {},
        content: [],
        // A FAILED result: this is the arm that would otherwise try to record an
        // untrusted stop resolution against a graph that does not exist.
        details: { results: [{ agent: "code-implementer-agent", task: taskPrompt, exitCode: 1, messages: [] }] },
      }, context);

      const written = stderr.mock.calls.map(([text]) => String(text)).join("");
      expect(written).toContain("no task graph to finalize");
      expect(written).not.toContain("cannot finalize reserved implementation attempts");
      expect(responses).not.toContainEqual(expect.objectContaining({ isError: true }));
      expect(existsSync(statePath)).toBe(false);
    } finally {
      stderr.mockRestore();
      writeState(initialGraph());
    }
  });

  it("names a graphless spawn's missing review result without calling it an orchestration failure", async () => {
    // The other result-side site: the reservation expected a reviewer result
    // that Pi did not return. Worth SAYING, but there is no protected state to
    // record an evidence failure against, so it is not a processing error.
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad471";
    const context = { cwd: ROOT, sessionManager: { getSessionId: () => session } };
    const toolCallId = "call-ad-hoc-review-missing";
    const taskPrompt = "Task: T1\nReview it.";
    rmSync(statePath, { force: true });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await pi.emit("tool_call", {
        toolName: "subagent",
        toolCallId,
        input: { agent: "code-reviewer", task: taskPrompt, agentScope: "user" },
      }, context)).toEqual([undefined]);

      // The reserved reviewer slot comes back as a DIFFERENT agent, which is
      // exactly the "missing or mismatched" reconciliation case.
      await pi.emit("tool_result", {
        toolName: "subagent",
        toolCallId,
        isError: false,
        input: {},
        content: [],
        details: { results: [{ agent: "architecture-tech-lead", task: taskPrompt, exitCode: 0, messages: [] }] },
      }, context);

      const written = stderr.mock.calls.map(([text]) => String(text)).join("");
      expect(written).toContain("no task graph to record them against");
      expect(written).not.toContain("cannot persist");
      expect(existsSync(statePath)).toBe(false);
    } finally {
      stderr.mockRestore();
      writeState(initialGraph());
    }
  });

  it("still reports a completion as unapplied when the graph vanished mid-run", async () => {
    // The case the diagnostic exists for: a graph WAS active at spawn, so the
    // agent's completion really was going to update protected state.
    const planPath = join(temp, "graph-vanished-plan.md");
    writeFileSync(planPath, "# Plan\n");
    writeState({
      ...initialGraph(),
      phase_artifacts: { architecture: planPath },
      skipped_phases: ["plan-alignment"],
      plan_file: planPath,
    });
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad421";
    const context = { cwd: ROOT, sessionManager: { getSessionId: () => session } };
    const toolCallId = "call-graph-vanished";
    const taskPrompt = "Task: T1\nReview the implementation.";

    const call = await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId,
      input: { agent: "code-reviewer", task: taskPrompt, agentScope: "user" },
    }, context);
    expect(call).toEqual([undefined]);

    rmSync(statePath, { force: true });
    rmSync(join(subagentDir, `${session}.task_graph`), { force: true });
    try {
      const responses = await pi.emit("tool_result", {
        ...reviewResult(taskPrompt, "must be reported as unapplied"),
        toolCallId,
      }, context);

      expect(JSON.stringify(responses)).toContain("was NOT applied");
    } finally {
      writeState(initialGraph());
    }
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
      restoreEnv("LOOM_STATE_PATH", previous);
      rmSync(latePath, { force: true });
    }
  });

  it("surfaces task-graph access failure in resume context and loom-status", async () => {
    const pi = await extension();
    const loop = join(temp, `pi-task-graph-loop-${process.pid}`);
    const previous = process.env.LOOM_STATE_PATH;
    rmSync(loop, { force: true });
    symlinkSync(loop, loop);
    process.env.LOOM_STATE_PATH = loop;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const outputs = await pi.emit("before_agent_start", { prompt: "", systemPrompt: "" }, {
        sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad417" },
      });
      expect(outputs).not.toContainEqual(expect.objectContaining({
        message: expect.objectContaining({ customType: "loom-context" }),
      }));
      expect(stderr.mock.calls.map(([text]) => String(text)).join(""))
        .toContain("resume context skipped — task graph unreadable");

      const notifications: Array<{ message: string; level: string }> = [];
      const status = pi.commands.get("loom-status");
      expect(status).toBeDefined();
      await status?.handler({}, {
        ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
      });
      expect(notifications).toContainEqual({ message: expect.stringContaining("Error: ELOOP"), level: "error" });
      expect(notifications).not.toContainEqual({ message: "No active loom orchestration", level: "info" });
    } finally {
      stderr.mockRestore();
      restoreEnv("LOOM_STATE_PATH", previous);
      rmSync(loop, { force: true });
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

  it("blocks oversized Pi transport calls with an exact lossless-partition diagnostic", async () => {
    const pi = await extension();
    const call = await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId: "call-oversized-pi-transport",
      input: {
        agentScope: "user",
        tasks: Array.from({ length: 9 }, (_, index) => ({
          agent: "code-reviewer",
          task: `Review transport item ${index + 1}`,
        })),
      },
    }, { sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad444" } });

    expect(call).toContainEqual(expect.objectContaining({
      block: true,
      reason: expect.stringContaining("partition the engine-issued spawn-batch into ordered chunks"),
    }));
  });

  it("records the durable Pi correlator before accepting an orchestration spawn", async () => {
    const pi = await extension();
    const staged = await piCaptureRun("pi-spawn-correlator");
    process.env.LOOM_ORCHESTRATION_RUNS_ROOT = staged.runsRoot;
    process.env.LOOM_ORCHESTRATION_RUN_DIR = staged.runDir;
    const session = "019fca39-f989-7510-8e62-50dadbcad43a";
    const toolCallId = "call-durable-correlator";
    const backup = `${statePath}.correlator-spawn-backup`;
    renameSync(statePath, backup);
    try {
      const results = await pi.emit("tool_call", {
        toolName: "subagent",
        toolCallId,
        input: {
          agent: "code-reviewer",
          task: `LOOM_REVIEW_CONTEXT: standalone\nLOOM_REQUEST_ID: ${staged.request.requestId}\nLOOM_CONTEXT_DIGEST: ${staged.request.contextDigest}\nReview the exact issued request`,
          agentScope: "user",
        },
      }, { sessionManager: { getSessionId: () => session } });

      expect(results).toEqual([undefined]);
      const nativeId = await rosterId(toolCallId, 0, "code-reviewer");
      const binding = staged.handle.readHarnessCorrelator("pi", nativeId);
      expect(binding.ok).toBe(true);
      if (binding.ok) {
        expect(binding.value?.requestId).toBe(staged.request.requestId);
        expect(binding.value?.role).toBe(staged.request.role);
      }
    } finally {
      rmSync(join(subagentDir, `${session}.active`), { force: true });
      renameSync(backup, statePath);
    }
  });

  it("captures the exact façade-issued Pi task through the CLI-published session binding", async () => {
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad43c";
    const toolCallId = "call-session-run-binding";
    const runsRoot = join(temp, "cli-session-binding-runs");
    const runDir = join(runsRoot, "run.cli-session-binding");
    mkdirSync(runDir, { recursive: true });
    const stdout = execFileSync("bun", [
      join(ROOT, "engine", "src", "cli.ts"),
      "helper", "orchestration", "start", "standalone-review",
      "--runs-root", runsRoot, "--run", runDir,
    ], {
      cwd: ROOT,
      encoding: "utf-8",
      input: JSON.stringify({ kind: "comments", files: ["src/types.ts"], dryRun: false }),
      env: {
        ...process.env,
        PI_CODING_AGENT: "true",
        PI_SESSION_ID: session,
        LOOM_SUBAGENT_DIR: subagentDir,
      },
    });
    const action = JSON.parse(stdout) as {
      kind: string;
      requests: readonly {
        authority: AgentRequestAuthority;
        task: string;
      }[];
    };
    expect(action.kind).toBe("spawn-batch");
    expect(action.requests).toHaveLength(1);
    const request = action.requests[0]!;
    const before = readFileSync(statePath, "utf-8");

    const call = await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId,
      input: { agent: request.authority.role, task: request.task, agentScope: "user" },
    }, { sessionManager: { getSessionId: () => session } });
    expect(call).toEqual([undefined]);

    const expected = [
      "### Machine Summary",
      "CRITICAL_COUNT: 0",
      "ADVISORY_COUNT: 0",
      "```findings",
      "[]",
      "```",
    ].join("\n");
    const responses = await pi.emit("tool_result", {
      toolName: "subagent",
      toolCallId,
      isError: false,
      input: {},
      content: [],
      details: { results: [{
        agent: request.authority.role,
        task: request.task,
        exitCode: 0,
        messages: [{ role: "assistant", content: [{ type: "text", text: expected }] }],
      }] },
    }, { sessionManager: { getSessionId: () => session } });

    expect(responses.every((response) => response === undefined)).toBe(true);
    expect(readFileSync(join(runDir, request.authority.outputSlot.path), "utf-8")).toBe(expected);
    expect(readFileSync(statePath, "utf-8")).toBe(before);
  });

  it("reloads durable session authority when the Pi extension restarts between spawn and result", async () => {
    const beforeReload = await extension();
    const staged = await piCaptureRun("pi-session-binding-reload");
    const session = "019fca39-f989-7510-8e62-50dadbcad43e";
    const toolCallId = "call-session-binding-reload";
    const prompt = [
      "LOOM_REVIEW_CONTEXT: standalone",
      `LOOM_REQUEST_ID: ${staged.request.requestId}`,
      `LOOM_CONTEXT_DIGEST: ${staged.request.contextDigest}`,
      "Review the exact issued request",
    ].join("\n");
    expect((await bindSession(session, staged)).ok).toBe(true);
    expect(await beforeReload.emit("tool_call", {
      toolName: "subagent",
      toolCallId,
      input: { agent: "code-reviewer", task: prompt, agentScope: "user" },
    }, { sessionManager: { getSessionId: () => session } })).toEqual([undefined]);

    const afterReload = await extension();
    const result = reviewResult(prompt, "captured after extension reload");
    const expected = (result.details.results[0].messages[0].content[0] as { text: string }).text;
    const responses = await afterReload.emit("tool_result", { ...result, toolCallId }, {
      sessionManager: { getSessionId: () => session },
    });

    expect(responses.every((response) => response === undefined)).toBe(true);
    expect(readFileSync(join(staged.runDir, "transcripts", "slot-1", "attempt-1.raw"), "utf-8"))
      .toBe(expected);
  });

  it("fails closed after reload when any same-session run binding is inaccessible", async () => {
    const beforeReload = await extension();
    const stale = await piCaptureRun("pi-session-binding-stale-unrelated", "stale unrelated context");
    const current = await piCaptureRun("pi-session-binding-current-after-stale", "current recovery context");
    const session = "019fca39-f989-7510-8e62-50dadbcad444";
    const toolCallId = "call-session-binding-current-after-stale";
    for (const staged of [stale, current]) {
      expect((await bindSession(session, staged)).ok).toBe(true);
    }
    const prompt = [
      "LOOM_REVIEW_CONTEXT: standalone",
      `LOOM_REQUEST_ID: ${current.request.requestId}`,
      `LOOM_CONTEXT_DIGEST: ${current.request.contextDigest}`,
      "Review the current issued request",
    ].join("\n");
    expect(await beforeReload.emit("tool_call", {
      toolName: "subagent", toolCallId,
      input: { agent: "code-reviewer", task: prompt, agentScope: "user" },
    }, { sessionManager: { getSessionId: () => session } })).toEqual([undefined]);
    rmSync(stale.runDir, { recursive: true, force: true });

    const afterReload = await extension();
    const result = reviewResult(prompt, "must not capture under ambiguous recovery authority");
    const responses = await afterReload.emit("tool_result", { ...result, toolCallId }, {
      sessionManager: { getSessionId: () => session },
    });

    expect(responses).toContainEqual(expect.objectContaining({
      isError: true,
      content: [expect.objectContaining({ text: expect.stringContaining("could not be recovered unambiguously") })],
    }));
    expect(() => readFileSync(join(current.runDir, "transcripts", "slot-1", "attempt-1.raw"), "utf-8")).toThrow();
  });

  it("preserves same-role result index authority across a Pi extension reload", async () => {
    const beforeReload = await extension();
    const staged = await piCaptureRun("pi-session-binding-reload-same-role");
    const secondRequestId = "request:reviewer:10" as AgentRequestAuthority["requestId"];
    const section = encodeByteSection("test", "second same-role context");
    if (!section.ok) throw new Error(section.error.message);
    const packet = buildContextPacket({
      requestId: secondRequestId, role: "code-reviewer", requiredSkill: "none", outputContract: "review output",
      fixedContext: [section.value], variableContext: [],
    });
    if (!packet.ok) throw new Error(packet.error.message);
    expect((await staged.handle.publishContext(packet.value)).ok).toBe(true);
    const second = {
      ...staged.request,
      requestId: secondRequestId,
      slotId: "slot-2",
      contextDigest: packet.value.digest,
      outputSlot: { kind: "fixed-artifact-slot", path: "transcripts/slot-2/attempt-1.raw" },
    } as AgentRequestAuthority;
    expect((await staged.handle.reserveRequest(second)).ok).toBe(true);
    const session = "019fca39-f989-7510-8e62-50dadbcad445";
    const toolCallId = "call-session-binding-reload-same-role";
    expect((await bindSession(session, staged, [staged.request.requestId, second.requestId])).ok).toBe(true);
    const prompts = [staged.request, second].map((request, index) => [
      "LOOM_REVIEW_CONTEXT: standalone",
      `LOOM_REQUEST_ID: ${request.requestId}`,
      `LOOM_CONTEXT_DIGEST: ${request.contextDigest}`,
      `Review same-role item ${index + 1}`,
    ].join("\n"));
    expect(await beforeReload.emit("tool_call", {
      toolName: "subagent", toolCallId,
      input: { agentScope: "user", tasks: prompts.map((task) => ({ agent: "code-reviewer", task })) },
    }, { sessionManager: { getSessionId: () => session } })).toEqual([undefined]);

    const output = ["### Machine Summary", "CRITICAL_COUNT: 0", "ADVISORY_COUNT: 0", "```findings", "[]", "```"].join("\n");
    const afterReload = await extension();
    const responses = await afterReload.emit("tool_result", {
      toolName: "subagent", toolCallId, isError: false, input: {}, content: [],
      details: { results: prompts.map((task) => ({
        agent: "code-reviewer", task, exitCode: 0,
        messages: [{ role: "assistant", content: [{ type: "text", text: output }] }],
      })) },
    }, { sessionManager: { getSessionId: () => session } });

    expect(responses.every((response) => response === undefined)).toBe(true);
    expect(readFileSync(join(staged.runDir, "transcripts", "slot-1", "attempt-1.raw"), "utf8")).toBe(output);
    expect(readFileSync(join(staged.runDir, "transcripts", "slot-2", "attempt-1.raw"), "utf8")).toBe(output);
  });

  it("reports missing request-bound results after Pi extension reload", async () => {
    const beforeReload = await extension();
    const staged = await piCaptureRun("pi-session-binding-reload-missing");
    const session = "019fca39-f989-7510-8e62-50dadbcad443";
    const toolCallId = "call-session-binding-reload-missing";
    const prompt = [
      "LOOM_REVIEW_CONTEXT: standalone",
      `LOOM_REQUEST_ID: ${staged.request.requestId}`,
      `LOOM_CONTEXT_DIGEST: ${staged.request.contextDigest}`,
      "Review the exact issued request",
    ].join("\n");
    expect((await bindSession(session, staged)).ok).toBe(true);
    expect(await beforeReload.emit("tool_call", {
      toolName: "subagent", toolCallId,
      input: { agent: "code-reviewer", task: prompt, agentScope: "user" },
    }, { sessionManager: { getSessionId: () => session } })).toEqual([undefined]);

    const afterReload = await extension();
    const responses = await afterReload.emit("tool_result", {
      toolName: "subagent", toolCallId, isError: false, input: {}, content: [],
      details: { results: [] },
    }, { sessionManager: { getSessionId: () => session } });

    expect(responses).toContainEqual(expect.objectContaining({
      isError: true,
      content: [expect.objectContaining({ text: expect.stringContaining("request-bound result 1") })],
    }));
  });

  it("does not publish a failed Pi child result as successful orchestration evidence", async () => {
    const pi = await extension();
    const staged = await piCaptureRun("pi-session-binding-failed-child");
    const session = "019fca39-f989-7510-8e62-50dadbcad43f";
    const toolCallId = "call-session-binding-failed-child";
    const prompt = [
      "LOOM_REVIEW_CONTEXT: standalone",
      `LOOM_REQUEST_ID: ${staged.request.requestId}`,
      `LOOM_CONTEXT_DIGEST: ${staged.request.contextDigest}`,
      "Review the exact issued request",
    ].join("\n");
    expect((await bindSession(session, staged)).ok).toBe(true);
    expect(await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId,
      input: { agent: "code-reviewer", task: prompt, agentScope: "user" },
    }, { sessionManager: { getSessionId: () => session } })).toEqual([undefined]);

    const responses = await pi.emit("tool_result", {
      ...reviewResult(prompt, "must not become evidence", {
        exitCode: 0,
        stopReason: "error",
        errorMessage: "Connection error.",
      }),
      toolCallId,
    }, { sessionManager: { getSessionId: () => session } });

    expect(responses).toContainEqual(expect.objectContaining({
      isError: true,
      content: [expect.objectContaining({ text: expect.stringContaining("agent-failed") })],
    }));
    expect(() => readFileSync(join(staged.runDir, "transcripts", "slot-1", "attempt-1.raw"), "utf-8"))
      .toThrow();

    // The recorded rejection is the run's OWN evidence for why the slot
    // produced nothing, and an operator classifies infra-vs-agent from it
    // alone. An `exitCode: 0` + `stopReason: "error"` child is exactly the
    // shape a dropped model-server connection leaves behind — the case that
    // used to be indistinguishable from a contract violation.
    const rejections = readdirSync(join(staged.runDir, "events"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => JSON.parse(readFileSync(join(staged.runDir, "events", name), "utf-8")) as {
        event: { kind?: string; diagnostic?: string };
      })
      .filter(({ event }) => event.kind === "request-capture-rejected");
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.event.diagnostic)
      .toContain('exitCode=0, stopReason=error, errorMessage="Connection error."');
  });

  it("reports a missing request-bound Pi result instead of silently leaving its transcript empty", async () => {
    const pi = await extension();
    const staged = await piCaptureRun("pi-session-binding-missing-result");
    const session = "019fca39-f989-7510-8e62-50dadbcad440";
    const toolCallId = "call-session-binding-missing-result";
    const prompt = [
      "LOOM_REVIEW_CONTEXT: standalone",
      `LOOM_REQUEST_ID: ${staged.request.requestId}`,
      `LOOM_CONTEXT_DIGEST: ${staged.request.contextDigest}`,
      "Review the exact issued request",
    ].join("\n");
    expect((await bindSession(session, staged)).ok).toBe(true);
    expect(await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId,
      input: { agent: "code-reviewer", task: prompt, agentScope: "user" },
    }, { sessionManager: { getSessionId: () => session } })).toEqual([undefined]);

    const responses = await pi.emit("tool_result", {
      toolName: "subagent", toolCallId, isError: false, input: {}, content: [],
      details: { results: [] },
    }, { sessionManager: { getSessionId: () => session } });

    expect(responses).toContainEqual(expect.objectContaining({
      isError: true,
      content: [expect.objectContaining({ text: expect.stringContaining("request-bound result 1") })],
    }));
  });

  it("does not mutate protected task state when a non-standalone run-bound result is missing", async () => {
    const planPath = join(temp, "run-bound-missing-wave-plan.md");
    writeFileSync(planPath, "# Plan\n");
    writeState({
      ...initialGraph(),
      phase_artifacts: { architecture: planPath },
      skipped_phases: ["plan-alignment"],
      plan_file: planPath,
    });
    const pi = await extension();
    const staged = await piCaptureRun("pi-run-bound-missing-wave-result");
    const session = "019fca39-f989-7510-8e62-50dadbcad442";
    const toolCallId = "call-run-bound-missing-wave-result";
    const prompt = [
      "Task ID: T1",
      `LOOM_REQUEST_ID: ${staged.request.requestId}`,
      `LOOM_CONTEXT_DIGEST: ${staged.request.contextDigest}`,
      "Review the exact issued Wave request",
    ].join("\n");
    expect((await bindSession(session, staged)).ok).toBe(true);
    const before = readFileSync(statePath, "utf-8");
    expect(await pi.emit("tool_call", {
      toolName: "subagent", toolCallId,
      input: { agent: "code-reviewer", task: prompt, agentScope: "user" },
    }, { sessionManager: { getSessionId: () => session } })).toEqual([undefined]);

    const responses = await pi.emit("tool_result", {
      toolName: "subagent", toolCallId, isError: false, input: {}, content: [],
      details: { results: [] },
    }, { sessionManager: { getSessionId: () => session } });

    expect(responses).toContainEqual(expect.objectContaining({ isError: true }));
    expect(readFileSync(statePath, "utf-8")).toBe(before);
  });

  it("blocks request-bound Pi spawns whose context digest does not match issued authority", async () => {
    const pi = await extension();
    const staged = await piCaptureRun("pi-session-binding-wrong-context");
    const session = "019fca39-f989-7510-8e62-50dadbcad43d";
    const published = await bindSession(session, staged);
    expect(published.ok).toBe(true);

    const call = await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId: "call-session-binding-wrong-context",
      input: {
        agent: "code-reviewer",
        task: [
          "LOOM_REVIEW_CONTEXT: standalone",
          `LOOM_REQUEST_ID: ${staged.request.requestId}`,
          `LOOM_CONTEXT_DIGEST: ${"f".repeat(64)}`,
          "Review the exact issued request",
        ].join("\n"),
        agentScope: "user",
      },
    }, { sessionManager: { getSessionId: () => session } });

    expect(call).toContainEqual(expect.objectContaining({
      block: true,
      reason: expect.stringContaining("no Pi session run binding contains issued request/context authority"),
    }));
    expect(() => readFileSync(join(subagentDir, `${session}.active`), "utf-8")).toThrow();
  });

  it("uses context authority to disambiguate identical request ids across active runs", async () => {
    const pi = await extension();
    const first = await piCaptureRun("pi-duplicate-request-first", "first context");
    const second = await piCaptureRun("pi-duplicate-request-second", "second context");
    const session = "019fca39-f989-7510-8e62-50dadbcad441";
    const toolCallId = "call-duplicate-request-context";
    for (const staged of [first, second]) {
      expect((await bindSession(session, staged)).ok).toBe(true);
    }
    const prompt = [
      "LOOM_REVIEW_CONTEXT: standalone",
      `LOOM_REQUEST_ID: ${second.request.requestId}`,
      `LOOM_CONTEXT_DIGEST: ${second.request.contextDigest}`,
      "Review the second issued request",
    ].join("\n");

    const call = await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId,
      input: { agent: "code-reviewer", task: prompt, agentScope: "user" },
    }, { sessionManager: { getSessionId: () => session } });
    expect(call).toEqual([undefined]);

    const nativeId = await rosterId(toolCallId, 0, "code-reviewer");
    expect(first.handle.readHarnessCorrelator("pi", nativeId)).toMatchObject({ ok: true, value: null });
    expect(second.handle.readHarnessCorrelator("pi", nativeId)).toMatchObject({
      ok: true,
      value: expect.objectContaining({ requestId: second.request.requestId }),
    });
    rmSync(join(subagentDir, `${session}.active`), { force: true });
  });

  it("binds duplicate-role Pi batch items by exact request marker instead of lexical request order", async () => {
    const pi = await extension();
    const staged = await piCaptureRun("pi-duplicate-role-correlator");
    const second = {
      ...staged.request,
      requestId: "request:reviewer:10",
      slotId: "slot-2",
      outputSlot: { kind: "fixed-artifact-slot", path: "transcripts/slot-2/attempt-1.raw" },
    } as AgentRequestAuthority;
    const reserved = await staged.handle.reserveRequest(second);
    expect(reserved.ok).toBe(true);
    process.env.LOOM_ORCHESTRATION_RUNS_ROOT = staged.runsRoot;
    process.env.LOOM_ORCHESTRATION_RUN_DIR = staged.runDir;
    const session = "019fca39-f989-7510-8e62-50dadbcad43b";
    const toolCallId = "call-duplicate-role-correlators";
    const backup = `${statePath}.duplicate-correlator-spawn-backup`;
    renameSync(statePath, backup);
    try {
      const results = await pi.emit("tool_call", {
        toolName: "subagent",
        toolCallId,
        input: {
          agentScope: "user",
          tasks: [
            { agent: "code-reviewer", task: `LOOM_REVIEW_CONTEXT: standalone\nLOOM_REQUEST_ID: ${second.requestId}\nLOOM_CONTEXT_DIGEST: ${second.contextDigest}\nReview second` },
            { agent: "code-reviewer", task: `LOOM_REVIEW_CONTEXT: standalone\nLOOM_REQUEST_ID: ${staged.request.requestId}\nLOOM_CONTEXT_DIGEST: ${staged.request.contextDigest}\nReview first` },
          ],
        },
      }, { sessionManager: { getSessionId: () => session } });

      expect(results).toEqual([undefined]);
      const firstBinding = staged.handle.readHarnessCorrelator(
        "pi",
        await rosterId(toolCallId, 0, "code-reviewer"),
      );
      const secondBinding = staged.handle.readHarnessCorrelator(
        "pi",
        await rosterId(toolCallId, 1, "code-reviewer"),
      );
      expect(firstBinding.ok && firstBinding.value?.requestId).toBe(second.requestId);
      expect(secondBinding.ok && secondBinding.value?.requestId).toBe(staged.request.requestId);

      const output = ["### Machine Summary", "CRITICAL_COUNT: 0", "ADVISORY_COUNT: 0", "```findings", "[]", "```"].join("\n");
      const reordered = await pi.emit("tool_result", {
        toolName: "subagent", toolCallId, isError: false, input: {}, content: [],
        details: { results: [
          {
            agent: "code-reviewer", exitCode: 0,
            task: `LOOM_REVIEW_CONTEXT: standalone\nLOOM_REQUEST_ID: ${staged.request.requestId}\nLOOM_CONTEXT_DIGEST: ${staged.request.contextDigest}\nReview first`,
            messages: [{ role: "assistant", content: [{ type: "text", text: output }] }],
          },
          {
            agent: "code-reviewer", exitCode: 0,
            task: `LOOM_REVIEW_CONTEXT: standalone\nLOOM_REQUEST_ID: ${second.requestId}\nLOOM_CONTEXT_DIGEST: ${second.contextDigest}\nReview second`,
            messages: [{ role: "assistant", content: [{ type: "text", text: output }] }],
          },
        ] },
      }, { sessionManager: { getSessionId: () => session } });
      expect(reordered).toContainEqual(expect.objectContaining({
        isError: true,
        content: [expect.objectContaining({ text: expect.stringContaining("does not match correlated request") })],
      }));
      expect(() => readFileSync(join(staged.runDir, "transcripts", "slot-1", "attempt-1.raw"))).toThrow();
      expect(() => readFileSync(join(staged.runDir, "transcripts", "slot-2", "attempt-1.raw"))).toThrow();
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

  it("issues a SCOPED write grant to a phase agent and enforces its artifact scope", async () => {
    writeState({
      ...initialGraph(),
      current_phase: "brainstorm",
      skipped_phases: ["brainstorm"],
      phase_artifacts: {},
      spec_file: null,
      plan_file: null,
    });
    const pi = await extension();
    const parentSession = "019fca39-f989-7510-8e62-50dadbcad430";
    const childSession = "019fca39-f989-7510-8e62-50dadbcad431";
    const input = {
      agentScope: "user",
      agent: "specify-agent",
      task: "## Specify: F6 fugue panel\nOutput location: `.claude/specs/2026-08-12-foo/spec.md`",
    };
    expect(await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId: "call-scoped-specify",
      input,
    }, { cwd: ROOT, sessionManager: { getSessionId: () => parentSession } })).toEqual([undefined]);
    expect(input.task).toMatch(/LOOM_PI_WRITE_GRANT:[0-9a-f]{64}/);

    // The grant carries a phase binding and a prompt-derived artifact scope.
    const grantsDir = join(subagentDir, "pi-write-grants");
    const stored = JSON.parse(readFileSync(join(grantsDir, readdirSync(grantsDir)[0]!), "utf-8"));
    expect(stored.taskId).toBe("phase:specify");
    expect(stored.scopeDirs).toEqual([join(ROOT, ".claude", "specs", "2026-08-12-foo") + "/"]);

    const started = await pi.emit("before_agent_start", {
      prompt: input.task,
      systemPrompt: "<!-- LOOM_PI_AGENT_ID:specify-agent -->",
    }, { cwd: ROOT, sessionManager: { getSessionId: () => childSession } });
    // Multiple before_agent_start handlers may be registered; the grant
    // consumer is one of them and must not block the child start.
    expect(started).not.toContainEqual(expect.objectContaining({ message: expect.anything() }));
    expect(readFileSync(join(subagentDir, `${childSession}.active`), "utf-8").trim())
      .toMatch(/^pi-grant-[0-9a-f]{16}$/);

    // The spec file — the artifact the template mandates — is writable.
    const inScope = await pi.emit("tool_call", {
      toolName: "write",
      input: { path: ".claude/specs/2026-08-12-foo/spec.md", content: "# Spec" },
    }, { cwd: ROOT, sessionManager: { getSessionId: () => childSession } });
    expect(inScope).toEqual([undefined]);
    // Sibling file directly under specs/ (not the run slug) is out of scope.
    const sibling = await pi.emit("tool_call", {
      toolName: "write",
      input: { path: ".claude/specs/other.md", content: "x" },
    }, { cwd: ROOT, sessionManager: { getSessionId: () => childSession } });
    expect(sibling).toContainEqual(expect.objectContaining({
      block: true,
      reason: expect.stringContaining("outside the granted artifact scope"),
    }));
    expect(sibling).toContainEqual(expect.objectContaining({
      reason: expect.stringContaining(".claude/specs/2026-08-12-foo"),
    }));
    // The repo root and the other artifact tree stay out of scope.
    const rootHit = await pi.emit("tool_call", {
      toolName: "edit",
      input: { path: "README.md" },
    }, { cwd: ROOT, sessionManager: { getSessionId: () => childSession } });
    expect(rootHit).toContainEqual(expect.objectContaining({ block: true }));
    const plansHit = await pi.emit("tool_call", {
      toolName: "write",
      input: { path: ".claude/plans/2026-08-12-foo.md", content: "# Plan" },
    }, { cwd: ROOT, sessionManager: { getSessionId: () => childSession } });
    expect(plansHit).toContainEqual(expect.objectContaining({ block: true }));
    // The state file itself is doubly protected (edit guard + scope).
    const stateHit = await pi.emit("tool_call", {
      toolName: "write",
      input: { path: ".claude/state/active_task_graph.json", content: "{}" },
    }, { cwd: ROOT, sessionManager: { getSessionId: () => childSession } });
    expect(stateHit).toContainEqual(expect.objectContaining({ block: true }));

    await pi.emit("session_shutdown", {}, {
      cwd: ROOT, sessionManager: { getSessionId: () => childSession },
    });
    expect(() => readFileSync(join(subagentDir, `${childSession}.active`), "utf-8")).toThrow();
  });

  it("gives no write grant to read-only spawns (reviewers, decompose, panel judges)", async () => {
    writeState({
      ...initialGraph(),
      phase_artifacts: { architecture: join(temp, "no-grant-plan.md") },
      skipped_phases: ["plan-alignment"],
      plan_file: join(temp, "no-grant-plan.md"),
    });
    writeFileSync(join(temp, "no-grant-plan.md"), "# Plan\n");
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad432";
    for (const [agent, task] of [
      // A REALISTIC judge prompt: the manifest and interview paths it must
      // READ are under .claude/specs/ — path mentions alone must never mint
      // a write grant for a read-only role.
      ["arch-judge-agent", "Candidate manifest: .claude/specs/2026-08-12-foo/panel-runs/run.abc/manifest.json\nValidated interview digest: .claude/specs/2026-08-12-foo/panel-runs/run.abc/interview.json\nScore the candidates. Return pure JSON."],
      ["decompose-agent", "Decompose the plan at .claude/plans/2026-08-12-foo.md into a task graph."],
      ["code-reviewer", "Task: T1\nReview the implementation."],
    ] as const) {
      // arch-judge and decompose run during the architecture phase; the
      // reviewer runs during execute.
      writeState({
        ...initialGraph(),
        current_phase: agent === "code-reviewer" ? "execute" : "architecture",
        phase_artifacts: {
          architecture: join(temp, "no-grant-plan.md"),
          ...(agent === "code-reviewer" ? {} : { specify: join(temp, "no-grant-spec.md") }),
        },
        skipped_phases: ["plan-alignment"],
        spec_file: agent === "code-reviewer" ? null : join(temp, "no-grant-spec.md"),
        plan_file: join(temp, "no-grant-plan.md"),
      });
      writeFileSync(join(temp, "no-grant-spec.md"), "# Spec\n");
      const input = { agentScope: "user", agent, task };
      const call = await pi.emit("tool_call", {
        toolName: "subagent",
        toolCallId: `call-no-grant-${agent}`,
        input,
      }, { cwd: ROOT, sessionManager: { getSessionId: () => session } });
      expect(call, agent).toEqual([undefined]);
      expect(input.task, agent).not.toMatch(/LOOM_PI_WRITE_GRANT:/);
    }

    // Positive control: a WRITER role (designer) with the same run-scoped
    // paths DOES receive a scoped grant — the policy is role-driven, not
    // path-absence-driven.
    writeState({
      ...initialGraph(),
      current_phase: "architecture",
      phase_artifacts: { architecture: join(temp, "no-grant-plan.md") },
      skipped_phases: ["plan-alignment"],
      spec_file: join(temp, "no-grant-spec.md"),
      plan_file: join(temp, "no-grant-plan.md"),
    });
    const designerInput = {
      agentScope: "user",
      agent: "arch-designer-agent",
      task: "Use the architecture-tech-lead skill.\nWrite your candidate to .claude/specs/2026-08-12-foo/panel-runs/run.abc/candidates/candidate-simplicity-first.md",
    };
    expect(await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId: "call-grant-designer",
      input: designerInput,
    }, { cwd: ROOT, sessionManager: { getSessionId: () => session } })).toEqual([undefined]);
    expect(designerInput.task).toMatch(/LOOM_PI_WRITE_GRANT:[0-9a-f]{64}/);
    // The real flow revokes outstanding grants when the parent subagent call
    // completes (tool_result) or the parent session ends — clean up so the
    // unconsumed designer grant cannot leak into sibling tests.
    await pi.emit("session_shutdown", {}, { cwd: ROOT, sessionManager: { getSessionId: () => session } });
  });

  it("blocks the panel interview stage under pi with an actionable diagnostic", async () => {
    writeState({
      ...initialGraph(),
      current_phase: "architecture",
      phase_artifacts: { architecture: join(temp, "no-grant-plan.md") },
      skipped_phases: ["plan-alignment"],
      spec_file: join(temp, "no-grant-spec.md"),
      plan_file: join(temp, "no-grant-plan.md"),
    });
    writeFileSync(join(temp, "no-grant-spec.md"), "# Spec\n");
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad437";
    const input = {
      agentScope: "user",
      agent: "arch-interviewer-agent",
      task: "Run the full questionnaire and write the digest to .claude/specs/x/panel-runs/run.y/interview.md",
    };
    const call = await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId: "call-panel-interview",
      input,
    }, { cwd: ROOT, sessionManager: { getSessionId: () => session } });
    expect(call).toContainEqual(expect.objectContaining({
      block: true,
      reason: expect.stringContaining("interview stage cannot run under pi"),
    }));
    expect(call).toContainEqual(expect.objectContaining({
      reason: expect.stringContaining("docs/pi-phase-agent-interviews.md"),
    }));
    // The spawn is refused up front: no grant, no roster entry, no pointer.
    // No grant was ever minted: the grants dir does not even exist.
    const grantDir = join(subagentDir, "pi-write-grants");
    expect(existsSync(grantDir) ? readdirSync(grantDir) : []).toEqual([]);
    expect(input.task).not.toMatch(/LOOM_PI_WRITE_GRANT:/);
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
    expect(readdirSync(grantDir).filter((name) => name.endsWith(".json"))).toEqual([]);
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
    const retryStderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await pi.emit("session_shutdown", {}, {
        cwd: ROOT, sessionManager: { getSessionId: () => parentSession },
      });
      expect(retryStderr.mock.calls.map(([text]) => String(text)).join(""))
        .not.toContain("shutdown cleanup failed");
    } finally {
      retryStderr.mockRestore();
    }
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

  it("reclaims an aged current-protocol reservation before adding the retry's own Pi roster row", async () => {
    // This scenario's premise is that no earlier agent is still serving the
    // graph. Other integration cases intentionally leave durable session
    // artifacts for reload tests, so give this liveness assertion a clean
    // registry rather than depending on file order.
    rmSync(subagentDir, { recursive: true, force: true });
    mkdirSync(subagentDir, { recursive: true });
    const planPath = join(temp, "current-reservation-retry-plan.md");
    writeFileSync(planPath, "# Plan\n");
    const strandedAt = new Date(Date.now() - 11 * 60_000).toISOString();
    writeState({
      ...initialGraph(),
      phase_artifacts: { architecture: planPath },
      skipped_phases: ["plan-alignment"],
      plan_file: planPath,
      executing_tasks: ["T1"],
      tasks: [{ ...initialGraph().tasks[0], reserved_at: strandedAt }],
    });
    const pi = await extension();
    const session = "019fca39-f989-7510-8e62-50dadbcad483";
    const context = { cwd: ROOT, sessionManager: { getSessionId: () => session } };
    const toolCallId = "call-current-reservation-retry";
    const prompt = "Task ID: T1\nUse the code-implementer skill. Implement and test.";

    const result = await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId,
      input: { agent: "code-implementer-agent", task: prompt, agentScope: "user" },
    }, context);

    expect(result).toEqual([undefined]);
    const retried = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(retried.executing_tasks).toEqual(["T1"]);
    expect(Date.parse(retried.tasks[0].reserved_at)).toBeGreaterThan(Date.parse(strandedAt));
    expect(readFileSync(join(subagentDir, `${session}.active`), "utf-8").trim()).not.toBe("");

    await pi.emit("tool_result", {
      toolName: "subagent",
      toolCallId,
      content: [],
      details: {
        results: [{ agent: "code-implementer-agent", task: prompt, exitCode: 1, messages: [] }],
      },
    }, context);
    expect(JSON.parse(readFileSync(statePath, "utf-8")).executing_tasks).toEqual([]);
    expect(() => readFileSync(join(subagentDir, `${session}.active`), "utf-8")).toThrow();
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

  /**
   * `piAllSlotsFailedNote` is thoroughly unit-tested in isolation, but nothing
   * pinned its WIRING into the tool_result handler — and a note that is never
   * written is indistinguishable from one that correctly stayed silent. Both
   * directions are asserted here, because the silent direction is what the
   * "one surviving sibling" case above already exercises and is exactly where
   * a dropped call would hide.
   */
  it("reports a whole-batch failure as a shared-infrastructure signature", async () => {
    const pi = await extension();
    const context = { sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad40b" } };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const first = reviewResult("Task: T1", "first failed", { exitCode: 1 }).details.results[0];
      const second = reviewResult("Task: T1", "second failed", { exitCode: 1 }).details.results[0];
      second.agent = "silent-failure-hunter";

      await pi.emit("tool_result", {
        toolName: "subagent",
        content: [],
        details: { results: [first, second] },
      }, context);

      const written = stderr.mock.calls.map(([text]) => String(text)).join("");
      expect(written).toContain("all 2 slots in this batch failed");
      expect(written).toContain("shared-infrastructure fault");
    } finally {
      stderr.mockRestore();
    }
  });

  it("stays silent about a shared fault when one slot in the batch survived", async () => {
    const pi = await extension();
    const context = { sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad40c" } };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const failed = reviewResult("Task: T1", "failed", { exitCode: 1 }).details.results[0];
      const healthy = reviewResult("Task: T1", "healthy").details.results[0];
      healthy.agent = "silent-failure-hunter";

      await pi.emit("tool_result", {
        toolName: "subagent",
        content: [],
        details: { results: [failed, healthy] },
      }, context);

      // A surviving sibling refutes the shared-fault reading outright.
      expect(stderr.mock.calls.map(([text]) => String(text)).join(""))
        .not.toContain("slots in this batch failed");
    } finally {
      stderr.mockRestore();
    }
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

  it("mints pi-structured evidence from a real-shaped green Bash test run", async () => {
    // LIVE-captured payload shapes (pi 0.83 --mode json child, 2026-08-12):
    // assistant message_end carries the bash toolCall block with
    // id/name/arguments; the toolResult arrives as a message_end with role
    // toolResult + toolCallId/toolName/isError and the runner output text.
    writeState({
      ...initialGraph(),
      executing_tasks: ["T1"],
      tasks: [{
        ...initialGraph().tasks[0],
        file_list: [],
        files_modified: ["packages/framework/src/__tests__/file-atomic.test.ts"],
        artifact_baseline: [],
        attempt_artifact_baseline: [{
          artifact: "packages/framework/src/__tests__/file-atomic.test.ts",
          snapshot: { kind: "missing" },
        }],
        new_tests_required: false,
      }],
    });
    const pi = await extension();
    const context = { sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad42e" } };
    await pi.emit("tool_result", {
      toolName: "subagent",
      content: [],
      details: {
        results: [{
          agent: "code-implementer-agent",
          task: "Task ID: T1",
          exitCode: 0,
          messages: [
            {
              role: "assistant",
              content: [{
                type: "toolCall",
                id: "chatcmpl-tool-structured-repro",
                name: "bash",
                arguments: {
                  command: "cd /home/peterstorm/dev/agentic/fugue && bun test packages/framework/src/__tests__/file-atomic.test.ts 2>&1 | tail -n 40",
                },
              }],
            },
            {
              role: "toolResult",
              toolCallId: "chatcmpl-tool-structured-repro",
              toolName: "bash",
              isError: false,
              content: [{
                type: "text",
                text: "bun test v1.3.13 (bf2e2cec)\n\nfile-atomic.test.ts:\n(pass) atomic commit\n\n 2142 pass\n 0 fail\n 1 expect() calls\nRan 1 test across 1 file. [11.00ms]\n",
              }],
            },
          ],
        }],
      },
    }, context);

    const task = JSON.parse(readFileSync(statePath, "utf-8")).tasks[0];
    expect(task.test_result).toMatchObject({
      verdict: "untrusted",
      passed: true,
      label: expect.stringMatching(/^pi-structured: /),
    });
    expect(task.proof.state).toBe("satisfied");
  });

  it.each([
    ["printf 'bun test\\n654 pass\\n'", "654 pass\n0 fail\n"],
    ["bun test | grep -v fail", "654 pass\n"],
    ["cd engine && bun test | grep -v fail", "654 pass\n"],
  ] as const)("keeps transcript fallback untrusted for test-looking command: %s", async (command, output) => {
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
            { role: "toolResult", toolCallId: "call-test", toolName: "bash", content: [{ type: "text", text: output }] },
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
      provenance: "unverified",
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

  it("rejects a malformed first result and still stores the second", async () => {
    // `agent: null` never reaches the loop's own try/catch any more: the
    // per-element parse rejects the element up front, which is the point —
    // a harness shape drift is a named diagnostic rather than whatever
    // `stripNamespace(null)` happened to throw. The isolation guarantee is
    // unchanged, and is what this asserts.
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
        .toContain("result 1 has an unrecognized shape (agent is object, expected string)");
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

  it("continues processing later Pi results when the first result throws", async () => {
    // A well-formed element that throws DOWNSTREAM — the case the loop's own
    // per-result try/catch exists for, and the one the malformed-shape test
    // above no longer reaches.
    const pi = await extension();
    const context = { sessionManager: { getSessionId: () => "019fca39-f989-7510-8e62-50dadbcad40a" } };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { StateManager } = await import("../src/state-manager");
    const update = vi.spyOn(StateManager.prototype, "update")
      .mockRejectedValueOnce(new Error("injected first-result failure"));
    try {
      const first = reviewResult("Task: T1", "first result discarded").details.results[0];
      const second = reviewResult("Task: T1", "second result still stored").details.results[0];
      const responses = await pi.emit("tool_result", {
        toolName: "subagent",
        content: [],
        details: { results: [first, second] },
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
      update.mockRestore();
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

/**
 * The Pi extension's fail-closed BACKSTOPS.
 *
 * Three refusals sit at the top of `tool_call` and had no test between them:
 * the outer catch that blocks the call when any loom guard throws, the
 * invalid-session-id spawn refusal, and the duplicate-`toolCallId` spawn
 * refusal. Each is the last thing standing between a malformed event and an
 * unguarded action, and each fails in the direction that matters only if it
 * actually runs — a regression turning any of them into a pass-through would
 * have been invisible.
 */
describe("Pi extension tool_call fail-closed backstops", () => {
  const extension = async () => {
    const extensionSpecifier = "../../pi/extension.ts";
    const module = await import(/* @vite-ignore */ extensionSpecifier) as {
      default: (pi: unknown) => void;
    };
    const pi = new FakePi();
    module.default(pi as never);
    return pi;
  };

  const SESSION = "019fca39-f989-7510-8e62-50dadbcad4a1";

  it("BLOCKS the call when a guard throws, naming the guard", async () => {
    const pi = await extension();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // A bash event whose `input.command` throws on read: the guard runs, the
      // read explodes inside it, and the outer catch must convert that into a
      // BLOCK. Returning allow — or letting the throw escape — would let an
      // unjudged bash command through while the operator believed the
      // state-file guard was armed.
      const results = await pi.emit("tool_call", {
        toolName: "bash",
        toolCallId: "call-guard-crash",
        input: new Proxy({}, {
          get(_target, property) {
            if (property === "command") throw new Error("synthetic guard fault");
            return undefined;
          },
        }),
      }, { cwd: ROOT, sessionManager: { getSessionId: () => SESSION } });

      expect(results).toContainEqual(expect.objectContaining({
        block: true,
        reason: expect.stringContaining("crashed (failing closed)"),
      }));
      expect(results).toContainEqual(expect.objectContaining({
        reason: expect.stringContaining("guard-state-file"),
      }));
      expect(results).toContainEqual(expect.objectContaining({
        reason: expect.stringContaining("synthetic guard fault"),
      }));
      expect(stderr.mock.calls.map(([text]) => String(text)).join(""))
        .toContain("blocking the call (fail-closed)");
    } finally {
      stderr.mockRestore();
    }
  });

  it("REFUSES a subagent spawn whose session id cannot be parsed", async () => {
    const pi = await extension();
    // Lifecycle evidence is keyed by session id and names files under the
    // subagent directory. An unparseable id cannot be recorded safely, so the
    // spawn is refused rather than started with no lifecycle binding — a
    // subagent nothing can later attribute or clean up.
    const results = await pi.emit("tool_call", {
      toolName: "subagent",
      toolCallId: "call-invalid-session",
      input: {
        agent: "code-reviewer",
        task: "LOOM_REVIEW_CONTEXT: standalone\nReview the exact frozen scope.",
        agentScope: "user",
      },
    }, { cwd: ROOT, sessionManager: { getSessionId: () => "../../etc/passwd" } });

    expect(results).toContainEqual(expect.objectContaining({
      block: true,
      reason: expect.stringContaining("invalid session id"),
    }));
    expect(results).toContainEqual(expect.objectContaining({
      reason: expect.stringContaining("refusing spawn"),
    }));
  });

  it("REFUSES a second spawn that reuses a live toolCallId in the same session", async () => {
    const pi = await extension();
    const context = { cwd: ROOT, sessionManager: { getSessionId: () => SESSION } };
    const input = {
      agent: "code-reviewer",
      task: "LOOM_REVIEW_CONTEXT: standalone\nReview the exact frozen scope.",
      agentScope: "user",
    };

    // The first spawn reserves lifecycle identity under this toolCallId.
    expect(await pi.emit("tool_call", {
      toolName: "subagent", toolCallId: "call-duplicate", input,
    }, context)).toEqual([undefined]);

    // The second must be refused: cleanup and result correlation are keyed by
    // toolCallId, so two live spawns sharing one would have their reservations
    // and write grants collide — the second silently inheriting or destroying
    // the first's bindings.
    const repeated = await pi.emit("tool_call", {
      toolName: "subagent", toolCallId: "call-duplicate", input,
    }, context);

    expect(repeated).toContainEqual(expect.objectContaining({
      block: true,
      reason: expect.stringContaining("Duplicate Pi subagent toolCallId"),
    }));
  });

  it("REFUSES a spawn with no toolCallId at all", async () => {
    const pi = await extension();
    const results = await pi.emit("tool_call", {
      toolName: "subagent",
      input: {
        agent: "code-reviewer",
        task: "LOOM_REVIEW_CONTEXT: standalone\nReview the exact frozen scope.",
        agentScope: "user",
      },
    }, { cwd: ROOT, sessionManager: { getSessionId: () => SESSION } });

    expect(results).toContainEqual(expect.objectContaining({
      block: true,
      reason: expect.stringContaining("without a subagent toolCallId"),
    }));
  });
});
