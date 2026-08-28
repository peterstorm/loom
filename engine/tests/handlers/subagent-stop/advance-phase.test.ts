import { describe, it, expect, beforeEach, afterEach } from "vitest";
import advancePhaseHandler, {
  resolveTransition,
  countMarkers,
} from "../../../src/handlers/subagent-stop/advance-phase";
import { findFile } from "../../../src/utils/find-file";
import { CLARIFY_THRESHOLD, PHASE_AGENT_MAP, ARCH_PANEL_AGENTS } from "../../../src/config";
import { stripNamespace } from "../../../src/utils/strip-namespace";
import type { TaskGraph } from "../../../src/types";
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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

  beforeEach(() => { tmpDir = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-cm-"))); });
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

  beforeEach(() => { tmpDir = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-ff-"))); });
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
    tmpDir = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-rt-")));
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

  it("surfaces an unreadable spec instead of advancing to clarify", () => {
    const specFile = join(tmpDir, ".claude", "specs", "feat", "spec.md");
    mkdirSync(join(tmpDir, ".claude", "specs", "feat"), { recursive: true });
    symlinkSync(specFile, specFile);

    expect(() => resolveTransition("specify", mkState({ spec_file: specFile })))
      .toThrow(/cannot access phase artifact/);
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

  it("surfaces an unreadable plan instead of treating it as missing", () => {
    const planFile = join(tmpDir, ".claude", "plans", "loop.md");
    mkdirSync(join(tmpDir, ".claude", "plans"), { recursive: true });
    symlinkSync(planFile, planFile);

    expect(() => resolveTransition("architecture", mkState({ plan_file: planFile })))
      .toThrow(/cannot access phase artifact/);
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

// ── panel agents: advance-phase must ignore them (design constraint 2) ────────

describe("panel agents — advance-phase passthrough (never mutates phase)", () => {
  let tmpDir: string;
  let origCwd: string;

  beforeEach(() => {
    tmpDir = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-panel-")));
    origCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("panel agents are not PHASE_AGENT_MAP members — handler short-circuits before resolveTransition", () => {
    // advance-phase looks up `PHASE_AGENT_MAP[stripNamespace(agent_type)]`
    // and returns passthrough on undefined. Panel agents must miss this map, or
    // their SubagentStop would run resolveTransition and could advance the phase.
    for (const agent of ARCH_PANEL_AGENTS) {
      expect(PHASE_AGENT_MAP[stripNamespace(agent)]).toBeUndefined();
      expect(PHASE_AGENT_MAP[stripNamespace(`loom:${agent}`)]).toBeUndefined();
    }
  });

  it("TRAP: a same-date-prefix plan on disk would advance IF a panel agent reached the architecture case — proving the map gate is load-bearing", () => {
    // Reproduce the exact hazard from design constraint 2: a stale same-day plan
    // sits in .claude/plans/ while a designer/judge completes mid-panel.
    const specDir = join(tmpDir, ".claude", "specs", "2026-07-16-feat");
    mkdirSync(specDir, { recursive: true });
    mkdirSync(join(tmpDir, ".claude", "plans"), { recursive: true });
    // A same-date-prefix plan the date-prefix fallback in resolveTransition
    // ("architecture" case) would happily pick up.
    writeFileSync(join(tmpDir, ".claude", "plans", "2026-07-16-stale.md"), "stale plan");

    const state = mkState({
      current_phase: "architecture",
      spec_dir: specDir,
      plan_file: null, // force the date-prefix fallback path
    });

    // IF the handler ever routed a panel agent into the architecture case, this
    // is what it would compute — a bogus advance off a stale plan:
    const wouldAdvance = resolveTransition("architecture", state);
    expect(wouldAdvance).not.toBeNull();
    expect(wouldAdvance!.nextPhase).toBe("plan-alignment");

    // The ONLY thing preventing that is panel agents missing from PHASE_AGENT_MAP,
    // so the handler returns passthrough before resolveTransition is ever called.
    for (const agent of ARCH_PANEL_AGENTS) {
      expect(PHASE_AGENT_MAP[stripNamespace(agent)]).toBeUndefined();
    }
  });

  it.each(["null", "42", "[]", JSON.stringify({ session_id: "smoke", agent_type: 7 })])(
    "the REAL handler rejects valid JSON outside the SubagentStop domain: %s",
    async (stdin) => {
      await expect(advancePhaseHandler(stdin, [])).resolves.toMatchObject({
        kind: "error",
        message: expect.stringContaining("invalid SubagentStop input"),
      });
    },
  );

  it("the REAL handler short-circuits a panel-agent SubagentStop to passthrough before any state access", async () => {
    // Drive the actual default-export handler, not just the map precondition. A
    // panel agent misses PHASE_AGENT_MAP, so the handler returns passthrough at
    // its first branch — before StateManager is ever consulted. It must never
    // throw and never advance, in both bare and `loom:`-namespaced forms. (The
    // full advance-vs-no-advance contract with real state on disk is exercised
    // end-to-end by scripts/smoke-panel-mode.sh, which spawns an isolated CLI
    // process; a same-process test cannot repoint the import-frozen state path.)
    for (const agent of ARCH_PANEL_AGENTS) {
      for (const name of [agent, `loom:${agent}`]) {
        const stdin = JSON.stringify({ session_id: "smoke", agent_type: name });
        await expect(advancePhaseHandler(stdin, [])).resolves.toEqual({ kind: "passthrough" });
      }
    }
  });
});
