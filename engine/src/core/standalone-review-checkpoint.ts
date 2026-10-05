/**
 * Standalone Review checkpoint: the versioned durable LC-2 state codec. Serialization
 * projects Maps to their parser inputs; parsing rebuilds every process-local parser brand
 * from persisted receipts/artifacts and replays the minimum reducer prefix — no
 * checkpoint field authenticates itself.
 */
import { canonicalDigest } from "./digest";
import {
  canonicalRecord, canonicalStructuralEquals, parseBlockedDiagnostic, reconcileEffectReceipt,
  type ArtifactSetPublished, type EffectIntent, type PublicationAuthorityResolver, type RequestId, type SlotId,
} from "./orchestration-contract";
import {
  parseSerializedRefutationAuthority, restoreRefutationCompletion, serializableRefutationAuthority,
  serializableRefutationCompletion,
} from "./standalone-refutation-completion";
import { parseFrozenStandalonePanelAuthority, standaloneCurrentPanelCriticals } from "./standalone-refutation-panel";
import {
  parseStandaloneAggregate, parseStandaloneRosterCompletionProof, reduceStandaloneReviewMachine, startStandaloneReviewMachine,
  type StandaloneReviewMachineState, type StandaloneReviewerProtocolResolver,
} from "./standalone-review";
import type { FrozenStandaloneReviewAuthority } from "./standalone-review-model";
import { parseStandaloneReviewAuthority } from "./standalone-review-preparation";
import {
  serializeAdjudicatedStandaloneReview, serializeStandaloneAggregate, serializeStandaloneReviewAuthority,
} from "./standalone-review-records";

type AcceptedStandaloneSlot = StandaloneReviewMachineState["accepted"][number];
type PendingStandaloneSlot = StandaloneReviewMachineState["pending"][number];

/** Versioned durable LC-2 checkpoint; Maps are projected to their parser inputs. */
export function serializeStandaloneReviewMachineState(state: StandaloneReviewMachineState): string {
  const record: Record<string, unknown> = {
    ...state,
    schema_version: state.authority.schemaVersion,
    authority: JSON.parse(serializeStandaloneReviewAuthority(state.authority)),
  };
  // Discriminant-preserving narrowing keeps durable fields aligned with the
  // exact union members that own them, so checkpoint serialization stays exhaustive.
  if ("refutationAuthority" in state) {
    record.refutationAuthority = serializableRefutationAuthority(state.refutationAuthority);
  }
  if ("refutationCompletion" in state && state.refutationCompletion !== undefined) {
    record.refutationCompletion = state.refutationCompletion === null
      ? null
      : serializableRefutationCompletion(state.refutationCompletion);
  }
  if ("aggregate" in state) {
    record.aggregate = JSON.parse(serializeStandaloneAggregate(state.aggregate));
  }
  if (state.kind === "recoverable-blocked") {
    record.predecessor = JSON.parse(serializeStandaloneReviewMachineState(state.predecessor));
  }
  if (state.kind === "done" || state.kind === "ready-to-finalize") {
    record.result = JSON.parse(serializeAdjudicatedStandaloneReview(state.result));
  }
  return JSON.stringify(record);
}

type StandaloneMachineStateParseError = Readonly<{
  kind: "standalone-machine-state-rejected";
  message: string;
}>;

