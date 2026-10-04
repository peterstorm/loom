import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseWaveFrozenSource,
  reviewedWorkspaceHeadSha,
  reviewedWorkspaceObservation,
  waveFrozenSource,
} from "../../src/core/reviewed-workspace";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("reviewedWorkspaceHeadSha", () => {
  it("keeps the persisted file and absent encodings byte-identical", () => {
    const bytes = Buffer.from("export const a = 1;\n");
    expect(reviewedWorkspaceHeadSha(["src/a.ts", "src/gone.ts"], [
      { path: "src/gone.ts", bytes: null },
      { path: "src/a.ts", bytes },
    ])).toBe(sha256(JSON.stringify([["src/a.ts", bytes.toString("base64")], ["src/gone.ts", null]])));
  });

  it("covers a scoped directory with the leaf files below it, encoded exactly like files", () => {
    const a = Buffer.from("export const a = 1;\n");
    const b = Buffer.from("export const b = 2;\n");
    expect(reviewedWorkspaceHeadSha(["calibration/run"], [
      { path: "calibration/run/nested/b.ts", bytes: b },
      { path: "calibration/run/a.ts", bytes: a },
    ])).toBe(sha256(JSON.stringify([
      ["calibration/run/a.ts", a.toString("base64")],
      ["calibration/run/nested/b.ts", b.toString("base64")],
    ])));
  });

  it("refuses a leaf outside every scoped path and a scoped path with no artifact", () => {
    expect(() => reviewedWorkspaceHeadSha(["calibration/run"], [
      { path: "calibration/run-other/a.ts", bytes: Buffer.from("x") },
    ])).toThrow("out-of-scope artifact calibration/run-other/a.ts");
    expect(() => reviewedWorkspaceHeadSha(["calibration/run", "src.ts"], [
      { path: "calibration/run/a.ts", bytes: Buffer.from("x") },
    ])).toThrow("omitted declared artifact src.ts");
  });

  it("freezes a directory's leaves as individually readable source files", () => {
    const observation = reviewedWorkspaceObservation("T13", ["calibration/run", "calibration/run/a.ts"], [
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
