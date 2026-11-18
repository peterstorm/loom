/**
 * The Task owner check's pure core (ADR-0092):
 * - `isSettledAtStop` / `duePathsAtStop`: the family schedule read at one
 *   Task's stop, a subset of what the gate asks by the same Wave;
 * - `taskOwnerCheckDuty`: who owes the check, over which obligations, and
 *   whether the Task answers each one's findings;
 * - `taskOwnerCheckDigest`: order-independent and sensitive to every input;
 * - the record's wire form: round-trips, and refuses what it cannot parse;
 * - `sortTaskOwnerFindings` and `taskOwnerCheckStopVerdict`: what blocks,
 *   what is noted, what passes;
 * - the helper report and the block message.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { duePaths, duePathsAtStop, isSettledAtStop, type ScheduledTask } from "../../src/core/owner-verification/obligations";
import { verifiedMutationOf } from "../../src/core/owner-verification/outcome";
import type {
  CoverageVerdict,
  InvariantVerdict,
  MutationVerdict,
  OwnerObligation,
  SurvivorDiagnostic,
} from "../../src/core/owner-verification/types";
import {
  judgeTaskOwnerCheck,
  parseTaskOwnerCheckRecord,
  recordedTaskOwnerCheck,
  renderTaskOwnerCheckBlock,
  renderTaskOwnerCheckReport,
  sortTaskOwnerFindings,
  TASK_OWNER_CHECK_BASH_TIMEOUT_MS,
  taskOwnerCheckDigest,
  taskOwnerCheckDuty,
  taskOwnerCheckRecordJson,
  taskOwnerCheckResult,
  taskOwnerCheckStopVerdict,
  taskOwnerCheckUnavailable,
  type JudgedObligation,
  type OwedTaskOwnerCheck,
  type RecordedTaskOwnerCheck,
  type TaskOwnerCheckGraph,
  type TaskOwnerCheckObservation,
  type TaskOwnerCheckResult,
} from "../../src/core/task-owner-check";
import { TASK_RECORD_CHECK_OFF, TASK_RECORD_NOT_RUN, taskRecordStanding, type TaskRecordDigest } from "../../src/core/task-record";
import type { Task } from "../../src/types";
import { contract, task } from "../fixtures/contract-status-fixtures";
import { ownerObligation } from "../fixtures/owner-obligation";
import { taskFixture } from "../fixtures/task-lifecycle";
import { mutationManifest } from "../fixtures/task-mutation";

const OWNER = "src/rules/owner.ts";
const SIBLING_A = "src/rules/a.ts";
const SIBLING_B = "src/rules/b.ts";
const MATRIX = "tests/rules.matrix.test.ts";
const START = "b".repeat(40);

const ADMISSION: OwnerObligation = ownerObligation({
  invariant: "INV-1",
  title: "Admission is decided only by the owner",
  statement: null,
  owner: OWNER,
  siblings: [{ path: SIBLING_A, note: null }, { path: SIBLING_B, note: null }],
  matrixTest: MATRIX,
  mutation: { kind: "verify" },
});

const withStart = (built: Task): Task => ({ ...built, start_sha: START });

/** A stamped graph over `tasks`, with the affected runner frozen. */
const graphOf = (tasks: readonly Task[], extra: Partial<TaskOwnerCheckGraph> = {}): TaskOwnerCheckGraph => ({
  tasks: [...tasks],
  owner_obligations: [ADMISSION],
  verification_manifest: mutationManifest(),
  ...extra,
});

const owed = (graph: TaskOwnerCheckGraph, taskId: string): OwedTaskOwnerCheck => {
  const duty = taskOwnerCheckDuty(graph, taskId);
  if (duty.kind !== "owed") throw new Error(`fixture: ${taskId} owes nothing (${duty.reason})`);
  return duty;
};

// A Wave in which T1 writes the owner and the matrix test, T2 a sibling, and Wave 2's T3 the other sibling.
const T1 = withStart(task("T1", 1, [OWNER, MATRIX]));
const T2 = withStart(task("T2", 1, [SIBLING_A]));
const T3 = withStart(task("T3", 2, [SIBLING_B]));
const FAMILY = graphOf([T1, T2, T3]);

