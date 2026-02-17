/**
 * SubagentStop dispatcher — routes by agent_type to relevant handlers.
 * Replaces dispatch.sh: reads stdin once, calls only relevant handlers.
 */

import { match, P } from "ts-pattern";
import type { HookHandler, SubagentStopInput } from "../../types";
import { PHASE_AGENT_MAP, IMPL_AGENTS, REVIEW_SUB_AGENTS } from "../../config";
import { StateManager } from "../../state-manager";
import { stripNamespace } from "../../utils/strip-namespace";

import cleanupSubagentFlag from "./cleanup-subagent-flag";
import advancePhase from "./advance-phase";
import updateTaskStatus from "./update-task-status";
import storeReviewerFindings from "./store-reviewer-findings";
import storeSpecCheckFindings from "./store-spec-check-findings";

type AgentCategory = "phase" | "impl" | "review" | "spec-check" | "unknown";

export function categorize(agentType: string): AgentCategory {
  if (PHASE_AGENT_MAP[agentType]) return "phase";
  if (IMPL_AGENTS.has(agentType)) return "impl";
  if (agentType === "spec-check-invoker") return "spec-check";
  if (REVIEW_SUB_AGENTS.has(agentType)) return "review";
  return "unknown";
}

const handler: HookHandler = async (stdin, args) => {
  const input: SubagentStopInput = JSON.parse(stdin);

  // Cleanup always runs
  await cleanupSubagentFlag(stdin, args);

  // No task graph → no orchestration hooks
  const mgr = StateManager.fromSession(input.session_id);
  if (!mgr) return { kind: "passthrough" };

  const category = categorize(stripNamespace(input.agent_type ?? ""));

  const safeRun = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      process.stderr.write(`ERROR in ${name}: ${(e as Error).message}\n`);
    }
  };

  await match(category)
    .with("phase", async () => {
      await safeRun("advancePhase", () => advancePhase(stdin, args));
    })
    .with("impl", async () => {
      await safeRun("updateTaskStatus", () => updateTaskStatus(stdin, args));
    })
    .with("review", async () => {
      await safeRun("storeReviewerFindings", () => storeReviewerFindings(stdin, args));
    })
    .with("spec-check", async () => {
      await safeRun("storeSpecCheckFindings", () => storeSpecCheckFindings(stdin, args));
    })
    .with("unknown", async () => {
      // No orchestration hooks for unknown agents
    })
    .exhaustive();

  return { kind: "passthrough" };
};

export default handler;
