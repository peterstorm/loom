import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import amendSpecTrace from "../../../src/handlers/helpers/amend-spec-trace";
import { parseSpec } from "../../../src/core/parse-spec";
import { installWaveGateRegistration } from "../../../src/core/wave-gate-registration";
import { waveGateAuthorityDigest } from "../../../src/core/wave-review-authority";
import { newWaveGate } from "../../../src/core/wave-gate-model";
import { StateManager, parseTaskGraph } from "../../../src/state-manager";
import type { TaskGraph } from "../../../src/types";
import { AMENDMENT_SPEC } from "../../fixtures/amendment-spec";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { activeWaveGateFixture, completedWaveGateFixture, taskFixture } from "../../fixtures/task-lifecycle";
import { WHITELISTED_HELPERS } from "../../../src/config";
import { guardStateFileDecision } from "../../../src/core/guard-state-file";
import { KNOWN_HANDLERS, piRuntimeHandshakeRequired } from "../../../src/handler-routes";

const parsedSpec = parseSpec(AMENDMENT_SPEC);
if (!parsedSpec.ok) throw new Error("fixture spec must parse");
const FR_002_HASH = parsedSpec.value.frs[1]!.contentHash;

/**
 * The real ledger, except that a test can make a subagent appear from the Nth
 * observation on: the only way to land between the helper's pre-lock check and
 * its in-lock re-check.
 */
const ledger = vi.hoisted(() => ({ activeFromObservation: null as number | null, observations: 0 }));
vi.mock("../../../src/machine/ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/machine/ledger")>();
  return {
    ...actual,
    anyActiveSubagent: (path: string) => {
      ledger.observations += 1;
      return (ledger.activeFromObservation !== null && ledger.observations >= ledger.activeFromObservation) ||
        actual.anyActiveSubagent(path);
    },
  };
});

