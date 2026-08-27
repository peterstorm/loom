import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { checkImplementationProof, checkReviewedWorkspace } from "../../src/core/wave-gate-machine";
import { reviewedWorkspaceObservation } from "../../src/core/reviewed-workspace";
import {
  commitCompletedWaveReopening,
  deriveWaveReopeningProof,
  hasLaterWaveProgress,
  hasLaterWaveTaskProgress,
  reopenCompletedWave,
  type WaveReopeningProof,
} from "../../src/handlers/helpers/reopen-completed-wave";
import { parseNewTestEvidence, type Task, type TaskGraph } from "../../src/types";
import { evaluateTaskProof } from "../../src/core/proof-obligations";
import { applyUntrustedStopResolution } from "../../src/core/implementation-application";
import type { WaveReviewContextAuthority } from "../../src/handlers/helpers/programs/wave-gate";
import { taskFixture } from "../fixtures/task-lifecycle";

const proof = (() => {
  const evaluated = evaluateTaskProof({ newTestsRequired: false, declaredArtifacts: [] }, {
    taskCompleted: true, testResult: undefined, filesModified: [], newTestsWritten: false,
  });
  if (evaluated.state !== "satisfied") throw new Error("fixture proof must satisfy");
  return evaluated;
})();
const ENGINE = fileURLToPath(new URL("../../", import.meta.url));
const CLI = join(ENGINE, "src", "cli.ts");
const digest = "a".repeat(64);
const head = "b".repeat(64);
const receipt = { kind: "protected-wave-state-committed" as const, effectId: "wave-completion:12345678901234567890123456789012", runId: "wave-run", committedRevision: 1, stateDigest: digest };
const task = (id: string, wave: number, status: Task["status"] = "completed"): Task => taskFixture({
  id, description: id, agent: "code-implementer-agent", wave, status, depends_on: [], proof,
  new_tests_required: false, review_status: "passed", review_generation: 7, file_list: ["src/a.ts"],
  accepted_review_authority: { generation: 7, packet_id: digest, head_sha: head, scope: ["src/a.ts"], run_id: "wave-run", authority_digest: digest },
  critical_findings: [], advisory_findings: [],
});
const pendingTask = (id: string, wave: number): Task => taskFixture({
  id, description: id, agent: "code-implementer-agent", wave, status: "pending", depends_on: [],
});
const graph = (tasks: readonly Task[] = [task("T19", 3), task("T22", 3), pendingTask("T23", 4)]): TaskGraph => ({
  current_phase: "execute", current_wave: 4, phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: null,
  tasks, wave_gates: { "3": { impl_complete: true, tests_passed: true, reviews_complete: true, blocked: false } },
  wave_gate_history: [{ schemaVersion: 1, kind: "completed-wave-gate", runId: "wave-run", wave: 3, authorityDigest: digest, revision: 1, completionReceipt: receipt } as never],
});
const request = { runId: "wave-run", wave: 3, authorityDigest: digest, taskIds: ["T19", "T22"] };

function context(taskId: string, workspaceHeadSha?: string): WaveReviewContextAuthority {
  const taskRun = { taskId, generation: 7, packetId: digest, headSha: "legacy-batch-epoch".replace(/[^a-f0-9]/g, "a").padEnd(64, "a"), ...(workspaceHeadSha === undefined ? {} : { workspaceHeadSha }) };
  return {
    runId: "wave-run", wave: 3, authorityDigest: digest, batchEpoch: head,
    subject: { role: "code-reviewer", taskId }, taskRun,
    task: { id: taskId, description: taskId, agent: "code-implementer-agent", reviewGeneration: 7, planContext: null, specAnchors: [], specContributions: [], declaredFiles: ["src/a.ts"], modifiedFiles: [], proof, testResult: null, priorFindings: [] },
    specCheckScope: null, packetId: digest, specFile: null, planFile: null,
  } as WaveReviewContextAuthority;
}

const legacyProof: WaveReopeningProof = { mode: "legacy-workspace-authority-unverifiable", taskIds: ["T19", "T22"] };
const modernProof = (taskIds: readonly string[]): WaveReopeningProof => ({ mode: "modern-exact-workspace-drift", taskIds });

