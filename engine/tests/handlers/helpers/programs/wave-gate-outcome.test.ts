import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { RegisteredWaveGateProgram } from "../../../../src/core/wave-gate-program";
import {
  NO_WAVE_REDERIVATIONS,
  spendWaveRederivation,
  waveResumeContext,
  type WaveRederivations,
} from "../../../../src/handlers/helpers/programs/wave-gate-outcome";
import { openRunDirectory, type RunDirHandle } from "../../../../src/orchestration/run-directory-handle";
import { StateManager } from "../../../../src/state-manager";
import { canonicalTempDir } from "../../../fixtures/canonical-temp-dir";

const RUN_ID = "run.wave-resume-context";
const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(): Readonly<{ handle: RunDirHandle; manager: StateManager }> {
  const root = canonicalTempDir("loom-wave-resume-context-");
  cleanup.push(root);
  const directory = join(root, RUN_ID);
  mkdirSync(directory, { recursive: true });
  const opened = openRunDirectory(root, directory);
  if (!opened.ok) throw new Error(opened.error.message);
  return { handle: opened.value, manager: new StateManager(join(root, "active_task_graph.json")) };
}

const registration = (wave: number | null): RegisteredWaveGateProgram => ({
  schemaVersion: 1, kind: "wave-gate", input: { wave }, taskIds: ["T1"], authorityDigest: "a".repeat(64),
});

describe("waveResumeContext — the reducer's first phase", () => {
  it("settles a registration that lacks an exact Wave as the blocked outcome, building no context", () => {
    const { handle, manager } = fixture();
    expect(waveResumeContext(handle, manager, registration(null), new Set())).toEqual({
      kind: "settled",
      result: { ok: true, action: { kind: "blocked", runId: handle.runId,
        diagnostic: { kind: "wave-gate-blocked", message: "registered Wave Gate authority lacks an exact Wave" } } },
    });
  });

  it("proceeds with a frozen context whose wave is the registration's own exact Wave", () => {
    const { handle, manager } = fixture();
    const registered = registration(3);
    const captured = new Set(["slot:1"]);
    const phase = waveResumeContext(handle, manager, registered, captured);
    if (phase.kind !== "proceed") throw new Error(`expected proceed, got ${phase.kind}`);
    expect(phase.value).toMatchObject({ handle, manager, registration: registered, wave: 3, captured });
    expect(Object.isFrozen(phase.value)).toBe(true);
  });
});

/**
 * The Wave Gate resume spin-guard. The reducer re-derives after each durable
 * step, and a defect that made no durable progress would recurse forever — an
 * engine that hangs rather than one that reports. The budget is the only way
 * the reducer re-enters itself, so these pin the bound itself: 64
 * re-derivations per invocation (65 reducer passes), then the blocked
 * diagnostic.
 */
describe("spendWaveRederivation — the reducer's re-derivation bound", () => {
  const spendFromFresh = (times: number): WaveRederivations => {
    let spent = NO_WAVE_REDERIVATIONS;
    for (let index = 0; index < times; index += 1) {
      const next = spendWaveRederivation(spent);
      if (!next.ok) throw new Error(`re-derivation ${index + 1} refused: ${next.error}`);
      spent = next.value;
    }
    return spent;
  };

  it("grants exactly 64 re-derivations, counting each, and refuses the 65th with the spin diagnostic", () => {
    const spent = spendFromFresh(64);
    expect(spent.made).toBe(64);
    expect(spendWaveRederivation(spent)).toEqual({
      ok: false,
      error: "Wave Gate resume exceeded 64 re-derivations without durable progress; refusing to spin",
    });
  });

  it("does not trip one below the bound, so legitimate long invocations are not capped early", () => {
    const next = spendWaveRederivation(spendFromFresh(63));
    expect(next.ok && next.value.made).toBe(64);
  });

  it("property: spending is pure — the spent budget is unchanged and frozen, and the result depends only on it", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 70 }), (times) => {
      const spent = spendFromFresh(Math.min(times, 64));
      const before = spent.made;
      const first = spendWaveRederivation(spent);
      expect(spendWaveRederivation(spent)).toEqual(first);
      expect(spent.made).toBe(before);
      expect(Object.isFrozen(spent)).toBe(true);
      expect(first.ok).toBe(before < 64);
    }), { numRuns: 50 });
  });

  it("rejects, at compile time, a hand-built budget", () => {
    // @ts-expect-error only NO_WAVE_REDERIVATIONS and spendWaveRederivation make a budget
    const forged: WaveRederivations = { made: 0 };
    expect(forged.made).toBe(0);
  });
});
