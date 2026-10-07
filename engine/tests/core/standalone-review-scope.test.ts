/**
 * The Standalone Review scope module's interface IS its test surface: the
 * changed-path, review-metadata and scope-safety parsers that preparation freezes
 * into authority, the canonical scope parser, the Finding scope check, and the
 * deterministic reviewer selection.
 */
import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../src/core/digest";
import {
  STANDALONE_REVIEWER_ROLES,
  findingScopeErrors,
  parseChangedPaths,
  parseReviewMetadata,
  parseScopeSafety,
  parseStandaloneReviewScope,
  selectStandaloneReviewers,
  type StandaloneChangedPaths,
} from "../../src/core/standalone-review-scope";

const SHA40 = "0123456789abcdef0123456789abcdef01234567";
const SHA64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const changedPaths = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  unstaged: ["src/x.ts"], staged: [], committed: [], base_revision: null, head_revision: SHA40, ...overrides,
});

const metadata = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  requested_kinds: ["all"], docs_only: false, source_or_test_changed: true, types_changed: true,
  comments_changed: true, additions: 1, file_count: 1, new_structure: false, languages: ["TypeScript"], ...overrides,
});

const docsOnly = (overrides: Readonly<Record<string, unknown>> = {}) => metadata({
  requested_kinds: ["comments"], docs_only: true, source_or_test_changed: false, types_changed: false,
  comments_changed: true, additions: 0, languages: ["Markdown"], ...overrides,
});

const errorsOf = (result: Readonly<{ ok: true } | { ok: false; errors: readonly string[] }>): string =>
  result.ok ? "" : result.errors.join("; ");

