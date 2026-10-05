/**
 * Standalone Refutation Panel completion: freezes standalone→T2 panel authority before
 * any completion can be accepted, and mints the completion receipt only from a T2
 * parser/reducer-produced done state whose exact authority and deterministic decision
 * remain frozen. Also owns the receipt's persisted-form codec, which projects the T2
 * verifier roster Map to its parser inputs.
 */
import { canonicalDigest } from "./digest";
import {
  canonicalRecord, canonicalStructuralEquals, parseArtifactDigest,
  type ArtifactDigest, type OrchestrationRunId, type PublicationAuthorityResolver,
} from "./orchestration-contract";
import {
  parseRefutationPanelAuthority,
  type RefutationPanelAuthority,
} from "./panel-authority";
import {
  parseRefutationPanelCheckpoint,
  replayPersistentRefutationPanel,
  resumePersistentRefutationPanel,
  type RefutationPanelCheckpoint,
  type RefutationPanelState,
} from "./persistent-panel";
import {
  freezeStandalonePanelAuthority, panelOutcomeValue, parseFrozenStandalonePanelAuthority, parseStandalonePanelOutcomes,
  standaloneCurrentPanelCriticals, type FrozenStandalonePanelAuthority,
} from "./standalone-refutation-panel";
import type { FrozenStandaloneReviewAuthority, ParsedPanelOutcomes, StandaloneReviewAggregate } from "./standalone-review-model";

type StandaloneRefutationAuthorityError = Readonly<{
  kind: "standalone-refutation-authority-rejected";
  message: string;
}>;

export type StandaloneRefutationCompletionReceipt = Readonly<{
  schemaVersion: 1;
  kind: "standalone-refutation-completed";
  /** The SAME branded identities `FrozenStandalonePanelAuthority` carries. The
   *  reducer below compares these four fields against that authority field by
   *  field; as plain `string` the comparison typechecked even if a run id and a
   *  digest were transposed at the construction site. */
  standaloneRunId: OrchestrationRunId;
  panelRunId: OrchestrationRunId;
  panelAuthority: FrozenStandalonePanelAuthority;
  findingBriefDigest: ArtifactDigest;
  manifestDigest: ArtifactDigest;
  threshold: number;
  outcomeDigest: string;
  completedPanelStateDigest: string;
  panel: ParsedPanelOutcomes;
  /** Parser-produced T2 state used by the in-process reducer. */
  completedPanelState: RefutationPanelState;
  /** Canonical T2 event checkpoint retained when completion crossed a durable boundary. */
  completedPanelCheckpoint: RefutationPanelCheckpoint | null;
}>;

const refutationAuthorityFailure = (message: string): Readonly<{ ok: false; error: StandaloneRefutationAuthorityError }> =>
  canonicalRecord({ ok: false, error: canonicalRecord({
    kind: "standalone-refutation-authority-rejected" as const,
    message,
  }) });

function deepFreezeJson<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((entry) => deepFreezeJson(entry));
    return Object.freeze(value) as T;
  }
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach((entry) => deepFreezeJson(entry));
    return Object.freeze(value);
  }
  return value;
}



function refutationManifestValue(authority: RefutationPanelAuthority): unknown {
  return {
    schemaVersion: authority.schemaVersion,
    panel: authority.panel,
    runId: authority.runId,
    findings: authority.findings,
    lenses: authority.lenses,
    verifierSlots: authority.verifierRoster.orderedSlots,
  };
}

/** Freeze standalone→T2 panel authority before any completion can be accepted. */
export function freezeStandaloneRefutationPanelAuthority(input: Readonly<{
  standaloneAuthority: FrozenStandaloneReviewAuthority;
  aggregate: StandaloneReviewAggregate;
  panelAuthority: RefutationPanelAuthority;
  threshold: number;
}>): Readonly<{ ok: true; value: FrozenStandalonePanelAuthority }> |
  Readonly<{ ok: false; error: StandaloneRefutationAuthorityError }> {
  const canonical = parseRefutationPanelAuthority({
    runId: input.panelAuthority.runId,
    findings: input.panelAuthority.findings,
    lenses: input.panelAuthority.lenses,
    verifierSlots: input.panelAuthority.verifierRoster.orderedSlots,
  });
  if (!canonical.ok) return refutationAuthorityFailure(canonical.error.message);
  if (input.aggregate.runId !== input.standaloneAuthority.runId) {
    return refutationAuthorityFailure("standalone aggregate and frozen standalone authority belong to different runs");
  }
  const manifestDigest = parseArtifactDigest(canonicalDigest(refutationManifestValue(canonical.value)));
  if (!manifestDigest.ok) return refutationAuthorityFailure(manifestDigest.error.message);
  const frozen = freezeStandalonePanelAuthority({
    standaloneRunId: input.standaloneAuthority.runId,
    panelRunId: canonical.value.runId,
    aggregate: input.aggregate,
    panelFindings: canonical.value.findings,
    lenses: canonical.value.lenses,
    manifestDigest: manifestDigest.value,
    threshold: input.threshold,
  });
  if (!frozen.ok) return refutationAuthorityFailure(frozen.error.message);
  return canonicalRecord({ ok: true, value: frozen.value });
}

