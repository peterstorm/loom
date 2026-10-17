/**
 * INV-3 isolation: affected-check data never reaches proof, receipts or Wave
 * Gate evidence (FR-026, SC-005).
 *
 * The same Task's stop is settled once per affected-check outcome, every
 * other input held fixed: the same project path, Git history, session, agent,
 * ledger epoch, clock and acceptance result. Only what the injected affected
 * runner does differs, and every one of these outcomes lets the stop proceed
 * to settlement. The settled TaskGraph (proof, receipts, test evidence and all)
 * must be byte-identical across them once the per-run identities (reservation
 * ids and the like, minted fresh by each registration) are named by position.
 * So nothing the affected check observed can have reached settlement.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  AFFECTED_NOTE_TEXT,
  MAX_AFFECTED_RUNNER_TIMEOUT_MS,
  STOP_HOOK_BUDGET_MS,
  type AffectedStopCheckNoteKind,
  type StopCheckBlockCount,
} from "../../src/core/affected-stop-check-types";
import { sha256Bytes } from "../../src/core/digest";
import { freezeVerificationManifest } from "../../src/core/verification-manifest";
import type { StopCheckShellPorts } from "../../src/handlers/subagent-stop/acceptance-stop-check";
import { runDispatch } from "../../src/handlers/subagent-stop/dispatch";
import { registerTaskExecutionBatch } from "../../src/handlers/task-execution";
import { publishImplementationAttemptSidecar } from "../../src/implementation-attempt-sidecar";
import { appendEvidence, epochOf, markAgentActive, parseAgentId, parseAgentType, parseSessionId, type Evidence } from "../../src/machine";
import type { CompletionCheckRunnerResult } from "../../src/orchestration/completion-check-runner";
import type { HookResult } from "../../src/types";
import { parseCanonicalRepositoryRoot, type CanonicalRepositoryRoot } from "../../src/utils/workspace-digest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { stateFileJson, task, writeStateFile } from "../fixtures/contract-status-fixtures";
import { inMemoryBlockCounters } from "../fixtures/stop-check-block-counters";

const SESSION = "stop-checks-isolation-session";
const AGENT = "agent-ledger";
const AGENT_TYPE = "code-implementer-agent";
const AFFECTED_REPORT = ".loom/completion-reports/affected.junit.xml";
const FIXED_NOW = new Date("2026-10-16T12:00:00.000Z");
const GIT_DATE = "2026-10-16T12:00:00Z";
const AFFECTED_RUNNER = {
  executable: "vitest",
  args: ["related", "--run", "--reporter=junit", `--outputFile=${AFFECTED_REPORT}`, "{files}"],
  cwd: ".",
  timeoutMs: MAX_AFFECTED_RUNNER_TIMEOUT_MS,
  report: { kind: "required-file", path: AFFECTED_REPORT },
};

const base = canonicalTempDir("loom-stop-checks-isolation-");
const saved = { dir: process.env.LOOM_SUBAGENT_DIR, state: process.env.LOOM_STATE_PATH, project: process.env.CLAUDE_PROJECT_DIR };

afterEach(() => {
  vi.useRealTimers();
  for (const [key, value] of [["LOOM_SUBAGENT_DIR", saved.dir], ["LOOM_STATE_PATH", saved.state], ["CLAUDE_PROJECT_DIR", saved.project]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

type Project = Readonly<{ root: string; canonicalRoot: CanonicalRepositoryRoot; statePath: string }>;

/** The one fixture, rebuilt at the same path with the same Git history for every outcome. */
async function project(): Promise<Project> {
  const root = join(base, "project");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_DATE: GIT_DATE, GIT_COMMITTER_DATE: GIT_DATE };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env });
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
  const raw = JSON.parse(stateFileJson([task("T3", 1, ["src/ledger.ts"])])) as Record<string, unknown>;
  const statePath = writeStateFile(root, JSON.stringify({ ...raw, current_wave: 1, verification_manifest: frozen.value }));
  process.env.LOOM_STATE_PATH = statePath;
  mkdirSync(process.env.LOOM_SUBAGENT_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(process.env.LOOM_SUBAGENT_DIR, `${SESSION}.task_graph`), statePath);
  const registered = await registerTaskExecutionBatch([{ kind: "implementation", prompt: "Task ID: T3", description: "T3" }]);
  if (registered.kind !== "registered") throw new Error(`fixture registration refused: ${JSON.stringify(registered)}`);
  const authority = registered.authorities.find(({ taskId }) => taskId === "T3");
  if (authority === undefined) throw new Error("fixture registration reserved no attempt for T3");
  publishImplementationAttemptSidecar({ sessionId: SESSION, agentId: AGENT, taskGraphPath: statePath, authority });
  const session = parseSessionId(SESSION);
  const id = parseAgentId(AGENT);
  const type = parseAgentType(AGENT_TYPE);
  if (session === null || id === null || type === null) throw new Error("fixture agent");
  await markAgentActive(session, id, type);
  const writes: Evidence[] = [{ kind: "FileWrite", path: join(root, "src/ledger.ts"), via: "tool" }];
  appendEvidence(session, epochOf(id, type), writes);
  mkdirSync(dirname(join(root, "src/ledger.ts")), { recursive: true });
  writeFileSync(join(root, "src/ledger.ts"), "export const ledger = 1;\n");
  writeFileSync(join(process.env.LOOM_SUBAGENT_DIR, `${AGENT}.transcript.jsonl`), [
    { type: "system", subtype: "init", cwd: root, session_id: SESSION, tools: ["Bash"] },
    { type: "user", uuid: "user-1", message: { role: "user", content: "Task ID: T3" }, parent_tool_use_id: null },
    { type: "assistant", uuid: "assistant-1", message: { role: "assistant", content: [{ type: "text", text: "Done." }], model: "claude-fixture" }, requestId: "request-1" },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  const canonicalRoot = parseCanonicalRepositoryRoot(root);
  if (!canonicalRoot.ok) throw new Error("fixture root");
  return { root, canonicalRoot: canonicalRoot.value, statePath };
}

/** What the injected affected runner does, plus the per-stop state that decides whether it launches. */
type Outcome = Readonly<{
  run: "passes" | "fails" | "zero-tests" | "timed-out" | "killed" | "no-report" | "start-failed" | "did-not-complete";
  affectedBlocks?: StopCheckBlockCount;
  lockHeld?: boolean;
  /** How long before this stop the hook started. */
  hookAgeMs?: number;
}>;

const junit = (outcome: "passed" | "failed" | "none"): Uint8Array => new TextEncoder().encode(
  `<testsuites><testsuite name="s" tests="${outcome === "none" ? 0 : 1}">` +
  (outcome === "none" ? "" : `<testcase classname="src/ledger.test.ts" name="ledger > balances">${outcome === "failed" ? "<failure/>" : ""}</testcase>`) +
  "</testsuite></testsuites>");

function ports(at: Project, outcome: Outcome): StopCheckShellPorts {
  const reports = new Map<string, Uint8Array>();
  const runnerResult = (timedOut: boolean, signal: string | null, bytes: Uint8Array | null): CompletionCheckRunnerResult => {
    if (bytes !== null) reports.set(join(at.root, AFFECTED_REPORT), bytes);
    return {
      ok: true,
      value: {
        checkResult: {
          checkId: "affected", scope: "wave",
          outcome: { kind: "observed", exitCode: 1, timedOut, signal, report: bytes === null ? { kind: "missing", path: AFFECTED_REPORT } : { kind: "produced", path: AFFECTED_REPORT, digest: sha256Bytes(bytes), byteLength: bytes.byteLength } },
        },
        diagnostics: { stdoutTail: "affected runner stdout naming ledger > balances", stderrTail: "", stdoutTruncated: false, stderrTruncated: false },
      },
    } as CompletionCheckRunnerResult;
  };
  const now = FIXED_NOW.getTime();
  return {
    repositoryRoot: () => ({ ok: true, root: at.canonicalRoot }),
    acquireRunner: () => outcome.lockHeld === true ? { kind: "held", reason: "another stop holds the lock" } : { kind: "acquired", release: () => null },
    runCheck: async (command) => {
      switch (outcome.run) {
        case "passes": return runnerResult(false, null, junit("passed"));
        case "fails": return runnerResult(false, null, junit("failed"));
        case "zero-tests": return runnerResult(false, null, junit("none"));
        case "timed-out": return runnerResult(true, "SIGKILL", junit("failed"));
        case "killed": return runnerResult(false, "SIGTERM", junit("failed"));
        case "no-report": return runnerResult(false, null, null);
        case "start-failed":
          return { ok: true, value: { checkResult: { checkId: command.checkId, scope: "wave", outcome: { kind: "spawn-failed", message: "spawn ENOENT" } }, diagnostics: { stdoutTail: "", stderrTail: "", stdoutTruncated: false, stderrTruncated: false } } } as CompletionCheckRunnerResult;
        case "did-not-complete":
          return { ok: false, error: { kind: "containment-unsupported", message: "no process groups" } };
      }
    },
    readReport: (path) => reports.get(path) ?? new Uint8Array(),
    blocks: inMemoryBlockCounters(outcome.affectedBlocks === undefined ? {} : { presets: { affected: outcome.affectedBlocks } }).counters,
    pathExists: () => true,
    // The hook started `hookAgeMs` ago; the clock does not move during the stop.
    now: (() => { let first = true; return () => { const reading = first ? now - (outcome.hookAgeMs ?? 0) : now; first = false; return reading; }; })(),
  };
}

/**
 * Name every per-run identity by its first position, so two settlements
 * compare byte for byte: the UUIDs each registration mints, and the two
 * digests computed over them (the attempt's authority digest and the receipt
 * id). Every other byte, every other digest included, is compared as is.
 */
function normalized(text: string): string {
  const seen = new Map<string, string>();
  const name = (id: string): string => {
    const named = seen.get(id) ?? `<id-${seen.size}>`;
    seen.set(id, named);
    return named;
  };
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, name)
    .replace(/("(?:authorityDigest|receiptId)": ")([0-9a-f]{64})"/g, (_match, key: string, digest: string) => `${key}${name(digest)}"`);
}

async function settle(outcome: Outcome): Promise<Readonly<{ result: HookResult; settled: string }>> {
  vi.useFakeTimers({ toFake: ["Date"], now: FIXED_NOW });
  const at = await project();
  const result = await runDispatch(JSON.stringify({
    session_id: SESSION, agent_id: AGENT, agent_type: AGENT_TYPE,
    agent_transcript_path: join(process.env.LOOM_SUBAGENT_DIR ?? "", `${AGENT}.transcript.jsonl`),
    hook_event_name: "SubagentStop",
  }), [], async () => ({ kind: "passthrough" }), ports(at, outcome));
  vi.useRealTimers();
  return { result, settled: normalized(readFileSync(at.statePath, "utf8")) };
}

const BASELINE: Outcome = { run: "passes" };

describe("INV-3: settlement is byte-identical under every affected-check outcome", () => {
  it.each<[string, Outcome, AffectedStopCheckNoteKind | null]>([
    ["all affected tests pass", { run: "passes" }, null],
    ["zero affected tests are found", { run: "zero-tests" }, "zero-tests"],
    ["failing tests at the block cap", { run: "fails", affectedBlocks: { kind: "count", blocks: 3 } }, "cap-reached"],
    ["an unreadable block counter", { run: "fails", affectedBlocks: { kind: "unreadable", reason: "counter is not JSON" } }, "counter-unreadable"],
    ["the runner timing out", { run: "timed-out" }, "timed-out"],
    ["the runner being killed", { run: "killed" }, "killed"],
    ["no readable report", { run: "no-report" }, "no-readable-report"],
    ["a runner that cannot start", { run: "start-failed" }, "start-failed"],
    ["a runner that does not complete", { run: "did-not-complete" }, "did-not-complete"],
    ["an exhausted hook budget", { run: "fails", hookAgeMs: STOP_HOOK_BUDGET_MS }, "budget-exhausted"],
    ["a runner lock another stop holds", { run: "fails", lockHeld: true }, "lock-held"],
  ])("AS-027: FR-026: with %s, the stop proceeds and the settled TaskGraph equals the all-pass settlement", async (_label, outcome, note) => {
    const baseline = await settle(BASELINE);
    const observed = await settle(outcome);

    expect(observed.result.kind).toBe("passthrough");
    if (note !== null && observed.result.kind === "passthrough") expect(observed.result.systemMessage).toContain(AFFECTED_NOTE_TEXT[note]);
    expect(observed.settled).toBe(baseline.settled);
    // The frozen manifest names the affected runner by design; nothing else may.
    const { verification_manifest: _frozen, ...settled } = JSON.parse(observed.settled) as Record<string, unknown>;
    expect(JSON.stringify(settled)).not.toMatch(/affected|related|ledger > balances/);
  });
});
