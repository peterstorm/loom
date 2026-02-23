import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveTransition, countMarkers, findFile } from "../../../src/handlers/subagent-stop/advance-phase";
import { CLARIFY_THRESHOLD } from "../../../src/config";
import type { TaskGraph } from "../../../src/types";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** Minimal TaskGraph for resolveTransition */
function mkState(overrides: Partial<TaskGraph> = {}): TaskGraph {
  return {
    current_phase: "init",
    phase_artifacts: {},
    skipped_phases: [],
    spec_file: null,
    plan_file: null,
    tasks: [],
    wave_gates: {},
    ...overrides,
  };
}

// ── countMarkers ──────────────────────────────────────────────────

describe("countMarkers", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "loom-cm-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("counts NEEDS CLARIFICATION markers", () => {
    const f = join(tmpDir, "spec.md");
    writeFileSync(f, "FR-1\n[NEEDS CLARIFICATION] auth?\nFR-2\n[NEEDS CLARIFICATION] rate limit?\n[NEEDS CLARIFICATION] timeout?");
    expect(countMarkers(f)).toBe(3);
  });

  it("returns 0 for clean file", () => {
    const f = join(tmpDir, "spec.md");
    writeFileSync(f, "All clear.");
    expect(countMarkers(f)).toBe(0);
  });

  it("returns CLARIFY_THRESHOLD + 1 for missing file (force clarify)", () => {
    expect(countMarkers(join(tmpDir, "nope.md"))).toBe(CLARIFY_THRESHOLD + 1);
  });

  it("returns 0 for empty file", () => {
    const f = join(tmpDir, "e.md");
    writeFileSync(f, "");
    expect(countMarkers(f)).toBe(0);
  });
});

// ── findFile ──────────────────────────────────────────────────────

describe("findFile", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "loom-ff-")); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("finds file in top directory", () => {
    writeFileSync(join(tmpDir, "brainstorm.md"), "x");
    expect(findFile(tmpDir, "brainstorm.md")).toBe(join(tmpDir, "brainstorm.md"));
  });

  it("finds file in nested directory", () => {
    const nested = join(tmpDir, "sub", "deep");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "spec.md"), "x");
    expect(findFile(tmpDir, "spec.md")).toBe(join(nested, "spec.md"));
  });

  it("returns null for missing file", () => {
    expect(findFile(tmpDir, "nope.md")).toBeNull();
  });

  it("returns null for missing directory", () => {
    expect(findFile(join(tmpDir, "nope"), "f.md")).toBeNull();
  });
});

// ── resolveTransition ─────────────────────────────────────────────

