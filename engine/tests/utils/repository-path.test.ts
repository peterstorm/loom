import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { partitionWriteEvidence } from "../../src/utils/repository-path";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("partitionWriteEvidence", () => {
  it("separates an absolute scratchpad write from repository writes", () => {
    const root = tempDir("loom-partition-root-");
    const scratch = tempDir("loom-partition-scratch-");
    const evidence = partitionWriteEvidence(root, [
      join(root, "src", "a.ts"),
      "src/b.ts",
      join(scratch, "tsconfig.json"),
      join(scratch, "not-yet", "created.ts"),
    ]);
    expect(evidence.repository).toEqual([join(root, "src", "a.ts"), "src/b.ts"]);
    expect(evidence.external).toEqual([join(scratch, "tsconfig.json"), join(scratch, "not-yet", "created.ts")]);
  });

  it("keeps relative escapes as repository evidence so the strict parser rejects them", () => {
    const root = tempDir("loom-partition-relative-");
    expect(partitionWriteEvidence(root, ["../escape.ts"])).toEqual({ repository: ["../escape.ts"], external: [] });
  });

  it("keeps an absolute path through a symlinked alias of the repository as repository evidence", () => {
    const root = tempDir("loom-partition-aliased-");
    const aliasParent = tempDir("loom-partition-alias-");
    mkdirSync(join(root, "src"));
    symlinkSync(root, join(aliasParent, "repo"));
    const aliased = join(aliasParent, "repo", "src", "new.ts");
    expect(partitionWriteEvidence(root, [aliased])).toEqual({ repository: [aliased], external: [] });
  });
});
