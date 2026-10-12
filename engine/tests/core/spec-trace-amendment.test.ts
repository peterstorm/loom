import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseSpec } from "../../src/core/parse-spec";
import { parseArtifactDigest } from "../../src/core/orchestration-contract";
import { capturedSpecCheck } from "../../src/core/spec-check";
import { amendSpecTrace, type SpecTraceAmendmentRefusal } from "../../src/core/spec-trace-amendment";
import type { SpecIndexAvailability } from "../../src/core/requirement-coverage";
import { newWaveGate } from "../../src/core/wave-gate-model";
import { parseTaskGraph } from "../../src/state-file-wire";
import type { Task, TaskGraph } from "../../src/types";
import { AMENDMENT_SPEC } from "../fixtures/amendment-spec";
import { findingId } from "../fixtures/finding-id";
import {
  activeWaveGateFixture,
  completedWaveGateFixture,
  protectedGraphFixture,
  taskFixture,
} from "../fixtures/task-lifecycle";

const parsedSpec = parseSpec(AMENDMENT_SPEC);
if (!parsedSpec.ok) throw new Error("amendment fixture specification must parse");
const index = parsedSpec.value;
const digest = parseArtifactDigest("a".repeat(64));
if (!digest.ok) throw new Error("fixture digest must parse");

const indexed: SpecIndexAvailability = Object.freeze({
  kind: "indexed", path: "spec.md", contentDigest: digest.value, index,
});
const unavailable: SpecIndexAvailability = Object.freeze({
  kind: "unavailable", reason: Object.freeze({ kind: "unreadable", path: "spec.md", reason: "ENOENT" }),
});

const hashOf = (id: string): string => {
  const entry = [...index.frs, ...index.scenarios].find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`no fixture entry ${id}`);
  return entry.contentHash;
};
/** A recorded hash the current Spec Index no longer agrees with: drift evidence that must survive. */
const DRIFTED = "f".repeat(64);

const finding = {
  id: findingId("code-reviewer-1"),
  agent: "code-reviewer",
  severity: "advisory" as const,
  file: null,
  line: null,
  claim: "settled review evidence",
};

const task = (
  id: string,
  wave: number,
  anchors: readonly string[],
  contributions: readonly string[],
  hashes: Readonly<Record<string, string>> = {},
): Task => taskFixture({
  id, description: id, agent: "code-implementer-agent", wave, depends_on: [], file_list: [`src/${id}.ts`],
  spec_anchors: [...anchors],
  spec_contributions: [...contributions],
  ...(Object.keys(hashes).length === 0 ? {} : { spec_anchor_hashes: hashes }),
  review_status: "pending",
  review_generation: 4,
  findings: [finding],
  critical_findings: [],
  advisory_findings: [finding.claim],
  refuted_findings: [],
  resolved_findings: [],
});

/** Wave 1 is completed history; Wave 2 is current and has no live gate. */
function populated(overrides: Partial<TaskGraph> = {}): TaskGraph {
  return protectedGraphFixture({
    spec_trace_version: 2,
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: "spec.md",
    plan_file: "plan.md",
    current_wave: 2,
    executing_tasks: [],
    spec_index_observation: { kind: "indexed", path: "spec.md", contentDigest: "a".repeat(64) },
    tasks: [
      task("T1", 1, ["AS-001"], [], { "AS-001": hashOf("AS-001") }),
      task("T2", 2, ["FR-001"], [], { "FR-001": DRIFTED }),
      task("T3", 2, [], []),
    ],
    wave_gates: { "1": newWaveGate(), "2": newWaveGate() },
    wave_gate_history: [completedWaveGateFixture({ runId: "run.wave-1", wave: 1 })],
    ...overrides,
  });
}

type Trace = Readonly<{ anchors: readonly string[]; contributions: readonly string[] }>;
const unchangedTraces: Readonly<Record<string, Trace>> = {
  T1: { anchors: ["AS-001"], contributions: [] },
  T2: { anchors: ["FR-001"], contributions: [] },
  T3: { anchors: [], contributions: [] },
};

