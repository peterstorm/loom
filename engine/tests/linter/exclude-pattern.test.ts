/**
 * Tests for a rule's exclusion list: the parse from an author's entry to a
 * file suffix or a directory, and the one matcher over the parsed forms.
 *
 * The two forms are told apart by a trailing slash and nothing else, so the
 * cases here pin the boundary between them, the fact that a directory pattern
 * cannot swallow a sibling whose name merely starts the same way, and the
 * frame a directory is matched in: the project, never the directories above it.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  describeExcludePatternError,
  matchesAnyExcludePattern,
  parseExcludePattern,
} from "../../src/linter/exclude-pattern";
import { excludePatterns } from "./exclude-patterns";

const ROOT = "/work/shop";

/** Does the one entry exclude `filePath`, in the project at `projectRoot`? */
const excludes = (filePath: string, entry: string, projectRoot: string | null = ROOT): boolean =>
  matchesAnyExcludePattern(filePath, excludePatterns(entry), projectRoot);

describe("parseExcludePattern", () => {
  it("reads an entry without a trailing slash as a file suffix", () => {
    expect(parseExcludePattern(".test.ts")).toEqual({ ok: true, value: { kind: "suffix", suffix: ".test.ts" } });
    expect(parseExcludePattern("scripts/lint-project.ts"))
      .toEqual({ ok: true, value: { kind: "suffix", suffix: "scripts/lint-project.ts" } });
  });

  it("reads an entry with a trailing slash as a directory, anchored by a leading slash", () => {
    const directory = { ok: true, value: { kind: "directory", segments: "/src/infra/" } };
    expect(parseExcludePattern("src/infra/")).toEqual(directory);
    expect(parseExcludePattern("/src/infra/")).toEqual(directory);
  });

  it("normalizes Windows separators, as a path's are when it is matched", () => {
    expect(parseExcludePattern("src\\infra\\")).toEqual(parseExcludePattern("src/infra/"));
    expect(parseExcludePattern("scripts\\lint-project.ts")).toEqual(parseExcludePattern("scripts/lint-project.ts"));
  });

  it("refuses an empty entry", () => {
    expect(parseExcludePattern("")).toEqual({ ok: false, error: { kind: "empty" } });
  });

  it.each(["/", "//", "\\"])("refuses %p: a directory with no name", (raw) => {
    expect(parseExcludePattern(raw)).toEqual({ ok: false, error: { kind: "unnamed-directory", raw } });
  });

  it.each(["**/*.test.ts", "src/*/", "*.java"])("refuses the glob %p", (raw) => {
    expect(parseExcludePattern(raw)).toEqual({ ok: false, error: { kind: "glob", raw } });
  });

  it("describes each refusal in the author's terms", () => {
    expect(describeExcludePatternError({ kind: "empty" })).toBe("is empty — it would exclude nothing");
    expect(describeExcludePatternError({ kind: "unnamed-directory", raw: "/" }))
      .toBe("'/' names no directory — it would exclude nothing");
    expect(describeExcludePatternError({ kind: "glob", raw: "*.java" }))
      .toBe("'*.java' is a glob — name a directory with a trailing '/' (every file beneath it) or a file suffix");
  });

  it("every entry is either refused or parsed to a pattern that can match some file", () => {
    fc.assert(fc.property(fc.string(), (raw) => {
      const parsed = parseExcludePattern(raw);
      if (!parsed.ok) return;
      const pattern = parsed.value;
      const witness = pattern.kind === "suffix" ? `src/x${pattern.suffix}` : `${pattern.segments.slice(1)}x.ts`;
      expect(matchesAnyExcludePattern(witness, [pattern], ROOT)).toBe(true);
    }));
  });
});

describe("a file-suffix pattern", () => {
  it.each([
    ["/work/shop/src/domain/order.test.ts", ".test.ts"],
    ["/work/shop/src/domain/order.property.test.ts", ".property.test.ts"],
    ["/work/shop/scripts/lint-project.ts", "scripts/lint-project.ts"],
    ["src/domain/order.test.ts", ".test.ts"],
  ])("excludes %s by %s", (filePath, entry) => {
    expect(excludes(filePath, entry)).toBe(true);
  });

  it.each([
    ["/work/shop/src/domain/order.ts", ".test.ts"],
    ["/work/shop/src/domain/order.spec.ts", ".test.ts"],
    ["/work/shop/scripts/other-tool.ts", "scripts/lint-project.ts"],
  ])("does not exclude %s by %s", (filePath, entry) => {
    expect(excludes(filePath, entry)).toBe(false);
  });

  it("matches a Windows path by its normalized separators", () => {
    expect(excludes("C:\\work\\shop\\src\\order.test.ts", ".test.ts", "C:\\work\\shop")).toBe(true);
    expect(excludes("C:\\work\\shop\\scripts\\lint-project.ts", "scripts/lint-project.ts", "C:\\work\\shop")).toBe(true);
  });

  it("never depended on where the checkout lives: it matches with no project, and outside the root", () => {
    expect(excludes("/work/shop/src/order.test.ts", ".test.ts", null)).toBe(true);
    expect(excludes("/srv/other/src/order.test.ts", ".test.ts")).toBe(true);
  });
});

