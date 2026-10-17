/**
 * INV-7 matrix: one changed-files derivation at stop.
 *
 * One ledger-plus-filesystem fixture: an attempt epoch whose FileWrites hold
 * a file written twice, a file deleted by stop time, a renamed file (its old
 * path gone, its new path minted by `mv` as a shell FileWrite), and a write
 * outside the repository, next to a sibling's epoch on the same ledger. The
 * same epoch goes through every sibling entry point, and each must hand the
 * affected runner exactly what the owner, `changedFilesAtStop`, derives:
 * - the Claude live stop, `runDispatch`, from its evidence snapshot;
 * - the Pi report-only stop, `reportImplementationStopChecks`, from the
 *   child's epoch in the parent ledger (`piChildEvidence`);
 * - `helper stop-check-plan`, from `liveAttemptEvidence`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { piChildEvidence } from "../../../pi/evidence-recorder";
import { reportImplementationStopChecks } from "../../../pi/subagent-stop";
import { piGrantedAgentId } from "../../../pi/write-grant";
import { changedFilesAtStop } from "../../src/core/changed-files";
import { freezeVerificationManifest } from "../../src/core/verification-manifest";
import { createStopCheckPlanHandler } from "../../src/handlers/helpers/stop-check-plan";
import { runDispatch } from "../../src/handlers/subagent-stop/dispatch";
import { registerTaskExecutionBatch } from "../../src/handlers/task-execution";
import { publishImplementationAttemptSidecar } from "../../src/implementation-attempt-sidecar";
import {
  appendEvidence,
  epochOf,
  fsSessionRegistry,
  markAgentActive,
  parseAgentId,
  parseAgentType,
  parseSessionId,
  type Evidence,
} from "../../src/machine";
import { StateManager } from "../../src/state-manager";
import { parseCanonicalRepositoryRoot, type CanonicalRepositoryRoot } from "../../src/utils/workspace-digest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { stateFileJson, task, writeStateFile } from "../fixtures/contract-status-fixtures";
import { AFFECTED_ARGV_PREFIX, AFFECTED_RUNNER, argvOf, recordingStopCheckPorts } from "../fixtures/stop-check-runners";

const SESSION = "changed-files-matrix-session";
const PI_PARENT_SESSION = "changed-files-matrix-pi-parent";
const AGENT_TYPE = "code-implementer-agent";
const PI_GRANT_TOKEN = "ab".repeat(32);
const EMPTY_REPORT = new TextEncoder().encode('<testsuites><testsuite name="s" tests="0"></testsuite></testsuites>');

const TASKS = [
  task("T2", 1, ["src/payload.ts"]),
  task("T3", 1, ["src/ledger.ts", "src/old-name.ts", "src/new-name.ts", "src/gone.ts"]),
];

/** One FileWrite of the epoch; `onDisk` says whether the path exists at stop time. */
type Write = Readonly<{ path: string; via: "tool" | "shell"; onDisk: boolean }>;

const EPOCH: readonly Write[] = [
  { path: "src/ledger.ts", via: "tool", onDisk: true },
  { path: "/elsewhere/outside-the-repository.ts", via: "tool", onDisk: false },
  { path: "src/old-name.ts", via: "tool", onDisk: false },
  // `mv src/old-name.ts src/new-name.ts` mints a shell FileWrite for its destination.
  { path: "src/new-name.ts", via: "shell", onDisk: true },
  { path: "src/ledger.ts", via: "shell", onDisk: true },
  { path: "src/gone.ts", via: "tool", onDisk: false },
];
const SIBLING_EPOCH: readonly Write[] = [{ path: "src/payload.ts", via: "tool", onDisk: true }];

