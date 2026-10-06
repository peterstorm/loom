/**
 * The run-directory half of harness capture, shared by both adapters.
 *
 * `core/harness-capture` owns the RULES — one unambiguous final payload, exact
 * bytes, bind to issued authority. This module owns everything those rules need
 * from a run directory: which requests the run issued, which slots already
 * accepted a capture, which request a native correlator claims, and the write
 * itself.
 *
 * It lives here, and not inside either adapter, because FR-033 requires Pi and
 * Claude Code to capture into the SAME engine-declared slot under the same
 * refusals. A per-adapter copy of this half is exactly how the two harnesses
 * drift into disagreeing about which results are admissible — the drift the
 * shared rules module was written to prevent, reintroduced one layer down.
 * Each adapter therefore contributes only what is genuinely harness-native: how
 * to observe an Agent's final payload, what its own correlator is, and the
 * preliminary responsibilities each capture performs before that observation —
 * resolving the issued request against its registration, parsing the claimed
 * registration, and resource-bounding final-payload selection before any
 * transcript work.
 *
 * The emission seam (T7, AD-8/AD-9) lives here for the same reason: an adapter
 * that observed its transcript through the emission vocabulary hands over the
 * closed emission frames BESIDE the unchanged final-payload candidates, and
 * the canonical selection runs ONCE in this runtime against the ISSUED
 * authority the run directory itself certifies — the same pure eligibility
 * join the render path projects with (`resolveReviewerCaptureEmissionAuthority`).
 * The accepted source is published here too (bounded write-ahead artifact,
 * replay-idempotent), from the provenance the selection decision RETURNED —
 * never reconstructed by a later logger from the transcript.
 */

import { match } from "ts-pattern";
import {
  bindCapture,
  captureKey,
  nativeCaptureObservation,
  observeEmissionCalls,
  recoverNativeCaptureArtifact,
  captureRejectionAuditRecord,
  captureRejectionDedupKey,
  parseFinalPayload,
  type CaptureKey,
  type CaptureReceipt,
  type EmissionCallFrame,
  type FinalPayload,
  type FinalPayloadCandidate,
  type HarnessResultIdentity,
} from "../core/harness-capture";
import { selectCanonicalPayload } from "../core/emission-ingestion";
import type { IssuedEmissionBindingOf } from "../core/emission-tool";
import {
  issuedReviewerEmissionRoute,
  projectRegisteredReviewerProtocol,
  reviewerEmissionEligible,
} from "../core/reviewer-emission-route";
import { canonicalRecord, parseEffectId, type AgentRequestAuthority, type ArtifactRef, type ContextDigest, type DomainResult } from "../core/orchestration-contract";
import { sha256Hex } from "../core/digest";
import { canonicalJson, type JsonValue } from "../core/review-packet";
import { parseStandaloneReviewerProtocolV3 } from "../core/standalone-lineage-contract";
import { verifyStandalonePanelView } from "./standalone-panel-context";
import { openRegisteredRunDirectory, type RunDirHandle } from "./run-directory-handle";
import { CONTEXT_PACKET_MAX_BYTES } from "./stored-context-packets";
import { recordReadCoverageObservation, registeredReadCoverage } from "./standalone-read-coverage-evidence";

/**
 * Where a run directory is announced explicitly.
 *
 * Operator/supervisor-supplied only: NO production code writes either variable.
 * On both harnesses the façade publishes a durable SESSION RUN BINDING instead
 * (`registerSessionRunBinding`, keyed by `PI_SESSION_ID` on Pi and by
 * `CLAUDE_CODE_SESSION_ID` on Claude Code), and that binding — not the
 * environment — is what carries capture authority across a process boundary:
 * `pi/review-run-authority` reads it back for Pi, `claude-run-authority` for Claude's
 * PostToolUse and SubagentStop hooks. When either variable is set it takes
 * precedence over the binding and half of it is a fault; a supervisor or a test
 * may use them to pin a harness to one run. Absent, with no binding claiming the
 * agent, means "this agent is not part of an orchestration run", which is the
 * common case and NOT an error.
 */
export const RUNS_ROOT_ENV = "LOOM_ORCHESTRATION_RUNS_ROOT";
export const RUN_DIR_ENV = "LOOM_ORCHESTRATION_RUN_DIR";

export type TerminalCaptureRefusal = Readonly<{
  kind: "terminal-refusal";
  reason: string;
  message: string;
}>;

export type CaptureObservation =
  | Readonly<{ kind: "candidates"; candidates: readonly FinalPayloadCandidate[] }>
  | Readonly<{
      kind: "emission-observed";
      /** The harness adapter's complete assistant emission-tool-call frames —
       *  the closed observation vocabulary's input, folded ONCE here by
       *  `observeEmissionCalls` before the selection (AD-8). Zero frames is
       *  the ordinary no-tool observation, not a special case. */
      frames: readonly EmissionCallFrame[];
      /** The unchanged final-payload candidates the extraction arms fold. */
      candidates: readonly FinalPayloadCandidate[];
    }>
  | Readonly<{ kind: "unavailable"; reason: string; message: string }>
  | TerminalCaptureRefusal;

export const captureEmissionObservation = (
  frames: readonly EmissionCallFrame[],
  candidates: readonly FinalPayloadCandidate[],
): CaptureObservation =>
  Object.freeze({ kind: "emission-observed" as const, frames: Object.freeze([...frames]), candidates: Object.freeze([...candidates]) });

