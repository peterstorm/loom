/**
 * SubagentStop dispatcher — routes by agent_type to relevant handlers.
 * Invoked via the dispatch.sh shim; reads stdin once, calls only relevant
 * handlers.
 */

import { match } from "ts-pattern";
import type { HookHandler, HookResult } from "../../types";
import type { AgentRequestAuthority } from "../../core/orchestration-contract";
import { PHASE_AGENT_MAP, IMPL_AGENTS, REVIEW_SUB_AGENTS } from "../../core/agent-catalog-projections";
import { StateManager } from "../../state-manager";
import { stripNamespace } from "../../utils/strip-namespace";
import { resolveAgentType } from "../../utils/agent-transcript-path";
import { parseReportedAgentId, parseSessionId, readActiveAgentRoles, readEvidence } from "../../machine";
import { ensureRosteredImplementationBinding, suppliedTranscript } from "../implementation-binding";
import { PENDING_BINDING_ESCALATION } from "../../core/implementation-binding";
import { parseSubagentStopStdin } from "../../parsers/parse-subagent-stop-input";
import { claudeRunContext, type ClaudeRun, type ClaudeRunAuthority } from "../../orchestration/claude-run-authority";
import { openRunDirectory } from "../../orchestration/run-directory-handle";
import { parseRegisteredFacadeProgram, reviewerProtocolResolver } from "../helpers/programs";

import {
  captureClaudeStop,
  establishClaudeStopRun,
  resolveClaudeRequestAuthority,
} from "./capture-orchestration-result";
import cleanupSubagentFlag from "./cleanup-subagent-flag";
import advancePhase from "./advance-phase";
import { runUpdateTaskStatus, type EvidenceSnapshot } from "./update-task-status";
import storeReviewerFindings from "./store-reviewer-findings";
import { runStoreSpecCheckFindings } from "./store-spec-check-findings";
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

/**
 * A rostered implementation Agent can reach SubagentStop still PENDING: its
 * binding is normally established by block-direct-edits before its first
 * write decision, and an Agent may never write (or run with the PreToolUse
 * hooks unavailable). Its transcript
 * exists now, so the binding is attempted once more from its OWN first prompt.
 * A binding that still cannot be proven stays an explicit missing-sidecar
 * observation carrying the reason: settlement then preserves execution
 * authority, and no other Task is ever settled in its place.
 */
