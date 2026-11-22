/**
 * SubagentStop dispatch resilience:
 * - malformed stdin fails closed with a specific "bindings may leak" error
 * - a cleanupSubagentFlag crash still settles the exact implementation attempt
 * - update-task-status judges the dispatcher's pre-unbind ledger snapshot,
 *   not whatever file is on disk when it runs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import dispatch, { runDispatch } from "../../../src/handlers/subagent-stop/dispatch";
import markActive from "../../../src/handlers/subagent-start/mark-subagent-active";
import { runUpdateTaskStatus } from "../../../src/handlers/subagent-stop/update-task-status";
import { SUBAGENT_DIR } from "../../../src/config";
import type { EvidenceRecord } from "../../../src/machine";
import { agentRequestAuthority } from "../../fixtures/agent-request-authority";
import { openRunDirectory } from "../../../src/orchestration/run-directory-handle";
import { buildContextPacket, encodeByteSection } from "../../../src/core/context-packets";
import { reportSummary } from "../../machine/report-summary";
import { resolveTaskGraph } from "../../../src/state-manager";
import { AGENT_COMMAND_ORIGIN } from "../../../src/machine/types";
import { executingGraphFixture, graphFixture, taskFixture } from "../../fixtures/task-lifecycle";
import {
  ARMED_ARTIFACT,
  ARMED_EPOCH,
  REGRESSION_ONLY,
  armedClaudeImplementation,
  writesTranscript,
} from "../../fixtures/claude-implementation-attempt";
import type { TaskGraph } from "../../../src/types";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const run = `dispatch-resilience-${process.pid}-${Date.now()}`;
const sid = (name: string) => `${run}-${name}`;

let dirs: string[] = [];
let sessionFiles: string[] = [];
const disposals: (() => void)[] = [];

function tempDir(): string {
  const dir = canonicalTempDir("loom-dispatch-");
  dirs.push(dir);
  return dir;
}

const originalCwd = process.cwd();

beforeEach(() => {
  const cwd = tempDir();
  process.chdir(cwd);
  vi.stubEnv("LOOM_STATE_PATH", join(cwd, "active_task_graph.json"));
  vi.stubEnv("CLAUDE_PROJECT_DIR", cwd);
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(cwd, "claude-config"));
  vi.stubEnv("LOOM_ORCHESTRATION_RUNS_ROOT", undefined);
  vi.stubEnv("LOOM_ORCHESTRATION_RUN_DIR", undefined);
  expect(resolveTaskGraph()).toBeNull();
});

afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  for (const f of sessionFiles) {
    rmSync(f, { recursive: true, force: true });
  }
  sessionFiles = [];
  vi.restoreAllMocks();
});

/**
 * State with one executing task under exact attempt authority, as every
 * loadable State File's executing Task carries (ADR-0098).
 */
