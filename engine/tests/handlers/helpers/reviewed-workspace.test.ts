import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { spawnSync } from "node:child_process";
import { observeReviewedWorkspace } from "../../../src/handlers/helpers/reviewed-workspace";
import { parseWaveFrozenSource, waveFrozenSource } from "../../../src/core/wave-frozen-source";
import { observedWorkspace } from "../../fixtures/reviewed-workspace";
import { taskFixture } from "../../fixtures/task-lifecycle";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(root: string, args: readonly string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}

describe("reviewed workspace shell observation", () => {
  it("captures exact dirty, untracked, binary, and deleted declared bytes without consulting Git HEAD", () => {
    const root = canonicalTempDir("loom-reviewed-workspace-");
    roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "tracked.ts"), "export const value = 'committed';\n");
    writeFileSync(join(root, "src", "deleted.ts"), "export const deleted = true;\n");
    git(root, ["init", "-q"]);
    git(root, ["add", "src/tracked.ts", "src/deleted.ts"]);
    git(root, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture"]);

    const dirty = "export const value = 'dirty workspace';\n";
    const untracked = "export const added = 'untracked';\n";
    const binary = Uint8Array.from([0xff, 0x00, 0x61]);
    writeFileSync(join(root, "src", "tracked.ts"), dirty);
    writeFileSync(join(root, "src", "untracked.ts"), untracked);
    writeFileSync(join(root, "src", "binary.bin"), binary);
    unlinkSync(join(root, "src", "deleted.ts"));

    const task = taskFixture({
      id: "T1", description: "snapshot", agent: "code-implementer-agent", wave: 1,
      status: "implemented", depends_on: [],
      file_list: ["src/tracked.ts", "src/deleted.ts", "src/binary.bin"],
      files_modified: ["src/untracked.ts"],
    });
    const [observed] = observeReviewedWorkspace([task], root);
    expect(observed!.scope).toEqual([
      "src/binary.bin", "src/deleted.ts", "src/tracked.ts", "src/untracked.ts",
    ]);
    expect(observed!.headSha).toBe(observedWorkspace("T1", observed!.scope, observed!.artifacts).headSha);

    const source = waveFrozenSource(observed!);
    expect(parseWaveFrozenSource(source)).toEqual({ ok: true, value: source });
    expect(source.files).toEqual([
      expect.objectContaining({ path: "src/binary.bin", kind: "binary", contentBase64: Buffer.from(binary).toString("base64") }),
      { path: "src/deleted.ts", kind: "absent", digest: null, byteLength: 0 },
      expect.objectContaining({ path: "src/tracked.ts", kind: "text", content: dirty }),
      expect.objectContaining({ path: "src/untracked.ts", kind: "text", content: untracked }),
    ]);
  });

  it("property: every byte sequence round-trips through the versioned source representation", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 4096 }), (bytes) => {
      const snapshot = observedWorkspace("T1", ["artifact"], [{ path: "artifact", bytes }]);
      const source = waveFrozenSource(snapshot);
      const parsed = parseWaveFrozenSource(JSON.parse(JSON.stringify(source)));
      expect(parsed).toEqual({ ok: true, value: source });
      const file = source.files[0]!;
      if (file.kind === "absent") throw new Error("present bytes cannot become absent");
      const restored = file.kind === "text" ? Buffer.from(file.content, "utf8") : Buffer.from(file.contentBase64, "base64");
      expect(restored).toEqual(Buffer.from(bytes));
    }), { seed: 9021, numRuns: 100 });
  });

  it("owns copied bytes so later buffer mutation cannot rewrite an issued snapshot", () => {
    const root = canonicalTempDir("loom-reviewed-workspace-copy-");
    roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "first");
    const task = taskFixture({ id: "T1", description: "snapshot", agent: "code-implementer-agent", wave: 1,
      status: "implemented", depends_on: [], file_list: ["src/a.ts"], files_modified: ["src/a.ts"] });
    const [before] = observeReviewedWorkspace([task], root);
    writeFileSync(join(root, "src", "a.ts"), "second");
    const [after] = observeReviewedWorkspace([task], root);
    expect(after!.headSha).not.toBe(before!.headSha);
    expect(waveFrozenSource(before!).files[0]).toMatchObject({ kind: "text", content: "first" });
    expect(waveFrozenSource(after!).files[0]).toMatchObject({ kind: "text", content: "second" });
  });
});
