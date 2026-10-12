import { spawn } from "node:child_process";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureLoomRuntimeIdentity,
  PI_EXTENSION_RUNTIME_REVISION_ENV,
  PI_EXTENSION_RUNTIME_ROOT_ENV,
} from "../../../src/runtime-compatibility";
import { fixturePiEnvironment } from "../../fixtures/pi-session";
import { activeWaveGateFixture, graphFixture, taskFixture } from "../../fixtures/task-lifecycle";
import { currentOrchestrationStatus } from "../../../src/handlers/helpers/orchestration";
import { openRunDirectory } from "../../../src/orchestration/run-directory-handle";
import type { LoomStatus } from "../../../src/types";

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
  const root = canonicalTempDir("loom-abandon-stamp-");
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

  // Issue #50 Gap 2: a marker without a state stamp (a run abandoned before the
  // stamp existed, or one whose stamp failed) used to read as a live run that
  // status told the operator to resume, which the engine then refused.
  it("reads an unstamped legacy marker and points status at the stamping replay, not a resume", async () => {
    const root = project(null);
    const runsRoot = join(root, ".claude", "reviews", "wave-gate-runs");
    const runId = "run.legacy-unstamped";
    mkdirSync(join(runsRoot, runId), { recursive: true });
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    writeFileSync(statePath, JSON.stringify({
      ...graphFixture([taskFixture({
        id: "T1", description: "T1", agent: "code-implementer-agent", wave: 1, depends_on: [], file_list: ["src/T1.ts"],
      })]),
      active_wave_gate: activeWaveGateFixture({ runId, wave: 1, authorityDigest: "d".repeat(64), runsRoot }),
    }));
    const opened = openRunDirectory(runsRoot, join(runsRoot, runId));
    if (!opened.ok) throw new Error(opened.error.message);
    const marked = await opened.value.abandonRun({ supersededBy: null, reason: "legacy exhaustion" });
    expect(marked.ok).toBe(true);

    const status = JSON.parse(await currentOrchestrationStatus(["--json"], statePath)) as LoomStatus;

    expect(status.next.reasons[0]?.message).toBe(
      `Wave Gate run ${runId} was abandoned in its Run Directory (${join(runsRoot, runId)}), ` +
        "but its protected registration was never tombstoned, so it cannot be resumed; repeat the identical " +
        `abandon to stamp it: helper orchestration abandon --runs-root ${runsRoot} --run ${runId} ` +
        '--reason "legacy exhaustion"',
    );
    expect(JSON.stringify(status)).not.toContain("resume-orchestration");
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
