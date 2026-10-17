/**
 * The one stop shell for both stop checks (G4, AD-10): the acceptance check
 * (I-slice 1, a claimant's owed acceptance testcases) and the affected-test
 * check (I7, the tests the attempt's changed files affect).
 *
 * `runStopChecks` is the shell; every decision is pure and lives elsewhere:
 * - what each check would run comes from `planStopChecks` (INV-1), over the
 *   changed files only `changedFilesAtStop` derives (INV-7);
 * - whether a check may block, and what each counter records, comes from
 *   `stopCheckBlockDecision`;
 * - verdicts come from `judgeStopCheck` and `judgeAffectedRun`, and the one
 *   combined block message from `renderStopChecksBlock`.
 *
 * The order of operations at one stop: load the TaskGraph, resolve the
 * repository root, derive the changed files, plan, read each runnable check's
 * counter, acquire the per-repository runner lock once, run acceptance then
 * affected under it (each report read back digest-checked while the lock is
 * held, AS-031), release, decide. The affected runner launches only when the
 * hook budget still holds its whole timeout; the timeout is never clipped.
 *
 * Total: every infrastructure fault fails OPEN with a note naming its cause,
 * and the stop proceeds for the Wave Gate to judge. The outcome carries only
 * text (INV-3): nothing here reaches settlement, proof, receipts or Wave Gate
 * evidence.
 */

import { join } from "node:path";
import { match } from "ts-pattern";
import { judgeStopCheck, renderStopCheckBlock } from "../../core/acceptance-contract";
// Not in the barrel: re-exporting it there would close an import cycle (see the module's header).
import { planStopChecks } from "../../core/acceptance-contract/stop-check-planner";
import {
  AFFECTED_NOTE_TEXT,
  AFFECTED_OUTSIDE_CWD_PREFIX,
  AFFECTED_STOP_CHECK_MAX_BLOCKS,
  SETTLEMENT_RESERVE_MS,
  STOP_HOOK_BUDGET_MS,
  type AcceptancePlan,
  type AffectedPlan,
  type AffectedStopCheckNoteKind,
  type ChangedFilePath,
  type ChangedFiles,
  type StopCheckBlockCount,
  type StopChecksOutcome,
} from "../../core/affected-stop-check-types";
import {
  judgeAffectedRun,
  renderAffectedBlock,
  renderStopChecksBlock,
  stopCheckBlockDecision,
  type StopCheckBlockCaps,
  type StopCheckName,
  type StopChecksBlockParts,
} from "../../core/affected-stop-check";
import { changedFilesAtStop, NO_CHANGED_FILES } from "../../core/changed-files";
import { sha256Bytes } from "../../core/digest";
import type { LedgerObservation } from "../../core/red-then-green-types";
import { parseJunitTestcases } from "../../core/structured-test-report";
import type { TaskGraph } from "../../types";
import type { CompletionCheckRunnerResult } from "../../orchestration/completion-check-runner";
import type { CanonicalRepositoryRoot } from "../../utils/workspace-digest";
import { ACCEPTANCE_STOP_CHECK_MAX_BLOCKS, NO_BLOCKS_ISSUED, type StopCheckShellPorts } from "./acceptance-stop-check";

/** The longest runner output tail a blocked agent is shown, per check. */
const OUTPUT_TAIL_CHARS = 4_000;

const CAPS: StopCheckBlockCaps = Object.freeze({
  acceptance: ACCEPTANCE_STOP_CHECK_MAX_BLOCKS,
  affected: AFFECTED_STOP_CHECK_MAX_BLOCKS,
});

/** The attempt's changed files as the shell observed them, or why they could not be. */
export type ChangedFilesObservation =
  | Readonly<{ kind: "observed"; changed: ChangedFiles }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

export type StopChecksInput = Readonly<{
  /** Read inside the shell, so a load fault is a note like every other fault. */
  loadGraph: () => TaskGraph;
  stateFilePath: string;
  taskId: string;
  /** Session and agent id, unique per spawned agent. */
  agentKey: string;
  /** The attempt's changed files beneath the resolved repository root. */
  changedFiles: (root: CanonicalRepositoryRoot) => ChangedFilesObservation;
  /** The hook clock's first reading at hook entry; the budget is measured from it. */
  hookStartedAtMs: number;
}>;

/**
 * The changed files of one attempt epoch, as every stop shell derives them:
 * the epoch's ledger events and a stop-time existence predicate go to
 * `changedFilesAtStop`, the INV-7 owner, unfiltered. An epoch that could not
 * be read is `unavailable`, never an empty set of changed files.
 */
