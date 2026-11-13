/**
 * The Task mutation check's pure core (ADR-0071), one decision at a time:
 * - `taskMutationDuty`: which Tasks owe the check, each off reason, and that
 *   only the Task's own TypeScript or JavaScript implementation files beneath
 *   the runner's cwd are ever mutated;
 * - `taskMutationDigest`: order-independent, and moved by every change to the
 *   base, the paths, a file's presence or a byte;
 * - `classifyTaskBaseline` and `classifyTaskMutantRun`: a red baseline is
 *   never a survivor, a timeout is a kill, a mutant that only breaks
 *   collection is no evidence;
 * - `taskMutationResult`, the one constructor of a result: its kind follows
 *   from the tallies alone, so a run whose every mutant was invalid is
 *   `inconclusive` and never clean;
 * - the record: parse after serialize is the identity, and every malformed
 *   document, including one whose kind its counts contradict, is refused;
 * - `taskMutationStanding`, `taskMutationStopVerdict` and the renderers.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { emptyAcceptanceExpectation, graphAcceptanceExpectation } from "../../src/core/acceptance-contract";
import { DECISION_RECORD_AGENT } from "../../src/core/model-profiles";
import { TASK_MUTATION_OPERATORS, type TaskMutant } from "../../src/core/owner-verification/mutation-plan";
import type { MatrixTestRun } from "../../src/core/owner-verification/types";
import {
  classifyTaskBaseline,
  classifyTaskMutantRun,
  isMutableSource,
  KILLING_TEST,
  mutantsByFile,
  NO_TASK_MUTATION_CHECK,
  parseTaskMutationRecord,
  recordedTaskMutation,
  renderTaskMutationBlock,
  renderTaskMutationReport,
  TASK_MUTATION_BASH_TIMEOUT_MS,
  TASK_MUTATION_DEADLINE_MS,
  TASK_MUTATION_NOT_RUN,
  TASK_MUTATION_OFF_TEXT,
  taskMutationDigest,
  taskMutationDuty,
  taskMutationMutants,
  taskMutationRecordJson,
  taskMutationResult,
  taskMutationResultOf,
  taskMutationStanding,
  taskMutationStopVerdict,
  taskMutationUnavailable,
  type TaskFileBytes,
  type TaskMutantRun,
  type TaskMutationOffReason,
  type TaskMutationResult,
  type TaskMutationTally,
  type TaskSurvivor,
} from "../../src/core/task-mutation-check";
import type { Task, TaskGraph } from "../../src/types";
import { contract, surface, task } from "../fixtures/contract-status-fixtures";
import { loomCommandsAt } from "../fixtures/loom-package-root";
import { distillTaskFixture, taskFixture } from "../fixtures/task-lifecycle";
import { junitReport, mutationManifest, START_SHA, talliedResult, type JunitCase } from "../fixtures/task-mutation";

type Graph = Pick<TaskGraph, "tasks" | "verification_manifest" | "acceptance_contracts">;

const IMPL = "src/ledger.ts";
const TEST = "src/ledger.test.ts";
const OWING = taskFixture({ ...task("T2", 2, [IMPL, TEST, "docs/ledger.md", "src/ledger.d.ts"]), start_sha: START_SHA });
const graphOf = (tasks: readonly Task[], overrides: Partial<Graph> = {}): Graph =>
  ({ tasks: [...tasks], verification_manifest: mutationManifest(), acceptance_contracts: [], ...overrides });

describe("taskMutationDuty", () => {
  it("owes the check for an implementation Task: its mutable files, and every declared file for the digest", () => {
    expect(taskMutationDuty(graphOf([OWING]), "T2")).toMatchObject({
      kind: "owed",
      taskId: "T2",
      wave: 2,
      startSha: START_SHA,
      mutable: [IMPL],
      declared: [IMPL, TEST, "docs/ledger.md", "src/ledger.d.ts"],
    });
  });

  it("carries a null base for a Task that records no start_sha", () => {
    expect(taskMutationDuty(graphOf([task("T2", 2, [IMPL])]), "T2")).toMatchObject({ kind: "owed", startSha: null });
  });

  // A manifest frozen before the Test-File Classification existed carries no `testFiles`.
  const { testFiles: _classification, ...PRE_CLASSIFICATION_MANIFEST } = mutationManifest();
  const SURFACE = surface("payload");
  const CONTRACT_GRAPH = graphOf([task("T1", 1, [SURFACE.types, SURFACE.acceptance, "src/stub.ts"])], {
    acceptance_contracts: [contract({ id: "CT-1", surface: SURFACE, anchors: ["AS-001"], freeze: { state: "awaiting-red" } })],
  });

  it.each<[TaskMutationOffReason, Graph, string]>([
    ["unknown-task", graphOf([OWING]), "T9"],
    ["switched-off", graphOf([OWING], { verification_manifest: mutationManifest({ taskMutationCheck: "off" }) }), "T2"],
    ["no-affected-runner", graphOf([OWING], { verification_manifest: mutationManifest({ affectedRunner: undefined }) }), "T2"],
    ["no-affected-runner", graphOf([OWING], { verification_manifest: undefined }), "T2"],
    ["no-frozen-classification", graphOf([OWING], { verification_manifest: PRE_CLASSIFICATION_MANIFEST }), "T2"],
    ["exempt-role", graphOf([distillTaskFixture({ id: "T7", wave: 2, scope: [IMPL] })]), "T7"],
    ["decision-record-task", graphOf([taskFixture({ ...task("T5", 2, ["src/decision.ts"]), agent: DECISION_RECORD_AGENT })]), "T5"],
    ["contract-task", CONTRACT_GRAPH, "T1"],
    ["no-mutable-files", graphOf([task("T4", 2, [TEST, "docs/ledger.md", "src/ledger.d.ts", "src/Ledger.java"])]), "T4"],
    ["no-mutable-files", graphOf([task("T4", 2, [])]), "T4"],
    ["no-mutable-files", graphOf([task("T4", 2, ["pi/ledger.ts"])], { verification_manifest: mutationManifest({ cwd: "engine" }) }), "T4"],
  ])("is off as %s, with a line that says why", (reason, graph, taskId) => {
    expect(taskMutationDuty(graph, taskId)).toEqual({ kind: "off", reason });
    expect(TASK_MUTATION_OFF_TEXT[reason]).not.toBe("");
  });

  it("mutates only files beneath the runner's cwd, and still digests the others", () => {
    const duty = taskMutationDuty(
      graphOf([task("T2", 2, ["engine/src/a.ts", "pi/b.ts", "engineering/c.ts"])], { verification_manifest: mutationManifest({ cwd: "engine" }) }),
      "T2",
    );
    expect(duty).toMatchObject({ kind: "owed", mutable: ["engine/src/a.ts"], declared: ["engine/src/a.ts", "pi/b.ts", "engineering/c.ts"] });
  });

  it.each([
    ["src/a.ts", true], ["src/a.tsx", true], ["src/a.mts", true], ["src/a.cjs", true], ["src/a.jsx", true],
    ["src/a.d.ts", false], ["src/a.d.mts", false], ["src/A.java", false], ["src/a.rs", false], ["README.md", false], ["src/a.json", false],
  ])("reads %s as mutable source: %s", (path, mutable) => {
    expect(isMutableSource(path)).toBe(mutable);
  });

  it("property: a Task's mutable files are always its own declared TS/JS files that are not tests, in file_list order", () => {
    const path = fc.constantFrom("src/a.ts", "src/a.test.ts", "src/b.js", "src/b.test.ts", "src/c.d.ts", "docs/c.md", "src/d.tsx", "src/E.java");
    fc.assert(fc.property(fc.uniqueArray(path, { maxLength: 8 }), fc.uniqueArray(path, { maxLength: 8 }), (own, siblings) => {
      const duty = taskMutationDuty(graphOf([task("T2", 2, own), task("T3", 2, siblings)]), "T2");
      const expected = own.filter((file) => isMutableSource(file) && !file.endsWith(".test.ts"));
      if (duty.kind === "off") {
        expect(duty.reason).toBe("no-mutable-files");
        expect(expected).toEqual([]);
        return;
      }
      expect(duty.mutable).toEqual(expected);
      expect(duty.declared).toEqual(own);
    }));
  });
});

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const fileArb: fc.Arbitrary<TaskFileBytes> = fc.record({
  path: fc.constantFrom("src/a.ts", "src/b.ts", "src/c.test.ts", "docs/d.md", "src/e.ts"),
  bytes: fc.option(fc.uint8Array({ maxLength: 24 }), { nil: null }),
});
const filesArb = fc.uniqueArray(fileArb, { selector: ({ path }) => path, minLength: 1, maxLength: 5 });
const shaArb = fc.option(fc.constantFrom(START_SHA, "b".repeat(40)), { nil: null });

describe("taskMutationDigest", () => {
  it("is a sha256 hex digest that names the base and each file's presence and bytes", () => {
    const digest = taskMutationDigest(START_SHA, [{ path: IMPL, bytes: encode("a") }, { path: TEST, bytes: null }]);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(taskMutationDigest(START_SHA, [{ path: IMPL, bytes: encode("a") }, { path: TEST, bytes: null }])).toBe(digest);
  });

  it("property: the digest does not depend on the order the files are given in", () => {
    fc.assert(fc.property(shaArb, filesArb, (sha, files) => {
      expect(taskMutationDigest(sha, [...files].reverse())).toBe(taskMutationDigest(sha, files));
    }));
  });

  it("property: one changed byte, a file gone or back, another path or another base each move the digest", () => {
    fc.assert(fc.property(shaArb, filesArb, fc.nat(), (sha, files, pick) => {
      const digest = taskMutationDigest(sha, files);
      const index = pick % files.length;
      const chosen = files[index]!;
      const replaced = (file: TaskFileBytes): readonly TaskFileBytes[] => files.map((entry, at) => at === index ? file : entry);
      const flipped = chosen.bytes === null ? encode("") : chosen.bytes.length === 0 ? null : Uint8Array.from(chosen.bytes, (byte, at) => at === 0 ? byte ^ 1 : byte);
      expect(taskMutationDigest(sha, replaced({ path: chosen.path, bytes: flipped }))).not.toBe(digest);
      expect(taskMutationDigest(sha, replaced({ path: `${chosen.path}.moved`, bytes: chosen.bytes }))).not.toBe(digest);
      expect(taskMutationDigest(sha, [...files, { path: "src/added.ts", bytes: null }])).not.toBe(digest);
      expect(taskMutationDigest(sha === null ? START_SHA : null, files)).not.toBe(digest);
    }));
  });
});

const exited = (bytes: Uint8Array | null): MatrixTestRun =>
  ({ kind: "exited", exitCode: 1, signal: null, report: bytes === null ? { kind: "missing" } : { kind: "produced", bytes } });
const passed = (name: string): JunitCase => ({ file: TEST, name, outcome: "passed" });
const failed = (name: string): JunitCase => ({ file: TEST, name, outcome: "failed" });
/** Vitest's synthetic testcase for a file that failed to load. */
const uncollected: JunitCase = { file: TEST, name: TEST, outcome: "failed" };
const NO_CONTRACTS = emptyAcceptanceExpectation(2);

