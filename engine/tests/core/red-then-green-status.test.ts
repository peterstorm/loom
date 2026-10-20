/**
 * Fixture-matrix tests for the Red-Then-Green Status core:
 * `redThenGreenStatusView` projects one Task of a TaskGraph, plus what the
 * shell observed of its live attempt, into the I6 status view, and
 * `renderRedThenGreenStatus` prints that view in the line grammar.
 *
 * Every derived fact is compared against the engine function settlement
 * itself asks (`redThenGreenDuty`, `classifyTaskFiles`, `judgeRedThenGreen`,
 * `redThenGreenFailureKind`) on the same inputs, so the tests pin reuse
 * (FR-005) rather than a second derivation. Spelling is asserted only through
 * the exported text constants.
 */

import { describe, expect, it } from "vitest";
import { redThenGreenDuty } from "../../src/core/implementation-application";
import {
  derivePendingTaskProof,
  evaluateTaskProof,
  type FailedTaskProof,
  type RedThenGreenEra,
} from "../../src/core/proof-obligations";
import { judgeRedThenGreen, redThenGreenFailureKind } from "../../src/core/red-then-green";
import type { LedgerObservation, RedThenGreenGap, TestFileResult } from "../../src/core/red-then-green-types";
import {
  GREEN_STEP,
  IMPLEMENTATION_FILES_HEADING,
  IMPLEMENTATION_WRITE_STEP,
  LIVE_NONE,
  LIVE_NOT_JUDGED,
  LIVE_NOT_OBSERVABLE,
  LIVE_PREFIX,
  LIVE_UNINSPECTABLE,
  LIVE_UNREADABLE,
  NO_IMPLEMENTATION_FILES,
  NO_TEST_FILES,
  NOT_OWED_REASON_TEXT,
  RED_STEP,
  RTG_NOT_OWED,
  RTG_OWES,
  RTG_UNDETERMINABLE,
  SHOWN,
  STORED_NO_OBLIGATION,
  STORED_NO_PROOF,
  STORED_PENDING,
  STORED_PREFIX,
  TEST_FILES_HEADING,
  UNTRUSTED_ONLY_SUFFIX,
  redThenGreenStatusView,
  renderRedThenGreenStatus,
  type RedThenGreenLiveInput,
  type RedThenGreenStatusInput,
} from "../../src/core/red-then-green-status";
import { parseReportSummary } from "../../src/core/structured-test-report";
import { UNKNOWN_TASK_PREFIX } from "../../src/core/stop-check-plan-types";
import { classifyTaskFiles } from "../../src/core/test-file-classification";
import {
  defaultVerificationManifest,
  legacyDefaultVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import { COVERED_BY_ACCEPTANCE_CONTRACT, type NewTestWaiverReason } from "../../src/core/verification-policy";
import type { Evidence } from "../../src/machine/types";
import type { Task, TaskGraph } from "../../src/types";
import { graphFixture, satisfiedProof, taskFixture } from "../fixtures/task-lifecycle";

// --- Fixture vocabulary ---

const ROOT = "/repo";
const IMPL = "engine/src/core/ledger.ts";
const TEST_A = "engine/tests/core/ledger.test.ts";
const FIXTURE = "engine/tests/fixtures/ledger-fixtures.ts";
const TEST_B = "engine/tests/core/replay.test.ts";
/** Test and implementation files interleaved, so `file_list` order is observable. */
const FILES: readonly string[] = [IMPL, TEST_A, FIXTURE, TEST_B];
const IMPL_ONLY: readonly string[] = [IMPL, FIXTURE];

const I6_MANIFEST: FrozenVerificationManifest = defaultVerificationManifest();
const OWED_ERA: RedThenGreenEra = "owed-if-new-tests";

const graphOf = (tasks: readonly Task[], manifest?: FrozenVerificationManifest): TaskGraph => ({
  ...graphFixture(tasks),
  ...(manifest === undefined ? {} : { verification_manifest: manifest }),
});

const base = (id: string, wave: number, files: readonly string[]) => ({
  id,
  description: id,
  agent: "code-implementer-agent",
  wave,
  depends_on: [],
  file_list: [...files],
  spec_anchors: [],
  spec_contributions: [],
});

/** A Task requiring new tests whose frozen Proof was derived under `era`. */
const requiredTask = (id: string, era: RedThenGreenEra, files: readonly string[] = FILES, wave = 1): Task =>
  taskFixture({
    ...base(id, wave, files),
    new_tests_required: true,
    proof: derivePendingTaskProof({ newTestsRequired: true, declaredArtifacts: files, redThenGreen: era }),
  });

/** A Task whose new tests are waived with `reason`, its Proof derived in the I6 era. */
const waivedTask = (id: string, reason: NewTestWaiverReason): Task => {
  const verificationPolicy = Object.freeze({
    regression: Object.freeze({ kind: "required" as const }),
    newTests: Object.freeze({ kind: "waived" as const, reason }),
  });
  return taskFixture({
    ...base(id, 1, FILES),
    verification_policy: { regression: verificationPolicy.regression, new_tests: verificationPolicy.newTests },
    proof: derivePendingTaskProof({ verificationPolicy, declaredArtifacts: FILES, redThenGreen: OWED_ERA }),
  });
};

/** A legacy `implemented` Task: no frozen Proof at all. */
const legacyTask = (id: string): Task => taskFixture({ ...base(id, 2, FILES), new_tests_required: true, status: "implemented" });

/** A failed I6 evaluation, as settlement stores it, minting `gap` (or `ledger-unavailable`). */
const failedProof = (gap: RedThenGreenGap | "no-ledger"): FailedTaskProof => {
  const evaluated = evaluateTaskProof(
    { newTestsRequired: true, declaredArtifacts: FILES, redThenGreen: OWED_ERA },
    {
      taskCompleted: true,
      testResult: { verdict: "trusted-pass" },
      filesModified: FILES,
      newTestsWritten: true,
      ...(gap === "no-ledger" ? {} : { redThenGreen: { kind: "unproven" as const, gap } }),
    },
  );
  if (evaluated.state !== "failed") throw new Error("failed proof fixture must fail");
  return evaluated;
};

// --- Ledger events ---

const passing = (file: string): TestFileResult => ({ file, executed: 2, failed: 0, skipped: 0, collectionError: false });
const failing = (file: string): TestFileResult => ({ file, executed: 2, failed: 1, skipped: 0, collectionError: false });
/** A file that failed to load (a missing module's import error): JUnit's one failing synthetic testcase. */
const collectionError = (file: string): TestFileResult => ({ file, executed: 1, failed: 1, skipped: 0, collectionError: true });

function report(results: readonly TestFileResult[]) {
  const total = results.reduce((sum, { executed }) => sum + executed, 0);
  const failed = results.reduce((sum, file) => sum + file.failed, 0);
  const parsed = parseReportSummary(total, failed, "junit-xml", { kind: "recorded", results });
  if (parsed === null) throw new Error("fixture report must reconcile");
  return parsed;
}

const RED_COMMAND = "bun test --reporter=junit --reporter-outfile=/tmp/red.xml";
const GREEN_COMMAND = "bun test --reporter=junit --reporter-outfile=/tmp/green.xml";

const SHOWN_EVENTS: readonly Evidence[] = [
  { kind: "FileRead", path: IMPL },
  { kind: "TestRun", command: RED_COMMAND, exit: 1, report: report([failing(TEST_A), passing(TEST_B)]) },
  { kind: "FileWrite", path: IMPL, via: "tool" },
  { kind: "TestRun", command: GREEN_COMMAND, exit: 0, report: report([passing(TEST_A), passing(TEST_B)]) },
];
/** Only an untrusted (exit-less) red: red is unmet by qualifying runs alone. */
const UNTRUSTED_RED_EVENTS: readonly Evidence[] = [
  { kind: "TestRun", command: RED_COMMAND, exit: null, report: report([failing(TEST_A)]) },
  { kind: "FileWrite", path: IMPL, via: "tool" },
];
/** An implementation write and no run at all. */
const NO_RED_EVENTS: readonly Evidence[] = [{ kind: "FileWrite", path: IMPL, via: "tool" }];

const read = (events: readonly Evidence[]): LedgerObservation => ({ kind: "read", events });
const live = (ledger: LedgerObservation): RedThenGreenLiveInput => ({ kind: "live", ledger, repositoryRoot: ROOT });
const NO_LIVE: RedThenGreenLiveInput = { kind: "no-live-attempt" };

const input = (graph: TaskGraph, taskId: string, liveInput: RedThenGreenLiveInput = NO_LIVE): RedThenGreenStatusInput =>
  ({ graph, taskId, live: liveInput });

const taskOf = (graph: TaskGraph, id: string): Task => {
  const found = graph.tasks.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`fixture lacks ${id}`);
  return found;
};