/**
 * Produce opaque completion authority only from a T2 parser/reducer-produced
 * done state whose exact authority and deterministic decision remain frozen.
 */
function replaySerializedRefutationCompletion(
  raw: unknown,
  resolver: PublicationAuthorityResolver,
): Readonly<{ ok: true; value: Extract<RefutationPanelState, { stage: "done" }> }> |
  Readonly<{ ok: false; message: string }> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "persisted Refutation Panel completion must be an object" };
  }
  const record = raw as Record<string, unknown>;
  const authority = parseSerializedRefutationAuthority(record.authority);
  if (!authority.ok) return { ok: false, message: authority.error.message };
  if (record.panel !== "refutation" || record.stage !== "done" || !Array.isArray(record.slots) ||
      typeof record.decision !== "object" || record.decision === null || Array.isArray(record.decision)) {
    return { ok: false, message: "persisted Refutation Panel completion state is malformed or non-terminal" };
  }
  const verdictEvents: unknown[] = [];
  for (const slot of record.slots) {
    if (typeof slot !== "object" || slot === null || Array.isArray(slot)) {
      return { ok: false, message: "persisted Refutation Panel completion contains a malformed slot" };
    }
    const progress = slot as Record<string, unknown>;
    if (progress.status !== "accepted" || typeof progress.result !== "object" || progress.result === null ||
        Array.isArray(progress.result)) {
      return { ok: false, message: "persisted Refutation Panel completion requires every verifier slot to be accepted" };
    }
    const result = progress.result as Record<string, unknown>;
    verdictEvents.push({
      schemaVersion: 1,
      type: "refutation-verdict-accepted",
      request: result.request,
      value: result.value,
    });
  }
  const replayed = replayPersistentRefutationPanel(authority.value, [
    ...verdictEvents,
    { schemaVersion: 1, type: "refutation-tally-completed", decision: record.decision },
  ], resolver);
  if (!replayed.ok) return { ok: false, message: replayed.error.message };
  if (replayed.value.state.stage !== "done") {
    return { ok: false, message: "persisted Refutation Panel event replay did not reach done" };
  }
  if (!canonicalStructuralEquals(
    serializableCompletedPanelState(replayed.value.state),
    serializableCompletedPanelState({ ...record, authority: authority.value }),
  )) {
    return { ok: false, message: "persisted Refutation Panel state disagrees with verified T2 replay" };
  }
  return { ok: true, value: replayed.value.state };
}

