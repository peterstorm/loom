/**
 * The TaskGraph's append-only logs at the load boundary. They all go through
 * one reader (`parseOptionalLog`), which supplies the "<field> must be an
 * array when present" refusal and each entry's "<field>[i]" label, and then
 * judges any identity collision the whole log forbids. These tests pin each
 * field's wording, so the field name or label the operator sees cannot drift
 * for a log no other test touches.
 */

import { describe, expect, it } from "vitest";
import { parseTaskGraph } from "../src/state-manager";
import { derivePendingTaskProof } from "../src/core/proof-obligations";
import { preI6DefaultVerificationManifest } from "../src/core/verification-manifest";
import { legacyForwardFixAudit, legacyForwardFixGraph } from "./fixtures/sealed-wave";

/** A valid execute-phase TaskGraph with one pending Task; `overrides` replace any top-level field. */
const graph = (overrides: Record<string, unknown> = {}) => ({
  current_phase: "execute",
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: null,
  tasks: [{
    id: "T1",
    description: "implement",
    agent: "code-implementer-agent",
    wave: 1,
    status: "pending",
    depends_on: [],
    new_tests_required: false,
    file_list: ["engine/src/a.ts"],
    proof: derivePendingTaskProof({
      declaredArtifactExpectation: "changed",
      newTestsRequired: false,
      declaredArtifacts: ["engine/src/a.ts"],
    }),
  }],
  wave_gates: {},
  verification_manifest: preI6DefaultVerificationManifest(),
  ...overrides,
});

function errorOf(raw: unknown): string {
  const parsed = parseTaskGraph(raw);
  expect(parsed.ok, "expected the loader to refuse this graph").toBe(false);
  if (parsed.ok) throw new Error("unreachable");
  return parsed.error;
}

/** Every append-only log, with the refusal its first entry earns when it is no object. */
const LOGS = [
  ["orphaned_wave_gate_history", "orphaned_wave_gate_history[0]: orphaned_wave_gate_history entry must be an object"],
  ["retired_wave_review_runs", "retired_wave_review_runs[0] must be an object"],
  ["spec_trace_wave_gate_retirements", "spec_trace_wave_gate_retirements[0]: spec_trace_wave_gate_retirements entry must be an object"],
  ["spec_amendments", "spec_amendments[0] must be an object"],
  ["spec_trace_amendments", "spec_trace_amendments[0]: spec_trace_amendments entry must be an object"],
  ["task_reopening_history", "task_reopening_history[0] must be an object"],
  ["wave_plan_edits", "wave_plan_edits[0] must be an object"],
  ["retro_records", "retro_records[0] must be an object"],
  ["forward_fix_history", "forward_fix_history[0] must be an object"],
  ["forward_fix_withdrawals", "forward_fix_withdrawals[0] must be an object"],
  ["wave_gate_history", "wave_gate_history[0]: wave_gate_history entry must be an object"],
  ["wave_reopening_history", "wave_reopening_history[0] must be an object"],
] as const;

describe("the TaskGraph's append-only logs", () => {
  it("loads the fixture graph, and every log absent or empty", () => {
    expect(parseTaskGraph(graph()).ok).toBe(true);
    for (const [field] of LOGS) expect(parseTaskGraph(graph({ [field]: [] })).ok, field).toBe(true);
  });

  it.each(LOGS)("refuses %s when it is present but not an array, naming the field", (field) => {
    for (const notAnArray of ["x", 7, {}, null]) {
      expect(errorOf(graph({ [field]: notAnArray }))).toBe(`${field} must be an array when present`);
    }
  });

  it.each(LOGS)("refuses a malformed first %s entry under its indexed label", (field, refusal) => {
    expect(errorOf(graph({ [field]: [42] }))).toBe(refusal);
  });

  it("refuses a Review Run retired twice", () => {
    const retired = {
      schemaVersion: 1, kind: "retired-wave-review-run", runId: "run.first", wave: 1,
      authorityDigest: "a".repeat(64), retirement: "abandoned",
    };
    expect(parseTaskGraph(graph({ retired_wave_review_runs: [retired] })).ok).toBe(true);
    expect(errorOf(graph({ retired_wave_review_runs: [retired, retired] })))
      .toBe("retired_wave_review_runs retires run run.first twice");
  });

  it("refuses one completed Wave's reopening audited twice", () => {
    const audit = {
      schemaVersion: 1,
      kind: "completed-wave-reopened-for-review-integrity",
      proofMode: "legacy-workspace-authority-unverifiable",
      runId: "run.first",
      wave: 1,
      authorityDigest: "a".repeat(64),
      completionReceipt: {
        kind: "protected-wave-state-committed", effectId: "completed-wave-effect", runId: "run.first",
        committedRevision: 1, stateDigest: "b".repeat(64),
      },
      reopenedTaskIds: ["T1"],
    };
    expect(parseTaskGraph(graph({ wave_reopening_history: [audit] })).ok).toBe(true);
    expect(errorOf(graph({ wave_reopening_history: [audit, audit] })))
      .toBe("wave_reopening_history contains duplicate authority audits");
  });

  it("refuses one fix Task named by two forward-fix audits", () => {
    const stored = JSON.parse(JSON.stringify(legacyForwardFixGraph()));
    expect(parseTaskGraph(stored).ok).toBe(true);
    expect(errorOf({ ...stored, forward_fix_history: [legacyForwardFixAudit(), legacyForwardFixAudit()] }))
      .toBe("forward_fix_history names fix Task T5 in two audits");
  });
});
