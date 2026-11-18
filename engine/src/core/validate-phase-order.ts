/**
 * Core: Enforce phase ordering during loom orchestration.
 * Harness-agnostic — no stdin parsing. BOTH categories of runtime I/O this
 * gate needs (the protected-state read and the phase artifact probes) arrive as
 * injected ports, so the decision logic itself is data-in /
 * data-out and can be exercised with in-memory fixtures.
 *
 * Definition site of `detectPhase` and `checkArtifacts`. The
 * `handlers/pre-tool-use/validate-phase-order` wrapper re-exports them onward,
 * so import sites that predate the move keep working.
 */

import { match } from "ts-pattern";
import type { HookResult, Phase, TaskGraph } from "../types";
import { ARCH_PANEL_AGENTS, isImplementationAgent, isStandaloneReviewAgent, PHASE_AGENT_MAP, REVIEW_AGENTS, REVIEW_PANEL_AGENTS } from "./agent-catalog-projections";
import {
  CLARIFY_THRESHOLD,
  ARCH_PANEL_PHASE,
  UTILITY_AGENTS,
  VALID_TRANSITIONS,
} from "./phase-policy";
import { extractNamespace, stripNamespace } from "../utils/strip-namespace";
import { hasStandaloneReviewContext } from "./review-output";
import { parseArtifactDigest } from "./orchestration-contract/identity";
import {
  planDesignRequirement,
  planDesignReviewOf,
  type RecordedPlanDesignReview,
} from "./plan-design-review";

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
  /** Lowercase hex SHA-256 of the artifact's exact bytes. Throws like `readFileSync` when unreadable. */
  readonly sha256: (path: string) => string;
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
  probe: Pick<ArtifactProbe, "exists">,
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
  /** The agent type as the harness names it: namespaced on Claude Code (`loom:code-reviewer`), bare on Pi. */
  agentType: string;
  /** The task prompt: read only for the standalone review marker. */
  prompt: string;
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

/**
 * The phase an agent's spawn belongs to, by the agent's identity alone: a
 * phase agent's phase, `execute` for implementation, review and Refutation
 * Panel agents, the architecture phase for the architecture panel, else
 * `unknown`. The prompt is never consulted: a prompt that merely mentions
 * "architecture" or a spec does not make its agent phase work (loom#213), and
 * a phase advances only through its phase agent (`PHASE_AGENT_MAP`).
 */
export function detectPhase(agent: string): Phase | "unknown" {
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
  return "unknown";
}

/**
 * Whose agent a spawn names, parsed once from the agent type as the harness
 * gave it (loom#213):
 * - `missing`: no agent type at all — a malformed or drifted spawn payload;
 * - `foreign`: another plugin's namespaced agent, whatever its bare name, or a
 *   bare name outside Loom's catalog;
 * - `loom`: a catalog agent, bare or `loom:`-namespaced, with its phase;
 * - `unknown-loom`: a `loom:` name the catalog does not know — misspelled or missing.
 *
 * A harness that gives bare names (Pi) carries no namespace, so there an
 * unknown name cannot be told from a foreign agent and reads as `foreign`.
 */
export type AgentIdentity =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "foreign" }>
  | Readonly<{ kind: "loom"; phase: Phase }>
  | Readonly<{ kind: "unknown-loom" }>;

export function classifyAgent(agentType: string): AgentIdentity {
  if (agentType.trim() === "") return { kind: "missing" };
  const namespace = extractNamespace(agentType);
  if (namespace !== null && namespace !== "loom") return { kind: "foreign" };
  const phase = detectPhase(stripNamespace(agentType));
  if (phase !== "unknown") return { kind: "loom", phase };
  return namespace === "loom" ? { kind: "unknown-loom" } : { kind: "foreign" };
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
  readonly plan_design_review?: RecordedPlanDesignReview;
}

/**
 * The architecture plan this graph names, as an existing path, or null. The
 * one resolution every plan-reading gate and the plan design acceptance share.
 */
export function planArtifactOf(
  state: Pick<ArtifactState, "phase_artifacts" | "plan_file">,
  probe: Pick<ArtifactProbe, "exists">,
): string | null {
  return resolveArtifact(state.phase_artifacts.architecture, state.plan_file, probe);
}

