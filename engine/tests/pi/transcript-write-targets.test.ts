import { describe, expect, it } from "vitest";
import { writeTargetPathOf, writtenPathsOf } from "../../../pi/transcript-adapter";

describe("writtenPathsOf", () => {
  it("reads write/Write tool-call paths in order and ignores everything else", () => {
    expect(writtenPathsOf([
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "write", arguments: { path: "a.md" } }] },
      { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { path: "b.md" } }] },
      { role: "user", content: [{ type: "toolCall", id: "c3", name: "write", arguments: { path: "c.md" } }] },
      { role: "assistant", content: [{ type: "toolCall", id: "c4", name: "Write", arguments: { file_path: "d.md" } }] },
      { role: "assistant", content: [{ type: "toolCall", id: "c5", name: "write", arguments: { filePath: "e.md" } }] },
    ])).toEqual(["a.md", "d.md", "e.md"]);
  });
});

describe("writeTargetPathOf — the probe order the ??= assignment encodes", () => {
  it("a non-string winner FAILS instead of deferring to a later string key", () => {
    // `path` holds a non-nullish non-string: it wins the probe at key 1, and
    // the string test rejects it — the later `file_path` string is never
    // consulted. A defer here would silently redirect the write target the
    // guard verifies onto a path the tool did not name.
    expect(writeTargetPathOf({ path: 42, file_path: "real.md" })).toBeNull();
  });

  it("a nullish winner DEFERS to the later key, and the FIRST non-nullish string wins", () => {
    // null and undefined are the only deferring values: `null` at `path`
    // leaves the probe open, so `file_path` proves the target; a later key
    // cannot displace an earlier non-nullish one.
    expect(writeTargetPathOf({ path: null, file_path: "real.md" })).toBe("real.md");
    expect(writeTargetPathOf({ file_path: "real.md", filePath: "shadow.md" })).toBe("real.md");
  });
});