function bindPendingImplementationAtStop(
  input: Readonly<{ session_id?: string; agent_id?: string; agent_transcript_path?: string }>,
  observation: ImplementationAuthorityObservation,
): ImplementationAuthorityObservation {
  if (observation.kind !== "authority-unavailable" || observation.failure.kind !== "missing-sidecar") return observation;
  const sessionId = parseSessionId(input.session_id ?? "");
  const agentId = parseReportedAgentId(input.agent_id ?? "");
  if (sessionId === null || agentId === null) return observation;
  const outcome = ensureRosteredImplementationBinding({
    sessionId,
    agentId,
    roster: readActiveAgentRoles(sessionId),
    ...suppliedTranscript(input.agent_transcript_path),
  });
  if (outcome === null) return observation;
  if (outcome.kind === "bound") return snapshotImplementationAttemptSidecar(sessionId, agentId);
  return Object.freeze({
    kind: "authority-unavailable",
    failure: Object.freeze({
      kind: "missing-sidecar",
      message: `implementation binding was still pending at SubagentStop and is ${outcome.kind}: ${outcome.reason}` +
        (outcome.kind === "pending" ? `. ${PENDING_BINDING_ESCALATION}` : ""),
    }),
  });
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

  // Cleanup is available to every post-parse failure boundary. It never
  // preempts the category's one chance to settle protected state, but routing,
  // capture, and authority faults must all release their runtime capabilities.
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
  const errorAfterCleanup = async (failure: string): Promise<HookResult> => {
    const cleanupFailure = await runCleanup();
    return {
      kind: "error",
      message: cleanupFailure === null
        ? failure
        : `${failure}; cleanup also failed: ${cleanupFailure}`,
    };
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

  // Request-bound capture runs BEFORE any legacy routing, and before the task
  // graph is resolved at all. Both orderings are load-bearing: the graph lookup
  // below returns early when there is none, which would skip capture for every
  // standalone run; and repository metadata is not request authority, so a
  // metadata fault must not prevent a reserved result from being captured.
  //
  // The run this stop speaks for is established ONCE (explicit environment
  // authority, else the Claude Code session run binding) and that one value is
  // threaded through capture, request resolution, and the reviewer-protocol
  // read below, so no step can re-derive a different run.
  let captureFailure: string | null = null;
  let runAuthority: ClaudeRunAuthority = { kind: "unbound" };
  try {
    const established = await establishClaudeStopRun(input, claudeRunContext(input.session_id));
    if (!established.ok) {
      captureFailure = `request-bound capture rejected: ${established.message}`;
    } else {
      runAuthority = established.value;
      const capture = await captureClaudeStop(input, runAuthority);
      if (capture.kind === "error") captureFailure = capture.message;
    }
  } catch (error) {
    captureFailure = `captureOrchestrationResult crashed: ${error instanceof Error ? error.message : String(error)}`;
    process.stderr.write(`ERROR in captureOrchestrationResult: ${captureFailure}\n`);
  }

  // Which PROGRAM a stop belongs to decides whether legacy category settlement
  // applies at all, and it is decided from the same correlation, in the same
  // run, the capture above used.
  let requestBinding: Readonly<{ request: AgentRequestAuthority; run: ClaudeRun }> | null = null;
  if (captureFailure === null) {
    const resolved = resolveClaudeRequestAuthority(input, runAuthority);
    if (resolved.ok) requestBinding = resolved.bound;
    else captureFailure = `request authority resolution failed: ${resolved.message}`;
  }
  const requestAuthority = requestBinding?.request ?? null;

  if (captureFailure !== null) return errorAfterCleanup(captureFailure);

  // Request-bound non-Wave programs own no TaskGraph mutation. A successful
  // capture is their complete SubagentStop settlement; falling through would
  // falsely require unrelated protected state and report an error after the
  // Run Directory had already accepted the evidence. They never need weaker
  // transcript metadata or implementation-sidecar routing observations.
  if (requestAuthority !== null && requestAuthority.program !== "wave-gate") {
    const cleanupFailure = await runCleanup();
    return cleanupFailure === null
      ? { kind: "passthrough" }
      : { kind: "error", message: cleanupFailure };
  }

  // Resolve legacy routing only after request authority. Claude may omit
  // agent_type, so this can touch transcript metadata; every filesystem fault
  // is converted to an explicit settlement failure and still runs cleanup.
  let resolvedAgentType: string;
  let sidecarObservation: ImplementationAuthorityObservation;
  try {
    resolvedAgentType = resolveAgentType(input);
    sidecarObservation = bindPendingImplementationAtStop(input, snapshotImplementationAttemptSidecar(
      input.session_id ?? "",
      input.agent_id ?? "",
    ));
  } catch (error) {
    const routingFailure = `dispatch: routing observation failed: ${error instanceof Error ? error.message : String(error)}`;
    return errorAfterCleanup(routingFailure);
  }

  // A request-bound Wave Gate stop is routed only by the exact engine-issued
  // role that capture resolved from the correlator and immutable reservation.
  // Reported/transcript metadata may be absent, but a contradictory role is a
  // refusal rather than an opportunity to settle one request through another
  // role's TaskGraph transition.
  let category: AgentCategory;
  if (requestBinding !== null) {
    const { request: issued, run: requestRun } = requestBinding;
    const authorityRole = stripNamespace(issued.role);
    const authorityCategory = categorize(authorityRole);
    if (authorityCategory !== "review" && authorityCategory !== "spec-check") {
      const message = `Wave Gate request ${issued.requestId} has unroutable issued role ${JSON.stringify(issued.role)}`;
      return errorAfterCleanup(message);
    }
    const reportedRole = stripNamespace(resolvedAgentType);
    if (reportedRole !== "" && reportedRole !== authorityRole) {
      const message = `Wave Gate request ${issued.requestId} is issued to ${JSON.stringify(issued.role)}, ` +
        `but SubagentStop reported ${JSON.stringify(resolvedAgentType)}`;
      return errorAfterCleanup(message);
    }
    category = authorityCategory;
    if (category === "review") {
      const opened = openRunDirectory(requestRun.runsRoot, requestRun.runDirectory);
      if (!opened.ok) return errorAfterCleanup(opened.error.message);
      const raw = opened.value.readProgramRegistration();
      if (!raw.ok) return errorAfterCleanup(raw.error.message);
      const registered = parseRegisteredFacadeProgram(raw.value);
      if (registered.kind !== "registered" || registered.program.kind !== "wave-gate") {
        return errorAfterCleanup("registered Wave reviewer authority unavailable; legacy settlement refused");
      }
      const protocol = reviewerProtocolResolver(opened.value, registered.program)(issued);
      if (!protocol.ok) return errorAfterCleanup(protocol.error.message);
      if (protocol.value.protocolVersion === 2) {
        // Capture is complete. Registered resume owns admission, bounded retry,
        // and locked Task settlement; never also merge/count-poll these bytes.
        const cleanupFailure = await runCleanup();
        return cleanupFailure === null
          ? { kind: "passthrough" }
          : { kind: "error", message: cleanupFailure };
      }
    }
  } else {
    // A valid sidecar is engine-issued implementation routing authority. Claude
    // may omit or corrupt agent_type metadata, so routing cannot be conditional
    // on that weaker field. Unavailable sidecars do not reclassify unrelated
    // agents.
    category = sidecarObservation.kind === "authority-observed"
      ? "impl"
      : categorize(stripNamespace(resolvedAgentType));
  }
  const authorityObservation: ImplementationAuthorityObservation | undefined = category === "impl"
    ? sidecarObservation
    : undefined;
  const specCheckRequestAuthority = category === "spec-check" ? requestAuthority : null;
  const settlementStdin = requestAuthority === null
    ? stdin
    : JSON.stringify({ ...input, agent_type: requestAuthority.role });

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
    .with("review", () => runChild("storeReviewerFindings", () => storeReviewerFindings(settlementStdin, args)))
    .with("spec-check", () => runChild("storeSpecCheckFindings", () =>
      runStoreSpecCheckFindings(settlementStdin, args, specCheckRequestAuthority ?? undefined)))
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
