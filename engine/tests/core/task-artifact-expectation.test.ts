/**
 * The one owner of "which expectation does this Task's Proof use" and of
 * which observed changes that Proof judges (ADR-0068 §4). Covers the rule
 * itself, the settlement that selects its evidence through it, the attest
 * program that must never produce the illegal combination, and the owner
 * schedule a Distill Task is no part of.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildTaskLocalByteObservation,
  NO_ENGINE_SKELETONS,
  settleObservedImplementation,
} from "../../src/core/implementation-application";
import { createImplementationAttemptAuthority, type ImplementationAttemptAuthority } from "../../src/core/implementation-completion";
import { armImplementationAttestation } from "../../src/core/implementation-lifecycle";
import { KNOWN_AGENTS } from "../../src/core/agent-catalog-projections";
import { DISTILL_AGENT } from "../../src/core/model-profiles";
import { duePaths, implementationTasks, owesInWave, waveOwnerDuty } from "../../src/core/owner-verification/obligations";
import { waveBaseOf } from "../../src/core/owner-verification/wave-base";
import {
  DECLARED_ARTIFACT_EXPECTATIONS,
  deriveProofObligations,
  TRUSTED_LEDGER_ONLY_POLICY,
} from "../../src/core/proof-obligations";
import { CONFORMANCE_NOT_OWED } from "../../src/core/skeleton/conformance-verdict";
import { proofArtifactChanges, taskArtifactExpectation } from "../../src/core/task-artifact-expectation";
import { DISTILL_VERIFICATION_POLICY } from "../../src/core/verification-policy";
import { renderImplementationLifecycleError } from "../../src/handlers/helpers/implementation-lifecycle-errors";
import type { Task, TaskGraph } from "../../src/types";
import { NEW_TEST_EVIDENCE_NOT_WRITTEN } from "../../src/types";
import { ownerObligation } from "../fixtures/owner-obligation";
import { taskFixture } from "../fixtures/task-lifecycle";

describe("taskArtifactExpectation", () => {
  it("is preserved for a Distill Task, attested for an attestation Task, changed otherwise", () => {
    expect(taskArtifactExpectation({ agent: DISTILL_AGENT })).toBe("preserved");
    expect(taskArtifactExpectation({ agent: "code-implementer-agent", implementation_attestation: true })).toBe("attested");
    expect(taskArtifactExpectation({ agent: "code-implementer-agent" })).toBe("changed");
    expect(taskArtifactExpectation({})).toBe("changed");
  });

  it("reads a raw record: only the exact flag and the exact agent name select a mode", () => {
    expect(taskArtifactExpectation({ agent: "code-implementer-agent", implementation_attestation: "true" })).toBe("changed");
    expect(taskArtifactExpectation({ agent: ["distill-agent"] })).toBe("changed");
    expect(taskArtifactExpectation({ agent: "Distill-Agent" })).toBe("changed");
  });

  it("property: every catalog agent but the distill agent follows the attestation flag alone", () => {
    const otherAgents = [...KNOWN_AGENTS].filter((agent) => agent !== DISTILL_AGENT);
    fc.assert(fc.property(fc.constantFrom(...otherAgents), fc.boolean(), (agent, attested) => {
      const task = { agent, ...(attested ? { implementation_attestation: true as const } : {}) };
      expect(taskArtifactExpectation(task)).toBe(attested ? "attested" : "changed");
      expect(taskArtifactExpectation({ ...task, agent: DISTILL_AGENT })).toBe("preserved");
    }));
  });

  it("selects a Distill Task's two obligations whatever its scope", () => {
    fc.assert(fc.property(fc.uniqueArray(fc.constantFrom("src/a.ts", "src/b.ts", "src/c.ts")), (declaredArtifacts) => {
      expect(deriveProofObligations({
        verificationPolicy: DISTILL_VERIFICATION_POLICY,
        declaredArtifacts,
        declaredArtifactExpectation: taskArtifactExpectation({ agent: DISTILL_AGENT }),
        redThenGreen: "owed-if-new-tests",
      })).toEqual([{ kind: "task-completed" }, { kind: "behaviour-preserved" }]);
    }));
  });
});

describe("proofArtifactChanges", () => {
  const changes = { attemptScope: ["src/attempt.ts"], cumulative: ["src/attempt.ts", "src/sibling.ts"] };

  it("judges a changed Proof by the cumulative delta and the other two by the attempt's own", () => {
    expect(proofArtifactChanges("changed", changes)).toBe(changes.cumulative);
    expect(proofArtifactChanges("attested", changes)).toBe(changes.attemptScope);
    expect(proofArtifactChanges("preserved", changes)).toBe(changes.attemptScope);
  });

  it("answers for every expectation", () => {
    for (const expectation of DECLARED_ARTIFACT_EXPECTATIONS) {
      expect([changes.attemptScope, changes.cumulative]).toContain(proofArtifactChanges(expectation, changes));
    }
  });
});

const digest = (value: string) => value.repeat(64);
const baseline = (path: string, value: string) => [{ artifact: path, snapshot: { kind: "sha256" as const, digest: digest(value) } }];

function distillAttempt(): ImplementationAttemptAuthority {
  const created = createImplementationAttemptAuthority({
    taskId: "T2",
    wave: 1,
    semanticAttempt: 1,
    reservationId: "distill-1",
    headSha: "a".repeat(40),
    reservedAt: "2026-11-11T00:00:01.000Z",
    // The attempt starts from what the sibling left: digest "b".
    taskScopeBaseline: baseline("src/a.ts", "b"),
    dirtySetBaseline: [],
  });
  if (!created.ok) throw new Error(created.error.errors.join("; "));
  return created.value;
}

function distillGraph(attempt: ImplementationAttemptAuthority): TaskGraph {
  const distill: Task = taskFixture({
    id: "T2",
    description: "Distill pass for Wave 1",
    agent: DISTILL_AGENT,
    wave: 1,
    depends_on: [],
    file_list: ["src/a.ts"],
    active_implementation_attempt: attempt,
    attempt_artifact_baseline: baseline("src/a.ts", "b"),
    attempt_repository_baseline: [],
    repository_baseline: [],
    reserved_at: attempt.reservedAt,
  });
  return {
    current_phase: "execute",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    current_wave: 1,
    executing_tasks: ["T2"],
    tasks: [distill],
    wave_gates: { "1": { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false } },
  };
}

/** The scope as settlement observes it: `now` against the attempt baseline "b" and the first Task baseline "a". */
const distillBytes = (attempt: ImplementationAttemptAuthority, now: string, reported: readonly string[]) =>
  buildTaskLocalByteObservation({
    authority: attempt,
    attemptBaseline: baseline("src/a.ts", "b"),
    currentAttemptScope: baseline("src/a.ts", now),
    // The cumulative delta is the sibling's implementation: "a" at the first baseline.
    proofBaseline: baseline("src/a.ts", "a"),
    currentProofScope: baseline("src/a.ts", now),
    parserModifiedPaths: reported,
    priorAttributedPaths: [],
    repositoryChangedPaths: [],
    siblingOwnedPaths: [],
    engineSkeletons: NO_ENGINE_SKELETONS,
  });

