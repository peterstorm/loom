/**
 * Unit and property tests for the stop-check-plan core: `stopCheckPlanView`
 * projects a TaskGraph and Task id into the view the Acceptance Stop Check
 * would act on, and `renderStopCheckPlan` prints it in the frozen line
 * grammar. Every owed fact is compared against `stopCheckExpectation` and
 * `acceptanceRunnerCheck` called on the same graph, so the tests pin reuse
 * (FR-002) rather than a second derivation. A property runs the live check
 * itself over every generated graph, so the plan and the check cannot drift.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AcceptanceContract, AcceptanceTestcase } from "../../src/core/acceptance-contract";
import type { NonEmpty } from "../../src/core/orchestration-contract";
import { stopCheckExpectation } from "../../src/core/acceptance-contract/stop-check";
import { renderStopCheckPlan, stopCheckPlanView } from "../../src/core/acceptance-contract/stop-check-plan";
import { STOP_CHECK_ON, UNKNOWN_TASK_PREFIX } from "../../src/core/stop-check-plan-types";
import { acceptanceRunnerCheck, type FrozenVerificationManifest } from "../../src/core/verification-manifest";
import { UNKEPT_BLOCK_COUNTERS, type StopCheckShellPorts } from "../../src/handlers/subagent-stop/acceptance-stop-check";
import { runStopChecks } from "../../src/handlers/subagent-stop/stop-checks";
import type { StopChecksOutcome } from "../../src/core/affected-stop-check-types";
import { NO_CHANGED_FILES } from "../../src/core/changed-files";
import type { Task, TaskGraph } from "../../src/types";
import { parseCanonicalRepositoryRoot } from "../../src/utils/workspace-digest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { task } from "../fixtures/contract-status-fixtures";
import {
  ENGINE_RUNNER,
  awaitingRedContract,
  frozenContract,
  frozenRunnerManifest,
  offLine,
} from "../fixtures/stop-check-plan-fixtures";
import { ACCEPTANCE_REPORT } from "../fixtures/stop-check-runners";
import { graphFixture } from "../fixtures/task-lifecycle";

const TYPES = "engine/src/core/ledger-types.ts";
const LEDGER = "engine/tests/acceptance/ledger.acceptance.test.ts";
const REPLAY = "engine/tests/acceptance/replay.acceptance.test.ts";
const OUTSIDE = "pi/tests/ledger.acceptance.test.ts";
const DEBIT = "ledger > AS-001: a debit lowers the balance";
const IDEMPOTENT = "replay > AS-002: a replayed entry changes nothing";

const ROOT_RUNNER = Object.freeze({ ...ENGINE_RUNNER, cwd: "." });

/** A TaskGraph value; the renderer is total over these, parser-admitted or not. */
const graphOf = (
  tasks: readonly Task[],
  contracts?: readonly AcceptanceContract[],
  manifest?: FrozenVerificationManifest,
): TaskGraph => ({
  ...graphFixture(tasks),
  ...(contracts === undefined ? {} : { acceptance_contracts: contracts }),
  ...(manifest === undefined ? {} : { verification_manifest: manifest }),
});

const ledgerContract = (file = LEDGER): AcceptanceContract => frozenContract({
  id: "CT-1",
  types: TYPES,
  files: [{ path: file, anchors: ["AS-001"] }],
  roster: [{ file, name: DEBIT, anchors: ["AS-001"] }],
});

const replayContract = (): AcceptanceContract => frozenContract({
  id: "CT-2",
  types: TYPES,
  files: [{ path: REPLAY, anchors: ["AS-002"] }],
  roster: [{ file: REPLAY, name: IDEMPOTENT, anchors: ["AS-002"] }],
});

const claimant = (anchors: readonly string[] = ["AS-001"]): readonly Task[] => [
  task("T1", 1, [TYPES, LEDGER, REPLAY]),
  task("T2", 2, ["engine/src/core/ledger.ts"], anchors),
];