describe("classifyTaskBaseline", () => {
  it("is green when every testcase passes, and untested when the report holds none", () => {
    expect(classifyTaskBaseline(exited(junitReport([passed("debits")])), NO_CONTRACTS)).toEqual({ kind: "green" });
    expect(classifyTaskBaseline(exited(junitReport([])), NO_CONTRACTS)).toEqual({ kind: "untested" });
  });

  it("is red, naming each failure, when a testcase fails or a file fails to collect: never a survivor", () => {
    expect(classifyTaskBaseline(exited(junitReport([passed("debits"), failed("credits")])), NO_CONTRACTS))
      .toEqual({ kind: "red", failures: [`'credits' (${TEST})`] });
    expect(classifyTaskBaseline(exited(junitReport([uncollected])), NO_CONTRACTS)).toMatchObject({ kind: "red" });
  });

  it.each<[string, MatrixTestRun, RegExp]>([
    ["a runner that could not start", { kind: "spawn-failed", message: "spawn vitest ENOENT" }, /could not start: spawn vitest ENOENT/],
    ["a timeout", { kind: "timed-out", elapsedMs: 60_000 }, /exceeded its time limit after 60000 ms/],
    ["a missing report", exited(null), /without writing its report/],
    ["an unreadable report", { kind: "exited", exitCode: 0, signal: null, report: { kind: "unreadable", reason: "EACCES" } }, /could not be read: EACCES/],
    ["a report that is no JUnit", exited(encode("not xml")), /.+/],
  ])("is unobservable for %s", (_label, run, reason) => {
    const baseline = classifyTaskBaseline(run, NO_CONTRACTS);
    expect(baseline.kind).toBe("unobservable");
    if (baseline.kind === "unobservable") expect(baseline.reason).toMatch(reason);
  });

  it("is green when the only failures are acceptance testcases the Wave Gate still expects RED", () => {
    const SURFACE = surface("payload");
    const awaiting = contract({ id: "CT-1", surface: SURFACE, anchors: ["AS-001"], freeze: { state: "awaiting-red" } });
    const expectation = graphAcceptanceExpectation({ acceptance_contracts: [awaiting], tasks: [task("T1", 1, [SURFACE.types, SURFACE.acceptance])] }, 1);
    const report = junitReport([{ file: SURFACE.acceptance, name: "AS-001: one valid call wins", outcome: "failed" }, passed("debits")]);
    expect(classifyTaskBaseline(exited(report), expectation)).toEqual({ kind: "green" });
  });

  it("property: a baseline is red exactly when some testcase failed, whatever else passed", () => {
    const caseArb = fc.record({ name: fc.constantFrom("a", "b", "c", "d"), outcome: fc.constantFrom<JunitCase["outcome"]>("passed", "failed") });
    fc.assert(fc.property(fc.uniqueArray(caseArb, { selector: ({ name }) => name, minLength: 1, maxLength: 4 }), (cases) => {
      const baseline = classifyTaskBaseline(exited(junitReport(cases.map(({ name, outcome }) => ({ file: TEST, name, outcome })))), NO_CONTRACTS);
      expect(baseline.kind).toBe(cases.some(({ outcome }) => outcome === "failed") ? "red" : "green");
    }));
  });
});

