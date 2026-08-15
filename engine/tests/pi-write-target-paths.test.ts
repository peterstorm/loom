import { describe, expect, it } from "vitest";
import { piWriteTargetPaths } from "../../pi/extension";

/**
 * `piWriteTargetPaths` is the extraction step a SCOPED phase-agent write grant
 * enforces against: `pi/extension.ts` blocks the edit outright when it returns
 * `[]` ("cannot verify the write target"), and runs every returned path through
 * `writeTargetViolatesScope` otherwise.
 *
 * Only the downstream predicate had tests. The extraction itself had none, in
 * either direction — so neither the fail-closed empty result nor the
 * `multi_edit` branch was verified, and a multi-target edit whose SECOND target
 * escaped the grant's scope had nothing proving the extractor even reported it.
 * A regression that dropped the `edits` branch would have turned every scoped
 * multi-edit into a silently unverified write.
 */
describe("piWriteTargetPaths — the scoped-grant write-target extractor", () => {
  describe("fails closed: an unrecognized shape yields no targets", () => {
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
      ["an edits array with no usable entries", { edits: [null, 3, "src/a.ts", {}, { path: "" }] }],
    ])("%s → []", (_label, input) => {
      expect(piWriteTargetPaths(input)).toEqual([]);
    });
  });

  describe("single-target shapes", () => {
    it.each([
      ["path", { path: "src/a.ts" }],
      ["file_path", { file_path: "src/a.ts" }],
      ["filePath", { filePath: "src/a.ts" }],
    ])("reads %s", (_label, input) => {
      expect(piWriteTargetPaths(input)).toEqual(["src/a.ts"]);
    });

    it("prefers `path` when more than one spelling is present", () => {
      expect(piWriteTargetPaths({ path: "src/a.ts", file_path: "src/b.ts" })).toEqual(["src/a.ts"]);
    });
  });

  describe("multi_edit: the `edits` array branch", () => {
    it("returns every distinct target, in order", () => {
      expect(piWriteTargetPaths({
        edits: [
          { path: "src/a.ts", old: "x", new: "y" },
          { file_path: "src/b.ts" },
          { path: "src/c.ts" },
        ],
      })).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    });

    it("deduplicates repeated targets without dropping distinct ones", () => {
      expect(piWriteTargetPaths({
        edits: [{ path: "src/a.ts" }, { path: "src/a.ts" }, { path: "src/b.ts" }],
      })).toEqual(["src/a.ts", "src/b.ts"]);
    });

    it("skips unusable entries but still reports the usable siblings", () => {
      // The scope check runs over EVERY returned path, so an out-of-scope
      // target sitting behind a malformed sibling must still be reported —
      // silently returning [] here would instead block the whole edit, and
      // silently returning only the first would let the second escape.
      expect(piWriteTargetPaths({
        edits: [null, { path: "src/a.ts" }, "nonsense", { path: 7 }, { file_path: "../../etc/passwd" }],
      })).toEqual(["src/a.ts", "../../etc/passwd"]);
    });

    it("ignores `edits` when a direct path is also present", () => {
      expect(piWriteTargetPaths({ path: "src/a.ts", edits: [{ path: "src/b.ts" }] }))
        .toEqual(["src/a.ts"]);
    });
  });
});
