/** Persistent Wave Gate program driver: the resume reducer. Each invocation
 * re-derives the run's lifecycle from durable state — terminal checkpoint,
 * completion-suite installation, review issuance, attempt-1 evidence,
 * attempt-2 retries, spec-check retry, Refutation Panel, advisory decision —
 * and commits completion of one protected Wave. Every phase lives in its own
 * module and answers with a WavePhase; starting and replacing a run live in
 * wave-gate-start.ts and wave-gate-replacement.ts. */
import { canonicalStructuralEquals } from '../../../core/orchestration-contract';
import { isRecord } from '../../../core/plain-record';
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import { observeTaskGraphProjectBoundary, TASK_GRAPH_PATH } from '../../../config';
import { StateManager } from '../../../state-manager';
import { commitWaveGateCompletion, deriveWaveReadiness } from '../../../core/wave-gate-machine';
import { deriveWaveStartReadiness } from '../../../core/wave-gate-checks';
import { WAVE_REVIEW_AGENTS } from '../../../core/agent-catalog-projections';
import { CURRENT_PI_CATALOG, type PiCatalog } from '../../../core/model-profiles';
import type { RegisteredWaveGateProgram } from '../../../core/wave-gate-program';
import { inspectFilePresence, loadPlanModelsSource } from '../complete-wave-gate';
import { runFullTierWaveLint } from '../lint-wave-gate';
import { ensureWaveCompletionSuite, observeCurrentWaveWorkspace } from '../wave-completion-suite';
import { observeReviewedWorkspace } from '../reviewed-workspace';
import { observeWaveSpecCheckDocuments } from '../../../orchestration/wave-spec-check-documents';
import type { TaskGraph } from '../../../types';
import { waveSpecCheckDocumentsMatch } from '../../../core/wave-review-authority';
import { exactObject } from './registration';
import type { FacadeDriveResult } from './program-result';
import {
  NO_WAVE_REDERIVATIONS,
  reportUncaughtWaveGateFailure,
  spendWaveRederivation,
  waveBlocked,
  waveResumeContext,
  type WavePhase,
  type WaveRederivations,
} from './wave-gate-outcome';
import { driveWaveAdvisoryDecision } from './wave-advisory-decision';
import { driveWaveRefutation } from './wave-refutation';
import { reconcileCurrentReviewEvidence } from './wave-review-collection';
import { issuedWaveProtocol, readRegisteredWaveProgram } from './wave-review-context';
import { reconcileWaveReviewIssuance } from './wave-review-requests';
import { driveWaveReviewRetries, driveWaveSpecCheckRetry } from './wave-review-retries';

const waveGateDeps = Object.freeze({
  loadPlanModels: loadPlanModelsSource,
  filePresence: inspectFilePresence,
  reviewedWorkspace: observeReviewedWorkspace,
});

function currentWaveGateDeps(graph: TaskGraph, authorityStartPath: string) {
  return graph.verification_manifest === undefined
    ? waveGateDeps
    : Object.freeze({
        ...waveGateDeps,
        currentWaveWorkspace: observeCurrentWaveWorkspace(graph, authorityStartPath),
      });
}

/** Canonical structural equality to a typed witness proves the raw value carries the witness's type. */
const provenEqualTo = <T>(witness: T, raw: unknown): raw is T => canonicalStructuralEquals(witness, raw);

function verifyCompletedWaveProtocols(handle: RunDirHandle, registration: RegisteredWaveGateProgram): void {
  const requests = handle.readIssuedRequests();
  if (!requests.ok) throw new Error(requests.error.message);
  const protocols = requests.value.filter(({ program, role }) => program === "wave-gate" && role !== "spec-check-invoker")
    .map((request) => issuedWaveProtocol(handle, registration, request));
  for (const taskId of registration.taskIds) {
    if (WAVE_REVIEW_AGENTS.some((role) => !protocols.some((protocol) =>
      protocol.subject.taskId === taskId && protocol.request.role === role))) {
      throw new Error(`completed Wave Task ${taskId} lacks the complete published reviewer protocol roster`);
    }
  }
}

/**
 * Resume a Wave Gate run. `catalog` is the catalog a Refutation Panel with no
 * record is minted under: today's in production; a replay of a run written
 * before a catalog retargeting passes the catalog as it stood
 * (`piCatalogAsOf`).
 */
export function resumeWaveGateFacade(
  handle: RunDirHandle,
  registration: RegisteredWaveGateProgram,
  catalog: PiCatalog = CURRENT_PI_CATALOG,
): Promise<FacadeDriveResult> {
  return resumeWaveGateAfter(handle, registration, catalog, NO_WAVE_REDERIVATIONS);
}