describe("resolveTransition", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "loom-rt-"));
    origCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── brainstorm ──

  it("brainstorm → specify when brainstorm.md exists", () => {
    const dir = join(tmpDir, ".claude", "specs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "brainstorm.md"), "ideas");

    const r = resolveTransition("brainstorm", mkState());
    expect(r).not.toBeNull();
    expect(r!.nextPhase).toBe("specify");
  });

  it("brainstorm → null when brainstorm.md missing", () => {
    expect(resolveTransition("brainstorm", mkState())).toBeNull();
  });

  // ── specify ──

  it("specify → architecture when markers ≤ threshold (skip clarify)", () => {
    const specFile = join(tmpDir, ".claude", "specs", "feat", "spec.md");
    mkdirSync(join(tmpDir, ".claude", "specs", "feat"), { recursive: true });
    const markers = Array.from({ length: CLARIFY_THRESHOLD }, () => "NEEDS CLARIFICATION").join("\n");
    writeFileSync(specFile, markers);

    const r = resolveTransition("specify", mkState({ spec_file: specFile }));
    expect(r).not.toBeNull();
    expect(r!.nextPhase).toBe("architecture");
    expect(r!.skipClarify).toBe(true);
  });

  it("specify → clarify when markers > threshold", () => {
    const specFile = join(tmpDir, ".claude", "specs", "feat", "spec.md");
    mkdirSync(join(tmpDir, ".claude", "specs", "feat"), { recursive: true });
    const markers = Array.from({ length: CLARIFY_THRESHOLD + 1 }, () => "NEEDS CLARIFICATION").join("\n");
    writeFileSync(specFile, markers);

    const r = resolveTransition("specify", mkState({ spec_file: specFile }));
    expect(r).not.toBeNull();
    expect(r!.nextPhase).toBe("clarify");
    expect(r!.skipClarify).toBeUndefined();
  });

  it("specify → null when spec_file is null", () => {
    expect(resolveTransition("specify", mkState())).toBeNull();
  });

  it("specify → null when spec_file doesn't exist", () => {
    expect(resolveTransition("specify", mkState({ spec_file: join(tmpDir, ".claude/specs/nope.md") }))).toBeNull();
  });

  it("specify → null when spec_file not in .claude/specs/", () => {
    const f = join(tmpDir, "random.md");
    writeFileSync(f, "x");
    expect(resolveTransition("specify", mkState({ spec_file: f }))).toBeNull();
  });

  it("specify with exactly CLARIFY_THRESHOLD markers → architecture", () => {
    const specFile = join(tmpDir, ".claude", "specs", "feat", "spec.md");
    mkdirSync(join(tmpDir, ".claude", "specs", "feat"), { recursive: true });
    writeFileSync(specFile, Array.from({ length: CLARIFY_THRESHOLD }, () => "NEEDS CLARIFICATION").join("\n"));

    const r = resolveTransition("specify", mkState({ spec_file: specFile }));
    expect(r!.nextPhase).toBe("architecture");
  });

  it("specify with 0 markers → architecture (skip clarify)", () => {
    const specFile = join(tmpDir, ".claude", "specs", "feat", "spec.md");
    mkdirSync(join(tmpDir, ".claude", "specs", "feat"), { recursive: true });
    writeFileSync(specFile, "All requirements clear.");

    const r = resolveTransition("specify", mkState({ spec_file: specFile }));
    expect(r!.nextPhase).toBe("architecture");
    expect(r!.skipClarify).toBe(true);
  });

  // ── clarify ──

  it("clarify → architecture when all markers resolved (0 remaining)", () => {
    const specFile = join(tmpDir, ".claude", "specs", "feat", "spec.md");
    mkdirSync(join(tmpDir, ".claude", "specs", "feat"), { recursive: true });
    writeFileSync(specFile, "Clean spec.");

    const r = resolveTransition("clarify", mkState({ spec_file: specFile }));
    expect(r).not.toBeNull();
    expect(r!.nextPhase).toBe("architecture");
  });

  it("clarify → null when markers still remain (even below trigger threshold)", () => {
    const specFile = join(tmpDir, ".claude", "specs", "feat", "spec.md");
    mkdirSync(join(tmpDir, ".claude", "specs", "feat"), { recursive: true });
    writeFileSync(specFile, Array.from({ length: CLARIFY_THRESHOLD }, () => "NEEDS CLARIFICATION").join("\n"));

    expect(resolveTransition("clarify", mkState({ spec_file: specFile }))).toBeNull();
  });

  it("clarify → null when markers above threshold", () => {
    const specFile = join(tmpDir, ".claude", "specs", "feat", "spec.md");
    mkdirSync(join(tmpDir, ".claude", "specs", "feat"), { recursive: true });
    writeFileSync(specFile, Array.from({ length: CLARIFY_THRESHOLD + 1 }, () => "NEEDS CLARIFICATION").join("\n"));

    expect(resolveTransition("clarify", mkState({ spec_file: specFile }))).toBeNull();
  });

  it("clarify → null when spec_file missing", () => {
    expect(resolveTransition("clarify", mkState())).toBeNull();
  });

  // ── architecture ──

  it("architecture → plan-alignment (normal flow, plan-alignment not skipped)", () => {
    const planFile = join(tmpDir, ".claude", "plans", "plan.md");
    mkdirSync(join(tmpDir, ".claude", "plans"), { recursive: true });
    writeFileSync(planFile, "plan");

    const r = resolveTransition("architecture", mkState({ plan_file: planFile }));
    expect(r).not.toBeNull();
    expect(r!.nextPhase).toBe("plan-alignment");
    expect(r!.artifact).toBe(planFile);
  });

  it("architecture → decompose when plan-alignment in skipped_phases", () => {
    const planFile = join(tmpDir, ".claude", "plans", "plan.md");
    mkdirSync(join(tmpDir, ".claude", "plans"), { recursive: true });
    writeFileSync(planFile, "plan");

    const r = resolveTransition("architecture", mkState({ plan_file: planFile, skipped_phases: ["plan-alignment"] }));
    expect(r).not.toBeNull();
    expect(r!.nextPhase).toBe("decompose");
    expect(r!.artifact).toBe(planFile);
  });

  it("architecture → null when plan_file not in .claude/plans/", () => {
    const f = join(tmpDir, "plan.md");
    writeFileSync(f, "plan");
    expect(resolveTransition("architecture", mkState({ plan_file: f }))).toBeNull();
  });

  it("architecture → null when plan_file is null", () => {
    expect(resolveTransition("architecture", mkState())).toBeNull();
  });

  // ── plan-alignment ──

  it("plan-alignment → decompose when gap report exists in spec_dir", () => {
    const specDir = join(tmpDir, ".claude", "specs");
    mkdirSync(specDir, { recursive: true });
    const gapReport = join(specDir, "plan-alignment.md");
    writeFileSync(gapReport, "gap report");

    const r = resolveTransition("plan-alignment", mkState({ spec_dir: specDir }));
    expect(r).not.toBeNull();
    expect(r!.nextPhase).toBe("decompose");
    expect(r!.artifact).toBe(gapReport);
  });

  it("plan-alignment → null when gap report missing", () => {
    const specDir = join(tmpDir, ".claude", "specs");
    mkdirSync(specDir, { recursive: true });

    expect(resolveTransition("plan-alignment", mkState({ spec_dir: specDir }))).toBeNull();
  });

  it("plan-alignment → null when spec_dir does not exist", () => {
    expect(resolveTransition("plan-alignment", mkState({ spec_dir: join(tmpDir, "nonexistent") }))).toBeNull();
  });

  it("plan-alignment → decompose using default spec_dir when spec_dir is null", () => {
    // Uses .claude/specs relative to cwd (tmpDir after chdir in beforeEach)
    const specDir = join(tmpDir, ".claude", "specs");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "plan-alignment.md"), "gap");

    const r = resolveTransition("plan-alignment", mkState({ spec_dir: null }));
    expect(r).not.toBeNull();
    expect(r!.nextPhase).toBe("decompose");
  });

  it("plan-alignment → decompose when gap report in nested subdir of spec_dir", () => {
    const specDir = join(tmpDir, ".claude", "specs");
    const nested = join(specDir, "feat");
    mkdirSync(nested, { recursive: true });
    const gapReport = join(nested, "plan-alignment.md");
    writeFileSync(gapReport, "nested gap");

    const r = resolveTransition("plan-alignment", mkState({ spec_dir: specDir }));
    expect(r).not.toBeNull();
    expect(r!.nextPhase).toBe("decompose");
    expect(r!.artifact).toBe(gapReport);
  });

  // ── loop-back: architecture re-run routes to plan-alignment again ──

  it("loop-back: architecture re-completes after plan-alignment started → routes to plan-alignment", () => {
    // Simulate: user ran architecture, got to plan-alignment, then re-ran architecture
    // (orchestrator reset current_phase back to "architecture").
    // The architecture case should fire again and route to plan-alignment.
    const planFile = join(tmpDir, ".claude", "plans", "plan.md");
    mkdirSync(join(tmpDir, ".claude", "plans"), { recursive: true });
    writeFileSync(planFile, "updated plan");

    const state = mkState({
      plan_file: planFile,
      current_phase: "architecture", // reset by orchestrator
      skipped_phases: [],            // plan-alignment NOT skipped
    });

    const r = resolveTransition("architecture", state);
    expect(r).not.toBeNull();
    expect(r!.nextPhase).toBe("plan-alignment");
  });

  // ── decompose ──

  it("decompose → execute (always)", () => {
    const r = resolveTransition("decompose", mkState());
    expect(r).not.toBeNull();
    expect(r!.nextPhase).toBe("execute");
    expect(r!.artifact).toBe("task_graph");
  });

  // ── terminal / no-op phases ──

  it("execute → null (terminal)", () => {
    expect(resolveTransition("execute", mkState())).toBeNull();
  });

  it("init → null (no transition)", () => {
    expect(resolveTransition("init", mkState())).toBeNull();
  });
});
