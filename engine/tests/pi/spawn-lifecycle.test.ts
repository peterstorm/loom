/**
 * Spawn lifecycle reservation outside orchestration (no task graph, no run
 * directory), against a temporary roster directory and plain fakes for the
 * parent-session, launcher and witness ports: whatever a refusal interrupts,
 * the claims ledger owns every roster entry admission wrote, so the rollback
 * leaves the roster and the parent session exactly as they were.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { fsSessionRegistry, parseSessionId } from "../../src/machine";
import type { AdmittedSpawnItem, SpawnAdmission } from "../../src/core/spawn-admission";
import type { SpawnEmissionExpectation } from "../../src/core/issued-emission-capability";
import { reservePiSpawnLifecycle, type PiSpawnLifecyclePorts } from "../../../pi/spawn-lifecycle";
import { createPiParentSessions } from "../../../pi/spawn-reservation";
import { createTrustedReviewWitnesses } from "../../../pi/trusted-review-witness";
import { piSpawnRosterId } from "../../../pi/tool-input";
import type { PiEmissionLaunchBridge } from "../../../pi/emission-launch-bridge";

const ENV_KEYS = ["LOOM_SUBAGENT_DIR", "LOOM_ORCHESTRATION_RUNS_ROOT", "LOOM_ORCHESTRATION_RUN_DIR"] as const;
let root: string;
let previous: ReadonlyArray<readonly [string, string | undefined]>;

beforeEach(() => {
  root = canonicalTempDir("loom-pi-spawn-lifecycle-");
  previous = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  process.env.LOOM_SUBAGENT_DIR = join(root, "subagents");
  delete process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
  delete process.env.LOOM_ORCHESTRATION_RUN_DIR;
});

afterEach(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const rawSessionId = "spawn-lifecycle-session";
const sessionId = parseSessionId(rawSessionId)!;
const toolCallId = "call-lifecycle-1";

const NO_EMISSION: SpawnEmissionExpectation = Object.freeze({ kind: "no-emission-tool" });
/** A reviewer-payload emission expectation: the lifecycle derives a launch
 *  slot from the live input for it. Only its binding kind is read before
 *  staging. */
const REVIEWER_EMISSION = Object.freeze({
  kind: "emission-enabled",
  binding: { kind: { kind: "reviewer-payload" } },
  contextDigest: "c".repeat(64),
  route: { provider: "fixture", model: "fixture" },
}) as unknown as SpawnEmissionExpectation;

const admitted = (task: string, emissionExpectation: SpawnEmissionExpectation): AdmittedSpawnItem =>
  Object.freeze({
    item: Object.freeze({ agent: "code-reviewer", task }) as AdmittedSpawnItem["item"],
    taskExecutionSpawn: Object.freeze({ kind: "non-implementation" }),
    emissionExpectation,
  });

const admissionOf = (items: readonly AdmittedSpawnItem[]): Extract<SpawnAdmission, { kind: "admit" }> =>
  Object.freeze({ kind: "admit", itemAdmissions: Object.freeze([...items]), needsTaskGraphLifecycle: false });

const fakePorts = (stage: PiEmissionLaunchBridge["stage"] = () => ({ ok: true })) => {
  const removedToolCalls: string[] = [];
  const parentSessions = createPiParentSessions();
  const ports: PiSpawnLifecyclePorts = {
    parentSessions,
    emissionLaunchBridge: {
      probe: () => ({ kind: "available" }),
      stage,
      removeToolCall: (_session, call) => { removedToolCalls.push(call); },
      removeSession: () => undefined,
    },
    reviewWitnesses: createTrustedReviewWitnesses(),
    runtimeRevision: "r".repeat(64),
    graphExists: () => false,
    enterGuard: () => undefined,
  };
  return { ports, parentSessions, removedToolCalls };
};

const reserve = (input: unknown, admission: Extract<SpawnAdmission, { kind: "admit" }>, ports: PiSpawnLifecyclePorts) =>
  reservePiSpawnLifecycle({
    event: { toolName: "subagent", input, toolCallId },
    cwd: root,
    sessionId: rawSessionId,
    safeSessionId: sessionId,
    admission,
    graph: { active: false, path: join(root, "absent-graph.json"), spawnGraphPath: null },
  }, ports);

const roster = () => fsSessionRegistry.readActiveRoster(sessionId);

describe("reservePiSpawnLifecycle", () => {
  it("reserves and records every roster entry of an admitted batch", async () => {
    const { ports, parentSessions } = fakePorts();
    const input = { tasks: [{ agent: "code-reviewer", task: "Review A" }, { agent: "code-reviewer", task: "Review B" }] };
    const refusal = await reserve(input, admissionOf([admitted("Review A", NO_EMISSION), admitted("Review B", NO_EMISSION)]), ports);
    expect(refusal).toBeUndefined();
    const ids = [0, 1].map((slot) => piSpawnRosterId(toolCallId, slot, "code-reviewer"));
    expect(roster()).toEqual(ids);
    expect(parentSessions.get(sessionId)?.spawnReservations.get(toolCallId)?.items.map(({ rosterId }) => rosterId)).toEqual(ids);
  });

  it("owns a slot's roster entry before marking it, so a failure building that slot's item orphans nothing", async () => {
    // A single-item input cannot address launch slot 2: deriving the second
    // slot's emission launch throws. Marked first and claimed after, that
    // slot's entry stayed on the roster with no rollback step to remove it.
    const { ports, parentSessions } = fakePorts();
    const input = { agent: "code-reviewer", task: "Review A" };
    const refusal = await reserve(input, admissionOf([admitted("Review A", NO_EMISSION), admitted("Review B", REVIEWER_EMISSION)]), ports);
    expect(refusal).toEqual({
      block: true,
      reason: "Cannot record Loom subagent lifecycle evidence; refusing spawn: single Pi subagent launch cannot address slot 1",
    });
    expect(roster()).toEqual([]);
    expect(parentSessions.get(sessionId)).toBeUndefined();
  });

  it("rolls back every roster entry when launch staging refuses, owing no cleanup debt", async () => {
    const { ports, parentSessions, removedToolCalls } = fakePorts(() => ({ ok: false, reason: "stage refused" }));
    const input = { tasks: [{ agent: "code-reviewer", task: "Review A" }, { agent: "code-reviewer", task: "Review B" }] };
    const refusal = await reserve(input, admissionOf([admitted("Review A", NO_EMISSION), admitted("Review B", REVIEWER_EMISSION)]), ports);
    expect(refusal).toEqual({
      block: true,
      reason: "Cannot record Loom subagent lifecycle evidence; refusing spawn: stage refused",
    });
    expect(roster()).toEqual([]);
    // Launches were never staged, so the ledger plans no launch removal.
    expect(removedToolCalls).toEqual([]);
    expect(parentSessions.get(sessionId)).toBeUndefined();
  });
});
