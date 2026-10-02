/**
 * Lazy exact implementation binding on Claude Code, end to end through the
 * real hook handlers.
 *
 * Claude Code fires SubagentStart before the child transcript exists and does
 * not honor a SubagentStart block. So SubagentStart records the roster row
 * and leaves the binding PENDING; the Agent's first tool call (any tool, via
 * bind-implementation-attempt, or the write itself, via block-direct-edits)
 * binds it from its own first prompt; and SubagentStop makes a last attempt.
 * Writes are admitted only once bound.
 *
 * block-direct-edits gates on the IMPORT-time TaskGraph path, so the graph
 * location is pinned in `vi.hoisted` before any engine module loads.
 */

import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "loom-lazy-binding-")));
  const statePath = path.join(root, "active_task_graph.json");
  fs.writeFileSync(statePath, "{}\n");
  process.env.LOOM_STATE_PATH = statePath;
  return { root, statePath };
});

import markActive from "../../src/handlers/subagent-start/mark-subagent-active";
import blockDirectEdits from "../../src/handlers/pre-tool-use/block-direct-edits";
import bindImplementationAttempt from "../../src/handlers/pre-tool-use/bind-implementation-attempt";
import dispatch from "../../src/handlers/subagent-stop/dispatch";
import {
  ensureImplementationBinding,
  ensureRosteredImplementationBinding,
} from "../../src/handlers/implementation-binding";
import { snapshotImplementationAttemptSidecar } from "../../src/implementation-attempt-sidecar";
import { projectSlug } from "../../src/utils/agent-transcript-path";
import {
  parseReportedAgentId,
  parseSessionId,
  readActiveAgentRoles,
  type AgentId,
  type SessionId,
} from "../../src/machine";
import {
  createImplementationAttemptAuthority,
  parseIsoInstant,
  parseReservationId,
  type ImplementationAttemptAuthority,
} from "../../src/core/implementation-completion";
import {
  authorizeImplementationSpawn,
  createImplementationAttemptContext,
} from "../../src/core/implementation-retry";
import { derivePendingTaskProof } from "../../src/core/proof-obligations";
import { StateManager } from "../../src/state-manager";
import { taskFixture } from "../fixtures/task-lifecycle";
import type { TaskGraph } from "../../src/types";

const ENGINE_ROOT = join(__dirname, "..", "..");
const { root: ROOT, statePath: STATE_PATH } = fixture;
const previous = {
  subagents: process.env.LOOM_SUBAGENT_DIR,
  project: process.env.CLAUDE_PROJECT_DIR,
  config: process.env.CLAUDE_CONFIG_DIR,
};

let headSha = "";
let caseDir = "";
let session = "";
let caseCounter = 0;

beforeAll(() => {
  execFileSync("git", ["init", "--quiet"], { cwd: ROOT });
  execFileSync("git", ["config", "user.email", "loom@example.test"], { cwd: ROOT });
  execFileSync("git", ["config", "user.name", "Loom Test"], { cwd: ROOT });
  writeFileSync(join(ROOT, ".gitignore"), ["active_task_graph.json", "cases/", ".task_graph*", ""].join("\n"));
  execFileSync("git", ["add", ".gitignore"], { cwd: ROOT });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture root"], { cwd: ROOT });
  headSha = execFileSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
});

beforeEach(() => {
  caseCounter += 1;
  caseDir = join(ROOT, "cases", `case-${caseCounter}`);
  mkdirSync(caseDir, { recursive: true });
  session = `lazy-binding-${caseCounter}`;
  process.env.LOOM_SUBAGENT_DIR = join(caseDir, "subagents");
  process.env.CLAUDE_CONFIG_DIR = join(caseDir, "claude-config");
  process.env.CLAUDE_PROJECT_DIR = ROOT;
  process.env.LOOM_STATE_PATH = STATE_PATH;
});

