/**
 * Whether a bound run can still advance decides whether the SessionStart sweep
 * may delete its session's Session Run Binding registry. Releasing an open run
 * early refuses its subagents' captures and its completion; keeping a finished
 * one only costs a few kilobytes until the grace bound. So every rule here
 * leans open: a run is finished only on its own proof.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { INSPECTABLE_PROGRAMS, type InspectableProgram } from "../../src/core/run-inspection";
import { runLiveness, TERMINAL_CHECKPOINT_STATES, type RunLivenessObservation } from "../../src/core/run-liveness";

const NOTHING_READ: RunLivenessObservation = { kind: "run-files", registration: null, checkpoint: null };

/** The checkpoint shape each program keeps its state name in. */
function checkpointIn(program: InspectableProgram, state: string): unknown {
  switch (program) {
    case "standalone-review":
    case "standalone-disposition":
    case "wave-gate":
      return { kind: state };
    case "remediation":
      return { schemaVersion: 2, state: { state } };
    case "architecture":
    case "refutation":
      return { data: { state: { stage: state } } };
    default: {
      const unreachable: never = program;
      throw new Error(`unknown program ${String(unreachable)}`);
    }
  }
}

const observing = (program: InspectableProgram, state: string): RunLivenessObservation => ({
  kind: "run-files", registration: { kind: program }, checkpoint: checkpointIn(program, state),
});

const anyProgram = fc.constantFrom(...INSPECTABLE_PROGRAMS);
const anyRunFiles = fc.record({
  kind: fc.constant("run-files" as const),
  registration: fc.oneof(fc.jsonValue(), anyProgram.map((kind) => ({ kind }))),
  checkpoint: fc.jsonValue(),
});
const anyObservation: fc.Arbitrary<RunLivenessObservation> = fc.oneof(
  fc.constant({ kind: "result-published" as const }),
  fc.constant({ kind: "abandoned" as const }),
  anyRunFiles,
);
/** A program paired with one of its own terminal states; the panels have none. */
const anyTerminalPair = fc.constantFrom(
  ...INSPECTABLE_PROGRAMS.flatMap((program) => TERMINAL_CHECKPOINT_STATES[program].map((state) => [program, state] as const)),
);

describe("runLiveness — examples", () => {
  it("a run with nothing read yet is open", () => {
    expect(runLiveness(NOTHING_READ)).toEqual({ kind: "open" });
  });

  it("each program's terminal checkpoint states finish it", () => {
    const terminal: readonly (readonly [InspectableProgram, string])[] = [
      ["standalone-review", "done"], ["standalone-review", "terminal-blocked"],
      ["standalone-disposition", "done"], ["remediation", "done"],
      ["wave-gate", "wave-gate-done"], ["wave-gate", "wave-gate-retired"],
    ];
    for (const [program, state] of terminal) {
      expect(runLiveness(observing(program, state)), `${program} ${state}`).toEqual({ kind: "finished", because: "terminal-state" });
    }
  });

  it("a blocked run its operator can still resume stays open", () => {
    expect(runLiveness(observing("standalone-review", "recoverable-blocked"))).toEqual({ kind: "open" });
    expect(runLiveness(observing("remediation", "recoverable-blocked"))).toEqual({ kind: "open" });
  });

  it("a panel is never finished by a checkpoint: its end lives in its journal", () => {
    for (const panel of ["architecture", "refutation"] as const) {
      for (const stage of ["complete", "done", "blocked"]) {
        expect(runLiveness(observing(panel, stage)), `${panel} ${stage}`).toEqual({ kind: "open" });
      }
    }
  });

  it("a published result and an abandonment each finish the run, naming their proof", () => {
    expect(runLiveness({ kind: "result-published" })).toEqual({ kind: "finished", because: "result-published" });
    expect(runLiveness({ kind: "abandoned" })).toEqual({ kind: "finished", because: "abandoned" });
  });

  it("only the panels lack terminal checkpoint states", () => {
    const withoutEnd = INSPECTABLE_PROGRAMS.filter((program) => TERMINAL_CHECKPOINT_STATES[program].length === 0);
    expect(withoutEnd).toEqual(["architecture", "refutation"]);
  });

  it("no caller can add a terminal state: the table is frozen through every list", () => {
    expect(Object.isFrozen(TERMINAL_CHECKPOINT_STATES)).toBe(true);
    for (const program of INSPECTABLE_PROGRAMS) {
      const states = TERMINAL_CHECKPOINT_STATES[program];
      expect(Object.isFrozen(states), program).toBe(true);
      expect(() => (states as string[]).push("running"), program).toThrow(TypeError);
    }
    expect(runLiveness(observing("standalone-review", "running"))).toEqual({ kind: "open" });
  });
});

describe("runLiveness — properties", () => {
  it("is total: any observation yields open or finished, never throws", () => {
    fc.assert(fc.property(anyObservation, (observation) => {
      expect(["open", "finished"]).toContain(runLiveness(observation).kind);
    }));
  });

  it("a run finished by its files is finished only by a terminal state", () => {
    fc.assert(fc.property(anyRunFiles, (observation) => {
      const liveness = runLiveness(observation);
      if (liveness.kind === "finished") expect(liveness.because).toBe("terminal-state");
    }));
  });

  it("a registration this build does not recognize never finishes a run on its own", () => {
    fc.assert(fc.property(fc.jsonValue(), fc.jsonValue(), (registration, checkpoint) => {
      const kind = typeof registration === "object" && registration !== null && !Array.isArray(registration)
        ? (registration as Record<string, unknown>)["kind"]
        : undefined;
      fc.pre(!INSPECTABLE_PROGRAMS.some((program) => program === kind));
      expect(runLiveness({ kind: "run-files", registration, checkpoint })).toEqual({ kind: "open" });
    }));
  });

  it("a state name outside its program's terminal set keeps the run open", () => {
    fc.assert(fc.property(anyProgram, fc.string(), (program, state) => {
      fc.pre(!TERMINAL_CHECKPOINT_STATES[program].includes(state));
      expect(runLiveness(observing(program, state))).toEqual({ kind: "open" });
    }));
  });

  it("every terminal state finishes exactly its own program, read through that program's checkpoint shape", () => {
    fc.assert(fc.property(anyTerminalPair, ([program, state]) => {
      expect(runLiveness(observing(program, state))).toEqual({ kind: "finished", because: "terminal-state" });
    }));
  });
});
