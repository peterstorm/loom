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
 * section (`implementation-brief.ts`) call the owner's `classifyTaskFiles`
 * over the frozen `testFiles` directly; `i6-settlement.matrix.test.ts` and
 * `implementation-brief.test.ts` pin what each does with the partition.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DeclaredArtifactBaseline } from "../../src/core/artifact-baseline";
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

/** The classification a frozen manifest carries; every freeze path carries one. */
function testFilesOf(manifest: FrozenVerificationManifest): FrozenTestFiles {
  const testFiles = (manifest as FrozenVerificationManifest & FrozenStopCheckManifestFields).testFiles;
  if (testFiles === undefined) throw new Error("every freeze path carries testFiles");
  return testFiles;
}

/** The frozen classification of a manifest built from these source keys. */
function frozenTestFiles(document: Readonly<Record<string, unknown>> | "no-manifest-file"): FrozenTestFiles {
  if (document === "no-manifest-file") return testFilesOf(defaultVerificationManifest());
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    kind: "loom-verification-manifest", checks: [], ...document,
  })));
  if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
  return testFilesOf(frozen.value);
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

describe("INV-2: the owner module", () => {
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
    expect(classifyTaskFiles(FILE_LIST, ENGINE_DEFAULT_TEST_FILES, undefined)).toEqual({
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
      createdImplementationFiles: [],
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
      const classification = classifyTaskFiles(fileList, testFiles, undefined);
      expect(classification.testFiles).toEqual(fileList.filter((file) => isTestFileBySuffixes(file, list)));
      expect(classification.implementationFiles).toEqual(fileList.filter((file) => !isTestFileBySuffixes(file, list)));
      expect(classification.testFiles.length + classification.implementationFiles.length).toBe(fileList.length);
    }));
  });
});

describe("FR-007a: the implementation files a Task's first artifact baseline records as missing are the files it creates", () => {
  const IMPL = "engine/src/core/ledger.ts";
  const FIXTURE = "engine/tests/fixtures/ledger-fixtures.ts";
  const OUTSIDE = "engine/src/core/unrelated.ts";
  const TEST = "engine/tests/core/ledger.test.ts";
  const missing = (artifact: string): DeclaredArtifactBaseline => ({ artifact, snapshot: { kind: "missing" } });
  const present = (artifact: string): DeclaredArtifactBaseline => ({ artifact, snapshot: { kind: "sha256", digest: "b".repeat(64) } });
  const created = (fileList: readonly string[], baseline: readonly DeclaredArtifactBaseline[] | undefined): readonly string[] =>
    classifyTaskFiles(fileList, ENGINE_DEFAULT_TEST_FILES, baseline).createdImplementationFiles;

  it("FR-007a: an implementation file missing at the baseline is created; one present is not", () => {
    expect(created([TEST, IMPL, FIXTURE], [missing(IMPL), present(FIXTURE), missing(TEST)])).toEqual([IMPL]);
  });

  it("FR-007a: test files are never created implementation files, whatever their baseline", () => {
    expect(created([TEST, IMPL], [missing(TEST)])).toEqual([]);
  });

  it("FR-007a: a Task without an artifact baseline creates nothing, so strict FR-007 holds", () => {
    expect(created([TEST, IMPL], undefined)).toEqual([]);
    expect(created([TEST, IMPL], [])).toEqual([]);
  });

  it("FR-007a: baseline and file_list spellings of one path are compared normalized", () => {
    expect(created([TEST, `./${IMPL}`], [missing(IMPL)])).toEqual([`./${IMPL}`]);
  });

  it("FR-007a: created files keep file_list order and are exactly the missing implementation files", () => {
    const pathArb = fc.constantFrom(IMPL, FIXTURE, OUTSIDE, TEST);
    fc.assert(fc.property(
      fc.uniqueArray(pathArb, { maxLength: 4 }),
      fc.uniqueArray(fc.tuple(pathArb, fc.boolean()), { selector: ([path]) => path, maxLength: 4 }),
      (fileList, entries) => {
        const classification = classifyTaskFiles(fileList, ENGINE_DEFAULT_TEST_FILES, entries.map(([path, absent]) => absent ? missing(path) : present(path)));
        expect(classification.createdImplementationFiles).toEqual(
          classification.implementationFiles.filter((file) => entries.some(([path, absent]) => path === file && absent)),
        );
      },
    ), { numRuns: 300 });
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
    expect(classifyTaskFiles(FILE_LIST, testFiles, undefined)).toEqual(classifyTaskFiles(FILE_LIST, ENGINE_DEFAULT_TEST_FILES, undefined));
  });

  it("AS-018: FR-014: a declared testFileSuffixes list freezes as the operator's pattern, and a file is a test file exactly when it matches it", () => {
    const testFiles = frozenTestFiles({ schemaVersion: 2, testFileSuffixes: OPERATOR_SUFFIXES });

    expect(testFiles).toEqual({ source: "operator-manifest", suffixes: OPERATOR_SUFFIXES });
    expect(classifyTaskFiles(FILE_LIST, testFiles, undefined)).toEqual({
      testFiles: [
        "engine/tests/core/ledger.spec.ts",
        "engine/tests/core/ledger.it.ts",
        "svc/src/test/java/com/acme/LedgerTest.java",
      ],
      implementationFiles: FILE_LIST.filter((file) => !OPERATOR_SUFFIXES.some((suffix) => file.endsWith(suffix))),
      createdImplementationFiles: [],
    });
  });

  it("the programmatic linter's test-file skip is the owner's engine default", () => {
    for (const file of FILE_LIST) {
      expect(isTestFile(file), file).toBe(isTestFileBySuffixes(file, DEFAULT_TEST_FILE_SUFFIXES));
    }
    expect(FILE_LIST.filter(isTestFile)).toEqual(classifyTaskFiles(FILE_LIST, frozenTestFiles("no-manifest-file"), undefined).testFiles);
  });
});
