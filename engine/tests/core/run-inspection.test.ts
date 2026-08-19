import { describe, expect, it } from "vitest";
import {
  deriveRunInspection,
  observed,
  renderRunInspectionHuman,
  renderRunInspectionJson,
  unavailable,
  type InspectedEvent,
  type RunInspectionObservation,
} from "../../src/core/run-inspection";
import { captureKey, type CaptureKey } from "../../src/core/harness-capture";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";

/**
 * Deciding "resume this run or replace it?" used to mean hand-reading
 * `authority.json`, `program.json`, `checkpoint.json`, and the event log with
 * `jq`, then cross-referencing each transcript slot for a rejection marker.
 * The projection under test is that reading, done once and honestly.
 *
 * "Honestly" is the load-bearing word here: every fact an operator would
 * otherwise read by hand is either `observed` with its value or `unavailable`
 * with the cause. A projection that defaulted an unreadable checkpoint to "no
 * checkpoint" would report a symlink-swapped run and a never-started run
 * identically — and the unreadable one is the fault.
 */

const request = (
  slotId: string,
  role: string,
  attempt: 1 | 2 = 1,
  requestId = `request:${slotId}:${attempt}`,
): AgentRequestAuthority => ({ slotId, role, attempt, requestId } as unknown as AgentRequestAuthority);

function observation(overrides: Partial<RunInspectionObservation> = {}): RunInspectionObservation {
  return Object.freeze({
    runId: "run.example",
    runsRoot: "/runs",
    runDirectory: "/runs/run.example",
    authority: observed<null>(null),
    programRegistration: observed<unknown>({ schemaVersion: 1, kind: "standalone-review" }),
    checkpoint: observed<string | null>(JSON.stringify({ kind: "awaiting-results" })),
    requests: observed<readonly AgentRequestAuthority[]>([]),
    capturedAttempts: observed<ReadonlySet<CaptureKey>>(new Set()),
    markerRejections: observed<ReadonlyMap<string, string>>(new Map()),
    events: observed<readonly InspectedEvent[]>([]),
    abandonment: observed<null>(null),
    ...overrides,
  });
}

describe("deriveRunInspection — program and state", () => {
  it("reads each program's checkpoint through that program's own shape", () => {
    const cases = [
      ["standalone-review", { kind: "awaiting-results" }, "awaiting-results"],
      ["wave-gate", { kind: "wave-gate-done" }, "wave-gate-done"],
      ["remediation", { schemaVersion: 1, state: { state: "done" } }, "done"],
      ["architecture", { schemaVersion: 1, data: { state: { stage: "awaiting-judges" } } }, "awaiting-judges"],
      ["refutation", { schemaVersion: 1, data: { state: { stage: "ready-to-tally" } } }, "ready-to-tally"],
    ] as const;

    for (const [kind, checkpoint, expected] of cases) {
      const inspection = deriveRunInspection(observation({
        programRegistration: observed<unknown>({ schemaVersion: 1, kind }),
        checkpoint: observed<string | null>(JSON.stringify(checkpoint)),
      }));
      expect(inspection.program).toEqual({ kind: "observed", value: { kind: "registered", program: kind } });
      expect(inspection.state, `${kind} state`).toEqual({ kind: "observed", value: expected });
    }
  });

  /**
   * The label paths differ per program, so a probe that tried each in turn
   * would report whichever field happened to match — including one belonging to
   * a different program's shape. Reading the wrong program's field is worse
   * than reading none, so a mismatched shape is `unavailable`.
   */
  it("refuses to read one program's checkpoint through another's shape", () => {
    const inspection = deriveRunInspection(observation({
      programRegistration: observed<unknown>({ schemaVersion: 1, kind: "remediation" }),
      checkpoint: observed<string | null>(JSON.stringify({ kind: "awaiting-results" })),
    }));

    expect(inspection.state).toEqual({
      kind: "unavailable",
      reason: "checkpoint carries no remediation state label",
    });
  });

  it("distinguishes a run with no checkpoint from one whose checkpoint cannot be read", () => {
    expect(deriveRunInspection(observation({ checkpoint: observed<string | null>(null) })).state)
      .toEqual({ kind: "observed", value: null });
    expect(deriveRunInspection(observation({ checkpoint: unavailable<string | null>("ELOOP") })).state)
      .toEqual({ kind: "unavailable", reason: "ELOOP" });
    expect(deriveRunInspection(observation({ checkpoint: observed<string | null>("{not json") })).state)
      .toMatchObject({ kind: "unavailable" });
  });

  it("reports an unregistered run as such, and refuses to label its checkpoint", () => {
    const inspection = deriveRunInspection(observation({ programRegistration: observed<unknown>(null) }));

    expect(inspection.program).toEqual({ kind: "observed", value: { kind: "unregistered" } });
    expect(inspection.state).toEqual({
      kind: "unavailable",
      reason: "run has a checkpoint but no registered program to read it through",
    });
  });

  it("distinguishes an unrecognized program kind from no program at all", () => {
    const inspection = deriveRunInspection(observation({
      programRegistration: observed<unknown>({ schemaVersion: 1, kind: "program-from-a-newer-engine" }),
    }));

    expect(inspection.program).toEqual({ kind: "observed", value: { kind: "unrecognized" } });
    expect(inspection.state).toEqual({
      kind: "unavailable",
      reason: "run has a checkpoint but its registered program kind is not recognised by this build",
    });
    expect(renderRunInspectionHuman(inspection)).toContain("program:   unrecognized program kind");
  });

  it("propagates an unreadable registration into the state rather than guessing", () => {
    const inspection = deriveRunInspection(observation({
      programRegistration: unavailable<unknown>("program.json is unreadable: EACCES"),
    }));

    expect(inspection.program).toMatchObject({ kind: "unavailable" });
    expect(inspection.state).toEqual({
      kind: "unavailable",
      reason: "program registration is unavailable: program.json is unreadable: EACCES",
    });
  });
});