/** One reducer pass of an invocation that has already made `spent` re-derivations. */
async function resumeWaveGateAfter(
  handle: RunDirHandle,
  registration: RegisteredWaveGateProgram,
  catalog: PiCatalog,
  spent: WaveRederivations,
): Promise<FacadeDriveResult> {
  // Durable progress was consumed: re-enter the reducer, spending one
  // re-derivation, or block once the invocation's budget is spent.
  const rederiveNext = (): Promise<FacadeDriveResult> | FacadeDriveResult => {
    const next = spendWaveRederivation(spent);
    return next.ok ? resumeWaveGateAfter(handle, registration, catalog, next.value) : waveBlocked(handle, next.error);
  };
  // A settled phase answers this invocation; a rederive phase re-derives.
  const conclude = (phase: Exclude<WavePhase<unknown>, Readonly<{ kind: "proceed" }>>): Promise<FacadeDriveResult> | FacadeDriveResult =>
    phase.kind === "settled" ? phase.result : rederiveNext();
  try {
    const registered = readRegisteredWaveProgram(handle);
    if (!canonicalStructuralEquals(registered, registration)) {
      return waveBlocked(handle, "supplied Wave registration differs from durable protocol authority");
    }
    const manager = new StateManager(TASK_GRAPH_PATH);
    const graph = manager.load();
    const terminal = await handle.readCheckpoint();
    if (terminal !== null) {
      let raw: unknown;
      try { raw = JSON.parse(terminal); }
      catch (error) { return waveBlocked(handle, `Wave Gate checkpoint is invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
      if (!isRecord(raw)) {
        return waveBlocked(handle, "Wave Gate checkpoint must be a typed object");
      }
      if (raw.kind === "wave-gate-done") {
        verifyCompletedWaveProtocols(handle, registration);
        if (!exactObject(raw, ["schemaVersion", "kind", "receipt"]) || raw.schemaVersion !== 1) {
          return waveBlocked(handle, "terminal Wave Gate checkpoint has invalid schema");
        }
        const receipt = raw.receipt;
        const history = graph.wave_gate_history?.find((entry) => entry.runId === handle.runId);
        if (history === undefined || !provenEqualTo(history.completionReceipt, receipt)) {
          return waveBlocked(handle, "terminal Wave Gate checkpoint does not match protected completion history");
        }
        return { ok: true, action: { kind: "done", runId: handle.runId, outcome: receipt } };
      }
      return waveBlocked(handle, `unknown or non-terminal Wave Gate checkpoint kind: ${String(raw.kind ?? "missing")}`);
    }
    // Completion crash-window recovery: the graph commit is atomic and durable
    // BEFORE the terminal checkpoint is written, so a crash between
    // commitActiveWaveGateCompletion and writeCheckpoint leaves the run with a
    // retired active authority, a completed wave_gate_history entry, and NO
    // checkpoint. The history entry is the authoritative completion record —
    // heal the missing checkpoint from it and report done instead of blocking
    // forever on the already-retired active authority.
    const completed = graph.wave_gate_history?.find((entry) =>
      entry.runId === handle.runId && entry.wave === registration.input.wave &&
      entry.authorityDigest === registration.authorityDigest);
    if (completed !== undefined) {
      verifyCompletedWaveProtocols(handle, registration);
      await handle.writeCheckpoint(JSON.stringify({
        schemaVersion: 1,
        kind: "wave-gate-done",
        receipt: completed.completionReceipt,
      }));
      return { ok: true, action: { kind: "done", runId: handle.runId, outcome: completed.completionReceipt } };
    }
    const active = graph.active_wave_gate;
    if (active === undefined || active.runId !== handle.runId || active.wave !== registration.input.wave ||
        active.authorityDigest !== registration.authorityDigest || active.terminalOutcome !== null) {
      return waveBlocked(handle, "protected active Wave Gate authority differs from the registered façade run");
    }
    if (graph.wave_review_epoch !== undefined) {
      const currentDocuments = observeWaveSpecCheckDocuments({
        specFile: graph.spec_file,
        planFile: graph.plan_file,
        projectBoundary: observeTaskGraphProjectBoundary(manager.getPath()),
      }).authority;
      if (!waveSpecCheckDocumentsMatch(graph.wave_review_epoch.specCheckDocuments, currentDocuments)) {
        return waveBlocked(handle, "current spec/plan bytes differ from the active Wave spec-check authority; refresh spec-check evidence");
      }
    }
    if (graph.current_wave !== registration.input.wave) {
      return waveBlocked(handle, `active Wave Gate wave ${registration.input.wave} does not match current wave ${graph.current_wave ?? "missing"}`);
    }
    const startReadiness = deriveWaveStartReadiness(graph, graph.tasks.filter((task) => task.wave === registration.input.wave));
    if (startReadiness.kind === "not-ready") return waveBlocked(handle, startReadiness.failures.join("; "));

    if (graph.verification_manifest !== undefined) {
      const ensured = await ensureWaveCompletionSuite({ handle, manager, graph, registration });
      if (!ensured.ok) {
        return {
          ok: true,
          action: {
            kind: "blocked",
            runId: handle.runId,
            diagnostic: ensured.error.diagnostic,
          },
        };
      }
      if (ensured.value.disposition === "installed") return rederiveNext();
    }

    const issued = handle.readIssuedRequests();
    const captured = handle.readCapturedAttempts();
    if (!issued.ok) return waveBlocked(handle, issued.error.message);
    if (!captured.ok) return waveBlocked(handle, captured.error.message);
    const resumed = waveResumeContext(handle, manager, registration, captured.value);
    if (resumed.kind !== "proceed") return conclude(resumed);
    const context = resumed.value;
    const issuance = await reconcileWaveReviewIssuance(context, graph, issued.value);
    if (issuance.kind !== "proceed") return conclude(issuance);
    const collection = await reconcileCurrentReviewEvidence(context, issuance.value);
    if (collection.kind !== "proceed") return conclude(collection);
    const { currentIssued } = issuance.value;
    const retries = await driveWaveReviewRetries(context, currentIssued);
    if (retries.kind !== "proceed") return conclude(retries);
    const specCheck = await driveWaveSpecCheckRetry(context, currentIssued);
    if (specCheck.kind !== "proceed") return conclude(specCheck);
    const refreshed = specCheck.value;
    if (registration.schemaVersion === 2 && refreshed.tasks.some((task) => {
      if (!registration.taskIds.includes(task.id)) return false;
      const accepted = task.accepted_review_authority;
      return accepted?.run_id !== handle.runId || accepted.authority_digest !== registration.authorityDigest ||
        accepted.generation !== (task.review_generation ?? 0) ||
        !canonicalStructuralEquals(accepted.reviewer_protocol, registration.reviewerProtocol);
    })) return waveBlocked(handle, "current Wave review lacks exact accepted reviewer protocol authority");
    const current = deriveWaveReadiness(refreshed, currentWaveGateDeps(refreshed, handle.runDirectory));
    if (!current.ok) return waveBlocked(handle, current.error.reasons.map(({ message }) => message).join("; "));
    const refutation = await driveWaveRefutation(context, current.value, catalog);
    if (refutation.kind !== "proceed") return conclude(refutation);
    const advisory = await driveWaveAdvisoryDecision(handle, current.value);
    if (advisory.kind !== "proceed") return conclude(advisory);
    const drive = advisory.value;
    if (drive.kind === "blocked") return waveBlocked(handle, drive.message);
    if (drive.kind !== "ready-to-complete") {
      return waveBlocked(handle, `Wave Gate lifecycle produced unexpected drive step ${drive.kind}`);
    }
    const lint = runFullTierWaveLint(current.value.waveTasks);
    if (lint.kind === "block") return waveBlocked(handle, lint.message);
    const completionDocuments = observeWaveSpecCheckDocuments({
      specFile: refreshed.spec_file,
      planFile: refreshed.plan_file,
      projectBoundary: observeTaskGraphProjectBoundary(manager.getPath()),
    }).authority;
    const committed = await manager.commitActiveWaveGateCompletion((locked) => {
      if (locked.spec_file !== refreshed.spec_file || locked.plan_file !== refreshed.plan_file ||
          !waveSpecCheckDocumentsMatch(locked.wave_review_epoch?.specCheckDocuments, completionDocuments)) {
        return {
          ok: false as const,
          error: {
            kind: "wave-completion-commit-rejected" as const,
            message: "spec/plan authority changed before Wave completion commit",
          },
        };
      }
      const lockedReadiness = deriveWaveReadiness(locked, currentWaveGateDeps(locked, handle.runDirectory));
      return lockedReadiness.ok ? commitWaveGateCompletion(lockedReadiness.value) : {
        ok: false as const,
        error: { kind: "wave-completion-commit-rejected" as const, message: lockedReadiness.error.reasons.map(({ message }) => message).join("; ") },
      };
    });
    await handle.writeCheckpoint(JSON.stringify({ schemaVersion: 1, kind: "wave-gate-done", receipt: committed.receipt }));
    return { ok: true, action: { kind: "done", runId: handle.runId, outcome: committed.receipt } };
  } catch (error) {
    return waveBlocked(handle, reportUncaughtWaveGateFailure(handle.runId, error));
  }
}