function parsePersistedStandaloneProgress(
  authority: FrozenStandaloneReviewAuthority,
  rawAccepted: unknown,
  rawPending: unknown,
): Readonly<{ ok: true; accepted: readonly AcceptedStandaloneSlot[]; pending: readonly PendingStandaloneSlot[] }> |
  Readonly<{ ok: false; message: string }> {
  if (!Array.isArray(rawAccepted) || !Array.isArray(rawPending)) {
    return { ok: false, message: "checkpoint accepted and pending slot projections must be arrays" };
  }
  const accepted: AcceptedStandaloneSlot[] = [];
  const pending: PendingStandaloneSlot[] = [];
  const observed = new Set<string>();
  for (const entry of rawAccepted) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, message: "checkpoint accepted slot projection is malformed" };
    }
    const record = entry as Record<string, unknown>;
    const slot = authority.roster.orderedSlots.find(({ slotId }) => slotId === record.slotId);
    // The persisted attempt is validated as 1 or 2 before it indexes the frozen
    // attempt tuple; broader lifecycle parsing enforces attempt cardinality.
    const attempt = record.attempt === 1 || record.attempt === 2
      ? slot?.attempts[record.attempt - 1]
      : undefined;
    if (slot === undefined || attempt === undefined || record.requestId !== attempt.requestId ||
        typeof record.payloadFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(record.payloadFingerprint) ||
        observed.has(slot.slotId)) {
      return { ok: false, message: "checkpoint accepted slot does not match frozen request/attempt authority" };
    }
    observed.add(slot.slotId);
    accepted.push(canonicalRecord({
      slotId: slot.slotId,
      requestId: attempt.requestId,
      attempt: attempt.attempt,
      payloadFingerprint: record.payloadFingerprint,
    }));
  }
  for (const entry of rawPending) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, message: "checkpoint pending slot projection is malformed" };
    }
    const record = entry as Record<string, unknown>;
    const slot = authority.roster.orderedSlots.find(({ slotId }) => slotId === record.slotId);
    if (slot === undefined || (record.expectedAttempt !== 1 && record.expectedAttempt !== 2) || observed.has(slot.slotId)) {
      return { ok: false, message: "checkpoint pending slot does not match frozen roster authority" };
    }
    // A pre-existing checkpoint has no `rejectionDiagnostic` at all; it replays
    // as null (the retry prompt then falls back to the generic contract
    // reminder). Any other shape is a corrupt projection, not a legacy one.
    const rawDiagnostic = record.rejectionDiagnostic;
    if (rawDiagnostic !== undefined && rawDiagnostic !== null && typeof rawDiagnostic !== "string") {
      return { ok: false, message: "checkpoint pending slot rejection diagnostic must be a string or null" };
    }
    const rejectionDiagnostic = typeof rawDiagnostic === "string" ? rawDiagnostic.trim() : "";
    if (rejectionDiagnostic !== "" && record.expectedAttempt !== 2) {
      return { ok: false, message: "checkpoint pending slot carries a rejection diagnostic without an attempt-2 expectation" };
    }
    observed.add(slot.slotId);
    pending.push(canonicalRecord({
      slotId: slot.slotId,
      expectedAttempt: record.expectedAttempt,
      rejectionDiagnostic: rejectionDiagnostic === "" ? null : rejectionDiagnostic,
    }));
  }
  if (observed.size !== authority.roster.orderedSlots.length) {
    return { ok: false, message: "checkpoint slot projections do not exactly cover the frozen roster" };
  }
  return { ok: true, accepted: Object.freeze(accepted), pending: Object.freeze(pending) };
}

/**
 * Rebuild every process-local parser brand from persisted receipts/artifacts,
 * then replay the minimum LC-2 prefix. No checkpoint field authenticates itself.
 */