function writeState(dir: string): string {
  const statePath = join(dir, "active_task_graph.json");
  const task = taskFixture({ id: "T1", description: "impl", agent: "code-implementer-agent", wave: 1, depends_on: [] });
  writeFileSync(statePath, JSON.stringify({
    ...executingGraphFixture(graphFixture([task]), ["T1"]),
    wave_gates: { "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false } },
  }));
  return statePath;
}

/** Point the session at the state file (cross-repo resolution path). */
function pointSessionAt(session: string, statePath: string): void {
  mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
  const pointer = `${SUBAGENT_DIR}/${session}.task_graph`;
  writeFileSync(pointer, statePath);
  sessionFiles.push(pointer);
}

describe("category handler errors propagate instead of passthrough (critical)", () => {
  it("a storeReviewerFindings failure fails the SubagentStop hook", async () => {
    const dir = tempDir();
    const statePath = writeState(dir);
    const session = sid("review-evidence-error");
    pointSessionAt(session, statePath);

    // The reviewer transcript is unreadable, so storeReviewerFindings returns
    // kind error. dispatch must surface that as a failed SubagentStop — a
    // swallowed error would make a wave look clean while evidence was lost.
    const result = await dispatch(JSON.stringify({
      session_id: session,
      agent_id: "agent-review-error",
      agent_type: "code-reviewer",
      agent_transcript_path: join(dir, "missing-transcript.jsonl"),
    }), []);

    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("store-reviewer-findings");
  });
});

describe("request-bound capture gates legacy dispatch", () => {
  it("combines capture and cleanup failures while skipping legacy state mutation", async () => {
    const dir = tempDir();
    const statePath = writeState(dir);
    const session = sid("capture-rejected");
    pointSessionAt(session, statePath);
    const runsRoot = join(dir, "runs");
    const runDir = join(runsRoot, "run.dispatch-capture");
    mkdirSync(runDir, { recursive: true });
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    const request = agentRequestAuthority("run.dispatch-capture");
    expect((await opened.value.reserveRequest(request)).ok).toBe(true);
    expect((await opened.value.recordHarnessCorrelator({
      schemaVersion: 1,
      harness: "claude",
      nativeId: "agent-capture",
      requestId: request.requestId,
      role: request.role,
      attempt: request.attempt,
    })).ok).toBe(true);
    const previousRoot = process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
    const previousRun = process.env.LOOM_ORCHESTRATION_RUN_DIR;
    process.env.LOOM_ORCHESTRATION_RUNS_ROOT = runsRoot;
    process.env.LOOM_ORCHESTRATION_RUN_DIR = runDir;
    try {
      const result = await runDispatch(JSON.stringify({
        session_id: session,
        agent_id: "agent-capture",
        agent_type: "code-reviewer",
        agent_transcript_path: join(dir, "missing-transcript.jsonl"),
      }), [], async () => ({ kind: "error", message: "injected cleanup failure" }));
      expect(result).toMatchObject({
        kind: "error",
        message: expect.stringContaining("injected cleanup failure"),
      });
      if (result.kind === "error") expect(result.message).toContain("request-bound capture rejected");
      const task = JSON.parse(readFileSync(statePath, "utf-8")).tasks[0];
      expect(task.critical_findings ?? []).toEqual([]);
    } finally {
      if (previousRoot === undefined) delete process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
      else process.env.LOOM_ORCHESTRATION_RUNS_ROOT = previousRoot;
      if (previousRun === undefined) delete process.env.LOOM_ORCHESTRATION_RUN_DIR;
      else process.env.LOOM_ORCHESTRATION_RUN_DIR = previousRun;
    }
  });

  it.each([
    ["matching metadata", "spec-check-invoker", true],
    ["omitted metadata", undefined, true],
    ["contradictory metadata", "code-reviewer", false],
  ] as const)("routes a captured Wave Gate spec-check from request authority with %s", async (_label, reportedAgentType, settles) => {
    const dir = tempDir();
    const statePath = writeState(dir);
    const session = sid("wave-gate-spec-check");
    pointSessionAt(session, statePath);
    const runsRoot = join(dir, "runs");
    const runDir = join(runsRoot, "run.dispatch-wave-gate");
    mkdirSync(runDir, { recursive: true });
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);

    const baseRequest = agentRequestAuthority("run.dispatch-wave-gate", {
      requestId: "wave-request:dispatch-spec-check:1",
      slotId: "wave-slot:dispatch-spec-check",
      role: "spec-check-invoker",
      requiredSkill: "spec-check",
      outputSlot: {
        kind: "fixed-artifact-slot",
        path: "transcripts/wave-slot:dispatch-spec-check/attempt-1.raw",
      },
    });
    const section = encodeByteSection("test", "request-bound Wave Gate spec-check context");
    if (!section.ok) throw new Error(section.error.message);
    const packet = buildContextPacket({
      requestId: baseRequest.requestId,
      role: baseRequest.role,
      requiredSkill: baseRequest.requiredSkill ?? "none",
      outputContract: "emit exact Wave spec-check bytes",
      fixedContext: [section.value],
      variableContext: [],
    });
    if (!packet.ok) throw new Error(packet.error.message);
    expect((await opened.value.publishContext(packet.value)).ok).toBe(true);
    const request = agentRequestAuthority("run.dispatch-wave-gate", {
      ...baseRequest,
      contextDigest: packet.value.digest,
    });
    expect((await opened.value.reserveRequest(request)).ok).toBe(true);
    expect((await opened.value.recordHarnessCorrelator({
      schemaVersion: 1,
      harness: "claude",
      nativeId: "agent-wave-gate-spec-check",
      requestId: request.requestId,
      role: request.role,
      attempt: request.attempt,
    })).ok).toBe(true);

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.active_wave_gate = {
      schemaVersion: 1,
      kind: "active-wave-gate",
      runId: request.runId,
      wave: 1,
      authorityDigest: "a".repeat(64),
      revision: 0,
      terminalOutcome: null,
    };
    state.wave_review_epoch = {
      runId: request.runId,
      wave: 1,
      batchEpoch: "b".repeat(64),
      specCheckDocuments: {
        spec: { path: state.spec_file, contentDigest: null },
        plan: { path: state.plan_file, contentDigest: null },
      },
      specCheckSlotAuthority: { slot_id: request.slotId, attempted: request.attempt },
      settledSpecCheckFloor: { kind: "settled", count: 0 },
    };
    writeFileSync(statePath, JSON.stringify(state));

    const transcriptPath = join(dir, "wave-gate-spec-check.jsonl");
    const capturedBytes = [
      "SPEC_CHECK_WAVE: 1",
      "SPEC_CHECK_CRITICAL_COUNT: 0",
      "SPEC_CHECK_HIGH_COUNT: 0",
      "SPEC_CHECK_VERDICT: PASSED",
    ].join("\n");
    writeFileSync(transcriptPath, JSON.stringify({
      message: { role: "assistant", content: [{ type: "text", text: capturedBytes }] },
    }));
    const cleanup = vi.fn(async () => ({ kind: "passthrough" as const }));
    const previousRoot = process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
    const previousRun = process.env.LOOM_ORCHESTRATION_RUN_DIR;
    process.env.LOOM_ORCHESTRATION_RUNS_ROOT = runsRoot;
    process.env.LOOM_ORCHESTRATION_RUN_DIR = runDir;
    try {
      const result = await runDispatch(JSON.stringify({
        session_id: session,
        agent_id: "agent-wave-gate-spec-check",
        agent_type: reportedAgentType,
        agent_transcript_path: transcriptPath,
      }), [], cleanup);

      expect(cleanup).toHaveBeenCalledOnce();
      const settledState = JSON.parse(readFileSync(statePath, "utf8"));
      if (settles) {
        expect(result).toEqual({ kind: "passthrough" });
        expect(settledState.spec_check).toMatchObject({
          wave: 1,
          verdict: "PASSED",
          critical_count: 0,
          high_count: 0,
        });
      } else {
        expect(result).toMatchObject({
          kind: "error",
          message: expect.stringMatching(/issued to.*spec-check-invoker.*reported.*code-reviewer/),
        });
        expect(settledState.spec_check).toBeUndefined();
      }
      const captured = opened.value.readTranscriptBytes(request);
      expect(captured.ok).toBe(true);
      if (captured.ok) expect(Buffer.from(captured.value).toString("utf8")).toBe(capturedBytes);
    } finally {
      if (previousRoot === undefined) delete process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
      else process.env.LOOM_ORCHESTRATION_RUNS_ROOT = previousRoot;
      if (previousRun === undefined) delete process.env.LOOM_ORCHESTRATION_RUN_DIR;
      else process.env.LOOM_ORCHESTRATION_RUN_DIR = previousRun;
    }
  });

  it.each([false, true])("terminates a captured standalone review without consulting faulting metadata (presentGraph=%s)", async (presentGraph) => {
    const session = sid("standalone");
    const statePath = join(process.cwd(), "active_task_graph.json");
    if (presentGraph) pointSessionAt(session, writeState(process.cwd()));
    expect(resolveTaskGraph()).toBe(presentGraph ? statePath : null);
    const graphBefore = presentGraph ? readFileSync(statePath, "utf8") : null;
    const dir = tempDir();
    const runsRoot = join(dir, "runs");
    const runDir = join(runsRoot, "run.graphless-standalone-capture");
    mkdirSync(runDir, { recursive: true });
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    const baseRequest = agentRequestAuthority("run.graphless-standalone-capture", {
      program: "standalone-review",
    });
    const section = encodeByteSection("test", "graphless standalone capture context");
    if (!section.ok) throw new Error(section.error.message);
    const packet = buildContextPacket({
      requestId: baseRequest.requestId,
      role: baseRequest.role,
      requiredSkill: "none",
      outputContract: "emit exact standalone review bytes",
      fixedContext: [section.value],
      variableContext: [],
    });
    if (!packet.ok) throw new Error(packet.error.message);
    expect((await opened.value.publishContext(packet.value)).ok).toBe(true);
    const request = agentRequestAuthority("run.graphless-standalone-capture", {
      program: "standalone-review",
      contextDigest: packet.value.digest,
    });
    expect((await opened.value.reserveRequest(request)).ok).toBe(true);
    expect((await opened.value.recordHarnessCorrelator({
      schemaVersion: 1,
      harness: "claude",
      nativeId: "agent-graphless-standalone",
      requestId: request.requestId,
      role: request.role,
      attempt: request.attempt,
    })).ok).toBe(true);
    const transcriptPath = join(dir, "graphless-standalone.jsonl");
    const capturedBytes = "exact graphless standalone review result";
    writeFileSync(transcriptPath, JSON.stringify({
      message: { role: "assistant", content: [{ type: "text", text: capturedBytes }] },
    }));
    const cleanup = vi.fn(async () => ({ kind: "passthrough" as const }));
    const config = join(dir, "faulting-claude-config");
    const project = join(dir, "project");
    mkdirSync(config, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(config, "projects"), "not a directory\n");
    const previousRoot = process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
    const previousRun = process.env.LOOM_ORCHESTRATION_RUN_DIR;
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    const previousProject = process.env.CLAUDE_PROJECT_DIR;
    process.env.LOOM_ORCHESTRATION_RUNS_ROOT = runsRoot;
    process.env.LOOM_ORCHESTRATION_RUN_DIR = runDir;
    process.env.CLAUDE_CONFIG_DIR = config;
    process.env.CLAUDE_PROJECT_DIR = project;
    try {
      const result = await runDispatch(JSON.stringify({
        session_id: session,
        agent_id: "agent-graphless-standalone",
        agent_transcript_path: transcriptPath,
      }), [], cleanup);

      expect(result).toEqual({ kind: "passthrough" });
      expect(cleanup).toHaveBeenCalledOnce();
      const captured = opened.value.readTranscriptBytes(request);
      expect(captured.ok).toBe(true);
      if (captured.ok) expect(Buffer.from(captured.value).toString("utf8")).toBe(capturedBytes);
      if (presentGraph) expect(readFileSync(statePath, "utf8")).toBe(graphBefore);
      else expect(resolveTaskGraph()).toBeNull();
    } finally {
      if (previousRoot === undefined) delete process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
      else process.env.LOOM_ORCHESTRATION_RUNS_ROOT = previousRoot;
      if (previousRun === undefined) delete process.env.LOOM_ORCHESTRATION_RUN_DIR;
      else process.env.LOOM_ORCHESTRATION_RUN_DIR = previousRun;
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
      if (previousProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = previousProject;
    }
  });
});

describe("routing observation faults settle through cleanup", () => {
  it("returns an ENOTDIR metadata fault after invoking cleanup", async () => {
    const dir = tempDir();
    const config = join(dir, "claude-config");
    const project = join(dir, "project");
    mkdirSync(config, { recursive: true });
    mkdirSync(project, { recursive: true });
    // projects must be a directory. Making it a file forces the derived
    // metadata stat to fail with ENOTDIR rather than an ordinary absence.
    writeFileSync(join(config, "projects"), "not a directory\n");
    const cleanup = vi.fn(async () => ({ kind: "passthrough" as const }));
    const environment = [
      "CLAUDE_CONFIG_DIR",
      "CLAUDE_PROJECT_DIR",
      "LOOM_ORCHESTRATION_RUNS_ROOT",
      "LOOM_ORCHESTRATION_RUN_DIR",
    ] as const;
    const previous = new Map(environment.map((name) => [name, process.env[name]]));
    process.env.CLAUDE_CONFIG_DIR = config;
    process.env.CLAUDE_PROJECT_DIR = project;
    delete process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
    delete process.env.LOOM_ORCHESTRATION_RUN_DIR;
    try {
      const result = await runDispatch(JSON.stringify({
        session_id: sid("routing-enotdir"),
        agent_id: "agent-routing-enotdir",
      }), [], cleanup);

      expect(cleanup).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        kind: "error",
        message: expect.stringMatching(/routing observation failed.*ENOTDIR|routing observation failed.*not a directory/i),
      });
    } finally {
      for (const name of environment) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe("malformed hook input is caught instead of escaping cleanup", () => {
  it("dispatch: malformed stdin fails closed and names skipped cleanup", async () => {
    const result = await dispatch("{not json", []);
    expect(result).toMatchObject({ kind: "error" });
    if (result.kind !== "error") return;
    expect(result.message).toContain("cleanup skipped");
    expect(result.message).toContain("bindings may leak");
  });

  it.each([
    ["null", "null"],
    ["scalar", "42"],
    ["array", "[]"],
    ["missing session identity", JSON.stringify({ agent_id: "agent-1" })],
    ["non-string Agent identity", JSON.stringify({ session_id: "session-1", agent_id: 7 })],
  ])("dispatch: valid JSON with an invalid %s shape fails before cleanup", async (_label, stdin) => {
    const cleanup = vi.fn(async () => ({ kind: "passthrough" as const }));

    const result = await runDispatch(stdin, [], cleanup);

    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/invalid SubagentStop input.*cleanup skipped.*bindings may leak/),
    });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("mark-subagent-active: malformed stdin without a TaskGraph → passthrough + loud stderr", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await markActive("{not json", []);
    expect(result.kind).toBe("passthrough");
    const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(text).toContain("agent not tracked");
    expect(text).toContain("no TaskGraph exists");
    expect(resolveTaskGraph()).toBeNull();
  });

  it("mark-subagent-active: malformed stdin with a real TaskGraph blocks without changing it", async () => {
    const statePath = writeState(process.cwd());
    const graphBefore = readFileSync(statePath, "utf8");
    expect(resolveTaskGraph()).toBe(statePath);

    const result = await markActive("{not json", []);

    expect(result).toMatchObject({
      kind: "block",
      message: expect.stringContaining(`TaskGraph ${statePath} is active`),
    });
    if (result.kind === "block") expect(result.message).toContain("refusing spawn");
    expect(readFileSync(statePath, "utf8")).toBe(graphBefore);
  });
});

/** Every discarded result is named; an unnameable active-graph stop also
 * fails the evidence boundary, while known unrelated custom roles retain
 * legacy passthrough compatibility. */
describe("dispatch names what it discarded (audit diagnostics)", () => {
  const stderrOf = async (
    payload: Record<string, unknown>,
    expectedKind: "passthrough" | "error" = "passthrough",
  ): Promise<string> => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await dispatch(JSON.stringify(payload), []);
      expect(result.kind).toBe(expectedKind);
      return stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    } finally {
      stderrSpy.mockRestore();
    }
  };

  it("says the whole record was skipped when no task graph resolves", async () => {
    // No session pointer and no local graph: resolution refuses authority,
    // so status, evidence and findings are ALL skipped.
    const text = await stderrOf({
      session_id: sid("no-graph-at-all"),
      agent_id: "agent-no-graph",
      agent_type: "code-implementer-agent",
    }, "error");
    expect(text).toContain("no task graph resolvable");
    expect(text).toContain("recorded NOTHING");
  });

  it("keeps a named custom agent as passthrough when no TaskGraph resolves", async () => {
    const text = await stderrOf({
      session_id: sid("custom-no-graph"),
      agent_id: "agent-custom",
      agent_type: "some-users-own-agent",
    });
    expect(text).toContain("no task graph resolvable");
    expect(text).toContain("recorded NOTHING");
  });

  it.each([
    ["code-implementer-agent", "error"],
    ["some-users-own-agent", "passthrough"],
  ] as const)("does not substitute a present local TaskGraph for an unbound %s session", async (agentType, expectedKind) => {
    const statePath = writeState(process.cwd());
    const graphBefore = readFileSync(statePath, "utf8");
    expect(resolveTaskGraph()).toBe(statePath);

    const text = await stderrOf({
      session_id: sid("unbound-with-local-graph"),
      agent_id: "agent-unbound",
      agent_type: agentType,
    }, expectedKind);

    expect(text).toContain("no task graph resolvable");
    expect(text).toContain("recorded NOTHING");
    expect(text).toContain("refusing local task-graph fallback");
    expect(readFileSync(statePath, "utf8")).toBe(graphBefore);
  });

  it("preserves recorded-NOTHING and cleanup diagnostics when graph resolution and cleanup both fail", async () => {
    const result = await runDispatch(JSON.stringify({
      session_id: "../../invalid session",
      agent_id: "agent-dual-failure",
      agent_type: "code-implementer-agent",
    }), [], async () => ({ kind: "error", message: "injected cleanup failure" }));

    expect(result).toMatchObject({ kind: "error" });
    if (result.kind !== "error") return;
    expect(result.message).toContain("no task graph resolvable");
    expect(result.message).toContain("SubagentStop recorded NOTHING");
    expect(result.message).toContain("invalid session id");
    expect(result.message).toContain("cleanup also failed: injected cleanup failure");
  });

  it.each([
    ["invalid session", { session_id: "../../invalid session", agent_id: "agent-invalid-session", agent_type: "code-reviewer" }, "missing/invalid session id"],
    ["missing agent", { session_id: sid("missing-agent"), agent_type: "code-reviewer" }, "missing agent_id"],
  ])("propagates %s cleanup identity failure instead of reporting successful cleanup", async (_label, payload, diagnostic) => {
    const result = await runDispatch(JSON.stringify(payload), []);

    expect(result).toMatchObject({ kind: "error" });
    if (result.kind !== "error") return;
    expect(result.message).toContain("SubagentStop recorded NOTHING");
    expect(result.message).toContain("cleanup also failed");
    expect(result.message).toContain(diagnostic);
  });

  it("distinguishes an UNNAMEABLE agent from a merely unrouted one", async () => {
    const dir = tempDir();
    const session = sid("unnameable");
    pointSessionAt(session, writeState(dir));

    // Neither the payload nor the harness metadata can say what ran — a loom
    // agent's result may have just been lost, which is not the same as a user's
    // own subagent legitimately having no orchestration hooks.
    const unnameable = await stderrOf(
      { session_id: session, agent_id: "agent-unnameable" },
      "error",
    );
    expect(unnameable).toContain("carried no agent_type and none could be derived");
    expect(unnameable).toContain("its result is LOST");
  });

  it("names an agent type that resolved but maps to no route", async () => {
    const dir = tempDir();
    const session = sid("unrouted");
    pointSessionAt(session, writeState(dir));

    const unrouted = await stderrOf({
      session_id: session,
      agent_id: "agent-unrouted",
      agent_type: "some-users-own-agent",
    });
    expect(unrouted).toContain("no orchestration route for agent type");
    expect(unrouted).toContain("some-users-own-agent");
    // The louder "result is LOST" wording belongs to the unnameable case only.
    expect(unrouted).not.toContain("its result is LOST");
  });
});

