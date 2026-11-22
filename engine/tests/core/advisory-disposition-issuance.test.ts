/**
 * Wave review issuance over advisory dispositions (ADR-0090): a deferred or
 * dismissed advisory is left out of a Review Packet's priors, the batch epoch
 * and the installed Review Run while its anchored bytes hold, and reissued
 * once they change. The three agree, so a reviewer is required to assess
 * exactly the priors it was shown.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { advisoryDisposition, anchorDigest } from "../../src/core/advisory-disposition";
import { parseArtifactDigest, parseOrchestrationRunId } from "../../src/core/orchestration-contract";
import type { CurrentReviewRun, CurrentReviewRunEvidence, CurrentReviewRunSlotAuthority } from "../../src/core/findings-shape";
import { captureKey } from "../../src/core/harness-capture";
import { REVIEWER_PROTOCOL_V2, WAVE_REVIEWER_PROTOCOL_V4 } from "../../src/core/reviewer-contract";
import { prepareExhaustedWaveGateRestart } from "../../src/core/wave-gate-replacement";
import type { RegisteredWaveGateProgram } from "../../src/core/wave-gate-program";
import {
  prepareWaveReviewBatch,
  readWaveReviewContext,
  taskReviewScope,
  type WaveRequestBatch,
  type WaveReviewRegistrationAuthority,
} from "../../src/core/wave-review-authority";
import { installWaveReviewRunsTransition } from "../../src/core/wave-review-issuance";
import { observeWaveSpecCheckDocuments } from "../../src/orchestration/wave-spec-check-documents";
import type { Task, TaskGraph } from "../../src/types";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { findingFixture } from "../fixtures/finding";
import { value } from "../fixtures/parse-result";
import { observedWorkspace } from "../fixtures/reviewed-workspace";
import { activeWaveGateFixture, fileOf, protectedGraphFixture, siblingTaskFixture } from "../fixtures/task-lifecycle";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const PLAN_FILE = ".claude/plans/2026-11-18-dispositions.md";
const RUN_ID = value(parseOrchestrationRunId("run.dispositions"));
const AUTHORITY = "a".repeat(64);

const ADVISORY = findingFixture("code-reviewer-1", "advisory", fileOf("T1"));
const CRITICAL = findingFixture("code-reviewer-2", "critical", fileOf("T1"));

const t1: Task = siblingTaskFixture({
  id: "T1", status: "implemented", spec_anchors: [], spec_contributions: [], files_modified: [fileOf("T1")],
  test_result: { verdict: "trusted-pass" }, new_tests_written: true, new_test_evidence: "one property", review_status: "pending",
  findings: [ADVISORY, CRITICAL], critical_findings: [CRITICAL.claim], advisory_findings: [ADVISORY.claim],
});

const registration: RegisteredWaveGateProgram = {
  schemaVersion: 2, reviewerProtocol: REVIEWER_PROTOCOL_V2,
  kind: "wave-gate", input: { wave: 1 }, taskIds: ["T1"], authorityDigest: value(parseArtifactDigest(AUTHORITY)),
};

/** The registration as batch preparation reads it: its Wave proven present. */
const preparing: WaveReviewRegistrationAuthority = { ...registration, input: { wave: 1 } };

function projectWithPlan(): string {
  const root = canonicalTempDir("loom-disposition-issuance-");
  cleanup.push(root);
  mkdirSync(join(root, ".claude", "plans"), { recursive: true });
  writeFileSync(join(root, PLAN_FILE), "# Plan: dispositions\n");
  return root;
}

const documentsOf = (root: string) => observeWaveSpecCheckDocuments({
  specFile: null, planFile: PLAN_FILE, projectBoundary: Object.freeze({ kind: "state-layout" as const, root }),
});

/** T1's reviewed workspace, every scoped file holding `content`. */
const workspaceOf = (content: string) => {
  const scope = taskReviewScope(t1);
  return observedWorkspace("T1", scope, scope.map((path) => ({ path, bytes: Buffer.from(`// ${path} ${content}\n`) })));
};

