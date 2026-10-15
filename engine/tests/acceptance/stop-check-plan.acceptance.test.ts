/**
 * CT-1 acceptance: what `helper stop-check-plan` shows for one Task.
 *
 * AS-001..AS-003 call the public pure renderer `renderStopCheckPlan` on
 * TaskGraphs the production State File parser admits, each carrying a
 * verification manifest frozen by the production freezer (or none, for the
 * AS-003 no-manifest case), and assert the exact output lines. AS-004 spawns `bun engine/src/cli.ts helper
 * stop-check-plan --task <id>` from the repository root with LOOM_STATE_PATH
 * naming a fixture State File in a canonical temp dir, and asserts the
 * refusal and the exit code. No Entry point is declared for the pure cases
 * (plan AD-4): the helper's own tests pin that it prints exactly these lines.
 */

import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { AcceptanceContract } from "../../src/core/acceptance-contract";
import { renderStopCheckPlan } from "../../src/core/acceptance-contract/stop-check-plan";
import {
  STOP_CHECK_OFF,
  STOP_CHECK_OFF_REASON_TEXT,
  STOP_CHECK_ON,
  UNKNOWN_TASK_PREFIX,
  type StopCheckOffReason,
} from "../../src/core/stop-check-plan-types";
import { acceptanceRunnerCheck } from "../../src/core/verification-manifest";
import type { Task } from "../../src/types";
import { gitProject, statePathIn, task, writeStateFile } from "../fixtures/contract-status-fixtures";
import {
  ACCEPTANCE_REPORT,
  awaitingRedContract,
  frozenContract,
  frozenRunnerManifest,
  runStopCheckPlanCli,
  stopCheckGraph,
} from "../fixtures/stop-check-plan-fixtures";

const LEDGER_TYPES = "engine/src/core/ledger-types.ts";
const LEDGER = "engine/tests/acceptance/ledger.acceptance.test.ts";
const REPLAY_TYPES = "engine/src/core/replay-types.ts";
const REPLAY = "engine/tests/acceptance/replay.acceptance.test.ts";

const DEBIT = "ledger > AS-001: a debit lowers the balance";
const CREDIT = "ledger > AS-001: a credit raises the balance";
const IDEMPOTENT = "replay > AS-002: a replayed entry changes nothing";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** CT-1 over the ledger file alone, frozen at Wave 1 with the debit and credit testcases. */
const ledgerContract = (): AcceptanceContract => frozenContract({
  id: "CT-1",
  types: LEDGER_TYPES,
  files: [{ path: LEDGER, anchors: ["AS-001"] }],
  roster: [
    { file: LEDGER, name: DEBIT, anchors: ["AS-001"] },
    { file: LEDGER, name: CREDIT, anchors: ["AS-001"] },
  ],
});

/** The single line an `off` view renders for a reason without errors. */
const offLine = (taskId: string, wave: number, reason: StopCheckOffReason["kind"]): string =>
  `${taskId} (Wave ${wave}): ${STOP_CHECK_OFF} — ${STOP_CHECK_OFF_REASON_TEXT[reason]}`;

/** The rendered lines of `taskId`, failing the test if the renderer refused it. */
function renderedLines(input: Parameters<typeof stopCheckGraph>[0], taskId: string): readonly string[] {
  const rendering = renderStopCheckPlan(stopCheckGraph(input).graph, taskId);
  expect(rendering.kind).toBe("rendered");
  return rendering.kind === "rendered" ? rendering.lines : [];
}

