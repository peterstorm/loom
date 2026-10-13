import { describe, expect, it } from "vitest";
import {
  parseContractRevisionArgs,
  reviseAcceptanceContract,
  type ContractRevisionRefusal,
} from "../../src/core/contract-revision";
import {
  acceptanceExpectation,
  frozenPathDrift,
  type AcceptanceContract,
  type FrozenPathObservation,
} from "../../src/core/acceptance-contract";

import { digest, seen } from "../fixtures/acceptance-fixtures";
import { newWaveGate } from "../../src/core/wave-gate-model";
import { parseTaskGraph } from "../../src/state-file-wire";
import type { Task, TaskGraph } from "../../src/types";
import {
  activeWaveGateFixture,
  completedWaveGateFixture,
  protectedGraphFixture,
  satisfiedProof,
  taskFixture,
} from "../fixtures/task-lifecycle";

const TYPES = "src/payload-contract.ts";
const ACCEPTANCE = "tests/payload.acceptance.test.ts";

const task = (
  id: string,
  wave: number,
  status: "pending" | "implemented" | "completed",
  anchors: readonly string[],
  files: readonly string[],
): Task => taskFixture({
  id, description: id, agent: "code-implementer-agent", wave, depends_on: wave === 1 ? [] : ["T1"],
  file_list: [...files], spec_anchors: [...anchors], spec_contributions: [],
  status,
  ...(status === "pending" ? {} : { proof: satisfiedProof(files) }),
  review_status: status === "pending" ? "pending" : "passed",
  review_generation: 3,
});

const CONTRACT: AcceptanceContract = {
  schemaVersion: 1,
  id: "CT-1",
  title: "Payload",
  statement: "One valid call wins.",
  contractTask: "T1",
  types: { kind: "file", path: TYPES },
  acceptance: [{ path: ACCEPTANCE, anchors: ["AS-001", "FR-001"] }],
  supportedDomain: null,
  freeze: {
    state: "frozen",
    wave: 1,
    paths: [{ path: TYPES, sha256: digest("a") }, { path: ACCEPTANCE, sha256: digest("b") }],
    roster: [
      { file: ACCEPTANCE, name: "payload > AS-001: one call wins", anchors: ["AS-001"] },
      { file: ACCEPTANCE, name: "payload > FR-001: rejects a second call", anchors: ["FR-001"] },
    ],
  },
  revisions: [],
};

/** Wave 1 (the contract Wave) completed; Wave 2 current with an implemented
 *  claimant T2 and an implemented bystander T3; Wave 3 holds claimant T4. */
function populated(overrides: Partial<TaskGraph> = {}): TaskGraph {
  return protectedGraphFixture({
    spec_trace_version: 2,
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 2,
    executing_tasks: [],
    tasks: [
      task("T1", 1, "completed", [], [TYPES, ACCEPTANCE]),
      task("T2", 2, "implemented", ["AS-001"], ["src/payload.ts"]),
      task("T3", 2, "implemented", [], ["src/other.ts"]),
      task("T4", 3, "pending", ["FR-001"], ["src/second.ts"]),
    ],
    wave_gates: { "1": newWaveGate(), "2": { ...newWaveGate(), impl_complete: true, tests_passed: true } },
    wave_gate_history: [completedWaveGateFixture({ runId: "run.wave-1", wave: 1 })],
    acceptance_contracts: [CONTRACT],
    ...overrides,
  });
}

type Observations = ReadonlyMap<string, FrozenPathObservation>;
const observed = (types: FrozenPathObservation, acceptance: FrozenPathObservation): Observations =>
  new Map([[TYPES, types], [ACCEPTANCE, acceptance]]);

const REVISED = observed(seen(digest("c")), seen(digest("b")));
const REQUEST = { contract: "CT-1", reason: "AS-001 asserted the wrong error variant" };

const revised = (graph: TaskGraph, digests = REVISED, request = REQUEST) => {
  const result = reviseAcceptanceContract(graph, request, digests);
  if (!result.ok) throw new Error(`expected a revision, got ${result.error.kind}: ${result.error.message}`);
  return result.value;
};

const refusal = (graph: TaskGraph, digests = REVISED, request = REQUEST): ContractRevisionRefusal => {
  const result = reviseAcceptanceContract(graph, request, digests);
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
};

const taskById = (graph: TaskGraph, id: string): Task => graph.tasks.find((candidate) => candidate.id === id)!;

