/**
 * store-test-evidence trusted-verdict guard: the helper's stdin is
 * agent-controlled text. It may set an UNTRUSTED result on a task — it must
 * NEVER overwrite a trusted verdict the evidence ledger produced. Without
 * the guard, an agent could launder a ledger `trusted-fail` into
 * `{verdict: "untrusted", passed: true}`, which the wave gate accepts.
 *
 * Spawns the real CLI in a tmp git repo (same pattern as set-phase.test.ts)
 * so TASK_GRAPH_PATH resolution is exercised end to end.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { parseNewTestEvidence, type TaskGraph, type Task } from "../../../src/types";
import { pendingTaskProof } from "../../fixtures/task-lifecycle";

const CLI_PATH = join(__dirname, "../../../src/cli.ts");

function makeTmpDir(): string {
  // See set-phase.test.ts: mkdtempSync is the collision-free form.
  return mkdtempSync(join(tmpdir(), "loom-ste-"));
}

function graphWith(task: Partial<Task>): TaskGraph {
  return {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    tasks: [
      {
        id: "T1",
        description: "impl",
        agent: "code-implementer-agent",
        wave: 1,
        status: "pending",
        depends_on: [],
        ...task,
      } as Task,
    ],
    wave_gates: {},
  };
}

describe("store-test-evidence helper — trusted verdicts survive", () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    const stateDir = join(tmpDir, ".claude", "state");
    mkdirSync(stateDir, { recursive: true });
    execSync("git init", { cwd: tmpDir, stdio: "ignore" });
    statePath = join(stateDir, "active_task_graph.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function runHelper(stdin: string, taskId: string = "T1"): { exitCode: number; stderr: string } {
    const result = spawnSync("bun", [CLI_PATH, "helper", "store-test-evidence", "--task", taskId], {
      cwd: tmpDir,
      encoding: "utf-8",
      input: stdin,
    });
    return { exitCode: result.status ?? -1, stderr: result.stderr ?? "" };
  }

  function readState(): TaskGraph {
    return JSON.parse(readFileSync(statePath, "utf-8"));
  }

  it("a ledger trusted-fail survives an attempted untrusted-pass overwrite (with a stderr note)", () => {
    writeFileSync(
      statePath,
      JSON.stringify(
        graphWith({
          status: "implemented",
          test_result: { verdict: "trusted-fail" },
          test_evidence: "ledger: exit 1 (npm test)",
        }),
        null,
        2,
      ),
    );

    // The agent claims success via helper stdin — the classic laundering move.
    const { exitCode, stderr } = runHelper(
      "TEST_PASSED: true\nTEST_EVIDENCE: all 999 tests pass, honest\nNEW_TESTS_WRITTEN: true\n",
    );
    expect(exitCode).toBe(0);

    const task = readState().tasks[0];
    expect(task.test_result).toEqual({ verdict: "trusted-fail" }); // untouched
    expect(task.test_evidence).toBe("ledger: exit 1 (npm test)"); // untouched
    expect(task.new_test_observation).toBeUndefined(); // nothing else laundered in either
    expect(stderr).toContain("refusing to overwrite");
  });

  it("a trusted-pass verdict is equally protected", () => {
    writeFileSync(
      statePath,
      JSON.stringify(graphWith({ status: "implemented", test_result: { verdict: "trusted-pass" } }), null, 2),
    );

    const { exitCode } = runHelper("TEST_PASSED: false\nTEST_EVIDENCE: fabricated failure\n");
    expect(exitCode).toBe(0);

    const task = readState().tasks[0];
    expect(task.test_result).toEqual({ verdict: "trusted-pass" });
  });

  it("rejects helper stdin for a revalidation-required Task without changing any stored evidence", () => {
    const original = graphWith({
      status: "pending",
      revalidation_required: true,
      proof: pendingTaskProof(),
      test_result: { verdict: "trusted-pass" },
      test_evidence: "ledger: 42 tests / 0 failed",
      new_test_observation: parseNewTestEvidence(true, "4 new tests, 8 assertions"),
      files_modified: ["src/implementation.ts", "tests/implementation.test.ts"],
      failure_reason: "infrastructure-blocked: transcript unavailable",
    });
    const originalBytes = JSON.stringify(original, null, 2);
    writeFileSync(statePath, originalBytes);

    const { exitCode, stderr } = runHelper(
      "TEST_PASSED: false\nTEST_EVIDENCE: overwrite\nNEW_TESTS_WRITTEN: false\nNEW_TEST_EVIDENCE: overwrite\n",
    );

    expect(exitCode).toBe(1);
    expect(stderr).toContain("requires a re-spawned implementation Agent");
    expect(readState()).toEqual(original);
    expect(readFileSync(statePath, "utf8")).toBe(originalBytes);
  });

  it("stores labeled untrusted evidence without minting positive completion authority", () => {
    writeFileSync(statePath, JSON.stringify(graphWith({}), null, 2));

    const { exitCode } = runHelper(
      "TEST_PASSED: true\nTEST_EVIDENCE: 12 passing\nNEW_TESTS_WRITTEN: true\nNEW_TEST_EVIDENCE: 3 new tests\n",
    );
    expect(exitCode).toBe(0);

    const task = readState().tasks[0];
    expect(task.status).toBe("pending");
    expect(task.test_result).toEqual({
      verdict: "untrusted",
      passed: true,
      label: "helper-reported (store-test-evidence stdin)", provenance: "unverified",
    });
    expect(task.test_evidence).toBe("12 passing");
    expect(task.new_test_observation).toEqual({
      kind: "written",
      written: true,
      evidence: "3 new tests",
    });
  });

  it("a --task matching no task is an ERROR, not a silent success", () => {
    const original = JSON.stringify(graphWith({}), null, 2);
    writeFileSync(statePath, original);

    const { exitCode, stderr } = runHelper("TEST_PASSED: true\nTEST_EVIDENCE: 12 passing\n", "T9");
    expect(exitCode).toBe(1);
    expect(stderr).toContain("no task T9");
    // …and nothing was stored anywhere.
    expect(readState().tasks[0].test_result).toBeUndefined();
  });

  it("an existing UNTRUSTED result may be overwritten (helper is the same trust tier)", () => {
    writeFileSync(
      statePath,
      JSON.stringify(
        graphWith({
          status: "implemented",
          test_result: { verdict: "untrusted", passed: false, label: "transcript-regex (fallback)", provenance: "unverified" },
        }),
        null,
        2,
      ),
    );

    const { exitCode } = runHelper("TEST_PASSED: true\nTEST_EVIDENCE: 5 passing\n");
    expect(exitCode).toBe(0);

    const task = readState().tasks[0];
    expect(task.test_result).toEqual({
      verdict: "untrusted",
      passed: true,
      label: "helper-reported (store-test-evidence stdin)", provenance: "unverified",
    });
  });
});
