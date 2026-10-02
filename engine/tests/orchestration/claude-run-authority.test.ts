import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";
import { buildContextPacket, encodeByteSection } from "../../src/orchestration/context-packets";
import { openRunDirectory } from "../../src/orchestration/run-directory-handle";
import { ORCHESTRATION_RUNS_SUFFIX, registerSessionRunBinding } from "../../src/orchestration/session-run-bindings";
import { RUN_DIR_ENV, RUNS_ROOT_ENV } from "../../src/orchestration/harness-capture-runtime";
import {
  resolveClaudeSpawnRun,
  resolveClaudeStopRun,
  type ClaudeRunContext,
} from "../../src/orchestration/claude-run-authority";
import { recordClaudeSpawnCorrelation } from "../../src/handlers/post-tool-use/record-orchestration-spawn";
import captureOrchestrationResult, { establishClaudeStopRun } from "../../src/handlers/subagent-stop/capture-orchestration-result";
import { projectSlug } from "../../src/utils/agent-transcript-path";

/**
 * Claude Code run authority WITHOUT the LOOM_ORCHESTRATION_* environment: the
 * session run binding the façade publishes is what tells Claude's PostToolUse
 * and SubagentStop hooks which run they speak for.
 */

const SESSION = "8a510c9a-c1fb-4b89-b61f-08ef6a007c78";
const ENV_KEYS = [RUNS_ROOT_ENV, RUN_DIR_ENV, "LOOM_SUBAGENT_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_PROJECT_DIR"] as const;
const cleanup: string[] = [];
let base: string;
let bindingDirectory: string;
let previousEnv: readonly (readonly [string, string | undefined])[];

beforeEach(() => {
  base = canonicalTempDir("loom-claude-run-authority-");
  cleanup.push(base);
  bindingDirectory = join(base, "subagents");
  mkdirSync(bindingDirectory);
  previousEnv = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  delete process.env[RUNS_ROOT_ENV];
  delete process.env[RUN_DIR_ENV];
  process.env.LOOM_SUBAGENT_DIR = bindingDirectory;
});

