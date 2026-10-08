/**
 * Spawn lifecycle reservation against a temporary
 * roster directory, plain fakes for the parent-session, launcher and witness
 * ports, and the production durable release ports wrapped to record (or fail)
 * each release: whatever a refusal interrupts, the claims ledger owns every
 * roster entry admission wrote, so the rollback leaves the roster and the
 * parent session exactly as they were — and a claim the ledger refuses has the
 * capability it just took released before the refusal reaches Pi.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { value } from "../fixtures/parse-result";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";
import { createRunDirectory } from "../../src/orchestration/run-directory-handle";
import type { SessionRunBinding } from "../../src/orchestration/session-run-bindings";
import { shutdownPiSession } from "../../../pi/session-shutdown";
import { dispatchPiSubagentStop } from "../../../pi/subagent-stop";
import { createPiChildWriteGrants } from "../../../pi/child-write-grant";
import { fsSessionRegistry, parseSessionId, type SessionTaskGraphPointerBinding } from "../../src/machine";
import type { AdmittedSpawnItem, SpawnAdmission } from "../../src/core/spawn-admission";
import type { SpawnEmissionExpectation } from "../../src/core/issued-emission-capability";
import { reservePiSpawnLifecycle, type PiSpawnLifecyclePorts } from "../../../pi/spawn-lifecycle";
import {
  claimPointerLease,
  claimRosterEntry,
  claimWitnessRun,
  claimWriteGrant,
  NO_SPAWN_CLAIMS,
  type SpawnClaims,
} from "../../../pi/spawn-claims";
import { createPiParentSessions, legacyReservationItem } from "../../../pi/spawn-reservation";
import { createTrustedReviewWitnesses, type TrustedReviewWitnesses } from "../../../pi/trusted-review-witness";
import { recordingDurableReleases } from "../fixtures/recording-durable-releases";
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
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const rawSessionId = "spawn-lifecycle-session";
const sessionId = parseSessionId(rawSessionId)!;
const toolCallId = "call-lifecycle-1";

type Admission = Extract<SpawnAdmission, { kind: "admit" }>;

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

/** An implementation item: under an active graph its slot is issued a write
 *  grant. Only its kind is read before the grant is claimed. */
const admittedImplementation = (task: string): AdmittedSpawnItem =>
  Object.freeze({
    item: Object.freeze({ agent: "code-implementer-agent", task }) as AdmittedSpawnItem["item"],
    taskExecutionSpawn: Object.freeze({ kind: "implementation" }) as unknown as AdmittedSpawnItem["taskExecutionSpawn"],
    emissionExpectation: NO_EMISSION,
  });

const admissionOf = (items: readonly AdmittedSpawnItem[], needsTaskGraphLifecycle = false): Admission =>
  Object.freeze({ kind: "admit", itemAdmissions: Object.freeze([...items]), needsTaskGraphLifecycle });

/** A pointer lease the batch already holds; never on disk, so its release
 *  succeeds without I/O. */
const HELD_POINTER = Object.freeze({
  directory: "/held",
  pointerName: "held.task_graph",
  registryName: "held.registry",
  target: "/held/graph.json",
  generationId: "held-generation",
  leaseId: "held-lease",
}) as unknown as SessionTaskGraphPointerBinding;

const fakePorts = (
  stage: PiEmissionLaunchBridge["stage"] = () => ({ ok: true }),
  options: Readonly<{
    graphExists?: boolean;
    failsRelease?: (call: string) => boolean;
    reviewWitnesses?: TrustedReviewWitnesses;
  }> = {},
) => {
  const removedToolCalls: string[] = [];
  const parentSessions = createPiParentSessions();
  const releases = recordingDurableReleases(options.failsRelease, new Set([HELD_POINTER]));
  const ports: PiSpawnLifecyclePorts = {
    parentSessions,
    emissionLaunchBridge: {
      probe: () => ({ kind: "available" }),
      stage,
      removeToolCall: (_session, call) => { removedToolCalls.push(call); },
      removeSession: () => undefined,
    },
    reviewWitnesses: options.reviewWitnesses ?? createTrustedReviewWitnesses(),
    durableClaimReleases: releases.durableClaimReleases,
    runtimeRevision: "r".repeat(64),
    graphExists: () => options.graphExists ?? false,
    enterGuard: () => undefined,
  };
  return { ports, parentSessions, removedToolCalls, releaseCalls: releases.calls };
};

