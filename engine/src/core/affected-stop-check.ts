/**
 * The affected-test stop check's pure core (I7, AD-10).
 * - `judgeAffectedRun` turns one affected run's parsed JUnit report into a verdict.
 * - `stopCheckBlockDecision` is the whole block-counter transition rule for
 *   both stop checks.
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

export type StopCheckName = "acceptance" | "affected";

/** Whether a check has failures it would block the stop for. A passing,
 *  skipped, off or fail-open check is `not-failing`. */
export type CheckVerdict = "failing" | "not-failing";

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

/** What a blocking stop writes to one check's counter: unchanged, or the new block count. */
export type BlockCounterWrite =
  | Readonly<{ kind: "keep" }>
  | Readonly<{ kind: "set"; blocks: number }>;

/**
 * The decision for one stop. A block names each check's counter write, and a
 * check contributes failures to the block exactly when its write is `set`. A
 * proceeding stop clears both counters, so it names no write. `notes` explain
 * every failing check that was not allowed to block.
 */
export type StopCheckBlockDecision =
  | Readonly<{ outcome: "block"; record: Readonly<Record<StopCheckName, BlockCounterWrite>>; notes: readonly string[] }>
  | Readonly<{ outcome: "proceed"; notes: readonly string[] }>;

const CAP_NOTE: { readonly [K in StopCheckName]: (cap: StopCheckBlockCaps[K]) => string } = freeze({
  acceptance: (cap) => `the acceptance stop check reached its ${cap}-block cap`,
  affected: () => AFFECTED_NOTE_TEXT["cap-reached"],
});

const UNREADABLE_NOTE: Readonly<Record<StopCheckName, (reason: string) => string>> = freeze({
  acceptance: (reason) => `the acceptance stop check's block counter is unreadable: ${reason}`,
  affected: (reason) => `${AFFECTED_NOTE_TEXT["counter-unreadable"]}: ${reason}`,
});

type CheckStep = Readonly<{ write: BlockCounterWrite; note: string | null }>;

const KEEP: CheckStep = freeze({ write: freeze({ kind: "keep" }), note: null });

/** One check's part of the decision: a failing check under its cap blocks
 *  and records `count + 1`; at the cap, or with an unreadable count, it fails open. */
function checkStep<K extends StopCheckName>(name: K, issued: StopCheckBlockCount, verdict: CheckVerdict, cap: StopCheckBlockCaps[K]): CheckStep {
  if (verdict === "not-failing") return KEEP;
  // Without a trustworthy count the cap cannot be enforced, so the check must not block.
  if (issued.kind === "unreadable") return freeze({ write: KEEP.write, note: UNREADABLE_NOTE[name](issued.reason) });
  if (issued.blocks >= cap) return freeze({ write: KEEP.write, note: CAP_NOTE[name](cap) });
  return freeze({ write: freeze({ kind: "set", blocks: issued.blocks + 1 }), note: null });
}

export function stopCheckBlockDecision(
  issued: Readonly<Record<StopCheckName, StopCheckBlockCount>>,
  verdicts: Readonly<Record<StopCheckName, CheckVerdict>>,
  caps: StopCheckBlockCaps,
): StopCheckBlockDecision {
  const acceptance = checkStep("acceptance", issued.acceptance, verdicts.acceptance, caps.acceptance);
  const affected = checkStep("affected", issued.affected, verdicts.affected, caps.affected);
  const notes = freeze([acceptance.note, affected.note].filter((note): note is string => note !== null));
  return acceptance.write.kind === "set" || affected.write.kind === "set"
    ? freeze({ outcome: "block", record: freeze({ acceptance: acceptance.write, affected: affected.write }), notes })
    : freeze({ outcome: "proceed", notes });
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