/** An exact Claude attempt for T1, disposed after the test. */
async function armed(label: string, options: Readonly<{ publishSidecar?: boolean; seed?: (graph: TaskGraph) => TaskGraph }> = {}) {
  const attempt = await armedClaudeImplementation({ label, verificationPolicy: REGRESSION_ONLY, ...options });
  disposals.push(attempt.dispose);
  return attempt;
}

describe("a cleanupSubagentFlag crash still runs update-task-status", () => {
  it("held cleanup lock reports cleanup failure after T1 settlement still runs", async () => {
    const attempt = await armed("cleanup-crash", { publishSidecar: true });
    writeFileSync(attempt.transcript, writesTranscript("Stopped without changing the artifact.", []));
    const s = attempt.sessionId;

    // .active exists → cleanup must take the lock to rewrite it
    const activeFile = `${SUBAGENT_DIR}/${s}.active`;
    writeFileSync(activeFile, "a-1\n");
    sessionFiles.push(activeFile);

    // Hold the cleanup lock with OUR live pid: acquisition retries then
    // throws — a genuine cleanup crash inside the dispatcher.
    const lockDir = `${SUBAGENT_DIR}/${s}.cleanup.lock`;
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "pid"), `${process.pid}`);
    sessionFiles.push(lockDir);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await dispatch(attempt.stopInput, []);
      expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("cleanup-subagent-flag") });
      const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(text).not.toContain("ERROR in cleanupSubagentFlag");
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }

    const state = JSON.parse(readFileSync(attempt.statePath, "utf-8"));
    expect(state.tasks[0].status).toBe("pending");
    expect(state.tasks[0].proof.state).toBe("failed");
    expect(state.tasks[0].implementation_attempt_history).toHaveLength(1);
    expect(state.executing_tasks).toEqual([]);
  }, 30000);

  it("catches a thrown cleanup dependency, still settles the attempt, and returns the cleanup error", async () => {
    const attempt = await armed("cleanup-throws", { publishSidecar: true });
    writeFileSync(attempt.transcript, writesTranscript("Stopped without changing the artifact.", []));

    const result = await runDispatch(
      attempt.stopInput,
      [],
      async () => { throw new Error("injected cleanup crash"); },
    );

    expect(result).toEqual({
      kind: "error",
      message: expect.stringContaining("cleanupSubagentFlag crashed: injected cleanup crash"),
    });
    const state = JSON.parse(readFileSync(attempt.statePath, "utf8"));
    expect(state.executing_tasks).toEqual([]);
    expect(state.tasks[0]).toMatchObject({
      status: "pending",
      proof: { state: "failed" },
    });
    expect(state.tasks[0].implementation_attempt_history).toHaveLength(1);
  });
});

