import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectPhase, checkArtifacts, canRunPanelAgent } from "../../src/handlers/pre-tool-use/validate-phase-order";
import type { ArtifactState } from "../../src/handlers/pre-tool-use/validate-phase-order";
import { VALID_TRANSITIONS } from "../../src/config";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "loom-test-"));
}

function writeFile(dir: string, filename: string, content = "content"): string {
  const path = join(dir, filename);
  writeFileSync(path, content, "utf-8");
  return path;
}

function baseState(overrides: Partial<ArtifactState> = {}): ArtifactState {
  return {
    skipped_phases: [],
    phase_artifacts: {},
    spec_file: null,
    plan_file: null,
    spec_dir: null,
    ...overrides,
  };
}

// ─── detectPhase ────────────────────────────────────────────────────────────

describe("detectPhase (pure)", () => {
  it("maps known phase agents", () => {
    expect(detectPhase("brainstorm-agent", "")).toBe("brainstorm");
    expect(detectPhase("specify-agent", "")).toBe("specify");
    expect(detectPhase("clarify-agent", "")).toBe("clarify");
    expect(detectPhase("architecture-agent", "")).toBe("architecture");
    expect(detectPhase("decompose-agent", "")).toBe("decompose");
  });

  it("maps plan-alignment-agent via PHASE_AGENT_MAP", () => {
    expect(detectPhase("plan-alignment-agent", "")).toBe("plan-alignment");
  });

  it("maps impl agents to execute", () => {
    expect(detectPhase("code-implementer-agent", "")).toBe("execute");
    expect(detectPhase("ts-test-agent", "")).toBe("execute");
    expect(detectPhase("frontend-agent", "")).toBe("execute");
  });

  it("maps review agents to execute", () => {
    expect(detectPhase("spec-check-invoker", "")).toBe("execute");
  });

  it("maps review sub-agents to execute", () => {
    expect(detectPhase("code-reviewer", "")).toBe("execute");
    expect(detectPhase("silent-failure-hunter", "")).toBe("execute");
    expect(detectPhase("pr-test-analyzer", "")).toBe("execute");
    expect(detectPhase("type-design-analyzer", "")).toBe("execute");
    expect(detectPhase("comment-analyzer", "")).toBe("execute");
    expect(detectPhase("code-simplifier", "")).toBe("execute");
  });

  it("maps refutation verifiers to execute by exact and bare name", () => {
    expect(detectPhase("review-verifier-agent", "")).toBe("execute");
    expect(detectPhase("review-verifier", "")).toBe("execute");
  });

  it("falls back to prompt keywords", () => {
    expect(detectPhase("custom-agent", "brainstorm ideas")).toBe("brainstorm");
    expect(detectPhase("custom-agent", "write specification")).toBe("specify");
    expect(detectPhase("custom-agent", "resolve NEEDS CLARIFICATION markers")).toBe("clarify");
    expect(detectPhase("custom-agent", "design architecture")).toBe("architecture");
  });

  it("detects plan-alignment from prompt regex (plan.alignment)", () => {
    expect(detectPhase("custom-agent", "run plan alignment check")).toBe("plan-alignment");
  });

  it("detects plan-alignment from prompt regex (gap.report)", () => {
    expect(detectPhase("custom-agent", "produce gap report")).toBe("plan-alignment");
  });

  it("detects plan-alignment case-insensitively", () => {
    expect(detectPhase("custom-agent", "Plan Alignment review")).toBe("plan-alignment");
    expect(detectPhase("custom-agent", "Gap Report analysis")).toBe("plan-alignment");
  });

  it("returns unknown for unrecognized agents", () => {
    expect(detectPhase("random-agent", "do stuff")).toBe("unknown");
  });

  // ── panel agents (--panel) map to architecture ──
  it("maps arch-panel agents to architecture (recognized, not blocked as unknown)", () => {
    expect(detectPhase("arch-interviewer-agent", "")).toBe("architecture");
    expect(detectPhase("arch-designer-agent", "")).toBe("architecture");
    expect(detectPhase("arch-judge-agent", "")).toBe("architecture");
  });

  it("maps arch-panel agents via the '-agent' suffix fallback", () => {
    expect(detectPhase("arch-interviewer", "")).toBe("architecture");
    expect(detectPhase("arch-designer", "")).toBe("architecture");
    expect(detectPhase("arch-judge", "")).toBe("architecture");
  });
});

// ─── panel agents: transition + artifact gating (design constraint 1) ─────────

