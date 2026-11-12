/**
 * Tests for the one rule-exclusion matcher: file suffixes and directories.
 *
 * The two forms are told apart by a trailing slash and nothing else, so the
 * cases here pin the boundary between them — and the fact that a directory
 * pattern cannot swallow a sibling whose name merely starts the same way.
 */

import { describe, it, expect } from "vitest";
import { matchesExcludePattern, matchesAnyExcludePattern } from "../../src/linter/exclude-pattern";

describe("matchesExcludePattern — file suffix form", () => {
  it.each([
    ["/work/shop/src/domain/order.test.ts", ".test.ts"],
    ["/work/shop/src/domain/order.property.test.ts", ".property.test.ts"],
    ["/work/shop/scripts/lint-project.ts", "scripts/lint-project.ts"],
    ["C:\\work\\shop\\src\\order.test.ts", ".test.ts"],
  ])("excludes %s by %s", (filePath, pattern) => {
    expect(matchesExcludePattern(filePath, pattern)).toBe(true);
  });

  it.each([
    ["/work/shop/src/domain/order.ts", ".test.ts"],
    ["/work/shop/src/domain/order.spec.ts", ".test.ts"],
    ["/work/shop/scripts/other-tool.ts", "scripts/lint-project.ts"],
  ])("does not exclude %s by %s", (filePath, pattern) => {
    expect(matchesExcludePattern(filePath, pattern)).toBe(false);
  });
});

describe("matchesExcludePattern — directory form", () => {
  it.each([
    ["/work/shop/apps/demo/src/main.ts", "apps/"],
    ["/work/shop/apps/demo/src/main.ts", "/apps/"],
    ["/work/shop/scripts/release.ts", "scripts/"],
    ["/work/shop/packages/framework/src/types/clock.ts", "packages/framework/src/types/"],
  ])("excludes %s by directory %s", (filePath, pattern) => {
    expect(matchesExcludePattern(filePath, pattern)).toBe(true);
  });

  it.each([
    ["/work/shop/packages/frameworks/src/x.ts", "framework/"],
    ["/work/shop/src/infrastructure/Db.java", "/infra/"],
    ["/work/shop/mysrc/infra/Db.java", "/src/infra/"],
    ["/work/shop/apps/demo/src/main.ts", "app/"],
  ])("does not exclude %s by directory %s", (filePath, pattern) => {
    expect(matchesExcludePattern(filePath, pattern)).toBe(false);
  });

  it("anchors a project-relative directory to a segment boundary, not to the front of the path", () => {
    expect(matchesExcludePattern("/work/shop/packages/host/src/apps/x.ts", "apps/")).toBe(true);
    expect(matchesExcludePattern("/work/shop/approvals/x.ts", "apps/")).toBe(false);
  });

  it("matches a Windows path by its normalized separators", () => {
    expect(matchesExcludePattern("C:\\work\\shop\\src\\infra\\Db.java", "src/infra/")).toBe(true);
  });
});

describe("matchesExcludePattern — degenerate patterns exclude nothing", () => {
  it.each(["", "/"])("the empty-ish pattern %p matches no file", (pattern) => {
    expect(matchesExcludePattern("/work/shop/src/order.ts", pattern)).toBe(false);
  });

  it("an empty list excludes nothing", () => {
    expect(matchesAnyExcludePattern("/work/shop/src/order.ts", [])).toBe(false);
  });

  it("one matching pattern among several is enough", () => {
    expect(matchesAnyExcludePattern("/work/shop/src/order.test.ts", ["apps/", ".test.ts"])).toBe(true);
  });
});
