/**
 * I6 settlement wiring matrix (T9, AD-6, AD-7).
 *
 * The same epoch facts reach exact settlement through each harness's own
 * ledger boundary:
 *   - Claude Code: the session ledger's records, read into the agent's epoch
 *     by `claudeEpochLedger` (what `update-task-status` hands settlement);
 *   - Pi: the parent session's ledger read back under the child's grant epoch
 *     by `piImplementationLedger` over `piChildEvidence`.
 * Both settle through `settleExactImplementation`, and every row asserts the
 * two harnesses reach the identical I6 result. The remaining blocks cover the
 * unreadable-ledger and unfrozen-classification infrastructure paths, the one
 * `redThenGreenDuty` answer (frozen Proof first, each disagreement named),
 * the stored-evidence reconcile carry-forward, the brief's I6 section and
 * retry remedy, and the real SubagentStop handler path carrying the agent's
 * epoch ledger into settlement.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildTaskLocalByteObservation,
  parseNewTestEvidence,
  redThenGreenDuty,
} from "../../src/core/implementation-application";
import {
  createImplementationAttemptAuthority,
  type ImplementationAttemptAuthority,
} from "../../src/core/implementation-completion";
import {
  baselineRestoreCommand,
  renderImplementationBrief,
  RULE_DOCUMENTS,
  type ImplementationBriefInput,
  type RuleDocument,
} from "../../src/core/implementation-brief";
import { authorizeImplementationSpawn } from "../../src/core/implementation-retry";
import {
  PI_STRUCTURED_EVIDENCE_POLICY,
  TRUSTED_LEDGER_ONLY_POLICY,
  type ProofEvaluationPolicy,
  type ProofObligationResult,
} from "../../src/core/proof-obligations";
import type { LedgerObservation, RedThenGreenGap, TestFileResult } from "../../src/core/red-then-green-types";
import { deriveTaskImplementationDispatch } from "../../src/core/task-implementation-dispatch";
import {
  parseAuthoredTaskRoster,
  populateTaskGraph,
  type AuthoredTask,
} from "../../src/core/task-graph-population";
import {
  defaultVerificationManifest,
  freezeVerificationManifest,
  parseFrozenVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import {
  settleExactImplementation,
  type ExactImplementationSettlement,
  type ExactImplementationSettlementPorts,
} from "../../src/handlers/helpers/exact-implementation-settlement";
import { reconcileTaskFromStoredEvidence } from "../../src/handlers/helpers/reconcile-implementation-proof";
import {
  claudeEpochLedger,
  runUpdateTaskStatus,
  type EvidenceSnapshot,
} from "../../src/handlers/subagent-stop/update-task-status";
import { registerTaskExecutionBatch } from "../../src/handlers/task-execution";
import { SUBAGENT_DIR } from "../../src/config";
import type { ImplementationAuthorityObservation } from "../../src/implementation-attempt-sidecar";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import {
  epochOf,
  parseAgentId,
  parseAgentType,
  parseSessionId,
  type AgentId,
  type AgentType,
  type EvidenceRecord,
  type SessionId,
} from "../../src/machine";
import { parseEvidenceLine } from "../../src/machine/evidence";
import { extractShellWriteTargets } from "../../src/core/shell-write-targets";
import type { Task, TaskGraph, TaskTestResult } from "../../src/types";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import { IMPLEMENTATION_BRIEF_TEMPLATE } from "../../src/orchestration/implementation-brief";
import { piGrantedAgentId } from "../../../pi/write-grant";
import { piImplementationLedger } from "../../../pi/subagent-settlement";

// --- Identities ---

function required<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`fixture ${label} must parse`);
  return value;
}

const ROOT = "/fixture";
const AGENT_TYPE: AgentType = required(parseAgentType("code-implementer-agent"), "agent type");
const CLAUDE_AGENT: AgentId = required(parseAgentId("agent-7"), "Claude agent id");
const PARENT_SESSION: SessionId = required(parseSessionId("pi-parent-session"), "Pi parent session");
const GRANT_TOKEN = "c".repeat(64);
const PI_AGENT: AgentId = required(piGrantedAgentId(GRANT_TOKEN), "Pi grant agent id");
const CLAUDE_EPOCH = epochOf(CLAUDE_AGENT, AGENT_TYPE);
const PI_EPOCH = epochOf(PI_AGENT, AGENT_TYPE);

// --- Files and runs ---

const LEDGER_TEST = "engine/tests/core/ledger.test.ts";
const REPLAY_TEST = "engine/tests/core/replay.test.ts";
const LEDGER_IMPL = "engine/src/core/ledger.ts";
const LEDGER_TYPES = "engine/src/core/ledger-types.ts";
const LEDGER_FIXTURES = "engine/tests/fixtures/ledger-fixtures.ts";
const REPORTED_LEDGER_TEST = "tests/core/ledger.test.ts";
const REPORTED_REPLAY_TEST = "tests/core/replay.test.ts";
const RED_RUN = "npm --prefix engine run test:unit -- tests/core/ledger.test.ts";
const GREEN_RUN = "npm --prefix engine run test:unit";

type RawEvent = Readonly<Record<string, unknown>>;

const passing = (file: string): TestFileResult => ({ file, executed: 2, failed: 0, skipped: 0, collectionError: false });
const failing = (file: string): TestFileResult => ({ file, executed: 2, failed: 1, skipped: 0, collectionError: false });
const collectionError = (file: string): TestFileResult => ({ file, executed: 1, failed: 1, skipped: 0, collectionError: true });
const write = (path: string, via: "tool" | "shell" = "tool"): RawEvent => ({ kind: "FileWrite", path, via });

function run(results: readonly TestFileResult[], options: Readonly<{ command?: string; exit?: number | null }> = {}): RawEvent {
  const total = results.reduce((sum, { executed }) => sum + executed, 0);
  const failed = results.reduce((sum, file) => sum + file.failed, 0);
  return {
    kind: "TestRun",
    command: options.command ?? (failed > 0 ? RED_RUN : GREEN_RUN),
    exit: options.exit === undefined ? (failed > 0 ? 1 : 0) : options.exit,
    report: { total, failed, source: "junit-xml", files: { kind: "recorded", results } },
  };
}
const reportlessRun = (exit: number): RawEvent => ({ kind: "TestRun", command: GREEN_RUN, exit, report: null });
const red = (file = REPORTED_LEDGER_TEST): RawEvent => run([failing(file)]);
const green = (...files: readonly string[]): RawEvent =>
  run((files.length === 0 ? [REPORTED_LEDGER_TEST] : files).map(passing));

/** Ledger lines as the production line parser reads them back, under `epoch`. */
function records(events: readonly RawEvent[], epoch: string, foreign: readonly RawEvent[] = []): readonly EvidenceRecord[] {
  const line = (event: RawEvent, owner: string, index: number): EvidenceRecord => {
    const parsed = parseEvidenceLine(JSON.stringify({ epoch: owner, event, callId: `call_${owner}_${index}` }));
    if (!parsed.ok) throw new Error(`fixture ledger line ${index} is unreadable: ${parsed.error}`);
    return parsed.value;
  };
  // A foreign epoch's facts interleave; neither harness may credit them.
  return [
    ...foreign.map((event, index) => line(event, "agent-99:code-implementer-agent", index)),
    ...events.map((event, index) => line(event, epoch, index)),
  ];
}

const TRANSPORTS = ["Claude", "Pi"] as const;
/** Which `harnessLedgers` observation each transport settles from. */
const LEDGER_KEY = { Claude: "claude", Pi: "pi" } as const satisfies Record<(typeof TRANSPORTS)[number], string>;