describe("update-task-status honors the pre-unbind evidence snapshot", () => {
  it("a trusted TestRun in the snapshot decides the verdict even with no ledger on disk", async () => {
    const attempt = await armed("snapshot");
    writeFileSync(join(attempt.root, ARMED_ARTIFACT), "export const value = 2;\n");
    writeFileSync(attempt.transcript, writesTranscript("Changed the artifact.", [ARMED_ARTIFACT]));

    // No <session>.evidence.jsonl exists — the snapshot is the only source,
    // exactly the bind-time truncation window the dispatcher closes.
    const snapshot: readonly EvidenceRecord[] = [{
      epoch: ARMED_EPOCH,
      event: {
        kind: "TestRun", origin: AGENT_COMMAND_ORIGIN,
        command: "npm test",
        exit: 0,
        report: reportSummary(5, 0),
      },
    }];

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await runUpdateTaskStatus(attempt.stopInput, [], { kind: "snapshot", events: snapshot }, attempt.observation);
    stderrSpy.mockRestore();
    expect(result.kind, JSON.stringify(result)).toBe("passthrough");

    const state = JSON.parse(readFileSync(attempt.statePath, "utf-8"));
    expect(state.tasks[0].status).toBe("implemented");
    expect(state.tasks[0].proof.state).toBe("satisfied");
    expect(state.tasks[0].test_result).toEqual({ verdict: "trusted-pass" });
    expect(state.tasks[0].test_evidence).toContain("ledger: exit 0");
  }, 30000);
});