afterEach(() => {
  for (const [key, prior] of previousEnv) {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

type StagedRun = Readonly<{ runsRoot: string; runDirectory: string; requests: readonly AgentRequestAuthority[] }>;

/** One registered run with one reserved request per id, all for code-reviewer. */
async function stagedRun(name: string, requestIds: readonly string[]): Promise<StagedRun> {
  const runsRoot = join(base, `runs-${name}`);
  const runDirectory = join(runsRoot, `run.${name}`);
  mkdirSync(runDirectory, { recursive: true });
  const opened = openRunDirectory(runsRoot, runDirectory);
  if (!opened.ok) throw new Error(opened.error.message);
  const requests: AgentRequestAuthority[] = [];
  for (const [index, requestId] of requestIds.entries()) {
    const section = encodeByteSection("test", `context for ${requestId}`);
    if (!section.ok) throw new Error(section.error.message);
    const packet = buildContextPacket({
      requestId: requestId as AgentRequestAuthority["requestId"],
      role: "code-reviewer",
      requiredSkill: "none",
      outputContract: "test output",
      fixedContext: [section.value],
      variableContext: [],
    });
    if (!packet.ok) throw new Error(packet.error.message);
    if (!(await opened.value.publishContext(packet.value)).ok) throw new Error("context publication failed");
    const slotId = `slot-${index + 1}`;
    const request = agentRequestAuthority(`run.${name}`, {
      requestId,
      slotId,
      contextDigest: packet.value.digest,
      outputSlot: { kind: "fixed-artifact-slot", path: `transcripts/${slotId}/attempt-1.raw` },
    });
    const reserved = await opened.value.reserveRequest(request);
    if (!reserved.ok) throw new Error(reserved.error.message);
    requests.push(request);
  }
  return { runsRoot, runDirectory, requests };
}

async function bind(run: StagedRun, requestIds: readonly string[] = run.requests.map(({ requestId }) => requestId)) {
  const registered = await registerSessionRunBinding(bindingDirectory, SESSION, {
    runId: run.runDirectory.split("/").pop(),
    runsRoot: run.runsRoot,
    runDirectory: run.runDirectory,
    requestIds,
    resultDigest: null,
  }, "claude-code");
  if (!registered.ok) throw new Error(registered.message);
}

function correlator(run: StagedRun, nativeId: string) {
  const opened = openRunDirectory(run.runsRoot, run.runDirectory);
  if (!opened.ok) throw new Error(opened.error.message);
  const read = opened.value.readHarnessCorrelator("claude", nativeId);
  if (!read.ok) throw new Error(read.error.message);
  return read.value;
}

const spawnPayload = (prompt: string, agentId: string, sessionId: string | undefined = SESSION) => ({
  session_id: sessionId,
  tool_name: "Agent",
  tool_input: { subagent_type: "loom:code-reviewer", prompt },
  tool_response: { status: "async_launched", agentId },
});

/** A current Claude Code subagent transcript: spawn prompt, SubagentHandback call, its acknowledgement. */
function handbackTranscript(name: string, prompt: string, payload: string): string {
  const path = join(base, `${name}.jsonl`);
  writeFileSync(path, [
    { type: "user", sessionId: SESSION, message: { role: "user", content: prompt } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "SubagentHandback", input: { message: payload } }] } },
    { type: "user", message: { role: "user", content: [{ tool_use_id: "toolu_1", type: "tool_result", content: [{ type: "text", text: "{\"success\":true}" }] }] } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

const stop = (agentId: string, transcriptPath: string, sessionId: string = SESSION) => JSON.stringify({
  session_id: sessionId,
  agent_id: agentId,
  agent_type: "loom:code-reviewer",
  agent_transcript_path: transcriptPath,
});

function capturedText(run: StagedRun, request: AgentRequestAuthority): string {
  const opened = openRunDirectory(run.runsRoot, run.runDirectory);
  if (!opened.ok) throw new Error(opened.error.message);
  const bytes = opened.value.readTranscriptBytes(request);
  if (!bytes.ok) throw new Error(bytes.error.message);
  return Buffer.from(bytes.value).toString("utf8");
}

const context = (overrides: Partial<ClaudeRunContext> = {}): ClaudeRunContext => ({
  runsRoot: undefined,
  runDirectory: undefined,
  bindingDirectory,
  sessionId: SESSION,
  ...overrides,
});

describe("Claude PostToolUse spawn correlation through the session run binding", () => {
  it("records the correlator in the one bound run that issued the marker", async () => {
    const issuing = await stagedRun("issuing", ["request:alpha:1"]);
    const other = await stagedRun("other", ["request:beta:1"]);
    await bind(issuing);
    await bind(other);

    const result = await recordClaudeSpawnCorrelation(
      spawnPayload("LOOM_REQUEST_ID: request:alpha:1\nReview.", "agent-alpha"), bindingDirectory);

    expect(result).toEqual({ kind: "allow" });
    expect(correlator(issuing, "agent-alpha")).toMatchObject({ requestId: "request:alpha:1", role: "code-reviewer" });
    expect(correlator(other, "agent-alpha")).toBeNull();
  });

  it("passes through an unrelated agent even when the session has bound runs", async () => {
    await bind(await stagedRun("bound", ["request:alpha:1"]));

    const result = await recordClaudeSpawnCorrelation(spawnPayload("Explain this repository.", "agent-x"), bindingDirectory);

    expect(result).toEqual({ kind: "passthrough" });
  });

  it("fails closed on a marker no session binding issued", async () => {
    await bind(await stagedRun("bound", ["request:alpha:1"]));

    const result = await recordClaudeSpawnCorrelation(
      spawnPayload("LOOM_REQUEST_ID: request:stale:1\nReview.", "agent-x"), bindingDirectory);

    expect(result).toMatchObject({
      kind: "error",
      message: "no Claude Code session run binding contains issued request request:stale:1",
    });
  });

  it("fails closed when several session bindings claim the marker", async () => {
    const first = await stagedRun("first", ["request:alpha:1"]);
    const second = await stagedRun("second", ["request:alpha:1"]);
    await bind(first);
    await bind(second);

    const result = await recordClaudeSpawnCorrelation(
      spawnPayload("LOOM_REQUEST_ID: request:alpha:1\nReview.", "agent-x"), bindingDirectory);

    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("multiple Claude Code session run bindings") });
    expect(correlator(first, "agent-x")).toBeNull();
    expect(correlator(second, "agent-x")).toBeNull();
  });

  it("refuses a Pi registry as Claude Code authority", async () => {
    const run = await stagedRun("pi-owned", ["request:alpha:1"]);
    const registered = await registerSessionRunBinding(bindingDirectory, SESSION, {
      runId: "run.pi-owned", runsRoot: run.runsRoot, runDirectory: run.runDirectory,
      requestIds: ["request:alpha:1"], resultDigest: null,
    }, "pi");
    expect(registered.ok).toBe(true);

    const result = await recordClaudeSpawnCorrelation(
      spawnPayload("LOOM_REQUEST_ID: request:alpha:1\nReview.", "agent-x"), bindingDirectory);

    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("belongs to Pi, not Claude Code") });
    expect(correlator(run, "agent-x")).toBeNull();
  });

  it("lets explicit environment authority take precedence over the session binding", async () => {
    const bound = await stagedRun("bound", ["request:alpha:1"]);
    const explicit = await stagedRun("explicit", ["request:alpha:1"]);
    await bind(bound);
    process.env[RUNS_ROOT_ENV] = explicit.runsRoot;
    process.env[RUN_DIR_ENV] = explicit.runDirectory;

    const result = await recordClaudeSpawnCorrelation(
      spawnPayload("LOOM_REQUEST_ID: request:alpha:1\nReview.", "agent-env"), bindingDirectory);

    expect(result).toEqual({ kind: "allow" });
    expect(correlator(explicit, "agent-env")).not.toBeNull();
    expect(correlator(bound, "agent-env")).toBeNull();
  });
});

