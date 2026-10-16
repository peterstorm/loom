/**
 * INV-2 matrix: whether a path is a test file is decided only by
 * `core/test-file-classification.ts`, against the frozen suffixes or the
 * engine default.
 *
 * One set of `file_list`s runs, under the engine default and under operator
 * suffixes, through the owner (`isTestFileBySuffixes`, `classifyTaskFiles`)
 * and through every sibling entry point that exists in this slice:
 *   - `verification-manifest.ts`, which freezes `testFiles` on every freeze
 *     path (operator suffixes, operator manifest without them, schema 1, and
 *     the no-file engine default);
 *   - `linter/programmatic/config.ts`, whose `isTestFile` skip is the engine
 *     default.
 * The settlement shell (`exact-implementation-settlement.ts`) and the I6 brief
 * section (`implementation-brief.ts`) gain their rows when they start
 * classifying (T9).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEST_FILE_SUFFIXES,
  ENGINE_DEFAULT_TEST_FILES,
  classifyTaskFiles,
  isTestFileBySuffixes,
} from "../../src/core/test-file-classification";
import type { FrozenStopCheckManifestFields, FrozenTestFiles } from "../../src/core/affected-stop-check-types";
import {
  defaultVerificationManifest,
  freezeVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import { isTestFile } from "../../src/linter/programmatic/config";

const OPERATOR_SUFFIXES = [".spec.ts", ".it.ts", "Test.java"] as const;

/** The frozen classification of a manifest built from these source keys. */
function frozenTestFiles(document: Readonly<Record<string, unknown>> | "no-manifest-file"): FrozenTestFiles {
  const manifest: FrozenVerificationManifest = document === "no-manifest-file"
    ? defaultVerificationManifest()
    : (() => {
        const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
          kind: "loom-verification-manifest", checks: [], ...document,
        })));
        if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
        return frozen.value;
      })();
  const testFiles = (manifest as FrozenVerificationManifest & FrozenStopCheckManifestFields).testFiles;
  if (testFiles === undefined) throw new Error("every freeze path carries testFiles");
  return testFiles;
}

const FILE_LIST: readonly string[] = [
  "engine/src/core/ledger.ts",
  "engine/tests/core/ledger.test.ts",
  "engine/tests/core/ledger.spec.ts",
  "engine/tests/ui/panel.test.tsx",
  "engine/tests/ui/panel.spec.tsx",
  "engine/tests/fixtures/ledger-fixtures.ts",
  "engine/src/core/ledger-types.ts",
  "engine/tests/core/ledger.it.ts",
  "svc/src/test/java/com/acme/LedgerTest.java",
  "svc/src/main/java/com/acme/Ledger.java",
  "docs/testing.md",
  "engine/tests/core/ledger.test.ts.snap",
];

// The owner's FrozenTestFiles and CT-2's are one shape; each must accept the other.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameFrozenTestFiles: MutuallyAssignable<FrozenTestFiles, import("../../src/core/test-file-classification").FrozenTestFiles> = true;

