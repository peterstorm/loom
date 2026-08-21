import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectPhase,
  checkArtifacts,
  canRunPanelAgent,
  realArtifactProbe,
  realPhaseOrderDeps,
} from "../../src/handlers/pre-tool-use/validate-phase-order";
import type { ArtifactProbe, ArtifactState } from "../../src/handlers/pre-tool-use/validate-phase-order";
import { VALID_TRANSITIONS } from "../../src/config";
import { validatePhaseOrder } from "../../src/core/validate-phase-order";

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

/**
 * In-memory `ArtifactProbe` over a `path → contents` map.
 *
 * The artifact reads are an injected port, so the phase-gating rule can be
 * driven with plain fixtures instead of a real temp directory per case. The
 * blocks that specifically exercise the REAL probe (unreadable file, cwd
 * fallback) keep using `realArtifactProbe` — those are about the shell.
 */
function memoryProbe(files: Readonly<Record<string, string>>): ArtifactProbe {
  const has = (path: string): boolean => Object.hasOwn(files, path);
  return {
    exists: has,
    readText: (path: string): string => {
      if (!has(path)) {
        const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return files[path]!;
    },
    findFile: (dir: string, filename: string): string | null => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      return Object.keys(files).find((path) => path.startsWith(prefix) && path.endsWith(`/${filename}`)) ?? null;
    },
  };
}

/** Nothing exists — the fixture most artifact-gate cases start from. */
const emptyProbe = memoryProbe({});

// ─── detectPhase ────────────────────────────────────────────────────────────

