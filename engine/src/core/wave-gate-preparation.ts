/**
 * Wave Gate post-review preparation — deriving the external actions a Wave
 * Gate run owes once its review roster has landed: the Refutation Panel for
 * active critical Findings, and the user's advisory decision.
 *
 * Every derivation starts from a canonical readiness snapshot
 * (`wave-gate-machine`), so Findings, lenses and advisory bytes are selected
 * by protected authority alone. Verifier slots are not derived here: the
 * shared verifier-issuance seam issues them from the refutation plan.
 */

import type { Task, WaveGateNextAction } from "../types";
import { sha256Bytes, sha256Hex } from "./digest";
import {
  awaitUserAction,
  canonicalRecord,
  parseArtifactByteLength,
  parseArtifactDigest,
  parseArtifactRef,
  parseContextDigest,
  parseOrchestrationRunId,
  parseRequestId,
  type ArtifactRef,
  type ContextDigest,
  type DomainResult,
  type NonEmpty,
  type OrchestrationRunId,
  type RequestId,
} from "./orchestration-contract";
import {
  buildFindingBrief,
  reviewSignals,
  selectReviewLenses,
  type BriefFinding,
  type ReviewLens,
} from "./review-panel";
import {
  isCanonicalWaveReadiness,
  projectWaveGateLifecycle,
  proveWaveGateNextAction,
  type WaveGateState,
  type WaveReadinessSnapshot,
} from "./wave-gate-machine";

export type WavePreparationError = Readonly<{
  kind: "wave-preparation-rejected";
  message: string;
}>;

const preparationFailure = <T>(message: string): DomainResult<T, WavePreparationError> =>
  canonicalRecord({ ok: false, error: canonicalRecord({ kind: "wave-preparation-rejected", message }) });

export type WaveRefutationPlan = Readonly<{
  runId: OrchestrationRunId;
  findings: NonEmpty<BriefFinding>;
  lenses: NonEmpty<ReviewLens>;
}>;

/**
 * Derive the idempotent run/finding/lens authority before request issuance.
 * The panel's verifier requests are issued from this plan by the one
 * verifier-issuance seam every Refutation Panel shares
 * (`handlers/helpers/programs/refutation-verifiers.ts`), which mints them
 * over their Context Packets or reads them back from the panel's record.
 */
export function deriveWaveRefutationPlan(
  snapshot: WaveReadinessSnapshot,
): DomainResult<WaveRefutationPlan, WavePreparationError> {
  if (!isCanonicalWaveReadiness(snapshot)) return preparationFailure("refutation preparation requires canonical readiness");
  const collecting = snapshot.waveTasks.filter(({ review_run }) => review_run !== undefined);
  if (collecting.length > 0) {
    return preparationFailure(
      `current Review Packet evidence must complete before refutation: ${collecting.map(({ id, review_run }) =>
        `${id}/${review_run!.packet_id}`).join(", ")}`,
    );
  }
  const unreviewed = snapshot.waveTasks.filter(({ review_status }) =>
    review_status !== "passed" && review_status !== "blocked");
  if (unreviewed.length > 0) {
    return preparationFailure(
      `current-generation review evidence must complete before refutation: ${unreviewed.map(({ id }) => id).join(", ")}`,
    );
  }
  const brief = buildFindingBrief(snapshot.wave, snapshot.graph.tasks);
  if (brief.findings.length === 0) return preparationFailure("an empty critical Finding set cannot start a Refutation Panel");
  const lenses = selectReviewLenses(reviewSignals(brief.findings), 3);
  if (!lenses.ok || lenses.value.length === 0) return preparationFailure(lenses.ok ? "no review lenses were derived" : lenses.errors.join("; "));
  const digest = sha256Hex(
    `${snapshot.registration.runId}|${snapshot.readinessDigest}|${brief.findings.map(({ id }) => id).join("|")}|${lenses.value.join("|")}`,
  );
  const panelRun = parseOrchestrationRunId(`wave-refutation:${digest.slice(0, 32)}`);
  if (!panelRun.ok) return preparationFailure(panelRun.error.message);
  return canonicalRecord({ ok: true, value: canonicalRecord({
    runId: panelRun.value,
    findings: Object.freeze(brief.findings) as NonEmpty<BriefFinding>,
    lenses: Object.freeze(lenses.value) as NonEmpty<ReviewLens>,
  }) });
}