describe("stopCheckPlanView", () => {
  it("is unknown-task for an id absent from the TaskGraph", () => {
    expect(stopCheckPlanView(graphOf(claimant(), [ledgerContract()], frozenRunnerManifest()), "T9"))
      .toEqual({ kind: "unknown-task", taskId: "T9" });
  });

  it("is off for no-runner when the graph carries no manifest or a manifest without a runner", () => {
    for (const manifest of [undefined, frozenRunnerManifest(null)]) {
      expect(stopCheckPlanView(graphOf(claimant(), [ledgerContract()], manifest), "T2"))
        .toEqual({ kind: "off", taskId: "T2", wave: 2, reason: { kind: "no-runner" } });
    }
  });

  it("is off for nothing-owed when the Task claims nothing, or no contracts exist", () => {
    expect(stopCheckPlanView(graphOf(claimant([]), [ledgerContract()], frozenRunnerManifest()), "T2"))
      .toEqual({ kind: "off", taskId: "T2", wave: 2, reason: { kind: "nothing-owed" } });
    expect(stopCheckPlanView(graphOf(claimant(), undefined, frozenRunnerManifest()), "T2"))
      .toEqual({ kind: "off", taskId: "T2", wave: 2, reason: { kind: "nothing-owed" } });
  });

  it("is off for nothing-owed when the claimed contract awaits RED", () => {
    const contracts = [awaitingRedContract({ id: "CT-1", types: TYPES, files: [{ path: LEDGER, anchors: ["AS-001"] }] })];
    expect(stopCheckPlanView(graphOf(claimant(), contracts, frozenRunnerManifest()), "T2"))
      .toEqual({ kind: "off", taskId: "T2", wave: 2, reason: { kind: "nothing-owed" } });
  });

  it("is off for command-refused with acceptanceRunnerCheck's refusal text", () => {
    const view = stopCheckPlanView(graphOf(claimant(), [ledgerContract(OUTSIDE)], frozenRunnerManifest()), "T2");
    expect(view).toEqual({
      kind: "off",
      taskId: "T2",
      wave: 2,
      reason: { kind: "command-refused", errors: [`acceptanceRunner.cwd engine does not contain ${OUTSIDE}`] },
    });
  });

  it("precedence: no runner beats nothing owed beats command refused", () => {
    const refusedWithoutRunner = graphOf(claimant(), [ledgerContract(OUTSIDE)]);
    expect(stopCheckPlanView(refusedWithoutRunner, "T2")).toMatchObject({ kind: "off", reason: { kind: "no-runner" } });
    const nothingOwedWithoutRunner = graphOf(claimant([]), [ledgerContract()]);
    expect(stopCheckPlanView(nothingOwedWithoutRunner, "T2")).toMatchObject({ kind: "off", reason: { kind: "no-runner" } });
    const outsideButNotOwed = graphOf(claimant([]), [ledgerContract(OUTSIDE)], frozenRunnerManifest());
    expect(stopCheckPlanView(outsideButNotOwed, "T2")).toMatchObject({ kind: "off", reason: { kind: "nothing-owed" } });
  });

  it("is on with stopCheckExpectation's owed and files and acceptanceRunnerCheck's argv and cwd", () => {
    const graph = graphOf(claimant(["AS-001", "AS-002"]), [ledgerContract(), replayContract()], frozenRunnerManifest());
    const target = graph.tasks.find(({ id }) => id === "T2");
    const runner = graph.verification_manifest?.acceptanceRunner;
    if (target === undefined || runner === undefined) throw new Error("fixture lacks T2 or a runner");
    const expectation = stopCheckExpectation(graph.acceptance_contracts ?? [], graph.tasks, target);
    if (expectation.kind !== "owed") throw new Error("fixture owes nothing");
    const command = acceptanceRunnerCheck(runner, expectation.files);
    if (!command.ok) throw new Error("fixture command refused");

    const view = stopCheckPlanView(graph, "T2");

    expect(view).toEqual({
      kind: "on",
      taskId: "T2",
      wave: 2,
      owed: expectation.owed,
      files: expectation.files,
      command: { argv: [command.value.executable, ...command.value.args], cwd: command.value.cwd, reportPath: ACCEPTANCE_REPORT },
    });
    expect(Object.isFrozen(view)).toBe(true);
  });

  it("passes owed files unchanged when the runner cwd is '.'", () => {
    const view = stopCheckPlanView(graphOf(claimant(), [ledgerContract(OUTSIDE)], frozenRunnerManifest(ROOT_RUNNER)), "T2");
    expect(view).toMatchObject({ kind: "on", command: { argv: ["npm", "run", "test:acceptance", "--", OUTSIDE], cwd: "." } });
  });
});

