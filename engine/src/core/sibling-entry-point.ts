/**
 * The one plan shape both the plan model (`engine/src/types.ts`) and the
 * owner-verification core (`core/owner-verification/types.ts`) name. It lives
 * in this dependency-free leaf so neither imports the other through it:
 * `types.ts` re-exports it, and the owner-verification types reach it here,
 * which keeps the top-level source domains acyclic.
 */

/** One `- path — note` line of an invariant's `**Sibling entry points:**` list. */
export type SiblingEntryPoint = Readonly<{ path: string; note: string | null }>;
