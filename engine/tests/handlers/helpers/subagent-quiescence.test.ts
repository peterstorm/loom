import { describe, expect, it } from "vitest";
import { assertQuiescentUnderLock, subagentActiveRefusal } from "../../../src/handlers/helpers/subagent-quiescence";
import { appearsUnderTheLock } from "../../fixtures/subagent-activity";

const quiet = () => false;
const active = () => true;

describe("subagent quiescence — refuse before the lock, re-check under it", () => {
  it("refuses an operation while a subagent is active, naming it", () => {
    expect(subagentActiveRefusal(quiet, "graph.json", "spec trace upgrade")).toBeNull();
    expect(subagentActiveRefusal(active, "graph.json", "spec trace upgrade")).toBe(
      "Spec trace upgrade refused while a subagent is active for this TaskGraph; wait for it to settle and retry",
    );
  });

  it("aborts the locked update when a subagent appears after the pre-lock check", () => {
    const { probe, observations } = appearsUnderTheLock();
    expect(subagentActiveRefusal(probe, "graph.json", "Contract Revision")).toBeNull();
    expect(() => assertQuiescentUnderLock(probe, "graph.json", "Contract Revision"))
      .toThrow("A subagent became active before the Contract Revision could commit");
    expect(observations()).toBe(2);
    expect(() => assertQuiescentUnderLock(quiet, "graph.json", "Contract Revision")).not.toThrow();
  });
});
