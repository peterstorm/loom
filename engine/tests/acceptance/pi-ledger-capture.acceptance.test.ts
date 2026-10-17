/**
 * CT-3 acceptance: Pi ledger capture through the shared minting rule.
 *
 * Entry points, all real:
 * - Claude Code: the PreToolUse call-start stamp (`runGuardStateFile`) and
 *   the PostToolUse recorder (`runRecordEvidence`), fed hook payloads.
 * - Pi: the extension factory (`pi/extension.ts`) registered on a fake `pi`
 *   API. A PARENT instance admits and reserves a real implementation spawn
 *   (`tool_call` on `subagent`), which issues the child's write grant. A
 *   separate CHILD instance, as in production where every Pi subagent is its
 *   own process, consumes that grant (`before_agent_start`) and receives the
 *   child's tool calls (`tool_call`, then `tool_result`). The parent instance
 *   then settles the batch (`tool_result` on `subagent`), which runs exact
 *   implementation settlement (I6) and the report-only stop checks (I7).
 *
 * Every scenario runs in a throwaway Git repository whose TaskGraph is
 * produced by the production population command (`populateTaskGraph`) over a
 * verification manifest frozen by the production freezer, so the I6 era and
 * the frozen affected runner come from the same code paths a real run uses.
 * State, ledgers and grants live under one temporary directory.
 *
 * Ledger facts are read back with `eventsForEpoch` over the ledger the
 * contract names: the Claude session under its caller's binding epoch, and
 * the Pi PARENT session under `epochOf(grant agent id, agent type)`, where the
 * grant agent id is the one the child's activation wrote to its roster.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import registerLoomPiExtension from "../../../pi/extension";
import { runRecordEvidence } from "../../src/handlers/post-tool-use/record-evidence";
import { runGuardStateFile } from "../../src/handlers/pre-tool-use/guard-state-file";
import {
  bindMachineAgent,
  epochOf,
  eventsForEpoch,
  fsSessionRegistry,
  type Evidence,
  type SessionId,
} from "../../src/machine";
import type { PiEvidenceNoRecordReason } from "../../src/machine/harness-tool-call-types";
import {
  parseAuthoredTaskRoster,
  populateTaskGraph,
  type AuthoredTask,
} from "../../src/core/task-graph-population";
import {
  defaultVerificationManifest,
  freezeVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import type { TaskGraph } from "../../src/types";
import {
  PI_EXTENSION_RUNTIME_REVISION_ENV,
  PI_EXTENSION_RUNTIME_ROOT_ENV,
} from "../../src/runtime-compatibility";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { fixturePiAgentDirectory } from "../fixtures/fixture-pi-agent-directory";
import { IMPLEMENTER_TYPE, agentIdOf, sessionIdOf } from "../fixtures/machine-identities";

// ─── Environment ──────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const temp = canonicalTempDir("loom-pi-ledger-capture-");
const subagentDir = join(temp, "subagents");
const piAgentDir = join(temp, "pi-agent");
const scratch = join(temp, "scratch");
mkdirSync(subagentDir, { recursive: true });
mkdirSync(scratch, { recursive: true });

const ENV_KEYS = [
  "LOOM_STATE_PATH",
  "LOOM_SUBAGENT_DIR",
  "PI_CODING_AGENT_DIR",
  "LOOM_ORCHESTRATION_RUNS_ROOT",
  "LOOM_ORCHESTRATION_RUN_DIR",
  "LOOM_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_ROOT",
  PI_EXTENSION_RUNTIME_ROOT_ENV,
  PI_EXTENSION_RUNTIME_REVISION_ENV,
] as const;
const previousEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]] as const));

const IMPLEMENTER = "code-implementer-agent";
const TASK_PROMPT = "Task ID: T1\nUse the code-implementer skill. Implement and test.";
const TEST_FILE = "tests/feature.test.ts";
const IMPLEMENTATION_FILE = "src/feature.ts";
const AFFECTED_REPORT = ".loom/completion-reports/affected.junit.xml";
const AFFECTED_RUNNER_SCRIPT = "scripts/affected-runner.mjs";

/** The no-record reasons the Pi child's stderr note names (frozen in the CT-3 types). */
const NO_GRANT: PiEvidenceNoRecordReason = "no-grant";
const GRANT_REJECTED: PiEvidenceNoRecordReason = "grant-rejected";

beforeAll(() => {
  // The spawn admission validates the child's rendered Pi agent definition;
  // sync them hermetically (no ambient parent model, no machine routing).
  const isolatedHome = join(temp, "routing-home");
  mkdirSync(isolatedHome, { recursive: true });
  execFileSync("bash", [join(ROOT, "scripts/sync-pi-agents.sh")], {
    cwd: ROOT,
    env: { ...process.env, PI_CODING_AGENT_DIR: piAgentDir, HOME: isolatedHome, PI_PROVIDER: "", PI_MODEL: "" },
  });
  // The route-reachability gate must consult the run's fake local route.
  cpSync(join(fixturePiAgentDirectory(), "models.json"), join(piAgentDir, "models.json"));
}, 120_000);

let stderr: string[] = [];

beforeEach(() => {
  process.env.LOOM_SUBAGENT_DIR = subagentDir;
  process.env.PI_CODING_AGENT_DIR = piAgentDir;
  delete process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
  delete process.env.LOOM_ORCHESTRATION_RUN_DIR;
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(temp, { recursive: true, force: true });
});

const stderrText = (): string => stderr.join("");

