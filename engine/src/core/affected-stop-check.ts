/**
 * The affected-test stop check's pure core (I7, AD-10).
 * - `judgeAffectedRun` turns one affected run's parsed JUnit report into a
 *   verdict. Each failure is classified by the Wave Gate's own
 *   `classifyFailedTestcase`, so one it would excuse as expected RED never
 *   blocks.
 * - `stopCheckBlockDecision` is the whole block-counter transition rule for
 *   every stop check (the two runner checks, the Task mutation check and
 *   the Task owner check),
 *   applying `blockAdmission`, the per-check cap gate.
 * - `renderAffectedBlock` and `renderStopChecksBlock` build the one combined
 *   message a blocked agent reads.
 *
 * The block counter is not a lifecycle. It is a bounded integer, from 0 to the
 * cap, kept per agent and per check, and its only rule is the total function
 * below. The shell reads and writes only the counter files the decision names.
 *
 * Nothing here is completion evidence (INV-3): a verdict and a decision only
 * decide whether the same agent keeps working. Pure and total: no I/O, no
 * clock, no throw.
 */

import {
  ACCEPTANCE_BLOCK_HEADING,
  AFFECTED_BLOCK_HEADING,
  AFFECTED_EXCUSED_HEADING,
  AFFECTED_STOP_CHECK_SUBJECT,
  capReachedNote,
  counterUnreadableNote,
  MUTATION_BLOCK_HEADING,
  OWNER_BLOCK_HEADING,
  STOP_CHECK_NAMES,
  type AFFECTED_STOP_CHECK_MAX_BLOCKS,
  type TASK_MUTATION_STOP_CHECK_MAX_BLOCKS,
  type TASK_OWNER_STOP_CHECK_MAX_BLOCKS,
  type AffectedRunVerdict,
  type ExcusedAcceptanceTestcase,
  type FailingAffectedTestcase,
  type JudgeAffectedRunFn,
  type StopCheckBlockCount,
  type StopCheckName,
} from "./affected-stop-check-types";
import { classifyFailedTestcase, isFailedReportTestcase } from "./acceptance-contract/gate";
import { freeze, nonEmpty } from "./acceptance-contract/kernel";
import type { NonEmpty } from "./orchestration-contract";
import { attributeReportedFile } from "./report-file-attribution";
import { blocksRemainingLine } from "./task-record";

// --- Judging an affected run ---

/**
 * Judge one affected run. Each failed testcase goes through the Wave Gate's
 * own classification (`classifyFailedTestcase`): an expected-RED failure is
 * excused, and anything else blocks, including a collection error in an
 * acceptance file. Both lists name a testcase by the same file identity.
 */
export const judgeAffectedRun: JudgeAffectedRunFn = (projection, expectation): AffectedRunVerdict => {
  if (!projection.ok) return freeze({ kind: "unobservable", reason: `the affected runner's report could not be read: ${projection.error.message}` });
  if (projection.value.length === 0) return freeze({ kind: "passed", observed: "zero-tests" });
  const blocking: FailingAffectedTestcase[] = [];
  const excused: ExcusedAcceptanceTestcase[] = [];
  for (const testcase of projection.value.filter(isFailedReportTestcase)) {
    const judged = classifyFailedTestcase(expectation, testcase);
    if (judged.kind === "expected-red") excused.push(freeze({ file: judged.file, name: judged.name }));
    else blocking.push(freeze({ file: judged.file, name: judged.name, outcome: judged.collectionError ? "collection-error" : "failed" }));
  }
  const failing = nonEmpty(blocking);
  if (failing !== null) return freeze({ kind: "failing", testcases: failing, excused: freeze(excused) });
  const allExcused = nonEmpty(excused);
  return allExcused === null ? freeze({ kind: "passed", observed: "some-tests" }) : freeze({ kind: "excused", excused: allExcused });
};

// --- The block-counter transition rule ---

/** Each check's payload type, keyed by check name. */
export type StopCheckPayloads = { readonly [K in StopCheckName]: unknown };

/** The same payload type for every check. */
export type EveryCheck<T> = { readonly [K in StopCheckName]: T };

/**
 * One slot per stop check, each its payload or null. As the failures of one
 * stop, a null slot is a check with nothing it would block for: a passing,
 * skipped, off or fail-open check. The decision is generic over the payloads
 * so a block can carry the very failure it blocks for.
 */
export type StopCheckSlots<C extends StopCheckPayloads> = { readonly [K in StopCheckName]: C[K] | null };

/**
 * Each check's own block cap, typed by what its cap note states.
 * - `affected`, `mutation` and `owner` are the literal types of their
 *   constants. Each note states that constant, so any other cap would make the
 *   note misstate it.
 * - `acceptance` is any count. Its note writes in the cap it is given, so it
 *   is truthful for every value. Its constant, `ACCEPTANCE_STOP_CHECK_MAX_BLOCKS`,
 *   belongs to the acceptance shell, and a pure module does not import a shell.
 */
