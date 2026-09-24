/**
 * Attestation-mode load invariants (D4 option 2).
 *
 * The TaskGraph load boundary proves flag/obligation/policy lockstep for
 * attestation Tasks: the mode flag, the attested declared-artifact obligations,
 * and the new-tests-waived policy stand or fall together, so a hand-edited or
 * drifted graph is refused with a diagnostic instead of reaching gate logic
 * that would read the contradiction as truth.
 */

import { describe, expect, it } from "vitest";
import { parseTaskGraph } from "../src/state-manager";
import { derivePendingTaskProof, type TaskProof } from "../src/core/proof-obligations";
import type { VerificationPolicy } from "../src/core/verification-policy";

const ATTESTED_POLICY: VerificationPolicy = Object.freeze({
  regression: Object.freeze({ kind: "required" as const }),
  newTests: Object.freeze({ kind: "waived" as const, reason: "existing-tests-sufficient" }),
});
const STORED_ATTESTED_POLICY = {
  regression: { kind: "required" },
  new_tests: { kind: "waived", reason: "existing-tests-sufficient" },
};
const REQUIRED_POLICY = {
  regression: { kind: "required" },
  new_tests: { kind: "required" },
};
const REGRESSION_WAIVED_POLICY = {
  regression: { kind: "waived", reason: "documentation-only" },
  new_tests: { kind: "waived", reason: "existing-tests-sufficient" },
};

const attestationProof = (artifacts: readonly string[] = ["src/a.ts"], policy = ATTESTED_POLICY): TaskProof =>
  derivePendingTaskProof({
    verificationPolicy: policy,
    declaredArtifacts: artifacts,
    declaredArtifactExpectation: "attested",
  });

const graphWith = (task: Record<string, unknown>): unknown => ({
  current_phase: "execute",
  current_wave: 1,
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: null,
  tasks: [{
    id: "T1",
    description: "attestation fixture",
    agent: "code-implementer-agent",
    wave: 1,
    depends_on: [],
    file_list: ["src/a.ts"],
    status: "pending",
    ...task,
  }],
  wave_gates: {},
});

const attestationTask = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  implementation_attestation: true,
  verification_policy: STORED_ATTESTED_POLICY,
  proof: attestationProof(),
  ...overrides,
});

describe("attestation Task load lockstep", () => {
  it("loads a consistent attestation Task: flag, attested obligations, waived policy", () => {
    const parsed = parseTaskGraph(graphWith(attestationTask()));
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    const task = parsed.value.tasks[0]!;
    expect(task.implementation_attestation).toBe(true);
    expect(task.proof?.obligations.map((obligation) => obligation.kind)).toEqual([
      "task-completed", "regression-test-pass", "attempt-scope-attested", "declared-artifact-attested",
    ]);
  });

  it("derives attested pending proof for a proof-less attestation Task at migration", () => {
    const parsed = parseTaskGraph(graphWith(attestationTask({ proof: undefined })));
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    const proof = parsed.value.tasks[0]!.proof;
    expect(proof?.state).toBe("pending");
    expect(proof?.obligations.some((obligation) => obligation.kind === "declared-artifact-attested")).toBe(true);
    // The migrated proof must NOT demand new tests.
    expect(proof?.obligations.some((obligation) => obligation.kind === "new-tests")).toBe(false);
  });

  it("refuses attestation obligations without the mode flag", () => {
    const parsed = parseTaskGraph(graphWith(attestationTask({ implementation_attestation: undefined })));
    expect(parsed).toMatchObject({
      ok: false,
      error: expect.stringContaining("proof obligations do not exactly match verification policy and file_list"),
    });
  });

  it("refuses changed obligations under the mode flag", () => {
    const parsed = parseTaskGraph(graphWith(attestationTask({
      proof: derivePendingTaskProof({
        verificationPolicy: ATTESTED_POLICY,
        declaredArtifacts: ["src/a.ts"],
        declaredArtifactExpectation: "changed",
      }),
    })));
    expect(parsed).toMatchObject({
      ok: false,
      error: expect.stringContaining("proof obligations do not exactly match verification policy and file_list"),
    });
  });

  it("refuses attestation mode when regression verification is waived", () => {
    const parsed = parseTaskGraph(graphWith(attestationTask({
      verification_policy: REGRESSION_WAIVED_POLICY,
      proof: derivePendingTaskProof({
        verificationPolicy: {
          regression: { kind: "waived", reason: "documentation-only" },
          newTests: { kind: "waived", reason: "existing-tests-sufficient" },
        },
        declaredArtifacts: ["src/a.ts"],
        declaredArtifactExpectation: "attested",
      }),
    })));
    expect(parsed).toMatchObject({
      ok: false,
      error: expect.stringContaining("attestation mode requires regression verification"),
    });
  });

  it("refuses attestation mode with a policy that still requires new tests", () => {
    const parsed = parseTaskGraph(graphWith(attestationTask({
      verification_policy: REQUIRED_POLICY,
      new_tests_required: undefined,
      proof: attestationProof(["src/a.ts"], ATTESTED_POLICY),
    })));
    expect(parsed).toMatchObject({
      ok: false,
      error: expect.stringContaining("attestation mode requires a verification policy that waives new tests"),
    });
  });

  it("refuses attestation mode with a legacy execution reservation", () => {
    const parsed = parseTaskGraph(graphWith({
      ...attestationTask(),
      legacy_execution_reservation: true,
    }));
    expect(parsed).toMatchObject({
      ok: false,
      error: expect.stringContaining("attestation mode requires a modern implementation dispatch"),
    });
  });

  it("refuses an attestation Task whose obligations disagree with file_list", () => {
    const parsed = parseTaskGraph(graphWith(attestationTask({
      file_list: ["src/a.ts", "src/b.ts"],
    })));
    expect(parsed).toMatchObject({
      ok: false,
      error: expect.stringContaining("proof obligations do not exactly match verification policy and file_list"),
    });
  });

  it("refuses a non-true implementation_attestation value", () => {
    const parsed = parseTaskGraph(graphWith(attestationTask({ implementation_attestation: false })));
    expect(parsed).toMatchObject({
      ok: false,
      error: expect.stringContaining("implementation_attestation must be true when present"),
    });
  });
});