describe("parseChangedPaths", () => {
  it("accepts 40-hex and 64-hex revisions and a null base", () => {
    expect(parseChangedPaths(changedPaths({ base_revision: "fedcba9876543210fedcba9876543210fedcba98", head_revision: SHA64 })).ok).toBe(true);
    expect(parseChangedPaths(changedPaths()).ok).toBe(true);
  });

  it("rejects revisions that are not git SHAs, exactly as the sibling boundaries do", () => {
    const branches = parseChangedPaths(changedPaths({ base_revision: "main", head_revision: "HEAD" }));
    expect(errorsOf(branches)).toContain("base_revision");
    expect(errorsOf(branches)).toContain("head_revision");
    expect(parseChangedPaths(changedPaths({ head_revision: "0123456789abcdef" })).ok).toBe(false);
    expect(parseChangedPaths(changedPaths({ head_revision: ` ${SHA40}` })).ok).toBe(false);
  });

  it("property: a head revision is admitted exactly when it is a bare 40- or 64-hex SHA", () => {
    fc.assert(fc.property(fc.string({ maxLength: 70 }), (revision) => {
      const admitted = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(revision);
      expect(parseChangedPaths(changedPaths({ head_revision: revision })).ok).toBe(admitted);
    }), { numRuns: 200 });
  });

  it("freezes each path list canonically sorted and refuses duplicates and unknown fields", () => {
    const parsed = parseChangedPaths(changedPaths({ unstaged: ["src/z.ts", "src/a.ts"] }));
    expect(parsed.ok && parsed.value.unstaged).toEqual(["src/a.ts", "src/z.ts"]);
    expect(parsed.ok && Object.isFrozen(parsed.value.unstaged)).toBe(true);
    expect(errorsOf(parseChangedPaths(changedPaths({ staged: ["src/a.ts", "src/a.ts"] })))).toContain("duplicate paths");
    expect(errorsOf(parseChangedPaths({ ...changedPaths(), extra: true }))).toContain("unknown field 'extra'");
  });

  it("property: every admitted path list is the strictly ascending set of its input paths", () => {
    const segment = fc.stringMatching(/^[a-z][a-z0-9_-]{0,6}$/);
    const path = fc.tuple(fc.array(segment, { minLength: 0, maxLength: 2 }), segment)
      .map(([dirs, leaf]) => [...dirs, `${leaf}.ts`].join("/"));
    fc.assert(fc.property(fc.array(path, { maxLength: 12 }), (paths) => {
      const parsed = parseChangedPaths(changedPaths({ unstaged: paths, committed: paths }));
      const distinct = new Set(paths).size === paths.length;
      expect(parsed.ok).toBe(distinct);
      if (!parsed.ok) return;
      for (const list of [parsed.value.unstaged, parsed.value.committed]) {
        expect([...list]).toEqual([...new Set(paths)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
        expect(list.every((entry, index) => index === 0 || list[index - 1]! < entry)).toBe(true);
      }
    }), { numRuns: 200 });
  });

  it("brands the parsed revisions and path lists so plain strings cannot stand in for them", () => {
    const parsed = parseChangedPaths(changedPaths({ base_revision: SHA64 }));
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const value: StandaloneChangedPaths = parsed.value;
    expect(value.headRevision).toBe(SHA40);
    expect(value.baseRevision).toBe(SHA64);
    // @ts-expect-error a bare string is not a parser-proven GitRevision.
    const forgedRevision: StandaloneChangedPaths["headRevision"] = "main";
    // @ts-expect-error an unsorted plain array is not a parser-proven SortedReviewPaths.
    const forgedPaths: StandaloneChangedPaths["unstaged"] = ["src/z.ts", "src/a.ts"];
    expect([forgedRevision, forgedPaths]).toHaveLength(2);
  });
});

describe("parseReviewMetadata docs_only invariant", () => {
  it("accepts a docs-only metadata record that also changes comments", () => {
    const parsed = parseReviewMetadata(docsOnly());
    expect(parsed.ok && parsed.value).toMatchObject({ docsOnly: true, sourceOrTestChanged: false, commentsChanged: true });
  });

  it("refuses docs_only without comments_changed — the contradiction that would silently drop comment-analyzer", () => {
    expect(errorsOf(parseReviewMetadata(docsOnly({ comments_changed: false }))))
      .toContain("comments_changed must be true when docs_only is true");
  });

  it("refuses docs_only with source_or_test_changed instead of normalizing it away", () => {
    expect(errorsOf(parseReviewMetadata(docsOnly({ source_or_test_changed: true }))))
      .toContain("source_or_test_changed must be false when docs_only is true");
  });

  it("property: every admitted docs-only record changes comments and no source or test", () => {
    fc.assert(fc.property(fc.boolean(), fc.boolean(), fc.boolean(), (docs, source, comments) => {
      const parsed = parseReviewMetadata(metadata({ docs_only: docs, source_or_test_changed: source, comments_changed: comments }));
      expect(parsed.ok).toBe(!docs || (!source && comments));
      if (parsed.ok && parsed.value.docsOnly) {
        expect(parsed.value.sourceOrTestChanged).toBe(false);
        expect(parsed.value.commentsChanged).toBe(true);
      }
    }));
  });

  it("refuses unknown kinds, empty kinds and negative counts", () => {
    expect(errorsOf(parseReviewMetadata(metadata({ requested_kinds: ["vibes"] })))).toContain("unknown review kind");
    expect(errorsOf(parseReviewMetadata(metadata({ requested_kinds: [] })))).toContain("must be non-empty");
    expect(errorsOf(parseReviewMetadata(metadata({ additions: -1 })))).toContain("non-negative safe integer");
  });
});

describe("parseStandaloneReviewScope and parseScopeSafety", () => {
  it("blocks empty, traversal and external scope rather than broadening it", () => {
    for (const raw of [[], ["src/../../outside.ts"], ["/tmp/outside.ts"], ["src/a.ts", "src/a.ts"]]) {
      expect(parseStandaloneReviewScope(raw).ok).toBe(false);
    }
    expect(parseStandaloneReviewScope(["src/a.ts", "docs/b.md"])).toEqual({ ok: true, value: ["src/a.ts", "docs/b.md"] });
  });

  it("requires safety for the exact frozen scope in order, and refuses symlinked or redirected paths", () => {
    const scope = ["src/a.ts", "src/b.ts"];
    const safe = scope.map((path) => ({ path, status: "safe" }));
    expect(parseScopeSafety(safe, scope).ok).toBe(true);
    expect(errorsOf(parseScopeSafety([...safe].reverse(), scope))).toContain("exact frozen scope in order");
    expect(errorsOf(parseScopeSafety(safe.slice(0, 1), scope))).toContain("exact frozen scope in order");
    expect(errorsOf(parseScopeSafety([safe[0], { path: "src/b.ts", status: "symlink" }], scope))).toContain("unsafe");
  });
});

describe("findingScopeErrors", () => {
  it("keeps an honestly unlocated finding and reports every located finding outside the scope", () => {
    const errors = findingScopeErrors(["src/a.ts"], [{ file: null }, { file: "src/a.ts" }, { file: "src/b.ts" }, { file: "../x" }], "findings");
    expect(errors).toEqual([
      "findings[2].file is outside the frozen review scope: src/b.ts",
      "findings[3].file is outside the frozen review scope: ../x",
    ]);
  });
});

describe("selectStandaloneReviewers", () => {
  it("property: selection is a distinct, canonically ordered roster that always starts with code-reviewer", () => {
    const kinds = fc.subarray(["code", "errors", "tests", "types", "comments", "architecture", "simplify", "all"] as const, { minLength: 1 });
    fc.assert(fc.property(kinds, fc.boolean(), fc.boolean(), fc.boolean(), fc.nat(1000), (requested, source, types, comments, additions) => {
      const parsed = parseReviewMetadata(metadata({ requested_kinds: requested, source_or_test_changed: source,
        types_changed: types, comments_changed: comments, additions }));
      if (!parsed.ok) throw new Error(errorsOf(parsed));
      const selected = selectStandaloneReviewers(parsed.value);
      expect(selected[0]).toBe("code-reviewer");
      expect(new Set(selected).size).toBe(selected.length);
      const order = selected.map((role) => STANDALONE_REVIEWER_ROLES.indexOf(role));
      expect(order).toEqual([...order].sort((a, b) => a - b));
    }));
  });
});

describe("canonicalDigest", () => {
  it("property: is byte-identical to SHA-256 over the value's JSON text (the digest persisted runs replay against)", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      expect(canonicalDigest(value)).toBe(createHash("sha256").update(JSON.stringify(value)).digest("hex"));
    }), { numRuns: 200 });
  });
});
