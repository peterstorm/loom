/**
 * SubagentStop dispatcher — routes by agent_type to relevant handlers.
 * Invoked via the dispatch.sh shim; reads stdin once, calls only relevant
 * handlers.
 */

import { match, P } from "ts-pattern";
import type { HookHandler, HookResult, SubagentStopInput } from "../../types";
import { PHASE_AGENT_MAP, IMPL_AGENTS, REVIEW_SUB_AGENTS } from "../../config";
import { StateManager } from "../../state-manager";
import { stripNamespace } from "../../utils/strip-namespace";
import { parseSessionId, readEvidence } from "../../machine";

import captureOrchestrationResult from "./capture-orchestration-result";
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

  // Category handlers are evidence boundaries, not best-effort side effects:
  // a child that reports an error (e.g. storeReviewerFindings could not read
  // the reviewer transcript) must surface as a failed SubagentStop, or a wave
  // can look clean while review evidence was silently lost. Cleanup runs
  // BEFORE the category handler, so propagating the failure still leaves the
  // roster/session state consistent.
  const runChild = async (name: string, fn: () => Promise<HookResult>): Promise<HookResult | null> => {
    try {
      const result = await fn();
      if (result.kind === "error" || result.kind === "block") return result;
      return null;
    } catch (e) {
      const message = `${name} crashed: ${e instanceof Error ? e.message : String(e)}`;
      process.stderr.write(`ERROR in ${name}: ${message}\n`);
      return { kind: "error", message };
    }
  };

  // Snapshot the ledger BEFORE cleanup unbinds: the next bind with zero
  // bindings truncates the ledger, so update-task-status must judge this
  // epoch's evidence from a pre-unbind snapshot, not whatever file is on
  // disk by the time it runs. The EvidenceSnapshot union (owned by
  // update-task-status.ts — keep both sides in sync) keeps a FAILED read
  // distinct from a genuinely empty ledger: downstream labels the verdict
  // snapshot-read-failed instead of minting a misleading "degraded".
  // Parse the session id once at this boundary — an unparseable id can name no
  // ledger file, so the snapshot is a (typed) failed read, not empty.
  const sessionId = input.session_id ? parseSessionId(input.session_id) : null;
  let evidenceSnapshot: EvidenceSnapshot;
  if (sessionId === null) {
    process.stderr.write(
      `dispatch: evidence snapshot failed for ${input.session_id ?? "(missing)"}: invalid session id\n`,
    );
    evidenceSnapshot = { kind: "snapshot-failed" };
  } else {
    try {
      evidenceSnapshot = { kind: "snapshot", events: readEvidence(sessionId) };
    } catch (e) {
      process.stderr.write(
        `dispatch: evidence snapshot failed for ${sessionId}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      evidenceSnapshot = { kind: "snapshot-failed" };
    }
  }

  // Request-bound capture runs BEFORE any legacy routing, and before the task
  // graph is resolved at all. Both orderings are load-bearing: the graph lookup
  // below returns early when there is none, which would skip capture for every
  // standalone run; and legacy handlers must not mutate task state after run
  // authority rejected the same result.
  let captureFailure: string | null = null;
  try {
    const capture = await captureOrchestrationResult(stdin, args);
    if (capture.kind === "error") captureFailure = capture.message;
  } catch (error) {
    captureFailure = `captureOrchestrationResult crashed: ${error instanceof Error ? error.message : String(error)}`;
    process.stderr.write(`ERROR in captureOrchestrationResult: ${captureFailure}\n`);
  }

  // Cleanup always runs — but must never abort the rest of the pipeline
  // (a lock-acquisition failure here would otherwise leave the task stuck
  // in executing with no status update).
  await safeRun("cleanupSubagentFlag", () => cleanupSubagentFlag(stdin, args));

  if (captureFailure !== null) {
    return { kind: "error", message: captureFailure };
  }

  // No task graph → no orchestration hooks
  const mgr = StateManager.fromSession(input.session_id);
  if (!mgr) return { kind: "passthrough" };

  const category = categorize(stripNamespace(input.agent_type ?? ""));

  let childFailure: HookResult | null = null;
  await match(category)
    .with("phase", async () => {
      childFailure = await runChild("advancePhase", () => advancePhase(stdin, args));
    })
    .with("impl", async () => {
      childFailure = await runChild("updateTaskStatus", () =>
        runUpdateTaskStatus(stdin, args, evidenceSnapshot),
      );
    })
    .with("review", async () => {
      childFailure = await runChild("storeReviewerFindings", () => storeReviewerFindings(stdin, args));
    })
    .with("spec-check", async () => {
      childFailure = await runChild("storeSpecCheckFindings", () => storeSpecCheckFindings(stdin, args));
    })
    .with("unknown", async () => {
      // No orchestration hooks for unknown agents
    })
    .exhaustive();

  if (childFailure !== null) return childFailure;
  return { kind: "passthrough" };
};

export default handler;