/** Each harness's epoch observation of the same facts. */
function harnessLedgers(events: readonly RawEvent[]): Readonly<{ claude: LedgerObservation; pi: LedgerObservation }> {
  const foreign = [write(LEDGER_IMPL), red(), green()];
  const claude = claudeEpochLedger({ kind: "read", records: records(events, CLAUDE_EPOCH, foreign) }, CLAUDE_AGENT, AGENT_TYPE);
  const piLedger = records(events, PI_EPOCH, foreign);
  const pi = piImplementationLedger(PARENT_SESSION, GRANT_TOKEN, AGENT_TYPE, {
    readEvidence: (session: SessionId) => session === PARENT_SESSION ? piLedger : [],
  });
  return { claude, pi };
}

// --- Population and settlement ---

type NewTests = "required" | "claimant";

function authoredTask(id: string, fileList: readonly string[], newTests: NewTests = "required"): AuthoredTask {
  return {
    id,
    description: `implement ${id}`,
    agent: "code-implementer-agent",
    wave: 1,
    depends_on: [],
    spec_anchors: [],
    spec_contributions: [],
    verification_policy: {
      regression: { kind: "required" },
      new_tests: newTests === "required"
        ? { kind: "required" }
        : { kind: "waived", reason: "covered-by-acceptance-contract" },
    },
    file_list: fileList,
  };
}

function populate(tasks: readonly AuthoredTask[], manifest: FrozenVerificationManifest | undefined): TaskGraph {
  const roster = parseAuthoredTaskRoster(tasks);
  if (!roster.ok) throw new Error(`fixture roster refused: ${roster.error}`);
  const populated = populateTaskGraph(
    { current_phase: "decompose", phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: "plan.md", tasks: [], wave_gates: {} },
    {
      planTitle: "Ledger plan",
      validatedPlanFile: "plan.md",
      tasks: roster.value,
      verificationManifest: manifest ?? defaultVerificationManifest(),
      specIndex: { kind: "unavailable", reason: { kind: "no-spec-file" } },
      observedSpecFile: null,
      force: false,
      proofBoundary: { kind: "absent", cause: "fixture: no Git repository root" },
      contracts: [],
    },
  );
  if (!populated.ok) throw new Error(`fixture population refused: ${populated.error.message}`);
  return populated.value.state;
}

function operatorPatternManifest(suffixes: readonly string[]): FrozenVerificationManifest {
  const source = { schemaVersion: 2, kind: "loom-verification-manifest", checks: [], testFileSuffixes: suffixes };
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify(source)));
  if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
  return frozen.value;
}

/** Today's exact engine-default freeze: what every TaskGraph populated before I6 carries. */
function preFeatureManifest(): FrozenVerificationManifest {
  const parsed = parseFrozenVerificationManifest({
    schemaVersion: 1,
    kind: "frozen-verification-manifest",
    source: { kind: "engine-default" },
    manifestDigest: "f151b9015dd8afd2c9ff94add17a86f6b5a9b0408931b31af70e9d4629823d6c",
    projectChecks: [],
  });
  if (!parsed.ok) throw new Error(`pre-feature manifest refused: ${parsed.error.errors.join("; ")}`);
  return parsed.value;
}

const taskOf = (graph: TaskGraph, taskId: string): Task => {
  const task = graph.tasks.find(({ id }) => id === taskId);
  if (task === undefined) throw new Error(`no ${taskId} in the fixture graph`);
  return task;
};

function reserved(graph: TaskGraph, taskId: string): Readonly<{ graph: TaskGraph; attempt: ImplementationAttemptAuthority }> {
  const task = taskOf(graph, taskId);
  const parsed = createImplementationAttemptAuthority({
    taskId: task.id,
    wave: task.wave,
    semanticAttempt: 1,
    reservationId: `t9-${task.id}`,
    headSha: "a".repeat(40),
    reservedAt: "2026-10-16T00:00:00.000Z",
    taskScopeBaseline: [],
    dirtySetBaseline: [],
  });
  if (!parsed.ok) throw new Error(parsed.error.errors.join("; "));
  const attempt = parsed.value;
  return {
    attempt,
    graph: {
      ...graph,
      executing_tasks: [taskId],
      tasks: graph.tasks.map((candidate): Task => candidate.id === taskId
        ? { ...candidate, active_implementation_attempt: attempt, reserved_at: attempt.reservedAt, start_sha: "d".repeat(40) }
        : candidate),
    },
  };
}

const snapshots = (paths: readonly string[], changed: boolean) =>
  [...paths].sort().map((artifact) => ({
    artifact,
    snapshot: changed ? { kind: "sha256" as const, digest: "b".repeat(64) } : { kind: "missing" as const },
  }));

function ports(
  attempt: ImplementationAttemptAuthority,
  fileList: readonly string[],
  newTestsWritten = true,
): ExactImplementationSettlementPorts {
  return {
    repository: {
      root: ROOT,
      authoritativeStatePath: `${ROOT}/.claude/state/active_task_graph.json`,
      observeTaskLocal: () => buildTaskLocalByteObservation({
        authority: attempt,
        attemptBaseline: snapshots(fileList, false),
        currentAttemptScope: snapshots(fileList, true),
        proofBaseline: snapshots(fileList, false),
        currentProofScope: snapshots(fileList, true),
        parserModifiedPaths: [],
        priorAttributedPaths: [],
        repositoryChangedPaths: [...fileList],
        siblingOwnedPaths: [],
      }),
    },
    newTests: {
      collect: () => ({
        ok: true,
        value: parseNewTestEvidence(newTestsWritten, newTestsWritten ? `new tests in ${fileList.join(", ")}` : undefined),
      }),
    },
  };
}

type SettleOptions = Readonly<{
  transport?: "Claude" | "Pi";
  policy?: ProofEvaluationPolicy;
  testResult?: TaskTestResult;
  newTestsWritten?: boolean;
}>;

function settle(
  graph: TaskGraph,
  taskId: string,
  ledger: LedgerObservation,
  options: SettleOptions = {},
): ExactImplementationSettlement {
  const { graph: state, attempt } = reserved(graph, taskId);
  const transport = options.transport ?? "Claude";
  return settleExactImplementation(state, {
    transport,
    authority: attempt,
    observedAt: "2026-10-16T00:05:00.000Z" as never,
    parserModifiedPaths: [],
    parserPathLabel: `${transport} fixture paths`,
    taskCompleted: true,
    testResult: options.testResult ?? { verdict: "trusted-pass" },
    testEvidence: `${transport} test evidence`,
    proofEvaluationPolicy: options.policy ?? (transport === "Pi" ? PI_STRUCTURED_EVIDENCE_POLICY : TRUSTED_LEDGER_ONLY_POLICY),
    ledger,
  }, ports(attempt, taskOf(state, taskId).file_list ?? [], options.newTestsWritten ?? true));
}

/** A Task's persisted I6 result, or undefined when its proof owes none or is not yet evaluated. */
function i6ResultOfTask(task: Task): ProofObligationResult | undefined {
  const proof = task.proof;
  if (proof === undefined || proof.state === "pending") return undefined;
  return proof.results.find((result) => result.obligation.kind === "red-then-green");
}

/** The persisted I6 result of a settled Task, or undefined when proof owes none. */
const i6Result = (settled: ExactImplementationSettlement, taskId: string): ProofObligationResult | undefined =>
  settled.application.kind === "applied" ? i6ResultOfTask(taskOf(settled.application.state, taskId)) : undefined;

const transitionOf = (settled: ExactImplementationSettlement): string | undefined =>
  settled.application.kind === "applied" ? settled.application.transition.kind : undefined;