describe("classifyTaskMutantRun", () => {
  it.each<[string, MatrixTestRun, string]>([
    ["a failing testcase kills", exited(junitReport([passed("debits"), failed("credits")])), "killed"],
    ["a timeout kills", { kind: "timed-out", elapsedMs: 60_000 }, "killed"],
    ["an all-passing run is a survivor", exited(junitReport([passed("debits")])), "survived"],
    ["a run of no testcase is invalid", exited(junitReport([])), "invalid"],
    ["a run whose only failure is a collection error is invalid", exited(junitReport([uncollected])), "invalid"],
    ["a collection error beside a real failure kills", exited(junitReport([uncollected, failed("credits")])), "killed"],
    ["a missing report is unobservable", exited(null), "unobservable"],
    ["a runner that could not start is unobservable", { kind: "spawn-failed", message: "ENOENT" }, "unobservable"],
  ])("%s", (_label, run, kind) => {
    expect(classifyTaskMutantRun(run, NO_CONTRACTS).kind).toBe(kind);
  });
});

const mutant = (path: string, line: number, operator: TaskMutant["operator"] = "guard-removal"): TaskMutant => ({
  id: `${path}:${line}:${operator}`, path, line, column: 3, start: line * 10, end: line * 10 + 4, operator,
  original: "if (amount <= 0) throw new Error();", replacement: ";",
});

