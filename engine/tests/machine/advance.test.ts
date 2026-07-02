import { describe, it, expect } from "vitest";
import {
  advance,
  foldEvidence,
  currentPhase,
  isToolAllowed,
  isTerminal,
  missingRequirements,
  blockExplanation,
} from "../../src/machine/advance";
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

const read = (path = "/a.ts"): Evidence => ({ kind: "FileRead", path });
const write = (path = "/a.ts"): Evidence => ({ kind: "FileWrite", path });
// Facts only — judgment is derived at fold time via judgeTestRun.
const testRun = (over: Partial<Extract<Evidence, { kind: "TestRun" }>> = {}): Evidence => ({
  kind: "TestRun",
  command: "npm test",
  exit: 0,
  report: { total: 5, failed: 0, source: "vitest-json" },
  ...over,
});

describe("advance", () => {
  it("starts in read-context with enforced tools denied", () => {
    expect(currentPhase(machine, initialState).id).toBe("read-context");
    expect(isToolAllowed(machine, initialState, "Write")).toBe(false);
    expect(isToolAllowed(machine, initialState, "Edit")).toBe(false);
  });

  it("tools outside the jurisdiction always pass", () => {
    expect(isToolAllowed(machine, initialState, "Read")).toBe(true);
    expect(isToolAllowed(machine, initialState, "Bash")).toBe(true);
    expect(isToolAllowed(machine, initialState, "Grep")).toBe(true);
  });

  it("FileRead advances read-context → implement, enabling writes", () => {
    const s = advance(machine, initialState, read());
    expect(currentPhase(machine, s).id).toBe("implement");
    expect(isToolAllowed(machine, s, "Write")).toBe(true);
  });

  it("full happy path reaches done with no missing requirements", () => {
    const s = foldEvidence(machine, [read(), write(), testRun()]);
    expect(currentPhase(machine, s).id).toBe("done");
    expect(isTerminal(machine, s)).toBe(true);
    expect(missingRequirements(machine, s)).toEqual([]);
  });

  it("an untrusted 'pass' (exit 0, no report) never advances verify", () => {
    const s = foldEvidence(machine, [read(), write(), testRun({ report: null })]);
    expect(currentPhase(machine, s).id).toBe("verify");
    expect(missingRequirements(machine, s)).toEqual([{ event: "TestRunPassed", min: 1 }]);
  });

  it("a trusted failing TestRun (exit 1) never advances verify", () => {
    const s = foldEvidence(machine, [read(), write(), testRun({ exit: 1, report: null })]);
    expect(currentPhase(machine, s).id).toBe("verify");
  });

  it("a report showing failures never advances verify even on exit 0", () => {
    const s = foldEvidence(machine, [read(), write(), testRun({ report: { total: 5, failed: 1, source: "vitest-json" } })]);
    expect(currentPhase(machine, s).id).toBe("verify");
  });

  it("evidence order matters for phases, not counts: write recorded in read-context still counts", () => {
    // A write that somehow lands before any read (e.g. contended session)
    // is counted, so the fold stays deterministic and replayable.
    const s = foldEvidence(machine, [write(), read()]);
    // read advances to implement; the earlier write already satisfies implement's guard
    expect(currentPhase(machine, s).id).toBe("verify");
  });

  it("blockExplanation names phase, allowed tools, and the advance guard", () => {
    const msg = blockExplanation(machine, initialState, "Write");
    expect(msg).toContain('"read-context"');
    expect(msg).toContain("FileRead");
    expect(msg).toContain("Write");
  });

  it("foldEvidence of [] equals initialState settled", () => {
    const s = foldEvidence(machine, []);
    expect(s.phaseIndex).toBe(0);
    expect(s.counts).toEqual(initialState.counts);
  });
});