export type StopCheckBlockCaps = Readonly<{
  acceptance: number;
  affected: typeof AFFECTED_STOP_CHECK_MAX_BLOCKS;
  mutation: typeof TASK_MUTATION_STOP_CHECK_MAX_BLOCKS;
  owner: typeof TASK_OWNER_STOP_CHECK_MAX_BLOCKS;
}>;

/** A check that blocks this stop: the failure it blocks for, and the block
 *  count its counter now records. */
export type Blocking<Failure> = Readonly<{ failure: Failure; blocks: number }>;

declare const SOME_CHECKS: unique symbol;

/**
 * Slots with at least one filled. A block and its message are both of this
 * shape, so neither can name no check. Only `someChecks` and `mapSomeChecks`
 * build one, and each fills at least one slot.
 */
export type SomeChecks<C extends StopCheckPayloads> = StopCheckSlots<C> & { readonly [SOME_CHECKS]: true };

/** One entry per check, in check order, each from `at`: the one place a record is built by listing the check names. */
function perCheck<C extends StopCheckPayloads>(at: <K extends StopCheckName>(name: K) => C[K]): { readonly [K in StopCheckName]: C[K] } {
  return freeze({ acceptance: at("acceptance"), affected: at("affected"), mutation: at("mutation"), owner: at("owner") });
}

/**
 * The slots, one per check, each from `at`. It returns the named
 * `StopCheckSlots<C>`, not `perCheck`'s mapped record, so `someChecks` can
 * infer its payloads from the result; through `perCheck` alone the caller
 * would spell the slot type twice.
 */
const slotsOf = <C extends StopCheckPayloads>(at: <K extends StopCheckName>(name: K) => C[K] | null): StopCheckSlots<C> =>
  perCheck<StopCheckSlots<C>>(at);

/** The slots as `SomeChecks`, or null when none is filled. The brand's minting point, reached only with a filled slot. */
export function someChecks<C extends StopCheckPayloads>(slots: StopCheckSlots<C>): SomeChecks<C> | null {
  return STOP_CHECK_NAMES.some((name) => slots[name] !== null) ? (freeze({ ...slots }) as SomeChecks<C>) : null;
}

/**
 * Each filled slot through `f`, in check order. The result fills exactly the
 * slots `checks` fills, so it names at least one check too: a block's message
 * parts are this mapping over the checks the block names.
 */
export function mapSomeChecks<C extends StopCheckPayloads, Part>(
  checks: SomeChecks<C>,
  f: (name: StopCheckName, check: C[StopCheckName]) => Part,
): SomeChecks<EveryCheck<Part>> {
  const parts = slotsOf<EveryCheck<Part>>((name) => {
    const check = checks[name];
    return check === null ? null : f(name, check);
  });
  // The brand's minting point: `checks` fills at least one slot, and `parts` fills the same ones.
  return parts as SomeChecks<EveryCheck<Part>>;
}

/** The checks one block names, each with its failure and the count its counter records. A check absent here keeps its counter unchanged. */
export type BlockingChecks<C extends StopCheckPayloads> = SomeChecks<{ readonly [K in StopCheckName]: Blocking<C[K]> }>;

/**
 * The decision for one stop. A block names exactly the checks that contribute
 * failures, with the count each counter records. A proceeding stop clears
 * every counter, so it names none. `notes` explain every failing check that
 * was not allowed to block.
 */
export type StopCheckBlockDecision<C extends StopCheckPayloads> =
  | Readonly<{ outcome: "block"; blocking: BlockingChecks<C>; notes: readonly string[] }>
  | Readonly<{ outcome: "proceed"; notes: readonly string[] }>;

/**
 * What a stop says of one check: the heading of its part of a block message,
 * and the subject its fail-open notes name it by. The note wording itself is
 * `capReachedNote` and `counterUnreadableNote`, which CT-2's
 * `AFFECTED_NOTE_TEXT` also builds from, so the affected check's notes have
 * one source.
 */
type StopCheckDescriptor = Readonly<{ heading: string; subject: string }>;

/** One descriptor per stop check. */
const STOP_CHECKS: { readonly [K in StopCheckName]: StopCheckDescriptor } = freeze({
  acceptance: freeze({ heading: ACCEPTANCE_BLOCK_HEADING, subject: "the acceptance stop check" }),
  affected: freeze({ heading: AFFECTED_BLOCK_HEADING, subject: AFFECTED_STOP_CHECK_SUBJECT }),
  mutation: freeze({ heading: MUTATION_BLOCK_HEADING, subject: "the Task mutation check" }),
  owner: freeze({ heading: OWNER_BLOCK_HEADING, subject: "the Task owner check" }),
});

/** A check's cap note, stating the cap it was given: each typed cap is the one its note may state. */
const capNote = <K extends StopCheckName>(name: K, cap: StopCheckBlockCaps[K]): string =>
  capReachedNote(STOP_CHECKS[name].subject, cap);

const unreadableCounterNote = (name: StopCheckName, reason: string): string =>
  `${counterUnreadableNote(STOP_CHECKS[name].subject)}: ${reason}`;

/** Whether one check may still block this agent, and the count its counter
 *  would then record, or why it fails open. */
export type BlockAdmission =
  | Readonly<{ kind: "may-block"; blocks: number }>
  | Readonly<{ kind: "fails-open"; note: string }>;