describe("an untrusted helper-reported pass never launders the ledger's trusted-fail", () => {
  it("the stop persists the epoch's trusted-fail over a pass store-test-evidence wrote first", async () => {
    // The classic laundering move: store-test-evidence stdin wrote an
    // untrusted pass BEFORE SubagentStop fired.
    const attempt = await armed("launder", {
      seed: (graph) => ({
        ...graph,
        tasks: graph.tasks.map((task) => ({
          ...task,
          test_result: { verdict: "untrusted", passed: true, label: "helper-reported (store-test-evidence stdin)", provenance: "unverified" },
          test_evidence: "all 999 tests pass, honest",
        })),
      }),
    });
    writeFileSync(join(attempt.root, ARMED_ARTIFACT), "export const value = 2;\n");
    writeFileSync(attempt.transcript, writesTranscript("Changed the artifact.", [ARMED_ARTIFACT]));
    const snapshot: readonly EvidenceRecord[] = [{
      epoch: ARMED_EPOCH,
      event: { kind: "TestRun", origin: AGENT_COMMAND_ORIGIN, command: "npm test", exit: 1, report: null },
    }];

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await runUpdateTaskStatus(attempt.stopInput, [], { kind: "snapshot", events: snapshot }, attempt.observation);
    stderrSpy.mockRestore();
    expect(result.kind, JSON.stringify(result)).toBe("passthrough");

    const state = JSON.parse(readFileSync(attempt.statePath, "utf-8"));
    expect(state.tasks[0].test_result).toEqual({ verdict: "trusted-fail" }); // ground truth persisted
    expect(state.tasks[0].test_evidence).toContain("ledger: exit 1");
    expect(state.tasks[0].status).toBe("pending");
  }, 30000);
});