const survivorArb: fc.Arbitrary<TaskSurvivor> = fc.record({
  path: fc.constantFrom(IMPL, "src/audit.ts"),
  line: fc.integer({ min: 1, max: 900 }),
  column: fc.integer({ min: 1, max: 120 }),
  operator: fc.constantFrom(...TASK_MUTATION_OPERATORS),
  original: fc.string({ maxLength: 30 }),
  replacement: fc.string({ maxLength: 30 }),
  coverage: fc.constantFrom<TaskSurvivor["coverage"]>("tested", "untested"),
});

/** A tally the constructor admits: candidates are 0 when no mutant was selected, and at least the mutants otherwise. */
const tallyArb: fc.Arbitrary<TaskMutationTally> = fc.record({
  killed: fc.nat({ max: 6 }),
  invalid: fc.nat({ max: 6 }),
  survivors: fc.array(survivorArb, { maxLength: 4 }),
  extra: fc.nat({ max: 20 }),
}).map(({ killed, invalid, survivors, extra }) => {
  const mutants = killed + invalid + survivors.length;
  return { killed, invalid, survivors, candidates: mutants === 0 ? 0 : mutants + extra };
});

const resultArb: fc.Arbitrary<TaskMutationResult> = fc.oneof(
  fc.string({ minLength: 1, maxLength: 40 }).map(taskMutationUnavailable),
  tallyArb.map(talliedResult),
);

describe("taskMutationResult", () => {
  it("property: the kind follows from the tallies alone, and the result counts every mutant it was given", () => {
    fc.assert(fc.property(tallyArb, (tally) => {
      const result = taskMutationResult(tally);
      if (!result.ok) throw new Error(result.error);
      const mutants = tally.killed + tally.invalid + tally.survivors.length;
      const expected = tally.survivors.length > 0 ? "survivors" : mutants === 0 ? "no-mutants" : tally.killed === 0 ? "inconclusive" : "clean";
      expect(result.value.kind).toBe(expected);
      expect(taskMutationMutants(result.value)).toBe(mutants);
    }));
  });

  it("property: a clean result always names a kill, so a run that judged nothing is never clean", () => {
    fc.assert(fc.property(tallyArb, (tally) => {
      const result = taskMutationResult(tally);
      if (result.ok && result.value.kind === "clean") expect(result.value.killed).toBeGreaterThan(0);
      if (tally.killed === 0 && tally.survivors.length === 0) expect(result.ok && result.value.kind).not.toBe("clean");
    }));
  });

  it("is inconclusive, never clean, when every selected mutant was invalid", () => {
    expect(taskMutationResult({ candidates: 5, killed: 0, invalid: 3, survivors: [] }))
      .toEqual({ ok: true, value: { kind: "inconclusive", invalid: 3, candidates: 5 } });
  });

  it("is clean when the tests killed one mutant and the rest were invalid, and counts both", () => {
    expect(taskMutationResult({ candidates: 5, killed: 1, invalid: 2, survivors: [] }))
      .toEqual({ ok: true, value: { kind: "clean", killed: 1, invalid: 2, candidates: 5 } });
  });

  it.each<[string, TaskMutationTally, RegExp]>([
    ["more mutants than candidate sites", { candidates: 2, killed: 2, invalid: 1, survivors: [] }, /more than the 2 candidate site/],
    ["candidate sites from which no mutant was selected", { candidates: 4, killed: 0, invalid: 0, survivors: [] }, /no mutant was selected from 4/],
    ["a negative count", { candidates: 4, killed: -1, invalid: 0, survivors: [] }, /non-negative integers/],
    ["a fractional count", { candidates: 4, killed: 0.5, invalid: 0, survivors: [] }, /non-negative integers/],
  ])("refuses %s", (_label, tally, reason) => {
    const result = taskMutationResult(tally);
    expect(result.ok ? "" : result.error).toMatch(reason);
  });
});