const settleDistill = (now: string, reported: readonly string[], testResult?: Task["test_result"]) => {
  const attempt = distillAttempt();
  const bytes = distillBytes(attempt, now, reported);
  const result = settleObservedImplementation(
    distillGraph(attempt),
    attempt,
    "2026-11-11T00:05:00.000Z" as never,
    {
      taskCompleted: true,
      contractConformance: CONFORMANCE_NOT_OWED,
      newTests: NEW_TEST_EVIDENCE_NOT_WRITTEN,
      ...(testResult === undefined ? {} : { testResult }),
    },
    TRUSTED_LEDGER_ONLY_POLICY,
    bytes,
  );
  if (result.kind !== "applied") throw new Error(`expected applied, got ${result.kind}`);
  return { bytes, result };
};

describe("settlement selects a Distill Task's filesModified from the attempt's own delta", () => {
  it("settles an attempt that changed nothing as unchanged, though the cumulative delta holds its sibling's work", () => {
    const { bytes, result } = settleDistill("b", []);
    expect(bytes.cumulativeProofArtifactChanges).toEqual(["src/a.ts"]);
    expect(bytes.attemptScopeChangedPaths).toEqual([]);
    expect(result.transition.kind).toBe("implemented");
    expect(result.state.tasks[0]?.proof).toMatchObject({
      state: "satisfied",
      results: [
        { state: "satisfied", evidence: { kind: "task-completed" } },
        { state: "satisfied", evidence: { kind: "behaviour-preserved", basis: { kind: "unchanged" } } },
      ],
    });
  });

  it("owes a regression pass for the bytes this attempt changed", () => {
    const passed = settleDistill("c", ["src/a.ts"], { verdict: "trusted-pass" });
    expect(passed.result.transition.kind).toBe("implemented");
    expect(passed.result.state.tasks[0]?.proof).toMatchObject({
      results: [{}, { evidence: { kind: "behaviour-preserved", basis: { kind: "tests-passed", provenance: "evidence-ledger" } } }],
    });
    const untested = settleDistill("c", ["src/a.ts"]);
    expect(untested.result.transition.kind).toBe("retry-required");
    expect(untested.result.state.tasks[0]?.proof).toMatchObject({
      state: "failed",
      failures: [{ kind: "test-result-missing" }],
    });
  });

  it("never lets a write the transcript did not report settle as unchanged", () => {
    const { bytes, result } = settleDistill("c", []);
    expect(bytes.attributedAttemptChangedPaths).toEqual([]);
    expect(bytes.attemptScopeChangedPaths).toEqual(["src/a.ts"]);
    expect(result.transition.kind).toBe("retry-required");
  });
});

