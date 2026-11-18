/**
 * Spec Amendment (ADR-0087): an operator-authored change to the
 * specification's text while the TaskGraph is live. It records the
 * Requirement diff, re-anchors open claims to the new text, owes completed
 * claims a re-judgement that the next Wave Gate's spec-check makes and its
 * completion discharges, and retires the Wave's review authority.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseSpec } from "../../src/core/parse-spec";
import {
  projectRequirementCoverage,
  recordedAnchorHashes,
  type SpecIndexAvailability,
} from "../../src/core/requirement-coverage";
import { amendSpec, specAmendmentDiff, type SpecAmendmentOutcome } from "../../src/core/spec-amendment";
import { rejudgeClaimsOf } from "../../src/core/spec-rejudgement";
import { reanchorVerifiedClaims } from "../../src/core/verified-claim-hashes";
import { coverageTasks } from "../../src/core/wave-review-authority";
import { newWaveGate } from "../../src/core/wave-gate-model";
import { projectSpecBytes } from "../../src/orchestration/spec-index-observation";
import { parseTaskGraph } from "../../src/state-file-wire";
import type { Task, TaskGraph, WaveSpecCheckDocumentsAuthority } from "../../src/types";
import { specDefining } from "../fixtures/spec-index-fixture";
import {
  activeWaveGateFixture,
  completedWaveGateFixture,
  protectedGraphFixture,
  satisfiedProof,
  taskFixture,
} from "../fixtures/task-lifecycle";

const SPEC = "spec.md";
/** The spec before: FR-001, FR-002, AS-001. */
const BEFORE = specDefining(["FR-001", "FR-002"], ["AS-001"]);
/** The spec after: FR-001 and AS-001 rewritten, FR-002 withdrawn, FR-003 added. */
const AFTER = BEFORE
  .replace("FR-001: System MUST satisfy FR-001", "FR-001: System MUST satisfy FR-001 within 10 MB per request")
  .replace("- FR-002: System MUST satisfy FR-002\n", "- FR-003: System MUST page responses at 250 entries\n")
  .replace("Then AS-001 holds", "Then AS-001 holds for every page");

const observed = (source: string): SpecIndexAvailability => projectSpecBytes(SPEC, Buffer.from(source));
const indexOf = (source: string) => {
  const parsed = parseSpec(source);
  if (!parsed.ok) throw new Error("fixture spec must parse");
  return parsed.value;
};
const before = indexOf(BEFORE);
const after = indexOf(AFTER);

const task = (id: string, wave: number, anchors: readonly string[], extra: Partial<Task> = {}): Task => taskFixture({
  id, description: id, agent: "code-implementer-agent", wave, depends_on: [], file_list: [`src/${id}.ts`],
  spec_anchors: [...anchors], spec_contributions: [],
  spec_anchor_hashes: recordedAnchorHashes(before, anchors),
  review_status: "pending",
  ...extra,
});
const completed = (id: string, anchors: readonly string[]): Task =>
  task(id, 1, anchors, { status: "completed", proof: satisfiedProof([`src/${id}.ts`]), review_status: "passed", files_modified: [`src/${id}.ts`] } as Partial<Task>);

/** Wave 1 completed (T1 claims FR-001, T3 claims FR-002); Wave 2 current with T2 claiming AS-001. */
function populated(overrides: Partial<TaskGraph> = {}): TaskGraph {
  return protectedGraphFixture({
    spec_trace_version: 2,
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: SPEC,
    plan_file: "plan.md",
    current_wave: 2,
    executing_tasks: [],
    tasks: [completed("T1", ["FR-001"]), completed("T3", ["FR-002"]), task("T2", 2, ["AS-001"])],
    wave_gates: { "1": { ...newWaveGate(), impl_complete: true, tests_passed: true, reviews_complete: true }, "2": newWaveGate() },
    wave_gate_history: [completedWaveGateFixture({ runId: "run.wave-1", wave: 1 })],
    ...overrides,
  });
}