export function epochChangedFiles<Root extends string>(
  ledger: LedgerObservation,
  exists: (root: Root, path: ChangedFilePath) => boolean,
): (root: Root) => ChangedFilesObservation {
  return (root) => ledger.kind === "read"
    ? Object.freeze({ kind: "observed", changed: changedFilesAtStop(ledger.events, root, (path) => exists(root, path)) })
    : Object.freeze({ kind: "unavailable", reason: `the attempt's ledger epoch is unreadable: ${ledger.reason}` });
}

// --- Per-check results ---

/** What one check contributes at this stop. A failing check renders its block part once the remaining blocks are known. */
type CheckResult =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "passed"; note: string | null }>
  | Readonly<{ kind: "failing"; part: (blocksRemaining: number) => string }>
  | Readonly<{ kind: "note"; note: string }>;

/** A check the plan turned on, with its runner. Everything else has already settled into a result. */
type Arm<Plan> = Readonly<{ kind: "runnable"; plan: Plan }> | CheckResult;

type OnAcceptance = Extract<AcceptancePlan, { kind: "on" }>;
type OnAffected = Extract<AffectedPlan, { kind: "on" }>;

const IDLE: CheckResult = Object.freeze({ kind: "idle" });
const describe = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
const tail = (text: string): string => text.length <= OUTPUT_TAIL_CHARS ? text : `…${text.slice(-OUTPUT_TAIL_CHARS)}`;
const runnerOutput = (run: Extract<CompletionCheckRunnerResult, { ok: true }>): string =>
  tail([run.value.diagnostics.stdoutTail, run.value.diagnostics.stderrTail].filter((part) => part.trim() !== "").join("\n"));

const acceptanceNote = (taskId: string, why: string): CheckResult => Object.freeze({
  kind: "note",
  note: `acceptance stop check for ${taskId} did not decide (${why}); the stop proceeds and the Wave Gate judges`,
});

const affectedNoteText = (taskId: string, kind: AffectedStopCheckNoteKind, detail: string | null = null): string =>
  `affected stop check for ${taskId}: ${AFFECTED_NOTE_TEXT[kind]}${detail === null ? "" : ` (${detail})`}; the stop proceeds`;

const affectedNote = (taskId: string, kind: AffectedStopCheckNoteKind, detail: string | null = null): CheckResult =>
  Object.freeze({ kind: "note", note: affectedNoteText(taskId, kind, detail) });

// --- Arms: what the plan leaves for each check ---

function acceptanceArm(taskId: string, plan: AcceptancePlan, rootFault: string | null): Arm<OnAcceptance> {
  if (plan.kind === "off") {
    return plan.reason.kind === "command-refused"
      ? acceptanceNote(taskId, `the runner command is invalid for these files: ${plan.reason.errors.join("; ")}`)
      : IDLE;
  }
  return rootFault === null ? Object.freeze({ kind: "runnable", plan }) : acceptanceNote(taskId, rootFault);
}

type AffectedObservation = ChangedFilesObservation | Readonly<{ kind: "no-root"; reason: string }>;

/** Why the affected check cannot decide whatever its plan says: no root, or no readable epoch. */
function affectedFault(taskId: string, observation: AffectedObservation): CheckResult | null {
  if (observation.kind === "no-root") return affectedNote(taskId, "repository-unavailable", observation.reason);
  if (observation.kind === "unavailable") return affectedNote(taskId, "crashed", observation.reason);
  return null;
}

function affectedArm(taskId: string, plan: AffectedPlan, observation: AffectedObservation): Arm<OnAffected> {
  if (plan.kind === "on") return affectedFault(taskId, observation) ?? Object.freeze({ kind: "runnable", plan });
  const { reason } = plan;
  // A missing runner is idle before the changed files matter.
  if (reason.kind === "no-runner") return IDLE;
  return affectedFault(taskId, observation) ?? match(reason)
    .returnType<CheckResult>()
    .with({ kind: "no-changed-files" }, ({ outsideCwd }) => affectedNote(taskId, "no-changed-files", outsideCwd === null
      ? null
      : outsideCwd.map((file) => `${AFFECTED_OUTSIDE_CWD_PREFIX}: ${file}`).join("; ")))
    .with({ kind: "command-refused" }, ({ errors }) => affectedNote(taskId, "command-refused", errors.join("; ")))
    .exhaustive();
}

// --- Running one check under the held lock ---

