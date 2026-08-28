/**
 * Auto-store spec-check findings when spec-check-invoker completes.
 * Modern Wave evidence requires exact capture-correlated request authority.
 */

import type { AgentRequestAuthority } from "../../core/orchestration-contract";
import { reconcileWaveBlock } from "../../core/wave-gate-model";
import { parseSpecCheckOutput, reconcileSpecCheck } from "../../core/spec-check";
import { parseSubagentStopStdin } from "../../parsers/parse-subagent-stop-input";
export { parseSpecCheckOutput } from "../../core/spec-check";
import { StateManager } from "../../state-manager";
import { passthroughResult, type HookHandler, type HookResult, type TaskGraph } from "../../types";
import { readTranscriptWithRetry } from "../../utils/read-transcript-with-retry";
import { resolveAgentTranscriptPath, resolveAgentType } from "../../utils/agent-transcript-path";
import { stripNamespace } from "../../utils/strip-namespace";

type SpecCheckRequestAuthority = Pick<
  AgentRequestAuthority,
  "runId" | "slotId" | "attempt" | "role"
>;

function specCheckAuthorityProblem(
  state: TaskGraph,
  authority: SpecCheckRequestAuthority | undefined,
): string | null {
  const epoch = state.wave_review_epoch;
  const active = state.active_wave_gate;
  if (epoch === undefined && active === undefined) {
    const modernAuthorityHistory = state.spec_trace_version === 2 ||
      state.verification_manifest !== undefined ||
      state.active_wave_completion_suite !== undefined ||
      (state.wave_gate_history?.length ?? 0) > 0 ||
      (state.wave_reopening_history?.length ?? 0) > 0 ||
      (state.orphaned_wave_gate_history?.length ?? 0) > 0 ||
      (state.spec_trace_wave_gate_retirements?.length ?? 0) > 0;
    if (authority !== undefined) {
      return `captured spec-check request ${authority.runId}/${authority.slotId}/${authority.attempt} has no current Wave authority`;
    }
    return modernAuthorityHistory
      ? "modern Wave spec-check has no current capture-correlated request authority"
      : null;
  }
  if (authority === undefined) return "modern Wave spec-check has no capture-correlated request authority";
  if (authority.role !== "spec-check-invoker") return `captured request belongs to ${authority.role}`;
  const slot = epoch?.specCheckSlotAuthority;
  return state.current_phase === "execute" && epoch !== undefined && active !== undefined &&
      state.current_wave === epoch.wave && active.runId === authority.runId && active.wave === epoch.wave &&
      epoch.runId === authority.runId && slot?.slot_id === authority.slotId && slot.attempted === authority.attempt
    ? null
    : `captured spec-check request ${authority.runId}/${authority.slotId}/${authority.attempt} does not match the exact current Wave epoch`;
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

  const rawPath = resolveAgentTranscriptPath(input) ?? input.agent_transcript_path ?? "";
  const transcript = await readTranscriptWithRetry(rawPath, /SPEC_CHECK_CRITICAL_COUNT:\s*\d+/);
  const findings = parseSpecCheckOutput(transcript ?? "");
  const applied = await manager.updateAndReturn((state) => {
    const authorityProblem = specCheckAuthorityProblem(state, requestAuthority);
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
    const resolution = reconcileSpecCheck(findings, wave, new Date().toISOString());
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