describe("a prior trusted verdict survives a stop that carries no trusted evidence", () => {
  /** Stops of the armed attempt that carry nothing trusted: no ledger line
   *  at all, or an agent-command pass with no report (judged untrusted). */
  const UNTRUSTED_STOPS: Readonly<Record<string, readonly EvidenceRecord[]>> = Object.freeze({
    empty: [],
    untrusted: [{
      epoch: ARMED_EPOCH,
      event: { kind: "TestRun", origin: AGENT_COMMAND_ORIGIN, command: "npm test", exit: 0, report: null },
    }],
  });

  for (const [stop, events] of Object.entries(UNTRUSTED_STOPS)) {
    it(`an ${stop} stop keeps the earlier trusted-fail and still releases the reservation`, async () => {
      const attempt = await armed(`trusted-kept-${stop}`, {
        seed: (graph) => ({
          ...graph,
          tasks: graph.tasks.map((task) => ({
            ...task, test_result: { verdict: "trusted-fail" }, test_evidence: "ledger: exit 1 (npm test)",
          })),
        }),
      });
      writeFileSync(attempt.transcript, writesTranscript("Stopped without changing the artifact.", []));

      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const result = await runUpdateTaskStatus(attempt.stopInput, [], { kind: "snapshot", events }, attempt.observation);
      stderrSpy.mockRestore();
      expect(result.kind, JSON.stringify(result)).toBe("passthrough");

      const state = JSON.parse(readFileSync(attempt.statePath, "utf-8"));
      expect(state.tasks[0].test_result).toEqual({ verdict: "trusted-fail" });
      expect(state.tasks[0].test_evidence).toBe("ledger: exit 1 (npm test)");
      // The verdict stands, but the Agent still stopped: its reservation is
      // released, or the duplicate-spawn check ghost-blocks the retry.
      expect(state.tasks[0].status).toBe("pending");
      expect(state.tasks[0].active_implementation_attempt).toBeUndefined();
      expect(state.executing_tasks).toEqual([]);
    }, 30000);
  }
});

