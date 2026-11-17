/**
 * Forward Fix: the operator's fallback when a judgement fails on code a
 * completed Wave sealed.
 *
 * A Task of the active Wave judges code another Task wrote (a budget test, a
 * benchmark gate). When that judgement fails and the code's Wave has already
 * completed, nothing in the run may change the code: `reopen-task` reaches
 * only the active Wave, and a completed Wave is verified history. Judged
 * Paths (`judged-paths.ts`) prevent that shape at decompose; this is what the
 * operator does when prevention missed it.
 *
 * `addForwardFix` appends one new Task to the active Wave whose `file_list`
 * holds the sealed code (and anything else the fix needs), and records a
 * `ForwardFixAudit`. Completed Waves stay untouched as history: the fix is
 * reviewed by the active Wave's gate like every other Task of the Wave. The
 * audit holds each named judge's next dispatch until the fix settles
 * (`dispatch-holds.ts`), so the judge's last attempt is not spent re-failing
 * on unfixed code.
 *
 * It is narrow on purpose. Every held Task must be a Task of the active Wave
 * whose last implementation attempt failed (the judgement is the evidence),
 * at least one path must be sealed by a completed Wave (otherwise
 * `reopen-task` or the held Task itself is the tool), and no path may be one
 * another Task of the Wave owns, a frozen Acceptance Contract path or
 * protected verification infrastructure. It shares the Wave-reopening
 * precondition (`reopenableWave`) with Task Reopening and Contract Revision.
 *
 * Its Distill Scope stays as population froze it (ADR-0068): the fix's files
 * are judged by the Wave Gate's review, not distilled.
 *
 * Pure: the shell supplies the locked graph and proves quiescence.
 */

import { match } from "ts-pattern";
import { frozenPaths } from "./acceptance-contract/tasks";
import { coupledSetGaps, describeCoupledSetGap } from "./coupled-file-sets";
import { isFlagToken } from "./cli-flag-token";
import { isProtectedVerificationPath } from "./completion-suite";
import { isDistillTask } from "./distill-task";
import { nonEmpty, type DomainResult, type NonEmpty } from "./orchestration-contract";
import { redThenGreenScope, taskRedThenGreenEra } from "./proof-obligations";
import { parseReviewPath } from "./review-packet";
import { isUntouchedJoinedTask, pendingAuthoredTask } from "./task-graph-population";
import { parseTaskId, TASK_ID_PATTERN, type TaskId } from "./task-id";
import { deriveTaskImplementationDispatch } from "./task-implementation-dispatch";
import { MAX_TASK_REOPENING_REASON_LENGTH } from "./task-reopening";
import { reopenableWave, type ReopenableWave, type WaveReopeningRefusal } from "./task-revalidation";
import { findResidualPlaceholders } from "./validate-template-substitution";
import { serializeVerificationPolicy } from "./verification-policy";
import { newWaveGate, reconcileWaveBlock } from "./wave-gate-model";
import { retireUnownedWaveReviewAuthority } from "./wave-gate-registration";
import type { ForwardFixAudit, ForwardFixWithdrawal, Task, TaskGraph } from "../types";

/** The implementation agents a Forward Fix may be dispatched to. */
export const FORWARD_FIX_AGENTS = Object.freeze(["code-implementer-agent", "frontend-agent", "security-agent"] as const);
export type ForwardFixAgent = (typeof FORWARD_FIX_AGENTS)[number];

/** Whether the fix owes new tests, or the held judge's tests are its proof. */
export type ForwardFixNewTests = "required" | "existing-tests-sufficient";

export type ForwardFixRequest = Readonly<{
  wave: number;
  /** The judges whose failed attempt the fix answers, distinct, in the order named. */
  heldTaskIds: NonEmpty<TaskId>;
  /** The fix Task's file_list, distinct, in the order named. */
  files: NonEmpty<string>;
  agent: ForwardFixAgent;
  description: string;
  reason: string;
  newTests: ForwardFixNewTests;
}>;

/** The refusals of the active, open Wave both operations change: the shared Wave-reopening precondition, then this Wave's. */
export type ForwardFixWaveRefusalKind =
  | "not-executing"
  | "live-wave-gate"
  | "implementation-active"
  | "wrong-wave"
  | "wave-completed"
  | "successor-named";

