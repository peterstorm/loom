/**
 * Façade program driver volume (A14): the imperative shell's program drivers
 * were one 2,900-line module; this volume owns ONE program's driver (or, for
 * helpers, the shared recovery/git/scope machinery). The public surface is
 * re-exported by index.ts so all existing import sites are unchanged.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseAgentRequestAuthority, parseEffectId, parseIssuedSpawnRequest, type AgentRequestAuthority, type InitialSpawnRequestInput, type PublicationAuthorityResolver, type SpawnRequest } from '../../../core/orchestration-contract';
import { aggregateStandaloneReview, bindStandaloneCaptureAuthority, captureStandaloneReviewerBytes, canonicalStandaloneResultArtifact, completeStandaloneReviewerCapture, prepareFreshStandaloneReview, proveStandaloneRosterCompletion, serializeStandaloneReviewAuthority, serializeAdjudicatedStandaloneReview, admitStandaloneTranscript, type FrozenStandaloneReviewAuthority } from '../../../core/standalone-review';
import { parseStandaloneReviewMachineState, reduceStandaloneReviewMachine, freezeStandaloneRefutationPanelAuthority, parseStandaloneRefutationCompletion, serializeStandaloneReviewMachineState, startStandaloneReviewMachine, type StandaloneReviewMachineState } from '../../../core/standalone-review-machine';
import { buildStandaloneFindingBrief, defaultRefutationThreshold, reviewSignals, selectReviewLenses } from '../../../core/review-panel';
import { completePersistentRefutationPanel, deriveRefutationVerifierBinding, panelRequestIdentity, parseRefutationPanelAuthority, refutationPanelCheckpoint, startPersistentRefutationPanel, submitRefutationVerdict, type PersistentRefutationPanelEvent } from '../../../core/panel-program';
import { buildContextPacket, encodeByteSection, type ContextPacket } from '../../../orchestration/context-packets';
import { readRunBytesNoFollow, writeRunBytesExclusiveNoFollow } from '../../../orchestration/no-follow-fs';
import { captureKey } from '../../../core/harness-capture';
import { type RunDirHandle } from '../../../orchestration/run-directory-handle';
import { resolveModelProfile, lowerModelProfile } from '../../../core/model-profiles';
import { decodeReviewerTranscript, deriveChangedPaths, durablePublicationDigest, durableRequests, failed, metadata, parsedAuthority, publicationFile, publicationResolver, publishInitialBatch, recoverOrPublishStandaloneRetry, refutationRetryTask, renderSpawnTask, safeScope, standalonePackets, standalonePublicationEffectId, standaloneRetryTask, type DurableRequestRecovery, type FacadeDriveResult, type RegisteredStandaloneProgram } from './helpers';

export async function startStandaloneFacade(
  handle: RunDirHandle,
  input: RegisteredStandaloneProgram["input"],
): Promise<FacadeDriveResult> {
  try {
    const changed = deriveChangedPaths();
    const union = [...new Set([
      ...changed.authority.unstaged,
      ...changed.authority.staged,
      ...changed.authority.committed,
    ])].sort();
    const scope = input.files ?? union;
    if (scope.length === 0) return failed("standalone review has no explicit or changed-path scope");
    const reviewMetadata = metadata(input.kind, scope, changed);
    const packetSet = standalonePackets(handle.runId, reviewMetadata, scope);
    const prepared = prepareFreshStandaloneReview({
      runId: handle.runId,
      ...(input.files === null ? {} : { explicitScope: input.files }),
      changedPaths: changed.authority,
      reviewMetadata: {
        requested_kinds: reviewMetadata.requestedKinds,
        docs_only: reviewMetadata.docsOnly,
        source_or_test_changed: reviewMetadata.sourceOrTestChanged,
        types_changed: reviewMetadata.typesChanged,
        comments_changed: reviewMetadata.commentsChanged,
        additions: reviewMetadata.additions,
        file_count: reviewMetadata.fileCount,
        new_structure: reviewMetadata.newStructure,
        languages: reviewMetadata.languages,
      },
      scopeSafety: safeScope(scope),
      reviewerContexts: packetSet.contexts,
    });
    if (!prepared.ok) return failed(prepared.error.errors.join("; "));
    const registration: RegisteredStandaloneProgram = Object.freeze({
      schemaVersion: 1,
      kind: "standalone-review",
      input,
      authority: JSON.parse(serializeStandaloneReviewAuthority(prepared.value.authority)),
    });
    const registered = await handle.registerProgram(registration);
    if (!registered.ok) return failed(registered.error.message);
    const initialRequests = prepared.value.initialRequests.map((authority) => Object.freeze({
      authority,
      context: Object.freeze({
        digest: authority.contextDigest,
        slot: Object.freeze({ kind: "fixed-artifact-slot" as const, path: `contexts/${authority.contextDigest}.json` }),
      }),
    }));
    // Publish every attempt-1 AND attempt-2 context up front. Attempt 2 is the
    // engine's only recovery path for a semantically rejected reviewer slot; a
    // retry must find its frozen packet already content-addressed in the run
    // directory, so the attempt-2 digest the roster froze at start can never
    // drift from the bytes a later retry reads (the frozen-source section hashes
    // worktree bytes at start time and must not be re-derived later).
    for (const packet of packetSet.packets) {
      const published = await handle.publishContext(packet);
      if (!published.ok) return failed(published.error.message);
    }
    const batch = await publishInitialBatch(handle, initialRequests, packetSet.packets.filter((_, index) => index % 2 === 0), "standalone-review");
    if (!batch.ok) return failed(batch.message);
    const awaiting = reduceStandaloneReviewMachine(startStandaloneReviewMachine(prepared.value.authority), {
      kind: "review-batch-published", runId: handle.runId,
    });
    if (!awaiting.ok) return failed(awaiting.error.message);
    await handle.writeCheckpoint(serializeStandaloneReviewMachineState(awaiting.value));
    return { ok: true, action: batch.action };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

export function standaloneRefutationPreparation(
  handle: RunDirHandle,
  authority: FrozenStandaloneReviewAuthority,
  aggregate: import("../../../core/standalone-review").StandaloneReviewAggregate,
) {
  const brief = buildStandaloneFindingBrief(aggregate);
  const selected = selectReviewLenses(reviewSignals(brief.findings), 3);
  if (!selected.ok) throw new Error(selected.errors.join("; "));
  const lenses = selected.value;
  const slots = [];
  const packets: ContextPacket[] = [];
  const inputs: InitialSpawnRequestInput[] = [];
  const retryInputs: Readonly<{ input: InitialSpawnRequestInput; packet: ContextPacket }>[] = [];
  const profile = resolveModelProfile("refutation");
  if (!profile.ok) throw new Error(profile.error.message);
  for (let index = 0; index < lenses.length; index += 1) {
    const lens = lenses[index]!;
    const [firstFinding, ...otherFindings] = brief.findings;
    if (firstFinding === undefined) throw new Error("standalone refutation requires a non-empty critical Finding set");
    const binding = deriveRefutationVerifierBinding(
      handle.runId,
      lens,
      [firstFinding.id, ...otherFindings.map(({ id }) => id)],
    );
    if (!binding.ok) throw new Error(binding.errors.join("; "));
    const attempts = ([1, 2] as const).map((attempt) => {
      const requestId = binding.value.requestIds[attempt - 1];
      const section = encodeByteSection("refutation-authority", JSON.stringify({
        runId: handle.runId, lens, findings: brief.findings, attempt,
      }));
      if (!section.ok) throw new Error(section.error.message);
      const packet = buildContextPacket({
        requestId,
        role: "review-verifier-agent",
        requiredSkill: "none",
        outputContract: `Adjudicate every Finding through lens '${lens}' and emit the exact refutation verdict JSON contract.`,
        fixedContext: Object.freeze([section.value]), variableContext: Object.freeze([]),
      });
      if (!packet.ok) throw new Error(packet.error.message);
      if (attempt === 1) packets.push(packet.value);
      const parsed = parseAgentRequestAuthority({
        runId: handle.runId, requestId, slotId: binding.value.slotId,
        program: "refutation-panel", role: "review-verifier-agent", attempt,
        modelProfile: profile.value.id,
        harnessBinding: { pi: lowerModelProfile(profile.value, "pi"), claude: lowerModelProfile(profile.value, "claude-code") },
        requiredSkill: null, contextDigest: packet.value.digest,
        outputSlot: `transcripts/${binding.value.slotId}/attempt-${attempt}.raw`,
      });
      if (!parsed.ok) throw new Error(parsed.error.violations.map(({ message }) => message).join("; "));
      const input = { authority: parsed.value, context: {
        digest: packet.value.digest,
        slot: { kind: "fixed-artifact-slot" as const, path: `contexts/${packet.value.digest}.json` },
      } };
      if (attempt === 1) inputs.push(input);
      else retryInputs.push(Object.freeze({ input: Object.freeze(input), packet: packet.value }));
      return parsed.value;
    });
    slots.push({ slotId: binding.value.slotId, attempts });
  }
  const panel = parseRefutationPanelAuthority({ runId: handle.runId, findings: brief.findings, lenses, verifierSlots: slots });
  if (!panel.ok) throw new Error(panel.error.message);
  const threshold = defaultRefutationThreshold(lenses.length);
  const frozen = freezeStandaloneRefutationPanelAuthority({ standaloneAuthority: authority, aggregate, panelAuthority: panel.value, threshold });
  if (!frozen.ok) throw new Error(frozen.error.message);
  return { brief, lenses, panel: panel.value, frozen: frozen.value, threshold, packets, inputs, retryInputs };
}

/**
 * The verdict-parse diagnostic that refused this verifier's attempt 1, or null
 * when the step recorded something else. The panel re-derives its whole event
 * prefix from the durable transcripts on every resume, so the rejection message
 * is regenerated deterministically — it needs no checkpoint field of its own.
 */
