/**
 * Issuing a narrowed review (ADR-0094) through batch preparation, the locked
 * install and an exhausted-run restart: the owner of every issued prior
 * Finding on the derived roster is issued with it, and a restart's
 * replacement keeps each Task's narrowed roster.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BASE_WAVE_REVIEW_AGENTS, parseNarrowedWaveReviewRoster } from "../../src/core/agent-catalog-projections";
import type { CurrentReviewRun, CurrentReviewRunEvidence, CurrentReviewRunSlotAuthority, Finding } from "../../src/core/findings-shape";
import { captureKey } from "../../src/core/harness-capture";
import { parseArtifactDigest, parseOrchestrationRunId } from "../../src/core/orchestration-contract";
import { WAVE_REVIEWER_PROTOCOL_V4 } from "../../src/core/reviewer-contract";
import type { NarrowedTaskReview, RegisteredWaveGateProgram } from "../../src/core/wave-gate-program";
import { prepareExhaustedWaveGateRestart, sameRestartRegistration } from "../../src/core/wave-gate-replacement";
import { prepareWaveReviewBatch, taskReviewScope } from "../../src/core/wave-review-authority";
import { installWaveReviewRunsTransition } from "../../src/core/wave-review-issuance";
import { observeWaveSpecCheckDocuments } from "../../src/orchestration/wave-spec-check-documents";
import type { Task, TaskGraph } from "../../src/types";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { findingId } from "../fixtures/finding-id";
import { value } from "../fixtures/parse-result";
import { observedWorkspace } from "../fixtures/reviewed-workspace";
import { activeWaveGateFixture, fileOf, protectedGraphFixture, siblingTaskFixture } from "../fixtures/task-lifecycle";
import { preI6DefaultVerificationManifest } from "../../src/core/verification-manifest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PLAN = ".claude/plans/2026-11-18-narrowing.md";
const RUN = value(parseOrchestrationRunId("run.narrowing"));
const DIGEST = "b".repeat(64);

const ownedBy = (agent: string): Finding =>
  ({ id: findingId(`${agent}-1`), agent, severity: "advisory", file: fileOf("T1"), line: 1, claim: `${agent} said so` });

/** T1, implemented, holding `findings`. */
const taskHolding = (findings: readonly Finding[]): Task => siblingTaskFixture({
  id: "T1", status: "implemented", spec_anchors: [], spec_contributions: [], files_modified: [fileOf("T1")],
  test_result: { verdict: "trusted-pass" }, new_tests_written: true, new_test_evidence: "a test", review_status: "pending",
  findings: [...findings], critical_findings: [], advisory_findings: findings.map(({ claim }) => claim),
});

/** T1 narrowed to `roles` against a basis the batch does not read. */
const narrowedTo = (roles: readonly string[]): NarrowedTaskReview => {
  const roster = parseNarrowedWaveReviewRoster(BASE_WAVE_REVIEW_AGENTS, roles);
  if (roster === null) throw new Error("fixture roles must narrow the base five");
  return { taskId: "T1", roster, from: BASE_WAVE_REVIEW_AGENTS, change: ["comment"],
    basis: { runId: "run.basis", authorityDigest: DIGEST, packetId: DIGEST, headSha: DIGEST } };
};

const registrationNarrowing = (roles: readonly string[]): RegisteredWaveGateProgram => ({
  schemaVersion: 2, reviewerProtocol: WAVE_REVIEWER_PROTOCOL_V4, kind: "wave-gate", input: { wave: 1 }, taskIds: ["T1"],
  authorityDigest: value(parseArtifactDigest(DIGEST)), narrowedReviews: [narrowedTo(roles)],
});

const graphHolding = (task: Task): TaskGraph => protectedGraphFixture({
  spec_trace_version: 2, current_phase: "execute", verification_manifest: preI6DefaultVerificationManifest(), current_wave: 1, phase_artifacts: {}, skipped_phases: [],
  spec_file: null, plan_file: PLAN, wave_gates: {}, executing_tasks: [], tasks: [task],
  active_wave_gate: activeWaveGateFixture({ runId: RUN, wave: 1, authorityDigest: DIGEST }),
});

function documents() {
  const root = canonicalTempDir("loom-narrowing-issuance-");
  roots.push(root);
  mkdirSync(join(root, ".claude", "plans"), { recursive: true });
  writeFileSync(join(root, PLAN), "# Plan: narrowing\n");
  return observeWaveSpecCheckDocuments({ specFile: null, planFile: PLAN, projectBoundary: { kind: "state-layout", root } });
}

const workspace = (task: Task) => {
  const scope = taskReviewScope(task);
  return observedWorkspace("T1", scope, scope.map((path) => ({ path, bytes: Buffer.from(`// ${path}\n`) })));
};

const prepare = (graph: TaskGraph, registration: RegisteredWaveGateProgram, run = RUN) =>
  prepareWaveReviewBatch(run, { ...registration, input: { wave: 1 } }, graph, 1, [workspace(graph.tasks[0]!)], documents());

