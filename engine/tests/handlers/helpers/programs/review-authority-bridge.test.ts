import { describe, expect, it } from "vitest";
import type { LoomReviewAuthorityReceipt } from "../../../../src/core/review-authority-receipt";
import {
  LOOM_REVIEW_AUTHORITY_BRIDGE, publishLoomReviewAuthorityBridge, readLoomReviewAuthorityBridge,
} from "../../../../src/handlers/helpers/programs/review-authority-bridge";

const receipt: LoomReviewAuthorityReceipt = Object.freeze<LoomReviewAuthorityReceipt>({
  schemaVersion: 1, kind: "loom-review-authority-receipt", sessionId: "session-1", runId: "review-run-1",
  runsRoot: "/project/.loom/runs", runDirectory: "/project/.loom/runs/review-run-1",
  requestIds: ["request:" + "a".repeat(64)], resultDigest: "b".repeat(64),
  reviewedSource: { schemaVersion: 1, headRevision: "c".repeat(40), files: [
    { path: "src/a.ts", kind: "file", digest: "d".repeat(64), byteLength: 12 },
    { path: "src/gone.ts", kind: "absent", digest: null, byteLength: 0 },
  ] },
});
const input = { cwd: "/project", sessionId: "session-1" };
const hostWith = (value: unknown) => ({ [LOOM_REVIEW_AUTHORITY_BRIDGE]: value });

describe("review-authority bridge lookup is fail-closed", () => {
  it("throws when no bridge is published", () => {
    expect(() => readLoomReviewAuthorityBridge({})).toThrow("loom review-authority bridge is not published under the contract key");
  });

  it("throws when the contract key holds a non-object", () => {
    expect(() => readLoomReviewAuthorityBridge(hostWith("bridge"))).toThrow("not published under the contract key");
    expect(() => readLoomReviewAuthorityBridge(hostWith(null))).toThrow("not published under the contract key");
  });

  it("throws when the bridge has no verify function", () => {
    expect(() => readLoomReviewAuthorityBridge(hostWith({}))).toThrow("loom review-authority bridge is malformed: verify is not a function");
    expect(() => readLoomReviewAuthorityBridge(hostWith({ verify: "yes" }))).toThrow("verify is not a function");
  });

  it("is keyed by the one global Symbol.for key, never a re-declared string", () => {
    expect(LOOM_REVIEW_AUTHORITY_BRIDGE).toBe(Symbol.for("@peterstorm/loom/review-authority/v1"));
    expect(() => readLoomReviewAuthorityBridge({ "@peterstorm/loom/review-authority/v1": { verify: async () => receipt } })).toThrow();
  });
});

describe("review-authority bridge publication", () => {
  it("round-trips a published verifier and freezes both the published and the read bridge", async () => {
    const host: Record<PropertyKey, unknown> = {};
    const calls: unknown[] = [];
    publishLoomReviewAuthorityBridge(host, { verify: async request => { calls.push(request); return receipt; } });
    expect(Object.isFrozen(host[LOOM_REVIEW_AUTHORITY_BRIDGE])).toBe(true);
    const bridge = readLoomReviewAuthorityBridge(host);
    expect(Object.isFrozen(bridge)).toBe(true);
    const verified = await bridge.verify(input);
    expect(calls).toEqual([input]);
    expect(verified).toEqual(receipt);
    expect(Object.isFrozen(verified) && Object.isFrozen(verified.requestIds) && Object.isFrozen(verified.reviewedSource.files)).toBe(true);
  });

  it("rejects a verification whose receipt certifies another session", async () => {
    const host: Record<PropertyKey, unknown> = {};
    publishLoomReviewAuthorityBridge(host, { verify: async () => ({ ...receipt, sessionId: "session-2" }) });
    await expect(readLoomReviewAuthorityBridge(host).verify(input)).rejects.toThrow("certifies a different session");
  });

  it("rejects a verification whose receipt is malformed", async () => {
    const host = hostWith({ verify: async () => ({ ...receipt, resultDigest: "not-a-digest" }) });
    await expect(readLoomReviewAuthorityBridge(host).verify(input)).rejects.toThrow("loom review-authority bridge is malformed: receipt resultDigest is malformed");
  });

  it("propagates the producer's own refusal unchanged", async () => {
    const host = hostWith({ verify: async () => { throw new Error("no request-bound Loom captures were witnessed"); } });
    await expect(readLoomReviewAuthorityBridge(host).verify(input)).rejects.toThrow("no request-bound Loom captures were witnessed");
  });
});