const roots: string[] = [];
const saved = { dir: process.env.LOOM_SUBAGENT_DIR, state: process.env.LOOM_STATE_PATH, project: process.env.CLAUDE_PROJECT_DIR };

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of [["LOOM_SUBAGENT_DIR", saved.dir], ["LOOM_STATE_PATH", saved.state], ["CLAUDE_PROJECT_DIR", saved.project]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const parsed = <T>(value: T | null, what: string): T => {
  if (value === null) throw new Error(`fixture ${what} must parse`);
  return value;
};

const events = (root: string, writes: readonly Write[]): Evidence[] =>
  writes.map(({ path, via }) => ({ kind: "FileWrite", path: path.startsWith("/") ? path : join(root, path), via }));

const transcriptPath = (agentId: string): string => join(process.env.LOOM_SUBAGENT_DIR ?? "", `${agentId}.transcript.jsonl`);

type Project = Readonly<{ root: string; canonicalRoot: CanonicalRepositoryRoot; statePath: string }>;

/** A committed Git project with a TaskGraph, both attempts live, and the fixture's files on disk. */
async function project(): Promise<Project> {
  const root = canonicalTempDir("loom-changed-files-matrix-");
  roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init", "--quiet");
  git("config", "user.email", "loom@example.test");
  git("config", "user.name", "Loom Test");
  writeFileSync(join(root, ".gitignore"), ".loom/\nsubagents/\n");
  git("add", ".gitignore");
  git("commit", "--quiet", "-m", "seed");
  process.env.LOOM_SUBAGENT_DIR = join(root, "subagents");
  process.env.CLAUDE_PROJECT_DIR = root;
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2, kind: "loom-verification-manifest", checks: [], affectedRunner: AFFECTED_RUNNER,
  })));
  if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
  const raw = JSON.parse(stateFileJson(TASKS)) as Record<string, unknown>;
  const statePath = writeStateFile(root, JSON.stringify({ ...raw, current_wave: 1, verification_manifest: frozen.value }));
  process.env.LOOM_STATE_PATH = statePath;
  mkdirSync(process.env.LOOM_SUBAGENT_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(process.env.LOOM_SUBAGENT_DIR, `${SESSION}.task_graph`), statePath);

  const registered = await registerTaskExecutionBatch(["T3", "T2"].map((taskId) => ({ kind: "implementation" as const, prompt: `Task ID: ${taskId}`, description: taskId })));
  if (registered.kind !== "registered") throw new Error(`fixture registration refused: ${JSON.stringify(registered)}`);
  const session = parsed(parseSessionId(SESSION), "session");
  const type = parsed(parseAgentType(AGENT_TYPE), "agent type");
  for (const [agentId, taskId, writes] of [["agent-ledger", "T3", EPOCH], ["agent-payload", "T2", SIBLING_EPOCH]] as const) {
    const authority = registered.authorities.find((candidate) => candidate.taskId === taskId);
    if (authority === undefined) throw new Error(`fixture registration reserved no attempt for ${taskId}`);
    publishImplementationAttemptSidecar({ sessionId: SESSION, agentId, taskGraphPath: statePath, authority });
    const id = parsed(parseAgentId(agentId), "agent id");
    await markAgentActive(session, id, type);
    appendEvidence(session, epochOf(id, type), events(root, writes));
    writeFileSync(transcriptPath(agentId), [
      { type: "system", subtype: "init", cwd: root, session_id: SESSION, tools: ["Bash"] },
      { type: "user", uuid: "user-1", message: { role: "user", content: `Task ID: ${taskId}` }, parent_tool_use_id: null },
      { type: "assistant", uuid: "assistant-1", message: { role: "assistant", content: [{ type: "text", text: "Done." }], model: "claude-fixture" }, requestId: "request-1" },
    ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  }
  for (const { path, onDisk } of [...EPOCH, ...SIBLING_EPOCH]) {
    if (!onDisk || path.startsWith("/")) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `// ${path}\n`);
  }
  const canonicalRoot = parseCanonicalRepositoryRoot(root);
  if (!canonicalRoot.ok) throw new Error("fixture root");
  return { root, canonicalRoot: canonicalRoot.value, statePath };
}

/** Production-shaped ports with the real existence predicate, and the files the last affected launch ran over. */
function recordingPorts(at: Project) {
  const { ports, launches } = recordingStopCheckPorts({
    root: at.canonicalRoot,
    report: () => EMPTY_REPORT,
    pathExists: (root, path) => existsSync(join(root, path)),
  });
  return {
    ports,
    affectedFiles: (): readonly string[] | null => {
      const last = launches.at(-1);
      if (last === undefined) return null;
      const argv = argvOf(last);
      expect(argv.slice(0, AFFECTED_ARGV_PREFIX.length)).toEqual(AFFECTED_ARGV_PREFIX);
      return argv.slice(AFFECTED_ARGV_PREFIX.length);
    },
  };
}

describe("INV-7: every stop shell hands the affected runner the owner's changed files", () => {
  it("AS-024: FR-019: the Claude stop, the Pi stop and stop-check-plan agree with changedFilesAtStop over one epoch", async () => {
    const at = await project();
    const owner = changedFilesAtStop(events(at.root, EPOCH), at.root, (path) => existsSync(join(at.root, path)));
    expect(owner).toEqual({ kind: "some", files: ["src/ledger.ts", "src/new-name.ts"] });
    const expected = owner.kind === "some" ? [...owner.files] : [];

    // helper stop-check-plan, through liveAttemptEvidence.
    const written: string[] = [];
    const planned = await createStopCheckPlanHandler((text) => { written.push(text); })("", ["--task", "T3"]);
    expect(planned).toEqual({ kind: "passthrough" });
    const lines = written.join("").split("\n");
    const listed = lines.slice(lines.indexOf("  changed files:") + 1).filter((line) => line.startsWith("    ")).map((line) => line.trim());

    // The Claude live stop, through the dispatcher's evidence snapshot.
    const claude = recordingPorts(at);
    await runDispatch(JSON.stringify({
      session_id: SESSION, agent_id: "agent-ledger", agent_type: AGENT_TYPE,
      agent_transcript_path: transcriptPath("agent-ledger"), hook_event_name: "SubagentStop",
    }), [], async () => ({ kind: "passthrough" }), claude.ports);

    // The Pi report-only stop, through the child's epoch in the parent ledger.
    const parentSession = parsed(parseSessionId(PI_PARENT_SESSION), "Pi parent session");
    const type = parsed(parseAgentType(AGENT_TYPE), "agent type");
    const grantAgent = parsed(parseAgentId(parsed(piGrantedAgentId(PI_GRANT_TOKEN), "grant agent id")), "grant agent id");
    appendEvidence(parentSession, epochOf(grantAgent, type), events(at.root, EPOCH));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const pi = recordingPorts(at);
    const manager = StateManager.fromPath(at.statePath);
    if (manager === null) throw new Error("fixture TaskGraph must load");
    await reportImplementationStopChecks(
      manager,
      "T3",
      piChildEvidence(parentSession, PI_GRANT_TOKEN, type, fsSessionRegistry),
      pi.ports,
    );

    expect(listed).toEqual(expected);
    expect(claude.affectedFiles()).toEqual(expected);
    expect(pi.affectedFiles()).toEqual(expected);
  });
});