describe("deriveRunInspection — slots", () => {
  const slots = [request("slot-2", "comment-analyzer"), request("slot-1", "code-reviewer")];

  it("classifies every issued slot and orders them by slot then attempt", () => {
    const inspection = deriveRunInspection(observation({
      requests: observed<readonly AgentRequestAuthority[]>([
        ...slots, request("slot-1", "code-reviewer", 2),
      ]),
      capturedAttempts: observed<ReadonlySet<CaptureKey>>(new Set([captureKey("slot-1", 2)])),
      markerRejections: observed<ReadonlyMap<string, string>>(new Map([
        ["request:slot-1:1", "attempt 1 was rejected"],
      ])),
    }));

    expect(inspection.slots).toMatchObject({ kind: "observed" });
    expect(inspection.slots.kind === "observed" && inspection.slots.value).toEqual([
      { slotId: "slot-1", requestId: "request:slot-1:1", role: "code-reviewer", attempt: 1, capture: "rejected", diagnostic: "attempt 1 was rejected" },
      { slotId: "slot-1", requestId: "request:slot-1:2", role: "code-reviewer", attempt: 2, capture: "captured", diagnostic: null },
      { slotId: "slot-2", requestId: "request:slot-2:1", role: "comment-analyzer", attempt: 1, capture: "awaited", diagnostic: null },
    ]);
  });

  /**
   * Both the event log and the per-slot marker record the same rejection, and
   * the log is the run's authoritative append-only record — the same precedence
   * `durableCaptureRejection` applies when it recovers a retry.
   */
  it("prefers the event log's diagnostic over the on-disk marker", () => {
    const inspection = deriveRunInspection(observation({
      requests: observed<readonly AgentRequestAuthority[]>([request("slot-1", "code-reviewer")]),
      markerRejections: observed<ReadonlyMap<string, string>>(new Map([["request:slot-1:1", "from the marker"]])),
      events: observed<readonly InspectedEvent[]>([{
        sequence: 0,
        dedupKey: "capture-rejected:abc",
        recordedAtMs: 1,
        event: { kind: "request-capture-rejected", requestId: "request:slot-1:1", diagnostic: "from the event log" },
      }]),
    }));

    expect(inspection.slots.kind === "observed" && inspection.slots.value[0]?.diagnostic).toBe("from the event log");
  });

  it("treats landed bytes as captured even when an earlier rejection was recorded", () => {
    const inspection = deriveRunInspection(observation({
      requests: observed<readonly AgentRequestAuthority[]>([request("slot-1", "code-reviewer")]),
      capturedAttempts: observed<ReadonlySet<CaptureKey>>(new Set([captureKey("slot-1", 1)])),
      markerRejections: observed<ReadonlyMap<string, string>>(new Map([["request:slot-1:1", "stale"]])),
    }));

    expect(inspection.slots.kind === "observed" && inspection.slots.value[0])
      .toMatchObject({ capture: "captured", diagnostic: null });
  });

  it("reports slots as unavailable when the requests or captures could not be read", () => {
    expect(deriveRunInspection(observation({
      requests: unavailable<readonly AgentRequestAuthority[]>("requests are malformed"),
    })).slots).toEqual({ kind: "unavailable", reason: "requests are malformed" });

    expect(deriveRunInspection(observation({
      capturedAttempts: unavailable<ReadonlySet<CaptureKey>>("EACCES"),
    })).slots).toEqual({ kind: "unavailable", reason: "captured attempts are unavailable: EACCES" });
  });

  /**
   * A corrupt event log must not withhold the slot classification: the partial
   * answer is exactly what the replace-or-resume decision runs on.
   */
  it("still classifies slots when the event log is unreadable", () => {
    const inspection = deriveRunInspection(observation({
      requests: observed<readonly AgentRequestAuthority[]>([request("slot-1", "code-reviewer")]),
      events: unavailable<readonly InspectedEvent[]>("event log is unreadable: corrupt filename"),
    }));

    expect(inspection.events).toMatchObject({ kind: "unavailable" });
    expect(inspection.slots.kind === "observed" && inspection.slots.value[0]?.capture).toBe("awaited");
  });
});

