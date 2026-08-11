/**
 * Closed effect execution and receipt reconciliation.
 *
 * Every edge effect a program can request is one of the six `EffectIntent`
 * variants the contract closes over. The runner dispatches an intent to the
 * narrow adapter that owns it, then hands the raw result to the PURE
 * `reconcileEffectReceipt` — the runner never decides for itself that an
 * effect succeeded.
 *
 * Receipts make effects idempotent across resumes. Before running anything,
 * the runner asks the run directory whether this effect id already recorded a
 * receipt; if so it reconciles against the stored one and performs no second
 * effect. That is what lets a crashed run resume without republishing, and it
 * is why a receipt is written under the effect's own id rather than a fresh
 * one.
 */

import {
  canonicalRecord,
  reconcileEffectReceipt,
  type EffectId,
  type EffectIntent,
  type EffectReceipt,
  type DomainResult,
} from "../core/orchestration-contract";
import type { RunDirHandle, StagedArtifact } from "./run-directory-handle";

export type EffectRunnerError = Readonly<{
  kind: "effect-execution-failed";
  effectId: EffectId | null;
  retriable: boolean;
  message: string;
}>;

const failure = <T>(
  effectId: EffectId | null,
  retriable: boolean,
  message: string,
): DomainResult<T, EffectRunnerError> =>
  ({ ok: false, error: canonicalRecord({ kind: "effect-execution-failed" as const, effectId, retriable, message }) });

const success = <T>(value: T): DomainResult<T, EffectRunnerError> => ({ ok: true, value });

/**
 * Adapters for the effects this runtime does not own itself. Filesystem
 * publication and transcript capture are the run directory's job; protected
 * state and Git are separate narrow adapters, supplied by the caller so this
 * module never acquires a `StateManager` or a subprocess of its own.
 */
export type EffectPorts = Readonly<{
  commitProtectedWaveState: (
    intent: Extract<EffectIntent, { kind: "commit-protected-wave-state" }>,
  ) => Promise<unknown>;
  inspectGitRemediation: (
    intent: Extract<EffectIntent, { kind: "inspect-git-remediation" }>,
  ) => Promise<unknown>;
  installVerifiedIndex: (
    intent: Extract<EffectIntent, { kind: "install-verified-index" }>,
  ) => Promise<unknown>;
}>;

/** Bytes a publish intent refers to, resolved by the caller that staged them. */
export type ArtifactResolver = (intent: Extract<EffectIntent, { kind: "publish-artifact-set" }>) => readonly StagedArtifact[];

export type EffectRunner = (intent: EffectIntent) => Promise<DomainResult<EffectReceipt, EffectRunnerError>>;

/**
 * Reconcile a raw adapter result against its intent. A receipt that does not
 * match the intent it claims to answer is a hard failure: the pure reconciler
 * is the only thing allowed to turn an adapter's word into a receipt.
 */
function reconcile(
  intent: EffectIntent,
  raw: unknown,
): DomainResult<EffectReceipt, EffectRunnerError> {
  const reconciled = reconcileEffectReceipt(intent, raw);
  return reconciled.ok
    ? success(reconciled.value)
    : failure(intent.effectId, false, `${reconciled.error.field}: ${reconciled.error.message}`);
}

async function runPublishArtifactSet(
  handle: RunDirHandle,
  resolveArtifacts: ArtifactResolver,
  intent: Extract<EffectIntent, { kind: "publish-artifact-set" }>,
): Promise<DomainResult<EffectReceipt, EffectRunnerError>> {
  const staged = resolveArtifacts(intent);
  if (staged.length !== intent.artifacts.length) {
    return failure(intent.effectId, false, "staged artifact count does not match the intent's artifact set");
  }
  const published = await handle.publishArtifactSet(staged);
  if (!published.ok) return failure(intent.effectId, true, published.error.message);
  return reconcile(intent, canonicalRecord({
    kind: "artifact-set-published" as const,
    effectId: intent.effectId,
    runId: intent.runId,
    artifacts: published.value,
  }));
}