describe("stop-check-plan rendering (CT-1)", () => {
  it("AS-001: lists each owed testcase under its contract id, the acceptance files, and the runner command with each file as one argument", () => {
    const tasks: readonly Task[] = [
      task("T1", 1, [LEDGER_TYPES, LEDGER, REPLAY_TYPES, REPLAY]),
      task("T2", 2, ["engine/src/core/ledger.ts"], ["AS-001", "AS-002"]),
    ];
    const contracts = [
      ledgerContract(),
      frozenContract({
        id: "CT-2",
        types: REPLAY_TYPES,
        files: [{ path: REPLAY, anchors: ["AS-002"] }],
        roster: [{ file: REPLAY, name: IDEMPOTENT, anchors: ["AS-002"] }],
      }),
    ];

    const lines = renderedLines({ tasks, contracts, manifest: frozenRunnerManifest() }, "T2");

    expect(lines).toEqual([
      `T2 (Wave 2): ${STOP_CHECK_ON}`,
      "CT-1",
      `  ${LEDGER} › ${DEBIT}`,
      `  ${LEDGER} › ${CREDIT}`,
      "CT-2",
      `  ${REPLAY} › ${IDEMPOTENT}`,
      "files:",
      `  ${LEDGER}`,
      `  ${REPLAY}`,
      "cwd: engine",
      `argv: ${JSON.stringify([
        "npm", "run", "test:acceptance", "--",
        "tests/acceptance/ledger.acceptance.test.ts",
        "tests/acceptance/replay.acceptance.test.ts",
      ])}`,
      `report: ${ACCEPTANCE_REPORT}`,
    ]);
    expect(lines.some((line) => line.includes("{files}"))).toBe(false);
  });

  it("AS-002: omits a roster testcase whose anchors are not all due by the Task's Wave", () => {
    const joint = "ledger > AS-001: AS-002: a reversal restores the balance";
    const tasks: readonly Task[] = [
      task("T1", 1, [LEDGER_TYPES, LEDGER]),
      task("T2", 2, ["engine/src/core/ledger.ts"], ["AS-001"]),
      task("T3", 3, ["engine/src/core/reversal.ts"], ["AS-002"]),
    ];
    const contracts = [frozenContract({
      id: "CT-1",
      types: LEDGER_TYPES,
      files: [{ path: LEDGER, anchors: ["AS-001", "AS-002"] }],
      roster: [
        { file: LEDGER, name: DEBIT, anchors: ["AS-001"] },
        { file: LEDGER, name: joint, anchors: ["AS-001", "AS-002"] },
      ],
    })];

    const lines = renderedLines({ tasks, contracts, manifest: frozenRunnerManifest() }, "T2");

    expect(lines).toEqual([
      `T2 (Wave 2): ${STOP_CHECK_ON}`,
      "CT-1",
      `  ${LEDGER} › ${DEBIT}`,
      "files:",
      `  ${LEDGER}`,
      "cwd: engine",
      `argv: ${JSON.stringify(["npm", "run", "test:acceptance", "--", "tests/acceptance/ledger.acceptance.test.ts"])}`,
      `report: ${ACCEPTANCE_REPORT}`,
    ]);
    expect(lines.some((line) => line.includes(joint))).toBe(false);
  });

  it("AS-003: with no acceptance runner frozen, a Task that claims a frozen contract renders the check off for that reason", () => {
    const tasks: readonly Task[] = [
      task("T1", 1, [LEDGER_TYPES, LEDGER]),
      task("T2", 2, ["engine/src/core/ledger.ts"], ["AS-001"]),
    ];

    expect(renderedLines({ tasks, contracts: [ledgerContract()], manifest: frozenRunnerManifest(null) }, "T2"))
      .toEqual([offLine("T2", 2, "no-runner")]);
    expect(renderedLines({ tasks, contracts: [ledgerContract()] }, "T2"))
      .toEqual([offLine("T2", 2, "no-runner")]);
  });

  it("AS-003: a Task that claims nothing renders the check off as owing nothing", () => {
    const tasks: readonly Task[] = [
      task("T1", 1, [LEDGER_TYPES, LEDGER]),
      task("T2", 2, ["engine/src/core/ledger.ts"], ["AS-001"]),
      task("T3", 2, ["engine/src/core/audit.ts"]),
    ];

    expect(renderedLines({ tasks, contracts: [ledgerContract()], manifest: frozenRunnerManifest() }, "T3"))
      .toEqual([offLine("T3", 2, "nothing-owed")]);
  });

  it("AS-003: a Task claiming a contract still awaiting RED renders the check off as owing nothing", () => {
    const tasks: readonly Task[] = [
      task("T1", 1, [LEDGER_TYPES, LEDGER]),
      task("T2", 2, ["engine/src/core/ledger.ts"], ["AS-001"]),
    ];
    const contracts = [awaitingRedContract({ id: "CT-1", types: LEDGER_TYPES, files: [{ path: LEDGER, anchors: ["AS-001"] }] })];

    expect(renderedLines({ tasks, contracts, manifest: frozenRunnerManifest() }, "T2"))
      .toEqual([offLine("T2", 2, "nothing-owed")]);
  });

  it("AS-003: a Task whose claimed anchors are not yet due by its Wave renders the check off as owing nothing", () => {
    const tasks: readonly Task[] = [
      task("T1", 1, [LEDGER_TYPES, LEDGER]),
      task("T2", 2, ["engine/src/core/ledger.ts"], ["AS-001"]),
      task("T3", 3, ["engine/src/core/reversal.ts"], ["AS-002"]),
    ];
    const contracts = [frozenContract({
      id: "CT-1",
      types: LEDGER_TYPES,
      files: [{ path: LEDGER, anchors: ["AS-001", "AS-002"] }],
      roster: [{ file: LEDGER, name: "ledger > AS-001: AS-002: a reversal restores the balance", anchors: ["AS-001", "AS-002"] }],
    })];

    expect(renderedLines({ tasks, contracts, manifest: frozenRunnerManifest() }, "T2"))
      .toEqual([offLine("T2", 2, "nothing-owed")]);
  });

  it("AS-003: an owed file outside the runner cwd renders the check off with the runner's refusal", () => {
    const outside = "pi/tests/ledger.acceptance.test.ts";
    const tasks: readonly Task[] = [
      task("T1", 1, [LEDGER_TYPES, outside]),
      task("T2", 2, ["engine/src/core/ledger.ts"], ["AS-001"]),
    ];
    const contracts = [frozenContract({
      id: "CT-1",
      types: LEDGER_TYPES,
      files: [{ path: outside, anchors: ["AS-001"] }],
      roster: [{ file: outside, name: DEBIT, anchors: ["AS-001"] }],
    })];
    const manifest = frozenRunnerManifest();
    const runner = manifest.acceptanceRunner;
    if (runner === undefined) throw new Error("the fixture manifest froze no acceptance runner");
    const refusal = acceptanceRunnerCheck(runner, [outside]);
    expect(refusal.ok).toBe(false);
    const errors = refusal.ok ? [] : refusal.error.errors;

    expect(renderedLines({ tasks, contracts, manifest }, "T2")).toEqual([
      offLine("T2", 2, "command-refused"),
      ...errors.map((error) => `  ${error}`),
    ]);
    expect(errors).toEqual([`acceptanceRunner.cwd engine does not contain ${outside}`]);
  });
});

