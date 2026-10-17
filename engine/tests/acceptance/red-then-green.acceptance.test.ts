/**
 * CT-1 acceptance: I6, the red-then-green proof obligation.
 *
 * Every TaskGraph here is populated by the production `populateTaskGraph`
 * from authored Tasks and a manifest frozen by the production freezer, so the
 * obligations under test are the ones population derives:
 *   - `defaultVerificationManifest()` is the no-manifest-file freeze a
 *     TaskGraph populated after this feature carries;
 *   - an operator schema-2 manifest declaring `testFileSuffixes` is frozen
 *     inside the testcase that needs it;
 *   - `PRE_FEATURE_DEFAULT_MANIFEST` is the exact engine-default freeze every
 *     TaskGraph populated before this feature carries.
 *
 * Settlement is driven through `settleExactImplementation`, the one shell both
 * harnesses settle through. The epoch ledger reaches it as a `LedgerObservation`
 * of events read back through the production ledger line parser, carried in
 * the production transport facts.
 * The byte and new-test ports report every declared file changed and new tests
 * written, so the only obligation a fixture can leave unmet is I6.
 */

import { describe, expect, it } from "vitest";
import {
  buildTaskLocalByteObservation,
  parseNewTestEvidence,
} from "../../src/core/implementation-application";
import {
  createImplementationAttemptAuthority,
  type ImplementationAttemptAuthority,
} from "../../src/core/implementation-completion";
import {
  PI_STRUCTURED_EVIDENCE_POLICY,
  TRUSTED_LEDGER_ONLY_POLICY,
  type ProofEvaluationPolicy,
} from "../../src/core/proof-obligations";
import type {
  LedgerObservation,
  RedThenGreenFailureKind,
  RedThenGreenGap,
  RunRef,
  TestFileResult,
} from "../../src/core/red-then-green-types";
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
  type ExactImplementationTransportFacts,
} from "../../src/handlers/helpers/exact-implementation-settlement";
import { parseEvidenceLine } from "../../src/machine/evidence";
import type { Task, TaskGraph, TaskTestResult } from "../../src/types";

// --- Repository, files and runs ---

const ROOT = "/fixture";
const EPOCH = "agent-7:code-implementer-agent";

const LEDGER_TEST = "engine/tests/core/ledger.test.ts";
const REPLAY_TEST = "engine/tests/core/replay.test.ts";
const LEDGER_IMPL = "engine/src/core/ledger.ts";
const LEDGER_TYPES = "engine/src/core/ledger-types.ts";
const LEDGER_FIXTURES = "engine/tests/fixtures/ledger-fixtures.ts";

/** How the engine's Vitest run (cwd `engine`) names the Task's test files. */
const REPORTED_LEDGER_TEST = "tests/core/ledger.test.ts";
const REPORTED_REPLAY_TEST = "tests/core/replay.test.ts";
const UNRELATED_TEST = "tests/core/audit.test.ts";

const RED_RUN = "npm --prefix engine run test:unit -- tests/core/ledger.test.ts";
const GREEN_RUN = "npm --prefix engine run test:unit";

/** Today's exact engine-default freeze: what every TaskGraph populated before
 *  this feature carries, and what its suite receipts were stamped against. */
const PRE_FEATURE_DEFAULT_MANIFEST = {
  schemaVersion: 1,
  kind: "frozen-verification-manifest",
  source: { kind: "engine-default" },
  manifestDigest: "f151b9015dd8afd2c9ff94add17a86f6b5a9b0408931b31af70e9d4629823d6c",
  projectChecks: [],
} as const;

// --- Ledger facts, as the recorder writes them ---

type RawEvent = Readonly<Record<string, unknown>>;

const passing = (file: string, executed = 2): TestFileResult =>
  ({ file, executed, failed: 0, skipped: 0, collectionError: false });
const failing = (file: string, failed = 1, executed = 2): TestFileResult =>
  ({ file, executed, failed, skipped: 0, collectionError: false });
