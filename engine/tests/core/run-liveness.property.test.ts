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

const NOTHING_READ: RunLivenessObservation = {
  resultPublished: false, abandoned: false, registration: null, checkpoint: null,
};

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
  ...NOTHING_READ, registration: { kind: program }, checkpoint: checkpointIn(program, state),
});

const anyProgram = fc.constantFrom(...INSPECTABLE_PROGRAMS);
const anyObservation = fc.record({
  resultPublished: fc.boolean(),
  abandoned: fc.boolean(),
  registration: fc.oneof(fc.jsonValue(), anyProgram.map((kind) => ({ kind }))),
  checkpoint: fc.jsonValue(),
});

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

  it("a published result and an abandonment each finish the run, the published result first", () => {
    expect(runLiveness({ ...NOTHING_READ, resultPublished: true })).toEqual({ kind: "finished", because: "result-published" });
    expect(runLiveness({ ...NOTHING_READ, abandoned: true })).toEqual({ kind: "finished", because: "abandoned" });
    expect(runLiveness({ ...NOTHING_READ, resultPublished: true, abandoned: true }))
      .toEqual({ kind: "finished", because: "result-published" });
  });

  it("only the panels lack terminal checkpoint states", () => {
    const withoutEnd = INSPECTABLE_PROGRAMS.filter((program) => TERMINAL_CHECKPOINT_STATES[program].size === 0);
    expect(withoutEnd).toEqual(["architecture", "refutation"]);
  });
});

describe("runLiveness — properties", () => {
  it("is total: any observation yields open or finished, never throws", () => {
    fc.assert(fc.property(anyObservation, (observation) => {
      expect(["open", "finished"]).toContain(runLiveness(observation).kind);
    }));
  });

  it("a published result or an abandonment finishes the run whatever its files say", () => {
    fc.assert(fc.property(anyObservation, (observation) => {
      fc.pre(observation.resultPublished || observation.abandoned);
      expect(runLiveness(observation).kind).toBe("finished");
    }));
  });

  it("a registration this build does not recognize never finishes a run on its own", () => {
    fc.assert(fc.property(fc.jsonValue(), fc.jsonValue(), (registration, checkpoint) => {
      const kind = typeof registration === "object" && registration !== null && !Array.isArray(registration)
        ? (registration as Record<string, unknown>)["kind"]
        : undefined;
      fc.pre(!INSPECTABLE_PROGRAMS.some((program) => program === kind));
      expect(runLiveness({ ...NOTHING_READ, registration, checkpoint })).toEqual({ kind: "open" });
    }));
  });

  it("a state name outside its program's terminal set keeps the run open", () => {
    fc.assert(fc.property(anyProgram, fc.string(), (program, state) => {
      fc.pre(!TERMINAL_CHECKPOINT_STATES[program].has(state));
      expect(runLiveness(observing(program, state))).toEqual({ kind: "open" });
    }));
  });

  it("finishing is monotone: adding an abandonment never reopens a run", () => {
    fc.assert(fc.property(anyObservation, (observation) => {
      fc.pre(runLiveness(observation).kind === "finished");
      expect(runLiveness({ ...observation, abandoned: true }).kind).toBe("finished");
    }));
  });
});
