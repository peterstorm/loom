/**
 * The `retro` report the status document carries (ADR-0083): every Wave's
 * friction digest and the Waves worth a retro now. It sits beside the
 * skeleton and owner-verification reports, outside the canonical facts and
 * next action, because a retro suggestion never changes what the run must do.
 *
 * Pure.
 */

import { gateRunCount, retroFacts, type RetroFacts, type WaveFriction } from "./retro-facts";
import { describeRetroTrigger, freshRetroSuggestions, type RetroSuggestion } from "./retro-triggers";
import type { TaskGraph } from "../types";

export type RetroStatusReport =
  | Readonly<{ kind: "observed"; facts: RetroFacts; suggestions: readonly RetroSuggestion[] }>
  | Readonly<{ kind: "not-observed"; reason: string }>;

/** The report for a parsed graph, or why there is none. */
export function retroStatusReport(
  parsed: Readonly<{ ok: true; value: TaskGraph }> | Readonly<{ ok: false; error: string }>,
): RetroStatusReport {
  if (!parsed.ok) return Object.freeze({ kind: "not-observed", reason: `the TaskGraph did not parse: ${parsed.error.slice(0, 300)}` });
  const facts = retroFacts(parsed.value);
  return Object.freeze({ kind: "observed", facts, suggestions: freshRetroSuggestions(facts) });
}

/** One Wave's digest as one line: the counts that are not zero. */
export function renderWaveDigest(digest: WaveFriction): string {
  const counts: readonly (readonly [string, string, number])[] = [
    ["retry", "retries", digest.retries],
    ["escalation", "escalations", digest.escalations],
    ["remediation", "remediations", digest.remediations],
    ["infrastructure block", "infrastructure blocks", digest.infrastructureBlocks],
    ["Wave Gate run", "Wave Gate runs", gateRunCount(digest)],
    ["Task reopening", "Task reopenings", digest.taskReopenings],
    ["Wave reopening", "Wave reopenings", digest.waveReopenings],
    ["plan edit", "plan edits", digest.planEdits],
    ["Forward Fix", "Forward Fixes", digest.forwardFixes],
    ["Forward Fix withdrawal", "Forward Fix withdrawals", digest.forwardFixWithdrawals],
    ["spec-trace amendment", "spec-trace amendments", digest.specTraceAmendments],
    ["critical Finding", "critical Findings", digest.findings.critical],
    ["advisory Finding", "advisory Findings", digest.findings.advisory],
    ["refuted Finding", "refuted Findings", digest.findings.refuted],
  ];
  const shown = counts.filter(([, , value]) => value > 0).map(([one, many, value]) => `${value} ${value === 1 ? one : many}`);
  return `Wave ${digest.wave} (${digest.progress}): ${shown.length === 0 ? "no friction recorded" : shown.join(", ")}`;
}

/** The human status lines for the report. */
export function renderRetroStatus(report: RetroStatusReport): readonly string[] {
  if (report.kind === "not-observed") return [`- retro: not observed (${report.reason})`];
  const started = report.facts.waves.filter(({ progress }) => progress !== "pending");
  return [
    "- retro:",
    ...started.map((digest) => `  - ${renderWaveDigest(digest)}`),
    ...report.suggestions.map(({ wave, triggers }) =>
      `  - suggested: /retro --wave ${wave} (${triggers.map(describeRetroTrigger).join("; ")})`),
  ];
}
