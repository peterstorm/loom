import { describe, it, expect, vi } from "vitest";
import { validateMinimal, validateFull } from "../../src/handlers/helpers/validate-task-graph";

describe("validateMinimal (pure)", () => {
  it("accepts valid minimal graph", () => {
    const result = validateMinimal({
      current_phase: "init",
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects missing current_phase", () => {
    const result = validateMinimal({ phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: null });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Missing required field: current_phase");
  });

  it("rejects invalid phase value", () => {
    const result = validateMinimal({ current_phase: "invalid", phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: null });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("not a valid phase");
  });

  it("rejects non-object phase_artifacts", () => {
    const result = validateMinimal({ current_phase: "init", phase_artifacts: "string", skipped_phases: [], spec_file: null, plan_file: null });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("phase_artifacts must be object");
  });

  it("rejects non-array skipped_phases", () => {
    const result = validateMinimal({ current_phase: "init", phase_artifacts: {}, skipped_phases: "string", spec_file: null, plan_file: null });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("skipped_phases must be array");
  });

  it("rejects missing spec_file and plan_file keys", () => {
    const result = validateMinimal({ current_phase: "init", phase_artifacts: {}, skipped_phases: [] });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Missing required field: spec_file");
    expect(result.errors).toContain("Missing required field: plan_file");
  });
});

describe("validateFull (pure)", () => {
  const validTask = {
    id: "T1",
    description: "Implement feature",
    agent: "code-implementer-agent",
    wave: 1,
    depends_on: [],
  };

  it("accepts valid task graph", () => {
    const result = validateFull({
      plan_title: "Test plan",
      plan_file: ".claude/plans/plan.md",
      spec_file: ".claude/specs/spec.md",
      tasks: [validTask],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects missing required top-level fields", () => {
    const result = validateFull({ tasks: [validTask] });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Missing required field: plan_title");
  });

  it("rejects non-array tasks", () => {
    const result = validateFull({ plan_title: "x", plan_file: "x", spec_file: "x", tasks: "not-array" });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("'tasks' must be an array");
  });

  it("rejects empty tasks array", () => {
    const result = validateFull({ plan_title: "x", plan_file: "x", spec_file: "x", tasks: [] });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("'tasks' array is empty");
  });

  it("validates task ID format", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [{ ...validTask, id: "bad-id" }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("id must match");
  });

  it("rejects unknown agent", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [{ ...validTask, agent: "fake-agent" }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("unknown agent");
  });

  it("rejects self-dependency", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [{ ...validTask, depends_on: ["T1"] }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("self-dependency");
  });

  it("rejects dependency on non-existent task", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [{ ...validTask, depends_on: ["T99"] }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("non-existent");
  });

  it("rejects dependency on same-or-later wave", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [
        { ...validTask, id: "T1", wave: 1, depends_on: [] },
        { ...validTask, id: "T2", wave: 1, depends_on: ["T1"] },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("deps must be in earlier wave");
  });

  it("accepts valid cross-wave dependency", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [
        { ...validTask, id: "T1", wave: 1, depends_on: [] },
        { ...validTask, id: "T2", wave: 2, depends_on: ["T1"] },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects wave gaps (1 → 3)", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [
        { ...validTask, id: "T1", wave: 1, depends_on: [] },
        { ...validTask, id: "T2", wave: 3, depends_on: [] },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("Wave gap");
  });

  it("detects multiple wave gaps (1 → 3 → 7)", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [
        { ...validTask, id: "T1", wave: 1, depends_on: [] },
        { ...validTask, id: "T2", wave: 3, depends_on: [] },
        { ...validTask, id: "T3", wave: 7, depends_on: [] },
      ],
    });
    expect(result.ok).toBe(false);
    const gapErrors = result.errors.filter(e => e.includes("Wave gap"));
    expect(gapErrors).toHaveLength(2);
  });

  it("does not warn when new_tests_required=false and description mentions ADR", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [
        { ...validTask, id: "T1", description: "Write ADR for state-management decision",
          new_tests_required: false, agent: "adr-writer-agent" },
      ],
    });
    expect(result.ok).toBe(true);
    const warned = stderr.mock.calls.some(([msg]) => String(msg).includes("doesn't match no-test patterns"));
    expect(warned).toBe(false);
    stderr.mockRestore();
  });

  it("warns when new_tests_required=false and description has no exempt keyword", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [{ ...validTask, description: "Implement core auth logic", new_tests_required: false }],
    });
    const warned = stderr.mock.calls.some(([msg]) => String(msg).includes("doesn't match no-test patterns"));
    expect(warned).toBe(true);
    stderr.mockRestore();
  });

  it("accepts ADR task in final wave with impl tasks in earlier waves", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [
        { ...validTask, id: "T1", wave: 1, agent: "code-implementer-agent" },
        { ...validTask, id: "T2", wave: 2, depends_on: ["T1"],
          agent: "adr-writer-agent", description: "Write ADR for choice", new_tests_required: false },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects ADR task in same wave as impl tasks", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [
        { ...validTask, id: "T1", wave: 1, agent: "code-implementer-agent" },
        { ...validTask, id: "T2", wave: 1,
          agent: "adr-writer-agent", description: "Write ADR for choice", new_tests_required: false },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes("ADR task wave"))).toBe(true);
  });

  it("rejects ADR task in non-final wave", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [
        { ...validTask, id: "T1", wave: 1, agent: "code-implementer-agent" },
        { ...validTask, id: "T2", wave: 2, depends_on: ["T1"],
          agent: "adr-writer-agent", description: "ADR doc", new_tests_required: false },
        { ...validTask, id: "T3", wave: 3, depends_on: ["T1"], agent: "code-implementer-agent" },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.includes("must be in the final wave"))).toBe(true);
  });

  it("accepts contiguous waves (1, 2, 3)", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [
        { ...validTask, id: "T1", wave: 1, depends_on: [] },
        { ...validTask, id: "T2", wave: 2, depends_on: [] },
        { ...validTask, id: "T3", wave: 3, depends_on: [] },
      ],
    });
    expect(result.ok).toBe(true);
  });
});
