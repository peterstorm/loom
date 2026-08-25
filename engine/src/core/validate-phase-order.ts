/**
 * Core: Enforce phase ordering during loom orchestration.
 * Harness-agnostic — no stdin parsing. BOTH categories of runtime I/O this
 * gate needs (the protected-state read and the phase artifact probes) arrive as
 * injected ports, so the decision logic itself is data-in /
 * data-out and can be exercised with in-memory fixtures.
 *
 * Definition site of `detectPhase` and `checkArtifacts`. `core/index.ts` and the
 * `handlers/pre-tool-use/validate-phase-order` wrapper re-export them onward, so
 * import sites that predate the move keep working.
 */

import { match } from "ts-pattern";
import type { HookResult, Phase, TaskGraph } from "../types";
import {
  PHASE_AGENT_MAP, REVIEW_AGENTS,
  REVIEW_PANEL_AGENTS, UTILITY_AGENTS, VALID_TRANSITIONS, CLARIFY_THRESHOLD,
  ARCH_PANEL_AGENTS, ARCH_PANEL_PHASE,
} from "../config";
import { stripNamespace } from "../utils/strip-namespace";
import { isImplementationAgent, isStandaloneReviewAgent } from "./model-profiles";
import { hasStandaloneReviewContext } from "./review-output";

/**
 * The phase-artifact reads this gate needs, injected rather than imported.
 *
 * The state read was already a seam (`PhaseOrderDeps.loadState`) so the gate
 * could not acquire `StateManager`'s write capability. Artifact existence and
 * content were not, which left `existsSync`/`readFileSync` in the middle of the
 * decision logic: the rule that decides which artifact a phase transition
 * requires could only be observed by writing real files into a real temp
 * directory. Both categories are now ports; the shell supplies the real
 * implementations.
 */
export interface ArtifactProbe {
  /** True when the path exists; readability is established by `readText`. */
  readonly exists: (path: string) => boolean;
  /** Artifact contents as UTF-8. Throws like `readFileSync` when unreadable. */
  readonly readText: (path: string) => string;
  /** Locate `filename` beneath `dir`, or null when absent. */
  readonly findFile: (dir: string, filename: string) => string | null;
}

/**
 * Resolves an artifact reference to an existing file path.
 * Phase artifacts may contain:
 *   - An actual file path (from advance-phase transcript parsing)
 *   - "completed" (from advance-phase when no path was extractable)
 *   - null/undefined
 * Falls back to the explicit file field (spec_file/plan_file) when the artifact
 * isn't a valid path.
 */
function resolveArtifact(
  artifact: string | undefined,
  fallback: string | null,
  probe: ArtifactProbe,
): string | null {
  // If artifact is a real file path that exists, use it
  if (artifact && artifact !== "completed" && probe.exists(artifact)) {
    return artifact;
  }
  // Fall back to the explicit field
  if (fallback && probe.exists(fallback)) {
    return fallback;
  }
  return null;
}

export interface ValidatePhaseOrderInput {
  agentType: string;   // bare or namespaced agent name
  prompt: string;      // task prompt
}

export function isPanelAgent(agent: string): boolean {
  return ARCH_PANEL_AGENTS.has(agent) || ARCH_PANEL_AGENTS.has(agent + "-agent");
}

export function canRunPanelAgent(currentPhase: Phase): boolean {
  return currentPhase === ARCH_PANEL_PHASE;
}

/** Refutation-panel verifiers run inside the wave gate, so they are
 *  execute-phase work — recognized here (bare or `-agent`-suffixed, like every
 *  other set) but absent from REVIEW_SUB_AGENTS so the SubagentStop dispatcher
 *  never parses them for findings they do not emit. */
export function isReviewPanelAgent(agent: string): boolean {
  return REVIEW_PANEL_AGENTS.has(agent) || REVIEW_PANEL_AGENTS.has(agent + "-agent");
}

