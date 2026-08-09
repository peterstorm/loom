import { describe, expect, it } from "vitest";
import { reviewPacketCleanupFailure } from "../../../src/handlers/helpers/review-packet";
import { standaloneTallyPublishErrors } from "../../../src/handlers/helpers/review-panel";

describe("review cleanup diagnostics", () => {
  it("retains both packet state-update and cleanup failures", () => {
    const original = new Error("state update failed");
    const combined = reviewPacketCleanupFailure(
      original,
      "/repo/.claude/review-packet.json",
      new Error("permission denied"),
    );

    expect(combined.message).toContain("state update failed");
    expect(combined.message).toContain("unbound review packet /repo/.claude/review-packet.json");
    expect(combined.message).toContain("permission denied");
    expect(combined.cause).toBe(original);
  });

  it("retains both standalone tally publication and pending-result cleanup failures", () => {
    expect(standaloneTallyPublishErrors(
      new Error("rename failed"),
      "/repo/run/.result.pending.json",
      new Error("device busy"),
    )).toEqual([
      "cannot publish standalone tally (the run may already be closed): rename failed",
      "also failed to remove pending result /repo/run/.result.pending.json: device busy",
    ]);
  });

  it("does not invent a cleanup diagnostic when cleanup succeeded", () => {
    expect(standaloneTallyPublishErrors("write failed", "/repo/run/.result.pending.json", null))
      .toEqual(["cannot publish standalone tally (the run may already be closed): write failed"]);
  });
});
