/**
 * I6 judge (`judgeRedThenGreen`): permutation and property tests (SC-001).
 *
 * Every epoch is generated as a sequence of abstract steps (a behavioral red,
 * an implementation write, a green run, a collection-only red, untrusted
 * runs, legacy facts, ...). Each step is rendered into the ledger fact the
 * recorder writes, the judge sees the rendered facts, and an independent
 * reference model over the abstract steps states the expected observation.
 * The judge must agree with the model on every sequence: no false pass, and
 * the expected gap each time.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { judgeRedThenGreen } from "../../src/core/red-then-green";
import type {
  JudgeRedThenGreenFn,
  RedThenGreenObservation,
  TestFileClassification,
  TestFileResult,
} from "../../src/core/red-then-green-types";
import { parseReportSummary } from "../../src/core/structured-test-report";
import type { Evidence } from "../../src/machine/types";

// The judge satisfies the frozen CT-1 signature.
const judge: JudgeRedThenGreenFn = judgeRedThenGreen;

const ROOT = "/repo";
const TEST_A = "engine/tests/core/ledger.test.ts";
const TEST_B = "engine/tests/core/replay.test.ts";
const IMPL = "engine/src/core/ledger.ts";
const FIXTURE = "engine/tests/fixtures/ledger-fixtures.ts";
const OUTSIDE = "engine/src/core/unrelated.ts";

/** How a Vitest run with cwd `engine` names the Task's test files. */
const REPORTED_A = "tests/core/ledger.test.ts";
const REPORTED_B = "tests/core/replay.test.ts";
const REPORTED_UNRELATED = "tests/core/audit.test.ts";

const CLASSIFIED: TestFileClassification = Object.freeze({
  testFiles: Object.freeze([TEST_A, TEST_B]),
  implementationFiles: Object.freeze([IMPL, FIXTURE]),
});
const NO_TEST_FILES: TestFileClassification = Object.freeze({
  testFiles: Object.freeze([]),
  implementationFiles: Object.freeze([IMPL, FIXTURE]),
});

// --- Fact rendering ---

const passing = (file: string, executed = 2): TestFileResult => ({ file, executed, failed: 0, skipped: 0, collectionError: false });
const failing = (file: string): TestFileResult => ({ file, executed: 2, failed: 1, skipped: 0, collectionError: false });
const collectionError = (file: string): TestFileResult => ({ file, executed: 1, failed: 1, skipped: 0, collectionError: true });
/** A file that declares testcases but runs none: every one skipped. */
const allSkipped = (file: string): TestFileResult => ({ file, executed: 2, failed: 0, skipped: 2, collectionError: false });

function summary(results: readonly TestFileResult[] | "unrecorded") {
  const listed = results === "unrecorded" ? [passing(REPORTED_A)] : results;
  const total = listed.reduce((sum, { executed }) => sum + executed, 0);
  const failed = listed.reduce((sum, file) => sum + file.failed, 0);
  const parsed = parseReportSummary(total, failed, "junit-xml", results === "unrecorded" ? undefined : { kind: "recorded", results });
  if (parsed === null) throw new Error("fixture report must reconcile");
  return parsed;
}

const testRun = (
  command: string,
  exit: number | null,
  results: readonly TestFileResult[] | "unrecorded" | null,
): Evidence => ({ kind: "TestRun", command, exit, report: results === null ? null : summary(results) });

