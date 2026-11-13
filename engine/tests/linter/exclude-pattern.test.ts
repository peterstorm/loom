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

  it("excludes a relative path exactly as its absolute spelling", () => {
    expect(matchesExcludePattern("src/infra/Db.java", "src/infra/")).toBe(true);
    expect(matchesExcludePattern("src/infra/Db.java", "/src/infra/")).toBe(true);
    expect(matchesExcludePattern("src/infrastructure/Db.java", "src/infra/")).toBe(false);
    expect(matchesExcludePattern("mysrc/infra/Db.java", "src/infra/")).toBe(false);
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
    expect(matchesAnyExcludePattern("/work/shop/src/order.ts", [], "/work/shop")).toBe(false);
  });

  it("one matching pattern among several is enough", () => {
    expect(matchesAnyExcludePattern("/work/shop/src/order.test.ts", ["apps/", ".test.ts"], "/work/shop")).toBe(true);
  });
});

describe("matchesAnyExcludePattern — patterns are matched inside the project", () => {
  // A checkout whose own location spells the directory the pattern names.
  const ROOT = "/home/u/apps/shop";

  it("does not exclude a file because a directory above the project has the pattern's name", () => {
    expect(matchesAnyExcludePattern(`${ROOT}/src/order.ts`, ["apps/"], ROOT)).toBe(false);
    expect(matchesAnyExcludePattern(`${ROOT}/src/order.ts`, ["/apps/"], ROOT)).toBe(false);
    expect(matchesAnyExcludePattern(`${ROOT}/src/order.ts`, ["u/apps/shop/"], ROOT)).toBe(false);
  });

  it("still excludes the project's own directory of that name, at any depth", () => {
    expect(matchesAnyExcludePattern(`${ROOT}/apps/demo/main.ts`, ["apps/"], ROOT)).toBe(true);
    expect(matchesAnyExcludePattern(`${ROOT}/packages/host/src/apps/x.ts`, ["apps/"], ROOT)).toBe(true);
    expect(matchesAnyExcludePattern(`${ROOT}/approvals/x.ts`, ["apps/"], ROOT)).toBe(false);
  });

  it("reads the root with a trailing slash or Windows separators as the same root", () => {
    expect(matchesAnyExcludePattern(`${ROOT}/src/order.ts`, ["apps/"], `${ROOT}/`)).toBe(false);
    expect(matchesAnyExcludePattern("C:\\apps\\shop\\src\\order.ts", ["apps/"], "C:\\apps\\shop")).toBe(false);
    expect(matchesAnyExcludePattern("C:\\apps\\shop\\apps\\demo\\main.ts", ["apps/"], "C:\\apps\\shop")).toBe(true);
  });

  it("leaves a file-suffix pattern alone: it never depended on where the checkout lives", () => {
    expect(matchesAnyExcludePattern(`${ROOT}/src/order.test.ts`, [".test.ts"], ROOT)).toBe(true);
    expect(matchesAnyExcludePattern(`${ROOT}/scripts/lint-project.ts`, ["scripts/lint-project.ts"], ROOT)).toBe(true);
  });

  it("takes an already-relative path as project-relative", () => {
    expect(matchesAnyExcludePattern("apps/demo/main.ts", ["apps/"], ROOT)).toBe(true);
    expect(matchesAnyExcludePattern("src/order.ts", ["apps/"], ROOT)).toBe(false);
  });

  it("compares the path as given when no project owns the rules, or the file is outside the root", () => {
    expect(matchesAnyExcludePattern(`${ROOT}/src/order.ts`, ["apps/"], null)).toBe(true);
    expect(matchesAnyExcludePattern("/srv/apps/other/x.ts", ["apps/"], ROOT)).toBe(true);
    // A sibling whose name only starts with the root's is outside it.
    expect(matchesAnyExcludePattern("/home/u/apps/shop-old/x.ts", ["apps/"], ROOT)).toBe(true);
  });
});
