/**
 * `waveHasBlockCause` / `reconcileWaveBlock` — the ONE copy of the rule that
 * decides whether a wave's `blocked` veto has a cause.
 *
 * These two functions had no test at all, despite five production call sites
 * (`state-manager.ts`, `store-review-findings.ts`, `review-panel.ts`,
 * `store-spec-check-findings.ts`, `wave-gate-machine.ts`) and a doc comment
 * recording a silent bug that already shipped once: counting raw
 * `critical_findings.length` made a WHITESPACE-ONLY finding a block cause, so a
 * wave passed `wave-gate-machine`'s `checkCriticalFindings` (which counts only
 * `finding.trim() !== ""`) and then re-blocked against this predicate — dead
 * ending behind a "BLOCKED due to:" list with nothing in it.
 *
 * The comment says "Same filter, same answer, one rule". Nothing held it to
 * that. These tests do.
 */

import { describe, it, expect } from "vitest";
import {
  waveHasBlockCause,
  reconcileWaveBlock,
  newWaveGate,
  type WaveBlockCauseTask,
  type WaveBlockCauseSpecCheck,
  type WaveGate,
} from "../../src/core/wave-gate-model";

const task = (over: Partial<WaveBlockCauseTask> = {}): WaveBlockCauseTask => ({
  wave: 1,
  critical_findings: [],
  ...over,
});

const specCheck = (over: Partial<WaveBlockCauseSpecCheck> = {}): WaveBlockCauseSpecCheck => ({
  wave: 1,
  verdict: "ALIGNED",
  critical_count: 0,
  ...over,
});

describe("waveHasBlockCause — review-finding cause", () => {
  it("a substantive critical finding on a task in the wave is a cause", () => {
    expect(waveHasBlockCause([task({ critical_findings: ["a real defect"] })], undefined, 1)).toBe(true);
  });

  it("no findings at all is not a cause", () => {
    expect(waveHasBlockCause([task()], undefined, 1)).toBe(false);
    expect(waveHasBlockCause([task({ critical_findings: undefined })], undefined, 1)).toBe(false);
  });

  // The shipped bug, pinned in both directions.
  it("a whitespace-only finding is NOT a cause", () => {
    for (const blank of ["", " ", "\t", "\n", "   \t \n "]) {
      expect(waveHasBlockCause([task({ critical_findings: [blank] })], undefined, 1), JSON.stringify(blank)).toBe(false);
    }
  });

  it("a substantive finding still counts when a whitespace one sits beside it", () => {
    expect(waveHasBlockCause([task({ critical_findings: ["  ", "a real defect"] })], undefined, 1)).toBe(true);
  });

  it("reads only tasks in the wave asked about", () => {
    const tasks = [task({ wave: 2, critical_findings: ["defect in a later wave"] })];
    expect(waveHasBlockCause(tasks, undefined, 1)).toBe(false);
    expect(waveHasBlockCause(tasks, undefined, 2)).toBe(true);
  });
});

describe("waveHasBlockCause — spec-check cause", () => {
  it("a wave-scoped spec-check with a critical is a cause", () => {
    expect(waveHasBlockCause([], specCheck({ critical_count: 1 }), 1)).toBe(true);
  });

  it("zero, absent, or wrong-wave critical counts are not causes", () => {
    expect(waveHasBlockCause([], specCheck({ critical_count: 0 }), 1)).toBe(false);
    expect(waveHasBlockCause([], specCheck({ critical_count: undefined }), 1)).toBe(false);
    expect(waveHasBlockCause([], specCheck({ wave: 2, critical_count: 1 }), 1)).toBe(false);
    expect(waveHasBlockCause([], undefined, 1)).toBe(false);
  });

  // A spec-check whose evidence capture failed reports nothing it can stand
  // behind, so its count is not a cause the operator could act on.
  it("an EVIDENCE_CAPTURE_FAILED spec-check is not a cause even with a critical count", () => {
    expect(waveHasBlockCause([], specCheck({ verdict: "EVIDENCE_CAPTURE_FAILED", critical_count: 3 }), 1)).toBe(false);
  });
});

describe("reconcileWaveBlock", () => {
  const gates = (blocked: boolean): Readonly<Record<string, WaveGate>> =>
    Object.freeze({ "1": { ...newWaveGate(), blocked } });

  it("sets blocked when a cause appears", () => {
    const next = reconcileWaveBlock(gates(false), [task({ critical_findings: ["defect"] })], undefined, 1);
    expect(next["1"]!.blocked).toBe(true);
  });

  it("clears blocked when the last cause goes away", () => {
    const next = reconcileWaveBlock(gates(true), [task()], undefined, 1);
    expect(next["1"]!.blocked).toBe(false);
  });

  // The whitespace bug's actual consequence: a wave left blocked with an empty
  // visible cause list. Downgrading the only critical to whitespace must clear.
  it("clears blocked when the only critical finding is whitespace", () => {
    const next = reconcileWaveBlock(gates(true), [task({ critical_findings: ["   "] })], undefined, 1);
    expect(next["1"]!.blocked).toBe(false);
  });

  // Documented contract: callers leave `wave_gates` untouched on a no-op, which
  // is only observable as referential identity.
  it("returns the SAME record object when nothing changes", () => {
    const before = gates(false);
    expect(reconcileWaveBlock(before, [task()], undefined, 1)).toBe(before);

    const blocked = gates(true);
    expect(reconcileWaveBlock(blocked, [task({ critical_findings: ["defect"] })], undefined, 1)).toBe(blocked);
  });

  it("materializes a fresh gate for a wave with no record yet", () => {
    const empty: Readonly<Record<string, WaveGate>> = Object.freeze({});
    const next = reconcileWaveBlock(empty, [task({ wave: 3, critical_findings: ["defect"] })], undefined, 3);
    expect(next).not.toBe(empty);
    expect(next["3"]).toEqual({ ...newWaveGate(), blocked: true });
  });

  it("leaves the other waves' gates untouched", () => {
    const before = Object.freeze({
      "1": { ...newWaveGate(), blocked: false },
      "2": { ...newWaveGate(), impl_complete: true, blocked: true },
    });
    const next = reconcileWaveBlock(before, [task({ critical_findings: ["defect"] })], undefined, 1);
    expect(next["2"]).toBe(before["2"]);
    expect(next["1"]!.blocked).toBe(true);
  });

  it("agrees with waveHasBlockCause on every input it is given", () => {
    const cases: readonly (readonly [readonly WaveBlockCauseTask[], WaveBlockCauseSpecCheck | undefined])[] = [
      [[], undefined],
      [[task()], undefined],
      [[task({ critical_findings: [" "] })], undefined],
      [[task({ critical_findings: ["real"] })], undefined],
      [[], specCheck({ critical_count: 2 })],
      [[], specCheck({ verdict: "EVIDENCE_CAPTURE_FAILED", critical_count: 2 })],
      [[task({ critical_findings: ["real"] })], specCheck({ critical_count: 2 })],
    ];
    for (const [tasks, check] of cases) {
      const expected = waveHasBlockCause(tasks, check, 1);
      expect(reconcileWaveBlock(gates(!expected), tasks, check, 1)["1"]!.blocked).toBe(expected);
    }
  });
});