export type WaveAdvisoryArtifactMaterial = Readonly<{
  reference: ArtifactRef;
  bytes: readonly number[];
}>;

export type WaveAdvisoryDecisionRequest = Readonly<{
  requestId: RequestId;
  decisionDigest: ContextDigest;
  context: Readonly<{
    digest: ContextDigest;
    slot: Readonly<{ kind: "fixed-artifact-slot"; path: string }>;
    bytes: readonly number[];
  }>;
  advisories: NonEmpty<WaveAdvisoryArtifactMaterial>;
}>;

const waveAdvisoryDecisionMaterialProofs = new WeakSet<object>();

/** Strip publication bytes only from the exact material set derived by core. */
export function waveAdvisoryDecisionActionRequest(
  material: WaveAdvisoryDecisionRequest,
): DomainResult<Readonly<{
  kind: "advisory-triage";
  requestId: RequestId;
  runId: OrchestrationRunId;
  context: Readonly<{
    digest: ContextDigest;
    slot: Readonly<{ kind: "fixed-artifact-slot"; path: string }>;
  }>;
  advisories: NonEmpty<ArtifactRef>;
}>, WavePreparationError> {
  if (!waveAdvisoryDecisionMaterialProofs.has(material) || material.decisionDigest !== material.context.digest) {
    return preparationFailure("advisory action requires one exact core-derived decision material set");
  }
  return canonicalRecord({ ok: true, value: canonicalRecord({
    kind: "advisory-triage" as const,
    requestId: material.requestId,
    runId: material.advisories[0].reference.runId,
    context: canonicalRecord({ digest: material.context.digest, slot: material.context.slot }),
    advisories: Object.freeze(material.advisories.map(({ reference }) => reference)) as NonEmpty<ArtifactRef>,
  }) });
}

/** One pure source for advisory bytes, references, and request identity. */
export function deriveWaveAdvisoryDecisionRequest(
  rawRunId: string,
  tasks: readonly Task[],
): DomainResult<WaveAdvisoryDecisionRequest, WavePreparationError> {
  const runId = parseOrchestrationRunId(rawRunId);
  if (!runId.ok) return preparationFailure(runId.error.message);
  const canonicalAdvisories = tasks.flatMap((task) => {
    if (task.findings !== undefined) {
      return task.findings.filter((finding) => finding.severity === "advisory").map((finding) => ({
        identity: `${task.id}:${finding.id}`,
        bytes: Object.freeze([...new TextEncoder().encode(JSON.stringify({ taskId: task.id, finding }))]),
      }));
    }
    return (task.advisory_findings ?? []).filter((claim) => claim.trim() !== "").map((claim, index) => ({
      identity: `${task.id}:legacy-advisory-${index + 1}`,
      bytes: Object.freeze([...new TextEncoder().encode(JSON.stringify({ taskId: task.id, claim }))]),
    }));
  });
  if (canonicalAdvisories.length === 0) return preparationFailure("no canonical advisories require user triage");

  const advisories: WaveAdvisoryArtifactMaterial[] = [];
  for (const { identity, bytes } of canonicalAdvisories) {
    const byteLength = parseArtifactByteLength(bytes.length);
    const digest = parseArtifactDigest(sha256Bytes(Uint8Array.from(bytes)));
    if (!byteLength.ok) return preparationFailure(byteLength.error.message);
    if (!digest.ok) return preparationFailure(digest.error.message);
    const reference = parseArtifactRef({
      runId: runId.value,
      slot: canonicalRecord({
        kind: "fixed-artifact-slot",
        path: `artifacts/advisories/${identity.replace(/[^A-Za-z0-9_.-]+/g, "-")}.json`,
      }),
      digest: digest.value,
      byteLength: byteLength.value,
    });
    if (!reference.ok) return preparationFailure(reference.error.message);
    advisories.push(canonicalRecord({ reference: reference.value, bytes }));
  }

  const contextBytes = Object.freeze([...new TextEncoder().encode(JSON.stringify(canonicalRecord({
    schemaVersion: 1,
    kind: "wave-advisory-decision-context",
    runId: runId.value,
    advisories: advisories.map(({ reference }) => reference),
  })))]);
  const contextDigest = parseContextDigest(sha256Bytes(Uint8Array.from(contextBytes)));
  if (!contextDigest.ok) return preparationFailure(contextDigest.error.message);
  const requestId = parseRequestId(`advisory-decision:${contextDigest.value.slice(0, 32)}`);
  if (!requestId.ok) return preparationFailure(requestId.error.message);
  const material = canonicalRecord({
    requestId: requestId.value,
    decisionDigest: contextDigest.value,
    context: canonicalRecord({
      digest: contextDigest.value,
      slot: canonicalRecord({ kind: "fixed-artifact-slot" as const, path: `contexts/${contextDigest.value}.json` }),
      bytes: contextBytes,
    }),
    advisories: Object.freeze(advisories) as NonEmpty<WaveAdvisoryArtifactMaterial>,
  });
  waveAdvisoryDecisionMaterialProofs.add(material);
  return canonicalRecord({ ok: true, value: material });
}