type ReserveOptions = Readonly<{ graphActive?: boolean; held?: SpawnClaims }>;

const reserve = (input: unknown, admission: Admission, ports: PiSpawnLifecyclePorts, options: ReserveOptions = {}) =>
  reservePiSpawnLifecycle({
    event: { toolName: "subagent", input, toolCallId },
    cwd: root,
    sessionId: rawSessionId,
    safeSessionId: sessionId,
    admission,
    graph: { active: options.graphActive ?? false, path: graphPath(), spawnGraphPath: null },
  }, ports, options.held);

const graphPath = () => join(root, "graph.json");
const writeGraph = () => writeFileSync(graphPath(), "{}\n", "utf8");
const lifecycleRefusal = (cause: string) => ({
  block: true,
  reason: `Cannot record Loom subagent lifecycle evidence; refusing spawn: ${cause}`,
});

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

describe("a claim the ledger refuses during admission", () => {
  const rosterId = piSpawnRosterId(toolCallId, 0, "code-reviewer");
  const implementerRosterId = piSpawnRosterId(toolCallId, 0, "code-implementer-agent");
  const reviewInput = { agent: "code-reviewer", task: "Review A" };
  const implementInput = { agent: "code-implementer-agent", task: "Task ID: T1\nImplement it" };
  const grantFiles = () => {
    const directory = join(root, "subagents", "pi-write-grants");
    return existsSync(directory) ? readdirSync(directory) : [];
  };
  it("refuses a roster entry already claimed before marking it, releasing only the held entry", async () => {
    const { ports, parentSessions, releaseCalls } = fakePorts();
    const held = value(claimRosterEntry(NO_SPAWN_CLAIMS, legacyReservationItem(
      { rosterId, emissionLaunch: null, kind: "non-implementation" },
      "code-reviewer",
      null,
    )));
    const refusal = await reserve(reviewInput, admissionOf([admitted("Review A", NO_EMISSION)]), ports, { held });
    expect(refusal).toEqual(lifecycleRefusal(`spawn batch already holds claimed roster entry ${rosterId}`));
    // Nothing was taken for the refused claim; the rollback removes the held one.
    expect(releaseCalls).toEqual([`removeRosterEntry:${rosterId}`]);
    expect(roster()).toEqual([]);
    expect(parentSessions.get(sessionId)).toBeUndefined();
  });

  it("releases the pointer lease it just bound when a lease is already held", async () => {
    writeGraph();
    const { ports, parentSessions, releaseCalls } = fakePorts(undefined, { graphExists: true });
    const held = value(claimPointerLease(NO_SPAWN_CLAIMS, HELD_POINTER));
    const refusal = await reserve(reviewInput, admissionOf([admitted("Review A", NO_EMISSION)], true), ports, { held });
    expect(refusal).toEqual(lifecycleRefusal("spawn batch already holds a claimed task-graph pointer lease"));
    // The direct release of the bound lease runs first, then the rollback.
    expect(releaseCalls).toEqual([
      expect.stringMatching(/^releasePointer:(?!held-lease)/),
      `removeRosterEntry:${rosterId}`,
      "releasePointer:held-lease",
    ]);
    // Released for real: the session pointer the bound lease wrote is gone.
    expect(existsSync(join(root, "subagents", `${sessionId}.task_graph`))).toBe(false);
    expect(roster()).toEqual([]);
    expect(parentSessions.get(sessionId)).toBeUndefined();
  });

  it("carries the bound lease's failed direct release in its refusal", async () => {
    writeGraph();
    const { ports, releaseCalls } = fakePorts(undefined, {
      graphExists: true,
      failsRelease: (call) => call.startsWith("releasePointer:") && call !== "releasePointer:held-lease",
    });
    const held = value(claimPointerLease(NO_SPAWN_CLAIMS, HELD_POINTER));
    const refusal = await reserve(reviewInput, admissionOf([admitted("Review A", NO_EMISSION)], true), ports, { held });
    expect(refusal).toEqual(lifecycleRefusal(
      "spawn batch already holds a claimed task-graph pointer lease " +
        "Cleanup failures: roll back task-graph pointer: releasePointer unavailable",
    ));
    expect(releaseCalls[0]).toMatch(/^releasePointer:(?!held-lease)/);
  });

  it("revokes the write grant it just issued when the slot already holds one", async () => {
    writeGraph();
    const { ports, parentSessions, releaseCalls } = fakePorts();
    const held = value(claimWriteGrant(NO_SPAWN_CLAIMS, { slot: 0, token: "held" }));
    const refusal = await reserve(implementInput, admissionOf([admittedImplementation(implementInput.task)]), ports, {
      graphActive: true,
      held,
    });
    expect(refusal).toEqual(lifecycleRefusal("spawn item 1 already holds a claimed write grant"));
    expect(releaseCalls).toEqual([
      expect.stringMatching(/^revokeGrant:[0-9a-f]{64}$/),
      "revokeGrant:held",
      `removeRosterEntry:${implementerRosterId}`,
    ]);
    // Revoked for real: the issued grant's record is gone.
    expect(grantFiles()).toEqual([]);
    expect(roster()).toEqual([]);
    expect(parentSessions.get(sessionId)).toBeUndefined();
  });

  it("carries the issued grant's failed direct revocation in its refusal", async () => {
    writeGraph();
    const { ports, releaseCalls } = fakePorts(undefined, {
      failsRelease: (call) => call.startsWith("revokeGrant:") && call !== "revokeGrant:held",
    });
    const held = value(claimWriteGrant(NO_SPAWN_CLAIMS, { slot: 0, token: "held" }));
    const refusal = await reserve(implementInput, admissionOf([admittedImplementation(implementInput.task)]), ports, {
      graphActive: true,
      held,
    });
    expect(refusal).toEqual(lifecycleRefusal(
      "spawn item 1 already holds a claimed write grant " +
        "Cleanup failures: revoke write grant for spawn item 1: revokeGrant unavailable",
    ));
    expect(releaseCalls[0]).toMatch(/^revokeGrant:[0-9a-f]{64}$/);
    // The failed revocation left the issued grant's record in place.
    expect(grantFiles()).toHaveLength(1);
  });
});

