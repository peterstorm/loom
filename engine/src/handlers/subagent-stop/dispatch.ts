/**
 * SubagentStop dispatcher — routes by agent_type to relevant handlers.
 * Invoked via the dispatch.sh shim; reads stdin once, calls only relevant
 * handlers.
 */

import { match, P } from "ts-pattern";
import type { HookHandler, SubagentStopInput } from "../../types";
import { PHASE_AGENT_MAP, IMPL_AGENTS, REVIEW_SUB_AGENTS } from "../../config";
import { StateManager } from "../../state-manager";
import { stripNamespace } from "../../utils/strip-namespace";
import { readEvidence } from "../../machine";

import cleanupSubagentFlag from "./cleanup-subagent-flag";
import advancePhase from "./advance-phase";
import { runUpdateTaskStatus, type EvidenceSnapshot } from "./update-task-status";
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
  let input: SubagentStopInput;
  try {
    input = JSON.parse(stdin);
  } catch (e) {
    // Malformed stop input: no session to clean. Say exactly what breaks —
    // cleanup skipped means the .active roster and machine bindings may leak
    // until the SessionStart stale-sweep runs.
    process.stderr.write(
      `dispatch: malformed SubagentStop input — cleanup skipped, bindings may leak: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return { kind: "passthrough" };
  }

  const safeRun = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      process.stderr.write(`ERROR in ${name}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  };

  // Snapshot the ledger BEFORE cleanup unbinds: the next bind with zero
  // bindings truncates the ledger, so update-task-status must judge this
  // epoch's evidence from a pre-unbind snapshot, not whatever file is on
  // disk by the time it runs. The EvidenceSnapshot union (owned by
  // update-task-status.ts — keep both sides in sync) keeps a FAILED read
  // distinct from a genuinely empty ledger: downstream labels the verdict
  // snapshot-read-failed instead of minting a misleading "degraded".
  let evidenceSnapshot: EvidenceSnapshot;
  try {
    evidenceSnapshot = { kind: "snapshot", events: readEvidence(input.session_id) };
  } catch (e) {
    process.stderr.write(
      `dispatch: evidence snapshot failed for ${input.session_id}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    evidenceSnapshot = { kind: "snapshot-failed" };
  }

  // Cleanup always runs — but must never abort the rest of the pipeline
  // (a lock-acquisition failure here would otherwise leave the task stuck
  // in executing with no status update).
  await safeRun("cleanupSubagentFlag", () => cleanupSubagentFlag(stdin, args));

  // No task graph → no orchestration hooks
  const mgr = StateManager.fromSession(input.session_id);
  if (!mgr) return { kind: "passthrough" };

  const category = categorize(stripNamespace(input.agent_type ?? ""));

  await match(category)
    .with("phase", async () => {
      await safeRun("advancePhase", () => advancePhase(stdin, args));
    })
    .with("impl", async () => {
      await safeRun("updateTaskStatus", () =>
        runUpdateTaskStatus(stdin, args, evidenceSnapshot),
      );
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
