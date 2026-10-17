/**
 * CT-2 acceptance: `helper stop-check-plan` renders the affected plan next to
 * the unchanged acceptance plan, and it shows exactly the plan the live
 * SubagentStop hook acts on.
 *
 * Every testcase drives the production handler `createStopCheckPlanHandler(write)`
 * over a State File in a fresh Git project. A Task's changed files come from
 * its live attempt, which is what production leaves on disk:
 * - an attempt reserved through the spawn registration;
 * - a published implementation sidecar and a roster entry;
 * - FileWrite facts on the session evidence ledger, and the files themselves.
 * AS-034 then runs the real SubagentStop dispatcher over the same fixture,
 * with recording runner ports, and compares what it launches with what the
 * plan shows.
 *
 * Each testcase builds the manifest it needs, so a key the parser refuses
 * fails that testcase alone.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AFFECTED_OFF_REASON_TEXT,
  AFFECTED_OUTSIDE_CWD_PREFIX,
  AFFECTED_SECTION_HEADING,
  AFFECTED_STOP_CHECK_OFF,
  MAX_AFFECTED_RUNNER_TIMEOUT_MS,
  type AffectedOffReason,
  type StopChecksPorts,
} from "../../src/core/affected-stop-check-types";
import type { AcceptanceContract } from "../../src/core/acceptance-contract";
import { renderStopCheckPlan } from "../../src/core/acceptance-contract/stop-check-plan";
import { sha256Bytes } from "../../src/core/digest";
import type { ImplementationAttemptAuthority } from "../../src/core/implementation-completion";
import { UNKNOWN_TASK_PREFIX } from "../../src/core/stop-check-plan-types";
import { freezeVerificationManifest, type FrozenVerificationManifest } from "../../src/core/verification-manifest";
import { createStopCheckPlanHandler } from "../../src/handlers/helpers/stop-check-plan";
import { runDispatch } from "../../src/handlers/subagent-stop/dispatch";
import { UNKEPT_BLOCK_COUNTERS } from "../../src/handlers/subagent-stop/acceptance-stop-check";
import { registerTaskExecutionBatch } from "../../src/handlers/task-execution";
import { publishImplementationAttemptSidecar } from "../../src/implementation-attempt-sidecar";
import {
  appendEvidence,
  epochOf,
  markAgentActive,
  parseAgentId,
  parseAgentType,
  parseSessionId,
  type Evidence,
} from "../../src/machine";
import type { CompletionCheckRunnerResult } from "../../src/orchestration/completion-check-runner";
import type { HookResult, Task, TaskGraph } from "../../src/types";
import { parseCanonicalRepositoryRoot, type CanonicalRepositoryRoot } from "../../src/utils/workspace-digest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { statePathIn, task, writeStateFile } from "../fixtures/contract-status-fixtures";
import { frozenContract, stopCheckGraph } from "../fixtures/stop-check-plan-fixtures";

type Ports = StopChecksPorts<CanonicalRepositoryRoot, CompletionCheckRunnerResult>;

const SESSION = "stop-check-plan-affected-session";
const AGENT_TYPE = "code-implementer-agent";
const ACCEPTANCE_REPORT = ".loom/completion-reports/acceptance.junit.xml";
const AFFECTED_REPORT = ".loom/completion-reports/affected.junit.xml";
const PAYLOAD_TYPES = "src/payload-types.ts";
const PAYLOAD_ACCEPTANCE = "tests/payload.acceptance.test.ts";
const OWED = "AS-001: one valid call wins";

const ACCEPTANCE_RUNNER = {
  executable: "vitest",
  args: ["run", "--reporter=junit", `--outputFile=${ACCEPTANCE_REPORT}`, "{files}"],
  cwd: ".",
  timeoutMs: 120_000,
  report: { kind: "required-file", path: ACCEPTANCE_REPORT },
};
const AFFECTED_RUNNER = {
  executable: "vitest",
  args: ["related", "--run", "--reporter=junit", `--outputFile=${AFFECTED_REPORT}`, "{files}"],
  cwd: ".",
  timeoutMs: MAX_AFFECTED_RUNNER_TIMEOUT_MS,
  report: { kind: "required-file", path: AFFECTED_REPORT },
};
const affectedArgv = (...files: string[]): readonly string[] => [AFFECTED_RUNNER.executable, ...AFFECTED_RUNNER.args.slice(0, -1), ...files];

/** A schema-2 manifest frozen by the production freezer; throws when it is refused. */
function manifest(runners: Readonly<{ acceptance?: boolean; affected?: Readonly<Record<string, unknown>> | boolean }>): FrozenVerificationManifest {
  const affected = runners.affected === true ? AFFECTED_RUNNER : runners.affected === false ? undefined : runners.affected;
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2,
    kind: "loom-verification-manifest",
    checks: [],
    ...(runners.acceptance === true ? { acceptanceRunner: ACCEPTANCE_RUNNER } : {}),
    ...(affected === undefined ? {} : { affectedRunner: affected }),
  })));
  if (!frozen.ok) throw new Error(`fixture manifest refused: ${frozen.error.errors.join("; ")}`);
  return frozen.value;
}