describe("isSettledAtStop / duePathsAtStop — the family schedule at one Task's stop", () => {
  it("a path is settled when nobody lists it, an earlier Wave does or the stopping Task does; never when only a concurrent Task does", () => {
    expect(isSettledAtStop(FAMILY.tasks, T1, OWNER)).toBe(true);
    expect(isSettledAtStop(FAMILY.tasks, T2, OWNER)).toBe(false);
    expect(isSettledAtStop(FAMILY.tasks, T3, OWNER)).toBe(true);
    expect(isSettledAtStop(FAMILY.tasks, T1, SIBLING_A)).toBe(false);
    expect(isSettledAtStop(FAMILY.tasks, T1, "src/rules/unlisted.ts")).toBe(true);
  });

  it("names the owner first, then each settled sibling, in declared order", () => {
    expect(duePathsAtStop(FAMILY.tasks, T1, ADMISSION)).toEqual([OWNER]);
    expect(duePathsAtStop(FAMILY.tasks, T2, ADMISSION)).toEqual([OWNER, SIBLING_A]);
    expect(duePathsAtStop(FAMILY.tasks, T3, ADMISSION)).toEqual([OWNER, SIBLING_A, SIBLING_B]);
  });

  const familyPath = fc.constantFrom(SIBLING_A, SIBLING_B, OWNER, MATRIX);
  const scheduled = fc.array(
    fc.record({ wave: fc.integer({ min: 1, max: 3 }), files: fc.uniqueArray(familyPath, { maxLength: 3 }) }),
    { minLength: 1, maxLength: 5 },
  ).map((specs): readonly ScheduledTask[] => specs.map(({ wave, files }, index) => ({ id: `T${index + 1}`, wave, file_list: files })));

  it("property: the stop asks a subset of what the gate asks by the stopping Task's Wave, the owner always first", () => {
    fc.assert(fc.property(scheduled, fc.nat(), (tasks, pick) => {
      const stopping = tasks[pick % tasks.length]!;
      const atStop = duePathsAtStop(tasks, stopping, ADMISSION);
      const byWave = duePaths(tasks, stopping.wave, ADMISSION);
      expect(atStop[0]).toBe(OWNER);
      expect(atStop.every((path) => byWave.includes(path))).toBe(true);
    }));
  });

  it("property: a sibling the stopping Task lists is due at its stop; one only a concurrent Task lists is not", () => {
    fc.assert(fc.property(scheduled, fc.nat(), (tasks, pick) => {
      const stopping = tasks[pick % tasks.length]!;
      const atStop = duePathsAtStop(tasks, stopping, ADMISSION);
      for (const sibling of [SIBLING_A, SIBLING_B]) {
        const listers = tasks.filter((other) => (other.file_list ?? []).includes(sibling));
        if ((stopping.file_list ?? []).includes(sibling)) expect(atStop).toContain(sibling);
        if (listers.length === 0) expect(atStop).toContain(sibling);
        if (listers.length > 0 && listers.every((other) => other.id !== stopping.id && other.wave === stopping.wave)) {
          expect(atStop).not.toContain(sibling);
        }
      }
    }));
  });
});

