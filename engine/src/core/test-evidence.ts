/** Pure classification of supported test-runner summaries. */

export type TestEvidence = Readonly<{
  passed: boolean;
  evidence: string;
}>;

/** Regex match with its position in concatenated test output. */
type MatchWithIndex = RegExpMatchArray & Readonly<{ index: number }>;

function allMatches(input: string, regex: RegExp): readonly MatchWithIndex[] {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  return Object.freeze(
    [...input.matchAll(new RegExp(regex.source, flags))].map((match) => match as MatchWithIndex),
  );
}

type RunnerTally = Readonly<{
  label: string;
  /** Group 1 is the executed-test count, when the runner reports one. */
  pass: RegExp;
  fail: RegExp;
  renderPass: (match: MatchWithIndex) => string;
  renderFail: (match: MatchWithIndex) => string;
}>;

type RunnerVerdict = Readonly<{
  label: string;
  line: number;
  kind: "passed" | "failed" | "zero";
  summary: string;
}>;

/**
 * How many tests a tally says actually ran.
 *
 * A zero-test tally is not a passing run. `judgeTestRun` already treats a
 * report with zero tests as a failure, while this transcript path read
 * `0 passing` as success — the two evidence paths reached opposite verdicts for
 * one run. A suite that collected nothing proves nothing.
 */
const tallyCount = (match: MatchWithIndex): number => {
  const raw = match[1];
  const count = raw === undefined ? 1 : Number(raw);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
};

/**
 * One source of truth for each runner's bounded pass/fail tally shape.
 *
 * A runner's later run supersedes its own earlier run. Different runners do
 * not supersede one another: every latest runner verdict is aggregated, and
 * any failure or zero-test verdict dominates every pass.
 */
const RUNNER_TALLIES: readonly RunnerTally[] = Object.freeze([
  {
    label: "node",
    pass: /^[ \t]*(\d+) passing(?:[ \t]+\([^)]+\))?[ \t]*$/m,
    fail: /^[ \t]*(\d+) failing(?:[ \t]+\([^)]+\))?[ \t]*$/m,
    renderPass: (match) => match[0].trim(),
    renderFail: (match) => match[0].trim(),
  },
  // Match Vitest's test tally, not the sibling `Test Files` tally.
  {
    label: "vitest",
    pass: /^[ \t]*Tests?[ \t]+(\d+) passed(?:[ \t]+\(\d+\))?[ \t]*$/m,
    fail: /^[ \t]*Tests?[ \t]+(\d+) failed(?:[ \t]+\(\d+\))?[ \t]*$/m,
    renderPass: (match) => match[0].trim(),
    renderFail: (match) => match[0].trim(),
  },
  {
    label: "cargo",
    pass: /^test result: ok\. (\d+) passed;[^\n]*$/m,
    fail: /^test result:.*?(\d+) failed[^\n]*$/m,
    renderPass: (match) => `${match[1]} passed`,
    renderFail: (match) => `${match[1]} failed`,
  },
  // The timing suffix prevents ordinary prose from minting pytest passes.
  {
    label: "pytest",
    pass: /^(?:[ \t]*=+[ \t]*)?(\d+) passed\b[^\n]*\bin \d+(?:\.\d+)?s(?:[ \t]*=+)?[ \t]*$/m,
    fail: /^(?:[ \t]*=+[ \t]*)?[^\n]*?(\d+) failed[^\n]*\bin \d+(?:\.\d+)?s(?:[ \t]*=+)?[ \t]*$/m,
    renderPass: (match) => match[0].trim(),
    renderFail: (match) => match[0].trim(),
  },
  {
    label: "bun",
    pass: /^[ \t]*(\d+) pass\b[^\n]*$/m,
    fail: /^[ \t]*(\d+) fail\b[^\n]*$/m,
    renderPass: (match) => match[0].trim(),
    renderFail: (match) => match[0].trim(),
  },
]);

const verdictPriority = (verdict: RunnerVerdict): number => verdict.kind === "failed" ? 1 : 0;

function latestRunnerVerdict(input: string, runner: RunnerTally): RunnerVerdict | null {
  const passes = allMatches(input, runner.pass).map((match): RunnerVerdict => {
    const executed = tallyCount(match);
    return Object.freeze({
      label: runner.label,
      line: lineOf(input, match.index),
      kind: executed === 0 ? "zero" : "passed",
      summary: executed === 0 ? "0 tests executed" : runner.renderPass(match),
    });
  });
  const failures = allMatches(input, runner.fail)
    .filter((match) => tallyCount(match) > 0)
    .map((match): RunnerVerdict => Object.freeze({
      label: runner.label,
      line: lineOf(input, match.index),
      kind: "failed",
      summary: runner.renderFail(match),
    }));
  return [...passes, ...failures].reduce<RunnerVerdict | null>((latest, candidate) => {
    if (latest === null || candidate.line > latest.line) return candidate;
    return candidate.line === latest.line && verdictPriority(candidate) > verdictPriority(latest)
      ? candidate
      : latest;
  }, null);
}

function latestMavenVerdict(input: string): RunnerVerdict | null {
  const stripped = input.replace(/\*\*/g, "");
  const hasBuildSuccess = /BUILD SUCCESS/.test(stripped);
  const tallies = allMatches(stripped, /Tests run: (\d+), Failures: (\d+), Errors: (\d+)/)
    .flatMap((match): readonly RunnerVerdict[] => {
      const executed = tallyCount(match);
      const failed = match[2] !== "0" || match[3] !== "0";
      if (!failed && !hasBuildSuccess) return [];
      return [Object.freeze({
        label: "maven",
        line: lineOf(stripped, match.index),
        kind: failed ? "failed" : executed === 0 ? "zero" : "passed",
        summary: executed === 0 && !failed ? "0 tests executed" : match[0],
      })];
    });
  const buildFailures = allMatches(stripped, /^BUILD FAILURE[ \t]*$/m)
    .map((match): RunnerVerdict => Object.freeze({
      label: "maven",
      line: lineOf(stripped, match.index),
      kind: "failed",
      summary: match[0],
    }));
  return [...tallies, ...buildFailures].reduce<RunnerVerdict | null>((latest, candidate) =>
    latest === null || candidate.line >= latest.line ? candidate : latest, null);
}

export function extractTestEvidence(bashOutput: string): TestEvidence {
  const verdicts = Object.freeze([
    latestMavenVerdict(bashOutput),
    ...RUNNER_TALLIES.map((runner) => latestRunnerVerdict(bashOutput, runner)),
  ].filter((verdict): verdict is RunnerVerdict => verdict !== null));
  const evidence = verdicts.map(({ label, summary }) => `${label}: ${summary}`).join("; ");
  const passed = verdicts.length > 0 && verdicts.every(({ kind }) => kind === "passed");
  return Object.freeze({ passed, evidence });
}

/** Zero-based line number of the character at `index`. */
function lineOf(input: string, index: number): number {
  let line = 0;
  for (let i = 0; i < index; i += 1) {
    if (input.charCodeAt(i) === 10) line += 1;
  }
  return line;
}
