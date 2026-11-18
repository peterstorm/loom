/**
 * Carried Review Evidence (ADR-0089, loom#213 Cause 1b): a Wave Gate restart
 * carries every accepted reviewer slot into the replacement run by reference
 * and reissues only the exhausted slots and spec-check.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { BASE_WAVE_REVIEW_AGENTS, ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS } from "../../src/core/agent-catalog-projections";
import { preserveAcceptedReviewRunFindings } from "../../src/core/findings";
import type {
  CurrentAcceptedReviewAuthority,
  CurrentDraftFinding,
  CurrentReviewRun,
  CurrentReviewRunEvidence,
  IssuedReviewRunSlotAuthority,
} from "../../src/core/findings-shape";
import { captureKey } from "../../src/core/harness-capture";
import { parseArtifactDigest, parseOrchestrationRunId, type AgentRequestAuthority } from "../../src/core/orchestration-contract";
import { REVIEWER_PAYLOAD_EXAMPLE_V2, REVIEWER_PROTOCOL_V2, WAVE_REVIEWER_PROTOCOL_V4 } from "../../src/core/reviewer-contract";
import { reviewedWorkspaceObservation, type ReviewedWorkspaceObservation } from "../../src/core/reviewed-workspace";
import { prepareExhaustedWaveGateRestart, sameRestartRegistration, type RestartCarryObservation } from "../../src/core/wave-gate-replacement";
import type { RegisteredWaveGateProgram, WaveReviewCarryAudit } from "../../src/core/wave-gate-program";
import { issuedWaveReviewRosters } from "../../src/core/wave-review-authority";
import { issuedRoles, registeredCarry } from "../../src/core/wave-review-carry-plan";
import { parseWaveReviewCarryAudit } from "../../src/core/wave-review-carry-audit";
import { parseSubjectDigest } from "../../src/core/review-subject";
import {
  publishedRostersOf,
  rebindCarriedReviewRun,
  waveAcceptanceProblem,
  type CarriedRunBinding,
} from "../../src/core/wave-review-carry";
import { parseTaskGraph } from "../../src/state-file-wire";
import type { Task, TaskCommonMetadata, TaskGraph } from "../../src/types";
import type { ReviewerProtocolDescriptor } from "../../src/core/reviewer-contract";
import { activeWaveGateFixture, graphFixture, taskFixture } from "../fixtures/task-lifecycle";
import { value } from "../fixtures/parse-result";
import { withOrigin } from "../fixtures/wave-gate-origin";

const DIGEST_A = "a".repeat(64);
const EPOCH_A = "e".repeat(64);
const PACKET_A = "1".repeat(64);
const PACKET_T1 = "2".repeat(64);
const PACKET_B = "3".repeat(64);
const EPOCH_B = "4".repeat(64);
const DIGEST_B = "b".repeat(64);
const ROSTER = BASE_WAVE_REVIEW_AGENTS;
const EXHAUSTED = ROSTER[2]!;
/** A Subject Digest for T2's rebinding: the fixture runs predate the digest, so none is compared. */
const SUBJECT_T2 = parseSubjectDigest("5".repeat(64))!;

const hex = (seed: number, length: number): string => seed.toString(16).padStart(length, "0");
const observe = (taskId: string, scope: readonly string[], content = "export const x = 1;\n"): ReviewedWorkspaceObservation =>
  value(reviewedWorkspaceObservation(taskId, scope, scope.map((path) => ({ path, bytes: Buffer.from(`${path}:${content}`) }))));

function issuedSlot(agent: string, seed: number, attempted: 1 | 2 = 1): IssuedReviewRunSlotAuthority {
  return { agent, slot_id: `wave-slot:${hex(seed, 32)}`, attempted,
    request_id: `wave-request:${hex(seed, 32)}:${attempted}`, context_digest: hex(seed, 64) };
}

const CURRENT_CRITICAL: CurrentDraftFinding = {
  ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings.find(({ severity }) => severity === "critical")!,
  file: "src/t2.ts", line: 1, protocolVersion: 2,
};

function evidenceFor(slot: IssuedReviewRunSlotAuthority, findings: readonly CurrentDraftFinding[] = []): CurrentReviewRunEvidence {
  return { protocolVersion: 2, agent: slot.agent, slot_id: slot.slot_id, attempted: slot.attempted,
    request_id: slot.request_id, context_digest: slot.context_digest, prior_assessments: [], new_findings: findings };
}

