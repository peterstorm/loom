import { afterEach, describe, expect, it } from "vitest";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareWriteTargets,
  publishStagedRunFile,
  writeRunFileExclusiveNoFollow,
  writeRunFileNoFollow,
} from "../../../src/handlers/helpers/panel-run";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("panel run no-follow writes", () => {
  it("refuses a symlink swapped in after target preparation", () => {
    const runDir = mkdtempSync(join(tmpdir(), "loom-panel-write-"));
    roots.push(runDir);
    const outside = join(runDir, "outside.txt");
    const target = join(runDir, "brief.md");
    writeFileSync(outside, "outside remains unchanged");

    expect(prepareWriteTargets(runDir, [], ["brief.md"])).toEqual({ ok: true, value: undefined });
    symlinkSync(outside, target);

    expect(() => writeRunFileNoFollow(target, "panel bytes")).toThrow();
    expect(() => writeRunFileExclusiveNoFollow(target, "authority bytes")).toThrow();
    expect(readFileSync(outside, "utf-8")).toBe("outside remains unchanged");
  });

  it("publishes a staged authority file without following a raced final symlink", () => {
    const runDir = mkdtempSync(join(tmpdir(), "loom-panel-publish-"));
    roots.push(runDir);
    const outside = join(runDir, "outside.txt");
    const staged = join(runDir, ".result.pending.json");
    const final = join(runDir, "result.json");
    writeFileSync(outside, "outside remains unchanged");
    writeRunFileExclusiveNoFollow(staged, "result bytes");
    symlinkSync(outside, final);

    publishStagedRunFile(staged, final);

    expect(readFileSync(outside, "utf-8")).toBe("outside remains unchanged");
    expect(lstatSync(final).isSymbolicLink()).toBe(false);
    expect(readFileSync(final, "utf-8")).toBe("result bytes");
  });
});