const sessionId = (): SessionId => sessionIdOf(randomUUID());

// ─── Fixture repository and TaskGraph ─────────────────────────────────────

type Repository = Readonly<{ root: string; statePath: string }>;

const TRACKED: Readonly<Record<string, string>> = Object.freeze({
  ".gitignore": ".claude/state/\n.loom/\n",
  "README.md": "# Fixture\n",
  [IMPLEMENTATION_FILE]: "export const feature = (): number => 0;\n",
  "src/legacy.ts": "export const legacy = 1;\n",
  "assets/a.txt": "a\n",
});

/**
 * A committed Git repository whose TaskGraph, populated over `manifest`, lives
 * at the canonical `.claude/state/` path.
 */
async function withPopulatedRepository(
  prefix: string,
  manifest: FrozenVerificationManifest,
  extra: Readonly<Record<string, string>>,
  body: (repository: Repository) => Promise<void>,
): Promise<void> {
  const root = canonicalTempDir(prefix);
  const statePath = join(root, ".claude", "state", "active_task_graph.json");
  const previous = process.env.LOOM_STATE_PATH;
  try {
    for (const [path, bytes] of Object.entries({ ...TRACKED, ...extra })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), bytes);
    }
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"],
      { cwd: root },
    );
    mkdirSync(dirname(statePath), { recursive: true });
    process.env.LOOM_STATE_PATH = statePath;
    populate({ root, statePath }, manifest);
    await body({ root, statePath });
  } finally {
    if (previous === undefined) delete process.env.LOOM_STATE_PATH;
    else process.env.LOOM_STATE_PATH = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

/** A non-claimant implementation Task that owes regression AND new tests (`newTests: required`). */
const implementationTask = (): AuthoredTask => Object.freeze({
  id: "T1",
  description: "implement the feature test-first",
  agent: IMPLEMENTER,
  wave: 1,
  depends_on: Object.freeze([]),
  spec_anchors: Object.freeze([]),
  spec_contributions: Object.freeze([]),
  verification_policy: Object.freeze({
    regression: Object.freeze({ kind: "required" as const }),
    new_tests: Object.freeze({ kind: "required" as const }),
  }),
  file_list: Object.freeze([IMPLEMENTATION_FILE, TEST_FILE]),
});

/** Populate the TaskGraph through the production population command and persist it. */
function populate(repository: Repository, manifest: FrozenVerificationManifest): void {
  const planPath = join(scratch, `plan-${randomUUID()}.md`);
  writeFileSync(planPath, "# Plan\n");
  const roster = parseAuthoredTaskRoster([implementationTask()]);
  if (!roster.ok) throw new Error(`fixture roster must parse: ${roster.error}`);
  const existing: TaskGraph = {
    current_phase: "decompose",
    phase_artifacts: { architecture: planPath },
    skipped_phases: ["plan-alignment"],
    spec_file: null,
    plan_file: planPath,
    tasks: [],
    wave_gates: {},
  };
  const populated = populateTaskGraph(existing, {
    planTitle: "Pi ledger capture fixture",
    validatedPlanFile: planPath,
    tasks: roster.value,
    verificationManifest: manifest,
    specIndex: { kind: "unavailable", reason: { kind: "no-spec-file" } },
    observedSpecFile: null,
    force: false,
    proofBoundary: { kind: "absent", cause: "fixture: first dispatch stamps its own baseline" },
    contracts: [],
  });
  if (!populated.ok) throw new Error(`fixture population must succeed: ${populated.error.message}`);
  writeFileSync(repository.statePath, JSON.stringify(populated.value.state, null, 2));
}

/** The operator manifest that freezes an affected runner (schema 2, AD-4). */
function affectedRunnerManifestSource(): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2,
    kind: "loom-verification-manifest",
    checks: [],
    affectedRunner: {
      executable: "node",
      args: [AFFECTED_RUNNER_SCRIPT, "{files}"],
      cwd: ".",
      timeoutMs: 60_000,
      report: { kind: "required-file", path: AFFECTED_REPORT },
    },
  }));
}

/** A runner that records the files it was given, then writes a passing JUnit report. */
function affectedRunnerScript(argvRecord: string): string {
  return [
    `import { mkdirSync, writeFileSync } from "node:fs";`,
    `writeFileSync(${JSON.stringify(argvRecord)}, JSON.stringify(process.argv.slice(2)));`,
    `mkdirSync(".loom/completion-reports", { recursive: true });`,
    `writeFileSync(${JSON.stringify(AFFECTED_REPORT)}, ` +
      `'<testsuites><testsuite name="affected" tests="1" failures="0">' + ` +
      `'<testcase classname="${TEST_FILE}" name="feature works"/></testsuite></testsuites>');`,
    "",
  ].join("\n");
}

// ─── Structured reports ──────────────────────────────────────────────────

/** A Vitest JSON report for the Task's one test file: red (behavioral failure) or green. */
function vitestReport(root: string, outcome: "red" | "green"): string {
  const failed = outcome === "red";
  return JSON.stringify({
    numTotalTestSuites: 1,
    numPassedTestSuites: failed ? 0 : 1,
    numFailedTestSuites: failed ? 1 : 0,
    numPendingTestSuites: 0,
    numTotalTests: 1,
    numPassedTests: failed ? 0 : 1,
    numFailedTests: failed ? 1 : 0,
    numPendingTests: 0,
    numTodoTests: 0,
    startTime: Date.now(),
    success: !failed,
    testResults: [{
      name: join(root, TEST_FILE),
      status: failed ? "failed" : "passed",
      message: "",
      startTime: Date.now(),
      endTime: Date.now(),
      assertionResults: [{
        ancestorTitles: ["feature"],
        fullName: "feature works",
        title: "works",
        status: failed ? "failed" : "passed",
        duration: 1,
        failureMessages: failed ? ["AssertionError: expected 0 to be 1"] : [],
      }],
    }],
  });
}

