/**
 * CT-2 acceptance: I7, the affected-test stop check, through the real
 * SubagentStop entry point.
 *
 * Every testcase drives `runDispatch(stdin, args, cleanup, ports)` for an
 * implementation agent's stop. The agent has a published implementation
 * sidecar, a session TaskGraph pointer and a roster entry, and its epoch's
 * FileWrite facts are on the session evidence ledger. That is the state a live
 * attempt leaves on disk. The injected `StopChecksPorts` are in-memory fakes:
 * - a runner that reports per check (told apart by report path), and that can
 *   time out, be killed, leave no report, fail to start or not complete;
 * - an advanceable clock for the 300 s hook budget;
 * - a recording runner lock;
 * - one block counter per check.
 *
 * Each testcase builds the manifest it needs, so a manifest key the parser
 * refuses fails the testcase itself, not the file.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCEPTANCE_BLOCK_HEADING,
  AFFECTED_BLOCK_HEADING,
  AFFECTED_NOTE_TEXT,
  AFFECTED_STOP_CHECK_MAX_BLOCKS,
  MAX_AFFECTED_RUNNER_TIMEOUT_MS,
  SETTLEMENT_RESERVE_MS,
  STOP_HOOK_BUDGET_MS,
  type AffectedStopCheckNoteKind,
  type StopCheckBlockCount,
  type StopCheckName,
  type StopChecksPorts,
} from "../../src/core/affected-stop-check-types";
import type { ImplementationAttemptAuthority } from "../../src/core/implementation-completion";
import { freezeVerificationManifest, type FrozenVerificationManifest } from "../../src/core/verification-manifest";
import { runDispatch } from "../../src/handlers/subagent-stop/dispatch";
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
import type { HookHandler, HookResult } from "../../src/types";
import { parseCanonicalRepositoryRoot, type CanonicalRepositoryRoot } from "../../src/utils/workspace-digest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { inMemoryBlockCounters } from "../fixtures/stop-check-block-counters";
import {
  ACCEPTANCE_REPORT,
  ACCEPTANCE_RUNNER,
  AFFECTED_REPORT,
  AFFECTED_RUNNER,
  affectedArgv,
  argvOf,
  checkNameOf,
  observedRun,
  parsedRun,
} from "../fixtures/stop-check-runners";
import { contract, frozenPaths, stateFileJson, surface, task, writeStateFile } from "../fixtures/contract-status-fixtures";

type Ports = StopChecksPorts<CanonicalRepositoryRoot, CompletionCheckRunnerResult>;

const SESSION = "affected-stop-check-session";
const AGENT_TYPE = "code-implementer-agent";
const SURFACE = surface("payload");
const OWED = "AS-001: one valid call wins";

/** A schema-2 manifest frozen by the production freezer; throws when it is refused. */
function manifest(runners: Readonly<{ acceptance?: boolean; affected?: boolean }>): FrozenVerificationManifest {
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2,
    kind: "loom-verification-manifest",
    checks: [],
    ...(runners.acceptance === true ? { acceptanceRunner: ACCEPTANCE_RUNNER } : {}),
    ...(runners.affected === true ? { affectedRunner: AFFECTED_RUNNER } : {}),
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

/** One FileWrite fact on the attempt's epoch. `onDisk` says whether the file exists at stop time. */
type Write = Readonly<{ path: string; via?: "tool" | "shell"; onDisk: boolean }>;

type Attempt = Readonly<{ agentId: string; taskId: "T2" | "T3"; writes: readonly Write[] }>;

type Project = Readonly<{ root: string; canonicalRoot: CanonicalRepositoryRoot; statePath: string }>;

/**
 * Three Tasks:
 * - T1 is CT-1's contract Task.
 * - T2 is a Wave-2 claimant owing CT-1's `AS-001` testcase.
 * - T3 is a Wave-2 Task that claims nothing.
 * Every file a testcase writes is in its Task's `file_list`, so settlement
 * after a proceeding stop never refuses the stop for scope.
 */
const TASKS = [
  task("T1", 1, [SURFACE.types, SURFACE.acceptance]),
  task("T2", 2, ["src/payload.ts", "src/payload.test.ts"], ["AS-001"]),
  task("T3", 2, ["src/ledger.ts", "src/ledger.test.ts", "src/old-name.ts", "src/new-name.ts", "src/gone.ts", "docs/ledger.md"]),
];

const CONTRACT = contract({
  id: "CT-1",
  surface: SURFACE,
  anchors: ["AS-001"],
  freeze: { state: "frozen", wave: 1, paths: frozenPaths(SURFACE, "a"), roster: [{ file: SURFACE.acceptance, name: OWED, anchors: ["AS-001"] }] },
});

function brandedSession() {
  const sessionId = parseSessionId(SESSION);
  if (sessionId === null) throw new Error("fixture session id");
  return sessionId;
}

/**
 * A fresh committed Git project holding the State File, with every attempt
 * reserved through the production spawn registration, in one batch.
 */
async function project(frozen: FrozenVerificationManifest, attempts: readonly Attempt[]): Promise<Project> {
  const root = canonicalTempDir("loom-affected-stop-check-");
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
  const raw = JSON.parse(stateFileJson(TASKS, [CONTRACT])) as Record<string, unknown>;
  const statePath = writeStateFile(root, JSON.stringify({ ...raw, current_wave: 2, verification_manifest: frozen }));
  process.env.LOOM_STATE_PATH = statePath;
  mkdirSync(process.env.LOOM_SUBAGENT_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(process.env.LOOM_SUBAGENT_DIR, `${SESSION}.task_graph`), statePath);
  const registered = await registerTaskExecutionBatch(attempts.map(({ taskId }) => ({ kind: "implementation", prompt: `Task ID: ${taskId}`, description: taskId })));
  if (registered.kind !== "registered") throw new Error(`fixture registration refused: ${JSON.stringify(registered)}`);
  for (const attempt of attempts) {
    const authority = registered.authorities.find(({ taskId }) => taskId === attempt.taskId);
    if (authority === undefined) throw new Error(`fixture registration reserved no attempt for ${attempt.taskId}`);
    await liveAttempt(root, statePath, attempt, authority);
  }
  const canonicalRoot = parseCanonicalRepositoryRoot(root);
  if (!canonicalRoot.ok) throw new Error("fixture root");
  return { root, canonicalRoot: canonicalRoot.value, statePath };
}

const transcriptPath = (agentId: string): string => join(process.env.LOOM_SUBAGENT_DIR ?? "", `${agentId}.transcript.jsonl`);

/** What SubagentStart, the write gate, the PostToolUse recorder and the agent's own transcript leave for one attempt. */
async function liveAttempt(root: string, statePath: string, { agentId, taskId, writes }: Attempt, authority: ImplementationAttemptAuthority): Promise<void> {
  publishImplementationAttemptSidecar({ sessionId: SESSION, agentId, taskGraphPath: statePath, authority });
  const sessionId = brandedSession();
  const id = parseAgentId(agentId);
  const type = parseAgentType(AGENT_TYPE);
  if (id === null || type === null) throw new Error("fixture agent");
  await markAgentActive(sessionId, id, type);
  const events: Evidence[] = writes.map(({ path, via = "tool" }) => ({
    kind: "FileWrite",
    path: path.startsWith("/") ? path : join(root, path),
    via,
  }));
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

const stopStdin = (agentId: string): string => JSON.stringify({
  session_id: SESSION,
  agent_id: agentId,
  agent_type: AGENT_TYPE,
  agent_transcript_path: transcriptPath(agentId),
  hook_event_name: "SubagentStop",
});

// --- Fake runner, clock, lock and counters ---

type Testcase = Readonly<{ file: string; name: string; outcome: "passed" | "failed" }>;

const junit = (cases: readonly Testcase[]): Uint8Array => new TextEncoder().encode(
  `<?xml version="1.0"?><testsuites tests="${cases.length}"><testsuite name="suite" tests="${cases.length}">` +
  cases.map(({ file, name, outcome }) =>
    `<testcase classname="${file}" name="${name}">` +
    (outcome === "failed" ? `<failure type="AssertionError" message="expected 1 to be 2"/>` : "") +
    "</testcase>").join("") +
  "</testsuite></testsuites>");

/** What one check's runner does when launched. */
type Run =
  | Readonly<{ kind: "report"; cases: readonly Testcase[]; tookMs?: number }>
  | Readonly<{ kind: "timed-out" }>
  | Readonly<{ kind: "killed" }>
  | Readonly<{ kind: "no-report" }>
  | Readonly<{ kind: "start-failed" }>
  | Readonly<{ kind: "did-not-complete" }>;

type Launch = Readonly<{ check: StopCheckName; argv: readonly string[]; cwd: string; timeoutMs: number; lockHeld: boolean }>;

type FakeOptions = Readonly<{
  acceptance?: Run | readonly Run[];
  affected?: Run | readonly Run[];
  blocks?: Readonly<{ acceptance?: number; affected?: number }>;
  /** Per-launch latency on the real event loop, so concurrent stops interleave. */
  latencyMs?: number;
  /** One lock state shared across several fakes, as one repository's lock file is. */
  lock?: { holder: string | null };
  /** Runs in flight across every fake sharing it, as one repository's report files are shared. */
  flight?: { count: number };
}>;

const runAt = (runs: Run | readonly Run[] | undefined, index: number): Run | undefined =>
  runs === undefined ? undefined : Array.isArray(runs) ? (runs[Math.min(index, runs.length - 1)] as Run) : (runs as Run);

/** In-memory ports for one project. The clock starts at the real time, and only launches advance it. */
function fakePorts(at: Project, options: FakeOptions = {}) {
  const startedAtMs = Date.now();
  const clock = { ms: startedAtMs };
  const launches: Launch[] = [];
  const reads: { path: string; inFlight: number }[] = [];
  const reports = new Map<string, Uint8Array>();
  const lock = options.lock ?? { holder: null };
  const locks = { acquired: 0, released: 0, held: 0 };
  const flight = options.flight ?? { count: 0 };
  const presetCount = (blocks: number | undefined): StopCheckBlockCount | undefined =>
    blocks === undefined ? undefined : { kind: "count", blocks };
  const blocks = inMemoryBlockCounters({
    presets: { acceptance: presetCount(options.blocks?.acceptance), affected: presetCount(options.blocks?.affected) },
  });
  const runsSoFar = { acceptance: 0, affected: 0 };

  const runCheck: Ports["runCheck"] = async (command) => {
    const check = checkNameOf(command);
    launches.push({ check, argv: argvOf(command), cwd: command.cwd, timeoutMs: command.timeoutMs, lockHeld: locks.held > 0 });
    const run = runAt(options[check], runsSoFar[check]++) ?? { kind: "report", cases: [] };
    flight.count++;
    try {
      await new Promise((resolve) => setTimeout(resolve, options.latencyMs ?? 0));
      clock.ms += run.kind === "report" ? (run.tookMs ?? 1_000) : run.kind === "timed-out" ? command.timeoutMs : 1_000;
      const reportPath = check === "acceptance" ? ACCEPTANCE_REPORT : AFFECTED_REPORT;
      const observed = (timedOut: boolean, signal: string | null, bytes: Uint8Array | null) => {
        if (bytes !== null) reports.set(join(at.root, reportPath), bytes);
        else reports.delete(join(at.root, reportPath));
        return observedRun(command, bytes, {
          ending: { exitCode: timedOut || signal !== null ? null : 1, timedOut, signal },
          stdoutTail: `${check} runner stdout`,
        });
      };
      switch (run.kind) {
        case "report":
          return observed(false, null, junit(run.cases));
        case "timed-out":
          // A killed runner's partial report: never judged.
          return observed(true, "SIGKILL", junit([{ file: "src/partial.test.ts", name: "partial", outcome: "failed" }]));
        case "killed":
          return observed(false, "SIGTERM", junit([{ file: "src/partial.test.ts", name: "partial", outcome: "failed" }]));
        case "no-report":
          return observed(false, null, null);
        case "start-failed":
          return parsedRun({ checkId: command.checkId, scope: "wave", outcome: { kind: "spawn-failed", message: `spawn ${command.executable} ENOENT` } });
        case "did-not-complete":
          return { ok: false, error: { kind: "containment-unsupported", message: "no process groups on this host" } };
      }
    } finally {
      flight.count--;
    }
  };

  const ports: Ports = {
    repositoryRoot: () => ({ ok: true, root: at.canonicalRoot }),
    acquireRunner: () => {
      const me = `lock-${Math.random()}`;
      if (lock.holder !== null) return { kind: "held", reason: `another stop (${lock.holder}) is running the stop-check runners` };
      lock.holder = me;
      locks.acquired++;
      locks.held++;
      return {
        kind: "acquired",
        release: () => {
          if (lock.holder === me) lock.holder = null;
          locks.released++;
          locks.held--;
          return null;
        },
      };
    },
    runCheck,
    readReport: (path) => {
      reads.push({ path, inFlight: flight.count });
      const bytes = reports.get(path);
      if (bytes === undefined) throw new Error(`ENOENT: ${path}`);
      return bytes;
    },
    blocks: blocks.counters,
    pathExists: (root, path) => existsSync(join(root, path)),
    now: () => clock.ms,
  };
  return { ports, launches, reads, locks, counters: blocks.counts, clock, startedAtMs };
}

/** Cleanup that records each call: a blocked stop must release nothing. */
function recordingCleanup() {
  const calls: string[] = [];
  const cleanup: HookHandler = async (stdin) => { calls.push(stdin); return { kind: "passthrough" }; };
  return { cleanup, calls };
}

/** The operator-facing text a stop that proceeded carries. */
const operatorText = (result: HookResult): string =>
  result.kind === "passthrough" ? result.systemMessage ?? "" : result.kind === "error" || result.kind === "block" ? result.message : "";

const affectedLaunches = (launches: readonly Launch[]) => launches.filter(({ check }) => check === "affected");
const failing = (file: string, name: string): Testcase => ({ file, name, outcome: "failed" });
const passing = (file: string, name: string): Testcase => ({ file, name, outcome: "passed" });

const LEDGER_TEST = "ledger > balances after a debit";
const PAYLOAD_TEST = "payload > parses the envelope";

// --- Blocking on failing affected tests ---

describe("I7 blocks on failing affected tests (CT-2)", () => {
  it("AS-020: FR-018: FR-020: a non-claimant with a failing affected test is blocked with each failing test and its file named, and the same agent resumes", async () => {
    const at = await project(manifest({ acceptance: true, affected: true }), [
      { agentId: "agent-ledger", taskId: "T3", writes: [{ path: "src/ledger.ts", onDisk: true }, { path: "src/ledger.test.ts", onDisk: true }] },
    ]);
    const before = readFileSync(at.statePath);
    const fake = fakePorts(at, {
      affected: [
        { kind: "report", cases: [failing("src/ledger.test.ts", LEDGER_TEST), failing("src/audit.test.ts", "audit > logs the debit"), passing("src/ledger.test.ts", "ledger > opens")] },
        { kind: "report", cases: [passing("src/ledger.test.ts", LEDGER_TEST), passing("src/audit.test.ts", "audit > logs the debit")] },
      ],
    });
    const first = recordingCleanup();

    const blocked = await runDispatch(stopStdin("agent-ledger"), [], first.cleanup, fake.ports);

    expect(blocked.kind).toBe("block");
    const message = operatorText(blocked);
    expect(message).toContain(AFFECTED_BLOCK_HEADING);
    expect(message).not.toContain(ACCEPTANCE_BLOCK_HEADING);
    expect(message).toContain(`'${LEDGER_TEST}' (src/ledger.test.ts)`);
    expect(message).toContain("'audit > logs the debit' (src/audit.test.ts)");
    expect(message).not.toContain("ledger > opens");
    expect(affectedLaunches(fake.launches).map(({ argv }) => argv)).toEqual([affectedArgv("src/ledger.ts", "src/ledger.test.ts")]);
    expect([...fake.counters.affected.values()]).toEqual([1]);
    // The same agent keeps working: nothing settled, nothing released.
    expect(first.calls).toEqual([]);
    expect(readFileSync(at.statePath).equals(before)).toBe(true);

    const second = recordingCleanup();
    const resumed = await runDispatch(stopStdin("agent-ledger"), [], second.cleanup, fake.ports);

    expect(resumed.kind).not.toBe("block");
    expect(affectedLaunches(fake.launches)).toHaveLength(2);
    expect(second.calls).toHaveLength(1);
  });

  it("AS-021: FR-018: an affected run whose tests all pass runs over the changed files and does not block", async () => {
    const at = await project(manifest({ affected: true }), [
      { agentId: "agent-ledger", taskId: "T3", writes: [{ path: "src/ledger.ts", onDisk: true }] },
    ]);
    const fake = fakePorts(at, { affected: { kind: "report", cases: [passing("src/ledger.test.ts", LEDGER_TEST)] } });
    const { cleanup, calls } = recordingCleanup();

    const result = await runDispatch(stopStdin("agent-ledger"), [], cleanup, fake.ports);

    expect(result.kind).not.toBe("block");
    expect(affectedLaunches(fake.launches).map(({ argv }) => argv)).toEqual([affectedArgv("src/ledger.ts")]);
    expect(fake.reads.map(({ path }) => path)).toEqual([join(at.root, AFFECTED_REPORT)]);
    expect([...fake.counters.affected.values()].every((blocks) => blocks === 0)).toBe(true);
    expect(calls).toHaveLength(1);
  });
});

// --- Changed files ---

describe("I7 runs over the Task's existing changed files (CT-2)", () => {
  it("AS-022: FR-021: a Task with no changed files in its epoch skips the affected check with a note saying so", async () => {
    const at = await project(manifest({ affected: true }), [{ agentId: "agent-ledger", taskId: "T3", writes: [] }]);
    const fake = fakePorts(at, { affected: { kind: "report", cases: [failing("src/ledger.test.ts", LEDGER_TEST)] } });
    const { cleanup } = recordingCleanup();

    const result = await runDispatch(stopStdin("agent-ledger"), [], cleanup, fake.ports);

    expect(result.kind).toBe("passthrough");
    expect(affectedLaunches(fake.launches)).toEqual([]);
    expect(operatorText(result)).toContain(AFFECTED_NOTE_TEXT["no-changed-files"]);
  });

  it("AS-023: FR-021: an affected run reporting zero tests passes with a note saying zero affected tests were found", async () => {
    const at = await project(manifest({ affected: true }), [
      { agentId: "agent-ledger", taskId: "T3", writes: [{ path: "docs/ledger.md", onDisk: true }] },
    ]);
    const fake = fakePorts(at, { affected: { kind: "report", cases: [] } });
    const { cleanup } = recordingCleanup();

    const result = await runDispatch(stopStdin("agent-ledger"), [], cleanup, fake.ports);

    expect(result.kind).toBe("passthrough");
    expect(affectedLaunches(fake.launches).map(({ argv }) => argv)).toEqual([affectedArgv("docs/ledger.md")]);
    expect(operatorText(result)).toContain(AFFECTED_NOTE_TEXT["zero-tests"]);
  });

  it("AS-024: FR-019: a changed file deleted by stop time is excluded, and a renamed file is passed under its new path", async () => {
    const at = await project(manifest({ affected: true }), [{
      agentId: "agent-ledger",
      taskId: "T3",
      writes: [
        { path: "src/old-name.ts", onDisk: false },
        { path: "src/gone.ts", onDisk: false },
        { path: "src/ledger.ts", onDisk: true },
        // `mv src/old-name.ts src/new-name.ts` mints a shell FileWrite for its destination.
        { path: "src/new-name.ts", via: "shell", onDisk: true },
      ],
    }]);
    const fake = fakePorts(at, { affected: { kind: "report", cases: [passing("src/ledger.test.ts", LEDGER_TEST)] } });

    await runDispatch(stopStdin("agent-ledger"), [], recordingCleanup().cleanup, fake.ports);

    expect(affectedLaunches(fake.launches).map(({ argv }) => argv)).toEqual([affectedArgv("src/ledger.ts", "src/new-name.ts")]);
  });

  it("FR-019: the changed files are only this epoch's FileWrite paths inside the repository, deduplicated in first-write order", async () => {
    const at = await project(manifest({ affected: true }), [
      {
        agentId: "agent-ledger",
        taskId: "T3",
        writes: [
          { path: "src/ledger.ts", onDisk: true },
          { path: "/elsewhere/outside-the-repository.ts", onDisk: false },
          { path: "src/ledger.test.ts", onDisk: true },
          { path: "src/ledger.ts", via: "shell", onDisk: true },
        ],
      },
      // A sibling's epoch on the same session ledger.
      { agentId: "agent-payload", taskId: "T2", writes: [{ path: "src/payload.ts", onDisk: true }] },
    ]);
    const fake = fakePorts(at, { affected: { kind: "report", cases: [passing("src/ledger.test.ts", LEDGER_TEST)] } });

    await runDispatch(stopStdin("agent-ledger"), [], recordingCleanup().cleanup, fake.ports);

    expect(affectedLaunches(fake.launches).map(({ argv }) => argv)).toEqual([affectedArgv("src/ledger.ts", "src/ledger.test.ts")]);
  });
});

// --- Failing open ---

describe("I7 fails open with a named note (CT-2)", () => {
  it(`AS-025: FR-022: FR-023: after ${AFFECTED_STOP_CHECK_MAX_BLOCKS} affected blocks the next failing stop fails open with a note and does not block`, async () => {
    const at = await project(manifest({ affected: true }), [
      { agentId: "agent-ledger", taskId: "T3", writes: [{ path: "src/ledger.ts", onDisk: true }] },
    ]);
    const fake = fakePorts(at, { affected: { kind: "report", cases: [failing("src/ledger.test.ts", LEDGER_TEST)] } });

    const results: HookResult[] = [];
    for (let stop = 0; stop <= AFFECTED_STOP_CHECK_MAX_BLOCKS; stop++) {
      results.push(await runDispatch(stopStdin("agent-ledger"), [], recordingCleanup().cleanup, fake.ports));
    }

    expect(results.slice(0, AFFECTED_STOP_CHECK_MAX_BLOCKS).map(({ kind }) => kind)).toEqual(Array(AFFECTED_STOP_CHECK_MAX_BLOCKS).fill("block"));
    const last = results.at(-1)!;
    expect(last.kind).not.toBe("block");
    expect(operatorText(last)).toContain(AFFECTED_NOTE_TEXT["cap-reached"]);
  });

  it("AS-025: FR-022: an agent the affected check has already blocked 3 times is not blocked again", async () => {
    const at = await project(manifest({ affected: true }), [
      { agentId: "agent-ledger", taskId: "T3", writes: [{ path: "src/ledger.ts", onDisk: true }] },
    ]);
    const fake = fakePorts(at, { affected: { kind: "report", cases: [failing("src/ledger.test.ts", LEDGER_TEST)] }, blocks: { affected: 3 } });

    const result = await runDispatch(stopStdin("agent-ledger"), [], recordingCleanup().cleanup, fake.ports);

    expect(result.kind).toBe("passthrough");
    expect(operatorText(result)).toContain(AFFECTED_NOTE_TEXT["cap-reached"]);
  });

  it.each<[string, Run, AffectedStopCheckNoteKind]>([
    ["times out (120 s)", { kind: "timed-out" }, "timed-out"],
    ["exits without a readable report", { kind: "no-report" }, "no-readable-report"],
    ["cannot be started", { kind: "start-failed" }, "start-failed"],
    ["is killed", { kind: "killed" }, "killed"],
    ["does not complete", { kind: "did-not-complete" }, "did-not-complete"],
  ])("AS-026: FR-022: an affected runner that %s fails open with a note naming the cause", async (_label, run, note) => {
    const at = await project(manifest({ affected: true }), [
      { agentId: "agent-ledger", taskId: "T3", writes: [{ path: "src/ledger.ts", onDisk: true }] },
    ]);
    const fake = fakePorts(at, { affected: run });

    const result = await runDispatch(stopStdin("agent-ledger"), [], recordingCleanup().cleanup, fake.ports);

    expect(result.kind).toBe("passthrough");
    expect(operatorText(result)).toContain(AFFECTED_NOTE_TEXT[note]);
    const launched = affectedLaunches(fake.launches);
    expect(launched).toHaveLength(1);
    expect(launched[0]!.timeoutMs).toBe(MAX_AFFECTED_RUNNER_TIMEOUT_MS);
    expect([...fake.counters.affected.values()].every((blocks) => blocks === 0)).toBe(true);
    expect(fake.locks).toMatchObject({ acquired: 1, released: 1 });
  });
});

// --- Never completion evidence ---

describe("I7 data never reaches proof, receipts or gate evidence (CT-2)", () => {
  it.each<[string, Run]>([
    ["all affected tests pass", { kind: "report", cases: [passing("src/ledger.test.ts", LEDGER_TEST)] }],
    ["zero affected tests are found", { kind: "report", cases: [] }],
    ["the affected runner times out", { kind: "timed-out" }],
  ])("AS-027: FR-026: when %s, the settled TaskGraph carries nothing from the affected check", async (_label, run) => {
    const at = await project(manifest({ affected: true }), [
      { agentId: "agent-ledger", taskId: "T3", writes: [{ path: "src/ledger.ts", onDisk: true }] },
    ]);
    const fake = fakePorts(at, { affected: run });

    const result = await runDispatch(stopStdin("agent-ledger"), [], recordingCleanup().cleanup, fake.ports);

    expect(result.kind).not.toBe("block");
    expect(affectedLaunches(fake.launches)).toHaveLength(1);
    const { verification_manifest: _frozen, ...settled } = JSON.parse(readFileSync(at.statePath, "utf8")) as Record<string, unknown>;
    const text = JSON.stringify(settled);
    expect(text).not.toContain(AFFECTED_REPORT);
    expect(text).not.toContain(LEDGER_TEST);
    expect(text).not.toContain("affected");
    expect(text).not.toContain("related");
  });
});

// --- One lock, one sequence, one message, one budget ---

describe("I7 shares one lock, one combined message and one budget with the acceptance check (CT-2)", () => {
  it("AS-028: FR-024: a claimant with both runners runs acceptance then affected under one lock, and one block message lists each check's failures under its own heading", async () => {
    const at = await project(manifest({ acceptance: true, affected: true }), [
      { agentId: "agent-payload", taskId: "T2", writes: [{ path: "src/payload.ts", onDisk: true }] },
    ]);
    const fake = fakePorts(at, {
      acceptance: { kind: "report", cases: [failing(SURFACE.acceptance, OWED)] },
      affected: { kind: "report", cases: [failing("src/payload.test.ts", PAYLOAD_TEST)] },
    });

    const result = await runDispatch(stopStdin("agent-payload"), [], recordingCleanup().cleanup, fake.ports);

    expect(result.kind).toBe("block");
    expect(fake.launches.map(({ check }) => check)).toEqual(["acceptance", "affected"]);
    expect(fake.launches.every(({ lockHeld }) => lockHeld)).toBe(true);
    expect(fake.locks).toMatchObject({ acquired: 1, released: 1 });
    const message = operatorText(result);
    const at1 = message.indexOf(ACCEPTANCE_BLOCK_HEADING);
    const owed = message.indexOf(OWED);
    const at2 = message.indexOf(AFFECTED_BLOCK_HEADING);
    const affected = message.indexOf(`'${PAYLOAD_TEST}' (src/payload.test.ts)`);
    expect(at1).toBeGreaterThanOrEqual(0);
    expect(owed).toBeGreaterThan(at1);
    expect(at2).toBeGreaterThan(owed);
    expect(affected).toBeGreaterThan(at2);
    expect([...fake.counters.acceptance.values()]).toEqual([1]);
    expect([...fake.counters.affected.values()]).toEqual([1]);
  });

  it("AS-029: FR-023: with the acceptance check at its own cap, only the affected check still blocks", async () => {
    const at = await project(manifest({ acceptance: true, affected: true }), [
      { agentId: "agent-payload", taskId: "T2", writes: [{ path: "src/payload.ts", onDisk: true }] },
    ]);
    const fake = fakePorts(at, {
      acceptance: { kind: "report", cases: [failing(SURFACE.acceptance, OWED)] },
      affected: { kind: "report", cases: [failing("src/payload.test.ts", PAYLOAD_TEST)] },
      blocks: { acceptance: 3 },
    });

    const result = await runDispatch(stopStdin("agent-payload"), [], recordingCleanup().cleanup, fake.ports);

    expect(result.kind).toBe("block");
    const message = operatorText(result);
    expect(message).toContain(AFFECTED_BLOCK_HEADING);
    expect(message).not.toContain(ACCEPTANCE_BLOCK_HEADING);
    expect([...fake.counters.affected.values()]).toEqual([1]);
    expect([...fake.counters.acceptance.values()].every((blocks) => blocks === 3)).toBe(true);
  });

  it("AS-029: FR-023: with the affected check at its own cap, only the acceptance check still blocks", async () => {
    const at = await project(manifest({ acceptance: true, affected: true }), [
      { agentId: "agent-payload", taskId: "T2", writes: [{ path: "src/payload.ts", onDisk: true }] },
    ]);
    const fake = fakePorts(at, {
      acceptance: { kind: "report", cases: [failing(SURFACE.acceptance, OWED)] },
      affected: { kind: "report", cases: [failing("src/payload.test.ts", PAYLOAD_TEST)] },
      blocks: { affected: 3 },
    });

    const result = await runDispatch(stopStdin("agent-payload"), [], recordingCleanup().cleanup, fake.ports);

    expect(result.kind).toBe("block");
    const message = operatorText(result);
    expect(message).toContain(ACCEPTANCE_BLOCK_HEADING);
    expect(message).not.toContain(AFFECTED_BLOCK_HEADING);
    expect([...fake.counters.acceptance.values()]).toEqual([1]);
    expect([...fake.counters.affected.values()].every((blocks) => blocks === 3)).toBe(true);
  });

  const deadlineMs = STOP_HOOK_BUDGET_MS - SETTLEMENT_RESERVE_MS;

  it.each<[string, number, boolean]>([
    ["leaves less than the affected timeout", deadlineMs - MAX_AFFECTED_RUNNER_TIMEOUT_MS + 1, false],
    ["leaves exactly the affected timeout", deadlineMs - MAX_AFFECTED_RUNNER_TIMEOUT_MS, true],
    ["leaves more than the affected timeout", 100_000, true],
  ])("AS-030: FR-025: an acceptance run that %s of the hook budget decides whether the affected runner launches, and the hook finishes inside 300 s", async (_label, acceptanceMs, launches) => {
    const at = await project(manifest({ acceptance: true, affected: true }), [
      { agentId: "agent-payload", taskId: "T2", writes: [{ path: "src/payload.ts", onDisk: true }] },
    ]);
    const fake = fakePorts(at, {
      acceptance: { kind: "report", cases: [passing(SURFACE.acceptance, OWED)], tookMs: acceptanceMs },
      affected: { kind: "timed-out" },
    });

    const result = await runDispatch(stopStdin("agent-payload"), [], recordingCleanup().cleanup, fake.ports);

    expect(result.kind).not.toBe("block");
    expect(fake.launches.map(({ check }) => check)).toEqual(launches ? ["acceptance", "affected"] : ["acceptance"]);
    expect(operatorText(result)).toContain(AFFECTED_NOTE_TEXT[launches ? "timed-out" : "budget-exhausted"]);
    expect(fake.clock.ms - fake.startedAtMs).toBeLessThanOrEqual(STOP_HOOK_BUDGET_MS);
  });

  it("AS-031: two agents stopping concurrently in one project never read a report while a run is writing one", async () => {
    const at = await project(manifest({ acceptance: true, affected: true }), [
      { agentId: "agent-payload", taskId: "T2", writes: [{ path: "src/payload.ts", onDisk: true }] },
      { agentId: "agent-ledger", taskId: "T3", writes: [{ path: "src/ledger.ts", onDisk: true }] },
    ]);
    const lock = { holder: null };
    const options: FakeOptions = {
      acceptance: { kind: "report", cases: [passing(SURFACE.acceptance, OWED)] },
      affected: { kind: "report", cases: [passing("src/ledger.test.ts", LEDGER_TEST)] },
      latencyMs: 25,
      lock,
      flight: { count: 0 },
    };
    const payload = fakePorts(at, options);
    const ledger = fakePorts(at, options);

    const results = await Promise.all([
      runDispatch(stopStdin("agent-payload"), [], recordingCleanup().cleanup, payload.ports),
      runDispatch(stopStdin("agent-ledger"), [], recordingCleanup().cleanup, ledger.ports),
    ]);

    expect(results.map(({ kind }) => kind)).not.toContain("block");
    const reads = [...payload.reads, ...ledger.reads];
    const launches = [...payload.launches, ...ledger.launches];
    expect(reads.some(({ path }) => path === join(at.root, AFFECTED_REPORT))).toBe(true);
    expect(launches.every(({ lockHeld }) => lockHeld)).toBe(true);
    expect(reads.every(({ inFlight }) => inFlight === 0)).toBe(true);
    expect(lock.holder).toBeNull();
  });
});