/** One refusal of kind `K`, with the message the operator reads. */
export type Refusal<K extends string> = Readonly<{ kind: K; message: string }>;

/** What `addForwardFix` can refuse. */
export type ForwardFixRefusalKind =
  | ForwardFixWaveRefusalKind
  | "unknown-task"
  | "foreign-task"
  | "not-a-judge"
  | "no-failed-judgement"
  | "protected-path"
  | "frozen-path"
  | "owned-in-wave"
  | "not-sealed"
  | "coupled-set-split";

export type ForwardFixRefusal = Refusal<ForwardFixRefusalKind>;

export type ForwardFix =
  /** The fix Task was appended: persist `graph`, which appends `audit`. */
  | Readonly<{ kind: "added"; graph: TaskGraph; audit: ForwardFixAudit; task: Task }>
  /** This exact Forward Fix already committed and its fix Task has not settled: nothing to write. */
  | Readonly<{ kind: "already-added"; audit: ForwardFixAudit }>;

export const FORWARD_FIX_USAGE =
  "Usage: helper orchestration add-forward-fix --wave <N> --hold <task-id> [--hold <task-id>]... " +
  "--file <path> [--file <path>]... --description \"<what the fix changes>\" --reason \"<the failed judgement>\" " +
  "[--agent code-implementer-agent|frontend-agent|security-agent] [--new-tests required|existing-tests-sufficient]";

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);
const okWith = <T>(value: T): DomainResult<T, never> => freeze({ ok: true as const, value });
const failWith = <E>(error: E): DomainResult<never, E> => freeze({ ok: false as const, error });
const refuse = <K extends string>(kind: K, message: string): DomainResult<never, Refusal<K>> =>
  failWith(freeze({ kind, message }));
const WAVE_NUMBER = /^[1-9][0-9]*$/;
const MAX_DESCRIPTION_LENGTH = 512;

const isForwardFixAgent = (value: string): value is ForwardFixAgent =>
  (FORWARD_FIX_AGENTS as readonly string[]).includes(value);

/** Collected flag values before they are parsed into a request. */
type ForwardFixFlags = {
  wave?: string;
  description?: string;
  reason?: string;
  agent?: string;
  newTests?: string;
  holds: string[];
  files: string[];
};

const REPEATABLE = new Set(["--hold", "--file"]);
const SINGLE: Readonly<Record<string, keyof Omit<ForwardFixFlags, "holds" | "files">>> = {
  "--wave": "wave",
  "--description": "description",
  "--reason": "reason",
  "--agent": "agent",
  "--new-tests": "newTests",
};

function collectFlags(args: readonly string[]): DomainResult<ForwardFixFlags, string> {
  const flags: ForwardFixFlags = { holds: [], files: [] };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? "";
    const value = args[index + 1];
    // Own properties only: a flag spelled like an inherited Object member is unknown, not a key.
    const key = Object.hasOwn(SINGLE, flag) ? SINGLE[flag] : undefined;
    if (!REPEATABLE.has(flag) && key === undefined) return failWith(`unknown argument '${flag}'`);
    if (value === undefined || isFlagToken(value)) return failWith(`${flag} needs a value`);
    if (flag === "--hold") flags.holds.push(value);
    else if (flag === "--file") flags.files.push(value);
    else if (key !== undefined) {
      if (flags[key] !== undefined) return failWith(`${flag} is given twice`);
      flags[key] = value.trim();
    }
  }
  return okWith(flags);
}

/** Distinct values, or the first repeat. */
function distinct<T extends string>(values: readonly T[]): DomainResult<readonly T[], T> {
  const repeated = values.find((value, index) => values.indexOf(value) !== index);
  return repeated === undefined ? okWith(values) : failWith(repeated);
}

/**
 * A non-blank trimmed one-line text of at most `max` characters that the fix
 * Task's brief can carry, or why not. The text lands in the fix Task's plan
 * context, which the spawn gate reads: a `{variable}` would fail the brief as
 * an unsubstituted template variable, a `LOOM_` token could pass for engine
 * authority, and a `Task ID:` could rebind the brief. A refused text never
 * reaches protected state, where it could not be corrected.
 */
