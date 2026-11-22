/**
 * The reason an operator gives for abandoning a run (`helper orchestration
 * abandon`), as a value object. The Run Directory marker and the protected
 * Wave Gate tombstone both carry it, so the rule lives here once.
 * Pure module: no I/O.
 */

import type { DomainResult } from "./orchestration-contract";

/** The longest reason an abandonment may carry. */
export const MAX_ABANDONMENT_REASON = 512;

/** Trimmed, non-blank text of at most `MAX_ABANDONMENT_REASON` characters,
 *  minted only by `parseAbandonmentReason`. */
export type AbandonmentReason = string & { readonly __brand: "AbandonmentReason" };

/**
 * Parse operator text into an AbandonmentReason. Surrounding whitespace is
 * trimmed first; the trimmed text must be non-blank, because an unexplained
 * abandonment tells the next operator nothing the directory listing did not,
 * and bounded, because the reason is stamped into protected state.
 */
export function parseAbandonmentReason(raw: string): DomainResult<AbandonmentReason, string> {
  const reason = raw.trim();
  if (reason === "") return Object.freeze({ ok: false, error: "an abandonment must carry a reason" });
  if (reason.length > MAX_ABANDONMENT_REASON) {
    return Object.freeze({ ok: false, error: `abandonment reason exceeds ${MAX_ABANDONMENT_REASON} characters` });
  }
  return Object.freeze({ ok: true, value: reason as AbandonmentReason });
}
