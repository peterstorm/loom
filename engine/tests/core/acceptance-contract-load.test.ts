import { describe, expect, it } from "vitest";
import { parseAuthoredTaskRoster, populateTaskGraph, type AuthoredTask } from "../../src/core/task-graph-population";
import { defaultVerificationManifest } from "../../src/core/verification-manifest";
import { parseTaskGraph } from "../../src/state-manager";
import type { PlanContract, TaskGraph } from "../../src/types";
import { indexedSpec } from "../fixtures/spec-index-fixture";

const CONTRACT: PlanContract = {
  id: "CT-1",
  title: "Load contract",
  declaration: {
    kind: "declared",
    types: { kind: "none", reason: "the slice consumes another surface" },
    acceptance: [{ path: "tests/load.acceptance.test.ts", anchors: ["FR-001"] }],
    supportedDomain: null,
    entryPoint: null,
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

function populated(contracts: readonly PlanContract[] = [CONTRACT]): TaskGraph {
  const roster = parseAuthoredTaskRoster([
    task("T1", 1, { file_list: ["tests/load.acceptance.test.ts"] }),
    task("T2", 2, { depends_on: ["T1"], spec_anchors: ["FR-001"] }),
  ]);
  if (!roster.ok) throw new Error(roster.error);
  const result = populateTaskGraph({
    current_phase: "decompose", phase_artifacts: {}, skipped_phases: [], spec_file: "spec.md", plan_file: "plan.md",
    tasks: [], wave_gates: {},
  }, {
    planTitle: "load", validatedPlanFile: "plan.md", tasks: roster.value,
    verificationManifest: defaultVerificationManifest(),
    specIndex: indexedSpec("spec.md"), observedSpecFile: "spec.md",
    force: false, proofBoundary: { kind: "absent", cause: "fixture" }, contracts,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.state;
}

const ACCEPTANCE = "tests/load.acceptance.test.ts";
const bytes = (fill: string) => [{ path: ACCEPTANCE, sha256: fill.repeat(64) }];
const revision = (n: number, previous: string, paths: string) =>
  ({ revision: n, reason: `fix ${n}`, previous: bytes(previous), paths: bytes(paths), revalidatedTaskIds: [] });
const withTasks = (graph: Record<string, unknown>, map: (task: Record<string, unknown>) => Record<string, unknown>) =>
  ({ ...graph, tasks: (graph.tasks as Record<string, unknown>[]).map(map) });

/** A mutation of the populated graph that patches its one contract. */
const withContract = (patch: Record<string, unknown>) => (graph: Record<string, unknown>): Record<string, unknown> => ({
  ...graph,
  acceptance_contracts: [{ ...(graph.acceptance_contracts as Record<string, unknown>[])[0], ...patch }],
});

/** T1's Proof as a non-writer's in this I6-era graph: red-then-green after new-tests. A
 *  contract retargeted away from T1 leaves T1 owing I6, which its frozen Proof must show
 *  before the contract's own binding is judged. */
const withT1OwingI6 = (graph: Record<string, unknown>): Record<string, unknown> => withTasks(graph, (task) => {
  if (task.id !== "T1") return task;
  const proof = task.proof as { obligations: Array<{ kind: string }>; results: unknown[] };
  const at = proof.obligations.findIndex(({ kind }) => kind === "new-tests") + 1;
  return {
    ...task,
    proof: {
      ...proof,
      obligations: [...proof.obligations.slice(0, at), { kind: "red-then-green" }, ...proof.obligations.slice(at)],
      results: [...proof.results.slice(0, at), { state: "pending", obligation: { kind: "red-then-green" } }, ...proof.results.slice(at)],
    },
  };
});

describe("acceptance_contracts at the State File load boundary", () => {
  it("round-trips the contracts population stamped", () => {
    const graph = populated();
    const parsed = parseTaskGraph(JSON.parse(JSON.stringify(graph)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.acceptance_contracts).toEqual(graph.acceptance_contracts);
  });

  it("accepts an explicitly empty contract list", () => {
    const raw = JSON.parse(JSON.stringify(populated([]))) as Record<string, unknown>;
    expect(parseTaskGraph({ ...raw, acceptance_contracts: [] })).toMatchObject({ ok: true });
  });

  it("refuses the writer's Proof once the contract list that exempted it is emptied", () => {
    const raw = JSON.parse(JSON.stringify(populated())) as Record<string, unknown>;
    expect(parseTaskGraph({ ...raw, acceptance_contracts: [] })).toMatchObject({
      ok: false,
      error: expect.stringContaining('tasks[0] ("T1"): proof obligations do not exactly match'),
    });
  });

  it.each<[string, (graph: Record<string, unknown>) => Record<string, unknown>, string]>([
    ["a contract task missing from the roster",
      (graph) => withContract({ contractTask: "T9" })(withT1OwingI6(graph)), "contract task T9 is not in tasks"],
    ["a frozen path its contract task does not list",
      withContract({ acceptance: [{ path: "tests/other.acceptance.test.ts", anchors: ["FR-001"] }] }),
      "frozen path 'tests/other.acceptance.test.ts' is not in T1's file_list"],
    ["a malformed freeze", withContract({ freeze: { state: "thawed" } }), "freeze.state must be awaiting-red, frozen or revised"],
    ["a contract with no acceptance files", withContract({ acceptance: [] }), "acceptance must be non-empty"],
    ["an acceptance file deciding no Requirement",
      withContract({ acceptance: [{ path: ACCEPTANCE, anchors: [] }] }), "anchors must be non-empty"],
    ["a revised freeze with no recorded revision",
      withContract({ freeze: { state: "revised", paths: bytes("a") } }), "freeze is revised but records no revision"],
    ["a freeze whose bytes are not the last revision's",
      withContract({ freeze: { state: "revised", paths: bytes("a") }, revisions: [revision(1, "b", "c")] }),
      "freeze.paths must equal the last revision's paths"],
    ["revisions recorded before any freeze", withContract({ revisions: [revision(1, "b", "c")] }), "revisions precede the freeze"],
    ["a revision that does not start from the bytes the one before it stamped",
      withContract({ freeze: { state: "revised", paths: bytes("e") }, revisions: [revision(1, "b", "c"), revision(2, "d", "e")] }),
      "revisions[1].previous must equal revision 1's paths"],
    ["a frozen path escaping the repository",
      withContract({ acceptance: [{ path: "../load.acceptance.test.ts", anchors: ["FR-001"] }] }),
      "freezes '../load.acceptance.test.ts', which is not a repository-relative path"],
  ])("refuses %s", (_name, mutate, message) => {
    const raw = JSON.parse(JSON.stringify(populated())) as Record<string, unknown>;
    expect(parseTaskGraph(mutate(raw))).toMatchObject({ ok: false, error: expect.stringContaining(message) });
  });

  it("refuses a freeze stamped before its contract Task's Wave", () => {
    const raw = JSON.parse(JSON.stringify(populated())) as Record<string, unknown>;
    const shifted = withTasks(raw, (task) => ({ ...task, wave: (task.wave as number) + 1 }));
    const frozen = withContract({
      freeze: { state: "frozen", wave: 1, paths: bytes("a"), roster: [{ file: ACCEPTANCE, name: "FR-001: loads", anchors: ["FR-001"] }] },
    })(shifted);
    expect(parseTaskGraph(frozen)).toMatchObject({
      ok: false,
      error: expect.stringContaining("freeze.wave 1 precedes contract task T1's Wave 2"),
    });
  });
});
