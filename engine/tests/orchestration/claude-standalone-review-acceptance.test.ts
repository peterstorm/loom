import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
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
import { git } from "../fixtures/git-repository";

/**
 * A standalone review driven end to end the way Claude Code drives it: the
 * façade CLI runs from the main agent's Bash (CLAUDECODE=1 and
 * CLAUDE_CODE_SESSION_ID, no Pi announcement, no LOOM_ORCHESTRATION_*), the
 * PostToolUse and SubagentStop hooks see only their payloads, and every
 * reviewer finishes with a SubagentHandback call. Six reviewers spawn in the
 * background (PostToolUse before SubagentStop); one runs in the foreground, so
 * its SubagentStop arrives first.
 *
 * Every scripted reviewer honours the read obligation (ADR-0022) the way a real
 * one must: it runs the exact LOOM_CONTEXT_READ_COMMAND from its issued task
 * with --diff for every listed file, page by page, and its transcript records
 * each real reader stdout as a Bash tool result. Scripted payloads, not live reviews.
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

/** README's change spans several reader pages, so skipping one is observable. */
const UPDATED_README = `# Updated fixture\n${Array.from({ length: 900 }, (_, i) => `Updated fixture line ${i}.`).join("\n")}\n`;

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
  writeFileSync(join(root, "README.md"), UPDATED_README);
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

