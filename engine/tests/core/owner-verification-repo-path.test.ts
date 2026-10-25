/**
 * The one repository-relative path rule both owner-verification seams use:
 * alias targets (`tsconfig-paths.ts`) and import specifiers (`coverage.ts`)
 * collapse `.`, `..` and empty segments the same way, and an escape from the
 * repository root is null, never a path.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { directoryOf, normalizeRepoPath, within } from "../../src/core/owner-verification/repo-path";

describe("the repository-relative path rule", () => {
  it.each([
    ["", "a/b", "a/b"],
    ["a", "./b/../c", "a/c"],
    ["a/b", "../..", ""],
    ["a", "../../x", null],
    ["", "..", null],
    ["a", "/b", "a/b"],
    ["a//b", "c", "a/b/c"],
  ] as const)("within(%j, %j) is %j", (directory, relative, expected) => {
    expect(within(directory, relative)).toBe(expected);
  });

  it.each([
    ["a/b/c.ts", "a/b/c.ts"],
    ["./a/./b.ts", "a/b.ts"],
    ["a/../b.ts", "b.ts"],
    ["a//b.ts", "a/b.ts"],
    ["../a.ts", null],
    ["a/../../b.ts", null],
  ] as const)("normalizeRepoPath(%j) is %j", (path, expected) => {
    expect(normalizeRepoPath(path)).toBe(expected);
  });

  it("directoryOf names the containing directory, empty at the root", () => {
    expect(directoryOf("a/b/c.ts")).toBe("a/b");
    expect(directoryOf("c.ts")).toBe("");
  });

  const segment = fc.constantFrom("a", "b", "src", ".", "..", "");
  const path = fc.array(segment, { maxLength: 6 }).map((segments) => segments.join("/"));

  it("property — normalizing is idempotent and never leaves `.`, `..` or empty segments", () => {
    fc.assert(fc.property(path, (raw) => {
      const once = normalizeRepoPath(raw);
      if (once === null) return;
      expect(normalizeRepoPath(once)).toBe(once);
      if (once !== "") expect(once.split("/").every((part) => part !== "" && part !== "." && part !== "..")).toBe(true);
    }));
  });

  it("property — within(directory, relative) is the normalized join", () => {
    fc.assert(fc.property(path, path, (directory, relative) => {
      expect(within(directory, relative)).toBe(normalizeRepoPath(`${directory}/${relative}`));
    }));
  });
});