/** An infrastructure settlement: no semantic retry counted, and the receipt says it consumed no attempt. */
function expectInfrastructureBlocked(task: Task): void {
  expect(task.retry_count).toBeUndefined();
  expect(task.implementation_attempt_history?.at(-1)).toMatchObject({ consumesSemanticAttempt: false });
}

/** Settle the same facts through both harness boundaries and require one answer. */
function settleOnBothHarnesses(graph: TaskGraph, events: readonly RawEvent[]) {
  const { claude, pi } = harnessLedgers(events);
  const claudeSettled = settle(graph, "T1", claude, { transport: "Claude" });
  const piSettled = settle(graph, "T1", pi, { transport: "Pi" });
  expect(pi).toEqual(claude);
  expect(i6Result(piSettled, "T1")).toEqual(i6Result(claudeSettled, "T1"));
  expect(transitionOf(piSettled)).toBe(transitionOf(claudeSettled));
  return { claude: claudeSettled, pi: piSettled };
}

function expectGapOnBoth(graph: TaskGraph, events: readonly RawEvent[], gap: RedThenGreenGap): void {
  const { claude } = settleOnBothHarnesses(graph, events);
  expect(claude).not.toHaveProperty("infrastructureReason");
  expect(transitionOf(claude)).toBe("retry-required");
  expect(i6Result(claude, "T1")).toMatchObject({ state: "failed", failure: { kind: "red-then-green-unproven", gap } });
}

function expectShownOnBoth(
  graph: TaskGraph,
  events: readonly RawEvent[],
  shown: Readonly<{ red: number; redCommand?: string; implementationWrite: string; green: number; greenCommand?: string }>,
): void {
  const { claude } = settleOnBothHarnesses(graph, events);
  expect(transitionOf(claude)).toBe("implemented");
  expect(i6Result(claude, "T1")).toMatchObject({
    state: "satisfied",
    evidence: {
      kind: "red-then-green",
      red: { index: shown.red, command: shown.redCommand ?? RED_RUN },
      implementationWrite: shown.implementationWrite,
      green: { index: shown.green, command: shown.greenCommand ?? GREEN_RUN },
    },
  });
}

const i6Graph = (fileList: readonly string[] = [LEDGER_TEST, LEDGER_IMPL]): TaskGraph =>
  populate([authoredTask("T1", fileList)], defaultVerificationManifest());

/** T1 with a Task-level artifact baseline: `created` files were missing at it, every other declared file present. */
function withArtifactBaseline(graph: TaskGraph, created: readonly string[]): TaskGraph {
  const task = taskOf(graph, "T1");
  const artifact_baseline = [...(task.file_list ?? [])].sort().map((artifact) => ({
    artifact,
    snapshot: created.includes(artifact) ? { kind: "missing" as const } : { kind: "sha256" as const, digest: "e".repeat(64) },
  }));
  return withTask(graph, { ...task, artifact_baseline });
}

/** A Vitest JSON run whose report lists `file` as failed to collect: no testcase at all. */
const jsonCollectionErrorRun = (file: string): RawEvent => ({
  kind: "TestRun",
  command: RED_RUN,
  exit: 1,
  report: { total: 0, failed: 0, source: "vitest-json", files: { kind: "recorded", results: [{ file, executed: 0, failed: 0, skipped: 0, collectionError: true }] } },
});

// --- The matrix ---

describe("I6 settlement matrix: Claude Code and Pi settle the same epoch facts identically", () => {
  it("AS-005: red, then the first implementation write, then green satisfy I6 on both harnesses", () => {
    expectShownOnBoth(i6Graph(), [write(LEDGER_TEST), red(), write(LEDGER_IMPL), green()],
      { red: 1, implementationWrite: LEDGER_IMPL, green: 3 });
  });

  it("AS-006: an implementation write before the red run names red as out of order on both harnesses", () => {
    expectGapOnBoth(i6Graph(), [write(LEDGER_TEST), write(LEDGER_IMPL), red(), green()],
      { kind: "red-after-first-implementation-write" });
  });

  it("AS-007: no passing run after the implementation write names green as missing on both harnesses", () => {
    expectGapOnBoth(i6Graph(), [write(LEDGER_TEST), red(), write(LEDGER_IMPL), red()],
      { kind: "green-missing", untrustedOnly: false });
  });

  it("AS-008: no implementation write names the implementation write as missing on both harnesses", () => {
    expectGapOnBoth(i6Graph(), [write(LEDGER_TEST), red(), green()], { kind: "implementation-write-missing" });
  });

  it("AS-009: a collection-error-only failure is not red on both harnesses", () => {
    expect(taskOf(i6Graph(), "T1").artifact_baseline).toBeUndefined();
    expectGapOnBoth(i6Graph(), [write(LEDGER_TEST), run([collectionError(REPORTED_LEDGER_TEST)]), write(LEDGER_IMPL), green()],
      { kind: "red-missing", untrustedOnly: false });
  });

  it("AS-009: a collection error is not red for a Task whose implementation files all existed at its artifact baseline", () => {
    const graph = withArtifactBaseline(i6Graph(), []);
    expectGapOnBoth(graph, [write(LEDGER_TEST), jsonCollectionErrorRun(REPORTED_LEDGER_TEST), write(LEDGER_IMPL), green()],
      { kind: "red-missing", untrustedOnly: false });
  });

  it.each([
    { shape: "Vitest JSON", collectionRed: jsonCollectionErrorRun(REPORTED_LEDGER_TEST) },
    { shape: "JUnit", collectionRed: run([collectionError(REPORTED_LEDGER_TEST)]) },
  ])("AS-042: a $shape collection error is red on both harnesses when the Task creates its implementation file", ({ collectionRed }) => {
    const graph = withArtifactBaseline(i6Graph(), [LEDGER_TEST, LEDGER_IMPL]);
    expectShownOnBoth(graph, [write(LEDGER_TEST), collectionRed, write(LEDGER_IMPL), green()],
      { red: 1, implementationWrite: LEDGER_IMPL, green: 3 });
  });

  it("AS-010: a fixture write before red is the first implementation write on both harnesses", () => {
    expectGapOnBoth(i6Graph([LEDGER_TEST, LEDGER_FIXTURES, LEDGER_IMPL]),
      [write(LEDGER_TEST), write(LEDGER_FIXTURES), red(), write(LEDGER_IMPL), green()],
      { kind: "red-after-first-implementation-write" });
  });

  it("AS-011: a red run without an exit code and a green run without a report count on neither harness", () => {
    expectGapOnBoth(i6Graph(), [write(LEDGER_TEST), run([failing(REPORTED_LEDGER_TEST)], { exit: null }), write(LEDGER_IMPL), reportlessRun(0)],
      { kind: "red-missing", untrustedOnly: true });
  });

  it("AS-013: a file_list with no test file names no-test-files on both harnesses", () => {
    expectGapOnBoth(i6Graph([LEDGER_IMPL, LEDGER_TYPES]), [red(), write(LEDGER_IMPL), green()], { kind: "no-test-files" });
  });

  it("AS-018: under a declared pattern a JVM Task proves I6 identically on both harnesses", () => {
    const main = "src/main/java/com/example/ledger/Ledger.java";
    const test = "src/test/java/com/example/ledger/LedgerTest.java";
    const graph = populate([authoredTask("T1", [main, test])], operatorPatternManifest(["Test.java"]));
    expectShownOnBoth(graph, [
      write(test),
      run([failing("com.example.ledger.LedgerTest")], { command: "mvn test" }),
      write(main),
      run([passing("com.example.ledger.LedgerTest")], { command: "mvn test" }),
    ], { red: 1, redCommand: "mvn test", implementationWrite: main, green: 3, greenCommand: "mvn test" });
  });

  it("AS-014: the same epoch facts settle to the identical judgment twice on each harness", () => {
    const events = [write(LEDGER_TEST), write(REPLAY_TEST), run([failing(REPORTED_LEDGER_TEST), passing(REPORTED_REPLAY_TEST)]), write(LEDGER_IMPL), green(REPORTED_LEDGER_TEST)];
    const graph = i6Graph([LEDGER_TEST, REPLAY_TEST, LEDGER_IMPL]);
    const first = settleOnBothHarnesses(graph, events);
    const second = settleOnBothHarnesses(graph, events);
    expect(second.claude).toEqual(first.claude);
    expect(second.pi).toEqual(first.pi);
    expect(i6Result(first.claude, "T1")).toMatchObject({ failure: { gap: { kind: "green-missing", untrustedOnly: false } } });
  });

  it("AS-012: a claimant Task owes no I6 on either harness, so an unread ledger never blocks it", () => {
    const graph = populate([
      authoredTask("T1", [LEDGER_TEST, LEDGER_IMPL]),
      authoredTask("T2", [REPLAY_TEST, "engine/src/core/replay.ts"], "claimant"),
    ], defaultVerificationManifest());
    for (const transport of ["Claude", "Pi"] as const) {
      const settled = settle(graph, "T2", { kind: "unreadable", reason: "ledger file is corrupt" }, { transport });
      expect(transitionOf(settled)).toBe("implemented");
      expect(i6Result(settled, "T2")).toBeUndefined();
    }
  });
});