const OWED_GRAPH = graphOf([requiredTask("T1", OWED_ERA)], I6_MANIFEST);

/** The classification settlement itself would judge T1 by. */
const settlementClassification = (graph: TaskGraph, id: string) => {
  const target = taskOf(graph, id);
  const duty = redThenGreenDuty(target, graph.verification_manifest);
  if (duty.kind !== "owed") throw new Error(`fixture ${id} owes no I6`);
  return classifyTaskFiles(target.file_list ?? [], duty.testFiles, target.artifact_baseline);
};

/** T1 owing I6 and creating IMPL: its frozen artifact baseline records IMPL missing. */
const CREATING_GRAPH = graphOf(
  [{ ...requiredTask("T1", OWED_ERA), artifact_baseline: [{ artifact: IMPL, snapshot: { kind: "missing" } }] }],
  I6_MANIFEST,
);

// --- The view ---

describe("redThenGreenStatusView: unknown Task", () => {
  it("is unknown-task for an id absent from the TaskGraph", () => {
    expect(redThenGreenStatusView(input(OWED_GRAPH, "T9"))).toEqual({ kind: "unknown-task", taskId: "T9" });
  });
});

describe("redThenGreenStatusView: duty", () => {
  it("is owed with settlement's classification, in file_list order, when the I6-era Proof owes red-then-green", () => {
    const view = redThenGreenStatusView(input(OWED_GRAPH, "T1"));
    expect(view).toMatchObject({
      kind: "task",
      taskId: "T1",
      wave: 1,
      status: "pending",
      duty: { kind: "owed", classification: { testFiles: [TEST_A, TEST_B], implementationFiles: [IMPL, FIXTURE] } },
    });
    expect(view).toMatchObject({ duty: { classification: settlementClassification(OWED_GRAPH, "T1") } });
  });

  it("classifies the implementation files a Task creates from its frozen artifact baseline, as settlement does", () => {
    expect(redThenGreenStatusView(input(CREATING_GRAPH, "T1"))).toMatchObject({
      duty: { kind: "owed", classification: { createdImplementationFiles: [IMPL] } },
    });
    expect(redThenGreenStatusView(input(CREATING_GRAPH, "T1"))).toMatchObject({
      duty: { classification: settlementClassification(CREATING_GRAPH, "T1") },
    });
    expect(redThenGreenStatusView(input(OWED_GRAPH, "T1"))).toMatchObject({
      duty: { kind: "owed", classification: { createdImplementationFiles: [] } },
    });
  });

  it("is owed with an empty test-file list when the file_list holds no test file", () => {
    const graph = graphOf([requiredTask("T1", OWED_ERA, IMPL_ONLY)], I6_MANIFEST);
    expect(redThenGreenStatusView(input(graph, "T1"))).toMatchObject({
      duty: { kind: "owed", classification: { testFiles: [], implementationFiles: [IMPL, FIXTURE] } },
    });
  });

  it("is not owed because the TaskGraph predates I6, with no manifest or one frozen without a classification", () => {
    for (const manifest of [undefined, legacyDefaultVerificationManifest()]) {
      const graph = graphOf([requiredTask("T1", "not-owed")], manifest);
      expect(redThenGreenDuty(taskOf(graph, "T1"), graph.verification_manifest)).toEqual({ kind: "not-owed" });
      expect(redThenGreenStatusView(input(graph, "T1"))).toMatchObject({
        duty: { kind: "not-owed", reason: { kind: "predates-i6" } },
      });
    }
  });

  it("is not owed because the Task is an Acceptance Contract claimant", () => {
    const graph = graphOf([waivedTask("T1", COVERED_BY_ACCEPTANCE_CONTRACT)], I6_MANIFEST);
    expect(redThenGreenStatusView(input(graph, "T1"))).toMatchObject({
      duty: { kind: "not-owed", reason: { kind: "claimant" } },
    });
  });

  it("is not owed because new tests are waived, carrying the waiver reason", () => {
    for (const reason of ["documentation-only", "existing-tests-sufficient", "generated-artifact"] as const) {
      const graph = graphOf([waivedTask("T1", reason)], I6_MANIFEST);
      expect(redThenGreenStatusView(input(graph, "T1"))).toMatchObject({
        duty: { kind: "not-owed", reason: { kind: "new-tests-waived", reason } },
      });
    }
  });

  it("is not owed for no-obligation-in-proof when an I6-era Task requiring new tests froze no red-then-green", () => {
    const graph = graphOf([requiredTask("T1", "not-owed")], I6_MANIFEST);
    expect(redThenGreenStatusView(input(graph, "T1"))).toMatchObject({
      duty: { kind: "not-owed", reason: { kind: "no-obligation-in-proof" } },
    });
  });

  it("reports predates-i6 first, even for a waived Task in a pre-I6 TaskGraph", () => {
    const graph = graphOf([waivedTask("T1", "documentation-only")]);
    expect(redThenGreenStatusView(input(graph, "T1"))).toMatchObject({
      duty: { kind: "not-owed", reason: { kind: "predates-i6" } },
    });
  });

  it("is undeterminable with redThenGreenDuty's reason for classification-unfrozen", () => {
    const graph = graphOf([requiredTask("T1", OWED_ERA)]);
    const duty = redThenGreenDuty(taskOf(graph, "T1"), graph.verification_manifest);
    if (duty.kind !== "classification-unfrozen") throw new Error("fixture must be classification-unfrozen");
    expect(redThenGreenStatusView(input(graph, "T1"))).toMatchObject({
      duty: { kind: "undeterminable", reason: duty.reason },
    });
  });

  it("is undeterminable with redThenGreenDuty's reason for proof-unfrozen", () => {
    const graph = graphOf([legacyTask("T1")], I6_MANIFEST);
    const duty = redThenGreenDuty(taskOf(graph, "T1"), graph.verification_manifest);
    if (duty.kind !== "proof-unfrozen") throw new Error("fixture must be proof-unfrozen");
    expect(redThenGreenStatusView(input(graph, "T1"))).toMatchObject({
      status: "implemented",
      wave: 2,
      duty: { kind: "undeterminable", reason: duty.reason },
    });
  });
});