describe("batch preparation refuses a narrowed review that leaves a prior Finding without its owner", () => {
  it("refuses a narrowing that omits the owner of an issued prior Finding on the derived roster", () => {
    const graph = graphHolding(taskHolding([ownedBy("code-reviewer")]));
    expect(prepare(graph, registrationNarrowing(["comment-analyzer"]))).toEqual({ ok: false, error: {
      kind: "wave-review-preparation-rejected",
      message: "Task T1 narrowed review omits code-reviewer, the owner of prior Finding code-reviewer-1",
    } });
  });

  it("admits the same narrowing when the Task holds no such Finding, or its owner is on no roster", () => {
    expect(prepare(graphHolding(taskHolding([])), registrationNarrowing(["comment-analyzer"])).ok).toBe(true);
    expect(prepare(graphHolding(taskHolding([ownedBy("recovered-view")])), registrationNarrowing(["comment-analyzer"])).ok).toBe(true);
  });

  it("admits a narrowing that issues the owner", () => {
    const graph = graphHolding(taskHolding([ownedBy("code-reviewer")]));
    const batch = value(prepare(graph, registrationNarrowing(["code-reviewer", "comment-analyzer"])));
    expect(batch.subjects.map(({ role }) => role)).toEqual(["spec-check-invoker", "code-reviewer", "comment-analyzer"]);
  });
});

describe("an exhausted restart of a narrowed Wave keeps each Task's narrowed roster", () => {
  /** Issue and install the narrowed batch, then exhaust its last slot after accepting the rest. */
  function exhaustedNarrowedRun(registration: RegisteredWaveGateProgram) {
    const graph = graphHolding(taskHolding([]));
    const batch = value(prepare(graph, registration));
    const installed = installWaveReviewRunsTransition(graph, {
      registration, batch, workspaces: [workspace(graph.tasks[0]!)], specCheckObservation: documents(),
    });
    if (!installed.ok) throw new Error(installed.error.message);
    const run = installed.value.tasks[0]!.review_run;
    if (run?.reviewer_protocol === undefined) throw new Error("T1 must hold a current Review Run");
    const last = run.slot_authority[run.slot_authority.length - 1]!;
    const exhaust = (slot: CurrentReviewRunSlotAuthority) => (slot.agent === last.agent ? { ...slot, attempted: 2 as const } : slot);
    const evidence: readonly CurrentReviewRunEvidence[] = run.slot_authority.filter(({ agent }) => agent !== last.agent)
      .map((slot) => ({ protocolVersion: 2, agent: slot.agent, slot_id: slot.slot_id, attempted: slot.attempted,
        request_id: slot.request_id, context_digest: slot.context_digest, prior_assessments: [], new_findings: [] }));
    const [first, ...rest] = run.slot_authority;
    const exhausted: CurrentReviewRun = { ...run, evidence, slot_authority: [exhaust(first), ...rest.map(exhaust)] };
    return { graph: { ...installed.value, tasks: [{ ...installed.value.tasks[0]!, review_run: exhausted }] }, run: exhausted, last };
  }

  it("inherits the narrowed reviews, and the replacement's Review Run keeps the narrowed roster and records the narrowing", () => {
    const registration = registrationNarrowing(["code-reviewer", "comment-analyzer"]);
    const { graph, run, last } = exhaustedNarrowedRun(registration);
    expect(run.expected_agents).toEqual(["code-reviewer", "comment-analyzer"]);
    const prepared = prepareExhaustedWaveGateRestart(graph, RUN, registration, "run.replacement", "/runs",
      new Set([captureKey(last.slot_id, 2)]), { workspaces: [workspace(graph.tasks[0]!)], issuedRosters: new Map() });
    if (!prepared.ok) throw new Error(prepared.message);
    expect(prepared.value.registration.narrowedReviews).toEqual(registration.narrowedReviews);

    const replacementRun = value(parseOrchestrationRunId("run.replacement"));
    const replacement = prepared.value.registration;
    const batch = value(prepare(prepared.value.graph, replacement, replacementRun));
    expect(batch.subjects.map(({ role }) => role)).toEqual(["spec-check-invoker", last.agent]);
    const rebuilt = installWaveReviewRunsTransition(prepared.value.graph, {
      registration: replacement, batch, workspaces: [workspace(graph.tasks[0]!)], specCheckObservation: documents(),
    });
    if (!rebuilt.ok) throw new Error(rebuilt.error.message);
    const rebuiltRun = rebuilt.value.tasks[0]!.review_run as CurrentReviewRun;
    expect(rebuiltRun.expected_agents).toEqual(["code-reviewer", "comment-analyzer"]);
    expect(rebuiltRun.narrowing).toEqual(run.narrowing);
  });

  it("a replacement registration that differs only in its narrowed reviews is not the same restart registration", () => {
    const registration = registrationNarrowing(["code-reviewer", "comment-analyzer"]);
    const { graph, last } = exhaustedNarrowedRun(registration);
    const prepared = prepareExhaustedWaveGateRestart(graph, RUN, registration, "run.replacement", "/runs",
      new Set([captureKey(last.slot_id, 2)]), { workspaces: [workspace(graph.tasks[0]!)], issuedRosters: new Map() });
    if (!prepared.ok) throw new Error(prepared.message);
    const replacement = prepared.value.registration;
    expect(sameRestartRegistration(replacement, replacement)).toBe(true);
    expect(sameRestartRegistration(replacement, { ...replacement, narrowedReviews: [narrowedTo(["comment-analyzer"])] })).toBe(false);
    const { narrowedReviews: _dropped, ...unnarrowed } = replacement;
    expect(sameRestartRegistration(replacement, unnarrowed as RegisteredWaveGateProgram)).toBe(false);
  });
});