export function parseStandaloneRefutationCompletion(input: Readonly<{
  panelAuthority: FrozenStandalonePanelAuthority;
  aggregate: StandaloneReviewAggregate;
  /** Untrusted live/legacy T2 state, or a canonical T2 checkpoint for compatibility. */
  completedPanelState?: unknown;
  /** T2's canonical event-backed completion checkpoint. */
  completedPanelCheckpoint?: unknown;
  /** Required when either persisted T2 representation must be replayed after restart. */
  publicationResolver?: PublicationAuthorityResolver;
}>): Readonly<{ ok: true; value: StandaloneRefutationCompletionReceipt }> |
  Readonly<{ ok: false; error: StandaloneRefutationAuthorityError }> {
  const persistedPanelAuthority = parseFrozenStandalonePanelAuthority(input.panelAuthority, input.aggregate);
  if (!persistedPanelAuthority.ok) {
    return refutationAuthorityFailure(`refutation completion panel authority is invalid: ${persistedPanelAuthority.error.message}`);
  }

  const stateLooksLikeCheckpoint = typeof input.completedPanelState === "object" &&
    input.completedPanelState !== null &&
    !Array.isArray(input.completedPanelState) &&
    (input.completedPanelState as Record<string, unknown>).schemaVersion === 2 &&
    (input.completedPanelState as Record<string, unknown>).kind === "refutation-panel-checkpoint";
  if (stateLooksLikeCheckpoint && input.completedPanelCheckpoint !== undefined &&
      input.completedPanelCheckpoint !== null &&
      !canonicalStructuralEquals(input.completedPanelState, input.completedPanelCheckpoint)) {
    return refutationAuthorityFailure("duplicate canonical Refutation Panel checkpoint inputs disagree");
  }
  const rawCheckpoint = input.completedPanelCheckpoint ??
    (stateLooksLikeCheckpoint ? input.completedPanelState : undefined);
  const rawState = stateLooksLikeCheckpoint ? undefined : input.completedPanelState;

  let checkpoint: RefutationPanelCheckpoint | null = null;
  let checkpointCompleted: Extract<RefutationPanelState, { stage: "done" }> | null = null;
  if (rawCheckpoint !== undefined && rawCheckpoint !== null) {
    if (input.publicationResolver === undefined) {
      return refutationAuthorityFailure("canonical Refutation Panel checkpoint replay requires publication authority");
    }
    const parsedCheckpoint = parseRefutationPanelCheckpoint(
      rawCheckpoint,
      input.publicationResolver,
    );
    if (!parsedCheckpoint.ok) return refutationAuthorityFailure(parsedCheckpoint.error.message);
    if (parsedCheckpoint.value.state.stage !== "done") {
      return refutationAuthorityFailure("canonical Refutation Panel checkpoint has not reached completed state");
    }
    checkpoint = deepFreezeJson(
      JSON.parse(JSON.stringify(rawCheckpoint)) as RefutationPanelCheckpoint,
    );
    checkpointCompleted = parsedCheckpoint.value.state;
  }

  const resumed = rawState === undefined
    ? null
    : resumePersistentRefutationPanel(rawState as RefutationPanelState);
  const replayed = rawState !== undefined && resumed?.ok === false && input.publicationResolver !== undefined
    ? replaySerializedRefutationCompletion(rawState, input.publicationResolver)
    : null;
  let stateCompleted: Extract<RefutationPanelState, { stage: "done" }> | null = null;
  if (resumed?.ok === true && resumed.value.state.stage === "done") {
    stateCompleted = resumed.value.state;
  } else if (replayed?.ok === true) {
    stateCompleted = replayed.value;
  }
  if (checkpointCompleted !== null && stateCompleted !== null && !canonicalStructuralEquals(
    serializableCompletedPanelState(checkpointCompleted),
    serializableCompletedPanelState(stateCompleted),
  )) {
    return refutationAuthorityFailure("canonical Refutation Panel checkpoint and supplied completed state disagree");
  }
  const completed = checkpointCompleted ?? stateCompleted;
  if (completed === null) {
    if (replayed !== null && !replayed.ok) return refutationAuthorityFailure(replayed.message);
    if (resumed?.ok === true) return refutationAuthorityFailure("refutation panel has not reached completed state");
    if (resumed?.ok === false) return refutationAuthorityFailure(resumed.error.message);
    return refutationAuthorityFailure("refutation completion requires a completed T2 state or canonical checkpoint");
  }
  const completedManifestDigest = canonicalDigest(refutationManifestValue(completed.authority));
  const independentlyFrozen = freezeStandalonePanelAuthority({
    standaloneRunId: input.aggregate.runId,
    panelRunId: completed.authority.runId,
    aggregate: input.aggregate,
    panelFindings: completed.authority.findings,
    lenses: completed.authority.lenses,
    manifestDigest: completedManifestDigest,
    threshold: input.panelAuthority.threshold,
  });
  if (!independentlyFrozen.ok || JSON.stringify(independentlyFrozen.value) !== JSON.stringify(persistedPanelAuthority.value) ||
      completed.authority.runId !== input.panelAuthority.panelRunId ||
      completedManifestDigest !== input.panelAuthority.manifestDigest ||
      completed.decision.threshold !== input.panelAuthority.threshold ||
      JSON.stringify(completed.decision.lenses) !== JSON.stringify(input.panelAuthority.lenses)) {
    return refutationAuthorityFailure("completed Refutation Panel does not match the exact frozen run/manifest/lens/threshold authority");
  }
  const rawOutcomes = {
    lenses: completed.decision.lenses,
    threshold: completed.decision.threshold,
    surviving: completed.decision.outcomes.filter(({ survives }) => survives).length,
    refuted: completed.decision.outcomes.filter(({ survives }) => !survives).length,
    outcomes: completed.decision.outcomes.map((outcome) => ({
      finding_id: outcome.finding.id,
      task_id: outcome.finding.taskId,
      claim: outcome.finding.claim,
      survives: outcome.survives,
      refuted_by: outcome.refutations.map(({ lens }) => lens),
      reasoning: outcome.refutations.map(({ reason }) => reason),
      upheld_by: outcome.upheldBy,
      uncertain_from: outcome.uncertainFrom,
    })),
  };
  const criticals = standaloneCurrentPanelCriticals(input.aggregate);
  const panel = parseStandalonePanelOutcomes(
    rawOutcomes,
    criticals,
    input.panelAuthority.findings.map(({ id, claim }) => ({ id, claim })),
    input.panelAuthority.lenses,
  );
  if (!panel.ok) return refutationAuthorityFailure(panel.errors.join("; "));
  const outcomeDigest = canonicalDigest(panelOutcomeValue(panel.value));
  const completedPanelStateDigest = canonicalDigest({
    stage: completed.stage,
    manifestDigest: completedManifestDigest,
    slots: completed.slots,
    decision: completed.decision,
  });
  const receipt = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "standalone-refutation-completed" as const,
    standaloneRunId: input.panelAuthority.standaloneRunId,
    panelRunId: input.panelAuthority.panelRunId,
    panelAuthority: input.panelAuthority,
    findingBriefDigest: input.panelAuthority.findingBriefDigest,
    manifestDigest: input.panelAuthority.manifestDigest,
    threshold: input.panelAuthority.threshold,
    outcomeDigest,
    completedPanelStateDigest,
    panel: panel.value,
    completedPanelState: completed,
    completedPanelCheckpoint: checkpoint,
  });
  return canonicalRecord({ ok: true, value: receipt });
}

