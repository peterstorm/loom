/**
 * no-duplicate-block as a rule: what it reports for a copy, what a baseline
 * entry excuses, and that it reaches the edit hook's own entry point.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { lintFile } from "../../../src/linter/index";
import {
  DEFAULT_CLONE_OPTIONS,
  EMPTY_CORPUS,
  fingerprint,
  fingerprintScheme,
  type CloneCorpus,
} from "../../../src/linter/clones/clone-detection";
import { parseIndexCache, renderIndexCache } from "../../../src/linter/clones/index-cache";
import { defaultCacheFile } from "../../../src/linter/clones/project-corpus";
import { createProgrammaticRules } from "../../../src/linter/programmatic";
import { EMPTY_CONFIG } from "../../../src/linter/programmatic/config";
import {
  detectedCloneKeys,
  FIX_HINT,
  handler,
  RULE_NAME,
  type DuplicateBlockOptions,
} from "../../../src/linter/programmatic/no-duplicate-block";
import type { Tier } from "../../../src/linter/types";
import { block, cloneOptions, cloneProjects } from "../../fixtures/clone-fixtures";

const DEFAULT_RULES_DIR = resolve(__dirname, "../../../../lint-rules");
const CLONE = cloneOptions(20, 4);
const OPTIONS: DuplicateBlockOptions = { clone: CLONE, baseline: [], projectRoot: "/project" };

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

  it("declares its first-call setup, which is what makes the executor run it last (executor.test.ts pins the ordering)", () => {
    const declaring = createProgrammaticRules(EMPTY_CONFIG, null, EMPTY_CORPUS).filter((rule) => rule.firstCallSetup === true);
    expect(declaring.map((rule) => rule.name)).toEqual([RULE_NAME]);
  });
});

describe("no-duplicate-block through the lint entry points", () => {
  const projects = cloneProjects("no-duplicate-block-");
  afterEach(projects.dispose);

  const lint = (root: string, path: string, tier: Tier) =>
    lintFile(join(root, path), tier, DEFAULT_RULES_DIR, projects.rulesDir(root), 5_000);

  const lintEdited = (root: string, path: string) => lint(root, path, "immediate");

  /** Long enough for the shipped defaults: 100 tokens over 8 lines. */
  const body = block("builder", 12);
  const FILES = {
    "tests/first.test.ts": [block("first", 2), body].join("\n"),
    "tests/second.test.ts": [block("second", 2), body].join("\n"),
  };
  const REFUSED = {
    kind: "violations",
    violations: [expect.objectContaining({ rule: RULE_NAME, line: 3, text: expect.stringContaining("tests/first.test.ts:3-14") })],
  };

  it("refuses a fixture builder pasted into a second test file, on the edit, twice running", () => {
    const root = projects.create(FILES, {});
    // The second run reads the fingerprint cache the first one wrote.
    expect(lintEdited(root, "tests/second.test.ts")).toEqual(REFUSED);
    expect(lintEdited(root, "tests/second.test.ts")).toEqual(REFUSED);
  });

  it("passes once the copy is replaced by an import", () => {
    const root = projects.create(FILES, {});
    expect(lintEdited(root, "tests/second.test.ts").kind).toBe("violations");
    writeFileSync(join(root, "tests/second.test.ts"), `import { builders } from "./first.test";\n${block("second", 3)}`);
    expect(lintEdited(root, "tests/second.test.ts")).toEqual({ kind: "pass" });
  });

  it("honours the project's thresholds and never compares an excluded file", () => {
    expect(lintEdited(projects.create(FILES, { duplicateBlockMinTokens: 500 }), "tests/second.test.ts")).toEqual({ kind: "pass" });
    const vendored = projects.create(FILES, { exclude: [{ path: "tests/first.test.ts", reason: "vendored" }] });
    expect(lintEdited(vendored, "tests/second.test.ts")).toEqual({ kind: "pass" });
  });

  it("reads the fingerprint cache on the edit and never in the full tier: a poisoned cache hides the copy from the edit alone", () => {
    const root = projects.create(FILES, {});
    const cacheFile = defaultCacheFile(root);
    const scheme = fingerprintScheme(DEFAULT_CLONE_OPTIONS);
    expect(lintEdited(root, "tests/second.test.ts")).toEqual(REFUSED);

    // Every entry keeps its size and time and loses its hashes: nothing is nominated any more.
    const written = parseIndexCache(readFileSync(cacheFile, "utf-8"), scheme);
    expect([...written.keys()]).toEqual(Object.keys(FILES));
    const poisoned = renderIndexCache(new Map([...written].map(([path, file]) => [path, { ...file, hashes: [] }] as const)), scheme);
    writeFileSync(cacheFile, poisoned);

    expect(lintEdited(root, "tests/second.test.ts")).toEqual({ kind: "pass" });
    // The Wave Gate and lint-project lint in the full tier: every file from its bytes.
    expect(lint(root, "tests/second.test.ts", "full")).toEqual(REFUSED);
    // And the full tier neither repaired nor replaced the cache it does not read.
    expect(readFileSync(cacheFile, "utf-8")).toBe(poisoned);
  });
});
