/**
 * Where one finished Pi subagent result goes — the pure routing decisions of
 * the SubagentStop dispatcher (`pi/subagent-stop.ts`).
 *
 * The dispatcher interleaves three I/O observations per result (request-bound
 * authority, the launcher's startup outcome, request-bound capture) and only
 * then may touch the TaskGraph. Every decision taken between those
 * observations lives here, over plain facts, so the ordering invariants the
 * dispatcher depends on are testable at one interface:
 *
 * - a result whose agent contradicts its reserved slot is ignored before any
 *   capture;
 * - a proven pre-prompt emission startup refusal retains semantic capture
 *   authority and never reaches capture;
 * - capture runs before the standalone short-circuit, so a standalone result
 *   is captured exactly when a run directory exists to collect it;
 * - every Loom-owned result under explicit run authority needs exact captured
 *   evidence before protected state can change;
 * - an ad-hoc batch (no TaskGraph at spawn) never reaches the TaskGraph;
 * - the applier is chosen by agent kind, and a failed process is never parsed
 *   as positive evidence.
 *
 * Each route carries the exact operator line it emits and whether that line
 * counts as an orchestration processing error; the shell only writes them.
 */

import { describeCaptureFailure, type CaptureOutcome } from "../engine/src/orchestration/harness-capture-runtime";
// `isReviewAgent` lives in `core/agent-catalog-projections` beside the
// review-agent roster it reads, NOT in `core/review-output` beside the
// review-output helpers, whose parse/merge rules stay free of it. Importing it
// from the wrong module is a LINK-time ESM failure that takes the whole extension
// with it — every hook, not just review capture. `engine/tests/pi-imports.test.ts`
// resolves every engine import in `pi/` against the real exports so the next
// move of a shared symbol fails a test instead of silently disarming Pi.
import { isReviewAgent, PHASE_AGENT_MAP, IMPL_AGENTS } from "../engine/src/core/agent-catalog-projections";
import type { TaskExecutionSpawn } from "../engine/src/core/validate-task-execution";
import type { Phase } from "../engine/src/types";

/** One operator-visible stderr line (without its newline) and the processing
 *  error it raises, `null` when it is informational only. */
export type PiResultNotice = Readonly<{ stderr: string; processingError: string | null }>;

const notice = (stderr: string, processingError: string | null = null): PiResultNotice =>
  Object.freeze({ stderr, processingError });

/** Results under these agent types are Loom orchestration evidence: exactly
 *  the agents a named applier settles (`piResultApplier`), so the agent
 *  roster is classified in one place. */
export const isLoomOwnedResultAgent = (agentType: string): boolean =>
  piResultApplier(agentType, false).kind !== "none";

/** A result whose agent is not the agent its slot reserved is ignored, before
 *  any capture; under run authority that is a processing error. `null`: the
 *  result answers for its slot (or no slot was reserved). */
export function reservedAgentMismatch(input: Readonly<{
  agentType: string;
  reservedAgentType: string | undefined;
  resultIndex: number;
  runBound: boolean;
}>): PiResultNotice | null {
  if (input.reservedAgentType === undefined || input.agentType === input.reservedAgentType) return null;
  const diagnostic = `result ${input.resultIndex + 1} agent ${JSON.stringify(input.agentType)} does not match ` +
    `reserved ${JSON.stringify(input.reservedAgentType)}`;
  return notice(`loom(pi): ${diagnostic} — evidence ignored`, input.runBound ? `request-bound ${diagnostic}` : null);
}

/** A request-bound result whose authority did not match its correlated
 *  request: rejected uncaptured, and the same diagnostic terminalises its
 *  capture slot. */
export function resultAuthorityRejection(
  agentType: string,
  problem: string,
): Readonly<{ notice: PiResultNotice; captureRejection: string }> {
  const diagnostic = `request-bound result authority rejected for ${agentType}: ${problem}`;
  return Object.freeze({
    notice: notice(`loom(pi): ${diagnostic}; transcript was not captured`, diagnostic),
    captureRejection: diagnostic,
  });
}

/** The marker-absence problem a request-bound result's authority check names. */
export const missingResultMarkersProblem = (resultIndex: number, agentType: string): string =>
  `request-bound result ${resultIndex + 1}/${agentType} has no request/context markers`;

/** The launcher's startup outcome, as `pi/review-capture.ts` classified it. */
export type PiEmissionStartupOutcome =
  | Readonly<{ kind: "ordinary" }>
  | Readonly<{ kind: "untrusted-marker"; reason: string }>
  | Readonly<{
      kind: "proven-startup-refusal";
      marker: Readonly<{ requestId: string; toolName: string; reason: string }>;
    }>;

export type PiEmissionStartupRoute =
  /** Continue to capture, after the notice (if any). */
  | Readonly<{ kind: "capture"; notice: PiResultNotice | null }>
  /** A proven pre-prompt refusal: semantic capture authority is retained. */
  | Readonly<{ kind: "retain-authority"; notice: PiResultNotice }>;

