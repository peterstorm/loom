/**
 * The one-contract population scenario two suites share: CT-1 with no types
 * file and one acceptance file deciding FR-001, and an authored Task builder.
 */
import type { AuthoredTask } from "../../src/core/task-graph-population";
import type { PlanContract } from "../../src/types";

/** CT-1, freezing `acceptance` (deciding FR-001) and no types file. */
export const loadContract = (acceptance: string): PlanContract => ({
  id: "CT-1",
  title: "Load contract",
  declaration: {
    kind: "declared",
    types: { kind: "none", reason: "the slice consumes another surface" },
    acceptance: [{ path: acceptance, anchors: ["FR-001"] }],
    supportedDomain: null,
    entryPoint: null,
    runtimeSeams: [],
    statement: "Loads.",
  },
});

/** An authored implementer Task of `wave` owning `src/<id>.ts`, new tests required; `overrides` replace any field. */
export const authoredTask = (id: string, wave: number, overrides: Partial<AuthoredTask> = {}): AuthoredTask => ({
  id,
  description: `task ${id}`,
  agent: "code-implementer-agent",
  wave,
  depends_on: [],
  spec_anchors: [],
  spec_contributions: [],
  verification_policy: { regression: { kind: "required" }, new_tests: { kind: "required" } },
  file_list: [`src/${id}.ts`],
  ...overrides,
});
