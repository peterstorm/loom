import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";
import { STANDALONE_REVIEWER_ROLES } from "../../src/core/standalone-review-scope";
import { recordClaudeSpawnCorrelation } from "../../src/handlers/post-tool-use/record-orchestration-spawn";
import { runDispatch } from "../../src/handlers/subagent-stop/dispatch";
import { RUN_DIR_ENV, RUNS_ROOT_ENV } from "../../src/orchestration/harness-capture-runtime";
import { openRunDirectory } from "../../src/orchestration/run-directory-handle";
import { ORCHESTRATION_RUNS_SUFFIX, readSessionRunBindings } from "../../src/orchestration/session-run-bindings";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";

/**
 * A standalone review driven end to end the way Claude Code drives it: the
 * façade CLI runs from the main agent's Bash (CLAUDECODE=1 and
 * CLAUDE_CODE_SESSION_ID, no Pi announcement, no LOOM_ORCHESTRATION_*), the
 * PostToolUse and SubagentStop hooks see only their payloads, and every
 * reviewer finishes with a SubagentHandback call. Six reviewers spawn in the
 * background (PostToolUse before SubagentStop); one runs in the foreground, so
 * its SubagentStop arrives first. Scripted fixture payloads, not live reviews.
 */

const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const EMPTY_REVIEW = JSON.stringify({ schemaVersion: 2, kind: "standalone-review", findings: [] });
const ENV_KEYS = [RUNS_ROOT_ENV, RUN_DIR_ENV, "LOOM_SUBAGENT_DIR"] as const;
const roots: string[] = [];
let previousEnv: readonly (readonly [string, string | undefined])[];

beforeEach(() => {
  previousEnv = ENV_KEYS.map((key) => [key, process.env[key]] as const);
});

