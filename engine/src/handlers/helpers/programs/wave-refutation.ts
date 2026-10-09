/**
 * The Wave Refutation Panel: when the current Wave carries active critical
 * Findings, adjudicate them through the persistent refutation panel — issue or
 * recover verifier requests, replay captured verdicts and terminal capture
 * rejections, then commit refuted outcomes under exact active authority.
 */
import { defaultRefutationThreshold, type FindingOutcome } from '../../../core/review-panel';
import { completePersistentRefutationPanel, panelRequestIdentity, rejectRefutationVerdict, startPersistentRefutationPanel, submitRefutationVerdict } from '../../../core/persistent-panel';
import { buildContextPacket, encodeByteSection } from '../../../core/context-packets';
import { captureKey } from '../../../core/harness-capture';
import type { RunDirHandle } from '../../../orchestration/run-directory-handle';
import { deriveWaveReadiness } from '../../../core/wave-gate-machine';
import { deriveWaveRefutationPlan } from '../../../core/wave-gate-preparation';
import { applyFindingOutcomes } from '../../../core/findings';
import { reconcileWaveBlock } from '../../../core/wave-gate-model';
import { decideRefutationTranscriptRead, refutationRejectionDiagnostic } from '../../../core/reviewer-retry';
import { waveRefutationCommitProblem } from '../../../core/wave-gate-membership';
import { durableCaptureRejection, durableRefutationRequests, publicationResolver } from './durable-requests';
import { failed } from './program-result';
import { executableRefutationRequests, recoverOrPublishRefutationRetry } from './refutation-requests';
import { prepareRefutationVerifiers } from './refutation-verifiers';
import { publishLegacyInitialBatch } from './request-publication';
import { proceed, rederive, settled, waveBlocked, type WavePhase, type WaveResumeContext } from './wave-gate-outcome';

type WaveReadiness = Extract<ReturnType<typeof deriveWaveReadiness>, { ok: true }>["value"];

/**
 * The current Wave's Refutation Panel. Its verifier requests are read from
 * the durable attempt-1 batch receipt when one exists and minted from today's
 * catalog only when none does (`prepareRefutationVerifiers`), so resuming a
 * panel issued under an older catalog compares recorded history with itself.
 */
function waveRefutationPreparation(
  handle: RunDirHandle,
  readiness: WaveReadiness,
) {
  const plan = deriveWaveRefutationPlan(readiness);
  if (!plan.ok) throw new Error(plan.error.message);
  const verifiers = prepareRefutationVerifiers({
    handle,
    label: "wave-refutation",
    identityRunId: plan.value.runId,
    findings: plan.value.findings,
    lenses: plan.value.lenses,
    packet: (lens, requestId, attempt) => {
      const section = encodeByteSection("wave-refutation-authority", JSON.stringify({
        panelRunId: plan.value.runId, lens, findings: plan.value.findings, attempt,
      }));
      if (!section.ok) throw new Error(section.error.message);
      const packet = buildContextPacket({ requestId, role: "review-verifier-agent", requiredSkill: "none",
        outputContract: `Adjudicate every Wave Finding through lens '${lens}' and emit exact refutation verdict JSON.`,
        fixedContext: [section.value], variableContext: [] });
      if (!packet.ok) throw new Error(packet.error.message);
      return packet.value;
    },
  });
  return { ...verifiers, threshold: defaultRefutationThreshold(plan.value.lenses.length) };
}

/**
 * Resume phase: adjudicate the current Wave's active critical Findings.
 * Proceeds unchanged when there are none, or when every adjudicated critical
 * was upheld; re-derives once a refutation retired at least one Finding.
 */
