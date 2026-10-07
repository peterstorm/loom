/**
 * The Trusted Review Witness Aggregate (CONTEXT.md): the Pi extension's
 * witnesses of captured standalone-review transcripts, grouped by session,
 * Standalone Review root and Review Run, and the replay that turns the current
 * run's witnesses into a Loom review-authority receipt.
 *
 * The aggregate is a port created once per extension factory and injected
 * wherever it is touched — spawn admission binds a run, result capture
 * records a witness, the review-authority bridge verifies, session shutdown
 * prunes — so every caller, and every test, holds its own isolated instance
 * rather than reaching a process-global map through an import.
 *
 * Ordering law: a run becomes current when its first exact standalone spawn is
 * bound before dispatch; retries and later captures enrich that run without
 * reordering it. Verification considers only the current run for the root;
 * rejection or a missing capture never falls back to an older run; exact
 * acceptance is idempotent and retires the root's older witnesses.
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
import type { LoomReviewAuthorityReceipt } from "../engine/src/handlers/helpers/programs/review-authority-bridge";
import { readRunBytesNoFollow } from "../engine/src/orchestration/no-follow-fs";
import type { SessionRunBinding } from "../engine/src/orchestration/session-run-bindings";
import { captureKey, type CaptureKey } from "../engine/src/core/harness-capture";
import { reduceStandaloneReviewMachine } from "../engine/src/core/standalone-review-machine";
import {
  parseArtifactDigest,
  parseContextDigest,
  type ArtifactDigest,
  type ContextDigest,
  type RequestId,
  type SlotId,
} from "../engine/src/core/orchestration-contract";
import { orchestrationMarkers } from "./review-run-authority";

/** The aggregate's interface: the four moments a witness is touched. */
export type TrustedReviewWitnesses = Readonly<{
  /** Bind a run as current for its root on its first exact standalone spawn;
   *  a retry of an already-bound run never reorders it. */
  touch: (sessionId: string, binding: SessionRunBinding) => void;
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

const trustedRunIdentity = ({ runsRoot, runDirectory }: Pick<SessionRunBinding, "runsRoot" | "runDirectory">): string =>
  `${runsRoot}\0${runDirectory}`;

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

/** One isolated witness aggregate; the extension factory creates exactly one. */
export function createTrustedReviewWitnesses(): TrustedReviewWitnesses {
  const sessions = new Map<string, Map<string, TrustedReviewRoot>>();

  const updateRun = (
    sessionId: string,
    binding: SessionRunBinding,
    updateCaptures: (captures: ReadonlyMap<CaptureKey, TrustedReviewCapture>) => ReadonlyMap<CaptureKey, TrustedReviewCapture>,
  ): void => {
    const sessionRoots = sessions.get(sessionId) ?? new Map<string, TrustedReviewRoot>();
    sessions.set(sessionId, sessionRoots);
    const rootIdentity = resolve(binding.runsRoot);
    const root = sessionRoots.get(rootIdentity) ?? Object.freeze({
      nextTouch: 1,
      runs: new Map<string, TrustedReviewRun>(),
    });
    const identity = trustedRunIdentity(binding);
    const previous = root.runs.get(identity);
    const runs = new Map(root.runs);
    runs.set(identity, Object.freeze({
      binding,
      captures: updateCaptures(previous?.captures ?? new Map<CaptureKey, TrustedReviewCapture>()),
      touchedAt: previous?.touchedAt ?? root.nextTouch,
    }));
    sessionRoots.set(rootIdentity, Object.freeze({
      nextTouch: previous === undefined ? root.nextTouch + 1 : root.nextTouch,
      runs,
    }));
  };

  return Object.freeze({
    touch: (sessionId: string, binding: SessionRunBinding): void => {
      updateRun(sessionId, binding, (captures) => captures);
    },
    remember: (sessionId, binding, role, task, outcome): void => {
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
      updateRun(sessionId, binding, (previous) => {
        const captures = new Map(previous);
        captures.set(
          captureKey(outcome.receipt.slotId, outcome.receipt.attempt),
          Object.freeze({
            requestId: outcome.receipt.requestId,
            slotId: outcome.receipt.slotId,
            attempt: outcome.receipt.attempt,
            role,
            contextDigest: contextDigest.value,
            digest: digest.value,
            byteLength: outcome.receipt.byteLength,
          }),
        );
        return captures;
      });
    },
    verify: async (input): Promise<LoomReviewAuthorityReceipt> => {
      const sessionRoots = sessions.get(input.sessionId);
      if (sessionRoots === undefined) throw new Error(`no request-bound Loom captures were witnessed for Pi session ${input.sessionId}`);
      const expectedRoot = standaloneReviewRoot(input.cwd);
      const root = sessionRoots.get(expectedRoot);
      if (root === undefined || root.runs.size === 0) {
        throw new Error(`no request-bound Loom captures were witnessed for Pi session ${input.sessionId} and root ${expectedRoot}`);
      }
      const current = [...root.runs.entries()].reduce((latest, candidate) =>
        candidate[1].touchedAt > latest[1].touchedAt ? candidate : latest);
      const outcome = await verifyTrustedReviewRun(input, current[1]);
      if (sessions.get(input.sessionId)?.get(expectedRoot) !== root) {
        throw new Error("current witnessed Standalone Review changed during verification; no older authority accepted");
      }
      if (outcome.kind === "rejected") {
        throw new Error(`current witnessed Standalone Review rejected: ${outcome.message}`);
      }
      // Exact accepted replay is idempotent. Once accepted, older witnesses for
      // this root are retired so they can never make a later verification
      // ambiguous or become fallback authority after a new run is touched.
      sessionRoots.set(expectedRoot, Object.freeze({
        nextTouch: root.nextTouch,
        runs: new Map([[current[0], current[1]]]),
      }));
      return outcome.receipt;
    },
    forget: (sessionId: string): void => {
      sessions.delete(sessionId);
    },
  });
}