/** The dismissal of T1's advisory over the bytes holding `content`. */
const dismissedOver = (content: string) => value(advisoryDisposition({
  wave: 1, taskId: "T1", findingId: ADVISORY.id, decision: "dismissed", reason: "false positive", target: null,
  anchor: anchorDigest(ADVISORY.file, workspaceOf(content).artifacts),
}));

const graphOf = (stamps: Record<string, unknown> = {}): TaskGraph => protectedGraphFixture({
  spec_trace_version: 2, current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
  spec_file: null, plan_file: PLAN_FILE, wave_gates: {}, executing_tasks: [], tasks: [t1],
  active_wave_gate: activeWaveGateFixture({ runId: RUN_ID, wave: 1, authorityDigest: AUTHORITY }),
  ...stamps,
});

function issue(graph: TaskGraph, content: string): Readonly<{ batch: WaveRequestBatch; installed: TaskGraph }> {
  const root = projectWithPlan();
  const batch = prepareWaveReviewBatch(RUN_ID, preparing, graph, 1, [workspaceOf(content)], documentsOf(root));
  if (!batch.ok) throw new Error(`issuance refused: ${batch.error.message}`);
  const installed = installWaveReviewRunsTransition(graph, {
    registration, batch: batch.value, workspaces: [workspaceOf(content)], specCheckObservation: documentsOf(root),
  });
  if (!installed.ok) throw new Error(installed.error.message);
  return { batch: batch.value, installed: installed.value };
}

/** The prior Finding ids every reviewer packet of the batch issues for T1. */
function packetPriorIds(batch: WaveRequestBatch): readonly (readonly string[])[] {
  return batch.packets.flatMap((packet) => {
    const context = readWaveReviewContext([packet], packet.digest);
    if (context.kind !== "loaded") throw new Error(`packet authority is ${context.kind}`);
    return context.value.task === null ? [] : [context.value.task.priorFindings.map(({ id }) => id)];
  });
}

describe("issuance over advisory dispositions", () => {
  it("issues every active Finding when nothing is decided", () => {
    const { batch, installed } = issue(graphOf(), "v1");
    expect(installed.tasks[0]!.review_run?.prior_finding_ids).toEqual([ADVISORY.id, CRITICAL.id]);
    expect(new Set(packetPriorIds(batch).map((ids) => ids.join()))).toEqual(new Set([`${ADVISORY.id},${CRITICAL.id}`]));
  });

  it("leaves a dismissed advisory out of every packet and the installed Review Run while its bytes hold", () => {
    const { batch, installed } = issue(graphOf({ advisory_dispositions: [dismissedOver("v1")] }), "v1");
    const run = installed.tasks[0]!.review_run;
    expect(run?.prior_finding_ids).toEqual([CRITICAL.id]);
    expect(packetPriorIds(batch).every((ids) => ids.join() === CRITICAL.id)).toBe(true);
    // The advisory stays active on the Task: a run resolves only what it issued.
    expect(installed.tasks[0]!.findings).toEqual([ADVISORY, CRITICAL]);
  });

  it("reissues the advisory once its anchored bytes change", () => {
    const { batch, installed } = issue(graphOf({ advisory_dispositions: [dismissedOver("v1")] }), "v2");
    expect(installed.tasks[0]!.review_run?.prior_finding_ids).toEqual([ADVISORY.id, CRITICAL.id]);
    expect(packetPriorIds(batch).every((ids) => ids.join() === `${ADVISORY.id},${CRITICAL.id}`)).toBe(true);
  });

  it("keeps an installed run's issued priors on replay, so the install stays idempotent", () => {
    const graph = graphOf({ advisory_dispositions: [dismissedOver("v1")] });
    const { batch, installed } = issue(graph, "v1");
    const root = projectWithPlan();
    const replayBatch = prepareWaveReviewBatch(RUN_ID, preparing, installed, 1, [workspaceOf("v1")], documentsOf(root));
    expect(replayBatch.ok && replayBatch.value.batchEpoch).toBe(batch.batchEpoch);
    const replay = installWaveReviewRunsTransition(installed, {
      registration, batch, workspaces: [workspaceOf("v1")], specCheckObservation: documentsOf(root),
    });
    expect(replay.ok && replay.value.tasks).toEqual(installed.tasks);
  });
});