const cleanup: string[] = [];
let inheritedEnvironment: readonly (readonly [string, string | undefined])[] = [];
beforeEach(() => {
  ledger.activeFromObservation = null;
  ledger.observations = 0;
  inheritedEnvironment = ["LOOM_STATE_PATH", "LOOM_SUBAGENT_DIR"].map((key) => [key, process.env[key]] as const);
});
afterEach(() => {
  for (const [key, value] of inheritedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const task = (id: string, wave: number, anchors: readonly string[]) => taskFixture({
  id, description: id, agent: "code-implementer-agent", wave, depends_on: [], file_list: [`src/${id}.ts`],
  spec_anchors: [...anchors], spec_contributions: [],
  review_status: "pending", review_generation: 2, findings: [], critical_findings: [], advisory_findings: [],
  refuted_findings: [], resolved_findings: [],
});

type Fixture = Readonly<{ root: string; statePath: string; runsRoot: string }>;

function fixture(overrides: Partial<TaskGraph> = {}): Fixture {
  const root = canonicalTempDir("loom-amend-spec-trace-");
  cleanup.push(root);
  const specFile = join(root, "spec.md");
  writeFileSync(specFile, AMENDMENT_SPEC);
  const statePath = join(root, "active_task_graph.json");
  const runsRoot = join(root, "runs");
  writeFileSync(statePath, JSON.stringify({
    spec_trace_version: 2,
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: specFile,
    plan_file: null,
    current_wave: 2,
    executing_tasks: [],
    tasks: [task("T1", 1, ["AS-001"]), task("T2", 2, ["FR-001"]), task("T3", 2, [])],
    wave_gates: { "1": newWaveGate(), "2": newWaveGate() },
    wave_gate_history: [completedWaveGateFixture({ runId: "run.wave-1", wave: 1 })],
    ...overrides,
  }));
  chmodSync(statePath, 0o444);
  process.env.LOOM_STATE_PATH = statePath;
  const subagents = join(root, "subagents");
  mkdirSync(subagents);
  process.env.LOOM_SUBAGENT_DIR = subagents;
  return { root, statePath, runsRoot };
}

const input = (t3Anchors: readonly string[]) => JSON.stringify({
  spec_trace_version: 2,
  tasks: [
    { id: "T1", spec_anchors: ["AS-001"], spec_contributions: [] },
    { id: "T2", spec_anchors: ["FR-001"], spec_contributions: [] },
    { id: "T3", spec_anchors: [...t3Anchors], spec_contributions: [] },
  ],
});

/** A fresh Wave Gate for the current Wave, as `start wave-gate` would register it. */
function successorInstall(state: TaskGraph, runsRoot: string) {
  const taskIds = state.tasks.filter(({ wave }) => wave === 2).map(({ id }) => id);
  return installWaveGateRegistration(state, activeWaveGateFixture({
    runId: "run.successor", wave: 2, authorityDigest: waveGateAuthorityDigest(2, taskIds, state), runsRoot,
  }), taskIds);
}

describe("amend-spec-trace registration", () => {
  // The registry parity suites iterate whatever is registered, so only a
  // named pin notices this helper dropping out of one of its registrations.
  it("is routed, whitelisted past the State File guard, and handshake-gated", () => {
    expect(KNOWN_HANDLERS.helper?.has("amend-spec-trace")).toBe(true);
    expect(WHITELISTED_HELPERS).toContain("amend-spec-trace");
    expect(piRuntimeHandshakeRequired("helper", "amend-spec-trace")).toBe(true);
    expect(guardStateFileDecision(
      'bun "$LOOM_DIR/engine/src/cli.ts" helper amend-spec-trace < /tmp/trace.json',
    ).kind).toBe("allow");
  });
});

describe("amend-spec-trace helper", () => {
  it("commits the amendment through StateManager, minting the new claim's hash from the observed spec", async () => {
    const { statePath } = fixture();
    const result = await amendSpecTrace(input(["FR-002"]), []);
    expect(result.kind, result.kind === "error" ? result.message : "").toBe("passthrough");

    const stored = new StateManager(statePath).load();
    expect(stored.tasks[2]).toMatchObject({ spec_anchors: ["FR-002"], spec_anchor_hashes: { "FR-002": FR_002_HASH } });
    expect(stored.spec_trace_amendments?.[0]).toMatchObject({ wave: 2, retiredRunId: null });
    expect(parseTaskGraph(JSON.parse(readFileSync(statePath, "utf8"))).ok).toBe(true);

    const committed = readFileSync(statePath, "utf8");
    expect((await amendSpecTrace(input(["FR-002"]), [])).kind).toBe("passthrough");
    expect(readFileSync(statePath, "utf8")).toBe(committed);
  });

  it("refuses without writing while a project-bound subagent is active", async () => {
    const { root, statePath } = fixture();
    const subagents = join(root, "subagents");
    writeFileSync(join(subagents, "session.active"), "agent-1\tcode-implementer-agent\n");
    writeFileSync(join(subagents, "session.task_graph"), statePath);
    const before = readFileSync(statePath, "utf8");

    const result = await amendSpecTrace(input(["FR-002"]), []);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("subagent is active");
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("re-checks for a subagent under the lock and refuses without writing when one appeared", async () => {
    const { statePath } = fixture();
    const before = readFileSync(statePath, "utf8");
    ledger.activeFromObservation = 2;

    const result = await amendSpecTrace(input(["FR-002"]), []);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("became active before the spec trace amendment could commit");
    expect(ledger.observations).toBe(2);
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses under a live Wave Gate through StateManager, naming the abandon recovery, without writing", async () => {
    const { statePath, runsRoot } = fixture();
    const installed = successorInstall(new StateManager(statePath).load(), runsRoot);
    if (installed.kind !== "installed") throw new Error("fixture successor must install");
    chmodSync(statePath, 0o644);
    writeFileSync(statePath, JSON.stringify(installed.state));
    chmodSync(statePath, 0o444);
    const before = readFileSync(statePath, "utf8");

    const result = await amendSpecTrace(input(["FR-002"]), []);
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("run.successor is live");
      expect(result.message).toContain("helper orchestration abandon");
    }
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses a core precondition without writing", async () => {
    const { statePath } = fixture();
    const before = readFileSync(statePath, "utf8");
    const result = await amendSpecTrace(input(["FR-999"]), []);
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toContain("FR-999");
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses arguments and malformed JSON", async () => {
    fixture();
    expect((await amendSpecTrace(input([]), ["--force"])).kind).toBe("error");
    expect((await amendSpecTrace("{", [])).kind).toBe("error");
  });

  it("retires an abandoned tombstone so a fresh successor installs cleanly over the amended trace", async () => {
    const runsRoot = "/runs";
    const { statePath } = fixture({
      active_wave_gate: activeWaveGateFixture({
        runId: "run.abandoned", wave: 2, authorityDigest: "d".repeat(64), revision: 2, runsRoot,
        terminalOutcome: { kind: "terminal-abandoned", reason: "trace was wrong", supersededBy: null },
      }),
      wave_review_epoch: { runId: "run.abandoned" as never, wave: 2, batchEpoch: "e".repeat(64) as never },
    });
    expect((await amendSpecTrace(input(["FR-002"]), [])).kind).toBe("passthrough");

    const stored = new StateManager(statePath).load();
    expect(stored.active_wave_gate).toBeUndefined();
    expect(stored.wave_review_epoch).toBeUndefined();
    expect(stored.spec_trace_amendments?.[0]?.retiredRunId).toBe("run.abandoned");
    const installed = successorInstall(stored, runsRoot);
    expect(installed.kind).toBe("installed");
    if (installed.kind === "installed") expect(parseTaskGraph(JSON.parse(JSON.stringify(installed.state))).ok).toBe(true);
  });

  it("leaves a never-gated Wave ready for a fresh start", async () => {
    const { statePath, runsRoot } = fixture();
    expect((await amendSpecTrace(input(["FR-002"]), [])).kind).toBe("passthrough");
    const installed = successorInstall(new StateManager(statePath).load(), runsRoot);
    expect(installed.kind).toBe("installed");
    if (installed.kind === "installed") expect(parseTaskGraph(JSON.parse(JSON.stringify(installed.state))).ok).toBe(true);
  });
});