describe("Pi settlement reads the child's epoch from the parent ledger (FR-035)", () => {
  it("AS-037: a Pi child's red, first implementation write and green in the parent ledger satisfy I6", () => {
    const events = [write(LEDGER_TEST), red(), write(LEDGER_IMPL, "shell"), green()];
    const ledger = piImplementationLedger(PARENT_SESSION, GRANT_TOKEN, AGENT_TYPE, {
      readEvidence: (session: SessionId) => session === PARENT_SESSION ? records(events, PI_EPOCH) : [],
    });
    const settled = settle(i6Graph(), "T1", ledger, {
      transport: "Pi",
      testResult: { verdict: "untrusted", passed: true, label: "pi-structured", provenance: "pi-structured" },
    });
    expect(transitionOf(settled)).toBe("implemented");
    expect(i6Result(settled, "T1")).toMatchObject({
      state: "satisfied",
      evidence: { kind: "red-then-green", red: { index: 1 }, implementationWrite: LEDGER_IMPL, green: { index: 3 } },
    });
  });

  it("AS-038: Pi-structured transcript evidence with only report-less ledger runs fails I6 naming the untrusted-only red step", () => {
    const events = [write(LEDGER_TEST), reportlessRun(1), write(LEDGER_IMPL), reportlessRun(0)];
    const ledger = piImplementationLedger(PARENT_SESSION, GRANT_TOKEN, AGENT_TYPE, {
      readEvidence: () => records(events, PI_EPOCH),
    });
    for (const policy of [PI_STRUCTURED_EVIDENCE_POLICY, TRUSTED_LEDGER_ONLY_POLICY]) {
      const settled = settle(i6Graph(), "T1", ledger, {
        transport: "Pi",
        policy,
        testResult: { verdict: "untrusted", passed: true, label: "pi-structured", provenance: "pi-structured" },
      });
      expect(transitionOf(settled)).toBe("retry-required");
      expect(i6Result(settled, "T1")).toMatchObject({
        state: "failed",
        failure: { kind: "red-then-green-unproven", gap: { kind: "red-missing", untrustedOnly: true } },
      });
    }
  });

  it("AS-038: Pi-structured evidence with no ledger TestRun at all still names the untrusted-only step", () => {
    const ledger = piImplementationLedger(PARENT_SESSION, GRANT_TOKEN, AGENT_TYPE, {
      readEvidence: () => records([write(LEDGER_TEST), write(LEDGER_IMPL)], PI_EPOCH),
    });
    const settled = settle(i6Graph(), "T1", ledger, {
      transport: "Pi",
      testResult: { verdict: "untrusted", passed: true, label: "pi-structured", provenance: "pi-structured" },
    });
    expect(i6Result(settled, "T1")).toMatchObject({ failure: { gap: { kind: "red-missing", untrustedOnly: true } } });
  });

  it("names why a Pi child's epoch cannot be read instead of reading it as empty", () => {
    const registry = { readEvidence: (): readonly EvidenceRecord[] => [] };
    expect(piImplementationLedger(null, GRANT_TOKEN, AGENT_TYPE, registry)).toMatchObject({ kind: "unreadable", reason: expect.stringMatching(/parent session/) });
    expect(piImplementationLedger(PARENT_SESSION, null, AGENT_TYPE, registry)).toMatchObject({ kind: "unreadable", reason: expect.stringMatching(/write grant/) });
    expect(piImplementationLedger(PARENT_SESSION, GRANT_TOKEN, "bad/agent", registry)).toMatchObject({ kind: "unreadable", reason: expect.stringMatching(/agent type/) });
    expect(piImplementationLedger(PARENT_SESSION, "not-a-token", AGENT_TYPE, registry)).toMatchObject({ kind: "unreadable" });
    expect(piImplementationLedger(PARENT_SESSION, GRANT_TOKEN, AGENT_TYPE, {
      readEvidence: () => { throw new Error("EIO: ledger read failed"); },
    })).toEqual({ kind: "unreadable", reason: "EIO: ledger read failed" });
  });
});

describe("Claude Code settlement reads the agent's own epoch (claudeEpochLedger)", () => {
  it("keeps only the agent's epoch, in ledger order, with duplicate deliveries dropped", () => {
    const own = records([write(LEDGER_TEST), red()], CLAUDE_EPOCH, [write(LEDGER_IMPL)]);
    const duplicated = [...own, own[own.length - 1]!];
    const ledger = claudeEpochLedger({ kind: "read", records: duplicated }, CLAUDE_AGENT, AGENT_TYPE);
    expect(ledger).toEqual({ kind: "read", events: own.slice(1).map(({ event }) => event) });
  });

  it("is unreadable, never an empty epoch, when the ledger read failed or the agent identity is unknown", () => {
    expect(claudeEpochLedger({ kind: "unreadable", reason: "snapshot failed" }, CLAUDE_AGENT, AGENT_TYPE))
      .toEqual({ kind: "unreadable", reason: "snapshot failed" });
    expect(claudeEpochLedger({ kind: "read", records: [] }, null, AGENT_TYPE)).toMatchObject({ kind: "unreadable" });
    expect(claudeEpochLedger({ kind: "read", records: [] }, CLAUDE_AGENT, null)).toMatchObject({ kind: "unreadable" });
  });
});