/** The abstract steps an epoch is built from. */
const STEPS = [
  "red",              // qualifying: a Task test file has a failing testcase
  "collection-red",   // qualifying: the Task test file only fails to collect
  "unrelated-red",    // qualifying: only a file outside the Task fails
  "green",            // qualifying: exit 0, every Task test file passes
  "partial-green",    // qualifying: exit 0, one Task test file unreported
  "empty-green",      // qualifying: exit 0, a Task test file executed nothing
  "skipped-green",    // qualifying: exit 0, a Task test file's testcases were all skipped
  "failing-exit-green", // qualifying report, every file passes, exit 1
  "untrusted-red",    // non-qualifying: no exit code
  "untrusted-green",  // non-qualifying: no exit code
  "reportless",       // non-qualifying: no structured report
  "legacy-red",       // non-qualifying: no per-file results
  "legacy-green",     // non-qualifying: no per-file results
  "write-test",       // FileWrite to a Task test file
  "write-impl",       // FileWrite (tool) to a Task implementation file
  "shell-write-impl", // FileWrite (shell) to a Task implementation file
  "absolute-write-impl", // FileWrite to an implementation file, absolute under the root
  "write-fixture",    // FileWrite to a fixture from the file_list (an implementation file)
  "write-outside",    // FileWrite to a file outside the file_list
  "foreign-absolute-write", // FileWrite to an absolute path outside the repository
  "read-impl",        // FileRead of an implementation file
] as const;
type Step = (typeof STEPS)[number];

function render(step: Step, index: number): Evidence {
  const command = `npm test #${index}`;
  switch (step) {
    case "red": return testRun(command, 1, [failing(REPORTED_A), passing(REPORTED_B)]);
    case "collection-red": return testRun(command, 1, [collectionError(REPORTED_A), passing(REPORTED_B)]);
    case "unrelated-red": return testRun(command, 1, [passing(REPORTED_A), passing(REPORTED_B), failing(REPORTED_UNRELATED)]);
    case "green": return testRun(command, 0, [passing(REPORTED_A), passing(REPORTED_B)]);
    case "partial-green": return testRun(command, 0, [passing(REPORTED_A)]);
    case "empty-green": return testRun(command, 0, [passing(REPORTED_A, 0), passing(REPORTED_B)]);
    case "skipped-green": return testRun(command, 0, [allSkipped(REPORTED_A), passing(REPORTED_B)]);
    case "failing-exit-green": return testRun(command, 1, [passing(REPORTED_A), passing(REPORTED_B)]);
    case "untrusted-red": return testRun(command, null, [failing(REPORTED_A), passing(REPORTED_B)]);
    case "untrusted-green": return testRun(command, null, [passing(REPORTED_A), passing(REPORTED_B)]);
    case "reportless": return testRun(command, 0, null);
    case "legacy-red": return testRun(command, 1, "unrecorded");
    case "legacy-green": return testRun(command, 0, "unrecorded");
    case "write-test": return { kind: "FileWrite", path: TEST_A, via: "tool" };
    case "write-impl": return { kind: "FileWrite", path: IMPL, via: "tool" };
    case "shell-write-impl": return { kind: "FileWrite", path: IMPL, via: "shell" };
    case "absolute-write-impl": return { kind: "FileWrite", path: `${ROOT}/${IMPL}`, via: "tool" };
    case "write-fixture": return { kind: "FileWrite", path: FIXTURE, via: "tool" };
    case "write-outside": return { kind: "FileWrite", path: OUTSIDE, via: "tool" };
    case "foreign-absolute-write": return { kind: "FileWrite", path: `/elsewhere/${IMPL}`, via: "tool" };
    case "read-impl": return { kind: "FileRead", path: IMPL };
  }
}

const renderAll = (steps: readonly Step[]): readonly Evidence[] => steps.map(render);

// --- The reference model, over abstract steps only ---

const IMPLEMENTATION_WRITES: ReadonlySet<Step> = new Set(["write-impl", "shell-write-impl", "absolute-write-impl", "write-fixture"]);
const NON_QUALIFYING_RUNS: ReadonlySet<Step> = new Set(["untrusted-red", "untrusted-green", "reportless", "legacy-red", "legacy-green"]);

function writtenPath(step: Step): string {
  if (step === "write-fixture") return FIXTURE;
  return IMPL;
}

