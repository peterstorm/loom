/**
 * Finding 7 of the G1 live pilot: the Wave 1 advisories on the contract's own
 * files were approved without anyone seeing that approval froze them. The
 * advisory pause now names exactly the advisories on paths this gate freezes.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  pendingFreezeAdvisories,
  renderPendingFreezeAdvisories,
  type AcceptanceContract,
} from "../../src/core/acceptance-contract";
import { deriveLoomStatusFromParsedGraph } from "../../src/core/loom-status";
import { evaluateTaskProof } from "../../src/core/proof-obligations";
import type { GateDeps } from "../../src/core/wave-gate-checks";
import { parseTaskGraph } from "../../src/state-manager";
import { parseNewTestEvidence, type Task, type TaskGraph } from "../../src/types";
import { contract, frozenPaths, surface } from "../fixtures/contract-status-fixtures";
import { findingId } from "../fixtures/finding-id";

const SURFACE = surface("payload");
const finding = (id: string, severity: "advisory" | "critical", file: string | null) =>
  ({ id: findingId(id), agent: "code-reviewer", severity, file, line: file === null ? null : 1, claim: `${id} claim` });

const awaiting = (contractTask = "T1"): AcceptanceContract =>
  contract({ id: "CT-1", contractTask, surface: SURFACE, anchors: ["AS-001"], freeze: { state: "awaiting-red" } });
const frozen = (): AcceptanceContract => contract({
  id: "CT-1", surface: SURFACE, anchors: ["AS-001"],
  freeze: { state: "frozen", wave: 1, paths: frozenPaths(SURFACE, "a"), roster: [{ file: SURFACE.acceptance, name: "AS-001: x", anchors: ["AS-001"] }] },
});

const view = (id: string, wave: number, findings: readonly ReturnType<typeof finding>[]) =>
  ({ id, wave, file_list: id === "T1" ? [SURFACE.types, SURFACE.acceptance] : [`src/${id}.ts`], spec_anchors: [], findings });

describe("pendingFreezeAdvisories", () => {
  it("names the contract Wave's advisories on frozen paths, in contract, Task and Finding order", () => {
    const tasks = [
      view("T1", 1, [finding("a-1", "advisory", SURFACE.acceptance), finding("a-2", "advisory", "src/other.ts")]),
      view("T2", 1, [finding("a-3", "advisory", `./${SURFACE.types}`), finding("c-1", "critical", SURFACE.types)]),
    ];
    expect(pendingFreezeAdvisories([awaiting()], tasks, 1)).toEqual([
      { contractId: "CT-1", taskId: "T1", findingId: "a-1", path: SURFACE.acceptance },
      { contractId: "CT-1", taskId: "T2", findingId: "a-3", path: SURFACE.types },
    ]);
  });

  it("is empty once the contract has frozen, outside its contract Wave, and for advisories with no file", () => {
    const onTypes = [view("T1", 1, [finding("a-1", "advisory", SURFACE.types), finding("a-2", "advisory", null)])];
    expect(pendingFreezeAdvisories([frozen()], onTypes, 1)).toEqual([]);
    expect(pendingFreezeAdvisories([awaiting()], [...onTypes, view("T2", 2, [finding("a-3", "advisory", SURFACE.types)])], 2))
      .toEqual([]);
    expect(pendingFreezeAdvisories([awaiting()], [view("T1", 1, [finding("a-2", "advisory", null)])], 1)).toEqual([]);
  });

  it("names every and only advisory whose file is frozen, for any finding set", () => {
    const files = fc.constantFrom<string | null>(SURFACE.types, SURFACE.acceptance, "src/elsewhere.ts", null);
    const findings = fc.array(fc.tuple(fc.constantFrom<"advisory" | "critical">("advisory", "critical"), files), { maxLength: 8 })
      .map((entries) => entries.map(([severity, file], index) => finding(`f-${index + 1}`, severity, file)));
    fc.assert(fc.property(findings, (set) => {
      const named = pendingFreezeAdvisories([awaiting()], [view("T1", 1, set)], 1).map(({ findingId: id }) => id);
      const expected = set
        .filter(({ severity, file }) => severity === "advisory" && (file === SURFACE.types || file === SURFACE.acceptance))
        .map(({ id }) => id);
      expect(named).toEqual(expected);
    }));
  });

  it("renders what approval does and how to fix first", () => {
    const text = renderPendingFreezeAdvisories([{ contractId: "CT-1", taskId: "T1", findingId: "a-1", path: SURFACE.types }]);
    expect(text).toContain(`a-1 (T1, CT-1: ${SURFACE.types})`);
    expect(text).toContain("Approving freezes them as they are");
    expect(text).toContain("abandon this run, re-dispatch the contract Task, and start a fresh Wave Gate");
  });
});

describe("status at the contract Wave's advisory pause", () => {
  const evaluated = evaluateTaskProof(
    { newTestsRequired: true, declaredArtifacts: [] },
    { taskCompleted: true, testResult: { verdict: "trusted-pass" }, filesModified: [], newTestsWritten: true },
  );
  if (evaluated.state !== "satisfied") throw new Error("fixture proof must be satisfied");
  const proof = evaluated;
  const deps: GateDeps = {
    loadPlanModels: () => ({
      kind: "loaded",
      models: { lifecycles: [], pipeline: null, invariants: [], contracts: [], strays: [] },
    }),
    filePresence: () => ({ ok: true, exists: true }),
  };

  function graphAtPause(advisoryFile: string, contracts: readonly AcceptanceContract[]): TaskGraph {
    const advisory = finding("comment-analyzer-1", "advisory", advisoryFile);
    const task: Task = {
      id: "T1", description: "contract", agent: "code-implementer-agent", wave: 1, status: "implemented", proof,
      depends_on: [], test_result: { verdict: "trusted-pass" },
      test_evidence: "vitest: Tests 5 passed", new_test_observation: parseNewTestEvidence(true, "1 new test"),
      review_status: "passed", findings: [advisory], critical_findings: [], advisory_findings: [advisory.claim],
    };
    const parsed = parseTaskGraph({
      current_phase: "execute", current_wave: 1, phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: "plan.md",
      spec_check: {
        wave: 1, run_at: "now", verdict: "PASSED", critical_count: 0, high_count: 0,
        critical_findings: [], high_findings: [], medium_findings: [],
      },
      tasks: [task],
      wave_gates: {},
      active_wave_gate: {
        schemaVersion: 1, kind: "active-wave-gate", runId: "freeze-notice-run", wave: 1,
        authorityDigest: "b".repeat(64), revision: 0, terminalOutcome: null,
      },
    });
    if (!parsed.ok) throw new Error(parsed.error);
    return { ...parsed.value, acceptance_contracts: contracts };
  }

  const statusOf = (graph: TaskGraph) => deriveLoomStatusFromParsedGraph({ ok: true, value: graph }, deps, null, {
    kind: "present", runId: "freeze-notice-run", path: "/runs/freeze-notice-run", advisoryApproval: { kind: "not-approved" },
  });

  it("names the advisory on a file the freeze will stamp beside the decision", () => {
    const status = statusOf(graphAtPause(SURFACE.types, [awaiting()]));
    expect(status.next.action.kind).toBe("await-user");
    expect(status.next.reasons).toContainEqual(expect.objectContaining({
      kind: "acceptance-freeze-pending",
      message: expect.stringContaining(`comment-analyzer-1 (T1, CT-1: ${SURFACE.types})`),
    }));
  });

  it("adds no notice when the advisories touch no frozen path, or the contract already froze", () => {
    for (const graph of [graphAtPause("src/other.ts", [awaiting()]), graphAtPause(SURFACE.types, [frozen()])]) {
      const status = statusOf(graph);
      expect(status.next.action.kind).toBe("await-user");
      expect(status.next.reasons.some(({ kind }) => kind === "acceptance-freeze-pending")).toBe(false);
    }
  });
});
