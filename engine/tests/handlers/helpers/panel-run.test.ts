import { afterEach, describe, expect, it } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

/**
 * Run roots are the REAL temp path: production resolves the run BASE once
 * (`realRunDir` / `ensureResolvedBaseDirectory`) so the strict no-symlink rule
 * applies BELOW it, not to the operator's own path to it — on macOS `tmpdir()`
 * sits behind the system `/var` → `/private/var` symlink. On Linux this is an
 * identity.
 */
describe("panel run no-follow writes", () => {
  it("refuses a symlink swapped in after target preparation", () => {
    const runDir = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-panel-write-")));
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

  it("refuses a parent directory swapped to a symlink after preparation", () => {
    const runDir = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-panel-parent-write-")));
    roots.push(runDir);
    const outside = join(runDir, "outside");
    const verdicts = join(runDir, "verdicts");
    mkdirSync(outside);

    expect(prepareWriteTargets(runDir, ["verdicts"], ["verdicts/verdict-1.json"]))
      .toEqual({ ok: true, value: undefined });
    rmSync(verdicts, { recursive: true });
    symlinkSync(outside, verdicts);

    expect(() => writeRunFileNoFollow(join(verdicts, "verdict-1.json"), "panel bytes")).toThrow();
    expect(() => writeRunFileExclusiveNoFollow(join(verdicts, "result.json"), "authority bytes")).toThrow();
    expect(() => readFileSync(join(outside, "verdict-1.json"), "utf-8")).toThrow();
    expect(() => readFileSync(join(outside, "result.json"), "utf-8")).toThrow();
  });

  it("publishes a staged authority file without following a raced final symlink", () => {
    const runDir = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-panel-publish-")));
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
