import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectPhase, checkArtifacts } from "../../src/handlers/pre-tool-use/validate-phase-order";
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

  it("uses .claude/specs as default spec_dir when spec_dir is null", () => {
    // This path won't exist in test env, so plan-alignment.md won't be found
    const plan = writeFile(tmp, "plan.md");
    const result = checkArtifacts("decompose", baseState({ plan_file: plan, spec_dir: null }));
    // .claude/specs doesn't exist in test environment → blocked
    expect(result).toBe("plan-alignment (no plan-alignment.md found)");
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
});