afterEach(() => {
  for (const [key, prior] of previousEnv) {
    if (prior === undefined) delete process.env[key];
    else process.env[key] = prior;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Action = Readonly<{
  kind: string;
  requests?: readonly Readonly<{ authority: AgentRequestAuthority; task: string }>[];
}>;

function git(root: string, args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

function project() {
  const root = canonicalTempDir("loom-claude-standalone-");
  roots.push(root);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "runs"));
  writeFileSync(join(root, "src", "a.ts"), "export const value = 1;\n");
  writeFileSync(join(root, "README.md"), "# Fixture\n");
  for (const args of [["init", "-q"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"],
    ["add", "src/a.ts", "README.md"], ["commit", "-qm", "fixture baseline"]]) git(root, args);
  writeFileSync(join(root, "src", "a.ts"), "export const value = 2;\n");
  writeFileSync(join(root, "README.md"), "# Updated fixture\n");
  const session = canonicalTempDir("loom-claude-session-");
  roots.push(session);
  return {
    root,
    runsRoot: join(root, "runs"),
    scope: ["README.md", "src/a.ts"],
    sessionId: randomUUID(),
    bindingDirectory: join(session, "subagents"),
    transcripts: session,
  };
}

/** The façade as Claude Code's Bash runs it: Claude session variables only. */
async function facade(p: ReturnType<typeof project>, args: readonly string[], stdin = ""): Promise<Action> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: p.sessionId, LOOM_SUBAGENT_DIR: p.bindingDirectory,
    LOOM_STATE_PATH: join(p.root, ".claude/state/active_task_graph.json") };
  for (const key of ["PI_CODING_AGENT", "PI_SESSION_ID", "PI_SESSION_FILE", RUNS_ROOT_ENV, RUN_DIR_ENV]) delete env[key];
  const result = await new Promise<Readonly<{ status: number | null; stdout: string; stderr: string }>>((resolve, reject) => {
    const child = spawn("bun", [cli, "helper", "orchestration", ...args], { cwd: p.root, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin);
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Action;
}

/** The subagent transcript Claude Code writes: spawn prompt, SubagentHandback call, its acknowledgement. */
function handbackTranscript(p: ReturnType<typeof project>, agentId: string, prompt: string, payload: string): string {
  const path = join(p.transcripts, `agent-${agentId}.jsonl`);
  writeFileSync(path, [
    { parentUuid: null, isSidechain: true, agentId, type: "user", sessionId: p.sessionId, message: { role: "user", content: prompt } },
    { isSidechain: true, agentId, type: "assistant", sessionId: p.sessionId,
      message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${agentId}`, name: "SubagentHandback", input: { message: payload } }] } },
    { isSidechain: true, agentId, type: "user", sessionId: p.sessionId,
      message: { role: "user", content: [{ tool_use_id: `toolu_${agentId}`, type: "tool_result",
        content: [{ type: "text", text: "{\"success\":true,\"message\":\"Report delivered to your caller.\"}" }] }] } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

const postToolUse = (p: ReturnType<typeof project>, role: string, prompt: string, agentId: string, status: string) =>
  recordClaudeSpawnCorrelation({
    session_id: p.sessionId,
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: { description: `${role} review`, subagent_type: `loom:${role}`, prompt },
    tool_response: { status, agentId, agentType: `loom:${role}` },
  }, p.bindingDirectory);

const subagentStop = (p: ReturnType<typeof project>, role: string, agentId: string, transcriptPath: string) =>
  runDispatch(JSON.stringify({
    session_id: p.sessionId,
    agent_id: agentId,
    agent_type: `loom:${role}`,
    agent_transcript_path: transcriptPath,
  }), []);

describe("Claude Code standalone review through session run bindings", () => {
  it("captures every SubagentHandback result without LOOM_ORCHESTRATION_* and resumes to a published result", async () => {
    const p = project();
    // The hooks run in-process here; they must learn the run from the binding alone.
    delete process.env[RUNS_ROOT_ENV];
    delete process.env[RUN_DIR_ENV];
    process.env.LOOM_SUBAGENT_DIR = p.bindingDirectory;

    const initial = await facade(p, ["start", "standalone-review", "--runs-root", p.runsRoot, "--run", "run.claude-e2e"],
      JSON.stringify({ kind: "all", files: p.scope, dryRun: false }));
    expect(initial.kind).toBe("spawn-batch");
    const requests = initial.requests!;
    expect(requests.map(({ authority }) => authority.role)).toEqual(STANDALONE_REVIEWER_ROLES);
    const registry = JSON.parse(readFileSync(join(p.bindingDirectory, `${p.sessionId}${ORCHESTRATION_RUNS_SUFFIX}`), "utf8"));
    expect(registry).toMatchObject({ harness: "claude-code", sessionId: p.sessionId });

    const [foreground, ...background] = requests;
    for (const [index, { authority, task }] of background.entries()) {
      const agentId = `a-background-${index}`;
      expect(await postToolUse(p, authority.role, task, agentId, "async_launched")).toEqual({ kind: "allow" });
      const stopped = await subagentStop(p, authority.role, agentId, handbackTranscript(p, agentId, task, EMPTY_REVIEW));
      expect(stopped, JSON.stringify(stopped)).toEqual({ kind: "passthrough" });
    }
    // Foreground: the agent finishes (SubagentStop) before its Agent call returns (PostToolUse).
    const foregroundStop = await subagentStop(p, foreground!.authority.role, "a-foreground",
      handbackTranscript(p, "a-foreground", foreground!.task, EMPTY_REVIEW));
    expect(foregroundStop, JSON.stringify(foregroundStop)).toEqual({ kind: "passthrough" });
    expect(await postToolUse(p, foreground!.authority.role, foreground!.task, "a-foreground", "completed")).toEqual({ kind: "allow" });

    const handle = openRunDirectory(p.runsRoot, join(p.runsRoot, "run.claude-e2e"));
    if (!handle.ok) throw new Error(handle.error.message);
    for (const { authority } of requests) {
      const bytes = handle.value.readTranscriptBytes(authority);
      expect(bytes.ok && Buffer.from(bytes.value).toString("utf8"), authority.role).toBe(EMPTY_REVIEW);
    }

    const done = await facade(p, ["resume", "--runs-root", p.runsRoot, "--run", "run.claude-e2e"]);
    expect(done.kind, JSON.stringify(done)).toBe("done");
    const resultBytes = readFileSync(join(handle.value.runDirectory, "result.json"));
    const result = JSON.parse(resultBytes.toString("utf8"));
    expect(result.reviewer_evidence).toHaveLength(STANDALONE_REVIEWER_ROLES.length);
    expect(result.surviving_critical_findings).toEqual([]);
    const completed = readSessionRunBindings(p.bindingDirectory, p.sessionId, "claude-code");
    expect(completed).toMatchObject({ ok: true, value: [expect.objectContaining({
      runId: "run.claude-e2e",
      resultDigest: createHash("sha256").update(resultBytes).digest("hex"),
    })] });
  }, 120_000);
});