export function refutationRejectionDiagnostic(event: PersistentRefutationPanelEvent | undefined): string | null {
  return event !== undefined && event.type === "refutation-verdict-rejected" ? event.message : null;
}

export function executableRefutationRequests(
  handle: RunDirHandle,
  requests: readonly SpawnRequest[],
  standalone: boolean,
  retryDiagnostic: string | null = null,
): readonly Readonly<SpawnRequest & { task: string }>[] {
  return requests.map((request) => {
    const task = renderSpawnTask(handle, request.authority, "Read the immutable context packet at LOOM_CONTEXT_PATH, then complete the exact pending Refutation Panel request.", { standalone });
    return Object.freeze({
      ...request,
      // Attempt 2 exists only because attempt 1 was refused. Re-asking the
      // identical question is what made the flake fatal.
      task: request.authority.attempt === 2 ? refutationRetryTask(task, retryDiagnostic) : task,
    });
  });
}

export function durableRefutationRequests(
  handle: RunDirHandle,
  inputs: readonly InitialSpawnRequestInput[],
  resolver: PublicationAuthorityResolver,
  label = "standalone-refutation",
): DurableRequestRecovery {
  const effectId = parseEffectId(`effect:${label}:${createHash("sha256").update(inputs.map((input) =>
    (input.authority as AgentRequestAuthority).requestId).join("|")).digest("hex")}`);
  if (!effectId.ok) return { kind: "corrupt", message: effectId.error.message };
  const publication = durablePublicationDigest(handle, effectId.value);
  if (publication.kind !== "found") return publication;
  const requests: SpawnRequest[] = [];
  for (const [batchIndex, input] of inputs.entries()) {
    const parsed = parseIssuedSpawnRequest(resolver, {
      ...input,
      issuance: { schemaVersion: 1, kind: "issued-spawn-request-proof", runId: handle.runId,
        effectId: effectId.value, publicationDigest: publication.digest, batchIndex },
    });
    if (!parsed.ok) return { kind: "corrupt", message: `durable refutation request is invalid: ${parsed.error.message}` };
    requests.push(parsed.value);
  }
  return { kind: "found", requests: Object.freeze(requests) };
}