function expected(
  steps: readonly Step[],
  classification: TestFileClassification,
  untrustedEvidence: boolean,
): RedThenGreenObservation {
  if (classification.testFiles.length === 0) return { kind: "unproven", gap: { kind: "no-test-files" } };
  const write = steps.findIndex((step) => IMPLEMENTATION_WRITES.has(step));
  if (write === -1) return { kind: "unproven", gap: { kind: "implementation-write-missing" } };
  const untrustedOnly = untrustedEvidence || steps.some((step) => NON_QUALIFYING_RUNS.has(step));
  const red = steps.indexOf("red");
  if (red === -1) return { kind: "unproven", gap: { kind: "red-missing", untrustedOnly } };
  if (red > write) return { kind: "unproven", gap: { kind: "red-after-first-implementation-write" } };
  const green = steps.findIndex((step, index) => index > write && step === "green");
  if (green === -1) return { kind: "unproven", gap: { kind: "green-missing", untrustedOnly } };
  return {
    kind: "shown",
    red: { index: red, command: `npm test #${red}` },
    implementationWrite: writtenPath(steps[write]!),
    green: { index: green, command: `npm test #${green}` },
  };
}

const stepArb = fc.constantFrom(...STEPS);
const epochArb = fc.array(stepArb, { maxLength: 12 });

// --- Exhaustive permutations of the three steps ---

const CORE_STEPS = ["red", "write-impl", "green"] as const;

function orderings(): readonly (readonly Step[])[] {
  const result: Step[][] = [[]];
  const extend = (prefix: readonly Step[], remaining: readonly Step[]): void => {
    remaining.forEach((step, index) => {
      const next = [...prefix, step];
      result.push(next);
      extend(next, remaining.filter((_, other) => other !== index));
    });
  };
  extend([], CORE_STEPS);
  return result;
}

describe("judgeRedThenGreen: every ordering of red, implementation write and green", () => {
  const cases = orderings();

  it("covers all 16 orderings of the three steps and their subsets", () => {
    expect(cases).toHaveLength(16);
  });

  it.each(cases.map((steps) => ({ steps, label: steps.join(" → ") || "(empty epoch)" })))(
    "FR-006 / FR-009: $label",
    ({ steps }) => {
      expect(judge(renderAll(steps), CLASSIFIED, ROOT, false)).toEqual(expected(steps, CLASSIFIED, false));
    },
  );

  it("FR-006: only red → write → green is shown", () => {
    const shown = cases.filter((steps) => judge(renderAll(steps), CLASSIFIED, ROOT, false).kind === "shown");
    expect(shown).toEqual([["red", "write-impl", "green"]]);
  });

  it("FR-009: the gaps of the orderings are the named, distinct failures", () => {
    const gaps = new Map(cases.map((steps) => {
      const observation = judge(renderAll(steps), CLASSIFIED, ROOT, false);
      return [steps.join(","), observation.kind === "unproven" ? observation.gap : "shown"] as const;
    }));
    expect(gaps.get("")).toEqual({ kind: "implementation-write-missing" });
    expect(gaps.get("red,green")).toEqual({ kind: "implementation-write-missing" });
    expect(gaps.get("write-impl,green")).toEqual({ kind: "red-missing", untrustedOnly: false });
    expect(gaps.get("write-impl,red,green")).toEqual({ kind: "red-after-first-implementation-write" });
    expect(gaps.get("red,write-impl")).toEqual({ kind: "green-missing", untrustedOnly: false });
    expect(gaps.get("red,green,write-impl")).toEqual({ kind: "green-missing", untrustedOnly: false });
    expect(gaps.get("red,write-impl,green")).toBe("shown");
  });
});

