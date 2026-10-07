/**
 * The Pi review-authority bridge: the process-global publish/read shell.
 *
 * Pi's extension certifies a completed Standalone Review under an exact
 * witnessed-capture replay, and test harnesses read that certification back.
 * The handoff is a process-global published under ONE Symbol.for key; the
 * producer publishes through `publishLoomReviewAuthorityBridge`, the consumers
 * read through `readLoomReviewAuthorityBridge`, and neither side re-declares
 * anything. The receipt wire contract and its reviewed-source codec are pure
 * and live in core/review-authority-receipt.
 *
 * The lookup is FAIL-CLOSED: an absent or malformed bridge is a thrown
 * contract violation, never an `undefined` the caller could misread as "the
 * review is simply not done yet". The receipt crosses a process-global, so the
 * read path PARSES every receipt `verify` resolves to into branded identities
 * before any consumer sees it; a malformed receipt rejects the verification.
 */
import {
  parseLoomReviewAuthorityReceipt,
  type LoomReviewAuthorityReceipt,
  type VerifiedLoomReviewAuthorityReceipt,
} from "../../../core/review-authority-receipt";

/** The one key the bridge is published under. `unique symbol`, so a consumer
 *  indexing globalThis with a re-declared string cannot compile. */
export const LOOM_REVIEW_AUTHORITY_BRIDGE: unique symbol = Symbol.for("@peterstorm/loom/review-authority/v1");

type VerifyInput = Readonly<{ cwd: string; sessionId: string }>;

/** What the producer publishes: exactly one verifier resolving to its wire receipt. */
export type LoomReviewAuthorityPublication = Readonly<{
  verify: (input: VerifyInput) => Promise<LoomReviewAuthorityReceipt>;
}>;

/** The bridge a consumer reads: its verifier resolves only to a parsed receipt. */
export type LoomReviewAuthorityBridge = Readonly<{
  verify: (input: VerifyInput) => Promise<VerifiedLoomReviewAuthorityReceipt>;
}>;

/** Read the published bridge, or throw — never hand back a shape the caller
 *  must guess or an absent value it might read as a verdict. The returned
 *  verifier resolves only to a parsed receipt certifying the session asked
 *  about; anything else rejects. */
export function readLoomReviewAuthorityBridge(host: unknown): LoomReviewAuthorityBridge {
  const raw = (host as Record<PropertyKey, unknown>)[LOOM_REVIEW_AUTHORITY_BRIDGE];
  if (typeof raw !== "object" || raw === null) {
    throw new Error("loom review-authority bridge is not published under the contract key");
  }
  const verify: unknown = (raw as Record<string, unknown>)["verify"];
  if (typeof verify !== "function") {
    throw new Error("loom review-authority bridge is malformed: verify is not a function");
  }
  return Object.freeze({
    verify: async (input: VerifyInput): Promise<VerifiedLoomReviewAuthorityReceipt> => {
      const receipt = parseLoomReviewAuthorityReceipt(await Reflect.apply(verify, undefined, [input]));
      if (!receipt.ok) throw new Error(`loom review-authority bridge is malformed: ${receipt.error}`);
      if (receipt.value.sessionId !== input.sessionId) {
        throw new Error("loom review-authority receipt certifies a different session");
      }
      return receipt.value;
    },
  });
}

/** Publish the bridge — the producer's ONLY way onto the contract key. */
export function publishLoomReviewAuthorityBridge(host: unknown, bridge: LoomReviewAuthorityPublication): void {
  (host as Record<PropertyKey, unknown>)[LOOM_REVIEW_AUTHORITY_BRIDGE] = Object.freeze({ verify: bridge.verify });
}
