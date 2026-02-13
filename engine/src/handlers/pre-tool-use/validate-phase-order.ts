/**
 * Enforce phase ordering: brainstorm → specify → clarify → architecture → decompose → execute
 * Blocks agent spawns if prerequisite phases not complete.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { match } from "ts-pattern";
import type { HookHandler, PreToolUseInput, Phase } from "../../types";
import {
  TASK_GRAPH_PATH, PHASE_AGENT_MAP, IMPL_AGENTS, REVIEW_AGENTS,
  UTILITY_AGENTS, VALID_TRANSITIONS, CLARIFY_THRESHOLD,
} from "../../config";
import { StateManager } from "../../state-manager";
import { stripNamespace } from "../../utils/strip-namespace";

export function detectPhase(agent: string, prompt: string): Phase | "unknown" {
  if (PHASE_AGENT_MAP[agent]) return PHASE_AGENT_MAP[agent];
  if (IMPL_AGENTS.has(agent) || REVIEW_AGENTS.has(agent)) return "execute";

  // Fallback: check prompt for phase indicators
  if (/brainstorm|explore.*intent|refine.*idea/i.test(prompt)) return "brainstorm";
  if (/specify|specification|requirements|spec\.md/i.test(prompt)) return "specify";
  if (/clarify|resolve.*markers|NEEDS CLARIFICATION/i.test(prompt)) return "clarify";
  if (/architecture|design|plan\.md/i.test(prompt)) return "architecture";

  return "unknown";
}

/** Recursively search for a file by name under a directory */
function findFile(dir: string, filename: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === filename) return true;
      if (entry.isDirectory()) {
        if (findFile(join(dir, entry.name), filename)) return true;
      }
    }
  } catch {}
  return false;
}

interface ArtifactState {
  skipped_phases: string[];
  phase_artifacts: Record<string, string>;
  spec_file: string | null;
  plan_file: string | null;
}

function checkArtifacts(targetPhase: Phase, state: ArtifactState): string | null {
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
        } catch {}
      }
      return null;
    })
    .with("decompose", () => {
      const plan = state.phase_artifacts.architecture ?? state.plan_file;
      if (!plan || !existsSync(plan)) return "architecture (no plan.md found)";
      return null;
    })
    .with("execute", () => {
      const plan = state.phase_artifacts.architecture ?? state.plan_file;
      if (!plan || !existsSync(plan)) return "architecture (no plan.md found)";
      return null;
    })
    .otherwise(() => null);
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
        "  code-implementer-agent, java-test-agent, ts-test-agent, etc.",
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
        "Expected flow: brainstorm → specify → clarify → architecture → decompose → execute",
        `Current phase: ${currentPhase}`,
        "",
        match(currentPhase)
          .with("init", () => "Next: Run brainstorm-agent (or --skip-brainstorm)")
          .with("brainstorm", () => "Next: Run specify-agent")
          .with("specify", () => "Next: Run clarify-agent or architecture-agent")
          .with("clarify", () => "Next: Run architecture-agent")
          .with("architecture", () => "Next: Decompose tasks")
          .otherwise(() => ""),
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