describe("taskMutationResultOf", () => {
  it("is clean when the tests killed a mutant and none survived, and counts the invalid ones apart", () => {
    const runs: TaskMutantRun[] = [{ mutant: mutant(IMPL, 2), outcome: "killed" }, { mutant: mutant(IMPL, 5), outcome: "invalid" }];
    expect(taskMutationResultOf(runs, 11)).toEqual({ kind: "clean", killed: 1, invalid: 1, candidates: 11 });
    expect(taskMutationResultOf([], 0)).toEqual({ kind: "no-mutants" });
  });

  it("is inconclusive when every mutant only broke collection or ran no test: never clean", () => {
    const runs: TaskMutantRun[] = [{ mutant: mutant(IMPL, 2), outcome: "invalid" }, { mutant: mutant(IMPL, 5), outcome: "invalid" }];
    expect(taskMutationResultOf(runs, 4)).toEqual({ kind: "inconclusive", invalid: 2, candidates: 4 });
  });

  it("property: a run with no kill and no survivor is never clean", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 8 }), fc.nat({ max: 10 }), (invalid, extra) => {
      const runs = Array.from({ length: invalid }, (_, at): TaskMutantRun => ({ mutant: mutant(IMPL, at + 1), outcome: "invalid" }));
      expect(taskMutationResultOf(runs, invalid + extra).kind).toBe("inconclusive");
    }));
  });

  it("is unavailable, naming why, when its tally cannot be a result", () => {
    const result = taskMutationResultOf([{ mutant: mutant(IMPL, 2), outcome: "killed" }], 0);
    expect(result).toMatchObject({ kind: "unavailable", reason: expect.stringContaining("the run's tally is inconsistent") });
  });

  it("names every survivor, and marks the ones no test ran for", () => {
    const runs: TaskMutantRun[] = [
      { mutant: mutant(IMPL, 2), outcome: "survived" },
      { mutant: mutant(IMPL, 5), outcome: "killed" },
      { mutant: mutant("src/audit.ts", 9, "comparison-flip"), outcome: "untested" },
    ];
    const result = taskMutationResultOf(runs, 3);
    expect(result).toMatchObject({ kind: "survivors", killed: 1, invalid: 0, candidates: 3 });
    if (result.kind !== "survivors") return;
    expect(result.survivors.map(({ path, line, operator, coverage }) => [path, line, operator, coverage])).toEqual([
      [IMPL, 2, "guard-removal", "tested"],
      ["src/audit.ts", 9, "comparison-flip", "untested"],
    ]);
  });

  it("groups mutants by the file they rewrite, in first-mutant order", () => {
    const grouped = mutantsByFile([mutant("src/b.ts", 1), mutant("src/a.ts", 2), mutant("src/b.ts", 3)]);
    expect(grouped.map(({ path, mutants }) => [path, mutants.map(({ line }) => line)])).toEqual([["src/b.ts", [1, 3]], ["src/a.ts", [2]]]);
    expect(mutantsByFile([])).toEqual([]);
  });
});

const DIGEST = taskMutationDigest(START_SHA, [{ path: IMPL, bytes: encode("a") }]);
const OTHER_DIGEST = taskMutationDigest(START_SHA, [{ path: IMPL, bytes: encode("b") }]);
const wire = (record: ReturnType<typeof recordedTaskMutation>): Record<string, unknown> => {
  const document: unknown = JSON.parse(taskMutationRecordJson(record));
  if (typeof document !== "object" || document === null) throw new Error("a record serializes to an object");
  return { ...document };
};

