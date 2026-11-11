/**
 * The shipped distill-agent Guarded Skill Machine (ADR-0068 §8): the distill
 * skill's "green baseline first" rule made mechanical on Claude Code. No file
 * tool is available before one trusted passing test run; after it, writes and
 * test runs are free in any order. The machine does not judge "a pass after
 * the last write": settlement owns that, and these tests pin where the line is.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { capVerdictForMachineCompletion, resolveTestEvidence } from "../../src/core/implementation-evidence";
import { DISTILL_AGENT } from "../../src/core/model-profiles";
import {
  blockExplanation, foldEvidence, isTerminal, isToolAllowed, missingRequirements,
} from "../../src/machine/advance";
import { machineToMermaid } from "../../src/machine/mermaid";
import { parseMachineJson } from "../../src/machine/parse-machine";
import { GATE_WIRED_TOOLS, type Evidence } from "../../src/machine/types";
import { DISTILLER_TYPE } from "../fixtures/machine-identities";
import { reportSummary } from "./report-summary";

const MACHINES = join(__dirname, "../../../machines");
const parsed = parseMachineJson(readFileSync(join(MACHINES, `${DISTILL_AGENT}.machine.json`), "utf-8"));
if (!parsed.ok) throw new Error(parsed.error);
const machine = parsed.value;

const read: Evidence = { kind: "FileRead", path: "/repo/src/a.ts" };
const write: Evidence = { kind: "FileWrite", path: "/repo/src/a.ts", via: "tool" };
const shellWrite: Evidence = { kind: "FileWrite", path: "/repo/src/a.ts", via: "shell" };
const pass: Evidence = { kind: "TestRun", command: "npx vitest run", exit: 0, report: reportSummary(4, 0) };
const fail: Evidence = { kind: "TestRun", command: "npx vitest run", exit: 1, report: null };
const unreportedPass: Evidence = { kind: "TestRun", command: "npx vitest run", exit: 0, report: null };

const writesAllowed = (events: readonly Evidence[]): boolean =>
  GATE_WIRED_TOOLS.every((tool) => isToolAllowed(machine, foldEvidence(machine, events), tool));
const writesDenied = (events: readonly Evidence[]): boolean =>
  GATE_WIRED_TOOLS.every((tool) => !isToolAllowed(machine, foldEvidence(machine, events), tool));

/** What settlement's machine cap does to the verdict the same events resolve to. */
const settled = (events: readonly Evidence[]) => {
  const resolved = resolveTestEvidence(events, "", true);
  const capped = capVerdictForMachineCompletion(resolved, missingRequirements(machine, foldEvidence(machine, events)));
  return { resolved, capped };
};

describe("shipped distill-agent machine definition", () => {
  it("parses, names the Distill Task's agent and claims every gate-wired file tool", () => {
    expect(machine.agent).toBe(DISTILLER_TYPE);
    expect(machine.agent).toBe(DISTILL_AGENT);
    expect([...machine.enforcedTools].sort()).toEqual([...GATE_WIRED_TOOLS].sort());
    expect(machine.phases.map(({ id }) => id)).toEqual(["green-baseline", "distill"]);
  });

  it("machines/README.md contains the exact machineToMermaid output", () => {
    expect(readFileSync(join(MACHINES, "README.md"), "utf-8")).toContain(machineToMermaid(machine));
  });
});

describe("green baseline first", () => {
  it("denies every file tool before a passing run and says what advances the phase", () => {
    expect(writesDenied([])).toBe(true);
    const message = blockExplanation(machine, foldEvidence(machine, []), "Edit");
    expect(message).toContain("green-baseline");
    expect(message).toContain("TestRunPassed");
  });

  it("allows reads and every unenforced tool from the start", () => {
    const state = foldEvidence(machine, []);
    for (const tool of ["Read", "Grep", "Glob", "Bash", "Skill"]) {
      expect(isToolAllowed(machine, state, tool)).toBe(true);
    }
  });

  it.each([
    ["reads alone", [read, read]],
    ["a failing run", [read, fail]],
    ["an exit-0 run with no parsed report", [read, unreportedPass]],
    ["a shell write", [read, shellWrite]],
  ] as const)("%s do not unlock writes", (_name, events) => {
    expect(writesDenied(events)).toBe(true);
    expect(isTerminal(machine, foldEvidence(machine, events))).toBe(false);
  });

  it("one trusted passing run unlocks writes, with or without a read before it", () => {
    expect(writesAllowed([pass])).toBe(true);
    expect(writesAllowed([read, fail, pass])).toBe(true);
  });
});

describe("after the baseline, writes and test runs are free", () => {
  it.each([
    ["write, pass", [pass, write, pass]],
    ["several writes then a failing run", [pass, write, write, fail]],
    ["interleaved runs and writes", [pass, write, fail, write, pass, write]],
  ] as const)("keeps writes allowed after %s", (_name, events) => {
    expect(writesAllowed(events)).toBe(true);
    expect(isTerminal(machine, foldEvidence(machine, events))).toBe(true);
  });
});

describe("terminal requirement and the settlement cap", () => {
  it("a pass that changed nothing completes the machine and keeps its trusted pass", () => {
    const { resolved, capped } = settled([read, pass]);
    expect(missingRequirements(machine, foldEvidence(machine, [read, pass]))).toEqual([]);
    expect(resolved.result).toEqual({ verdict: "trusted-pass" });
    expect(capped).toBe(resolved);
  });

  it("an edit followed by a passing run completes the machine and keeps its trusted pass", () => {
    const { resolved, capped } = settled([read, pass, write, pass]);
    expect(resolved.result).toEqual({ verdict: "trusted-pass" });
    expect(capped).toBe(resolved);
  });

  it("does not approximate 'a pass after the last write': the machine is complete, the evidence resolver demotes", () => {
    const events = [read, pass, write];
    expect(missingRequirements(machine, foldEvidence(machine, events))).toEqual([]);
    const { resolved, capped } = settled(events);
    expect(resolved.result).toMatchObject({
      verdict: "untrusted",
      label: "low-trust (files modified after last trusted pass; transcript-regex)",
    });
    expect(capped).toBe(resolved);
  });

  it("a run that never saw a passing baseline is incomplete, and has no trusted pass to cap", () => {
    const events = [read, fail];
    expect(missingRequirements(machine, foldEvidence(machine, events))).toEqual([{ event: "TestRunPassed", min: 1 }]);
    const { resolved, capped } = settled(events);
    expect(resolved.result).toEqual({ verdict: "trusted-fail" });
    expect(capped).toBe(resolved);
  });
});