export function detectPhase(agent: string, prompt: string): Phase | "unknown" {
  // Bound to a local rather than re-indexed: the map's value type is now
  // honestly `Phase | undefined`, so the guard and the returned value are the
  // same narrowed binding instead of two lookups the compiler must trust to
  // agree.
  const direct = PHASE_AGENT_MAP[agent];
  if (direct) return direct;
  const suffixed = PHASE_AGENT_MAP[agent + "-agent"];
  if (suffixed) return suffixed;
  if (isImplementationAgent(agent) || REVIEW_AGENTS.has(agent) || REVIEW_AGENTS.has(agent + "-agent")) return "execute";
  if (isReviewPanelAgent(agent)) return "execute";
  // Architecture-panel agents (--panel) are architecture-phase work. Recognized
  // here so validate-phase-order allows them, but never added to PHASE_AGENT_MAP
  // (advance-phase must ignore them — only architecture-agent advances the phase).
  // ARCH_PANEL_PHASE (config) is the single source for this classification so it
  // cannot drift from ARCH_PANEL_AGENTS.
  if (isPanelAgent(agent)) return ARCH_PANEL_PHASE;

  if (/brainstorm|explore.*intent|refine.*idea/i.test(prompt)) return "brainstorm";
  if (/specify|specification|requirements|spec\.md/i.test(prompt)) return "specify";
  if (/clarify|resolve.*markers|NEEDS CLARIFICATION/i.test(prompt)) return "clarify";
  if (/architecture|design|plan\.md/i.test(prompt)) return "architecture";
  if (/plan[\s\-_]alignment|gap[\s\-_]report/i.test(prompt)) return "plan-alignment";

  return "unknown";
}

/** `readonly` throughout, like its siblings `ArtifactProbe` and
 *  `PhaseOrderDeps`: this is the gate's DECISION INPUT, and a decision input a
 *  checker can reassign in place is one the next checker may read differently. */
export interface ArtifactState {
  readonly skipped_phases: readonly Phase[];
  readonly phase_artifacts: Readonly<Partial<Record<Phase, string>>>;
  readonly spec_file: string | null;
  readonly plan_file: string | null;
  readonly spec_dir?: string | null;
}

function checkPlanAlignmentGate(state: ArtifactState, probe: ArtifactProbe): string | null {
  const plan = resolveArtifact(state.phase_artifacts.architecture, state.plan_file, probe);
  if (!plan) return "architecture (no plan.md found)";
  if (!state.skipped_phases.includes("plan-alignment")) {
    const specDir = state.spec_dir ?? ".claude/specs";
    if (!probe.findFile(specDir, "plan-alignment.md")) {
      return "plan-alignment (no plan-alignment.md found)";
    }
  }
  return null;
}

/**
 * The spec artifact, or the reason it is missing.
 *
 * `clarify` and `architecture` both gate on "specify produced a readable
 * spec.md", and both used to spell out the same declared-artifact →
 * spec_file → spec_dir search and the same failure string. One rule, one
 * resolution: a change to where a spec may live cannot now reach one gate and
 * not the other.
 */
function resolveSpecArtifact(
  state: ArtifactState,
  probe: ArtifactProbe,
): Readonly<{ ok: true; spec: string }> | Readonly<{ ok: false; missing: string }> {
  const declared = resolveArtifact(state.phase_artifacts.specify, state.spec_file, probe);
  // Only fall back to disk search if spec_dir is explicitly set
  const spec = declared ?? (state.spec_dir ? probe.findFile(state.spec_dir, "spec.md") : null);
  return spec && probe.exists(spec)
    ? { ok: true, spec }
    : { ok: false, missing: "specify (no spec.md found)" };
}

export function checkArtifacts(
  targetPhase: Phase,
  state: ArtifactState,
  probe: ArtifactProbe,
): string | null {
  return match(targetPhase)
    .with("specify", () => {
      if (state.skipped_phases.includes("brainstorm")) return null;
      const specDir = state.spec_dir ?? ".claude/specs";
      if (!probe.findFile(specDir, "brainstorm.md")) {
        return `brainstorm (no brainstorm.md found in ${specDir})`;
      }
      return null;
    })
    .with("clarify", () => {
      const resolved = resolveSpecArtifact(state, probe);
      return resolved.ok ? null : resolved.missing;
    })
    .with("architecture", () => {
      const resolved = resolveSpecArtifact(state, probe);
      if (!resolved.ok) return resolved.missing;
      if (!state.skipped_phases.includes("clarify")) {
        try {
          const content = probe.readText(resolved.spec);
          const markers = (content.match(/NEEDS CLARIFICATION/g) ?? []).length;
          if (markers > CLARIFY_THRESHOLD) return `clarify (${markers} markers > ${CLARIFY_THRESHOLD})`;
        } catch (e) {
          return `specify (spec.md unreadable: ${(e as Error).message})`;
        }
      }
      return null;
    })
    .with("plan-alignment", () => {
      const plan = resolveArtifact(state.phase_artifacts.architecture, state.plan_file, probe);
      if (!plan) return "architecture (no plan.md found)";
      return null;
    })
    .with("decompose", () => checkPlanAlignmentGate(state, probe))
    .with("execute", () => checkPlanAlignmentGate(state, probe))
    .with("init", () => null)
    .with("brainstorm", () => null)
    .exhaustive();
}