export function parseStandaloneReviewMachineState(
  raw: unknown,
  publicationResolver: PublicationAuthorityResolver,
  reviewerProtocols: StandaloneReviewerProtocolResolver,
  registeredAuthority: FrozenStandaloneReviewAuthority,
): Readonly<{ ok: true; value: StandaloneReviewMachineState }> |
  Readonly<{ ok: false; error: StandaloneMachineStateParseError }> {
  const failure = (message: string) => canonicalRecord({
    ok: false as const,
    error: canonicalRecord({ kind: "standalone-machine-state-rejected" as const, message }),
  });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return failure("checkpoint must be an object");
  const record = raw as Record<string, unknown>;
  if (record.schema_version !== registeredAuthority.schemaVersion || typeof record.kind !== "string") return failure("checkpoint schema_version or kind differs from registered authority");
  const authority = parseStandaloneReviewAuthority(record.authority,
    registeredAuthority.schemaVersion === 3 ? registeredAuthority.successor : undefined);
  if (!authority.ok) return failure(authority.errors.join("; "));
  if (serializeStandaloneReviewAuthority(authority.value) !== serializeStandaloneReviewAuthority(registeredAuthority)) {
    return failure("checkpoint authority differs from independently parsed program registration");
  }

  const started = startStandaloneReviewMachine(authority.value);
  if (record.kind === "preparing") return canonicalRecord({ ok: true as const, value: started });

  if (record.kind === "recoverable-blocked") {
    const predecessor = parseStandaloneReviewMachineState(record.predecessor, publicationResolver, reviewerProtocols, registeredAuthority);
    if (!predecessor.ok) return failure(`recoverable predecessor is invalid: ${predecessor.error.message}`);
    if (predecessor.value.kind === "recoverable-blocked" || predecessor.value.kind === "done" ||
        predecessor.value.kind === "terminal-blocked") {
      return failure("recoverable predecessor must be a non-terminal LC-2 state");
    }
    if (serializeStandaloneReviewAuthority(predecessor.value.authority) !== serializeStandaloneReviewAuthority(authority.value)) {
      return failure("recoverable predecessor authority differs from the blocked checkpoint authority");
    }
    const progress = parsePersistedStandaloneProgress(authority.value, record.accepted, record.pending);
    if (!progress.ok || !canonicalStructuralEquals(progress.accepted, predecessor.value.accepted) ||
        !canonicalStructuralEquals(progress.pending, predecessor.value.pending)) {
      return failure(progress.ok
        ? "recoverable checkpoint progress differs from its predecessor"
        : progress.message);
    }
    const diagnostic = parseBlockedDiagnostic(record.diagnostic);
    if (!diagnostic.ok || diagnostic.value.kind !== "effect-blocked") {
      return failure(diagnostic.ok
        ? "recoverable checkpoint requires an infrastructure retry diagnostic"
        : diagnostic.error.message);
    }
    const parsedIntentProbe = reconcileEffectReceipt(record.expectedIntent, null);
    if (parsedIntentProbe.ok || parsedIntentProbe.error.effectId === null) {
      return failure(parsedIntentProbe.ok
        ? "recoverable checkpoint EffectIntent unexpectedly reconciled with an empty receipt"
        : parsedIntentProbe.error.message);
    }
    if (typeof record.expectedIntentDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.expectedIntentDigest) ||
        canonicalDigest(record.expectedIntent) !== record.expectedIntentDigest) {
      return failure("recoverable checkpoint EffectIntent digest is invalid or stale");
    }
    const blocked = reduceStandaloneReviewMachine(predecessor.value, {
      kind: "recoverable-effect-failed",
      diagnostic: diagnostic.value,
      intent: record.expectedIntent as EffectIntent,
    });
    if (!blocked.ok || blocked.value.kind !== "recoverable-blocked" ||
        blocked.value.expectedIntentDigest !== record.expectedIntentDigest) {
      return failure(blocked.ok ? "recoverable checkpoint did not replay to blocked" : blocked.error.message);
    }
    return canonicalRecord({ ok: true as const, value: blocked.value });
  }

  const awaiting = reduceStandaloneReviewMachine(started, {
    kind: "review-batch-published",
    runId: authority.value.runId,
  });
  if (!awaiting.ok) return failure(awaiting.error.message);
  if (record.kind === "awaiting-results") {
    const progress = parsePersistedStandaloneProgress(authority.value, record.accepted, record.pending);
    return progress.ok
      ? canonicalRecord({ ok: true as const, value: canonicalRecord({
          ...awaiting.value,
          accepted: progress.accepted,
          pending: progress.pending,
        }) })
      : failure(progress.message);
  }
  if (record.kind === "terminal-blocked") {
    const progress = parsePersistedStandaloneProgress(authority.value, record.accepted, record.pending);
    if (!progress.ok) return failure(progress.message);
    if (typeof record.failed !== "object" || record.failed === null || Array.isArray(record.failed)) {
      return failure("terminal-blocked checkpoint failed result is malformed");
    }
    const failed = record.failed as Record<string, unknown>;
    if (Object.keys(failed).sort().join(",") !== ["attempt", "message", "requestId", "slotId"].sort().join(",") ||
        failed.attempt !== 2 || typeof failed.message !== "string" || failed.message.trim() !== failed.message ||
        failed.message.length === 0) {
      return failure("terminal-blocked checkpoint failed result fields are invalid");
    }
    const projectedAwaiting = canonicalRecord({
      ...awaiting.value,
      accepted: progress.accepted,
      pending: progress.pending,
    });
    const terminal = reduceStandaloneReviewMachine(projectedAwaiting, {
      kind: "result-rejected",
      request: {
        runId: authority.value.runId,
        slotId: failed.slotId as SlotId,
        requestId: failed.requestId as RequestId,
        attempt: 2,
      },
      message: failed.message,
    });
    if (!terminal.ok || terminal.value.kind !== "terminal-blocked" ||
        !canonicalStructuralEquals(terminal.value.failed, failed)) {
      return failure(terminal.ok ? "terminal-blocked checkpoint did not replay exactly" : terminal.error.message);
    }
    return canonicalRecord({ ok: true as const, value: terminal.value });
  }

  const completion = parseStandaloneRosterCompletionProof(authority.value, publicationResolver, record.completion, reviewerProtocols);
  if (!completion.ok) return failure(completion.error.violations.map((violation) => violation.kind).join("; "));
  // A retried slot's accepted proof entry is at attempt 2. Replay the exact
  // rejection that advanced it — derived from the persisted accepted
  // projection, never from prose — so the checkpoint replays to the same
  // aggregating state the live run checkpointed. Without this, replaying
  // complete-roster-proved against a pristine pending (every slot at attempt
  // 1) refuses the retried slot's attempt-2 entry as stale and the whole
  // checkpoint becomes unrecoverable.
  const progress = parsePersistedStandaloneProgress(authority.value, record.accepted, record.pending);
  if (!progress.ok) return failure(progress.message);
  let replayBase: StandaloneReviewMachineState = awaiting.value;
  for (const entry of progress.accepted) {
    if (entry.attempt !== 2) continue;
    const slot = authority.value.roster.byId.get(entry.slotId);
    const attemptOne = slot?.attempts[0];
    if (attemptOne === undefined || attemptOne.requestId === entry.requestId) {
      return failure("checkpoint accepted attempt-2 entry lacks a canonical attempt-1 predecessor");
    }
    const rejected = reduceStandaloneReviewMachine(replayBase, {
      kind: "result-rejected",
      request: { runId: authority.value.runId, slotId: entry.slotId, requestId: attemptOne.requestId, attempt: 1 },
      message: "recovered from the persisted attempt-2 acceptance projection",
    });
    if (!rejected.ok || rejected.value.kind !== "awaiting-results") {
      return failure(rejected.ok ? "checkpoint attempt-2 acceptance did not replay to awaiting results" : rejected.error.message);
    }
    replayBase = rejected.value;
  }
  const aggregating = reduceStandaloneReviewMachine(replayBase, {
    kind: "complete-roster-proved",
    completion: completion.value,
  });
  if (!aggregating.ok) return failure(aggregating.error.message);
  if (!canonicalStructuralEquals(aggregating.value.accepted, progress.accepted)) {
    return failure("checkpoint replayed accepted-slot progress differs from the persisted projection");
  }
  if (record.kind === "aggregating") return canonicalRecord({ ok: true as const, value: aggregating.value });

  const aggregate = parseStandaloneAggregate(record.aggregate, { authority: authority.value, completion: completion.value });
  if (!aggregate.ok) return failure(aggregate.errors.join("; "));
  const criticals = standaloneCurrentPanelCriticals(aggregate.value);
  let readyOrAwaiting: StandaloneReviewMachineState;
  if (criticals.length === 0) {
    const ready = reduceStandaloneReviewMachine(aggregating.value, { kind: "aggregate-clean", aggregate: aggregate.value });
    if (!ready.ok) return failure(ready.error.message);
    readyOrAwaiting = ready.value;
  } else {
    const panelAuthority = parseFrozenStandalonePanelAuthority(record.panelAuthority, aggregate.value);
    if (!panelAuthority.ok) return failure(panelAuthority.error.message);
    const refutationAuthority = parseSerializedRefutationAuthority(record.refutationAuthority);
    if (!refutationAuthority.ok) return failure(refutationAuthority.error.message);
    const routed = reduceStandaloneReviewMachine(aggregating.value, {
      kind: "aggregate-has-criticals",
      aggregate: aggregate.value,
      panelAuthority: panelAuthority.value,
      refutationAuthority: refutationAuthority.value,
    });
    if (!routed.ok) return failure(routed.error.message);
    if (record.kind === "awaiting-refutation") return canonicalRecord({ ok: true as const, value: routed.value });
    const refutation = restoreRefutationCompletion(
      record.refutationCompletion,
      aggregate.value,
      panelAuthority.value,
      publicationResolver,
    );
    if (refutation === null) return failure("checkpoint lacks a valid durable Refutation Panel completion receipt");
    const ready = reduceStandaloneReviewMachine(routed.value, { kind: "refutation-completed", completion: refutation });
    if (!ready.ok) return failure(ready.error.message);
    readyOrAwaiting = ready.value;
  }
  if (readyOrAwaiting.kind !== "ready-to-finalize") return failure("checkpoint did not replay to ready-to-finalize");
  if (record.kind === "ready-to-finalize") {
    if (authority.value.schemaVersion === 3 && !canonicalStructuralEquals(record,
        JSON.parse(serializeStandaloneReviewMachineState(readyOrAwaiting)))) return failure("v3 ready checkpoint differs from re-proved finalization");
    return canonicalRecord({ ok: true as const, value: readyOrAwaiting });
  }
  if (record.kind !== "done") return failure(`unsupported or inconsistent checkpoint kind: ${record.kind}`);
  const done = reduceStandaloneReviewMachine(readyOrAwaiting, {
    kind: "result-published",
    result: record.result,
    receipt: record.publicationReceipt as ArtifactSetPublished,
  });
  if (done.ok && authority.value.schemaVersion === 3 && !canonicalStructuralEquals(record,
      JSON.parse(serializeStandaloneReviewMachineState(done.value)))) return failure("v3 done checkpoint differs from re-proved publication");
  return done.ok ? canonicalRecord({ ok: true as const, value: done.value }) : failure(done.error.message);
}
