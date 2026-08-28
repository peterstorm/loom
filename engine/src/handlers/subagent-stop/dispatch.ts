/**
 * SubagentStop dispatcher — routes by agent_type to relevant handlers.
 * Invoked via the dispatch.sh shim; reads stdin once, calls only relevant
 * handlers.
 */

import { match } from "ts-pattern";
import type { HookHandler, HookResult } from "../../types";
import { PHASE_AGENT_MAP, IMPL_AGENTS, REVIEW_SUB_AGENTS } from "../../config";
import { StateManager } from "../../state-manager";
import { stripNamespace } from "../../utils/strip-namespace";
import { resolveAgentType } from "../../utils/agent-transcript-path";
import { parseSessionId, readEvidence } from "../../machine";
import { parseSubagentStopStdin } from "../../parsers/parse-subagent-stop-input";

import captureOrchestrationResult from "./capture-orchestration-result";
import cleanupSubagentFlag from "./cleanup-subagent-flag";
import advancePhase from "./advance-phase";
import { runUpdateTaskStatus, type EvidenceSnapshot } from "./update-task-status";
import storeReviewerFindings from "./store-reviewer-findings";
import storeSpecCheckFindings from "./store-spec-check-findings";
import { passthroughDiagnostic } from "../../utils/hook-diagnostic";
import {
  snapshotImplementationAttemptSidecar,
  type ImplementationAuthorityObservation,
} from "../../implementation-attempt-sidecar";

type AgentCategory = "phase" | "impl" | "review" | "spec-check" | "unknown";

export function categorize(agentType: string): AgentCategory {
  if (PHASE_AGENT_MAP[agentType]) return "phase";
  if (IMPL_AGENTS.has(agentType)) return "impl";
  if (agentType === "spec-check-invoker") return "spec-check";
  if (REVIEW_SUB_AGENTS.has(agentType)) return "review";
  return "unknown";
}