const vitestCommand = (reportPath: string): string =>
  `npx vitest run ${TEST_FILE} --reporter=json --outputFile=${reportPath}`;

// ─── Harness-neutral tool-call script ────────────────────────────────────

/**
 * One tool call, described once and delivered to either harness. `effect`
 * is what the tool did on disk; it runs between the call-start stamp and the
 * result, exactly where the real tool runs.
 */
type ToolStep =
  | Readonly<{ kind: "read"; path: string }>
  | Readonly<{ kind: "write"; path: string; content: string }>
  | Readonly<{ kind: "edit"; path: string; oldText: string; newText: string }>
  | Readonly<{
      kind: "bash";
      command: string;
      /** The process exit status the tool observed. */
      exit: number;
      stdout: string;
      /** Pi `details.exitCode`, when this Pi build exposes one (FR-033). */
      piDetailsExitCode?: number;
      effect?: () => void;
    }>;

type BashStep = Extract<ToolStep, { kind: "bash" }>;

function applyEffect(root: string, step: ToolStep): void {
  if (step.kind === "write") {
    mkdirSync(dirname(resolve(root, step.path)), { recursive: true });
    writeFileSync(resolve(root, step.path), step.content);
  } else if (step.kind === "edit") {
    const path = resolve(root, step.path);
    const current = readFileSync(path, "utf-8");
    writeFileSync(path, current.includes(step.oldText) ? current.replace(step.oldText, step.newText) : current);
  } else if (step.kind === "bash") {
    step.effect?.();
  }
}

// ─── Claude Code delivery ────────────────────────────────────────────────

type ClaudeAgent = Readonly<{ session: SessionId; agentId: string; root: string }>;

async function bindClaudeAgent(root: string): Promise<ClaudeAgent> {
  const session = sessionId();
  const agentId = `claude-impl-${randomUUID().slice(0, 8)}`;
  await bindMachineAgent(session, IMPLEMENTER_TYPE, agentIdOf(agentId));
  return { session, agentId, root };
}

function claudeEpochFacts(agent: ClaudeAgent): readonly Evidence[] {
  return eventsForEpoch(fsSessionRegistry.readEvidence(agent.session), epochOf(agentIdOf(agent.agentId), IMPLEMENTER_TYPE));
}

function claudePayload(step: ToolStep): Readonly<{ tool_name: string; tool_input: Record<string, unknown>; tool_response: unknown }> {
  switch (step.kind) {
    case "read":
      return {
        tool_name: "Read",
        tool_input: { file_path: step.path },
        tool_response: { type: "text", file: { filePath: step.path, content: "", numLines: 1, startLine: 1, totalLines: 1 } },
      };
    case "write":
      return {
        tool_name: "Write",
        tool_input: { file_path: step.path, content: step.content },
        tool_response: { type: "create", filePath: step.path, content: step.content, structuredPatch: [] },
      };
    case "edit":
      return {
        tool_name: "Edit",
        tool_input: { file_path: step.path, old_string: step.oldText, new_string: step.newText },
        tool_response: { filePath: step.path, oldString: step.oldText, newString: step.newText, structuredPatch: [], userModified: false, replaceAll: false },
      };
    case "bash":
      return {
        tool_name: "Bash",
        tool_input: { command: step.command },
        tool_response: { stdout: step.stdout, stderr: "", interrupted: false, isImage: false, exit_code: step.exit },
      };
  }
}

/** Deliver steps through Claude Code's PreToolUse stamp and PostToolUse recorder. */
async function deliverToClaude(agent: ClaudeAgent, steps: readonly ToolStep[]): Promise<void> {
  for (const step of steps) {
    const callId = `toolu_${randomUUID()}`;
    const payload = claudePayload(step);
    const envelope = { session_id: agent.session, agent_id: agent.agentId, cwd: agent.root, tool_use_id: callId };
    if (payload.tool_name === "Bash") {
      const guard = await runGuardStateFile(JSON.stringify({ ...envelope, tool_name: "Bash", tool_input: payload.tool_input }));
      expect(guard.kind, "fixture: the Claude state-file guard must admit the call").not.toBe("block");
    }
    applyEffect(agent.root, step);
    await runRecordEvidence(JSON.stringify({ ...envelope, ...payload }));
  }
}

// ─── Pi delivery ─────────────────────────────────────────────────────────

type Handler = (event: Record<string, unknown>, context: Record<string, unknown>) => unknown;

/** The slice of Pi's ExtensionAPI the extension registers on. */
class FakePi {
  readonly handlers = new Map<string, Handler[]>();

  on(event: string, handler: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  registerCommand(): void {}

  registerTool(): void {}

  async emit(event: string, payload: Record<string, unknown>, context: Record<string, unknown>): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.handlers.get(event) ?? []) results.push(await handler(payload, context));
    return results;
  }
}

/** One registered Pi extension instance: one Pi process (a parent, or one child). */
function piProcess(): FakePi {
  const pi = new FakePi();
  registerLoomPiExtension(pi as never);
  return pi;
}

