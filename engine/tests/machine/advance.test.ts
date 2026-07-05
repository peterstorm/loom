import { describe, it, expect } from "vitest";
import {
  advance,
  foldEvidence,
  currentPhase,
  isToolAllowed,
  isTerminal,
  missingRequirements,
  blockExplanation,
  tokensFor,
} from "../../src/machine/advance";
import { initialState, type Evidence } from "../../src/machine/types";
import { parseMachine } from "../../src/machine/parse-machine";
import { reportSummary } from "./report-summary";

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

const read = (path = "/a.ts"): Evidence => ({ kind: "FileRead", path });
const write = (path = "/a.ts"): Evidence => ({ kind: "FileWrite", path, via: "tool" });
// Facts only — judgment is derived at fold time via judgeTestRun.
const testRun = (over: Partial<Extract<Evidence, { kind: "TestRun" }>> = {}): Evidence => ({
  kind: "TestRun",
  command: "npm test",
  exit: 0,
  report: reportSummary(5, 0),
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
    const s = foldEvidence(machine, [read(), write(), testRun({ report: reportSummary(5, 1) })]);
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

describe("Requirement.min > 1 (thresholds are counted, not boolean)", () => {
  const thresholdParsed = parseMachine({
    agent: "code-implementer-agent",
    enforcedTools: ["Edit", "Write", "MultiEdit"],
    phases: [
      { id: "read-context", allowedTools: [], advance: { event: "FileRead", min: 2 } },
      { id: "implement", allowedTools: ["Edit", "Write", "MultiEdit"], advance: { event: "FileWrite", min: 1 } },
      { id: "done", terminal: true, allowedTools: ["Edit", "Write", "MultiEdit"], requires: [{ event: "TestRunPassed", min: 1 }] },
    ],
  });
  if (!thresholdParsed.ok) throw new Error(thresholdParsed.error);
  const threshold = thresholdParsed.value;

  it("one FileRead does NOT satisfy min: 2 — still blocked, explanation shows the shortfall", () => {
    const s = foldEvidence(threshold, [read("/a.ts")]);
    expect(currentPhase(threshold, s).id).toBe("read-context");
    expect(isToolAllowed(threshold, s, "Write")).toBe(false);

    const msg = blockExplanation(threshold, s, "Write");
    expect(msg).toContain("FileRead ≥ 2 (currently 1)");
  });

  it("two FileReads satisfy min: 2 and advance the phase", () => {
    const s = foldEvidence(threshold, [read("/a.ts"), read("/b.ts")]);
    expect(currentPhase(threshold, s).id).toBe("implement");
    expect(isToolAllowed(threshold, s, "Write")).toBe(true);
  });

  it("the same path read twice counts twice — the guard counts events, not distinct paths", () => {
    const s = foldEvidence(threshold, [read("/a.ts"), read("/a.ts")]);
    expect(currentPhase(threshold, s).id).toBe("implement");
  });
});

describe("missingRequirements — broken terminal-is-last invariant fails CLOSED", () => {
  it("a non-terminal last phase (unparseable via parseMachine, forced structurally) reads as failure, never []", async () => {
    const { MACHINE_INVARIANT_VIOLATED } = await import("../../src/machine/advance");
    const { satisfied } = await import("../../src/machine/advance");
    // parseMachine enforces terminal-is-last, so this MachineDef can only be
    // forged by casting — exactly the impossible state the sentinel guards.
    const broken = {
      agent: "broken-agent",
      enforcedTools: ["Edit"],
      phases: [{ id: "a", terminal: false, allowedTools: [], advance: { event: "FileRead", min: 1 } }],
    } as unknown as typeof machine;
    const missing = missingRequirements(broken, initialState);
    expect(missing).toEqual([MACHINE_INVARIANT_VIOLATED]);
    // The sentinel is unsatisfiable by construction — the impossible state
    // can never be reported as clean completion.
    expect(satisfied(MACHINE_INVARIANT_VIOLATED, { FileRead: 9999, FileWrite: 9999, TestRun: 9999, TestRunPassed: 9999 })).toBe(false);
  });
});

describe("tokensFor — shell writes never advance guards (round-10 Fix 5)", () => {
  it("via: 'shell' counts nothing; via: 'tool' counts FileWrite (absent via maps to 'tool' at the parse boundary)", () => {
    expect(tokensFor({ kind: "FileWrite", path: "/x", via: "shell" })).toEqual([]);
    expect(tokensFor({ kind: "FileWrite", path: "/x", via: "tool" })).toEqual(["FileWrite"]);
  });

  it("a Bash redirect cannot push the machine past the implement guard", () => {
    // read → implement; a shell write must leave the machine in implement.
    const viaShell = foldEvidence(machine, [read(), { kind: "FileWrite", path: "/x", via: "shell" }]);
    expect(currentPhase(machine, viaShell).id).toBe("implement");
    // …while a tool write advances to verify.
    const viaTool = foldEvidence(machine, [read(), write()]);
    expect(currentPhase(machine, viaTool).id).toBe("verify");
  });
});