/** Persisted projection of T2 authority: the verifier roster Map becomes its parser inputs. */
export function serializableRefutationAuthority(authority: RefutationPanelAuthority): unknown {
  return {
    runId: authority.runId,
    findings: authority.findings,
    lenses: authority.lenses,
    verifierSlots: authority.verifierRoster.orderedSlots,
  };
}

/**
 * The lossy shape a persisted panel checkpoint actually carries: the verifier
 * roster Map is projected to its parser inputs, so this is deliberately NOT a
 * RefutationPanelState — the compiler tracks that seam instead of an
 * `as unknown as` cast bridging it. Only the parsed `authority` is restored;
 * every other field stays the persisted JSON it was.
 */
type SerializedRefutationPanelState = Readonly<{ authority: RefutationPanelAuthority }> & Record<string, unknown>;

function serializableCompletedPanelState(
  state: Readonly<{ authority: RefutationPanelAuthority }> & Record<string, unknown>,
): unknown {
  return { ...state, authority: serializableRefutationAuthority(state.authority) };
}

/** Persisted projection of a completion receipt; its completed T2 state carries projected authority. */
export function serializableRefutationCompletion(
  receipt: Readonly<{ completedPanelState: Readonly<{ authority: RefutationPanelAuthority }> }>,
): unknown {
  return { ...receipt, completedPanelState: serializableCompletedPanelState(receipt.completedPanelState) };
}

/** Reparse persisted T2 authority, accepting either the projected or the live roster shape. */
export function parseSerializedRefutationAuthority(raw: unknown) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return parseRefutationPanelAuthority({ runId: undefined, findings: undefined, lenses: undefined, verifierSlots: undefined });
  }
  const record = raw as Record<string, unknown>;
  const verifierRoster = typeof record.verifierRoster === "object" && record.verifierRoster !== null
    ? record.verifierRoster as Record<string, unknown>
    : null;
  return parseRefutationPanelAuthority({
    runId: record.runId,
    findings: record.findings,
    lenses: record.lenses,
    verifierSlots: record.verifierSlots ?? verifierRoster?.orderedSlots,
  });
}

function restoreRefutationPanelState(raw: unknown): SerializedRefutationPanelState | null {
  if (typeof raw !== "object" || raw === null || !("authority" in raw)) return null;
  const record = raw as Record<string, unknown>;
  const parsed = parseSerializedRefutationAuthority(record.authority);
  return parsed.ok ? { ...record, authority: parsed.value } : null;
}

/**
 * Rebuild a durable completion receipt by re-proving it from its persisted T2 state or
 * checkpoint; null when the persisted receipt is absent or differs from the re-proof.
 */
export function restoreRefutationCompletion(
  raw: unknown,
  aggregate: StandaloneReviewAggregate,
  panelAuthority: FrozenStandalonePanelAuthority,
  publicationResolver: PublicationAuthorityResolver,
): StandaloneRefutationCompletionReceipt | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const completedPanelState = restoreRefutationPanelState(record.completedPanelState);
  if (completedPanelState === null && record.completedPanelCheckpoint === undefined) return null;
  const parsed = parseStandaloneRefutationCompletion({
    panelAuthority,
    aggregate,
    ...(completedPanelState === null ? {} : { completedPanelState }),
    ...(record.completedPanelCheckpoint === undefined || record.completedPanelCheckpoint === null
      ? {}
      : { completedPanelCheckpoint: record.completedPanelCheckpoint }),
    publicationResolver,
  });
  if (!parsed.ok) return null;
  const supplied = {
    ...record,
    completedPanelState: completedPanelState ?? parsed.value.completedPanelState,
    completedPanelCheckpoint: record.completedPanelCheckpoint ?? null,
  };
  return canonicalStructuralEquals(
    serializableRefutationCompletion(parsed.value),
    serializableRefutationCompletion(supplied),
  ) ? parsed.value : null;
}