const amendment = (traces: Partial<Record<string, Trace>> = {}) => ({
  spec_trace_version: 2,
  tasks: ["T1", "T2", "T3"].map((id) => {
    const trace = traces[id] ?? unchangedTraces[id]!;
    return { id, spec_anchors: [...trace.anchors], spec_contributions: [...trace.contributions] };
  }),
});

const amended = (graph: TaskGraph, raw: unknown, specIndex: SpecIndexAvailability = indexed) => {
  const result = amendSpecTrace(graph, raw, specIndex);
  if (!result.ok) throw new Error(`expected amendment, got ${result.error.kind}: ${result.error.message}`);
  if (result.value.kind !== "amended") throw new Error("expected a changed trace");
  return result.value;
};

const refusal = (graph: TaskGraph, raw: unknown, specIndex: SpecIndexAvailability = indexed): SpecTraceAmendmentRefusal => {
  const result = amendSpecTrace(graph, raw, specIndex);
  if (result.ok) throw new Error(`expected refusal, got ${result.value.kind}`);
  return result.error;
};

const taskById = (graph: TaskGraph, id: string): Task => graph.tasks.find((candidate) => candidate.id === id)!;
const reloads = (graph: TaskGraph) => parseTaskGraph(JSON.parse(JSON.stringify(graph)));

