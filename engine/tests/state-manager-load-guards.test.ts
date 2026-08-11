/**
 * Load-boundary guards in `state-manager.ts` whose REJECTING branch nothing hit.
 *
 * Every one of these parses a value that arrives from `active_task_graph.json`
 * on disk — a file an operator can edit and a crashed writer can leave
 * inconsistent — so "the fixtures were always self-consistent" is precisely the
 * gap: deleting any of these cross-field checks left the suite green while the
 * loader started accepting a graph it is supposed to refuse.
 */

import { describe, expect, it } from "vitest";
import { parseTaskGraph } from "../src/state-manager";

const PACKET = "a".repeat(64);
const HEAD = "b".repeat(40);
const DIGEST = (fill: string) => fill.repeat(64);

const validTask = {
  id: "T1",
  description: "impl",
  agent: "code-implementer-agent",
  wave: 1,
  status: "pending",
  depends_on: [],
} as const;

const graph = (overrides: Record<string, unknown> = {}) => ({
  current_phase: "execute",
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: null,
  tasks: [validTask],
  wave_gates: {},
  ...overrides,
});

const errorOf = (raw: Record<string, unknown>): string => {
  const parsed = parseTaskGraph(raw);
  expect(parsed.ok, `expected the loader to refuse this graph`).toBe(false);
  if (parsed.ok) throw new Error("unreachable");
  return parsed.error;
};

// ---------------------------------------------------------------------------
// wave_gate_history
// ---------------------------------------------------------------------------

const completedEntry = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind: "completed-wave-gate",
  runId: "completed-wave-run",
  wave: 1,
  authorityDigest: DIGEST("f"),
  revision: 3,
  completionReceipt: {
    kind: "protected-wave-state-committed",
    effectId: "completed-wave-effect",
    runId: "completed-wave-run",
    committedRevision: 3,
    stateDigest: DIGEST("e"),
  },
  ...overrides,
});

describe("parseCompletedWaveGateRegistration cross-field checks", () => {
  it("accepts the self-consistent entry these cases are varied from", () => {
    expect(parseTaskGraph(graph({ wave_gate_history: [completedEntry()] })).ok).toBe(true);
  });

  it("refuses a completion receipt minted under a different run", () => {
    const entry = completedEntry();
    const foreign = { ...entry, completionReceipt: { ...entry.completionReceipt, runId: "some-other-run" } };
    expect(errorOf(graph({ wave_gate_history: [foreign] }))).toContain("belongs to a different run");
  });

  it("refuses a completion receipt whose committedRevision is not the terminal revision", () => {
    const entry = completedEntry();
    const drifted = { ...entry, completionReceipt: { ...entry.completionReceipt, committedRevision: 2 } };
    expect(errorOf(graph({ wave_gate_history: [drifted] })))
      .toContain("completion receipt revision must equal terminal revision");
  });
});

describe("parseWaveGateHistory duplicate and collision checks", () => {
  it("refuses a history that repeats one run identity", () => {
    const duplicate = [completedEntry({ wave: 1 }), completedEntry({ wave: 2 })];
    expect(errorOf(graph({ wave_gate_history: duplicate }))).toContain("duplicate run identities");
  });

  it("refuses a history that completes the same Wave twice", () => {
    const secondRun = completedEntry({
      runId: "second-wave-run",
      completionReceipt: { ...completedEntry().completionReceipt, runId: "second-wave-run" },
    });
    expect(errorOf(graph({ wave_gate_history: [completedEntry(), secondRun] })))
      .toContain("duplicate completed Waves");
  });

  it("accepts two genuinely distinct completed Waves", () => {
    const secondRun = completedEntry({
      runId: "second-wave-run",
      wave: 2,
      completionReceipt: { ...completedEntry().completionReceipt, runId: "second-wave-run" },
    });
    expect(parseTaskGraph(graph({ wave_gate_history: [completedEntry(), secondRun] })).ok).toBe(true);
  });

  it("refuses a history array that is not an array", () => {
    expect(errorOf(graph({ wave_gate_history: {} }))).toContain("must be an array");
  });
});

// ---------------------------------------------------------------------------
// task review_run / review_status consistency
// ---------------------------------------------------------------------------

