/**
 * loom#198, Cause 4: a TaskGraph is only ever written by the engine revision
 * it is pinned to; moving the pin is an explicit, audited adoption.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  adoptEngineRevision,
  engineRevisionPinAtPopulation,
  engineRevisionWriteRefusal,
  isEngineRevision,
  isSelfHosted,
  MAX_ENGINE_REVISION_REASON_LENGTH,
} from "../../src/core/engine-revision-pin";
import { parseTaskGraph } from "../../src/state-file-wire";
import type { EngineRevisionPin, TaskGraph } from "../../src/types";

const REV_A = `sha256:${"a".repeat(64)}`;
const REV_B = `sha256:${"b".repeat(64)}`;
const REV_C = `sha256:${"c".repeat(64)}`;

const graph = (engine_revision?: EngineRevisionPin): TaskGraph => ({
  current_phase: "execute", phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: null,
  tasks: [], wave_gates: {}, ...(engine_revision === undefined ? {} : { engine_revision }),
});
const adopted = (state: TaskGraph, revision: string, reason = "the fix for #196 is on main"): TaskGraph => {
  const result = adoptEngineRevision(state, revision, reason);
  if (!result.ok || result.value.kind !== "adopted") throw new Error(`expected an adoption, got ${JSON.stringify(result)}`);
  return result.value.graph;
};

describe("the pin population records", () => {
  it("pins the running revision, or records self-hosted", () => {
    expect(engineRevisionPinAtPopulation(REV_A, false)).toEqual({ schemaVersion: 1, kind: "pinned", revision: REV_A, adoptions: [] });
    expect(engineRevisionPinAtPopulation(REV_A, true)).toEqual({ schemaVersion: 1, kind: "self-hosted" });
  });

  it("calls a project self-hosted exactly when it holds the engine package", () => {
    expect(isSelfHosted("/work/loom", "/work/loom", "/")).toBe(true);
    expect(isSelfHosted("/work/repo/vendor/loom", "/work/repo", "/")).toBe(true);
    expect(isSelfHosted("/work/loom", "/work/loom-graph-checks", "/")).toBe(false);
    expect(isSelfHosted("/plugins/loom", "/work/flexii", "/")).toBe(false);
  });
});

describe("engineRevisionWriteRefusal", () => {
  it("lets the pinned revision write, and refuses any other with the adoption command", () => {
    const pinned = graph(engineRevisionPinAtPopulation(REV_A, false));
    expect(engineRevisionWriteRefusal(pinned, REV_A)).toBeNull();
    const refusal = engineRevisionWriteRefusal(pinned, REV_B);
    expect(refusal).toContain(`pinned to Loom engine revision ${REV_A}`);
    expect(refusal).toContain(`the running engine is ${REV_B}`);
    expect(refusal).toContain("helper orchestration adopt-engine-revision");
  });

  it("never refuses an unpinned or self-hosted graph", () => {
    expect(engineRevisionWriteRefusal(graph(), REV_B)).toBeNull();
    expect(engineRevisionWriteRefusal(graph(engineRevisionPinAtPopulation(REV_A, true)), REV_B)).toBeNull();
  });
});

describe("adoptEngineRevision", () => {
  it("moves the pin to the running revision and records where from and why, so the running engine may write it", () => {
    const moved = adopted(graph(engineRevisionPinAtPopulation(REV_A, false)), REV_B);
    expect(moved.engine_revision).toEqual({
      schemaVersion: 1, kind: "pinned", revision: REV_B,
      adoptions: [{ from: REV_A, to: REV_B, reason: "the fix for #196 is on main" }],
    });
    expect(engineRevisionWriteRefusal(moved, REV_B)).toBeNull();
  });

  it("gives an unpinned graph its first pin", () => {
    expect(adopted(graph(), REV_A).engine_revision).toMatchObject({ revision: REV_A, adoptions: [{ from: null, to: REV_A }] });
  });

  it("is idempotent on the running revision", () => {
    expect(adoptEngineRevision(graph(engineRevisionPinAtPopulation(REV_A, false)), REV_A, "again"))
      .toEqual({ ok: true, value: { kind: "already-pinned", revision: REV_A } });
  });

  it.each<[string, EngineRevisionPin | undefined, string, string]>([
    ["a self-hosted graph", { schemaVersion: 1, kind: "self-hosted" }, REV_B, "reason"],
    ["a blank reason", undefined, REV_B, "   "],
    ["an over-long reason", undefined, REV_B, "r".repeat(MAX_ENGINE_REVISION_REASON_LENGTH + 1)],
    ["a running revision that is no runtime revision", undefined, "HEAD", "reason"],
  ])("refuses %s", (_label, pin, revision, reason) => {
    expect(adoptEngineRevision(graph(pin), revision, reason).ok).toBe(false);
  });

  it("keeps a chain of adoptions the State File parser loads, whatever the sequence of moves", () => {
    fc.assert(fc.property(fc.array(fc.constantFrom(REV_A, REV_B, REV_C), { maxLength: 6 }), (moves) => {
      let state = graph(engineRevisionPinAtPopulation(REV_A, false));
      for (const revision of moves) {
        const result = adoptEngineRevision(state, revision, "move");
        if (!result.ok) throw new Error(result.error);
        if (result.value.kind === "adopted") state = result.value.graph;
      }
      const reloaded = parseTaskGraph(JSON.parse(JSON.stringify(state)));
      expect(reloaded.ok, reloaded.ok ? "" : reloaded.error).toBe(true);
      expect(engineRevisionWriteRefusal(state, moves.at(-1) ?? REV_A)).toBeNull();
    }));
  });
});

describe("engine_revision on the State File", () => {
  const loaded = (pin: unknown) => parseTaskGraph(JSON.parse(JSON.stringify({ ...graph(), engine_revision: pin })));
  const PINNED = { schemaVersion: 1, kind: "pinned", revision: REV_B, adoptions: [{ from: REV_A, to: REV_B, reason: "why" }] };

  it("loads a pinned, a self-hosted and an absent pin", () => {
    expect(loaded(PINNED)).toMatchObject({ ok: true, value: { engine_revision: PINNED } });
    expect(loaded({ schemaVersion: 1, kind: "self-hosted" })).toMatchObject({ ok: true });
    expect(parseTaskGraph(graph()).ok).toBe(true);
    expect(isEngineRevision(REV_A)).toBe(true);
  });

  it.each<[string, unknown, string]>([
    ["an unknown kind", { ...PINNED, kind: "floating" }, "must be pinned or self-hosted"],
    ["an unknown field", { ...PINNED, extra: 1 }, "unknown field(s): extra"],
    ["a revision that is no runtime revision", { ...PINNED, revision: "HEAD" }, "must be a runtime revision"],
    ["a broken chain", { ...PINNED, revision: REV_C, adoptions: [{ from: REV_A, to: REV_B, reason: "a" }, { from: REV_A, to: REV_C, reason: "b" }] },
      "does not start where the previous adoption ended"],
    ["a pin that is not where the chain ends", { ...PINNED, revision: REV_C }, "is not where its last adoption ended"],
    ["an adoption that moves nowhere", { ...PINNED, revision: REV_A, adoptions: [{ from: REV_A, to: REV_A, reason: "a" }] }, "moves the pin nowhere"],
    ["a blank reason", { ...PINNED, adoptions: [{ from: REV_A, to: REV_B, reason: " " }] }, "reason must be a trimmed non-blank string"],
    ["a self-hosted pin with a revision", { schemaVersion: 1, kind: "self-hosted", revision: REV_A }, "unknown field(s): revision"],
  ])("refuses %s", (_label, pin, problem) => {
    const result = loaded(pin);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(problem);
  });
});
