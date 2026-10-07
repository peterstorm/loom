/**
 * The pure settlement core, exercised without a store: every reducer here is
 * the exact callback the shell runs under `TaskGraphStore.updateAndReturn`.
 */

import { describe, expect, it } from "vitest";
import type { TaskGraph, WaveSpecCheckDocumentsAuthority } from "../../src/types";
import { graphFixture, taskFixture } from "../fixtures/task-lifecycle";
import { parseTaskGraph } from "../../src/state-manager";
import { resolveReviewFindings, reviewResolutionLog, type ReviewResolution } from "../../src/core/review-output";
import { parseSpecCheckOutput } from "../../src/core/spec-check";
import { parseSettledFloor } from "../../src/core/requirement-coverage";
import { parseArtifactDigest, parseOrchestrationRunId } from "../../src/core/orchestration-contract";
import {
  createImplementationAttemptAuthority,
  parseIsoInstant,
  parseReservationId,
  type ImplementationAttemptAuthority,
} from "../../src/core/implementation-completion";
import { currentPiSpecCheckAuthority, type PiReviewAttemptAuthority } from "../../../pi/reserved-slot";
import {
  clearCurrentReservedAuthority,
  observeImplementationTranscript,
  outcome,
  pendingMalformedTranscriptState,
  processingFailure,
  reduceLockedReviewEvidence,
  reducePiSpecCheckResult,
  renderFailedReviewEvidence,
  renderReviewEvidence,
  resolveImplementationTaskId,
  retireCompletedOrMissingImplementation,
  transcriptTextOf,
  type LockedReviewEvidenceApplication,
} from "../../../pi/subagent-settlement";

const AGENT = "code-reviewer";

/** A Task with no review generation, run or packet: the explicitly legacy review authority. */
const legacyReviewGraph = (): TaskGraph => graphFixture([taskFixture({
  id: "T1", description: "implementation", agent: "code-implementer-agent",
  wave: 1, depends_on: [], file_list: [],
})]);

const REVIEW_TRANSCRIPT = [
  "### Machine Summary",
  "CRITICAL_COUNT: 1",
  "ADVISORY_COUNT: 0",
  "CRITICAL: unchecked cast in the reducer",
].join("\n");

function attemptAuthority(taskId: string, reservation: string): ImplementationAttemptAuthority {
  const instant = parseIsoInstant("2026-08-24T00:00:00.000Z");
  const reservationId = parseReservationId(reservation);
  if (!instant.ok || !reservationId.ok) throw new Error("fixture identity failed");
  const created = createImplementationAttemptAuthority({
    taskId, wave: 1, semanticAttempt: 1, reservationId: reservationId.value,
    headSha: "1".repeat(40), reservedAt: instant.value,
    taskScopeBaseline: [], dirtySetBaseline: [],
  });
  if (!created.ok) throw new Error(created.error.errors.join("; "));
  return created.value;
}

/** One executing Task holding `authority` as its active attempt, beside an untouched T2. */
const attemptGraph = (authority: ImplementationAttemptAuthority, status: "pending" | "implemented" = "pending"): TaskGraph => ({
  ...graphFixture([
    {
      ...taskFixture({
        id: "T1", description: "implementation", agent: "code-implementer-agent",
        wave: 1, status, depends_on: [], file_list: [],
      }),
      active_implementation_attempt: authority,
      attempt_artifact_baseline: [],
      attempt_repository_baseline: [],
      reserved_at: authority.reservedAt,
    },
    taskFixture({ id: "T2", description: "other", agent: "code-implementer-agent", wave: 1, depends_on: [], file_list: [] }),
  ]),
  executing_tasks: ["T1", "T2"],
});

const ATTEMPT_FIELDS = [
  "active_implementation_attempt", "active_implementation_context",
  "attempt_artifact_baseline", "attempt_repository_baseline", "reserved_at",
] as const;

