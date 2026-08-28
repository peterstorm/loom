import { describe, expect, it } from "vitest";
import {
  buildTaskLocalByteObservation,
  parseNewTestEvidence,
  unavailableTaskLocalByteObservation,
} from "../../../src/core/implementation-application";
import {
  createImplementationAttemptAuthority,
  type ImplementationAttemptAuthority,
} from "../../../src/core/implementation-completion";
import {
  PI_STRUCTURED_EVIDENCE_POLICY,
  TRUSTED_LEDGER_ONLY_POLICY,
  derivePendingTaskProof,
} from "../../../src/core/proof-obligations";
import {
  settleExactImplementation,
  type ExactImplementationSettlementPorts,
  type ExactImplementationTransportFacts,
} from "../../../src/handlers/helpers/exact-implementation-settlement";
import type { TaskGraph, TaskTestResult } from "../../../src/types";
import { taskFixture } from "../../fixtures/task-lifecycle";

function authority(reservationId = "shared-exact"): ImplementationAttemptAuthority {
  const parsed = createImplementationAttemptAuthority({
    taskId: "T1",
    wave: 1,
    semanticAttempt: 1,
    reservationId,
    headSha: "a".repeat(40),
    reservedAt: "2026-08-25T00:00:00.000Z",
    taskScopeBaseline: [],
    dirtySetBaseline: [],
  });
  if (!parsed.ok) throw new Error(parsed.error.errors.join("; "));
  return parsed.value;
}