/**
 * The per-check gate: under its cap with a readable count, a check may block
 * and would record `count + 1`; at the cap, or with an unreadable count, it
 * fails open. The block decision applies it to each failing check, and the
 * stop shell asks it before running a check at all.
 */
export function blockAdmission<K extends StopCheckName>(name: K, issued: StopCheckBlockCount, cap: StopCheckBlockCaps[K]): BlockAdmission {
  // Without a trustworthy count the cap cannot be enforced, so the check must not block.
  if (issued.kind === "unreadable") return freeze({ kind: "fails-open", note: unreadableCounterNote(name, issued.reason) });
  if (issued.blocks >= cap) return freeze({ kind: "fails-open", note: capNote(name, cap) });
  return freeze({ kind: "may-block", blocks: issued.blocks + 1 });
}

type CheckStep<Failure> = Readonly<{ blocking: Blocking<Failure> | null; note: string | null }>;

const NOT_BLOCKING: CheckStep<never> = freeze({ blocking: null, note: null });

/** One check's part of the decision: a failing check blocks when its gate admits it. */
function checkStep<K extends StopCheckName, Failure>(
  name: K,
  issued: StopCheckBlockCount,
  failure: Failure | null,
  cap: StopCheckBlockCaps[K],
): CheckStep<Failure> {
  if (failure === null) return NOT_BLOCKING;
  const admission = blockAdmission(name, issued, cap);
  return admission.kind === "fails-open"
    ? freeze({ blocking: null, note: admission.note })
    : freeze({ blocking: freeze({ failure, blocks: admission.blocks }), note: null });
}

export function stopCheckBlockDecision<C extends StopCheckPayloads>(
  issued: Readonly<Record<StopCheckName, StopCheckBlockCount>>,
  failures: StopCheckSlots<C>,
  caps: StopCheckBlockCaps,
): StopCheckBlockDecision<C> {
  const step = <K extends StopCheckName>(name: K): CheckStep<C[K]> => checkStep(name, issued[name], failures[name], caps[name]);
  const steps = perCheck<{ readonly [K in StopCheckName]: CheckStep<C[K]> }>(step);
  const notes = freeze(STOP_CHECK_NAMES.flatMap((name) => {
    const { note } = steps[name];
    return note === null ? [] : [note];
  }));
  const blocking = someChecks(slotsOf<{ readonly [K in StopCheckName]: Blocking<C[K]> }>((name) => steps[name].blocking));
  return blocking === null ? freeze({ outcome: "proceed", notes }) : freeze({ outcome: "block", blocking, notes });
}

// --- The block message ---

/** How a failing affected test's reported file maps to a declared repository
 *  path: through `attributeReportedFile` (INV-5), over the files the Task
 *  declared or changed. */
export type AffectedFileAttribution = Readonly<{ declared: readonly string[]; repositoryRoot: string | null }>;

const OUTCOME_TEXT: Readonly<Record<FailingAffectedTestcase["outcome"], string>> = freeze({
  "failed": "failed",
  "collection-error": "failed to collect",
});

/** One expected-RED acceptance failure as a block message or note names it. */
export const renderExcusedAcceptanceTestcase = ({ file, name }: ExcusedAcceptanceTestcase): string => `'${name}' (${file})`;

/** The affected check's part of a block message: what is failing, what fails
 *  without blocking, and what the agent may do about it. */
export function renderAffectedBlock(
  testcases: NonEmpty<FailingAffectedTestcase>,
  excused: readonly ExcusedAcceptanceTestcase[],
  attribution: AffectedFileAttribution,
  runnerOutput: string,
  blocksRemaining: number,
): string {
  const lines = testcases.map(({ file, name, outcome }) => {
    const shown = attributeReportedFile(attribution.declared, file, attribution.repositoryRoot) ?? file;
    return `- '${name}' (${shown}) — ${OUTCOME_TEXT[outcome]}`;
  });
  return [
    "LOOM AFFECTED-TEST STOP CHECK: tests affected by the files your attempt changed are failing.",
    "Keep working until they pass:",
    ...lines,
    ...(excused.length === 0 ? [] : ["", AFFECTED_EXCUSED_HEADING, ...excused.map((testcase) => `- ${renderExcusedAcceptanceTestcase(testcase)}`)]),
    "",
    "Failures can also come from a sibling Task editing concurrently; if your own code is correct, say that and stop.",
    blocksRemainingLine(blocksRemaining),
    ...(runnerOutput.trim() === "" ? [] : ["", "Runner output (tail):", runnerOutput.trimEnd()]),
  ].join("\n");
}

/** The parts of one combined block message. At least one check contributes. */
export type StopChecksBlockParts = SomeChecks<EveryCheck<string>>;

/** One combined block message: each contributing check's part under its own
 *  heading, in check order, acceptance first (AS-028). */
export function renderStopChecksBlock(parts: StopChecksBlockParts): string {
  return STOP_CHECK_NAMES.flatMap((name) => {
    const body = parts[name];
    return body === null ? [] : [`${STOP_CHECKS[name].heading}\n\n${body}`];
  }).join("\n\n");
}