/**
 * The protected-state read this gate needs, injected rather than imported.
 *
 * `StateManager` is the sole writer of the protected task graph, and a gate
 * that imports it acquires — in type terms — the ability to write the state it
 * is meant to judge. Passing a read seam keeps that capability in the shell
 * and lets this module be exercised without a real state file. The shell
 * supplies `realPhaseOrderDeps`; nothing else may.
 */
export interface PhaseOrderDeps {
  /**
   * Loaded protected graph, or null when there is no active plan.
   *
   * `null` is the ALLOW answer, so the shell must return it only when absence
   * is proven (ENOENT). An unreadable-but-present graph must raise, never
   * report "no plan" — see `realPhaseOrderDeps`.
   */
  readonly loadState: () => TaskGraph | null;
  /** Phase-artifact existence and content reads. */
  readonly artifacts: ArtifactProbe;
}

export function validatePhaseOrder(
  input: ValidatePhaseOrderInput,
  deps: PhaseOrderDeps,
): HookResult {
  const bareAgent = stripNamespace(input.agentType);
  // A standalone review is an isolated run artifact, but the marker is prompt
  // text supplied across a harness boundary. Only the closed review/verifier
  // roster may exercise that authority; every other use fails loudly.
  if (hasStandaloneReviewContext(input.prompt)) {
    return isStandaloneReviewAgent(bareAgent)
      ? { kind: "allow" }
      : {
          kind: "block",
          message: `BLOCKED: Agent ${input.agentType} is not authorized for LOOM_REVIEW_CONTEXT: standalone.`,
        };
  }
  // No active plan → nothing to order. The shell decides what "no state"
  // means; this gate only reacts to the answer.
  const loadedState = deps.loadState();
  if (loadedState === null) return { kind: "allow" };

  // Allow utility agents
  if (UTILITY_AGENTS.has(bareAgent) || UTILITY_AGENTS.has(bareAgent + "-agent")) return { kind: "allow" };

  const targetPhase = detectPhase(bareAgent, input.prompt);

  if (targetPhase === "unknown") {
    return {
      kind: "block",
      message: [
        "BLOCKED: Unrecognized agent type during loom orchestration.",
        "",
        `Agent: ${input.agentType}`,
        "",
        "Use a recognized phase agent:",
        "  brainstorm-agent, specify-agent, clarify-agent, architecture-agent,",
        "  plan-alignment-agent, code-implementer-agent, ts-test-agent, frontend-agent, etc.",
      ].join("\n"),
    };
  }

  const state = loadedState;
  const currentPhase: Phase = state.current_phase ?? "init";

  // Panel mode is an architecture-only fan-out. Generic transition rules allow
  // plan-alignment → architecture for the standard single-agent loop-back, but
  // that must never reopen the expensive panel workflow.
  if (isPanelAgent(bareAgent) && !canRunPanelAgent(currentPhase)) {
    return {
      kind: "block",
      message: [
        "BLOCKED: Architecture panel agents may run only during the architecture phase.",
        "",
        `Agent: ${input.agentType}`,
        `Current phase: ${currentPhase}`,
        "Plan-alignment loop-backs must use architecture-agent (single-agent mode).",
      ].join("\n"),
    };
  }

  // Validate transition
  const allowed = VALID_TRANSITIONS[currentPhase] ?? [];
  if (!allowed.includes(targetPhase)) {
    return {
      kind: "block",
      message: [
        `BLOCKED: Invalid phase transition: ${currentPhase} → ${targetPhase}`,
        "",
        "Expected flow: brainstorm → specify → clarify → architecture → plan-alignment → decompose → execute",
        `Current phase: ${currentPhase}`,
        "",
        match(currentPhase)
          .with("init", () => "Next: Run brainstorm-agent (or --skip-brainstorm)")
          .with("brainstorm", () => "Next: Run specify-agent")
          .with("specify", () => "Next: Run clarify-agent or architecture-agent")
          .with("clarify", () => "Next: Run architecture-agent")
          .with("architecture", () => "Next: Run plan-alignment-agent (or --skip-plan-alignment)")
          .with("plan-alignment", () => "Next: Run plan-alignment-agent, or loop back with architecture-agent")
          .with("decompose", () => "")
          .with("execute", () => "")
          .exhaustive(),
      ].join("\n"),
    };
  }

  // Check artifact requirements
  const missing = checkArtifacts(targetPhase, state, deps.artifacts);
  if (missing) {
    return {
      kind: "block",
      message: [
        `BLOCKED: Missing prerequisite for ${targetPhase} phase`,
        "",
        `Required: ${missing}`,
        "",
        "Complete the prerequisite phase first, or use --skip-X flag.",
      ].join("\n"),
    };
  }

  return { kind: "allow" };
}