describe("the Task mutation record", () => {
  it("property: parse after serialize is the identity, and equal records serialize to equal bytes", () => {
    fc.assert(fc.property(fc.constantFrom("T1", "T22"), resultArb, (taskId, result) => {
      const record = recordedTaskMutation(taskId, DIGEST, result);
      const parsed = parseTaskMutationRecord(wire(record));
      expect(parsed).toEqual({ ok: true, value: record });
      if (parsed.ok) expect(taskMutationRecordJson(parsed.value)).toBe(taskMutationRecordJson(record));
    }));
  });

  const CLEAN = wire(recordedTaskMutation("T2", DIGEST, talliedResult({ killed: 2, candidates: 5 })));
  const SURVIVOR = { path: IMPL, line: 2, column: 3, operator: "guard-removal", original: "if (x) return;", replacement: ";", coverage: "tested" };
  const clean = (overrides: Record<string, unknown>): Record<string, unknown> =>
    ({ ...CLEAN, result: { kind: "clean", killed: 2, invalid: 0, candidates: 5, ...overrides } });
  const survivors = (overrides: Record<string, unknown>): Record<string, unknown> =>
    ({ ...CLEAN, result: { kind: "survivors", killed: 1, invalid: 0, candidates: 5, survivors: [SURVIVOR], ...overrides } });

  it.each<[string, unknown, RegExp]>([
    ["a non-object", "record", /must be an object/],
    ["an unknown key", { ...CLEAN, proof: true }, /unknown key\(s\) proof/],
    ["a missing key", { schemaVersion: 1, kind: CLEAN.kind, taskId: "T2", digest: DIGEST }, /lacks result/],
    ["another schema version", { ...CLEAN, schemaVersion: 2 }, /schemaVersion must be 1/],
    ["another kind", { ...CLEAN, kind: "loom-receipt" }, /kind must be/],
    ["an empty Task id", { ...CLEAN, taskId: "" }, /taskId must be a non-empty string/],
    ["a digest that is no sha256", { ...CLEAN, digest: "abc" }, /digest must be a sha256 hex digest/],
    ["an unknown result kind", { ...CLEAN, result: { kind: "passed" } }, /result\.kind must be one of "no-mutants", "clean", "survivors", "inconclusive", "unavailable"$/],
    ["more mutants than candidates", clean({ killed: 6 }), /more than the 5 candidate site/],
    ["a negative count", clean({ killed: -1 }), /result\.killed must be a non-negative integer/],
    ["a clean result with no kill: every mutant invalid", clean({ killed: 0, invalid: 3 }), /names a clean result, but its counts make it inconclusive/],
    ["a clean result over nothing selected", clean({ killed: 0, invalid: 0, candidates: 0 }), /names a clean result, but its counts make it no-mutants/],
    ["an inconclusive result that names a kill", { ...CLEAN, result: { kind: "inconclusive", invalid: 0, candidates: 0 } }, /counts make it no-mutants/],
    ["a clean result missing its invalid count", { ...CLEAN, result: { kind: "clean", killed: 2, candidates: 5 } }, /lacks invalid/],
    ["the retired mutants count", { ...CLEAN, result: { kind: "clean", mutants: 2, candidates: 5 } }, /unknown key\(s\) mutants/],
    ["an unavailable result with no reason", { ...CLEAN, result: { kind: "unavailable", reason: "" } }, /reason must be a non-empty string/],
    ["a clean result carrying survivors", clean({ survivors: [] }), /unknown key\(s\) survivors/],
    ["a survivors result naming none", survivors({ survivors: [] }), /at least one survivor/],
    ["more survivors than candidates", survivors({ candidates: 1 }), /more than the 1 candidate site/],
    ["a survivor with an unknown operator", survivors({ survivors: [{ ...SURVIVOR, operator: "delete-file" }] }), /operator must be one of/],
    ["a survivor at an absolute path", survivors({ survivors: [{ ...SURVIVOR, path: "/etc/passwd" }] }), /repository-relative path/],
    ["a survivor at line 0", survivors({ survivors: [{ ...SURVIVOR, line: 0 }] }), /positive integers/],
    ["a survivor with unknown coverage", survivors({ survivors: [{ ...SURVIVOR, coverage: "partial" }] }), /coverage must be/],
  ])("refuses %s", (_label, document, reason) => {
    const parsed = parseTaskMutationRecord(document);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(reason);
  });
});

const CLEAN_RESULT = talliedResult({ killed: 3, candidates: 3 });
const INCONCLUSIVE_RESULT = talliedResult({ invalid: 2, candidates: 4 });
const SURVIVORS_RESULT = taskMutationResultOf([{ mutant: mutant(IMPL, 2), outcome: "survived" }, { mutant: mutant(IMPL, 7, "comparison-flip"), outcome: "untested" }], 9);
const COMMAND = loomCommandsAt("/opt/loom").mutationCheck("T2");