describe("redThenGreenStatusView: live attempt", () => {
  it("passes not-observable, no-live-attempt and uninspectable through unchanged", () => {
    const passthrough: readonly RedThenGreenLiveInput[] = [
      { kind: "not-observable" },
      { kind: "no-live-attempt" },
      { kind: "uninspectable", reason: "two live sidecars for T1" },
    ];
    for (const liveInput of passthrough) {
      expect(redThenGreenStatusView(input(OWED_GRAPH, "T1", liveInput))).toMatchObject({ live: liveInput });
    }
  });

  it("is unreadable with the ledger's reason when the epoch could not be read", () => {
    const view = redThenGreenStatusView(input(OWED_GRAPH, "T1", live({ kind: "unreadable", reason: "ledger torn" })));
    expect(view).toMatchObject({ live: { kind: "unreadable", reason: "ledger torn" } });
  });

  it("is judged exactly as judgeRedThenGreen judges the epoch (shown)", () => {
    const expected = judgeRedThenGreen(SHOWN_EVENTS, settlementClassification(OWED_GRAPH, "T1"), ROOT, false);
    expect(expected).toEqual({
      kind: "shown",
      red: { index: 1, command: RED_COMMAND },
      implementationWrite: IMPL,
      green: { index: 3, command: GREEN_COMMAND },
    });
    expect(redThenGreenStatusView(input(OWED_GRAPH, "T1", live(read(SHOWN_EVENTS))))).toMatchObject({
      live: { kind: "judged", observation: expected },
    });
  });

  it("is judged exactly as judgeRedThenGreen judges the epoch (gaps, trusted and untrusted)", () => {
    for (const events of [UNTRUSTED_RED_EVENTS, NO_RED_EVENTS, []]) {
      const expected = judgeRedThenGreen(events, settlementClassification(OWED_GRAPH, "T1"), ROOT, false);
      expect(expected.kind).toBe("unproven");
      expect(redThenGreenStatusView(input(OWED_GRAPH, "T1", live(read(events))))).toMatchObject({
        live: { kind: "judged", observation: expected },
      });
    }
  });

  it("is judged with a collection error as red only for a Task that creates its module (FR-007a parity)", () => {
    const events: readonly Evidence[] = [
      { kind: "TestRun", command: RED_COMMAND, exit: 1, report: report([collectionError(TEST_A), passing(TEST_B)]) },
      { kind: "FileWrite", path: IMPL, via: "tool" },
      { kind: "TestRun", command: GREEN_COMMAND, exit: 0, report: report([passing(TEST_A), passing(TEST_B)]) },
    ];
    const creating = judgeRedThenGreen(events, settlementClassification(CREATING_GRAPH, "T1"), ROOT, false);
    const editing = judgeRedThenGreen(events, settlementClassification(OWED_GRAPH, "T1"), ROOT, false);
    expect(creating.kind).toBe("shown");
    expect(editing).toMatchObject({ kind: "unproven", gap: { kind: "red-missing" } });
    expect(redThenGreenStatusView(input(CREATING_GRAPH, "T1", live(read(events))))).toMatchObject({
      live: { kind: "judged", observation: creating },
    });
    expect(redThenGreenStatusView(input(OWED_GRAPH, "T1", live(read(events))))).toMatchObject({
      live: { kind: "judged", observation: editing },
    });
  });

  it("is judged as no-test-files when the owed Task declares no test file", () => {
    const graph = graphOf([requiredTask("T1", OWED_ERA, IMPL_ONLY)], I6_MANIFEST);
    expect(redThenGreenStatusView(input(graph, "T1", live(read(SHOWN_EVENTS))))).toMatchObject({
      live: { kind: "judged", observation: { kind: "unproven", gap: { kind: "no-test-files" } } },
    });
  });

  it("is not judged when the duty is not owed or undeterminable", () => {
    const graphs = [
      graphOf([waivedTask("T1", "documentation-only")], I6_MANIFEST),
      graphOf([requiredTask("T1", OWED_ERA)]),
    ];
    for (const graph of graphs) {
      expect(redThenGreenStatusView(input(graph, "T1", live(read(SHOWN_EVENTS))))).toMatchObject({
        live: { kind: "not-judged" },
      });
    }
  });
});