describe("resolveImplementationTaskId", () => {
  const base = {
    agentType: "code-implementer-agent",
    reservedAuthority: null,
    resultPrompt: "",
    parentPrompt: "",
    executingTasks: [],
  };

  it("prefers the reservation over either prompt", () => {
    expect(resolveImplementationTaskId({
      ...base,
      reservedTaskId: "T9",
      resultPrompt: "Task ID: T1",
      parentPrompt: "Task ID: T2",
    })).toEqual({ kind: "bound", taskId: "T9", inferred: false });
  });

  it("falls back to the result prompt, then the parent prompt", () => {
    expect(resolveImplementationTaskId({ ...base, reservedTaskId: null, resultPrompt: "Task ID: T1" }))
      .toEqual({ kind: "bound", taskId: "T1", inferred: false });
    expect(resolveImplementationTaskId({ ...base, reservedTaskId: null, parentPrompt: "Task ID: T2" }))
      .toEqual({ kind: "bound", taskId: "T2", inferred: false });
  });

  it("infers a single executing task, and refuses an ambiguous or empty set", () => {
    expect(resolveImplementationTaskId({ ...base, reservedTaskId: null, executingTasks: ["T5"] }))
      .toEqual({ kind: "bound", taskId: "T5", inferred: true });
    expect(resolveImplementationTaskId({ ...base, reservedTaskId: null, executingTasks: ["T5", "T6"] }))
      .toMatchObject({ kind: "unbound", reason: expect.stringContaining("ambiguous") });
    expect(resolveImplementationTaskId({ ...base, reservedTaskId: null, executingTasks: [] }))
      .toMatchObject({ kind: "unbound", reason: expect.stringContaining("executing_tasks is empty") });
  });
});

describe("retireCompletedOrMissingImplementation", () => {
  const graph = (status: "pending" | "completed"): TaskGraph => ({
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    executing_tasks: ["T1"],
    tasks: [taskFixture({
      id: "T1", description: "implementation", agent: "code-implementer-agent",
      wave: 1, status, depends_on: [], file_list: [],
    })],
    wave_gates: {},
  });

  it("retires a legacy reservation for a completed or missing Task without touching its input", () => {
    const completed = graph("completed");
    const retired = retireCompletedOrMissingImplementation(completed, "T1", null);
    expect(retired.retired).toBe(true);
    expect(retired.state.executing_tasks).toEqual([]);
    expect(completed.executing_tasks).toEqual(["T1"]);

    const missing = retireCompletedOrMissingImplementation(graph("pending"), "T9", null);
    expect(missing.retired).toBe(true);
    expect(missing.state.executing_tasks).toEqual(["T1"]);
  });

  it("keeps a still-pending Task's reservation", () => {
    const pending = graph("pending");
    expect(retireCompletedOrMissingImplementation(pending, "T1", null))
      .toEqual({ state: pending, retired: false });
  });
});

describe("clearCurrentReservedAuthority", () => {
  const authority = attemptAuthority("T1", "pi-t1");

  it.each<readonly [string, ImplementationAttemptAuthority | null]>([
    ["a legacy reservation (no authority)", null],
    ["an authority whose digest is not the Task's current attempt", attemptAuthority("T1", "pi-other")],
  ])("leaves every attempt field in place for %s", (_name, expected) => {
    const state = attemptGraph(authority);
    const cleared = clearCurrentReservedAuthority(state, "T1", expected);
    expect(cleared.tasks[0]).toEqual(state.tasks[0]);
    if (expected === null) expect(cleared).toBe(state);
  });

  it("releases exactly the matching Task's attempt state without touching its input or other Tasks", () => {
    const state = attemptGraph(authority);
    const cleared = clearCurrentReservedAuthority(state, "T1", authority);
    for (const field of ATTEMPT_FIELDS) expect(cleared.tasks[0]?.[field]).toBeUndefined();
    expect(cleared.tasks[1]).toBe(state.tasks[1]);
    expect(state.tasks[0]?.active_implementation_attempt).toBe(authority);
    expect(cleared.executing_tasks).toEqual(["T1", "T2"]);
  });
});

describe("pendingMalformedTranscriptState", () => {
  const authority = attemptAuthority("T1", "pi-t1");

  it.each<readonly [string, "pending" | "implemented", ImplementationAttemptAuthority | null, string | undefined, boolean]>([
    ["a pending Task under its current authority", "pending", authority, "transcript malformed", true],
    ["a pending Task under a legacy reservation", "pending", null, "transcript malformed", false],
    ["a non-pending Task, whose reason is not overwritten", "implemented", authority, undefined, true],
  ])("releases execution for %s", (_name, status, expected, failureReason, released) => {
    const state = attemptGraph(authority, status);
    const next = pendingMalformedTranscriptState({ state, taskId: "T1", expected, failureReason: "transcript malformed" });
    expect(next.executing_tasks).toEqual(["T2"]);
    expect(next.tasks[0]?.failure_reason).toBe(failureReason);
    expect(next.tasks[0]?.active_implementation_attempt).toBe(released ? undefined : authority);
    expect(next.tasks[1]).toBe(state.tasks[1]);
    expect(state.executing_tasks).toEqual(["T1", "T2"]);
  });
});

