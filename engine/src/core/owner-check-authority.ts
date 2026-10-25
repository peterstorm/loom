/**
 * The owner check's authority, named by both the suite authorization
 * (`core/verification-manifest.ts`, which `types.ts` imports) and the
 * owner-verification core (`core/owner-verification/obligations.ts`, which
 * imports `types.ts`). It lives in this leaf so neither reaches the other
 * through it, which keeps the top-level source domains acyclic.
 */

import type { InvariantId } from "./invariant-id";
import type { ArtifactDigest } from "./orchestration-contract/identity";

/**
 * What the Wave's suite authorization injects as the `loom:owner-verification`
 * check: the stamp's identity and the ids of the obligations the Wave owes
 * coverage and mutation for, in plan order. `owed` may be empty: the check
 * still proves the plan agrees with the stamp.
 */
export type OwnerCheckAuthority = Readonly<{ obligationsDigest: ArtifactDigest; owed: readonly InvariantId[] }>;