describe("INV-2: the owner module", () => {
  it("declares the same FrozenTestFiles shape as the CT-2 contract", () => {
    expect(sameFrozenTestFiles).toBe(true);
  });

  it("DEFAULT_TEST_FILE_SUFFIXES is the engine's existing default list", () => {
    expect(DEFAULT_TEST_FILE_SUFFIXES).toEqual([".test.ts", ".spec.ts", ".test.tsx", ".spec.tsx"]);
    expect(Object.isFrozen(DEFAULT_TEST_FILE_SUFFIXES)).toBe(true);
    expect(ENGINE_DEFAULT_TEST_FILES).toEqual({ source: "engine-default", suffixes: DEFAULT_TEST_FILE_SUFFIXES });
  });

  it("a path is a test file exactly when it ends with one of the suffixes", () => {
    expect(isTestFileBySuffixes("a/b.test.ts", DEFAULT_TEST_FILE_SUFFIXES)).toBe(true);
    expect(isTestFileBySuffixes("a/b.test.ts.snap", DEFAULT_TEST_FILE_SUFFIXES)).toBe(false);
    expect(isTestFileBySuffixes("a/b.it.ts", DEFAULT_TEST_FILE_SUFFIXES)).toBe(false);
    expect(isTestFileBySuffixes("a/b.it.ts", OPERATOR_SUFFIXES)).toBe(true);
    expect(isTestFileBySuffixes("a\\b.spec.ts", DEFAULT_TEST_FILE_SUFFIXES)).toBe(true);
  });

  it("FR-013: every file_list entry that is not a test file is an implementation file, fixtures, helpers and type files included", () => {
    expect(classifyTaskFiles(FILE_LIST, ENGINE_DEFAULT_TEST_FILES)).toEqual({
      testFiles: [
        "engine/tests/core/ledger.test.ts",
        "engine/tests/core/ledger.spec.ts",
        "engine/tests/ui/panel.test.tsx",
        "engine/tests/ui/panel.spec.tsx",
      ],
      implementationFiles: [
        "engine/src/core/ledger.ts",
        "engine/tests/fixtures/ledger-fixtures.ts",
        "engine/src/core/ledger-types.ts",
        "engine/tests/core/ledger.it.ts",
        "svc/src/test/java/com/acme/LedgerTest.java",
        "svc/src/main/java/com/acme/Ledger.java",
        "docs/testing.md",
        "engine/tests/core/ledger.test.ts.snap",
      ],
    });
  });

  it("FR-013: the classification is a partition of file_list, in file_list order, decided by the suffix match", () => {
    const suffixes = fc.constantFrom<readonly string[]>(DEFAULT_TEST_FILE_SUFFIXES, OPERATOR_SUFFIXES);
    const path = fc.tuple(
      fc.stringMatching(/^[a-z]{1,6}(\/[a-z]{1,6}){0,2}$/),
      fc.constantFrom("", ".ts", ".test.ts", ".spec.tsx", ".it.ts", "Test.java", ".java", ".test.ts.snap"),
    ).map(([stem, suffix]) => `${stem}${suffix}`);
    fc.assert(fc.property(fc.uniqueArray(path), suffixes, (fileList, list) => {
      const testFiles = Object.freeze({ source: "operator-manifest" as const, suffixes: list as unknown as FrozenTestFiles["suffixes"] });
      const classification = classifyTaskFiles(fileList, testFiles);
      expect(classification.testFiles).toEqual(fileList.filter((file) => isTestFileBySuffixes(file, list)));
      expect(classification.implementationFiles).toEqual(fileList.filter((file) => !isTestFileBySuffixes(file, list)));
      expect(classification.testFiles.length + classification.implementationFiles.length).toBe(fileList.length);
    }));
  });
});

describe("INV-2: every sibling entry point agrees with the owner", () => {
  it.each<[string, Readonly<Record<string, unknown>> | "no-manifest-file"]>([
    ["no manifest file (engine default)", "no-manifest-file"],
    ["a schema-1 manifest", { schemaVersion: 1 }],
    ["a schema-2 manifest without testFileSuffixes", { schemaVersion: 2 }],
  ])("FR-014: verification-manifest freezes the owner's engine default for %s", (_label, document) => {
    const testFiles = frozenTestFiles(document);

    expect(testFiles).toEqual(ENGINE_DEFAULT_TEST_FILES);
    expect(classifyTaskFiles(FILE_LIST, testFiles)).toEqual(classifyTaskFiles(FILE_LIST, ENGINE_DEFAULT_TEST_FILES));
  });

  it("AS-018: FR-014: a declared testFileSuffixes list freezes as the operator's pattern, and a file is a test file exactly when it matches it", () => {
    const testFiles = frozenTestFiles({ schemaVersion: 2, testFileSuffixes: OPERATOR_SUFFIXES });

    expect(testFiles).toEqual({ source: "operator-manifest", suffixes: OPERATOR_SUFFIXES });
    expect(classifyTaskFiles(FILE_LIST, testFiles)).toEqual({
      testFiles: [
        "engine/tests/core/ledger.spec.ts",
        "engine/tests/core/ledger.it.ts",
        "svc/src/test/java/com/acme/LedgerTest.java",
      ],
      implementationFiles: FILE_LIST.filter((file) => !OPERATOR_SUFFIXES.some((suffix) => file.endsWith(suffix))),
    });
  });

  it("the programmatic linter's test-file skip is the owner's engine default", () => {
    for (const file of FILE_LIST) {
      expect(isTestFile(file), file).toBe(isTestFileBySuffixes(file, DEFAULT_TEST_FILE_SUFFIXES));
    }
    expect(FILE_LIST.filter(isTestFile)).toEqual(classifyTaskFiles(FILE_LIST, frozenTestFiles("no-manifest-file")).testFiles);
  });
});
