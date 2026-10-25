/**
 * The overlay's path set, read from `git status --porcelain=v2 -z
 * --untracked-files=all` (AD-8, FR-015): every record kind porcelain v2
 * prints, both sides of a rename or copy, and the two refusals.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { statusPaths } from "../../src/core/owner-verification/status-paths";

const HASH = "0".repeat(40);
const ordinary = (path: string): string => `1 .M N... 100644 100644 100644 ${HASH} ${HASH} ${path}`;
const renamed = (path: string, original: string, score = "R100"): readonly string[] =>
  [`2 R. N... 100644 100644 100644 ${HASH} ${HASH} ${score} ${path}`, original];
const unmerged = (path: string): string => `u UU N... 100644 100644 100644 100644 ${HASH} ${HASH} ${HASH} ${path}`;
const output = (...records: readonly string[]): string => `${records.join("\0")}\0`;

describe("statusPaths", () => {
  it.each([
    ["an ordinary change", output(ordinary("src/rules/owner.ts")), ["src/rules/owner.ts"]],
    ["an ordinary change whose path has spaces", output(ordinary("docs/a b.md")), ["docs/a b.md"]],
    ["a deletion", output(`1 .D N... 100644 100644 000000 ${HASH} ${HASH} src/other.ts`), ["src/other.ts"]],
    ["a rename, both sides", output(...renamed("src/new.ts", "src/old.ts")), ["src/new.ts", "src/old.ts"]],
    ["a copy, both sides", output(...renamed("src/copy.ts", "src/source.ts", "C075")), ["src/copy.ts", "src/source.ts"]],
    ["a rename whose sides have spaces", output(...renamed("a b/new.ts", "a b/old.ts")), ["a b/new.ts", "a b/old.ts"]],
    ["an unmerged path", output(unmerged("src/conflict.ts")), ["src/conflict.ts"]],
    ["an untracked file", output("? notes.txt"), ["notes.txt"]],
    ["an untracked directory, trailing slash kept", output("? fixtures/"), ["fixtures/"]],
    ["headers and empty records", output("# branch.oid abc", "# branch.head main", "", ordinary("x.ts")), ["x.ts"]],
    ["nothing changed", "", []],
    [
      "every kind in output order",
      output(ordinary("a.ts"), ...renamed("b.ts", "c.ts"), unmerged("d.ts"), "? e/"),
      ["a.ts", "b.ts", "c.ts", "d.ts", "e/"],
    ],
  ] as const)("names %s", (_case, raw, expected) => {
    expect(statusPaths(raw)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ["an unknown record kind", output("! ignored.txt"), /unrecognized record: "! ignored.txt"/],
    ["a truncated ordinary record", output("1 .M N... 100644"), /unrecognized record/],
    ["a truncated unmerged record", output(`u UU N... 100644 100644 100644 100644 ${HASH} ${HASH} ${HASH}`), /unrecognized record/],
    ["a rename at the end of the output with no original", `2 R. N... 100644 100644 100644 ${HASH} ${HASH} R100 new.ts`, /rename without its original path/],
    ["a rename followed by an empty original", output(...renamed("new.ts", "")), /rename without its original path/],
  ] as const)("refuses %s", (_case, raw, message) => {
    const parsed = statusPaths(raw);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(message);
  });

  it("names each ordinary path exactly once, in order, whatever the path text", () => {
    const path = fc.string({ minLength: 1, maxLength: 24 }).filter((text) => !text.includes("\0"));
    fc.assert(fc.property(fc.array(path, { maxLength: 8 }), (paths) => {
      expect(statusPaths(output(...paths.map(ordinary)))).toEqual({ ok: true, value: paths });
    }));
  });
});