function boundedText(value: string | undefined, flag: string, max: number, why: string): DomainResult<string, string> {
  if (value === undefined || value.length === 0) return failWith(`${flag} must say ${why}`);
  if (value.length > max) return failWith(`${flag} is longer than ${max} characters`);
  if (/[\r\n]/.test(value)) return failWith(`${flag} must be one line`);
  const placeholders = findResidualPlaceholders(value);
  if (placeholders.length > 0) {
    return failWith(`${flag} may not carry a {template variable} (${placeholders.join(", ")}); the fix Task's brief would be refused`);
  }
  if (/\bLOOM_[A-Z_]+/.test(value)) return failWith(`${flag} may not carry a LOOM_ token`);
  return /task id:/i.test(value) ? failWith(`${flag} may not carry a Task ID binding`) : okWith(value);
}

/**
 * Exactly one `--wave`, `--description` and `--reason`; one or more distinct
 * `--hold` Task ids and `--file` paths; at most one `--agent` (default
 * `code-implementer-agent`) and `--new-tests` (default `required`). A value
 * that is itself a flag is refused.
 */
export function parseForwardFixArgs(args: readonly string[]): DomainResult<ForwardFixRequest, string> {
  const fail = (problem: string) => freeze({ ok: false as const, error: `${problem}. ${FORWARD_FIX_USAGE}` });
  const collected = collectFlags(args);
  if (!collected.ok) return fail(collected.error);
  const flags = collected.value;
  if (flags.wave === undefined || !WAVE_NUMBER.test(flags.wave) || !Number.isSafeInteger(Number(flags.wave))) {
    return fail("--wave must name the active Wave as a positive integer");
  }
  const holdIds = flags.holds.map((raw) => parseTaskId(raw, "--hold"));
  const invalidHold = holdIds.flatMap((result) => result.ok ? [] : result.error.errors);
  if (invalidHold.length > 0) return fail(invalidHold.join("; "));
  const holds = distinct(holdIds.flatMap((result) => result.ok ? [result.value] : []));
  if (!holds.ok) return fail(`--hold ${holds.error} is given twice`);
  const [firstHold, ...restHolds] = holds.value;
  if (firstHold === undefined) return fail("--hold must name at least one Task whose judgement failed");
  const paths = flags.files.map((raw, index) => parseReviewPath(raw, `--file[${index}]`));
  const invalidPath = paths.flatMap((result) => result.ok ? [] : result.errors);
  if (invalidPath.length > 0) return fail(invalidPath.join("; "));
  const files = distinct(paths.flatMap((result) => result.ok ? [result.value as string] : []));
  if (!files.ok) return fail(`--file ${files.error} is given twice`);
  const [firstFile, ...restFiles] = files.value;
  if (firstFile === undefined) return fail("--file must name at least one path the fix changes");
  const description = boundedText(flags.description, "--description", MAX_DESCRIPTION_LENGTH, "what the fix changes");
  if (!description.ok) return fail(description.error);
  const reason = boundedText(flags.reason, "--reason", MAX_TASK_REOPENING_REASON_LENGTH, "which judgement failed and why");
  if (!reason.ok) return fail(reason.error);
  const agent = flags.agent ?? "code-implementer-agent";
  if (!isForwardFixAgent(agent)) return fail(`--agent must be one of ${FORWARD_FIX_AGENTS.join(", ")}`);
  const newTests = flags.newTests ?? "required";
  if (newTests !== "required" && newTests !== "existing-tests-sufficient") {
    return fail("--new-tests must be required or existing-tests-sufficient");
  }
  return freeze({
    ok: true as const,
    value: freeze({
      wave: Number(flags.wave),
      heldTaskIds: freeze([firstHold, ...restHolds] as const),
      files: freeze([firstFile, ...restFiles] as const),
      agent,
      description: description.value,
      reason: reason.value,
      newTests,
    }),
  });
}

/** The shared Wave-reopening refusal, in this operation's words. */
const waveReopeningRefusal = (refusal: WaveReopeningRefusal): DomainResult<never, Refusal<ForwardFixWaveRefusalKind>> =>
  match(refusal)
    .with({ kind: "not-executing" }, ({ phase }) =>
      refuse("not-executing", `a Forward Fix requires the execute Phase (current: ${phase})`))
    .with({ kind: "live-wave-gate" }, ({ runId, wave }) =>
      refuse("live-wave-gate", `Wave Gate run ${runId} owns Wave ${wave}'s verification; ` +
        "abandon it with helper orchestration abandon, then retry"))
    .with({ kind: "implementation-active" }, ({ holders }) =>
      refuse("implementation-active", `implementation reservations are active: ${holders.join(", ")}`))
    .exhaustive();

