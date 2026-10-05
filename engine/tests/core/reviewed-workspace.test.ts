import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reviewedWorkspaceObservation } from "../../src/core/reviewed-workspace";
import { parseWaveFrozenSource, waveFrozenSource } from "../../src/core/wave-frozen-source";
import { observedWorkspace } from "../fixtures/reviewed-workspace";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("reviewedWorkspaceObservation", () => {
  it("keeps the persisted file and absent encodings byte-identical", () => {
    const bytes = Buffer.from("export const a = 1;\n");
    expect(observedWorkspace("T1", ["src/a.ts", "src/gone.ts"], [
      { path: "src/gone.ts", bytes: null },
      { path: "src/a.ts", bytes },
    ]).headSha).toBe(sha256(JSON.stringify([["src/a.ts", bytes.toString("base64")], ["src/gone.ts", null]])));
  });

  it("covers a scoped directory with the leaf files below it, encoded exactly like files", () => {
    const a = Buffer.from("export const a = 1;\n");
    const b = Buffer.from("export const b = 2;\n");
    expect(observedWorkspace("T1", ["calibration/run"], [
      { path: "calibration/run/nested/b.ts", bytes: b },
      { path: "calibration/run/a.ts", bytes: a },
    ]).headSha).toBe(sha256(JSON.stringify([
      ["calibration/run/a.ts", a.toString("base64")],
      ["calibration/run/nested/b.ts", b.toString("base64")],
    ])));
  });

  it("refuses, as a value, a leaf outside every scoped path and a scoped path with no artifact", () => {
    expect(reviewedWorkspaceObservation("T1", ["calibration/run"], [
      { path: "calibration/run-other/a.ts", bytes: Buffer.from("x") },
    ])).toEqual({ ok: false, error: "reviewed workspace contains out-of-scope artifact calibration/run-other/a.ts" });
    expect(reviewedWorkspaceObservation("T1", ["calibration/run", "src.ts"], [
      { path: "calibration/run/a.ts", bytes: Buffer.from("x") },
    ])).toEqual({ ok: false, error: "reviewed workspace snapshot omitted declared artifact src.ts" });
  });

  it.each([
    ["a trailing-slash directory scope", ["calibration/run/"], "calibration/run/a.ts"],
    ["a dot-segment scope", ["./calibration/run"], "calibration/run/a.ts"],
    ["an absolute artifact", ["calibration/run"], "/calibration/run/a.ts"],
    ["a traversal artifact", ["calibration/run"], "calibration/run/../a.ts"],
  ])("refuses %s as non-canonical instead of reporting an omitted artifact", (_name, scope, path) => {
    const observed = reviewedWorkspaceObservation("T1", scope, [{ path, bytes: Buffer.from("x") }]);
    expect(observed.ok).toBe(false);
    if (observed.ok) return;
    expect(observed.error).not.toContain("omitted declared artifact");
    expect(observed.error).toMatch(/reviewed workspace (scope|artifact) path must/);
  });

  it("owns its bytes: mutating the observed buffer cannot rewrite the observation", () => {
    const bytes = Buffer.from("first");
    const observed = observedWorkspace("T1", ["a.ts"], [{ path: "a.ts", bytes }]);
    bytes.write("xxxxx");
    expect(Buffer.from(observed.artifacts[0]!.bytes!).toString()).toBe("first");
    expect(Object.isFrozen(observed.artifacts[0]!.bytes)).toBe(true);
  });

  it("freezes a directory's leaves as individually readable source files", () => {
    const observation = observedWorkspace("T13", ["calibration/run", "calibration/run/a.ts"], [
      { path: "calibration/run/a.ts", bytes: Buffer.from("a\n") },
      { path: "calibration/run/gone.ts", bytes: null },
    ]);
    const source = waveFrozenSource(observation);
    expect(source.files.map(({ path, kind }) => [path, kind])).toEqual([
      ["calibration/run/a.ts", "text"],
      ["calibration/run/gone.ts", "absent"],
    ]);
    expect(parseWaveFrozenSource(JSON.parse(JSON.stringify(source)))).toEqual({ ok: true, value: source });
  });
});
