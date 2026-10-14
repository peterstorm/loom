/**
 * The Acceptance Stop Check: what a claimant owes when its agent tries to
 * stop, and the verdict a run of those acceptance files gives.
 *
 * G4 slice 1 (I7 for G1 claimants). The Wave Gate's completion suite is the
 * only completion authority; this check only decides whether the claimant's
 * own agent should keep working while its context is still loaded. So a
 * verdict it cannot reach is `unobservable` and never blocks: only an owed
 * testcase the report shows not passing does.
 *
 * Pure. The shell runs the operator-declared runner over `files` and hands
 * back the report projection.
 */

import type { ArtifactDigest, NonEmpty } from "../orchestration-contract";
import type { JunitTestcasesResult } from "../structured-test-report";
import { acceptanceExpectation, observeAcceptanceFacts, type AcceptanceExpectation } from "./gate";
import { freeze, nonEmpty } from "./kernel";
import type { AcceptanceContract, AcceptanceTestcase, ContractTaskView } from "./model";
import { claims, dueWaves } from "./tasks";

/** One contract's testcases a claimant owes at its stop. */
export type OwedAcceptance = Readonly<{ contractId: string; testcases: NonEmpty<AcceptanceTestcase> }>;

declare const OWED_STOP_CHECK: unique symbol;

/**
 * What a Task owes at its stop, judged per roster testcase: the testcases of
 * frozen contracts that it claims and whose every anchor is due by its Wave.
 * `none` when there is no such testcase; otherwise `owed` carries them, the
 * acceptance files holding them, and the gate expectation that attributes
 * report testcases to those files.
 */
export type OwedStopCheck = Readonly<{
  kind: "owed";
  owed: NonEmpty<OwedAcceptance>;
  files: NonEmpty<string>;
  expectation: AcceptanceExpectation;
  /** Only stopCheckExpectation constructs this, so `files` and `expectation`
   *  always agree with `owed`. */
  readonly [OWED_STOP_CHECK]: true;
}>;

export type StopCheckExpectation = Readonly<{ kind: "none" }> | OwedStopCheck;

/** One owed testcase the report shows not passing, and why. */
export type FailingAcceptanceTestcase = Readonly<{
  contractId: string;
  file: string;
  name: string;
  /** `failed` with the report's failure type; `skipped` when the report ran it
   *  as skipped; `did-not-run` when the report holds no passing or failing
   *  record of it: absent, failed to collect, or its file produced no
   *  testcase while another owed file did. */
  outcome:
    | Readonly<{ kind: "failed"; failureType: string | null }>
    | Readonly<{ kind: "skipped" }>
    | Readonly<{ kind: "did-not-run" }>;
}>;

export type StopCheckVerdict =
  | Readonly<{ kind: "passed" }>
  | Readonly<{ kind: "failing"; testcases: NonEmpty<FailingAcceptanceTestcase> }>
  | Readonly<{ kind: "unobservable"; reason: string }>;

const NONE: StopCheckExpectation = freeze({ kind: "none" });

/** The roster entries of one frozen contract that `task` claims and that are due by its Wave. */
function owedTestcases(contract: AcceptanceContract, task: ContractTaskView, tasks: readonly ContractTaskView[]): readonly AcceptanceTestcase[] {
  if (contract.freeze.state !== "frozen") return [];
  const due = dueWaves(contract, tasks);
  return contract.freeze.roster.filter((entry) =>
    claims(contract, task, entry.anchors) &&
    entry.anchors.every((anchor) => (due[anchor] ?? Number.POSITIVE_INFINITY) <= task.wave));
}

export function stopCheckExpectation(
  contracts: readonly AcceptanceContract[],
  tasks: readonly ContractTaskView[],
  task: ContractTaskView,
): StopCheckExpectation {
  const owed = nonEmpty(contracts.flatMap((contract): OwedAcceptance[] => {
    const testcases = nonEmpty(owedTestcases(contract, task, tasks));
    return testcases === null ? [] : [freeze({ contractId: contract.id, testcases })];
  }));
  if (owed === null) return NONE;
  const files = nonEmpty([...new Set(owed.flatMap(({ testcases }) => testcases.map(({ file }) => file)))])!;
  const owingContracts = contracts.filter(({ id }) => owed.some(({ contractId }) => contractId === id));
  return freeze({
    kind: "owed",
    owed,
    files,
    expectation: acceptanceExpectation(owingContracts, tasks, task.wave),
  }) as OwedStopCheck;
}

/** The verdict of one runner report over the owed testcases. */
export function judgeStopCheck(
  check: OwedStopCheck,
  reportDigest: ArtifactDigest,
  projection: JunitTestcasesResult,
): StopCheckVerdict {
  const facts = observeAcceptanceFacts(check.expectation, "acceptance-stop-check", reportDigest, projection);
  if (facts.kind === "unprojectable") return freeze({ kind: "unobservable", reason: `the runner's report could not be read: ${facts.reason}` });
  const ran = facts.testcases.filter(({ file }) => check.files.includes(file));
  if (ran.length === 0) {
    return freeze({ kind: "unobservable", reason: `the runner's report contains no testcase of ${check.files.join(", ")}` });
  }
  const failing = nonEmpty(check.owed.flatMap(({ contractId, testcases }) => testcases.flatMap((entry): FailingAcceptanceTestcase[] => {
    const observed = ran.find(({ file, name }) => file === entry.file && name === entry.name);
    if (observed !== undefined && !observed.collectionError && observed.outcome === "passed") return [];
    const outcome: FailingAcceptanceTestcase["outcome"] = observed === undefined || observed.collectionError
      ? freeze({ kind: "did-not-run" })
      : observed.outcome === "skipped"
        ? freeze({ kind: "skipped" })
        : freeze({ kind: "failed", failureType: observed.failureType });
    return [freeze({ contractId, file: entry.file, name: entry.name, outcome })];
  })));
  return failing === null ? freeze({ kind: "passed" }) : freeze({ kind: "failing", testcases: failing });
}

function describeOutcome(outcome: FailingAcceptanceTestcase["outcome"]): string {
  switch (outcome.kind) {
    case "failed":
      return outcome.failureType === null ? "failed" : `failed (${outcome.failureType})`;
    case "skipped":
      return "skipped";
    case "did-not-run":
      return "did not run";
  }
}

/** The message the blocked agent reads: what is still failing, and what it may and may not do about it. */
export function renderStopCheckBlock(
  testcases: NonEmpty<FailingAcceptanceTestcase>,
  runnerOutput: string,
  blocksRemaining: number,
): string {
  const lines = testcases.map(({ contractId, file, name, outcome }) => `- ${contractId}: '${name}' (${file}) — ${describeOutcome(outcome)}`);
  return [
    "LOOM ACCEPTANCE STOP CHECK: your Task claims Requirements whose frozen acceptance testcases are still not passing.",
    "Your Wave Gate requires them green. Keep working until they pass:",
    ...lines,
    "",
    "The acceptance files are frozen: never edit them. If a frozen test is wrong, stop and say so plainly; only an operator Contract Revision changes it.",
    "Failures can also come from a sibling Task editing concurrently; if your own code is correct, say that and stop.",
    `This check blocks at most ${blocksRemaining} more time(s); after that your stop proceeds and the Wave Gate judges.`,
    ...(runnerOutput.trim() === "" ? [] : ["", "Runner output (tail):", runnerOutput.trimEnd()]),
  ].join("\n");
}