describe("redThenGreenStatusView: stored result", () => {
  it("is no-proof for a legacy Task without a frozen Proof", () => {
    const graph = graphOf([legacyTask("T1")], I6_MANIFEST);
    expect(redThenGreenStatusView(input(graph, "T1"))).toMatchObject({ stored: { kind: "no-proof" } });
  });

  it("is no-obligation when the frozen Proof owes no red-then-green", () => {
    const graph = graphOf([waivedTask("T1", COVERED_BY_ACCEPTANCE_CONTRACT)], I6_MANIFEST);
    expect(redThenGreenStatusView(input(graph, "T1"))).toMatchObject({ stored: { kind: "no-obligation" } });
  });

  it("is pending while the red-then-green result awaits evaluation", () => {
    expect(redThenGreenStatusView(input(OWED_GRAPH, "T1"))).toMatchObject({ stored: { kind: "pending" } });
  });

  it("is satisfied with the stored red-then-green evidence for an implemented Task", () => {
    const proof = satisfiedProof(FILES, OWED_ERA);
    const graph = graphOf([taskFixture({ ...base("T1", 1, FILES), status: "implemented", proof })], I6_MANIFEST);
    expect(redThenGreenStatusView(input(graph, "T1"))).toMatchObject({
      status: "implemented",
      stored: {
        kind: "satisfied",
        red: { index: 0, command: "npx vitest run" },
        implementationWrite: IMPL,
        green: { index: 1, command: "npx vitest run" },
      },
    });
  });

  it("is failed with redThenGreenFailureKind for a failed Task and a retry-pending Task", () => {
    const gap: RedThenGreenGap = { kind: "red-after-first-implementation-write" };
    const failedGraph = graphOf([taskFixture({ ...base("T1", 1, FILES), status: "failed", proof: failedProof(gap) })], I6_MANIFEST);
    const retryGraph = graphOf([taskFixture({ ...base("T1", 1, FILES), status: "pending", proof: failedProof(gap) })], I6_MANIFEST);
    for (const graph of [failedGraph, retryGraph]) {
      expect(redThenGreenStatusView(input(graph, "T1"))).toMatchObject({
        stored: { kind: "failed", failureKind: redThenGreenFailureKind(gap) },
      });
    }
    expect(redThenGreenStatusView(input(retryGraph, "T1"))).toMatchObject({ status: "pending" });
  });

  it("is failed as ledger-unavailable when no ledger observation reached proof", () => {
    const graph = graphOf([taskFixture({ ...base("T1", 1, FILES), status: "failed", proof: failedProof("no-ledger") })], I6_MANIFEST);
    expect(redThenGreenStatusView(input(graph, "T1"))).toMatchObject({
      stored: { kind: "failed", failureKind: redThenGreenFailureKind({ kind: "ledger-unavailable" }) },
    });
  });

  it("is failed as proof:<kind> when the red-then-green result fails another way", () => {
    const proof = failedProof({ kind: "red-missing", untrustedOnly: false });
    const results = proof.results.map((result) =>
      result.obligation.kind === "red-then-green" && result.state === "failed"
        ? { ...result, failure: { kind: "task-not-completed" as const } }
        : result);
    const [head, ...tail] = results;
    if (head === undefined) throw new Error("fixture proof has results");
    const graph = graphOf(
      [taskFixture({ ...base("T1", 1, FILES), status: "failed", proof: { ...proof, results: [head, ...tail] } })],
      I6_MANIFEST,
    );
    expect(redThenGreenStatusView(input(graph, "T1"))).toMatchObject({
      stored: { kind: "failed", failureKind: "proof:task-not-completed" },
    });
  });
});