describe("Claude SubagentStop capture through the session run binding", () => {
  const payload = JSON.stringify({ schemaVersion: 2, kind: "standalone-review", findings: [] });

  it("captures into the bound run whose correlator records the agent", async () => {
    const run = await stagedRun("capture", ["request:alpha:1"]);
    await bind(run);
    await bind(await stagedRun("unrelated", ["request:beta:1"]));
    const prompt = "LOOM_REQUEST_ID: request:alpha:1\nReview.";
    expect(await recordClaudeSpawnCorrelation(spawnPayload(prompt, "agent-alpha"), bindingDirectory)).toEqual({ kind: "allow" });

    const result = await captureOrchestrationResult(stop("agent-alpha", handbackTranscript("alpha", prompt, payload)), []);

    expect(result).toEqual({ kind: "passthrough" });
    expect(capturedText(run, run.requests[0]!)).toBe(payload);
  });

  it("captures a foreground spawn whose stop precedes its PostToolUse, then agrees with that PostToolUse", async () => {
    const run = await stagedRun("foreground", ["request:alpha:1"]);
    await bind(run);
    const prompt = "LOOM_REVIEW_CONTEXT: standalone\nLOOM_REQUEST_ID: request:alpha:1\nReview.";

    const result = await captureOrchestrationResult(stop("agent-fg", handbackTranscript("fg", prompt, payload)), []);

    expect(result).toEqual({ kind: "passthrough" });
    expect(correlator(run, "agent-fg")).toMatchObject({ requestId: "request:alpha:1", role: "code-reviewer", attempt: 1 });
    expect(capturedText(run, run.requests[0]!)).toBe(payload);
    expect(await recordClaudeSpawnCorrelation(spawnPayload(prompt, "agent-fg"), bindingDirectory)).toEqual({ kind: "allow" });
  });

  it("leaves an ad-hoc agent alone when the session has no binding", async () => {
    const result = await captureOrchestrationResult(stop("agent-adhoc", join(base, "never-read.jsonl")), []);

    expect(result).toEqual({ kind: "passthrough" });
  });

  it("leaves an uncorrelated, unmarked agent alone in a session with bound runs", async () => {
    const run = await stagedRun("bound", ["request:alpha:1"]);
    await bind(run);

    const result = await captureOrchestrationResult(
      stop("agent-adhoc", handbackTranscript("adhoc", "Summarise the README.", "summary")), []);

    expect(result).toEqual({ kind: "passthrough" });
    expect(correlator(run, "agent-adhoc")).toBeNull();
  });

  it("fails closed when an agent is correlated in several bound runs", async () => {
    const first = await stagedRun("first", ["request:alpha:1"]);
    const second = await stagedRun("second", ["request:beta:1"]);
    await bind(first);
    await bind(second);
    process.env[RUNS_ROOT_ENV] = first.runsRoot;
    process.env[RUN_DIR_ENV] = first.runDirectory;
    await recordClaudeSpawnCorrelation(spawnPayload("LOOM_REQUEST_ID: request:alpha:1\nGo.", "agent-dup"), bindingDirectory);
    process.env[RUNS_ROOT_ENV] = second.runsRoot;
    process.env[RUN_DIR_ENV] = second.runDirectory;
    await recordClaudeSpawnCorrelation(spawnPayload("LOOM_REQUEST_ID: request:beta:1\nGo.", "agent-dup"), bindingDirectory);
    delete process.env[RUNS_ROOT_ENV];
    delete process.env[RUN_DIR_ENV];

    const result = await captureOrchestrationResult(stop("agent-dup", handbackTranscript("dup", "x", payload)), []);

    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("correlated in multiple session-bound runs") });
  });

  it("fails closed on a stop whose spawn prompt names a request no binding issued", async () => {
    await bind(await stagedRun("bound", ["request:alpha:1"]));

    const result = await captureOrchestrationResult(
      stop("agent-x", handbackTranscript("stale", "LOOM_REQUEST_ID: request:stale:1\nGo.", payload)), []);

    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("no Claude Code session run binding contains issued request request:stale:1") });
  });

  it("fails closed on an unreadable binding registry", async () => {
    writeFileSync(join(bindingDirectory, `${SESSION}${ORCHESTRATION_RUNS_SUFFIX}`), "{not json");

    const result = await captureOrchestrationResult(stop("agent-x", join(base, "never-read.jsonl")), []);

    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("invalid JSON") });
  });

  it("skips a bound run whose directory was removed", async () => {
    const removed = await stagedRun("removed", ["request:alpha:1"]);
    await bind(removed);
    rmSync(removed.runDirectory, { recursive: true });

    const result = await captureOrchestrationResult(
      stop("agent-adhoc", handbackTranscript("after-removal", "Plain task.", "done")), []);

    expect(result).toEqual({ kind: "passthrough" });
  });
});

