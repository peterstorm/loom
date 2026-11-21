import { evaluateAsRecorded, greenCompletionSuiteResult } from "./completion-suite-evaluation";
import { labelledValue } from "./parse-result";
import {
  authorizeWaveCompletionSuite,
  preI6DefaultVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import type { AcceptedWaveCompletionReceipt } from "../../src/core/completion-suite";
import { parseArtifactDigest } from "../../src/core/orchestration-contract";
import { parseActiveWaveGateRegistration } from "../../src/state-file-wire";
import type { TaskGraph, WaveWorkspaceObservation } from "../../src/types";

const SUITE_WORKSPACE_DIGEST = labelledValue("fixture workspace digest", parseArtifactDigest("c".repeat(64)));

/** The workspace every fixture suite ran on; gate deps that observe it see the suite as current. */
export const COMPLETION_SUITE_WORKSPACE: WaveWorkspaceObservation = Object.freeze({
  kind: "observed",
  workspaceDigest: SUITE_WORKSPACE_DIGEST,
});

/** Build one accepted receipt for Wave Gate state fixtures: every check of
 *  `manifest` observed green on `COMPLETION_SUITE_WORKSPACE`. The default is
 *  the pre-I6 engine default manifest (frozen before test-file classification
 *  existed), so Proofs derived without a red-then-green duty stay exact. */
export function acceptedWaveCompletionSuite(
  active: NonNullable<TaskGraph["active_wave_gate"]>,
  manifest: FrozenVerificationManifest = preI6DefaultVerificationManifest(),
): AcceptedWaveCompletionReceipt {
  const authorized = authorizeWaveCompletionSuite(manifest, active, SUITE_WORKSPACE_DIGEST, null);
  if (!authorized.ok) throw new Error(authorized.error.errors.join("; "));
  const evaluated = evaluateAsRecorded(
    authorized.value,
    greenCompletionSuiteResult(authorized.value, { digest: "f".repeat(64), byteLength: 10 }),
  );
  if (evaluated.kind !== "accepted") throw new Error("completion-suite fixture was not accepted");
  return evaluated.receipt;
}

/** One raw `wave_gate_history` entry's authority: its run, Wave, gate digest and terminal revision. */
export type CompletedWaveGateInput = Readonly<{
  runId: string;
  wave: number;
  authorityDigest?: string;
  /** The terminal revision; the archived suite was accepted at the revision before it. */
  revision?: number;
  /** The manifest the suite ran under; the pre-I6 engine default when omitted. */
  manifest?: FrozenVerificationManifest;
}>;

/** The suite a completed Wave archived: accepted at the active registration's
 *  revision, one before the entry's terminal `revision`. */
export function archivedCompletionSuite(input: CompletedWaveGateInput): AcceptedWaveCompletionReceipt {
  const active = labelledValue("active registration", parseActiveWaveGateRegistration({
    schemaVersion: 1,
    kind: "active-wave-gate",
    runId: input.runId,
    wave: input.wave,
    authorityDigest: input.authorityDigest ?? "d".repeat(64),
    revision: (input.revision ?? 1) - 1,
    terminalOutcome: null,
  }));
  return acceptedWaveCompletionSuite(active, input.manifest);
}

/** The raw schema-2 `wave_gate_history` entry completion writes. */
export type CompletedWaveGateEntry = Readonly<{
  schemaVersion: 2;
  kind: "completed-wave-gate";
  runId: string;
  wave: number;
  authorityDigest: string;
  revision: number;
  completionReceipt: Readonly<{
    kind: "protected-wave-state-committed";
    effectId: string;
    runId: string;
    committedRevision: number;
    stateDigest: string;
  }>;
  completionSuite: AcceptedWaveCompletionReceipt;
}>;

/** A raw schema-2 `wave_gate_history` entry: the completion receipt at
 *  `revision` and the suite it archived, exactly as completion writes it. */
export function completedWaveGateEntry(input: CompletedWaveGateInput): CompletedWaveGateEntry {
  const revision = input.revision ?? 1;
  return {
    schemaVersion: 2,
    kind: "completed-wave-gate",
    runId: input.runId,
    wave: input.wave,
    authorityDigest: input.authorityDigest ?? "d".repeat(64),
    revision,
    completionReceipt: {
      kind: "protected-wave-state-committed",
      effectId: `effect:wave-gate-complete:${input.runId}`,
      runId: input.runId,
      committedRevision: revision,
      stateDigest: "e".repeat(64),
    },
    completionSuite: archivedCompletionSuite(input),
  };
}
