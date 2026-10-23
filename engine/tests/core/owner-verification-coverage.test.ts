/**
 * Sibling coverage (T5, AD-5): specifier resolution, reach, the coverage
 * decision and the shell's bounded frontier step — all pure.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  COVERAGE_FRONTIER_BOUND,
  coverageFrontier,
  coverageOverFiles,
  decideCoverage,
  initialCoverageState,
  reachedFiles,
  resolveSpecifier,
  type CoverageFrontierStep,
  type CoverageGraphState,
} from "../../src/core/owner-verification/coverage";
import type { OwnerObligation, PathAliases } from "../../src/core/owner-verification/types";

const OWNER = "src/rules/owner.ts";
const SIBLING_A = "src/rules/sibling-a.ts";
const SIBLING_B = "src/rules/sibling-b.ts";
const MATRIX = "tests/rules.matrix.test.ts";

const obligation = (siblings: readonly string[] = [SIBLING_A, SIBLING_B], owner: string = OWNER): OwnerObligation => ({
  invariant: "INV-7",
  title: "Admission is decided only by the owner",
  statement: null,
  owner,
  siblings: siblings.map((path) => ({ path, note: null })),
  matrixTest: MATRIX,
  mutation: { kind: "verify" },
});

const ALIASES: PathAliases = [{ pattern: "@rules/*", targets: ["src/rules/*"] }];
const known = (...paths: string[]): ReadonlySet<string> => new Set(paths);
const importing = (...specifiers: string[]): string => specifiers.map((s, i) => `import * as m${i} from "${s}";`).join("\n") + "\n";

const SOURCES: Readonly<Record<string, string>> = {
  [OWNER]: "export const decide = (age: number) => age >= 18;\n",
  [SIBLING_A]: 'import { decide } from "./owner";\nexport const a = decide;\n',
  [SIBLING_B]: 'import { decide } from "./owner";\nexport const b = decide;\n',
  "src/rules/index.ts": 'export * from "./sibling-b";\n',
};

const over = (matrixText: string, siblings?: readonly string[], aliases: PathAliases = ALIASES) =>
  coverageOverFiles({
    matrixTest: MATRIX,
    obligation: obligation(siblings),
    files: new Map(Object.entries({ ...SOURCES, [MATRIX]: matrixText })),
    aliases,
  });

describe("resolveSpecifier", () => {
  it("AS-006: resolves relative specifiers through the extension ladder in order", () => {
    expect(resolveSpecifier("tests/a.test.ts", "../src/x", [], known("src/x.ts"))).toBe("src/x.ts");
    expect(resolveSpecifier("tests/a.test.ts", "../src/x", [], known("src/x.tsx"))).toBe("src/x.tsx");
    expect(resolveSpecifier("tests/a.test.ts", "../src/x", [], known("src/x.mts"))).toBe("src/x.mts");
    expect(resolveSpecifier("tests/a.test.ts", "../src/x", [], known("src/x.cts"))).toBe("src/x.cts");
    expect(resolveSpecifier("tests/a.test.ts", "../src/x.ts", [], known("src/x.ts"))).toBe("src/x.ts");
    expect(resolveSpecifier("tests/a.test.ts", "../src/x.js", [], known("src/x.ts"))).toBe("src/x.ts");
    expect(resolveSpecifier("tests/a.test.ts", "../src/x.mjs", [], known("src/x.mts"))).toBe("src/x.mts");
    expect(resolveSpecifier("tests/a.test.ts", "../src/x", [], known("src/x/index.ts"))).toBe("src/x/index.ts");
    // The exact file wins over the directory index; `.ts` wins over `.tsx`.
    expect(resolveSpecifier("tests/a.test.ts", "../src/x", [], known("src/x.ts", "src/x/index.ts", "src/x.tsx"))).toBe("src/x.ts");
  });

  it("normalizes `.` and `..` segments, and refuses a path that escapes the repository", () => {
    expect(resolveSpecifier("a/b/c.ts", "./../b/./d", [], known("a/b/d.ts"))).toBe("a/b/d.ts");
    expect(resolveSpecifier("a/b/c.ts", "..", [], known("a/index.ts"))).toBe("a/index.ts");
    expect(resolveSpecifier("a.ts", "../outside", [], known("outside.ts"))).toBeNull();
  });

  it("AS-006: resolves aliases with a single `*`, trying targets in order", () => {
    const aliases: PathAliases = [{ pattern: "@lib/*", targets: ["gen/*", "src/lib/*"] }];
    expect(resolveSpecifier("tests/a.test.ts", "@lib/x", aliases, known("src/lib/x.ts"))).toBe("src/lib/x.ts");
    expect(resolveSpecifier("tests/a.test.ts", "@lib/x", aliases, known("gen/x.ts", "src/lib/x.ts"))).toBe("gen/x.ts");
    expect(resolveSpecifier("tests/a.test.ts", "@lib/deep/x.js", aliases, known("src/lib/deep/x.ts"))).toBe("src/lib/deep/x.ts");
  });

  it("AS-006: an exact alias wins over a wildcard, and the longest wildcard prefix wins", () => {
    const aliases: PathAliases = [
      { pattern: "@/*", targets: ["src/*"] },
      { pattern: "@/rules/*", targets: ["lib/rules/*"] },
      { pattern: "@/rules/owner", targets: ["exact/owner"] },
    ];
    const files = known("src/rules/x.ts", "lib/rules/x.ts", "exact/owner.ts", "lib/rules/owner.ts");
    expect(resolveSpecifier("t.ts", "@/rules/x", aliases, files)).toBe("lib/rules/x.ts");
    expect(resolveSpecifier("t.ts", "@/rules/owner", aliases, files)).toBe("exact/owner.ts");
    expect(resolveSpecifier("t.ts", "@/other", aliases, known("src/other.ts"))).toBe("src/other.ts");
  });

  it("AS-006: bare package and absolute specifiers are external and resolve to nothing", () => {
    expect(resolveSpecifier("tests/a.test.ts", "rules/owner", ALIASES, known("rules/owner.ts"))).toBeNull();
    expect(resolveSpecifier("tests/a.test.ts", "vitest", ALIASES, known("vitest.ts"))).toBeNull();
    expect(resolveSpecifier("tests/a.test.ts", "/src/x", ALIASES, known("src/x.ts"))).toBeNull();
    expect(resolveSpecifier("tests/a.test.ts", "../src/missing", ALIASES, known("src/x.ts"))).toBeNull();
  });
});

describe("reachedFiles and decideCoverage", () => {
  it("AS-001: a matrix test importing the owner and every sibling covers the Invariant", () => {
    expect(over(importing("../src/rules/owner", "@rules/sibling-a", "../src/rules/sibling-b.js"))).toEqual({ kind: "covered" });
  });

  it("AS-002: a matrix test omitting one sibling names the Invariant's missing sibling path", () => {
    expect(over(importing("../src/rules/owner", "../src/rules/sibling-a"))).toEqual({ kind: "missing", paths: [SIBLING_B] });
  });

  it("AS-003: with no sibling entry points only the owner must be reached", () => {
    expect(over(importing("../src/rules/owner"), [])).toEqual({ kind: "covered" });
    expect(over(importing("../src/rules/sibling-a"), [])).toEqual({ kind: "missing", paths: [OWNER] });
  });

  it("AS-006: reach is direct imports closed under re-exports only", () => {
    const files = new Map(Object.entries({ ...SOURCES, [MATRIX]: importing("../src/rules/index", "../src/rules/sibling-a") }));
    expect([...reachedFiles(MATRIX, files, [])].sort()).toEqual(["src/rules/index.ts", SIBLING_A, SIBLING_B].sort());
  });

  it("AS-006: the matrix test's own re-exports are direct edges", () => {
    expect(over('export * from "../src/rules/owner";\nexport { a } from "@rules/sibling-a";\nexport * from "../src/rules";\n'))
      .toEqual({ kind: "covered" });
  });

  it("FR-006: decideCoverage names every missing path in declared order, the owner first", () => {
    expect(decideCoverage(new Set(), obligation([SIBLING_B, SIBLING_A]))).toEqual({ kind: "missing", paths: [OWNER, SIBLING_B, SIBLING_A] });
    expect(decideCoverage(new Set([SIBLING_B]), obligation([SIBLING_B, SIBLING_A]))).toEqual({ kind: "missing", paths: [OWNER, SIBLING_A] });
    expect(decideCoverage(new Set([OWNER, SIBLING_A, SIBLING_B]), obligation())).toEqual({ kind: "covered" });
  });

  it("FR-006: a declared path spelled with `./` still matches its reached file, and is reported as declared", () => {
    expect(decideCoverage(new Set([OWNER]), obligation([], `./${OWNER}`))).toEqual({ kind: "covered" });
    expect(decideCoverage(new Set(), obligation([], `./${OWNER}`))).toEqual({ kind: "missing", paths: [`./${OWNER}`] });
  });

  it("a missing matrix test reaches nothing", () => {
    expect(coverageOverFiles({ matrixTest: MATRIX, obligation: obligation([]), files: new Map(Object.entries(SOURCES)), aliases: [] }))
      .toEqual({ kind: "missing", paths: [OWNER] });
  });
});

// ---------------------------------------------------------------------------
// Laws
// ---------------------------------------------------------------------------

/** A chain `c0 → c1 → … → cN = target` of `n` hops from the matrix test, by re-export or plain import. */
const chainFiles = (hops: number, edge: "reexport" | "import"): Record<string, string> => {
  const link = (i: number) => (i === hops ? "src/chain/target.ts" : `src/chain/c${i}.ts`);
  const files: Record<string, string> = { "src/chain/target.ts": "export const target = 1;\n" };
  for (let i = 1; i < hops; i += 1) {
    const next = `./${link(i + 1).slice("src/chain/".length, -3)}`;
    files[link(i)] = edge === "reexport" ? `export * from "${next}";\n` : `import * as n from "${next}";\nexport const v = n;\n`;
  }
  files[MATRIX] = `import * as first from "../src/chain/${link(1).slice("src/chain/".length, -3)}";\n`;
  return files;
};