const piContext = (cwd: string, session: string): Record<string, unknown> => ({
  cwd,
  hasUI: false,
  ui: { notify: () => undefined },
  abort: () => undefined,
  sessionManager: { getSessionId: () => session },
});

/** A granted Pi implementation child: the parent that spawned it and the child process itself. */
type PiChild = Readonly<{
  root: string;
  parent: FakePi;
  parentSession: SessionId;
  spawnCallId: string;
  child: FakePi;
  childSession: SessionId;
  /** The child prompt as dispatched, carrying the parent-issued grant marker. */
  prompt: string;
  /** The grant identity the child's activation wrote to its roster. */
  grantAgentId: string;
}>;

/** Reserve a real implementation spawn on a parent, then activate its grant in a child process. */
async function spawnGrantedChild(root: string): Promise<PiChild> {
  const parent = piProcess();
  const parentSession = sessionId();
  const spawnCallId = `call-spawn-${randomUUID()}`;
  const input = { agentScope: "user", tasks: [{ agent: IMPLEMENTER, task: TASK_PROMPT }] };
  const admitted = await parent.emit("tool_call", {
    type: "tool_call",
    toolName: "subagent",
    toolCallId: spawnCallId,
    input,
  }, piContext(root, parentSession));
  expect(admitted, `fixture: the parent must admit the implementation spawn\n${stderrText()}`).toEqual([undefined]);
  const prompt = input.tasks[0]!.task;
  expect(prompt, "fixture: the spawn must inject a write grant").toMatch(/LOOM_PI_WRITE_GRANT:[0-9a-f]{64}/);

  const child = piProcess();
  const childSession = sessionId();
  await child.emit("before_agent_start", {
    prompt: `Task: ${prompt}`,
    systemPrompt: `<!-- LOOM_PI_AGENT_ID:${IMPLEMENTER} -->`,
  }, piContext(root, childSession));
  const rosterPath = join(subagentDir, `${childSession}.active`);
  expect(existsSync(rosterPath), `fixture: the child must activate its grant\n${stderrText()}`).toBe(true);
  const grantAgentId = readFileSync(rosterPath, "utf-8").trim();
  expect(grantAgentId).toMatch(/^pi-grant-[0-9a-f]{16}$/);
  return { root, parent, parentSession, spawnCallId, child, childSession, prompt, grantAgentId };
}

/** The child's epoch in the PARENT session's ledger: `epochOf(grant agent id, agent type)`. */
function piParentEpochFacts(granted: PiChild): readonly Evidence[] {
  return eventsForEpoch(fsSessionRegistry.readEvidence(granted.parentSession), epochOf(agentIdOf(granted.grantAgentId), IMPLEMENTER_TYPE));
}

function piEvents(step: ToolStep, callId: string): Readonly<{ call: Record<string, unknown>; result: Record<string, unknown> }> {
  const text = (value: string) => [{ type: "text", text: value }];
  switch (step.kind) {
    case "read": {
      const input = { path: step.path };
      return {
        call: { type: "tool_call", toolName: "read", toolCallId: callId, input },
        result: { type: "tool_result", toolName: "read", toolCallId: callId, input, content: text(""), isError: false, details: undefined },
      };
    }
    case "write": {
      const input = { path: step.path, content: step.content };
      return {
        call: { type: "tool_call", toolName: "write", toolCallId: callId, input },
        result: {
          type: "tool_result", toolName: "write", toolCallId: callId, input,
          content: text(`Successfully wrote ${step.content.length} bytes to ${step.path}`), isError: false, details: undefined,
        },
      };
    }
    case "edit": {
      const input = { path: step.path, edits: [{ oldText: step.oldText, newText: step.newText }] };
      return {
        call: { type: "tool_call", toolName: "edit", toolCallId: callId, input },
        result: {
          type: "tool_result", toolName: "edit", toolCallId: callId, input,
          content: text(`Successfully replaced 1 block in ${step.path}.`), isError: false, details: { diff: "", patch: "" },
        },
      };
    }
    case "bash": {
      const input = { command: step.command };
      return {
        call: { type: "tool_call", toolName: "bash", toolCallId: callId, input },
        result: {
          type: "tool_result", toolName: "bash", toolCallId: callId, input,
          content: text(step.stdout),
          isError: step.exit !== 0,
          details: step.piDetailsExitCode === undefined ? undefined : { exitCode: step.piDetailsExitCode },
        },
      };
    }
  }
}

/** Deliver steps to a Pi child process as Pi does: `tool_call`, the tool runs, then `tool_result`. */
async function deliverToPi(
  child: FakePi,
  root: string,
  session: string,
  steps: readonly ToolStep[],
): Promise<void> {
  for (const step of steps) {
    const callId = `call_${randomUUID()}`;
    const { call, result } = piEvents(step, callId);
    const verdicts = await child.emit("tool_call", call, piContext(root, session));
    expect(verdicts.filter((verdict) => verdict !== undefined), "fixture: the child's guards must admit the call").toEqual([]);
    applyEffect(root, step);
    await child.emit("tool_result", result, piContext(root, session));
  }
}