const reviewedTask = (overrides: Record<string, unknown> = {}) => ({
  ...validTask,
  review_status: "pending",
  review_generation: 1,
  findings: [],
  critical_findings: [],
  advisory_findings: [],
  review_run: {
    generation: 1,
    packet_id: PACKET,
    head_sha: HEAD,
    expected_agents: ["code-reviewer", "silent-failure-hunter"],
    prior_finding_ids: [],
    evidence: [],
  },
  ...overrides,
});

describe("taskStatusError review_run consistency", () => {
  it("accepts the consistent task these cases are varied from", () => {
    expect(parseTaskGraph(graph({ tasks: [reviewedTask()] })).ok).toBe(true);
  });

  it("refuses a review_run on a task with no review_generation", () => {
    const task = reviewedTask();
    const { review_generation: _dropped, ...withoutGeneration } = task;
    expect(errorOf(graph({ tasks: [{ ...withoutGeneration, review_run: { ...task.review_run, generation: 0 } }] })))
      .toContain("review_run requires review_generation");
  });

  // Only statuses that ARE in REVIEW_STATUSES reach the review_run rule; an
  // unknown status is refused earlier by the enum check.
  it.each(["passed", "blocked"])(
    "refuses an in-progress review_run alongside review_status %s",
    (review_status) => {
      expect(errorOf(graph({ tasks: [reviewedTask({ review_status })] })))
        .toContain("requires pending or evidence_capture_failed status");
    },
  );

  it("allows an in-progress review_run alongside evidence_capture_failed", () => {
    expect(parseTaskGraph(graph({
      tasks: [reviewedTask({
        review_status: "evidence_capture_failed",
        review_evidence_failures: ["code-reviewer"],
      })],
    })).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// task review_run.slot_authority
// ---------------------------------------------------------------------------

const withSlots = (slot_authority: unknown) => graph({
  tasks: [reviewedTask({
    review_run: { ...reviewedTask().review_run, slot_authority },
  })],
});

const slots = () => [
  { agent: "code-reviewer", slot_id: "slot-1", attempted: 1 },
  { agent: "silent-failure-hunter", slot_id: "slot-2", attempted: 1 },
];

describe("taskFindingsError slot_authority validation", () => {
  it("accepts the well-formed slot authority these cases are varied from", () => {
    expect(parseTaskGraph(withSlots(slots())).ok).toBe(true);
  });

  it("refuses an empty slot_authority", () => {
    expect(errorOf(withSlots([]))).toContain("must be a non-empty array when present");
  });

  it("refuses a slot_authority that is not an array", () => {
    expect(errorOf(withSlots({}))).toContain("must be a non-empty array when present");
  });

  it("refuses a slot_authority that does not cover every expected agent", () => {
    expect(errorOf(withSlots(slots().slice(0, 1))))
      .toContain("must cover every expected agent exactly once in order");
  });

  it("refuses slots whose agents are out of expected_agents order", () => {
    expect(errorOf(withSlots([...slots()].reverse())))
      .toContain("agent must match expected_agents in order");
  });

  it("refuses a slot carrying an unexpected field", () => {
    const [first, second] = slots();
    expect(errorOf(withSlots([{ ...first, extra: true }, second])))
      .toContain("must contain exactly agent/slot_id/attempted");
  });

  it("refuses a slot missing a required field", () => {
    const [first, second] = slots();
    const { attempted: _dropped, ...withoutAttempted } = first!;
    expect(errorOf(withSlots([withoutAttempted, second])))
      .toContain("must contain exactly agent/slot_id/attempted");
  });

  it("refuses two slots that reuse one slot id", () => {
    const [first, second] = slots();
    expect(errorOf(withSlots([first, { ...second!, slot_id: first!.slot_id }])))
      .toContain("duplicates an earlier Review Run slot");
  });

  it.each([0, 3, "1", null])("refuses an attempted value of %s", (attempted) => {
    const [first, second] = slots();
    expect(errorOf(withSlots([{ ...first!, attempted }, second]))).toContain("attempted must be 1 or 2");
  });

  it("accepts a second attempt on a slot", () => {
    const [first, second] = slots();
    expect(parseTaskGraph(withSlots([{ ...first!, attempted: 2 }, second])).ok).toBe(true);
  });
});