/** Run A's Review Run over T2: every roster slot but `exhausted` accepted. */
function predecessorRun(
  accepted: readonly string[],
  overrides: Partial<CurrentReviewRun> = {},
  bytes: ReviewedWorkspaceObservation = observe("T2", ["src/t2.ts"]),
): CurrentReviewRun {
  const slots = ROSTER.map((agent, index) => issuedSlot(agent, index + 1, accepted.includes(agent) ? 1 : 2));
  const [first, ...rest] = slots;
  return {
    generation: 0, packet_id: PACKET_A, head_sha: EPOCH_A,
    expected_agents: ROSTER, prior_finding_ids: [],
    reviewer_protocol: WAVE_REVIEWER_PROTOCOL_V4,
    evidence: slots.filter(({ agent }) => accepted.includes(agent))
      .map((slot) => evidenceFor(slot, slot.agent === ROSTER[0] ? [CURRENT_CRITICAL] : [])),
    slot_authority: [first!, ...rest],
    workspace_scope: bytes.scope, workspace_head_sha: bytes.headSha,
    wave_gate_run_id: "run.previous", wave_gate_authority_digest: DIGEST_A,
    ...overrides,
  };
}

const implemented = (id: string, extra: Partial<TaskCommonMetadata> = {}): Task =>
  taskFixture({ id, description: `${id} work`, agent: "code-implementer-agent", wave: 1, depends_on: [],
    status: "implemented", file_list: [`src/${id.toLowerCase()}.ts`], files_modified: [`src/${id.toLowerCase()}.ts`],
    review_generation: 0, findings: [], critical_findings: [], advisory_findings: [], ...extra });

/** Run A's acceptance of T1's whole roster. */
function acceptanceT1(overrides: Partial<CurrentAcceptedReviewAuthority> = {}): CurrentAcceptedReviewAuthority {
  const bytes = observe("T1", ["src/t1.ts"]);
  return { generation: 0, packet_id: PACKET_T1, head_sha: bytes.headSha, scope: bytes.scope,
    run_id: "run.previous", authority_digest: DIGEST_A, reviewer_protocol: WAVE_REVIEWER_PROTOCOL_V4, ...overrides };
}

/** T1 accepted every slot in run A; T2 accepted all but one slot, which exhausted attempt 2. */
function exhaustedWave(input: Readonly<{
  t1?: Partial<Task>;
  run?: CurrentReviewRun;
}> = {}): TaskGraph {
  const t1 = implemented("T1", { review_status: "passed", accepted_review_authority: acceptanceT1(), ...input.t1 });
  const t2 = implemented("T2", {
    review_status: "evidence_capture_failed", review_error: "attempt 2 exhausted", review_evidence_failures: [EXHAUSTED],
    review_run: input.run ?? predecessorRun(ROSTER.filter((agent) => agent !== EXHAUSTED)),
  });
  return {
    ...graphFixture([t1, t2]),
    active_wave_gate: activeWaveGateFixture({ runId: "run.previous", wave: 1, authorityDigest: DIGEST_A }),
    wave_review_epoch: { runId: value(parseOrchestrationRunId("run.previous")), wave: 1, batchEpoch: value(parseArtifactDigest(EPOCH_A)) },
  };
}

const previousRegistration = (reviewerProtocol: ReviewerProtocolDescriptor = WAVE_REVIEWER_PROTOCOL_V4): RegisteredWaveGateProgram => ({
  schemaVersion: 2, reviewerProtocol, kind: "wave-gate", input: { wave: 1 }, taskIds: ["T1", "T2"], authorityDigest: DIGEST_A,
});

const observation = (overrides: Partial<RestartCarryObservation> = {}): RestartCarryObservation => ({
  workspaces: [observe("T1", ["src/t1.ts"]), observe("T2", ["src/t2.ts"])],
  issuedRosters: new Map([["T2", ROSTER], ["T1", ROSTER]]),
  ...overrides,
});

