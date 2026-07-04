import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { advance, foldEvidence, isTerminal, isToolAllowed, missingRequirements, tokensFor } from "../../src/machine/advance";
import { initialState, type Evidence } from "../../src/machine/types";
import { parseMachine } from "../../src/machine/parse-machine";
import { parseReportSummary } from "../../src/machine/test-report";

// MachineDef is branded: parseMachine is its only producer, so tests build
// the machine the same way production does — from a raw definition.
const parsed = parseMachine({
  agent: "code-implementer-agent",
  enforcedTools: ["Edit", "Write", "MultiEdit"],
  phases: [
    { id: "read-context", allowedTools: [], advance: { event: "FileRead", min: 1 } },
    { id: "implement", allowedTools: ["Edit", "Write", "MultiEdit"], advance: { event: "FileWrite", min: 1 } },
    { id: "verify", allowedTools: ["Edit", "Write", "MultiEdit"], advance: { event: "TestRunPassed", min: 1 } },
    { id: "done", terminal: true, allowedTools: ["Edit", "Write", "MultiEdit"], requires: [{ event: "TestRunPassed", min: 1 }] },
  ],
});
if (!parsed.ok) throw new Error(parsed.error);
const machine = parsed.value;

const evidenceArb: fc.Arbitrary<Evidence> = fc.oneof(
  fc.record({ kind: fc.constant("FileRead" as const), path: fc.constant("/f.ts") }),
  fc.record({ kind: fc.constant("FileWrite" as const), path: fc.constant("/f.ts") }),
  fc.record({
    kind: fc.constant("TestRun" as const),
    command: fc.constantFrom("npm test", "bun test", "mvn test", 'echo "npm test: 5 passing"'),
    exit: fc.option(fc.integer({ min: 0, max: 2 }), { nil: null }),
    // TestReportSummary is branded (parseReportSummary is its sole producer):
    // generate raw counts, then mint through the parser. Impossible counts
    // (failed > total) parse to null — which is exactly the report: null the
    // reducer must already tolerate, so coverage is preserved.
    report: fc
      .record({
        total: fc.integer({ min: 0, max: 100 }),
        failed: fc.integer({ min: 0, max: 100 }),
        source: fc.constantFrom("vitest-json" as const, "junit-xml" as const),
      })
      .map((r) => parseReportSummary(r.total, r.failed, r.source)),
  }),
);

/** The judgment the reducer must derive: exit 0 + confirming report. */
const isTrustedPass = (e: Evidence): boolean =>
  e.kind === "TestRun" && e.exit === 0 && e.report !== null && e.report.total > 0 && e.report.failed === 0;

describe("phase machine — invariants", () => {
  it("terminal is unreachable without a fact-confirmed passing TestRun", () => {
    fc.assert(
      fc.property(fc.array(evidenceArb, { maxLength: 50 }), (events) => {
        const s = foldEvidence(machine, events);
        if (!events.some(isTrustedPass)) {
          expect(isTerminal(machine, s)).toBe(false);
          expect(missingRequirements(machine, s).length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("stored judgments cannot exist — a ledger roundtrip preserves fold state", () => {
    fc.assert(
      fc.property(fc.array(evidenceArb, { maxLength: 30 }), (events) => {
        // Serialize as ledger records and re-parse: state must be identical
        // (this is the replayability property the fold design rests on).
        const lines = events.map((event) => JSON.stringify({ epoch: "a:b", event }));
        const reparsed = lines
          .map((l) => JSON.parse(l) as { event: Evidence })
          .map((r) => r.event);
        expect(foldEvidence(machine, reparsed)).toEqual(foldEvidence(machine, events));
      }),
      { numRuns: 200 },
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

  it("gate soundness: Write is never allowed while no FileRead has been observed", () => {
    fc.assert(
      fc.property(fc.array(evidenceArb, { maxLength: 50 }), (events) => {
        const s = foldEvidence(machine, events);
        if (s.counts.FileRead === 0) {
          expect(isToolAllowed(machine, s, "Write")).toBe(false);
          expect(isToolAllowed(machine, s, "Edit")).toBe(false);
        }
      }),
      { numRuns: 300 },
    );
  });
});
