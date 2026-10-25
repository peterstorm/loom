/**
 * Population proves the authored Requirement trace against the Spec Index: a
 * declared spec it cannot index, an id the index does not define, or a trace
 * with no spec at all is refused before anything is written — the G1 live
 * pilot's NFR-001/SC-001 claims and non-canonical spec surfaced only later.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  parseAuthoredTaskRoster,
  populateTaskGraph,
  type AuthoredTask,
  type TaskGraphPopulationCommand,
} from "../../src/core/task-graph-population";
import { defaultVerificationManifest } from "../../src/core/verification-manifest";
import { parseArtifactDigest } from "../../src/core/orchestration-contract";
import {
  completableRequirementIds,
  unprovenRequirementTrace,
  type SpecIndexAvailability,
} from "../../src/core/requirement-coverage";
import type { TaskGraph } from "../../src/types";
import { indexedSpec } from "../fixtures/spec-index-fixture";

const task = (id: string, anchors: readonly string[], contributions: readonly string[] = []): AuthoredTask => ({
  id,
  description: `implement ${id}`,
  agent: "code-implementer-agent",
  wave: 1,
  depends_on: [],
  spec_anchors: [...anchors],
  spec_contributions: [...contributions],
  verification_policy: { regression: { kind: "required" }, new_tests: { kind: "required" } },
  file_list: [`src/${id}.ts`],
});

const graph = (specFile: string | null): TaskGraph => ({
  current_phase: "decompose", phase_artifacts: {}, skipped_phases: [], spec_file: specFile, plan_file: "plan.md",
  tasks: [], wave_gates: {},
});

function populate(tasks: readonly AuthoredTask[], specIndex: SpecIndexAvailability, specFile: string | null) {
  const roster = parseAuthoredTaskRoster(tasks);
  if (!roster.ok) throw new Error(roster.error);
  const command: TaskGraphPopulationCommand = {
    planTitle: "plan", validatedPlanFile: "plan.md", tasks: roster.value,
    verificationManifest: defaultVerificationManifest(), specIndex, observedSpecFile: specFile,
    force: false, proofBoundary: { kind: "absent", cause: "fixture" }, contracts: [], invariants: [],
  };
  return populateTaskGraph(graph(specFile), command);
}

const digest = (() => {
  const parsed = parseArtifactDigest("d".repeat(64));
  if (!parsed.ok) throw new Error("digest fixture");
  return parsed.value;
})();
const NO_SPEC: SpecIndexAvailability = { kind: "unavailable", reason: { kind: "no-spec-file" } };
const UNPARSED: SpecIndexAvailability = {
  kind: "unavailable",
  reason: { kind: "unparsed", path: "spec.md", contentDigest: digest, errors: [{ kind: "missing-section", section: "Appendix: Glossary" }] },
};

describe("populateTaskGraph — Spec Index authority", () => {
  it("populates a trace every id of which the Spec Index defines", () => {
    expect(populate([task("T1", ["FR-001", "AS-001"], ["FR-002"])], indexedSpec("spec.md"), "spec.md")).toMatchObject({ ok: true });
  });

  it("refuses ids the Spec Index does not define as completable, naming each edge", () => {
    const result = populate([task("T1", ["FR-001"]), task("T2", ["NFR-001"], ["SC-001", "OOS-001"])], indexedSpec("spec.md"), "spec.md");
    expect(result).toMatchObject({ ok: false, error: { kind: "unknown-requirement" } });
    if (!result.ok) expect(result.error.message).toContain("T2 → NFR-001, T2 → SC-001, T2 → OOS-001");
  });

  it("refuses a declared spec that is not canonical, even when nothing claims from it", () => {
    const result = populate([task("T1", [])], UNPARSED, "spec.md");
    expect(result).toMatchObject({ ok: false, error: { kind: "spec-index-unavailable" } });
    if (!result.ok) expect(result.error.message).toContain("spec file spec.md is not a canonical specification");
  });

  it("refuses a Requirement trace when the plan has no spec_file", () => {
    const result = populate([task("T1", [], ["FR-001"])], NO_SPEC, null);
    expect(result).toMatchObject({ ok: false, error: { kind: "spec-index-unavailable" } });
    if (!result.ok) expect(result.error.message).toContain("no Spec Index can prove they exist");
  });

  it("populates a plan with no spec_file and no Requirement trace", () => {
    expect(populate([task("T1", [])], NO_SPEC, null)).toMatchObject({ ok: true });
  });
});

describe("unprovenRequirementTrace — the one admission rule for new trace edges", () => {
  const index = indexedSpec("spec.md");
  const ids = fc.constantFrom("FR-001", "FR-002", "AS-001", "AS-002", "OOS-001", "NFR-001", "SC-001", "FR-999");
  const edges = fc.array(fc.record({ taskId: fc.constantFrom("T1", "T2", "T3"), id: ids }), { maxLength: 12 });

  it("admits a trace exactly when every edge names a completable entry, and names the rest in order", () => {
    if (index.kind !== "indexed") throw new Error("fixture");
    const completable = completableRequirementIds(index.index);
    fc.assert(fc.property(edges, (trace) => {
      const unknown = trace.filter(({ id }) => !completable.has(id));
      const outcome = unprovenRequirementTrace(index, trace);
      expect(outcome).toEqual(unknown.length === 0 ? null : { kind: "unknown-requirement", edges: unknown });
    }));
  });

  it("refuses any non-empty trace without a Spec Index, and admits an empty one", () => {
    fc.assert(fc.property(edges, (trace) => {
      expect(unprovenRequirementTrace(NO_SPEC, trace)).toEqual(
        trace.length === 0 ? null : { kind: "spec-index-unavailable", reason: { kind: "no-spec-file" } });
    }));
  });
});
