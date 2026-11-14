/**
 * The user's lint-coverage ignore list (`core/lint-coverage-ignore.ts`): one
 * smart constructor for an entry, a strict parse that applies it, and updates
 * that are idempotent and round-trip through the rendered document.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  describeIgnoredProjectError,
  ignoredProject,
  isIgnored,
  parseCoverageIgnoreList,
  renderCoverageIgnoreList,
  withIgnored,
  withoutIgnored,
  type CoverageIgnoreList,
  type IgnoredProject,
} from "../../src/core/lint-coverage-ignore";

const entry = (path: string, reason: string): IgnoredProject => {
  const result = ignoredProject(path, reason);
  if (!result.ok) throw new Error(describeIgnoredProjectError(result.error, ""));
  return result.value;
};

const pathArb = fc.array(fc.stringMatching(/^[a-z0-9-]{1,8}$/), { minLength: 1, maxLength: 4 }).map((segments) => `/${segments.join("/")}`);
const reasonArb = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim() !== "");
const listArb: fc.Arbitrary<CoverageIgnoreList> = fc
  .uniqueArray(fc.record({ path: pathArb, reason: reasonArb }), { selector: (raw) => raw.path, maxLength: 5 })
  .map((raws) => raws.map(({ path, reason }) => entry(path, reason)));

const parse = (text: string): CoverageIgnoreList => {
  const result = parseCoverageIgnoreList(JSON.parse(text));
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

describe("ignoredProject — the one place an entry's invariant is checked", () => {
  it("refuses a relative path and a blank reason, by kind", () => {
    expect(ignoredProject("relative", "x")).toEqual({ ok: false, error: { kind: "relative-path", path: "relative" } });
    expect(ignoredProject("/a", " \t")).toEqual({ ok: false, error: { kind: "blank-reason" } });
    expect(describeIgnoredProjectError({ kind: "relative-path", path: "r" }, "ignore[2].")).toBe("ignore[2].path must be an absolute path");
    expect(describeIgnoredProjectError({ kind: "blank-reason" }, "")).toBe("reason must be a non-empty string");
  });

  it("property: the parser accepts an entry exactly when the smart constructor does", () => {
    fc.assert(fc.property(fc.oneof(pathArb, fc.string()), fc.string(), (path, reason) => {
      const constructed = ignoredProject(path, reason);
      const parsed = parseCoverageIgnoreList({ ignore: [{ path, reason }] });
      expect(parsed.ok).toBe(constructed.ok);
      if (constructed.ok && parsed.ok) expect(parsed.value).toEqual([constructed.value]);
    }));
  });
});

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
    expect(refusal({ ignore: [{ path: 7, reason: "x" }] })).toBe("ignore[0].path must be an absolute path");
    expect(refusal({ ignore: [{ path: "/a", reason: " " }] })).toBe("ignore[0].reason must be a non-empty string");
    expect(refusal({ ignore: [{ path: "/a", reason: null }] })).toBe("ignore[0].reason must be a non-empty string");
  });

  it("names the first refused entry, in order", () => {
    const result = parseCoverageIgnoreList({ ignore: [{ path: "/ok", reason: "fine" }, { path: "rel", reason: "x" }, "bad"] });
    expect(result).toEqual({ ok: false, error: "ignore[1].path must be an absolute path" });
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
      const once = withIgnored(list, entry(path, first));
      expect(withIgnored(once, entry(path, first))).toEqual(once);
      expect(isIgnored(once, path)).toBe(true);
      const replaced = withIgnored(once, entry(path, second));
      expect(replaced.filter((ignored) => ignored.path === path)).toEqual([{ path, reason: second }]);
    }));
  });

  it("property: unignoring removes exactly that path, and twice is the same as once", () => {
    fc.assert(fc.property(listArb, pathArb, (list, path) => {
      const removed = withoutIgnored(list, path);
      expect(isIgnored(removed, path)).toBe(false);
      expect(withoutIgnored(removed, path)).toEqual(removed);
      expect(removed).toEqual(list.filter((ignored) => ignored.path !== path));
    }));
  });

  it("matches a project by its exact root, never a parent or child of it", () => {
    const list = withIgnored([], entry("/work/repo", "not mine"));
    expect(isIgnored(list, "/work/repo")).toBe(true);
    expect(isIgnored(list, "/work")).toBe(false);
    expect(isIgnored(list, "/work/repo/sub")).toBe(false);
  });
});
