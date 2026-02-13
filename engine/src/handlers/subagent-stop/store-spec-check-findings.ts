/**
 * Auto-store spec-check findings when spec-check-invoker completes.
 * Extracts CRITICAL/HIGH/MEDIUM findings and severity counts.
 * Blocks wave if CRITICAL_COUNT > 0.
 */

import { existsSync, readFileSync } from "node:fs";
import type { HookHandler, SubagentStopInput, SpecCheck } from "../../types";
import { StateManager } from "../../state-manager";
import { parseTranscript } from "../../parsers/parse-transcript";
import { readTranscriptWithRetry } from "../../utils/read-transcript-with-retry";

interface SpecCheckFindings {
  critical: string[];
  high: string[];
  medium: string[];
  criticalCount: number | null;
  highCount: number | null;
  verdict: string | null;
  wave: number | null;
}

/** Parse spec-check output for findings */
export function parseSpecCheckOutput(output: string): SpecCheckFindings {
  // Find the actual output block (last occurrence of CRITICAL_COUNT, not template)
  // Template has "SPEC_CHECK_CRITICAL_COUNT: N" where N is not a digit
  // Real output has "SPEC_CHECK_CRITICAL_COUNT: 0" (or other digit)
  const lastCritCountIdx = output.lastIndexOf("SPEC_CHECK_CRITICAL_COUNT:");

  // Search backwards from lastCritCountIdx to find the start of this output block
  // Look for previous SPEC_CHECK_WAVE or start of string
  let blockStart = 0;
  if (lastCritCountIdx >= 0) {
    const beforeCount = output.slice(0, lastCritCountIdx);
    const lastWaveIdx = beforeCount.lastIndexOf("SPEC_CHECK_WAVE:");
    blockStart = lastWaveIdx >= 0 ? lastWaveIdx : 0;
  }

  const searchBlock = lastCritCountIdx >= 0 ? output.slice(blockStart) : output;

  const critical: string[] = [];
  const high: string[] = [];
  const medium: string[] = [];

  for (const line of searchBlock.split("\n")) {
    const critMatch = line.match(/^CRITICAL:\s*(.*)/);
    if (critMatch) { const t = critMatch[1].trim(); if (t !== '') critical.push(t); continue; }
    const highMatch = line.match(/^HIGH:\s*(.*)/);
    if (highMatch) { const t = highMatch[1].trim(); if (t !== '') high.push(t); continue; }
    const medMatch = line.match(/^MEDIUM:\s*(.*)/);
    if (medMatch) { const t = medMatch[1].trim(); if (t !== '') medium.push(t); }
  }

  const critCount = searchBlock.match(/SPEC_CHECK_CRITICAL_COUNT:\s*(\d+)/);
  const highCount = searchBlock.match(/SPEC_CHECK_HIGH_COUNT:\s*(\d+)/);
  const verdict = searchBlock.match(/SPEC_CHECK_VERDICT:\s*(PASSED|BLOCKED)/);
  const wave = searchBlock.match(/SPEC_CHECK_WAVE:\s*(\d+)/);

  return {
    critical,
    high,
    medium,
    criticalCount: critCount ? Number(critCount[1]) : null,
    highCount: highCount ? Number(highCount[1]) : null,
    verdict: verdict?.[1] ?? null,
    wave: wave ? Number(wave[1]) : null,
  };
}

const handler: HookHandler = async (stdin) => {
  const input: SubagentStopInput = JSON.parse(stdin);

  const agentType = (input.agent_type ?? "").replace(/^[^:]+:/, "");
  if (agentType !== "spec-check-invoker") return { kind: "passthrough" };

  const mgr = StateManager.fromSession(input.session_id);
  if (!mgr) return { kind: "passthrough" };

  const rawPath = input.agent_transcript_path ?? "";
  const transcript = await readTranscriptWithRetry(rawPath, /SPEC_CHECK_CRITICAL_COUNT:\s*\d+/);
  if (!transcript) return { kind: "passthrough" };

  const findings = parseSpecCheckOutput(transcript);
  const state = mgr.load();
  const wave = findings.wave ?? state.current_wave ?? 1;

  // Safety: no CRITICAL_COUNT → evidence_capture_failed
  if (findings.criticalCount === null) {
    process.stderr.write("WARNING: No SPEC_CHECK_CRITICAL_COUNT — marking evidence_capture_failed\n");
    await mgr.update((s) => ({
      ...s,
      spec_check: {
        wave,
        run_at: new Date().toISOString(),
        verdict: "EVIDENCE_CAPTURE_FAILED",
        error: "SPEC_CHECK_CRITICAL_COUNT marker not found - re-run /wave-gate",
      },
    }));
    return { kind: "passthrough" };
  }

  const specCheck: SpecCheck = {
    wave,
    run_at: new Date().toISOString(),
    critical_count: findings.criticalCount,
    high_count: findings.highCount ?? 0,
    critical_findings: findings.critical,
    high_findings: findings.high,
    medium_findings: findings.medium,
    verdict: findings.verdict ?? "UNKNOWN",
  };

  await mgr.update((s) => {
    const updated = { ...s, spec_check: specCheck };
    if (findings.criticalCount! > 0) {
      const waveKey = String(wave);
      updated.wave_gates = {
        ...s.wave_gates,
        [waveKey]: {
          ...(s.wave_gates[waveKey] ?? { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false }),
          blocked: true,
        },
      };
    }
    return updated;
  });

  process.stderr.write(`Spec-check: ${findings.criticalCount} critical, ${findings.highCount ?? 0} high\n`);
  return { kind: "passthrough" };
};

export default handler;