describe("reviseAcceptanceContract", () => {
  it("re-stamps the frozen bytes, records the revision, and clears the roster for the next gate to re-record green", () => {
    const { graph, revision } = revised(populated());
    const contract = graph.acceptance_contracts![0]!;
    const paths = [{ path: TYPES, sha256: digest("c") }, { path: ACCEPTANCE, sha256: digest("b") }];
    expect(contract.freeze).toEqual({ state: "revised", paths });
    expect(contract.revisions).toEqual([revision]);
    expect(revision).toEqual({
      revision: 1,
      reason: REQUEST.reason,
      previous: [{ path: TYPES, sha256: digest("a") }, { path: ACCEPTANCE, sha256: digest("b") }],
      paths,
      revalidatedTaskIds: ["T2"],
    });
    expect(frozenPathDrift(graph.acceptance_contracts!, REVISED)).toEqual([]);
    expect(acceptanceExpectation(graph.acceptance_contracts!, graph.tasks, 2).contracts[0]).toMatchObject({
      phase: "green", roster: null,
    });
  });

  it("returns the current Wave's implemented claimants to revalidation and leaves every other Task alone", () => {
    const before = populated();
    const { graph } = revised(before);
    expect(taskById(graph, "T2")).toMatchObject({
      status: "pending",
      revalidation_required: true,
      review_status: "pending",
      review_generation: 4,
    });
    expect(taskById(graph, "T2").proof).toEqual(taskById(before, "T2").proof);
    for (const id of ["T1", "T3", "T4"]) expect(taskById(graph, id)).toEqual(taskById(before, id));
    expect(graph.wave_gates["2"]).toMatchObject({ impl_complete: false, tests_passed: null, reviews_complete: false });
    expect(graph.wave_gates["1"]).toEqual(before.wave_gates["1"]);
  });

  it("produces a graph the State File parser reloads", () => {
    const { graph } = revised(populated());
    expect(parseTaskGraph(JSON.parse(JSON.stringify(graph)))).toMatchObject({ ok: true });
  });

  it("numbers a second revision after the first and chains its previous bytes", () => {
    const first = revised(populated()).graph;
    const again = observed(seen(digest("c")), seen(digest("d")));
    const { graph, revision } = revised(first, again, { contract: "CT-1", reason: "FR-001 needed a boundary case" });
    expect(revision.revision).toBe(2);
    expect(revision.previous).toEqual([{ path: TYPES, sha256: digest("c") }, { path: ACCEPTANCE, sha256: digest("b") }]);
    expect(revision.revalidatedTaskIds).toEqual([]);
    expect(graph.acceptance_contracts![0]!.revisions).toHaveLength(2);
  });

  it("refuses an unknown contract", () => {
    expect(refusal(populated(), REVISED, { ...REQUEST, contract: "CT-9" })).toMatchObject({ kind: "unknown-contract" });
  });

  it("refuses outside the execute Phase", () => {
    expect(refusal(populated({ current_phase: "architecture" }))).toMatchObject({ kind: "not-executing" });
  });

  it("refuses while implementation reservations are active", () => {
    expect(refusal(populated({ executing_tasks: ["T3"] }))).toMatchObject({ kind: "implementation-active" });
  });

  it("refuses while a Wave Gate is live", () => {
    const graph = populated({
      active_wave_gate: activeWaveGateFixture({ runId: "run.wave-2", wave: 2, authorityDigest: "d".repeat(64) }),
    });
    expect(refusal(graph)).toMatchObject({ kind: "live-wave-gate", message: expect.stringContaining("run.wave-2") });
  });

  it("refuses before the freeze: the contract Task still owns its files", () => {
    const graph = populated({ acceptance_contracts: [{ ...CONTRACT, freeze: { state: "awaiting-red" } }] });
    expect(refusal(graph)).toMatchObject({ kind: "not-frozen" });
  });

  it("refuses while the contract Wave has not completed", () => {
    expect(refusal(populated({ wave_gate_history: [] }))).toMatchObject({ kind: "contract-wave-open" });
  });

  it("refuses when a claimant sits in a completed Wave, naming the Wave to reopen", () => {
    const graph = populated({
      current_wave: 3,
      tasks: [
        task("T1", 1, "completed", [], [TYPES, ACCEPTANCE]),
        task("T2", 2, "completed", ["AS-001"], ["src/payload.ts"]),
        task("T3", 2, "completed", [], ["src/other.ts"]),
        task("T4", 3, "pending", ["FR-001"], ["src/second.ts"]),
      ],
      wave_gate_history: [
        completedWaveGateFixture({ runId: "run.wave-1", wave: 1 }),
        completedWaveGateFixture({ runId: "run.wave-2", wave: 2 }),
      ],
    });
    expect(refusal(graph)).toMatchObject({
      kind: "claimant-completed",
      message: expect.stringContaining("T2 (Wave 2)"),
    });
  });

  it("refuses when a frozen path cannot be read", () => {
    const digests = observed({ kind: "unreadable", reason: "ELOOP: refusing to follow a link" }, seen(digest("b")));
    expect(refusal(populated(), digests)).toMatchObject({
      kind: "unreadable-path",
      message: expect.stringContaining(`'${TYPES}' (ELOOP: refusing to follow a link)`),
    });
  });

  it("refuses as stale when the locked contracts name a path the shell never observed", () => {
    const partial: Observations = new Map([[ACCEPTANCE, seen(digest("b"))]]);
    expect(refusal(populated(), partial)).toMatchObject({
      kind: "observation-stale",
      message: expect.stringContaining(`'${TYPES}' (not observed)`),
    });
  });

  it("refuses when the bytes did not change", () => {
    const digests = observed(seen(digest("a")), seen(digest("b")));
    expect(refusal(populated(), digests)).toMatchObject({ kind: "unchanged" });
  });
});

describe("parseContractRevisionArgs", () => {
  it("parses the contract and a trimmed reason, in either order", () => {
    expect(parseContractRevisionArgs(["--contract", "CT-2", "--reason", "  wrong variant "]))
      .toEqual({ ok: true, value: { contract: "CT-2", reason: "wrong variant" } });
    expect(parseContractRevisionArgs(["--reason", "wrong variant", "--contract", "CT-2"]))
      .toEqual({ ok: true, value: { contract: "CT-2", reason: "wrong variant" } });
  });

  it.each([
    [[]],
    [["--contract", "CT-2"]],
    [["--contract", "contract-2", "--reason", "x"]],
    [["--contract", "CT-2", "--reason", "   "]],
    [["--contract", "CT-2", "--reason", "x".repeat(513)]],
    [["--contract", "CT-2", "--reason", "x", "--force"]],
    [["--contract", "CT-2", "--contract", "CT-3", "--reason", "x"]],
    [["--contract", "CT-2", "--reason"]],
  ])("refuses %j", (args) => {
    expect(parseContractRevisionArgs(args)).toMatchObject({ ok: false });
  });
});
