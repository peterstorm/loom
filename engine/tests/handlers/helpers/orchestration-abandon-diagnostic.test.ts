import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { graphFixture, taskFixture } from "../../fixtures/task-lifecycle";

const cli = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("abandon stamp diagnostic", () => {
  it("reports a published marker without claiming it retired a different active Wave Gate", () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-abandon-mismatch-")));
    roots.push(root);
    const runsRoot = join(root, "runs");
    mkdirSync(join(runsRoot, "run.not-owner"), { recursive: true });
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    mkdirSync(join(root, ".claude", "state"), { recursive: true });
    const graph = {
      ...graphFixture([taskFixture({
        id: "T1", description: "pending", agent: "code-implementer-agent", wave: 1,
        depends_on: [], file_list: [], new_tests_required: false,
      })]),
      active_wave_gate: {
        schemaVersion: 1, kind: "active-wave-gate", runId: "run.active-owner",
        wave: 1, authorityDigest: "a".repeat(64), revision: 0,
        terminalOutcome: null, runsRoot,
      },
    };
    writeFileSync(statePath, JSON.stringify(graph));
    const before = readFileSync(statePath);

    const result = spawnSync("bun", [cli, "helper", "orchestration", "abandon",
      "--runs-root", runsRoot, "--run", "run.not-owner", "--reason", "superseded elsewhere"],
    { cwd: root, encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: "run-abandoned", runId: "run.not-owner" });
    expect(result.stderr).toContain("no protected Wave Gate registration was tombstoned (authority-mismatch)");
    expect(readFileSync(statePath)).toEqual(before);
  }, 30_000);
});