const collectionError = (file: string): TestFileResult =>
  ({ file, executed: 1, failed: 1, skipped: 0, collectionError: true });

const write = (path: string, via: "tool" | "shell" = "tool"): RawEvent => ({ kind: "FileWrite", path, via });
const read = (path: string): RawEvent => ({ kind: "FileRead", path });

/** A TestRun with a parsed JUnit report recording `results`, reconciled with its counts. */
function run(
  results: readonly TestFileResult[],
  options: Readonly<{ command?: string; exit?: number | null }> = {},
): RawEvent {
  const total = results.reduce((sum, { executed }) => sum + executed, 0);
  const failed = results.reduce((sum, file) => sum + file.failed, 0);
  return {
    kind: "TestRun",
    command: options.command ?? (failed > 0 ? RED_RUN : GREEN_RUN),
    exit: options.exit === undefined ? (failed > 0 ? 1 : 0) : options.exit,
    report: { total, failed, source: "junit-xml", files: { kind: "recorded", results } },
  };
}

/** A TestRun recorded before per-file results existed. */
const legacyRun = (total: number, failed: number): RawEvent => ({
  kind: "TestRun",
  command: failed > 0 ? RED_RUN : GREEN_RUN,
  exit: failed > 0 ? 1 : 0,
  report: { total, failed, source: "junit-xml" },
});

/** A TestRun whose command printed no structured report. */
const reportlessRun = (exit: number): RawEvent =>
  ({ kind: "TestRun", command: GREEN_RUN, exit, report: null });

const red = (file = REPORTED_LEDGER_TEST): RawEvent => run([failing(file)]);
const green = (...files: readonly string[]): RawEvent =>
  run((files.length === 0 ? [REPORTED_LEDGER_TEST] : files).map((file) => passing(file)));

/** The epoch ledger exactly as the production line parser reads it back. */
function ledger(events: readonly RawEvent[]): LedgerObservation {
  return {
    kind: "read",
    events: events.map((event, index) => {
      const parsed = parseEvidenceLine(JSON.stringify({ epoch: EPOCH, event, callId: `toolu_${index}` }));
      if (!parsed.ok) throw new Error(`fixture ledger line ${index} is unreadable: ${parsed.error}`);
      return parsed.value.event;
    }),
  };
}

// --- Population ---

type NewTests = "required" | "claimant" | "existing-tests-sufficient";

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
        : { kind: "waived", reason: newTests === "claimant" ? "covered-by-acceptance-contract" : newTests },
    },
    file_list: fileList,
  };
}

