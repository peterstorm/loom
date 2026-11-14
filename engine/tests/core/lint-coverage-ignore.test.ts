/**
 * The user's lint-coverage ignore list (`core/lint-coverage-ignore.ts`): a
 * strict parse, and updates that are idempotent and round-trip through the
 * rendered document.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  isIgnored,
  parseCoverageIgnoreList,
  renderCoverageIgnoreList,
  withIgnored,
  withoutIgnored,
  type CoverageIgnoreList,
} from "../../src/core/lint-coverage-ignore";

const pathArb = fc.array(fc.stringMatching(/^[a-z0-9-]{1,8}$/), { minLength: 1, maxLength: 4 }).map((segments) => `/${segments.join("/")}`);
const reasonArb = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim() !== "");
const listArb: fc.Arbitrary<CoverageIgnoreList> = fc.uniqueArray(fc.record({ path: pathArb, reason: reasonArb }), { selector: (entry) => entry.path, maxLength: 5 });

const parse = (text: string): CoverageIgnoreList => {
  const result = parseCoverageIgnoreList(JSON.parse(text));
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

describe("parseCoverageIgnoreList", () => {
  it("accepts the documented shape", () => {
    expect(parseCoverageIgnoreList({ ignore: [{ path: "/src/vendor-fork", reason: "upstream's repository" }] }))
      .toEqual({ ok: true, value: [{ path: "/src/vendor-fork", reason: "upstream's repository" }] });
  });

  it("refuses anything else, naming what is wrong — a broken list never reads as 'ignore all'", () => {
    const refusal = (raw: unknown): string => {
      const result = parseCoverageIgnoreList(raw);
      return result.ok ? "accepted" : result.error;
    };
    expect(refusal([])).toContain("expected { \"ignore\": [{ path, reason }] }");
    expect(refusal({ ignore: [], extra: 1 })).toBe("unknown key 'extra'");
    expect(refusal({ ignore: ["/a"] })).toBe("ignore[0] must be an object { path, reason }");
    expect(refusal({ ignore: [{ path: "/a", reason: "x", note: "y" }] })).toBe("ignore[0] has unknown key 'note'");
    expect(refusal({ ignore: [{ path: "relative", reason: "x" }] })).toBe("ignore[0].path must be an absolute path");
    expect(refusal({ ignore: [{ path: "/a", reason: " " }] })).toBe("ignore[0].reason must be a non-empty string");
  });
});

describe("ignore-list updates", () => {
  it("property: the rendered list parses back to itself", () => {
    fc.assert(fc.property(listArb, (list) => {
      expect(parse(renderCoverageIgnoreList(list))).toEqual(list);
    }));
  });

  it("property: ignoring is idempotent and replaces an earlier reason", () => {
    fc.assert(fc.property(listArb, pathArb, reasonArb, reasonArb, (list, path, first, second) => {
      const once = withIgnored(list, path, first);
      expect(withIgnored(once, path, first)).toEqual(once);
      expect(isIgnored(once, path)).toBe(true);
      const replaced = withIgnored(once, path, second);
      expect(replaced.filter((entry) => entry.path === path)).toEqual([{ path, reason: second }]);
    }));
  });

  it("property: unignoring removes exactly that path, and twice is the same as once", () => {
    fc.assert(fc.property(listArb, pathArb, (list, path) => {
      const removed = withoutIgnored(list, path);
      expect(isIgnored(removed, path)).toBe(false);
      expect(withoutIgnored(removed, path)).toEqual(removed);
      expect(removed).toEqual(list.filter((entry) => entry.path !== path));
    }));
  });

  it("matches a project by its exact root, never a parent or child of it", () => {
    const list = withIgnored([], "/work/repo", "not mine");
    expect(isIgnored(list, "/work/repo")).toBe(true);
    expect(isIgnored(list, "/work")).toBe(false);
    expect(isIgnored(list, "/work/repo/sub")).toBe(false);
  });
});
