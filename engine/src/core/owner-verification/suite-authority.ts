/**
 * INV-3 sibling: the one place a Wave's completion suite is authorized from
 * a TaskGraph. The owner check authority is derived here, from the graph the
 * suite is authorized for (`ownerCheckAuthority(ownerScopeOf(graph), wave)`),
 * never handed in, so the gate (`handlers/helpers/wave-completion-suite.ts`)
 * and readiness (`core/wave-completion-suite-readiness.ts`) cannot disagree
 * about which owned Invariants the Wave owes: both call this function.
 *
 * Pure. The State File wire parse (`state-file-wire.ts`) re-derives the same
 * authority from the stamp on purpose: a persisted receipt must never certify
 * its own roster.
 */

import type { TaskGraph } from "../../types";
import type { AuthorizedWaveCompletionSuite } from "../completion-suite";
import {
  authorizeWaveCompletionSuite,
  legacyDefaultVerificationManifest,
  type VerificationManifestResult,
} from "../verification-manifest";
import { ownerCheckAuthority, ownerScopeOf } from "./obligations";

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);

/**
 * The completion suite the graph's active Wave owes at `workspaceDigest`:
 * the graph's frozen manifest (the legacy engine default when it has none),
 * its active registration, and the owner check exactly when the graph carries
 * the `owner_obligations` stamp. Refused when the graph has no active Wave
 * Gate registration to authorize for.
 */
export function authorizeGraphCompletionSuite(
  graph: TaskGraph,
  workspaceDigest: unknown,
): VerificationManifestResult<AuthorizedWaveCompletionSuite> {
  const active = graph.active_wave_gate;
  if (active === undefined) {
    return freeze({
      ok: false,
      error: freeze({ kind: "invalid-verification-manifest", errors: freeze(["the TaskGraph has no active Wave Gate registration to authorize a completion suite for"] as const) }),
    });
  }
  const manifest = graph.verification_manifest ?? legacyDefaultVerificationManifest();
  return authorizeWaveCompletionSuite(manifest, active, workspaceDigest, ownerCheckAuthority(ownerScopeOf(graph), active.wave));
}
