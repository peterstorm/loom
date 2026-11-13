/**
 * The Trusted Review Witness Aggregate (docs/contexts/harness/CONTEXT.md): the Pi extension's
 * witnesses of captured standalone-review transcripts, grouped by session,
 * Standalone Review root and Review Run, and the replay that turns the current
 * run's witnesses into a Loom review-authority receipt.
 *
 * The aggregate is a port created once per extension factory and injected
 * wherever it is touched — spawn admission binds a run (and retracts that
 * binding when it refuses the spawn), result capture records a witness, the
 * review-authority bridge verifies, session shutdown prunes — so every caller,
 * and every test, holds its own isolated instance rather than reaching a
 * process-global map through an import.
 *
 * Ordering law: a run becomes current when its first exact standalone spawn is
 * bound before dispatch; retries and later captures enrich that run without
 * reordering it. A spawn refused after binding a new run retracts it while it
 * is still unwitnessed, so a refusal never leaves an empty run current.
 * Verification considers only the current run for the root; rejection or a
 * missing capture never falls back to an older run; exact acceptance is
 * idempotent and retires the root's older witnesses.
 */

import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { CaptureOutcome } from "../engine/src/orchestration/harness-capture-runtime";
import { openRegisteredRunDirectory, type RunDirHandle } from "../engine/src/orchestration/run-directory-handle";
import {
  parseRegisteredFacadeProgram,
  readStandaloneReviewedSource,
  replayStandaloneCapturedEvidence,
  replayStandaloneResultFromEvidence,
} from "../engine/src/handlers/helpers/programs";
import type { LoomReviewAuthorityReceipt } from "../engine/src/core/review-authority-receipt";
import { readRunBytesNoFollow } from "../engine/src/utils/no-follow-fs";
import type { SessionRunBinding } from "../engine/src/orchestration/session-run-bindings";
import { captureKey, type CaptureKey } from "../engine/src/core/harness-capture";
import { reduceStandaloneReviewMachine } from "../engine/src/core/standalone-review";
import {
  parseArtifactDigest,
  parseContextDigest,
  type ArtifactDigest,
  type ContextDigest,
  type RequestId,
  type SlotId,
} from "../engine/src/core/orchestration-contract";
import { orchestrationMarkers } from "./review-run-authority";

/** Whether a touch made its run current (`bound`) or found it already bound. */
export type TrustedReviewRunTouch = "bound" | "already-bound";

/** The aggregate's interface: the moments a witness is touched. */
export type TrustedReviewWitnesses = Readonly<{
  /** Bind a run as current for its root on its first exact standalone spawn;
   *  a retry of an already-bound run never reorders it. */
  touch: (sessionId: string, binding: SessionRunBinding) => TrustedReviewRunTouch;
  /** Undo a `bound` touch whose spawn was refused: the run is dropped while
   *  it holds no witnessed capture, so the root's previous run is current
   *  again. A run that has since witnessed a capture is kept. */
  retract: (sessionId: string, binding: SessionRunBinding) => void;
  /** Witness one exactly captured transcript under its run. Throws when the
   *  task's authority markers or the receipt digest cannot be trusted. */
  remember: (
    sessionId: string,
    binding: SessionRunBinding,
    role: string,
    task: string,
    outcome: Extract<CaptureOutcome, { kind: "captured" }>,
  ) => void;
  /** Replay the current run for `<cwd>/.claude/reviews/review-and-fix-runs`
   *  and return its receipt, or throw the refusal. */
  verify: (input: Readonly<{ cwd: string; sessionId: string }>) => Promise<LoomReviewAuthorityReceipt>;
  /** Session shutdown retires every witness the session accumulated. */
  forget: (sessionId: string) => void;
}>;

type TrustedReviewCapture = Readonly<{
  /** The receipt's own branded identities: the witness is compared against
   *  issued authority, so it keeps the authority's types, not bare strings. */
  requestId: RequestId;
  slotId: SlotId;
  attempt: 1 | 2;
  /** The harness-reported agent type, compared against the issued role. */
  role: string;
  /** Branded, because this proof compares two 64-hex fields: as plain strings
   *  the context digest and the transcript digest were mutually interchangeable
   *  at the construction site, which is the one place a swap must be impossible.
   */
  contextDigest: ContextDigest;
  digest: ArtifactDigest;
  byteLength: number;
}>;

