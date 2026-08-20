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

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  handleWaveReviewContext,
  publishWaveAdvisoryDecisionRequest,
  waveAdvisoryDecisionRequestId,
  waveGateDecisionMismatch,
} from "../../../../src/handlers/helpers/programs/wave-gate";
import {
  deriveLoomStatusFromParsedGraph,
  deriveWaveAdvisoryDecisionRequest,
  deriveWaveGateDriveStep,
  deriveWaveReadiness,
} from "../../../../src/core/wave-gate-machine";
import { observedAdvisoryApproval } from "../../../../src/handlers/helpers/orchestration";
import { parseRequestId } from "../../../../src/core/orchestration-contract";
import { buildContextPacket, encodeByteSection } from "../../../../src/orchestration/context-packets";
import { openRunDirectory } from "../../../../src/orchestration/run-directory-handle";
import type { RegisteredWaveGateProgram } from "../../../../src/handlers/helpers/programs/helpers";
import { parseTaskGraph } from "../../../../src/state-manager";
import type { TaskGraph } from "../../../../src/types";

const RUN_ID = "run.wave-decision";
const DIGEST = "a".repeat(64);

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
  overrides: Partial<RegisteredWaveGateProgram> = {},
): RegisteredWaveGateProgram => ({
  schemaVersion: 1,
  kind: "wave-gate",
  input: { wave: 1 },
  taskIds: ["T1", "T2"],
  authorityDigest: DIGEST,
  ...overrides,
});

const pendingDecisionId = (): string => waveAdvisoryDecisionRequestId(RUN_ID, TASKS);

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
      packetId: null,
      specFile: null,
      planFile: null,
    });
    expect(handleWaveReviewContext([packet], packet.digest)).toMatchObject({
      kind: "loaded",
      value: { runId: RUN_ID, wave: 1, subject: { taskId: null }, taskRun: null },
    });
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

  it.each([
    ["a foreign Task payload", taskAuthority({ id: "T2" }), "identity/generation"],
    ["a stale Task generation", taskAuthority({ reviewGeneration: 1 }), "identity/generation"],
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

describe("waveGateDecisionMismatch", () => {
  it("derives post-review advisory intent from LC-1 rather than shell predicates", () => {
    const snapshot = deriveWaveReadiness(
      graph(),
      { loadPlanModels: () => ({ kind: "none" }), fileExists: () => true },
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
      { loadPlanModels: () => ({ kind: "none" }), fileExists: () => true },
      null,
      { kind: "present", runId: RUN_ID, path: `/runs/${RUN_ID}`, advisoryApproved: false },
    );
    expect(status.next.action.kind).toBe("await-user");
    if (status.next.action.kind !== "await-user") return;
    expect(waveGateDecisionMismatch(
      graph(), registration(), RUN_ID, status.next.action.request.requestId,
    )).toBeNull();
  });

  it("treats a corrupt advisory event log as unapproved and reports the cause", async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-wave-advisory-events-"));
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
      expect(approved).toBe(false);
      expect(stderr.mock.calls.map(([text]) => String(text)).join(""))
        .toContain(`cannot read advisory decision event log for ${RUN_ID}`);
    } finally {
      stderr.mockRestore();
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });

  it("publishes every byte referenced by the façade await-user request", async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "loom-wave-advisory-"));
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