describe("resolveClaudeStopRun", () => {
  it("never reads the spawn prompt once a bound run's correlator claims the agent", async () => {
    const run = await stagedRun("claimed", ["request:alpha:1"]);
    await bind(run);
    await recordClaudeSpawnCorrelation(spawnPayload("LOOM_REQUEST_ID: request:alpha:1\nGo.", "agent-a"), bindingDirectory);
    let promptReads = 0;

    const resolved = resolveClaudeStopRun(context(), "agent-a", () => { promptReads += 1; return { ok: true, value: null }; });

    expect(resolved).toEqual({ ok: true, value: { kind: "bound", run: { runsRoot: run.runsRoot, runDirectory: run.runDirectory } } });
    expect(promptReads).toBe(0);
  });

  it("names the uncorrelated request a marked spawn prompt claims", async () => {
    const run = await stagedRun("pending", ["request:alpha:1"]);
    await bind(run);

    const resolved = resolveClaudeStopRun(context(), "agent-a", () => ({ ok: true, value: "LOOM_REQUEST_ID: request:alpha:1" }));

    expect(resolved).toEqual({ ok: true, value: {
      kind: "uncorrelated",
      run: { runsRoot: run.runsRoot, runDirectory: run.runDirectory },
      requestId: "request:alpha:1",
    } });
  });

  it("treats an unsafe session id as naming no registry", () => {
    expect(resolveClaudeStopRun(context({ sessionId: "../../escape" }), "agent-a", () => {
      throw new Error("must not read");
    })).toEqual({ ok: true, value: { kind: "unbound" } });
  });

  it("refuses half an explicit authority", () => {
    expect(resolveClaudeStopRun(context({ runsRoot: "/tmp/runs" }), "agent-a", () => ({ ok: true, value: null })))
      .toMatchObject({ ok: false, message: expect.stringContaining("requires both") });
  });

  it("fails closed when the session has bindings but the stop names no agent", async () => {
    await bind(await stagedRun("bound", ["request:alpha:1"]));

    expect(resolveClaudeStopRun(context(), "", () => ({ ok: true, value: null })))
      .toMatchObject({ ok: false, message: expect.stringContaining("names no agent_id") });
  });
});