/** Read a produced report back while the lock is held, refusing one whose bytes changed since the runner produced it. */
function readBack(ports: StopCheckShellPorts, root: CanonicalRepositoryRoot, report: Readonly<{ path: string; digest: string }>):
  Readonly<{ ok: true; bytes: Uint8Array }> | Readonly<{ ok: false; reason: string }> {
  let bytes: Uint8Array;
  try {
    bytes = ports.readReport(join(root, report.path));
  } catch (cause) {
    return { ok: false, reason: `the report could not be read back: ${describe(cause)}` };
  }
  return sha256Bytes(bytes) === report.digest ? { ok: true, bytes } : { ok: false, reason: "the report changed after the runner produced it" };
}

async function runAcceptance(taskId: string, plan: OnAcceptance, root: CanonicalRepositoryRoot, ports: StopCheckShellPorts): Promise<CheckResult> {
  const note = (why: string): CheckResult => acceptanceNote(taskId, why);
  const run = await ports.runCheck(plan.command, root);
  if (!run.ok) return note(`the runner did not complete: ${run.error.message}`);
  const outcome = run.value.checkResult.outcome;
  if (outcome.kind === "spawn-failed") return note(`the runner could not start: ${outcome.message}`);
  // A report a killed runner left behind is partial: its absent testcases say nothing about the agent.
  if (outcome.timedOut) return note("the runner timed out");
  if (outcome.signal !== null) return note(`the runner was killed by ${outcome.signal}`);
  if (outcome.report.kind !== "produced") return note(`the runner produced no report (${outcome.report.kind})`);
  const read = readBack(ports, root, outcome.report);
  if (!read.ok) return note(read.reason);
  const verdict = judgeStopCheck(plan.check, outcome.report.digest, parseJunitTestcases(read.bytes));
  if (verdict.kind === "passed") return Object.freeze({ kind: "passed", note: null });
  if (verdict.kind === "unobservable") return note(verdict.reason);
  const output = runnerOutput(run);
  return Object.freeze({ kind: "failing", part: (remaining) => renderStopCheckBlock(verdict.testcases, output, remaining) });
}

async function runAffected(
  taskId: string,
  plan: OnAffected,
  declared: readonly string[],
  root: CanonicalRepositoryRoot,
  ports: StopCheckShellPorts,
): Promise<CheckResult> {
  const note = (kind: AffectedStopCheckNoteKind, detail: string | null = null): CheckResult => affectedNote(taskId, kind, detail);
  const run = await ports.runCheck(plan.command, root);
  if (!run.ok) return note("did-not-complete", run.error.message);
  const outcome = run.value.checkResult.outcome;
  if (outcome.kind === "spawn-failed") return note("start-failed", outcome.message);
  // A killed runner's report is partial, so it is never judged.
  if (outcome.timedOut) return note("timed-out", `${plan.command.timeoutMs} ms`);
  if (outcome.signal !== null) return note("killed", outcome.signal);
  if (outcome.report.kind !== "produced") return note("no-readable-report", outcome.report.kind);
  const read = readBack(ports, root, outcome.report);
  if (!read.ok) return note("no-readable-report", read.reason);
  const verdict = judgeAffectedRun(parseJunitTestcases(read.bytes));
  switch (verdict.kind) {
    case "passed":
      return Object.freeze({ kind: "passed", note: verdict.observed === "zero-tests" ? affectedNoteText(taskId, "zero-tests") : null });
    case "unobservable":
      return note("no-readable-report", verdict.reason);
    case "failing": {
      const output = runnerOutput(run);
      const attribution = Object.freeze({ declared: [...declared, ...plan.files], repositoryRoot: root });
      return Object.freeze({ kind: "failing", part: (remaining) => renderAffectedBlock(verdict.testcases, attribution, output, remaining) });
    }
  }
}

// --- The stop ---

type Results = Readonly<Record<StopCheckName, CheckResult>>;
type Issued = Readonly<Record<StopCheckName, StopCheckBlockCount>>;

const NOT_FAILING = Object.freeze({ acceptance: "not-failing", affected: "not-failing" } as const);

const isRunnable = <Plan>(arm: Arm<Plan>): arm is Readonly<{ kind: "runnable"; plan: Plan }> => arm.kind === "runnable";

/**
 * A runnable check stays runnable only while it may still block this agent:
 * the decision rule asked about this check failing alone. When it may not,
 * the rule's note says why (the cap, or an unreadable counter), and the
 * check fails open without running.
 */
function admitted<Plan>(taskId: string, name: StopCheckName, arm: Arm<Plan>, issued: Issued): Arm<Plan> {
  if (!isRunnable(arm)) return arm;
  const decision = stopCheckBlockDecision(issued, { ...NOT_FAILING, [name]: "failing" }, CAPS);
  return decision.outcome === "block"
    ? arm
    : Object.freeze({ kind: "note", note: decision.notes.map((note) => `stop checks for ${taskId}: ${note}`).join("\n") });
}

