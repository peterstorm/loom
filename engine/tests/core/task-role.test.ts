import { describe, expect, expectTypeOf, it } from "vitest";
import fc from "fast-check";
import {
  isDistillTask,
  taskRoleOf,
  taskRolePolicy,
  taskRolePolicyOf,
  type DistillTaskView,
  type TaskRole,
  type TaskRolePolicy,
} from "../../src/core/distill-task";
import type { DistillTrialSettlement } from "../../src/core/distill-snapshot";
import type { ImplementationSettlementApplicationResult } from "../../src/core/implementation-application";
import { DISTILL_AGENT } from "../../src/core/model-profiles";
import type { Task } from "../../src/types";

const ROLES = ["authored", "distill"] as const satisfies readonly TaskRole[];

describe("Task role", () => {
  it("is distill for exactly the distill agent, whatever else the record holds", () => {
    fc.assert(fc.property(fc.anything(), (agent) => {
      expect(taskRoleOf({ agent })).toBe(agent === DISTILL_AGENT ? "distill" : "authored");
    }));
    expect(taskRoleOf({})).toBe("authored");
    expect(taskRoleOf({ agent: DISTILL_AGENT })).toBe("distill");
  });

  it("isDistillTask agrees with the role and narrows only the agent", () => {
    fc.assert(fc.property(fc.oneof(fc.constant(DISTILL_AGENT), fc.string()), (agent) => {
      const task = { id: "T1", agent };
      expect(isDistillTask(task)).toBe(taskRoleOf(task) === "distill");
      if (isDistillTask(task)) {
        expectTypeOf(task.agent).toEqualTypeOf<typeof DISTILL_AGENT>();
        expectTypeOf(task.id).toEqualTypeOf<string>();
      }
    }));
  });

  it("covers every role, so the roster below is the whole union", () => {
    expectTypeOf<(typeof ROLES)[number]>().toEqualTypeOf<TaskRole>();
  });

  it("answers a Task's policy from its role alone", () => {
    for (const role of ROLES) {
      const agent = role === "distill" ? DISTILL_AGENT : "code-implementer-agent";
      expect(taskRoleOf({ agent })).toBe(role);
      expect(taskRolePolicy({ agent })).toBe(taskRolePolicyOf(role));
    }
  });

  it("gives the two roles opposite answers on every rule", () => {
    const authored = taskRolePolicyOf("authored");
    const distill = taskRolePolicyOf("distill");

    expect(authored).toEqual({
      authorable: true,
      holdsSkeletons: true,
      declaredArtifacts: "produced",
      attestable: true,
      traceable: true,
      schedulesFamilies: true,
      waveReviewExemption: null,
      proofSettlement: "reconcilable",
      dispatchAppendix: "none",
      totalTestWaiver: "suspicious",
    } satisfies TaskRolePolicy);
    expect(distill).toEqual({
      authorable: false,
      holdsSkeletons: false,
      declaredArtifacts: "preserved",
      attestable: false,
      traceable: false,
      schedulesFamilies: false,
      waveReviewExemption: "distill-task",
      proofSettlement: "attempt-only",
      dispatchAppendix: "distill",
      totalTestWaiver: "by-construction",
    } satisfies TaskRolePolicy);
    for (const rule of Object.keys(authored) as readonly (keyof TaskRolePolicy)[]) {
      expect(distill[rule], rule).not.toEqual(authored[rule]);
    }
  });

  it("freezes the policies", () => {
    for (const role of ROLES) expect(Object.isFrozen(taskRolePolicyOf(role))).toBe(true);
  });
});

describe("structural views the distill modules declare instead of importing", () => {
  it("DistillTaskView is a view of Task, with the same closed status union", () => {
    expectTypeOf<Task>().toExtend<DistillTaskView>();
    expectTypeOf<Task["status"]>().toEqualTypeOf<DistillTaskView["status"]>();
  });

  it("DistillTrialSettlement is a view of the settlement application result", () => {
    expectTypeOf<ImplementationSettlementApplicationResult>().toExtend<DistillTrialSettlement>();
    expectTypeOf<ImplementationSettlementApplicationResult["kind"]>().toEqualTypeOf<DistillTrialSettlement["kind"]>();
  });
});