/** The Waves whose gate has completed. */
const completedWaves = (graph: TaskGraph): ReadonlySet<number> =>
  new Set((graph.wave_gate_history ?? []).map(({ wave }) => wave));

/**
 * The active, open Wave a Forward Fix changes, or the exact refusal: the shared
 * Wave-reopening precondition, then the requested Wave being that Wave, not
 * completed, and not under an abandoned run that names a successor (changing
 * the roster would orphan that successor's authority).
 */
function openForwardFixWave(graph: TaskGraph, requestedWave: number): DomainResult<ReopenableWave, Refusal<ForwardFixWaveRefusalKind>> {
  const reopenable = reopenableWave(graph);
  if (!reopenable.ok) return waveReopeningRefusal(reopenable.error);
  const { wave, abandonedRunId } = reopenable.value;
  if (wave !== requestedWave) return refuse("wrong-wave", `Wave ${requestedWave} is not the active Wave ${wave}`);
  if (completedWaves(graph).has(wave)) {
    return refuse("wave-completed", `Wave ${wave} has completed; a Forward Fix changes only the active, open Wave`);
  }
  const outcome = graph.active_wave_gate?.terminalOutcome;
  if (outcome?.kind === "terminal-abandoned" && outcome.supersededBy !== null) {
    return refuse("successor-named", `abandoned Wave Gate run ${abandonedRunId} names successor ` +
      `${outcome.supersededBy}; changing the Wave's Tasks would orphan that successor's authority, so start it ` +
      "(or abandon it naming no successor) first");
  }
  return reopenable;
}

/**
 * The Wave Gates once `wave`'s roster became `tasks`: its review and test bits
 * reset, implementation complete exactly when every Task of the Wave is, and
 * its block re-derived.
 */
function resetWaveGates(retired: TaskGraph, wave: number, tasks: readonly Task[]): TaskGraph["wave_gates"] {
  const existing = retired.wave_gates[String(wave)] ?? newWaveGate();
  const gate = {
    ...existing,
    impl_complete: tasks.filter((task) => task.wave === wave).every(({ status }) => status === "implemented" || status === "completed"),
    tests_passed: null,
    reviews_complete: false,
  };
  return reconcileWaveBlock({ ...retired.wave_gates, [String(wave)]: gate }, tasks, retired.spec_check, wave);
}

/** Whether `task` is a Forward Fix Task some audit records. */
const isForwardFixTask = (graph: TaskGraph, task: Task): boolean =>
  (graph.forward_fix_history ?? []).some(({ fixTaskId }) => fixTaskId === task.id);

/**
 * Whether `task`'s last implementation attempt failed: its owed dispatch is
 * the engine-authorized retry, or it reached terminal escalation.
 */
function judgementFailed(task: Task): boolean {
  const derivation = deriveTaskImplementationDispatch(task);
  return derivation.kind === "escalated" ||
    (derivation.kind === "dispatch" && derivation.dispatch.kind === "retry-implementation");
}

/** The first held Task that is not a failed judge of the active Wave, in request order, or null. */
function heldTaskRefusal(graph: TaskGraph, request: ForwardFixRequest): DomainResult<never, ForwardFixRefusal> | null {
  for (const id of request.heldTaskIds) {
    const task = graph.tasks.find((candidate) => candidate.id === id);
    if (task === undefined) return refuse("unknown-task", `${id} is not a Task of this TaskGraph`);
    if (task.wave !== request.wave) {
      return refuse("foreign-task", `${id} belongs to Wave ${task.wave}, not the active Wave ${request.wave}`);
    }
    const notAJudge = isDistillTask(task) ? "the Wave's distill pass" : isForwardFixTask(graph, task) ? "a Forward Fix Task" : null;
    if (notAJudge !== null) {
      return refuse("not-a-judge", `${id} is ${notAJudge}; only an authored Task that judges code is held`);
    }
    if (task.status !== "pending" || !judgementFailed(task)) {
      return refuse("no-failed-judgement", `${id} has no failed implementation attempt to answer (status ${task.status}); ` +
        "a Forward Fix answers a judgement that failed, so let the Task run first");
    }
  }
  return null;
}

