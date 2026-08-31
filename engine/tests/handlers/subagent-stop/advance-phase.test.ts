import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import advancePhaseHandler, {
  applyEligiblePhaseTransition,
  resolveTransition,
  countMarkers,
  isPhaseResultEligible,
} from "../../../src/handlers/subagent-stop/advance-phase";
import { findFile } from "../../../src/utils/find-file";
import {
  ARCH_PANEL_AGENTS,
  CLARIFY_THRESHOLD,
  PHASE_AGENT_MAP,
  PHASE_ORDER,
  SUBAGENT_DIR,
} from "../../../src/config";
import { stripNamespace } from "../../../src/utils/strip-namespace";
import type { TaskGraph } from "../../../src/types";
import { StateManager } from "../../../src/state-manager";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
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

  it("fails closed for a missing marker artifact", () => {
    expect(() => countMarkers(join(tmpDir, "nope.md"))).toThrow(/cannot read phase artifact/);
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

// ── phase result eligibility ─────────────────────────────────────

describe("isPhaseResultEligible", () => {
  it("accepts every exact active-Phase completion and the initial brainstorm handoff", () => {
    for (const phase of PHASE_ORDER) {
      expect(isPhaseResultEligible(phase, phase)).toBe(true);
    }
    expect(isPhaseResultEligible("init", "brainstorm")).toBe(true);
  });

  it("rejects every other stale or future completion", () => {
    for (const currentPhase of PHASE_ORDER) {
      for (const completedPhase of PHASE_ORDER) {
        if (currentPhase === completedPhase ||
            (currentPhase === "init" && completedPhase === "brainstorm")) continue;
        expect(isPhaseResultEligible(currentPhase, completedPhase)).toBe(false);
      }
    }
  });
});

describe("applyEligiblePhaseTransition", () => {
  it("returns the identical aggregate when a concurrent completion already advanced the Phase", () => {
    const state = mkState({ current_phase: "architecture" });

    const stale = applyEligiblePhaseTransition(
      state,
      "specify",
      { nextPhase: "architecture", artifact: ".claude/specs/feature/spec.md" },
      "2026-08-31T00:00:00.000Z",
    );

    expect(stale).toBe(state);
  });

  it("immutably applies an eligible transition", () => {
    const state = mkState({ current_phase: "specify" });

    const next = applyEligiblePhaseTransition(
      state,
      "specify",
      { nextPhase: "architecture", artifact: ".claude/specs/feature/spec.md", skipClarify: true },
      "2026-08-31T00:00:00.000Z",
    );

    expect(next).not.toBe(state);
    expect(state.current_phase).toBe("specify");
    expect(next).toMatchObject({
      current_phase: "architecture",
      phase_artifacts: { specify: ".claude/specs/feature/spec.md" },
      skipped_phases: ["clarify"],
      updated_at: "2026-08-31T00:00:00.000Z",
    });
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

  it("brainstorm reports the missing artifact", () => {
    expect(resolveTransition("brainstorm", mkState())).toEqual({
      kind: "not-ready",
      reason: expect.stringContaining("brainstorm.md was not found"),
    });
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

  it("specify reports absent spec authority", () => {
    expect(resolveTransition("specify", mkState())).toMatchObject({
      kind: "not-ready",
      reason: expect.stringContaining("no readable spec.md"),
    });
  });

  it("specify reports a missing spec artifact", () => {
    expect(resolveTransition("specify", mkState({ spec_file: join(tmpDir, ".claude/specs/nope.md") }))).toMatchObject({
      kind: "not-ready",
      reason: expect.stringContaining("recorded spec_file"),
    });
  });

  it("surfaces an unreadable spec instead of advancing to clarify", () => {
    const specFile = join(tmpDir, ".claude", "specs", "feat", "spec.md");
    mkdirSync(join(tmpDir, ".claude", "specs", "feat"), { recursive: true });
    symlinkSync(specFile, specFile);

    expect(() => resolveTransition("specify", mkState({ spec_file: specFile })))
      .toThrow(/cannot access phase artifact/);
  });

  it("specify reports an out-of-scope spec artifact without falling back", () => {
    const f = join(tmpDir, "random.md");
    const fallback = join(tmpDir, ".claude", "specs", "fallback", "spec.md");
    mkdirSync(join(tmpDir, ".claude", "specs", "fallback"), { recursive: true });
    writeFileSync(f, "corrupt authority");
    writeFileSync(fallback, "fallback must not hide corruption");
    expect(resolveTransition("specify", mkState({ spec_file: f }))).toMatchObject({
      kind: "not-ready",
      reason: expect.stringContaining("outside run spec_dir"),
    });
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

  it("clarify reports markers still remaining (even below trigger threshold)", () => {
    const specFile = join(tmpDir, ".claude", "specs", "feat", "spec.md");
    mkdirSync(join(tmpDir, ".claude", "specs", "feat"), { recursive: true });
    writeFileSync(specFile, Array.from({ length: CLARIFY_THRESHOLD }, () => "NEEDS CLARIFICATION").join("\n"));

    expect(resolveTransition("clarify", mkState({ spec_file: specFile }))).toMatchObject({
      kind: "not-ready",
      reason: expect.stringContaining("NEEDS CLARIFICATION marker(s) remain unresolved"),
    });
  });

  it("clarify reports markers above threshold", () => {
    const specFile = join(tmpDir, ".claude", "specs", "feat", "spec.md");
    mkdirSync(join(tmpDir, ".claude", "specs", "feat"), { recursive: true });
    writeFileSync(specFile, Array.from({ length: CLARIFY_THRESHOLD + 1 }, () => "NEEDS CLARIFICATION").join("\n"));

    expect(resolveTransition("clarify", mkState({ spec_file: specFile }))).toMatchObject({
      kind: "not-ready",
      reason: expect.stringContaining("NEEDS CLARIFICATION marker(s) remain unresolved"),
    });
  });

  it("clarify reports a missing spec artifact", () => {
    expect(resolveTransition("clarify", mkState())).toMatchObject({
      kind: "not-ready",
      reason: expect.stringContaining("no readable spec.md"),
    });
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

  it("architecture reports an out-of-scope plan", () => {
    const f = join(tmpDir, "plan.md");
    writeFileSync(f, "plan");
    expect(resolveTransition("architecture", mkState({ plan_file: f }))).toMatchObject({
      kind: "not-ready",
      reason: expect.stringContaining("is outside"),
    });
  });

  it("architecture reports a missing plan", () => {
    expect(resolveTransition("architecture", mkState())).toMatchObject({
      kind: "not-ready",
      reason: expect.stringContaining("no readable plan artifact"),
    });
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

  it("plan-alignment reports a missing gap report", () => {
    const specDir = join(tmpDir, ".claude", "specs");
    mkdirSync(specDir, { recursive: true });

    expect(resolveTransition("plan-alignment", mkState({ spec_dir: specDir }))).toMatchObject({
      kind: "not-ready",
      reason: expect.stringContaining("plan-alignment.md was not found"),
    });
  });

  it("plan-alignment rejects an out-of-scope spec directory before discovery", () => {
    expect(resolveTransition("plan-alignment", mkState({ spec_dir: join(tmpDir, "nonexistent") }))).toMatchObject({
      kind: "not-ready",
      reason: expect.stringContaining("spec_dir"),
    });
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

  it("execute reports its terminal state", () => {
    expect(resolveTransition("execute", mkState())).toEqual({
      kind: "not-ready",
      reason: "execute is terminal and has no next phase",
    });
  });

  it("init reports that no completed transition exists", () => {
    expect(resolveTransition("init", mkState())).toEqual({
      kind: "not-ready",
      reason: "init has no completed phase transition",
    });
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

  const withPhaseState = async (
    session: string,
    state: TaskGraph,
    run: () => Promise<void>,
  ): Promise<void> => {
    const statePath = join(tmpDir, `${session}.json`);
    const pointerPath = join(SUBAGENT_DIR, `${session}.task_graph`);
    writeFileSync(statePath, JSON.stringify(state));
    mkdirSync(SUBAGENT_DIR, { recursive: true });
    writeFileSync(pointerPath, statePath);
    try {
      await run();
    } finally {
      rmSync(pointerPath, { force: true });
    }
  };

  const mutateBeforeLockedUpdate = (
    session: string,
    mutateState: (state: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const originalUpdateAndReturn = StateManager.prototype.updateAndReturn;
    return vi.spyOn(StateManager.prototype, "updateAndReturn").mockImplementationOnce(async function (
      this: StateManager,
      mutate,
    ) {
      const path = join(tmpDir, `${session}.json`);
      const current = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
      writeFileSync(path, JSON.stringify(mutateState(current)));
      return originalUpdateAndReturn.call(this, mutate);
    });
  };

  it("the REAL handler fails closed when a known phase agent has no TaskGraph authority", async () => {
    const result = await advancePhaseHandler(JSON.stringify({
      session_id: `missing-phase-${process.pid}-${Date.now()}`,
      agent_id: "phase-agent",
      agent_type: "brainstorm-agent",
    }), []);
    expect(result).toMatchObject({
      kind: "error",
      message: expect.stringContaining("session TaskGraph authority unavailable"),
    });
  });

  it("an explicitly empty transcript path remains eligible for filesystem artifact discovery", async () => {
    const session = `phase-empty-transcript-${process.pid}-${Date.now()}`;
    const artifactDir = join(tmpDir, ".claude", "specs");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "brainstorm.md"), "ideas");
    await withPhaseState(session, mkState({ current_phase: "brainstorm" }), async () => {
      const result = await advancePhaseHandler(JSON.stringify({
        session_id: session,
        agent_type: "brainstorm-agent",
        agent_transcript_path: "",
      }), []);

      expect(result).toEqual({ kind: "passthrough" });
      expect(JSON.parse(readFileSync(join(tmpDir, `${session}.json`), "utf-8"))).toMatchObject({
        current_phase: "specify",
        phase_artifacts: { brainstorm: ".claude/specs/brainstorm.md" },
      });
    });
  });

  it("the REAL handler fails closed when a phase transcript cannot be read", async () => {
    const session = `phase-transcript-${process.pid}-${Date.now()}`;
    const unreadableTranscript = join(tmpDir, "transcript-directory.jsonl");
    mkdirSync(unreadableTranscript);
    await withPhaseState(session, mkState({ current_phase: "brainstorm" }), async () => {
      const result = await advancePhaseHandler(JSON.stringify({
        session_id: session,
        agent_id: "phase-agent",
        agent_type: "brainstorm-agent",
        agent_transcript_path: unreadableTranscript,
      }), []);
      expect(result).toMatchObject({
        kind: "error",
        message: expect.stringContaining("failed to read or parse transcript"),
      });
    });
  });

  it("the REAL handler fails closed when phase artifact discovery fails", async () => {
    const session = `phase-artifact-${process.pid}-${Date.now()}`;
    const spec = join(tmpDir, ".claude", "specs", "loop.md");
    mkdirSync(join(tmpDir, ".claude", "specs"), { recursive: true });
    symlinkSync(spec, spec);
    await withPhaseState(session, mkState({ current_phase: "specify", spec_file: spec }), async () => {
      const result = await advancePhaseHandler(JSON.stringify({
        session_id: session,
        agent_id: "phase-agent",
        agent_type: "specify-agent",
      }), []);
      expect(result).toMatchObject({
        kind: "error",
        message: expect.stringContaining("phase artifact discovery failed"),
      });
    });
  });

  it("the REAL handler refuses a future phase result without mutating protected state", async () => {
    const session = `phase-future-${process.pid}-${Date.now()}`;
    const initial = mkState({ current_phase: "brainstorm" });
    await withPhaseState(session, initial, async () => {
      const result = await advancePhaseHandler(JSON.stringify({
        session_id: session,
        agent_id: "future-phase-agent",
        agent_type: "specify-agent",
      }), []);
      expect(result).toMatchObject({
        kind: "error",
        message: expect.stringMatching(/specify result cannot advance current phase brainstorm.*exact phase authority required/),
      });
      expect(JSON.parse(readFileSync(join(tmpDir, `${session}.json`), "utf-8"))).toEqual(initial);
    });
  });

  it("the locked transition preserves a phase that advanced after the initial read", async () => {
    const session = `phase-race-${process.pid}-${Date.now()}`;
    const artifactDir = join(tmpDir, ".claude", "specs");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "brainstorm.md"), "ideas");
    await withPhaseState(session, mkState({ current_phase: "brainstorm" }), async () => {
      const update = mutateBeforeLockedUpdate(session, (current) => ({ ...current, current_phase: "specify" }));
      try {
        const result = await advancePhaseHandler(JSON.stringify({
          session_id: session,
          agent_id: "racing-phase-agent",
          agent_type: "brainstorm-agent",
        }), []);
        expect(result).toMatchObject({
          kind: "passthrough",
          systemMessage: expect.stringContaining("already past"),
        });
        expect(JSON.parse(readFileSync(join(tmpDir, `${session}.json`), "utf-8"))).toMatchObject({
          current_phase: "specify",
          phase_artifacts: {},
        });
      } finally {
        update.mockRestore();
      }
    });
  });

  it("rejects same-Phase artifact authority drift instead of reading under the locked commit", async () => {
    const session = `phase-authority-race-${process.pid}-${Date.now()}`;
    const initialSpec = join(tmpDir, ".claude", "specs", "initial", "spec.md");
    const lockedSpec = join(tmpDir, ".claude", "specs", "locked", "spec.md");
    mkdirSync(join(tmpDir, ".claude", "specs", "initial"), { recursive: true });
    mkdirSync(join(tmpDir, ".claude", "specs", "locked"), { recursive: true });
    writeFileSync(initialSpec, "resolved spec");
    writeFileSync(
      lockedSpec,
      Array.from({ length: CLARIFY_THRESHOLD + 1 }, () => "NEEDS CLARIFICATION").join("\n"),
    );
    await withPhaseState(
      session,
      mkState({ current_phase: "specify", spec_file: initialSpec }),
      async () => {
        const update = mutateBeforeLockedUpdate(session, (current) => ({ ...current, spec_file: lockedSpec }));
        try {
          const result = await advancePhaseHandler(JSON.stringify({
            session_id: session,
            agent_id: "racing-specify-agent",
            agent_type: "specify-agent",
          }), []);

          expect(result).toMatchObject({
            kind: "error",
            message: expect.stringContaining("authority changed after filesystem observation"),
          });
          expect(JSON.parse(readFileSync(join(tmpDir, `${session}.json`), "utf-8"))).toMatchObject({
            current_phase: "specify",
            spec_file: lockedSpec,
            phase_artifacts: {},
            skipped_phases: [],
          });
        } finally {
          update.mockRestore();
        }
      },
    );
  });

  it("does not persist stale spec artifact authority after the locked Phase advances", async () => {
    const session = `phase-spec-artifact-race-${process.pid}-${Date.now()}`;
    const specFile = join(tmpDir, ".claude", "specs", "race", "spec.md");
    mkdirSync(join(tmpDir, ".claude", "specs", "race"), { recursive: true });
    writeFileSync(specFile, "resolved spec");
    const initial = mkState({ current_phase: "specify", spec_file: specFile });
    await withPhaseState(session, initial, async () => {
      const update = mutateBeforeLockedUpdate(session, (current) => ({ ...current, current_phase: "architecture" }));
      try {
        const result = await advancePhaseHandler(JSON.stringify({
          session_id: session,
          agent_id: "racing-specify-agent",
          agent_type: "specify-agent",
        }), []);
        expect(result).toMatchObject({
          kind: "passthrough",
          systemMessage: expect.stringContaining("already past"),
        });
        expect(JSON.parse(readFileSync(join(tmpDir, `${session}.json`), "utf-8"))).toMatchObject({
          current_phase: "architecture",
          spec_file: specFile,
          phase_artifacts: {},
        });
      } finally {
        update.mockRestore();
      }
    });
  });

  it("the REAL handler reports a missing required artifact instead of silently passing through", async () => {
    const session = `phase-not-ready-${process.pid}-${Date.now()}`;
    await withPhaseState(session, mkState({ current_phase: "brainstorm" }), async () => {
      const result = await advancePhaseHandler(JSON.stringify({
        session_id: session,
        agent_id: "phase-agent",
        agent_type: "brainstorm-agent",
      }), []);
      expect(result).toMatchObject({
        kind: "error",
        message: expect.stringMatching(/brainstorm.*brainstorm\.md was not found.*phase NOT advanced/),
      });
    });
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
