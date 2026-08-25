import { describe, expect, it } from "vitest";
import { piWriteTargetPaths } from "../../pi/extension";

const paths = (input: unknown): readonly string[] => {
  const parsed = piWriteTargetPaths(input);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

describe("piWriteTargetPaths — all-or-nothing scoped write parsing", () => {
  describe("fails closed with a typed parse error", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["a string", "src/a.ts"],
      ["a number", 7],
      ["an array", ["src/a.ts"]],
      ["an empty object", {}],
      ["a path that is not a string", { path: 7 }],
      ["an empty path string", { path: "" }],
      ["an empty file_path string", { file_path: "" }],
      ["an edits value that is not an array", { edits: { path: "src/a.ts" } }],
      ["an empty edits array", { edits: [] }],
    ])("rejects %s", (_label, input) => {
      expect(piWriteTargetPaths(input)).toMatchObject({ ok: false, error: expect.any(String) });
    });
  });

  describe("single-target shapes", () => {
    it.each([
      ["path", { path: "src/a.ts" }],
      ["file_path", { file_path: "src/a.ts" }],
      ["filePath", { filePath: "src/a.ts" }],
    ])("reads %s", (_label, input) => {
      expect(paths(input)).toEqual(["src/a.ts"]);
    });

    it("preserves direct-path precedence when more than one spelling is present", () => {
      expect(paths({ path: "src/a.ts", file_path: "src/b.ts" })).toEqual(["src/a.ts"]);
    });
  });

  describe("multi_edit entries", () => {
    it("returns every distinct parsed target in order", () => {
      expect(paths({
        edits: [
          { path: "src/a.ts", old: "x", new: "y" },
          { file_path: "src/b.ts" },
          { filePath: "src/c.ts" },
          { path: "src/a.ts" },
        ],
      })).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    });

    it("blocks the whole batch when any sibling is malformed", () => {
      const parsed = piWriteTargetPaths({
        edits: [{ path: "src/a.ts" }, { path: 7 }, { file_path: "../../etc/passwd" }],
      });
      expect(parsed).toEqual({
        ok: false,
        error: "write input.edits[1] must name one non-empty path, file_path, or filePath target",
      });
      expect(parsed).not.toHaveProperty("value");
    });

    it("returns every valid target so an out-of-scope sibling cannot hide", () => {
      expect(paths({ edits: [{ path: "src/a.ts" }, { file_path: "../../etc/passwd" }] }))
        .toEqual(["src/a.ts", "../../etc/passwd"]);
    });

    it("uses a direct path for the standard one-file multi-edit shape", () => {
      expect(paths({ path: "src/a.ts", edits: [{ oldText: "x", newText: "y" }] }))
        .toEqual(["src/a.ts"]);
    });
  });
});
