import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { observeReviewedWorkspace } from "../../../src/handlers/helpers/reviewed-workspace";
import { taskFixture } from "../../fixtures/task-lifecycle";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repository(): string {
  const root = canonicalTempDir("loom-reviewed-workspace-");
  roots.push(root);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  mkdirSync(join(root, "calibration", "run"), { recursive: true });
  writeFileSync(join(root, "calibration", "run", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "src.ts"), "export const s = 1;\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["-c", "user.name=Loom Test", "-c", "user.email=loom@example.test", "commit", "--quiet", "-m", "seed"], { cwd: root });
  return root;
}

const task = (fileList: string[]) => taskFixture({
  id: "T13", description: "observe", agent: "code-implementer-agent", wave: 1,
  status: "implemented", depends_on: [], file_list: fileList,
});

describe("observeReviewedWorkspace", () => {
  it("observes a declared directory artifact and tracks changes to its leaves", () => {
    // Production regression: the Wave Gate threw "reviewed artifact must be a
    // regular file" while building review requests for a directory artifact.
    const root = repository();
    const [before] = observeReviewedWorkspace([task(["calibration/run", "src.ts"])], root);
    expect(before?.scope).toEqual(["calibration/run", "src.ts"]);
    writeFileSync(join(root, "calibration", "run", "new.ts"), "export const n = 1;\n");
    const [after] = observeReviewedWorkspace([task(["calibration/run", "src.ts"])], root);
    expect(after?.headSha).not.toBe(before?.headSha);
  });

  it("refuses a declared path that is neither a file nor a directory", () => {
    const root = repository();
    symlinkSync("src.ts", join(root, "alias.ts"));
    expect(() => observeReviewedWorkspace([task(["alias.ts"])], root)).toThrow("must not traverse a symlink");
  });
});