export function routeEmissionStartup(
  outcome: PiEmissionStartupOutcome,
  agentType: string,
  resultIndex: number,
): PiEmissionStartupRoute {
  switch (outcome.kind) {
    case "ordinary":
      return Object.freeze({ kind: "capture" as const, notice: null });
    case "untrusted-marker": {
      const diagnostic = `untrusted emission launch outcome for ${agentType}[${resultIndex}]: ${outcome.reason}`;
      return Object.freeze({
        kind: "capture" as const,
        notice: notice(`loom(pi): ${diagnostic}; applying the ordinary failed-result lifecycle`, diagnostic),
      });
    }
    case "proven-startup-refusal": {
      const { marker } = outcome;
      const diagnostic =
        `Emission startup refused before the Task prompt for issued request ${marker.requestId} ` +
        `(${agentType}, ${marker.toolName}): ${marker.reason}. ` +
        "Correct the launcher/readiness infrastructure and retry this same issued request with a new subagent tool call.";
      return Object.freeze({
        kind: "retain-authority" as const,
        notice: notice(`loom(pi): ${diagnostic} Semantic capture authority was retained.`, diagnostic),
      });
    }
  }
}

/** Which named applier in `pi/subagent-result` settles a result. */
export type PiResultApplier =
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "phase"; phase: Phase }>
  | Readonly<{ kind: "implementation" }>
  | Readonly<{ kind: "review" }>
  | Readonly<{ kind: "spec-check" }>
  /** No applier owns this agent: the result changes nothing. */
  | Readonly<{ kind: "none" }>;

/** A failed process is settled as a failure whatever its agent, so its
 *  valid-looking assistant text is never parsed as evidence. */
export function piResultApplier(agentType: string, resultFailed: boolean): PiResultApplier {
  if (resultFailed) return Object.freeze({ kind: "failed" as const });
  const phase = PHASE_AGENT_MAP[agentType];
  if (phase) return Object.freeze({ kind: "phase" as const, phase });
  if (IMPL_AGENTS.has(agentType)) return Object.freeze({ kind: "implementation" as const });
  if (isReviewAgent(agentType)) return Object.freeze({ kind: "review" as const });
  if (agentType === "spec-check-invoker") return Object.freeze({ kind: "spec-check" as const });
  return Object.freeze({ kind: "none" as const });
}

export type PiCapturedResultFacts = Readonly<{
  agentType: string;
  /** The reserved slot's lifecycle kind; `undefined` when none was reserved. */
  reservedKind: TaskExecutionSpawn["kind"] | undefined;
  runBound: boolean;
  /** The result's task carries Standalone Review context. */
  standaloneContext: boolean;
  resultFailed: boolean;
  spawnedWithoutTaskGraph: boolean;
  capture: CaptureOutcome;
}>;

export type PiCapturedResultRoute =
  | Readonly<{ kind: "skip"; notice: PiResultNotice }>
  /** Resolve the TaskGraph and hand the result to this applier. */
  | Readonly<{ kind: "settle"; applier: PiResultApplier }>;

const skip = (reason: PiResultNotice): PiCapturedResultRoute => Object.freeze({ kind: "skip" as const, notice: reason });

/**
 * Route a result after request-bound capture ran. Standalone results are run
 * artifacts: they never reach a TaskGraph, and under run authority their
 * failed capture is a processing error rather than a harmless short-circuit.
 * A rejected capture, or a Loom-owned result under run authority without
 * exact captured evidence, leaves protected state unchanged. An ad-hoc batch
 * has no TaskGraph to change.
 */
export function routeCapturedPiResult(facts: PiCapturedResultFacts): PiCapturedResultRoute {
  const { agentType, capture } = facts;
  if (facts.runBound || facts.reservedKind === "standalone" || facts.standaloneContext) {
    if (facts.runBound && capture.kind !== "captured") {
      const diagnostic = `standalone request-bound capture failed for ${agentType}: ${describeCaptureFailure(capture)}`;
      return skip(notice(`loom(pi): ${diagnostic}; task state untouched`, diagnostic));
    }
    return skip(notice(facts.resultFailed
      ? `loom(pi): failed standalone ${agentType} result ignored — task state untouched`
      : `loom(pi): ${agentType} belongs to a standalone review run — task state untouched`));
  }
  if (capture.kind === "terminal-rejection" || capture.kind === "retriable-failure" ||
      (facts.runBound && isLoomOwnedResultAgent(agentType) && capture.kind !== "captured")) {
    const diagnostic = `request-bound capture rejected for ${agentType}: ${describeCaptureFailure(capture)}`;
    return skip(notice(`loom(pi): ${diagnostic}; protected state unchanged`, diagnostic));
  }
  if (facts.spawnedWithoutTaskGraph) {
    return skip(notice(
      `loom(pi): ad-hoc ${agentType} completion — no TaskGraph existed at spawn, protected state untouched`,
    ));
  }
  return Object.freeze({ kind: "settle" as const, applier: piResultApplier(agentType, facts.resultFailed) });
}

/** A settled result whose session has no TaskGraph: Loom-owned evidence was
 *  dropped (a processing error); any other agent's result is simply ignored. */
export function missingTaskGraphNotice(agentType: string, sessionId: string): PiResultNotice | null {
  if (!isLoomOwnedResultAgent(agentType)) return null;
  const diagnostic = `no task graph for session ${JSON.stringify(sessionId)}; ${agentType} completion was NOT applied`;
  return notice(`loom(pi): ${diagnostic}`, diagnostic);
}