describe("amendSpecTrace", () => {
  it("replaces only the amended Tasks' trace and keeps every settled implementation and review fact", () => {
    const before = populated();
    const { graph } = amended(before, amendment({ T3: { anchors: ["FR-002"], contributions: [] } }));

    expect(taskById(graph, "T3").spec_anchors).toEqual(["FR-002"]);
    expect(taskById(graph, "T1")).toBe(taskById(before, "T1"));
    expect(taskById(graph, "T2")).toBe(taskById(before, "T2"));
    const { spec_anchors: _a, spec_anchor_hashes: _h, ...settled } = taskById(graph, "T3");
    const { spec_anchors: _b, spec_anchor_hashes: _i, ...original } = taskById(before, "T3");
    expect(settled).toEqual(original);
    expect(graph.wave_gate_history).toBe(before.wave_gate_history);
    expect(reloads(graph).ok).toBe(true);
  });

  it("keeps a retained claim's recorded hash, mints an added claim's, and drops a removed claim's", () => {
    const moved = amended(populated(), amendment({
      T2: { anchors: ["FR-002"], contributions: [] },
      T3: { anchors: ["FR-001"], contributions: [] },
    })).graph;
    expect(taskById(moved, "T2").spec_anchor_hashes).toEqual({ "FR-002": hashOf("FR-002") });
    expect(taskById(moved, "T3").spec_anchor_hashes).toEqual({ "FR-001": hashOf("FR-001") });

    const widened = amended(populated(), amendment({ T2: { anchors: ["FR-001", "FR-002"], contributions: [] } })).graph;
    expect(taskById(widened, "T2").spec_anchor_hashes).toEqual({ "FR-001": DRIFTED, "FR-002": hashOf("FR-002") });

    const narrowed = amended(populated(), amendment({ T2: { anchors: [], contributions: [] } })).graph;
    expect(taskById(narrowed, "T2").spec_anchor_hashes).toBeUndefined();
  });

  it("is a no-op for an exact replay and for a pure reordering", () => {
    const graph = populated({ tasks: [
      task("T1", 1, ["AS-001"], [], { "AS-001": hashOf("AS-001") }),
      task("T2", 2, ["FR-001", "FR-002"], []),
      task("T3", 2, [], []),
    ] });
    for (const anchors of [["FR-001", "FR-002"], ["FR-002", "FR-001"]]) {
      const result = amendSpecTrace(graph, amendment({ T2: { anchors, contributions: [] } }), indexed);
      expect(result).toEqual({ ok: true, value: { kind: "unchanged", graph } });
      if (result.ok) expect(result.value.graph).toBe(graph);
    }
  });

  it("appends an audit entry naming the Wave, each change, and the amend-time Spec Index observation", () => {
    const { graph, amendment: audit } = amended(populated(), amendment({ T3: { anchors: ["FR-002"], contributions: [] } }));
    expect(audit).toEqual({
      schemaVersion: 1,
      kind: "spec-trace-amendment",
      wave: 2,
      retiredRunId: null,
      changes: [{
        taskId: "T3",
        before: { spec_anchors: [], spec_contributions: [] },
        after: { spec_anchors: ["FR-002"], spec_contributions: [] },
      }],
      specIndexObservation: { kind: "indexed", path: "spec.md", contentDigest: "a".repeat(64) },
    });
    expect(graph.spec_trace_amendments).toEqual([audit]);

    const second = amended(graph, amendment({ T3: { anchors: ["FR-002"], contributions: [] }, T2: { anchors: [], contributions: [] } }));
    expect(second.graph.spec_trace_amendments).toEqual([audit, second.amendment]);
    expect(reloads(second.graph).ok).toBe(true);
  });

  it("retires an abandoned tombstone's review authority and keeps status, proof and Findings", () => {
    const runId = "run.abandoned";
    const before = populated({
      active_wave_gate: activeWaveGateFixture({
        runId, wave: 2, authorityDigest: "d".repeat(64), revision: 3,
        terminalOutcome: { kind: "terminal-abandoned", reason: "trace was wrong", supersededBy: null },
      }),
      wave_review_epoch: { runId: runId as never, wave: 2, batchEpoch: "e".repeat(64) as never },
      spec_check: capturedSpecCheck({ wave: 2, runAt: "2026-10-12T00:00:00.000Z", criticalFindings: [] }),
    });
    const { graph, amendment: audit } = amended(before, amendment({ T3: { anchors: ["FR-002"], contributions: [] } }));

    expect(audit.retiredRunId).toBe(runId);
    expect(graph.active_wave_gate).toBeUndefined();
    expect(graph.wave_review_epoch).toBeUndefined();
    expect(graph.spec_check).toBeUndefined();
    for (const id of ["T2", "T3"]) {
      const after = taskById(graph, id);
      const original = taskById(before, id);
      expect(after.status).toBe(original.status);
      expect(after.proof).toEqual(original.proof);
      expect(after.findings).toEqual(original.findings);
      expect(after.review_generation).toBe(original.review_generation);
    }
    expect(reloads(graph).ok).toBe(true);
  });

  it("without a tombstone retires only current-Wave review residue", () => {
    const amendT3 = amendment({ T3: { anchors: ["FR-002"], contributions: [] } });
    const currentCheck = capturedSpecCheck({ wave: 2, runAt: "2026-10-12T00:00:00.000Z", criticalFindings: [] });
    expect(amended(populated({ spec_check: currentCheck }), amendT3).graph.spec_check).toBeUndefined();

    const olderCheck = capturedSpecCheck({ wave: 1, runAt: "2026-10-11T00:00:00.000Z", criticalFindings: [] });
    const kept = amended(populated({ spec_check: olderCheck }), amendT3).graph;
    expect(kept.spec_check).toEqual(olderCheck);
    expect(reloads(kept).ok).toBe(true);
  });

  it("retires review acceptance granted by the abandoned run", () => {
    const runId = "run.abandoned";
    const accepted = {
      ...task("T2", 2, ["FR-001"], []),
      review_status: "passed" as const,
      accepted_review_authority: {
        generation: 4, packet_id: "a".repeat(64), head_sha: "b".repeat(40), scope: ["src/T2.ts"],
        run_id: runId, authority_digest: "d".repeat(64),
      },
    } as Task;
    const base = populated();
    const graph = {
      ...base,
      tasks: [taskById(base, "T1"), accepted, taskById(base, "T3")],
      active_wave_gate: activeWaveGateFixture({
        runId, wave: 2, authorityDigest: "d".repeat(64),
        terminalOutcome: { kind: "terminal-abandoned", reason: "trace was wrong", supersededBy: null },
      }),
    };
    const after = taskById(amended(graph, amendment({ T3: { anchors: ["FR-002"], contributions: [] } })).graph, "T2");
    expect(after.review_status).toBe("pending");
    expect(after.accepted_review_authority).toBeUndefined();
  });

  it.each<[string, (graph: TaskGraph) => TaskGraph, SpecTraceAmendmentRefusal["kind"]]>([
    ["a legacy graph", ({ spec_trace_version: _v, ...legacy }) => legacy, "legacy-graph"],
    ["a graph outside execute", (graph) => ({ ...graph, current_phase: "decompose" }), "not-executing"],
    ["an implementation reservation", (graph) => ({ ...graph, executing_tasks: ["T3"] }), "implementation-active"],
    ["a live Wave Gate", (graph) => ({
      ...graph,
      active_wave_gate: activeWaveGateFixture({ runId: "run.live", wave: 2, authorityDigest: "d".repeat(64) }),
    }), "live-wave-gate"],
    ["a done tombstone", (graph) => ({
      ...graph,
      active_wave_gate: activeWaveGateFixture({
        runId: "run.done", wave: 2, authorityDigest: "d".repeat(64),
        terminalOutcome: {
          kind: "done",
          outcome: {
            runId: "run.done",
            slot: { kind: "fixed-artifact-slot", path: "result.json" },
            digest: "a".repeat(64),
            byteLength: 11,
          },
        },
      }),
    }), "live-wave-gate"],
    ["a Spec Index naming another spec_file", (graph) => ({ ...graph, spec_file: "other.md" }), "spec-authority-changed"],
  ])("refuses %s without producing a graph", (_label, mutate, kind) => {
    expect(refusal(mutate(populated()), amendment({ T3: { anchors: ["FR-002"], contributions: [] } })).kind).toBe(kind);
  });

  it.each<[string, unknown, SpecTraceAmendmentRefusal["kind"], string]>([
    ["a malformed input", { tasks: [] }, "invalid-input", "exactly spec_trace_version and tasks"],
    ["a partial roster", { spec_trace_version: 2, tasks: amendment().tasks.slice(1) }, "invalid-input", "missing existing Tasks: T1"],
    // Arrays compare as sets, so without this a repeated id would read as an unchanged replay.
    ["a repeated id in an otherwise unchanged trace", amendment({ T2: { anchors: ["FR-001", "FR-001"], contributions: [] } }),
      "invalid-input", "Task T2 spec_anchors repeats FR-001"],
    ["a repeated Contribution", amendment({ T3: { anchors: [], contributions: ["FR-001", "FR-001"] } }),
      "invalid-input", "Task T3 spec_contributions repeats FR-001"],
    ["a completed Wave's Task", amendment({ T1: { anchors: ["AS-001", "FR-002"], contributions: [] } }), "completed-wave-changed", "T1"],
    ["a claim moved out of a completed Wave", amendment({
      T1: { anchors: [], contributions: [] },
      T3: { anchors: ["AS-001"], contributions: [] },
    }), "completed-wave-changed", "Wave 1"],
    ["an id the Spec Index does not define", amendment({ T3: { anchors: ["FR-999"], contributions: [] } }), "unknown-requirement", "FR-999"],
    ["an excluded Requirement", amendment({ T3: { anchors: ["OOS-001"], contributions: [] } }), "unknown-requirement", "OOS-001"],
    ["a v2 ownership violation", amendment({ T2: { anchors: ["FR-001"], contributions: ["FR-002"] } }), "invalid-trace", "FR-002"],
  ])("refuses %s", (_label, raw, kind, message) => {
    const error = refusal(populated(), raw);
    expect(error.kind).toBe(kind);
    expect(error.message).toContain(message);
  });

  it("fails closed on an added claim or Contribution when the Spec Index is unavailable, but still applies removals", () => {
    const graph = populated({ spec_index_observation: undefined });
    expect(refusal(graph, amendment({ T3: { anchors: ["FR-002"], contributions: [] } }), unavailable).kind)
      .toBe("spec-index-unavailable");
    expect(refusal(graph, amendment({ T3: { anchors: [], contributions: ["FR-001"] } }), unavailable).kind)
      .toBe("spec-index-unavailable");

    const removed = amended(graph, amendment({ T2: { anchors: [], contributions: [] } }), unavailable);
    expect(taskById(removed.graph, "T2").spec_anchors).toEqual([]);
    expect(removed.amendment.specIndexObservation).toEqual({
      kind: "unavailable", reason: { kind: "unreadable", path: "spec.md", reason: "ENOENT" },
    });
    expect(reloads(removed.graph).ok).toBe(true);
  });

  it("lets an exact replay through even after a successor gate went live", () => {
    const first = amended(populated(), amendment({ T3: { anchors: ["FR-002"], contributions: [] } })).graph;
    const live = {
      ...first,
      active_wave_gate: activeWaveGateFixture({ runId: "run.successor", wave: 2, authorityDigest: "d".repeat(64) }),
    };
    const replay = amendSpecTrace(live, amendment({ T3: { anchors: ["FR-002"], contributions: [] } }), indexed);
    expect(replay.ok && replay.value.kind).toBe("unchanged");
  });

  it("any accepted current-Wave amendment loads, and every amended Task's hash keys are its claims", () => {
    const ids = ["FR-001", "FR-002"];
    const traceArbitrary = fc.record({
      anchors: fc.subarray(ids),
      contributions: fc.subarray(ids),
    });
    fc.assert(fc.property(traceArbitrary, traceArbitrary, (t2, t3) => {
      const result = amendSpecTrace(populated(), amendment({ T2: t2, T3: t3 }), indexed);
      if (!result.ok || result.value.kind === "unchanged") return;
      expect(reloads(result.value.graph).ok).toBe(true);
      for (const { taskId } of result.value.amendment.changes) {
        const amendedTask = taskById(result.value.graph, taskId);
        expect(Object.keys(amendedTask.spec_anchor_hashes ?? {}).sort())
          .toEqual([...(amendedTask.spec_anchors ?? [])].sort());
      }
    }));
  });
});

