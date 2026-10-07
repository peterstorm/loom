/**
 * Auto-store spec-check findings when spec-check-invoker completes.
 * Modern Wave evidence requires exact capture-correlated request authority.
 */

import {
  parseSpecCheckOutput,
  settleSpecCheck,
  specCheckAuthorityProblem,
  type SpecCheckRequestAuthority,
} from "../../core/spec-check";
import { parseSubagentStopStdin } from "../../parsers/parse-subagent-stop-input";
export { parseSpecCheckOutput } from "../../core/spec-check";
import { StateManager } from "../../state-manager";
import { passthroughResult, type HookHandler, type HookResult } from "../../types";
import { readSettledTranscript, type TranscriptFileReader } from "../../utils/read-transcript-with-retry";
import { resolveAgentTranscriptPath, resolveAgentType } from "../../utils/agent-transcript-path";
import { stripNamespace } from "../../utils/strip-namespace";
import { observeWaveSpecCheckDocuments } from "../../orchestration/wave-spec-check-documents";
import { CLAUDE_TRANSCRIPT_MAX_BYTES, readClaudeTranscriptText } from "../../orchestration/claude-transcript-file";
import { epochSettledFloor } from "../../core/wave-review-authority";
import { claudeTranscriptCandidates, parseClaudeTranscript, type ClaudeTranscript } from "../../core/claude-transcript-projection";
import { observeTaskGraphProjectBoundary } from "../../config";
import { match } from "ts-pattern";

/**
 * What the spec-check transcript's final turn delivered, from the ONE settled
 * read: the report text to parse, or a final turn the strict projection found
 * malformed (a torn last line the legacy text read tolerates), carrying its
 * typed corruption error beside the legacy text.
 */
export type SpecCheckTranscriptDelivery =
  /** `handback`: exactly one delivered SubagentHandback; `legacy`: none or several, so the legacy text read. */
  | Readonly<{ kind: "delivered"; source: "handback" | "legacy"; text: string }>
  | Readonly<{ kind: "corrupt-final-turn"; error: string; legacyText: string }>;

/** Every outcome of reading a located spec-check transcript. */
export type SpecCheckReportRead =
  /** The located transcript no longer exists. */
  | Readonly<{ kind: "missing"; path: string }>
  /** The transcript exists but cannot be read: oversize, non-UTF-8, or a filesystem fault. */
  | Readonly<{ kind: "unreadable"; message: string }>
  | SpecCheckTranscriptDelivery;

/**
 * Classify the final turn of the ONE settled transcript read. Current Claude
 * subagents deliver their report through one `SubagentHandback` call, whose
 * JSON-escaped tool input hides every line-start `CRITICAL:`/`HIGH:` finding
 * from the legacy text read while its count markers still match — so the
 * counts can never reconcile. Exactly one delivered handback is the report; no
 * handback or several keep the legacy read, whose reconciliation still fails
 * closed. A malformed final turn is its own outcome, so the caller decides —
 * visibly — what an undecidable delivery means.
 */
export function specCheckTranscriptDelivery(transcript: ClaudeTranscript, legacyText: string): SpecCheckTranscriptDelivery {
  const candidates = claudeTranscriptCandidates(transcript);
  if (!candidates.ok) return Object.freeze({ kind: "corrupt-final-turn", error: candidates.error, legacyText });
  const handbacks = candidates.value.filter(({ origin }) => origin.endsWith(".handback"));
  return handbacks.length === 1
    ? Object.freeze({ kind: "delivered", source: "handback", text: handbacks[0]!.text })
    : Object.freeze({ kind: "delivered", source: "legacy", text: legacyText });
}

/**
 * Read the spec-check transcript once — waiting for the count marker like the
 * legacy read, bounded and decoded exactly like request-bound capture — and
 * derive both the legacy text and the handback candidates from those same
 * bytes. Every outcome is a value: a located transcript that vanished or cannot
 * be read is never an empty report, and never an exception the caller must
 * remember to catch.
 */
export async function readSpecCheckReport(
  transcriptPath: string,
  maximumBytes = CLAUDE_TRANSCRIPT_MAX_BYTES,
): Promise<SpecCheckReportRead> {
  const boundedRead: TranscriptFileReader = (path) => readClaudeTranscriptText(path, maximumBytes);
  let settled;
  try {
    settled = await readSettledTranscript(transcriptPath, /SPEC_CHECK_CRITICAL_COUNT:\s*\d+/, boundedRead);
  } catch (error) {
    return Object.freeze({ kind: "unreadable", message: error instanceof Error ? error.message : String(error) });
  }
  if (settled.kind === "missing") return Object.freeze({ kind: "missing", path: transcriptPath });
  return specCheckTranscriptDelivery(parseClaudeTranscript(settled.content.split("\n")), settled.text);
}

/** The settlement policy's verdict on one transcript read: the report text to
 *  parse (with the diagnostic the hook must surface, if any), or the capture
 *  failure it is. */
export type SpecCheckReportSettlement =
  | Readonly<{ kind: "report"; text: string; diagnostic: string | null }>
  | Readonly<{ kind: "failure"; reason: string }>;

/**
 * The spec-check settlement policy at the transcript seam, pure. A missing or
 * unreadable transcript is a capture failure. A corrupt final turn falls back
 * to the legacy text — whose count reconciliation still fails closed, so no
 * wrong report is accepted — with its typed error as a diagnostic, so a torn
 * transcript is diagnosable rather than surfacing only as a count mismatch.
 */