describe("panel agents — VALID_TRANSITIONS + artifact gate", () => {
  it("architecture → architecture is a valid transition (panel re-entry mid-phase)", () => {
    // Panel agents detect as "architecture" while current_phase is already
    // "architecture", so the transition they trigger is architecture→architecture.
    expect(VALID_TRANSITIONS["architecture"]).toContain("architecture");
  });

  it("panel agents are blocked in execute/decompose (architecture not a valid target)", () => {
    expect(VALID_TRANSITIONS["execute"]).not.toContain("architecture");
    expect(VALID_TRANSITIONS["decompose"]).not.toContain("architecture");
  });

  it("panel agents share architecture's artifact gate — blocked when spec.md missing", () => {
    // detectPhase(panel) === "architecture", so checkArtifacts("architecture", …)
    // gates them identically to architecture-agent: no spec.md ⇒ blocked.
    expect(checkArtifacts("architecture", baseState())).toBe("specify (no spec.md found)");
  });

  it("panel agents are blocked from plan-alignment even though standard architecture loop-back remains valid", () => {
    expect(VALID_TRANSITIONS["plan-alignment"]).toContain("architecture");
    expect(canRunPanelAgent("plan-alignment")).toBe(false);
    expect(canRunPanelAgent("architecture")).toBe(true);
  });

  it("panel agents require the explicit architecture current phase", () => {
    expect(VALID_TRANSITIONS["init"]).toContain("architecture");
    expect(canRunPanelAgent("init")).toBe(false);
    expect(canRunPanelAgent("specify")).toBe(false);
    expect(canRunPanelAgent("architecture")).toBe(true);
  });
});

// ─── VALID_TRANSITIONS ───────────────────────────────────────────────────────

describe("VALID_TRANSITIONS", () => {
  it("init allows architecture (for --skip-specify)", () => {
    expect(VALID_TRANSITIONS["init"]).toContain("architecture");
  });

  it("init allows brainstorm and specify", () => {
    expect(VALID_TRANSITIONS["init"]).toContain("brainstorm");
    expect(VALID_TRANSITIONS["init"]).toContain("specify");
  });

  it("architecture allows plan-alignment", () => {
    expect(VALID_TRANSITIONS["architecture"]).toContain("plan-alignment");
  });

  it("plan-alignment allows decompose", () => {
    expect(VALID_TRANSITIONS["plan-alignment"]).toContain("decompose");
  });

  it("architecture allows decompose (skip path via --skip-plan-alignment)", () => {
    expect(VALID_TRANSITIONS["architecture"]).toContain("decompose");
  });
});

// ─── checkArtifacts — plan-alignment phase ──────────────────────────────────

describe("checkArtifacts — plan-alignment phase", () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("blocked when no plan_file and no phase_artifacts.architecture", () => {
    const result = checkArtifacts("plan-alignment", baseState());
    expect(result).toBe("architecture (no plan.md found)");
  });

  it("blocked when plan_file path does not exist on disk", () => {
    const result = checkArtifacts("plan-alignment", baseState({ plan_file: "/nonexistent/plan.md" }));
    expect(result).toBe("architecture (no plan.md found)");
  });

  it("allowed when plan_file exists", () => {
    const plan = writeFile(tmp, "plan.md");
    const result = checkArtifacts("plan-alignment", baseState({ plan_file: plan }));
    expect(result).toBeNull();
  });

  it("allowed when phase_artifacts.architecture exists", () => {
    const plan = writeFile(tmp, "plan.md");
    const result = checkArtifacts("plan-alignment", baseState({ phase_artifacts: { architecture: plan } }));
    expect(result).toBeNull();
  });

  it("phase_artifacts.architecture takes priority over plan_file", () => {
    const plan = writeFile(tmp, "plan.md");
    // plan_file points to nonexistent, but phase_artifacts.architecture is valid
    const result = checkArtifacts("plan-alignment", baseState({
      phase_artifacts: { architecture: plan },
      plan_file: "/nonexistent/plan.md",
    }));
    expect(result).toBeNull();
  });
});

// ─── checkArtifacts — decompose phase ────────────────────────────────────────

describe("checkArtifacts — decompose phase", () => {
  let tmp: string;
  let specDir: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    specDir = join(tmp, "specs");
    mkdirSync(specDir, { recursive: true });
  });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("blocked when no plan.md", () => {
    const result = checkArtifacts("decompose", baseState({ spec_dir: specDir }));
    expect(result).toBe("architecture (no plan.md found)");
  });

  it("blocked when plan-alignment.md absent and plan-alignment not skipped", () => {
    const plan = writeFile(tmp, "plan.md");
    const result = checkArtifacts("decompose", baseState({ plan_file: plan, spec_dir: specDir }));
    expect(result).toBe("plan-alignment (no plan-alignment.md found)");
  });

  it("allowed when plan-alignment.md present in spec_dir", () => {
    const plan = writeFile(tmp, "plan.md");
    writeFile(specDir, "plan-alignment.md");
    const result = checkArtifacts("decompose", baseState({ plan_file: plan, spec_dir: specDir }));
    expect(result).toBeNull();
  });

  it("allowed when plan-alignment IS skipped (no plan-alignment.md needed)", () => {
    const plan = writeFile(tmp, "plan.md");
    // no plan-alignment.md in specDir
    const result = checkArtifacts("decompose", baseState({
      plan_file: plan,
      spec_dir: specDir,
      skipped_phases: ["plan-alignment"],
    }));
    expect(result).toBeNull();
  });

  it("plan-alignment.md found in subdirectory of spec_dir", () => {
    const plan = writeFile(tmp, "plan.md");
    const subDir = join(specDir, "sub");
    mkdirSync(subDir, { recursive: true });
    writeFile(subDir, "plan-alignment.md");
    const result = checkArtifacts("decompose", baseState({ plan_file: plan, spec_dir: specDir }));
    expect(result).toBeNull();
  });

  it("blocks decompose when plan-alignment.md is missing in the given spec_dir", () => {
    // spec_dir points at a directory with no plan-alignment.md → blocked.
    const plan = writeFile(tmp, "plan.md");
    const result = checkArtifacts("decompose", baseState({ plan_file: plan, spec_dir: "/nonexistent/specs" }));
    expect(result).toBe("plan-alignment (no plan-alignment.md found)");
  });

  it("falls back to .claude/specs when spec_dir is null", () => {
    // With spec_dir null, checkArtifacts searches the cwd-relative ".claude/specs"
    // default. chdir into an isolated dir with no such directory to make the
    // fallback hermetic (independent of the repo's real .claude/specs).
    const plan = writeFile(tmp, "plan.md");
    const isolatedCwd = join(tmp, "cwd");
    mkdirSync(isolatedCwd, { recursive: true });
    const originalCwd = process.cwd();
    try {
      process.chdir(isolatedCwd);
      const result = checkArtifacts("decompose", baseState({ plan_file: plan, spec_dir: null }));
      expect(result).toBe("plan-alignment (no plan-alignment.md found)");
    } finally {
      process.chdir(originalCwd);
    }
  });
});