describe("spec_trace_amendments load boundary", () => {
  const committed = () => amended(populated(), amendment({ T3: { anchors: ["FR-002"], contributions: [] } })).graph;
  const raw = (graph: TaskGraph) => JSON.parse(JSON.stringify(graph)) as Record<string, unknown> & {
    tasks: Record<string, unknown>[];
    spec_trace_amendments: Record<string, unknown>[];
  };

  it("refuses a trace that contradicts its latest amendment", () => {
    const tampered = raw(committed());
    tampered.tasks[2]!.spec_anchors = [];
    delete tampered.tasks[2]!.spec_anchor_hashes;
    const parsed = parseTaskGraph(tampered);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("T3");
  });

  it.each<[string, (graph: ReturnType<typeof raw>) => void]>([
    ["on a legacy graph", (graph) => { delete graph.spec_trace_version; }],
    ["with an unknown field", (graph) => { graph.spec_trace_amendments[0]!.extra = true; }],
    ["with no changes", (graph) => { graph.spec_trace_amendments[0]!.changes = []; }],
    ["naming a Task outside the roster", (graph) => {
      (graph.spec_trace_amendments[0]!.changes as Record<string, unknown>[])[0]!.taskId = "T9";
    }],
  ])("refuses an amendment audit %s", (_label, mutate) => {
    const tampered = raw(committed());
    mutate(tampered);
    expect(parseTaskGraph(tampered).ok).toBe(false);
  });
});
