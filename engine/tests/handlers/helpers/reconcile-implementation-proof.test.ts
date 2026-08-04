import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateTaskProof, PI_STRUCTURED_EVIDENCE_POLICY } from "../../../src/core/proof-obligations";
import {
  parseRecoveredBaselineSha,
  reconcileTaskFromStoredEvidence,
} from "../../../src/handlers/helpers/reconcile-implementation-proof";
import type { Task } from "../../../src/types";

const ENGINE = fileURLToPath(new URL("../../../", import.meta.url));
const CLI = join(ENGINE, "src", "cli.ts");
const cleanup: string[] = [];
afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const testResult = {
  verdict: "untrusted" as const,
  passed: true,
  label: "pi-structured: bun: 25 pass",
};

function failedTask(taskCompleted = true): Task {
  const proof = evaluateTaskProof(
    { newTestsRequired: true, declaredArtifacts: ["src/a.ts"] },
    {
      taskCompleted,
      testResult,
      filesModified: [],
      newTestsWritten: false,
      newTestEvidence: "",
    },
    PI_STRUCTURED_EVIDENCE_POLICY,
  );
  return {
    id: "T5",
    description: "implementation",
    agent: "code-implementer-agent",
    wave: 2,
    status: "pending",
    depends_on: [],
    file_list: ["src/a.ts"],
    files_modified: ["src/a.ts"],
    new_tests_required: true,
    new_tests_written: true,
    new_test_evidence: "1 new test method, 2 assertions",
    test_result: testResult,
    test_evidence: "bun: 25 pass",
    proof,
  };
}

describe("parseRecoveredBaselineSha", () => {
  it("accepts one exact Git SHA and rejects malformed or repeated overrides", () => {
    const sha = "a".repeat(40);
    expect(parseRecoveredBaselineSha(["--wave", "2", "--baseline-sha", sha])).toBe(sha);
    expect(parseRecoveredBaselineSha(["--wave", "2"])).toBeNull();
    expect(() => parseRecoveredBaselineSha(["--baseline-sha", "HEAD~1"]))
      .toThrow(/lowercase 40- or 64-character/);
    expect(() => parseRecoveredBaselineSha([
      "--baseline-sha", sha, "--baseline-sha", sha,
    ])).toThrow(/only once/);
  });
});

describe("historical baseline recovery CLI", () => {
  it("atomically replaces poisoned boundaries with an audited ancestor commit", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-proof-recovery-"));
    cleanup.push(root);
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "loom@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Loom Test"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "before wave 2"], { cwd: root });
    const historical = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
    mkdirSync(join(root, "src"));
    const implemented = "export const implemented = true;\n";
    writeFileSync(join(root, "src", "a.ts"), implemented);
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "wave 2 implementation"], { cwd: root });
    const poisonedStart = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).trim();
    const proof = evaluateTaskProof(
      { newTestsRequired: false, declaredArtifacts: ["src/a.ts"] },
      { taskCompleted: true, filesModified: [] },
    );
    const statePath = join(root, ".claude", "state", "active_task_graph.json");
    mkdirSync(join(root, ".claude", "state"), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      current_phase: "execute", phase_artifacts: {}, skipped_phases: [],
      spec_file: null, plan_file: null, current_wave: 2, executing_tasks: [],
      wave_gates: {
        "2": { impl_complete: true, tests_passed: true, reviews_complete: false, blocked: false },
      },
      tasks: [{
        id: "T5", description: "implementation", agent: "code-implementer-agent",
        wave: 2, status: "pending", depends_on: [], new_tests_required: false,
        file_list: ["src/a.ts"], files_modified: ["src/a.ts"], proof,
        start_sha: poisonedStart,
        artifact_baseline: [{
          artifact: "src/a.ts",
          snapshot: {
            kind: "sha256",
            digest: createHash("sha256").update(implemented).digest("hex"),
          },
        }],
      }],
    }, null, 2));

    const withoutOverride = spawnSync("bun", [CLI, "helper", "reconcile-implementation-proof", "--wave", "2"], {
      cwd: root, encoding: "utf-8", env: { ...process.env, LOOM_STATE_PATH: statePath },
    });
    expect(withoutOverride.status).not.toBe(0);

    const recovered = spawnSync("bun", [
      CLI, "helper", "reconcile-implementation-proof", "--wave", "2",
      "--baseline-sha", historical,
    ], {
      cwd: root, encoding: "utf-8", env: { ...process.env, LOOM_STATE_PATH: statePath },
    });
    expect(recovered.status, recovered.stderr).toBe(0);
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.tasks[0]).toMatchObject({
      status: "implemented",
      start_sha: historical,
      artifact_baseline_recovered_from: historical,
      proof: { state: "satisfied" },
      artifact_baseline: [{ artifact: "src/a.ts", snapshot: { kind: "missing" } }],
    });
    expect(state.wave_gates["2"].impl_complete).toBe(true);
  });
});

describe("reconcileTaskFromStoredEvidence", () => {
  it("repairs stale failed proof from persisted Pi evidence and byte-attributed artifacts", () => {
    const reconciled = reconcileTaskFromStoredEvidence(
      failedTask(),
      ["src/a.ts"],
      { written: false, evidence: "" },
    );

    expect(reconciled.status).toBe("implemented");
    expect(reconciled.proof?.state).toBe("satisfied");
    expect(reconciled.new_tests_written).toBe(true);
    if (reconciled.proof?.state === "satisfied") {
      expect(reconciled.proof.evidence.map((evidence) => evidence.kind)).toEqual([
        "task-completed",
        "regression-test-pass",
        "new-tests",
        "declared-artifact-changed",
      ]);
    }
  });

  it("never invents completion when the prior proof did not observe it", () => {
    const reconciled = reconcileTaskFromStoredEvidence(
      failedTask(false),
      ["src/a.ts"],
      { written: true, evidence: "1 new test method, 2 assertions" },
    );

    expect(reconciled.status).toBe("pending");
    expect(reconciled.proof?.state).toBe("failed");
    if (reconciled.proof?.state === "failed") {
      expect(reconciled.proof.failures.map((failure) => failure.kind)).toEqual(["task-not-completed"]);
    }
  });
});