describe("a late stop never reopens a completed Task", () => {
  it("redelivering the settled attempt's stop after the Task completed changes nothing", async () => {
    const attempt = await armed("completed-kept");
    writeFileSync(join(attempt.root, ARMED_ARTIFACT), "export const value = 2;\n");
    writeFileSync(attempt.transcript, writesTranscript("Changed the artifact.", [ARMED_ARTIFACT]));
    const pass: readonly EvidenceRecord[] = [{
      epoch: ARMED_EPOCH,
      event: { kind: "TestRun", origin: AGENT_COMMAND_ORIGIN, command: "npm test", exit: 0, report: reportSummary(5, 0) },
    }];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const settled = await runUpdateTaskStatus(attempt.stopInput, [], { kind: "snapshot", events: pass }, attempt.observation);
    expect(settled.kind, JSON.stringify(settled)).toBe("passthrough");

    // The Wave Gate then completes T1 (the protected State File is written
    // the way its lock-holder writes it).
    const implemented = JSON.parse(readFileSync(attempt.statePath, "utf-8"));
    expect(implemented.tasks[0]).toMatchObject({ status: "implemented", proof: { state: "satisfied" } });
    chmodSync(attempt.statePath, 0o644);
    writeFileSync(attempt.statePath, JSON.stringify({
      ...implemented,
      tasks: implemented.tasks.map((task: { id: string }) => task.id === "T1" ? { ...task, status: "completed" } : task),
    }));
    chmodSync(attempt.statePath, 0o444);
    const before = readFileSync(attempt.statePath);

    // A late SubagentStop for the same attempt arrives with no evidence at all.
    const late = await runUpdateTaskStatus(attempt.stopInput, [], { kind: "snapshot", events: [] }, attempt.observation);
    const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    stderrSpy.mockRestore();

    expect(late.kind, JSON.stringify(late)).toBe("passthrough");
    // The completed Task already holds this attempt's receipt: the redelivery is a duplicate.
    expect(text).toContain("T1 result ignored (duplicate)");
    expect(readFileSync(attempt.statePath).equals(before)).toBe(true);
    const state = JSON.parse(readFileSync(attempt.statePath, "utf-8"));
    expect(state.tasks[0]).toMatchObject({ status: "completed", test_result: { verdict: "trusted-pass" } });
  }, 30000);
});