describe("standalone lifecycle", () => {
  it("allows the marker only for the closed standalone review roster", () => {
    expect(validatePhaseOrder({
      agentType: "loom:code-reviewer",
      prompt: "LOOM_REVIEW_CONTEXT: standalone\nReview the frozen scope",
    }, realPhaseOrderDeps)).toEqual({ kind: "allow" });
    expect(validatePhaseOrder({
      agentType: "review-verifier-agent",
      prompt: "LOOM_REVIEW_CONTEXT: standalone\nJudge the manifest",
    }, realPhaseOrderDeps)).toEqual({ kind: "allow" });
  });

  it.each(["code-implementer-agent", "architecture-agent", "spec-check-invoker", "unknown-agent"])(
    "rejects standalone marker authority for %s",
    (agentType) => {
      expect(validatePhaseOrder({
        agentType,
        prompt: "LOOM_REVIEW_CONTEXT: standalone\nTask ID: T1",
      }, realPhaseOrderDeps)).toMatchObject({
        kind: "block",
        message: expect.stringContaining("not authorized"),
      });
    },
  );

  // ENOENT is the ONLY answer that may read as "no active plan", because that
  // is the answer validatePhaseOrder turns into `allow`. Bare `existsSync`
  // reported false for EACCES/ELOOP/ENOTDIR/EIO too, so an unreadable task
  // graph silently disarmed this spawn gate while its siblings stayed armed.
  describe("realPhaseOrderDeps.loadState — absence must be proven", () => {
    function withStatePath<T>(path: string, run: () => T): T {
      const previous = process.env.LOOM_STATE_PATH;
      process.env.LOOM_STATE_PATH = path;
      try {
        return run();
      } finally {
        if (previous === undefined) delete process.env.LOOM_STATE_PATH;
        else process.env.LOOM_STATE_PATH = previous;
      }
    }

    it("returns null for a genuinely absent graph (ENOENT ⇒ allow)", () => {
      const dir = makeTmpDir();
      try {
        expect(withStatePath(join(dir, "active_task_graph.json"), () => realPhaseOrderDeps.loadState()))
          .toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("raises rather than reporting absence when the graph cannot be read", () => {
      const dir = makeTmpDir();
      const sealed = join(dir, "sealed");
      mkdirSync(sealed, { recursive: true });
      const graphPath = join(sealed, "active_task_graph.json");
      writeFileSync(graphPath, JSON.stringify({ current_phase: "execute" }));
      chmodSync(sealed, 0o000);
      try {
        // A throw is the fail-closed answer: the route is a FAIL_CLOSED_ROUTE,
        // so it exits 2 (block). Returning null here would have exited 0.
        expect(() => withStatePath(graphPath, () => realPhaseOrderDeps.loadState())).toThrow();
      } finally {
        chmodSync(sealed, 0o700);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("resolves a late LOOM_STATE_PATH once per phase-order invocation", () => {
    const dir = makeTmpDir();
    const graphPath = join(dir, "active_task_graph.json");
    const previous = process.env.LOOM_STATE_PATH;
    writeFileSync(graphPath, JSON.stringify({
      current_phase: "execute",
      phase_artifacts: {},
      skipped_phases: [],
      spec_file: null,
      plan_file: null,
      current_wave: 1,
      executing_tasks: [],
      tasks: [],
      wave_gates: {},
    }));
    process.env.LOOM_STATE_PATH = graphPath;
    try {
      expect(validatePhaseOrder({
        agentType: "arch-designer-agent",
        prompt: "Design through the architecture panel",
      }, realPhaseOrderDeps)).toMatchObject({
        kind: "block",
        message: expect.stringContaining("Architecture panel agents may run only during the architecture phase"),
      });
    } finally {
      if (previous === undefined) delete process.env.LOOM_STATE_PATH;
      else process.env.LOOM_STATE_PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
    expect(checkArtifacts("architecture", baseState(), emptyProbe)).toBe("specify (no spec.md found)");
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
  it("is structurally immutable at runtime", () => {
    expect(Object.isFrozen(VALID_TRANSITIONS)).toBe(true);
    for (const targets of Object.values(VALID_TRANSITIONS)) expect(Object.isFrozen(targets)).toBe(true);
    expect(() => (VALID_TRANSITIONS.init as unknown as string[]).push("execute")).toThrow();
    expect(VALID_TRANSITIONS.init).not.toContain("execute");
  });

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
  const PLAN = "/fixtures/plan.md";

  it("blocked when no plan_file and no phase_artifacts.architecture", () => {
    const result = checkArtifacts("plan-alignment", baseState(), emptyProbe);
    expect(result).toBe("architecture (no plan.md found)");
  });

  it("blocked when plan_file path does not exist", () => {
    const result = checkArtifacts("plan-alignment", baseState({ plan_file: "/nonexistent/plan.md" }), emptyProbe);
    expect(result).toBe("architecture (no plan.md found)");
  });

  it("allowed when plan_file exists", () => {
    const result = checkArtifacts(
      "plan-alignment",
      baseState({ plan_file: PLAN }),
      memoryProbe({ [PLAN]: "plan" }),
    );
    expect(result).toBeNull();
  });

  it("allowed when phase_artifacts.architecture exists", () => {
    const result = checkArtifacts(
      "plan-alignment",
      baseState({ phase_artifacts: { architecture: PLAN } }),
      memoryProbe({ [PLAN]: "plan" }),
    );
    expect(result).toBeNull();
  });

  it("phase_artifacts.architecture takes priority over plan_file", () => {
    // plan_file points to nonexistent, but phase_artifacts.architecture is valid
    const result = checkArtifacts("plan-alignment", baseState({
      phase_artifacts: { architecture: PLAN },
      plan_file: "/nonexistent/plan.md",
    }), memoryProbe({ [PLAN]: "plan" }));
    expect(result).toBeNull();
  });

  it("'completed' is not a path — it never resolves an artifact", () => {
    const result = checkArtifacts(
      "plan-alignment",
      baseState({ phase_artifacts: { architecture: "completed" } }),
      memoryProbe({ completed: "not a plan" }),
    );
    expect(result).toBe("architecture (no plan.md found)");
  });
});

// ─── checkArtifacts — decompose phase ────────────────────────────────────────

describe("checkArtifacts — decompose phase", () => {
  const SPEC_DIR = "/fixtures/specs";
  const PLAN = "/fixtures/plan.md";
  const ALIGNMENT = `${SPEC_DIR}/plan-alignment.md`;

  it("blocked when no plan.md", () => {
    const result = checkArtifacts("decompose", baseState({ spec_dir: SPEC_DIR }), emptyProbe);
    expect(result).toBe("architecture (no plan.md found)");
  });

  it("blocked when plan-alignment.md absent and plan-alignment not skipped", () => {
    const result = checkArtifacts(
      "decompose",
      baseState({ plan_file: PLAN, spec_dir: SPEC_DIR }),
      memoryProbe({ [PLAN]: "plan" }),
    );
    expect(result).toBe("plan-alignment (no plan-alignment.md found)");
  });

  it("allowed when plan-alignment.md present in spec_dir", () => {
    const result = checkArtifacts(
      "decompose",
      baseState({ plan_file: PLAN, spec_dir: SPEC_DIR }),
      memoryProbe({ [PLAN]: "plan", [ALIGNMENT]: "alignment" }),
    );
    expect(result).toBeNull();
  });

  it("allowed when plan-alignment IS skipped (no plan-alignment.md needed)", () => {
    const result = checkArtifacts("decompose", baseState({
      plan_file: PLAN,
      spec_dir: SPEC_DIR,
      skipped_phases: ["plan-alignment"],
    }), memoryProbe({ [PLAN]: "plan" }));
    expect(result).toBeNull();
  });

  it("plan-alignment.md found in subdirectory of spec_dir", () => {
    const result = checkArtifacts(
      "decompose",
      baseState({ plan_file: PLAN, spec_dir: SPEC_DIR }),
      memoryProbe({ [PLAN]: "plan", [`${SPEC_DIR}/sub/plan-alignment.md`]: "alignment" }),
    );
    expect(result).toBeNull();
  });

  it("blocks decompose when plan-alignment.md is missing in the given spec_dir", () => {
    // spec_dir points at a directory with no plan-alignment.md → blocked. A
    // same-named file OUTSIDE the spec dir must not satisfy the gate.
    const result = checkArtifacts(
      "decompose",
      baseState({ plan_file: PLAN, spec_dir: "/nonexistent/specs" }),
      memoryProbe({ [PLAN]: "plan", [ALIGNMENT]: "alignment" }),
    );
    expect(result).toBe("plan-alignment (no plan-alignment.md found)");
  });

  it("falls back to .claude/specs when spec_dir is null", () => {
    // With spec_dir null the rule searches the cwd-relative ".claude/specs"
    // default. The probe makes that hermetic — no chdir, no reliance on the
    // repo's real .claude/specs.
    const result = checkArtifacts(
      "decompose",
      baseState({ plan_file: PLAN, spec_dir: null }),
      memoryProbe({ [PLAN]: "plan" }),
    );
    expect(result).toBe("plan-alignment (no plan-alignment.md found)");
  });

  it("accepts plan-alignment.md under the default .claude/specs when spec_dir is null", () => {
    const result = checkArtifacts(
      "decompose",
      baseState({ plan_file: PLAN, spec_dir: null }),
      memoryProbe({ [PLAN]: "plan", ".claude/specs/plan-alignment.md": "alignment" }),
    );
    expect(result).toBeNull();
  });
});

// ─── checkArtifacts — execute phase ──────────────────────────────────────────

describe("checkArtifacts — execute phase", () => {
  const SPEC_DIR = "/fixtures/specs";
  const PLAN = "/fixtures/plan.md";
  const ALIGNMENT = `${SPEC_DIR}/plan-alignment.md`;

  it("blocked when no plan.md", () => {
    const result = checkArtifacts("execute", baseState({ spec_dir: SPEC_DIR }), emptyProbe);
    expect(result).toBe("architecture (no plan.md found)");
  });

  it("blocked when plan-alignment.md absent and not skipped", () => {
    const result = checkArtifacts(
      "execute",
      baseState({ plan_file: PLAN, spec_dir: SPEC_DIR }),
      memoryProbe({ [PLAN]: "plan" }),
    );
    expect(result).toBe("plan-alignment (no plan-alignment.md found)");
  });

  it("allowed when plan-alignment.md present", () => {
    const result = checkArtifacts(
      "execute",
      baseState({ plan_file: PLAN, spec_dir: SPEC_DIR }),
      memoryProbe({ [PLAN]: "plan", [ALIGNMENT]: "alignment" }),
    );
    expect(result).toBeNull();
  });

  it("allowed when plan-alignment IS skipped", () => {
    const result = checkArtifacts("execute", baseState({
      plan_file: PLAN,
      spec_dir: SPEC_DIR,
      skipped_phases: ["plan-alignment"],
    }), memoryProbe({ [PLAN]: "plan" }));
    expect(result).toBeNull();
  });
});

// ─── checkArtifacts — existing phases (regression) ──────────────────────────

describe("checkArtifacts — existing phases (regression)", () => {
  const SPEC = "/fixtures/spec.md";
  const MARKERS = "NEEDS CLARIFICATION\nNEEDS CLARIFICATION\nNEEDS CLARIFICATION\nNEEDS CLARIFICATION";

  it("brainstorm phase always allowed (no prereq)", () => {
    expect(checkArtifacts("brainstorm", baseState(), emptyProbe)).toBeNull();
  });

  it("specify blocked when no brainstorm.md in spec_dir", () => {
    expect(checkArtifacts("specify", baseState({ spec_dir: "/fixtures/specs" }), emptyProbe))
      .toBe("brainstorm (no brainstorm.md found in /fixtures/specs)");
  });

  it("specify allowed when brainstorm IS skipped", () => {
    expect(checkArtifacts(
      "specify",
      baseState({ spec_dir: "/fixtures/specs", skipped_phases: ["brainstorm"] }),
      emptyProbe,
    )).toBeNull();
  });

  it("clarify blocked when no spec.md", () => {
    expect(checkArtifacts("clarify", baseState(), emptyProbe)).toBe("specify (no spec.md found)");
  });

  it("clarify allowed when spec.md exists", () => {
    expect(checkArtifacts("clarify", baseState({ spec_file: SPEC }), memoryProbe({ [SPEC]: "spec" }))).toBeNull();
  });

  it("architecture blocked when no spec.md", () => {
    expect(checkArtifacts("architecture", baseState(), emptyProbe)).toBe("specify (no spec.md found)");
  });

  it("architecture allowed when spec.md exists with no NEEDS CLARIFICATION markers", () => {
    expect(checkArtifacts(
      "architecture",
      baseState({ spec_file: SPEC }),
      memoryProbe({ [SPEC]: "no markers here" }),
    )).toBeNull();
  });

  it("architecture blocked when spec.md has >3 NEEDS CLARIFICATION markers and clarify not skipped", () => {
    expect(checkArtifacts(
      "architecture",
      baseState({ spec_file: SPEC }),
      memoryProbe({ [SPEC]: MARKERS }),
    )).toContain("clarify");
  });

  it("architecture allowed when clarify is skipped even with markers", () => {
    expect(checkArtifacts("architecture", baseState({
      spec_file: SPEC,
      skipped_phases: ["clarify"],
    }), memoryProbe({ [SPEC]: MARKERS }))).toBeNull();
  });

  it("architecture blocked when spec.md is present but unreadable", () => {
    // The port reports the file as present and then throws on read — the shape
    // an EACCES spec.md has. The gate must report it, not treat it as absent.
    const unreadable: ArtifactProbe = {
      exists: (path: string) => path === SPEC,
      readText: (): string => { throw new Error("EACCES: permission denied"); },
      findFile: () => null,
    };
    const result = checkArtifacts("architecture", baseState({ spec_file: SPEC }), unreadable);
    expect(result).toContain("spec.md unreadable");
    expect(result).toContain("EACCES");
  });
});

// ─── realArtifactProbe — the shell half of the seam ──────────────────────────

describe("realArtifactProbe", () => {
  let tmp: string;

  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("reports existence and contents from the real filesystem", () => {
    const spec = writeFile(tmp, "spec.md", "real content");
    expect(realArtifactProbe.exists(spec)).toBe(true);
    expect(realArtifactProbe.exists(join(tmp, "absent.md"))).toBe(false);
    expect(realArtifactProbe.readText(spec)).toBe("real content");
  });

  it("finds a file recursively beneath a directory", () => {
    const sub = join(tmp, "specs", "sub");
    mkdirSync(sub, { recursive: true });
    const alignment = writeFile(sub, "plan-alignment.md");
    expect(realArtifactProbe.findFile(join(tmp, "specs"), "plan-alignment.md")).toBe(alignment);
    expect(realArtifactProbe.findFile(join(tmp, "specs"), "absent.md")).toBeNull();
  });

  it("propagates a read failure for a present-but-unreadable artifact", () => {
    const spec = writeFile(tmp, "spec.md", "content");
    chmodSync(spec, 0o000);
    try {
      expect(realArtifactProbe.exists(spec)).toBe(true);
      // The gate turns this throw into "spec.md unreadable" rather than
      // silently reading the spec as marker-free.
      expect(() => realArtifactProbe.readText(spec)).toThrow();
    } finally {
      chmodSync(spec, 0o644); // restore for cleanup
    }
  });
});