describe("a directory pattern", () => {
  it.each([
    ["/work/shop/apps/demo/src/main.ts", "apps/"],
    ["/work/shop/apps/demo/src/main.ts", "/apps/"],
    ["/work/shop/scripts/release.ts", "scripts/"],
    ["/work/shop/packages/framework/src/types/clock.ts", "packages/framework/src/types/"],
  ])("excludes %s by directory %s", (filePath, entry) => {
    expect(excludes(filePath, entry)).toBe(true);
  });

  it.each([
    ["/work/shop/packages/frameworks/src/x.ts", "framework/"],
    ["/work/shop/src/infrastructure/Db.java", "/infra/"],
    ["/work/shop/mysrc/infra/Db.java", "/src/infra/"],
    ["/work/shop/apps/demo/src/main.ts", "app/"],
  ])("does not exclude %s by directory %s", (filePath, entry) => {
    expect(excludes(filePath, entry)).toBe(false);
  });

  it("is anchored to a segment boundary, not to the front of the path", () => {
    expect(excludes("/work/shop/packages/host/src/apps/x.ts", "apps/")).toBe(true);
    expect(excludes("/work/shop/approvals/x.ts", "apps/")).toBe(false);
  });

  it("takes an already-relative path as project-relative, with or without a project", () => {
    expect(excludes("src/infra/Db.java", "src/infra/")).toBe(true);
    expect(excludes("src/infra/Db.java", "/src/infra/")).toBe(true);
    expect(excludes("src/infrastructure/Db.java", "src/infra/")).toBe(false);
    expect(excludes("mysrc/infra/Db.java", "src/infra/")).toBe(false);
    expect(excludes("src/infra/Db.java", "src/infra/", null)).toBe(true);
  });

  it("matches a Windows path by its normalized separators", () => {
    expect(excludes("C:\\work\\shop\\src\\infra\\Db.java", "src/infra/", "C:\\work\\shop")).toBe(true);
    expect(excludes("C:\\work\\shop\\src\\infra\\Db.java", "src\\infra\\", "C:\\work\\shop")).toBe(true);
  });
});

describe("a directory pattern is matched inside the project", () => {
  // A checkout whose own location spells the directory the pattern names.
  const UNDER_APPS = "/home/u/apps/shop";

  it("does not exclude a file because a directory above the project has the pattern's name", () => {
    expect(excludes(`${UNDER_APPS}/src/order.ts`, "apps/", UNDER_APPS)).toBe(false);
    expect(excludes(`${UNDER_APPS}/src/order.ts`, "/apps/", UNDER_APPS)).toBe(false);
    expect(excludes(`${UNDER_APPS}/src/order.ts`, "u/apps/shop/", UNDER_APPS)).toBe(false);
  });

  it("still excludes the project's own directory of that name, at any depth", () => {
    expect(excludes(`${UNDER_APPS}/apps/demo/main.ts`, "apps/", UNDER_APPS)).toBe(true);
    expect(excludes(`${UNDER_APPS}/packages/host/src/apps/x.ts`, "apps/", UNDER_APPS)).toBe(true);
    expect(excludes(`${UNDER_APPS}/approvals/x.ts`, "apps/", UNDER_APPS)).toBe(false);
  });

  it("reads the root with a trailing slash or Windows separators as the same root", () => {
    expect(excludes(`${UNDER_APPS}/src/order.ts`, "apps/", `${UNDER_APPS}/`)).toBe(false);
    expect(excludes("C:\\apps\\shop\\src\\order.ts", "apps/", "C:\\apps\\shop")).toBe(false);
    expect(excludes("C:\\apps\\shop\\apps\\demo\\main.ts", "apps/", "C:\\apps\\shop")).toBe(true);
  });

  it("excludes nothing when no project owns the rules: the frame is unknown, so the rule reads the file", () => {
    expect(excludes(`${UNDER_APPS}/src/order.ts`, "apps/", null)).toBe(false);
    expect(excludes(`${UNDER_APPS}/apps/demo/main.ts`, "apps/", null)).toBe(false);
  });

  it("excludes nothing for a file outside the project root", () => {
    expect(excludes("/srv/apps/other/x.ts", "apps/", UNDER_APPS)).toBe(false);
    // A sibling whose name only starts with the root's is outside it.
    expect(excludes("/home/u/apps/shop-old/apps/x.ts", "apps/", UNDER_APPS)).toBe(false);
  });

  it("no directory pattern excludes a file by the directories above its project", () => {
    const segment = fc.stringMatching(/^[a-z]{1,6}$/);
    fc.assert(fc.property(fc.array(segment, { minLength: 1, maxLength: 4 }), segment, (above, name) => {
      const root = `/${above.join("/")}`;
      const inProject = `${root}/zz-${name}.ts`;
      for (const directory of above) expect(excludes(inProject, `${directory}/`, root)).toBe(false);
    }));
  });
});

describe("matchesAnyExcludePattern", () => {
  it("an empty list excludes nothing", () => {
    expect(matchesAnyExcludePattern("/work/shop/src/order.ts", [], ROOT)).toBe(false);
  });

  it("one matching pattern among several is enough", () => {
    expect(matchesAnyExcludePattern("/work/shop/src/order.test.ts", excludePatterns("apps/", ".test.ts"), ROOT)).toBe(true);
  });
});