describe("reviewed workspace integrity", () => {
  it("fails closed after accepted evidence when current dirty/untracked declared bytes drift", () => {
    const changed = reviewedWorkspaceObservation("T22", ["src/a.ts"], [{ path: "src/a.ts", bytes: Buffer.from("dirty and untracked") }]);
    const result = checkReviewedWorkspace([task("T22", 3)], { loadPlanModels: () => ({ kind: "none" }), filePresence: () => ({ ok: true, exists: true }), reviewedWorkspace: () => [changed] });
    expect(result.passed).toBe(false);
    if (!result.passed) expect(result.reason).toContain("refresh review evidence");
  });

  it("accepts an unchanged declared scope", () => {
    const unchanged = { taskId: "T22", scope: ["src/a.ts"], headSha: head };
    expect(checkReviewedWorkspace([task("T22", 3)], { loadPlanModels: () => ({ kind: "none" }), filePresence: () => ({ ok: true, exists: true }), reviewedWorkspace: () => [unchanged] }).passed).toBe(true);
  });

  it("property: a byte mutation changes the snapshot authority", () => {
    fc.assert(fc.property(fc.uint8Array(), fc.integer({ min: 0, max: 255 }), (bytes, extra) => {
      const original = reviewedWorkspaceObservation("T", ["a.ts"], [{ path: "a.ts", bytes }]);
      const changed = reviewedWorkspaceObservation("T", ["a.ts"], [{ path: "a.ts", bytes: Uint8Array.from([...bytes, extra]) }]);
      expect(changed.headSha).not.toBe(original.headSha);
    }));
  });
});

describe("completed Wave reopening proof", () => {
  it("treats the realistic chatbot Wave 3 packets as legacy authority unverifiable and never observes their bytes", () => {
    const chatbotRequest = {
      runId: "wave-gate-w3-v2-20260822T185702Z", wave: 3,
      authorityDigest: "d211895cbd476d455f9005d1460428e607cf0d12e142b6d04575ca3b54bf07fc",
      taskIds: ["T19", "T22"],
    };
    const chatbotGraph = graph([
      { ...task("T19", 3), review_generation: 5 }, task("T22", 3), pendingTask("T23", 4),
    ]);
    const historicalContexts = [context("T19"), context("T22")].map((entry, index) => ({
      ...entry, runId: chatbotRequest.runId, authorityDigest: chatbotRequest.authorityDigest,
      taskRun: { ...entry.taskRun, generation: index === 0 ? 5 : 7, headSha: "ac87a789948bb24b38ee850284f847e612ef30e743770e6ccdd5ff632bcadc60" },
    })) as WaveReviewContextAuthority[];
    let observed = false;
    const derived = deriveWaveReopeningProof(chatbotGraph, chatbotRequest, historicalContexts, () => {
      observed = true;
      throw new Error("legacy batch epoch must never be compared with workspace bytes");
    });
    expect(derived).toEqual(legacyProof);
    expect(observed).toBe(false);
  });

  it("requires every completed Task for legacy/unverifiable authority and rejects the old partial recovery list", () => {
    const derived = deriveWaveReopeningProof(graph(), request, [context("T19"), context("T22")], () => []);
    expect(() => reopenCompletedWave(graph(), { ...request, taskIds: ["T22"] }, derived)).toThrow("legacy-workspace-authority-unverifiable");
    expect(reopenCompletedWave(graph(), request, derived).wave_reopening_history?.[0]).toMatchObject({
      kind: "completed-wave-reopened-for-review-integrity",
      proofMode: "legacy-workspace-authority-unverifiable",
      reopenedTaskIds: ["T19", "T22"],
    });
  });

  it("uses only workspaceHeadSha for modern exact-drift proof", () => {
    const derived = deriveWaveReopeningProof(graph(), request, [context("T19", head), context("T22", head)], (tasks) =>
      tasks.map((entry) => ({ taskId: entry.id, headSha: entry.id === "T22" ? digest : head })),
    );
    expect(derived).toEqual(modernProof(["T22"]));
    expect(() => reopenCompletedWave(graph(), request, derived)).toThrow("exactly equal");
    const reopened = reopenCompletedWave(graph(), { ...request, taskIds: ["T22"] }, derived);
    expect(reopened.wave_reopening_history?.[0]).toMatchObject({ proofMode: "modern-exact-workspace-drift", reopenedTaskIds: ["T22"] });
    expect(() => deriveWaveReopeningProof(graph(), request, [context("T19", head), context("T22", head)], () => [])).toThrow("could not be observed");
  });
});