describe("a capability a failed compensation orphans", () => {
  const reviewInput = { agent: "code-reviewer", task: "Review A" };
  const implementInput = { agent: "code-implementer-agent", task: "Task ID: T1\nImplement it" };
  const grantFiles = () => {
    const directory = join(root, "subagents", "pi-write-grants");
    return existsSync(directory) ? readdirSync(directory) : [];
  };
  const shutdown = (ports: PiSpawnLifecyclePorts) =>
    shutdownPiSession(rawSessionId, {
      parentSessions: ports.parentSessions,
      childWriteGrants: createPiChildWriteGrants(),
      emissionLaunchBridge: ports.emissionLaunchBridge,
      reviewWitnesses: ports.reviewWitnesses,
      durableClaimReleases: ports.durableClaimReleases,
    });
  const orphans = (parentSessions: ReturnType<typeof createPiParentSessions>) =>
    [...parentSessions.get(sessionId)?.orphanedClaims ?? []];

  /** Refuse an implementation spawn whose slot already holds a grant while
   *  every revocation of the issued one fails until `heal` is called. */
  const refusedGrantCompensation = async () => {
    writeGraph();
    let failing = true;
    const fake = fakePorts(undefined, {
      failsRelease: (call) => failing && call.startsWith("revokeGrant:") && call !== "revokeGrant:held",
    });
    const held = value(claimWriteGrant(NO_SPAWN_CLAIMS, { slot: 0, token: "held" }));
    const refusal = await reserve(implementInput, admissionOf([admittedImplementation(implementInput.task)]), fake.ports, {
      graphActive: true,
      held,
    });
    expect(refusal?.reason).toContain("Cleanup failures: revoke write grant for spawn item 1: revokeGrant unavailable");
    return { ...fake, heal: () => { failing = false; } };
  };

  it("keeps a write grant whose compensating revocation failed as session debt, then shutdown revokes it", async () => {
    const { ports, parentSessions, releaseCalls, heal } = await refusedGrantCompensation();
    const issuedToken = releaseCalls[0]!.slice("revokeGrant:".length);
    expect(orphans(parentSessions)).toEqual([{ kind: "write-grant", grant: { slot: 0, token: issuedToken } }]);
    expect(grantFiles()).toHaveLength(1);

    heal();
    await shutdown(ports);
    expect(releaseCalls.at(-1)).toBe(`revokeGrant:${issuedToken}`);
    expect(grantFiles()).toEqual([]);
    expect(parentSessions.get(sessionId)).toBeUndefined();
  });

  it("retries an orphaned write grant at the session's next settlement", async () => {
    const { ports, parentSessions, releaseCalls, heal } = await refusedGrantCompensation();
    const issuedToken = releaseCalls[0]!.slice("revokeGrant:".length);
    heal();
    const response = await dispatchPiSubagentStop(
      { toolName: "subagent", toolCallId: "call-unrelated", input: {}, content: [], details: { results: [] }, isError: false } as
        unknown as ToolResultEvent,
      { sessionManager: { getSessionId: () => rawSessionId } },
      {
        parentSessions,
        emissionLaunchBridge: ports.emissionLaunchBridge,
        reviewWitnesses: ports.reviewWitnesses,
        durableClaimReleases: ports.durableClaimReleases,
      },
    );
    expect(response).toBeUndefined();
    expect(releaseCalls.at(-1)).toBe(`revokeGrant:${issuedToken}`);
    expect(grantFiles()).toEqual([]);
    expect(parentSessions.get(sessionId)).toBeUndefined();
  });

  it("keeps a pointer lease whose release keeps failing visible as shutdown debt", async () => {
    writeGraph();
    const { ports, parentSessions } = fakePorts(undefined, {
      graphExists: true,
      failsRelease: (call) => call.startsWith("releasePointer:") && call !== "releasePointer:held-lease",
    });
    const held = value(claimPointerLease(NO_SPAWN_CLAIMS, HELD_POINTER));
    await reserve(reviewInput, admissionOf([admitted("Review A", NO_EMISSION)], true), ports, { held });
    const [orphan] = orphans(parentSessions);
    expect(orphan?.kind).toBe("pointer-lease");

    const failure = "release orphaned task-graph pointer lease: releasePointer unavailable";
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(shutdown(ports)).rejects.toThrow(`Loom Pi session shutdown cleanup failed: ${failure}`);
    await expect(shutdown(ports)).rejects.toThrow(`Loom Pi session shutdown cleanup failed: ${failure}`);
    expect(orphans(parentSessions)).toEqual([orphan]);
    // The lease it bound is still on disk: nothing pretended to release it.
    expect(existsSync(join(root, "subagents", `${sessionId}.task_graph`))).toBe(true);
  });
});