/** A TaskGraph the production population command derived from `tasks` and `manifest`. */
function populate(tasks: readonly AuthoredTask[], manifest: FrozenVerificationManifest): TaskGraph {
  const roster = parseAuthoredTaskRoster(tasks);
  if (!roster.ok) throw new Error(`fixture roster refused: ${roster.error}`);
  const populated = populateTaskGraph(
    {
      current_phase: "decompose",
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: "plan.md",
      tasks: [],
      wave_gates: {},
    },
    {
      planTitle: "Ledger plan",
      validatedPlanFile: "plan.md",
      tasks: roster.value,
      verificationManifest: manifest,
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

/** Freeze an operator schema-2 manifest declaring a test-file pattern. */
function operatorPatternManifest(suffixes: readonly string[]): FrozenVerificationManifest {
  const source = { schemaVersion: 2, kind: "loom-verification-manifest", checks: [], testFileSuffixes: suffixes };
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify(source)));
  expect(frozen.ok, frozen.ok ? "" : frozen.error.errors.join("; ")).toBe(true);
  if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
  return frozen.value;
}

function preFeatureManifest(): FrozenVerificationManifest {
  const parsed = parseFrozenVerificationManifest(PRE_FEATURE_DEFAULT_MANIFEST);
  if (!parsed.ok) throw new Error(`pre-feature manifest refused: ${parsed.error.errors.join("; ")}`);
  return parsed.value;
}

const taskOf = (graph: TaskGraph, taskId: string): Task => {
  const task = graph.tasks.find(({ id }) => id === taskId);
  if (task === undefined) throw new Error(`no ${taskId} in the fixture graph`);
  return task;
};

const obligationKinds = (graph: TaskGraph, taskId: string): readonly string[] =>
  (taskOf(graph, taskId).proof?.obligations ?? []).map(({ kind }) => kind);

// --- Settlement ---

function authority(task: Task): ImplementationAttemptAuthority {
  const parsed = createImplementationAttemptAuthority({
    taskId: task.id,
    wave: task.wave,
    semanticAttempt: 1,
    reservationId: `ct1-${task.id}`,
    headSha: "a".repeat(40),
    reservedAt: "2026-10-16T00:00:00.000Z",
    taskScopeBaseline: [],
    dirtySetBaseline: [],
  });
  if (!parsed.ok) throw new Error(parsed.error.errors.join("; "));
  return parsed.value;
}

/** The populated graph with `taskId`'s implementation attempt reserved. */
function reserved(graph: TaskGraph, taskId: string): Readonly<{ graph: TaskGraph; attempt: ImplementationAttemptAuthority }> {
  const attempt = authority(taskOf(graph, taskId));
  return {
    attempt,
    graph: {
      ...graph,
      executing_tasks: [taskId],
      tasks: graph.tasks.map((task): Task => task.id === taskId
        ? { ...task, active_implementation_attempt: attempt, reserved_at: attempt.reservedAt }
        : task),
    },
  };
}

const snapshots = (paths: readonly string[], changed: boolean) =>
  [...paths].sort().map((artifact) => ({
    artifact,
    snapshot: changed ? { kind: "sha256" as const, digest: "b".repeat(64) } : { kind: "missing" as const },
  }));

/** Every declared file changed in this attempt, and new tests were written. */
function ports(attempt: ImplementationAttemptAuthority, fileList: readonly string[]): ExactImplementationSettlementPorts {
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
    newTests: { collect: () => ({ ok: true, value: parseNewTestEvidence(true, `new tests in ${fileList.join(", ")}`) }) },
  };
}

type SettleOptions = Readonly<{
  transport?: "Claude" | "Pi";
  policy?: ProofEvaluationPolicy;
  testResult?: TaskTestResult;
}>;

/** Settle `taskId`'s reserved attempt from the epoch `ledger`. */
function settle(
  graph: TaskGraph,
  taskId: string,
  epoch: LedgerObservation,
  options: SettleOptions = {},
): ExactImplementationSettlement {
  const { graph: state, attempt } = reserved(graph, taskId);
  const transport = options.transport ?? "Claude";
  const facts: ExactImplementationTransportFacts = {
    transport,
    authority: attempt,
    observedAt: "2026-10-16T00:05:00.000Z" as never,
    parserModifiedPaths: [],
    parserPathLabel: `${transport} fixture paths`,
    taskCompleted: true,
    testResult: options.testResult ?? { verdict: "trusted-pass" },
    testEvidence: `${transport} test evidence`,
    proofEvaluationPolicy: options.policy ?? TRUSTED_LEDGER_ONLY_POLICY,
    ledger: epoch,
  };
  return settleExactImplementation(state, facts, ports(attempt, taskOf(state, taskId).file_list ?? []));
}

const failureKind = (gap: RedThenGreenGap): RedThenGreenFailureKind => `proof:red-then-green-unproven:${gap.kind}`;

/** The settlement refused I6 with exactly `gap`, as a semantic failure the Task retries. */
function expectGap(settled: ExactImplementationSettlement, gap: RedThenGreenGap): void {
  expect(settled).not.toHaveProperty("infrastructureReason");
  expect(settled.application).toMatchObject({
    kind: "applied",
    transition: {
      kind: "retry-required",
      failures: expect.arrayContaining([
        expect.objectContaining({
          kind: "proof-obligation-failure",
          failure: { kind: "red-then-green-unproven", gap },
        }),
      ]),
      receipt: { failureKinds: expect.arrayContaining([failureKind(gap)]) },
    },
  });
}