describe("later-Wave progress refusal", () => {
  const progressMutations: readonly [(task: Task) => Task, string][] = [
    [(entry) => taskFixture({ ...entry, status: "implemented" }), "status"],
    [(entry) => ({ ...entry, reserved_at: "2026-08-22T00:00:00.000Z" }), "reservation"],
    [(entry) => ({ ...entry, start_sha: "a".repeat(40) }), "start SHA"],
    [(entry) => ({ ...entry, files_modified: [] }), "files"],
    [(entry) => taskFixture({ ...entry, status: "pending", proof, revalidation_required: true }), "proof"],
    [(entry) => ({ ...entry, test_result: { verdict: "trusted-pass" } }), "test result"],
    [(entry) => ({ ...entry, test_evidence: "ran" }), "test evidence"],
    [(entry) => ({ ...entry, new_test_observation: parseNewTestEvidence(false, "none") }), "new-test observation"],
    [(entry) => ({ ...entry, review_generation: 1 }), "review generation"],
    [(entry) => ({ ...entry, review_status: "passed" }), "review status"],
    [(entry) => ({ ...entry, review_run: {} as never }), "review run"],
    [(entry) => ({ ...entry, accepted_review_authority: {} as never }), "accepted authority"],
    [(entry) => ({ ...entry, review_error: "rejected" }), "review error"],
    [(entry) => ({ ...entry, review_evidence_failures: [] }), "review evidence failure"],
    [(entry) => ({ ...entry, findings: [{ id: "code-reviewer-1", agent: "code-reviewer", severity: "advisory", file: null, line: null, claim: "reviewed" }] }), "findings"],
    [(entry) => ({ ...entry, critical_findings: ["reviewed"] }), "critical findings"],
    [(entry) => ({ ...entry, advisory_findings: ["reviewed"] }), "advisory findings"],
    [(entry) => ({ ...entry, refuted_findings: [{}] as never }), "refuted findings"],
    [(entry) => ({ ...entry, resolved_findings: [{}] as never }), "resolved findings"],
    [(entry) => ({ ...entry, artifact_baseline: [] }), "artifact baseline"],
    [(entry) => ({ ...entry, attempt_artifact_baseline: [] }), "attempt baseline"],
    [(entry) => ({ ...entry, attempt_repository_baseline: [] }), "repository baseline"],
    [(entry) => ({ ...entry, issued_review_packets: [] }), "issued packet"],
    [(entry) => ({ ...entry, artifact_baseline_recovered_from: "a".repeat(40) }), "recovered baseline"],
    [(entry) => ({ ...entry, recovered_artifact_writes: [] }), "recovered writes"],
    [(entry) => ({ ...entry, failure_reason: "failed" }), "failure reason"],
    [(entry) => ({ ...entry, retry_count: 1 }), "retry"],
  ];

  it("property: every progress signal, including executing pending Tasks, refuses reopening", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: progressMutations.length }), (index) => {
      const later = pendingTask("T23", 4);
      const mutated = index === progressMutations.length ? later : progressMutations[index]![0](later);
      const state = graph([task("T19", 3), task("T22", 3), mutated]);
      const executing = index === progressMutations.length ? { ...state, executing_tasks: ["T23"] } : state;
      expect(hasLaterWaveProgress(executing, 3)).toBe(true);
      expect(() => reopenCompletedWave(executing, request, legacyProof)).toThrow("later-Wave");
    }));
  });

  it("keeps a wholly untouched pending later Task eligible", () => {
    expect(hasLaterWaveTaskProgress(pendingTask("T23", 4), [])).toBe(false);
    expect(hasLaterWaveProgress(graph(), 3)).toBe(false);
  });
});