describe("taskMutationStanding and taskMutationStopVerdict", () => {
  it("reads a record of these bytes as current, of other bytes or another Task as stale, and none as not-run", () => {
    const record = recordedTaskMutation("T2", DIGEST, CLEAN_RESULT);
    expect(taskMutationStanding(record, "T2", DIGEST)).toEqual({ kind: "current", result: CLEAN_RESULT });
    expect(taskMutationStanding(record, "T2", OTHER_DIGEST)).toEqual({ kind: "stale" });
    expect(taskMutationStanding(record, "T3", DIGEST)).toEqual({ kind: "stale" });
    expect(taskMutationStanding(TASK_MUTATION_NOT_RUN, "T2", DIGEST)).toEqual({ kind: "not-run" });
  });

  const observedAs = (standing: ReturnType<typeof taskMutationStanding>) => ({ kind: "observed" as const, standing, command: COMMAND });

  it("is idle for a Task that owes nothing and passes a clean current record, or one with nothing to mutate", () => {
    expect(taskMutationStopVerdict("T2", NO_TASK_MUTATION_CHECK)).toEqual({ kind: "idle" });
    expect(taskMutationStopVerdict("T2", observedAs({ kind: "current", result: CLEAN_RESULT }))).toEqual({ kind: "passed" });
    expect(taskMutationStopVerdict("T2", observedAs({ kind: "current", result: talliedResult({ candidates: 0 }) }))).toEqual({ kind: "passed" });
  });

  it("never passes an inconclusive record: it is a note naming why the run judged nothing", () => {
    expect(taskMutationStopVerdict("T2", observedAs({ kind: "current", result: INCONCLUSIVE_RESULT }))).toEqual({
      kind: "note",
      note: "Task mutation check for T2 did not decide (its last run was inconclusive: none of its 2 mutant(s) could be judged, " +
        "because each only broke test collection or ran no test); the stop proceeds",
    });
  });

  it("fails for a check that never ran, ran over other bytes, or left survivors, carrying the command", () => {
    expect(taskMutationStopVerdict("T2", observedAs({ kind: "not-run" }))).toEqual({ kind: "failing", cause: { kind: "not-run" }, command: COMMAND });
    expect(taskMutationStopVerdict("T2", observedAs({ kind: "stale" }))).toEqual({ kind: "failing", cause: { kind: "stale" }, command: COMMAND });
    const verdict = taskMutationStopVerdict("T2", observedAs({ kind: "current", result: SURVIVORS_RESULT }));
    expect(verdict).toMatchObject({ kind: "failing", cause: { kind: "survivors" }, command: COMMAND });
  });

  it("fails open: an unavailable run and an unobservable record are notes that name the cause, never a block", () => {
    const unavailable = taskMutationStopVerdict("T2", observedAs({ kind: "current", result: taskMutationUnavailable("the unmutated tests fail") }));
    expect(unavailable).toEqual({ kind: "note", note: "Task mutation check for T2 did not decide (its last run was unavailable: the unmutated tests fail); the stop proceeds" });
    expect(taskMutationStopVerdict("T2", { kind: "unavailable", reason: "its record is unreadable: EACCES" }))
      .toEqual({ kind: "note", note: "Task mutation check for T2 did not decide (its record is unreadable: EACCES); the stop proceeds" });
  });

  it("property: a stop is held only by a record that is missing, stale or names survivors, and passes only a clean or empty one", () => {
    const standing = fc.oneof(
      fc.constant({ kind: "not-run" as const }),
      fc.constant({ kind: "stale" as const }),
      resultArb.map((result) => ({ kind: "current" as const, result })),
    );
    fc.assert(fc.property(standing, (observed) => {
      const verdict = taskMutationStopVerdict("T2", observedAs(observed));
      const holds = observed.kind !== "current" || observed.result.kind === "survivors";
      const passes = observed.kind === "current" && (observed.result.kind === "clean" || observed.result.kind === "no-mutants");
      expect(verdict.kind === "failing").toBe(holds);
      expect(verdict.kind === "passed").toBe(passes);
    }));
  });
});