const notesOf = (results: Results): readonly string[] =>
  [results.acceptance, results.affected].flatMap((result) =>
    result.kind === "note" ? [result.note] : result.kind === "passed" && result.note !== null ? [result.note] : []);

/** The stop the results belong to: whose Task it is, and whose counters a block writes. */
type Stopper = Pick<StopChecksInput, "taskId" | "agentKey">;

/** Settle the results into one outcome, writing only the counters the decision names. */
function settle({ taskId, agentKey }: Stopper, results: Results, issued: Issued, ports: StopCheckShellPorts, extraNotes: readonly string[]): StopChecksOutcome {
  const decision = stopCheckBlockDecision(issued, {
    acceptance: results.acceptance.kind === "failing" ? "failing" : "not-failing",
    affected: results.affected.kind === "failing" ? "failing" : "not-failing",
  }, CAPS);
  const notes = [...notesOf(results), ...decision.notes.map((note) => `stop checks for ${taskId}: ${note}`), ...extraNotes];
  if (decision.outcome === "proceed") {
    if (notes.length > 0) return Object.freeze({ kind: "note", message: notes.join("\n") });
    return results.acceptance.kind === "passed" || results.affected.kind === "passed" ? Object.freeze({ kind: "passed" }) : Object.freeze({ kind: "skip" });
  }
  const part = (name: StopCheckName): string | null => {
    const write = decision.record[name];
    const result = results[name];
    return write.kind === "set" && result.kind === "failing" ? result.part(CAPS[name] - write.blocks) : null;
  };
  const { acceptance: acceptanceWrite, affected: affectedWrite } = decision.record;
  if (acceptanceWrite.kind === "set") ports.recordBlock(agentKey, acceptanceWrite.blocks);
  if (affectedWrite.kind === "set") ports.recordAffectedBlock(agentKey, affectedWrite.blocks);
  const acceptance = part("acceptance");
  const affected = part("affected");
  // Each arm of the non-empty parts type names the failing check it carries.
  const parts: StopChecksBlockParts | null = acceptance !== null
    ? { acceptance, affected }
    : affected !== null ? { acceptance: null, affected } : null;
  // A block always names a failing check, so parts exist; a defect here becomes the shell's crash note.
  if (parts === null) throw new Error("unreachable: a block names no failing check");
  const body = renderStopChecksBlock(parts);
  return Object.freeze({
    kind: "block",
    message: notes.length === 0 ? body : `${body}\n\nStop-check notes:\n${notes.map((note) => `- ${note}`).join("\n")}`,
  });
}

async function decide(input: StopChecksInput, ports: StopCheckShellPorts): Promise<StopChecksOutcome> {
  const { taskId } = input;
  const graph = input.loadGraph();
  const resolvedRoot = ports.repositoryRoot(input.stateFilePath);
  const observation = resolvedRoot.ok ? input.changedFiles(resolvedRoot.root) : Object.freeze({ kind: "no-root" as const, reason: resolvedRoot.reason });
  const plan = planStopChecks(graph, taskId, observation.kind === "observed" ? observation.changed : NO_CHANGED_FILES);
  if (plan.kind === "unknown-task") return Object.freeze({ kind: "skip" });

  const planned = Object.freeze({
    acceptance: acceptanceArm(taskId, plan.acceptance, resolvedRoot.ok ? null : resolvedRoot.reason),
    affected: affectedArm(taskId, plan.affected, observation),
  });
  // Only a check that would run reads its counter.
  const issued: Issued = Object.freeze({
    acceptance: isRunnable(planned.acceptance) ? ports.blocksIssued(input.agentKey) : NO_BLOCKS_ISSUED,
    affected: isRunnable(planned.affected) ? ports.affectedBlocksIssued(input.agentKey) : NO_BLOCKS_ISSUED,
  });
  const acceptance = admitted(taskId, "acceptance", planned.acceptance, issued);
  const affected = admitted(taskId, "affected", planned.affected, issued);

  // Without a root every arm is already settled (a note, or idle when its check is off); the guard also narrows `root`.
  if (!resolvedRoot.ok || (!isRunnable(acceptance) && !isRunnable(affected))) {
    return settle(input, { acceptance: resultOf(acceptance), affected: resultOf(affected) }, issued, ports, []);
  }
  const root = resolvedRoot.root;
  const lock = ports.acquireRunner(root);
  if (lock.kind === "held") {
    return settle(input, {
      acceptance: isRunnable(acceptance) ? acceptanceNote(taskId, lock.reason) : acceptance,
      affected: isRunnable(affected) ? affectedNote(taskId, "lock-held", lock.reason) : affected,
    }, issued, ports, []);
  }
  const ran = await runAdmitted(input, { acceptance, affected }, graph, root, ports);
  // Released on every path, and its fault named on every path: a crash under the lock still reports it.
  const releaseFault = lock.release();
  const lockNotes = releaseFault === null ? [] : [`stop checks for ${taskId}: ${releaseFault}`];
  const crashed = (cause: unknown): StopChecksOutcome =>
    Object.freeze({ kind: "note", message: [crashNote(taskId, cause), ...lockNotes].join("\n") });
  if (!ran.ok) return crashed(ran.cause);
  try {
    return settle(input, ran.results, issued, ports, lockNotes);
  } catch (cause) {
    return crashed(cause);
  }
}

