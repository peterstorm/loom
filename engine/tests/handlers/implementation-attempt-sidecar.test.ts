import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import markActive from "../../src/handlers/subagent-start/mark-subagent-active";
import dispatch from "../../src/handlers/subagent-stop/dispatch";
import cleanupSubagentFlag from "../../src/handlers/subagent-stop/cleanup-subagent-flag";
import {
  implementationAttemptSidecarLeaf,
  publishImplementationAttemptSidecar,
  publishSidecarBytes,
  snapshotImplementationAttemptSidecar,
} from "../../src/implementation-attempt-sidecar";
import {
  createImplementationAttemptAuthority,
  parseIsoInstant,
  parseReservationId,
  type ImplementationAttemptAuthority,
} from "../../src/core/implementation-completion";
import { countActiveAgents, machineBindingPath, parseSessionId } from "../../src/machine";
import { taskFixture } from "../fixtures/task-lifecycle";
import type { Task, TaskGraph } from "../../src/types";
import { derivePendingTaskProof } from "../../src/core/proof-obligations";

const roots: string[] = [];
const previousDir = process.env.LOOM_SUBAGENT_DIR;
const previousState = process.env.LOOM_STATE_PATH;
const previousProject = process.env.CLAUDE_PROJECT_DIR;
const SESSION = "sidecar-session";
const SESSION_ID = parseSessionId(SESSION)!;
const AGENT = "agent-sidecar";

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "loom-sidecar-"));
  roots.push(value);
  process.env.LOOM_SUBAGENT_DIR = join(value, "subagents");
  process.env.CLAUDE_PROJECT_DIR = value;
  execFileSync("git", ["init", "--quiet"], { cwd: value });
  execFileSync("git", ["config", "user.email", "loom@example.test"], { cwd: value });
  execFileSync("git", ["config", "user.name", "Loom Test"], { cwd: value });
  writeFileSync(join(value, ".gitkeep"), "fixture\n");
  execFileSync("git", ["add", ".gitkeep"], { cwd: value });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture root"], { cwd: value });
  return value;
}

function authority(taskId = "T1", reservation = "sidecar-reservation"): ImplementationAttemptAuthority {
  const instant = parseIsoInstant("2026-08-24T00:00:00.000Z");
  const reservationId = parseReservationId(reservation);
  if (!instant.ok || !reservationId.ok) throw new Error("fixture identity failed");
  const created = createImplementationAttemptAuthority({
    taskId,
    wave: 1,
    semanticAttempt: 1,
    reservationId: reservationId.value,
    headSha: execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: process.env.CLAUDE_PROJECT_DIR,
      encoding: "utf8",
    }).trim(),
    reservedAt: instant.value,
    taskScopeBaseline: [],
    dirtySetBaseline: [],
  });
  if (!created.ok) throw new Error(created.error.errors.join("; "));
  return created.value;
}

function modernGraph(
  path: string,
  attempt = authority(),
  taskOverrides: Partial<Task> = {},
): TaskGraph {
  const task = taskFixture({
    id: "T1",
    description: "implementation",
    agent: "code-implementer-agent",
    wave: 1,
    status: "pending",
    depends_on: [],
    file_list: [],
    active_implementation_attempt: attempt,
    artifact_baseline: [],
    attempt_artifact_baseline: [],
    attempt_repository_baseline: [],
    reserved_at: attempt.reservedAt,
    ...taskOverrides,
  });
  const graph: TaskGraph = {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    executing_tasks: ["T1"],
    tasks: [task],
    wave_gates: {},
  };
  writeFileSync(path, JSON.stringify(graph, null, 2));
  return graph;
}