/** The paths of `request` a Task of a completed Wave wrote, in request order. */
const sealedPathsOf = (graph: TaskGraph, request: ForwardFixRequest): readonly string[] => {
  const completed = completedWaves(graph);
  return request.files.filter((path) =>
    graph.tasks.some((task) => completed.has(task.wave) && (task.file_list ?? []).includes(path)));
};

/**
 * The sealed paths of an admissible request, or the first path that may not
 * join the active Wave (in request order), or the refusal of a request that
 * seals nothing.
 */
function admittedSealedPaths(graph: TaskGraph, request: ForwardFixRequest): DomainResult<NonEmpty<string>, ForwardFixRefusal> {
  const frozen = new Set((graph.acceptance_contracts ?? []).flatMap((contract) => frozenPaths(contract)));
  for (const path of request.files) {
    if (isProtectedVerificationPath(path)) {
      return refuse("protected-path", `'${path}' is protected verification infrastructure; no Task may write it`);
    }
    if (frozen.has(path)) {
      return refuse("frozen-path", `'${path}' is a frozen Acceptance Contract path; change it with a Contract Revision (helper revise-contract)`);
    }
    const owner = graph.tasks.find((task) => task.wave === request.wave && (task.file_list ?? []).includes(path));
    if (owner !== undefined) {
      return refuse("owned-in-wave", `'${path}' is in ${owner.id}'s file_list in the active Wave; ` +
        `fix it through ${owner.id} (helper orchestration reopen-task, or its own retry) instead`);
    }
  }
  const sealed = nonEmpty(sealedPathsOf(graph, request));
  return sealed === null
    ? refuse("not-sealed", "no --file path is written by a Task of a completed Wave; a Forward Fix exists for sealed code. " +
      "Change open code through the Task that owns it")
    : okWith(sealed);
}

/** The next free Task id after every id of the roster and every withdrawn fix Task, so a withdrawn id is never minted again. */
function nextTaskId(graph: TaskGraph): TaskId {
  const ids = [...graph.tasks.map(({ id }) => id), ...(graph.forward_fix_withdrawals ?? []).map(({ audit }) => audit.fixTaskId)];
  const highest = Math.max(0, ...ids.map((id) => TASK_ID_PATTERN.test(id) ? Number(id.slice(1)) : 0));
  const minted = parseTaskId(`T${highest + 1}`);
  if (!minted.ok) throw new Error(`unreachable: T${highest + 1} is not a Task id`);
  return minted.value;
}

/** The plan context a Forward Fix Task's brief carries, from the request alone. */
export function forwardFixPlanContext(request: ForwardFixRequest, sealedPaths: readonly string[]): string {
  return [
    `Forward Fix for ${request.heldTaskIds.join(", ")}: ${request.reason}`,
    `Sealed paths (written by a completed Wave): ${sealedPaths.join(", ")}.`,
    `${request.heldTaskIds.join(", ")} judge${request.heldTaskIds.length === 1 ? "s" : ""} this code and failed; ` +
      "change the code so the judgement passes. Never weaken, skip or loosen the judging tests or any budget they enforce.",
  ].join("\n");
}

/**
 * The fix Task's pending record, written by population's own builder: no
 * dependency, no Requirement trace, regression always required, and new
 * tests as the request says. Its I6 era is the graph's.
 */
function fixTaskOf(graph: TaskGraph, request: ForwardFixRequest, fixTaskId: TaskId, sealedPaths: NonEmpty<string>): Task {
  const scope = redThenGreenScope(graph.verification_manifest, graph.acceptance_contracts ?? []);
  return pendingAuthoredTask(
    {
      id: fixTaskId,
      description: request.description,
      agent: request.agent,
      wave: request.wave,
      depends_on: [],
      plan_context: forwardFixPlanContext(request, sealedPaths),
      verification_policy: serializeVerificationPolicy({
        regression: { kind: "required" },
        newTests: request.newTests === "required"
          ? { kind: "required" }
          : { kind: "waived", reason: "existing-tests-sufficient" },
      }),
      file_list: request.files,
    },
    taskRedThenGreenEra(scope, fixTaskId),
  );
}

/** Two lists with the same entries in the same order. */
const sameList = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((entry, index) => entry === right[index]);

/**
 * The committed audit this request replays: any audit in the history (not
 * only the latest) that the request describes exactly and whose fix Task is
 * still pending. A retry that arrives after a later Forward Fix is still a
 * replay.
 */
