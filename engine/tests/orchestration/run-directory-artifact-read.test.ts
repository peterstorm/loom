import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunDirectory, type RunDirHandle } from "../../src/orchestration/run-directory-handle";

const cleanup: string[] = [];

function freshHandle(): RunDirHandle {
  const runsRoot = mkdtempSync(join(tmpdir(), "loom-artifact-read-"));
  cleanup.push(runsRoot);
  const created = createRunDirectory(runsRoot, "run.artifact-read");
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("RunDirHandle.readArtifactBytes", () => {
  it("returns null only when the parsed artifact slot is absent", () => {
    expect(freshHandle().readArtifactBytes("completion/result.json")).toEqual({ ok: true, value: null });
  });

  it("reads published artifact bytes exactly", async () => {
    const handle = freshHandle();
    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 255]);
    const published = await handle.publishArtifactSet([{
      relativePath: "completion/result.bin",
      bytes: [...bytes],
    }]);
    expect(published.ok).toBe(true);

    const read = handle.readArtifactBytes("completion/result.bin");

    expect(read.ok).toBe(true);
    if (!read.ok || read.value === null) return;
    expect([...read.value]).toEqual([...bytes]);
  });

  it.each([
    ["an absolute path", "/tmp/result.json"],
    ["traversal", "../result.json"],
    ["a dot component", "completion/./result.json"],
    ["an empty component", "completion//result.json"],
    ["a non-string", { path: "completion/result.json" }],
  ])("refuses malformed artifact-relative input: %s", (_label, relativePath) => {
    const read = freshHandle().readArtifactBytes(relativePath);

    expect(read).toMatchObject({
      ok: false,
      error: { kind: "invalid-run-directory", field: "artifacts" },
    });
  });

  it("refuses a symlink occupying an artifact slot", () => {
    const handle = freshHandle();
    const outside = join(handle.runDirectory, "outside.json");
    writeFileSync(outside, "outside");
    symlinkSync(outside, join(handle.runDirectory, "artifacts", "result.json"));

    const read = handle.readArtifactBytes("result.json");

    expect(read).toMatchObject({
      ok: false,
      error: {
        kind: "invalid-run-directory",
        field: "artifacts",
        message: expect.stringContaining("unreadable"),
      },
    });
  });

  it("refuses a directory occupying an artifact slot", () => {
    const handle = freshHandle();
    mkdirSync(join(handle.runDirectory, "artifacts", "result.json"));

    expect(handle.readArtifactBytes("result.json")).toMatchObject({
      ok: false,
      error: { kind: "invalid-run-directory", field: "artifacts" },
    });
  });
});