function restart(state: TaskGraph, carry = observation(), previous = previousRegistration()) {
  const run = state.tasks.find(({ id }) => id === "T2")!.review_run!;
  const exhausted = new Set((run.slot_authority ?? []).filter(({ attempted }) => attempted === 2)
    .map(({ slot_id }) => captureKey(slot_id, 2)));
  const prepared = prepareExhaustedWaveGateRestart(state, "run.previous", previous, "run.next", "/runs", exhausted, carry);
  if (!prepared.ok) throw new Error(prepared.message);
  return prepared.value;
}

const accepted = ROSTER.filter((agent) => agent !== EXHAUSTED);

describe("Wave Gate restart records the carry plan along the restart lineage", () => {
  it("carries a fully accepted Task untouched and keeps a partly accepted Task's run; only the exhausted slot is left to issue", () => {
    const state = exhaustedWave();
    const prepared = restart(state);
    expect(prepared.registration.restart?.carry).toEqual({
      lineage: [{ runId: "run.previous", authorityDigest: DIGEST_A }],
      carried: [
        { kind: "accepted-task", taskId: "T1", roster: ROSTER, acceptance: { runId: "run.previous", authorityDigest: DIGEST_A } },
        { kind: "accepted-slots", taskId: "T2", agents: accepted },
      ],
    });
    expect(prepared.graph.tasks[0]).toEqual(state.tasks[0]);
    const t2 = prepared.graph.tasks[1]!;
    expect(t2.review_run).toEqual(state.tasks[1]!.review_run);
    expect(t2).toMatchObject({ review_status: "pending" });
    expect(t2.review_error).toBeUndefined();
    expect(t2.review_evidence_failures).toBeUndefined();
    expect(t2.findings).toEqual([]);
    expect(prepared.graph.wave_review_epoch).toBeUndefined();
    expect(issuedWaveReviewRosters([{ taskId: "T1", roster: ROSTER }, { taskId: "T2", roster: ROSTER }],
      registeredCarry(prepared.registration))).toEqual([{ taskId: "T2", roster: [EXHAUSTED] }]);
  });

  it("is re-derived identically, and a different carry plan is a different registration", () => {
    const state = exhaustedWave();
    const left = restart(state).registration;
    expect(sameRestartRegistration(left, restart(state).registration)).toBe(true);
    const fullReset = restart(state, observation({ workspaces: [] })).registration;
    expect(sameRestartRegistration(left, fullReset)).toBe(false);
  });

  it("a v2-registered predecessor never carries into the v4 replacement (ADR-0084): today's full reset", () => {
    const run = predecessorRun(accepted, { reviewer_protocol: REVIEWER_PROTOCOL_V2 });
    const prepared = restart(exhaustedWave({ run, t1: { accepted_review_authority: acceptanceT1({ reviewer_protocol: REVIEWER_PROTOCOL_V2 }) } }),
    observation(), previousRegistration(REVIEWER_PROTOCOL_V2));
    expect(prepared.registration.restart).toEqual({ previousRunId: "run.previous", exhaustedSlots: [`T2/${EXHAUSTED}`] });
    expect(prepared.graph.tasks[1]!.review_run).toBeUndefined();
    expect(prepared.graph.tasks[1]!.findings).toMatchObject([{ ...CURRENT_CRITICAL, review_packet_id: PACKET_A }]);
  });

  it("a fully accepted Task whose derived roster differs from the roster its run issued is reissued", () => {
    const prepared = restart(exhaustedWave(), observation({ issuedRosters: new Map([["T1", ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS]]) }));
    expect(prepared.registration.restart?.carry?.carried).toEqual([{ kind: "accepted-slots", taskId: "T2", agents: accepted }]);
  });

  it("an accepted Task carried from an earlier run carries again only while that run stays on the lineage", () => {
    const earlier = { runId: "run.earliest", authorityDigest: "c".repeat(64) };
    const t1 = { accepted_review_authority: acceptanceT1({ run_id: earlier.runId, authority_digest: earlier.authorityDigest }) };
    const chained = withOrigin(previousRegistration(), { restart: { previousRunId: "run.earliest",
      exhaustedSlots: ["T2/x"], carry: { lineage: [earlier], carried: [{ kind: "accepted-task", taskId: "T1", roster: ROSTER, acceptance: earlier }] } } });
    const prepared = restart(exhaustedWave({ t1 }), observation({ issuedRosters: new Map() }), chained);
    expect(prepared.registration.restart?.carry).toEqual({
      lineage: [earlier, { runId: "run.previous", authorityDigest: DIGEST_A }],
      carried: [
        { kind: "accepted-task", taskId: "T1", roster: ROSTER, acceptance: earlier },
        { kind: "accepted-slots", taskId: "T2", agents: accepted },
      ],
    });
    const unrelated = restart(exhaustedWave({ t1 }), observation({ issuedRosters: new Map() }));
    expect(unrelated.registration.restart?.carry?.carried.map(({ taskId }) => taskId)).toEqual(["T2"]);
  });
});

