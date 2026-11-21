import { afterEach, describe, expect, it } from "vitest";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  publishStagedRunFile,
  writeRunFileExclusiveNoFollow,
  writeRunFileNoFollow,
} from "../../src/utils/no-follow-fs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Symlink-attack coverage for the WRITE and PUBLISH primitives of `no-follow-fs`
 * (the read and remove side is in no-follow-fs.test.ts).
 *
 * Run roots are the REAL temp path: production resolves the run BASE once
 * (`ensureResolvedBaseDirectory`) so the strict no-symlink rule
 * applies BELOW it, not to the operator's own path to it — on macOS `tmpdir()`
 * sits behind the system `/var` → `/private/var` symlink. On Linux this is an
 * identity.
 */
describe("no-follow run-file writes", () => {
  it("refuses a symlink swapped in at the target", () => {
    const runDir = canonicalTempDir("loom-panel-write-");
    roots.push(runDir);
    const outside = join(runDir, "outside.txt");
    const target = join(runDir, "brief.md");
    writeFileSync(outside, "outside remains unchanged");

    symlinkSync(outside, target);

    expect(() => writeRunFileNoFollow(target, "panel bytes")).toThrow();
    expect(() => writeRunFileExclusiveNoFollow(target, "authority bytes")).toThrow();
    expect(readFileSync(outside, "utf-8")).toBe("outside remains unchanged");
  });

  it("refuses a parent directory swapped to a symlink", () => {
    const runDir = canonicalTempDir("loom-panel-parent-write-");
    roots.push(runDir);
    const outside = join(runDir, "outside");
    const verdicts = join(runDir, "verdicts");
    mkdirSync(outside);

    mkdirSync(verdicts);
    rmSync(verdicts, { recursive: true });
    symlinkSync(outside, verdicts);

    expect(() => writeRunFileNoFollow(join(verdicts, "verdict-1.json"), "panel bytes")).toThrow();
    expect(() => writeRunFileExclusiveNoFollow(join(verdicts, "result.json"), "authority bytes")).toThrow();
    expect(() => readFileSync(join(outside, "verdict-1.json"), "utf-8")).toThrow();
    expect(() => readFileSync(join(outside, "result.json"), "utf-8")).toThrow();
  });

  it("publishes a staged authority file without following a raced final symlink", () => {
    const runDir = canonicalTempDir("loom-panel-publish-");
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
