import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseVerifiedIndexInstalled } from "../../src/core/orchestration-contract";

const digest = "a".repeat(64);
const receipt = {
  kind: "verified-index-installed",
  effectId: `effect:remediation-install:${digest}`,
  runId: "run.abc123",
  indexDigest: digest,
  witnessDigest: "b".repeat(64),
};

/**
 * The remediation resume path used to shape-check a checkpointed done receipt
 * with typeof tests, which accepted any strings where the contract demands
 * canonical authority ids and SHA-256 digests. parseVerifiedIndexInstalled is
 * the parse-don't-validate replacement; a done claim rides on a receipt the
 * contract vouches for, or it is not a done claim.
 */
describe("parseVerifiedIndexInstalled", () => {
  it("round-trips the receipt the remediation façade checkpoints", () => {
    const parsed = parseVerifiedIndexInstalled(receipt);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(receipt);
  });

  it("rejects the shapes the old typeof checks accepted", () => {
    for (const bad of [
      { ...receipt, indexDigest: "not-a-digest" },
      { ...receipt, effectId: "" },
      { ...receipt, runId: "spaces are illegal" },
      { ...receipt, kind: "artifact-set-published" },
      { ...receipt, extra: true },
      (({ witnessDigest: _dropped, ...rest }) => rest)(receipt),
    ]) {
      const parsed = parseVerifiedIndexInstalled(bad);
      expect(parsed.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("is total for arbitrary input", () => {
    fc.assert(fc.property(fc.anything(), (raw) => {
      expect(() => parseVerifiedIndexInstalled(raw)).not.toThrow();
    }));
  });
});