export type CaptureOutcome =
  | Readonly<{ kind: "not-an-orchestration-run" }>
  | Readonly<{ kind: "no-reservation"; agentId: string }>
  | Readonly<{ kind: "captured"; receipt: CaptureReceipt }>
  | Readonly<{ kind: "terminal-rejection"; reason: string; message: string }>
  | Readonly<{ kind: "retriable-failure"; reason: string; message: string }>;

export const terminalCaptureRefusal = (reason: string, message: string): TerminalCaptureRefusal =>
  Object.freeze({ kind: "terminal-refusal", reason, message });

export const captureUnavailable = (reason: string, message: string): CaptureObservation =>
  Object.freeze({ kind: "unavailable", reason, message });

export const captureCandidates = (candidates: readonly FinalPayloadCandidate[]): CaptureObservation =>
  Object.freeze({ kind: "candidates", candidates });

const retriableFailure = (reason: string, message: string): CaptureOutcome =>
  Object.freeze({ kind: "retriable-failure", reason, message });

// ---------------------------------------------------------------------------
// Issued reviewer emission authority at the capture seam (AD-7/AD-8, T7)
// ---------------------------------------------------------------------------

/**
 * What the capture seam's issued-authority resolution concluded for ONE
 * correlated reviewer request. The eligibility predicate, the registration's
 * protocol projection and the route decision are the render path's own
 * (`core/reviewer-emission-route`), so the two sides cannot disagree about
 * which requests are emission-enabled:
 *
 * - `ineligible` — the request names no issued reviewer-payload contract
 *   (non-producer roles/programs): the no-tool baseline. Observed emission
 *   calls are still refused, never absorbed as absence.
 * - `extraction-only` — the issued contract is explicit extraction-only
 *   (archived v1, unsupported registry cell, or a route the qualified-route
 *   gate does not trust): extraction-only authority cannot be upgraded by an
 *   observed emission call (AD-7).
 * - `emission` — the issued contract selects a frozen registry cell on the
 *   qualified route: the binding the selection admits against.
 * - `unavailable` — the issued authority itself could not be read or parsed:
 *   unavailable evidence, never an invented extraction result.
 *
 * The claim is minted from the DURABLE program registration and the issued
 * request authority — never from prompt markers, harness claims, or model
 * arguments (FR-001) — so a Claude harness (no Pi parent) is extraction-only
 * by construction and a non-qualified provider route cannot be upgraded by
 * any capture-side input.
 */
export type ReviewerCaptureEmissionAuthority =
  | Readonly<{ kind: "ineligible" }>
  | Readonly<{ kind: "extraction-only"; reason: string }>
  | Readonly<{ kind: "emission"; binding: IssuedEmissionBindingOf<"reviewer-payload">; contextDigest: ContextDigest }>
  | Readonly<{ kind: "unavailable"; message: string }>;

/**
 * Resolve the issued reviewer emission authority for one correlated request
 * from the run directory's own durable registration: this shell owns only the
 * registration read; the decision is `core/reviewer-emission-route`'s.
 */
export function resolveReviewerCaptureEmissionAuthority(
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  harness: HarnessResultIdentity["harness"],
): ReviewerCaptureEmissionAuthority {
  if (!reviewerEmissionEligible(request)) return Object.freeze({ kind: "ineligible" as const });
  const stored = handle.readProgramRegistration(16_777_216);
  if (!stored.ok) {
    return Object.freeze({ kind: "unavailable" as const, message: stored.error.message });
  }
  const projected = projectRegisteredReviewerProtocol(stored.value);
  if (!projected.ok) {
    return Object.freeze({ kind: "unavailable" as const, message: projected.error });
  }
  if (projected.value === null) return Object.freeze({ kind: "ineligible" as const });
  const route = issuedReviewerEmissionRoute(projected.value, request, harness === "pi");
  switch (route.kind) {
    case "emission":
      return Object.freeze({ kind: "emission" as const, binding: route.binding, contextDigest: route.contextDigest });
    case "extraction-only":
      return Object.freeze({ kind: "extraction-only" as const, reason: route.reason });
    case "refused":
      return Object.freeze({ kind: "unavailable" as const, message: route.reason });
  }
}

// ---------------------------------------------------------------------------
// Accepted-source provenance (FR-009): bounded, write-ahead, replay-idempotent
// ---------------------------------------------------------------------------

/**
 * The accepted source of one capture, returned BY the selection decision and
 * persisted beside the accepted bytes — never reconstructed by a later logger
 * from the transcript (the plan's provenance posture). The emission arm
 * carries the accepted call's identity and the issued schema digest; the
 * extraction-over-refused-call arm carries the single-call refusal that led
 * to the fallback (FR-006). The zero-call baseline arm carries no refusal —
 * there was none.
 */
export type CaptureSourceProvenance = Readonly<{
  source: "emission-tool" | "extraction";
  toolCallId?: string;
  producerKind?: string;
  /** The issued emission schema version — named `emissionSchemaVersion` in the
   *  record because the record itself carries its own `schemaVersion`. */
  emissionSchemaVersion?: string;
  schemaDigest?: string;
  emissionRefusal?: Readonly<{ code: string; message: string }>;
}>;

/** The bounded publication budget of one source record (the native-capture
 *  observation's bound — these records are small by construction). */
const CAPTURE_SOURCE_BOUND_BYTES = 16_384;

const captureSourceArtifactPath = (requestId: string): string => `capture-sources/${requestId}.json`;

/** The canonical source record for one accepted capture. Deterministic in its
 *  inputs, so an exact replay derives byte-identical record bytes. */