describe("taskOwnerCheckDuty — who owes the check, and over what", () => {
  it("owes the Task writing the owner and the matrix test, which answers its findings", () => {
    const duty = owed(FAMILY, "T1");
    expect(duty.obligations).toEqual([{ obligation: ADMISSION, due: [OWNER], answers: true }]);
    expect(duty.startSha).toBe(START);
    expect(duty.digested).toEqual([OWNER, MATRIX]);
  });

  it("owes nothing to a sibling writer whose owner a concurrent Task is still writing", () => {
    expect(taskOwnerCheckDuty(FAMILY, "T2")).toEqual({ kind: "off", reason: "nothing-owed" });
  });

  it("owes a later Wave's sibling writer, which does not answer the matrix test's findings", () => {
    const duty = owed(FAMILY, "T3");
    expect(duty.obligations).toEqual([{ obligation: ADMISSION, due: [OWNER, SIBLING_A, SIBLING_B], answers: false }]);
    expect(duty.digested).toEqual([OWNER, SIBLING_A, SIBLING_B, MATRIX]);
  });

  it("carries the frozen runner when an owed obligation needs mutation, and none when every one is exempt", () => {
    const duty = owed(FAMILY, "T1");
    expect(duty.mutation === "owed" && duty.runner).toEqual(mutationManifest().affectedRunner);
    const exempt = ownerObligation({ ...ADMISSION, mutation: { kind: "exempt", reason: "the rule is a lookup table no mutant can change" } });
    const exemptOnly = owed({ ...graphOf([T1]), owner_obligations: [exempt], verification_manifest: mutationManifest({ affectedRunner: undefined }) }, "T1");
    expect(exemptOnly.mutation).toBe("exempt-only");
    expect("runner" in exemptOnly).toBe(false);
  });

  it("owes no duty it could not run: an obligation needing mutation with no runner frozen is off, never a runner-less duty", () => {
    expect(taskOwnerCheckDuty({ ...graphOf([T1]), verification_manifest: mutationManifest({ affectedRunner: undefined }) }, "T1"))
      .toEqual({ kind: "off", reason: "no-affected-runner" });
  });

  it("owes nothing for a family whose matrix test a concurrent Task is still writing", () => {
    const graph = graphOf([withStart(task("T1", 1, [OWNER])), withStart(task("T2", 1, [MATRIX]))]);
    expect(taskOwnerCheckDuty(graph, "T1")).toEqual({ kind: "off", reason: "nothing-owed" });
    expect(taskOwnerCheckDuty(graph, "T2")).toEqual({ kind: "off", reason: "nothing-owed" });
  });

  it("owes nothing for a Wave that changes only the matrix test: the gate owes nothing either", () => {
    expect(taskOwnerCheckDuty(graphOf([withStart(task("T1", 1, [MATRIX]))]), "T1")).toEqual({ kind: "off", reason: "nothing-owed" });
  });

  it.each([
    ["unknown-task", FAMILY, "T9"],
    ["unstamped", { ...FAMILY, owner_obligations: undefined }, "T1"],
    ["exempt-role", graphOf([T1, taskFixture({ ...task("T4", 1, [OWNER]), agent: "distill-agent" })]), "T4"],
    ["decision-record-task", graphOf([taskFixture({ ...task("T1", 1, [OWNER, MATRIX]), agent: "adr-writer-agent" })]), "T1"],
    ["contract-task", graphOf([T1], {
      acceptance_contracts: [contract({
        id: "CT-1", contractTask: "T1", surface: { types: "src/types.ts", acceptance: "tests/ct1.acceptance.test.ts" },
        anchors: ["FR-001"], freeze: { state: "awaiting-red" },
      })],
    }), "T1"],
    ["nothing-owed", graphOf([withStart(task("T1", 1, ["src/other.ts"]))]), "T1"],
  ] as const)("is off as %s", (reason, graph, taskId) => {
    expect(taskOwnerCheckDuty(graph, taskId)).toEqual({ kind: "off", reason });
  });
});

describe("taskOwnerCheckDigest", () => {
  const duty = owed(FAMILY, "T1");
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
  const files = [{ path: OWNER, bytes: bytes("owner") }, { path: MATRIX, bytes: bytes("matrix") }];

  it("does not depend on the order the files are given in", () => {
    expect(taskOwnerCheckDigest(duty, files)).toBe(taskOwnerCheckDigest(duty, [...files].reverse()));
  });

  it("changes with a byte, a file's absence, the base or the owed obligations", () => {
    const base = taskOwnerCheckDigest(duty, files);
    expect(taskOwnerCheckDigest(duty, [{ path: OWNER, bytes: bytes("owneR") }, files[1]!])).not.toBe(base);
    expect(taskOwnerCheckDigest(duty, [{ path: OWNER, bytes: null }, files[1]!])).not.toBe(base);
    expect(taskOwnerCheckDigest({ ...duty, startSha: "c".repeat(40) }, files)).not.toBe(base);
    expect(taskOwnerCheckDigest({ ...duty, obligations: [{ ...duty.obligations[0], answers: false }] }, files)).not.toBe(base);
  });
});

// --- Verdicts ---

const COVERED: CoverageVerdict = { kind: "covered" };
const SURVIVOR: SurvivorDiagnostic = {
  mutantId: "m1", operator: "comparison-flip", line: 2, column: 11, original: "age >= 18", replacement: "age < 18",
};