type TrustedReviewRun = Readonly<{
  binding: SessionRunBinding;
  captures: ReadonlyMap<CaptureKey, TrustedReviewCapture>;
  touchedAt: number;
}>;

type TrustedReviewRoot = Readonly<{
  nextTouch: number;
  runs: ReadonlyMap<string, TrustedReviewRun>;
}>;

/** A rewrite of one run's witnessed captures. */
type CaptureUpdate = (captures: ReadonlyMap<CaptureKey, TrustedReviewCapture>) => ReadonlyMap<CaptureKey, TrustedReviewCapture>;

/** The Standalone Review root a session's verification reads. */
const standaloneReviewRoot = (cwd: string): string => resolve(cwd, ".claude/reviews/review-and-fix-runs");

type TrustedRunVerification =
  | Readonly<{ kind: "rejected"; message: string }>
  | Readonly<{ kind: "accepted"; receipt: LoomReviewAuthorityReceipt }>;

function trustedCaptureProblem(handle: RunDirHandle, run: TrustedReviewRun): string | null {
  const issued = handle.readIssuedRequests();
  const captured = handle.readCapturedAttempts();
  if (!issued.ok) return issued.error.message;
  if (!captured.ok) return captured.error.message;
  for (const key of captured.value) {
    const authority = issued.value.find((request) =>
      captureKey(request.slotId, request.attempt) === key);
    const trusted = run.captures.get(key);
    if (authority === undefined || trusted === undefined || authority.requestId !== trusted.requestId ||
        authority.role !== trusted.role || authority.contextDigest !== trusted.contextDigest) {
      return `captured slot ${key} was not witnessed with identical request authority`;
    }
    const bytes = handle.readTranscriptBytes(authority);
    if (!bytes.ok) return bytes.error.message;
    const digest = createHash("sha256").update(bytes.value).digest("hex");
    if (digest !== trusted.digest || bytes.value.byteLength !== trusted.byteLength) {
      return `captured slot ${key} changed after Pi witnessed it`;
    }
  }
  const absentWitness = [...run.captures.keys()].find((key) => !captured.value.has(key));
  if (absentWitness !== undefined) {
    return `witnessed slot ${absentWitness} is absent from the Run Directory`;
  }
  return run.captures.size === 0 ? "no transcript capture was witnessed" : null;
}