describe("deriveRunInspection — event tail", () => {
  it("summarizes the count and the last event's kind and sequence", () => {
    const inspection = deriveRunInspection(observation({
      events: observed<readonly InspectedEvent[]>([
        { sequence: 0, dedupKey: "a", recordedAtMs: 1, event: { kind: "batch-published" } },
        { sequence: 1, dedupKey: "b", recordedAtMs: 2, event: { kind: "request-capture-rejected" } },
      ]),
    }));

    expect(inspection.events).toEqual({
      kind: "observed",
      value: { count: 2, last: { sequence: 1, kind: "request-capture-rejected", recordedAtMs: 2 } },
    });
  });

  it("falls back to the dedup key when an event carries no kind", () => {
    const inspection = deriveRunInspection(observation({
      events: observed<readonly InspectedEvent[]>([
        { sequence: 0, dedupKey: "unlabelled-event", recordedAtMs: 1, event: 7 },
      ]),
    }));

    expect(inspection.events.kind === "observed" && inspection.events.value.last?.kind).toBe("unlabelled-event");
  });

  it("reports an empty log as zero events rather than as unavailable", () => {
    expect(deriveRunInspection(observation()).events).toEqual({ kind: "observed", value: { count: 0, last: null } });
  });
});

describe("run inspection renderers", () => {
  const inspection = deriveRunInspection(observation({
    requests: observed<readonly AgentRequestAuthority[]>([
      request("slot-1", "code-reviewer"), request("slot-2", "comment-analyzer"),
    ]),
    capturedAttempts: observed<ReadonlySet<CaptureKey>>(new Set([captureKey("slot-1", 1)])),
    markerRejections: observed<ReadonlyMap<string, string>>(new Map([["request:slot-2:1", "agent-failed: stopReason=error"]])),
    abandonment: observed({ supersededBy: "run.replacement", reason: "shared endpoint dropped every child" }),
  }));

  it("renders the human form with the tally, each slot, and the reason it refused", () => {
    const text = renderRunInspectionHuman(inspection);

    expect(text).toContain("run:       run.example");
    expect(text).toContain("program:   standalone-review");
    expect(text).toContain("state:     awaiting-results");
    expect(text).toContain("2 issued — 1 captured, 1 rejected, 0 awaited");
    expect(text).toContain("agent-failed: stopReason=error");
    expect(text).toContain("abandoned: yes — superseded by run.replacement: shared endpoint dropped every child");
  });

  it("names the cause in the human form instead of hiding an unavailable fact", () => {
    const text = renderRunInspectionHuman(deriveRunInspection(observation({
      checkpoint: unavailable<string | null>("checkpoint is unreadable: ELOOP"),
    })));

    expect(text).toContain("state:     unavailable (checkpoint is unreadable: ELOOP)");
  });

  /** Both renderers project the SAME value, so they cannot disagree. */
  it("renders a JSON form carrying every fact the human form shows", () => {
    const json = JSON.parse(renderRunInspectionJson(inspection)) as Record<string, unknown>;

    expect(json).toMatchObject({
      schemaVersion: 1,
      kind: "run-inspection",
      runId: "run.example",
      program: { kind: "observed", value: { kind: "registered", program: "standalone-review" } },
      state: { kind: "observed", value: "awaiting-results" },
      abandonment: { kind: "observed", value: { supersededBy: "run.replacement" } },
    });
    expect((json.slots as { value: unknown[] }).value).toHaveLength(2);
  });
});