describe("renderStopCheckPlan", () => {
  it("AS-001: renders the on grammar: header, owed testcases by contract, files, cwd, argv, report", () => {
    const lines = renderStopCheckPlan(graphOf(claimant(["AS-001", "AS-002"]), [ledgerContract(), replayContract()], frozenRunnerManifest()), "T2");
    expect(lines).toEqual({
      kind: "rendered",
      lines: [
        `T2 (Wave 2): ${STOP_CHECK_ON}`,
        "CT-1",
        `  ${LEDGER} › ${DEBIT}`,
        "CT-2",
        `  ${REPLAY} › ${IDEMPOTENT}`,
        "files:",
        `  ${LEDGER}`,
        `  ${REPLAY}`,
        "cwd: engine",
        `argv: ${JSON.stringify(["npm", "run", "test:acceptance", "--", "tests/acceptance/ledger.acceptance.test.ts", "tests/acceptance/replay.acceptance.test.ts"])}`,
        `report: ${ACCEPTANCE_REPORT}`,
      ],
    });
  });

  it("AS-002: a joint testcase whose second anchor is due later is not rendered", () => {
    const joint = "ledger > AS-001: AS-002: a reversal";
    const tasks = [...claimant(["AS-001"]), task("T3", 3, ["engine/src/core/reversal.ts"], ["AS-002"])];
    const contracts = [frozenContract({
      id: "CT-1",
      types: TYPES,
      files: [{ path: LEDGER, anchors: ["AS-001", "AS-002"] }],
      roster: [{ file: LEDGER, name: DEBIT, anchors: ["AS-001"] }, { file: LEDGER, name: joint, anchors: ["AS-001", "AS-002"] }],
    })];
    const rendering = renderStopCheckPlan(graphOf(tasks, contracts, frozenRunnerManifest()), "T2");
    expect(rendering.kind === "rendered" && rendering.lines.some((line) => line.includes(joint))).toBe(false);
    expect(rendering.kind === "rendered" && rendering.lines.includes(`  ${LEDGER} › ${DEBIT}`)).toBe(true);
  });

  it("AS-003: renders each off reason as one line, and command-refused with its errors indented", () => {
    expect(renderStopCheckPlan(graphOf(claimant(), [ledgerContract()]), "T2"))
      .toEqual({ kind: "rendered", lines: [offLine("T2", 2, "no-runner")] });
    expect(renderStopCheckPlan(graphOf(claimant([]), [ledgerContract()], frozenRunnerManifest()), "T2"))
      .toEqual({ kind: "rendered", lines: [offLine("T2", 2, "nothing-owed")] });
    expect(renderStopCheckPlan(graphOf(claimant(), [ledgerContract(OUTSIDE)], frozenRunnerManifest()), "T2"))
      .toEqual({
        kind: "rendered",
        lines: [offLine("T2", 2, "command-refused"), `  acceptanceRunner.cwd engine does not contain ${OUTSIDE}`],
      });
  });

  it("refuses an unknown id with the frozen message", () => {
    expect(renderStopCheckPlan(graphOf(claimant()), "T9"))
      .toEqual({ kind: "unknown-task", taskId: "T9", message: `${UNKNOWN_TASK_PREFIX} T9 in the TaskGraph` });
  });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

const ANCHORS: NonEmpty<string> = ["AS-001", "AS-002", "AS-003"];
const FILE_POOL = [LEDGER, REPLAY, OUTSIDE] as const;
const TASK_IDS = ["T1", "T2", "T3", "T4"] as const;

/** A non-empty, duplicate-free subset of `pool`, built head-first so no cast is needed. */
const nonEmptySubsetArb = (pool: NonEmpty<string>): fc.Arbitrary<NonEmpty<string>> =>
  fc.tuple(fc.constantFrom(...pool), fc.uniqueArray(fc.constantFrom(...pool)))
    .map(([head, rest]): NonEmpty<string> => [head, ...rest.filter((anchor) => anchor !== head)]);

/** One roster entry of contract `id` over `file`; the name is unique within the contract. */
const testcaseArb = (id: string, file: string, anchors: NonEmpty<string>, index: number): fc.Arbitrary<AcceptanceTestcase> =>
  nonEmptySubsetArb(anchors).map((entryAnchors) => ({ file, name: `${id} case ${index} ${entryAnchors.join(" ")}`, anchors: entryAnchors }));

/** A frozen or awaiting-RED contract over one acceptance file; roster names are unique across contracts. */
const contractArb = (index: number): fc.Arbitrary<AcceptanceContract> => {
  const id = `CT-${index + 1}`;
  return fc.tuple(nonEmptySubsetArb(ANCHORS), fc.constantFrom(...FILE_POOL), fc.boolean(), fc.nat({ max: 2 }))
    .chain(([anchors, file, frozen, extra]) => {
      const files: NonEmpty<{ path: string; anchors: NonEmpty<string> }> = [{ path: file, anchors }];
      if (!frozen) return fc.constant(awaitingRedContract({ id, types: TYPES, files }));
      const tail = Array.from({ length: extra }, (_, i) => testcaseArb(id, file, anchors, i + 1));
      return fc.tuple(testcaseArb(id, file, anchors, 0), fc.tuple(...tail))
        .map(([head, rest]) => frozenContract({ id, types: TYPES, files, roster: [head, ...rest] }));
    });
};

const contractsArb: fc.Arbitrary<readonly AcceptanceContract[]> = fc.nat({ max: 3 })
  .chain((count): fc.Arbitrary<readonly AcceptanceContract[]> => fc.tuple(...Array.from({ length: count }, (_, i) => contractArb(i))));

const tasksArb: fc.Arbitrary<readonly Task[]> = fc.uniqueArray(
  fc.record({ id: fc.constantFrom(...TASK_IDS), wave: fc.integer({ min: 1, max: 4 }), anchors: fc.uniqueArray(fc.constantFrom(...ANCHORS)) }),
  { selector: ({ id }) => id, minLength: 1 },
).map((rows) => rows.map(({ id, wave, anchors }) => task(id, wave, [`engine/src/${id}.ts`], anchors)));

const manifestArb: fc.Arbitrary<FrozenVerificationManifest | undefined> = fc.constantFrom(
  undefined,
  frozenRunnerManifest(null),
  frozenRunnerManifest(),
  frozenRunnerManifest(ROOT_RUNNER),
);

const graphArb: fc.Arbitrary<TaskGraph> = fc.tuple(tasksArb, contractsArb, manifestArb)
  .map(([tasks, contracts, manifest]) => graphOf(tasks, contracts, manifest));

const idArb = fc.constantFrom(...TASK_IDS, "T9");

const LIVE_ROOT = (() => {
  const parsed = parseCanonicalRepositoryRoot(canonicalTempDir("loom-stop-check-plan-root-"));
  if (!parsed.ok) throw new Error("root fixture");
  return parsed.value;
})();

type LiveStop = Readonly<{ outcome: StopChecksOutcome; launched: readonly Readonly<{ argv: readonly string[]; cwd: string }>[] }>;

/**
 * The live stop checks run once at `taskId`'s stop, with per-stop state that
 * never stops them: no block issued yet, a resolved repository root, a free
 * runner lock and no changed files (so the affected check never launches). It records each command it would launch; the launch
 * fails, so nothing is judged and nothing is blocked.
 */
async function liveStop(graph: TaskGraph, taskId: string): Promise<LiveStop> {
  const launched: { argv: readonly string[]; cwd: string }[] = [];
  const ports: StopCheckShellPorts = {
    repositoryRoot: () => ({ ok: true, root: LIVE_ROOT }),
    acquireRunner: () => ({ kind: "acquired", release: () => null }),
    runCheck: async (check) => {
      launched.push({ argv: [check.executable, ...check.args], cwd: check.cwd });
      return { ok: false, error: { kind: "containment-unsupported", message: "not launched by this test" } };
    },
    readReport: () => new Uint8Array(),
    blocks: UNKEPT_BLOCK_COUNTERS,
    pathExists: () => true,
    now: () => Date.now(),
  };
  const outcome = await runStopChecks({
    loadGraph: () => graph,
    stateFilePath: "/repo/.claude/state/active_task_graph.json",
    taskId,
    agentKey: "s.a",
    changedFiles: () => ({ kind: "observed", changed: NO_CHANGED_FILES }),
    hookStartedAtMs: Date.now(),
  }, ports);
  return { outcome, launched };
}

/** Whether `value` and every object or array reachable from it is frozen. */
function isDeeplyFrozen(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen);
}

/** Freezes `value` recursively, as the State File parser does to every TaskGraph it admits. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe("stop-check-plan properties", () => {
  it("adds no mutable structure: over a frozen graph, every view and rendering is deeply frozen", () => {
    fc.assert(fc.property(graphArb, idArb, (graph, taskId) => {
      const frozen = deepFreeze(graph);
      expect(isDeeplyFrozen(stopCheckPlanView(frozen, taskId))).toBe(true);
      expect(isDeeplyFrozen(renderStopCheckPlan(frozen, taskId))).toBe(true);
    }));
  });

  it("never throws, over every generated graph and id", () => {
    fc.assert(fc.property(graphArb, idArb, (graph, taskId) => {
      expect(() => renderStopCheckPlan(graph, taskId)).not.toThrow();
      expect(() => stopCheckPlanView(graph, taskId)).not.toThrow();
    }));
  });

  it("renders at least one line, or refuses as unknown-task exactly when the id is absent", () => {
    fc.assert(fc.property(graphArb, idArb, (graph, taskId) => {
      const rendering = renderStopCheckPlan(graph, taskId);
      const present = graph.tasks.some(({ id }) => id === taskId);
      expect(rendering.kind).toBe(present ? "rendered" : "unknown-task");
      if (rendering.kind === "rendered") expect(rendering.lines.length).toBeGreaterThanOrEqual(1);
    }));
  });

  it("agrees with the live check: on exactly when it launches the planned command, command-refused exactly when it notes the refusal, otherwise it skips", async () => {
    await fc.assert(fc.asyncProperty(graphArb, idArb, async (graph, taskId) => {
      const view = stopCheckPlanView(graph, taskId);
      const { outcome, launched } = await liveStop(graph, taskId);
      if (view.kind === "on") {
        expect(launched).toEqual([{ argv: view.command.argv, cwd: view.command.cwd }]);
        return;
      }
      expect(launched).toEqual([]);
      if (view.kind === "off" && view.reason.kind === "command-refused") {
        expect(outcome).toMatchObject({ kind: "note", message: expect.stringContaining(view.reason.errors.join("; ")) });
      } else {
        expect(outcome).toEqual({ kind: "skip" });
      }
    }));
  });

  it("an on rendering lists every owed testcase exactly once", () => {
    fc.assert(fc.property(graphArb, idArb, (graph, taskId) => {
      const view = stopCheckPlanView(graph, taskId);
      const rendering = renderStopCheckPlan(graph, taskId);
      if (view.kind !== "on" || rendering.kind !== "rendered") return;
      for (const { testcases } of view.owed) {
        for (const { file, name } of testcases) {
          expect(rendering.lines.filter((line) => line === `  ${file} › ${name}`)).toHaveLength(1);
        }
      }
    }));
  });
});