function replayedAudit(graph: TaskGraph, request: ForwardFixRequest): ForwardFixAudit | undefined {
  return (graph.forward_fix_history ?? []).find((audit) => {
    if (audit.wave !== request.wave || audit.reason !== request.reason || !sameList(audit.heldTaskIds, request.heldTaskIds)) {
      return false;
    }
    const fix = graph.tasks.find(({ id }) => id === audit.fixTaskId);
    return fix !== undefined && fix.status === "pending" && fix.description === request.description &&
      fix.agent === request.agent && sameList(fix.file_list ?? [], request.files);
  });
}

/**
 * Append a Forward Fix Task to the active Wave, or refuse with the exact
 * precondition that failed: the shared Wave-reopening precondition, then this
 * operation's Wave, held-Task and path checks. Replaying a committed Forward
 * Fix whose Task has not settled changes nothing.
 */
export function addForwardFix(graph: TaskGraph, request: ForwardFixRequest): DomainResult<ForwardFix, ForwardFixRefusal> {
  const replay = replayedAudit(graph, request);
  if (replay !== undefined) return okWith(freeze({ kind: "already-added" as const, audit: replay }));
  const open = openForwardFixWave(graph, request.wave);
  if (!open.ok) return open;
  const refusal = heldTaskRefusal(graph, request);
  if (refusal !== null) return refusal;
  const sealed = admittedSealedPaths(graph, request);
  if (!sealed.ok) return sealed;
  // A fix that takes part of a coupled file set takes all of it (ADR-0082).
  const gap = coupledSetGaps(graph.tasks, { id: "the Forward Fix", file_list: request.files })[0];
  if (gap !== undefined) return refuse("coupled-set-split", `${describeCoupledSetGap(gap)}; name every member with --file`);

  const { wave, abandonedRunId } = open.value;
  const sealedPaths = sealed.value;
  const fixTaskId = nextTaskId(graph);
  const retired = retireUnownedWaveReviewAuthority(graph, wave, abandonedRunId);
  const task = fixTaskOf(retired, request, fixTaskId, sealedPaths);
  const audit: ForwardFixAudit = freeze({
    schemaVersion: 1,
    kind: "forward-fix-added",
    wave,
    fixTaskId,
    heldTaskIds: request.heldTaskIds,
    sealedPaths,
    reason: request.reason,
    abandonedRunId,
  });
  const tasks = Object.freeze([...retired.tasks, task]);
  return freeze({
    ok: true as const,
    value: freeze({
      kind: "added" as const,
      task,
      audit,
      graph: freeze({
        ...retired,
        tasks,
        wave_gates: resetWaveGates(retired, wave, tasks),
        forward_fix_history: Object.freeze([...(graph.forward_fix_history ?? []), audit]),
      }),
    }),
  });
}

// ---------------------------------------------------------------------------
// Withdrawing a Forward Fix that was never dispatched
// ---------------------------------------------------------------------------

export type ForwardFixWithdrawalRequest = Readonly<{
  wave: number;
  fixTaskId: TaskId;
  reason: string;
}>;

export type ForwardFixWithdrawalOutcome =
  /** The fix Task left the roster and its audit moved into `withdrawal`: persist `graph`. */
  | Readonly<{ kind: "withdrawn"; graph: TaskGraph; withdrawal: ForwardFixWithdrawal }>
  /** This exact withdrawal already committed: nothing to write. */
  | Readonly<{ kind: "already-withdrawn"; withdrawal: ForwardFixWithdrawal }>;

/** What `withdrawForwardFix` can refuse. */
export type ForwardFixWithdrawalRefusalKind =
  | ForwardFixWaveRefusalKind
  /** The named Task is no Forward Fix of the active Wave. */
  | "not-a-forward-fix"
  /** The fix Task was already dispatched, so it has evidence to settle instead. */
  | "already-dispatched";

export type ForwardFixWithdrawalRefusal = Refusal<ForwardFixWithdrawalRefusalKind>;

export const FORWARD_FIX_WITHDRAWAL_USAGE =
  "Usage: helper orchestration withdraw-forward-fix --wave <N> --task <fix-task-id> --reason \"<why the fix is withdrawn>\"";

