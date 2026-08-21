/** Pure classification of supported test-runner summaries. */

export type TestEvidence = Readonly<{
  passed: boolean;
  evidence: string;
}>;

/** Last regex match with its position in concatenated test output. */
type MatchWithIndex = RegExpMatchArray & Readonly<{ index: number }>;

function lastMatch(input: string, regex: RegExp): MatchWithIndex | null {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const matches = [...input.matchAll(new RegExp(regex.source, flags))];
  const last = matches.at(-1);
  return last === undefined ? null : last as MatchWithIndex;
}

type RunnerTally = Readonly<{
  label: string;
  pass: RegExp;
  fail: RegExp;
  render: (match: MatchWithIndex) => string;
}>;

/**
 * One source of truth for each runner's pass/fail tally shape. Order is
 * significant: the first pass tally that is not VETOED by a non-zero failure
 * tally wins. A failure tally on an EARLIER line is a superseded run and does
 * not veto; a failure tally on the SAME line as the pass tally is part of the
 * runner's one-line verdict unit (pytest: `2 failed, 6 passed in 0.42s`) and
 * vetoes it.
 */
const RUNNER_TALLIES: readonly RunnerTally[] = Object.freeze([
  { label: "node", pass: /(\d+) passing/, fail: /(\d+) failing/, render: (match) => match[0] },
  // Match Vitest's test tally, not the sibling `Test Files` tally.
  { label: "vitest", pass: /Tests?\s+\d+ passed/, fail: /Tests?\s+(\d+) failed/, render: (match) => match[0] },
  { label: "cargo", pass: /test result: ok\. (\d+) passed/, fail: /test result:.*(\d+) failed/, render: (match) => `${match[1]} passed` },
  // The timing suffix and line-start anchors prevent prose from minting passes.
  { label: "pytest", pass: /(\d+) passed\b[^\n]*\bin \d+(?:\.\d+)?s/, fail: /(\d+) failed/, render: (match) => match[0] },
  { label: "bun", pass: /^\s*(\d+) pass\b/m, fail: /^\s*(\d+) fail\b/m, render: (match) => match[0] },
]);

export function extractTestEvidence(bashOutput: string): TestEvidence {
  // Maven's pass tally already asserts zero failures and errors.
  if (/BUILD SUCCESS/.test(bashOutput)) {
    const stripped = bashOutput.replace(/\*\*/g, "");
    const maven = lastMatch(stripped, /Tests run: \d+, Failures: 0, Errors: 0/);
    if (maven !== null) {
      // A success tally is only the FINAL verdict when nothing worse follows it:
      // a later non-zero Failures:/Errors: tally (a broken re-run, or a later
      // module in the same output) or a later BUILD FAILURE vetoes it — the same
      // "last verdict wins" rule the runner loop applies, so a pass-then-fail
      // transcript cannot mint a pass off the superseded run.
      const tail = stripped.slice(maven.index);
      // The last tally in the tail is the final verdict: if it is the selected
      // zero tally the pass holds; a non-zero final tally vetoes (the runner
      // loop's same rule). The tail always contains the selected tally, so a
      // final tally always exists.
      const finalTally = lastMatch(tail, /Tests run: \d+, Failures: (\d+), Errors: (\d+)/);
      const tallyVetoes = finalTally !== null && (finalTally[1] !== "0" || finalTally[2] !== "0");
      if (!tallyVetoes && !/BUILD FAILURE/.test(tail)) {
        return Object.freeze({ passed: true, evidence: `maven: ${maven[0]}` });
      }
    }
  }

  for (const runner of RUNNER_TALLIES) {
    const passed = lastMatch(bashOutput, runner.pass);
    if (passed === null) continue;
    const failed = lastMatch(bashOutput, runner.fail);
    // A non-zero failure tally vetoes the pass unless it sits on an EARLIER
    // line — a superseded run whose verdict the later pass replaces. A
    // same-line failure is one verdict unit with the pass and wins.
    const vetoed = failed !== null &&
      failed[1] !== "0" &&
      lineOf(bashOutput, failed.index) >= lineOf(bashOutput, passed.index);
    if (!vetoed) {
      return Object.freeze({ passed: true, evidence: `${runner.label}: ${runner.render(passed)}` });
    }
  }

  return Object.freeze({ passed: false, evidence: "" });
}

/** Zero-based line number of the character at `index`. */
function lineOf(input: string, index: number): number {
  let line = 0;
  for (let i = 0; i < index; i += 1) {
    if (input.charCodeAt(i) === 10) line += 1;
  }
  return line;
}