/** The settlement implemented the Task with I6 shown by exactly these facts. */
function expectShown(
  settled: ExactImplementationSettlement,
  taskId: string,
  shown: Readonly<{ red: RunRef; implementationWrite: string; green: RunRef }>,
): void {
  expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "implemented" } });
  if (settled.application.kind !== "applied") return;
  expect(taskOf(settled.application.state, taskId).proof).toMatchObject({
    state: "satisfied",
    evidence: expect.arrayContaining([{ kind: "red-then-green", ...shown }]),
  });
}

/** The I6 gap a settlement names, or undefined when it names none. */
function gapOf(settled: ExactImplementationSettlement): unknown {
  if (settled.application.kind !== "applied") return undefined;
  const transition = settled.application.transition;
  if (!("failures" in transition)) return undefined;
  for (const failure of transition.failures) {
    if (failure.kind !== "proof-obligation-failure") continue;
    const proofFailure: Readonly<{ kind: string }> = failure.failure;
    if (proofFailure.kind === "red-then-green-unproven" && "gap" in proofFailure) return proofFailure.gap;
  }
  return undefined;
}

const NON_CLAIMANT_FILES = [LEDGER_TEST, LEDGER_IMPL] as const;

/** An I6-era graph with one non-claimant Task T1 over `fileList`. */
const i6Graph = (fileList: readonly string[] = NON_CLAIMANT_FILES): TaskGraph =>
  populate([authoredTask("T1", fileList)], defaultVerificationManifest());

const at = (index: number, command: string): RunRef => ({ index, command });

