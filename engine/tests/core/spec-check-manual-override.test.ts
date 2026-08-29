/**
 * One predicate decides whether spec-check evidence may be written, and by whom.
 *
 * Before this module decided it, the Wave Gate façade, the Claude SubagentStop
 * hook, the Pi shell, and the manual `store-spec-check` helper each had their own
 * conjunct set for the same invariant — the shape that let a stdin-only helper
 * call flip a Wave's spec gate from `EVIDENCE_CAPTURE_FAILED` to `PASSED`, clear
 * the derived Wave block, and suppress the epoch's real spec-check spawn.
 */

import { describe, it, expect } from "vitest";
import { parseOrchestrationRunId, parseSlotId } from "../../src/core/orchestration-contract";
import {
  decideSpecCheckManualOverride,
  specCheckAuthorityProblem,
  type SpecCheckRequestAuthority,
} from "../../src/core/spec-check";
import type { TaskGraph } from "../../src/types";

const base = {
  current_phase: "execute",
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: null,
  tasks: [],
  wave_gates: {},
  current_wave: 1,
} as const;

/** Test double: only the fields the predicate reads are meaningful here. */
const graph = (extra: Record<string, unknown>): TaskGraph => ({ ...base, ...extra }) as TaskGraph;

const runId = (() => {
  const parsed = parseOrchestrationRunId("run.1");
  if (!parsed.ok) throw new Error(`fixture run id rejected: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
})();

const slotId = (() => {
  const parsed = parseSlotId("slot.1");
  if (!parsed.ok) throw new Error(`fixture slot id rejected: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
})();

const authority: SpecCheckRequestAuthority = {
  runId,
  slotId,
  attempt: 1,
  role: "spec-check-invoker",
};

const modernGraph = graph({ spec_trace_version: 2 });
const legacyGraph = graph({});

const activeWave = graph({
  active_wave_gate: { runId, wave: 1, authorityDigest: "digest-one" },
  wave_review_epoch: {
    runId,
    wave: 1,
    batchEpoch: "epoch-one",
    specCheckSlotAuthority: { slot_id: slotId, attempted: 1 },
  },
});

describe("specCheckAuthorityProblem", () => {
  it("allows legacy evidence with no Wave authority at all", () => {
    expect(specCheckAuthorityProblem(legacyGraph, undefined)).toBeNull();
  });

  it("refuses modern evidence that carries no capture-correlated request authority", () => {
    expect(specCheckAuthorityProblem(modernGraph, undefined)).toContain(
      "no current capture-correlated request authority",
    );
  });

  it("refuses a captured request that matches no current Wave authority", () => {
    expect(specCheckAuthorityProblem(modernGraph, authority)).toContain("has no current Wave authority");
  });

  it("accepts the exact current epoch slot and attempt", () => {
    expect(specCheckAuthorityProblem(activeWave, authority)).toBeNull();
  });

  it("refuses a retired attempt of the same slot", () => {
    expect(specCheckAuthorityProblem(activeWave, { ...authority, attempt: 2 }))
      .toContain("does not match the exact current Wave epoch");
  });

  it("refuses a request belonging to another role", () => {
    expect(specCheckAuthorityProblem(activeWave, { ...authority, role: "code-reviewer" }))
      .toContain("belongs to code-reviewer");
  });
});

describe("decideSpecCheckManualOverride", () => {
  it("leaves the documented legacy manual route available", () => {
    expect(decideSpecCheckManualOverride(legacyGraph, null)).toEqual({ kind: "allowed", reason: null });
  });

  it("refuses every manual write while a registered Wave Gate owns the Wave", () => {
    const decision = decideSpecCheckManualOverride(activeWave, "operator says so");
    expect(decision.kind).toBe("refused-active");
    // Even the exact captured authority does not make the manual route legal:
    // it carries no capture correlation of its own.
    expect(decideSpecCheckManualOverride(activeWave, null).kind).toBe("refused-active");
  });

  it("requires a reason before overriding on a modern graph with no active run", () => {
    expect(decideSpecCheckManualOverride(modernGraph, null).kind).toBe("requires-reason");
  });

  it("accepts a modern override only when it names its reason", () => {
    expect(decideSpecCheckManualOverride(modernGraph, "FRs 12-14 land in wave 3")).toEqual({
      kind: "allowed",
      reason: "FRs 12-14 land in wave 3",
    });
  });
});
