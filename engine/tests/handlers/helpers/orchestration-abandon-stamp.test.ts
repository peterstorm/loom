import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureLoomRuntimeIdentity,
  PI_EXTENSION_RUNTIME_REVISION_ENV,
  PI_EXTENSION_RUNTIME_ROOT_ENV,
} from "../../../src/runtime-compatibility";
import { fixturePiEnvironment } from "../../fixtures/pi-session";

/**
 * The shell-level abandonment stamp wrapper's two arms, driven through the
 * real CLI seam. The stamp-failed arm is the recovery contract for an
 * abandonment whose Run Directory marker landed but whose protected-state
 * stamp did not: the operator must be told to repeat the identical command,
 * never handed a bare error. The no-graph arm completes the abandonment when
 * no protected graph exists to stamp.
 */

const ENGINE = fileURLToPath(new URL("../../../", import.meta.url));
const CLI = join(ENGINE, "src", "cli.ts");
const PACKAGE_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CURRENT_RUNTIME = captureLoomRuntimeIdentity(PACKAGE_ROOT);
const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function runCli(args: readonly string[], cwd: string) {
  const env: NodeJS.ProcessEnv = { ...fixturePiEnvironment(cwd) };
  // The ambient session's runtime handshake must not leak into the spawned CLI:
  // it names the runtime the OUTER Pi process loaded, which is stale once this
  // checkout has changed (exactly the skew the CLI guard is designed to catch).
  // The test publishes its own checkout-consistent identity instead.
  delete env[PI_EXTENSION_RUNTIME_ROOT_ENV];
  delete env[PI_EXTENSION_RUNTIME_REVISION_ENV];
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  if (env.PI_CODING_AGENT === "true") {
    env[PI_EXTENSION_RUNTIME_ROOT_ENV] ??= CURRENT_RUNTIME.packageRoot;
    env[PI_EXTENSION_RUNTIME_REVISION_ENV] ??= CURRENT_RUNTIME.revision;
  }
  return new Promise<Readonly<{ status: number | null; stdout: string; stderr: string }>>((resolve, reject) => {
    const child = spawn("bun", [CLI, "helper", "orchestration", ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", (text: string) => { stderr += text; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end("");
  });
}

function project(stateFileBytes: string | null): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-abandon-stamp-")));
  cleanup.push(root);
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  if (stateFileBytes !== null) {
    writeFileSync(join(root, ".claude", "state", "active_task_graph.json"), stateFileBytes);
  }
  return root;
}

describe("abandonment state-stamp wrapper arms", () => {
  it("treats a missing protected graph as the no-graph arm and completes the abandonment", async () => {
    const root = project(null);
    const runsRoot = join(root, "runs");
    mkdirSync(join(runsRoot, "run.abandon-no-graph"), { recursive: true });

    const result = await runCli(
      ["abandon", "--runs-root", runsRoot, "--run", "run.abandon-no-graph", "--reason", "superseded by a fresh run"],
      root,
    );

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      kind: "run-abandoned",
      runId: "run.abandon-no-graph",
      supersededBy: null,
    });
  });

  it("returns the operator retry guidance when the protected stamp fails, not a bare error", async () => {
    const root = project("{broken");
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run.abandon-stamp-failed");
    mkdirSync(runDir, { recursive: true });

    const result = await runCli(
      ["abandon", "--runs-root", runsRoot, "--run", "run.abandon-stamp-failed", "--reason", "superseded by a fresh run"],
      root,
    );

    expect(result.status).not.toBe(0);
    // The marker landed and stays: evidence is durable even though the stamp
    // failed, which is exactly why the guidance is a repeat, not a rewrite.
    expect(existsSync(join(runDir, "abandoned.json"))).toBe(true);
    expect(result.stderr).toContain("run abandonment was recorded in the Run Directory");
    expect(result.stderr).toContain("repeat the identical abandon command to retry the state stamp");
  });
});