const NO_PLAN = "architecture (no plan.md found)";

/** The plan-alignment gate, once the plan this graph names is resolved. */
function checkPlanAlignmentGate(state: ArtifactState, probe: ArtifactProbe): string | null {
  if (state.skipped_phases.includes("plan-alignment")) return null;
  const specDir = state.spec_dir ?? ".claude/specs";
  return probe.findFile(specDir, "plan-alignment.md") ? null : "plan-alignment (no plan-alignment.md found)";
}

/**
 * The plan design gate (ADR-0070): decompose needs the design review this
 * graph requires, accepted for the plan's bytes as they are now. Only the
 * digest of `plan` (the plan the alignment gate just resolved) is read; the
 * review's Run Directory is never opened here.
 */
function checkPlanDesignGate(state: ArtifactState, plan: string, probe: ArtifactProbe): string | null {
  const review = planDesignReviewOf(state.plan_design_review);
  if (review.status === "not-required") return null;
  let observed: string;
  try {
    observed = probe.sha256(plan);
  } catch (e) {
    return `architecture (plan unreadable: ${(e as Error).message})`;
  }
  const currentSha256 = parseArtifactDigest(observed);
  return currentSha256.ok
    ? planDesignRequirement(review, currentSha256.value, plan)
    : `architecture (plan digest unreadable: ${currentSha256.error.message})`;
}

/** The plan this graph names, then `gates` over it; NO_PLAN when there is none. */
function withPlan(state: ArtifactState, probe: ArtifactProbe, gates: (plan: string) => string | null): string | null {
  const plan = planArtifactOf(state, probe);
  return plan === null ? NO_PLAN : gates(plan);
}

/**
 * The spec artifact, or the reason it is missing.
 *
 * `clarify` and `architecture` both require an existing spec.md and share the
 * same declared-artifact → spec_file → spec_dir search and failure string.
 * Architecture additionally reads the selected artifact when it must count
 * clarification markers; clarify only needs the artifact path as its input.
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
    .with("plan-alignment", () => planArtifactOf(state, probe) ? null : NO_PLAN)
    .with("decompose", () => withPlan(state, probe, (plan) =>
      checkPlanAlignmentGate(state, probe) ?? checkPlanDesignGate(state, plan, probe)))
    // Execute keeps the plan-alignment gate only: the design gate binds the
    // plan Tasks are cut from, and a plan may be amended once they exist.
    .with("execute", () => withPlan(state, probe, () => checkPlanAlignmentGate(state, probe)))
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

  // A foreign agent is not phase work, so the phase order is not its business
  // (loom#213): it cannot advance a phase, and what it may write in the
  // orchestrated repository is the direct-edit guard's decision
  // (`core/block-direct-edits.ts`). On a bare-name harness (Pi) an unknown
  // name is foreign too, so there a misspelled Loom agent passes this gate
  // and is still held by the direct-edit guard.
  const judged = match(classifyAgent(input.agentType))
    .returnType<Readonly<{ phase: Phase }> | HookResult>()
    .with({ kind: "foreign" }, (): HookResult => ({ kind: "allow" }))
    .with({ kind: "missing" }, (): HookResult => ({
      kind: "block",
      message: "BLOCKED: The spawn names no agent type, so its phase cannot be judged.",
    }))
    .with({ kind: "unknown-loom" }, (): HookResult => ({
      kind: "block",
      message: [
        "BLOCKED: Unrecognized Loom agent type during loom orchestration.",
        "",
        `Agent: ${input.agentType}`,
        "",
        "Use a recognized phase agent:",
        "  brainstorm-agent, specify-agent, clarify-agent, architecture-agent,",
        "  plan-alignment-agent, code-implementer-agent, ts-test-agent, frontend-agent, etc.",
      ].join("\n"),
    }))
    .with({ kind: "loom" }, ({ phase }) => ({ phase }))
    .exhaustive();
  if (!("phase" in judged)) return judged;
  const targetPhase = judged.phase;

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