describe("what the implementer reads", () => {
  it("forms one quoted command through the package's CLI", () => {
    expect(COMMAND).toBe("bun '/opt/loom/engine/src/cli.ts' helper mutation-check --task 'T2'");
    expect(loomCommandsAt("/home/o'brien/loom").mutationCheck("T2")).toContain(`'/home/o'\\''brien/loom/engine/src/cli.ts'`);
  });

  it("gives every operator a killing test", () => {
    expect(Object.keys(KILLING_TEST).sort()).toEqual([...TASK_MUTATION_OPERATORS].sort());
  });

  it("reports a clean run, a run with nothing to mutate, and an unavailable run in one line each", () => {
    expect(renderTaskMutationReport("T2", CLEAN_RESULT))
      .toBe("Task mutation check for T2: clean — your tests killed all 3 mutant(s) they could judge (of 3 site(s) on changed lines).");
    expect(renderTaskMutationReport("T2", talliedResult({ candidates: 0 })))
      .toBe("Task mutation check for T2: clean — no mutants (no mutation site on a line this Task changed).");
    expect(renderTaskMutationReport("T2", taskMutationUnavailable("the unmutated tests fail")))
      .toBe("Task mutation check for T2: unavailable — the unmutated tests fail. It did not decide and will not block your stop.");
  });

  it("names the invalid mutants of a clean run apart from the ones its tests killed", () => {
    expect(renderTaskMutationReport("T2", talliedResult({ killed: 1, invalid: 2, candidates: 6 })).split("\n")).toEqual([
      "Task mutation check for T2: clean — your tests killed all 1 mutant(s) they could judge (of 6 site(s) on changed lines).",
      "2 more mutant(s) only broke test collection or ran no test, so they are no evidence either way.",
    ]);
  });

  it("reports a run whose every mutant was invalid as inconclusive, never as clean or killed", () => {
    const report = renderTaskMutationReport("T2", INCONCLUSIVE_RESULT);
    expect(report).toBe(
      "Task mutation check for T2: inconclusive — none of its 2 mutant(s) could be judged, because each only broke test collection " +
      "or ran no test (of 4 site(s) on changed lines). Check that your tests import the changed file and run. " +
      "It did not decide and will not block your stop.");
    expect(report).not.toContain("clean");
    expect(report).not.toContain("killed");
  });

  it("property: no report claims a kill the result does not count", () => {
    fc.assert(fc.property(resultArb, (result) => {
      const report = renderTaskMutationReport("T2", result);
      const killed = result.kind === "clean" || result.kind === "survivors" ? result.killed : 0;
      if (killed === 0) expect(report).not.toMatch(/killed all/);
    }));
  });

  it("names each survivor with its place, operator, change and killing test, and how to answer an equivalent mutant", () => {
    const report = renderTaskMutationReport("T2", SURVIVORS_RESULT);
    expect(report.split("\n")[0]).toBe("Task mutation check for T2: 2 of 2 mutant(s) survived (of 9 site(s) on changed lines).");
    expect(report).toContain(`- ${IMPL}:2:3 guard-removal: \`if (amount <= 0) throw new Error();\` → \`;\`\n  killed by: ${KILLING_TEST["guard-removal"]}`);
    expect(report).toContain(`- ${IMPL}:7:3 comparison-flip:`);
    expect(report).toContain("(no test ran for this file)");
    expect(report).toContain("an equivalent mutant");
  });

  it("cuts a long original to one bounded line", () => {
    const long = taskMutationResultOf([{ mutant: { ...mutant(IMPL, 2), original: `if (x) {\n${"  return 1;\n".repeat(40)}}` }, outcome: "survived" }], 1);
    const [, survivorLine] = renderTaskMutationReport("T2", long).split("\n");
    expect(survivorLine).toContain("…");
    expect(survivorLine!.length).toBeLessThan(220);
  });

  it.each([
    [{ kind: "not-run" as const }, "The check has not run for this Task."],
    [{ kind: "stale" as const }, "Your files changed after the check last ran"],
  ])("a block for %j says why, gives the command, and counts the blocks left", (cause, why) => {
    const block = renderTaskMutationBlock(cause, COMMAND, 1);
    expect(block).toContain(why);
    expect(block).toContain(`  ${COMMAND}`);
    expect(block).toContain(`timeout of ${TASK_MUTATION_BASH_TIMEOUT_MS} ms`);
    expect(block).toContain("at most 1 more time(s)");
  });

  it("a block for survivors lists them as the helper does", () => {
    if (SURVIVORS_RESULT.kind !== "survivors") throw new Error("fixture");
    const block = renderTaskMutationBlock({ kind: "survivors", survivors: SURVIVORS_RESULT.survivors }, COMMAND, 0);
    expect(block).toContain(`- ${IMPL}:2:3 guard-removal:`);
    expect(block).toContain("at most 0 more time(s)");
  });

  it("leaves the tool call room beyond the run's own deadline", () => {
    expect(TASK_MUTATION_DEADLINE_MS).toBe(480_000);
    expect(TASK_MUTATION_BASH_TIMEOUT_MS).toBeGreaterThan(TASK_MUTATION_DEADLINE_MS);
  });
});
