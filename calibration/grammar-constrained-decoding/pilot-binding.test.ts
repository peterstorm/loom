import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mintCellBinding, pilotRequestId, type CellBinding } from "./pilot-binding";
import { CELL_KEYS, contentDigest, PILOT_CELLS, PILOT_ARMS } from "./pilot-vocabulary";

/**
 * The pilot's per-attempt engine issuance at its interface: the request
 * identity and the binding minted for it through the engine's one mint.
 */

describe("per-attempt request identity", () => {
  it("is SAFE_AUTHORITY_ID-shaped, deterministic, and fresh per arm and attempt (property)", () => {
    fc.assert(fc.property(
      fc.string(), fc.string(), fc.constantFrom(...PILOT_ARMS), fc.integer({ min: 1, max: 2 }),
      (windowId, pairId, arm, attempt) => {
        const id = pilotRequestId(windowId, pairId, arm, attempt);
        expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/);
        expect(id).toBe(pilotRequestId(windowId, pairId, arm, attempt));
        expect(id).not.toBe(pilotRequestId(windowId, pairId, arm, attempt + 1));
        expect(id).not.toBe(pilotRequestId(windowId, pairId, arm === "emission-enabled" ? "extraction-only" : "emission-enabled", attempt));
      },
    ), { numRuns: 100 });
  });

  it("is fresh per window and per pair (property)", () => {
    fc.assert(fc.property(
      fc.string(), fc.string(), fc.string(), fc.constantFrom(...PILOT_ARMS), fc.integer({ min: 1, max: 2 }),
      (windowId, pairId, other, arm, attempt) => {
        fc.pre(other !== windowId && other !== pairId);
        const id = pilotRequestId(windowId, pairId, arm, attempt);
        expect(id).not.toBe(pilotRequestId(other, pairId, arm, attempt));
        expect(id).not.toBe(pilotRequestId(windowId, other, arm, attempt));
      },
    ), { numRuns: 100 });
  });
});

describe("issued binding per attempt", () => {
  it("mints every cell's binding for its producer kind, path-refined, addressing the exact prompt", () => {
    for (const cell of CELL_KEYS) {
      const requestId = pilotRequestId("w", `${cell}#c#r1`, "emission-enabled", 1);
      const minted = mintCellBinding(cell, requestId, "the exact prompt");
      if (!minted.ok) throw new Error(minted.error);
      const producer = PILOT_CELLS[cell];
      expect(minted.value.path).toBe(producer.kind === "reviewer-payload" ? "reviewer" : "verdict");
      expect(minted.value.binding.requestId).toBe(requestId);
      expect(minted.value.binding.kind.kind).toBe(producer.kind);
      expect(minted.value.binding.version).toBe(producer.version);
      expect(minted.value.binding.toolName).toBe(producer.toolName);
      expect(minted.value.contextDigest).toBe(contentDigest("the exact prompt"));
      expect(Object.isFrozen(minted.value)).toBe(true);
    }
  });

  it("ties the path tag to the binding's refinement, so they cannot disagree (type-level)", () => {
    const minted = mintCellBinding("judge-verdict/v1", pilotRequestId("w", "p", "emission-enabled", 1), "prompt");
    if (!minted.ok || minted.value.path !== "verdict") throw new Error("the judge cell minted no verdict-path binding");
    // @ts-expect-error — a verdict-kind binding cannot be tagged for the reviewer path.
    const crossed: CellBinding = { ...minted.value, path: "reviewer" };
    expect(crossed.binding.kind.kind).toBe("judge-verdict");
  });

  it("refuses a request id the engine's mint does not issue", () => {
    expect(mintCellBinding("judge-verdict/v1", "not a safe id!", "prompt").ok).toBe(false);
  });
});