export function settleSpecCheckReportRead(read: SpecCheckReportRead): SpecCheckReportSettlement {
  return match(read)
    .returnType<SpecCheckReportSettlement>()
    .with({ kind: "missing" }, ({ path }) =>
      ({ kind: "failure", reason: `spec-check transcript is unreadable: no transcript exists at ${path}` }))
    .with({ kind: "unreadable" }, ({ message }) =>
      ({ kind: "failure", reason: `spec-check transcript is unreadable: ${message}` }))
    .with({ kind: "corrupt-final-turn" }, ({ error, legacyText }) => ({
      kind: "report",
      text: legacyText,
      diagnostic: `store-spec-check-findings: spec-check final turn is malformed (${error}); parsing the legacy transcript text, whose count reconciliation fails closed`,
    }))
    .with({ kind: "delivered" }, ({ text }) => ({ kind: "report", text, diagnostic: null }))
    .exhaustive();
}

export const runStoreSpecCheckFindings = async (
  stdin: string,
  _args: string[],
  requestAuthority?: SpecCheckRequestAuthority,
): Promise<HookResult> => {
  const parsedInput = parseSubagentStopStdin(stdin);
  if (!parsedInput.ok) {
    return {
      kind: "error",
      message: `store-spec-check-findings: invalid SubagentStop input — spec-check findings NOT stored: ${parsedInput.error}`,
    };
  }
  const input = parsedInput.value;
  const agentType = stripNamespace(resolveAgentType(input));
  if (agentType === "") {
    return {
      kind: "error",
      message: "store-spec-check-findings: SubagentStop Agent identity is unavailable — spec-check findings NOT stored",
    };
  }
  if (agentType !== "spec-check-invoker") return { kind: "passthrough" };

  let manager: StateManager | null;
  try {
    manager = StateManager.fromSession(input.session_id);
  } catch (error) {
    return {
      kind: "error",
      message: `store-spec-check-findings: session TaskGraph authority unavailable — spec-check findings NOT stored: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (manager === null) {
    return {
      kind: "error",
      message: `store-spec-check-findings: no TaskGraph authority for session ${JSON.stringify(input.session_id)} — spec-check findings NOT stored`,
    };
  }

  const resolvedTranscriptPath = resolveAgentTranscriptPath(input);
  const rawPath = resolvedTranscriptPath ?? input.agent_transcript_path ?? "";
  const report: SpecCheckReportSettlement = resolvedTranscriptPath === null
    ? { kind: "failure", reason: `spec-check transcript is unreadable: no transcript can be located at ${rawPath || "<unset>"}` }
    : settleSpecCheckReportRead(await readSpecCheckReport(resolvedTranscriptPath));
  if (report.kind === "report" && report.diagnostic !== null) process.stderr.write(`[loom] ${report.diagnostic}\n`);
  const transcriptFailure = report.kind === "failure" ? report.reason : null;
  const findings = parseSpecCheckOutput(report.kind === "report" ? report.text : "");
  let observation;
  try {
    const observedState = manager.load();
    observation = observeWaveSpecCheckDocuments({
      specFile: observedState.spec_file,
      planFile: observedState.plan_file,
      projectBoundary: observeTaskGraphProjectBoundary(manager.getPath()),
    });
  } catch (error) {
    return {
      kind: "error",
      message: `store-spec-check-findings: spec/plan authority is unreadable — spec-check findings NOT stored: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const documents = observation.authority;
  const applied = await manager.updateAndReturn((state) => {
    const authorityProblem = specCheckAuthorityProblem(state, requestAuthority, documents);
    if (authorityProblem !== null) {
      return {
        state,
        value: {
          kind: "error" as const,
          message: `store-spec-check-findings: ${authorityProblem} — spec-check findings NOT stored`,
        },
      };
    }
    // The Wave never comes from the Agent's SPEC_CHECK_WAVE marker. Protected
    // epoch authority chooses evidence filing and the Wave block target; on the
    // legacy path the protected current Wave is the engine's belief. The
    // reported party selects neither destination.
    const epochWave = state.wave_review_epoch?.wave ?? null;
    const wave = epochWave ?? state.current_wave ?? 1;
    // Read back from the epoch, never re-projected: only a packet-correlated
    // capture carries floor authority, and it is exactly what this Agent saw.
    const runAt = new Date().toISOString();
    const settlement = transcriptFailure === null
      ? settleSpecCheck(state, {
          kind: "registered-transcript",
          parsed: findings,
          wave,
          runAt,
          floor: epochSettledFloor(state.wave_review_epoch),
        })
      : settleSpecCheck(state, {
          kind: "capture-failure",
          wave,
          runAt,
          error: `${transcriptFailure} - re-run /wave-gate`,
        });
    const value = settlement.specCheck.verdict === "EVIDENCE_CAPTURE_FAILED"
      ? passthroughResult(`WARNING: ${settlement.specCheck.error} — marking evidence_capture_failed`)
      : passthroughResult(
          `Spec-check: ${settlement.specCheck.critical_count} critical, ${settlement.specCheck.high_count} high`,
        );
    return { state: settlement.state, value };
  });
  if (applied.kind === "passthrough" && applied.systemMessage !== undefined) {
    process.stderr.write(`${applied.systemMessage}\n`);
  }
  return applied;
};

const handler: HookHandler = (stdin, args) => runStoreSpecCheckFindings(stdin, args);

export default handler;