function transcript(path: string, lines: readonly unknown[]): void {
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

const user = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const assistant = (text: string) => ({ type: "assistant", message: { role: "assistant", content: text } });

function startInput(transcriptPath: string): string {
  return JSON.stringify({
    session_id: SESSION,
    agent_id: AGENT,
    agent_type: "code-implementer-agent",
    agent_transcript_path: transcriptPath,
  });
}

async function settleInvalidModernRecord(
  invalidRecord: string,
  reservation: string,
): Promise<Readonly<{ result: Awaited<ReturnType<typeof dispatch>>; stored: TaskGraph }>> {
  const dir = root();
  const statePath = join(dir, "active_task_graph.json");
  const attempt = authority("T1", reservation);
  modernGraph(statePath, attempt, {
    new_tests_required: false,
    proof: derivePendingTaskProof({ newTestsRequired: false, declaredArtifacts: [] }),
  });
  process.env.LOOM_STATE_PATH = statePath;
  mkdirSync(process.env.LOOM_SUBAGENT_DIR!, { recursive: true });
  writeFileSync(join(process.env.LOOM_SUBAGENT_DIR!, `${SESSION}.task_graph`), statePath);
  const transcriptPath = join(dir, "agent.jsonl");
  writeFileSync(transcriptPath, `${JSON.stringify(user("Task ID: T1"))}\n${invalidRecord}\n`);
  publishImplementationAttemptSidecar({
    sessionId: SESSION,
    agentId: AGENT,
    taskGraphPath: statePath,
    authority: attempt,
  });
  const result = await dispatch(JSON.stringify({
    session_id: SESSION,
    agent_id: AGENT,
    agent_type: "code-implementer-agent",
    agent_transcript_path: transcriptPath,
  }), []);
  return {
    result,
    stored: JSON.parse(readFileSync(statePath, "utf8")) as TaskGraph,
  };
}

afterEach(() => {
  if (previousDir === undefined) delete process.env.LOOM_SUBAGENT_DIR;
  else process.env.LOOM_SUBAGENT_DIR = previousDir;
  if (previousState === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = previousState;
  if (previousProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = previousProject;
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("Claude implementation authority sidecar", () => {
  it("binds from only the trusted first user prompt and publishes exact authority before start", async () => {
    const dir = root();
    const statePath = join(dir, "active_task_graph.json");
    const attempt = authority();
    modernGraph(statePath, attempt);
    process.env.LOOM_STATE_PATH = statePath;
    const transcriptPath = join(dir, "agent.jsonl");
    transcript(transcriptPath, [user("Task ID: T1"), assistant("Task ID: T999")]);

    const result = await markActive(startInput(transcriptPath), []);
    expect(result.kind).toBe("passthrough");
    expect(snapshotImplementationAttemptSidecar(SESSION, AGENT)).toEqual({
      kind: "authority-observed",
      sidecar: expect.objectContaining({
        sessionId: SESSION,
        agentId: AGENT,
        canonicalTaskGraphPath: statePath,
        authority: attempt,
      }),
    });
    expect(countActiveAgents(SESSION_ID)).toBe(1);
    expect(readFileSync(machineBindingPath(SESSION_ID), "utf8")).toContain(AGENT);
  });

  it("blocks an implementation start when the bound Task has only a legacy reservation", async () => {
    const dir = root();
    const statePath = join(dir, "active_task_graph.json");
    const legacy = taskFixture({
      id: "T1", description: "legacy", agent: "code-implementer-agent",
      wave: 1, status: "pending", depends_on: [], file_list: [],
    });
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, current_wave: 1,
      executing_tasks: ["T1"], tasks: [legacy], wave_gates: {},
    }, null, 2));
    process.env.LOOM_STATE_PATH = statePath;
    const transcriptPath = join(dir, "agent.jsonl");
    transcript(transcriptPath, [user("Task ID: T1")]);

    const result = await markActive(startInput(transcriptPath), []);
    expect(result).toMatchObject({
      kind: "block",
      message: expect.stringContaining("no current modern implementation attempt"),
    });
    expect(countActiveAgents(SESSION_ID)).toBe(0);
  });

  it.each([
    {
      name: "missing Task in the trusted first prompt",
      lines: [user("Implement the requested change"), assistant("Task ID: T1")],
      message: "trusted first user prompt contains no Task id",
    },
    {
      name: "malformed bytes before the trusted prompt",
      lines: null,
      message: "malformed transcript JSON before the first user prompt",
    },
  ])("blocks $name and rolls back roster, machine binding, and sidecar", async ({ lines, message }) => {
    const dir = root();
    const statePath = join(dir, "active_task_graph.json");
    modernGraph(statePath);
    process.env.LOOM_STATE_PATH = statePath;
    const transcriptPath = join(dir, "agent.jsonl");
    if (lines === null) writeFileSync(transcriptPath, "not-json\n" + JSON.stringify(user("Task ID: T1")));
    else transcript(transcriptPath, lines);

    const result = await markActive(startInput(transcriptPath), []);
    expect(result).toMatchObject({ kind: "block", message: expect.stringContaining(message) });
    expect(countActiveAgents(SESSION_ID)).toBe(0);
    expect(snapshotImplementationAttemptSidecar(SESSION, AGENT)).toMatchObject({
      kind: "authority-unavailable",
      failure: { kind: "missing-sidecar" },
    });
  });

  it("snapshots authority before cleanup removes the sidecar and dispatches settlement", async () => {
    const dir = root();
    const statePath = join(dir, "active_task_graph.json");
    const attempt = authority();
    modernGraph(statePath, attempt);
    process.env.LOOM_STATE_PATH = statePath;
    mkdirSync(process.env.LOOM_SUBAGENT_DIR!, { recursive: true });
    writeFileSync(join(process.env.LOOM_SUBAGENT_DIR!, `${SESSION}.task_graph`), statePath);
    const transcriptPath = join(dir, "agent.jsonl");
    transcript(transcriptPath, [user("Task ID: T1"), assistant("implementation finished")]);
    publishImplementationAttemptSidecar({ sessionId: SESSION, agentId: AGENT, taskGraphPath: statePath, authority: attempt });

    const result = await dispatch(JSON.stringify({
      session_id: SESSION,
      agent_id: AGENT,
      agent_type: "code-implementer-agent",
      agent_transcript_path: transcriptPath,
    }), []);
    if (result.kind === "error" || result.kind === "block") throw new Error(result.message);
    expect(result.kind).toBe("passthrough");
    expect(snapshotImplementationAttemptSidecar(SESSION, AGENT)).toMatchObject({
      kind: "authority-unavailable",
      failure: { kind: "missing-sidecar" },
    });
    const stored = JSON.parse(readFileSync(statePath, "utf8")) as TaskGraph;
    expect(stored.executing_tasks).toEqual([]);
    expect(stored.tasks[0]?.active_implementation_attempt).toBeUndefined();
  });

  it("routes an exact modern sidecar even when Claude omits agent_type metadata", async () => {
    const dir = root();
    const statePath = join(dir, "active_task_graph.json");
    const attempt = authority("T1", "claude-sidecar-route");
    modernGraph(statePath, attempt, {
      new_tests_required: false,
      proof: derivePendingTaskProof({ newTestsRequired: false, declaredArtifacts: [] }),
    });
    process.env.LOOM_STATE_PATH = statePath;
    mkdirSync(process.env.LOOM_SUBAGENT_DIR!, { recursive: true });
    writeFileSync(join(process.env.LOOM_SUBAGENT_DIR!, `${SESSION}.task_graph`), statePath);
    const transcriptPath = join(dir, "agent.jsonl");
    transcript(transcriptPath, [user("Task ID: T1"), assistant("implementation finished")]);
    publishImplementationAttemptSidecar({
      sessionId: SESSION, agentId: AGENT, taskGraphPath: statePath, authority: attempt,
    });

    const result = await dispatch(JSON.stringify({
      session_id: SESSION,
      agent_id: AGENT,
      agent_transcript_path: transcriptPath,
    }), []);

    expect(result.kind).toBe("passthrough");
    const stored = JSON.parse(readFileSync(statePath, "utf8")) as TaskGraph;
    expect(stored.tasks[0]).toMatchObject({
      status: "implemented",
      implementation_attempt_history: [{ authorityDigest: attempt.authorityDigest }],
    });
  });

  it("implements an exact modern Claude attempt only through an Oracle receipt", async () => {
    const dir = root();
    const statePath = join(dir, "active_task_graph.json");
    const attempt = authority("T1", "claude-positive-oracle");
    modernGraph(statePath, attempt, {
      new_tests_required: false,
      proof: derivePendingTaskProof({ newTestsRequired: false, declaredArtifacts: [] }),
    });
    process.env.LOOM_STATE_PATH = statePath;
    mkdirSync(process.env.LOOM_SUBAGENT_DIR!, { recursive: true });
    writeFileSync(join(process.env.LOOM_SUBAGENT_DIR!, `${SESSION}.task_graph`), statePath);
    const transcriptPath = join(dir, "agent.jsonl");
    transcript(transcriptPath, [user("Task ID: T1"), assistant("implementation finished")]);
    publishImplementationAttemptSidecar({
      sessionId: SESSION,
      agentId: AGENT,
      taskGraphPath: statePath,
      authority: attempt,
    });

    const result = await dispatch(JSON.stringify({
      session_id: SESSION,
      agent_id: AGENT,
      agent_type: "code-implementer-agent",
      agent_transcript_path: transcriptPath,
    }), []);
    expect(result.kind).toBe("passthrough");
    const stored = JSON.parse(readFileSync(statePath, "utf8")) as TaskGraph;
    expect(stored.executing_tasks).toEqual([]);
    expect(stored.tasks[0]).toMatchObject({
      status: "implemented",
      proof: { state: "satisfied" },
      implementation_attempt_history: [{
        authorityDigest: attempt.authorityDigest,
        transition: "implemented",
        consumesSemanticAttempt: false,
      }],
    });
    expect(stored.tasks[0]?.active_implementation_attempt).toBeUndefined();
    expect(stored.wave_gates["1"]?.impl_complete).toBe(true);
  });

  it("settles a modern stop with no resolvable transcript as exact infrastructure and releases only that authority", async () => {
    const dir = root();
    const statePath = join(dir, "active_task_graph.json");
    const attempt = authority("T1", "claude-missing-transcript");
    modernGraph(statePath, attempt, {
      new_tests_required: false,
      proof: derivePendingTaskProof({ newTestsRequired: false, declaredArtifacts: [] }),
    });
    process.env.LOOM_STATE_PATH = statePath;
    mkdirSync(process.env.LOOM_SUBAGENT_DIR!, { recursive: true });
    writeFileSync(join(process.env.LOOM_SUBAGENT_DIR!, `${SESSION}.task_graph`), statePath);
    publishImplementationAttemptSidecar({
      sessionId: SESSION,
      agentId: AGENT,
      taskGraphPath: statePath,
      authority: attempt,
    });

    const result = await dispatch(JSON.stringify({
      session_id: SESSION,
      agent_id: AGENT,
      agent_type: "code-implementer-agent",
    }), []);

    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("no resolvable transcript path"),
    });
    expect(result).toMatchObject({
      message: expect.stringContaining("exact non-consuming infrastructure Oracle receipt"),
    });
    const stored = JSON.parse(readFileSync(statePath, "utf8")) as TaskGraph;
    expect(stored.executing_tasks).toEqual([]);
    expect(stored.tasks[0]).toMatchObject({
      status: "pending",
      revalidation_required: true,
      implementation_attempt_history: [{
        authorityDigest: attempt.authorityDigest,
        transition: "infrastructure-blocked",
        consumesSemanticAttempt: false,
      }],
    });
    expect(stored.tasks[0]?.active_implementation_attempt).toBeUndefined();
    expect(stored.tasks[0]).not.toHaveProperty("test_result");
    expect(stored.wave_gates["1"]?.impl_complete).toBe(false);
  });

  it("settles a valid partial transcript with a malformed tail as non-consuming infrastructure, never implemented", async () => {
    const dir = root();
    const statePath = join(dir, "active_task_graph.json");
    const attempt = authority("T1", "claude-malformed-tail");
    modernGraph(statePath, attempt, {
      new_tests_required: false,
      proof: derivePendingTaskProof({ newTestsRequired: false, declaredArtifacts: [] }),
    });
    process.env.LOOM_STATE_PATH = statePath;
    mkdirSync(process.env.LOOM_SUBAGENT_DIR!, { recursive: true });
    writeFileSync(join(process.env.LOOM_SUBAGENT_DIR!, `${SESSION}.task_graph`), statePath);
    const transcriptPath = join(dir, "agent.jsonl");
    writeFileSync(transcriptPath, [
      JSON.stringify(user("Task ID: T1")),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Implementation complete; focused tests pass." },
            { type: "tool_use", name: "Bash", input: { command: "npx vitest run focused.test.ts" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "1 passed (1)" }] },
      }),
      '{"type":"assistant","message":',
    ].join("\n"));
    publishImplementationAttemptSidecar({
      sessionId: SESSION,
      agentId: AGENT,
      taskGraphPath: statePath,
      authority: attempt,
    });

    const result = await dispatch(JSON.stringify({
      session_id: SESSION,
      agent_id: AGENT,
      agent_type: "code-implementer-agent",
      agent_transcript_path: transcriptPath,
    }), []);

    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("exact non-consuming infrastructure Oracle receipt"),
    });
    const stored = JSON.parse(readFileSync(statePath, "utf8")) as TaskGraph;
    expect(stored.executing_tasks).toEqual([]);
    expect(stored.tasks[0]).toMatchObject({
      status: "pending",
      revalidation_required: true,
      implementation_attempt_history: [{
        authorityDigest: attempt.authorityDigest,
        transition: "infrastructure-blocked",
        consumesSemanticAttempt: false,
      }],
    });
    expect(stored.tasks[0]?.active_implementation_attempt).toBeUndefined();
    expect(stored.tasks[0]).not.toHaveProperty("test_result");
    expect(stored.wave_gates["1"]?.impl_complete).toBe(false);
  });

  it.each([
    ["empty object", "{}"],
    ["null", "null"],
    ["scalar", "42"],
    ["array", "[]"],
    ["unknown content block", '{"type":"assistant","message":{"role":"assistant","content":[{"type":"future_block","text":"done"}]}}'],
    ["misspelled content block", '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_uses","id":"tool-1","name":"Bash","input":{}}]}}'],
    ["invalid tail", '{"type":"assistant","message":'],
  ])("settles a syntactically invalid or schema-invalid modern %s as non-consuming infrastructure", async (name, invalidRecord) => {
    const { result, stored } = await settleInvalidModernRecord(
      invalidRecord,
      `claude-invalid-${name.replace(/[^a-z]+/g, "-")}`,
    );
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("exact non-consuming infrastructure Oracle receipt"),
    });
    expect(stored.tasks[0]).toMatchObject({
      status: "pending",
      revalidation_required: true,
      implementation_attempt_history: [{
        transition: "infrastructure-blocked",
        consumesSemanticAttempt: false,
      }],
    });
    expect(stored.tasks[0]?.active_implementation_attempt).toBeUndefined();
    expect(stored.tasks[0]).not.toHaveProperty("test_result");
    expect(stored.wave_gates["1"]?.impl_complete).toBe(false);
  });

  it("rejects a foreign canonical TaskGraph sidecar and preserves the current attempt", async () => {
    const dir = root();
    const statePath = join(dir, "active_task_graph.json");
    const foreignPath = join(dir, "foreign-task-graph.json");
    const attempt = authority("T1", "claude-foreign-graph");
    modernGraph(statePath, attempt);
    modernGraph(foreignPath, attempt);
    process.env.LOOM_STATE_PATH = statePath;
    mkdirSync(process.env.LOOM_SUBAGENT_DIR!, { recursive: true });
    writeFileSync(join(process.env.LOOM_SUBAGENT_DIR!, `${SESSION}.task_graph`), statePath);
    const transcriptPath = join(dir, "agent.jsonl");
    transcript(transcriptPath, [user("Task ID: T1"), assistant("finished")]);
    publishImplementationAttemptSidecar({
      sessionId: SESSION, agentId: AGENT, taskGraphPath: foreignPath, authority: attempt,
    });

    const result = await dispatch(JSON.stringify({
      session_id: SESSION,
      agent_id: AGENT,
      agent_transcript_path: transcriptPath,
    }), []);

    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("different canonical TaskGraph") });
    const stored = JSON.parse(readFileSync(statePath, "utf8")) as TaskGraph;
    expect(stored.executing_tasks).toEqual(["T1"]);
    expect(stored.tasks[0]?.active_implementation_attempt).toEqual(attempt);
    expect(stored.tasks[0]?.implementation_attempt_history ?? []).toEqual([]);
  });

  it("treats duplicate Claude delivery as idempotent and retains one receipt", async () => {
    const dir = root();
    const statePath = join(dir, "active_task_graph.json");
    const attempt = authority("T1", "claude-duplicate-delivery");
    modernGraph(statePath, attempt, {
      new_tests_required: false,
      proof: derivePendingTaskProof({ newTestsRequired: false, declaredArtifacts: [] }),
    });
    process.env.LOOM_STATE_PATH = statePath;
    mkdirSync(process.env.LOOM_SUBAGENT_DIR!, { recursive: true });
    writeFileSync(join(process.env.LOOM_SUBAGENT_DIR!, `${SESSION}.task_graph`), statePath);
    const transcriptPath = join(dir, "agent.jsonl");
    transcript(transcriptPath, [user("Task ID: T1"), assistant("finished")]);
    const stop = JSON.stringify({ session_id: SESSION, agent_id: AGENT, agent_transcript_path: transcriptPath });

    publishImplementationAttemptSidecar({ sessionId: SESSION, agentId: AGENT, taskGraphPath: statePath, authority: attempt });
    expect((await dispatch(stop, [])).kind).toBe("passthrough");
    publishImplementationAttemptSidecar({ sessionId: SESSION, agentId: AGENT, taskGraphPath: statePath, authority: attempt });
    expect((await dispatch(stop, [])).kind).toBe("passthrough");

    const stored = JSON.parse(readFileSync(statePath, "utf8")) as TaskGraph;
    expect(stored.tasks[0]?.implementation_attempt_history).toHaveLength(1);
    expect(stored.tasks[0]?.implementation_attempt_history?.[0]?.authorityDigest).toBe(attempt.authorityDigest);
  });

  it.each(["missing", "malformed"] as const)(
    "a %s stop sidecar cannot positively settle or release a modern attempt",
    async (scenario) => {
      const dir = root();
      const statePath = join(dir, "active_task_graph.json");
      const attempt = authority();
      modernGraph(statePath, attempt);
      process.env.LOOM_STATE_PATH = statePath;
      mkdirSync(process.env.LOOM_SUBAGENT_DIR!, { recursive: true });
      writeFileSync(join(process.env.LOOM_SUBAGENT_DIR!, `${SESSION}.task_graph`), statePath);
      const transcriptPath = join(dir, "agent.jsonl");
      transcript(transcriptPath, [user("Task ID: T1"), assistant("finished")]);
      if (scenario === "malformed") {
        writeFileSync(
          join(process.env.LOOM_SUBAGENT_DIR!, implementationAttemptSidecarLeaf(SESSION, AGENT)!),
          "{broken",
        );
      }

      const result = await dispatch(JSON.stringify({
        session_id: SESSION,
        agent_id: AGENT,
        agent_type: "code-implementer-agent",
        agent_transcript_path: transcriptPath,
      }), []);
      expect(result).toMatchObject({ kind: "error", message: expect.stringContaining(`${scenario}-sidecar`) });
      const stored = JSON.parse(readFileSync(statePath, "utf8")) as TaskGraph;
      expect(stored.executing_tasks).toEqual(["T1"]);
      expect(stored.tasks[0]?.active_implementation_attempt).toEqual(attempt);
    },
  );

  it("retains primary publication and temporary cleanup failures through the plain operation seam", () => {
    const primary = new Error("link publication failed");
    const cleanup = new Error("temporary cleanup failed");
    let thrown: unknown;
    try {
      publishSidecarBytes("attempt.json", Buffer.from("authority"), {
        writeStaged: () => undefined,
        publishNoReplace: () => { throw primary; },
        readLive: () => Buffer.from("unused"),
        removeStaged: () => { throw cleanup; },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown).toMatchObject({
      message: expect.stringContaining("publication and temporary-file cleanup both failed"),
      errors: [primary, cleanup],
    });
  });

  it("publishes idempotently for identical bytes and never overwrites a different live authority", () => {
    const dir = root();
    const statePath = join(dir, "active_task_graph.json");
    modernGraph(statePath);
    const first = authority("T1", "sidecar-first");
    const second = authority("T1", "sidecar-second");
    publishImplementationAttemptSidecar({
      sessionId: SESSION,
      agentId: AGENT,
      taskGraphPath: statePath,
      authority: first,
    });
    expect(() => publishImplementationAttemptSidecar({
      sessionId: SESSION,
      agentId: AGENT,
      taskGraphPath: statePath,
      authority: first,
    })).not.toThrow();
    expect(() => publishImplementationAttemptSidecar({
      sessionId: SESSION,
      agentId: AGENT,
      taskGraphPath: statePath,
      authority: second,
    })).toThrow(/already binds different bytes/);
    expect(snapshotImplementationAttemptSidecar(SESSION, AGENT)).toMatchObject({
      kind: "authority-observed",
      sidecar: { authority: first },
    });
  });

  it("rolls back the identified exact registration when a different live sidecar wins publication", async () => {
    const dir = root();
    const statePath = join(dir, "active_task_graph.json");
    const current = authority("T1", "sidecar-current-registration");
    const winner = authority("T1", "sidecar-race-winner");
    modernGraph(statePath, current);
    process.env.LOOM_STATE_PATH = statePath;
    const transcriptPath = join(dir, "agent.jsonl");
    transcript(transcriptPath, [user("Task ID: T1")]);
    publishImplementationAttemptSidecar({
      sessionId: SESSION,
      agentId: AGENT,
      taskGraphPath: statePath,
      authority: winner,
    });

    const result = await markActive(startInput(transcriptPath), []);
    expect(result).toMatchObject({ kind: "block", message: expect.stringContaining("different bytes") });
    const stored = JSON.parse(readFileSync(statePath, "utf8")) as TaskGraph;
    expect(stored.executing_tasks).toEqual([]);
    expect(stored.tasks[0]?.active_implementation_attempt).toBeUndefined();
    expect(stored.tasks[0]?.implementation_attempt_history).toContainEqual(expect.objectContaining({
      authorityDigest: current.authorityDigest,
      transition: "infrastructure-blocked",
    }));
    expect(snapshotImplementationAttemptSidecar(SESSION, AGENT)).toMatchObject({
      kind: "authority-observed",
      sidecar: { authority: winner },
    });
  });

  it("keeps missing and malformed sidecars explicit", () => {
    const dir = root();
    mkdirSync(process.env.LOOM_SUBAGENT_DIR!, { recursive: true });
    expect(snapshotImplementationAttemptSidecar(SESSION, AGENT)).toMatchObject({
      kind: "authority-unavailable",
      failure: { kind: "missing-sidecar" },
    });
    const leaf = implementationAttemptSidecarLeaf(SESSION, AGENT)!;
    writeFileSync(join(process.env.LOOM_SUBAGENT_DIR!, leaf), "{broken");
    expect(snapshotImplementationAttemptSidecar(SESSION, AGENT)).toMatchObject({
      kind: "authority-unavailable",
      failure: { kind: "malformed-sidecar" },
    });
    expect(dir).toBeTruthy();
  });

  it("refuses sidecar leaf and directory symlinks without touching their targets", () => {
    const dir = root();
    const statePath = join(dir, "active_task_graph.json");
    modernGraph(statePath);
    mkdirSync(process.env.LOOM_SUBAGENT_DIR!, { recursive: true });
    const target = join(dir, "target.json");
    writeFileSync(target, "sentinel");
    const leaf = implementationAttemptSidecarLeaf(SESSION, AGENT)!;
    symlinkSync(target, join(process.env.LOOM_SUBAGENT_DIR!, leaf));
    expect(snapshotImplementationAttemptSidecar(SESSION, AGENT)).toMatchObject({
      kind: "authority-unavailable",
      failure: { kind: "unreadable-sidecar" },
    });
    expect(readFileSync(target, "utf8")).toBe("sentinel");

    rmSync(process.env.LOOM_SUBAGENT_DIR!, { recursive: true, force: true });
    const real = join(dir, "real-subagents");
    mkdirSync(real);
    symlinkSync(real, process.env.LOOM_SUBAGENT_DIR!);
    expect(() => publishImplementationAttemptSidecar({
      sessionId: SESSION,
      agentId: AGENT,
      taskGraphPath: statePath,
      authority: authority(),
    })).toThrow();
  });

  it("reports a non-directory sidecar root as an explicit filesystem failure", () => {
    const dir = root();
    const statePath = join(dir, "active_task_graph.json");
    modernGraph(statePath);
    writeFileSync(process.env.LOOM_SUBAGENT_DIR!, "not a directory");
    expect(() => publishImplementationAttemptSidecar({
      sessionId: SESSION,
      agentId: AGENT,
      taskGraphPath: statePath,
      authority: authority(),
    })).toThrow();
    expect(snapshotImplementationAttemptSidecar(SESSION, AGENT)).toMatchObject({
      kind: "authority-unavailable",
      failure: { kind: "unreadable-sidecar" },
    });
  });

  it("cleanup removes exactly the keyed sidecar", async () => {
    const dir = root();
    const statePath = join(dir, "active_task_graph.json");
    const attempt = authority();
    modernGraph(statePath, attempt);
    publishImplementationAttemptSidecar({ sessionId: SESSION, agentId: AGENT, taskGraphPath: statePath, authority: attempt });
    const result = await cleanupSubagentFlag(JSON.stringify({ session_id: SESSION, agent_id: AGENT, agent_type: "code-implementer-agent" }), []);
    expect(result.kind).toBe("passthrough");
    expect(snapshotImplementationAttemptSidecar(SESSION, AGENT)).toMatchObject({
      kind: "authority-unavailable",
      failure: { kind: "missing-sidecar" },
    });
  });
});
