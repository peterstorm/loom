/**
 * Core: Enforce phase ordering during loom orchestration.
 * Pure function — no stdin parsing.
 *
 * Re-exports detectPhase and checkArtifacts from the original handler
 * for backwards compatibility.
 */

import { existsSync, readFileSync } from "node:fs";
import { match } from "ts-pattern";
import type { HookResult, Phase } from "../types";
import {
  TASK_GRAPH_PATH, PHASE_AGENT_MAP, IMPL_AGENTS, REVIEW_AGENTS,
  UTILITY_AGENTS, VALID_TRANSITIONS, CLARIFY_THRESHOLD,
} from "../config";
import { StateManager } from "../state-manager";
import { stripNamespace } from "../utils/strip-namespace";
import { findFile } from "../utils/find-file";

/**
 * Resolves an artifact reference to an existing file path.
 * Phase artifacts may contain:
 *   - An actual file path (from advance-phase transcript parsing)
 *   - "completed" (from advance-phase when no path was extractable)
 *   - null/undefined
 * Falls back to the explicit file field (spec_file/plan_file) when the artifact
 * isn't a valid path.
 */
function resolveArtifact(artifact: string | undefined, fallback: string | null): string | null {
  // If artifact is a real file path that exists, use it
  if (artifact && artifact !== "completed" && existsSync(artifact)) {
    return artifact;
  }
  // Fall back to the explicit field
  if (fallback && existsSync(fallback)) {
    return fallback;
  }
  return null;
}

export interface ValidatePhaseOrderInput {
  agentType: string;   // bare or namespaced agent name
  prompt: string;      // task prompt
}

export function detectPhase(agent: string, prompt: string): Phase | "unknown" {
  if (PHASE_AGENT_MAP[agent]) return PHASE_AGENT_MAP[agent]; if (PHASE_AGENT_MAP[agent + "-agent"]) return PHASE_AGENT_MAP[agent + "-agent"];
  if (IMPL_AGENTS.has(agent) || IMPL_AGENTS.has(agent + "-agent") || REVIEW_AGENTS.has(agent) || REVIEW_AGENTS.has(agent + "-agent")) return "execute";

  if (/brainstorm|explore.*intent|refine.*idea/i.test(prompt)) return "brainstorm";
  if (/specify|specification|requirements|spec\.md/i.test(prompt)) return "specify";
  if (/clarify|resolve.*markers|NEEDS CLARIFICATION/i.test(prompt)) return "clarify";
  if (/architecture|design|plan\.md/i.test(prompt)) return "architecture";
  if (/plan[\s\-_]alignment|gap[\s\-_]report/i.test(prompt)) return "plan-alignment";

  return "unknown";
}

export interface ArtifactState {
  skipped_phases: Phase[];
  phase_artifacts: Partial<Record<Phase, string>>;
  spec_file: string | null;
  plan_file: string | null;
  spec_dir?: string | null;
}

function checkPlanAlignmentGate(state: ArtifactState): string | null {
  const plan = resolveArtifact(state.phase_artifacts.architecture, state.plan_file);
  if (!plan) return "architecture (no plan.md found)";
  if (!state.skipped_phases.includes("plan-alignment")) {
    const specDir = state.spec_dir ?? ".claude/specs";
    if (!findFile(specDir, "plan-alignment.md")) {
      return "plan-alignment (no plan-alignment.md found)";
    }
  }
  return null;
}

export function checkArtifacts(targetPhase: Phase, state: ArtifactState): string | null {
  return match(targetPhase)
    .with("specify", () => {
      if (state.skipped_phases.includes("brainstorm")) return null;
      const specDir = state.spec_dir ?? ".claude/specs";
      if (!findFile(specDir, "brainstorm.md")) {
        return `brainstorm (no brainstorm.md found in ${specDir})`;
      }
      return null;
    })
    .with("clarify", () => {
      let spec = resolveArtifact(state.phase_artifacts.specify, state.spec_file);
      if (!spec) {
        // Only fall back to disk search if spec_dir is explicitly set
        if (state.spec_dir) {
          spec = findFile(state.spec_dir, "spec.md");
        }
      }
      if (!spec || !existsSync(spec)) return "specify (no spec.md found)";
      return null;
    })
    .with("architecture", () => {
      let spec = resolveArtifact(state.phase_artifacts.specify, state.spec_file);
      if (!spec) {
        // Only fall back to disk search if spec_dir is explicitly set
        if (state.spec_dir) {
          spec = findFile(state.spec_dir, "spec.md");
        }
      }
      if (!spec || !existsSync(spec)) return "specify (no spec.md found)";
      if (!state.skipped_phases.includes("clarify")) {
        try {
          const content = readFileSync(spec, "utf-8");
          const markers = (content.match(/NEEDS CLARIFICATION/g) ?? []).length;
          if (markers > CLARIFY_THRESHOLD) return `clarify (${markers} markers > ${CLARIFY_THRESHOLD})`;
        } catch (e) {
          return `specify (spec.md unreadable: ${(e as Error).message})`;
        }
      }
      return null;
    })
    .with("plan-alignment", () => {
      const plan = resolveArtifact(state.phase_artifacts.architecture, state.plan_file);
      if (!plan) return "architecture (no plan.md found)";
      return null;
    })
    .with("decompose", () => checkPlanAlignmentGate(state))
    .with("execute", () => checkPlanAlignmentGate(state))
    .with("init", () => null)
    .with("brainstorm", () => null)
    .exhaustive();
}

export function validatePhaseOrder(input: ValidatePhaseOrderInput): HookResult {
  if (!existsSync(TASK_GRAPH_PATH)) return { kind: "allow" };

  const bareAgent = stripNamespace(input.agentType);

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

  const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
  if (!mgr) return { kind: "allow" };
  const state = mgr.load();
  const currentPhase: Phase = state.current_phase ?? "init";

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
  const missing = checkArtifacts(targetPhase, state);
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