describe("carry admissibility: any drift means the Task is issued in full", () => {
  type Drift = "head" | "scope" | "protocol" | "acceptance-generation" | "acceptance-head";
  const drifted = (drift: Drift): Readonly<{ state: TaskGraph; carry: RestartCarryObservation }> => {
    switch (drift) {
      case "head":
        return { state: exhaustedWave(), carry: observation({ workspaces: [observe("T1", ["src/t1.ts"]), observe("T2", ["src/t2.ts"], "changed")] }) };
      case "scope": {
        const state = exhaustedWave();
        const t2 = { ...state.tasks[1]!, files_modified: ["src/t2.ts", "src/t2b.ts"] };
        return { state: { ...state, tasks: [state.tasks[0]!, t2] },
          carry: observation({ workspaces: [observe("T1", ["src/t1.ts"]), observe("T2", ["src/t2.ts", "src/t2b.ts"])] }) };
      }
      case "protocol":
        return { state: exhaustedWave({ run: predecessorRun(accepted, { reviewer_protocol: REVIEWER_PROTOCOL_V2 }) }), carry: observation() };
      case "acceptance-generation":
        return { state: exhaustedWave({ t1: { review_generation: 1 } }), carry: observation() };
      case "acceptance-head":
        return { state: exhaustedWave(), carry: observation({ workspaces: [observe("T1", ["src/t1.ts"], "changed"), observe("T2", ["src/t2.ts"])] }) };
      default: {
        const unreachable: never = drift;
        throw new Error(`unknown drift ${String(unreachable)}`);
      }
    }
  };
  const carriedIds = (drift: Drift): readonly string[] => {
    const { state, carry } = drifted(drift);
    return restart(state, carry).registration.restart?.carry?.carried.map(({ taskId }) => taskId) ?? [];
  };

  it("drift in the reviewed bytes, scope or protocol of a partly accepted run issues that Task in full", () => {
    fc.assert(fc.property(fc.constantFrom<Drift>("head", "scope", "protocol"), (drift) => {
      expect(carriedIds(drift)).toEqual(["T1"]);
    }));
  });

  it("drift in a fully accepted Task's generation or bytes reissues it", () => {
    fc.assert(fc.property(fc.constantFrom<Drift>("acceptance-generation", "acceptance-head"), (drift) => {
      expect(carriedIds(drift)).toEqual(["T2"]);
    }));
  });

  it("a restart carries exactly the accepted slots, for any accepted subset", () => {
    fc.assert(fc.property(fc.subarray([...ROSTER], { minLength: 1, maxLength: ROSTER.length - 1 }), (acceptedAgents) => {
      const carried = restart(exhaustedWave({ run: predecessorRun(acceptedAgents) })).registration.restart?.carry?.carried;
      expect(carried?.find(({ taskId }) => taskId === "T2")).toEqual({ kind: "accepted-slots", taskId: "T2", agents: acceptedAgents });
    }));
  });
});