describe("a restart over a dismissed advisory carries the accepted slots (ADR-0089, ADR-0090)", () => {
  const current: RegisteredWaveGateProgram = { ...registration, reviewerProtocol: WAVE_REVIEWER_PROTOCOL_V4 };

  /** Issue under `registration` over the `v1` bytes, then accept every slot of T1's run but the last, which exhausts attempt 2. */
  function exhaustedAfterIssue(graph: TaskGraph, under: RegisteredWaveGateProgram) {
    const root = projectWithPlan();
    const batch = value(prepareWaveReviewBatch(RUN_ID, { ...under, input: { wave: 1 } }, graph, 1, [workspaceOf("v1")], documentsOf(root)));
    const installed = installWaveReviewRunsTransition(graph, {
      registration: under, batch, workspaces: [workspaceOf("v1")], specCheckObservation: documentsOf(root),
    });
    if (!installed.ok) throw new Error(installed.error.message);
    const run = installed.value.tasks[0]!.review_run;
    if (run?.reviewer_protocol === undefined) throw new Error("T1 must hold a current Review Run");
    const [first, ...rest] = run.slot_authority;
    const exhaustedAgent = (rest[rest.length - 1] ?? first).agent;
    const exhaust = (slot: CurrentReviewRunSlotAuthority): CurrentReviewRunSlotAuthority =>
      (slot.agent === exhaustedAgent ? { ...slot, attempted: 2 } : slot);
    const evidence: readonly CurrentReviewRunEvidence[] = run.slot_authority.filter(({ agent }) => agent !== exhaustedAgent)
      .map((slot) => ({ protocolVersion: 2, agent: slot.agent, slot_id: slot.slot_id, attempted: slot.attempted,
        request_id: slot.request_id, context_digest: slot.context_digest, prior_assessments: [], new_findings: [] }));
    const t1Run: CurrentReviewRun = { ...run, evidence, slot_authority: [exhaust(first), ...rest.map(exhaust)] };
    const exhausted: TaskGraph = { ...installed.value, tasks: [{ ...installed.value.tasks[0]!, review_run: t1Run }] };
    return { exhausted, run: t1Run, exhaustedAgent, slotId: (rest[rest.length - 1] ?? first).slot_id };
  }

  it("rebuilds the replacement's run with the carried run's prior ids, carrying every accepted slot", () => {
    const graph = graphOf({ advisory_dispositions: [dismissedOver("v1")] });
    const { exhausted, run, exhaustedAgent, slotId } = exhaustedAfterIssue(graph, current);
    expect(run.prior_finding_ids).toEqual([CRITICAL.id]);

    const prepared = prepareExhaustedWaveGateRestart(exhausted, RUN_ID, current, "run.replacement", "/runs",
      new Set([captureKey(slotId, 2)]), { workspaces: [workspaceOf("v1")], issuedRosters: new Map() });
    if (!prepared.ok) throw new Error(prepared.message);
    const accepted = run.expected_agents.filter((agent) => agent !== exhaustedAgent);
    expect(prepared.value.notCarried).toEqual([]);
    expect(prepared.value.registration.restart?.carry?.carried).toEqual([{ kind: "accepted-slots", taskId: "T1", agents: accepted }]);

    const replacementId = value(parseOrchestrationRunId("run.replacement"));
    const replacement = prepared.value.registration;
    const root = projectWithPlan();
    const batch = value(prepareWaveReviewBatch(replacementId, { ...replacement, input: { wave: 1 } }, prepared.value.graph, 1,
      [workspaceOf("v1")], documentsOf(root)));
    const rebuilt = installWaveReviewRunsTransition(prepared.value.graph, {
      registration: replacement, batch, workspaces: [workspaceOf("v1")], specCheckObservation: documentsOf(root),
    });
    if (!rebuilt.ok) throw new Error(rebuilt.error.message);
    const rebuiltRun = rebuilt.value.tasks[0]!.review_run!;
    expect(rebuiltRun.prior_finding_ids).toEqual(run.prior_finding_ids);
    expect(rebuiltRun.slot_authority!.filter(({ carried_from }) => carried_from !== undefined).map(({ agent }) => agent))
      .toEqual(accepted);
    expect(rebuiltRun.evidence).toEqual(run.evidence);
  });
});