const targetObligation = obligation([], "src/chain/target.ts");

describe("coverage laws", () => {
  it("FR-007: AS-006: a re-export chain of any length reaches its target", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 40 }), (hops) => {
      const files = new Map(Object.entries(chainFiles(hops, "reexport")));
      expect(coverageOverFiles({ matrixTest: MATRIX, obligation: targetObligation, files, aliases: [] })).toEqual({ kind: "covered" });
    }));
  });

  it("FR-007: AS-003: a plain import chain longer than one hop never reaches its target", () => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 40 }), (hops) => {
      const files = new Map(Object.entries(chainFiles(hops, "import")));
      expect(coverageOverFiles({ matrixTest: MATRIX, obligation: targetObligation, files, aliases: [] }))
        .toEqual({ kind: "missing", paths: ["src/chain/target.ts"] });
    }));
  });

  const MATRICES = [
    importing("../src/rules/owner", "@rules/sibling-a", "../src/rules/index"),
    importing("../src/rules/sibling-a"),
    importing("./owner", "../src/rules"),
    'export * from "../src/rules/index";\nimport "../src/rules/owner.js";\n',
  ];

  it("FR-007: reach and verdict are invariant under the file map's insertion order", () => {
    fc.assert(fc.property(fc.constantFrom(...MATRICES), fc.integer(), (matrixText, seed) => {
      const entries = Object.entries({ ...SOURCES, [MATRIX]: matrixText });
      const shuffled = fc.sample(fc.shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length }), { seed, numRuns: 1 })[0]!;
      const input = { matrixTest: MATRIX, obligation: obligation(), aliases: ALIASES };
      expect(coverageOverFiles({ ...input, files: new Map(shuffled) })).toEqual(coverageOverFiles({ ...input, files: new Map(entries) }));
      expect([...reachedFiles(MATRIX, new Map(shuffled), ALIASES)].sort()).toEqual([...reachedFiles(MATRIX, new Map(entries), ALIASES)].sort());
    }), { numRuns: 60 });
  });

  it("FR-007: a file nothing imports never changes the verdict, whatever its text", () => {
    fc.assert(fc.property(fc.constantFrom(...MATRICES), fc.stringMatching(/^[a-z]{1,8}$/), fc.string(), (matrixText, name, text) => {
      const input = { matrixTest: MATRIX, obligation: obligation(), aliases: ALIASES };
      const base = { ...SOURCES, [MATRIX]: matrixText };
      expect(coverageOverFiles({ ...input, files: new Map(Object.entries({ ...base, [`src/unrelated/${name}.ts`]: text })) }))
        .toEqual(coverageOverFiles({ ...input, files: new Map(Object.entries(base)) }));
    }), { numRuns: 60 });
  });
});