describe("judgeRedThenGreen: properties over arbitrary epochs (SC-001)", () => {
  it("FR-006..FR-009: agrees with the reference model on every epoch", () => {
    fc.assert(fc.property(epochArb, fc.boolean(), (steps, untrusted) => {
      expect(judge(renderAll(steps), CLASSIFIED, ROOT, untrusted)).toEqual(expected(steps, CLASSIFIED, untrusted));
    }), { numRuns: 2000 });
  });

  it("FR-006: no false pass — a shown observation names a behavioral red, then the first implementation write, then a full green", () => {
    fc.assert(fc.property(epochArb, fc.boolean(), (steps, untrusted) => {
      const observation = judge(renderAll(steps), CLASSIFIED, ROOT, untrusted);
      if (observation.kind !== "shown") return;
      const firstWrite = steps.findIndex((step) => IMPLEMENTATION_WRITES.has(step));
      expect(steps[observation.red.index]).toBe("red");
      expect(observation.red.index).toBeLessThan(firstWrite);
      expect(steps[observation.green.index]).toBe("green");
      expect(observation.green.index).toBeGreaterThan(firstWrite);
    }), { numRuns: 1000 });
  });

  it("FR-008: inserting untrusted runs never changes whether I6 is shown", () => {
    const untrustedArb = fc.constantFrom<Step>(...NON_QUALIFYING_RUNS);
    fc.assert(fc.property(
      epochArb,
      fc.array(fc.tuple(fc.nat(), untrustedArb), { maxLength: 4 }),
      (steps, insertions) => {
        const noisy = [...steps];
        for (const [position, step] of insertions) noisy.splice(position % (noisy.length + 1), 0, step);
        const before = judge(renderAll(steps), CLASSIFIED, ROOT, false);
        const after = judge(renderAll(noisy), CLASSIFIED, ROOT, false);
        expect(after.kind).toBe(before.kind);
        if (before.kind === "unproven" && after.kind === "unproven") expect(after.gap.kind).toBe(before.gap.kind);
      },
    ), { numRuns: 1000 });
  });

  it("FR-012 / AS-014: the judgment is deterministic over the same facts", () => {
    fc.assert(fc.property(epochArb, fc.boolean(), (steps, untrusted) => {
      const events = renderAll(steps);
      expect(judge(events, CLASSIFIED, ROOT, untrusted)).toEqual(judge(events, CLASSIFIED, ROOT, untrusted));
    }), { numRuns: 500 });
  });

  it("AS-013: a classification with no test files is always the no-test-files gap", () => {
    fc.assert(fc.property(epochArb, fc.boolean(), (steps, untrusted) => {
      expect(judge(renderAll(steps), NO_TEST_FILES, ROOT, untrusted))
        .toEqual({ kind: "unproven", gap: { kind: "no-test-files" } });
    }), { numRuns: 300 });
  });

  it("AS-011: Pi-structured provenance marks an unmet red or green step untrusted-only, and never satisfies one", () => {
    fc.assert(fc.property(epochArb, (steps) => {
      const trusted = judge(renderAll(steps), CLASSIFIED, ROOT, false);
      const pi = judge(renderAll(steps), CLASSIFIED, ROOT, true);
      expect(pi.kind).toBe(trusted.kind);
      if (pi.kind === "unproven" && (pi.gap.kind === "red-missing" || pi.gap.kind === "green-missing")) {
        expect(pi.gap.untrustedOnly).toBe(true);
      }
    }), { numRuns: 500 });
  });
});

