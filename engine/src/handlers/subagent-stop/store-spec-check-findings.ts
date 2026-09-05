/**
 * Auto-store spec-check findings when spec-check-invoker completes.
 * Modern Wave evidence requires exact capture-correlated request authority.
 */

import { reconcileWaveBlock } from "../../core/wave-gate-model";
import {
  parseSpecCheckOutput,
  reconcileSpecCheck,
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
import { settledSpecCheckFloor } from "../../core/wave-review-authority";

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
    observation = observeWaveSpecCheckDocuments(observedState.spec_file, observedState.plan_file);
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
    const wave = state.wave_review_epoch?.wave ?? findings.wave ?? state.current_wave ?? 1;
    const captured = transcriptFailure === null
      ? reconcileSpecCheck(findings, wave, new Date().toISOString(),
          settledSpecCheckFloor(observation.specIndex, state, wave))
      : {
          kind: "evidence-failed" as const,
          specCheck: {
            wave,
            run_at: new Date().toISOString(),
            verdict: "EVIDENCE_CAPTURE_FAILED" as const,
            error: `${transcriptFailure} - re-run /wave-gate`,
          },
        };
    const resolution = captured;
    const value = resolution.kind === "evidence-failed"
      ? passthroughResult(`WARNING: ${resolution.specCheck.error} — marking evidence_capture_failed`)
      : passthroughResult(
          `Spec-check: ${resolution.specCheck.critical_count} critical, ${resolution.specCheck.high_count} high`,
        );
    return {
      state: {
        ...state,
        spec_check: resolution.specCheck,
        wave_gates: reconcileWaveBlock(state.wave_gates, state.tasks, resolution.specCheck, wave),
      },
      value,
    };
  });
  if (applied.kind === "passthrough" && applied.systemMessage !== undefined) {
    process.stderr.write(`${applied.systemMessage}\n`);
  }
  return applied;
};

const handler: HookHandler = (stdin, args) => runStoreSpecCheckFindings(stdin, args);

export default handler;