// ---------------------------------------------------------------------------
// The bounded frontier the shell drives
// ---------------------------------------------------------------------------

/** Drives the frontier against an in-memory repository, as the shell does against the filesystem. */
const drive = (repo: Readonly<Record<string, string>>, aliases: PathAliases, maxSteps = 100): CoverageFrontierStep & { reads: number } => {
  let state: CoverageGraphState = initialCoverageState(MATRIX, aliases);
  let read: ReadonlyMap<string, string> = new Map();
  let reads = 0;
  for (let step = 0; step < maxSteps; step += 1) {
    const result = coverageFrontier(state, read);
    if (result.kind !== "read") return { ...result, reads };
    state = result.state;
    read = new Map(result.next.flatMap((path) => (path in repo ? [[path, repo[path]!] as const] : [])));
    reads += read.size;
  }
  throw new Error("frontier did not settle");
};

describe("coverageFrontier", () => {
  it("first asks for the matrix test, then settles on exactly the files coverage needs", () => {
    const first = coverageFrontier(initialCoverageState(MATRIX, ALIASES), new Map());
    expect(first).toMatchObject({ kind: "read", next: [MATRIX] });

    const repo = {
      ...SOURCES,
      [MATRIX]: importing("../src/rules/owner", "@rules/sibling-a", "../src/rules/index"),
      "src/unrelated.ts": "export {};\n",
    };
    const done = drive(repo, ALIASES);
    expect(done.kind).toBe("complete");
    if (done.kind !== "complete") return;
    expect([...done.state.files.keys()].sort()).toEqual([MATRIX, "src/rules/index.ts", OWNER, SIBLING_A, SIBLING_B].sort());
    expect(coverageOverFiles({ matrixTest: MATRIX, obligation: obligation(), files: done.state.files, aliases: ALIASES }))
      .toEqual({ kind: "covered" });
  });

  it("FR-007: the gathered files decide coverage exactly as the whole repository does", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 12 }), fc.constantFrom<"reexport" | "import">("reexport", "import"), (hops, edge) => {
      const repo = chainFiles(hops, edge);
      const done = drive(repo, []);
      expect(done.kind).toBe("complete");
      if (done.kind !== "complete") return;
      const input = { matrixTest: MATRIX, obligation: targetObligation, aliases: [] };
      expect(coverageOverFiles({ ...input, files: done.state.files })).toEqual(coverageOverFiles({ ...input, files: new Map(Object.entries(repo)) }));
    }));
  });

  it("a missing matrix test settles with nothing gathered", () => {
    const done = drive({}, []);
    expect(done).toMatchObject({ kind: "complete" });
  });

  it("exceeding the bound is a coverage-bound-exceeded infrastructure failure", () => {
    const repo = chainFiles(COVERAGE_FRONTIER_BOUND + 5, "reexport");
    const done = drive(repo, [], COVERAGE_FRONTIER_BOUND + 50);
    expect(done.kind).toBe("bound-exceeded");
    if (done.kind !== "bound-exceeded") return;
    expect(done.failure.kind).toBe("coverage-bound-exceeded");
    expect(done.failure.detail).toContain(String(COVERAGE_FRONTIER_BOUND));
    expect(COVERAGE_FRONTIER_BOUND).toBe(512);
  });
});