export async function durableCaptureRejection(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
): Promise<string | null> {
  const events = await handle.readEvents();
  const rejected = events.find(({ event }) => {
    if (typeof event !== "object" || event === null || Array.isArray(event)) return false;
    const record = event as Record<string, unknown>;
    return record.kind === "request-capture-rejected" && record.requestId === authority.requestId &&
      record.slotId === authority.slotId && record.attempt === authority.attempt;
  });
  if (rejected !== undefined && typeof rejected.event === "object" && rejected.event !== null) {
    const diagnostic = (rejected.event as Record<string, unknown>).diagnostic;
    return typeof diagnostic === "string" ? diagnostic : "capture was rejected without a diagnostic";
  }
  const marker = handle.readCaptureRejection(authority);
  if (!marker.ok) throw new Error(marker.error.message);
  return marker.value;
}

export async function recoverOrPublishRefutationRetry(
  handle: RunDirHandle,
  authority: AgentRequestAuthority,
  retryInputs: readonly Readonly<{ input: InitialSpawnRequestInput; packet: ContextPacket }>[],
  resolver: PublicationAuthorityResolver,
  label: string,
): Promise<Readonly<{ ok: true; request: SpawnRequest }> | Readonly<{ ok: false; message: string }>> {
  const rejection = await durableCaptureRejection(handle, authority);
  if (rejection !== null) {
    return { ok: false, message: `refutation attempt 2 exhausted after capture rejection: ${rejection}` };
  }
  const prepared = retryInputs.find(({ input }) =>
    (input.authority as AgentRequestAuthority).requestId === authority.requestId);
  if (prepared === undefined || JSON.stringify(prepared.input.authority) !== JSON.stringify(authority)) {
    return { ok: false, message: `refutation retry ${authority.requestId} is not exact prepared attempt-2 authority` };
  }
  const retryLabel = `${label}-retry:${authority.slotId}`;
  const recovered = durableRefutationRequests(handle, [prepared.input], resolver, retryLabel);
  if (recovered.kind === "corrupt") return { ok: false, message: recovered.message };
  if (recovered.kind === "found") return { ok: true, request: recovered.requests[0]! };
  const published = await publishInitialBatch(handle, [prepared.input], [prepared.packet], retryLabel);
  return published.ok
    ? { ok: true, request: published.requests[0]! }
    : { ok: false, message: published.message };
}