function captureSourceRecord(
  request: AgentRequestAuthority,
  harness: HarnessResultIdentity["harness"],
  provenance: CaptureSourceProvenance,
  payload: FinalPayload,
): Readonly<Record<string, JsonValue>> {
  return canonicalRecord({
    schemaVersion: 1,
    kind: "capture-source" as const,
    requestId: request.requestId,
    slotId: request.slotId,
    attempt: request.attempt,
    harness,
    source: provenance.source,
    ...(provenance.toolCallId === undefined ? {} : { toolCallId: provenance.toolCallId }),
    ...(provenance.producerKind === undefined ? {} : { producerKind: provenance.producerKind }),
    ...(provenance.emissionSchemaVersion === undefined ? {} : { emissionSchemaVersion: provenance.emissionSchemaVersion }),
    ...(provenance.schemaDigest === undefined ? {} : { schemaDigest: provenance.schemaDigest }),
    ...(provenance.emissionRefusal === undefined ? {} : { emissionRefusal: provenance.emissionRefusal }),
    payloadDigest: payload.digest,
    payloadByteLength: payload.byteLength,
  });
}

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

/**
 * Publish the bounded accepted-source record BEFORE the transcript write —
 * write-ahead evidence bound to the request, through the run directory's
 * existing no-follow artifact publication (the same mechanism and recovery
 * posture as the native capture observation).
 *
 * Exact-replay idempotent: a record already published with IDENTICAL bytes
 * (a crash between publication and the transcript write, replayed) proceeds;
 * a published record describing a DIFFERENT accepted source is a refusal —
 * the recorded selection is authoritative and is never rewritten or silently
 * reconciled (missing/corrupt provenance is unavailable evidence, never an
 * invented historical source).
 */
async function publishCaptureSourceRecord(
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  harness: HarnessResultIdentity["harness"],
  provenance: CaptureSourceProvenance,
  payload: FinalPayload,
): Promise<DomainResult<true, string>> {
  const serialized = canonicalJson(captureSourceRecord(request, harness, provenance, payload));
  const bytes = new TextEncoder().encode(serialized);
  if (bytes.length > CAPTURE_SOURCE_BOUND_BYTES) {
    return { ok: false, error: "capture-source record exceeds the 16384-byte publication bound" };
  }
  const path = captureSourceArtifactPath(request.requestId);
  const prior = handle.readArtifactBytes(path, CAPTURE_SOURCE_BOUND_BYTES);
  if (!prior.ok) return { ok: false, error: prior.error.message };
  if (prior.value !== null) {
    return bytesEqual(prior.value, bytes)
      ? { ok: true, value: true }
      : {
          ok: false,
          error: `capture-source provenance for request ${request.requestId} is already published with a different accepted source; the recorded selection is authoritative and is never rewritten`,
        };
  }
  const published = await handle.publishArtifactSet([{ relativePath: path, bytes: [...bytes] }]);
  return published.ok ? { ok: true, value: true } : { ok: false, error: published.error.message };
}

/**
 * Where an accepted payload came from, as the capture pipeline carries it to
 * persistence: chosen BY a selection decision (its provenance is published),
 * or the candidates-only arm no selection ran over (today's byte-identical
 * layout, no record). A closed union rather than a nullable provenance, so the
 * shared persistence pipeline below — not each purpose — decides publication.
 */
type CaptureSource =
  | Readonly<{ kind: "selected"; provenance: CaptureSourceProvenance }>
  | Readonly<{ kind: "unselected" }>;

const selectedSource = (provenance: CaptureSourceProvenance): CaptureSource =>
  Object.freeze({ kind: "selected" as const, provenance: Object.freeze(provenance) });

const UNSELECTED_SOURCE: CaptureSource = Object.freeze({ kind: "unselected" as const });

/**
 * Why a capture did not happen, in operator-facing words.
 *
 * Written beside the union rather than at the call site: `pi/extension` derived
 * it twice, byte-for-byte, in the two branches that report a failed capture, so
 * the two diagnostics could drift apart while describing the same value. A
 * `captured` outcome has no failure to describe and says so rather than
 * pretending to.
 */
export function describeCaptureFailure(outcome: CaptureOutcome): string {
  return match(outcome)
    .with({ kind: "terminal-rejection" }, ({ reason, message }) => `${reason}: ${message}`)
    .with({ kind: "retriable-failure" }, ({ reason, message }) => `${reason}: ${message}`)
    .with({ kind: "no-reservation" }, ({ agentId }) => `no reservation for ${agentId}`)
    .with({ kind: "not-an-orchestration-run" }, () => "orchestration run authority was unavailable")
    .with({ kind: "captured" }, () => "capture succeeded")
    .exhaustive();
}

/**
 * Terminalise one refused capture and return what the operator must be told.
 *
 * ONE home for the whole protocol — tombstone, audit record, and the journal
 * identity that record dedups by — because both adapters need it and two copies
 * had already drifted: the engine copy let a journal-append failure throw out of
 * a function whose stated contract is "refusals are returned, never thrown",
 * while the Pi copy turned the identical fault into a string. One journal fault,
 * two classifications, plus a shared dedup key only one side could change.
 *
 * The refusal is a parsed `TerminalCaptureRefusal`; infrastructure failures
 * cannot inhabit that type and therefore cannot call this protocol accidentally.
 * The durable diagnostic is derived once from its reason and message.
 *
 * It never throws, and it never loses the cause. When the tombstone cannot be
 * written the returned message carries the ORIGINAL refusal as well as the
 * persistence error, because at that point no on-disk trace of the reason exists
 * at all and "rejection-persistence" alone would name the wrong component.
 */
