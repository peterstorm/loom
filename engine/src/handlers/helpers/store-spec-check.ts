/**
 * Store spec-check findings manually.
 * Usage: bun cli.ts helper store-spec-check <<< "SPEC_CHECK_WAVE: 1\nSPEC_CHECK_CRITICAL_COUNT: 0\n..."
 * Reads SPEC_CHECK_* markers and CRITICAL:/HIGH:/MEDIUM: lines from stdin.
 */

import type { HookHandler, SpecCheck } from "../../types";
import { parseSpecCheckVerdict } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";
import { StateManager } from "../../state-manager";

const handler: HookHandler = async (stdin) => {
  const mgr = StateManager.fromPath(TASK_GRAPH_PATH);
  if (!mgr) return { kind: "error", message: `No task graph at ${TASK_GRAPH_PATH}` };

  const critical: string[] = [];
  const high: string[] = [];
  const medium: string[] = [];

  for (const line of stdin.split("\n")) {
    const critMatch = line.match(/^CRITICAL:\s*(.*)/);
    if (critMatch) { const t = critMatch[1].trim(); if (t !== '') critical.push(t); continue; }
    const highMatch = line.match(/^HIGH:\s*(.*)/);
    if (highMatch) { const t = highMatch[1].trim(); if (t !== '') high.push(t); continue; }
    const medMatch = line.match(/^MEDIUM:\s*(.*)/);
    if (medMatch) { const t = medMatch[1].trim(); if (t !== '') medium.push(t); }
  }

  const critCount = stdin.match(/SPEC_CHECK_CRITICAL_COUNT:\s*(\d+)/);
  const highCount = stdin.match(/SPEC_CHECK_HIGH_COUNT:\s*(\d+)/);
  const verdict = stdin.match(/SPEC_CHECK_VERDICT:\s*(PASSED|BLOCKED)/);
  const wave = stdin.match(/SPEC_CHECK_WAVE:\s*(\d+)/);

  if (!critCount) return { kind: "error", message: "SPEC_CHECK_CRITICAL_COUNT marker required" };
  if (!verdict) return { kind: "error", message: "SPEC_CHECK_VERDICT marker required" };

  // The regex above only admits PASSED|BLOCKED; the parse restates that
  // proof in the type (closed SpecCheckVerdict union) instead of a cast.
  const parsedVerdict = parseSpecCheckVerdict(verdict[1]);
  if (parsedVerdict === null) {
    return { kind: "error", message: `SPEC_CHECK_VERDICT ${JSON.stringify(verdict[1])} is not a recognized verdict` };
  }

  // Fail closed on a count/findings mismatch, mirroring the auto handler
  // (store-spec-check-findings): the wave gate reads critical_count, so a
  // reported 0 alongside listed CRITICAL lines (or vice versa) would forge
  // a pass or manufacture a block.
  const reportedCritical = Number(critCount[1]);
  if (reportedCritical !== critical.length) {
    return {
      kind: "error",
      message: `SPEC_CHECK_CRITICAL_COUNT is ${reportedCritical} but ${critical.length} CRITICAL: line(s) were provided — counts must match the findings`,
    };
  }
  const reportedHigh = highCount ? Number(highCount[1]) : 0;
  if (highCount && reportedHigh !== high.length) {
    return {
      kind: "error",
      message: `SPEC_CHECK_HIGH_COUNT is ${reportedHigh} but ${high.length} HIGH: line(s) were provided — counts must match the findings`,
    };
  }

  const state = mgr.load();
  const waveNum = wave ? Number(wave[1]) : state.current_wave ?? 1;

  const specCheck: SpecCheck = {
    wave: waveNum,
    run_at: new Date().toISOString(),
    critical_count: reportedCritical,
    high_count: reportedHigh,
    critical_findings: critical,
    high_findings: high,
    medium_findings: medium,
    verdict: parsedVerdict,
  };

  await mgr.update((s) => ({ ...s, spec_check: specCheck }));

  process.stderr.write(`Spec-check stored: wave=${waveNum} critical=${critCount[1]} verdict=${verdict[1]}\n`);
  return { kind: "passthrough" };
};

export default handler;