describe("resolveClaudeSpawnRun", () => {
  it("requires a session id to resolve a marker without explicit authority", () => {
    expect(resolveClaudeSpawnRun(context({ sessionId: undefined }), "request:alpha:1"))
      .toMatchObject({ ok: false, message: expect.stringContaining("no session_id") });
  });

  it("returns the explicit run without consulting bindings", () => {
    expect(resolveClaudeSpawnRun(context({ runsRoot: "/r", runDirectory: "/r/run.x", sessionId: undefined }), "request:alpha:1"))
      .toEqual({ ok: true, value: { runsRoot: "/r", runDirectory: "/r/run.x" } });
  });
});

describe("establishClaudeStopRun foreground refusals", () => {
  const prompt = "LOOM_REQUEST_ID: request:alpha:1\nReview.";

  /**
   * Point Claude's transcript/meta derivation at an empty hermetic config tree,
   * so nothing the real harness wrote for this session can answer for the agent.
   * Returns where the derived `agent-<id>.*` files for this session would live.
   */
  function hermeticClaudeConfig(): string {
    const configDir = join(base, "claude-config");
    const projectDir = join(base, "project");
    mkdirSync(projectDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.CLAUDE_PROJECT_DIR = projectDir;
    const subagents = join(configDir, "projects", projectSlug(projectDir), SESSION, "subagents");
    mkdirSync(subagents, { recursive: true });
    return subagents;
  }

  it("refuses a marked foreground stop whose transcript cannot be located, recording no correlator", async () => {
    const run = await stagedRun("no-transcript", ["request:alpha:1"]);
    await bind(run);
    hermeticClaudeConfig();

    const result = await establishClaudeStopRun({
      session_id: SESSION,
      agent_id: "agent-lost",
      agent_type: "loom:code-reviewer",
      agent_transcript_path: join(base, "missing.jsonl"),
    }, context());

    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("no transcript can be located") });
    expect(correlator(run, "agent-lost")).toBeNull();
  });

  it("refuses a marked foreground stop whose role resolves empty, recording no correlator", async () => {
    const run = await stagedRun("no-role", ["request:alpha:1"]);
    await bind(run);
    hermeticClaudeConfig();

    const result = await establishClaudeStopRun({
      session_id: SESSION,
      agent_id: "agent-roleless",
      agent_transcript_path: handbackTranscript("roleless", prompt, "{}"),
    }, context());

    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("has no agent role to correlate") });
    expect(correlator(run, "agent-roleless")).toBeNull();
  });

  it("refuses a marked foreground stop whose role metadata is unreadable, recording no correlator", async () => {
    const run = await stagedRun("bad-role", ["request:alpha:1"]);
    await bind(run);
    writeFileSync(join(hermeticClaudeConfig(), "agent-agent-badmeta.meta.json"), "{not json");

    const result = await establishClaudeStopRun({
      session_id: SESSION,
      agent_id: "agent-badmeta",
      agent_transcript_path: handbackTranscript("badmeta", prompt, "{}"),
    }, context());

    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("cannot resolve the role of Claude agent agent-badmeta") });
    expect(correlator(run, "agent-badmeta")).toBeNull();
  });
});
