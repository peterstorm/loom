import { describe, it, expect } from "vitest";
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
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects missing current_phase", () => {
    const result = validateMinimal({ phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: null });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing required field: current_phase");
  });

  it("rejects invalid phase value", () => {
    const result = validateMinimal({ current_phase: "invalid", phase_artifacts: {}, skipped_phases: [], spec_file: null, plan_file: null });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("not a valid phase");
  });

  it("rejects non-object phase_artifacts", () => {
    const result = validateMinimal({ current_phase: "init", phase_artifacts: "string", skipped_phases: [], spec_file: null, plan_file: null });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("phase_artifacts must be object");
  });

  it("rejects non-array skipped_phases", () => {
    const result = validateMinimal({ current_phase: "init", phase_artifacts: {}, skipped_phases: "string", spec_file: null, plan_file: null });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("skipped_phases must be array");
  });

  it("rejects missing spec_file and plan_file keys", () => {
    const result = validateMinimal({ current_phase: "init", phase_artifacts: {}, skipped_phases: [] });
    expect(result.valid).toBe(false);
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
    expect(result.valid).toBe(true);
  });

  it("rejects missing required top-level fields", () => {
    const result = validateFull({ tasks: [validTask] });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing required field: plan_title");
  });

  it("rejects non-array tasks", () => {
    const result = validateFull({ plan_title: "x", plan_file: "x", spec_file: "x", tasks: "not-array" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("'tasks' must be an array");
  });

  it("rejects empty tasks array", () => {
    const result = validateFull({ plan_title: "x", plan_file: "x", spec_file: "x", tasks: [] });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("'tasks' array is empty");
  });

  it("validates task ID format", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [{ ...validTask, id: "bad-id" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("id must match");
  });

  it("rejects unknown agent", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [{ ...validTask, agent: "fake-agent" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("unknown agent");
  });

  it("rejects self-dependency", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [{ ...validTask, depends_on: ["T1"] }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("self-dependency");
  });

  it("rejects dependency on non-existent task", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [{ ...validTask, depends_on: ["T99"] }],
    });
    expect(result.valid).toBe(false);
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
    expect(result.valid).toBe(false);
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
    expect(result.valid).toBe(true);
  });

  it("rejects wave gaps (1 → 3)", () => {
    const result = validateFull({
      plan_title: "x", plan_file: "x", spec_file: "x",
      tasks: [
        { ...validTask, id: "T1", wave: 1, depends_on: [] },
        { ...validTask, id: "T2", wave: 3, depends_on: [] },
      ],
    });
    expect(result.valid).toBe(false);
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
    expect(result.valid).toBe(false);
    const gapErrors = result.errors.filter(e => e.includes("Wave gap"));
    expect(gapErrors).toHaveLength(2);
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
    expect(result.valid).toBe(true);
  });
});
