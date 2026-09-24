/**
 * The Pi review-authority bridge contract.
 *
 * Pi's extension certifies a completed Standalone Review under an exact
 * witnessed-capture replay, and test harnesses read that certification back.
 * The handoff is a process-global published under ONE Symbol.for key; before
 * this module the key string was duplicated in three files and every consumer
 * structurally guessed the bridge's shape. Now the key, the receipt type, and
 * the fail-closed lookup live here — the producer publishes through
 * `publishLoomReviewAuthorityBridge`, the consumers read through
 * `readLoomReviewAuthorityBridge`, and neither side re-declares anything.
 *
 * The lookup is FAIL-CLOSED: an absent or malformed bridge is a thrown
 * contract violation, never an `undefined` the caller could misread as "the
 * review is simply not done yet".
 */

import type { StandaloneReviewedSource } from "./standalone-evidence";

/** The one key the bridge is published under. `unique symbol`, so a consumer
 *  indexing globalThis with a re-declared string cannot compile. */
export const LOOM_REVIEW_AUTHORITY_BRIDGE: unique symbol = Symbol.for("@peterstorm/loom/review-authority/v1");

/** The certification `verify` resolves to: the exact witnessed Standalone
 *  Review run, its captured request authority, and the reviewed-source
 *  attestation the replay proved. */
export type LoomReviewAuthorityReceipt = Readonly<{
  schemaVersion: 1;
  kind: "loom-review-authority-receipt";
  sessionId: string;
  runId: string;
  runsRoot: string;
  runDirectory: string;
  requestIds: readonly string[];
  resultDigest: string;
  reviewedSource: StandaloneReviewedSource;
}>;

/** The bridge object the producer publishes: exactly one verifier. */
export type LoomReviewAuthorityBridge = Readonly<{
  verify: (input: Readonly<{ cwd: string; sessionId: string }>) => Promise<LoomReviewAuthorityReceipt>;
}>;

/** Read the published bridge, or throw — never hand back a shape the caller
 *  must guess or an absent value it might read as a verdict. */
export function readLoomReviewAuthorityBridge(host: unknown): LoomReviewAuthorityBridge {
  const raw = (host as Record<PropertyKey, unknown>)[LOOM_REVIEW_AUTHORITY_BRIDGE];
  if (typeof raw !== "object" || raw === null) {
    throw new Error("loom review-authority bridge is not published under the contract key");
  }
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate["verify"] !== "function") {
    throw new Error("loom review-authority bridge is malformed: verify is not a function");
  }
  return Object.freeze({ verify: candidate["verify"] as LoomReviewAuthorityBridge["verify"] });
}

/** Publish the bridge — the producer's ONLY way onto the contract key. */
export function publishLoomReviewAuthorityBridge(host: unknown, bridge: LoomReviewAuthorityBridge): void {
  (host as Record<PropertyKey, unknown>)[LOOM_REVIEW_AUTHORITY_BRIDGE] = Object.freeze(bridge);
}