export type WaveGateDriveStep =
  | Readonly<{
      kind: "await-advisory-decision";
      material: WaveAdvisoryDecisionRequest;
      state: Extract<WaveGateState, { kind: "awaiting-advisory-decision" }>;
    }>
  | Readonly<{
      kind: "ready-to-complete";
      state: Extract<WaveGateState, { kind: "ready-to-complete" }>;
    }>
  | Readonly<{ kind: "blocked"; message: string; state: WaveGateState }>;

/**
 * Pure driver intent for the post-review Wave Gate seam.
 *
 * The shell supplies only the durable user-decision observation. Canonical
 * Finding counts, stage transitions, advisory material, and completion
 * eligibility all stay behind LC-1, so status and resume cannot grow separate
 * advisory-stage predicates.
 */
export function deriveWaveGateDriveStep(
  snapshot: WaveReadinessSnapshot,
  advisoryApproved: boolean,
): DomainResult<WaveGateDriveStep, WavePreparationError> {
  if (!isCanonicalWaveReadiness(snapshot)) {
    return preparationFailure("Wave Gate drive requires canonical readiness");
  }
  const counts = snapshot.facts.findingCounts;
  if (counts.kind !== "known") return preparationFailure("Wave Gate drive lacks canonical Finding counts");
  const projected = projectWaveGateLifecycle(snapshot, canonicalRecord({
    batchPublished: true,
    acceptedResults: 0,
    rejectedAttempt: null,
    rosterComplete: true,
    activeCritical: counts.value.activeCritical,
    advisoryCount: counts.value.advisory,
    advisoryApproved,
    committed: null,
  }));
  if (!projected.ok) return preparationFailure(projected.error.message);
  const state = projected.value;
  if (state.kind === "awaiting-advisory-decision") {
    const material = deriveWaveAdvisoryDecisionRequest(snapshot.registration.runId, snapshot.waveTasks);
    return material.ok
      ? canonicalRecord({ ok: true, value: canonicalRecord({ kind: "await-advisory-decision", material: material.value, state }) })
      : material;
  }
  if (state.kind === "ready-to-complete" && snapshot.gateDecision.verdict.kind === "pass") {
    return canonicalRecord({ ok: true, value: canonicalRecord({ kind: "ready-to-complete", state }) });
  }
  const message = snapshot.gateDecision.verdict.kind === "fail"
    ? snapshot.gateDecision.verdict.reason
    : `Wave Gate lifecycle reached ${state.kind}, not a post-review drive state`;
  return canonicalRecord({ ok: true, value: canonicalRecord({ kind: "blocked", message, state }) });
}

/** Advisory policy remains user-owned. The engine derives whether the action
 * exists from canonical advisory counts and only accepts the exact Wave/run-
 * scoped advisory request. */
export function deriveWaveAdvisoryNextAction(
  snapshot: WaveReadinessSnapshot,
  state: Extract<WaveGateState, { kind: "awaiting-advisory-decision" }>,
): DomainResult<WaveGateNextAction, WavePreparationError> {
  if (!isCanonicalWaveReadiness(snapshot) || state.runId !== snapshot.registration.runId) {
    return preparationFailure("advisory action requires canonical readiness for this lifecycle run");
  }
  const request = deriveWaveAdvisoryDecisionRequest(snapshot.registration.runId, snapshot.waveTasks);
  if (!request.ok) return request;
  const actionRequest = waveAdvisoryDecisionActionRequest(request.value);
  if (!actionRequest.ok) return actionRequest;
  const built = awaitUserAction(actionRequest.value);
  if (!built.ok) return preparationFailure(built.error.message);
  const proven = proveWaveGateNextAction(snapshot, state, built.value);
  return proven.ok ? canonicalRecord({ ok: true, value: proven.value }) : preparationFailure(proven.error.message);
}