/** The child transcript the parent's subagent result carries for these steps. */
function piTranscript(steps: readonly ToolStep[]): readonly Record<string, unknown>[] {
  return [
    ...steps.flatMap((step, index) => {
      const callId = `transcript_${index}`;
      const { call, result } = piEvents(step, callId);
      return [
        { role: "assistant", content: [{ type: "toolCall", id: callId, name: call.toolName, arguments: call.input }] },
        {
          role: "toolResult",
          toolCallId: callId,
          toolName: result.toolName,
          isError: result.isError,
          content: result.content,
        },
      ];
    }),
    { role: "assistant", content: [{ type: "text", text: "Implemented T1 test-first; tests pass." }] },
  ];
}

/** The parent settles the finished batch (`tool_result` on `subagent`). */
async function settleBatch(granted: PiChild, steps: readonly ToolStep[]): Promise<void> {
  await granted.parent.emit("tool_result", {
    type: "tool_result",
    toolName: "subagent",
    toolCallId: granted.spawnCallId,
    input: { agentScope: "user", tasks: [{ agent: IMPLEMENTER, task: granted.prompt }] },
    content: [],
    isError: false,
    details: {
      results: [{
        agent: IMPLEMENTER,
        task: "Task ID: T1",
        exitCode: 0,
        messages: piTranscript(steps),
      }],
    },
  }, piContext(granted.root, granted.parentSession));
}

function settledTask(repository: Repository): Record<string, unknown> {
  const state = JSON.parse(readFileSync(repository.statePath, "utf-8")) as { tasks: Record<string, unknown>[] };
  const task = state.tasks.find((candidate) => candidate.id === "T1");
  if (task === undefined) throw new Error("fixture TaskGraph lost T1");
  return task;
}

/** The persisted I6 proof result of the settled Task, or undefined when proof owes none. */
function redThenGreenResult(repository: Repository): unknown {
  const proof = settledTask(repository).proof as { results?: readonly { obligation?: { kind?: string } }[] } | undefined;
  return proof?.results?.find((result) => result.obligation?.kind === "red-then-green");
}

/** Every ledger in the shared subagent directory, by file name. */
function allLedgers(): ReadonlyMap<string, string> {
  return new Map(readdirSync(subagentDir)
    .filter((name) => name.endsWith(".evidence.jsonl"))
    .map((name) => [name, readFileSync(join(subagentDir, name), "utf-8")] as const));
}

// ─── Scripts ─────────────────────────────────────────────────────────────

const TEST_SOURCE = "import { expect, it } from 'vitest';\nimport { feature } from '../src/feature';\nit('works', () => expect(feature()).toBe(1));\n";

const writeTestFile = (root: string): ToolStep =>
  ({ kind: "write", path: resolve(root, TEST_FILE), content: TEST_SOURCE });

const implementFeature = (root: string): ToolStep => ({
  kind: "edit",
  path: resolve(root, IMPLEMENTATION_FILE),
  oldText: "=> 0;",
  newText: "=> 1;",
});

/** A trusted, report-producing Vitest run whose report the runner writes during the call. */
function vitestRun(root: string, outcome: "red" | "green"): BashStep {
  const reportPath = join(scratch, `vitest-${randomUUID()}.json`);
  return {
    kind: "bash",
    command: vitestCommand(reportPath),
    exit: outcome === "red" ? 1 : 0,
    stdout: outcome === "red" ? " Test Files  1 failed (1)\n      Tests  1 failed (1)\n" : " Test Files  1 passed (1)\n      Tests  1 passed (1)\n",
    effect: () => writeFileSync(reportPath, vitestReport(root, outcome)),
  };
}

type RedThenGreenScript = Readonly<{
  steps: readonly ToolStep[];
  red: BashStep;
  green: BashStep;
}>;

/** Red on the Task's test file, then the first implementation write, then green. */
function redThenGreenScript(root: string): RedThenGreenScript {
  const red = vitestRun(root, "red");
  const green = vitestRun(root, "green");
  return { steps: [writeTestFile(root), red, implementFeature(root), green], red, green };
}

// ─── Acceptance ──────────────────────────────────────────────────────────