// ─── checkArtifacts — execute phase ──────────────────────────────────────────

describe("checkArtifacts — execute phase", () => {
  let tmp: string;
  let specDir: string;

  beforeEach(() => {
    tmp = makeTmpDir();
    specDir = join(tmp, "specs");
    mkdirSync(specDir, { recursive: true });
  });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("blocked when no plan.md", () => {
    const result = checkArtifacts("execute", baseState({ spec_dir: specDir }));
    expect(result).toBe("architecture (no plan.md found)");
  });

  it("blocked when plan-alignment.md absent and not skipped", () => {
    const plan = writeFile(tmp, "plan.md");
    const result = checkArtifacts("execute", baseState({ plan_file: plan, spec_dir: specDir }));
    expect(result).toBe("plan-alignment (no plan-alignment.md found)");
  });

  it("allowed when plan-alignment.md present", () => {
    const plan = writeFile(tmp, "plan.md");
    writeFile(specDir, "plan-alignment.md");
    const result = checkArtifacts("execute", baseState({ plan_file: plan, spec_dir: specDir }));
    expect(result).toBeNull();
  });

  it("allowed when plan-alignment IS skipped", () => {
    const plan = writeFile(tmp, "plan.md");
    const result = checkArtifacts("execute", baseState({
      plan_file: plan,
      spec_dir: specDir,
      skipped_phases: ["plan-alignment"],
    }));
    expect(result).toBeNull();
  });
});

// ─── checkArtifacts — existing phases (regression) ──────────────────────────

describe("checkArtifacts — existing phases (regression)", () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("brainstorm phase always allowed (no prereq)", () => {
    expect(checkArtifacts("brainstorm", baseState())).toBeNull();
  });

  it("clarify blocked when no spec.md", () => {
    expect(checkArtifacts("clarify", baseState())).toBe("specify (no spec.md found)");
  });

  it("clarify allowed when spec.md exists", () => {
    const spec = writeFile(tmp, "spec.md");
    expect(checkArtifacts("clarify", baseState({ spec_file: spec }))).toBeNull();
  });

  it("architecture blocked when no spec.md", () => {
    expect(checkArtifacts("architecture", baseState())).toBe("specify (no spec.md found)");
  });

  it("architecture allowed when spec.md exists with no NEEDS CLARIFICATION markers", () => {
    const spec = writeFile(tmp, "spec.md", "no markers here");
    expect(checkArtifacts("architecture", baseState({ spec_file: spec }))).toBeNull();
  });

  it("architecture blocked when spec.md has >3 NEEDS CLARIFICATION markers and clarify not skipped", () => {
    const content = "NEEDS CLARIFICATION\nNEEDS CLARIFICATION\nNEEDS CLARIFICATION\nNEEDS CLARIFICATION";
    const spec = writeFile(tmp, "spec.md", content);
    expect(checkArtifacts("architecture", baseState({ spec_file: spec }))).toContain("clarify");
  });

  it("architecture allowed when clarify is skipped even with markers", () => {
    const content = "NEEDS CLARIFICATION\nNEEDS CLARIFICATION\nNEEDS CLARIFICATION\nNEEDS CLARIFICATION";
    const spec = writeFile(tmp, "spec.md", content);
    expect(checkArtifacts("architecture", baseState({
      spec_file: spec,
      skipped_phases: ["clarify"],
    }))).toBeNull();
  });

  it("architecture blocked when spec.md is unreadable", () => {
    const spec = writeFile(tmp, "spec.md", "content");
    chmodSync(spec, 0o000);
    const result = checkArtifacts("architecture", baseState({ spec_file: spec }));
    expect(result).toContain("spec.md unreadable");
    chmodSync(spec, 0o644); // restore for cleanup
  });
});