function graph(attempt: ImplementationAttemptAuthority, newTestsRequired = false): TaskGraph {
  const task = taskFixture({
    id: "T1",
    description: "shared exact settlement",
    agent: "code-implementer-agent",
    wave: 1,
    status: "pending",
    depends_on: [],
    file_list: [],
    new_tests_required: newTestsRequired,
    proof: derivePendingTaskProof({ newTestsRequired, declaredArtifacts: [] }),
    active_implementation_attempt: attempt,
    artifact_baseline: [],
    attempt_artifact_baseline: [],
    attempt_repository_baseline: [],
    reserved_at: attempt.reservedAt,
  });
  return {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    executing_tasks: ["T1"],
    tasks: [task],
    wave_gates: { "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false } },
  };
}

function facts(
  transport: "Claude" | "Pi",
  attempt: ImplementationAttemptAuthority,
  testResult: TaskTestResult = { verdict: "trusted-pass" },
): ExactImplementationTransportFacts {
  return {
    transport,
    authority: attempt,
    observedAt: "2026-08-25T00:01:00.000Z" as never,
    parserModifiedPaths: [],
    parserPathLabel: `${transport} fixture paths`,
    taskCompleted: true,
    testResult,
    testEvidence: `${transport} evidence`,
    proofEvaluationPolicy: transport === "Claude"
      ? TRUSTED_LEDGER_ONLY_POLICY
      : PI_STRUCTURED_EVIDENCE_POLICY,
  };
}

function ports(
  attempt: ImplementationAttemptAuthority,
  newTests = parseNewTestEvidence(false, "verification waived"),
): ExactImplementationSettlementPorts {
  return {
    repository: {
      root: "/fixture",
      observeTaskLocal: () => buildTaskLocalByteObservation({
        authority: attempt,
        attemptBaseline: [],
        currentAttemptScope: [],
        proofBaseline: [],
        currentProofScope: [],
        parserModifiedPaths: [],
        priorAttributedPaths: [],
        repositoryChangedPaths: [],
        siblingOwnedPaths: [],
      }),
    },
    newTests: { collect: () => ({ ok: true, value: newTests }) },
  };
}

const TRANSPORTS = ["Claude", "Pi"] as const;

describe("shared exact implementation settlement shell", () => {
  it("derives canonical current-Wave sibling ownership from locked declared and modified paths", () => {
    const attempt = authority("sibling-ownership");
    const initial = graph(attempt);
    const sibling = taskFixture({
      id: "T2",
      description: "parallel sibling",
      agent: "code-implementer-agent",
      wave: 1,
      status: "pending",
      depends_on: [],
      file_list: ["src/../sibling.ts"],
      files_modified: ["other.ts"],
    });
    let observedSiblingPaths: readonly string[] = [];
    const observingPorts: ExactImplementationSettlementPorts = {
      ...ports(attempt),
      repository: {
        root: "/fixture",
        observeTaskLocal: (args) => {
          observedSiblingPaths = args.siblingOwnedPaths;
          return buildTaskLocalByteObservation({
            authority: attempt,
            attemptBaseline: [],
            currentAttemptScope: [],
            proofBaseline: [],
            currentProofScope: [],
            parserModifiedPaths: [],
            priorAttributedPaths: [],
            repositoryChangedPaths: ["sibling.ts", "other.ts"],
            siblingOwnedPaths: args.siblingOwnedPaths,
          });
        },
      },
    };
    const settled = settleExactImplementation(
      { ...initial, tasks: [...initial.tasks, sibling] },
      facts("Claude", attempt),
      observingPorts,
    );
    expect(observedSiblingPaths).toEqual(["other.ts", "sibling.ts"]);
    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "implemented" } });
  });

  it.each(TRANSPORTS)("settles accepted %s facts through the same operation", (transport) => {
    const attempt = authority(`accepted-${transport}`);
    const settled = settleExactImplementation(graph(attempt), facts(transport, attempt), ports(attempt));
    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "implemented" } });
  });

  it.each(TRANSPORTS)("settles semantic %s failures without infrastructure relabeling", (transport) => {
    const attempt = authority(`semantic-${transport}`);
    const settled = settleExactImplementation(
      graph(attempt, true),
      facts(transport, attempt),
      ports(attempt, parseNewTestEvidence(false, "no attributed tests")),
    );
    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "retry-required" } });
    expect(settled).not.toHaveProperty("infrastructureReason");
  });

  it.each(TRANSPORTS)("settles %s repository uncertainty as infrastructure", (transport) => {
    const attempt = authority(`infrastructure-${transport}`);
    const unavailablePorts: ExactImplementationSettlementPorts = {
      ...ports(attempt),
      repository: {
        root: "/fixture",
        observeTaskLocal: () => unavailableTaskLocalByteObservation(attempt, "HEAD drift"),
      },
    };
    const settled = settleExactImplementation(graph(attempt), facts(transport, attempt), unavailablePorts);
    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "infrastructure-blocked" } });
    expect(settled.infrastructureReason).toContain("HEAD drift");
  });

  it.each(TRANSPORTS)("archives thrown %s task-local observation failures as infrastructure", (transport) => {
    const attempt = authority(`task-local-defect-${transport}`);
    const defectPorts: ExactImplementationSettlementPorts = {
      ...ports(attempt),
      repository: {
        root: "/fixture",
        observeTaskLocal: () => { throw new Error("worktree unreadable"); },
      },
    };
    const settled = settleExactImplementation(graph(attempt), facts(transport, attempt), defectPorts);
    expect(settled.application).toMatchObject({
      kind: "applied",
      transition: { kind: "infrastructure-blocked" },
    });
    expect(settled.infrastructureReason).toBe(
      `${transport} task-local observation unavailable: worktree unreadable`,
    );
  });

  it.each(TRANSPORTS)("keeps stale %s authority non-positive", (transport) => {
    const attempt = authority(`stale-${transport}`);
    const replacement = authority(`replacement-${transport}`);
    const settled = settleExactImplementation(graph(replacement), facts(transport, attempt), ports(attempt));
    expect(settled.application).toMatchObject({ kind: "ignored", reason: "stale" });
  });

  it.each(TRANSPORTS)("keeps duplicate %s delivery idempotent", (transport) => {
    const attempt = authority(`duplicate-${transport}`);
    const first = settleExactImplementation(graph(attempt), facts(transport, attempt), ports(attempt));
    if (first.application.kind !== "applied") throw new Error("fixture must settle once");
    const duplicate = settleExactImplementation(first.application.state, facts(transport, attempt), ports(attempt));
    expect(duplicate.application).toMatchObject({ kind: "ignored", reason: "duplicate" });
  });

  it.each(TRANSPORTS)("settles typed unavailable %s new-test observations as infrastructure", (transport) => {
    const attempt = authority(`new-test-unavailable-${transport}`);
    const failingPorts: ExactImplementationSettlementPorts = {
      ...ports(attempt),
      newTests: { collect: () => ({
        ok: false,
        error: { kind: "git-observation-failed", operation: "diff-worktree", message: "index unreadable" },
      }) },
    };
    const settled = settleExactImplementation(graph(attempt), facts(transport, attempt), failingPorts);
    expect(settled.application).toMatchObject({ kind: "applied", transition: { kind: "infrastructure-blocked" } });
    expect(settled.infrastructureReason).toContain(`${transport} new-test observation unavailable`);
    expect(settled.infrastructureReason).toContain("index unreadable");
  });

  it.each(TRANSPORTS)("archives thrown %s new-test observation failures as infrastructure", (transport) => {
    const attempt = authority(`new-test-defect-${transport}`);
    const defectPorts: ExactImplementationSettlementPorts = {
      ...ports(attempt),
      newTests: { collect: () => { throw new TypeError("collector invariant broke"); } },
    };
    const settled = settleExactImplementation(graph(attempt), facts(transport, attempt), defectPorts);
    expect(settled.application).toMatchObject({
      kind: "applied",
      transition: {
        kind: "infrastructure-blocked",
        failures: [expect.objectContaining({ kind: "implementation-observation-unavailable" })],
      },
    });
    expect(settled.infrastructureReason).toBe(
      `${transport} new-test observation unavailable: collector invariant broke`,
    );
    if (settled.application.kind !== "applied") return;
    expect(settled.application.state.tasks[0]?.implementation_attempt_history).toContainEqual(
      expect.objectContaining({
        authorityDigest: attempt.authorityDigest,
        transition: "infrastructure-blocked",
        consumesSemanticAttempt: false,
      }),
    );
  });

  it("preserves Pi structured provenance rather than flattening it to ledger trust", () => {
    const attempt = authority("pi-provenance");
    const untrusted: TaskTestResult = {
      verdict: "untrusted",
      passed: true,
      label: "pi-structured",
      provenance: "pi-structured",
    };
    const verificationPolicy = {
      regression: { kind: "required" as const },
      newTests: { kind: "waived" as const, reason: "existing-tests-sufficient" as const },
    };
    const initial = graph(attempt);
    const provenanceGraph: TaskGraph = {
      ...initial,
      tasks: initial.tasks.map((task) => taskFixture({
        ...task,
        new_tests_required: undefined,
        verification_policy: {
          regression: verificationPolicy.regression,
          new_tests: verificationPolicy.newTests,
        },
        proof: derivePendingTaskProof({ verificationPolicy, declaredArtifacts: [] }),
      })),
    };
    const settled = settleExactImplementation(provenanceGraph, facts("Pi", attempt, untrusted), ports(attempt));
    expect(settled.application.kind).toBe("applied");
    if (settled.application.kind !== "applied") return;
    expect(settled.application.state.tasks[0]?.proof).toMatchObject({
      state: "satisfied",
      results: expect.arrayContaining([
        expect.objectContaining({
          evidence: expect.objectContaining({ provenance: "pi-structured", verdict: "untrusted-pass" }),
        }),
      ]),
    });
    expect(settled.application.state.tasks[0]?.test_result).toEqual(untrusted);
  });
});
