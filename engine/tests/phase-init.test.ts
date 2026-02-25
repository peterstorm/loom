import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveInitialState } from "../src/phase-init";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("resolveInitialState", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "loom-pi-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("defaults: current_phase init, empty skipped_phases, spec_file null", () => {
    const state = resolveInitialState({}, tmpDir);
    expect(state.current_phase).toBe("init");
    expect(state.skipped_phases).toEqual([]);
    expect(state.spec_file).toBeNull();
    expect(state.plan_file).toBeNull();
    expect(state.spec_dir).toBe(tmpDir);
  });

  it("--skip-brainstorm: phase=specify, skipped=[brainstorm]", () => {
    const state = resolveInitialState({ skipBrainstorm: true }, tmpDir);
    expect(state.current_phase).toBe("specify");
    expect(state.skipped_phases).toEqual(["brainstorm"]);
    expect(state.spec_file).toBeNull();
  });

  it("--skip-clarify alone: phase=init, skipped=[clarify]", () => {
    const state = resolveInitialState({ skipClarify: true }, tmpDir);
    expect(state.current_phase).toBe("init");
    expect(state.skipped_phases).toEqual(["clarify"]);
  });

  it("--skip-specify: phase=architecture, skipped=[brainstorm,specify,clarify], spec_file set", () => {
    const specDir = join(tmpDir, "specs");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "spec.md"), "# Spec");

    const state = resolveInitialState({ skipSpecify: true }, specDir);
    expect(state.current_phase).toBe("architecture");
    expect(state.skipped_phases).toEqual(["brainstorm", "specify", "clarify"]);
    expect(state.spec_file).toBe(join(specDir, "spec.md"));
  });

  it("--skip-specify finds spec.md in nested dir", () => {
    const nested = join(tmpDir, "sub", "deep");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "spec.md"), "# Nested Spec");

    const state = resolveInitialState({ skipSpecify: true }, tmpDir);
    expect(state.spec_file).toBe(join(nested, "spec.md"));
  });

  it("--skip-specify throws when no spec.md on disk", () => {
    expect(() => resolveInitialState({ skipSpecify: true }, tmpDir))
      .toThrow(/--skip-specify requires existing spec.md/);
  });

  it("--skip-brainstorm + --skip-clarify: phase=specify, skipped=[brainstorm,clarify]", () => {
    const state = resolveInitialState({ skipBrainstorm: true, skipClarify: true }, tmpDir);
    expect(state.current_phase).toBe("specify");
    expect(state.skipped_phases).toEqual(["brainstorm", "clarify"]);
  });

  it("--skip-specify already includes clarify, no duplicate", () => {
    const specDir = join(tmpDir, "specs");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "spec.md"), "x");

    const state = resolveInitialState({ skipSpecify: true, skipClarify: true }, specDir);
    expect(state.skipped_phases).toEqual(["brainstorm", "specify", "clarify"]);
    // No duplicate "clarify"
    expect(state.skipped_phases.filter(p => p === "clarify")).toHaveLength(1);
  });

  it("returns proper TaskGraph shape", () => {
    const state = resolveInitialState({}, tmpDir);
    expect(state).toHaveProperty("phase_artifacts");
    expect(state).toHaveProperty("tasks");
    expect(state).toHaveProperty("wave_gates");
    expect(state.tasks).toEqual([]);
    expect(state.wave_gates).toEqual({});
  });

  it("--skip-plan-alignment: skipped=[plan-alignment], phase=init", () => {
    const state = resolveInitialState({ skipPlanAlignment: true }, tmpDir);
    expect(state.current_phase).toBe("init");
    expect(state.skipped_phases).toContain("plan-alignment");
    expect(state.spec_file).toBeNull();
  });

  it("--skip-plan-alignment + --skip-brainstorm: skipped=[brainstorm,plan-alignment], phase=specify", () => {
    const state = resolveInitialState({ skipBrainstorm: true, skipPlanAlignment: true }, tmpDir);
    expect(state.current_phase).toBe("specify");
    expect(state.skipped_phases).toEqual(["brainstorm", "plan-alignment"]);
  });

  it("--skip-plan-alignment + --skip-specify: skipped include plan-alignment, no duplicate", () => {
    const specDir = join(tmpDir, "specs");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "spec.md"), "# Spec");

    const state = resolveInitialState({ skipSpecify: true, skipPlanAlignment: true }, specDir);
    expect(state.current_phase).toBe("architecture");
    expect(state.skipped_phases).toContain("plan-alignment");
    // No duplicate
    expect(state.skipped_phases.filter(p => p === "plan-alignment")).toHaveLength(1);
  });

  it("--skip-plan-alignment only: plan-alignment in skipped_phases but not other phases", () => {
    const state = resolveInitialState({ skipPlanAlignment: true }, tmpDir);
    expect(state.skipped_phases).not.toContain("brainstorm");
    expect(state.skipped_phases).not.toContain("clarify");
    expect(state.skipped_phases).not.toContain("specify");
    expect(state.skipped_phases).toContain("plan-alignment");
  });

  it("--skip-specify does NOT auto-skip plan-alignment", () => {
    const specDir = join(tmpDir, "specs");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "spec.md"), "# Spec");

    const state = resolveInitialState({ skipSpecify: true }, specDir);
    expect(state.skipped_phases).not.toContain("plan-alignment");
  });
});

