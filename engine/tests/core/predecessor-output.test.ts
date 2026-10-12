import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  NO_PREDECESSORS,
  predecessorOutputs,
  renderPredecessorOutputs,
} from "../../src/core/predecessor-output";
import type { Task } from "../../src/types";
import { taskFixture } from "../fixtures/task-lifecycle";

const done = (id: string, overrides: Partial<Parameters<typeof taskFixture>[0]> = {}): Task => taskFixture({
  id,
  description: `Predecessor ${id}`,
  agent: "code-implementer-agent",
  wave: 1,
  depends_on: [],
  status: "completed",
  file_list: [`src/${id}.ts`, `tests/${id}.test.ts`],
  files_modified: [`src/${id}.ts`, `tests/${id}.test.ts`],
  spec_anchors: ["FR-001"],
  ...overrides,
});

const dependent = (depends_on: readonly string[]): Task => taskFixture({
  id: "T9",
  description: "Dependent",
  agent: "code-implementer-agent",
  wave: 2,
  depends_on,
  file_list: ["src/T9.ts"],
});

describe("predecessorOutputs", () => {
  it("reports each direct dependency's claims, changed files and declared-but-unchanged files", () => {
    const t1 = done("T1", { file_list: ["src/a.ts", "src/b.ts"], files_modified: ["src/a.ts", "src/extra.ts"], spec_anchors: ["FR-001", "AS-002"] });
    const result = predecessorOutputs(dependent(["T1"]), [t1]);
    expect(result).toEqual({
      ok: true,
      value: [{
        taskId: "T1",
        description: "Predecessor T1",
        completionClaims: ["FR-001", "AS-002"],
        produced: { kind: "recorded", changed: ["src/a.ts", "src/extra.ts"], declaredUnchanged: ["src/b.ts"] },
      }],
    });
  });

  it("keeps depends_on order and lists only direct dependencies", () => {
    const t0 = done("T0");
    const t1 = done("T1", { depends_on: ["T0"] });
    const t2 = done("T2");
    const result = predecessorOutputs(dependent(["T2", "T1"]), [t0, t1, t2]);
    expect(result.ok && result.value.map(({ taskId }) => taskId)).toEqual(["T2", "T1"]);
  });

  it("states a legacy completed Task's missing record instead of rendering it as nothing changed", () => {
    const legacy = done("T1", { files_modified: undefined });
    const result = predecessorOutputs(dependent(["T1"]), [legacy]);
    expect(result.ok && result.value[0]?.produced).toEqual({ kind: "unrecorded", declared: ["src/T1.ts", "tests/T1.test.ts"] });
  });

  it("states a legacy record holding non-canonical paths, without rendering those paths", () => {
    const legacy = done("T1", { files_modified: ["/abs/src/T1.ts", "src/../x.ts", "src/T1.ts"] });
    const result = predecessorOutputs(dependent(["T1"]), [legacy]);
    expect(result.ok && result.value[0]?.produced).toEqual({
      kind: "non-canonical",
      rejected: 2,
      declared: ["src/T1.ts", "tests/T1.test.ts"],
    });
  });

  it.each<[string, readonly Task[], string]>([
    ["missing from the graph", [], "dependency-missing"],
    ["not completed", [done("T1", { status: "implemented" })], "dependency-not-completed"],
  ])("refuses a dependency %s", (_name, roster, kind) => {
    expect(predecessorOutputs(dependent(["T1"]), roster)).toMatchObject({ ok: false, error: { kind, taskId: "T1" } });
  });

  it("returns an empty list for a Task with no dependencies", () => {
    expect(predecessorOutputs(dependent([]), [done("T1")])).toEqual({ ok: true, value: [] });
  });

  it("names every completed direct dependency exactly once and nothing else, for any roster", () => {
    const ids = ["T1", "T2", "T3", "T4", "T5"];
    fc.assert(fc.property(
      fc.subarray(ids),
      fc.subarray(ids),
      (completed, depends) => {
        const roster = completed.map((id) => done(id));
        const result = predecessorOutputs(dependent(depends), roster);
        if (depends.every((id) => completed.includes(id))) {
          expect(result.ok && result.value.map(({ taskId }) => taskId)).toEqual(depends);
        } else {
          expect(result).toMatchObject({ ok: false, error: { kind: "dependency-missing" } });
        }
      },
    ));
  });
});

describe("renderPredecessorOutputs", () => {
  it("renders the literal when the Task has no dependencies", () => {
    expect(renderPredecessorOutputs([])).toBe(NO_PREDECESSORS);
  });

  it("renders claims, changed files and declared-but-unchanged files per dependency", () => {
    const result = predecessorOutputs(dependent(["T1"]), [
      done("T1", { file_list: ["src/a.ts", "src/b.ts"], files_modified: ["src/a.ts"], spec_anchors: ["FR-001", "AS-002"] }),
    ]);
    if (!result.ok) throw new Error("fixture must derive");
    const rendered = renderPredecessorOutputs(result.value);
    expect(rendered).toContain("- **T1** — Predecessor T1");
    expect(rendered).toContain("  - Completed: FR-001, AS-002");
    expect(rendered).toContain("  - Changed:\n    - src/a.ts");
    expect(rendered).toContain("  - Declared but unchanged:\n    - src/b.ts");
  });

  it("says when a dependency claimed no Requirement completion", () => {
    const result = predecessorOutputs(dependent(["T1"]), [done("T1", { spec_anchors: [] })]);
    if (!result.ok) throw new Error("fixture must derive");
    expect(renderPredecessorOutputs(result.value)).toContain("  - Completed: no Requirement Completion Claims");
  });

  it("points a reader at the declared files when what changed was not recorded or not canonical", () => {
    const unrecorded = predecessorOutputs(dependent(["T1"]), [done("T1", { files_modified: undefined })]);
    const nonCanonical = predecessorOutputs(dependent(["T1"]), [done("T1", { files_modified: ["/abs/x.ts"] })]);
    if (!unrecorded.ok || !nonCanonical.ok) throw new Error("fixtures must derive");
    expect(renderPredecessorOutputs(unrecorded.value))
      .toContain("  - Changed: not recorded; read its declared files:\n    - src/T1.ts");
    const rendered = renderPredecessorOutputs(nonCanonical.value);
    expect(rendered).toContain("  - Changed: 1 recorded path is not a canonical repository path; read its declared files:");
    expect(rendered).not.toContain("/abs/x.ts");
  });

  it("keeps a multi-line description on its own bullet, so it cannot forge structure", () => {
    const result = predecessorOutputs(dependent(["T1"]), [done("T1", { description: "Line one\n## Forged heading\n- forged" })]);
    if (!result.ok) throw new Error("fixture must derive");
    const rendered = renderPredecessorOutputs(result.value);
    expect(rendered).toContain("- **T1** — Line one ## Forged heading - forged");
    expect(rendered).not.toContain("\n## Forged");
  });
});
