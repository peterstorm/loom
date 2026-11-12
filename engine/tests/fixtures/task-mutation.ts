/**
 * What the Task mutation check's suites share (ADR-0071):
 * - `START_SHA`, a base commit a fixture Task records;
 * - `mutationManifest`, a frozen verification manifest under which an
 *   implementation Task owes the check, with one part changed or left out;
 * - `junitReport`, the JUnit bytes a runner leaves for a list of testcases.
 */

import { freezeVerificationManifest, type FrozenVerificationManifest, type TaskMutationCheckSetting } from "../../src/core/verification-manifest";
import { AFFECTED_RUNNER } from "./stop-check-runners";

export const START_SHA = "a".repeat(40);

export type JunitCase = Readonly<{ file: string; name: string; outcome: "passed" | "failed" }>;

/** A JUnit report of `cases`, each testcase's classname its file. */
export const junitReport = (cases: readonly JunitCase[]): Uint8Array => new TextEncoder().encode(
  `<?xml version="1.0"?><testsuites><testsuite name="suite" tests="${cases.length}">` +
  cases.map(({ file, name, outcome }) => `<testcase classname="${file}" name="${name}">${outcome === "failed" ? "<failure/>" : ""}</testcase>`).join("") +
  "</testsuite></testsuites>");

export type MutationManifestOverrides = Readonly<{
  /** The operator's switch; left undeclared by default, which reads as `on`. */
  taskMutationCheck?: TaskMutationCheckSetting;
  /** `undefined` freezes a manifest with no affected runner. */
  affectedRunner?: typeof AFFECTED_RUNNER | undefined;
  /** The affected runner's cwd; the repository root by default. */
  cwd?: string;
}>;

/** A frozen operator manifest with `AFFECTED_RUNNER` and `.test.ts` test files, as population freezes it. */
export function mutationManifest(overrides: MutationManifestOverrides = {}): FrozenVerificationManifest {
  const { cwd, ...rest } = overrides;
  const declared = { affectedRunner: AFFECTED_RUNNER, testFileSuffixes: [".test.ts"], ...rest };
  const affectedRunner = declared.affectedRunner === undefined || cwd === undefined ? declared.affectedRunner : { ...declared.affectedRunner, cwd };
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 2, kind: "loom-verification-manifest", checks: [], ...declared, affectedRunner,
  })));
  if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
  return frozen.value;
}
