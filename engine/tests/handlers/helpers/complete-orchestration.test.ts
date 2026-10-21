/**
 * `helper complete-orchestration` through the real CLI: a finished graph is
 * archived byte-for-byte beside the live path and the live graph removed, so
 * the guards keyed on it lift; an unfinished graph is left exactly in place.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { completedGraphArchiveLeaf } from "../../../src/core/orchestration-completion";
import { completeOrchestration } from "../../../src/handlers/helpers/complete-orchestration";
import { activeWaveGateFixture, graphFixture, taskFixture } from "../../fixtures/task-lifecycle";

const CLI_PATH = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));

const task = (id: string, status: "implemented" | "completed") =>
  taskFixture({ id, description: id, wave: 1, depends_on: [], agent: "code-implementer-agent", status });

describe("complete-orchestration helper", () => {
  let repo: string;
  let stateDir: string;
  let statePath: string;

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "loom-complete-")));
    stateDir = join(repo, ".claude", "state");
    mkdirSync(stateDir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    statePath = join(stateDir, "active_task_graph.json");
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  function install(graph: unknown): string {
    const bytes = JSON.stringify(graph, null, 2);
    writeFileSync(statePath, bytes);
    chmodSync(statePath, 0o444);
    return bytes;
  }

  function run(): { exitCode: number; stderr: string } {
    try {
      execFileSync("bun", [CLI_PATH, "helper", "complete-orchestration"], {
        cwd: repo,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
      });
      return { exitCode: 0, stderr: "" };
    } catch (error) {
      const failed = error as { status: number; stderr: string };
      return { exitCode: failed.status, stderr: failed.stderr ?? "" };
    }
  }

  const archives = () => readdirSync(stateDir).filter((name) => name.startsWith("completed_task_graph-"));

  it("archives a finished graph byte-for-byte and removes the live graph", () => {
    const bytes = install({ ...graphFixture([task("T1", "completed"), task("T2", "completed")]), github_issue: 123 });

    expect(run().exitCode).toBe(0);

    expect(existsSync(statePath)).toBe(false);
    const [archive, ...others] = archives();
    expect(others).toEqual([]);
    expect(archive).toMatch(/^completed_task_graph-issue-123-\d{8}T\d{6}Z\.json$/);
    expect(readFileSync(join(stateDir, archive!), "utf-8")).toBe(bytes);
  });

  it("refuses an unfinished graph, naming why, and leaves it untouched", () => {
    const bytes = install(graphFixture([task("T1", "completed"), task("T2", "implemented")]));

    const { exitCode, stderr } = run();

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Task T2 is implemented, not completed");
    expect(stderr).toContain("helper cleanup-state");
    expect(readFileSync(statePath, "utf-8")).toBe(bytes);
    expect(archives()).toEqual([]);
  });

  it("refuses while a Wave Gate run is active, naming the run", () => {
    const bytes = install({
      ...graphFixture([task("T1", "completed")]),
      active_wave_gate: activeWaveGateFixture({ runId: "wg-live", wave: 1, authorityDigest: "a".repeat(64) }),
    });

    const { exitCode, stderr } = run();

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Wave Gate run wg-live is still registered as active");
    expect(readFileSync(statePath, "utf-8")).toBe(bytes);
    expect(archives()).toEqual([]);
  });

  it("never overwrites an existing archive: the live graph and the old archive both survive", async () => {
    const nowMs = Date.UTC(2026, 9, 21, 9, 2, 7);
    const graph = { ...graphFixture([task("T1", "completed")]), github_issue: 7 };
    const bytes = install(graph);
    const leaf = completedGraphArchiveLeaf(graph, nowMs);
    writeFileSync(join(stateDir, leaf), "earlier archive\n");

    await expect(completeOrchestration(statePath, nowMs)).rejects.toThrow();

    expect(readFileSync(statePath, "utf-8")).toBe(bytes);
    expect(readFileSync(join(stateDir, leaf), "utf-8")).toBe("earlier archive\n");
  });

  it("reports when there is no active graph", () => {
    const { exitCode, stderr } = run();
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("No active task graph");
  });
});
