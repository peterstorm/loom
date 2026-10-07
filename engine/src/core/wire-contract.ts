/**
 * The Wire Contract's stamping seam (see CONTEXT.md: Wire Contract).
 *
 * renderReviewerWireContract() owns the generated shared fragment
 * (agents/_shared/wire-contract.md); each reviewer agent file carries its
 * stamped copy between the markers below. The marker spelling is retained
 * for historical tooling, not permission to hand-edit the generated fragment. This module owns the pure
 * region-replacement so the stamp script and the drift test share one
 * implementation — a test proving regions equal the fragment through a
 * DIFFERENT parser than the stamper writes with would be two contracts again.
 *
 * The read-coverage bullet (agents/_shared/read-coverage.md) is stamped the
 * same way, but anchored by its own opening words rather than by markers: it
 * is one item of each reviewer's bootstrap list, where a marker comment would
 * split the list. Exactly one line per reviewer may start with the anchor.
 */

export const WIRE_CONTRACT_START =
  "<!-- wire-contract:start — stamped from agents/_shared/wire-contract.md; edit the fragment, then run scripts/stamp-wire-contract.ts -->";
export const WIRE_CONTRACT_END = "<!-- wire-contract:end -->";

export type StampResult =
  | Readonly<{ ok: true; value: string }>
  | Readonly<{ ok: false; error: string }>;

/** Extract the stamped region's current content, or an error naming what's missing. */
export function extractWireContractRegion(agentMarkdown: string): StampResult {
  const start = agentMarkdown.indexOf(WIRE_CONTRACT_START);
  const end = agentMarkdown.indexOf(WIRE_CONTRACT_END);
  if (start === -1) return { ok: false, error: "missing wire-contract start marker" };
  if (end === -1) return { ok: false, error: "missing wire-contract end marker" };
  if (end < start) return { ok: false, error: "wire-contract markers are out of order" };
  const inner = agentMarkdown.slice(start + WIRE_CONTRACT_START.length, end);
  return { ok: true, value: inner.replace(/^\n/, "").replace(/\n$/, "") };
}

/** The opening words that locate the read-coverage bullet in a reviewer file. */
export const READ_COVERAGE_BULLET_ANCHOR = "- When the engine task carries `LOOM_READ_COVERAGE: ";

/** The one line starting with the read-coverage anchor, or an error naming why there is not exactly one. */
export function extractReadCoverageBullet(agentMarkdown: string): StampResult {
  const bullets = agentMarkdown.split("\n").filter((line) => line.startsWith(READ_COVERAGE_BULLET_ANCHOR));
  if (bullets.length === 0) return { ok: false, error: "missing read-coverage bullet" };
  if (bullets.length > 1) return { ok: false, error: `${bullets.length} read-coverage bullets; expected exactly one` };
  return { ok: true, value: bullets[0]! };
}

/** Replace the read-coverage bullet with the one-line fragment, byte-exact and idempotent. */
export function stampReadCoverageBullet(agentMarkdown: string, fragment: string): StampResult {
  const bullet = fragment.replace(/\n$/, "");
  if (!bullet.startsWith(READ_COVERAGE_BULLET_ANCHOR) || bullet.includes("\n")) {
    return { ok: false, error: "read-coverage fragment must be one line starting with its anchor" };
  }
  const current = extractReadCoverageBullet(agentMarkdown);
  if (!current.ok) return current;
  return {
    ok: true,
    value: agentMarkdown.split("\n").map((line) => line === current.value ? bullet : line).join("\n"),
  };
}

/** Replace the stamped region with the fragment, byte-exact and idempotent. */
export function stampWireContract(agentMarkdown: string, fragment: string): StampResult {
  const region = extractWireContractRegion(agentMarkdown);
  if (!region.ok) return region;
  const start = agentMarkdown.indexOf(WIRE_CONTRACT_START);
  const end = agentMarkdown.indexOf(WIRE_CONTRACT_END);
  const normalized = fragment.replace(/\n$/, "");
  return {
    ok: true,
    value:
      agentMarkdown.slice(0, start + WIRE_CONTRACT_START.length) +
      "\n" + normalized + "\n" +
      agentMarkdown.slice(end),
  };
}
