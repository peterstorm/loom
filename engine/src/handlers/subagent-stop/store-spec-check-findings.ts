/**
 * Auto-store spec-check findings when spec-check-invoker completes.
 * Extracts CRITICAL/HIGH/MEDIUM findings and severity counts.
 * Blocks wave if CRITICAL_COUNT > 0.
 */

import type { HookHandler, SubagentStopInput } from "../../types";
import { reconcileWaveBlock } from "../../core/wave-gate-model";
import { parseSpecCheckOutput, reconcileSpecCheck } from "../../core/spec-check";
export { parseSpecCheckOutput } from "../../core/spec-check";
import { StateManager } from "../../state-manager";
import { readTranscriptWithRetry } from "../../utils/read-transcript-with-retry";
import { resolveAgentTranscriptPath } from "../../utils/agent-transcript-path";
import { passthroughDiagnostic } from "../../utils/hook-diagnostic";
import { stripNamespace } from "../../utils/strip-namespace";

const handler: HookHandler = async (stdin) => {
  // Guard the standalone CLI route: dispatch parses stdin before calling
  // handlers, but this handler is also registered directly (KNOWN_HANDLERS),
  // where a bare JSON.parse throw would surface as an uncontextualized
  // "Hook error" (mirrors cleanup-subagent-flag / update-task-status).
  let input: SubagentStopInput;
  try {
    input = JSON.parse(stdin);
  } catch (e) {
    return {
      kind: "error",
      message: `store-spec-check-findings: malformed SubagentStop input — spec-check findings NOT stored: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const agentType = stripNamespace(input.agent_type ?? "");
  if (agentType !== "spec-check-invoker") return { kind: "passthrough" };

  let mgr: StateManager | null;
  try {
    mgr = StateManager.fromSession(input.session_id);
  } catch (error) {
    return passthroughDiagnostic(
      `store-spec-check-findings: session TaskGraph authority unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  if (!mgr) return { kind: "passthrough" };

  // Resolved, not read off the payload: on a harness that sends no
  // `agent_transcript_path` every spec-check would otherwise land in the
  // evidence_capture_failed arm below, blocking every wave gate on a
  // capture failure rather than on the spec.
  const rawPath = resolveAgentTranscriptPath(input) ?? input.agent_transcript_path ?? "";
  const transcript = await readTranscriptWithRetry(rawPath, /SPEC_CHECK_CRITICAL_COUNT:\s*\d+/);
  if (!transcript) {
    // Fail CLOSED, mirroring the missing-count path below: recording nothing
    // here would let wave-gate check 4 pass vacuously as "skipped (no
    // spec-check data)" — an unreadable/empty transcript must read as a
    // capture failure, never as a clean skip.
    process.stderr.write(
      `WARNING: spec-check transcript empty or unreadable (path=${rawPath || "<unset>"}) — marking evidence_capture_failed\n`,
    );
    const state = mgr.load();
    await mgr.update((s) => ({
      ...s,
      spec_check: {
        wave: state.current_wave ?? 1,
        run_at: new Date().toISOString(),
        verdict: "EVIDENCE_CAPTURE_FAILED",
        error: "spec-check agent transcript empty or unreadable - re-run /wave-gate",
      },
    }));
    return { kind: "passthrough" };
  }

  const findings = parseSpecCheckOutput(transcript);
  const state = mgr.load();
  const wave = findings.wave ?? state.current_wave ?? 1;

  const resolution = reconcileSpecCheck(findings, wave, new Date().toISOString());
  if (resolution.kind === "evidence-failed") {
    process.stderr.write(`WARNING: ${resolution.specCheck.error} — marking evidence_capture_failed\n`);
    await mgr.update((s) => ({ ...s, spec_check: resolution.specCheck }));
    return { kind: "passthrough" };
  }

  // `blocked` is DERIVED from the freshly stored spec-check, never asserted:
  // `wave-gate-model.waveHasBlockCause` is documented as the only copy of the
  // rule, and a literal `blocked: true` here was a second copy that could not
  // clear the flag when the cause went away.
  await mgr.update((s) => ({
    ...s,
    spec_check: resolution.specCheck,
    wave_gates: reconcileWaveBlock(s.wave_gates, s.tasks, resolution.specCheck, wave),
  }));

  return passthroughDiagnostic(`Spec-check: ${resolution.specCheck.critical_count} critical, ${resolution.specCheck.high_count} high\n`);
};

export default handler;
