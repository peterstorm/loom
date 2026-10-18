import { describe, expect, it } from "vitest";
import {
  epochOf,
  phaseGateTarget,
  type EvidenceAttribution,
  type MachineBinding,
} from "../../src/machine/evidence";
import { IMPLEMENTER_TYPE, agentIdOf } from "../fixtures/machine-identities";

const binding = ((): MachineBinding => {
  const agentId = agentIdOf("a-1");
  return { agentId, agentType: IMPLEMENTER_TYPE, epoch: epochOf(agentId, IMPLEMENTER_TYPE) };
})();

describe("phaseGateTarget", () => {
  it.each<[string, EvidenceAttribution, ReturnType<typeof phaseGateTarget>]>([
    // The caller's OWN binding gates it, even while siblings run in parallel.
    ["a reported caller with one binding", { kind: "caller", binding }, { kind: "gate", binding }],
    ["an unreported caller under the sole-active rule", { kind: "sole", binding }, { kind: "gate", binding }],
    ["no live binding at all", { kind: "ungated" }, { kind: "pass" }],
    ["a reported caller with no machine", { kind: "caller-unbound", agentId: binding.agentId }, { kind: "pass" }],
    [
      "an unreported caller in a contended session",
      { kind: "contended" },
      { kind: "stand-down", reason: "call carries no agent_id and the session is contended" },
    ],
  ])("routes %s", (_name, attribution, expected) => {
    expect(phaseGateTarget(attribution)).toEqual(expected);
  });

  it.each<[string, EvidenceAttribution, string]>([
    ["corrupt binding authority", { kind: "corrupt" }, "machine binding authority has malformed rows"],
    ["an unparseable caller id", { kind: "caller-unparseable", raw: "evil:id" }, 'caller agent_id "evil:id" is reserved or path-unsafe'],
    ["a caller owning two binding lines", { kind: "caller-ambiguous", agentId: binding.agentId, bindings: 2 }, "caller a-1 owns 2 binding lines"],
  ])("fails closed on %s", (_name, attribution, reason) => {
    const target = phaseGateTarget(attribution);
    expect(target.kind).toBe("fail-closed");
    if (target.kind === "fail-closed") expect(target.reason).toContain(reason);
  });
});
