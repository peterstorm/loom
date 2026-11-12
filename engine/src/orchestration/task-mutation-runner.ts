/**
 * The Task mutation check's execution shell (ADR-0071). It runs what
 * `helper mutation-check` asks for and decides nothing: the duty, the mutants,
 * each run's classification and the tally are the pure core's
 * (`core/task-mutation-check.ts`, `core/owner-verification/mutation-plan.ts`).
 *
 * One run, for a Task that owes the check:
 * 1. Each declared implementation file is read from the real workspace and at
 *    the Task's base commit; `changedHeadLines` names the lines the Task
 *    changed and `taskMutants` selects at most `MUTANT_CAP_PER_TASK` mutants
 *    over all the files together.
 * 2. Per file that holds a mutant, one isolated worktree
 *    (`withMutationWorkspace`, the Wave Gate's own): the frozen
 *    `affectedRunner` runs over that file unmutated, then once per mutant.
 *    The real workspace is only ever read.
 * 3. `taskMutationResultOf` tallies the runs.
 *
 * A run launches only while the time left before the deadline holds its whole
 * timeout; otherwise, and on every fault, the result is `unavailable`, which
 * never blocks a stop. `runTaskMutationCheck` never throws.
 */

import { match } from "ts-pattern";
import { graphAcceptanceExpectation, type AcceptanceExpectation } from "../core/acceptance-contract";
import { failure, success, type DomainResult } from "../core/orchestration-contract/identity";
import { applyTaskMutant, MUTANT_CAP_PER_TASK, taskMutants, type TaskMutants } from "../core/owner-verification/mutation-plan";
import type { MatrixTestRun } from "../core/owner-verification/types";
import { parseReviewPath } from "../core/review-packet";
import {
  classifyTaskBaseline,
  classifyTaskMutantRun,
  mutantsByFile,
  TASK_MUTATION_DEADLINE_MS,
  taskMutationResultOf,
  taskMutationUnavailable,
  type FileMutants,
  type OwedTaskMutation,
  type TaskMutantRun,
  type TaskMutationResult,
} from "../core/task-mutation-check";
import { changedHeadLines } from "../core/unified-diff";
import type { TaskGraph } from "../types";
import { describeCause } from "../utils/describe-cause";
import type { CanonicalRepositoryRoot } from "../utils/workspace-digest";
import { withMutationWorkspace, type OwnerVariant } from "./owner-mutation-workspace";
import { matrixTestCommand, ownerAtBase, readRepositoryText, resolveWaveBase, runOnce } from "./owner-verification-runner";

/** One runner execution over a file, with that file's bytes as `variant` says: the port `runFileMutants` sequences. */
export type RunTaskFile = (variant: OwnerVariant) => Promise<MatrixTestRun>;

/** What bounds a run: the instant it must end by, the clock, and the longest one execution may take. */
export type TaskMutationBudget = Readonly<{ deadlineMs: number; now: () => number; runTimeoutMs: number }>;

const BASELINE: OwnerVariant = Object.freeze({ kind: "baseline" });

/** Why no further execution may launch, or null while the budget holds a whole one. */
function exhausted({ deadlineMs, now, runTimeoutMs }: TaskMutationBudget): string | null {
  const left = deadlineMs - now();
  return left >= runTimeoutMs
    ? null
    : `its ${TASK_MUTATION_DEADLINE_MS / 1000} s deadline cannot hold another run (${Math.max(left, 0)} ms left, one run may take ${runTimeoutMs} ms)`;
}

/**
 * The sequencing policy for one file: the unmutated run first, then each
 * mutant in plan order. A red or unobservable baseline, an unobservable
 * mutant run and an exhausted budget each end the whole check with the reason
 * it could not decide; a baseline that ran no test leaves every mutant of the
 * file surviving without being run.
 */
export async function runFileMutants(
  run: RunTaskFile,
  { path, mutants }: FileMutants,
  text: string,
  expectation: AcceptanceExpectation,
  budget: TaskMutationBudget,
): Promise<DomainResult<readonly TaskMutantRun[], string>> {
  const late = exhausted(budget);
  if (late !== null) return failure(late);
  const baseline = classifyTaskBaseline(await run(BASELINE), expectation);
  const undecided = match(baseline)
    .returnType<DomainResult<readonly TaskMutantRun[], string> | null>()
    .with({ kind: "red" }, ({ failures }) =>
      failure(`the unmutated tests of ${path} fail (${failures.join(", ")}), so no mutant can be judged; a sibling Task's unfinished work may be the cause`))
    .with({ kind: "unobservable" }, ({ reason }) => failure(`the unmutated run of ${path} could not be observed: ${reason}`))
    .with({ kind: "untested" }, () => success(mutants.map((mutant): TaskMutantRun => ({ mutant, outcome: "untested" }))))
    .with({ kind: "green" }, () => null)
    .exhaustive();
  if (undecided !== null) return undecided;
  const runs: TaskMutantRun[] = [];
  for (const mutant of mutants) {
    const lateMutant = exhausted(budget);
    if (lateMutant !== null) return failure(lateMutant);
    const outcome = classifyTaskMutantRun(await run({ kind: "mutant", text: applyTaskMutant(text, mutant) }), expectation);
    if (outcome.kind === "unobservable") return failure(`a mutant run of ${path} could not be observed: ${outcome.reason}`);
    runs.push({ mutant, outcome: outcome.kind });
  }
  return success(runs);
}