type Project = ReturnType<typeof project>;

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, stdin = "") {
  return new Promise<Readonly<{ status: number | null; stdout: string; stderr: string }>>((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

/** The façade as Claude Code's Bash runs it: Claude session variables only. */
async function facade(p: Project, args: readonly string[], stdin = ""): Promise<Action> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: p.sessionId, LOOM_SUBAGENT_DIR: p.bindingDirectory,
    LOOM_STATE_PATH: join(p.root, ".claude/state/active_task_graph.json") };
  for (const key of ["PI_CODING_AGENT", "PI_SESSION_ID", "PI_SESSION_FILE", RUNS_ROOT_ENV, RUN_DIR_ENV]) delete env[key];
  const result = await run("bun", [cli, "helper", "orchestration", ...args], p.root, env, stdin);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Action;
}

type Read = Readonly<{ command: string; output: string }>;

/**
 * What a diligent reviewer's Bash does with its issued task: run the exact
 * read command with --diff for every listed file until nextOffset is null.
 * `skip` withholds one page (by file and page index) to script an incomplete read.
 */
async function readFrozenDiff(p: Project, task: string, skip?: Readonly<{ path: string; page: number }>): Promise<readonly Read[]> {
  const command = /^LOOM_CONTEXT_READ_COMMAND: (.*)$/m.exec(task)?.[1];
  if (command === undefined) throw new Error("issued task lacks LOOM_CONTEXT_READ_COMMAND");
  expect(task).toContain("LOOM_READ_COVERAGE: every-frozen-diff-unit");
  const paths = [...task.matchAll(/^- (.+): \d+ units, \d+ page\(s\)$/gm)].map((match) => match[1]!);
  expect(paths).toEqual(p.scope);
  const reads: Read[] = [];
  for (const path of paths) {
    let offset: number | null = 0;
    for (let page = 0; offset !== null; page += 1) {
      const invocation = `${command} --diff '${path}' --offset ${offset}`;
      const result = await run("bash", ["-c", invocation], p.root, process.env);
      expect(result.status, result.stderr).toBe(0);
      offset = (JSON.parse(result.stdout) as { nextOffset: number | null }).nextOffset;
      if (skip?.path === path && skip.page === page) continue;
      reads.push({ command: invocation, output: result.stdout });
    }
  }
  return reads;
}

/** The subagent transcript Claude Code writes: spawn prompt, each Bash read and its result, the SubagentHandback call and its acknowledgement. */
function handbackTranscript(p: Project, agentId: string, prompt: string, reads: readonly Read[], payload: string): string {
  const path = join(p.transcripts, `agent-${agentId}.jsonl`);
  writeFileSync(path, [
    { parentUuid: null, isSidechain: true, agentId, type: "user", sessionId: p.sessionId, message: { role: "user", content: prompt } },
    ...reads.flatMap(({ command, output }, index) => [
      { isSidechain: true, agentId, type: "assistant", sessionId: p.sessionId,
        message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${agentId}_read_${index}`, name: "Bash", input: { command } }] } },
      { isSidechain: true, agentId, type: "user", sessionId: p.sessionId,
        message: { role: "user", content: [{ tool_use_id: `toolu_${agentId}_read_${index}`, type: "tool_result", content: output }] } },
    ]),
    { isSidechain: true, agentId, type: "assistant", sessionId: p.sessionId,
      message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_${agentId}`, name: "SubagentHandback", input: { message: payload } }] } },
    { isSidechain: true, agentId, type: "user", sessionId: p.sessionId,
      message: { role: "user", content: [{ tool_use_id: `toolu_${agentId}`, type: "tool_result",
        content: [{ type: "text", text: "{\"success\":true,\"message\":\"Report delivered to your caller.\"}" }] }] } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

const postToolUse = (p: Project, role: string, prompt: string, agentId: string, status: string) =>
  recordClaudeSpawnCorrelation({
    session_id: p.sessionId,
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: { description: `${role} review`, subagent_type: `loom:${role}`, prompt },
    tool_response: { status, agentId, agentType: `loom:${role}` },
  }, p.bindingDirectory);

const subagentStop = (p: Project, role: string, agentId: string, transcriptPath: string) =>
  runDispatch(JSON.stringify({
    session_id: p.sessionId,
    agent_id: agentId,
    agent_type: `loom:${role}`,
    agent_transcript_path: transcriptPath,
  }), []);

/** One background reviewer: spawn reported first, then its stop with the scripted reads. */
async function backgroundReview(p: Project, agentId: string, request: Readonly<{ authority: AgentRequestAuthority; task: string }>,
  reads: readonly Read[]): Promise<void> {
  expect(await postToolUse(p, request.authority.role, request.task, agentId, "async_launched")).toEqual({ kind: "allow" });
  const stopped = await subagentStop(p, request.authority.role, agentId, handbackTranscript(p, agentId, request.task, reads, EMPTY_REVIEW));
  expect(stopped, JSON.stringify(stopped)).toEqual({ kind: "passthrough" });
}

async function startReview(p: Project, runId: string): Promise<readonly Readonly<{ authority: AgentRequestAuthority; task: string }>[]> {
  // The hooks run in-process here; they must learn the run from the binding alone.
  delete process.env[RUNS_ROOT_ENV];
  delete process.env[RUN_DIR_ENV];
  process.env.LOOM_SUBAGENT_DIR = p.bindingDirectory;
  const initial = await facade(p, ["start", "standalone-review", "--runs-root", p.runsRoot, "--run", runId],
    JSON.stringify({ kind: "all", files: p.scope, dryRun: false }));
  expect(initial.kind).toBe("spawn-batch");
  const requests = initial.requests!;
  expect(requests.map(({ authority }) => authority.role)).toEqual(STANDALONE_REVIEWER_ROLES);
  return requests;
}

describe("Claude Code standalone review through session run bindings", () => {
  it("captures every SubagentHandback result without LOOM_ORCHESTRATION_* and resumes to a published result", async () => {
    const p = project();
    const requests = await startReview(p, "run.claude-e2e");
    const registry = JSON.parse(readFileSync(join(p.bindingDirectory, `${p.sessionId}${ORCHESTRATION_RUNS_SUFFIX}`), "utf8"));
    expect(registry).toMatchObject({ harness: "claude-code", sessionId: p.sessionId });

    const [foreground, ...background] = requests;
    for (const [index, request] of background.entries()) {
      await backgroundReview(p, `a-background-${index}`, request, await readFrozenDiff(p, request.task));
    }
    // Foreground: the agent finishes (SubagentStop) before its Agent call returns (PostToolUse).
    const foregroundStop = await subagentStop(p, foreground!.authority.role, "a-foreground",
      handbackTranscript(p, "a-foreground", foreground!.task, await readFrozenDiff(p, foreground!.task), EMPTY_REVIEW));
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
  }, 180_000);

  it("refuses a reviewer that skipped a frozen diff page, retries it with the unread range, and admits the complete read", async () => {
    const p = project();
    const requests = await startReview(p, "run.claude-coverage");
    const [skimmer, ...diligent] = requests;
    await backgroundReview(p, "a-skimmer", skimmer!, await readFrozenDiff(p, skimmer!.task, { path: "README.md", page: 1 }));
    for (const [index, request] of diligent.entries()) {
      await backgroundReview(p, `a-diligent-${index}`, request, await readFrozenDiff(p, request.task));
    }

    // The skimmer's empty review is well-formed, yet the engine observed an
    // unread README page: its slot is retried, and only its slot.
    const retried = await facade(p, ["resume", "--runs-root", p.runsRoot, "--run", "run.claude-coverage"]);
    expect(retried.kind, JSON.stringify(retried)).toBe("spawn-batch");
    expect(retried.requests!.map(({ authority }) => [authority.slotId, authority.attempt])).toEqual([[skimmer!.authority.slotId, 2]]);
    const retry = retried.requests![0]!;
    expect(retry.task).toContain("read coverage incomplete");
    expect(retry.task).toMatch(/README\.md \(\d+ of \d+ units unread: \d+-\d+\)/);

    await backgroundReview(p, "a-skimmer-retry", retry, await readFrozenDiff(p, retry.task));
    const done = await facade(p, ["resume", "--runs-root", p.runsRoot, "--run", "run.claude-coverage"]);
    expect(done.kind, JSON.stringify(done)).toBe("done");
    const result = JSON.parse(readFileSync(join(p.runsRoot, "run.claude-coverage", "result.json"), "utf8"));
    expect(result.reviewer_evidence).toHaveLength(STANDALONE_REVIEWER_ROLES.length);
  }, 240_000);
});