describe("CT-3: Pi ledger capture through the shared minting rule", () => {
  it("AS-036: the same read, edit, write and bash calls mint identical facts in identical order through Claude Code and a Pi implementation child", async () => {
    await withPopulatedRepository("loom-pi-ledger-as036-", defaultVerificationManifest(), {}, async (repository) => {
      const { root } = repository;
      const reportPath = join(scratch, `as036-${randomUUID()}.json`);
      const steps: readonly ToolStep[] = [
        { kind: "read", path: resolve(root, "README.md") },
        { kind: "write", path: resolve(root, "notes.md"), content: "notes\n" },
        { kind: "edit", path: resolve(root, IMPLEMENTATION_FILE), oldText: "=> 0;", newText: "=> 1;" },
        { kind: "bash", command: "printf 'log\\n' > build.log", exit: 0, stdout: "" },
        { kind: "bash", command: "mv build.log build.moved.log", exit: 0, stdout: "" },
        {
          kind: "bash",
          command: vitestCommand(reportPath),
          exit: 1,
          stdout: " Tests  1 failed (1)\n",
          effect: () => writeFileSync(reportPath, vitestReport(root, "red")),
        },
      ];

      const claude = await bindClaudeAgent(root);
      await deliverToClaude(claude, steps);
      const granted = await spawnGrantedChild(root);
      await deliverToPi(granted.child, root, granted.childSession, steps);

      const claudeFacts = claudeEpochFacts(claude);
      expect(claudeFacts).toEqual([
        { kind: "FileRead", path: resolve(root, "README.md") },
        { kind: "FileWrite", path: resolve(root, "notes.md"), via: "tool" },
        { kind: "FileWrite", path: resolve(root, IMPLEMENTATION_FILE), via: "tool" },
        { kind: "FileWrite", path: resolve(root, "build.log"), via: "shell" },
        { kind: "FileWrite", path: resolve(root, "build.moved.log"), via: "shell" },
        {
          kind: "TestRun",
          command: vitestCommand(reportPath),
          exit: 1,
          report: expect.objectContaining({ total: 1, failed: 1, source: "vitest-json" }),
        },
      ]);
      expect(piParentEpochFacts(granted)).toEqual(claudeFacts);
    });
  }, 120_000);

  it("FR-031: a granted Pi child records FileRead, FileWrite with via, and a TestRun with per-file results for its own tool calls", async () => {
    await withPopulatedRepository("loom-pi-ledger-fr031-", defaultVerificationManifest(), {}, async (repository) => {
      const { root } = repository;
      const granted = await spawnGrantedChild(root);
      const red = vitestRun(root, "red");
      await deliverToPi(granted.child, root, granted.childSession, [
        { kind: "read", path: resolve(root, "README.md") },
        writeTestFile(root),
        { kind: "bash", command: "printf 'x' > scratch.txt", exit: 0, stdout: "" },
        red,
      ]);

      expect(piParentEpochFacts(granted)).toEqual([
        { kind: "FileRead", path: resolve(root, "README.md") },
        { kind: "FileWrite", path: resolve(root, TEST_FILE), via: "tool" },
        { kind: "FileWrite", path: resolve(root, "scratch.txt"), via: "shell" },
        {
          kind: "TestRun",
          command: red.command,
          exit: 1,
          report: expect.objectContaining({
            total: 1,
            failed: 1,
            files: {
              kind: "recorded",
              results: [{ file: join(root, TEST_FILE), executed: 1, failed: 1, skipped: 0, collectionError: false }],
            },
          }),
        },
      ]);
    });
  }, 120_000);

  it("FR-032: a Pi child records into the parent session's ledger under the epoch of its parent-issued grant identity and agent type, never into its own session", async () => {
    await withPopulatedRepository("loom-pi-ledger-fr032-", defaultVerificationManifest(), {}, async (repository) => {
      const { root } = repository;
      const granted = await spawnGrantedChild(root);
      await deliverToPi(granted.child, root, granted.childSession, [
        { kind: "read", path: resolve(root, "README.md") },
        implementFeature(root),
      ]);

      const agentId = agentIdOf(granted.grantAgentId);
      const parentRecords = fsSessionRegistry.readEvidence(granted.parentSession);
      expect(parentRecords.map(({ epoch }) => epoch)).toEqual([
        epochOf(agentId, IMPLEMENTER_TYPE),
        epochOf(agentId, IMPLEMENTER_TYPE),
      ]);
      expect(piParentEpochFacts(granted)).toEqual([
        { kind: "FileRead", path: resolve(root, "README.md") },
        { kind: "FileWrite", path: resolve(root, IMPLEMENTATION_FILE), via: "tool" },
      ]);
      expect(fsSessionRegistry.readEvidence(granted.childSession)).toEqual([]);
    });
  }, 120_000);

  it("FR-033: a Pi TestRun's exit comes only from that call's tool result, and report discovery, freshness and the agent-authored-artifact veto apply as on Claude Code", async () => {
    await withPopulatedRepository("loom-pi-ledger-fr033-", defaultVerificationManifest(), {}, async (repository) => {
      const { root } = repository;
      const granted = await spawnGrantedChild(root);
      const bunRun = "bun test tests/feature.test.ts";

      // Exit: details.exitCode when numeric, otherwise isError read as 1 or 0.
      await deliverToPi(granted.child, root, granted.childSession, [
        { kind: "bash", command: bunRun, exit: 1, stdout: "0 pass\n1 fail\n" },
        { kind: "bash", command: bunRun, exit: 0, stdout: "1 pass\n0 fail\n" },
        { kind: "bash", command: bunRun, exit: 3, stdout: "", piDetailsExitCode: 3 },
      ]);
      expect(piParentEpochFacts(granted)).toEqual([
        { kind: "TestRun", command: bunRun, exit: 1, report: null },
        { kind: "TestRun", command: bunRun, exit: 0, report: null },
        { kind: "TestRun", command: bunRun, exit: 3, report: null },
      ]);

      // Fresh report written by the runner during the call: it vouches.
      const freshPath = join(scratch, `fr033-fresh-${randomUUID()}.json`);
      // Stale report: its mtime predates the call, so it cannot vouch.
      const stalePath = join(scratch, `fr033-stale-${randomUUID()}.json`);
      writeFileSync(stalePath, vitestReport(root, "green"));
      const longAgo = new Date(Date.now() - 60 * 60_000);
      utimesSync(stalePath, longAgo, longAgo);
      // Agent-authored report: the agent's own write tool staged it this epoch.
      const stagedPath = join(scratch, `fr033-staged-${randomUUID()}.json`);
      const discovery: readonly ToolStep[] = [
        {
          kind: "bash",
          command: vitestCommand(freshPath),
          exit: 0,
          stdout: "",
          effect: () => writeFileSync(freshPath, vitestReport(root, "green")),
        },
        { kind: "bash", command: vitestCommand(stalePath), exit: 0, stdout: "" },
        { kind: "write", path: stagedPath, content: vitestReport(root, "green") },
        { kind: "bash", command: vitestCommand(stagedPath), exit: 0, stdout: "" },
      ];
      const claude = await bindClaudeAgent(root);
      await deliverToClaude(claude, discovery);
      await deliverToPi(granted.child, root, granted.childSession, discovery);

      const expectedDiscovery = [
        {
          kind: "TestRun",
          command: vitestCommand(freshPath),
          exit: 0,
          report: expect.objectContaining({ total: 1, failed: 0, source: "vitest-json" }),
        },
        { kind: "TestRun", command: vitestCommand(stalePath), exit: 0, report: null },
        { kind: "FileWrite", path: stagedPath, via: "tool" },
        { kind: "TestRun", command: vitestCommand(stagedPath), exit: 0, report: null },
      ];
      expect(claudeEpochFacts(claude)).toEqual(expectedDiscovery);
      expect(piParentEpochFacts(granted).slice(3)).toEqual(expectedDiscovery);
    });
  }, 120_000);

  it("FR-034: a literal mv, git mv or cp mints a shell FileWrite for its destination on Claude Code and on Pi", async () => {
    await withPopulatedRepository("loom-pi-ledger-fr034-", defaultVerificationManifest(), {}, async (repository) => {
      const { root } = repository;
      const steps: readonly ToolStep[] = [
        { kind: "bash", command: "mv assets/a.txt assets/b.txt", exit: 0, stdout: "" },
        { kind: "bash", command: "git mv src/legacy.ts src/renamed.ts", exit: 0, stdout: "" },
        { kind: "bash", command: "cp README.md docs.md", exit: 0, stdout: "" },
      ];
      const expected = [
        { kind: "FileWrite", path: resolve(root, "assets/b.txt"), via: "shell" },
        { kind: "FileWrite", path: resolve(root, "src/renamed.ts"), via: "shell" },
        { kind: "FileWrite", path: resolve(root, "docs.md"), via: "shell" },
      ];

      const claude = await bindClaudeAgent(root);
      await deliverToClaude(claude, steps);
      const granted = await spawnGrantedChild(root);
      await deliverToPi(granted.child, root, granted.childSession, steps);

      for (const facts of [claudeEpochFacts(claude), piParentEpochFacts(granted)]) {
        for (const destination of expected) expect(facts).toContainEqual(destination);
      }
    });
  }, 120_000);

  it("AS-041: a renamed file is recorded under its new path through either harness, for mv, git mv and cp", async () => {
    await withPopulatedRepository("loom-pi-ledger-as041-", defaultVerificationManifest(), {}, async (repository) => {
      const { root } = repository;
      const cases = [
        { command: "mv assets/a.txt assets/moved.txt", destination: "assets/moved.txt" },
        { command: "git mv src/legacy.ts src/legacy-renamed.ts", destination: "src/legacy-renamed.ts" },
        { command: "cp README.md README.copy.md", destination: "README.copy.md" },
      ] as const;

      for (const { command, destination } of cases) {
        const step: ToolStep = { kind: "bash", command, exit: 0, stdout: "" };
        const claude = await bindClaudeAgent(root);
        await deliverToClaude(claude, [step]);
        expect(claudeEpochFacts(claude), `Claude Code: ${command}`).toEqual([
          { kind: "FileWrite", path: resolve(root, destination), via: "shell" },
        ]);
      }

      const granted = await spawnGrantedChild(root);
      for (const { command } of cases) {
        await deliverToPi(granted.child, root, granted.childSession, [{ kind: "bash", command, exit: 0, stdout: "" }]);
      }
      expect(piParentEpochFacts(granted)).toEqual(cases.map(({ destination }) => (
        { kind: "FileWrite", path: resolve(root, destination), via: "shell" }
      )));
    });
  }, 120_000);

  it("AS-039: a Pi child with no write grant, or with a rejected grant, records nothing into any epoch and its stderr says why", async () => {
    await withPopulatedRepository("loom-pi-ledger-as039-", defaultVerificationManifest(), {}, async (repository) => {
      const { root } = repository;
      // A consumed grant: replaying its marker in another child is rejected.
      const granted = await spawnGrantedChild(root);
      const before = allLedgers();
      const calls = (): readonly ToolStep[] => [
        { kind: "read", path: resolve(root, "README.md") },
        { kind: "bash", command: "printf 'x' > rejected.txt", exit: 0, stdout: "" },
        vitestRun(root, "green"),
      ];

      const ungranted = piProcess();
      const ungrantedSession = sessionId();
      await ungranted.emit("before_agent_start", {
        prompt: `Task: ${TASK_PROMPT}`,
        systemPrompt: `<!-- LOOM_PI_AGENT_ID:${IMPLEMENTER} -->`,
      }, piContext(root, ungrantedSession));
      stderr = [];
      await deliverToPi(ungranted, root, ungrantedSession, calls());
      expect(allLedgers()).toEqual(before);
      expect(stderrText()).toContain(NO_GRANT);

      const rejected = piProcess();
      const rejectedSession = sessionId();
      await rejected.emit("before_agent_start", {
        prompt: `Task: ${granted.prompt}`,
        systemPrompt: `<!-- LOOM_PI_AGENT_ID:${IMPLEMENTER} -->`,
      }, piContext(root, rejectedSession));
      expect(stderrText(), "fixture: replaying a consumed grant must be rejected").toContain("child write grant rejected");
      stderr = [];
      await deliverToPi(rejected, root, rejectedSession, calls());
      expect(allLedgers()).toEqual(before);
      expect(stderrText()).toContain(GRANT_REJECTED);
    });
  }, 120_000);

  it("AS-037: a Pi non-claimant Task with newTests required whose child ledger shows red, then the first implementation write, then green satisfies I6 at settlement", async () => {
    await withPopulatedRepository("loom-pi-ledger-as037-", defaultVerificationManifest(), {}, async (repository) => {
      const { root } = repository;
      const granted = await spawnGrantedChild(root);
      const { steps, red, green } = redThenGreenScript(root);
      await deliverToPi(granted.child, root, granted.childSession, steps);
      await settleBatch(granted, steps);

      expect(redThenGreenResult(repository), stderrText()).toMatchObject({
        state: "satisfied",
        obligation: { kind: "red-then-green" },
        evidence: {
          kind: "red-then-green",
          red: expect.objectContaining({ command: red.command }),
          implementationWrite: expect.stringMatching(/(^|\/)src\/feature\.ts$/),
          green: expect.objectContaining({ command: green.command }),
        },
      });
    });
  }, 120_000);

  it("AS-038: a Pi Task whose only test evidence is Pi-structured transcript evidence, with no trusted ledger TestRun, fails I6 naming the untrusted-only step", async () => {
    await withPopulatedRepository("loom-pi-ledger-as038-", defaultVerificationManifest(), {}, async (repository) => {
      const { root } = repository;
      const granted = await spawnGrantedChild(root);
      // Bun runs with no structured report: the ledger TestRuns stay
      // untrusted, and the transcript yields only Pi-structured evidence.
      const steps: readonly ToolStep[] = [
        writeTestFile(root),
        { kind: "bash", command: `bun test ${TEST_FILE}`, exit: 1, stdout: "tests/feature.test.ts:\n(fail) works\n\n 0 pass\n 1 fail\nRan 1 test across 1 file.\n" },
        implementFeature(root),
        { kind: "bash", command: `bun test ${TEST_FILE}`, exit: 0, stdout: "tests/feature.test.ts:\n(pass) works\n\n 1 pass\n 0 fail\nRan 1 test across 1 file.\n" },
      ];
      await deliverToPi(granted.child, root, granted.childSession, steps);
      await settleBatch(granted, steps);

      expect(settledTask(repository).test_result, "fixture: the transcript yields Pi-structured evidence").toMatchObject({
        verdict: "untrusted",
        provenance: "pi-structured",
      });
      expect(redThenGreenResult(repository), stderrText()).toMatchObject({
        state: "failed",
        obligation: { kind: "red-then-green" },
        failure: { kind: "red-then-green-unproven", gap: { kind: "red-missing", untrustedOnly: true } },
      });
      expect(settledTask(repository).status).not.toBe("implemented");
    });
  }, 120_000);

  it("AS-040: a Pi implementation Task with a frozen affected runner runs the report-only affected check over the changed files from its child's epoch", async () => {
    const argvRecord = join(scratch, `affected-argv-${randomUUID()}.json`);
    const frozen = freezeVerificationManifest(affectedRunnerManifestSource());
    expect(frozen.ok, frozen.ok ? "" : frozen.error.errors.join("; ")).toBe(true);
    if (!frozen.ok) return;
    await withPopulatedRepository("loom-pi-ledger-as040-", frozen.value, { [AFFECTED_RUNNER_SCRIPT]: affectedRunnerScript(argvRecord) }, async (repository) => {
      const { root } = repository;
      const granted = await spawnGrantedChild(root);
      const steps: readonly ToolStep[] = [writeTestFile(root), implementFeature(root)];
      await deliverToPi(granted.child, root, granted.childSession, steps);
      await settleBatch(granted, steps);

      expect(existsSync(argvRecord), `the affected runner never ran\n${stderrText()}`).toBe(true);
      const files = JSON.parse(readFileSync(argvRecord, "utf-8")) as string[];
      expect([...files].sort()).toEqual([IMPLEMENTATION_FILE, TEST_FILE].sort());
      expect(stderrText()).toMatch(/affected/i);
    });
  }, 120_000);

  it("FR-035: Pi settlement (I6) and the Pi report-only stop check (I7) both read the child's epoch from the parent ledger", async () => {
    const argvRecord = join(scratch, `affected-argv-${randomUUID()}.json`);
    const frozen = freezeVerificationManifest(affectedRunnerManifestSource());
    expect(frozen.ok, frozen.ok ? "" : frozen.error.errors.join("; ")).toBe(true);
    if (!frozen.ok) return;
    await withPopulatedRepository("loom-pi-ledger-fr035-", frozen.value, { [AFFECTED_RUNNER_SCRIPT]: affectedRunnerScript(argvRecord) }, async (repository) => {
      const { root } = repository;
      const granted = await spawnGrantedChild(root);
      const { steps } = redThenGreenScript(root);
      await deliverToPi(granted.child, root, granted.childSession, steps);
      expect(piParentEpochFacts(granted).filter(({ kind }) => kind === "TestRun")).toHaveLength(2);
      await settleBatch(granted, steps);

      expect(redThenGreenResult(repository), stderrText()).toMatchObject({
        state: "satisfied",
        obligation: { kind: "red-then-green" },
      });
      expect(existsSync(argvRecord), `the affected runner never ran\n${stderrText()}`).toBe(true);
      const files = JSON.parse(readFileSync(argvRecord, "utf-8")) as string[];
      expect([...files].sort()).toEqual([IMPLEMENTATION_FILE, TEST_FILE].sort());
    });
  }, 120_000);
});