describe("observeImplementationTranscript", () => {
  const bashCall = (command: string, output: string) => [
    { role: "assistant", content: [{ type: "toolCall", id: "call-tests", name: "bash", arguments: { command } }] },
    {
      role: "toolResult", toolCallId: "call-tests", toolName: "bash", isError: false,
      content: [{ type: "text", text: output }],
    },
  ];
  const BUN_PASS = "bun test v1.3.0\n 1 pass\n 0 fail\n 1 expect() calls\nRan 1 test across 1 file.\n";

  it("names a transcript that is not a Pi message array as malformed, with no log", () => {
    const observed = observeImplementationTranscript("not messages", "T1");
    expect(observed).toMatchObject({ kind: "malformed", log: [] });
    if (observed.kind === "malformed") {
      expect(observed.failureReason).toMatch(/^Pi transcript evidence capture failed: \S/);
    }
  });

  it("accepts structured test evidence from a classified test run, with no fallback log", () => {
    const messages = bashCall("bun test engine/tests/pi/subagent-settlement.test.ts", BUN_PASS);
    const observed = observeImplementationTranscript(messages, "T1");
    expect(observed).toMatchObject({ kind: "accepted", log: [], test: { kind: "structured", evidence: { passed: true } } });
    if (observed.kind === "accepted") expect(observed.resultMessages).toHaveLength(2);
  });

  it("falls back to the transcript and logs why when no Bash call was a test run", () => {
    const observed = observeImplementationTranscript(bashCall("ls", "file.ts\n"), "T1");
    expect(observed).toMatchObject({ kind: "accepted", test: { kind: "fallback", evidence: { passed: false } } });
    expect(observed.log).toEqual([
      "loom(pi): T1 produced no structured test evidence (no Bash call was classified as a test run) — " +
        "transcript fallback used; the wave gate will reject it",
    ]);
  });
});

