import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import reviseContract from "../../../src/handlers/helpers/revise-contract";
import type { AcceptanceContract } from "../../../src/core/acceptance-contract";
import { contentDigest } from "../../fixtures/acceptance-fixtures";
import { newWaveGate } from "../../../src/core/wave-gate-model";
import { StateManager, parseTaskGraph } from "../../../src/state-manager";
import { WHITELISTED_HELPERS } from "../../../src/config";
import { guardStateFileDecision } from "../../../src/core/guard-state-file";
import { KNOWN_HANDLERS, piRuntimeHandshakeRequired } from "../../../src/handler-routes";
import type { Task } from "../../../src/types";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { completedWaveGateFixture, satisfiedProof, taskFixture } from "../../fixtures/task-lifecycle";

/** The real ledger, except that a test can make a subagent appear from the
 *  Nth observation on: the only way to land between the pre-lock check and
 *  the in-lock re-check. */
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

const TYPES = "src/payload-contract.ts";
const ACCEPTANCE = "tests/payload.acceptance.test.ts";
const FROZEN_TYPES = "export type Payload = { readonly id: string };\n";
const FROZEN_ACCEPTANCE = "it('AS-001: one call wins', () => expect(wins()).toBe(2));\n";

const sha = contentDigest;

const task = (id: string, wave: number, status: "implemented" | "completed", anchors: readonly string[], files: readonly string[]): Task =>
  taskFixture({
    id, description: id, agent: "code-implementer-agent", wave, depends_on: wave === 1 ? [] : ["T1"],
    file_list: [...files], spec_anchors: [...anchors], spec_contributions: [],
    status, proof: satisfiedProof(files), review_status: "passed", review_generation: 1,
  });

const CONTRACT: AcceptanceContract = {
  schemaVersion: 1,
  id: "CT-1",
  title: "Payload",
  statement: "One valid call wins.",
  contractTask: "T1",
  types: { kind: "file", path: TYPES },
  acceptance: [{ path: ACCEPTANCE, anchors: ["AS-001"] }],
  supportedDomain: null,
  freeze: {
    state: "frozen",
    wave: 1,
    paths: [{ path: TYPES, sha256: sha(FROZEN_TYPES) }, { path: ACCEPTANCE, sha256: sha(FROZEN_ACCEPTANCE) }],
    roster: [{ file: ACCEPTANCE, name: "payload > AS-001: one call wins", anchors: ["AS-001"] }],
  },
  revisions: [],
};

type Fixture = Readonly<{ root: string; statePath: string }>;

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A Git repository holding the frozen files and a TaskGraph whose Wave 1
 *  froze them and whose current Wave 2 holds the implemented claimant T2. */
function fixture(): Fixture {
  const root = canonicalTempDir("loom-revise-contract-");
  cleanup.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  write(root, TYPES, FROZEN_TYPES);
  write(root, ACCEPTANCE, FROZEN_ACCEPTANCE);
  const statePath = join(root, ".loom", "active_task_graph.json");
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, JSON.stringify({
    spec_trace_version: 2,
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 2,
    executing_tasks: [],
    tasks: [task("T1", 1, "completed", [], [TYPES, ACCEPTANCE]), task("T2", 2, "implemented", ["AS-001"], ["src/payload.ts"])],
    wave_gates: { "1": newWaveGate(), "2": { ...newWaveGate(), impl_complete: true } },
    wave_gate_history: [completedWaveGateFixture({ runId: "run.wave-1", wave: 1 })],
    acceptance_contracts: [CONTRACT],
  }));
  chmodSync(statePath, 0o444);
  process.env.LOOM_STATE_PATH = statePath;
  const subagents = join(root, "subagents");
  mkdirSync(subagents);
  process.env.LOOM_SUBAGENT_DIR = subagents;
  return { root, statePath };
}

const ARGS = ["--contract", "CT-1", "--reason", "AS-001 asserted the wrong error variant"];

describe("revise-contract registration", () => {
  it("is routed, whitelisted past the State File guard, and handshake-gated", () => {
    expect(KNOWN_HANDLERS.helper?.has("revise-contract")).toBe(true);
    expect(WHITELISTED_HELPERS).toContain("revise-contract");
    expect(piRuntimeHandshakeRequired("helper", "revise-contract")).toBe(true);
    expect(guardStateFileDecision(
      'bun "$LOOM_DIR/engine/src/cli.ts" helper revise-contract --contract CT-1 --reason "wrong variant"',
    ).kind).toBe("allow");
  });
});

describe("revise-contract helper", () => {
  it("stamps the edited bytes and returns the claimant to revalidation through StateManager", async () => {
    const { root, statePath } = fixture();
    const edited = "it('AS-001: one call wins', () => expect(wins()).toEqual({ kind: 'won' }));\n";
    write(root, ACCEPTANCE, edited);

    const result = await reviseContract("", ARGS);
    expect(result.kind, result.kind === "error" ? result.message : "").toBe("passthrough");

    const stored = new StateManager(statePath).load();
    expect(stored.acceptance_contracts?.[0]?.freeze).toEqual({
      state: "revised",
      paths: [{ path: TYPES, sha256: sha(FROZEN_TYPES) }, { path: ACCEPTANCE, sha256: sha(edited) }],
    });
    expect(stored.acceptance_contracts?.[0]?.revisions).toMatchObject([{ revision: 1, revalidatedTaskIds: ["T2"] }]);
    expect(stored.tasks[1]).toMatchObject({ status: "pending", revalidation_required: true });
    expect(parseTaskGraph(JSON.parse(readFileSync(statePath, "utf8"))).ok).toBe(true);
  });

  it("refuses without writing when the frozen bytes did not change", async () => {
    const { statePath } = fixture();
    const before = readFileSync(statePath, "utf8");
    const result = await reviseContract("", ARGS);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("unchanged") });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses without writing while a project-bound subagent is active", async () => {
    const { root, statePath } = fixture();
    write(root, TYPES, "export type Payload = { readonly id: number };\n");
    const subagents = join(root, "subagents");
    writeFileSync(join(subagents, "session.active"), "agent-1\tcode-implementer-agent\n");
    writeFileSync(join(subagents, "session.task_graph"), statePath);
    const before = readFileSync(statePath, "utf8");

    const result = await reviseContract("", ARGS);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("subagent is active") });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("re-checks for a subagent under the lock and refuses without writing when one appeared", async () => {
    const { root, statePath } = fixture();
    write(root, TYPES, "export type Payload = { readonly id: number };\n");
    const before = readFileSync(statePath, "utf8");
    ledger.activeFromObservation = 2;

    const result = await reviseContract("", ARGS);
    expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("became active before the Contract Revision") });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses malformed arguments with the usage", async () => {
    fixture();
    expect(await reviseContract("", ["--contract", "CT-1"])).toMatchObject({
      kind: "error",
      message: expect.stringContaining("Usage: helper revise-contract"),
    });
  });
});
