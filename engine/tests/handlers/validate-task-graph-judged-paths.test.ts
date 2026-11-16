import { describe, expect, it } from "vitest";
import { validateFull } from "../../src/handlers/helpers/validate-task-graph";

const REQUIRED = { regression: { kind: "required" }, new_tests: { kind: "required" } } as const;

const task = (id: string, wave: number, file_list: readonly string[], extra: Record<string, unknown> = {}) => ({
  id,
  description: `Implement ${id}`,
  agent: "code-implementer-agent",
  wave,
  depends_on: [],
  spec_anchors: [],
  spec_contributions: [],
  verification_policy: REQUIRED,
  plan_context: "",
  file_list,
  ...extra,
});

const payload = (tasks: readonly Record<string, unknown>[]) => ({
  spec_trace_version: 2,
  plan_title: "Judged paths",
  plan_file: ".claude/plans/p.md",
  spec_file: ".claude/specs/s/spec.md",
  tasks,
});

const errorsOf = (result: ReturnType<typeof validateFull>): readonly string[] => result.ok ? [] : result.errors;

describe("validate-task-graph --decompose-payload: judged_paths", () => {
  it("accepts a payload that declares no judged paths (the field is optional)", () => {
    expect(validateFull(payload([task("T1", 1, ["src/a.ts"])]), "decompose-payload").ok).toBe(true);
  });

  it("refuses a judge scheduled after the Wave of the code it judges", () => {
    const result = validateFull(payload([
      task("T1", 1, ["src/serve.ts"]),
      task("T2", 2, ["tests/budget.test.ts"], { depends_on: ["T1"], judged_paths: ["src/serve.ts"] }),
    ]), "decompose-payload");
    expect(errorsOf(result)).toEqual([
      expect.stringContaining("Task T2 (Wave 2) judges 'src/serve.ts', which T1 writes in the earlier Wave 1"),
    ]);
  });

  it("accepts the judge in or before the writer's Wave", () => {
    const result = validateFull(payload([
      task("T1", 1, ["tests/budget.test.ts"], { judged_paths: ["src/serve.ts"] }),
      task("T2", 2, ["src/serve.ts"], { depends_on: ["T1"] }),
    ]), "decompose-payload");
    expect(result.ok).toBe(true);
  });

  it("refuses malformed judged_paths with the parser's diagnostics and derives no rule error from them", () => {
    const result = validateFull(payload([
      task("T1", 1, ["src/a.ts"], { judged_paths: "src/a.ts" }),
    ]), "decompose-payload");
    expect(errorsOf(result)).toEqual(["Task T1: 'judged_paths' must be an array of paths"]);
  });

  it("does not apply to stored State Files, which never carry judged_paths", () => {
    // A state-file graph is refused or admitted by the loader; judged_paths is
    // decompose-only, so the rule must not introduce state-file diagnostics.
    const result = validateFull(payload([task("T1", 1, ["src/a.ts"], { judged_paths: ["src/nobody.ts"] })]), "state-file");
    expect(errorsOf(result).some((error) => error.includes("judged path"))).toBe(false);
  });
});
