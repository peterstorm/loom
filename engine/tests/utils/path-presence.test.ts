import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observePathPresence } from "../../src/utils/path-presence";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "loom-path-presence-"));
  dirs.push(dir);
  return dir;
};

describe("observePathPresence — only ENOENT proves absence", () => {
  it("reports a missing path as absent and an existing one as present", () => {
    const dir = scratch();
    writeFileSync(join(dir, "here.json"), "{}");
    expect(observePathPresence(join(dir, "missing.json"))).toEqual({ kind: "absent" });
    expect(observePathPresence(join(dir, "here.json"))).toEqual({ kind: "present" });
  });

  it("keeps an unobservable path unknown, with its cause, instead of absent", () => {
    // existsSync answers false here; a symlink loop is present, not missing.
    const dir = scratch();
    symlinkSync("loop", join(dir, "loop"));
    expect(observePathPresence(join(dir, "loop"))).toEqual({ kind: "unknown", cause: expect.stringContaining("ELOOP") });
  });
});