// --- Project, State File and live attempts ---

const roots: string[] = [];
const saved = { dir: process.env.LOOM_SUBAGENT_DIR, state: process.env.LOOM_STATE_PATH, project: process.env.CLAUDE_PROJECT_DIR };

afterEach(() => {
  for (const [key, value] of [["LOOM_SUBAGENT_DIR", saved.dir], ["LOOM_STATE_PATH", saved.state], ["CLAUDE_PROJECT_DIR", saved.project]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Three Tasks:
 * - T1 is CT-1's contract Task.
 * - T2 is a Wave-2 claimant owing CT-1's `AS-001` testcase.
 * - T3 is a Wave-2 Task that claims nothing.
 */
const TASKS: readonly Task[] = [
  task("T1", 1, [PAYLOAD_TYPES, PAYLOAD_ACCEPTANCE]),
  task("T2", 2, ["src/payload.ts", "src/payload.test.ts", "src/scratch.ts"], ["AS-001"]),
  task("T3", 2, ["src/ledger.ts", "src/ledger.test.js", "-e"]),
];

const CONTRACT: AcceptanceContract = frozenContract({
  id: "CT-1",
  types: PAYLOAD_TYPES,
  files: [{ path: PAYLOAD_ACCEPTANCE, anchors: ["AS-001"] }],
  roster: [{ file: PAYLOAD_ACCEPTANCE, name: OWED, anchors: ["AS-001"] }],
});

/** One FileWrite fact on the attempt's epoch. `onDisk` says whether the file exists at stop time. */
type Write = Readonly<{ path: string; via?: "tool" | "shell"; onDisk: boolean }>;
type Attempt = Readonly<{ agentId: string; taskId: "T2" | "T3"; writes: readonly Write[] }>;
type Project = Readonly<{ root: string; canonicalRoot: CanonicalRepositoryRoot; statePath: string; graph: TaskGraph }>;

/** A fresh committed Git project holding the State File, with every attempt reserved by the production spawn registration. */
async function project(frozen: FrozenVerificationManifest, attempts: readonly Attempt[]): Promise<Project> {
  const root = canonicalTempDir("loom-stop-check-plan-affected-");
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
  const { graph, json } = stopCheckGraph({ tasks: TASKS, contracts: [CONTRACT], manifest: frozen });
  const statePath = writeStateFile(root, JSON.stringify({ ...JSON.parse(json), current_wave: 2 }));
  process.env.LOOM_STATE_PATH = statePath;
  mkdirSync(process.env.LOOM_SUBAGENT_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(process.env.LOOM_SUBAGENT_DIR, `${SESSION}.task_graph`), statePath);
  if (attempts.length > 0) {
    const registered = await registerTaskExecutionBatch(attempts.map(({ taskId }) => ({ kind: "implementation", prompt: `Task ID: ${taskId}`, description: taskId })));
    if (registered.kind !== "registered") throw new Error(`fixture registration refused: ${JSON.stringify(registered)}`);
    for (const attempt of attempts) {
      const authority = registered.authorities.find(({ taskId }) => taskId === attempt.taskId);
      if (authority === undefined) throw new Error(`fixture registration reserved no attempt for ${attempt.taskId}`);
      await liveAttempt(root, statePath, attempt, authority);
    }
  }
  const canonicalRoot = parseCanonicalRepositoryRoot(root);
  if (!canonicalRoot.ok) throw new Error("fixture root");
  return { root, canonicalRoot: canonicalRoot.value, statePath, graph };
}

const transcriptPath = (agentId: string): string => join(process.env.LOOM_SUBAGENT_DIR ?? "", `${agentId}.transcript.jsonl`);

/** What SubagentStart, the write gate, the PostToolUse recorder and the agent's transcript leave for one attempt. */
async function liveAttempt(root: string, statePath: string, { agentId, taskId, writes }: Attempt, authority: ImplementationAttemptAuthority): Promise<void> {
  publishImplementationAttemptSidecar({ sessionId: SESSION, agentId, taskGraphPath: statePath, authority });
  const sessionId = parseSessionId(SESSION);
  const id = parseAgentId(agentId);
  const type = parseAgentType(AGENT_TYPE);
  if (sessionId === null || id === null || type === null) throw new Error("fixture agent");
  await markAgentActive(sessionId, id, type);
  const events: Evidence[] = writes.map(({ path, via = "tool" }) => ({ kind: "FileWrite", path: path.startsWith("/") ? path : join(root, path), via }));
  appendEvidence(sessionId, epochOf(id, type), events);
  for (const { path, onDisk } of writes) {
    if (!onDisk || path.startsWith("/")) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), `// ${path}\n`);
  }
  writeFileSync(transcriptPath(agentId), [
    { type: "system", subtype: "init", cwd: root, session_id: SESSION, tools: ["Bash"] },
    { type: "user", uuid: "user-1", message: { role: "user", content: `Task ID: ${taskId}` }, parent_tool_use_id: null },
    { type: "assistant", uuid: "assistant-1", message: { role: "assistant", content: [{ type: "text", text: "Implementation complete." }], model: "claude-fixture" }, requestId: "request-1" },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
}

type PlanRun = Readonly<{ result: HookResult; lines: readonly string[] }>;

/** `helper stop-check-plan --task <id>` through the production handler; the lines it printed. */
async function plan(taskId: string): Promise<PlanRun> {
  const written: string[] = [];
  const result = await createStopCheckPlanHandler((text) => { written.push(text); })("", ["--task", taskId]);
  const text = written.join("");
  return { result, lines: text === "" ? [] : text.replace(/\n$/, "").split("\n") };
}

/** The CT-1 acceptance lines for the Task, which the combined plan must keep unchanged. */
function acceptanceLines(graph: TaskGraph, taskId: string): readonly string[] {
  const rendering = renderStopCheckPlan(graph, taskId);
  if (rendering.kind !== "rendered") throw new Error(`${taskId} is not in the fixture graph`);
  return rendering.lines;
}

const offSection = (reason: AffectedOffReason["kind"]): readonly string[] =>
  [AFFECTED_SECTION_HEADING, `  ${AFFECTED_STOP_CHECK_OFF} — ${AFFECTED_OFF_REASON_TEXT[reason]}`];

// --- The affected plan ---

describe("stop-check-plan renders the affected plan (CT-2)", () => {
  it("AS-032: FR-028: a claimant's plan shows its current changed files, the expanded argv, the cwd and the report path after the unchanged acceptance plan", async () => {
    const at = await project(manifest({ acceptance: true, affected: true }), [{
      agentId: "agent-payload",
      taskId: "T2",
      writes: [
        { path: "src/payload.ts", onDisk: true },
        { path: "src/scratch.ts", onDisk: false },
        { path: "src/payload.test.ts", onDisk: true },
        { path: "src/payload.ts", via: "shell", onDisk: true },
      ],
    }]);

    const { result, lines } = await plan("T2");

    expect(result).toEqual({ kind: "passthrough" });
    expect(lines).toEqual([
      ...acceptanceLines(at.graph, "T2"),
      AFFECTED_SECTION_HEADING,
      "  changed files:",
      "    src/payload.ts",
      "    src/payload.test.ts",
      "  cwd: .",
      `  argv: ${JSON.stringify(affectedArgv("src/payload.ts", "src/payload.test.ts"))}`,
      `  report: ${AFFECTED_REPORT}`,
    ]);
    expect(lines.some((line) => line.includes("{files}"))).toBe(false);
  });

  it("AS-032: FR-028: a non-claimant's plan shows the acceptance check off and its affected plan on", async () => {
    const at = await project(manifest({ acceptance: true, affected: true }), [
      { agentId: "agent-ledger", taskId: "T3", writes: [{ path: "src/ledger.ts", onDisk: true }] },
    ]);

    const { lines } = await plan("T3");

    expect(lines).toEqual([
      ...acceptanceLines(at.graph, "T3"),
      AFFECTED_SECTION_HEADING,
      "  changed files:",
      "    src/ledger.ts",
      "  cwd: .",
      `  argv: ${JSON.stringify(affectedArgv("src/ledger.ts"))}`,
      `  report: ${AFFECTED_REPORT}`,
    ]);
  });

  it("AS-033: FR-028: with no affected runner frozen, the plan says the check is off for that one reason", async () => {
    const at = await project(manifest({ acceptance: true }), [
      { agentId: "agent-payload", taskId: "T2", writes: [{ path: "src/payload.ts", onDisk: true }] },
    ]);

    expect((await plan("T2")).lines).toEqual([...acceptanceLines(at.graph, "T2"), ...offSection("no-runner")]);
  });

  it("AS-033: FR-028: with no live attempt, or an attempt that changed nothing, the plan says there are no changed files", async () => {
    const at = await project(manifest({ acceptance: true, affected: true }), [{ agentId: "agent-payload", taskId: "T2", writes: [] }]);

    expect((await plan("T2")).lines).toEqual([...acceptanceLines(at.graph, "T2"), ...offSection("no-changed-files")]);
    expect((await plan("T3")).lines).toEqual([...acceptanceLines(at.graph, "T3"), ...offSection("no-changed-files")]);
  });

  it("AS-033: FR-028: an attempt whose only changed files were deleted, or lie outside the runner cwd, has no changed files, and each file outside the cwd is named", async () => {
    const at = await project(manifest({ affected: { ...AFFECTED_RUNNER, cwd: "engine" } }), [{
      agentId: "agent-ledger",
      taskId: "T3",
      writes: [{ path: "src/ledger.ts", onDisk: true }, { path: "engine/gone.ts", onDisk: false }],
    }]);

    expect((await plan("T3")).lines).toEqual([
      ...acceptanceLines(at.graph, "T3"),
      ...offSection("no-changed-files"),
      `    ${AFFECTED_OUTSIDE_CWD_PREFIX}: src/ledger.ts`,
    ]);
  });

  it("AS-033: FR-028: when the runner command cannot be formed for the changed files, the plan says so and shows the refusal", async () => {
    const nodeRunner = {
      executable: "node",
      args: ["--test", "--test-reporter=junit", `--test-reporter-destination=${AFFECTED_REPORT}`, "{files}"],
      cwd: ".",
      timeoutMs: MAX_AFFECTED_RUNNER_TIMEOUT_MS,
      report: { kind: "required-file", path: AFFECTED_REPORT },
    };
    // A changed file named like an inline-evaluation option makes `node --test` refuse the argv.
    const at = await project(manifest({ affected: nodeRunner }), [{
      agentId: "agent-ledger",
      taskId: "T3",
      writes: [{ path: "src/ledger.test.js", onDisk: true }, { path: "-e", onDisk: true }],
    }]);

    const { lines } = await plan("T3");

    const head = [...acceptanceLines(at.graph, "T3"), ...offSection("command-refused")];
    expect(lines.slice(0, head.length)).toEqual(head);
    const errors = lines.slice(head.length);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((line) => line.startsWith("    ") && line.trim() !== "")).toBe(true);
    expect(errors.join("\n")).toContain("node arguments do not select an allowed project script");
  });
});

// --- One plan for the hook and the view ---

type Launch = Readonly<{ check: "acceptance" | "affected"; argv: readonly string[]; cwd: string }>;

/** Runner ports that record each launch and report every check passing. */
function recordingPorts(at: Project): Readonly<{ ports: Ports; launches: Launch[] }> {
  const launches: Launch[] = [];
  const reports = new Map<string, Uint8Array>();
  const clock = { ms: Date.now() };
  const ports: Ports = {
    repositoryRoot: () => ({ ok: true, root: at.canonicalRoot }),
    acquireRunner: () => ({ kind: "acquired", release: () => null }),
    runCheck: async (command) => {
      const path = command.reportPolicy.kind === "required-file" ? command.reportPolicy.path : "";
      launches.push({ check: path === AFFECTED_REPORT ? "affected" : "acceptance", argv: [command.executable, ...command.args], cwd: command.cwd });
      const bytes = new TextEncoder().encode(
        `<?xml version="1.0"?><testsuites tests="1"><testsuite name="suite" tests="1"><testcase classname="${PAYLOAD_ACCEPTANCE}" name="${OWED}"></testcase></testsuite></testsuites>`);
      reports.set(join(at.root, path), bytes);
      clock.ms += 1_000;
      return {
        ok: true,
        value: {
          checkResult: {
            checkId: command.checkId,
            scope: "wave",
            outcome: { kind: "observed", exitCode: 0, timedOut: false, signal: null, report: { kind: "produced", path, digest: sha256Bytes(bytes), byteLength: bytes.byteLength } },
          },
          diagnostics: { stdoutTail: "", stderrTail: "", stdoutTruncated: false, stderrTruncated: false },
        },
      } as CompletionCheckRunnerResult;
    },
    readReport: (path) => reports.get(path) ?? new Uint8Array(),
    blocks: UNKEPT_BLOCK_COUNTERS,
    pathExists: (root, path) => existsSync(join(root, path)),
    now: () => clock.ms,
  };
  return { ports, launches };
}

/** The launches a rendered plan promises: the acceptance command, then the affected one, each only when on. */
function plannedLaunches(lines: readonly string[]): readonly Launch[] {
  const value = (prefix: string): string | undefined => lines.find((line) => line.startsWith(prefix))?.slice(prefix.length);
  const section = lines.indexOf(AFFECTED_SECTION_HEADING);
  const acceptanceArgv = value("argv: ");
  const affected = section < 0 ? [] : lines.slice(section);
  const affectedValue = (prefix: string): string | undefined => affected.find((line) => line.startsWith(prefix))?.slice(prefix.length);
  const affectedArgvLine = affectedValue("  argv: ");
  return [
    ...(acceptanceArgv === undefined ? [] : [{ check: "acceptance" as const, argv: JSON.parse(acceptanceArgv) as string[], cwd: value("cwd: ") ?? "" }]),
    ...(affectedArgvLine === undefined ? [] : [{ check: "affected" as const, argv: JSON.parse(affectedArgvLine) as string[], cwd: affectedValue("  cwd: ") ?? "" }]),
  ];
}

describe("stop-check-plan and the live hook share one plan (CT-2)", () => {
  it.each<[string, Readonly<{ acceptance?: boolean; affected?: boolean }>, Attempt]>([
    ["a claimant with both runners and changed files", { acceptance: true, affected: true },
      { agentId: "agent-payload", taskId: "T2", writes: [{ path: "src/payload.test.ts", onDisk: true }, { path: "src/payload.ts", onDisk: true }] }],
    ["a non-claimant with changed files", { acceptance: true, affected: true },
      { agentId: "agent-ledger", taskId: "T3", writes: [{ path: "src/ledger.ts", onDisk: true }, { path: "src/ledger.test.js", via: "shell", onDisk: true }] }],
    ["a claimant whose only changed file was deleted", { acceptance: true, affected: true },
      { agentId: "agent-payload", taskId: "T2", writes: [{ path: "src/scratch.ts", onDisk: false }] }],
    ["a claimant with no affected runner frozen", { acceptance: true },
      { agentId: "agent-payload", taskId: "T2", writes: [{ path: "src/payload.ts", onDisk: true }] }],
  ])("AS-034: FR-027: for %s, the live SubagentStop hook launches exactly the commands stop-check-plan shows", async (_label, runners, attempt) => {
    const at = await project(manifest(runners), [attempt]);

    const { lines } = await plan(attempt.taskId);
    expect(lines).toContain(AFFECTED_SECTION_HEADING);
    const fake = recordingPorts(at);
    await runDispatch(JSON.stringify({
      session_id: SESSION,
      agent_id: attempt.agentId,
      agent_type: AGENT_TYPE,
      agent_transcript_path: transcriptPath(attempt.agentId),
      hook_event_name: "SubagentStop",
    }), [], async () => ({ kind: "passthrough" }), fake.ports);

    expect(fake.launches).toEqual(plannedLaunches(lines));
  });
});

// --- Read-only, with the existing refusals ---

/** Every regular file under `root`, by relative path, with its digest. */
function snapshot(root: string): Readonly<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === ".git") continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(root, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  walk(root);
  return files;
}

describe("stop-check-plan stays read-only and keeps its refusals (CT-2)", () => {
  it("FR-029: AS-032: rendering a live attempt's affected plan changes no file: State File, ledger, sidecar and runtime directory are byte-identical", async () => {
    const at = await project(manifest({ acceptance: true, affected: true }), [
      { agentId: "agent-payload", taskId: "T2", writes: [{ path: "src/payload.ts", onDisk: true }] },
    ]);
    const before = snapshot(at.root);

    const { lines } = await plan("T2");

    expect(lines).toContain(AFFECTED_SECTION_HEADING);
    expect(snapshot(at.root)).toEqual(before);
  });

  it("FR-029: with an affected runner frozen, an unknown Task id and a missing TaskGraph are still refused and nothing is printed", async () => {
    const at = await project(manifest({ acceptance: true, affected: true }), [
      { agentId: "agent-ledger", taskId: "T3", writes: [{ path: "src/ledger.ts", onDisk: true }] },
    ]);

    const unknown = await plan("T9");
    expect(unknown.lines).toEqual([]);
    expect(unknown.result).toEqual({ kind: "error", message: `${UNKNOWN_TASK_PREFIX} T9 in the TaskGraph` });

    const missing = join(at.root, "elsewhere");
    process.env.LOOM_STATE_PATH = statePathIn(missing);
    const absent = await plan("T3");
    expect(absent.lines).toEqual([]);
    expect(absent.result).toMatchObject({ kind: "error", message: expect.stringContaining(statePathIn(missing)) });

    // The known Task in the same graph still renders its affected plan.
    process.env.LOOM_STATE_PATH = at.statePath;
    expect((await plan("T3")).lines).toContain(AFFECTED_SECTION_HEADING);
  });
});