function verified(survivors: readonly SurvivorDiagnostic[]): MutationVerdict {
  const built = verifiedMutationOf({ killed: 3, timedOut: 0, invalid: 0, survivors, unmutated: 0, ownerChangedInWave: true });
  if (!built.ok) throw new Error(built.error.kind);
  return built.value;
}

const verdict = (coverage: CoverageVerdict, mutation: MutationVerdict): InvariantVerdict => ({
  invariant: ADMISSION.invariant, title: ADMISSION.title, owner: OWNER, matrixTest: MATRIX, coverage, mutation,
});

const CLEAN = taskOwnerCheckResult([verdict(COVERED, verified([]))]);
const SURVIVORS = taskOwnerCheckResult([verdict(COVERED, verified([SURVIVOR]))]);
const MISSING = taskOwnerCheckResult([verdict({ kind: "missing", paths: [SIBLING_B] }, verified([]))]);
const RED = taskOwnerCheckResult([verdict(COVERED, { kind: "red-baseline", failures: ["matrix > admits"] })]);
const REFUSED = taskOwnerCheckResult([verdict(COVERED, {
  kind: "infrastructure", failure: { kind: "spawn-failed", detail: "the runner could not start: not launched: the deadline" },
})]);
const MIXED = taskOwnerCheckResult([verdict({ kind: "missing", paths: [SIBLING_B] }, { kind: "red-baseline", failures: ["matrix > admits"] })]);

/** A record of one run over `duty`, through its one constructor; a refusal is a broken fixture. */
function recorded(duty: OwedTaskOwnerCheck, digest: TaskRecordDigest, result: TaskOwnerCheckResult): RecordedTaskOwnerCheck {
  const built = recordedTaskOwnerCheck(duty, digest, result);
  if (!built.ok) throw new Error(`fixture: ${built.error}`);
  return built.value;
}

/** The judged obligations of `result` under `duty`; a result the duty refuses is a broken fixture. */
function judgedOf(duty: OwedTaskOwnerCheck, result: TaskOwnerCheckResult): readonly JudgedObligation[] {
  const judgement = judgeTaskOwnerCheck(duty, result);
  if (judgement.kind !== "judged") throw new Error(`fixture: ${judgement.reason}`);
  return judgement.judged;
}

const FOREIGN = taskOwnerCheckResult([{ ...verdict(COVERED, verified([SURVIVOR])), invariant: ownerObligation({ ...ADMISSION, invariant: "INV-7" }).invariant }]);

describe("the record's wire form", () => {
  const DUTY = owed(FAMILY, "T1");
  const DIGEST = taskOwnerCheckDigest(DUTY, []);

  it.each([
    ["clean", CLEAN], ["survivors", SURVIVORS], ["missing", MISSING], ["red baseline", RED], ["refused run", REFUSED],
    ["unavailable", taskOwnerCheckUnavailable("no Git repository here")],
  ] as const)("round-trips a %s result", (_name, result) => {
    const record = recorded(DUTY, DIGEST, result);
    expect(parseTaskOwnerCheckRecord(JSON.parse(taskOwnerCheckRecordJson(record)))).toEqual({ ok: true, value: record });
  });

  it("serializes equal records to equal bytes", () => {
    expect(taskOwnerCheckRecordJson(recorded(DUTY, DIGEST, CLEAN)))
      .toBe(taskOwnerCheckRecordJson(recorded(DUTY, DIGEST, taskOwnerCheckResult([verdict(COVERED, verified([]))]))));
  });

  it("refuses to record a result for an Invariant the duty does not owe, or a duty with no Task id", () => {
    expect(recordedTaskOwnerCheck(DUTY, DIGEST, FOREIGN)).toEqual({
      ok: false, error: "the result is not of this duty: it judged INV-7, which Task T1 does not owe at its stop",
    });
    expect(recordedTaskOwnerCheck({ ...DUTY, taskId: "" }, DIGEST, CLEAN)).toEqual({ ok: false, error: "a Task owner record needs a Task id" });
  });

  const valid = (): Record<string, unknown> => JSON.parse(taskOwnerCheckRecordJson(recorded(DUTY, DIGEST, SURVIVORS)));
  it.each([
    ["another schema", (raw: Record<string, unknown>) => ({ ...raw, schemaVersion: 2 }), "schemaVersion must be 1"],
    ["another kind", (raw: Record<string, unknown>) => ({ ...raw, kind: "loom-task-mutation-record" }), "kind must be"],
    ["an unknown key", (raw: Record<string, unknown>) => ({ ...raw, extra: 1 }), "unknown key(s) extra"],
    ["a digest that is not sha256", (raw: Record<string, unknown>) => ({ ...raw, digest: "abc" }), "sha256 hex digest"],
    ["no verdict", (raw: Record<string, unknown>) => ({ ...raw, result: { kind: "verdicts", verdicts: [] } }), "at least one verdict"],
    ["a verdict the gate's parser refuses", (raw: Record<string, unknown>) => ({ ...raw, result: { kind: "verdicts", verdicts: [{}] } }), "verdicts[0]"],
    ["a blank unavailable reason", (raw: Record<string, unknown>) => ({ ...raw, result: { kind: "unavailable", reason: "" } }), "reason must be"],
  ] as const)("refuses %s", (_name, corrupt, message) => {
    const parsed = parseTaskOwnerCheckRecord(corrupt(valid()));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });
});