describe("a FAILED evidence snapshot is never laundered into 'genuinely empty' (snapshot-failed sentinel)", () => {
  it("unreadable ledger → verdict is labeled snapshot-read-failed, never 'degraded'", async () => {
    const attempt = await armed("snapshot-fail", { publishSidecar: true });
    writeFileSync(join(attempt.root, ARMED_ARTIFACT), "export const value = 2;\n");
    // No pass markers: the transcript-regex fallback finds nothing.
    writeFileSync(attempt.transcript, writesTranscript("Changed the artifact.", [ARMED_ARTIFACT]));
    const s = attempt.sessionId;

    // A DIRECTORY at the ledger path makes readEvidence throw (EISDIR):
    // the dispatcher's snapshot read fails. The { kind: "snapshot-failed" }
    // sentinel routes update-task-status to the transcript-only fallback
    // with a snapshot-read-failed label — never the misleading "degraded
    // (machine bound, no ledger evidence)" that a laundered [] would mint.
    const ledgerDir = `${SUBAGENT_DIR}/${s}.evidence.jsonl`;
    mkdirSync(ledgerDir, { recursive: true });
    sessionFiles.push(ledgerDir);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await dispatch(attempt.stopInput, []);
    const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    stderrSpy.mockRestore();

    expect(result.kind, JSON.stringify(result)).toBe("passthrough"); // dispatcher never crashes the pipeline
    expect(text).toContain(`evidence snapshot failed for ${s}`);
    // The handler proceeds (labeled), it does not crash:
    expect(text).not.toContain("ERROR in updateTaskStatus");
    expect(text).toContain("labeled snapshot-read-failed");

    const state = JSON.parse(readFileSync(attempt.statePath, "utf-8"));
    expect(state.tasks[0].status).toBe("pending");
    expect(state.tasks[0].proof.state).toBe("failed");
    expect(state.tasks[0].test_result).toEqual({
      verdict: "untrusted",
      passed: false,
      label: "snapshot-read-failed (ledger snapshot unreadable; transcript-regex)",
      provenance: "unverified",
    });
    expect(state.tasks[0].test_result.label).not.toContain("degraded");
  }, 30000);
});


describe("an INVALID session id is a typed snapshot failure, never an empty snapshot (round-10 gap 22)", () => {
  it("session_id with reserved characters → typed snapshot failure + cleanup error", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await dispatch(
      JSON.stringify({
        session_id: "../../etc/evil session",
        agent_id: "a-1",
        agent_type: "code-implementer-agent",
      }),
      [],
    );
    const text = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    stderrSpy.mockRestore();

    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("missing/invalid session id"),
    });
    // The snapshot is labeled FAILED (invalid id can name no ledger file) —
    // downstream would label the verdict snapshot-read-failed, never "degraded".
    expect(text).toContain("evidence snapshot failed");
    expect(text).toContain("invalid session id");
  });
});