describe("issuedRoles: what a replacement issues for one Task", () => {
  it("issued and carried roles partition the roster, in roster order, for any carried subset", () => {
    fc.assert(fc.property(fc.subarray([...ROSTER], { minLength: 1 }), (carriedAgents) => {
      const agents = carriedAgents as unknown as readonly [string, ...string[]];
      const issued = issuedRoles(ROSTER, { kind: "accepted-slots", taskId: "T2", agents });
      expect(issued.filter((role) => carriedAgents.includes(role))).toEqual([]);
      expect(ROSTER.filter((role) => issued.includes(role) || carriedAgents.includes(role))).toEqual(ROSTER);
      expect(issued).toEqual(ROSTER.filter((role) => !carriedAgents.includes(role)));
    }));
  });

  it("issues the whole roster when nothing carries and nothing for a Task whose whole roster carries", () => {
    expect(issuedRoles(ROSTER, undefined)).toEqual(ROSTER);
    expect(issuedRoles(ROSTER, { kind: "accepted-task", taskId: "T1", roster: ROSTER,
      acceptance: { runId: "run.previous", authorityDigest: DIGEST_A } })).toEqual([]);
  });

  it("issuedWaveReviewRosters drops a Task with nothing left to issue", () => {
    const carry = registeredCarry(restart(exhaustedWave()).registration);
    expect(issuedWaveReviewRosters([{ taskId: "T1", roster: ROSTER }, { taskId: "T2", roster: ROSTER }], carry))
      .toEqual([{ taskId: "T2", roster: [EXHAUSTED] }]);
  });
});

describe("a restart names each reviewed Task it did not carry, and why", () => {
  it("names nothing when every reviewed Task carries", () => {
    expect(restart(exhaustedWave()).notCarried).toEqual([]);
  });

  it("names drift in the reviewed bytes", () => {
    const prepared = restart(exhaustedWave(), observation({ workspaces: [observe("T1", ["src/t1.ts"]), observe("T2", ["src/t2.ts"], "changed")] }));
    expect(prepared.notCarried).toEqual([{ taskId: "T2", reason: { kind: "drift", fields: ["head"] } }]);
  });

  it("names drift in generation and roster of a whole-roster acceptance", () => {
    expect(restart(exhaustedWave({ t1: { review_generation: 1 } })).notCarried)
      .toEqual([{ taskId: "T1", reason: { kind: "drift", fields: ["generation"] } }]);
    expect(restart(exhaustedWave(), observation({ issuedRosters: new Map([["T1", ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS]]) })).notCarried)
      .toEqual([{ taskId: "T1", reason: { kind: "drift", fields: ["roster"] } }]);
  });

  it("names an unobserved and a refused workspace observation, with the refusal", () => {
    expect(restart(exhaustedWave(), observation({ workspaces: [observe("T1", ["src/t1.ts"])] })).notCarried)
      .toEqual([{ taskId: "T2", reason: { kind: "workspace-unobserved" } }]);
    expect(restart(exhaustedWave(), observation({ workspaces: [observe("T1", ["src/t1.ts"]), observe("T2", ["src/other.ts"])] })).notCarried)
      .toEqual([{ taskId: "T2", reason: { kind: "workspace-rejected", error: "Task T2 workspace observation differs from its exact review scope" } }]);
  });

  it("names a predecessor under another protocol and an acceptance off the lineage", () => {
    const run = predecessorRun(accepted, { reviewer_protocol: REVIEWER_PROTOCOL_V2 });
    expect(restart(exhaustedWave({ run }), observation(), previousRegistration(REVIEWER_PROTOCOL_V2)).notCarried).toEqual([
      { taskId: "T1", reason: { kind: "predecessor-protocol" } }, { taskId: "T2", reason: { kind: "predecessor-protocol" } },
    ]);
    const t1 = { accepted_review_authority: acceptanceT1({ run_id: "run.earliest" }) };
    expect(restart(exhaustedWave({ t1 })).notCarried)
      .toEqual([{ taskId: "T1", reason: { kind: "acceptance-off-lineage", runId: "run.earliest" } }]);
  });

  it("names a run with no accepted slot", () => {
    expect(restart(exhaustedWave({ run: predecessorRun([]) })).notCarried)
      .toEqual([{ taskId: "T2", reason: { kind: "nothing-accepted" } }]);
  });
});

