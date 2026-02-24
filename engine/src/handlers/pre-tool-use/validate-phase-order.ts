/**
 * Enforce phase ordering: brainstorm → specify → clarify → architecture → plan-alignment → decompose → execute
 * Blocks agent spawns if prerequisite phases not complete.
 */

import { existsSync, readFileSync } from "node:fs";
import { match } from "ts-pattern";
import type { HookHandler, PreToolUseInput, Phase } from "../../types";
import {
  TASK_GRAPH_PATH, PHASE_AGENT_MAP, IMPL_AGENTS, REVIEW_AGENTS,
  UTILITY_AGENTS, VALID_TRANSITIONS, CLARIFY_THRESHOLD,
} from "../../config";
import { StateManager } from "../../state-manager";
import { stripNamespace } from "../../utils/strip-namespace";
import { findFile } from "../../utils/find-file";

export function detectPhase(agent: string, prompt: string): Phase | "unknown" {
  if (PHASE_AGENT_MAP[agent]) return PHASE_AGENT_MAP[agent];
  if (IMPL_AGENTS.has(agent) || REVIEW_AGENTS.has(agent)) return "execute";

  // Fallback: check prompt for phase indicators
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

/** Check plan-alignment gate: plan.md exists + plan-alignment.md exists (unless skipped) */
function checkPlanAlignmentGate(state: ArtifactState): string | null {
  const plan = state.phase_artifacts.architecture ?? state.plan_file;
  if (!plan || !existsSync(plan)) return "architecture (no plan.md found)";
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
      if (!findFile(".claude/specs", "brainstorm.md")) {
        return "brainstorm (no brainstorm.md found in .claude/specs/)";
      }
      return null;
    })
    .with("clarify", () => {
      const spec = state.phase_artifacts.specify ?? state.spec_file;
      if (!spec || !existsSync(spec)) return "specify (no spec.md found)";
      return null;
    })
    .with("architecture", () => {
      const spec = state.phase_artifacts.specify ?? state.spec_file;
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
      const plan = state.phase_artifacts.architecture ?? state.plan_file;
      if (!plan || !existsSync(plan)) return "architecture (no plan.md found)";
      return null;
    })
    .with("decompose", () => checkPlanAlignmentGate(state))
    .with("execute", () => checkPlanAlignmentGate(state))
    .with("init", () => null)
    .with("brainstorm", () => null)
    .exhaustive();
}

const handler: HookHandler = async (stdin) => {
  if (!existsSync(TASK_GRAPH_PATH)) return { kind: "allow" };

  const input: PreToolUseInput = JSON.parse(stdin);
  if (input.tool_name !== "Task") return { kind: "allow" };

  const prompt = (input.tool_input?.prompt as string) ?? "";
  const subagentType = (input.tool_input?.subagent_type as string) ?? "";
  const bareAgent = stripNamespace(subagentType);

  // Allow utility agents
  if (UTILITY_AGENTS.has(bareAgent)) return { kind: "allow" };

  const targetPhase = detectPhase(bareAgent, prompt);

  if (targetPhase === "unknown") {
    return {
      kind: "block",
      message: [
        "BLOCKED: Unrecognized agent type during loom orchestration.",
        "",
        `Agent: ${subagentType}`,
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
          .with("plan-alignment", () => "Next: Waiting for plan-alignment-agent to complete")
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
};

export default handler;
