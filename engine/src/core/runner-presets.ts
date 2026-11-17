/**
 * Known test runners as `affectedRunner` presets, and the one rule that picks
 * one from what a repository shows (loom#198, Cause 3).
 *
 * An `affectedRunner` is data in the Verification Manifest: an executable,
 * its arguments with one `{files}` slot, and the report path the runner
 * writes. Loom needs nothing from a runner but a JUnit XML or Vitest/Jest
 * JSON report with per-file results, so any runner that can write one works
 * without a change to Loom; these presets only spare the operator from
 * working out the reporter flags. A runner missing here is one row added
 * here, or the generic shape written by hand.
 *
 * Every preset passes the manifest's command policy as it stands (the
 * executable allowlist and the argv rules in `completion-suite.ts`); the
 * presets test pins that by freezing each one.
 *
 * Pure.
 */

/** The report path every preset writes, beneath the protected completion-report root. */
export const PRESET_JUNIT_REPORT = ".loom/completion-reports/affected.junit.xml" as const;
export const PRESET_JSON_REPORT = ".loom/completion-reports/affected.json" as const;

export const RUNNER_PRESET_IDS = ["vitest", "jest", "mocha", "mocha-ts-node", "bun", "node-test"] as const;
export type RunnerPresetId = (typeof RUNNER_PRESET_IDS)[number];

/** An `affectedRunner` as the manifest declares it. */
export type AffectedRunnerDeclaration = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: ".";
  timeoutMs: number;
  report: Readonly<{ kind: "required-file"; path: string }>;
}>;

const TIMEOUT_MS = 120_000;

const preset = (executable: string, args: readonly string[], reportPath: string = PRESET_JUNIT_REPORT): AffectedRunnerDeclaration => Object.freeze({
  executable,
  args: Object.freeze([...args]),
  cwd: ".",
  timeoutMs: TIMEOUT_MS,
  report: Object.freeze({ kind: "required-file", path: reportPath }),
});

/** Each preset's declaration. Keyed by every preset id, so a new id does not compile without one. */
export const RUNNER_PRESETS: Readonly<Record<RunnerPresetId, AffectedRunnerDeclaration>> = Object.freeze({
  vitest: preset("node_modules/.bin/vitest", ["run", "--reporter=junit", `--outputFile=${PRESET_JUNIT_REPORT}`, "{files}"]),
  jest: preset("node_modules/.bin/jest", ["--ci", "--json", `--outputFile=${PRESET_JSON_REPORT}`, "--runTestsByPath", "{files}"], PRESET_JSON_REPORT),
  mocha: preset("node", ["node_modules/mocha/bin/mocha.js", "--reporter", "xunit", "--reporter-option", `output=${PRESET_JUNIT_REPORT}`, "{files}"]),
  "mocha-ts-node": preset("node", [
    "node_modules/mocha/bin/mocha.js", "--extension", "ts", "-r", "ts-node/register",
    "--reporter", "xunit", "--reporter-option", `output=${PRESET_JUNIT_REPORT}`, "{files}",
  ]),
  bun: preset("bun", ["test", "--reporter=junit", `--reporter-outfile=${PRESET_JUNIT_REPORT}`, "{files}"]),
  "node-test": preset("node", ["--test", "--test-reporter=junit", `--test-reporter-destination=${PRESET_JUNIT_REPORT}`, "{files}"]),
});

/** What the shell observed of a repository, for the detection rule. */
export type PackageRunnerFacts = Readonly<{
  /** `package.json`'s dependency and devDependency names; empty when there is none. */
  packages: ReadonlySet<string>;
  /** `package.json`'s `scripts.test`, or null. */
  testScript: string | null;
  /** Why a `package.json` that exists could not be read, or null: the hint names it. */
  packageJsonProblem: string | null;
}>;

export type RepositoryRunnerFacts = PackageRunnerFacts & Readonly<{
  /** Whether a Bun lockfile (bun.lock, or the older binary one) exists. */
  bunLockfile: boolean;
}>;

/** A preset the facts point to, and the one fact that decided it. */
export type RunnerSuggestion = Readonly<{ preset: RunnerPresetId; because: string }>;

const mochaPreset = (facts: RepositoryRunnerFacts): RunnerPresetId =>
  facts.packages.has("ts-node") ? "mocha-ts-node" : "mocha";

/**
 * The preset a repository's own facts point to, or null when none does. The
 * test script decides first (it is what the project runs), then the
 * installed runner packages, then a Bun lockfile.
 */
export function suggestRunnerPreset(facts: RepositoryRunnerFacts): RunnerSuggestion | null {
  const script = facts.testScript ?? "";
  const mocha = mochaPreset(facts);
  const byScript: readonly (readonly [RegExp, RunnerPresetId])[] = [
    [/\bvitest\b/, "vitest"],
    [/\bjest\b/, "jest"],
    [/\bmocha\b/, mocha],
    [/\bbun\s+test\b/, "bun"],
    [/\bnode\s+--test\b/, "node-test"],
  ];
  const scripted = byScript.find(([pattern]) => pattern.test(script));
  if (scripted !== undefined) return Object.freeze({ preset: scripted[1], because: `package.json scripts.test runs \`${script}\`` });
  const byPackage: readonly (readonly [string, RunnerPresetId])[] = [["vitest", "vitest"], ["jest", "jest"], ["mocha", mocha]];
  const installed = byPackage.find(([name]) => facts.packages.has(name));
  if (installed !== undefined) return Object.freeze({ preset: installed[1], because: `package.json depends on ${installed[0]}` });
  return facts.bunLockfile ? Object.freeze({ preset: "bun", because: "the repository has a Bun lockfile" }) : null;
}

/** The manifest fragment to paste, as indented JSON. */
export const renderAffectedRunner = (preset: RunnerPresetId): string =>
  JSON.stringify({ affectedRunner: RUNNER_PRESETS[preset] }, null, 2);

/** How to declare the runner `facts` point to: `affectedRunnerHint` over the detected preset. */
export const affectedRunnerHintFor = (facts: RepositoryRunnerFacts, manifestPath: string): string =>
  affectedRunnerHint(suggestRunnerPreset(facts), manifestPath, facts.packageJsonProblem);

/**
 * How to declare the runner, as the population refusal and
 * `helper suggest-affected-runner` print it: the detected preset with why,
 * or the generic shape when nothing was detected, and where it goes.
 */
export function affectedRunnerHint(suggestion: RunnerSuggestion | null, manifestPath: string, packageJsonProblem: string | null = null): string {
  const where = `Add it to ${manifestPath} (schemaVersion 2), install it with \`helper write-verification-manifest\`, then re-run populate-task-graph. ` +
    "Any runner works that writes a JUnit XML or Vitest/Jest JSON report with per-file results to the declared path; " +
    `\`{files}\` is replaced by the test files. Presets: ${RUNNER_PRESET_IDS.join(", ")}.`;
  if (suggestion === null) {
    const unread = packageJsonProblem === null ? "" : ` (${packageJsonProblem}; fix it to get a suggestion)`;
    return `No known test runner was detected${unread}. Declare one in this shape:\n` +
      JSON.stringify({ affectedRunner: { executable: "<runner>", args: ["<reporter flags>", "{files}"], cwd: ".", timeoutMs: TIMEOUT_MS, report: { kind: "required-file", path: PRESET_JUNIT_REPORT } } }, null, 2) +
      `\n${where}`;
  }
  return `Suggested runner: ${suggestion.preset} (${suggestion.because}):\n${renderAffectedRunner(suggestion.preset)}\n${where}`;
}
