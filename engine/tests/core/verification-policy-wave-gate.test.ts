import { describe, expect, it } from "vitest";
import {
  checkNewTests,
  checkTestEvidence,
} from "../../src/core/wave-gate-machine";
import { evaluateTaskProof } from "../../src/core/proof-obligations";
import type { Task } from "../../src/types";
import { pendingTaskProof } from "../fixtures/task-lifecycle";

const task = (verification_policy: Task["verification_policy"]): Task => ({
  id: "T1",
  description: "verify independently",
  agent: "code-implementer-agent",
  wave: 1,
  status: "pending",
  proof: pendingTaskProof(),
  depends_on: [],
  verification_policy,
});

describe("VerificationPolicy Wave Gate parity", () => {
  it("requires regression while waiving new-test creation", () => {
    const source = task({
      regression: { kind: "required" },
      new_tests: { kind: "waived", reason: "existing-tests-sufficient" },
    });
    expect(checkTestEvidence([source]).passed).toBe(false);
    const newTestCheck = checkNewTests([source]);
    expect(newTestCheck.passed).toBe(true);
    expect(newTestCheck.passed && newTestCheck.summary).toContain(
      "verification_policy.new_tests waived: existing-tests-sufficient",
    );

    const proof = evaluateTaskProof({
      verificationPolicy: {
        regression: { kind: "required" },
        newTests: { kind: "waived", reason: "existing-tests-sufficient" },
      },
      declaredArtifacts: [],
    }, {
      taskCompleted: true,
      testResult: { verdict: "trusted-pass" },
      filesModified: [],
      newTestsWritten: false,
    });
    expect(proof.state).toBe("satisfied");
  });

  it("requires new tests while waiving regression execution", () => {
    const source = {
      ...task({
        regression: { kind: "waived", reason: "documentation-only" },
        new_tests: { kind: "required" },
      }),
      new_tests_written: false,
    };
    expect(checkTestEvidence([source]).passed).toBe(true);
    expect(checkNewTests([source]).passed).toBe(false);

    const proof = evaluateTaskProof({
      verificationPolicy: {
        regression: { kind: "waived", reason: "documentation-only" },
        newTests: { kind: "required" },
      },
      declaredArtifacts: [],
    }, {
      taskCompleted: true,
      filesModified: [],
      newTestsWritten: true,
      newTestEvidence: "one property",
    });
    expect(proof.state).toBe("satisfied");
  });
});