// --- The rendering ---

const linesOf = (statusInput: RedThenGreenStatusInput): readonly string[] => {
  const rendering = renderRedThenGreenStatus(statusInput);
  if (rendering.kind !== "rendered") throw new Error(`expected rendered lines, got ${rendering.kind}`);
  return rendering.lines;
};

describe("renderRedThenGreenStatus", () => {
  it("refuses an unknown Task with the shared unknown-task message", () => {
    expect(renderRedThenGreenStatus(input(OWED_GRAPH, "T9"))).toEqual({
      kind: "unknown-task",
      taskId: "T9",
      message: `${UNKNOWN_TASK_PREFIX} T9 in the TaskGraph`,
    });
  });

  it("prints an owed Task's header, files in file_list order, the live judgment and the stored result", () => {
    expect(linesOf(input(OWED_GRAPH, "T1", live(read(SHOWN_EVENTS))))).toEqual([
      `T1 (Wave 1, pending): ${RTG_OWES}`,
      TEST_FILES_HEADING,
      `  ${TEST_A}`,
      `  ${TEST_B}`,
      IMPLEMENTATION_FILES_HEADING,
      `  ${IMPL}`,
      `  ${FIXTURE}`,
      `${LIVE_PREFIX} ${SHOWN}`,
      `  ${RED_STEP} #1 ${RED_COMMAND}`,
      `  ${IMPLEMENTATION_WRITE_STEP} ${IMPL}`,
      `  ${GREEN_STEP} #3 ${GREEN_COMMAND}`,
      `${STORED_PREFIX} ${STORED_PENDING}`,
    ]);
  });

  it("prints the no-test-files line for an owed Task whose file_list holds no test file", () => {
    const graph = graphOf([requiredTask("T1", OWED_ERA, IMPL_ONLY)], I6_MANIFEST);
    expect(linesOf(input(graph, "T1")).slice(1, 5)).toEqual([NO_TEST_FILES, IMPLEMENTATION_FILES_HEADING, `  ${IMPL}`, `  ${FIXTURE}`]);
  });

  it("prints the no-implementation-files line for an owed Task whose file_list holds only test files", () => {
    const tests = [TEST_A];
    const graph = graphOf([requiredTask("T1", OWED_ERA, tests)], I6_MANIFEST);
    expect(linesOf(input(graph, "T1")).slice(1, 4)).toEqual([TEST_FILES_HEADING, `  ${TEST_A}`, NO_IMPLEMENTATION_FILES]);
  });

  it("prints each not-owed reason in the header, and no files section", () => {
    const cases: readonly (readonly [TaskGraph, string])[] = [
      [graphOf([requiredTask("T1", "not-owed")]), NOT_OWED_REASON_TEXT["predates-i6"]],
      [graphOf([waivedTask("T1", COVERED_BY_ACCEPTANCE_CONTRACT)], I6_MANIFEST), NOT_OWED_REASON_TEXT.claimant],
      [graphOf([waivedTask("T1", "documentation-only")], I6_MANIFEST), `${NOT_OWED_REASON_TEXT["new-tests-waived"]}: documentation-only`],
      [graphOf([requiredTask("T1", "not-owed")], I6_MANIFEST), NOT_OWED_REASON_TEXT["no-obligation-in-proof"]],
    ];
    for (const [graph, reasonText] of cases) {
      const lines = linesOf(input(graph, "T1"));
      expect(lines[0]).toBe(`T1 (Wave 1, pending): ${RTG_NOT_OWED} — ${reasonText}`);
      expect(lines).not.toContain(TEST_FILES_HEADING);
      expect(lines).not.toContain(NO_TEST_FILES);
      expect(lines).not.toContain(IMPLEMENTATION_FILES_HEADING);
    }
  });

  it("prints an undeterminable duty with its reason, and no files section", () => {
    const graph = graphOf([legacyTask("T1")], I6_MANIFEST);
    const duty = redThenGreenDuty(taskOf(graph, "T1"), graph.verification_manifest);
    if (duty.kind !== "proof-unfrozen") throw new Error("fixture must be proof-unfrozen");
    expect(linesOf(input(graph, "T1"))).toEqual([
      `T1 (Wave 2, implemented): ${RTG_UNDETERMINABLE} — ${duty.reason}`,
      LIVE_NONE,
      `${STORED_PREFIX} ${STORED_NO_PROOF}`,
    ]);
  });

  it("prints every live arm", () => {
    const waived = graphOf([waivedTask("T1", "documentation-only")], I6_MANIFEST);
    const cases: readonly (readonly [TaskGraph, RedThenGreenLiveInput, readonly string[]])[] = [
      [OWED_GRAPH, { kind: "no-live-attempt" }, [LIVE_NONE]],
      [OWED_GRAPH, { kind: "not-observable" }, [LIVE_NOT_OBSERVABLE]],
      [OWED_GRAPH, { kind: "uninspectable", reason: "two live sidecars" }, [`${LIVE_PREFIX} ${LIVE_UNINSPECTABLE} — two live sidecars`]],
      [OWED_GRAPH, live({ kind: "unreadable", reason: "ledger torn" }), [`${LIVE_PREFIX} ${LIVE_UNREADABLE} — ledger torn`]],
      [waived, live(read(SHOWN_EVENTS)), [`${LIVE_PREFIX} ${LIVE_NOT_JUDGED}`]],
      [OWED_GRAPH, live(read(NO_RED_EVENTS)), [`${LIVE_PREFIX} ${redThenGreenFailureKind({ kind: "red-missing", untrustedOnly: false })}`]],
      [
        OWED_GRAPH,
        live(read(UNTRUSTED_RED_EVENTS)),
        [`${LIVE_PREFIX} ${redThenGreenFailureKind({ kind: "red-missing", untrustedOnly: true })}${UNTRUSTED_ONLY_SUFFIX}`],
      ],
    ];
    for (const [graph, liveInput, expected] of cases) {
      const lines = linesOf(input(graph, "T1", liveInput));
      // The live section sits after the header and any files section, just before the one stored line.
      expect(lines.slice(lines.length - 1 - expected.length, -1)).toEqual(expected);
      expect(lines.at(-1)?.startsWith(STORED_PREFIX)).toBe(true);
    }
  });

  it("prints every stored arm", () => {
    const gap: RedThenGreenGap = { kind: "green-missing", untrustedOnly: false };
    const cases: readonly (readonly [Task, readonly string[]])[] = [
      [legacyTask("T1"), [`${STORED_PREFIX} ${STORED_NO_PROOF}`]],
      [waivedTask("T1", COVERED_BY_ACCEPTANCE_CONTRACT), [`${STORED_PREFIX} ${STORED_NO_OBLIGATION}`]],
      [requiredTask("T1", OWED_ERA), [`${STORED_PREFIX} ${STORED_PENDING}`]],
      [
        taskFixture({ ...base("T1", 1, FILES), status: "implemented", proof: satisfiedProof(FILES, OWED_ERA) }),
        [
          `${STORED_PREFIX} ${SHOWN}`,
          `  ${RED_STEP} #0 npx vitest run`,
          `  ${IMPLEMENTATION_WRITE_STEP} ${IMPL}`,
          `  ${GREEN_STEP} #1 npx vitest run`,
        ],
      ],
      [
        taskFixture({ ...base("T1", 1, FILES), status: "pending", proof: failedProof(gap) }),
        [`${STORED_PREFIX} ${redThenGreenFailureKind(gap)}`],
      ],
    ];
    for (const [target, expected] of cases) {
      const lines = linesOf(input(graphOf([target], I6_MANIFEST), "T1"));
      const storedStart = lines.findIndex((line) => line.startsWith(STORED_PREFIX));
      expect(lines.slice(storedStart)).toEqual(expected);
    }
  });
});