/** The checks' results under the held lock, or the fault that stopped them: a throw never skips the release. */
type Ran = Readonly<{ ok: true; results: Results }> | Readonly<{ ok: false; cause: unknown }>;

/** Run each admitted check in order, acceptance then affected; an arm that is not runnable is already its result. */
async function runAdmitted(
  input: StopChecksInput,
  arms: Readonly<{ acceptance: Arm<OnAcceptance>; affected: Arm<OnAffected> }>,
  graph: TaskGraph,
  root: CanonicalRepositoryRoot,
  ports: StopCheckShellPorts,
): Promise<Ran> {
  const { acceptance, affected } = arms;
  try {
    const acceptanceResult = isRunnable(acceptance) ? await runAcceptance(input.taskId, acceptance.plan, root, ports) : acceptance;
    const affectedResult = isRunnable(affected) ? await runAffectedWithinBudget(input, affected.plan, graph, root, ports) : affected;
    return Object.freeze({ ok: true, results: Object.freeze({ acceptance: acceptanceResult, affected: affectedResult }) });
  } catch (cause) {
    return Object.freeze({ ok: false, cause });
  }
}

const crashNote = (taskId: string, cause: unknown): string => `stop checks for ${taskId} crashed and did not decide: ${describe(cause)}`;

/** A non-runnable arm is already its result; a runnable one that never ran contributes nothing. */
const resultOf = <Plan>(arm: Arm<Plan>): CheckResult => isRunnable(arm) ? IDLE : arm;

/** The affected runner launches only when the time left before the deadline holds its whole timeout. */
async function runAffectedWithinBudget(
  input: StopChecksInput,
  plan: OnAffected,
  graph: TaskGraph,
  root: CanonicalRepositoryRoot,
  ports: StopCheckShellPorts,
): Promise<CheckResult> {
  const deadline = input.hookStartedAtMs + STOP_HOOK_BUDGET_MS - SETTLEMENT_RESERVE_MS;
  const left = deadline - ports.now();
  if (left < plan.command.timeoutMs) {
    return affectedNote(input.taskId, "budget-exhausted", `${Math.max(left, 0)} ms left, the runner needs ${plan.command.timeoutMs} ms`);
  }
  const declared = graph.tasks.find(({ id }) => id === input.taskId)?.file_list ?? [];
  return runAffected(input.taskId, plan, declared, root, ports);
}

/**
 * Decide the stop. Total: every fault becomes a note, and a stop that
 * proceeds clears both of the agent's block counters.
 */
export async function runStopChecks(input: StopChecksInput, ports: StopCheckShellPorts): Promise<StopChecksOutcome> {
  let outcome: StopChecksOutcome;
  try {
    outcome = await decide(input, ports);
  } catch (error) {
    outcome = { kind: "note", message: crashNote(input.taskId, error) };
  }
  if (outcome.kind === "block") return outcome;
  const faults: string[] = [];
  for (const clear of [ports.clearBlocks, ports.clearAffectedBlocks]) {
    try {
      clear(input.agentKey);
    } catch (error) {
      faults.push(describe(error));
    }
  }
  if (faults.length === 0) return outcome;
  const cleared = `a block counter could not be cleared: ${faults.join("; ")}`;
  return { kind: "note", message: outcome.kind === "note" ? `${outcome.message}\n${cleared}` : `stop checks for ${input.taskId}: ${cleared}` };
}

/** The operator line a report-only run prints, or null when there is nothing to say. */
export function stopChecksReportLine(taskId: string, outcome: StopChecksOutcome): string | null {
  switch (outcome.kind) {
    case "skip":
      return null;
    case "passed":
      return `stop checks: every acceptance and affected-test check that ran for ${taskId} passes`;
    case "note":
      return outcome.message;
    case "block":
      return `stop checks (report-only on Pi; the agent has already ended): ${taskId}\n${outcome.message}`;
  }
}
