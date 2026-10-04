import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reviewedWorkspaceHeadSha } from "../../src/core/reviewed-workspace";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("reviewedWorkspaceHeadSha", () => {
  it("keeps the persisted file and absent encodings byte-identical", () => {
    const bytes = Buffer.from("export const a = 1;\n");
    expect(reviewedWorkspaceHeadSha(["src/a.ts", "src/gone.ts"], [
      { path: "src/gone.ts", bytes: null },
      { path: "src/a.ts", bytes },
    ])).toBe(sha256(JSON.stringify([["src/a.ts", bytes.toString("base64")], ["src/gone.ts", null]])));
  });

  it("identifies a directory artifact by its tree digest, distinct from any file", () => {
    const tree = "d".repeat(64);
    const asTree = reviewedWorkspaceHeadSha(["calibration/run"], [{ path: "calibration/run", tree }]);
    expect(asTree).toBe(sha256(JSON.stringify([["calibration/run", { tree }]])));
    expect(asTree).not.toBe(reviewedWorkspaceHeadSha(["calibration/run"], [{ path: "calibration/run", bytes: Buffer.from(tree) }]));
    expect(asTree).not.toBe(reviewedWorkspaceHeadSha(["calibration/run"], [{ path: "calibration/run", tree: "e".repeat(64) }]));
  });
});