describe("a witness run the ledger refuses during admission", () => {
  const runId = "run.lifecycle-witness";
  const contextDigest = "a".repeat(64);
  const standaloneTask = "Review the change\nLOOM_REVIEW_CONTEXT: standalone\n" +
    `LOOM_REQUEST_ID: request:reviewer:1\nLOOM_CONTEXT_DIGEST: ${contextDigest}\n`;
  /** A review run the batch already holds as its witness binding. */
  const HELD_RUN = Object.freeze({
    runId: "run.held",
    runsRoot: "/held-runs",
    runDirectory: "/held-runs/run.held",
    requestIds: Object.freeze([]),
    resultDigest: null,
  }) as unknown as SessionRunBinding;

  /** A Standalone Review Run Directory with one issued code-reviewer
   *  request, named to the lifecycle as the explicit run. The spawn is
   *  emission-enabled, so admission correlates the request against the
   *  issued markers without re-rendering the task — no program registration
   *  is read before the witness binding is claimed. */
  const issuedStandaloneRun = async (): Promise<void> => {
    const runsRoot = join(root, ".claude", "reviews", "review-and-fix-runs");
    mkdirSync(runsRoot, { recursive: true });
    const created = createRunDirectory(runsRoot, runId);
    if (!created.ok) throw new Error(created.error.message);
    const reserved = await created.value.reserveRequest(
      agentRequestAuthority(runId, { program: "standalone-review", contextDigest }),
    );
    if (!reserved.ok) throw new Error(reserved.error.message);
    process.env.LOOM_ORCHESTRATION_RUNS_ROOT = runsRoot;
    process.env.LOOM_ORCHESTRATION_RUN_DIR = created.value.runDirectory;
  };

  /** The real witness aggregate, with every retraction recorded (by run id)
   *  and failing while `failing`. */
  const retractionWitnesses = (failing: boolean) => {
    const real = createTrustedReviewWitnesses();
    const retracted: string[] = [];
    const witnesses: TrustedReviewWitnesses = {
      ...real,
      retract: (session, binding) => {
        retracted.push(binding.runId);
        if (failing) throw new Error("retract unavailable");
        real.retract(session, binding);
      },
    };
    return { witnesses, retracted };
  };

  const reserveStandalone = async (failing: boolean) => {
    await issuedStandaloneRun();
    const { witnesses, retracted } = retractionWitnesses(failing);
    const { ports, parentSessions } = fakePorts(undefined, { reviewWitnesses: witnesses });
    const held = value(claimWitnessRun(NO_SPAWN_CLAIMS, HELD_RUN));
    const refusal = await reserve(
      { agent: "code-reviewer", task: standaloneTask },
      admissionOf([admitted(standaloneTask, REVIEWER_EMISSION)]),
      ports,
      { held },
    );
    return { refusal, retracted, witnesses, parentSessions };
  };

  it("retracts the run it just bound as current, then rolls back the held one", async () => {
    const { refusal, retracted, witnesses, parentSessions } = await reserveStandalone(false);
    expect(refusal).toEqual(lifecycleRefusal("spawn batch already holds claimed review run run.held"));
    // The compensation retracts the newly bound run before the rollback
    // retracts the held binding.
    expect(retracted).toEqual([runId, "run.held"]);
    // Retracted for real: the refused spawn left no run current for the root.
    await expect(witnesses.verify({ cwd: root, sessionId: rawSessionId }))
      .rejects.toThrow(`no request-bound Loom captures were witnessed for Pi session ${rawSessionId}`);
    expect(roster()).toEqual([]);
    expect(parentSessions.get(sessionId)).toBeUndefined();
  });

  it("carries a failed compensating retraction in its refusal and orphans no durable debt", async () => {
    const { refusal, retracted, parentSessions } = await reserveStandalone(true);
    expect(refusal).toEqual(lifecycleRefusal(
      "spawn batch already holds claimed review run run.held " +
        `Cleanup failures: retract unwitnessed review run ${runId}: retract unavailable ` +
        "Cleanup failures: retract unwitnessed review run run.held: retract unavailable",
    ));
    expect(retracted).toEqual([runId, "run.held"]);
    // A witness binding is process-local: shutdown's witness forget
    // discharges it, so the session keeps no orphaned claim for it.
    expect(parentSessions.get(sessionId)).toBeUndefined();
  });
});