describe("attestation can never be armed on a Distill Task", () => {
  it("refuses, so the combination the State File rejects is never written", () => {
    const distill = taskFixture({ id: "T2", description: "Distill pass", agent: DISTILL_AGENT, wave: 1, depends_on: [], file_list: ["src/a.ts"] });
    const armed = armImplementationAttestation(distill, { executing: false });
    expect(armed.ok).toBe(false);
    if (armed.ok) return;
    expect(armed.error).toEqual({ kind: "distill-task-not-attestable", taskId: "T2" });
    expect(renderImplementationLifecycleError(armed.error)).toMatch(/Task T2 is its Wave's distill pass.*cannot be attested/);
  });
});

describe("a Distill Task is no part of the owner schedule", () => {
  const family = ownerObligation({
    invariant: "INV-1",
    title: "One owner",
    statement: null,
    owner: "src/owner.ts",
    siblings: [{ path: "src/sibling.ts", note: null }],
    matrixTest: "tests/owner.matrix.test.ts",
    mutation: { kind: "verify" },
  });
  const task = (id: string, wave: number, files: readonly string[], agent = "code-implementer-agent", start_sha?: string) =>
    ({ id, wave, file_list: files, agent, ...(start_sha === undefined ? {} : { start_sha }) });
  const authored = [
    task("T1", 1, ["src/owner.ts", "tests/owner.matrix.test.ts"], "code-implementer-agent", "a".repeat(40)),
    task("T2", 2, ["src/sibling.ts"], "code-implementer-agent", "a".repeat(40)),
  ];
  const withDistill = [
    ...authored,
    task("T3", 1, ["src/owner.ts"], DISTILL_AGENT),
    task("T4", 2, ["src/sibling.ts"], DISTILL_AGENT),
  ];

  it("leaves what each Wave owes and what is due exactly as its siblings decide", () => {
    for (const wave of [1, 2]) {
      expect(owesInWave(withDistill, new Set(), wave, family)).toBe(owesInWave(authored, new Set(), wave, family));
      expect(duePaths(withDistill, wave, family)).toEqual(duePaths(authored, wave, family));
      expect(waveOwnerDuty({ tasks: withDistill, owner_obligations: [family] }, wave))
        .toEqual(waveOwnerDuty({ tasks: authored, owner_obligations: [family] }, wave));
    }
  });

  it("never makes a Wave owe on its own listing: a contract Task's stub Wave still owes nothing", () => {
    const stubWave = [task("T1", 1, ["src/owner.ts"]), task("T2", 1, ["src/owner.ts"], DISTILL_AGENT)];
    expect(owesInWave(stubWave, new Set(["T1"]), 1, family)).toBe(false);
  });

  it("is not a Task whose change the mutants cover, so it adds no second Wave base and no missing one", () => {
    expect(implementationTasks({ tasks: withDistill }).map(({ id }) => id)).toEqual(["T1", "T2"]);
    // The Distill Task records no start_sha here; counted, it would be a missing-wave-base refusal.
    expect(waveBaseOf(implementationTasks({ tasks: withDistill }), 1, family.owner))
      .toEqual({ ok: true, value: { kind: "commit", sha: "a".repeat(40) } });
  });
});