export async function finalizeStandaloneState(
  handle: RunDirHandle,
  ready: Extract<StandaloneReviewMachineState, { kind: "ready-to-finalize" }>,
): Promise<FacadeDriveResult> {
  const json = serializeAdjudicatedStandaloneReview(ready.result);
  const artifact = canonicalStandaloneResultArtifact(ready.result);
  if (!artifact.ok) return failed(artifact.error.message);
  const resultBytes = Buffer.from(json, "utf8");
  try { writeRunBytesExclusiveNoFollow(`${handle.runDirectory}/result.json`, resultBytes); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !readRunBytesNoFollow(`${handle.runDirectory}/result.json`).equals(resultBytes)) {
      return failed(error instanceof Error ? error.message : String(error));
    }
  }
  const receipt = { kind: "artifact-set-published" as const, effectId: ready.publicationIntent.effectId,
    runId: handle.runId, artifacts: Object.freeze([artifact.value]) as readonly [typeof artifact.value] };
  const recorded = await handle.recordReceipt(receipt);
  if (!recorded.ok) return failed(`cannot durably record publication receipt: ${recorded.error.message}`);
  const done = reduceStandaloneReviewMachine(ready, { kind: "result-published", result: JSON.parse(json), receipt });
  if (!done.ok || done.value.kind !== "done") return failed(done.ok ? "standalone result did not reach done" : done.error.message);
  await handle.writeCheckpoint(serializeStandaloneReviewMachineState(done.value));
  return { ok: true, action: { kind: "done", runId: handle.runId, outcome: done.value.outcome } };
}