export async function terminalizeCaptureRejection(
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  refusal: TerminalCaptureRefusal,
): Promise<CaptureOutcome> {
  const diagnostic = `${refusal.reason}: ${refusal.message}`;
  let terminal: Awaited<ReturnType<RunDirHandle["rejectCapture"]>>;
  try {
    terminal = await handle.rejectCapture(request, diagnostic);
  } catch (error) {
    return retriableFailure(
      "rejection-persistence",
      `capture refused (${diagnostic}) and its rejection persistence crashed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!terminal.ok) {
    return retriableFailure(
      "rejection-persistence",
      `capture refused (${diagnostic}) and its rejection could not be persisted: ${terminal.error.message}`,
    );
  }
  try {
    await handle.appendEvent({
      schemaVersion: 1,
      sequence: 0,
      dedupKey: captureRejectionDedupKey(request.requestId, request.attempt),
      recordedAtMs: Date.now(),
      event: captureRejectionAuditRecord(request, diagnostic),
    });
    return { kind: "terminal-rejection", reason: refusal.reason, message: refusal.message };
  } catch (error) {
    return {
      kind: "terminal-rejection",
      reason: "rejection-audit-unsynchronized",
      message: `capture refused (${diagnostic}); it was terminalised but its audit event could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The issued request one native correlator resolves to, plus what a caller
 * needs to act on it.
 */
export type CorrelatedRequest = Readonly<{
  handle: RunDirHandle;
  issued: readonly AgentRequestAuthority[];
  identity: HarnessResultIdentity;
  request: AgentRequestAuthority;
}>;

export type CorrelatedRequestResolution =
  | Readonly<{ ok: true; value: CorrelatedRequest }>
  | Readonly<{ ok: false; outcome: CaptureOutcome }>;

/**
 * Resolve "which request does this native correlator answer" in ONE place.
 *
 * Opening the run, reading its correlator binding, and loading the issued
 * authority is the same three-step question for every consumer: the capture path
 * below, and `subagent-stop/dispatch`, which must know the program a stop
 * belongs to BEFORE it decides whether legacy TaskGraph settlement applies. Two
 * copies of that question is how a harness ends up calling a stop "unrelated"
 * while its own capture path still fills the slot, so the question has exactly
 * one asker.
 *
 * Decisions only — nothing here terminalises, tombstones, or writes. What an
 * unresolved correlator MEANS (refusal, tombstone, or silence for an agent in
 * nobody's run) belongs to the caller, and `ok: false` carries the same typed
 * `CaptureOutcome` the capture path already reports, so the caller that refuses
 * and the caller that audits cannot disagree about the words.
 */
export function resolveCorrelatedRequest(args: Readonly<{
  harness: HarnessResultIdentity["harness"];
  runsRoot: string | undefined;
  runDirectory: string | undefined;
  nativeId: string;
}>): CorrelatedRequestResolution {
  if (args.runsRoot === undefined && args.runDirectory === undefined) {
    return { ok: false, outcome: { kind: "not-an-orchestration-run" } };
  }
  if (args.runsRoot === undefined || args.runDirectory === undefined) {
    return {
      ok: false,
      outcome: retriableFailure(
        "run-authority",
        "orchestration capture requires both runsRoot and runDirectory",
      ),
    };
  }

  const opened = openRegisteredRunDirectory(args.runsRoot, args.runDirectory);
  if (!opened.ok) {
    return { ok: false, outcome: retriableFailure("run-directory", opened.error.message) };
  }
  const handle = opened.value;

  const correlator = handle.readHarnessCorrelator(args.harness, args.nativeId);
  if (!correlator.ok) {
    return { ok: false, outcome: retriableFailure("correlator", correlator.error.message) };
  }
  if (correlator.value === null) {
    return {
      ok: false,
      outcome: {
        kind: "no-reservation",
        agentId: args.nativeId.length === 0 ? "(missing)" : args.nativeId,
      },
    };
  }
  return resolveIssuedMatch(handle, correlator.value);
}

function resolveIssuedMatch(handle: RunDirHandle,
  binding: NonNullable<Extract<ReturnType<RunDirHandle["readHarnessCorrelator"]>, { ok: true }>["value"]>,
): CorrelatedRequestResolution {
  const issued = handle.readIssuedRequests();
  if (!issued.ok) {
    return { ok: false, outcome: retriableFailure("requests", issued.error.message) };
  }
  const request = issued.value.find(({ requestId }) => requestId === binding.requestId);
  if (request === undefined) {
    return {
      ok: false,
      outcome: retriableFailure(
        "unknown-request",
        "correlated request has no issued authority",
      ),
    };
  }
  if (binding.role !== request.role || binding.attempt !== request.attempt) {
    return {
      ok: false,
      outcome: {
        kind: "terminal-rejection",
        reason: "correlator-authority",
        message: `correlator authority ${binding.role}/attempt-${binding.attempt} does not match issued request ${request.role}/attempt-${request.attempt}`,
      },
    };
  }

  const identity: HarnessResultIdentity = Object.freeze({
    harness: binding.harness,
    requestId: binding.requestId,
    attempt: binding.attempt,
    nativeId: binding.nativeId,
  });
  return Object.freeze({
    ok: true,
    value: Object.freeze({ handle, issued: issued.value, identity, request }),
  });
}

/**
 * Capture one finished Agent's result into its reserved slot.
 *
 * Pure with respect to decisions: every refusal is returned as a typed outcome
 * the caller audits rather than guessed at. Terminal refusals that reached a
 * real reservation and left it UNFILLED are durably recorded
 * (`terminalizeCaptureRejection` tombstones the attempt and journals the audit
 * record), because a rejected attempt that left no trace is indistinguishable
 * from an attempt that never happened. Retriable infrastructure failures never
 * tombstone the attempt; environment repair may safely retry it.
 *
 * Two other families write nothing, both because they have nothing to write against.
 * The refusals that never resolved a reservation — `not-an-orchestration-run`,
 * `no-reservation`, `run-authority`, `run-directory`, `correlator`,
 * `requests`, and `unknown-request` — never reached one. And
 * `duplicate-capture` reached a reservation that is already durably FILLED:
 * `rejectCapture` refuses to tombstone a captured attempt by design. Current v3
 * alone may recover a missing receipt, after a fresh native observation proves
 * the original write-ahead request/context/correlator and exact captured bytes.
 * Existing receipts and legacy duplicates remain refusals; replay cannot recover.
 *
 * The adapter supplies the two harness-native facts — the native correlator and
 * every candidate final payload it observed — and nothing else differs between
 * them.
 *
 * Candidates are handed over in full rather than pre-selected: pre-selection is
 * exactly where "pick the last text block" hides an ambiguity the engine should
 * have refused.
 */
type CaptureHarnessInput = Readonly<{
  harness: HarnessResultIdentity["harness"];
  runsRoot: string | undefined;
  runDirectory: string | undefined;
  nativeId: string;
  /**
   * Every tool output the harness transcript records as delivered to the
   * Agent, in order — the read-coverage observation's only input (ADR-0022).
   * Lazy: it is called only when the Run carries a read obligation. Absent
   * means the adapter cannot observe tool outputs, which records an
   * unobservable attempt rather than inventing coverage.
   */
  observeToolOutputs?: () => readonly string[];
}> & (
  | Readonly<{ observe: () => CaptureObservation; candidates?: never }>
  | Readonly<{ candidates: readonly FinalPayloadCandidate[]; observe?: never }>
);

// ---------------------------------------------------------------------------
// Per-purpose capture persistence: ONE interface, both purposes behind it
// ---------------------------------------------------------------------------

/**
 * Everything that differs between the legacy capture purpose and the native
 * standalone-successor purpose, behind one interface. The purpose used to be a
 * flag branched at four call sites (candidate byte limit, duplicate set,
 * context reading, persistence); the successor branch of the last one returned
 * before the accepted-source publication, so a successor capture won by an
 * emission call recorded no source (FR-009). Now the purpose only supplies
 * its own steps, and `persistBoundCapture` runs the shared pipeline —
 * admit → publish the accepted source → write — so no purpose can skip the
 * publication.
 */
type CapturePersistence = Readonly<{
  /** A purpose-specific refusal over the observed candidates, decided before
   *  any selection or transcript work; null admits them. */
  refuseCandidates: (candidates: readonly FinalPayloadCandidate[]) => Readonly<{ reason: string; message: string }> | null;
  /** The already-captured set `bindCapture` refuses duplicates against. */
  duplicateGuard: (captured: ReadonlySet<CaptureKey>) => ReadonlySet<CaptureKey>;
  /** Every pre-write check this purpose owns (context binding, durable-receipt
   *  state). A returned outcome stops the capture; null proceeds. */
  admit: (handle: RunDirHandle, request: AgentRequestAuthority) => Promise<CaptureOutcome | null>;
  /** The purpose's durable write of the accepted bytes. */
  write: (
    handle: RunDirHandle,
    request: AgentRequestAuthority,
    receipt: CaptureReceipt,
    payload: FinalPayload,
    observation: "fresh" | "recapture",
  ) => Promise<CaptureOutcome>;
}>;

/** The context-binding refusal both purposes share: the packet the request
 *  names must describe that exact request and role. */
const contextBindingRefusal = (
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  context: Readonly<{ requestId: string; role: string }>,
): Promise<CaptureOutcome> | null =>
  context.requestId === request.requestId && context.role === request.role
    ? null
    : terminalizeCaptureRejection(handle, request, terminalCaptureRefusal(
        "context-binding",
        `context ${request.contextDigest} does not describe request ${request.requestId}/${request.role}`,
      ));

const LEGACY_CAPTURE: CapturePersistence = Object.freeze<CapturePersistence>({
  refuseCandidates: () => null,
  duplicateGuard: (captured) => captured,
  admit: async (handle, request) => {
    const context = handle.readContext(request.contextDigest);
    if (!context.ok) return retriableFailure("context", context.error.message);
    return contextBindingRefusal(handle, request, context.value);
  },
  write: async (handle, request, receipt, payload) => {
    const written = await handle.captureTranscript(request, payload.bytes);
    if (!written.ok) {
      const rejection = handle.readCaptureRejection(request);
      return rejection.ok && rejection.value !== null
        ? { kind: "terminal-rejection", reason: "transcript", message: written.error.message }
        : retriableFailure("transcript", written.error.message);
    }
    return { kind: "captured", receipt };
  },
});

const nativeCaptureEffect = (request: AgentRequestAuthority) =>
  parseEffectId(`effect:capture:${sha256Hex(`${request.requestId}:${request.attempt}`)}`);

const STANDALONE_SUCCESSOR_CAPTURE: CapturePersistence = Object.freeze<CapturePersistence>({
  refuseCandidates: (candidates) =>
    candidates.some(candidate => Buffer.byteLength(candidate.text, "utf8") > 1_048_576)
      ? Object.freeze({ reason: "payload-byte-limit", message: "native successor final exceeds the unchanged 1048576-byte reviewer budget" })
      : null,
  // Only current native capture can reconcile an unreceipted write. Its durable
  // observation and exact bytes are proved by `write`; legacy duplicate rules stay intact.
  duplicateGuard: () => new Set(),
  admit: async (handle, request) => {
    const context = request.program === "standalone-review"
      ? handle.readStandaloneSuccessorContext(request.contextDigest, CONTEXT_PACKET_MAX_BYTES)
      : handle.readContext(request.contextDigest);
    if (!context.ok) return retriableFailure("context", context.error.message);
    const unbound = contextBindingRefusal(handle, request, context.value);
    if (unbound !== null) return unbound;
    if (request.program === "refutation-panel") {
      if (context.value.schemaVersion === 3) return retriableFailure("context", "refutation uses its own explicit packet contract");
      const view = verifyStandalonePanelView(handle, context.value);
      if (!view.ok) return retriableFailure("context", view.error);
    }
    const effect = nativeCaptureEffect(request);
    if (!effect.ok) return retriableFailure("receipt", effect.error.message);
    const existing = handle.readReceipt(effect.value, 16_384);
    if (!existing.ok) return retriableFailure("receipt", existing.error.message);
    // Any existing receipt (including a foreign/contradictory one) precludes repair.
    // Normal already-receipted duplicate delivery remains a refusal, not a new witness.
    if (existing.value !== null) return { kind: "terminal-rejection", reason: "duplicate-capture", message: "native capture already has a durable receipt; duplicate delivery cannot replace it" };
    const rejected = handle.readCaptureRejection(request);
    if (!rejected.ok) return retriableFailure("transcript", rejected.error.message);
    if (rejected.value !== null) return { kind: "terminal-rejection", reason: "transcript", message: rejected.value };
    return null;
  },
  write: async (handle, request, receipt, payload, observation) => {
    const effect = nativeCaptureEffect(request);
    if (!effect.ok) return retriableFailure("receipt", effect.error.message);
    const artifact = await observeNativeCaptureArtifact(handle, request, receipt, payload, observation);
    if (!artifact.ok) return retriableFailure("transcript", artifact.error);
    const recorded = await handle.recordReceipt({ kind: "raw-transcript-captured", effectId: effect.value,
      runId: handle.runId, requestId: request.requestId, artifact: artifact.value });
    if (!recorded.ok) return retriableFailure("receipt", `native bytes captured but durable receipt unavailable: ${recorded.error.message}`);
    return { kind: "captured", receipt };
  },
});

/**
 * A read-coverage Run's persistence (ADR-0022): once the purpose's own
 * pre-write checks admit the capture, the attempt's read-coverage observation
 * is recorded write-ahead — before any accepted-source publication or
 * transcript write — so every captured standalone transcript of such a Run has
 * its observation beside it. Recording failure is retriable infrastructure,
 * never a consumed attempt. Requests of other programs (refutation verifiers)
 * carry no read obligation.
 */
function withReadCoverageObservation(
  persistence: CapturePersistence,
  observeToolOutputs: (() => readonly string[]) | undefined,
): CapturePersistence {
  return Object.freeze<CapturePersistence>({
    ...persistence,
    admit: async (handle, request) => {
      const stopped = await persistence.admit(handle, request);
      if (stopped !== null || request.program !== "standalone-review") return stopped;
      const recorded = await recordReadCoverageObservation(handle, request, observeToolOutputs === undefined ? null : observeToolOutputs());
      return recorded.ok ? null : retriableFailure("read-coverage", recorded.error);
    },
  });
}

/** The capture persistence the run's durable registration selects: a schema-3
 *  standalone-review registration (with the exact frozen v3 protocol) is the
 *  native successor purpose; every other registration is legacy. A
 *  read-coverage registration (ADR-0022) additionally records the attempt's
 *  read observation. One registration read decides both. */
function readCapturePersistence(
  handle: RunDirHandle,
  observeToolOutputs: (() => readonly string[]) | undefined,
): DomainResult<CapturePersistence, string> {
  const registration = handle.readProgramRegistration(16_777_216);
  if (!registration.ok) return { ok: false, error: registration.error.message };
  const raw = registration.value;
  const coverage = registeredReadCoverage(raw);
  if (!coverage.ok) return { ok: false, error: coverage.error };
  const successor = typeof raw === "object" && raw !== null && Object.getOwnPropertyDescriptor(raw, "schemaVersion")?.value === 3 &&
    Object.getOwnPropertyDescriptor(raw, "kind")?.value === "standalone-review";
  if (successor && !parseStandaloneReviewerProtocolV3(Object.getOwnPropertyDescriptor(raw, "reviewerProtocol")?.value).ok) {
    return { ok: false, error: "successor capture requires the exact registered protocol descriptor" };
  }
  const purpose = successor ? STANDALONE_SUCCESSOR_CAPTURE : LEGACY_CAPTURE;
  return { ok: true, value: coverage.value === null ? purpose : withReadCoverageObservation(purpose, observeToolOutputs) };
}

export async function captureHarnessResult(args: CaptureHarnessInput): Promise<CaptureOutcome> {
  const resolved = resolveCorrelatedRequest(args);
  if (!resolved.ok) return resolved.outcome;
  const { handle, issued, identity, request } = resolved.value;

  const reject = (reason: string, message: string): Promise<CaptureOutcome> =>
    terminalizeCaptureRejection(handle, request, terminalCaptureRefusal(reason, message));

  const observation = args.observe === undefined
    ? captureCandidates(args.candidates)
    : args.observe();
  if (observation.kind === "unavailable") return retriableFailure(observation.reason, observation.message);
  if (observation.kind === "terminal-refusal") {
    return terminalizeCaptureRejection(handle, request, observation);
  }
  const persistence = readCapturePersistence(handle, args.observeToolOutputs);
  if (!persistence.ok) return retriableFailure("registration", persistence.error);
  const refused = persistence.value.refuseCandidates(observation.candidates);
  if (refused !== null) return reject(refused.reason, refused.message);
  // The canonical selection seam (T7, AD-8/AD-9): an adapter that observed the
  // transcript through the emission vocabulary hands over BOTH projections —
  // assistant emission-tool-call frames and the unchanged final-payload
  // candidates — and the selection is made ONCE here, against the issued
  // authority the run directory itself carries. The candidates-only arm
  // below is the pre-selection adapters' existing contract and stays
  // byte-identical.
  if (observation.kind === "emission-observed") {
    return captureSelectedEmission(handle, request, identity, issued, args.harness, observation, persistence.value, reject);
  }
  const payload = parseFinalPayload(observation.candidates);
  if (!payload.ok) return reject(payload.error.reason, payload.error.message);
  return bindAndPersistCapture(handle, request, identity, issued, payload.value, persistence.value, UNSELECTED_SOURCE);
}

/**
 * The duplicate-bind rule the selection paths share with the extraction
 * baseline: `duplicate-capture` must NOT tombstone (the slot already holds
 * accepted bytes and `rejectCapture` refuses a captured attempt); every other
 * bind refusal leaves the reservation unfilled and is terminalised.
 */
async function bindAndPersistCapture(
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  identity: HarnessResultIdentity,
  issued: readonly AgentRequestAuthority[],
  payload: FinalPayload,
  persistence: CapturePersistence,
  source: CaptureSource,
): Promise<CaptureOutcome> {
  const captured = handle.readCapturedAttempts();
  if (!captured.ok) return retriableFailure("transcripts", captured.error.message);
  const bound = bindCapture({
    issued,
    identity,
    payload,
    alreadyCaptured: persistence.duplicateGuard(captured.value),
  });
  if (!bound.ok) {
    return bound.error.reason === "duplicate-capture"
      ? { kind: "terminal-rejection", reason: bound.error.reason, message: bound.error.message }
      : terminalizeCaptureRejection(handle, request, terminalCaptureRefusal(bound.error.reason, bound.error.message));
  }
  return persistBoundCapture(handle, request, bound.value, payload, persistence, source,
    captured.value.has(captureKey(request.slotId, request.attempt)) ? "recapture" : "fresh");
}

/**
 * The BOTH-causes diagnostic the two engine-refused selection arms share
 *  (FR-006/AD-9: one rejection carrying both causes, never two).
 */
const describeRefusalPair = (
  emissionRefusal: Readonly<{ code: string; message: string }>,
  extraction: Readonly<{ reason: string; message: string }>,
): string =>
  `emission arguments were refused [${emissionRefusal.code}]: ${emissionRefusal.message}; ` +
    `final-message extraction was refused [${extraction.reason}]: ${extraction.message}`;

/**
 * The capture seam's ONE canonical selection (AD-8/AD-9, T7): the emission
 * observation is folded once, the selection runs against the ISSUED binding
 * the run directory itself certifies (`resolveReviewerCaptureEmissionAuthority`
 * — never an adapter claim), and every closed selection arm maps onto the
 * existing capture outcome vocabulary. The refusal arms terminalise with the
 * selection's own diagnostics (FR-006/FR-007/FR-014); the accepted arms bind
 * and persist with the provenance the decision RETURNED, so the accepted
 * source is published by the decision site and never reconstructed from the
 * transcript later.
 *
 * Extraction-only and non-producer authority (the `ineligible` and
 * `extraction-only` arms — archived v1 contracts, unsupported registry cells,
 * routes the qualified-route gate does not trust, non-Pi harnesses) keep the
 * unchanged extraction semantics when NO emission call was observed, and
 * refuse an observed emission call outright: extraction-only authority cannot
 * be upgraded by a call to a tool the issued request never advertised (AD-7).
 */
async function captureSelectedEmission(
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  identity: HarnessResultIdentity,
  issued: readonly AgentRequestAuthority[],
  harness: HarnessResultIdentity["harness"],
  observation: Extract<CaptureObservation, { kind: "emission-observed" }>,
  persistence: CapturePersistence,
  reject: (reason: string, message: string) => Promise<CaptureOutcome>,
): Promise<CaptureOutcome> {
  const authority = resolveReviewerCaptureEmissionAuthority(handle, request, harness);
  if (authority.kind === "unavailable") return retriableFailure("emission-authority", authority.message);
  if (authority.kind !== "emission") {
    if (observation.frames.length > 0) {
      const authorityClass = authority.kind === "extraction-only" ? "extraction-only" : "non-producer";
      const detail = authority.kind === "extraction-only"
        ? authority.reason
        : `request ${request.requestId} carries no issued producer contract`;
      return reject("unexpected-emission-call",
        `capture observed ${observation.frames.length} emission tool call(s) under ${authorityClass} authority (${detail}); ` +
          "extraction-only authority cannot be upgraded by an observed emission call");
    }
    const payload = parseFinalPayload(observation.candidates);
    if (!payload.ok) return reject(payload.error.reason, payload.error.message);
    return bindAndPersistCapture(handle, request, identity, issued, payload.value, persistence, UNSELECTED_SOURCE);
  }
  const selection = selectCanonicalPayload(
    authority.binding,
    observeEmissionCalls(observation.frames),
    observation.candidates,
  );
  switch (selection.kind) {
    case "emission-tool-arguments":
      return bindAndPersistCapture(handle, request, identity, issued, selection.payload, persistence, selectedSource({
        source: "emission-tool" as const,
        toolCallId: selection.call.toolCallId,
        producerKind: selection.call.kind.kind,
        emissionSchemaVersion: authority.binding.version,
        schemaDigest: authority.binding.schemaDigest,
      }));
    case "final-message-extraction":
      if (!selection.fallback.ok) return reject(selection.fallback.error.reason, selection.fallback.error.message);
      return bindAndPersistCapture(handle, request, identity, issued, selection.fallback.value, persistence,
        selectedSource({ source: "extraction" as const }));
    case "extraction-over-refused-call":
      if (!selection.fallback.ok) {
        return reject("emission-and-extraction-refused", describeRefusalPair(selection.emissionRefusal, selection.fallback.error));
      }
      return bindAndPersistCapture(handle, request, identity, issued, selection.fallback.value, persistence, selectedSource({
        source: "extraction" as const,
        emissionRefusal: { code: selection.emissionRefusal.code, message: selection.emissionRefusal.message },
      }));
    case "duplicate-emission-call":
      return reject("ambiguous-emission-call",
        `result carried ${selection.calls.length} distinct emission tool calls ` +
          `(${selection.calls.map(({ toolCallId }) => toolCallId).join(", ")}); exactly one successfully executed call is allowed`);
    case "refused-call-no-fallback":
      return reject("emission-and-extraction-refused", describeRefusalPair(selection.emissionRefusal, selection.extraction));
    case "observation-refused":
      return reject(selection.refusal.code, selection.refusal.message);
  }
}

/**
 * The shared persistence pipeline every purpose runs: the purpose's own
 * pre-write checks, then the accepted source published BEFORE the write
 * (write-ahead, same posture as the native capture observation) whenever a
 * selection decision produced the payload, then the purpose's write. The
 * candidates-only arm publishes nothing and keeps today's byte-identical
 * layout. Publication failure is retriable infrastructure, never a consumed
 * attempt and never a silently-unrecorded source.
 */
async function persistBoundCapture(
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  receipt: CaptureReceipt,
  payload: FinalPayload,
  persistence: CapturePersistence,
  source: CaptureSource,
  observation: "fresh" | "recapture",
): Promise<CaptureOutcome> {
  const stopped = await persistence.admit(handle, request);
  if (stopped !== null) return stopped;
  if (source.kind === "selected") {
    const published = await publishCaptureSourceRecord(handle, request, receipt.harness, source.provenance, payload);
    if (!published.ok) return retriableFailure("capture-source", published.error);
  }
  return persistence.write(handle, request, receipt, payload, observation);
}

async function observeNativeCaptureArtifact(
  handle: RunDirHandle,
  request: AgentRequestAuthority,
  receipt: CaptureReceipt,
  payload: FinalPayload,
  observation: "fresh" | "recapture",
): Promise<DomainResult<ArtifactRef, string>> {
  const path = `native-capture-observations/${request.requestId}.json`;
  if (observation === "recapture") {
    const prior = handle.readArtifactBytes(path, 16_384);
    if (!prior.ok) return { ok: false, error: prior.error.message };
    const bytes = handle.readTranscriptBytes(request, 1_048_576);
    if (!bytes.ok) return { ok: false, error: bytes.error.message };
    return recoverNativeCaptureArtifact({ request, receipt, payload, observation: prior.value, capturedBytes: bytes.value });
  }
  const bytes = Buffer.from(nativeCaptureObservation(request, receipt, payload.origin));
  if (bytes.length > 16_384) return { ok: false, error: "native capture observation exceeds 16384-byte bound" };
  // Freeze request/context/native identity BEFORE the exclusive raw write. This is
  // inert write-ahead evidence, not a receipt; replay never promotes it to authority.
  const observed = await handle.publishArtifactSet([{ relativePath: path, bytes: [...bytes] }]);
  if (!observed.ok) return { ok: false, error: observed.error.message };
  const written = await handle.captureTranscript(request, payload.bytes);
  return written.ok ? written : { ok: false, error: written.error.message };
}

/**
 * Render a capture outcome for the audit log, or `null` when there was nothing
 * to capture. Both adapters emit the SAME text: a rejection must be visible,
 * because silence here looks exactly like a run that had nothing to capture.
 */
export function captureAuditLine(prefix: string, outcome: CaptureOutcome): string | null {
  if (outcome.kind === "terminal-rejection") {
    return `${prefix}: rejected (${outcome.reason}): ${outcome.message}\n`;
  }
  if (outcome.kind === "retriable-failure") {
    return `${prefix}: retriable failure (${outcome.reason}): ${outcome.message}\n`;
  }
  if (outcome.kind === "no-reservation") {
    return `${prefix}: no reservation for ${outcome.agentId}\n`;
  }
  if (outcome.kind === "captured") {
    return `${prefix}: captured ${outcome.receipt.requestId} (${outcome.receipt.byteLength} bytes)\n`;
  }
  return null;
}