export async function driveWaveRefutation(
  context: WaveResumeContext,
  current: WaveReadiness,
): Promise<WavePhase> {
  const { handle, manager, registration } = context;
  if (!(current.facts.findingCounts.kind === "known" && current.facts.findingCounts.value.activeCritical > 0)) {
    return proceed();
  }
  const preparation = waveRefutationPreparation(handle, current);
  const resolver = publicationResolver(handle);
  const recovered = durableRefutationRequests(handle, preparation.inputs, resolver, "wave-refutation");
  if (recovered.kind === "corrupt") return settled(waveBlocked(handle, recovered.message));
  if (recovered.kind === "absent") {
    // Panel verdicts are the explicit extraction-only publication route:
    // the refutation batch carries no reviewer emission authority, so the
    // shared core renders every task with the caller's instruction verbatim.
    const published = await publishLegacyInitialBatch(handle, preparation.inputs, preparation.packets, "wave-refutation");
    return settled(published.ok ? { ok: true, action: published.action } : failed(published.message));
  }
  const requests = recovered.requests;
  const panelCaptured = handle.readCapturedAttempts();
  if (!panelCaptured.ok) return settled(waveBlocked(handle, panelCaptured.error.message));
  // A durable harness capture rejection is a completed FAILED attempt, not
  // an invitation to respawn attempt 1 forever — the same class-2
  // trichotomy the Wave reviewer slots and the standalone program's
  // decideAttemptOneSlots phase apply. A slot whose attempt-1 capture the
  // harness terminally rejected (no bytes can ever land) is tombstoned
  // here and routed into the panel's own rejection path in the replay
  // loop below, which re-issues its attempt-2 retry; only genuinely
  // un-delivered slots are re-issued at attempt 1.
  const missing = requests.filter((request) => !panelCaptured.value.has(captureKey(request.authority.slotId, request.authority.attempt)));
  const rejectionReceipts = new Map<string, string>();
  for (const request of missing) {
    const rejection = await durableCaptureRejection(handle, request.authority);
    if (rejection !== null) rejectionReceipts.set(request.authority.slotId, rejection);
  }
  const reissues = missing.filter((request) => !rejectionReceipts.has(request.authority.slotId));
  if (reissues.length > 0) {
    return settled({
      ok: true,
      action: { kind: "spawn-batch", runId: handle.runId, requests: executableRefutationRequests(handle, reissues, false) },
    });
  }
  let panelState = startPersistentRefutationPanel(preparation.panel).state;
  for (const request of requests) {
    const transcript = decideRefutationTranscriptRead(
      handle.readTranscriptBytes(request.authority),
      rejectionReceipts.get(request.authority.slotId),
    );
    if (transcript.kind === "infrastructure-failure") return settled(failed(transcript.message));
    // A tombstoned attempt-1 slot has no evidence: the capture runtime
    // terminally rejected the attempt, so there is no verdict to parse.
    // Only that explicit tombstone advances the slot through the panel's
    // semantic rejection path; an unreadable captured transcript returned
    // above as infrastructure failure and cannot consume a retry.
    let submitted = transcript.kind === "verdict"
      ? submitRefutationVerdict(panelState, resolver, panelRequestIdentity(request), transcript.transcript)
      : rejectRefutationVerdict(panelState, resolver, panelRequestIdentity(request), transcript.diagnostic);
    if (!submitted.ok) return settled(waveBlocked(handle, submitted.error.message));
    panelState = submitted.value.state;
    if (submitted.value.action?.kind === "spawn-refutation-verifiers") {
      const retryAuthority = submitted.value.action.requests[0];
      const retry = await recoverOrPublishRefutationRetry(
        handle, retryAuthority, preparation.retryInputs, resolver, "wave-refutation",
      );
      if (!retry.ok) {
        // The attempt-2 capture was TERMINALLY rejected: the capture runtime
        // refuses any future capture for this slot, so re-issuing the spawn
        // can never land evidence — that is the attempt-2 doom loop this
        // exists to break. Attempt 2 is the FINAL attempt, so the panel
        // machine records the rejection as an explicit panel rejection
        // (terminal-blocked) instead of the resume blocking on the same raw
        // recovery error forever — the same terminal path a semantic
        // attempt-2 rejection already takes.
        if (retry.kind !== "capture-rejected" || retry.request === null) return settled(waveBlocked(handle, retry.message));
        submitted = rejectRefutationVerdict(panelState, resolver, panelRequestIdentity(retry.request), retry.rejection);
        if (!submitted.ok) return settled(waveBlocked(handle, submitted.error.message));
        if (submitted.value.action?.kind === "refutation-blocked") {
          return settled(waveBlocked(handle, `Wave refutation panel terminally blocked: ${submitted.value.action.diagnostic.message}`));
        }
        return settled(waveBlocked(handle, "refutation capture rejection did not terminal-block the panel"));
      }
      const attempts = handle.readCapturedAttempts();
      if (!attempts.ok) return settled(waveBlocked(handle, attempts.error.message));
      if (!attempts.value.has(captureKey(retry.request.authority.slotId, retry.request.authority.attempt))) {
        return settled({ ok: true, action: {
          kind: "spawn-batch", runId: handle.runId,
          requests: executableRefutationRequests(
            handle, [retry.request], false, refutationRejectionDiagnostic(submitted.value.recordedEvent),
          ),
        } });
      }
      const retryBytes = handle.readTranscriptBytes(retry.request.authority);
      if (!retryBytes.ok) return settled(waveBlocked(handle, retryBytes.error.message));
      submitted = submitRefutationVerdict(
        panelState, resolver, panelRequestIdentity(retry.request), Buffer.from(retryBytes.value).toString("utf8"),
      );
      if (!submitted.ok) return settled(waveBlocked(handle, submitted.error.message));
      panelState = submitted.value.state;
      if (submitted.value.action?.kind === "refutation-blocked") {
        return settled(waveBlocked(handle, submitted.value.action.diagnostic.message));
      }
    }
  }
  const completed = completePersistentRefutationPanel(panelState, resolver, preparation.threshold);
  if (!completed.ok || completed.value.state.stage !== "done") {
    return settled(waveBlocked(handle, completed.ok ? "Wave Refutation Panel did not reach done" : completed.error.message));
  }
  const donePanel = completed.value.state;
  const refutingOutcomes = donePanel.decision.outcomes.filter(
    (outcome): outcome is Extract<FindingOutcome, { survives: false }> => !outcome.survives,
  );
  if (refutingOutcomes.length > 0) {
    await manager.update((locked) => {
      const authorityProblem = waveRefutationCommitProblem(
        locked,
        registration,
        current.registration,
        preparation.panel,
      );
      if (authorityProblem !== null) throw new Error(authorityProblem);
      const tasks = locked.tasks.map((task) => applyFindingOutcomes(task, donePanel.decision.outcomes));
      return {
        ...locked,
        tasks,
        wave_gates: reconcileWaveBlock(locked.wave_gates, tasks, locked.spec_check, registration.input.wave!),
      };
    });
    // The tally retired at least one finding, so the derived snapshot
    // changed: re-derive readiness under it (the wave gate may now pass).
    return rederive;
  }
  // Every adjudicated critical was UPHELD. `applyFindingOutcomes` records
  // only refutations, so re-deriving now would reproduce the identical
  // readiness snapshot, the identical deterministic tally, and recurse
  // forever at ~100% CPU (loom#20 Finding 4) — a surviving critical is
  // exactly the `checkCriticalFindings` failure the gate must surface as
  // blocked until remediation retires it. Proceed to the advisory and
  // gate-decision steps with the unchanged snapshot.
  return proceed();
}