async function runReserveAgentRequests(
  handle: RunDirHandle,
  intent: Extract<EffectIntent, { kind: "reserve-agent-requests" }>,
): Promise<DomainResult<EffectReceipt, EffectRunnerError>> {
  const requestIds = [];
  for (const request of intent.requests) {
    const reserved = await handle.reserveRequest(request);
    if (!reserved.ok) return failure(intent.effectId, false, reserved.error.message);
    requestIds.push(reserved.value.requestId);
  }
  return reconcile(intent, canonicalRecord({
    kind: "agent-requests-reserved" as const,
    effectId: intent.effectId,
    runId: intent.runId,
    requestIds,
  }));
}

async function runCaptureRawTranscript(
  handle: RunDirHandle,
  intent: Extract<EffectIntent, { kind: "capture-raw-transcript" }>,
): Promise<DomainResult<EffectReceipt, EffectRunnerError>> {
  const captured = await handle.captureTranscript(intent.request, intent.bytes);
  if (!captured.ok) return failure(intent.effectId, false, captured.error.message);
  return reconcile(intent, canonicalRecord({
    kind: "raw-transcript-captured" as const,
    effectId: intent.effectId,
    runId: intent.runId,
    requestId: intent.request.requestId,
    artifact: captured.value,
  }));
}

async function runThroughPort(
  intent: EffectIntent,
  port: () => Promise<unknown>,
): Promise<DomainResult<EffectReceipt, EffectRunnerError>> {
  const raw = await (async (): Promise<unknown> => {
    try {
      return await port();
    } catch (error) {
      return canonicalRecord({ __failed: error instanceof Error ? error.message : String(error) });
    }
  })();
  const failed = (raw as Record<string, unknown> | null)?.["__failed"];
  return typeof failed === "string"
    ? failure(intent.effectId, true, failed)
    : reconcile(intent, raw);
}

/**
 * Build the runner. `handle` owns run-directory effects; `ports` own the ones
 * that reach outside it. The returned function is the ONLY way a program's
 * effect intent becomes a receipt.
 */
export function createEffectRunner(args: Readonly<{
  handle: RunDirHandle;
  ports: EffectPorts;
  resolveArtifacts: ArtifactResolver;
}>): EffectRunner {
  return async (intent: EffectIntent): Promise<DomainResult<EffectReceipt, EffectRunnerError>> => {
    // Resume path: an effect that already recorded a receipt is never re-run.
    // A receipt that exists but cannot be read stops the runner: re-executing
    // on an unreadable receipt is exactly the double-effect this guard exists
    // to prevent, so it is retriable rather than silently re-run.
    const recorded = args.handle.readReceipt(intent.effectId);
    if (!recorded.ok) return failure(intent.effectId, true, recorded.error.message);
    if (recorded.value !== null) return reconcile(intent, recorded.value);

    const executed = await executeIntent(args, intent);
    if (!executed.ok) return executed;

    const stored = await args.handle.recordReceipt(executed.value);
    return stored.ok ? executed : failure(intent.effectId, false, stored.error.message);
  };
}

function executeIntent(
  args: Readonly<{ handle: RunDirHandle; ports: EffectPorts; resolveArtifacts: ArtifactResolver }>,
  intent: EffectIntent,
): Promise<DomainResult<EffectReceipt, EffectRunnerError>> {
  switch (intent.kind) {
    case "publish-artifact-set":
      return runPublishArtifactSet(args.handle, args.resolveArtifacts, intent);
    case "reserve-agent-requests":
      return runReserveAgentRequests(args.handle, intent);
    case "capture-raw-transcript":
      return runCaptureRawTranscript(args.handle, intent);
    case "commit-protected-wave-state":
      return runThroughPort(intent, () => args.ports.commitProtectedWaveState(intent));
    case "inspect-git-remediation":
      return runThroughPort(intent, () => args.ports.inspectGitRemediation(intent));
    case "install-verified-index":
      return runThroughPort(intent, () => args.ports.installVerifiedIndex(intent));
  }
}
