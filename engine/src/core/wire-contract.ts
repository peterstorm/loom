/**
 * The Wire Contract's stamping seam (see CONTEXT.md: Wire Contract).
 *
 * The contract text a review Agent must follow lives in ONE fragment
 * (agents/_shared/wire-contract.md); each reviewer agent file carries a
 * stamped copy between the markers below. This module owns the pure
 * region-replacement so the stamp script and the drift test share one
 * implementation — a test proving regions equal the fragment through a
 * DIFFERENT parser than the stamper writes with would be two contracts again.
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
