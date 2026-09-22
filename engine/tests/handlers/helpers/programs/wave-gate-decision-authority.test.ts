import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
/**
 * `waveGateDecisionMismatch` is the guard that stops a Wave advisory decision
 * meant for one Wave Gate run from being applied to a stale or foreign one.
 *
 * It used to be a raw boolean chain inline in `decideOperation`, inside the CLI
 * dispatcher, so its four dimensions had no interface of their own: the only
 * coverage spawned the whole CLI against fixture files and matched stderr, and
 * "wrong run" / "wrong wave" / "wrong authority digest" / "wrong decision id"
 * were indistinguishable from each other in a failure. Each is its own case
 * here, against plain objects.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureLoomRuntimeIdentity, PI_EXTENSION_RUNTIME_ROOT_ENV, PI_EXTENSION_RUNTIME_REVISION_ENV } from "../../../../src/runtime-compatibility";
import { canonicalTempDir } from "../../../fixtures/canonical-temp-dir";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  applyCurrentSpecCheckCaptureRejection,
  applyWaveFacadeSubmission,
  handleWaveReviewContext,
  installWaveReviewRuns,
  publishWaveAdvisoryDecisionRequest,
  reportUncaughtWaveGateFailure,
  specCheckSlotBelongsToWaveEpoch,
  waveAdvisoryDecisionRequestId,
  waveGateAuthorityDigest,
  waveGateDecisionMismatch,
  waveRefutationCommitProblem,
  waveRequests,
} from "../../../../src/handlers/helpers/programs/wave-gate";
import {
  deriveLoomStatusFromParsedGraph,
  deriveWaveAdvisoryDecisionRequest,
  deriveWaveGateDriveStep,
  deriveWaveReadiness,
} from "../../../../src/core/wave-gate-machine";
import { observedAdvisoryApproval } from "../../../../src/handlers/helpers/orchestration";
import { derivePendingTaskProof } from "../../../../src/core/proof-obligations";
import { buildFindingBrief } from "../../../../src/core/review-panel";
import {
  parseRequestId,
  type AgentRequestAuthority,
  type ArtifactDigest,
  type OrchestrationRunId,
} from "../../../../src/core/orchestration-contract";
import type { WaveReviewRegistrationAuthority } from "../../../../src/core/wave-review-authority";
import { buildContextPacket, encodeByteSection } from "../../../../src/orchestration/context-packets";
import { openRunDirectory, type RunDirHandle } from "../../../../src/orchestration/run-directory-handle";
import type { RegisteredWaveGateProgram } from "../../../../src/handlers/helpers/programs/helpers";
import { parseTaskGraph, StateManager } from "../../../../src/state-manager";
import { capturedSpecCheck } from "../../../../src/core/spec-check";
import type { TaskGraph } from "../../../../src/types";

const RUN_ID = "run.wave-decision";
const DIGEST = "a".repeat(64);
const DOCUMENTS = {
  spec: { path: null, contentDigest: null },
  plan: { path: null, contentDigest: null },
} as const;

const task = (id: string, claim: string): TaskGraph["tasks"][number] => ({
  id,
  description: `review ${id}`,
  agent: "code-implementer-agent",
  wave: 1,
  status: "completed",
  depends_on: [],
  findings: [{
    id: `${id}-1`,
    agent: "comment-analyzer",
    severity: "advisory",
    file: null,
    line: null,
    claim,
  }],
  critical_findings: [],
  advisory_findings: [claim],
} as unknown as TaskGraph["tasks"][number]);

const TASKS = [task("T1", "prefer a named predicate"), task("T2", "tighten the envelope schema")];

const graph = (overrides: Partial<TaskGraph> = {}): TaskGraph => ({
  current_phase: "execute",
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: null,
  executing_tasks: [],
  tasks: TASKS,
  wave_gates: {},
  current_wave: 1,
  active_wave_gate: {
    schemaVersion: 1,
    kind: "active-wave-gate",
    runId: RUN_ID,
    wave: 1,
    authorityDigest: DIGEST,
    revision: 0,
    terminalOutcome: null,
  },
  ...overrides,
} as unknown as TaskGraph);

const registration = (
  overrides: Partial<Extract<RegisteredWaveGateProgram, { schemaVersion: 1 }>> = {},
): Extract<RegisteredWaveGateProgram, { schemaVersion: 1 }> => ({
  schemaVersion: 1,
  kind: "wave-gate",
  input: { wave: 1 },
  taskIds: ["T1", "T2"],
  authorityDigest: DIGEST,
  ...overrides,
});

const pendingDecisionId = (): string => waveAdvisoryDecisionRequestId(RUN_ID, TASKS);

describe("Wave Gate start effect ordering", () => {
  it("leaves protected bytes unchanged when Run Directory program publication is refused", async () => {
    const root = canonicalTempDir("loom-wave-publication-refusal-");
    const runsRoot = join(root, "runs");
    const runDirectory = join(runsRoot, "run.publication-refusal");
    const stateDirectory = join(root, ".claude", "state");
    const statePath = join(stateDirectory, "active_task_graph.json");
    mkdirSync(runDirectory, { recursive: true });
    mkdirSync(stateDirectory, { recursive: true });
    const initial = graph({ active_wave_gate: undefined });
    writeFileSync(statePath, JSON.stringify(initial));
    try {
      const opened = openRunDirectory(runsRoot, runDirectory);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect((await opened.value.registerProgram({
        ...registration({ input: { wave: 2 } }),
        taskIds: ["T9"],
      })).ok).toBe(true);
      const before = readFileSync(statePath);
      const runtime = captureLoomRuntimeIdentity(fileURLToPath(new URL("../../../../../", import.meta.url)));
      const childEnv: NodeJS.ProcessEnv = { ...process.env, LOOM_STATE_PATH: statePath,
        PI_CODING_AGENT: "true", [PI_EXTENSION_RUNTIME_ROOT_ENV]: runtime.packageRoot,
        [PI_EXTENSION_RUNTIME_REVISION_ENV]: runtime.revision };
      const started = spawnSync("bun", [
        new URL("../../../../src/cli.ts", import.meta.url).pathname,
        "helper", "orchestration", "start", "wave-gate",
        "--runs-root", runsRoot, "--run", runDirectory,
      ], { cwd: root, env: childEnv, input: JSON.stringify({ wave: 1 }), encoding: "utf8" });

      expect(started.status).not.toBe(0);
      expect(started.stderr).toContain("different program authority");
      expect(readFileSync(statePath)).toEqual(before);
      expect(new StateManager(statePath).load().active_wave_gate).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects same-Wave TaskGraph drift after publication without installing stale authority", async () => {
    const root = canonicalTempDir("loom-wave-start-race-");
    const statePath = join(root, "active_task_graph.json");
    const initial = graph({ active_wave_gate: undefined, tasks: [TASKS[0]!] });
    const taskIds = ["T1"];
    const authorityDigest = waveGateAuthorityDigest(1, taskIds, initial);
    const active = {
      schemaVersion: 1,
      kind: "active-wave-gate",
      runId: RUN_ID,
      wave: 1,
      authorityDigest,
      revision: 0,
      terminalOutcome: null,
    };
    writeFileSync(statePath, JSON.stringify({ ...initial, tasks: TASKS }));
    const before = readFileSync(statePath);
    try {
      await expect(new StateManager(statePath).registerActiveWaveGate(active, taskIds))
        .rejects.toThrow("changed after Run Directory publication");
      expect(readFileSync(statePath)).toEqual(before);
      expect(new StateManager(statePath).load().active_wave_gate).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Wave Gate internal-failure boundary", () => {
  it("returns expected submission refusals without classifying them as internal", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const handle = {
      readContext: () => ({ ok: false, error: { message: "expected context refusal" } }),
    } as unknown as RunDirHandle;
    try {
      const result = await applyWaveFacadeSubmission(
        handle,
        { runId: RUN_ID, contextDigest: DIGEST } as AgentRequestAuthority,
        "",
      );
      expect(result).toEqual({ ok: false, message: "expected context refusal" });
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it("routes unexpected submission exceptions through stack-preserving diagnostics", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const handle = {
      readContext: () => { throw new Error("injected context adapter crash"); },
    } as unknown as RunDirHandle;
    try {
      const result = await applyWaveFacadeSubmission(
        handle,
        { runId: RUN_ID, contextDigest: DIGEST } as AgentRequestAuthority,
        "",
      );
      expect(result).toEqual({ ok: false, message: "internal Wave Gate failure: injected context adapter crash" });
      const diagnostic = stderr.mock.calls.map(([text]) => String(text)).join("");
      expect(diagnostic).toContain("Error: injected context adapter crash");
      expect(diagnostic).toContain("wave-gate-decision-authority.test.ts");
    } finally {
      stderr.mockRestore();
    }
  });

  it("retains stack context and classifies the blocked diagnostic as internal", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const error = new Error("injected reducer defect");
    try {
      expect(reportUncaughtWaveGateFailure(RUN_ID, error))
        .toBe("internal Wave Gate failure: injected reducer defect");
      const diagnostic = stderr.mock.calls.map(([text]) => String(text)).join("");
      expect(diagnostic).toContain(`uncaught internal Wave Gate failure in ${RUN_ID}`);
      expect(diagnostic).toContain("Error: injected reducer defect");
      expect(diagnostic).toContain("wave-gate-decision-authority.test.ts");
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("Wave review registration authority", () => {
  it("requires an exact concrete Wave", () => {
    expectTypeOf<WaveReviewRegistrationAuthority["input"]["wave"]>().toEqualTypeOf<number>();
    expect(registration().input.wave).toBe(1);
  });
});

describe("wave review context authority", () => {
  const packetFor = (authority: unknown) => {
    const section = encodeByteSection("wave-review-authority", JSON.stringify(authority));
    expect(section.ok).toBe(true);
    if (!section.ok) throw new Error(section.error.message);
    const requestId = parseRequestId("wave-request:context-test:1");
    expect(requestId.ok).toBe(true);
    if (!requestId.ok) throw new Error(requestId.error.message);
    const packet = buildContextPacket({
      requestId: requestId.value,
      role: "spec-check-invoker",
      requiredSkill: "spec-check",
      outputContract: "test",
      fixedContext: [section.value],
      variableContext: [],
    });
    expect(packet.ok).toBe(true);
    if (!packet.ok) throw new Error(packet.error.message);
    return packet.value;
  };

  const taskAuthority = (overrides: Record<string, unknown> = {}) => ({
    id: "T1",
    description: "review T1",
    agent: "code-implementer-agent",
    reviewGeneration: 0,
    planContext: null,
    specAnchors: [],
    specContributions: [],
    declaredFiles: ["engine/src/a.ts"],
    modifiedFiles: ["engine/src/a.ts"],
    proof: null,
    testResult: null,
    priorFindings: [],
    ...overrides,
  });

  it("loads only a proven exact authority shape", () => {
    const packet = packetFor({
      runId: RUN_ID,
      wave: 1,
      authorityDigest: DIGEST,
      batchEpoch: "b".repeat(64),
      subject: { role: "spec-check-invoker", taskId: null },
      taskRun: null,
      task: null,
      specCheckScope: [{
        id: "T1",
        description: "review T1",
        completionAnchors: ["FR-1"],
        contributions: [],
        declaredFiles: ["engine/src/a.ts"],
        modifiedFiles: ["engine/src/a.ts"],
      }],
      packetId: null,
      specFile: null,
      planFile: null,
      specCheckDocuments: DOCUMENTS,
    });
    const context = handleWaveReviewContext([packet], packet.digest);
    expect(context).toMatchObject({
      kind: "loaded",
      value: { runId: RUN_ID, wave: 1, subject: { taskId: null }, taskRun: null },
    });
    if (context.kind !== "loaded") return;
    const brandedAuthority = (
      runId: OrchestrationRunId,
      authorityDigest: ArtifactDigest,
      batchEpoch: ArtifactDigest,
    ) => ({ runId, authorityDigest, batchEpoch });
    expect(brandedAuthority(
      context.value.runId,
      context.value.authorityDigest,
      context.value.batchEpoch,
    )).toEqual({ runId: RUN_ID, authorityDigest: DIGEST, batchEpoch: "b".repeat(64) });
  });

  it("keeps exact spec-check packet membership after every reviewer run closes", () => {
    const batchEpoch = "b".repeat(64);
    const slotId = "wave-slot:spec-check";
    const packet = packetFor({
      runId: RUN_ID,
      wave: 1,
      authorityDigest: DIGEST,
      batchEpoch,
      subject: { role: "spec-check-invoker", taskId: null },
      taskRun: null,
      task: null,
      specCheckScope: [{
        id: "T1", description: "review T1", completionAnchors: ["FR-1"], contributions: [], declaredFiles: [],
        modifiedFiles: [],
      }],
      packetId: null,
      specFile: null,
      planFile: null,
      specCheckDocuments: DOCUMENTS,
    });
    const context = handleWaveReviewContext([packet], packet.digest);
    expect(context.kind).toBe("loaded");
    if (context.kind !== "loaded") return;
    const closedReviewGraph = graph({
      wave_review_epoch: {
        runId: RUN_ID,
        wave: 1,
        batchEpoch,
        specCheckDocuments: DOCUMENTS,
        specCheckSlotAuthority: { slot_id: slotId, attempted: 1 },
      } as TaskGraph["wave_review_epoch"],
    });

    expect(specCheckSlotBelongsToWaveEpoch(
      closedReviewGraph,
      { runId: RUN_ID, slotId, attempt: 1 },
      context.value,
    )).toBe(true);
    expect(specCheckSlotBelongsToWaveEpoch(
      closedReviewGraph,
      { runId: RUN_ID, slotId, attempt: 2 },
      context.value,
    )).toBe(false);
  });

  it("does not let a paused attempt-1 rejection overwrite accepted attempt-2 evidence", () => {
    const batchEpoch = "b".repeat(64);
    const slotId = "wave-slot:spec-check";
    const acceptedAttemptTwo = capturedSpecCheck({
      wave: 1,
      runAt: "2026-08-28T00:00:02.000Z",
      criticalFindings: [],
    });
    const lockedAfterAttemptTwo = graph({
      spec_check: acceptedAttemptTwo,
      wave_review_epoch: {
        runId: RUN_ID,
        wave: 1,
        batchEpoch,
        specCheckDocuments: DOCUMENTS,
        specCheckSlotAuthority: { slot_id: slotId, attempted: 2 },
      } as TaskGraph["wave_review_epoch"],
    });
    const transition = applyCurrentSpecCheckCaptureRejection(
      lockedAfterAttemptTwo,
      { runId: RUN_ID, slotId, attempt: 1 },
      {
        wave: 1,
        batchEpoch: batchEpoch as ArtifactDigest,
        authorityDigest: DIGEST as ArtifactDigest,
        specCheckDocuments: DOCUMENTS,
      },
      "attempt 1 capture rejected",
      "2026-08-28T00:00:01.000Z",
    );

    expect(transition.applied).toBe(false);
    expect(transition.state).toBe(lockedAfterAttemptTwo);
    expect(transition.state.spec_check).toEqual(acceptedAttemptTwo);
  });

  it("applies a capture rejection while attempt 1 still owns the exact slot", () => {
    const batchEpoch = "b".repeat(64);
    const slotId = "wave-slot:spec-check";
    const lockedAttemptOne = graph({
      spec_check: capturedSpecCheck({
        wave: 1,
        runAt: "2026-08-28T00:00:00.000Z",
        criticalFindings: ["earlier blocker"],
      }),
      wave_gates: {
        "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: true },
      },
      wave_review_epoch: {
        runId: RUN_ID,
        wave: 1,
        batchEpoch,
        specCheckDocuments: DOCUMENTS,
        specCheckSlotAuthority: { slot_id: slotId, attempted: 1 },
      } as TaskGraph["wave_review_epoch"],
    });
    const failure = {
      wave: 1,
      run_at: "2026-08-28T00:00:01.000Z",
      verdict: "EVIDENCE_CAPTURE_FAILED" as const,
      error: "attempt 1 capture rejected",
      cause: "transcript" as const,
    };

    const transition = applyCurrentSpecCheckCaptureRejection(
      lockedAttemptOne,
      { runId: RUN_ID, slotId, attempt: 1 },
      {
        wave: 1,
        batchEpoch: batchEpoch as ArtifactDigest,
        authorityDigest: DIGEST as ArtifactDigest,
        specCheckDocuments: DOCUMENTS,
      },
      failure.error,
      failure.run_at,
    );

    expect(transition.applied).toBe(true);
    expect(transition.state.spec_check).toEqual(failure);
    expect(transition.state.wave_gates["1"]?.blocked).toBe(false);
  });

  it("loads a Task reviewer only with complete matching Task authority", () => {
    const packetId = "c".repeat(64);
    const packet = packetFor({
      runId: RUN_ID,
      wave: 1,
      authorityDigest: DIGEST,
      batchEpoch: "b".repeat(64),
      subject: { role: "code-reviewer", taskId: "T1" },
      taskRun: { taskId: "T1", generation: 0, packetId, headSha: "d".repeat(64) },
      task: taskAuthority(),
      specCheckScope: null,
      packetId,
      specFile: null,
      planFile: null,
    });

    expect(handleWaveReviewContext([packet], packet.digest)).toMatchObject({
      kind: "loaded",
      value: {
        subject: { role: "code-reviewer", taskId: "T1" },
        task: { id: "T1", reviewGeneration: 0, declaredFiles: ["engine/src/a.ts"] },
        packetId,
      },
    });
  });

  it("rejects matching unsafe Task Run and Task review generations", () => {
    const packetId = "c".repeat(64);
    const unsafeGeneration = Number.MAX_SAFE_INTEGER + 1;
    const packet = packetFor({
      runId: RUN_ID,
      wave: 1,
      authorityDigest: DIGEST,
      batchEpoch: "b".repeat(64),
      subject: { role: "code-reviewer", taskId: "T1" },
      taskRun: { taskId: "T1", generation: unsafeGeneration, packetId, headSha: "d".repeat(64) },
      task: taskAuthority({ reviewGeneration: unsafeGeneration }),
      specCheckScope: null,
      packetId,
      specFile: null,
      planFile: null,
    });

    expect(handleWaveReviewContext([packet], packet.digest)).toMatchObject({
      kind: "corrupt",
      message: expect.stringContaining("taskRun fields are invalid"),
    });
  });

  it("accepts and preserves valid non-null proof and test evidence", () => {
    const packetId = "c".repeat(64);
    const proof = derivePendingTaskProof({ newTestsRequired: false, declaredArtifacts: [] });
    const testResult = { verdict: "trusted-pass" as const };
    const packet = packetFor({
      runId: RUN_ID,
      wave: 1,
      authorityDigest: DIGEST,
      batchEpoch: "b".repeat(64),
      subject: { role: "code-reviewer", taskId: "T1" },
      taskRun: { taskId: "T1", generation: 0, packetId, headSha: "d".repeat(64) },
      task: taskAuthority({ proof, testResult }),
      specCheckScope: null,
      packetId,
      specFile: null,
      planFile: null,
    });

    expect(handleWaveReviewContext([packet], packet.digest)).toMatchObject({
      kind: "loaded",
      value: { task: { proof, testResult } },
    });
  });

  it.each([
    ["a foreign Task payload", taskAuthority({ id: "T2" }), "identity/generation"],
    ["a stale Task generation", taskAuthority({ reviewGeneration: 1 }), "identity/generation"],
    ["malformed proof evidence", taskAuthority({ proof: { state: "invented" } }), "task.proof is invalid"],
    ["malformed test evidence", taskAuthority({ testResult: { verdict: "invented" } }), "task.testResult is invalid"],
    ["malformed prior Findings", taskAuthority({ priorFindings: [{ id: "missing-fields" }] }), "fields are invalid"],
  ] as const)("rejects %s", (_label, task, message) => {
    const packetId = "c".repeat(64);
    const packet = packetFor({
      runId: RUN_ID,
      wave: 1,
      authorityDigest: DIGEST,
      batchEpoch: "b".repeat(64),
      subject: { role: "code-reviewer", taskId: "T1" },
      taskRun: { taskId: "T1", generation: 0, packetId, headSha: "d".repeat(64) },
      task,
      specCheckScope: null,
      packetId,
      specFile: null,
      planFile: null,
    });

    expect(handleWaveReviewContext([packet], packet.digest)).toMatchObject({
      kind: "corrupt",
      message: expect.stringContaining(message),
    });
  });

  it("classifies valid JSON with the wrong schema as corrupt", () => {
    const packet = packetFor({ wave: 1, batchEpoch: "b".repeat(64) });
    expect(handleWaveReviewContext([packet], packet.digest)).toMatchObject({
      kind: "corrupt",
      message: expect.stringContaining("invalid top-level schema"),
    });
  });

  it.each([
    ["a spec-check subject carrying Task authority", {
      subject: { role: "spec-check-invoker", taskId: "T1" },
      taskRun: { taskId: "T1", generation: 0, packetId: "c".repeat(64), headSha: "d".repeat(64) },
      task: { id: "T1" }, packetId: "c".repeat(64),
    }],
    ["a Task reviewer with nullable Task authority", {
      subject: { role: "code-reviewer", taskId: null }, taskRun: null, task: null, packetId: null,
    }],
    ["an unknown review role", {
      subject: { role: "invented-reviewer", taskId: null }, taskRun: null, task: null, packetId: null,
    }],
  ] as const)("rejects %s", (_label, illegal) => {
    const packet = packetFor({
      runId: RUN_ID,
      wave: 1,
      authorityDigest: DIGEST,
      batchEpoch: "b".repeat(64),
      ...illegal,
      specFile: null,
      planFile: null,
    });
    expect(handleWaveReviewContext([packet], packet.digest).kind).toBe("corrupt");
  });
});

describe("Wave review epoch installation", () => {
  it("upgrades a historical floor under lock and clears stale spec-check evidence", async () => {
    const root = canonicalTempDir("loom-wave-floor-upgrade-");
    const previousCwd = process.cwd();
    const runsRoot = join(root, "runs");
    const runDirectory = join(runsRoot, "run.floor-upgrade");
    const statePath = join(root, "active_task_graph.json");
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(join(root, "src", "x.ts"), "export const x = 1;\n");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "src/x.ts"], { cwd: root });
    execFileSync("git", [
      "-c", "user.name=Loom Tests", "-c", "user.email=loom@example.test",
      "commit", "--quiet", "-m", "fixture",
    ], { cwd: root });
    process.chdir(root);
    try {
      const pendingTask = {
        id: "T1",
        description: "review floor upgrade",
        agent: "code-implementer-agent",
        wave: 1,
        status: "pending" as const,
        proof: derivePendingTaskProof({ newTestsRequired: false, declaredArtifacts: ["src/x.ts"] }),
        new_tests_required: false,
        depends_on: [],
        file_list: ["src/x.ts"],
        files_modified: ["src/x.ts"],
        review_status: "pending" as const,
        review_generation: 0,
        findings: [],
        critical_findings: [],
        advisory_findings: [],
      };
      const beforeActive: TaskGraph = {
        current_phase: "execute",
        current_wave: 1,
        phase_artifacts: {},
        skipped_phases: [],
        spec_file: null,
        plan_file: null,
        executing_tasks: [],
        tasks: [pendingTask],
        wave_gates: {},
      };
      const authorityDigest = waveGateAuthorityDigest(1, ["T1"], beforeActive);
      const registration: RegisteredWaveGateProgram = {
        schemaVersion: 1,
        kind: "wave-gate",
        input: { wave: 1 },
        taskIds: ["T1"],
        authorityDigest,
      };
      writeFileSync(statePath, JSON.stringify({
        ...beforeActive,
        active_wave_gate: {
          schemaVersion: 1,
          kind: "active-wave-gate",
          runId: "run.floor-upgrade",
          wave: 1,
          authorityDigest,
          revision: 0,
          runsRoot,
          terminalOutcome: null,
        },
      }));
      const opened = openRunDirectory(runsRoot, runDirectory);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect((await opened.value.registerProgram(registration)).ok).toBe(true);
      const manager = new StateManager(statePath);
      const batch = waveRequests(opened.value, registration, manager.load(), 1, root);
      const specCheckAuthority = batch.requests
        .map(({ authority }) => authority as AgentRequestAuthority)
        .find(({ role }) => role === "spec-check-invoker");
      if (specCheckAuthority === undefined) throw new Error("fixture lacks spec-check authority");
      await manager.update((locked) => ({
        ...locked,
        spec_check: capturedSpecCheck({ wave: 1, runAt: "historical", criticalFindings: [] }),
        wave_review_epoch: {
          runId: specCheckAuthority.runId,
          wave: 1,
          batchEpoch: batch.batchEpoch,
          specCheckDocuments: batch.specCheckDocuments,
          specCheckSlotAuthority: { slot_id: specCheckAuthority.slotId, attempted: 1 },
        },
      }));

      await installWaveReviewRuns(manager, registration, batch);

      const upgraded = manager.load();
      expect(upgraded.spec_check).toBeUndefined();
      expect(upgraded.wave_review_epoch?.settledSpecCheckFloor).toEqual(batch.settledFloor);
      expect(upgraded.tasks[0]?.review_run).toBeDefined();
    } finally {
      process.chdir(previousCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("locked Refutation Panel authority", () => {
  const criticalGraph = (): TaskGraph => {
    const tasks = TASKS.map((entry, index) => index === 0
      ? {
          ...entry,
          review_status: "blocked" as const,
          findings: [{
            id: "code-reviewer-1",
            agent: "code-reviewer",
            severity: "critical" as const,
            file: "engine/src/example.ts",
            line: 1,
            claim: "exact critical",
          }],
          critical_findings: ["exact critical"],
          advisory_findings: [],
        }
      : { ...entry, review_status: "passed" as const });
    return graph({ tasks });
  };

  it("accepts only the panel bound to the locked active registration and Finding set", () => {
    const current = criticalGraph();
    const findings = buildFindingBrief(1, current.tasks).findings;
    expect(findings).toHaveLength(1);
    const panel = { runId: current.active_wave_gate!.runId, findings: [findings[0]!] as const };

    expect(waveRefutationCommitProblem(
      current,
      registration(),
      current.active_wave_gate!,
      panel,
    )).toBeNull();
    expect(waveRefutationCommitProblem(
      graph({ ...current, active_wave_gate: { ...current.active_wave_gate!, revision: 1 } }),
      registration(),
      current.active_wave_gate!,
      panel,
    )).toContain("exact active Wave Gate authority");
    expect(waveRefutationCommitProblem(
      criticalGraph(),
      registration(),
      current.active_wave_gate!,
      { ...panel, findings: [{ ...panel.findings[0], claim: "stale critical" }] },
    )).toContain("locked current-Wave Finding authority");
  });
});

describe("waveGateDecisionMismatch", () => {
  it("derives post-review advisory intent from LC-1 rather than shell predicates", () => {
    const snapshot = deriveWaveReadiness(
      graph(),
      { loadPlanModels: () => ({ kind: "none" }), filePresence: () => ({ ok: true, exists: true }) },
    );
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;

    const pending = deriveWaveGateDriveStep(snapshot.value, false);
    expect(pending.ok).toBe(true);
    if (!pending.ok) return;
    expect(pending.value).toMatchObject({
      kind: "await-advisory-decision",
      material: { requestId: pendingDecisionId() },
      state: { kind: "awaiting-advisory-decision" },
    });

    const approved = deriveWaveGateDriveStep(snapshot.value, true);
    expect(approved.ok).toBe(true);
    if (approved.ok) expect(approved.value.kind).not.toBe("await-advisory-decision");
  });

  it("uses the same core-owned request identity as lifecycle status", () => {
    const core = deriveWaveAdvisoryDecisionRequest(RUN_ID, TASKS);

    expect(core.ok).toBe(true);
    if (core.ok) expect(pendingDecisionId()).toBe(core.value.requestId);
  });

  it("admits the exact await-user request emitted by status", () => {
    const status = deriveLoomStatusFromParsedGraph(
      { ok: true, value: graph() },
      { loadPlanModels: () => ({ kind: "none" }), filePresence: () => ({ ok: true, exists: true }) },
      null,
      { kind: "present", runId: RUN_ID, path: `/runs/${RUN_ID}`, advisoryApproval: { kind: "not-approved" } },
    );
    expect(status.next.action.kind).toBe("await-user");
    if (status.next.action.kind !== "await-user") return;
    expect(waveGateDecisionMismatch(
      graph(), registration(), RUN_ID, status.next.action.request.requestId,
    )).toBeNull();
  });

  it("preserves a corrupt advisory event log as unavailable and reports the cause", async () => {
    const runsRoot = canonicalTempDir("loom-wave-advisory-events-");
    const runDirectory = join(runsRoot, RUN_ID);
    mkdirSync(runDirectory);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const opened = openRunDirectory(runsRoot, runDirectory);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      writeFileSync(join(runDirectory, "events", "000000-corrupt.json"), "{not json");
      const parsedGraph = parseTaskGraph(graph());
      if (!parsedGraph.ok) throw new Error(parsedGraph.error);
      expect(parsedGraph.ok).toBe(true);
      const approved = await observedAdvisoryApproval(graph(), {
        kind: "present",
        runId: RUN_ID,
        path: runDirectory,
      });
      expect(approved).toEqual({
        kind: "unavailable",
        reason: expect.stringContaining("cannot read advisory decision event log"),
      });
      expect(stderr.mock.calls.map(([text]) => String(text)).join(""))
        .toContain(`cannot determine advisory approval for ${RUN_ID}`);
    } finally {
      stderr.mockRestore();
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  it("rejects copied advisory material before publishing any referenced bytes", async () => {
    const runsRoot = canonicalTempDir("loom-wave-advisory-forged-");
    const runDirectory = join(runsRoot, RUN_ID);
    mkdirSync(runDirectory);
    try {
      const opened = openRunDirectory(runsRoot, runDirectory);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const material = deriveWaveAdvisoryDecisionRequest(RUN_ID, TASKS);
      expect(material.ok).toBe(true);
      if (!material.ok) return;

      const published = await publishWaveAdvisoryDecisionRequest(opened.value, { ...material.value });

      expect(published).toMatchObject({
        ok: false,
        message: expect.stringContaining("exact core-derived decision material set"),
      });
      expect(existsSync(join(runDirectory, material.value.context.slot.path))).toBe(false);
      for (const advisory of material.value.advisories) {
        expect(existsSync(join(runDirectory, advisory.reference.slot.path))).toBe(false);
      }
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  it("publishes every byte referenced by the façade await-user request", async () => {
    const runsRoot = canonicalTempDir("loom-wave-advisory-");
    const runDirectory = join(runsRoot, RUN_ID);
    mkdirSync(runDirectory);
    try {
      const opened = openRunDirectory(runsRoot, runDirectory);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      const material = deriveWaveAdvisoryDecisionRequest(RUN_ID, TASKS);
      expect(material.ok).toBe(true);
      if (!material.ok) return;
      const published = await publishWaveAdvisoryDecisionRequest(opened.value, material.value);
      expect(published.ok).toBe(true);
      if (!published.ok) return;
      expect(published.request.requestId).toBe(pendingDecisionId());
      for (const advisory of published.request.advisories) {
        const bytes = readFileSync(join(runDirectory, advisory.slot.path));
        expect(bytes).toHaveLength(advisory.byteLength);
      }
      const context = readFileSync(join(runDirectory, published.request.context.slot.path), "utf8");
      expect(context).toContain("wave-advisory-decision-context");
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  it("refuses a decision whose run is not the protected active one", () => {
    expect(waveGateDecisionMismatch(graph(), registration(), "run.other", pendingDecisionId()))
      .toBe("protected active Wave Gate authority differs from this decision run");
  });

  it("refuses a decision for a different wave than the registration names", () => {
    expect(waveGateDecisionMismatch(graph(), registration({ input: { wave: 2 } }), RUN_ID, pendingDecisionId()))
      .toBe("protected active Wave Gate authority differs from this decision run");
  });

  it("refuses a decision whose authority digest drifted from the protected anchor", () => {
    expect(waveGateDecisionMismatch(graph(), registration({ authorityDigest: "b".repeat(64) }), RUN_ID, pendingDecisionId()))
      .toBe("protected active Wave Gate authority differs from this decision run");
  });

  it("refuses when no Wave Gate is registered as active at all", () => {
    expect(waveGateDecisionMismatch(graph({ active_wave_gate: undefined }), registration(), RUN_ID, pendingDecisionId()))
      .toBe("protected active Wave Gate authority differs from this decision run");
  });

  it("refuses a decision id that is not the exact pending advisory request", () => {
    const mismatch = waveGateDecisionMismatch(graph(), registration(), RUN_ID, "advisory-decision:deadbeef");
    expect(mismatch).toContain("is not the exact pending advisory request");
    expect(mismatch).toContain(pendingDecisionId());
  });

  /**
   * The decision id is derived from the advisories of the registration's OWN
   * tasks. A registration naming a subset therefore expects a different id —
   * which is the point: approving "the advisories" must name which ones.
   */
  it("derives the expected id from only the registration's tasks", () => {
    const subset = registration({ taskIds: ["T1"] });
    expect(waveGateDecisionMismatch(graph(), subset, RUN_ID, pendingDecisionId()))
      .toContain("is not the exact pending advisory request");
    expect(waveGateDecisionMismatch(graph(), subset, RUN_ID, waveAdvisoryDecisionRequestId(RUN_ID, [TASKS[0]!])))
      .toBeNull();
  });
});