describe("I6 obligation (CT-1)", () => {
  it("FR-005: only non-claimant Tasks requiring new tests owe I6 after this feature, and an earlier TaskGraph is never newly obligated", () => {
    const tasks = [
      authoredTask("T1", [LEDGER_TEST, LEDGER_IMPL]),
      authoredTask("T2", ["engine/tests/core/replay.test.ts", "engine/src/core/replay.ts"], "claimant"),
      authoredTask("T3", ["engine/tests/core/audit.test.ts", "engine/src/core/audit.ts"], "existing-tests-sufficient"),
    ];

    const current = populate(tasks, defaultVerificationManifest());
    expect(obligationKinds(current, "T1")).toContain("red-then-green");
    expect(obligationKinds(current, "T2")).not.toContain("red-then-green");
    expect(obligationKinds(current, "T3")).not.toContain("red-then-green");

    const earlier = populate(tasks, preFeatureManifest());
    for (const id of ["T1", "T2", "T3"]) expect(obligationKinds(earlier, id)).not.toContain("red-then-green");
    const { verification_manifest: _frozen, ...unfrozen } = earlier;
    const noRed = ledger([write(LEDGER_TEST), write(LEDGER_IMPL), green()]);
    for (const graph of [earlier, unfrozen]) {
      expect(settle(graph, "T1", noRed).application)
        .toMatchObject({ kind: "applied", transition: { kind: "implemented" } });
    }
  });

  it("AS-005: a behavioral red on the Task's test file, then its first implementation write, then a green run satisfy I6", () => {
    const settled = settle(i6Graph(), "T1", ledger([
      write(LEDGER_TEST),
      red(),
      write(LEDGER_IMPL),
      green(),
    ]));

    expectShown(settled, "T1", { red: at(1, RED_RUN), implementationWrite: LEDGER_IMPL, green: at(3, GREEN_RUN) });
  });

  it("AS-005: absolute report identities beneath the repository attribute to the Task's test files", () => {
    const settled = settle(i6Graph([LEDGER_TEST, REPLAY_TEST, LEDGER_IMPL]), "T1", ledger([
      write(LEDGER_TEST),
      write(REPLAY_TEST),
      run([failing(`${ROOT}/${LEDGER_TEST}`), passing(`${ROOT}/${REPLAY_TEST}`)]),
      read(LEDGER_IMPL),
      write(LEDGER_IMPL),
      run([passing(`${ROOT}/${LEDGER_TEST}`), passing(`${ROOT}/${REPLAY_TEST}`)]),
    ]));

    expectShown(settled, "T1", { red: at(2, RED_RUN), implementationWrite: LEDGER_IMPL, green: at(5, GREEN_RUN) });
  });

  it("AS-006: an implementation write before any qualifying red fails proof naming red as out of order, and the Task retries", () => {
    const settled = settle(i6Graph(), "T1", ledger([
      write(LEDGER_TEST),
      write(LEDGER_IMPL),
      red(),
      green(),
    ]));

    expectGap(settled, { kind: "red-after-first-implementation-write" });
  });

  it("AS-007: a red run and an implementation write with no later passing run fail proof naming green as missing", () => {
    const settled = settle(i6Graph(), "T1", ledger([
      write(LEDGER_TEST),
      red(),
      write(LEDGER_IMPL),
      red(),
    ]));

    expectGap(settled, { kind: "green-missing", untrustedOnly: false });
  });

  it("AS-008: red and green runs with no implementation write fail proof naming the implementation write as missing", () => {
    const settled = settle(i6Graph(), "T1", ledger([
      write(LEDGER_TEST),
      red(),
      write(LEDGER_TEST),
      green(),
    ]));

    expectGap(settled, { kind: "implementation-write-missing" });
  });

  it("AS-009: a run whose only failure in the Task's test files is a collection error is not red", () => {
    const settled = settle(i6Graph(), "T1", ledger([
      write(LEDGER_TEST),
      run([collectionError(REPORTED_LEDGER_TEST)]),
      write(LEDGER_IMPL),
      green(),
    ]));

    expectGap(settled, { kind: "red-missing", untrustedOnly: false });
  });

  it("AS-010: a fixture write before the red run is the first implementation write, so red is out of order", () => {
    const settled = settle(i6Graph([LEDGER_TEST, LEDGER_FIXTURES, LEDGER_IMPL]), "T1", ledger([
      write(LEDGER_TEST),
      write(LEDGER_FIXTURES),
      red(),
      write(LEDGER_IMPL),
      green(),
    ]));

    expectGap(settled, { kind: "red-after-first-implementation-write" });
  });

  for (const policy of [TRUSTED_LEDGER_ONLY_POLICY, PI_STRUCTURED_EVIDENCE_POLICY]) {
    const label = policy.untrustedPass;

    it(`AS-011: a red step met only by a run without an exit code does not count (${label} policy)`, () => {
      const settled = settle(i6Graph(), "T1", ledger([
        write(LEDGER_TEST),
        run([failing(REPORTED_LEDGER_TEST)], { exit: null }),
        write(LEDGER_IMPL),
        green(),
      ]), { policy });

      expectGap(settled, { kind: "red-missing", untrustedOnly: true });
    });

    it(`AS-011: a green step met only by a run without a structured report does not count (${label} policy)`, () => {
      const settled = settle(i6Graph(), "T1", ledger([
        write(LEDGER_TEST),
        red(),
        write(LEDGER_IMPL),
        reportlessRun(0),
      ]), { policy });

      expectGap(settled, { kind: "green-missing", untrustedOnly: true });
    });

    it(`AS-011: Pi-structured transcript evidence with no ledger TestRun satisfies no step (${label} policy)`, () => {
      const settled = settle(i6Graph(), "T1", ledger([write(LEDGER_TEST), write(LEDGER_IMPL)]), {
        transport: "Pi",
        policy,
        testResult: { verdict: "untrusted", passed: true, label: "pi-structured", provenance: "pi-structured" },
      });

      expectGap(settled, { kind: "red-missing", untrustedOnly: true });
    });
  }

  it("AS-012: a claimant Task owes no observed red and settles from an implementation write and a green run", () => {
    const graph = populate([
      authoredTask("T1", [LEDGER_TEST, LEDGER_IMPL]),
      authoredTask("T2", [REPLAY_TEST, "engine/src/core/replay.ts"], "claimant"),
    ], defaultVerificationManifest());
    expect(obligationKinds(graph, "T1")).toContain("red-then-green");
    expect(obligationKinds(graph, "T2")).not.toContain("red-then-green");

    const settled = settle(graph, "T2", ledger([
      write("engine/src/core/replay.ts"),
      green(REPORTED_REPLAY_TEST),
    ]));

    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "implemented" } });
    expect(gapOf(settled)).toBeUndefined();
  });

  it("AS-013: a Task owing I6 whose file_list matches no test file fails proof saying it declares no test files", () => {
    const settled = settle(i6Graph([LEDGER_IMPL, LEDGER_TYPES]), "T1", ledger([
      run([failing(REPORTED_LEDGER_TEST)]),
      write(LEDGER_IMPL),
      green(),
    ]));

    expectGap(settled, { kind: "no-test-files" });
  });

  it("AS-014: the same ledger facts settled twice give the identical judgment", () => {
    const graph = i6Graph();
    const facts = ledger([write(LEDGER_TEST), red(), write(LEDGER_IMPL), red()]);

    const first = settle(graph, "T1", facts);
    const second = settle(graph, "T1", facts);

    expectGap(first, { kind: "green-missing", untrustedOnly: false });
    expect(second).toEqual(first);
  });

  it("AS-018: under a declared test-file pattern a file is a test file exactly when it matches, so a JVM Task proves I6", () => {
    const main = "src/main/java/com/example/ledger/Ledger.java";
    const test = "src/test/java/com/example/ledger/LedgerTest.java";
    const fixtures = "src/test/java/com/example/ledger/LedgerFixtures.java";
    const graph = populate([authoredTask("T1", [main, test, fixtures])], operatorPatternManifest(["Test.java"]));

    const settled = settle(graph, "T1", ledger([
      write(test),
      run([failing("com.example.ledger.LedgerTest")], { command: "mvn test" }),
      write(main),
      run([passing("com.example.ledger.LedgerTest")], { command: "mvn test" }),
    ]));

    expectShown(settled, "T1", { red: at(1, "mvn test"), implementationWrite: main, green: at(3, "mvn test") });
  });

  it("AS-018: a file_list entry the declared pattern does not match is an implementation file even if the default list would match it", () => {
    const spec = "tests/ledger.spec.ts";
    const notATest = "tests/ledger.test.ts";
    const graph = populate([authoredTask("T1", ["src/ledger.ts", spec, notATest])], operatorPatternManifest([".spec.ts"]));

    const settled = settle(graph, "T1", ledger([
      write(spec),
      run([failing(spec)]),
      write(notATest),
      run([passing(spec)]),
    ]));

    expectShown(settled, "T1", { red: at(1, RED_RUN), implementationWrite: notATest, green: at(3, GREEN_RUN) });
  });
});

