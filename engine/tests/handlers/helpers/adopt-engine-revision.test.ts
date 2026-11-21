/**
 * loom#198, Cause 4, through the real write boundary: a State File pinned to
 * another engine revision refuses every write by the running engine, and
 * `orchestration adopt-engine-revision` is the audited way to move the pin.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdoptEngineRevisionOperation } from "../../../src/handlers/helpers/adopt-engine-revision";
import { ORCHESTRATION_OPERATIONS } from "../../../src/handlers/helpers/orchestration-operations";
import { piRuntimeHandshakeRequired, routeConsumesStdin } from "../../../src/handler-routes";
import { runningEngineIdentity, StateManager } from "../../../src/state-manager";
import type { EngineRevision, EngineRevisionPin } from "../../../src/types";
import { engineRevisionOf } from "../../../src/core/engine-revision-pin";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { appearsUnderTheLock } from "../../fixtures/subagent-activity";
import { legacyDefaultVerificationManifest } from "../../../src/core/verification-manifest";

const OTHER = engineRevisionOf(`sha256:${"0".repeat(64)}`);
const RUNNING = engineRevisionOf(runningEngineIdentity().revision);
const ARGS = ["--reason", "the run continues on main after the #196 fix"] as const;
const quiet = () => false;

const cleanup: string[] = [];
let previousStatePath: string | undefined;
afterEach(() => {
  if (previousStatePath === undefined) delete process.env.LOOM_STATE_PATH;
  else process.env.LOOM_STATE_PATH = previousStatePath;
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function installState(pin?: EngineRevisionPin): string {
  previousStatePath = process.env.LOOM_STATE_PATH;
  const root = canonicalTempDir("loom-engine-revision-");
  cleanup.push(root);
  const statePath = join(root, ".claude", "state", "active_task_graph.json");
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  writeFileSync(statePath, JSON.stringify({
    current_phase: "execute", verification_manifest: legacyDefaultVerificationManifest(), current_wave: 1, phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: null,
    executing_tasks: [], wave_gates: {}, tasks: [],
    ...(pin === undefined ? {} : { engine_revision: pin }),
  }));
  process.env.LOOM_STATE_PATH = statePath;
  return statePath;
}
const pinnedTo = (revision: EngineRevision): EngineRevisionPin => ({ schemaVersion: 1, kind: "pinned", revision, adoptions: [] });
const write = (statePath: string) => new StateManager(statePath).update((state) => ({ ...state, plan_file: "plan.md" }));

describe("the State File's write boundary", () => {
  it("refuses, leaving the bytes untouched, a write by an engine other than the one the graph is pinned to", async () => {
    const statePath = installState(pinnedTo(OTHER));
    const before = readFileSync(statePath, "utf8");
    await expect(write(statePath)).rejects.toThrow(/pinned to Loom engine revision .*adopt-engine-revision/su);
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("admits a write by the pinned engine, and any write to an unpinned or self-hosted graph", async () => {
    for (const pin of [pinnedTo(RUNNING), undefined, { schemaVersion: 1, kind: "self-hosted" } as const]) {
      const statePath = installState(pin);
      await write(statePath);
      expect(JSON.parse(readFileSync(statePath, "utf8")).plan_file).toBe("plan.md");
    }
  });
});

describe("adopt-engine-revision", () => {
  it("takes only flags, requires the Pi runtime handshake and is parent-only", () => {
    expect(ORCHESTRATION_OPERATIONS["adopt-engine-revision"]).toEqual({ input: "flags", runtimeSkew: "handshake-required", subagent: "parent-only" });
    expect(routeConsumesStdin("helper", "orchestration", ["adopt-engine-revision", ...ARGS])).toBe(false);
    expect(piRuntimeHandshakeRequired("helper", "orchestration", ["adopt-engine-revision", ...ARGS])).toBe(true);
  });

  it("moves the pin to the running engine with its reason, after which the engine may write again", async () => {
    const statePath = installState(pinnedTo(OTHER));
    expect(await createAdoptEngineRevisionOperation(quiet)([...ARGS])).toEqual({ kind: "allow" });
    expect(JSON.parse(readFileSync(statePath, "utf8")).engine_revision).toEqual({
      schemaVersion: 1, kind: "pinned", revision: RUNNING,
      adoptions: [{ from: OTHER, to: RUNNING, reason: "the run continues on main after the #196 fix" }],
    });
    await write(statePath);
  });

  it("is idempotent: a repeat leaves the State File byte-identical", async () => {
    const statePath = installState(pinnedTo(OTHER));
    await createAdoptEngineRevisionOperation(quiet)([...ARGS]);
    const once = readFileSync(statePath, "utf8");
    expect(await createAdoptEngineRevisionOperation(quiet)([...ARGS])).toEqual({ kind: "allow" });
    expect(readFileSync(statePath, "utf8")).toBe(once);
  });

  it("refuses without --reason, and refuses a self-hosted graph, writing nothing", async () => {
    expect(await createAdoptEngineRevisionOperation(quiet)([])).toMatchObject({ kind: "error", message: expect.stringContaining("requires --reason") });
    const statePath = installState({ schemaVersion: 1, kind: "self-hosted" });
    const before = readFileSync(statePath, "utf8");
    expect(await createAdoptEngineRevisionOperation(quiet)([...ARGS])).toMatchObject({ kind: "error", message: expect.stringContaining("self-hosted") });
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });

  it("refuses while a subagent is active, and re-checks under the lock", async () => {
    const statePath = installState(pinnedTo(OTHER));
    const before = readFileSync(statePath, "utf8");
    expect(await createAdoptEngineRevisionOperation(() => true)([...ARGS])).toMatchObject({ kind: "error", message: expect.stringContaining("subagent is active") });
    const { probe, observations } = appearsUnderTheLock();
    expect(await createAdoptEngineRevisionOperation(probe)([...ARGS])).toMatchObject({ kind: "error", message: expect.stringContaining("before the engine revision adoption could commit") });
    expect(observations()).toBe(2);
    expect(readFileSync(statePath, "utf8")).toBe(before);
  });
});
