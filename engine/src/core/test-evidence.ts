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
 * significant: the first pass tally with no later non-zero failure tally wins.
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
    const maven = lastMatch(bashOutput.replace(/\*\*/g, ""), /Tests run: \d+, Failures: 0, Errors: 0/);
    if (maven !== null) return Object.freeze({ passed: true, evidence: `maven: ${maven[0]}` });
  }

  for (const runner of RUNNER_TALLIES) {
    const passed = lastMatch(bashOutput, runner.pass);
    if (passed === null) continue;
    const failed = lastMatch(bashOutput, runner.fail);
    if (failed === null || failed[1] === "0" || failed.index < passed.index) {
      return Object.freeze({ passed: true, evidence: `${runner.label}: ${runner.render(passed)}` });
    }
  }

  return Object.freeze({ passed: false, evidence: "" });
}
