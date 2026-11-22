/**
 * INV-3 sibling: the one place a Wave's completion suite is authorized from
 * a TaskGraph. The owner check authority is derived here, from the graph the
 * suite is authorized for (`ownerCheckAuthorityOf(waveOwnerDuty(graph, wave))`),
 * never handed in, so the gate (`handlers/helpers/wave-completion-suite.ts`)
 * and readiness (`core/wave-completion-suite-readiness.ts`) cannot disagree
 * about which owned Invariants the Wave owes: both call this function.
 *
 * Pure. The State File wire parse (`state-file-wire.ts`) re-derives the same
 * authority from the stamp on purpose: a persisted receipt must never certify
 * its own roster.
 */

import type { AuthorizedWaveCompletionSuite } from "../completion-suite";
import type { ManifestedTaskGraph } from "../manifested-task-graph";
import {
  authorizeWaveCompletionSuite,
  type VerificationManifestResult,
} from "../verification-manifest";
import { ownerCheckAuthorityOf, waveOwnerDuty } from "./obligations";

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);

/**
 * The completion suite the graph's active Wave owes at `workspaceDigest`:
 * the graph's frozen manifest, its active registration, and the owner check
 * exactly when the graph carries the `owner_obligations` stamp. The graph is a
 * `ManifestedTaskGraph`, so its manifest is proven before this is reached;
 * refused only when the graph has no active Wave Gate registration.
 */
export function authorizeGraphCompletionSuite(
  graph: ManifestedTaskGraph,
  workspaceDigest: unknown,
): VerificationManifestResult<AuthorizedWaveCompletionSuite> {
  const active = graph.active_wave_gate;
  if (active === undefined) {
    return freeze({
      ok: false,
      error: freeze({
        kind: "invalid-verification-manifest",
        errors: freeze(["the TaskGraph has no active Wave Gate registration to authorize a completion suite for"] as const),
      }),
    });
  }
  return authorizeWaveCompletionSuite(
    graph.verification_manifest,
    active,
    workspaceDigest,
    ownerCheckAuthorityOf(waveOwnerDuty(graph, active.wave)),
  );
}
