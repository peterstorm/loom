import { describe, expect, it } from "vitest";
import { applyFailedPiResult, type TaskGraphStore } from "../../../pi/subagent-result";
import {
  createImplementationAttemptAuthority,
  parseIsoInstant,
  parseReservationId,
} from "../../src/core/implementation-completion";
import { taskFixture } from "../fixtures/task-lifecycle";
import type { TaskGraph } from "../../src/types";

function authority(reservation: string) {
  const instant = parseIsoInstant("2026-08-24T00:00:00.000Z");
  const reservationId = parseReservationId(reservation);
  if (!instant.ok || !reservationId.ok) throw new Error("fixture identity failed");
  const created = createImplementationAttemptAuthority({
    taskId: "T1", wave: 1, semanticAttempt: 1, reservationId: reservationId.value,
    headSha: "1".repeat(40), reservedAt: instant.value,
    taskScopeBaseline: [], dirtySetBaseline: [],
  });
  if (!created.ok) throw new Error(created.error.errors.join("; "));
  return created.value;
}

function store(initial: TaskGraph): TaskGraphStore & { current(): TaskGraph } {
  let state = initial;
  const updateAndReturn = async <T>(
    mutate: (current: TaskGraph) => Readonly<{ state: TaskGraph; value: T }>,
  ): Promise<T> => {
    const applied = mutate(state);
    state = applied.state;
    return applied.value;
  };
  return {
    load: () => state,
    update: async (mutate) => { state = mutate(state); },
    updateAndReturn,
    current: () => state,
  };
}

describe("Pi exact implementation authority correlation", () => {
  it("settles an exact failed result with a non-consuming infrastructure receipt", async () => {
    const attempt = authority("pi-failed-attempt");
    const graph: TaskGraph = {
      current_phase: "execute",
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
      current_wave: 1,
      executing_tasks: ["T1"],
      tasks: [taskFixture({
        id: "T1", description: "implementation", agent: "code-implementer-agent",
        wave: 1, status: "pending", depends_on: [], file_list: [],
        active_implementation_attempt: attempt,
        artifact_baseline: [],
        attempt_artifact_baseline: [],
        attempt_repository_baseline: [],
        reserved_at: attempt.reservedAt,
      })],
      wave_gates: {},
    };
    const fake = store(graph);

    const result = await applyFailedPiResult({
      store: fake,
      agentType: "code-implementer-agent",
      result: {
        agent: "code-implementer-agent",
        task: "Task ID: T1",
        exitCode: 1,
        stopReason: "error",
        messages: [],
      },
      reservedSlot: {
        agentType: "code-implementer-agent",
        taskId: "T1",
        implementationAuthority: attempt,
      },
      now: "2026-08-24T00:01:00.000Z",
    });

    expect(result.processingErrors).toEqual([]);
    expect(fake.current().executing_tasks).toEqual([]);
    expect(fake.current().tasks[0]).toMatchObject({
      status: "pending",
      revalidation_required: true,
      implementation_attempt_history: [{
        authorityDigest: attempt.authorityDigest,
        transition: "infrastructure-blocked",
        consumesSemanticAttempt: false,
      }],
    });
    expect(fake.current().tasks[0]?.active_implementation_attempt).toBeUndefined();
  });

  it("a late failed result cannot release a newer active attempt sharing the Task id", async () => {
    const oldAttempt = authority("pi-old-attempt");
    const replacement = authority("pi-replacement-attempt");
    const graph: TaskGraph = {
      current_phase: "execute",
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
      current_wave: 1,
      executing_tasks: ["T1"],
      tasks: [taskFixture({
        id: "T1", description: "implementation", agent: "code-implementer-agent",
        wave: 1, status: "pending", depends_on: [], file_list: [],
        active_implementation_attempt: replacement,
        attempt_artifact_baseline: [],
        attempt_repository_baseline: [],
        reserved_at: replacement.reservedAt,
      })],
      wave_gates: {},
    };
    const fake = store(graph);

    const result = await applyFailedPiResult({
      store: fake,
      agentType: "code-implementer-agent",
      result: {
        agent: "code-implementer-agent",
        task: "Task ID: T1",
        exitCode: 1,
        stopReason: "error",
        messages: [],
      },
      reservedSlot: {
        agentType: "code-implementer-agent",
        taskId: "T1",
        implementationAuthority: oldAttempt,
      },
      now: "2026-08-24T00:01:00.000Z",
    });

    expect(result.processingErrors).toEqual([]);
    expect(result.log.join("\n")).toContain("stale");
    expect(fake.current()).toBe(graph);
    expect(fake.current().executing_tasks).toEqual(["T1"]);
    expect(fake.current().tasks[0]?.active_implementation_attempt).toEqual(replacement);
  });
});
