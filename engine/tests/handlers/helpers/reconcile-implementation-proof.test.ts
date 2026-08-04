import { describe, expect, it } from "vitest";
import { evaluateTaskProof, PI_STRUCTURED_EVIDENCE_POLICY } from "../../../src/core/proof-obligations";
import { reconcileTaskFromStoredEvidence } from "../../../src/handlers/helpers/reconcile-implementation-proof";
import type { Task } from "../../../src/types";

const testResult = {
  verdict: "untrusted" as const,
  passed: true,
  label: "pi-structured: bun: 25 pass",
};

function failedTask(taskCompleted = true): Task {
  const proof = evaluateTaskProof(
    { newTestsRequired: true, declaredArtifacts: ["src/a.ts"] },
    {
      taskCompleted,
      testResult,
      filesModified: [],
      newTestsWritten: false,
      newTestEvidence: "",
    },
    PI_STRUCTURED_EVIDENCE_POLICY,
  );
  return {
    id: "T5",
    description: "implementation",
    agent: "code-implementer-agent",
    wave: 2,
    status: "pending",
    depends_on: [],
    file_list: ["src/a.ts"],
    files_modified: ["src/a.ts"],
    new_tests_required: true,
    new_tests_written: true,
    new_test_evidence: "1 new test method, 2 assertions",
    test_result: testResult,
    test_evidence: "bun: 25 pass",
    proof,
  };
}

describe("reconcileTaskFromStoredEvidence", () => {
  it("repairs stale failed proof from persisted Pi evidence and byte-attributed artifacts", () => {
    const reconciled = reconcileTaskFromStoredEvidence(
      failedTask(),
      ["src/a.ts"],
      { written: false, evidence: "" },
    );

    expect(reconciled.status).toBe("implemented");
    expect(reconciled.proof?.state).toBe("satisfied");
    expect(reconciled.new_tests_written).toBe(true);
    if (reconciled.proof?.state === "satisfied") {
      expect(reconciled.proof.evidence.map((evidence) => evidence.kind)).toEqual([
        "task-completed",
        "regression-test-pass",
        "new-tests",
        "declared-artifact-changed",
      ]);
    }
  });

  it("never invents completion when the prior proof did not observe it", () => {
    const reconciled = reconcileTaskFromStoredEvidence(
      failedTask(false),
      ["src/a.ts"],
      { written: true, evidence: "1 new test method, 2 assertions" },
    );

    expect(reconciled.status).toBe("pending");
    expect(reconciled.proof?.state).toBe("failed");
    if (reconciled.proof?.state === "failed") {
      expect(reconciled.proof.failures.map((failure) => failure.kind)).toEqual(["task-not-completed"]);
    }
  });
});