describe("reduceLockedReviewEvidence and its renderers", () => {
  const slotBound: PiReviewAttemptAuthority = {
    kind: "slot-bound", taskId: "T1", agentType: AGENT, generation: 1,
    packetId: "a".repeat(64), slotId: "wave-slot:code-reviewer", attempted: 1,
  };
  const reduce = (
    state: TaskGraph,
    taskId: string,
    resolution: ReviewResolution,
    reviewAuthority: PiReviewAttemptAuthority | null = null,
  ) => reduceLockedReviewEvidence(state, { agentType: AGENT, taskId, reviewAuthority, resolutionFor: () => resolution });
  const FAILURE = "code-reviewer exited 1";

  it("reports a vanished review Task as missing and leaves state untouched", () => {
    const state = legacyReviewGraph();
    const reduced = reduce(state, "T9", resolveReviewFindings(REVIEW_TRANSCRIPT, AGENT));
    expect(reduced).toEqual({ state, value: { kind: "missing" } });
    expect(reduced.state).toBe(state);
  });

  it("rejects a reservation that does not match the Task's current review authority", () => {
    const state = legacyReviewGraph();
    const reduced = reduce(state, "T1", resolveReviewFindings(REVIEW_TRANSCRIPT, AGENT), slotBound);
    expect(reduced.state).toBe(state);
    expect(reduced.value).toEqual({
      kind: "authority-rejected",
      problem: "failed reviewer reservation does not match exact current Task/Review Run slot authority",
    });
  });

  it("applies parsed findings under the lock and reports the change", () => {
    const state = legacyReviewGraph();
    const resolution = resolveReviewFindings(REVIEW_TRANSCRIPT, AGENT);
    const reduced = reduce(state, "T1", resolution);
    expect(reduced.value).toMatchObject({ kind: "applied", resolution, changed: true });
    if (reduced.value.kind !== "applied") return;
    expect(reduced.state.tasks[0]).toBe(reduced.value.task);
    expect(reduced.value.task.critical_findings).toEqual(["unchecked cast in the reducer"]);
    expect(state.tasks[0]?.critical_findings).toBeUndefined();
  });

  it("folds an unchanged application into applied with changed: false and the input state", () => {
    const state = legacyReviewGraph();
    const reduced = reduce(state, "T1", { kind: "ignored-stale", agent: AGENT, message: "stale packet" });
    expect(reduced.state).toBe(state);
    expect(reduced.value).toMatchObject({ kind: "applied", changed: false, task: state.tasks[0] });
  });

  const applied = reduce(legacyReviewGraph(), "T1", resolveReviewFindings(REVIEW_TRANSCRIPT, AGENT)).value;
  const failed = reduce(legacyReviewGraph(), "T1", resolveReviewFindings("no summary", AGENT)).value;
  const unchanged = reduce(legacyReviewGraph(), "T1", { kind: "ignored-stale", agent: AGENT, message: "stale packet" }).value;
  const logOf = (application: LockedReviewEvidenceApplication): string => {
    if (application.kind !== "applied") throw new Error("fixture must be applied");
    return reviewResolutionLog("T1", application.resolution, application.task, application.changed);
  };

  it.each<readonly [string, LockedReviewEvidenceApplication, ReturnType<typeof outcome>]>([
    ["missing", { kind: "missing" },
      processingFailure(`WARNING: ${AGENT} review task T1 disappeared before evidence application — findings NOT stored`)],
    ["authority-rejected", { kind: "authority-rejected", problem: "has no authority" },
      processingFailure(`WARNING: ${AGENT} review task T1 has no authority — findings NOT stored`)],
    ["applied", applied, outcome(["Task T1 review: blocked (1 critical)"])],
    ["applied but unchanged", unchanged, outcome([logOf(unchanged)])],
  ])("renderReviewEvidence renders %s", (_name, application, expected) => {
    expect(renderReviewEvidence(AGENT, "T1", application)).toEqual(expected);
  });

  it.each<readonly [string, LockedReviewEvidenceApplication, ReturnType<typeof outcome>]>([
    ["a stored failure", failed, outcome([logOf(failed)])],
    ["a duplicate/stale failure (changed: false)", unchanged, processingFailure(
      `loom(pi): ${FAILURE}; review task T1 rejected duplicate/stale failure evidence ` +
        "under the state lock — review evidence NOT stored",
    )],
    ["a vanished Task", { kind: "missing" }, processingFailure(
      `loom(pi): ${FAILURE}; review task T1 disappeared under the state lock — review evidence NOT stored`,
    )],
    ["a rejected authority", { kind: "authority-rejected", problem: "has no authority" }, processingFailure(
      `loom(pi): ${FAILURE}; review task T1 has no authority under the state lock — review evidence NOT stored`,
    )],
  ])("renderFailedReviewEvidence renders %s", (_name, application, expected) => {
    expect(renderFailedReviewEvidence(FAILURE, "T1", application)).toEqual(expected);
  });

  it("marks a stored failure as evidence_capture_failed in its log line", () => {
    expect(logOf(failed)).toMatch(/— marking evidence_capture_failed$/);
  });
});

