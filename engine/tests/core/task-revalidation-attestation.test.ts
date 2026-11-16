/**
 * Returning an attested Task to revalidation (a Task Reopening, a Contract
 * Revision or a reopened completed Wave) ends its attestation mode: the
 * reopening exists because its bytes must change, and an attested dispatch
 * forbids any change. The Task gets a fresh pending Proof with the normal
 * declared-artifact expectation under its current policy.
 */
import { describe, expect, it } from "vitest";
import { armImplementationAttestation } from "../../src/core/implementation-lifecycle";
import { returnToRevalidation } from "../../src/core/task-revalidation";
import { deriveTaskImplementationDispatch } from "../../src/core/task-implementation-dispatch";
import { taskVerificationPolicy } from "../../src/core/verification-policy";
import type { Task } from "../../src/types";
import { taskFixture } from "../fixtures/task-lifecycle";

const pendingTask = (): Task => taskFixture({
  id: "T1", description: "Implement T1", agent: "code-implementer-agent", wave: 1, depends_on: [],
  file_list: ["src/a.ts", "src/a.test.ts"], spec_anchors: [], spec_contributions: [], review_status: "pending", review_generation: 0,
});

/** T1 armed for attestation, as `helper orchestration attest` leaves it. */
const attestedTask = (): Task => {
  const command = armImplementationAttestation(pendingTask(), { executing: false });
  if (!command.ok) throw new Error(`fixture attestation refused: ${command.error.kind}`);
  return command.value.task;
};

const obligationKinds = (task: Task): readonly string[] =>
  (task.proof?.obligations ?? []).map((obligation) => JSON.stringify(obligation));

describe("returnToRevalidation of an attested Task", () => {
  it("ends attestation mode, so the reopened Task's dispatch no longer forbids changes", () => {
    const attested = attestedTask();
    const before = deriveTaskImplementationDispatch(attested);
    expect(before.kind === "dispatch" && before.dispatch.promptAppendix).toContain("LOOM_IMPLEMENTATION_ATTESTATION_CONTEXT");

    const reopened = returnToRevalidation(attested, undefined);
    expect(reopened.implementation_attestation).toBeUndefined();
    expect(obligationKinds(reopened).some((kind) => kind.includes("attested"))).toBe(false);
    const after = deriveTaskImplementationDispatch(reopened);
    expect(after.kind).toBe("dispatch");
    if (after.kind === "dispatch") expect(after.dispatch.promptAppendix ?? "").not.toContain("LOOM_IMPLEMENTATION_ATTESTATION_CONTEXT");
  });

  it("keeps the Task's current policy and marks it for revalidation at a new Review Generation", () => {
    const attested = attestedTask();
    const reopened = returnToRevalidation(attested, undefined);
    expect(taskVerificationPolicy(reopened)).toEqual(taskVerificationPolicy(attested));
    expect(reopened).toMatchObject({ status: "pending", revalidation_required: true, review_generation: 1 });
    expect(reopened.proof?.state).toBe("pending");
  });

  it("leaves a Task that was never attested exactly as before", () => {
    const task = pendingTask();
    const reopened = returnToRevalidation(task, undefined);
    expect(reopened.proof).toEqual(task.proof);
    expect(reopened.implementation_attestation).toBeUndefined();
  });
});