describe("sortTaskOwnerFindings — who answers each finding", () => {
  const answering = owed(FAMILY, "T1");
  const reporting = owed(FAMILY, "T3");

  it("a Task listing the matrix test answers a missing path and a survivor", () => {
    expect(sortTaskOwnerFindings(judgedOf(answering, MISSING)).blocking.map(({ kind }) => kind)).toEqual(["missing-siblings"]);
    expect(sortTaskOwnerFindings(judgedOf(answering, SURVIVORS)).blocking.map(({ kind }) => kind)).toEqual(["survivor"]);
  });

  it("a Task not listing the matrix test only reports them, naming the file that answers", () => {
    const sorted = sortTaskOwnerFindings(judgedOf(reporting, SURVIVORS));
    expect(sorted.blocking).toEqual([]);
    expect(sorted.noted).toEqual([expect.stringContaining(`only ${MATRIX} answers this, and this Task does not list it`)]);
  });

  it("a red baseline and an infrastructure verdict are noted for any Task", () => {
    for (const duty of [answering, reporting]) {
      expect(sortTaskOwnerFindings(judgedOf(duty, RED))).toEqual({ blocking: [], noted: [expect.stringContaining("is red against the unmutated workspace")] });
      expect(sortTaskOwnerFindings(judgedOf(duty, REFUSED))).toEqual({ blocking: [], noted: [expect.stringContaining("infrastructure failure (spawn-failed)")] });
    }
  });

  it("a result for an Invariant the duty does not owe is never judged: it reads as unavailable", () => {
    expect(judgeTaskOwnerCheck(answering, FOREIGN)).toEqual({
      kind: "unavailable", reason: "its record is not of this duty: it judged INV-7, which Task T1 does not owe at its stop",
    });
  });
});

