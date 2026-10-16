import { evaluateAsRecorded } from "./completion-suite-evaluation";
import {
  authorizeWaveCompletionSuite,
  legacyDefaultVerificationManifest,
  type FrozenVerificationManifest,
} from "../../src/core/verification-manifest";
import type { TaskGraph } from "../../src/types";

/** Build one accepted receipt for Wave Gate state fixtures. The default is the
 *  authority a graph with no `verification_manifest` reads: the legacy default
 *  manifest, frozen before test-file classification existed. */
export function acceptedWaveCompletionSuite(
  active: NonNullable<TaskGraph["active_wave_gate"]>,
  manifest: FrozenVerificationManifest = legacyDefaultVerificationManifest(),
) {
  const authorized = authorizeWaveCompletionSuite(manifest, active, "c".repeat(64));
  if (!authorized.ok) throw new Error(authorized.error.errors.join("; "));
  const evaluated = evaluateAsRecorded(authorized.value, {
    kind: "wave-completion-suite-result",
    runId: active.runId,
    wave: active.wave,
    revision: active.revision,
    authorityDigest: active.authorityDigest,
    manifestDigest: manifest.manifestDigest,
    suiteDigest: authorized.value.suiteDigest,
    workspaceDigest: authorized.value.workspaceDigest,
    checks: authorized.value.checks.map((check) => ({
      checkId: check.checkId,
      scope: check.scope,
      outcome: {
        kind: "observed" as const,
        exitCode: 0,
        timedOut: false,
        signal: null,
        report: { kind: "not-required" as const },
      },
    })),
  });
  if (evaluated.kind !== "accepted") throw new Error("completion-suite fixture was not accepted");
  return evaluated.receipt;
}
