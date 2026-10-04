import { describe, expect, it } from "vitest";
import { supersedeAbandonedWaveGateReview } from "../../src/core/wave-gate-supersede";
import type { TaskGraph } from "../../src/types";

const authority = (runId: string) => ({
  generation: 6, packet_id: "a".repeat(64), head_sha: "b".repeat(64), scope: ["src/a.ts"],
  run_id: runId, authority_digest: "c".repeat(64),
});

const graph = {
  current_phase: "execute",
  current_wave: 8,
  phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: null, wave_gates: {},
  tasks: [
    { id: "T13", wave: 8, review_status: "passed", review_generation: 6,
      findings: [{ id: "pr-test-analyzer-1", severity: "advisory", claim: "c", file: null, line: null, agent: "pr-test-analyzer" }],
      accepted_review_authority: authority("run.abandoned") },
    { id: "T14", wave: 8, review_status: "passed", accepted_review_authority: authority("run.other") },
    { id: "T1", wave: 1, review_status: "passed", accepted_review_authority: authority("run.abandoned") },
  ],
  spec_check: { wave: 8, run_at: "now", verdict: "EVIDENCE_CAPTURE_FAILED", error: "e", cause: "transcript" },
  wave_review_epoch: { runId: "run.abandoned", wave: 8 },
  active_wave_gate: { runId: "run.abandoned" },
} as unknown as TaskGraph;

describe("supersedeAbandonedWaveGateReview", () => {
  it("retires the abandoned run's epoch and spec-check and reopens only the reviews it accepted", () => {
    // Production regression: abandoning an exhausted Wave 8 gate left its
    // review epoch behind, so the successor's registration was refused as
    // "wave_review_epoch must match active_wave_gate run/Wave authority".
    const next = supersedeAbandonedWaveGateReview(graph, "run.abandoned", ["T13", "T14"]);
    expect(next.wave_review_epoch).toBeUndefined();
    expect(next.spec_check).toBeUndefined();
    expect(next.active_wave_gate).toBeUndefined();
    const [t13, t14, t1] = next.tasks;
    expect(t13).toMatchObject({ review_status: "pending", review_generation: 6 });
    expect(t13?.accepted_review_authority).toBeUndefined();
    expect(t13?.findings).toEqual(graph.tasks[0]!.findings);
    expect(t14).toMatchObject({ review_status: "passed", accepted_review_authority: { run_id: "run.other" } });
    expect(t1).toMatchObject({ review_status: "passed", accepted_review_authority: { run_id: "run.abandoned" } });
  });
});