describe("taskOwnerCheckStopVerdict — what one stop does", () => {
  const duty = owed(FAMILY, "T1");
  const COMMAND = "bun cli.ts helper owner-check --task 'T1'";
  const current = (result: TaskOwnerCheckResult): TaskOwnerCheckObservation =>
    ({ kind: "observed", duty, standing: { kind: "current", result }, command: COMMAND });

  it("is idle when the Task owes nothing", () => {
    expect(taskOwnerCheckStopVerdict("T1", TASK_RECORD_CHECK_OFF)).toEqual({ kind: "idle" });
  });

  it("blocks for a record that is missing or stale", () => {
    for (const standing of [{ kind: "not-run" }, { kind: "stale" }] as const) {
      expect(taskOwnerCheckStopVerdict("T1", { kind: "observed", duty, standing, command: COMMAND }))
        .toEqual({ kind: "failing", cause: standing, command: COMMAND });
    }
  });

  it("blocks for a finding the Task answers, carrying the findings it only reports", () => {
    const decided = taskOwnerCheckStopVerdict("T1", current(MIXED));
    expect(decided.kind).toBe("failing");
    if (decided.kind !== "failing" || decided.cause.kind !== "findings") throw new Error("a missing path the Task answers blocks");
    expect(decided.cause.findings.map(({ kind }) => kind)).toEqual(["missing-siblings"]);
    expect(decided.cause.noted).toEqual([expect.stringContaining("is red against the unmutated workspace")]);
  });

  it("passes a current clean record", () => {
    expect(taskOwnerCheckStopVerdict("T1", current(CLEAN))).toEqual({ kind: "passed" });
  });

  it.each([
    ["a red baseline", RED, "is red against the unmutated workspace"],
    ["a refused run", REFUSED, "spawn-failed"],
    ["an unavailable run", taskOwnerCheckUnavailable("the family's files changed"), "its last run was unavailable: the family's files changed"],
  ] as const)("notes %s, and the stop proceeds", (_name, result, detail) => {
    const decided = taskOwnerCheckStopVerdict("T1", current(result));
    expect(decided).toEqual({ kind: "note", note: expect.stringContaining(detail) });
    if (decided.kind === "note") expect(decided.note).toMatch(/the stop proceeds and the Wave Gate judges$/);
  });

  it("notes a survivor the Task does not answer", () => {
    const reporting = owed(FAMILY, "T3");
    expect(taskOwnerCheckStopVerdict("T3", { kind: "observed", duty: reporting, standing: { kind: "current", result: SURVIVORS }, command: COMMAND }))
      .toEqual({ kind: "note", note: expect.stringContaining("this Task does not list it") });
  });

  it("notes a current record that judged an Invariant the duty does not owe", () => {
    expect(taskOwnerCheckStopVerdict("T1", current(FOREIGN)))
      .toEqual({ kind: "note", note: expect.stringContaining("its record is not of this duty: it judged INV-7") });
  });

  it("notes every fault", () => {
    expect(taskOwnerCheckStopVerdict("T1", { kind: "unavailable", reason: "EIO" }))
      .toEqual({ kind: "note", note: "Task owner check for T1 did not hold the stop (EIO); the stop proceeds and the Wave Gate judges" });
  });

  it("reads a record of another Task or other bytes as stale", () => {
    const digest = taskOwnerCheckDigest(duty, []);
    const other = taskOwnerCheckDigest(duty, [{ path: OWNER, bytes: null }]);
    expect(taskRecordStanding(TASK_RECORD_NOT_RUN, "T1", digest)).toEqual({ kind: "not-run" });
    expect(taskRecordStanding(recorded(duty, digest, CLEAN), "T1", digest)).toEqual({ kind: "current", result: CLEAN });
    expect(taskRecordStanding(recorded(duty, other, CLEAN), "T1", digest)).toEqual({ kind: "stale" });
    expect(taskRecordStanding(recorded(duty, digest, CLEAN), "T2", digest)).toEqual({ kind: "stale" });
  });
});

describe("what the implementer reads", () => {
  const duty = owed(FAMILY, "T1");

  it("the report names each verdict, then each finding in the gate's words and how to answer it", () => {
    const report = renderTaskOwnerCheckReport("T1", judgeTaskOwnerCheck(duty, SURVIVORS));
    expect(report).toContain("Task owner check for T1: 1 finding(s) this Task answers in its matrix test.");
    expect(report).toContain(`- INV-1 (matrix test ${MATRIX}): coverage reaches every path due at this stop; mutation generated 4`);
    expect(report).toContain(`INV-1: mutant survived at ${OWNER}:2:11 (comparison-flip)`);
    expect(report).toContain("For a survivor, add an assertion to the matrix test");
  });

  it("the report of a clean, a noted and an unavailable run", () => {
    expect(renderTaskOwnerCheckReport("T1", judgeTaskOwnerCheck(duty, CLEAN)).split("\n")[0]).toBe("Task owner check for T1: clean.");
    expect(renderTaskOwnerCheckReport("T1", judgeTaskOwnerCheck(duty, RED))).toContain("nothing for this Task to answer.\n");
    expect(renderTaskOwnerCheckReport("T1", judgeTaskOwnerCheck(duty, taskOwnerCheckUnavailable("no root"))))
      .toBe("Task owner check for T1: unavailable — no root. It did not decide and will not block your stop.");
  });

  it("the block repeats the command with its timeout and the blocks left", () => {
    const block = renderTaskOwnerCheckBlock({ kind: "not-run" }, "CMD", 1);
    expect(block).toContain("The check has not run for this Task.");
    expect(block).toContain(`timeout of ${TASK_OWNER_CHECK_BASH_TIMEOUT_MS} ms`);
    expect(block).toContain("\n  CMD\n");
    expect(block).toContain("blocks at most 1 more time(s)");
  });
});