/** Exactly one `--wave`, `--task` (the fix Task) and `--reason`, in any order. */
export function parseForwardFixWithdrawalArgs(args: readonly string[]): DomainResult<ForwardFixWithdrawalRequest, string> {
  const fail = (problem: string) => failWith(`${problem}. ${FORWARD_FIX_WITHDRAWAL_USAGE}`);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index] ?? "";
    const value = args[index + 1];
    if (flag !== "--wave" && flag !== "--task" && flag !== "--reason") return fail(`unknown argument '${flag}'`);
    if (value === undefined || isFlagToken(value)) return fail(`${flag} needs a value`);
    if (values.has(flag)) return fail(`${flag} is given twice`);
    values.set(flag, value.trim());
  }
  const wave = values.get("--wave");
  if (wave === undefined || !WAVE_NUMBER.test(wave) || !Number.isSafeInteger(Number(wave))) {
    return fail("--wave must name the active Wave as a positive integer");
  }
  const fixTaskId = parseTaskId(values.get("--task"), "--task");
  if (!fixTaskId.ok) return fail(fixTaskId.error.errors.join("; "));
  const reason = boundedText(values.get("--reason"), "--reason", MAX_TASK_REOPENING_REASON_LENGTH, "why the fix is withdrawn");
  if (!reason.ok) return fail(reason.error);
  return okWith(freeze({ wave: Number(wave), fixTaskId: fixTaskId.value, reason: reason.value }));
}

/** The committed withdrawal this request replays: its fix Task is gone and the record names the same reason. */
const replayedWithdrawal = (graph: TaskGraph, request: ForwardFixWithdrawalRequest): ForwardFixWithdrawal | undefined =>
  (graph.forward_fix_withdrawals ?? []).find(({ audit, reason }) =>
    audit.fixTaskId === request.fixTaskId && audit.wave === request.wave && reason === request.reason &&
    !graph.tasks.some(({ id }) => id === request.fixTaskId));

/**
 * Withdraw a Forward Fix whose fix Task was never dispatched, or refuse with
 * the exact precondition that failed: the active, open Wave `addForwardFix`
 * also requires, a fix Task of a live audit of that Wave, and that Task still
 * exactly as it joined (`isUntouchedJoinedTask`). The fix Task leaves the roster and its audit moves whole
 * into `forward_fix_withdrawals`, which releases its hold on the judges.
 * Replaying a committed withdrawal changes nothing.
 */
export function withdrawForwardFix(
  graph: TaskGraph,
  request: ForwardFixWithdrawalRequest,
): DomainResult<ForwardFixWithdrawalOutcome, ForwardFixWithdrawalRefusal> {
  const replay = replayedWithdrawal(graph, request);
  if (replay !== undefined) return okWith(freeze({ kind: "already-withdrawn" as const, withdrawal: replay }));
  const open = openForwardFixWave(graph, request.wave);
  if (!open.ok) return open;
  const { wave, abandonedRunId } = open.value;
  const audit = (graph.forward_fix_history ?? []).find(({ fixTaskId }) => fixTaskId === request.fixTaskId);
  const fix = graph.tasks.find(({ id }) => id === request.fixTaskId);
  if (audit === undefined || audit.wave !== wave || fix === undefined) {
    return refuse("not-a-forward-fix", `${request.fixTaskId} is not a Forward Fix Task of the active Wave ${wave}`);
  }
  if (!isUntouchedJoinedTask(fix)) {
    return refuse("already-dispatched", `${request.fixTaskId} was already dispatched; let it settle, or reopen it, instead of withdrawing it`);
  }
  const withdrawal: ForwardFixWithdrawal = freeze({ schemaVersion: 1, kind: "forward-fix-withdrawn", audit, reason: request.reason });
  const retired = retireUnownedWaveReviewAuthority(graph, wave, abandonedRunId);
  const tasks = Object.freeze(retired.tasks.filter(({ id }) => id !== request.fixTaskId));
  return okWith(freeze({
    kind: "withdrawn" as const,
    withdrawal,
    graph: freeze({
      ...retired,
      tasks,
      wave_gates: resetWaveGates(retired, wave, tasks),
      forward_fix_history: Object.freeze((graph.forward_fix_history ?? []).filter((entry) => entry !== audit)),
      forward_fix_withdrawals: Object.freeze([...(graph.forward_fix_withdrawals ?? []), withdrawal]),
    }),
  }));
}