async function verifyTrustedReviewRun(
  input: Readonly<{ sessionId: string }>,
  run: TrustedReviewRun,
): Promise<TrustedRunVerification> {
  const reject = (message: string): TrustedRunVerification => ({
    kind: "rejected",
    message: `${run.binding.runId}: ${message}`,
  });
  const opened = openRegisteredRunDirectory(run.binding.runsRoot, run.binding.runDirectory);
  if (!opened.ok) return reject(opened.error.message);
  const programRaw = opened.value.readProgramRegistration();
  if (!programRaw.ok || programRaw.value === null) {
    return reject(programRaw.ok ? "registered program is missing" : programRaw.error.message);
  }
  const program = parseRegisteredFacadeProgram(programRaw.value);
  if (program.kind !== "registered" || program.program.kind !== "standalone-review") {
    return reject("registered program is not a valid Standalone Review");
  }
  const captureProblem = trustedCaptureProblem(opened.value, run);
  if (captureProblem !== null) return reject(captureProblem);
  const replayed = program.program.schemaVersion === 3
    ? await replayStandaloneCapturedEvidence(opened.value, program.program, run.captures)
    : replayStandaloneResultFromEvidence(opened.value, program.program, run.captures);
  if (!replayed.ok) return reject(`engine evidence replay did not prove completion: ${replayed.message}`);
  let resultBytes: Buffer;
  try {
    resultBytes = readRunBytesNoFollow(join(opened.value.runDirectory, "result.json"));
  } catch (error) {
    return reject(`cannot read canonical result artifact: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!resultBytes.equals(Buffer.from(replayed.json, "utf8"))) {
    return reject("result.json does not match checkpoint-independent evidence replay");
  }
  if (program.program.schemaVersion === 3) {
    const receipt = opened.value.readReceipt(replayed.ready.publicationIntent.effectId, 16_384);
    if (!receipt.ok || receipt.value?.kind !== "artifact-set-published") return reject("successor result publication receipt is unavailable");
    const published = reduceStandaloneReviewMachine(replayed.ready, { kind: "result-published", result: JSON.parse(replayed.json), receipt: receipt.value });
    if (!published.ok || published.value.kind !== "done") return reject("successor result publication receipt differs from native replay");
  }
  const reviewedSource = readStandaloneReviewedSource(opened.value, program.program, 16_777_216,
    replayed.ready.authority.schemaVersion === 3 ? replayed.ready.authority.successor : undefined);
  if (!reviewedSource.ok) return reject(`reviewed source attestation failed: ${reviewedSource.message}`);
  return { kind: "accepted", receipt: Object.freeze({
    schemaVersion: 1,
    kind: "loom-review-authority-receipt",
    sessionId: input.sessionId,
    runId: run.binding.runId,
    runsRoot: run.binding.runsRoot,
    runDirectory: run.binding.runDirectory,
    requestIds: Object.freeze([...new Set([...run.captures.values()].map(({ requestId }) => requestId))].sort()),
    resultDigest: replayed.digest,
    reviewedSource: reviewedSource.value,
  }) };
}

/** Where a binding's run lives in the aggregate: its root and run identities,
 *  derived in this one place. */
type TrustedRunLocation = Readonly<{ rootIdentity: string; runIdentity: string }>;

const trustedRunLocation = ({ runsRoot, runDirectory }: SessionRunBinding): TrustedRunLocation =>
  Object.freeze({ rootIdentity: resolve(runsRoot), runIdentity: `${runsRoot}\0${runDirectory}` });

const EMPTY_TRUSTED_ROOT: TrustedReviewRoot = Object.freeze({ nextTouch: 1, runs: new Map<string, TrustedReviewRun>() });

/** The root with one run touched: a new run is bound at the root's next touch
 *  ordinal; an existing one keeps its ordinal, so it is never reordered. */
function rootWithRunTouched(
  root: TrustedReviewRoot,
  runIdentity: string,
  binding: SessionRunBinding,
  updateCaptures: CaptureUpdate,
): TrustedReviewRoot {
  const previous = root.runs.get(runIdentity);
  const runs = new Map(root.runs);
  runs.set(runIdentity, Object.freeze({
    binding,
    captures: updateCaptures(previous?.captures ?? new Map<CaptureKey, TrustedReviewCapture>()),
    touchedAt: previous?.touchedAt ?? root.nextTouch,
  }));
  return Object.freeze({ nextTouch: previous === undefined ? root.nextTouch + 1 : root.nextTouch, runs });
}

/** The root with one run removed — `null` when no run remains, because an
 *  empty root must never linger as a container with no current run. */
function rootWithoutRun(root: TrustedReviewRoot, runIdentity: string): TrustedReviewRoot | null {
  const runs = new Map(root.runs);
  runs.delete(runIdentity);
  return runs.size === 0 ? null : Object.freeze({ nextTouch: root.nextTouch, runs });
}

/** The capture a task's exact authority markers and its receipt witness.
 *  Throws when the markers or the receipt digest cannot be trusted. */
function witnessedCapture(
  role: string,
  task: string,
  outcome: Extract<CaptureOutcome, { kind: "captured" }>,
): TrustedReviewCapture {
  const markers = orchestrationMarkers(task, `captured ${outcome.receipt.requestId}`);
  if (markers === null || markers.requestId !== outcome.receipt.requestId) {
    throw new Error(`captured request ${outcome.receipt.requestId} is missing its exact task authority markers`);
  }
  const contextDigest = parseContextDigest(markers.contextDigest);
  if (!contextDigest.ok) {
    throw new Error(`captured request ${outcome.receipt.requestId} carries an invalid context marker: ${contextDigest.error.message}`);
  }
  const digest = parseArtifactDigest(outcome.receipt.digest);
  if (!digest.ok) {
    throw new Error(`captured request ${outcome.receipt.requestId} carries an invalid receipt digest: ${digest.error.message}`);
  }
  return Object.freeze({
    requestId: outcome.receipt.requestId,
    slotId: outcome.receipt.slotId,
    attempt: outcome.receipt.attempt,
    role,
    contextDigest: contextDigest.value,
    digest: digest.value,
    byteLength: outcome.receipt.byteLength,
  });
}

/** The root's current run: the one touched last. */
const currentRunOf = (root: TrustedReviewRoot): readonly [string, TrustedReviewRun] =>
  [...root.runs.entries()].reduce((latest, candidate) =>
    candidate[1].touchedAt > latest[1].touchedAt ? candidate : latest);

/** A session root's current run as the store saw it. `root` is the version
 *  the lookup observed: settling compares it against the stored root, so a
 *  touch, retraction or forget in between is detected, never overwritten. */
type ObservedCurrentRun = Readonly<{
  sessionId: string;
  rootIdentity: string;
  root: TrustedReviewRoot;
  runIdentity: string;
  run: TrustedReviewRun;
}>;

type CurrentRunLookup =
  | Readonly<{ kind: "no-session" }>
  | Readonly<{ kind: "no-root" }>
  | Readonly<{ kind: "current"; current: ObservedCurrentRun }>;

/** The session → root → run storage behind the aggregate. */
type WitnessSessions = Map<string, Map<string, TrustedReviewRoot>>;

const rootOf = (sessions: WitnessSessions, sessionId: string, rootIdentity: string): TrustedReviewRoot | undefined =>
  sessions.get(sessionId)?.get(rootIdentity);

/** Store a session's root, or drop it (`null`): the one rule by which an
 *  emptied root and an emptied session are collapsed rather than kept. */
function storeRoot(sessions: WitnessSessions, sessionId: string, rootIdentity: string, root: TrustedReviewRoot | null): void {
  const sessionRoots = sessions.get(sessionId) ?? new Map<string, TrustedReviewRoot>();
  if (root === null) sessionRoots.delete(rootIdentity);
  else sessionRoots.set(rootIdentity, root);
  if (sessionRoots.size === 0) sessions.delete(sessionId);
  else sessions.set(sessionId, sessionRoots);
}

/** Bind (or enrich) a binding's run; a new run becomes current. */
function updateRun(sessions: WitnessSessions, sessionId: string, binding: SessionRunBinding, updateCaptures: CaptureUpdate): TrustedReviewRunTouch {
  const { rootIdentity, runIdentity } = trustedRunLocation(binding);
  const root = rootOf(sessions, sessionId, rootIdentity) ?? EMPTY_TRUSTED_ROOT;
  const touch = root.runs.has(runIdentity) ? "already-bound" : "bound";
  storeRoot(sessions, sessionId, rootIdentity, rootWithRunTouched(root, runIdentity, binding, updateCaptures));
  return touch;
}

/** Drop a binding's run while it holds no witnessed capture: a witnessed run
 *  is authority and is kept. */
function retractUnwitnessed(sessions: WitnessSessions, sessionId: string, binding: SessionRunBinding): void {
  const { rootIdentity, runIdentity } = trustedRunLocation(binding);
  const root = rootOf(sessions, sessionId, rootIdentity);
  const run = root?.runs.get(runIdentity);
  if (root === undefined || run === undefined || run.captures.size > 0) return;
  storeRoot(sessions, sessionId, rootIdentity, rootWithoutRun(root, runIdentity));
}

/** The session root's current run, with the root version it was read from. */
function currentRun(sessions: WitnessSessions, sessionId: string, rootIdentity: string): CurrentRunLookup {
  if (!sessions.has(sessionId)) return { kind: "no-session" };
  const root = rootOf(sessions, sessionId, rootIdentity);
  if (root === undefined || root.runs.size === 0) return { kind: "no-root" };
  const [runIdentity, run] = currentRunOf(root);
  return { kind: "current", current: Object.freeze({ sessionId, rootIdentity, root, runIdentity, run }) };
}

/** Whether the root still is the version `current` observed. */
const stillCurrent = (sessions: WitnessSessions, current: ObservedCurrentRun): boolean =>
  rootOf(sessions, current.sessionId, current.rootIdentity) === current.root;

/** Compare-and-swap the observed root to hold only its current run, so the
 *  older witnesses can never become fallback authority. False, and nothing
 *  written, when the root changed since it was observed. Idempotent. */
function retireOtherRuns(sessions: WitnessSessions, current: ObservedCurrentRun): boolean {
  if (!stillCurrent(sessions, current)) return false;
  storeRoot(sessions, current.sessionId, current.rootIdentity, Object.freeze({
    nextTouch: current.root.nextTouch,
    runs: new Map([[current.runIdentity, current.run]]),
  }));
  return true;
}

/** The store: every invariant of the keying lives in the operations above —
 *  an emptied root or session is collapsed, a run is never reordered, and
 *  settling a verification is a compare-and-swap on the observed root. */
function trustedWitnessStore() {
  const sessions: WitnessSessions = new Map();
  return Object.freeze({
    updateRun: (sessionId: string, binding: SessionRunBinding, updateCaptures: CaptureUpdate): TrustedReviewRunTouch =>
      updateRun(sessions, sessionId, binding, updateCaptures),
    retractUnwitnessed: (sessionId: string, binding: SessionRunBinding): void => retractUnwitnessed(sessions, sessionId, binding),
    currentRun: (sessionId: string, rootIdentity: string): CurrentRunLookup => currentRun(sessions, sessionId, rootIdentity),
    /** Settle a REJECTED verification: true while the root is unchanged;
     *  nothing is retired or promoted. */
    stillCurrent: (current: ObservedCurrentRun): boolean => stillCurrent(sessions, current),
    /** Settle an ACCEPTED verification (compare-and-swap). */
    retireOtherRuns: (current: ObservedCurrentRun): boolean => retireOtherRuns(sessions, current),
    forget: (sessionId: string): void => {
      sessions.delete(sessionId);
    },
  });
}

/** Prove the session's current Standalone Review run for `cwd`. An exact
 *  acceptance is idempotent and retires the root's older witnesses so they can
 *  never make a later verification ambiguous or become fallback authority
 *  after a new run is touched. A root that changed while verification was in
 *  flight is refused whatever the verdict: no older authority is accepted. */
async function verifyWitnessedStandaloneReview(
  store: ReturnType<typeof trustedWitnessStore>,
  input: Readonly<{ cwd: string; sessionId: string }>,
): Promise<LoomReviewAuthorityReceipt> {
  const expectedRoot = standaloneReviewRoot(input.cwd);
  const lookup = store.currentRun(input.sessionId, expectedRoot);
  if (lookup.kind === "no-session") throw new Error(`no request-bound Loom captures were witnessed for Pi session ${input.sessionId}`);
  if (lookup.kind === "no-root") {
    throw new Error(`no request-bound Loom captures were witnessed for Pi session ${input.sessionId} and root ${expectedRoot}`);
  }
  const outcome = await verifyTrustedReviewRun(input, lookup.current.run);
  const settled = outcome.kind === "accepted" ? store.retireOtherRuns(lookup.current) : store.stillCurrent(lookup.current);
  if (!settled) throw new Error("current witnessed Standalone Review changed during verification; no older authority accepted");
  if (outcome.kind === "rejected") throw new Error(`current witnessed Standalone Review rejected: ${outcome.message}`);
  return outcome.receipt;
}

/** One isolated witness aggregate; the extension factory creates exactly one. */
export function createTrustedReviewWitnesses(): TrustedReviewWitnesses {
  const store = trustedWitnessStore();
  return Object.freeze({
    touch: (sessionId: string, binding: SessionRunBinding): TrustedReviewRunTouch =>
      store.updateRun(sessionId, binding, (captures) => captures),
    retract: store.retractUnwitnessed,
    remember: (sessionId, binding, role, task, outcome): void => {
      const capture = witnessedCapture(role, task, outcome);
      store.updateRun(sessionId, binding, (previous) => {
        const captures = new Map(previous);
        captures.set(captureKey(capture.slotId, capture.attempt), capture);
        return captures;
      });
    },
    verify: (input) => verifyWitnessedStandaloneReview(store, input),
    forget: store.forget,
  });
}