afterEach(() => {
  for (const [key, value] of [
    ["LOOM_SUBAGENT_DIR", previous.subagents],
    ["CLAUDE_PROJECT_DIR", previous.project],
    ["CLAUDE_CONFIG_DIR", previous.config],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(() => {
  delete process.env.LOOM_STATE_PATH;
  rmSync(ROOT, { recursive: true, force: true });
});

function authority(taskId: string): ImplementationAttemptAuthority {
  const instant = parseIsoInstant("2026-10-02T00:00:00.000Z");
  const reservation = parseReservationId(`lazy-${session}-${taskId}`);
  if (!instant.ok || !reservation.ok) throw new Error("fixture identity failed");
  const created = createImplementationAttemptAuthority({
    taskId, wave: 1, semanticAttempt: 1, reservationId: reservation.value,
    headSha, reservedAt: instant.value, taskScopeBaseline: [], dirtySetBaseline: [],
  });
  if (!created.ok) throw new Error(created.error.errors.join("; "));
  return created.value;
}

/** A Wave graph: the `executing` Tasks carry a modern attempt; the rest are merely pending. */
function writeGraph(
  taskIds: readonly string[],
  executing: readonly string[] = taskIds,
): Readonly<Record<string, ImplementationAttemptAuthority>> {
  const attempts = Object.fromEntries(executing.map((id) => [id, authority(id)]));
  const tasks = taskIds.map((id) => {
    const base = {
      id, description: `implementation ${id}`, agent: "code-implementer-agent",
      wave: 1, status: "pending" as const, depends_on: [], file_list: [],
      new_tests_required: false,
      proof: derivePendingTaskProof({ newTestsRequired: false, declaredArtifacts: [] }),
    };
    const attempt = attempts[id];
    if (attempt === undefined) return taskFixture(base);
    const admission = authorizeImplementationSpawn({ id }, `Task ID: ${id}`);
    if (!admission.ok) throw new Error(admission.error);
    return taskFixture({
      ...base,
      active_implementation_attempt: attempt,
      active_implementation_context: createImplementationAttemptContext({
        authority: attempt, prompt: `Task ID: ${id}`, admission,
      }),
      implementation_retry_protocol: 2,
      implementation_retry_history_start: 0,
      artifact_baseline: [], attempt_artifact_baseline: [], attempt_repository_baseline: [],
      reserved_at: attempt.reservedAt,
    });
  });
  const graph: TaskGraph = {
    current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
    spec_file: null, plan_file: null, current_wave: 1,
    executing_tasks: [...executing], tasks, wave_gates: {},
  };
  // StateManager leaves the State File read-only after an update.
  chmodSync(STATE_PATH, 0o600);
  writeFileSync(STATE_PATH, JSON.stringify(graph, null, 2));
  return attempts;
}

const readGraph = (): TaskGraph => JSON.parse(readFileSync(STATE_PATH, "utf8")) as TaskGraph;

const ids = (agent: string): Readonly<{ sessionId: SessionId; agentId: AgentId }> => ({
  sessionId: parseSessionId(session)!,
  agentId: parseReportedAgentId(agent)!,
});

/** Where Claude Code writes `agent`'s transcript — what the hooks derive. */
function transcriptPath(agent: string): string {
  return join(process.env.CLAUDE_CONFIG_DIR!, "projects", projectSlug(ROOT), session, "subagents", `agent-${agent}.jsonl`);
}

/** The harness flushing the child's transcript, prompt first. */
function writeTranscript(agent: string, prompt: string, ...tail: readonly unknown[]): void {
  const path = transcriptPath(agent);
  mkdirSync(join(path, ".."), { recursive: true });
  const lines = [{ type: "user", message: { role: "user", content: prompt } }, ...tail];
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}
const finished = { type: "assistant", message: { role: "assistant", content: "implementation finished" } };

const startInput = (agent: string) =>
  JSON.stringify({ session_id: session, agent_id: agent, agent_type: "loom:code-implementer-agent" });

const toolInput = (tool: string, agent: string | null) => JSON.stringify({
  session_id: session,
  ...(agent === null ? {} : { agent_id: agent }),
  tool_name: tool,
  tool_input: tool === "Read" ? { file_path: join(ROOT, ".gitignore") } : { file_path: join(ROOT, "src", "feature.ts") },
  cwd: ROOT,
});

async function start(agent: string): Promise<void> {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const result = await markActive(startInput(agent), []);
    expect(result).toEqual({ kind: "passthrough" });
    expect(stderr.mock.calls.map((call) => String(call[0])).join("")).toContain("binding deferred");
  } finally {
    stderr.mockRestore();
  }
}

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    return await run();
  } finally {
    stderr.mockRestore();
  }
}

const sidecarOf = (agent: string) => snapshotImplementationAttemptSidecar(session, agent);

describe("SubagentStart before the child transcript exists", () => {
  it("records the roster row and leaves the binding pending — never a block", async () => {
    writeGraph(["T1"]);

    await start("a-1");

    const { sessionId } = ids("a-1");
    expect(readActiveAgentRoles(sessionId)).toEqual([{ agentId: "a-1", agentType: "code-implementer-agent" }]);
    expect(sidecarOf("a-1")).toMatchObject({ kind: "authority-unavailable", failure: { kind: "missing-sidecar" } });
  });

  it("blocks a pending Agent's Edit as RETRIABLE while its transcript is still missing", async () => {
    writeGraph(["T1"]);
    await start("a-1");

    const result = await quietly(() => blockDirectEdits(toolInput("Edit", "a-1"), []));

    expect(result).toMatchObject({ kind: "block", message: expect.stringContaining("not yet available") });
    if (result.kind === "block") expect(result.message).toContain("retriable");
    expect(sidecarOf("a-1")).toMatchObject({ kind: "authority-unavailable", failure: { kind: "missing-sidecar" } });
  });

  it("keeps the main agent blocked while the only implementer is pending", async () => {
    writeGraph(["T1"]);
    await start("a-1");

    const result = await quietly(() => blockDirectEdits(toolInput("Write", null), []));

    expect(result).toMatchObject({ kind: "block", message: expect.stringContaining("Direct edits not allowed") });
  });
});

describe("the first tool call binds", () => {
  it("a read-only first call binds from the now-written prompt, and the next Edit is admitted", async () => {
    const attempts = writeGraph(["T1"]);
    await start("a-1");
    writeTranscript("a-1", "**Task ID:** T1\n\nImplement it.");

    expect(await bindImplementationAttempt(toolInput("Read", "a-1"), [])).toEqual({ kind: "passthrough" });

    expect(sidecarOf("a-1")).toMatchObject({
      kind: "authority-observed",
      sidecar: { agentId: "a-1", canonicalTaskGraphPath: STATE_PATH, authority: attempts.T1 },
    });
    expect(await blockDirectEdits(toolInput("Edit", "a-1"), [])).toEqual({ kind: "allow" });
  });

  it("an Edit as the very first call binds itself before deciding — no reliance on the binder hook", async () => {
    const attempts = writeGraph(["T1"]);
    await start("a-1");
    writeTranscript("a-1", "Task ID: T1");

    expect(await blockDirectEdits(toolInput("Edit", "a-1"), [])).toEqual({ kind: "allow" });
    expect(sidecarOf("a-1")).toMatchObject({ kind: "authority-observed", sidecar: { authority: attempts.T1 } });
  });

  it("a read-only call while the transcript is still missing proceeds and reports the deferral", async () => {
    writeGraph(["T1"]);
    await start("a-1");

    const result = await quietly(() => bindImplementationAttempt(toolInput("Read", "a-1"), []));

    expect(result).toMatchObject({ kind: "passthrough", systemMessage: expect.stringContaining("pending") });
  });

  it("the binder ignores main-agent calls and non-implementation subagents", async () => {
    writeGraph(["T1"]);
    await quietly(() => markActive(JSON.stringify({ session_id: session, agent_id: "r-1", agent_type: "loom:code-reviewer" }), []));
    writeTranscript("r-1", "Task ID: T1");

    expect(await bindImplementationAttempt(toolInput("Read", null), [])).toEqual({ kind: "passthrough" });
    expect(await bindImplementationAttempt(toolInput("Read", "r-1"), [])).toEqual({ kind: "passthrough" });
    expect(sidecarOf("r-1")).toMatchObject({ kind: "authority-unavailable", failure: { kind: "missing-sidecar" } });
  });
});

describe("parallel implementers of one type", () => {
  it("each binds to the Task its OWN prompt names", async () => {
    const attempts = writeGraph(["T1", "T2"]);
    await start("a-1");
    await start("a-2");
    writeTranscript("a-2", "Task ID: T2");
    writeTranscript("a-1", "Task ID: T1");

    expect(await blockDirectEdits(toolInput("Edit", "a-2"), [])).toEqual({ kind: "allow" });
    expect(await bindImplementationAttempt(toolInput("Grep", "a-1"), [])).toEqual({ kind: "passthrough" });

    expect(sidecarOf("a-1")).toMatchObject({ kind: "authority-observed", sidecar: { authority: attempts.T1 } });
    expect(sidecarOf("a-2")).toMatchObject({ kind: "authority-observed", sidecar: { authority: attempts.T2 } });
  });

  it("a bound sibling never lends write authority to a pending Agent", async () => {
    writeGraph(["T1", "T2"]);
    await start("a-1");
    await start("a-2");
    writeTranscript("a-1", "Task ID: T1");
    expect(await blockDirectEdits(toolInput("Edit", "a-1"), [])).toEqual({ kind: "allow" });

    const pending = await quietly(() => blockDirectEdits(toolInput("Edit", "a-2"), []));

    expect(pending).toMatchObject({ kind: "block", message: expect.stringContaining("not yet available") });
  });
});

describe("unprovable bindings refuse writes with the reason", () => {
  it.each([
    { name: "an unknown Task", executing: ["T1"], prompt: "Task ID: T9", reason: "names unknown Task T9" },
    { name: "a non-executing Task", executing: ["T1"], prompt: "Task ID: T2", reason: "Task T2 has no current modern implementation attempt" },
    { name: "no Task at all", executing: ["T1"], prompt: "Implement the change", reason: "contains no Task id" },
  ])("blocks the Edit of an Agent whose prompt names $name", async ({ executing, prompt, reason }) => {
    writeGraph(["T1", "T2"], executing);
    await start("a-1");
    writeTranscript("a-1", prompt);

    const result = await blockDirectEdits(toolInput("Edit", "a-1"), []);

    expect(result).toMatchObject({ kind: "block", message: expect.stringContaining("refused") });
    if (result.kind === "block") expect(result.message).toContain(reason);
    expect(sidecarOf("a-1")).toMatchObject({ kind: "authority-unavailable", failure: { kind: "missing-sidecar" } });
    // The binder surfaces the same refusal on a read-only call, without blocking it.
    expect(await quietly(() => bindImplementationAttempt(toolInput("Read", "a-1"), [])))
      .toMatchObject({ kind: "passthrough", systemMessage: expect.stringContaining(reason) });
  });
});

describe("idempotent and race-safe binding", () => {
  it("repeated binding is idempotent: published once, then observed (running) or already-owned (spawn)", async () => {
    const attempts = writeGraph(["T1"]);
    await start("a-1");
    writeTranscript("a-1", "Task ID: T1");
    const { sessionId, agentId } = ids("a-1");
    const roster = readActiveAgentRoles(sessionId);

    expect(ensureRosteredImplementationBinding({ sessionId, agentId, roster }))
      .toEqual({ kind: "bound", authority: attempts.T1, publication: "published" });
    expect(ensureRosteredImplementationBinding({ sessionId, agentId, roster }))
      .toEqual({ kind: "bound", authority: attempts.T1, publication: "observed" });
    expect(ensureImplementationBinding({
      sessionId, agentId, graph: StateManager.fromPath(STATE_PATH)!, existingSidecar: "reprove",
    })).toEqual({ kind: "bound", authority: attempts.T1, publication: "already-owned" });
  });

  it("concurrent first calls from one child publish exactly one sidecar and leave no staged file", async () => {
    const attempts = writeGraph(["T1"]);
    await start("a-1");
    writeTranscript("a-1", "Task ID: T1");

    const run = () => new Promise<number | null>((resolve, reject) => {
      const child = spawn("bun", [join(ENGINE_ROOT, "src", "cli.ts"), "pre-tool-use", "bind-implementation-attempt"], {
        env: { ...process.env },
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.on("error", reject);
      child.on("close", resolve);
      child.stdin.end(toolInput("Read", "a-1"));
    });
    const statuses = await Promise.all([run(), run(), run(), run()]);

    expect(statuses).toEqual([0, 0, 0, 0]);
    expect(sidecarOf("a-1")).toMatchObject({ kind: "authority-observed", sidecar: { authority: attempts.T1 } });
    const leftovers = readdirSync(process.env.LOOM_SUBAGENT_DIR!).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  }, 30_000);
});

describe("SubagentStop of an Agent still pending", () => {
  const stopInput = (agent: string) => JSON.stringify({
    session_id: session, agent_id: agent, agent_type: "code-implementer-agent",
  });

  it("binds from the now-existing transcript and settles exactly its own Task", async () => {
    const attempts = writeGraph(["T1", "T2"]);
    await start("a-1");
    writeTranscript("a-1", "Task ID: T1", finished);

    const result = await quietly(() => dispatch(stopInput("a-1"), []));

    if (result.kind === "error" || result.kind === "block") throw new Error(result.message);
    const stored = readGraph();
    expect(stored.tasks.find((task) => task.id === "T1")).toMatchObject({
      status: "implemented",
      implementation_attempt_history: [{ authorityDigest: attempts.T1.authorityDigest }],
    });
    // The sibling's exact authority is untouched.
    expect(stored.executing_tasks).toEqual(["T2"]);
    expect(stored.tasks.find((task) => task.id === "T2")?.active_implementation_attempt).toEqual(attempts.T2);
  });

  it("reports explicitly and preserves every attempt when no transcript can prove the binding", async () => {
    const attempts = writeGraph(["T1", "T2"]);
    await start("a-1");

    const result = await quietly(() => dispatch(stopInput("a-1"), []));

    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("still pending at SubagentStop") });
    const stored = readGraph();
    expect(stored.executing_tasks).toEqual(["T1", "T2"]);
    expect(stored.tasks.map((task) => task.active_implementation_attempt)).toEqual([attempts.T1, attempts.T2]);
    // Cleanup still released the Agent's runtime capabilities.
    expect(readActiveAgentRoles(ids("a-1").sessionId)).toEqual([]);
  });
});
