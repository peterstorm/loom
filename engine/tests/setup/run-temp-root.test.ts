/**
 * Pins the per-run temp root (`run-temp-root.ts`): workers and the children
 * they spawn resolve `tmpdir()` inside it, the Pi route setup that runs after
 * it lands inside it too, and its teardown removes a root that a
 * permission-failure fixture left read-only.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { fixturePiAgentDirectory } from "../fixtures/fixture-pi-agent-directory";
import { runTempRoot } from "../fixtures/run-temp-root";
import { removeRunTempRoot } from "./run-temp-root";

const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe("per-run temp root", () => {
  it("is this worker's tmpdir()", () => {
    expect(tmpdir()).toBe(runTempRoot());
    expect(existsSync(runTempRoot())).toBe(true);
  });

  it("is the tmpdir() of a spawned child, which inherits the environment", () => {
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(require('node:os').tmpdir())"], { encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe(runTempRoot());
  });

  it("holds the fixture Pi agent directory, whose setup runs after it", () => {
    expect(fixturePiAgentDirectory().startsWith(runTempRoot() + sep)).toBe(true);
  });

  it.skipIf(runningAsRoot)("teardown removes a root holding a read-only directory", () => {
    const root = mkdtempSync(join(tmpdir(), "teardown-"));
    const locked = join(root, "locked");
    mkdirSync(join(locked, "inner"), { recursive: true });
    writeFileSync(join(locked, "inner", "file.txt"), "x");
    chmodSync(join(locked, "inner"), 0o500);
    chmodSync(locked, 0o500);

    removeRunTempRoot(root);

    expect(existsSync(root)).toBe(false);
  });
});
