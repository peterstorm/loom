import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { advance, foldEvidence, isTerminal, missingRequirements, tokensFor } from "../../src/machine/advance";
import { initialState, type Evidence, type MachineDef } from "../../src/machine/types";

const machine: MachineDef = {
  agent: "code-implementer-agent",
  enforcedTools: ["Edit", "Write", "MultiEdit"],
  phases: [
    { id: "read-context", allowedTools: [], advance: { event: "FileRead", min: 1 }, terminal: false, requires: [] },
    { id: "implement", allowedTools: ["Edit", "Write", "MultiEdit"], advance: { event: "FileWrite", min: 1 }, terminal: false, requires: [] },
    { id: "verify", allowedTools: ["Edit", "Write", "MultiEdit"], advance: { event: "TestRunPassed", min: 1 }, terminal: false, requires: [] },
    { id: "done", allowedTools: ["Edit", "Write", "MultiEdit"], advance: null, terminal: true, requires: [{ event: "TestRunPassed", min: 1 }] },
  ],
};

const evidenceArb: fc.Arbitrary<Evidence> = fc.oneof(
  fc.record({ kind: fc.constant("FileRead" as const), path: fc.constant("/f.ts") }),
  fc.record({ kind: fc.constant("FileWrite" as const), path: fc.constant("/f.ts") }),
  fc.record({
    kind: fc.constant("TestRun" as const),
    command: fc.constantFrom("npm test", "bun test", "mvn test", 'echo "npm test: 5 passing"'),
    exit: fc.option(fc.integer({ min: 0, max: 2 }), { nil: null }),
    report: fc.option(
      fc.record({
        total: fc.integer({ min: 0, max: 100 }),
        failed: fc.integer({ min: 0, max: 100 }),
        source: fc.constantFrom("vitest-json" as const, "junit-xml" as const),
      }),
      { nil: null },
    ),
    passed: fc.boolean(),
    trusted: fc.boolean(),
  }),
);

describe("phase machine — invariants", () => {
  it("terminal is unreachable without a trusted passing TestRun", () => {
    fc.assert(
      fc.property(fc.array(evidenceArb, { maxLength: 50 }), (events) => {
        const s = foldEvidence(machine, events);
        const trustedPass = events.some((e) => e.kind === "TestRun" && e.passed && e.trusted);
        if (!trustedPass) {
          expect(isTerminal(machine, s)).toBe(false);
          expect(missingRequirements(machine, s).length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("phaseIndex is monotonically non-decreasing under any event", () => {
    fc.assert(
      fc.property(fc.array(evidenceArb, { maxLength: 50 }), (events) => {
        let s = foldEvidence(machine, []);
        for (const e of events) {
          const next = advance(machine, s, e);
          expect(next.phaseIndex).toBeGreaterThanOrEqual(s.phaseIndex);
          s = next;
        }
      }),
      { numRuns: 300 },
    );
  });

  it("fold equals incremental application (state is replayable from the ledger)", () => {
    fc.assert(
      fc.property(fc.array(evidenceArb, { maxLength: 50 }), (events) => {
        const folded = foldEvidence(machine, events);
        let incremental = foldEvidence(machine, []);
        for (const e of events) incremental = advance(machine, incremental, e);
        expect(incremental).toEqual(folded);
      }),
      { numRuns: 300 },
    );
  });

  it("counts always equal the token tally of the ledger", () => {
    fc.assert(
      fc.property(fc.array(evidenceArb, { maxLength: 50 }), (events) => {
        const s = foldEvidence(machine, events);
        const tally = { FileRead: 0, FileWrite: 0, TestRun: 0, TestRunPassed: 0 };
        for (const e of events) for (const t of tokensFor(e)) tally[t]++;
        expect(s.counts).toEqual(tally);
      }),
      { numRuns: 300 },
    );
  });

  it("initialState never allows enforced tools before evidence", () => {
    expect(initialState.phaseIndex).toBe(0);
    expect(machine.phases[0].allowedTools).toEqual([]);
  });
});
