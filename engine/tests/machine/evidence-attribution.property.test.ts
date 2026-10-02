/**
 * attributeEvidence — whose epoch one tool call's evidence lands in.
 *
 * Claude Code stamps `agent_id` on every hook fired inside a subagent, and
 * parallel subagents share the parent's session_id. The invariants:
 *
 *   (1) a REPORTED caller is never credited to a binding that is not its own
 *       — and never through the session-wide sole-active fallback;
 *   (2) parallel bound agents each attribute to their own binding;
 *   (3) an UNREPORTED caller (main agent / older harness) gets exactly the
 *       pre-existing sole-active decision (resolveSoleActiveBinding);
 *   (4) unparseable callers and corrupt authority never attribute at all.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  attributeEvidence,
  epochOf,
  parseAgentId,
  parseAgentType,
  parseCallerIdentity,
  resolveSoleActiveBinding,
  type AgentId,
  type CallerIdentity,
  type MachineBinding,
  type MachineBindingAuthority,
} from "../../src/machine/evidence";

const ID_POOL = ["a339f6fd51d78b179", "a-2", "a-3", "a-4", "a-5"] as const;
const TYPE_POOL = ["code-implementer-agent", "ts-test-agent"] as const;

const agentId = (raw: string): AgentId => {
  const parsed = parseAgentId(raw);
  if (parsed === null) throw new Error(`fixture id ${raw} must parse`);
  return parsed;
};

const binding = (id: string, type: string): MachineBinding => {
  const agentType = parseAgentType(type);
  if (agentType === null) throw new Error(`fixture type ${type} must parse`);
  return { agentId: agentId(id), agentType, epoch: epochOf(agentId(id), agentType) };
};

const parsed = (bindings: readonly MachineBinding[]): MachineBindingAuthority => ({ kind: "parsed", bindings });

const bindingArb: fc.Arbitrary<MachineBinding> = fc
  .tuple(fc.constantFrom(...ID_POOL), fc.constantFrom(...TYPE_POOL))
  .map(([id, type]) => binding(id, type));

const bindingsArb = fc.uniqueArray(bindingArb, { maxLength: 5, selector: (b) => b.epoch });
const rosterArb = fc.uniqueArray(fc.constantFrom(...ID_POOL).map(agentId), { maxLength: 5 });
const reportedArb: fc.Arbitrary<CallerIdentity> = fc
  .constantFrom(...ID_POOL)
  .map((id) => parseCallerIdentity(id));

describe("attributeEvidence — caller identity is exact", () => {
  it("(1) a reported caller is credited only to its own binding, never via the sole fallback", () => {
    fc.assert(
      fc.property(reportedArb, bindingsArb, rosterArb, (caller, bindings, roster) => {
        const result = attributeEvidence(caller, parsed(bindings), roster);
        expect(result.kind).not.toBe("sole");
        expect(result.kind).not.toBe("contended");
        if (result.kind === "caller") {
          expect(caller.kind).toBe("reported");
          if (caller.kind === "reported") expect(result.binding.agentId).toBe(caller.agentId);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("(1) a reported caller with exactly one own binding line is credited to it, whatever else is bound", () => {
    fc.assert(
      fc.property(bindingsArb, rosterArb, (bindings, roster) => {
        for (const id of ID_POOL) {
          const own = bindings.filter((b) => b.agentId === id);
          const result = attributeEvidence(parseCallerIdentity(id), parsed(bindings), roster);
          if (bindings.length === 0) expect(result.kind).toBe("ungated");
          else if (own.length === 0) expect(result).toEqual({ kind: "caller-unbound", agentId: id });
          else if (own.length === 1) expect(result).toEqual({ kind: "caller", binding: own[0] });
          else expect(result).toEqual({ kind: "caller-ambiguous", agentId: id, bindings: own.length });
        }
      }),
      { numRuns: 300 },
    );
  });

  it("(2) N parallel bound implementers each attribute to their own epoch", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: ID_POOL.length }), (n) => {
        const bound = ID_POOL.slice(0, n).map((id) => binding(id, "code-implementer-agent"));
        const roster = bound.map((b) => b.agentId);
        const epochs = bound.map((b) => {
          const result = attributeEvidence(parseCallerIdentity(b.agentId), parsed(bound), roster);
          expect(result.kind).toBe("caller");
          return result.kind === "caller" ? result.binding.epoch : null;
        });
        expect(epochs).toEqual(bound.map((b) => b.epoch));
        expect(new Set(epochs).size).toBe(n);
      }),
    );
  });

  it("(3) an unreported caller gets exactly the sole-active decision", () => {
    fc.assert(
      fc.property(bindingsArb, rosterArb, (bindings, roster) => {
        const result = attributeEvidence(parseCallerIdentity(undefined), parsed(bindings), roster);
        const sole = resolveSoleActiveBinding(bindings, roster);
        if (bindings.length === 0) expect(result).toEqual({ kind: "ungated" });
        else if (sole === null) expect(result).toEqual({ kind: "contended" });
        else expect(result).toEqual({ kind: "sole", binding: sole });
      }),
      { numRuns: 500 },
    );
  });

  it("(4) unparseable callers and corrupt authority never attribute", () => {
    const unparseableArb = fc.oneof(
      fc.constantFrom("", "a 1", "a:1", "../a", "pi-grant-forged"),
      fc.integer(),
      fc.constant(null),
      fc.boolean(),
    );
    fc.assert(
      fc.property(unparseableArb, bindingsArb, rosterArb, (raw, bindings, roster) => {
        const caller = parseCallerIdentity(raw);
        expect(caller.kind).toBe("unparseable");
        const result = attributeEvidence(caller, parsed(bindings), roster);
        expect(["caller-unparseable", "ungated"]).toContain(result.kind);
      }),
    );
    fc.assert(
      fc.property(fc.oneof(reportedArb, fc.constant(parseCallerIdentity(undefined))), bindingsArb, rosterArb,
        (caller, bindings, roster) => {
          expect(attributeEvidence(caller, { kind: "corrupt", bindings }, roster)).toEqual({ kind: "corrupt" });
        }),
    );
  });
});

describe("parseCallerIdentity", () => {
  it("absent → unreported; a harness id → reported; the write-grant namespace is refused", () => {
    expect(parseCallerIdentity(undefined)).toEqual({ kind: "unreported" });
    expect(parseCallerIdentity("a339f6fd51d78b179")).toEqual({ kind: "reported", agentId: "a339f6fd51d78b179" });
    expect(parseCallerIdentity("pi-grant-x").kind).toBe("unparseable");
    expect(parseCallerIdentity(42)).toEqual({ kind: "unparseable", raw: "42" });
  });
});
