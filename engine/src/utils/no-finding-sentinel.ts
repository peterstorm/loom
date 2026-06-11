/**
 * "No findings" sentinel detection.
 *
 * Review and spec-check agents conventionally write a line like `CRITICAL: none`
 * (or `CRITICAL: (none)`, `CRITICAL: N/A`) to mean "zero critical findings" —
 * mirroring the `CRITICAL_COUNT: 0` they also emit. The finding parsers capture
 * the text after `CRITICAL:` verbatim, so without this guard the literal word
 * `none` becomes a stored "critical finding" that blocks the wave gate even though
 * the agent reported zero. This was a recurring false-positive: a passing review
 * (`review_status: passed`, count 0) still left `["none"]` in `critical_findings`,
 * and `complete-wave-gate` counts that array.
 *
 * A sentinel is a finding whose text is JUST a no-result token — optionally
 * parenthesized, optionally followed by an explanatory clause introduced by
 * punctuation (e.g. `(none) — prior critical fixed`). It is deliberately NOT a
 * sentinel when the token is followed by more words with no punctuation break
 * (e.g. `none of the error paths are handled`), so a genuine finding that happens
 * to start with "none" is preserved.
 */

/**
 * Matches a leading "no findings" token: `none`, `n/a`/`na`, `nil`, `null`,
 * optionally wrapped in parentheses, that is EITHER the entire (trimmed) string
 * or immediately followed by a clause-separating punctuation mark
 * (`—`, `–`, `-`, `.`, `:`, `;`, `,`). The trailing punctuation requirement is
 * what distinguishes the sentinel `none. all paths covered` from the real finding
 * `none of the callers check the result`.
 */
const NO_FINDING_SENTINEL = /^[\s(]*(?:none|n\/?a|nil|null)[\s)]*(?:$|[—–\-.:;,])/i;

/** True when `text` is a "no findings" sentinel rather than an actual finding. */
export function isNoFindingSentinel(text: string): boolean {
  return NO_FINDING_SENTINEL.test(text.trim());
}

/** Drop empty strings and "no findings" sentinels from a list of finding texts. */
export function dropNoFindingSentinels(xs: readonly string[]): string[] {
  return xs.filter((s) => s.trim() !== "" && !isNoFindingSentinel(s));
}