describe("an unreadable ledger is an infrastructure failure, never a semantic retry", () => {
  it.each(TRANSPORTS)("settles an owed Task as infrastructure-blocked on %s when its ledger is unreadable", (transport) => {
    const settled = settle(i6Graph(), "T1", { kind: "unreadable", reason: "ledger line 4 is corrupt" }, { transport });
    expect(settled.infrastructureReason).toContain("ledger line 4 is corrupt");
    expect(transitionOf(settled)).toBe("infrastructure-blocked");
    if (settled.application.kind !== "applied") return;
    expectInfrastructureBlocked(taskOf(settled.application.state, "T1"));
  });

  it.each(TRANSPORTS)("settles an owed Task as infrastructure-blocked on %s when its TaskGraph froze no test-file classification", (transport) => {
    const populated = i6Graph();
    expect(taskOf(populated, "T1").proof?.obligations.map(({ kind }) => kind)).toContain("red-then-green");
    const unclassified: TaskGraph = { ...populated, verification_manifest: preFeatureManifest() };
    const ledger = harnessLedgers([write(LEDGER_TEST), red(), write(LEDGER_IMPL), green()])[LEDGER_KEY[transport]];
    const settled = settle(unclassified, "T1", ledger, { transport });
    expect(settled.infrastructureReason).toMatch(/T1 owes red-then-green but its TaskGraph freezes no test-file classification/);
    expect(transitionOf(settled)).toBe("infrastructure-blocked");
    if (settled.application.kind !== "applied") throw new Error("infrastructure settlement must apply");
    expectInfrastructureBlocked(taskOf(settled.application.state, "T1"));
  });

  it("FR-005: a pre-feature TaskGraph settles without consulting the ledger at all", () => {
    const graph = populate([authoredTask("T1", [LEDGER_TEST, LEDGER_IMPL])], preFeatureManifest());
    expect(taskOf(graph, "T1").proof?.obligations.map(({ kind }) => kind)).not.toContain("red-then-green");
    expect(transitionOf(settle(graph, "T1", { kind: "read", events: [] }))).toBe("implemented");
    expect(transitionOf(settle(graph, "T1", { kind: "unreadable", reason: "ledger file is corrupt" }))).toBe("implemented");
  });
});

// --- One answer to "does this Task owe I6" ---

/** The Task with no frozen Proof: what a hand-edited or partially migrated
 *  State File can still carry on a pending Task. */
const withoutProof = (task: Task): Task => {
  const { proof: _frozen, ...rest } = task;
  return rest as Task;
};

const withTask = (graph: TaskGraph, task: Task): TaskGraph =>
  ({ ...graph, tasks: graph.tasks.map((candidate) => candidate.id === task.id ? task : candidate) });

