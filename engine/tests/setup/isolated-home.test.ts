/**
 * Pins the per-run isolated home (`isolated-home.ts`): no worker and no child
 * it spawns can resolve the developer's home, so the Pi agent directory every
 * routing read starts from is the run's own, empty one.
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { PI_AGENT_DIRECTORY_VARIABLE, resolvePiAgentDirectory } from "../../src/core/pi-agent-directory";
import { runTempRoot } from "../fixtures/run-temp-root";

describe("per-run isolated home", () => {
  it("is this worker's homedir(), inside the run's temp root", () => {
    expect(homedir()).toBe(join(runTempRoot(), "home"));
    expect(homedir().startsWith(runTempRoot() + sep)).toBe(true);
  });

  it("is the homedir() of a spawned child, which inherits the environment", () => {
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(require('node:os').homedir())"], { encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe(homedir());
  });

  it("leaves no ambient Pi agent directory, so Pi's default resolves under the isolated home", () => {
    expect(process.env[PI_AGENT_DIRECTORY_VARIABLE]).toBeUndefined();
    expect(resolvePiAgentDirectory(process.env, homedir())).toBe(join(homedir(), ".pi", "agent"));
  });
});