describe("publishedRostersOf: the roles a predecessor published per Task", () => {
  type Role = AgentRequestAuthority["role"];
  const request = (role: Role, attempt: 1 | 2 = 1, program: AgentRequestAuthority["program"] = "wave-gate") =>
    ({ program, attempt, role });
  const candidate = (role: Role, taskId: string | null, batchEpoch: string | null = EPOCH_A, attempt: 1 | 2 = 1) =>
    ({ authority: request(role, attempt), batchEpoch, taskId });

  it("groups current-epoch attempt-1 reviewer roles by Task, in journal order", () => {
    expect(publishedRostersOf([
      candidate(ROSTER[1]!, "T1"), candidate(ROSTER[0]!, "T1"), candidate(ROSTER[0]!, "T2"),
    ], EPOCH_A)).toEqual(new Map([["T1", [ROSTER[1], ROSTER[0]]], ["T2", [ROSTER[0]]]]));
  });

  it("ignores retried attempts, stale epochs, spec-check, other programs and contexts naming no Task", () => {
    expect(publishedRostersOf([
      candidate(ROSTER[0]!, "T1", EPOCH_A, 2),
      candidate(ROSTER[1]!, "T1", EPOCH_B),
      candidate("spec-check-invoker", "T1"),
      { authority: request(ROSTER[2]!, 1, "standalone-review"), batchEpoch: EPOCH_A, taskId: "T1" },
      candidate(ROSTER[3]!, null),
      candidate(ROSTER[4]!, "T1", null),
    ], EPOCH_A)).toEqual(new Map());
  });

  it("publishes nothing when the predecessor has no current epoch", () => {
    expect(publishedRostersOf([candidate(ROSTER[0]!, "T1")], undefined)).toEqual(new Map());
  });
});

describe("a chained restart keeps every carried slot's original origin", () => {
  /** Rebind T2's carried run into `nextRunId`, then exhaust the slots that run issued fresh. */
  function rebindAndExhaust(prepared: ReturnType<typeof restart>, nextRunId: string, packetId: string, epoch: string): TaskGraph {
    const [t1, t2] = prepared.graph.tasks;
    const carry = prepared.registration.restart?.carry?.carried.find(({ taskId }) => taskId === "T2");
    if (carry?.kind !== "accepted-slots" || t1 === undefined || t2 === undefined) throw new Error("T2 must carry its accepted slots");
    const bytes = observe("T2", ["src/t2.ts"]);
    const rebound = value(rebindCarriedReviewRun(t2, carry, {
      runId: nextRunId, authorityDigest: prepared.registration.authorityDigest, protocol: WAVE_REVIEWER_PROTOCOL_V4,
      generation: 0, packetId, headSha: epoch, bytes: { scope: bytes.scope, headSha: bytes.headSha }, roster: ROSTER,
      subject: SUBJECT_T2, issued: issuedRoles(ROSTER, carry).map((agent) => issuedSlot(agent, packetId.charCodeAt(0) * 100 + ROSTER.indexOf(agent))),
    }));
    const [first, ...rest] = rebound.slot_authority.map((slot) => (slot.carried_from === undefined ? { ...slot, attempted: 2 as const } : slot));
    return {
      ...prepared.graph,
      tasks: [t1, { ...t2, review_run: { ...rebound, slot_authority: [first!, ...rest] } }],
      active_wave_gate: activeWaveGateFixture({ runId: nextRunId, wave: 1, authorityDigest: prepared.registration.authorityDigest }),
      wave_review_epoch: { runId: value(parseOrchestrationRunId(nextRunId)), wave: 1, batchEpoch: value(parseArtifactDigest(epoch)) },
    };
  }
  function restartAgain(state: TaskGraph, previousRunId: string, previous: RegisteredWaveGateProgram, nextRunId: string) {
    const run = state.tasks[1]!.review_run!;
    const exhausted = new Set((run.slot_authority ?? []).filter(({ attempted }) => attempted === 2)
      .map(({ slot_id }) => captureKey(slot_id, 2)));
    return value(prepareExhaustedWaveGateRestart(state, previousRunId, previous, nextRunId, "/runs", exhausted, observation()));
  }

  it("carries the twice-carried slots under their first origin, and lists every run of the chain in order", () => {
    const toNext = restart(exhaustedWave());
    const atNext = rebindAndExhaust(toNext, "run.next", PACKET_B, EPOCH_B);
    const toThird = restartAgain(atNext, "run.next", toNext.registration, "run.third");
    const atThird = rebindAndExhaust(toThird, "run.third", "5".repeat(64), "6".repeat(64));
    const toFourth = restartAgain(atThird, "run.third", toThird.registration, "run.fourth");
    expect(toFourth.registration.restart?.carry?.lineage).toEqual([
      { runId: "run.previous", authorityDigest: DIGEST_A },
      { runId: "run.next", authorityDigest: toNext.registration.authorityDigest },
      { runId: "run.third", authorityDigest: toThird.registration.authorityDigest },
    ]);
    expect(toFourth.registration.restart?.carry?.carried).toEqual([
      { kind: "accepted-task", taskId: "T1", roster: ROSTER, acceptance: { runId: "run.previous", authorityDigest: DIGEST_A } },
      { kind: "accepted-slots", taskId: "T2", agents: accepted },
    ]);
    const atFourth = rebindAndExhaust(toFourth, "run.fourth", "7".repeat(64), "8".repeat(64));
    const origins = atFourth.tasks[1]!.review_run!.slot_authority!.flatMap((slot) => (slot.carried_from === undefined ? [] : [slot.carried_from]));
    expect(origins).toEqual(accepted.map(() => ({ run_id: "run.previous", authority_digest: DIGEST_A, packet_id: PACKET_A })));
  });
});