/** A fresh Git repository to hold one State File. */
const project = (): string => gitProject("loom-stop-check-plan-", cleanup);

describe("helper stop-check-plan refusals (CT-1)", () => {
  it("AS-004: an unknown Task id is refused naming the id, with a non-zero exit", () => {
    const { json } = stopCheckGraph({
      tasks: [task("T1", 1, [LEDGER_TYPES, LEDGER]), task("T2", 2, ["engine/src/core/ledger.ts"], ["AS-001"])],
      contracts: [ledgerContract()],
      manifest: frozenRunnerManifest(),
    });
    const statePath = writeStateFile(project(), json);

    const run = runStopCheckPlanCli(statePath, "T9");

    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(`${UNKNOWN_TASK_PREFIX} T9 in the TaskGraph`);
    expect(run.stderr).not.toContain("Unknown handler");
    expect(run.status).not.toBe(0);
    expect(run.status).not.toBeNull();
  });

  it("AS-004: with no TaskGraph it refuses with the path it looked for, with a non-zero exit", () => {
    const statePath = statePathIn(project());

    const run = runStopCheckPlanCli(statePath, "T1");

    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(statePath);
    expect(run.stderr).not.toContain("Unknown handler");
    expect(run.status).not.toBe(0);
    expect(run.status).not.toBeNull();
  });
});
