import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  persistReviewPacketAndBind,
  reviewPacketAuthorityError,
  reviewPacketCleanupFailure,
} from "../../../src/handlers/helpers/review-packet";
import { standaloneTallyPublishErrors } from "../../../src/handlers/helpers/review-panel";

describe("review cleanup diagnostics", () => {
  it("rejects lock-time drift in packet identity or selected base", () => {
    const expected = { taskStartSha: "a".repeat(40), packetId: "1".repeat(64) };
    expect(reviewPacketAuthorityError(expected, expected, "T1")).toBeNull();
    expect(reviewPacketAuthorityError(
      expected,
      { ...expected, packetId: "2".repeat(64) },
      "T1",
    )).toContain("repository HEAD, or review artifacts changed");
    expect(reviewPacketAuthorityError(
      expected,
      { ...expected, taskStartSha: "b".repeat(40) },
      "T1",
    )).toContain("repository HEAD, or review artifacts changed");
  });

  it("removes a packet when the post-write state binding fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-review-packet-bind-"));
    const packet = join(dir, "packet.json");
    try {
      await expect(persistReviewPacketAndBind(
        packet,
        "packet bytes\n",
        async () => { throw new Error("state update failed"); },
      )).rejects.toThrow("state update failed");
      expect(existsSync(packet)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the packet only after its state binding succeeds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-review-packet-bind-"));
    const packet = join(dir, "packet.json");
    try {
      await persistReviewPacketAndBind(packet, "packet bytes\n", async () => {});
      expect(readFileSync(packet, "utf-8")).toBe("packet bytes\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
