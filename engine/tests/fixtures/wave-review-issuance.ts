/**
 * Wave review issuance fixtures: a project holding a plan file, a Wave 1
 * TaskGraph proven by the production parser, and the batch
 * `prepareWaveReviewBatch` issues for it over observed bytes, with readers for
 * the packets and sections of that batch.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ContextPacket } from "../../src/core/context-packets";
import { parseOrchestrationRunId, type DomainResult } from "../../src/core/orchestration-contract";
import { CURRENT_REVIEWER_PROTOCOL } from "../../src/core/reviewer-contract";
import {
  prepareWaveReviewBatch,
  taskReviewScope,
  waveReviewView,
  type WaveRequestBatch,
  type WaveReviewPreparationError,
  type WaveReviewRegistrationAuthority,
} from "../../src/core/wave-review-authority";
import { observeWaveSpecCheckDocuments } from "../../src/orchestration/wave-spec-check-documents";
import type { Task, TaskGraph } from "../../src/types";
import { canonicalTempDir } from "./canonical-temp-dir";
import { observedWorkspace } from "./reviewed-workspace";
import { protectedGraphFixture, taskFixture } from "./task-lifecycle";

/** A fresh project root holding `planFile`; the root is pushed onto `cleanup`. */
export function projectWithPlanFile(prefix: string, planFile: string, cleanup: string[]): string {
  const root = canonicalTempDir(prefix);
  cleanup.push(root);
  mkdirSync(dirname(join(root, planFile)), { recursive: true });
  writeFileSync(join(root, planFile), "# Plan\n");
  return root;
}

/** An implemented Wave 1 Task that declared and modified exactly `files`. */
export const reviewedTaskFixture = (id: string, files: readonly string[]): Task => taskFixture({
  id, description: `Reviewed Task ${id}`, agent: "code-implementer-agent", wave: 1,
  status: "implemented", depends_on: [], spec_anchors: [], spec_contributions: [],
  file_list: [...files], files_modified: [...files],
});

/** A Wave 1 execute-phase TaskGraph over `tasks`, with `stamps` as further State File fields. */
export function reviewGraphFixture(
  planFile: string | null,
  tasks: readonly Task[],
  stamps: Readonly<Record<string, unknown>> = {},
): TaskGraph {
  return protectedGraphFixture({
    spec_trace_version: 2, current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [],
    spec_file: null, plan_file: planFile, wave_gates: {}, ...stamps, tasks,
  });
}

/** A Wave 1 gate registration over `taskIds`, at the given reviewer protocol schema. */
export const waveRegistrationFixture = (schemaVersion: 1 | 2, taskIds: readonly string[]): WaveReviewRegistrationAuthority => ({
  kind: "wave-gate",
  input: { wave: 1 },
  taskIds,
  authorityDigest: "a".repeat(64),
  ...(schemaVersion === 2
    ? { schemaVersion: 2 as const, reviewerProtocol: CURRENT_REVIEWER_PROTOCOL }
    : { schemaVersion: 1 as const }),
});

/**
 * Prepare the attempt-1 batch of `graph`'s Wave 1 under `root`: every Task is
 * registered, and every reviewed one is observed holding `// <path>` at each
 * path of its review scope.
 */
export function prepareWaveBatchFixture(
  root: string,
  graph: TaskGraph,
  schemaVersion: 1 | 2 = 2,
): DomainResult<WaveRequestBatch, WaveReviewPreparationError> {
  const runId = parseOrchestrationRunId("run.wave-review-fixture");
  if (!runId.ok) throw new Error(runId.error.message);
  const documents = observeWaveSpecCheckDocuments({
    specFile: null,
    planFile: graph.plan_file ?? null,
    projectBoundary: Object.freeze({ kind: "state-layout" as const, root }),
  });
  const workspace = waveReviewView(graph.tasks).reviewed.map((task) => {
    const scope = taskReviewScope(task);
    return observedWorkspace(task.id, scope, scope.map((path) => ({ path, bytes: Buffer.from(`// ${path}\n`) })));
  });
  const registration = waveRegistrationFixture(schemaVersion, graph.tasks.map(({ id }) => id));
  return prepareWaveReviewBatch(runId.value, registration, graph, 1, workspace, documents);
}

/** `prepareWaveBatchFixture`, for a graph the fixture expects issuance to admit. */
export function issueWaveBatchFixture(root: string, graph: TaskGraph, schemaVersion: 1 | 2 = 2): WaveRequestBatch {
  const batch = prepareWaveBatchFixture(root, graph, schemaVersion);
  if (!batch.ok) throw new Error(`issuance refused: ${batch.error.message}`);
  return batch.value;
}

/** The text of the packet's fixed section labelled `label`, or null when it carries none. */
export const sectionTextOf = (packet: ContextPacket, label: string): string | null => {
  const section = packet.fixedContext.find((candidate) => candidate.label === label);
  return section === undefined ? null : Buffer.from(section.bytes).toString("utf8");
};

/** The batch's packet for `role` on `taskId` (null for the spec-check subject). */
export function packetOf(batch: WaveRequestBatch, role: string, taskId: string | null): ContextPacket {
  const packet = batch.packets[batch.subjects.findIndex((subject) => subject.role === role && subject.taskId === taskId)];
  if (packet === undefined) throw new Error(`the batch issued no ${role} packet for ${taskId ?? "the Wave"}`);
  return packet;
}

/** The packet digests of a batch, which are the requests' retry identity. */
export const packetDigests = (batch: WaveRequestBatch): readonly string[] => batch.packets.map(({ digest }) => digest);