const REASON = "Paging adds FR-003; NFR budget per request tightened";
const decided = (graph: TaskGraph, current = observed(BEFORE), proposed = observed(AFTER)): SpecAmendmentOutcome => {
  const result = amendSpec(graph, current, proposed, REASON);
  if (!result.ok) throw new Error(`expected an amendment, got ${result.error.kind}: ${result.error.message}`);
  return result.value;
};
const amended = (graph = populated()) => {
  const outcome = decided(graph);
  if (outcome.kind !== "amended") throw new Error(`expected amended, got ${outcome.kind}`);
  return outcome;
};
const byId = (graph: TaskGraph, id: string): Task => {
  const found = graph.tasks.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no Task ${id}`);
  return found;
};

describe("specAmendmentDiff", () => {
  it("classifies rewritten, added and withdrawn ids in Spec Index order", () => {
    expect(specAmendmentDiff(before, after)).toEqual({ rewritten: ["FR-001", "AS-001"], added: ["FR-003"], withdrawn: ["FR-002"] });
    expect(specAmendmentDiff(before, before)).toEqual({ rewritten: [], added: [], withdrawn: [] });
  });
});

describe("amendSpec", () => {
  it("records the diff and both observations, re-anchors open claims, and owes completed claims a re-judgement", () => {
    const graph = populated();
    const { graph: next, amendment } = amended(graph);
    expect(amendment).toMatchObject({
      schemaVersion: 1, kind: "spec-amended", wave: 2, reason: REASON,
      rewritten: ["FR-001", "AS-001"], added: ["FR-003"], withdrawn: ["FR-002"],
      rejudge: [{ taskId: "T1", claim: "FR-001" }, { taskId: "T3", claim: "FR-002" }],
      retiredRunId: null,
    });
    expect(amendment.before).toMatchObject({ kind: "indexed", path: SPEC });
    expect(amendment.after).toMatchObject({ kind: "indexed", path: SPEC });
    expect(amendment.before).not.toEqual(amendment.after);
    expect(byId(next, "T2").spec_anchor_hashes).toEqual(recordedAnchorHashes(after, ["AS-001"]));
    expect(byId(next, "T1")).toEqual(byId(graph, "T1"));
    expect(next.spec_amendments).toEqual([amendment]);
  });

  it("writes a graph the State File loader accepts, audit included", () => {
    const { graph: next } = amended();
    const loaded = parseTaskGraph(JSON.parse(JSON.stringify(next)));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.spec_amendments).toEqual(next.spec_amendments);
  });

  it("answers unchanged when the spec already holds the proposed bytes, and bytes-pending for a committed amendment", () => {
    expect(decided(populated(), observed(AFTER), observed(AFTER))).toEqual({ kind: "unchanged" });
    const { graph: next, amendment } = amended();
    expect(decided(next)).toEqual({ kind: "bytes-pending", amendment });
  });

  it("withdraws an id moved to Out of Scope, refusing it while an open Task claims it", () => {
    const outOfScope = BEFORE.replace("- FR-002: System MUST satisfy FR-002\n", "").replace("- OOS-001: Anything else", "- OOS-001: Anything else\n- FR-002: System MUST satisfy FR-002");
    const moved = indexOf(outOfScope.replace("- FR-002: System MUST satisfy FR-002", "- OOS-002: FR-002 is no longer in scope"));
    expect(specAmendmentDiff(before, moved).withdrawn).toEqual(["FR-002"]);
  });

  it("refuses to withdraw an id an open Task only contributes to", () => {
    const contributor = { ...task("T4", 2, []), spec_contributions: ["FR-002"] } as Task;
    // T4 contributes to FR-002 in Wave 2; T5 completes it in Wave 3. The refusal names the first open Task tied to it.
    const graph = populated({ tasks: [completed("T1", ["FR-001"]), task("T2", 2, ["AS-001"]), contributor, task("T5", 3, ["FR-002"])] });
    expect(amendSpec(graph, observed(BEFORE), observed(AFTER), REASON))
      .toMatchObject({ ok: false, error: { kind: "withdrawn-still-claimed", message: expect.stringContaining("T4") } });
  });

  it("refuses to amend a spec that changed outside amend-spec since the last amendment", () => {
    const { graph: next } = amended();
    const edited = AFTER.replace("within 10 MB per request", "within 12 MB per request");
    const result = amendSpec(next, observed(edited), observed(BEFORE), REASON);
    expect(result.ok ? result.value.kind : result.error.kind).toBe("spec-changed-outside-amendments");
    expect(decided(next, observed(AFTER), observed(edited)).kind).toBe("amended");
  });

  it("refuses to withdraw an id a Task that has not completed still claims, naming it", () => {
    const graph = populated({ tasks: [completed("T1", ["FR-001"]), task("T3", 2, ["FR-002"]), task("T2", 2, ["AS-001"])] });
    const result = amendSpec(graph, observed(BEFORE), observed(AFTER), REASON);
    expect(result).toMatchObject({ ok: false, error: { kind: "withdrawn-still-claimed", message: expect.stringContaining("T3") } });
  });

  it.each<[string, () => TaskGraph, string]>([
    ["a graph outside the execute Phase", () => populated({ current_phase: "decompose" }), "not-executing"],
    ["an active implementation reservation", () => populated({ executing_tasks: ["T2"] }), "implementation-active"],
    ["a live Wave Gate", () => populated({ active_wave_gate: activeWaveGateFixture({ runId: "run.wave-2", wave: 2, authorityDigest: "a".repeat(64) }) }), "live-wave-gate"],
    ["a legacy trace graph", () => { const { spec_trace_version: _v2, ...legacy } = populated(); return legacy as TaskGraph; }, "legacy-graph"],
    ["another spec_file", () => populated({ spec_file: "other.md" }), "spec-authority-changed"],
  ])("refuses %s", (_label, graph, kind) => {
    const result = amendSpec(graph(), observed(BEFORE), observed(AFTER), REASON);
    expect(result.ok ? result.value.kind : result.error.kind).toBe(kind);
  });

  it("refuses a proposed spec that does not parse, and a blank reason", () => {
    const broken = amendSpec(populated(), observed(BEFORE), observed("# not a spec\n"), REASON);
    expect(broken.ok ? broken.value.kind : broken.error.kind).toBe("spec-index-unavailable");
    const blank = amendSpec(populated(), observed(BEFORE), observed(AFTER), "  ");
    expect(blank.ok ? blank.value.kind : blank.error.kind).toBe("invalid-reason");
  });

  it("retires an abandoned run's review authority and records it", () => {
    const abandoned = populated({
      active_wave_gate: activeWaveGateFixture({
        runId: "run.wave-2", wave: 2, authorityDigest: "a".repeat(64),
        terminalOutcome: { kind: "terminal-abandoned", reason: "spec changes", supersededBy: null },
      }),
    });
    const { amendment } = amended(abandoned);
    expect(amendment.retiredRunId).toBe("run.wave-2");
  });
});

describe("re-judgement at the next Wave Gate", () => {
  it("lists each completed claim the amendments changed once, and nothing for a Task that is not completed", () => {
    const { graph: next, amendment } = amended();
    const twice = { ...next, spec_amendments: [amendment, amendment] };
    expect(rejudgeClaimsOf(twice, byId(twice, "T1"))).toEqual(["FR-001"]);
    expect(rejudgeClaimsOf(twice, byId(twice, "T3"))).toEqual(["FR-002"]);
    expect(rejudgeClaimsOf(twice, { ...byId(twice, "T1"), status: "pending" } as Task)).toEqual([]);
  });

  it("puts the owed claim among the current Wave's rows and leaves the withdrawn one as completed drift", () => {
    const { graph: next } = amended();
    const coverage = projectRequirementCoverage(observed(AFTER), coverageTasks(next, 2));
    if (coverage.kind !== "projected") throw new Error("expected a projection");
    expect(coverage.rows.map(({ taskId, claim }) => `${taskId}:${claim}`)).toEqual(["T1:FR-001", "T2:AS-001"]);
    expect(coverage.rows[0]?.verdict).toMatchObject({ kind: "candidate-pass", drift: { kind: "drifted" } });
    expect(coverage.completedDrift.map(({ taskId, claim, change }) => `${taskId}:${claim}:${change.kind}`)).toEqual(["T3:FR-002:withdrawn"]);
  });

  it("is discharged by the Wave's completion, which re-anchors the re-judged claim", () => {
    const { graph: next } = amended();
    const reviewedIndex = observed(AFTER);
    if (reviewedIndex.kind !== "indexed") throw new Error("expected an index");
    const reviewed: WaveSpecCheckDocumentsAuthority = {
      spec: { path: SPEC, contentDigest: reviewedIndex.contentDigest },
      plan: { path: null, contentDigest: null },
    };
    const done = reanchorVerifiedClaims(next, 2, reviewed, reviewedIndex);
    expect(byId(done, "T1").spec_anchor_hashes).toEqual(recordedAnchorHashes(after, ["FR-001"]));
    const coverage = projectRequirementCoverage(reviewedIndex, coverageTasks(done, 3));
    expect(coverage.kind === "projected" && coverage.rows.some(({ taskId }) => taskId === "T1")).toBe(false);
  });
});

describe("re-anchoring touches only the claims an amendment changed", () => {
  it("leaves a completed Task's unchanged claim alone", () => {
    const graph = populated({ tasks: [completed("T1", ["FR-001", "AS-001"]), completed("T3", ["FR-002"]), task("T2", 2, [])] });
    const rewroteFr = BEFORE.replace("FR-001: System MUST satisfy FR-001", "FR-001: System MUST satisfy FR-001 within 10 MB per request");
    const result = amendSpec(graph, observed(BEFORE), observed(rewroteFr), REASON);
    if (!result.ok || result.value.kind !== "amended") throw new Error("expected an amendment");
    const index = observed(rewroteFr);
    if (index.kind !== "indexed") throw new Error("expected an index");
    const done = reanchorVerifiedClaims(result.value.graph, 2, {
      spec: { path: SPEC, contentDigest: index.contentDigest }, plan: { path: null, contentDigest: null },
    }, index);
    const hashes = byId(done, "T1").spec_anchor_hashes ?? {};
    expect(hashes["FR-001"]).toBe(recordedAnchorHashes(index.index, ["FR-001"])["FR-001"]);
    expect(hashes["AS-001"]).toBe(recordedAnchorHashes(before, ["AS-001"])["AS-001"]);
  });
});

describe("the State File proves a spec amendment", () => {
  it.each<[string, (audit: Record<string, unknown>) => Record<string, unknown>, string]>([
    ["an unknown field", (audit) => ({ ...audit, extra: 1 }), "unknown field(s): extra"],
    ["a wrong kind", (audit) => ({ ...audit, kind: "spec-trace-amendment" }), "invalid schema or kind"],
    ["a re-judgement of an unknown Task", (audit) => ({ ...audit, rejudge: [{ taskId: "T9", claim: "FR-001" }] }), "names no Task"],
    ["a re-judgement of an unchanged id", (audit) => ({ ...audit, rejudge: [{ taskId: "T1", claim: "FR-003" }] }), "rewrote or withdrew"],
    ["a repeated id", (audit) => ({ ...audit, added: ["FR-003", "FR-003"] }), "repeats an id"],
    ["a blank reason", (audit) => ({ ...audit, reason: " " }), "reason"],
    ["one id in two lists", (audit) => ({ ...audit, added: ["FR-001"] }), "more than one of rewritten, added and withdrawn"],
    ["a repeated re-judgement", (audit) => ({ ...audit, rejudge: [{ taskId: "T1", claim: "FR-001" }, { taskId: "T1", claim: "FR-001" }] }), "repeats T1:FR-001"],
    ["an observation that never parsed", (audit) => ({ ...audit, after: { kind: "unavailable", reason: { kind: "no-spec-file" } } }), "must be an indexed observation"],
  ])("refuses %s", (_label, tamper, message) => {
    const raw = JSON.parse(JSON.stringify(amended().graph)) as Record<string, unknown>;
    const [audit] = raw.spec_amendments as Record<string, unknown>[];
    const loaded = parseTaskGraph({ ...raw, spec_amendments: [tamper(audit ?? {})] });
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error).toContain(message);
  });
});

describe("specAmendmentDiff (property)", () => {
  it("partitions every id: a rewritten or withdrawn id was in the old spec, an added one was not", () => {
    const ids: fc.Arbitrary<string[]> = fc.uniqueArray(fc.constantFrom<string>("FR-001", "FR-002", "FR-003", "FR-004"), { minLength: 1, maxLength: 4 });
    fc.assert(fc.property(ids, ids, fc.boolean(), (old, next, reword) => {
      const oldIndex = indexOf(specDefining(old, ["AS-001"]));
      const nextSource = specDefining(next, ["AS-001"]);
      const nextIndex = indexOf(reword ? nextSource.replace(/MUST satisfy/g, "MUST now satisfy") : nextSource);
      const diff = specAmendmentDiff(oldIndex, nextIndex);
      const common = next.filter((id) => old.includes(id));
      expect(diff.rewritten).toEqual(reword ? common : []);
      expect(diff.added).toEqual(next.filter((id) => !old.includes(id)));
      expect(diff.withdrawn).toEqual(old.filter((id) => !next.includes(id)));
    }));
  });
});
