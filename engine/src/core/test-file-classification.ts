/**
 * The one test-file classifier (INV-2). Whether a path is a test file is
 * decided here, against a frozen suffix list or the engine default, and
 * nowhere else: the verification manifest freezes the default from here, the
 * I6 settlement split and brief section classify a Task's `file_list` here,
 * and the programmatic linter's test-file skip asks here.
 *
 * A suffix list, not globs or regexes: it matches the existing default form,
 * needs no matcher dependency, and digests canonically (AD-12).
 */

import type { NonEmpty } from "./orchestration-contract";
import type { TestFileClassification } from "./red-then-green-types";

/**
 * The frozen test-file classification. Declared here, by its owner: CT-2's
 * types file (`affected-stop-check-types.ts`) re-exports this declaration.
 * The import runs only that way round, because the types file imports
 * `../types`, which imports the verification manifest that freezes this
 * value, so declaring it there would close a cycle between top-level domains.
 */
export type FrozenTestFiles = Readonly<{
  source: "operator-manifest" | "engine-default";
  suffixes: NonEmpty<string>;
}>;

/** The engine's default test-file suffixes, used when a manifest declares none. */
export const DEFAULT_TEST_FILE_SUFFIXES: NonEmpty<string> = Object.freeze([
  ".test.ts",
  ".spec.ts",
  ".test.tsx",
  ".spec.tsx",
] as const);

/** The classification frozen for a manifest that declares no `testFileSuffixes`,
 *  a schema-1 manifest, or no manifest file at all. */
export const ENGINE_DEFAULT_TEST_FILES: FrozenTestFiles & Readonly<{ source: "engine-default" }> = Object.freeze({
  source: "engine-default",
  suffixes: DEFAULT_TEST_FILE_SUFFIXES,
});

/** Whether `path` is a test file under `suffixes`: its normalized form ends with one of them. */
export function isTestFileBySuffixes(path: string, suffixes: readonly string[]): boolean {
  const normalized = path.replace(/\\/g, "/");
  return suffixes.some((suffix) => normalized.endsWith(suffix));
}

/**
 * Partition a Task's `file_list` by the frozen classification, in `file_list`
 * order. Every entry that is not a test file (fixtures, helpers and type files
 * included) is an implementation file (FR-013).
 */
export function classifyTaskFiles(fileList: readonly string[], testFiles: FrozenTestFiles): TestFileClassification {
  const isTest = (file: string): boolean => isTestFileBySuffixes(file, testFiles.suffixes);
  return Object.freeze({
    testFiles: Object.freeze(fileList.filter(isTest)),
    implementationFiles: Object.freeze(fileList.filter((file) => !isTest(file))),
  });
}