describe("rebinding a carried Task's Review Run into the replacement run", () => {
  const freshSlot = issuedSlot(EXHAUSTED, 99);
  const bytes = observe("T2", ["src/t2.ts"]);
  const binding: CarriedRunBinding = {
    runId: "run.next", authorityDigest: DIGEST_B, protocol: WAVE_REVIEWER_PROTOCOL_V4,
    generation: 0, packetId: PACKET_B, headSha: EPOCH_B, bytes: { scope: bytes.scope, headSha: bytes.headSha },
    roster: ROSTER, subject: SUBJECT_T2, issued: [freshSlot],
  };
  const task = (): Task => exhaustedWave().tasks[1]!;
  const carry = { kind: "accepted-slots" as const, taskId: "T2", agents: accepted as unknown as readonly [string, ...string[]] };

  it("keeps each accepted slot's identity and evidence, adds its provenance, and issues a fresh slot for the exhausted agent", () => {
    const predecessor = task().review_run as CurrentReviewRun;
    const rebound = value(rebindCarriedReviewRun(task(), carry, binding));
    expect(rebound).toMatchObject({ packet_id: PACKET_B, head_sha: EPOCH_B, wave_gate_run_id: "run.next",
      wave_gate_authority_digest: DIGEST_B, prior_finding_ids: predecessor.prior_finding_ids });
    expect(rebound.evidence).toEqual(predecessor.evidence);
    expect(rebound.slot_authority).toEqual(predecessor.slot_authority.map((slot) => slot.agent === EXHAUSTED ? freshSlot
      : { ...slot, carried_from: { run_id: "run.previous", authority_digest: DIGEST_A, packet_id: PACKET_A } }));
  });

  it("is idempotent: rebinding the installed run reproduces it exactly", () => {
    const rebound = value(rebindCarriedReviewRun(task(), carry, binding));
    expect(rebindCarriedReviewRun({ ...task(), review_run: rebound }, carry, binding)).toEqual({ ok: true, value: rebound });
  });

  it("refuses a carry into the run that issued the evidence, a slot without evidence and drifted bytes", () => {
    expect(rebindCarriedReviewRun(task(), carry, { ...binding, runId: "run.previous" }).ok).toBe(false);
    expect(rebindCarriedReviewRun(task(), { ...carry, agents: ROSTER as unknown as readonly [string, ...string[]] }, binding).ok).toBe(false);
    expect(rebindCarriedReviewRun(task(), carry, { ...binding, bytes: { ...binding.bytes, headSha: "f".repeat(64) } }).ok).toBe(false);
  });

  it("carried findings keep the Review Packet that issued them", () => {
    const rebound = value(rebindCarriedReviewRun(task(), carry, binding));
    const folded = preserveAcceptedReviewRunFindings({ ...task(), review_run: rebound });
    expect(folded.findings).toMatchObject([{ ...CURRENT_CRITICAL, agent: ROSTER[0], review_packet_id: PACKET_A }]);
  });

  it("a carried slot round-trips through the State File; one without evidence, or naming its own run, is refused", () => {
    const rebound = value(rebindCarriedReviewRun(task(), carry, binding));
    const graphWith = (run: unknown): unknown => ({
      ...graphFixture([task()]),
      tasks: [{ ...task(), review_status: "pending", review_error: undefined, review_evidence_failures: undefined, review_run: run }],
      active_wave_gate: activeWaveGateFixture({ runId: "run.next", wave: 1, authorityDigest: DIGEST_B }),
    });
    const loaded = parseTaskGraph(JSON.parse(JSON.stringify(graphWith(rebound))));
    expect(loaded.ok, JSON.stringify(loaded)).toBe(true);
    if (loaded.ok) expect(loaded.value.tasks[0]!.review_run).toEqual(rebound);
    const withoutEvidence = { ...rebound, evidence: rebound.evidence.slice(1) };
    expect(parseTaskGraph(JSON.parse(JSON.stringify(graphWith(withoutEvidence)))).ok).toBe(false);
    const [first, ...rest] = rebound.slot_authority;
    const ownRun = { ...rebound, slot_authority: [{ ...first!, carried_from: { run_id: "run.next", authority_digest: DIGEST_B, packet_id: PACKET_B } }, ...rest] };
    expect(parseTaskGraph(JSON.parse(JSON.stringify(graphWith(ownRun)))).ok).toBe(false);
  });
});