describe("redThenGreenDuty: the frozen Proof decides, and every disagreement is named", () => {
  it("reads owed from the frozen Proof and hands over the frozen classification", () => {
    const graph = i6Graph();
    expect(redThenGreenDuty(taskOf(graph, "T1"), graph.verification_manifest)).toEqual({
      kind: "owed",
      testFiles: graph.verification_manifest?.testFiles,
    });
  });

  it("reads not-owed from a frozen Proof without red-then-green, whatever the era", () => {
    const claimant = populate([authoredTask("T1", [LEDGER_TEST, LEDGER_IMPL], "claimant")], defaultVerificationManifest());
    expect(redThenGreenDuty(taskOf(claimant, "T1"), claimant.verification_manifest)).toEqual({ kind: "not-owed" });
    const preFeature = populate([authoredTask("T1", [LEDGER_TEST, LEDGER_IMPL])], preFeatureManifest());
    expect(redThenGreenDuty(taskOf(preFeature, "T1"), preFeature.verification_manifest)).toEqual({ kind: "not-owed" });
  });

  it("names a frozen Proof that owes I6 under a manifest with no test-file classification", () => {
    const graph = i6Graph();
    expect(redThenGreenDuty(taskOf(graph, "T1"), preFeatureManifest())).toEqual({
      kind: "classification-unfrozen",
      reason: "T1 owes red-then-green but its TaskGraph freezes no test-file classification",
    });
  });

  it("names a Task with no frozen Proof in an I6-era TaskGraph instead of reading it as not owed", () => {
    const graph = i6Graph();
    expect(redThenGreenDuty(withoutProof(taskOf(graph, "T1")), graph.verification_manifest)).toEqual({
      kind: "proof-unfrozen",
      reason: "T1 carries no frozen Proof, but its TaskGraph's I6 era owes red-then-green for a Task that requires new tests",
    });
  });

  it("reads a proof-less Task as not owed when its era or its waiver owes no I6", () => {
    const preFeature = populate([authoredTask("T1", [LEDGER_TEST, LEDGER_IMPL])], preFeatureManifest());
    expect(redThenGreenDuty(withoutProof(taskOf(preFeature, "T1")), preFeature.verification_manifest)).toEqual({ kind: "not-owed" });
    const claimant = populate([authoredTask("T1", [LEDGER_TEST, LEDGER_IMPL], "claimant")], defaultVerificationManifest());
    expect(redThenGreenDuty(withoutProof(taskOf(claimant, "T1")), claimant.verification_manifest)).toEqual({ kind: "not-owed" });
  });

  it.each(TRANSPORTS)("refuses on %s to settle a proof-less Task an I6-era TaskGraph obligates, under any ledger", (transport) => {
    const graph = i6Graph();
    const proofless = withTask(graph, withoutProof(taskOf(graph, "T1")));
    for (const ledger of [
      harnessLedgers([write(LEDGER_TEST), red(), write(LEDGER_IMPL), green()])[LEDGER_KEY[transport]],
      { kind: "unreadable", reason: "ledger file is corrupt" } as const,
    ]) {
      const settled = settle(proofless, "T1", ledger, { transport });
      expect(settled).not.toHaveProperty("infrastructureReason");
      expect(settled.application).toMatchObject({
        kind: "error",
        error: { kind: "invalid-task", errors: [expect.stringMatching(/T1 carries no frozen Proof, but its TaskGraph's I6 era owes red-then-green/)] },
      });
      // A refusal changes nothing: the reservation stands and no receipt is written.
      const task = taskOf(settled.application.state, "T1");
      expect(task.active_implementation_attempt).toBeDefined();
      expect(task.implementation_attempt_history).toBeUndefined();
    }
  });
});

// --- Stored-evidence reconcile (INV-6 sibling) ---

describe("reconcileTaskFromStoredEvidence carries a satisfied I6 result forward and never re-judges it", () => {
  const changed = [LEDGER_TEST, LEDGER_IMPL];
  const written = parseNewTestEvidence(true, "new tests in engine/tests/core/ledger.test.ts");

  /** A Task whose I6 was shown but whose proof failed on new-test evidence. */
  function failedOnNewTests(): Readonly<{ graph: TaskGraph; task: Task }> {
    const settled = settle(i6Graph(), "T1", harnessLedgers([write(LEDGER_TEST), red(), write(LEDGER_IMPL), green()]).claude, { newTestsWritten: false });
    expect(transitionOf(settled)).toBe("retry-required");
    if (settled.application.kind !== "applied") throw new Error("fixture settlement must apply");
    return { graph: settled.application.state, task: taskOf(settled.application.state, "T1") };
  }

  it("FR-012: keeps the earlier satisfied red-then-green evidence when another obligation is repaired", () => {
    const { graph, task } = failedOnNewTests();
    const reconciled = reconcileTaskFromStoredEvidence(task, changed, written, false, graph.verification_manifest);
    expect(reconciled.proof?.state).toBe("satisfied");
    expect(reconciled.proof?.state === "satisfied" ? reconciled.proof.evidence : []).toContainEqual({
      kind: "red-then-green",
      red: { index: 1, command: RED_RUN },
      implementationWrite: LEDGER_IMPL,
      green: { index: 3, command: GREEN_RUN },
    });
  });

  it("fails as ledger-unavailable when no satisfied I6 result exists to carry forward", () => {
    const settled = settle(i6Graph(), "T1", harnessLedgers([write(LEDGER_IMPL), green()]).claude);
    if (settled.application.kind !== "applied") throw new Error("fixture settlement must apply");
    const graph = settled.application.state;
    const reconciled = reconcileTaskFromStoredEvidence(taskOf(graph, "T1"), changed, written, false, graph.verification_manifest);
    expect(reconciled.proof).toMatchObject({
      state: "failed",
      failures: expect.arrayContaining([{ kind: "red-then-green-unproven", gap: { kind: "ledger-unavailable" } }]),
    });
  });

  it("FR-005: a pre-feature TaskGraph's Task is never newly obligated", () => {
    const graph = populate([authoredTask("T1", [LEDGER_TEST, LEDGER_IMPL])], preFeatureManifest());
    const task: Task = { ...taskOf(graph, "T1"), test_result: { verdict: "trusted-pass" } } as Task;
    for (const manifest of [graph.verification_manifest, undefined]) {
      const reconciled = reconcileTaskFromStoredEvidence(task, changed, written, false, manifest);
      expect(reconciled.proof?.obligations.map(({ kind }) => kind)).not.toContain("red-then-green");
    }
  });

  it("keeps a frozen red-then-green obligation even when handed a manifest with no classification, so I6 is never silently dropped", () => {
    const { task } = failedOnNewTests();
    const reconciled = reconcileTaskFromStoredEvidence(task, changed, written, false, undefined);
    expect(reconciled.proof?.obligations.map(({ kind }) => kind)).toContain("red-then-green");
    expect(reconciled.proof?.state).toBe("satisfied");
  });

  it("refuses a proof-less Task an I6-era TaskGraph obligates instead of failing it as ledger-unavailable", () => {
    const graph = i6Graph();
    const proofless = { ...withoutProof(taskOf(graph, "T1")), test_result: { verdict: "trusted-pass" } } as Task;
    expect(() => reconcileTaskFromStoredEvidence(proofless, changed, written, false, graph.verification_manifest))
      .toThrow(/T1 carries no frozen Proof, but its TaskGraph's I6 era owes red-then-green/);
  });
});

// --- The brief (AD-7) ---

const TEMPLATE = readFileSync(join(LOOM_PACKAGE_ROOT, IMPLEMENTATION_BRIEF_TEMPLATE), "utf8");
const RULES: ReadonlyMap<RuleDocument, string> = new Map(RULE_DOCUMENTS.map((name) =>
  [name, readFileSync(join(LOOM_PACKAGE_ROOT, "rules", name), "utf8")] as const));

function briefInput(graph: TaskGraph, task: Task, overrides: Partial<ImplementationBriefInput> = {}): ImplementationBriefInput {
  const derivation = deriveTaskImplementationDispatch(task);
  if (derivation.kind !== "dispatch") throw new Error(`fixture Task must be owed a dispatch, got ${derivation.kind}`);
  return {
    template: TEMPLATE,
    task,
    dispatch: derivation.dispatch,
    planFile: "plan.md",
    spec: { kind: "unavailable", reason: { kind: "no-spec-file" } },
    rules: RULES,
    roster: graph.tasks,
    invariants: [],
    contracts: [],
    verificationManifest: graph.verification_manifest,
    ...overrides,
  };
}

function renderedPrompt(input: ImplementationBriefInput): string {
  const rendered = renderImplementationBrief(input);
  if (!rendered.ok) throw new Error(rendered.error.message);
  return rendered.value.prompt;
}

/** The brief's I6 section, or "" when the brief carries none. */
const i6Section = (prompt: string): string => prompt.split("**I6 red-then-green")[1] ?? "";

/** A retry-owed Task whose previous attempt settled with `events`. */
function retryAfter(graph: TaskGraph, events: readonly RawEvent[], newTestsWritten = true): Readonly<{ graph: TaskGraph; task: Task }> {
  const settled = settle(graph, "T1", harnessLedgers(events).claude, { newTestsWritten });
  if (settled.application.kind !== "applied") throw new Error("fixture settlement must apply");
  expect(settled.application.transition.kind).toBe("retry-required");
  const state = settled.application.state;
  const task: Task = { ...taskOf(state, "T1"), implementation_retry_protocol: 2, implementation_retry_history_start: 0 } as Task;
  return { graph: state, task };
}

describe("the implementation brief states I6 up front and names the repair on retry", () => {
  it("AS-005: an owing Task's brief lists its test and implementation files, the order, and that only reported ledger runs count", () => {
    const graph = i6Graph([LEDGER_TEST, LEDGER_FIXTURES, LEDGER_IMPL]);
    const task = taskOf(graph, "T1");
    const prompt = renderedPrompt(briefInput(graph, task));
    const section = i6Section(prompt);
    expect(section).not.toBe("");
    expect(section).toContain(`Test files:\n- ${LEDGER_TEST}`);
    expect(section).toContain(`Implementation files:\n- ${LEDGER_FIXTURES}\n- ${LEDGER_IMPL}`);
    expect(section).toMatch(/1\. \*\*Red\.\*\*[\s\S]*2\. \*\*First implementation write\.\*\*[\s\S]*3\. \*\*Green\.\*\*/);
    expect(section).toMatch(/exit code and a parsed structured report/);
    expect(section).not.toContain("I6 repair for this retry");
    expect(authorizeImplementationSpawn(task, prompt)).toMatchObject({ ok: true, kind: "initial" });
  });

  it("AS-018: the brief classifies the file_list by the frozen operator pattern, not the engine default", () => {
    const spec = "tests/ledger.spec.ts";
    const notATest = "tests/ledger.test.ts";
    const graph = populate([authoredTask("T1", ["src/ledger.ts", spec, notATest])], operatorPatternManifest([".spec.ts"]));
    const section = i6Section(renderedPrompt(briefInput(graph, taskOf(graph, "T1"))));
    expect(section).toContain(`Test files:\n- ${spec}`);
    expect(section).toContain(`Implementation files:\n- src/ledger.ts\n- ${notATest}`);
  });

  it("AS-012: a claimant's brief carries no I6 section", () => {
    const graph = populate([
      authoredTask("T1", [LEDGER_TEST, LEDGER_IMPL]),
      authoredTask("T2", [REPLAY_TEST, "engine/src/core/replay.ts"], "claimant"),
    ], defaultVerificationManifest());
    expect(renderedPrompt(briefInput(graph, taskOf(graph, "T2")))).not.toContain("I6 red-then-green");
  });

  it("AS-013: an owing Task with no test file is told so before it starts", () => {
    const graph = i6Graph([LEDGER_IMPL, LEDGER_TYPES]);
    const section = i6Section(renderedPrompt(briefInput(graph, taskOf(graph, "T1"))));
    expect(section).toContain("Test files:\nNone — your file list matches no test file");
    expect(section).toMatch(/no-test-files/);
  });

  it("refuses an owing Task's brief when the TaskGraph's frozen test-file classification is not supplied", () => {
    const graph = i6Graph();
    const rendered = renderImplementationBrief(briefInput(graph, taskOf(graph, "T1"), { verificationManifest: undefined }));
    expect(rendered).toMatchObject({ ok: false, error: { kind: "test-file-classification-unavailable" } });
  });

  it("refuses the brief of a proof-less Task an I6-era TaskGraph obligates, naming the missing frozen Proof", () => {
    const graph = i6Graph();
    const owing = taskOf(graph, "T1");
    const rendered = renderImplementationBrief({ ...briefInput(graph, owing), task: withoutProof(owing) });
    expect(rendered).toMatchObject({
      ok: false,
      error: { kind: "red-then-green-proof-unfrozen", message: expect.stringMatching(/T1 carries no frozen Proof/) },
    });
  });

  it("step 2 exempts the baseline git restore from the first implementation write, as the minting rule does", () => {
    const graph = i6Graph();
    const section = i6Section(renderedPrompt(briefInput(graph, taskOf(graph, "T1"))));
    const step2 = section.split("\n").find((line) => line.startsWith("2. **First implementation write.**")) ?? "";
    expect(step2).toMatch(/by a file tool or a shell command/);
    expect(step2).toMatch(/`git restore`[^.]*mints no FileWrite and is exempt/);
    // The exemption is the minting rule's, not a promise: a restore line mints no write.
    expect(extractShellWriteTargets(`git restore --source ${"d".repeat(40)} -- ${LEDGER_IMPL}`)).toEqual([]);
  });

  it("AS-006: a retry after an I6 failure tells the agent to restore its implementation files, observe red, then implement", () => {
    const { graph, task } = retryAfter(i6Graph([LEDGER_TEST, LEDGER_TYPES, LEDGER_IMPL]),
      [write(LEDGER_TEST), write(LEDGER_IMPL), red(), green()]);
    const prompt = renderedPrompt(briefInput(graph, task));
    expect(prompt).toContain("proof:red-then-green-unproven:red-after-first-implementation-write");
    expect(prompt).toContain(baselineRestoreCommand("d".repeat(40), [LEDGER_TYPES, LEDGER_IMPL]));
    expect(prompt).toMatch(/mints no FileWrite/);
    expect(prompt).toMatch(/observe red[\s\S]*then implement/i);
    expect(authorizeImplementationSpawn(task, prompt)).toMatchObject({ ok: true, kind: "retry" });
  });

  describe("the retry's restore command, run by real bash against a real repository", () => {
    const FILES = ["src/ledger.ts", "src/ledger types.ts"] as const;

    /** A repository whose baseline commit holds `src/ledger.ts`, after an
     *  attempt that changed it and created `src/ledger types.ts` (a space in
     *  its name). Returns the baseline commit. */
    function attemptedRepository(repository: string): string {
      const git = (...args: string[]): string => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
      git("init", "-q");
      git("config", "user.name", "Loom Test");
      git("config", "user.email", "loom@example.test");
      mkdirSync(join(repository, "src"));
      writeFileSync(join(repository, FILES[0]), "baseline\n");
      git("add", FILES[0]);
      git("commit", "-qm", "baseline");
      writeFileSync(join(repository, FILES[0]), "attempt\n");
      writeFileSync(join(repository, FILES[1]), "created\n");
      return git("rev-parse", "HEAD");
    }

    const bash = (command: string, cwd: string): number => {
      try {
        execFileSync("bash", ["-c", command], { cwd, stdio: "ignore" });
        return 0;
      } catch (error) {
        return (error as { status?: number }).status ?? -1;
      }
    };

    function inRepository(body: (repository: string) => void): void {
      const repository = canonicalTempDir("loom-i6-restore-");
      try {
        body(repository);
      } finally {
        rmSync(repository, { recursive: true, force: true });
      }
    }

    it("returns changed files to the baseline, deletes created ones, and mints no FileWrite", () => inRepository((repository) => {
      const command = baselineRestoreCommand(attemptedRepository(repository), FILES);
      expect(bash(command, repository)).toBe(0);
      expect(readFileSync(join(repository, FILES[0]), "utf8")).toBe("baseline\n");
      expect(() => readFileSync(join(repository, FILES[1]))).toThrow(/ENOENT/);
      expect(extractShellWriteTargets(command)).toEqual([]);
    }));

    it("restores the root-relative paths when the agent's cwd is a subdirectory", () => inRepository((repository) => {
      const command = baselineRestoreCommand(attemptedRepository(repository), FILES);
      expect(bash(command, join(repository, "src"))).toBe(0);
      expect(readFileSync(join(repository, FILES[0]), "utf8")).toBe("baseline\n");
      expect(() => readFileSync(join(repository, FILES[1]))).toThrow(/ENOENT/);
    }));

    it("fails and deletes nothing when the source is not a commit, so no file is misread as created", () => inRepository((repository) => {
      attemptedRepository(repository);
      for (const source of ["e".repeat(40), "HEAD~5"]) {
        expect(bash(baselineRestoreCommand(source, FILES), repository)).not.toBe(0);
        expect(readFileSync(join(repository, FILES[0]), "utf8")).toBe("attempt\n");
        expect(readFileSync(join(repository, FILES[1]), "utf8")).toBe("created\n");
      }
    }));

    it("fails and deletes nothing outside any repository", () => inRepository((directory) => {
      writeFileSync(join(directory, "ledger.ts"), "attempt\n");
      expect(bash(baselineRestoreCommand("HEAD", ["ledger.ts"]), directory)).not.toBe(0);
      expect(readFileSync(join(directory, "ledger.ts"), "utf8")).toBe("attempt\n");
    }));
  });

  it("FR-007a: the Red step of a Task that creates implementation files names them and says a failure to load them is red", () => {
    const graph = withArtifactBaseline(i6Graph([LEDGER_TEST, LEDGER_TYPES, LEDGER_IMPL]), [LEDGER_TEST, LEDGER_IMPL]);
    const section = i6Section(renderedPrompt(briefInput(graph, taskOf(graph, "T1"))));
    const red = section.split("\n").find((line) => line.startsWith("1. **Red.**")) ?? "";
    expect(red).toBe(
      "1. **Red.** A trusted test run in which at least one testcase in one of your test files fails. " +
        `Your Task creates \`${LEDGER_IMPL}\`: before you write it, your tests failing to load it (a collection or import error in one of your test files) IS red.`,
    );
  });

  it("FR-007: the Red step of a Task that creates no implementation file keeps the collection-error exclusion", () => {
    for (const graph of [i6Graph(), withArtifactBaseline(i6Graph(), [LEDGER_TEST])]) {
      const section = i6Section(renderedPrompt(briefInput(graph, taskOf(graph, "T1"))));
      expect(section).toContain("A collection or import error with no failing testcase is not red.");
      expect(section).not.toContain("Your Task creates");
    }
  });

  it("FR-007a: the retry remedy's red step names the created files the restore deleted", () => {
    const created = [LEDGER_TYPES, LEDGER_IMPL];
    const failed = retryAfter(withArtifactBaseline(i6Graph([LEDGER_TEST, LEDGER_TYPES, LEDGER_IMPL]), [LEDGER_TEST, ...created]),
      [write(LEDGER_TEST), write(LEDGER_IMPL), red(), green()]);
    const prompt = renderedPrompt(briefInput(failed.graph, failed.task));
    const remedy = prompt.split("**I6 repair for this retry.**")[1] ?? "";
    const step2 = remedy.split("\n").find((line) => line.startsWith("2. Run your tests and observe red")) ?? "";
    expect(step2).toBe(
      "2. Run your tests and observe red: at least one testcase in one of your test files fails. " +
        `Your Task creates \`${LEDGER_TYPES}\`, \`${LEDGER_IMPL}\`: before you write them, your tests failing to load them (a collection or import error in one of your test files) IS red.`,
    );
  });

  it("a retry of a Task with no recorded start commit restores from HEAD and says what that discards", () => {
    const { graph, task } = retryAfter(i6Graph([LEDGER_TEST, LEDGER_IMPL]),
      [write(LEDGER_TEST), write(LEDGER_IMPL), red(), green()]);
    const { start_sha: _start, ...unrecorded } = task;
    const prompt = renderedPrompt(briefInput(graph, unrecorded as Task));
    expect(prompt).toContain(baselineRestoreCommand("HEAD", [LEDGER_IMPL]));
    expect(prompt).toMatch(/No start commit was recorded for this Task, so `HEAD` stands in/);
    expect(prompt).not.toContain("<the Task's start commit>");
  });

  it("a retry whose previous attempt failed for another reason carries no I6 remedy", () => {
    const { graph, task } = retryAfter(i6Graph(), [write(LEDGER_TEST), red(), write(LEDGER_IMPL), green()], false);
    const prompt = renderedPrompt(briefInput(graph, task));
    expect(prompt).toContain("**I6 red-then-green");
    expect(prompt).not.toContain("I6 repair for this retry");
  });
});

// --- The SubagentStop handler path (update-task-status → settlement) ---

describe("update-task-status hands settlement the agent's own epoch ledger (claudeEpochLedger)", () => {
  const roots: string[] = [];
  const pointers: string[] = [];
  const initialProject = process.env.CLAUDE_PROJECT_DIR;
  const initialState = process.env.LOOM_STATE_PATH;
  const TEST_FILE = "src/artifact.test.ts";
  const IMPL_FILE = "src/artifact.ts";

  afterEach(() => {
    vi.restoreAllMocks();
    if (initialProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = initialProject;
    if (initialState === undefined) delete process.env.LOOM_STATE_PATH;
    else process.env.LOOM_STATE_PATH = initialState;
    for (const pointer of pointers.splice(0)) rmSync(pointer, { force: true });
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

  /** One owing Task registered against a real repository, its bytes then
   *  changed. `implementation` says whether the baseline commit already holds
   *  the implementation file or the Task creates it. */
  async function armedOwingTask(label: string, implementation: "existing" | "created" = "existing") {
    const repository = canonicalTempDir("loom-i6-handler-");
    roots.push(repository);
    git(repository, "init", "-q");
    git(repository, "config", "user.name", "Loom Test");
    git(repository, "config", "user.email", "loom@example.test");
    mkdirSync(join(repository, "src"));
    writeFileSync(join(repository, ".gitignore"), ".claude/\n");
    if (implementation === "existing") writeFileSync(join(repository, IMPL_FILE), "export const value = 1;\n");
    git(repository, "add", ".gitignore", ...(implementation === "existing" ? [IMPL_FILE] : []));
    git(repository, "commit", "-qm", "baseline");
    const statePath = join(repository, ".claude", "state", "active_task_graph.json");
    mkdirSync(join(repository, ".claude", "state"), { recursive: true });
    process.env.CLAUDE_PROJECT_DIR = repository;
    delete process.env.LOOM_STATE_PATH;

    const graph: TaskGraph = { ...populate([authoredTask("T1", [TEST_FILE, IMPL_FILE])], defaultVerificationManifest()), current_phase: "execute" };
    expect(taskOf(graph, "T1").proof?.obligations.map(({ kind }) => kind)).toContain("red-then-green");
    writeFileSync(statePath, JSON.stringify(graph));
    const registered = await registerTaskExecutionBatch([{
      kind: "implementation", prompt: "Task ID: T1", description: "implement T1",
    }], "parallel", { kind: "at-registration", anyActiveForGraph: false }, repository);
    if (registered.kind !== "registered") throw new Error(registered.message);
    const authority = registered.authorities[0]!;

    const sessionId = `claude-i6-${label}-${process.pid}-${Date.now()}`;
    mkdirSync(SUBAGENT_DIR, { recursive: true });
    const pointer = join(SUBAGENT_DIR, `${sessionId}.task_graph`);
    writeFileSync(pointer, statePath);
    pointers.push(pointer);

    writeFileSync(join(repository, TEST_FILE), "it('works', () => {});\n");
    writeFileSync(join(repository, IMPL_FILE), "export const value = 2;\n");
    const transcript = join(repository, ".claude", "transcript.jsonl");
    writeFileSync(transcript, [TEST_FILE, IMPL_FILE].map((file_path, index) => JSON.stringify({
      type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `tool-${index}`, name: "Write", input: { file_path } }] },
    })).join("\n") + "\n");
    const observation: ImplementationAuthorityObservation = {
      kind: "authority-observed",
      sidecar: {
        schemaVersion: 1, kind: "claude-implementation-attempt-sidecar",
        sessionId: sessionId as never, agentId: "agent-7" as never,
        canonicalTaskGraphPath: statePath, authority,
      },
    };
    const stop = (snapshot: EvidenceSnapshot) => {
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      return runUpdateTaskStatus(JSON.stringify({
        session_id: sessionId, agent_id: "agent-7", agent_type: "code-implementer-agent", agent_transcript_path: transcript,
      }), [], snapshot, observation);
    };
    const persistedTask = (): Task => taskOf(JSON.parse(readFileSync(statePath, "utf8")) as TaskGraph, "T1");
    return { stop, persistedTask };
  }

  const reportedRun = (results: readonly TestFileResult[]): RawEvent => run(results, { command: "npx vitest run" });

  it("judges I6 from the agent's own snapshot epoch, crediting no foreign epoch's facts", async () => {
    const { stop, persistedTask } = await armedOwingTask("own-epoch");
    const events = [write(TEST_FILE), reportedRun([failing(TEST_FILE)]), write(IMPL_FILE), reportedRun([passing(TEST_FILE)])];
    await stop({ kind: "snapshot", events: records(events, CLAUDE_EPOCH, [write(IMPL_FILE)]) });
    expect(i6ResultOfTask(persistedTask())).toMatchObject({
      state: "satisfied",
      evidence: { kind: "red-then-green", red: { index: 1 }, implementationWrite: IMPL_FILE, green: { index: 3 } },
    });
  }, 30_000);

  it("AS-042: a test that cannot load the module the Task creates is red, judged against the registered artifact baseline", async () => {
    const { stop, persistedTask } = await armedOwingTask("created-module", "created");
    expect(persistedTask().artifact_baseline).toContainEqual({ artifact: IMPL_FILE, snapshot: { kind: "missing" } });
    const collectionRed: RawEvent = {
      kind: "TestRun",
      command: "npx vitest run",
      exit: 1,
      report: { total: 0, failed: 0, source: "vitest-json", files: { kind: "recorded", results: [{ file: TEST_FILE, executed: 0, failed: 0, skipped: 0, collectionError: true }] } },
    };
    await stop({ kind: "snapshot", events: records([write(TEST_FILE), collectionRed, write(IMPL_FILE), reportedRun([passing(TEST_FILE)])], CLAUDE_EPOCH) });
    expect(i6ResultOfTask(persistedTask())).toMatchObject({
      state: "satisfied",
      evidence: { kind: "red-then-green", red: { index: 1 }, implementationWrite: IMPL_FILE, green: { index: 3 } },
    });
  }, 30_000);

  it("AS-009: the same collection error is not red when the implementation file existed at the baseline", async () => {
    const { stop, persistedTask } = await armedOwingTask("existing-module");
    expect(persistedTask().artifact_baseline).toContainEqual({ artifact: IMPL_FILE, snapshot: expect.objectContaining({ kind: "sha256" }) });
    const collectionRed: RawEvent = {
      kind: "TestRun",
      command: "npx vitest run",
      exit: 1,
      report: { total: 0, failed: 0, source: "vitest-json", files: { kind: "recorded", results: [{ file: TEST_FILE, executed: 0, failed: 0, skipped: 0, collectionError: true }] } },
    };
    await stop({ kind: "snapshot", events: records([write(TEST_FILE), collectionRed, write(IMPL_FILE), reportedRun([passing(TEST_FILE)])], CLAUDE_EPOCH) });
    expect(i6ResultOfTask(persistedTask())).toMatchObject({
      state: "failed",
      failure: { kind: "red-then-green-unproven", gap: { kind: "red-missing", untrustedOnly: false } },
    });
  }, 30_000);

  it("settles as infrastructure-blocked when the dispatcher's snapshot of that epoch failed", async () => {
    const { stop, persistedTask } = await armedOwingTask("snapshot-failed");
    await stop({ kind: "snapshot-failed" });
    const task = persistedTask();
    expect(task.implementation_attempt_history?.at(-1)).toMatchObject({ transition: "infrastructure-blocked" });
    expectInfrastructureBlocked(task);
  }, 30_000);
});
