/**
 * A Task under the I6-era manifest, as the plan-edit suites (re-scope,
 * dependency edits) build them: a pending one carries the Proof population
 * derives for it there; `extra` replaces any field.
 */
import type { Task } from "../../src/types";
import { i6PendingTaskFixture, taskFixture } from "./task-lifecycle";

const REQUIRED = { regression: { kind: "required" as const }, new_tests: { kind: "required" as const } };

export const i6PlanTask = (id: string, wave: number, fileList: readonly string[], extra: Partial<Task> = {}): Task => {
  const input = {
    id, description: id, agent: "code-implementer-agent", wave, depends_on: [],
    file_list: [...fileList], spec_anchors: [], spec_contributions: [],
    verification_policy: REQUIRED, review_status: "pending" as const,
    ...extra,
  };
  return extra.status === undefined || extra.status === "pending" ? i6PendingTaskFixture(input) : taskFixture(input);
};