describe("I6 ordering and trust rules (CT-1)", () => {
  it("FR-006: a passing run that leaves one of the Task's test files unreported is not the green step", () => {
    const settled = settle(i6Graph([LEDGER_TEST, REPLAY_TEST, LEDGER_IMPL]), "T1", ledger([
      write(LEDGER_TEST),
      write(REPLAY_TEST),
      run([failing(REPORTED_LEDGER_TEST), failing(REPORTED_REPLAY_TEST)]),
      write(LEDGER_IMPL),
      green(REPORTED_LEDGER_TEST),
    ]));

    expectGap(settled, { kind: "green-missing", untrustedOnly: false });
  });

  it("FR-006: a passing run before the first implementation write is not the green step", () => {
    const settled = settle(i6Graph(), "T1", ledger([
      write(LEDGER_TEST),
      red(),
      green(),
      write(LEDGER_IMPL),
    ]));

    expectGap(settled, { kind: "green-missing", untrustedOnly: false });
  });

  it("FR-006: a failing testcase outside the Task's test files is not a red for the Task", () => {
    const settled = settle(i6Graph(), "T1", ledger([
      write(LEDGER_TEST),
      run([passing(REPORTED_LEDGER_TEST), failing(UNRELATED_TEST)]),
      write(LEDGER_IMPL),
      run([passing(REPORTED_LEDGER_TEST), passing(UNRELATED_TEST)]),
    ]));

    expectGap(settled, { kind: "red-missing", untrustedOnly: false });
  });

  it("FR-006: a shell write to an implementation file counts as the first implementation write", () => {
    const settled = settle(i6Graph(), "T1", ledger([
      write(LEDGER_TEST),
      red(),
      write(LEDGER_IMPL, "shell"),
      green(),
    ]));

    expectShown(settled, "T1", { red: at(1, RED_RUN), implementationWrite: LEDGER_IMPL, green: at(3, GREEN_RUN) });
  });

  it("FR-007: a run with a collection error in one test file and a failing testcase in another counts as red", () => {
    const settled = settle(i6Graph([LEDGER_TEST, REPLAY_TEST, LEDGER_IMPL]), "T1", ledger([
      write(LEDGER_TEST),
      write(REPLAY_TEST),
      run([collectionError(REPORTED_REPLAY_TEST), failing(REPORTED_LEDGER_TEST)]),
      write(LEDGER_IMPL),
      green(REPORTED_LEDGER_TEST, REPORTED_REPLAY_TEST),
    ]));

    expectShown(settled, "T1", { red: at(2, RED_RUN), implementationWrite: LEDGER_IMPL, green: at(4, GREEN_RUN) });
  });

  it("FR-008: on both harness transports and under both evaluation policies, only runs with an exit code and a parsed report count", () => {
    for (const transport of ["Claude", "Pi"] as const) {
      for (const policy of [TRUSTED_LEDGER_ONLY_POLICY, PI_STRUCTURED_EVIDENCE_POLICY]) {
        const trusted = settle(i6Graph(), "T1", ledger([write(LEDGER_TEST), red(), write(LEDGER_IMPL), green()]), { transport, policy });
        expectShown(trusted, "T1", { red: at(1, RED_RUN), implementationWrite: LEDGER_IMPL, green: at(3, GREEN_RUN) });

        const untrusted = settle(i6Graph(), "T1", ledger([
          write(LEDGER_TEST),
          run([failing(REPORTED_LEDGER_TEST)], { exit: null }),
          write(LEDGER_IMPL),
          reportlessRun(0),
        ]), { transport, policy });
        expectGap(untrusted, { kind: "red-missing", untrustedOnly: true });
      }
    }
  });

  it("FR-008: a legacy TestRun fact without per-file results is not a qualifying run, so it satisfies neither the red nor the green step", () => {
    const legacyRed = settle(i6Graph(), "T1", ledger([
      write(LEDGER_TEST),
      legacyRun(2, 1),
      write(LEDGER_IMPL),
      green(),
    ]));
    expectGap(legacyRed, { kind: "red-missing", untrustedOnly: true });

    const legacyGreen = settle(i6Graph(), "T1", ledger([
      write(LEDGER_TEST),
      red(),
      write(LEDGER_IMPL),
      legacyRun(2, 0),
    ]));
    expectGap(legacyGreen, { kind: "green-missing", untrustedOnly: true });
  });

  it("FR-009: every unmet step is a distinct named proof failure", () => {
    const fixtures: readonly Readonly<{ files: readonly string[]; events: readonly RawEvent[]; gap: RedThenGreenGap }>[] = [
      { files: [LEDGER_IMPL], events: [write(LEDGER_IMPL), green()], gap: { kind: "no-test-files" } },
      { files: NON_CLAIMANT_FILES, events: [red(), green()], gap: { kind: "implementation-write-missing" } },
      { files: NON_CLAIMANT_FILES, events: [write(LEDGER_IMPL), green()], gap: { kind: "red-missing", untrustedOnly: false } },
      {
        files: NON_CLAIMANT_FILES,
        events: [run([failing(REPORTED_LEDGER_TEST)], { exit: null }), write(LEDGER_IMPL), green()],
        gap: { kind: "red-missing", untrustedOnly: true },
      },
      { files: NON_CLAIMANT_FILES, events: [write(LEDGER_IMPL), red(), green()], gap: { kind: "red-after-first-implementation-write" } },
      { files: NON_CLAIMANT_FILES, events: [red(), write(LEDGER_IMPL)], gap: { kind: "green-missing", untrustedOnly: false } },
      {
        files: NON_CLAIMANT_FILES,
        events: [red(), write(LEDGER_IMPL), reportlessRun(0)],
        gap: { kind: "green-missing", untrustedOnly: true },
      },
    ];

    const named = fixtures.map(({ files, events }) => gapOf(settle(i6Graph(files), "T1", ledger(events))));

    expect(named).toEqual(fixtures.map(({ gap }) => gap));
    expect(new Set(named.map((gap) => JSON.stringify(gap))).size).toBe(fixtures.length);
  });

  it("FR-010: a claimant Task is credited red, so a ledger with no red run never fails it on I6", () => {
    const graph = populate([
      authoredTask("T1", [LEDGER_TEST, LEDGER_IMPL]),
      authoredTask("T2", [REPLAY_TEST, "engine/src/core/replay.ts"], "claimant"),
    ], defaultVerificationManifest());
    const noRed = ledger([write("engine/src/core/replay.ts"), write(REPLAY_TEST), green(REPORTED_REPLAY_TEST)]);

    expectGap(settle(graph, "T1", ledger([write(LEDGER_IMPL), write(LEDGER_TEST), green()])), {
      kind: "red-missing",
      untrustedOnly: false,
    });
    const claimant = settle(graph, "T2", noRed);
    expect(gapOf(claimant)).toBeUndefined();
    expect(claimant.application).toMatchObject({ kind: "applied", transition: { kind: "implemented" } });
  });

  it("FR-012: the judgment is computed from the ledger facts each settlement is given, not from an earlier judgment", () => {
    const graph = i6Graph();
    const unproven = settle(graph, "T1", ledger([write(LEDGER_TEST), red(), write(LEDGER_IMPL)]));
    const shown = settle(graph, "T1", ledger([write(LEDGER_TEST), red(), write(LEDGER_IMPL), green()]));

    expectGap(unproven, { kind: "green-missing", untrustedOnly: false });
    expectShown(shown, "T1", { red: at(1, RED_RUN), implementationWrite: LEDGER_IMPL, green: at(3, GREEN_RUN) });
    expect(settle(graph, "T1", ledger([write(LEDGER_TEST), red(), write(LEDGER_IMPL)]))).toEqual(unproven);
  });

  it("FR-013: a type file from the file_list is an implementation file, and test-file writes are not implementation writes", () => {
    const settled = settle(i6Graph([LEDGER_TEST, LEDGER_TYPES, LEDGER_IMPL]), "T1", ledger([
      write(LEDGER_TEST),
      red(),
      write(LEDGER_TEST),
      write(LEDGER_TYPES),
      write(LEDGER_IMPL),
      green(),
    ]));

    expectShown(settled, "T1", { red: at(1, RED_RUN), implementationWrite: LEDGER_TYPES, green: at(5, GREEN_RUN) });
  });

  it("FR-014: without a declared pattern the engine default suffixes classify the file_list frozen at population", () => {
    const spec = "engine/tests/core/ledger.spec.ts";
    const graph = populate([authoredTask("T1", [spec, LEDGER_IMPL, LEDGER_FIXTURES])], defaultVerificationManifest());

    const settled = settle(graph, "T1", ledger([
      write(spec),
      run([failing("tests/core/ledger.spec.ts")]),
      write(LEDGER_FIXTURES),
      run([passing("tests/core/ledger.spec.ts")]),
    ]));

    expectShown(settled, "T1", { red: at(1, RED_RUN), implementationWrite: LEDGER_FIXTURES, green: at(3, GREEN_RUN) });
  });
});