export type TaskMutationRunInput = Readonly<{
  /** The real workspace. It is only ever read. */
  root: CanonicalRepositoryRoot;
  graph: Pick<TaskGraph, "tasks" | "acceptance_contracts">;
  duty: OwedTaskMutation;
  now: () => number;
}>;

type Planned = Readonly<{ selected: TaskMutants; texts: ReadonlyMap<string, string> }>;

/** The mutants of the Task's changed lines and each mutated file's text, or why they cannot be told. */
function planTaskMutants({ root, duty }: TaskMutationRunInput): DomainResult<Planned, string> {
  if (duty.startSha === null) return failure(`Task ${duty.taskId} records no start_sha, so the lines it changed cannot be told`);
  const base = resolveWaveBase(root, `Task ${duty.taskId}`, { kind: "commit", sha: duty.startSha });
  if (!base.ok) return failure(base.error.detail);
  const texts = new Map<string, string>();
  const changes: { path: string; text: string; changedLines: ReadonlySet<number> }[] = [];
  for (const path of duty.mutable) {
    const read = readRepositoryText(root, path);
    if (read.kind === "unreadable") return failure(read.failure.detail);
    // A declared file the Task has not written, or has deleted, holds no line to mutate.
    if (read.kind === "absent") continue;
    const before = ownerAtBase(root, base.value, path);
    if (!before.ok) return failure(before.error.detail);
    texts.set(path, read.text);
    changes.push({ path, text: read.text, changedLines: changedHeadLines(before.value, read.text) });
  }
  const selected = taskMutants(changes, MUTANT_CAP_PER_TASK);
  return selected.ok
    ? success({ selected: selected.value, texts })
    : failure(`${selected.error.path} does not parse, so its mutation sites cannot be trusted: ${selected.error.diagnostics.join("; ")}`);
}

/** One file's runs in its own isolated worktree, or why they could not decide. */
async function runFile(
  input: TaskMutationRunInput,
  file: FileMutants,
  text: string,
  expectation: AcceptanceExpectation,
  deadlineMs: number,
): Promise<DomainResult<readonly TaskMutantRun[], string>> {
  const { runner } = input.duty;
  const command = matrixTestCommand(runner, file.path);
  if (!command.ok) return failure(`the affectedRunner cannot run over ${file.path}: ${command.error}`);
  const ownerPath = parseReviewPath(file.path, "implementation file");
  if (!ownerPath.ok) return failure(ownerPath.errors.join("; "));
  const budget: TaskMutationBudget = { deadlineMs, now: input.now, runTimeoutMs: command.value.timeoutMs };
  const ran = await withMutationWorkspace(
    { repositoryRoot: input.root, ownerPath: ownerPath.value, reportPath: runner.report.path, runnerCwd: runner.cwd },
    (workspace) => runFileMutants((variant) => runOnce(workspace, command.value, variant), file, text, expectation, budget),
  );
  return ran.ok ? ran.value : failure(`${ran.error.kind}: ${ran.error.detail}`);
}

async function decide(input: TaskMutationRunInput): Promise<TaskMutationResult> {
  const deadlineMs = input.now() + TASK_MUTATION_DEADLINE_MS;
  const planned = planTaskMutants(input);
  if (!planned.ok) return taskMutationUnavailable(planned.error);
  const { selected, texts } = planned.value;
  const expectation = graphAcceptanceExpectation(input.graph, input.duty.wave);
  const runs: TaskMutantRun[] = [];
  for (const file of mutantsByFile(selected.mutants)) {
    const text = texts.get(file.path);
    if (text === undefined) return taskMutationUnavailable(`${file.path} holds a mutant but its text was not read`);
    const ran = await runFile(input, file, text, expectation, deadlineMs);
    if (!ran.ok) return taskMutationUnavailable(ran.error);
    runs.push(...ran.value);
  }
  return taskMutationResultOf(runs, selected.candidates);
}

/**
 * Run the Task mutation check for a Task that owes it. Never throws: whatever
 * a step throws is the `unavailable` result naming it.
 */
export async function runTaskMutationCheck(input: TaskMutationRunInput): Promise<TaskMutationResult> {
  try {
    return await decide(input);
  } catch (cause) {
    return taskMutationUnavailable(`the check failed while it ran: ${describeCause(cause)}`);
  }
}