describe("completion admits only acceptances carried along the recorded restart lineage", () => {
  const replacement = (): RegisteredWaveGateProgram => restart(exhaustedWave()).registration;
  const t1 = (): Task => exhaustedWave().tasks[0]!;

  it("admits the replacement run's own acceptance and a carried one", () => {
    const own = { ...t1(), accepted_review_authority: acceptanceT1({ run_id: "run.next", authority_digest: replacement().authorityDigest }) };
    expect(waveAcceptanceProblem(own, replacement(), "run.next", [])).toBeNull();
    expect(waveAcceptanceProblem(t1(), replacement(), "run.next", [])).toBeNull();
  });

  it("refuses an acceptance forged outside the lineage, a missing one and a carried one under another protocol", () => {
    const forged = { ...t1(), accepted_review_authority: acceptanceT1({ run_id: "run.forged" }) };
    expect(waveAcceptanceProblem(forged, replacement(), "run.next", [])).not.toBeNull();
    expect(waveAcceptanceProblem({ ...t1(), accepted_review_authority: undefined }, replacement(), "run.next", [])).not.toBeNull();
    const v2 = { ...t1(), accepted_review_authority: acceptanceT1({ reviewer_protocol: REVIEWER_PROTOCOL_V2 }) };
    expect(waveAcceptanceProblem(v2, replacement(), "run.next", [])).not.toBeNull();
    const noCarry = withOrigin(replacement(), { restart: { previousRunId: "run.previous", exhaustedSlots: [`T2/${EXHAUSTED}`] } });
    expect(waveAcceptanceProblem(t1(), noCarry, "run.next", [])).not.toBeNull();
  });
});

describe("the carry audit is parsed, not validated", () => {
  const audit = (): WaveReviewCarryAudit => restart(exhaustedWave()).registration.restart!.carry!;

  it("round-trips the audit restart records", () => {
    expect(parseWaveReviewCarryAudit(JSON.parse(JSON.stringify(audit())))).toEqual({ ok: true, value: audit() });
  });

  it("refuses an acceptance outside the lineage, an empty or repeated agent list and an unknown field", () => {
    const raw = JSON.parse(JSON.stringify(audit())) as { lineage: unknown[]; carried: Record<string, unknown>[] };
    expect(parseWaveReviewCarryAudit({ ...raw, lineage: [{ runId: "run.other", authorityDigest: DIGEST_A }] }).ok).toBe(false);
    expect(parseWaveReviewCarryAudit({ ...raw, carried: [raw.carried[0], { ...raw.carried[1], agents: [] }] }).ok).toBe(false);
    expect(parseWaveReviewCarryAudit({ ...raw, carried: [raw.carried[0], { ...raw.carried[1], agents: [EXHAUSTED, EXHAUSTED] }] }).ok).toBe(false);
    expect(parseWaveReviewCarryAudit({ ...raw, carried: [] }).ok).toBe(false);
    expect(parseWaveReviewCarryAudit({ ...raw, extra: true }).ok).toBe(false);
    expect(parseWaveReviewCarryAudit({ ...raw, carried: [raw.carried[1], raw.carried[1]] }).ok).toBe(false);
  });
});
