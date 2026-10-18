/**
 * The affected-test stop check's pure core (I7, AD-10).
 * - `judgeAffectedRun` turns one affected run's parsed JUnit report into a verdict.
 * - `stopCheckBlockDecision` is the whole block-counter transition rule for
 *   both stop checks, applying `blockAdmission`, the per-check cap gate.
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
  AFFECTED_NOTE_TEXT,
  type AFFECTED_STOP_CHECK_MAX_BLOCKS,
  type AffectedRunVerdict,
  type FailingAffectedTestcase,
  type JudgeAffectedRunFn,
  type StopCheckBlockCount,
  type StopCheckName,
} from "./affected-stop-check-types";
import { freeze, nonEmpty } from "./acceptance-contract/kernel";
import type { NonEmpty } from "./orchestration-contract";
import { attributeReportedFile } from "./report-file-attribution";
import { isCollectionErrorTestcase } from "./structured-test-report";

// --- Judging an affected run ---

export const judgeAffectedRun: JudgeAffectedRunFn = (projection): AffectedRunVerdict => {
  if (!projection.ok) return freeze({ kind: "unobservable", reason: `the affected runner's report could not be read: ${projection.error.message}` });
  if (projection.value.length === 0) return freeze({ kind: "passed", observed: "zero-tests" });
  const failing = nonEmpty(projection.value
    .filter(({ outcome }) => outcome === "failed")
    .map((testcase): FailingAffectedTestcase => freeze({
      file: testcase.classname,
      name: testcase.name,
      outcome: isCollectionErrorTestcase(testcase) ? "collection-error" : "failed",
    })));
  return failing === null ? freeze({ kind: "passed", observed: "some-tests" }) : freeze({ kind: "failing", testcases: failing });
};

// --- The block-counter transition rule ---

/**
 * Each check's failure at this stop, or null when it has none it would block
 * for: a passing, skipped, off or fail-open check is null. The decision is
 * generic over the failure so a block can carry the very failure it blocks for.
 */
export type StopCheckFailures<Acceptance, Affected> = Readonly<{ acceptance: Acceptance | null; affected: Affected | null }>;

/**
 * Each check's own block cap, typed by what its cap note states.
 * - `affected` is the literal type of `AFFECTED_STOP_CHECK_MAX_BLOCKS`. Its
 *   note is the fixed `AFFECTED_NOTE_TEXT["cap-reached"]`, built from that
 *   constant, so any other cap would make the note misstate it.
 * - `acceptance` is any count. Its note writes in the cap it is given, so it
 *   is truthful for every value. Its constant, `ACCEPTANCE_STOP_CHECK_MAX_BLOCKS`,
 *   belongs to the acceptance shell, and a pure module does not import a shell.
 */
export type StopCheckBlockCaps = Readonly<{ acceptance: number; affected: typeof AFFECTED_STOP_CHECK_MAX_BLOCKS }>;

/** A check that blocks this stop: the failure it blocks for, and the block
 *  count its counter now records. */
export type Blocking<Failure> = Readonly<{ failure: Failure; blocks: number }>;

/** The checks one block names: at least one, acceptance first. A check absent
 *  here keeps its counter unchanged. */
export type BlockingChecks<Acceptance, Affected> =
  | Readonly<{ acceptance: Blocking<Acceptance>; affected: Blocking<Affected> | null }>
  | Readonly<{ acceptance: null; affected: Blocking<Affected> }>;

/**
 * The decision for one stop. A block names exactly the checks that contribute
 * failures, with the count each counter records. A proceeding stop clears both
 * counters, so it names none. `notes` explain every failing check that was not
 * allowed to block.
 */
export type StopCheckBlockDecision<Acceptance, Affected> =
  | Readonly<{ outcome: "block"; blocking: BlockingChecks<Acceptance, Affected>; notes: readonly string[] }>
  | Readonly<{ outcome: "proceed"; notes: readonly string[] }>;

const CAP_NOTE: { readonly [K in StopCheckName]: (cap: StopCheckBlockCaps[K]) => string } = freeze({
  acceptance: (cap) => `the acceptance stop check reached its ${cap}-block cap`,
  affected: () => AFFECTED_NOTE_TEXT["cap-reached"],
});

const UNREADABLE_NOTE: Readonly<Record<StopCheckName, (reason: string) => string>> = freeze({
  acceptance: (reason) => `the acceptance stop check's block counter is unreadable: ${reason}`,
  affected: (reason) => `${AFFECTED_NOTE_TEXT["counter-unreadable"]}: ${reason}`,
});

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
  if (issued.kind === "unreadable") return freeze({ kind: "fails-open", note: UNREADABLE_NOTE[name](issued.reason) });
  if (issued.blocks >= cap) return freeze({ kind: "fails-open", note: CAP_NOTE[name](cap) });
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

export function stopCheckBlockDecision<Acceptance, Affected>(
  issued: Readonly<Record<StopCheckName, StopCheckBlockCount>>,
  failures: StopCheckFailures<Acceptance, Affected>,
  caps: StopCheckBlockCaps,
): StopCheckBlockDecision<Acceptance, Affected> {
  const acceptance = checkStep("acceptance", issued.acceptance, failures.acceptance, caps.acceptance);
  const affected = checkStep("affected", issued.affected, failures.affected, caps.affected);
  const notes = freeze([acceptance.note, affected.note].filter((note): note is string => note !== null));
  if (acceptance.blocking !== null) {
    return freeze({ outcome: "block", blocking: freeze({ acceptance: acceptance.blocking, affected: affected.blocking }), notes });
  }
  if (affected.blocking !== null) {
    return freeze({ outcome: "block", blocking: freeze({ acceptance: null, affected: affected.blocking }), notes });
  }
  return freeze({ outcome: "proceed", notes });
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

/** The affected check's part of a block message: what is failing, and what the agent may do about it. */
export function renderAffectedBlock(
  testcases: NonEmpty<FailingAffectedTestcase>,
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
    "",
    "Failures can also come from a sibling Task editing concurrently; if your own code is correct, say that and stop.",
    `This check blocks at most ${blocksRemaining} more time(s); after that your stop proceeds and the Wave Gate judges.`,
    ...(runnerOutput.trim() === "" ? [] : ["", "Runner output (tail):", runnerOutput.trimEnd()]),
  ].join("\n");
}

/** The parts of one combined block message. At least one check contributes. */
export type StopChecksBlockParts =
  | Readonly<{ acceptance: string; affected: string | null }>
  | Readonly<{ acceptance: null; affected: string }>;

/** One combined block message: each contributing check's part under its own
 *  heading, acceptance first (AS-028). */
export function renderStopChecksBlock(parts: StopChecksBlockParts): string {
  const section = (heading: string, body: string | null): readonly string[] => body === null ? [] : [`${heading}\n\n${body}`];
  return [...section(ACCEPTANCE_BLOCK_HEADING, parts.acceptance), ...section(AFFECTED_BLOCK_HEADING, parts.affected)].join("\n\n");
}
