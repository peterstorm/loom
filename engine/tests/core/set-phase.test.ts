/**
 * The `set-phase` loop-back (issue #50): every Phase but `execute` is a
 * target, and `execute` is refused for any argument shape, because only
 * `populate-task-graph` may enter it, in the write that installs the Tasks.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EXECUTE_IS_POPULATION_ONLY, applySetPhase, parseSetPhaseArgs } from "../../src/core/set-phase";
import { PHASES, type Phase } from "../../src/core/phases";
import type { TaskGraph } from "../../src/types";

const graph = (overrides: Partial<TaskGraph> = {}): TaskGraph => ({
  current_phase: "plan-alignment",
  phase_artifacts: { architecture: ".claude/plans/plan.md", "plan-alignment": ".claude/specs/s/plan-alignment.md" },
  skipped_phases: [],
  spec_file: null,
  plan_file: null,
  tasks: [],
  wave_gates: {},
  ...overrides,
});

const phase = fc.constantFrom(...PHASES);
const clearArtifact = fc.option(phase, { nil: null });
const argsFor = (target: Phase, clear: Phase | null): readonly string[] =>
  ["--phase", target, ...(clear === null ? [] : ["--clear-artifact", clear])];

describe("parseSetPhaseArgs", () => {
  it("parses every Phase but execute, with or without an artifact to clear", () => {
    fc.assert(fc.property(phase.filter((value) => value !== "execute"), clearArtifact, (target, clear) => {
      expect(parseSetPhaseArgs(argsFor(target, clear))).toEqual({ ok: true, value: { phase: target, clearArtifact: clear } });
    }));
  });

  it("refuses execute whatever else the arguments say, naming populate-task-graph", () => {
    fc.assert(fc.property(clearArtifact, fc.boolean(), (clear, clearFirst) => {
      const args = clearFirst && clear !== null
        ? ["--clear-artifact", clear, "--phase", "execute"]
        : argsFor("execute", clear);
      expect(parseSetPhaseArgs(args)).toEqual({ ok: false, error: EXECUTE_IS_POPULATION_ONLY });
    }));
    expect(EXECUTE_IS_POPULATION_ONLY).toContain("helper populate-task-graph");
  });

  it.each([
    [[], "Invalid or missing --phase"],
    [["--phase"], "Invalid or missing --phase"],
    [["--phase", "nonexistent"], "Invalid or missing --phase"],
    [["--phase", "architecture", "--clear-artifact", "nonexistent"], "Invalid --clear-artifact"],
  ])("refuses %j", (args, message) => {
    const parsed = parseSetPhaseArgs(args);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });
});

describe("applySetPhase", () => {
  const updatedAt = "2026-11-02T00:00:00.000Z";

  it("moves the Phase and stamps updated_at, leaving the artifacts alone when none is cleared", () => {
    const before = graph();
    const after = applySetPhase(before, { phase: "architecture", clearArtifact: null }, updatedAt);
    expect(after).toEqual({ ...before, current_phase: "architecture", updated_at: updatedAt });
  });

  it("drops exactly the cleared artifact", () => {
    const after = applySetPhase(graph(), { phase: "architecture", clearArtifact: "plan-alignment" }, updatedAt);
    expect(after.phase_artifacts).toEqual({ architecture: ".claude/plans/plan.md" });
  });

  it("clearing an artifact that was never recorded changes no artifact", () => {
    const before = graph();
    expect(applySetPhase(before, { phase: "architecture", clearArtifact: "brainstorm" }, updatedAt).phase_artifacts)
      .toEqual(before.phase_artifacts);
  });
});
