import { describe, expect, it } from "vitest";
import { parseAuthoredTaskRoster, populateTaskGraph, type AuthoredTask } from "../../src/core/task-graph-population";
import { defaultVerificationManifest } from "../../src/core/verification-manifest";
import { parseTaskGraph } from "../../src/state-manager";
import type { PlanContract, TaskGraph } from "../../src/types";

const CONTRACT: PlanContract = {
  id: "CT-1",
  title: "Load contract",
  declaration: {
    kind: "declared",
    types: { kind: "none", reason: "the slice consumes another surface" },
    acceptance: [{ path: "tests/load.acceptance.test.ts", anchors: ["FR-001"] }],
    supportedDomain: null,
    statement: "Loads.",
  },
};

const task = (id: string, wave: number, overrides: Partial<AuthoredTask> = {}): AuthoredTask => ({
  id,
  description: `task ${id}`,
  agent: "code-implementer-agent",
  wave,
  depends_on: [],
  spec_anchors: [],
  spec_contributions: [],
  verification_policy: { regression: { kind: "required" }, new_tests: { kind: "required" } },
  file_list: [`src/${id}.ts`],
  ...overrides,
});

function populated(): TaskGraph {
  const roster = parseAuthoredTaskRoster([
    task("T1", 1, { file_list: ["tests/load.acceptance.test.ts"] }),
    task("T2", 2, { depends_on: ["T1"], spec_anchors: ["FR-001"] }),
  ]);
  if (!roster.ok) throw new Error(roster.error);
  const result = populateTaskGraph({
    current_phase: "decompose", phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: "plan.md",
    tasks: [], wave_gates: {},
  }, {
    planTitle: "load", validatedPlanFile: "plan.md", tasks: roster.value,
    verificationManifest: defaultVerificationManifest(),
    specIndex: { kind: "unavailable", reason: { kind: "no-spec-file" } }, observedSpecFile: null,
    force: false, proofBoundary: { kind: "absent", cause: "fixture" }, contracts: [CONTRACT],
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.state;
}

describe("acceptance_contracts at the State File load boundary", () => {
  it("round-trips the contracts population stamped", () => {
    const graph = populated();
    const parsed = parseTaskGraph(JSON.parse(JSON.stringify(graph)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.acceptance_contracts).toEqual(graph.acceptance_contracts);
  });

  it("accepts an explicitly empty contract list", () => {
    const raw = JSON.parse(JSON.stringify(populated())) as Record<string, unknown>;
    expect(parseTaskGraph({ ...raw, acceptance_contracts: [] })).toMatchObject({ ok: true });
  });

  it.each<[string, (graph: Record<string, unknown>) => Record<string, unknown>, string]>([
    ["a contract task missing from the roster", (graph) => ({
      ...graph,
      acceptance_contracts: [{ ...(graph.acceptance_contracts as Record<string, unknown>[])[0], contractTask: "T9" }],
    }), "contract task T9 is not in tasks"],
    ["a frozen path its contract task does not list", (graph) => ({
      ...graph,
      acceptance_contracts: [{
        ...(graph.acceptance_contracts as Record<string, unknown>[])[0],
        acceptance: [{ path: "tests/other.acceptance.test.ts", anchors: ["FR-001"] }],
      }],
    }), "frozen path 'tests/other.acceptance.test.ts' is not in T1's file_list"],
    ["a malformed freeze", (graph) => ({
      ...graph,
      acceptance_contracts: [{ ...(graph.acceptance_contracts as Record<string, unknown>[])[0], freeze: { state: "thawed" } }],
    }), "freeze.state must be awaiting-red, frozen or revised"],
    ["a contract with no acceptance files", (graph) => ({
      ...graph,
      acceptance_contracts: [{ ...(graph.acceptance_contracts as Record<string, unknown>[])[0], acceptance: [] }],
    }), "acceptance must be non-empty"],
    ["an acceptance file deciding no Requirement", (graph) => ({
      ...graph,
      acceptance_contracts: [{
        ...(graph.acceptance_contracts as Record<string, unknown>[])[0],
        acceptance: [{ path: "tests/load.acceptance.test.ts", anchors: [] }],
      }],
    }), "anchors must be non-empty"],
    ["a revised freeze with no recorded revision", (graph) => ({
      ...graph,
      acceptance_contracts: [{
        ...(graph.acceptance_contracts as Record<string, unknown>[])[0],
        freeze: { state: "revised", paths: [{ path: "tests/load.acceptance.test.ts", sha256: "a".repeat(64) }] },
      }],
    }), "freeze is revised but records no revision"],
    ["a freeze whose bytes are not the last revision's", (graph) => ({
      ...graph,
      acceptance_contracts: [{
        ...(graph.acceptance_contracts as Record<string, unknown>[])[0],
        freeze: { state: "revised", paths: [{ path: "tests/load.acceptance.test.ts", sha256: "a".repeat(64) }] },
        revisions: [{
          revision: 1,
          reason: "fixed AS-001",
          previous: [{ path: "tests/load.acceptance.test.ts", sha256: "b".repeat(64) }],
          paths: [{ path: "tests/load.acceptance.test.ts", sha256: "c".repeat(64) }],
          revalidatedTaskIds: [],
        }],
      }],
    }), "freeze.paths must equal the last revision's paths"],
    ["revisions recorded before any freeze", (graph) => ({
      ...graph,
      acceptance_contracts: [{
        ...(graph.acceptance_contracts as Record<string, unknown>[])[0],
        revisions: [{
          revision: 1,
          reason: "fixed AS-001",
          previous: [{ path: "tests/load.acceptance.test.ts", sha256: "b".repeat(64) }],
          paths: [{ path: "tests/load.acceptance.test.ts", sha256: "c".repeat(64) }],
          revalidatedTaskIds: [],
        }],
      }],
    }), "revisions precede the freeze"],
    ["a frozen path escaping the repository", (graph) => ({
      ...graph,
      acceptance_contracts: [{
        ...(graph.acceptance_contracts as Record<string, unknown>[])[0],
        acceptance: [{ path: "../load.acceptance.test.ts", anchors: ["FR-001"] }],
      }],
    }), "freezes '../load.acceptance.test.ts', which is not a repository-relative path"],
  ])("refuses %s", (_name, mutate, message) => {
    const raw = JSON.parse(JSON.stringify(populated())) as Record<string, unknown>;
    expect(parseTaskGraph(mutate(raw))).toMatchObject({ ok: false, error: expect.stringContaining(message) });
  });
});