describe("reducePiSpecCheckResult", () => {
  const NOW = "2026-08-16T00:00:00.000Z";
  const runId = parseOrchestrationRunId("run.pi-spec-check");
  const authorityDigest = parseArtifactDigest("a".repeat(64));
  const batchEpoch = parseArtifactDigest("b".repeat(64));
  const floor = parseSettledFloor({ kind: "settled", count: 0 });
  if (!runId.ok || !authorityDigest.ok || !batchEpoch.ok || floor === null) {
    throw new Error("invalid spec-check authority fixture constants");
  }
  const DOCUMENTS: WaveSpecCheckDocumentsAuthority = {
    spec: { path: null, contentDigest: null },
    plan: { path: null, contentDigest: null },
  };
  const parsed = parseTaskGraph({
    ...legacyReviewGraph(),
    active_wave_gate: {
      schemaVersion: 1, kind: "active-wave-gate", runId: runId.value, wave: 1,
      authorityDigest: authorityDigest.value, revision: 1, terminalOutcome: null,
    },
    wave_review_epoch: {
      runId: runId.value, wave: 1, batchEpoch: batchEpoch.value, specCheckDocuments: DOCUMENTS,
      specCheckSlotAuthority: { slot_id: "wave-slot:spec-check", attempted: 1 }, settledSpecCheckFloor: floor,
    },
  });
  if (!parsed.ok) throw new Error(`invalid spec-check graph fixture: ${parsed.error}`);
  const state = parsed.value;
  const authority = currentPiSpecCheckAuthority(state);
  if (authority === null) throw new Error("spec-check fixture lacks exact authority");
  const rejected = (problem: string) => {
    const diagnostic = `spec-check evidence rejected: ${problem}; protected state unchanged`;
    return outcome([`loom(pi): ${diagnostic}`], [diagnostic]);
  };
  const report = (critical: number) => parseSpecCheckOutput([
    "SPEC_CHECK_WAVE: 1",
    ...(critical > 0 ? ["CRITICAL: requirement R1 is unimplemented"] : []),
    `SPEC_CHECK_CRITICAL_COUNT: ${critical}`,
    "SPEC_CHECK_HIGH_COUNT: 0",
    `SPEC_CHECK_VERDICT: ${critical > 0 ? "BLOCKED" : "PASSED"}`,
  ].join("\n"));

  it.each<readonly [string, Parameters<typeof reducePiSpecCheckResult>[1], WaveSpecCheckDocumentsAuthority, string]>([
    ["no reserved authority", null, DOCUMENTS, "spec-check result has no exact reserved Wave slot/attempt authority"],
    ["a reserved attempt the current slot does not carry", { ...authority, attempt: 2 }, DOCUMENTS,
      `reserved spec-check authority run.pi-spec-check/1/wave-slot:spec-check/2 does not match current run.pi-spec-check/1/wave-slot:spec-check/1`],
    ["spec bytes the epoch did not freeze", authority, { ...DOCUMENTS, spec: { path: "spec.md", contentDigest: authorityDigest.value } },
      "current spec/plan bytes do not match exact Wave spec-check authority"],
  ])("rejects %s and leaves protected state untouched", (_name, reserved, documents, problem) => {
    const reduced = reducePiSpecCheckResult(state, reserved, { kind: "parsed", findings: report(0) }, documents, NOW);
    expect(reduced.state).toBe(state);
    expect(reduced.value).toEqual(rejected(problem));
  });

  it.each([[0, false], [1, true]] as const)("settles a parsed report with %i critical, deriving blocked=%s", (critical, blocked) => {
    const reduced = reducePiSpecCheckResult(state, authority, { kind: "parsed", findings: report(critical) }, DOCUMENTS, NOW);
    expect(reduced.value).toEqual(outcome());
    expect(reduced.state.spec_check).toMatchObject({ wave: 1, run_at: NOW, verdict: blocked ? "BLOCKED" : "PASSED" });
    expect(reduced.state.wave_gates["1"]?.blocked ?? false).toBe(blocked);
  });

  it("records a capture failure as evidence_capture_failed and logs its cause", () => {
    const reduced = reducePiSpecCheckResult(state, authority, { kind: "capture-failed", error: "transcript unreadable" }, DOCUMENTS, NOW);
    expect(reduced.state.spec_check).toMatchObject({ wave: 1, verdict: "EVIDENCE_CAPTURE_FAILED" });
    const specCheck = reduced.state.spec_check;
    if (specCheck?.verdict !== "EVIDENCE_CAPTURE_FAILED") return;
    expect(specCheck.error).toContain("transcript unreadable");
    expect(reduced.value).toEqual(outcome([`loom(pi): ${specCheck.error} — marking spec-check evidence_capture_failed`]));
  });
});

describe("transcriptTextOf", () => {
  it("joins only assistant and tool-result text, in order", () => {
    expect(transcriptTextOf([
      { role: "user", content: [{ type: "text", text: "prompt" }] },
      { role: "assistant", content: [{ type: "text", text: "a" }, { type: "opaque", originalType: "thinking" }] },
      { role: "toolResult", toolCallId: "c1", toolName: "bash", isError: false, content: [{ type: "text", text: "b" }] },
      { role: "other", originalRole: "custom", content: [{ type: "text", text: "ignored" }] },
    ])).toBe("a\nb");
  });
});

describe("outcome", () => {
  it("is frozen data with an empty default", () => {
    const empty = outcome();
    expect(empty).toEqual({ processingErrors: [], log: [] });
    expect(Object.isFrozen(empty) && Object.isFrozen(empty.log) && Object.isFrozen(empty.processingErrors)).toBe(true);
  });
});