describe("reopen completed Wave", () => {
  it("returns the exact proof derived and committed from locked state", async () => {
    const locked = graph();
    let current = locked;
    const committedProof = legacyProof;
    const store = {
      updateAndReturn: async <T>(
        mutate: (state: TaskGraph) => Readonly<{ state: TaskGraph; value: T }>,
      ): Promise<T> => {
        const applied = mutate(current);
        current = applied.state;
        return applied.value;
      },
    };

    const committed = await commitCompletedWaveReopening(
      store,
      request,
      (observed, lockedRequest) => {
        expect(observed).toBe(locked);
        expect(lockedRequest).toBe(request);
        return committedProof;
      },
    );

    expect(committed).toEqual({ kind: "committed", proof: committedProof });
    expect(current.wave_reopening_history?.[0]).toMatchObject({
      proofMode: committed.proof.mode,
      reopenedTaskIds: committed.proof.taskIds,
    });
  });

  it("returns immutable committed audit proof on exact replay without recomputing", async () => {
    let current = reopenCompletedWave(graph(), request, legacyProof);
    const store = {
      updateAndReturn: async <T>(
        mutate: (state: TaskGraph) => Readonly<{ state: TaskGraph; value: T }>,
      ): Promise<T> => {
        const applied = mutate(current);
        current = applied.state;
        return applied.value;
      },
    };
    let proveCalled = false;

    const replay = await commitCompletedWaveReopening(store, request, () => {
      proveCalled = true;
      return modernProof(["T22"]);
    });

    expect(proveCalled).toBe(false);
    expect(replay).toEqual({ kind: "already-committed", proof: legacyProof });
  });

  it("reopens only the derived Tasks, retains historical evidence, and requires fresh task revalidation", () => {
    const before = graph();
    const after = reopenCompletedWave(before, request, legacyProof);
    expect(after.tasks.slice(0, 2)).toMatchObject([
      { id: "T19", status: "pending", revalidation_required: true, review_status: "pending", review_generation: 8 },
      { id: "T22", status: "pending", revalidation_required: true, review_status: "pending", review_generation: 8 },
    ]);
    expect(after.tasks[2]).toEqual(before.tasks[2]);
    expect(after.current_wave).toBe(3);
    expect(after.wave_gate_history).toEqual([]);
    expect(after.wave_reopening_history?.[0]?.completionReceipt).toEqual(receipt);
    expect(after.tasks.slice(0, 2).map((entry) => entry.proof)).toEqual(before.tasks.slice(0, 2).map((entry) => entry.proof));
    expect(checkImplementationProof(after.tasks.filter((entry) => entry.wave === 3))).toMatchObject({ passed: false });
    expect(after.wave_gates["3"]).toEqual({ impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false });
  });

  it("refuses actual missing drift and remains idempotent only through the immutable audit", () => {
    expect(() => reopenCompletedWave(graph(), request, modernProof([]))).toThrow("exactly equal");
    const reopened = reopenCompletedWave(graph(), request, legacyProof);
    expect(() => reopenCompletedWave(reopened, request, legacyProof)).toThrow("current_wave exactly");
  });

  it("blocks immediate Wave Gate preparation and forbids legacy task-stop positive bypass", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-reopened-wave-"));
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-reopened-wave-runs-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
      expect(spawnSync("git", ["init"], { cwd: root, encoding: "utf8" }).status).toBe(0);
      const statePath = join(root, ".claude", "state", "active_task_graph.json");
      const e2eProof = evaluateTaskProof({ newTestsRequired: false, declaredArtifacts: ["src/a.ts"] }, {
        taskCompleted: true, testResult: undefined, filesModified: ["src/a.ts"], newTestsWritten: false,
      });
      if (e2eProof.state !== "satisfied") throw new Error("e2e fixture proof must satisfy");
      const reopened = reopenCompletedWave(graph(), request, legacyProof);
      const awaitingRevalidation = {
        ...reopened,
        tasks: reopened.tasks.map((entry) => entry.wave === 3
          ? taskFixture({ ...entry, status: "pending", proof: e2eProof, revalidation_required: true, files_modified: ["src/a.ts"] })
          : entry),
      };
      expect(checkImplementationProof(awaitingRevalidation.tasks.filter((entry) => entry.wave === 3))).toMatchObject({ passed: false });
      mkdirSync(join(root, ".claude", "state"), { recursive: true });
      writeFileSync(statePath, JSON.stringify(awaitingRevalidation));
      const { PI_CODING_AGENT: _pi, ...env } = process.env;
      const blockedRun = join(runsRoot, "run.revalidation-required");
      mkdirSync(blockedRun);
      const blocked = spawnSync("bun", [CLI, "helper", "orchestration", "start", "wave-gate", "--runs-root", runsRoot, "--run", blockedRun], {
        cwd: root, encoding: "utf8", input: JSON.stringify({ wave: 3 }),
        env: { ...env, LOOM_STATE_PATH: statePath },
      });
      expect(blocked.status, blocked.stderr).toBe(0);
      expect((JSON.parse(blocked.stdout) as { kind: string }).kind, blocked.stdout).toBe("blocked");

      const freshStop = {
        taskCompleted: true,
        testResult: { verdict: "untrusted" as const, passed: true, label: "pi-structured: fresh bun test pass", provenance: "pi-structured" as const },
        testEvidence: "fresh bun test pass",
        filesModified: ["src/a.ts"],
        changedDeclaredArtifacts: ["src/a.ts"],
        bytesChangedSinceAttempt: false,
        newTestsWritten: false,
        newTestEvidence: "",
      };
      const revalidated = ["T19", "T22"].reduce<TaskGraph>((state, taskId) =>
        applyUntrustedStopResolution({ ...state, executing_tasks: [taskId] }, taskId, freshStop).state,
      awaitingRevalidation);
      expect(revalidated.tasks.slice(0, 2)).toMatchObject([
        { status: "pending", proof: { state: "failed" }, revalidation_required: true },
        { status: "pending", proof: { state: "failed" }, revalidation_required: true },
      ]);
      expect(checkImplementationProof(revalidated.tasks.filter((entry) => entry.wave === 3))).toMatchObject({ passed: false });
      chmodSync(statePath, 0o644);
      writeFileSync(statePath, JSON.stringify(revalidated));
      const runDir = join(runsRoot, "run.revalidated-wave");
      mkdirSync(runDir);
      const started = spawnSync("bun", [CLI, "helper", "orchestration", "start", "wave-gate", "--runs-root", runsRoot, "--run", runDir], {
        cwd: root, encoding: "utf8", input: JSON.stringify({ wave: 3 }),
        env: { ...env, LOOM_STATE_PATH: statePath },
      });
      expect(started.status, started.stderr).toBe(0);
      expect((JSON.parse(started.stdout) as { kind: string }).kind, started.stdout).toBe("blocked");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(runsRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