export async function resumeStandaloneFacade(
  handle: RunDirHandle,
  registration: RegisteredStandaloneProgram,
): Promise<FacadeDriveResult> {
  try {
    const authorityResult = parsedAuthority(registration);
    if (!authorityResult.ok) return failed(authorityResult.message);
    const resolver = publicationResolver(handle);
    const checkpoint = await handle.readCheckpoint();
    let rawState: unknown;
    if (checkpoint === null) {
      // Initial-batch crash window: publishInitialBatch persists contexts,
      // requests, and the publication receipt BEFORE the awaiting-results
      // checkpoint is written. A crash inside that window leaves no checkpoint;
      // reconstruct the exact awaiting-results state from the registered frozen
      // authority (the same pure state start would have checkpointed) so
      // reviewer evidence captured before the crash is not discarded.
      const effectId = standalonePublicationEffectId(authorityResult.value);
      if (!effectId.ok) return failed(effectId.error.message);
      const publication = durablePublicationDigest(handle, effectId.value);
      if (publication.kind === "corrupt") return failed(publication.message);
      if (publication.kind === "found") {
        const reconstructed = reduceStandaloneReviewMachine(
          startStandaloneReviewMachine(authorityResult.value),
          { kind: "review-batch-published", runId: handle.runId },
        );
        if (!reconstructed.ok || reconstructed.value.kind !== "awaiting-results") {
          return failed(reconstructed.ok
            ? "standalone recovery did not reach awaiting-results"
            : reconstructed.error.message);
        }
        const serialized = serializeStandaloneReviewMachineState(reconstructed.value);
        await handle.writeCheckpoint(serialized);
        rawState = JSON.parse(serialized) as unknown;
      } else {
        return failed("standalone review checkpoint is missing and no durable batch publication exists");
      }
    } else {
      try { rawState = JSON.parse(checkpoint); } catch { return failed("standalone review checkpoint is invalid JSON"); }
    }
    const state = parseStandaloneReviewMachineState(rawState, resolver);
    if (!state.ok) return failed(state.error.message);
    if (state.value.kind === "done") return { ok: true, action: { kind: "done", runId: handle.runId, outcome: state.value.outcome } };
    if (state.value.kind === "terminal-blocked" || state.value.kind === "recoverable-blocked") {
      return { ok: true, action: { kind: "blocked", runId: handle.runId, diagnostic: state.value } };
    }
    if (state.value.kind === "ready-to-finalize") return finalizeStandaloneState(handle, state.value);
    if (state.value.kind === "awaiting-refutation") {
      const preparation = standaloneRefutationPreparation(handle, state.value.authority, state.value.aggregate);
      const recovered = durableRefutationRequests(handle, preparation.inputs, resolver);
      if (recovered.kind === "corrupt") return failed(recovered.message);
      if (recovered.kind === "absent") {
        const published = await publishInitialBatch(handle, preparation.inputs, preparation.packets, "standalone-refutation");
        return published.ok ? { ok: true, action: published.action } : failed(published.message);
      }
      const panelRequests = recovered.requests;
      const captured = handle.readCapturedAttempts();
      if (!captured.ok) return failed(captured.error.message);
      const missing = panelRequests.filter((request) => !captured.value.has(captureKey(request.authority.slotId, request.authority.attempt)));
      if (missing.length > 0) {
        return {
          ok: true,
          action: { kind: "spawn-batch", runId: handle.runId, requests: executableRefutationRequests(handle, missing, true) },
        };
      }
      let panelState = startPersistentRefutationPanel(preparation.panel).state;
      // Collect the FULL immutable event prefix as the panel runs. The legacy
      // completed-state projection records accepted verdicts only, so a slot
      // accepted on attempt 2 (after an attempt-1 verdict was rejected) cannot
      // be replayed from it — the durable restart would see the slot still
      // awaiting attempt 1 and reject the :2 request. The canonical T2
      // checkpoint below carries the rejection events and replay reaches the
      // exact terminal state.
      const panelEvents: PersistentRefutationPanelEvent[] = [];
      for (const request of panelRequests) {
        const bytes = handle.readTranscriptBytes(request.authority);
        if (!bytes.ok) return failed(bytes.error.message);
        let submitted = submitRefutationVerdict(panelState, resolver, panelRequestIdentity(request), Buffer.from(bytes.value).toString("utf8"));
        if (!submitted.ok) return failed(submitted.error.message);
        panelState = submitted.value.state;
        if (submitted.value.recordedEvent !== undefined) panelEvents.push(submitted.value.recordedEvent);
        if (submitted.value.action?.kind === "spawn-refutation-verifiers") {
          const retryAuthority = submitted.value.action.requests[0];
          const retry = await recoverOrPublishRefutationRetry(
            handle, retryAuthority, preparation.retryInputs, resolver, "standalone-refutation",
          );
          if (!retry.ok) return failed(retry.message);
          const attempts = handle.readCapturedAttempts();
          if (!attempts.ok) return failed(attempts.error.message);
          if (!attempts.value.has(captureKey(retry.request.authority.slotId, retry.request.authority.attempt))) {
            return { ok: true, action: {
              kind: "spawn-batch", runId: handle.runId,
              requests: executableRefutationRequests(
                handle, [retry.request], true, refutationRejectionDiagnostic(submitted.value.recordedEvent),
              ),
            } };
          }
          const retryBytes = handle.readTranscriptBytes(retry.request.authority);
          if (!retryBytes.ok) return failed(retryBytes.error.message);
          submitted = submitRefutationVerdict(
            panelState, resolver, panelRequestIdentity(retry.request), Buffer.from(retryBytes.value).toString("utf8"),
          );
          if (!submitted.ok) return failed(submitted.error.message);
          panelState = submitted.value.state;
          if (submitted.value.recordedEvent !== undefined) panelEvents.push(submitted.value.recordedEvent);
          if (submitted.value.action?.kind === "refutation-blocked") {
            return failed(submitted.value.action.diagnostic.message);
          }
        }
      }
      const completed = completePersistentRefutationPanel(panelState, resolver, preparation.threshold);
      if (!completed.ok || completed.value.state.stage !== "done") return failed(completed.ok ? "refutation did not reach done" : completed.error.message);
      if (completed.value.recordedEvent !== undefined) panelEvents.push(completed.value.recordedEvent);
      const canonical = refutationPanelCheckpoint(completed.value.state, panelEvents, resolver);
      if (!canonical.ok) return failed(canonical.error.message);
      const completion = parseStandaloneRefutationCompletion({
        panelAuthority: preparation.frozen,
        aggregate: state.value.aggregate,
        completedPanelState: completed.value.state,
        completedPanelCheckpoint: canonical.value,
        publicationResolver: resolver,
      });
      if (!completion.ok) return failed(completion.error.message);
      const ready = reduceStandaloneReviewMachine(state.value, { kind: "refutation-completed", completion: completion.value });
      if (!ready.ok || ready.value.kind !== "ready-to-finalize") return failed(ready.ok ? "refutation did not unlock finalization" : ready.error.message);
      return finalizeStandaloneState(handle, ready.value);
    }
    if (state.value.kind !== "awaiting-results") return failed(`unsupported standalone resume state ${state.value.kind}`);

    const activeAuthority = state.value.authority;
    const recovered = durableRequests(handle, activeAuthority, resolver);
    if (recovered.kind !== "found") {
      return failed(recovered.kind === "absent"
        ? "standalone publication authority is absent"
        : recovered.message);
    }
    const attemptOneBySlot = new Map(recovered.requests.map((request) => [request.authority.slotId, request] as const));
    const captured = handle.readCapturedAttempts();
    if (!captured.ok) return failed(captured.error.message);
    const pendingBySlot = new Map(state.value.pending.map(({ slotId, expectedAttempt }) => [slotId, expectedAttempt] as const));
    const scope = activeAuthority.scope;

    // Phase A — semantic admission check for every captured attempt-1 slot the
    // machine still expects at attempt 1. A transcript the frozen-scope
    // validator refuses is REJECTED here — where the LC-2 lifecycle can advance
    // the slot to attempt 2 — instead of dead-ending the whole run at
    // aggregation with no recovery path.
    const rejected: Readonly<{ slot: AgentRequestAuthority; problems: readonly string[] }>[] = [];
    for (const slot of activeAuthority.roster.orderedSlots) {
      if ((pendingBySlot.get(slot.slotId) ?? 1) !== 1) continue;
      const attemptOne = attemptOneBySlot.get(slot.slotId);
      if (attemptOne === undefined) {
        return failed(`standalone attempt-1 issuance authority is missing for ${slot.slotId}`);
      }
      if (!captured.value.has(captureKey(attemptOne.authority.slotId, 1))) continue;
      const bytes = handle.readTranscriptBytes(attemptOne.authority);
      if (!bytes.ok) return failed(bytes.error.message);
      const decoded = decodeReviewerTranscript(bytes.value, attemptOne.authority.role);
      const admission = decoded.ok
        ? admitStandaloneTranscript(scope, decoded.text, attemptOne.authority.role)
        : { ok: false as const, problems: Object.freeze([decoded.message]) };
      if (!admission.ok) rejected.push({ slot: attemptOne.authority, problems: [...admission.problems] });
    }
    let machine: StandaloneReviewMachineState = state.value;
    if (rejected.length > 0) {
      for (const { slot, problems } of rejected) {
        const reduced = reduceStandaloneReviewMachine(machine, {
          kind: "result-rejected",
          request: { runId: handle.runId, slotId: slot.slotId, requestId: slot.requestId, attempt: 1 },
          message: problems.join("; "),
        });
        if (!reduced.ok || reduced.value.kind !== "awaiting-results") {
          return failed(reduced.ok ? "standalone semantic rejection did not remain awaiting results" : reduced.error.message);
        }
        machine = reduced.value;
      }
      await handle.writeCheckpoint(serializeStandaloneReviewMachineState(machine));
      for (const { slot, problems } of rejected) {
        await handle.appendEvent({
          schemaVersion: 1,
          sequence: 0,
          dedupKey: `standalone-result-rejected:${createHash("sha256").update(`${slot.requestId}:${slot.attempt}`).digest("hex")}`,
          recordedAtMs: Date.now(),
          event: {
            kind: "standalone-result-rejected",
            runId: handle.runId,
            requestId: slot.requestId,
            slotId: slot.slotId,
            attempt: slot.attempt,
            diagnostic: problems.join("; "),
          },
        });
      }
    }

    // Phase B — assemble the issued-request set. Slots still expected at
    // attempt 1 come from the original batch publication; slots at attempt 2
    // (freshly rejected here or retried in an earlier resume) come from the
    // per-slot retry batch, published now if a crash left it unpublished.
    const rejectedSlotIds = new Set(rejected.map(({ slot }) => slot.slotId));
    // Read the diagnostic off the REDUCED machine, not off this pass's `rejected`
    // set: a resume that merely re-issues an already-recorded retry has an empty
    // `rejected` set, and reading from it there silently degraded the attempt-2
    // prompt to the generic fallback.
    const rejectedDiagnostics = new Map(machine.pending.flatMap(({ slotId, rejectionDiagnostic }) =>
      rejectionDiagnostic === null ? [] : [[slotId, rejectionDiagnostic] as const]));
    const issued: SpawnRequest[] = [];
    for (const slot of activeAuthority.roster.orderedSlots) {
      const expected = rejectedSlotIds.has(slot.slotId) ? 2 : (pendingBySlot.get(slot.slotId) ?? 1);
      if (expected === 1) {
        const attemptOne = attemptOneBySlot.get(slot.slotId);
        if (attemptOne === undefined) {
          return failed(`standalone attempt-1 issuance authority is missing for ${slot.slotId}`);
        }
        issued.push(attemptOne);
        continue;
      }
      const retry = await recoverOrPublishStandaloneRetry(handle, activeAuthority, slot, resolver);
      if (!retry.ok) return failed(retry.message);
      issued.push(retry.request);
    }
    const captureAuthority = bindStandaloneCaptureAuthority(activeAuthority, issued);
    if (!captureAuthority.ok) return failed(captureAuthority.error.message);

    // Phase C — accept captured expected attempts. A captured attempt 2 that
    // STILL fails the frozen-scope validator terminal-blocks the run exactly as
    // the LC-2 lifecycle prescribes for a second and final attempt.
    const accepted = [];
    const missing: SpawnRequest[] = [];
    for (const request of issued) {
      if (!captured.value.has(captureKey(request.authority.slotId, request.authority.attempt))) {
        missing.push(request);
        continue;
      }
      const bytes = handle.readTranscriptBytes(request.authority);
      if (!bytes.ok) return failed(bytes.error.message);
      if (request.authority.attempt === 2) {
        const decoded = decodeReviewerTranscript(bytes.value, request.authority.role);
        const admission = decoded.ok
          ? admitStandaloneTranscript(scope, decoded.text, request.authority.role)
          : { ok: false as const, problems: Object.freeze([decoded.message]) };
        if (!admission.ok) {
          const problems = [...admission.problems];
          const terminal = reduceStandaloneReviewMachine(machine, {
            kind: "result-rejected",
            request: { runId: handle.runId, slotId: request.authority.slotId, requestId: request.authority.requestId, attempt: 2 },
            message: problems.join("; "),
          });
          if (!terminal.ok || terminal.value.kind !== "terminal-blocked") {
            return failed(terminal.ok ? "standalone attempt-2 rejection did not terminal-block" : terminal.error.message);
          }
          await handle.writeCheckpoint(serializeStandaloneReviewMachineState(terminal.value));
          await handle.appendEvent({
            schemaVersion: 1,
            sequence: 0,
            dedupKey: `standalone-result-rejected:${createHash("sha256").update(`${request.authority.requestId}:${request.authority.attempt}`).digest("hex")}`,
            recordedAtMs: Date.now(),
            event: {
              kind: "standalone-result-rejected",
              runId: handle.runId,
              requestId: request.authority.requestId,
              slotId: request.authority.slotId,
              attempt: 2,
              diagnostic: problems.join("; "),
            },
          });
          return { ok: true, action: { kind: "blocked", runId: handle.runId, diagnostic: terminal.value } };
        }
      }
      const prepared = captureStandaloneReviewerBytes(captureAuthority.value, request.authority.requestId, bytes.value);
      if (!prepared.ok) return failed(prepared.error.message);
      const completed = completeStandaloneReviewerCapture(prepared.value, {
        kind: "raw-transcript-captured",
        effectId: prepared.value.intent.effectId,
        runId: handle.runId,
        requestId: request.authority.requestId,
        artifact: prepared.value.expectedArtifact,
      });
      if (!completed.ok) return failed(completed.error.message);
      accepted.push(completed.value);
    }
    if (missing.length > 0) {
      const effectId = standalonePublicationEffectId(activeAuthority);
      if (!effectId.ok) return failed(effectId.error.message);
      const receipt = JSON.parse(readRunBytesNoFollow(
        `${handle.runDirectory}/artifacts/${publicationFile(effectId.value)}`,
      ).toString("utf8")) as Record<string, unknown>;
      return { ok: true, action: {
        kind: "spawn-batch",
        runId: handle.runId,
        publicationIdentity: {
          schemaVersion: 1,
          kind: "batch-publication-identity",
          runId: handle.runId,
          effectId: effectId.value,
          publicationDigest: receipt.publicationDigest,
        },
        idempotencyKey: { runId: handle.runId, effectId: effectId.value },
        receipt,
        requests: missing.map((request) => request.authority.attempt === 2
          ? {
              ...request,
              task: standaloneRetryTask(
                renderSpawnTask(handle, request.authority, "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.", { standalone: true }),
                rejectedDiagnostics.get(request.authority.slotId) ?? null,
              ),
            }
          : {
              ...request,
              task: renderSpawnTask(handle, request.authority, "Read the immutable context packet at LOOM_CONTEXT_PATH and emit only the required reviewer result.", { standalone: true }),
            }),
      } };
    }
    const completion = proveStandaloneRosterCompletion(activeAuthority, resolver, accepted);
    if (!completion.ok) return failed(completion.error.violations.map((entry) => JSON.stringify(entry)).join("; "));
    let reduced = reduceStandaloneReviewMachine(machine, { kind: "complete-roster-proved", completion: completion.value });
    if (!reduced.ok) return failed(reduced.error.message);
    if (reduced.value.kind !== "aggregating") return failed("standalone roster did not reach aggregation");
    const aggregate = aggregateStandaloneReview({ authority: activeAuthority, completion: completion.value });
    if (!aggregate.ok) return failed(aggregate.errors.join("; "));
    if (aggregate.value.kind !== "clean") {
      const preparation = standaloneRefutationPreparation(handle, activeAuthority, aggregate.value.aggregate);
      reduced = reduceStandaloneReviewMachine(reduced.value, {
        kind: "aggregate-has-criticals",
        aggregate: aggregate.value.aggregate,
        panelAuthority: preparation.frozen,
        refutationAuthority: preparation.panel,
      });
      if (!reduced.ok || reduced.value.kind !== "awaiting-refutation") return failed(reduced.ok ? "critical route did not reach refutation" : reduced.error.message);
      await handle.writeCheckpoint(serializeStandaloneReviewMachineState(reduced.value));
      const published = await publishInitialBatch(handle, preparation.inputs, preparation.packets, "standalone-refutation");
      return published.ok ? { ok: true, action: published.action } : failed(published.message);
    }
    reduced = reduceStandaloneReviewMachine(reduced.value, { kind: "aggregate-clean", aggregate: aggregate.value.aggregate });
    if (!reduced.ok || reduced.value.kind !== "ready-to-finalize") return failed(reduced.ok ? "standalone finalization did not become ready" : reduced.error.message);
    return finalizeStandaloneState(handle, reduced.value);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