export const runDispatch = async (
  stdin: string,
  args: string[],
  cleanup: HookHandler = cleanupSubagentFlag,
): Promise<HookResult> => {
  const parsedInput = parseSubagentStopStdin(stdin);
  if (!parsedInput.ok) {
    // No trustworthy session or Agent identity exists, so cleanup cannot be
    // named. Fail closed rather than reporting a successful stop that settled
    // nothing and may have leaked runtime authority.
    return {
      kind: "error",
      message: `dispatch: invalid SubagentStop input — cleanup skipped, bindings may leak: ${parsedInput.error}`,
    };
  }
  const input = parsedInput.value;

  // Category handlers are evidence boundaries, not best-effort side effects:
  // a child that reports an error (e.g. storeReviewerFindings could not read
  // the reviewer transcript) must surface as a failed SubagentStop, or a wave
  // can look clean while review evidence was silently lost. Cleanup runs after
  // category settlement so the exact TaskGraph pointer lease remains live for
  // every handler that resolves session authority.
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

  // Snapshot the ledger BEFORE cleanup unbinds: attribution runs through the
  // live binding, so once cleanup has unbound it update-task-status can no
  // longer tell this epoch's records apart from a sibling's in the file on
  // disk. It must judge from the pre-unbind snapshot instead. (The bind itself
  // no longer truncates — machine/ledger.ts's `bindMachineAgent` documents why
  // that was removed.) The EvidenceSnapshot union (owned by
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

  // Resolve routing before cleanup: Claude's payload may omit agent_type, and
  // the transcript metadata used by the fallback survives cleanup. Modern
  // implementation correlation is snapshotted here too — never reconstructed
  // from assistant text or executing_tasks after the sidecar is removed.
  const resolvedAgentType = resolveAgentType(input);
  const reportedCategory = categorize(stripNamespace(resolvedAgentType));
  const sidecarObservation = snapshotImplementationAttemptSidecar(
    input.session_id ?? "",
    input.agent_id ?? "",
  );
  // A valid sidecar is engine-issued implementation routing authority. Claude
  // may omit or corrupt agent_type metadata, so routing cannot be conditional
  // on that weaker field. Unavailable sidecars do not reclassify unrelated
  // agents.
  const category: AgentCategory = sidecarObservation.kind === "authority-observed"
    ? "impl"
    : reportedCategory;
  const authorityObservation: ImplementationAuthorityObservation | undefined = category === "impl"
    ? sidecarObservation
    : undefined;

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

  // Cleanup always runs, but only after every consumer has resolved the
  // pointer capability. A cleanup failure remains explicit without preempting
  // the category's one chance to settle protected state.
  const runCleanup = async (): Promise<string | null> => {
    try {
      const cleanupResult = await cleanup(stdin, args);
      return cleanupResult.kind === "error" || cleanupResult.kind === "block"
        ? cleanupResult.message
        : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`ERROR in cleanupSubagentFlag: ${message}\n`);
      return `cleanupSubagentFlag crashed: ${message}`;
    }
  };

  if (captureFailure !== null) {
    const cleanupFailure = await runCleanup();
    return {
      kind: "error",
      message: cleanupFailure === null
        ? captureFailure
        : `${captureFailure}; cleanup also failed: ${cleanupFailure}`,
    };
  }

  const noTaskGraphDiagnostic = (cause?: unknown): string =>
    `[loom] dispatch: no task graph resolvable for session ${JSON.stringify(input.session_id ?? "")}` +
    (cause === undefined ? "" : `: ${cause instanceof Error ? cause.message : String(cause)}`) +
    " — SubagentStop recorded NOTHING (task status, test evidence and findings all skipped)";
  const taskGraphRequired = category !== "unknown" || resolvedAgentType === "";
  const unresolvedTaskGraph = async (cause?: unknown): Promise<HookResult> => {
    const graphFailure = noTaskGraphDiagnostic(cause);
    if (taskGraphRequired) process.stderr.write(`${graphFailure}\n`);
    const cleanupFailure = await runCleanup();
    if (cleanupFailure !== null) {
      return { kind: "error", message: `${graphFailure}; cleanup also failed: ${cleanupFailure}` };
    }
    return taskGraphRequired
      ? { kind: "error", message: graphFailure }
      : passthroughDiagnostic(`${graphFailure}\n`);
  };

  // Known Loom categories require exact TaskGraph authority. Only an explicitly
  // named custom agent may legitimately have no graph and pass through.
  try {
    if (StateManager.fromSession(input.session_id) === null) return unresolvedTaskGraph();
  } catch (error) {
    return unresolvedTaskGraph(error);
  }

  const childFailure: HookResult | null = await match(category)
    .with("phase", () => runChild("advancePhase", () => advancePhase(stdin, args)))
    .with("impl", () => runChild("updateTaskStatus", () =>
      runUpdateTaskStatus(stdin, args, evidenceSnapshot, authorityObservation)))
    .with("review", () => runChild("storeReviewerFindings", () => storeReviewerFindings(stdin, args)))
    .with("spec-check", () => runChild("storeSpecCheckFindings", () => storeSpecCheckFindings(stdin, args)))
    .with("unknown", async () => {
      // Genuinely-unknown agents (a user's own subagent) legitimately have no
      // orchestration hooks. An UNNAMEABLE one does not: it means neither the
      // payload nor the harness metadata could say what ran, so a loom agent
      // may have just been discarded. Name which case this is.
      const message = resolvedAgentType === ""
        ? `[loom] dispatch: SubagentStop carried no agent_type and none could be derived for ` +
          `session ${JSON.stringify(input.session_id ?? "")} / agent ${JSON.stringify(input.agent_id ?? "")} — ` +
          `nothing was recorded; if this was a loom agent its result is LOST`
        : `[loom] dispatch: no orchestration route for agent type ${JSON.stringify(resolvedAgentType)} — nothing recorded`;
      process.stderr.write(`${message}\n`);
      return resolvedAgentType === "" ? { kind: "error" as const, message } : null;
    })
    .exhaustive();

  const cleanupFailure = await runCleanup();
  if (cleanupFailure !== null) {
    const categoryMessage = childFailure !== null && (childFailure.kind === "error" || childFailure.kind === "block")
      ? `; category settlement also failed: ${childFailure.message}`
      : "";
    return { kind: "error", message: `${cleanupFailure}${categoryMessage}` };
  }
  if (childFailure !== null) return childFailure;
  return { kind: "passthrough" };
};

const handler: HookHandler = (stdin, args) => runDispatch(stdin, args);

export default handler;
