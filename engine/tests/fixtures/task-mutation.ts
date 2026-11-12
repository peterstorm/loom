/**
 * What the Task mutation check's suites share (ADR-0071):
 * - `START_SHA`, a base commit a fixture Task records;
 * - `mutationManifest`, the one frozen verification manifest under which an
 *   implementation Task owes the check, with one part changed or left out:
 *   the in-memory suites take its defaults, and the real fixture repository
 *   (`task-mutation-repo.ts`) passes its own runner and test-file suffixes;
 * - `junitReport`, the JUnit bytes a runner leaves for a list of testcases;
 * - `talliedResult`, a `TaskMutationResult` built through its one
 *   constructor, so no suite writes a result the engine could not produce.
 */

import { taskMutationResult, type TaskMutationResult, type TaskMutationTally } from "../../src/core/task-mutation-check";
import { freezeVerificationManifest, type FrozenVerificationManifest, type TaskMutationCheckSetting } from "../../src/core/verification-manifest";
import { AFFECTED_RUNNER } from "./stop-check-runners";

export const START_SHA = "a".repeat(40);

export type JunitCase = Readonly<{ file: string; name: string; outcome: "passed" | "failed" }>;

/** A JUnit report of `cases`, each testcase's classname its file. */
export const junitReport = (cases: readonly JunitCase[]): Uint8Array => new TextEncoder().encode(
  `<?xml version="1.0"?><testsuites><testsuite name="suite" tests="${cases.length}">` +
  cases.map(({ file, name, outcome }) => `<testcase classname="${file}" name="${name}">${outcome === "failed" ? "<failure/>" : ""}</testcase>`).join("") +
  "</testsuite></testsuites>");

/** An affected runner as an operator declares it in the manifest. */
export type AffectedRunnerDeclaration = Readonly<{
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  report: Readonly<{ kind: "required-file"; path: string }>;
}>;

export type MutationManifestOverrides = Readonly<{
  /** The operator's switch; left undeclared by default, which reads as `on`. */
  taskMutationCheck?: TaskMutationCheckSetting;
  /** `AFFECTED_RUNNER` by default; `undefined` freezes a manifest with no affected runner. */
  affectedRunner?: AffectedRunnerDeclaration | undefined;
  /** The affected runner's cwd; the runner's own by default. */
  cwd?: string;
  /** The frozen Test-File Classification; `.test.ts` by default. */
  testFileSuffixes?: readonly string[];
}>;

/** A frozen operator manifest under which an implementation Task owes the check, as population freezes it. */
export function mutationManifest(overrides: MutationManifestOverrides = {}): FrozenVerificationManifest {
  const { cwd, ...rest } = overrides;
  const declared = { affectedRunner: AFFECTED_RUNNER, testFileSuffixes: [".test.ts"], ...rest };
  const affectedRunner = declared.affectedRunner === undefined || cwd === undefined ? declared.affectedRunner : { ...declared.affectedRunner, cwd };
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2, kind: "loom-verification-manifest", checks: [], ...declared, affectedRunner,
  })));
  if (!frozen.ok) throw new Error(`fixture manifest refused: ${frozen.error.errors.join("; ")}`);
  return frozen.value;
}

/** The result `tally` makes; a tally the constructor refuses is a broken fixture. */
export function talliedResult(tally: Partial<TaskMutationTally> & Pick<TaskMutationTally, "candidates">): TaskMutationResult {
  const result = taskMutationResult({ killed: 0, invalid: 0, survivors: [], ...tally });
  if (!result.ok) throw new Error(`fixture tally refused: ${result.error}`);
  return result.value;
}
