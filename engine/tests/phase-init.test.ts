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
});