describe("judgeRedThenGreen: worked cases", () => {
  it("AS-005: a red, an implementation write and a green are shown with their indices and commands", () => {
    expect(judge(renderAll(["write-test", "red", "read-impl", "write-impl", "green"]), CLASSIFIED, ROOT, false)).toEqual({
      kind: "shown",
      red: { index: 1, command: "npm test #1" },
      implementationWrite: IMPL,
      green: { index: 4, command: "npm test #4" },
    });
  });

  it("AS-009: a collection-only red is not red", () => {
    expect(judge(renderAll(["collection-red", "write-impl", "green"]), CLASSIFIED, ROOT, false))
      .toEqual({ kind: "unproven", gap: { kind: "red-missing", untrustedOnly: false } });
  });

  it("FR-007: a collection error in one Task test file beside a failing testcase in another is red", () => {
    const events: readonly Evidence[] = [
      testRun("red", 1, [collectionError(REPORTED_B), failing(REPORTED_A)]),
      { kind: "FileWrite", path: IMPL, via: "tool" },
      testRun("green", 0, [passing(REPORTED_A), passing(REPORTED_B)]),
    ];
    expect(judge(events, CLASSIFIED, ROOT, false)).toMatchObject({ kind: "shown", red: { index: 0, command: "red" } });
  });

  it("FR-006: a green with a collection error in a Task test file is not green", () => {
    const events: readonly Evidence[] = [
      testRun("red", 1, [failing(REPORTED_A), passing(REPORTED_B)]),
      { kind: "FileWrite", path: IMPL, via: "tool" },
      testRun("not green", 0, [passing(REPORTED_A), { file: REPORTED_B, executed: 1, failed: 1, skipped: 0, collectionError: true }]),
    ];
    // exit 0 with a failing synthetic testcase is contradictory but representable; it must not green.
    expect(judge(events, CLASSIFIED, ROOT, false))
      .toEqual({ kind: "unproven", gap: { kind: "green-missing", untrustedOnly: false } });
  });

  it("FR-006: a green whose Task test file skipped every testcase is not green", () => {
    // Red, implement, then skip the failing test: the file declares testcases
    // and fails none, yet runs none, so the order is not shown.
    expect(judge(renderAll(["red", "write-impl", "skipped-green"]), CLASSIFIED, ROOT, false))
      .toEqual({ kind: "unproven", gap: { kind: "green-missing", untrustedOnly: false } });
    const partlySkipped: TestFileResult = { file: REPORTED_A, executed: 2, failed: 0, skipped: 1, collectionError: false };
    expect(judge([...renderAll(["red", "write-impl"]), testRun("green", 0, [partlySkipped, passing(REPORTED_B)])], CLASSIFIED, ROOT, false))
      .toMatchObject({ kind: "shown" });
  });

  it("AS-010: a fixture write before the red is the first implementation write", () => {
    expect(judge(renderAll(["write-fixture", "red", "write-impl", "green"]), CLASSIFIED, ROOT, false))
      .toEqual({ kind: "unproven", gap: { kind: "red-after-first-implementation-write" } });
  });

  it("AS-005: an absolute write beneath the repository root is an implementation write, one outside it is not", () => {
    expect(judge(renderAll(["red", "absolute-write-impl", "green"]), CLASSIFIED, ROOT, false))
      .toMatchObject({ kind: "shown", implementationWrite: IMPL });
    expect(judge(renderAll(["red", "foreign-absolute-write", "green"]), CLASSIFIED, ROOT, false))
      .toEqual({ kind: "unproven", gap: { kind: "implementation-write-missing" } });
  });

  it("AS-005: absolute report identities beneath the repository root attribute to the Task's test files", () => {
    const events: readonly Evidence[] = [
      testRun("red", 1, [failing(`${ROOT}/${TEST_A}`), passing(`${ROOT}/${TEST_B}`)]),
      { kind: "FileWrite", path: `${ROOT}/${IMPL}`, via: "tool" },
      testRun("green", 0, [passing(`${ROOT}/${TEST_A}`), passing(`${ROOT}/${TEST_B}`)]),
    ];
    expect(judge(events, CLASSIFIED, ROOT, false)).toEqual({
      kind: "shown",
      red: { index: 0, command: "red" },
      implementationWrite: IMPL,
      green: { index: 2, command: "green" },
    });
  });

  it("AS-018: JVM class identities attribute to the Task's JVM test file", () => {
    const test = "src/test/java/com/example/LedgerTest.java";
    const main = "src/main/java/com/example/Ledger.java";
    const jvm: TestFileClassification = { testFiles: [test], implementationFiles: [main] };
    const events: readonly Evidence[] = [
      testRun("mvn test", 1, [failing("com.example.LedgerTest")]),
      { kind: "FileWrite", path: main, via: "tool" },
      testRun("mvn test", 0, [passing("com.example.LedgerTest")]),
    ];
    expect(judge(events, jvm, ROOT, false)).toMatchObject({ kind: "shown", implementationWrite: main });
  });

  it("FR-008: a red met only by a run without an exit code reports untrusted-only", () => {
    expect(judge(renderAll(["untrusted-red", "write-impl", "green"]), CLASSIFIED, ROOT, false))
      .toEqual({ kind: "unproven", gap: { kind: "red-missing", untrustedOnly: true } });
  });

  it("FR-008: a green met only by a legacy fact reports untrusted-only", () => {
    expect(judge(renderAll(["red", "write-impl", "legacy-green"]), CLASSIFIED, ROOT, false))
      .toEqual({ kind: "unproven", gap: { kind: "green-missing", untrustedOnly: true } });
  });
});
