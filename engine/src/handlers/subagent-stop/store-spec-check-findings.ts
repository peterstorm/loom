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
import { readTranscriptWithRetry } from "../../utils/read-transcript-with-retry";
import { resolveAgentTranscriptPath, resolveAgentType } from "../../utils/agent-transcript-path";
import { stripNamespace } from "../../utils/strip-namespace";
import { observeWaveSpecCheckDocuments } from "../../orchestration/wave-spec-check-documents";
import { epochSettledFloor } from "../../core/wave-review-authority";
import { observeTaskGraphProjectBoundary } from "../../config";

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
  let transcript: string | null = null;
  let transcriptFailure: string | null = resolvedTranscriptPath === null
    ? `spec-check transcript is unreadable: no transcript can be located at ${rawPath || "<unset>"}`
    : null;
  if (resolvedTranscriptPath !== null) {
    try {
      transcript = await readTranscriptWithRetry(resolvedTranscriptPath, /SPEC_CHECK_CRITICAL_COUNT:\s*\d+/);
    } catch (error) {
      transcriptFailure = `spec-check transcript is unreadable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const findings = parseSpecCheckOutput(transcript ?? "");
  let observation;
  try {
    const observedState = manager.load();
    observation = observeWaveSpecCheckDocuments({
      specFile: observedState.spec_file,
      planFile: observedState.plan_file,
      projectRoot: observeTaskGraphProjectBoundary(manager.getPath()).root,
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
