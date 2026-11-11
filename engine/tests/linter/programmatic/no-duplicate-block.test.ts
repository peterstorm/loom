/**
 * no-duplicate-block as a rule: what it reports for a copy, what a baseline
 * entry excuses, and that it reaches the edit hook's own entry point.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { lintFile } from "../../../src/linter/index";
import { EMPTY_CORPUS, fingerprint, type CloneCorpus, type CloneOptions } from "../../../src/linter/clones/clone-detection";
import { createProgrammaticRules } from "../../../src/linter/programmatic";
import {
  detectedCloneKeys,
  FIX_HINT,
  handler,
  RULE_NAME,
  type DuplicateBlockOptions,
} from "../../../src/linter/programmatic/no-duplicate-block";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";

const DEFAULT_RULES_DIR = resolve(__dirname, "../../../../lint-rules");
const CLONE: CloneOptions = { minTokens: 20, minLines: 4 };
const OPTIONS: DuplicateBlockOptions = { clone: CLONE, baseline: [], projectRoot: "/project" };

const block = (name: string, count: number): string =>
  Array.from({ length: count }, (_, row) => `const ${name}${row} = compute${name}(${row}, "${name}");`).join("\n");

const SHARED = block("shared", 8);
const ORIGINAL = [block("before", 2), SHARED].join("\n");
const COPY = [block("mine", 3), SHARED].join("\n");

/** A corpus holding exactly these project-relative sources. */
const corpusOf = (sources: Readonly<Record<string, string>>): CloneCorpus => ({
  candidates: (target) =>
    Object.entries(sources)
      .filter(([path]) => path !== target.path)
      .map(([path, content]) => fingerprint(path, content, CLONE)),
});

const CORPUS = corpusOf({ "src/original.ts": ORIGINAL });

describe("no-duplicate-block", () => {
  it("reports a copy at its first line, naming where the original is", () => {
    expect(handler(COPY, "/project/src/copy.ts", CORPUS, OPTIONS)).toEqual([
      {
        rule: RULE_NAME,
        file: "/project/src/copy.ts",
        line: 4,
        text: expect.stringMatching(/^lines 4-11 repeat src\/original\.ts:3-10 \(\d+ tokens\)$/),
        fixHint: FIX_HINT,
      },
    ]);
  });

  it("reports a block a file holds twice, with no corpus at all", () => {
    const twice = [SHARED, block("between", 2), SHARED].join("\n");
    expect(handler(twice, "/project/src/twice.ts", EMPTY_CORPUS, OPTIONS).map(({ line, text }) => ({ line, text }))).toEqual([
      { line: 1, text: expect.stringContaining("repeat src/twice.ts:11-18") },
    ]);
  });

  it("leaves a file alone that copies nothing", () => {
    expect(handler(block("unique", 12), "/project/src/unique.ts", CORPUS, OPTIONS)).toEqual([]);
  });

  it("keys a copy by both paths and the copied tokens, project-relative from an absolute path", () => {
    const keys = detectedCloneKeys(COPY, "/project/src/copy.ts", CORPUS, OPTIONS);
    expect(keys).toEqual([expect.stringMatching(/^src\/copy\.ts::src\/original\.ts@[0-9a-f]{8}$/)]);
  });

  it("excuses a baselined copy, and only that copy", () => {
    const baseline = detectedCloneKeys(COPY, "src/copy.ts", CORPUS, OPTIONS);
    const excused: DuplicateBlockOptions = { ...OPTIONS, baseline };

    expect(handler(COPY, "/project/src/copy.ts", CORPUS, excused)).toEqual([]);
    // The same block copied into another file is a new copy with its own key.
    expect(handler(COPY, "/project/src/second-copy.ts", CORPUS, excused)).toHaveLength(1);
    // And a baselined copy that then changes is reported again.
    const changed = COPY.replace("computeshared(7", "computeshared(70");
    expect(handler([changed, block("more", 1)].join("\n"), "/project/src/copy.ts", corpusOf({
      "src/original.ts": ORIGINAL.replace("computeshared(7", "computeshared(70"),
    }), excused)).toHaveLength(1);
  });

  it("is the last programmatic rule, so the corpus it builds on first use delays no other rule past its deadline", () => {
    expect(createProgrammaticRules().at(-1)?.name).toBe(RULE_NAME);
  });
});

describe("no-duplicate-block through the edit hook's entry point", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A project with a rules directory, the given config and files. */
  function project(config: Readonly<Record<string, unknown>>, files: Readonly<Record<string, string>>): string {
    const root = canonicalTempDir("no-duplicate-block-");
    cleanup.push(root);
    const rulesDir = join(root, ".claude", "linter", "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "config.json"), JSON.stringify(config));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  const lintEdited = (root: string, path: string) =>
    lintFile(join(root, path), "immediate", DEFAULT_RULES_DIR, join(root, ".claude", "linter", "rules"), 5_000);

  /** Long enough for the shipped defaults: 100 tokens over 8 lines. */
  const body = block("builder", 12);
  const FILES = {
    "tests/first.test.ts": [block("first", 2), body].join("\n"),
    "tests/second.test.ts": [block("second", 2), body].join("\n"),
  };

  it("refuses a fixture builder pasted into a second test file, on the edit, twice running", () => {
    const root = project({}, FILES);
    const expected = {
      kind: "violations",
      violations: [expect.objectContaining({ rule: RULE_NAME, line: 3, text: expect.stringContaining("tests/first.test.ts:3-14") })],
    };
    // The second run reads the fingerprint cache the first one wrote.
    expect(lintEdited(root, "tests/second.test.ts")).toEqual(expected);
    expect(lintEdited(root, "tests/second.test.ts")).toEqual(expected);
  });

  it("passes once the copy is replaced by an import", () => {
    const root = project({}, FILES);
    expect(lintEdited(root, "tests/second.test.ts").kind).toBe("violations");
    writeFileSync(join(root, "tests/second.test.ts"), `import { builders } from "./first.test";\n${block("second", 3)}`);
    expect(lintEdited(root, "tests/second.test.ts")).toEqual({ kind: "pass" });
  });

  it("honours the project's thresholds and never compares an excluded file", () => {
    expect(lintEdited(project({ duplicateBlockMinTokens: 500 }, FILES), "tests/second.test.ts")).toEqual({ kind: "pass" });
    const vendored = project({ exclude: [{ path: "tests/first.test.ts", reason: "vendored" }] }, FILES);
    expect(lintEdited(vendored, "tests/second.test.ts")).toEqual({ kind: "pass" });
  });
});
