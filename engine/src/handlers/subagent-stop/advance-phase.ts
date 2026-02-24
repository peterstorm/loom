/**
 * Advance current_phase when phase agents complete.
 * Extracts and stores phase artifacts from transcript.
 *
 * Phases: brainstorm → specify → clarify → architecture → plan-alignment → decompose → execute
 */

import { existsSync, readFileSync } from "node:fs";
import { match } from "ts-pattern";
import type { HookHandler, SubagentStopInput, Phase, TaskGraph } from "../../types";
import { PHASE_AGENT_MAP, PHASE_ORDER, CLARIFY_THRESHOLD } from "../../config";
import { StateManager } from "../../state-manager";
import { parsePhaseArtifacts } from "../../parsers/parse-phase-artifacts";
import { stripNamespace } from "../../utils/strip-namespace";
import { findFile } from "../../utils/find-file";

/** Count NEEDS CLARIFICATION markers in a file */
export function countMarkers(filePath: string): number {
  try {
    return (readFileSync(filePath, "utf-8").match(/NEEDS CLARIFICATION/g) ?? []).length;
  } catch (e) {
    process.stderr.write(`WARNING: countMarkers failed for ${filePath}: ${(e as Error).message}\n`);
    return CLARIFY_THRESHOLD + 1; // force clarify on read failure
  }
}

/** Determine next phase + artifact after a phase completes */
export function resolveTransition(
  completedPhase: Phase,
  state: TaskGraph,
): { nextPhase: Phase; artifact: string; skipClarify?: boolean } | null {
  return match(completedPhase)
    .with("brainstorm", () => {
      // Scope search to current run's spec_dir to avoid finding stale artifacts
      const searchDir = state.spec_dir ?? ".claude/specs";
      const file = findFile(searchDir, "brainstorm.md");
      if (!file) return null;
      return { nextPhase: "specify" as Phase, artifact: file };
    })
    .with("specify", () => {
      const spec = state.spec_file;
      if (!spec || !existsSync(spec) || !spec.includes(".claude/specs/")) return null;
      const markers = countMarkers(spec);
      if (markers > CLARIFY_THRESHOLD) {
        return { nextPhase: "clarify" as Phase, artifact: spec };
      }
      return { nextPhase: "architecture" as Phase, artifact: spec, skipClarify: true };
    })
    .with("clarify", () => {
      const spec = state.spec_file;
      if (!spec || !existsSync(spec)) return null;
      const markers = countMarkers(spec);
      if (markers > 0) return null; // All markers must be resolved before advancing
      return { nextPhase: "architecture" as Phase, artifact: spec };
    })
    .with("architecture", () => {
      const plan = state.plan_file;
      if (!plan || !existsSync(plan) || !plan.includes(".claude/plans/")) return null;
      if (state.skipped_phases.includes("plan-alignment")) {
        return { nextPhase: "decompose" as Phase, artifact: plan };
      }
      return { nextPhase: "plan-alignment" as Phase, artifact: plan };
    })
    .with("plan-alignment", () => {
      // Loop-back (re-running architecture) is orchestrator-driven via `set-phase` helper,
      // not handled in this hook. We only advance to decompose when the gap report exists.
      const specDir = state.spec_dir ?? ".claude/specs";
      const gapReport = findFile(specDir, "plan-alignment.md");
      if (!gapReport) {
        process.stderr.write(`plan-alignment completed but no plan-alignment.md found in ${specDir}\n`);
        return null;
      }
      return { nextPhase: "decompose" as Phase, artifact: gapReport };
    })
    .with("decompose", () => {
      return { nextPhase: "execute" as Phase, artifact: "task_graph" };
    })
    .with("init", () => null)
    .with("execute", () => null)
    .exhaustive();
}

const handler: HookHandler = async (stdin) => {
  const input: SubagentStopInput = JSON.parse(stdin);
  const completedPhase = PHASE_AGENT_MAP[stripNamespace(input.agent_type ?? "")];
  if (!completedPhase) return { kind: "passthrough" };

  const mgr = StateManager.fromSession(input.session_id);
  if (!mgr) return { kind: "passthrough" };

  // Guard: skip if phase already advanced past this one
  const currentState = mgr.load();
  const currentIdx = PHASE_ORDER.indexOf(currentState.current_phase);
  const completedIdx = PHASE_ORDER.indexOf(completedPhase);
  if (completedIdx >= 0 && currentIdx > completedIdx) {
    process.stderr.write(`Phase ${completedPhase} already past (current: ${currentState.current_phase}), skipping.\n`);
    return { kind: "passthrough" };
  }

  // Extract artifacts from transcript before checking transition
  if (input.agent_transcript_path && existsSync(input.agent_transcript_path)) {
    const transcriptContent = readFileSync(input.agent_transcript_path, "utf-8");
    const artifacts = parsePhaseArtifacts(transcriptContent, currentState.spec_dir);

    await mgr.update((s) => {
      const updates: Partial<TaskGraph> = {};

      if (artifacts.spec_file && existsSync(artifacts.spec_file)
          && artifacts.spec_file.includes(".claude/specs/")) {
        updates.spec_file = artifacts.spec_file;
      }
      if (!s.plan_file && artifacts.plan_file && existsSync(artifacts.plan_file)
          && artifacts.plan_file.includes(".claude/plans/")) {
        updates.plan_file = artifacts.plan_file;
      }

      return Object.keys(updates).length > 0 ? { ...s, ...updates } : s;
    });
  }

  // Reload after potential artifact writes
  const state = mgr.load();
  const transition = resolveTransition(completedPhase, state);
  if (!transition) return { kind: "passthrough" };

  const { nextPhase, artifact, skipClarify } = transition;

  await mgr.update((s) => ({
    ...s,
    current_phase: nextPhase,
    phase_artifacts: { ...s.phase_artifacts, [completedPhase]: artifact },
    skipped_phases: skipClarify
      ? ([...new Set([...s.skipped_phases, "clarify" as Phase])] as Phase[])
      : s.skipped_phases,
    updated_at: new Date().toISOString(),
  }));

  process.stderr.write(`Phase advanced: ${completedPhase} → ${nextPhase}\n`);
  if (skipClarify) {
    process.stderr.write(`  (clarify auto-skipped: markers ≤ ${CLARIFY_THRESHOLD})\n`);
  }

  return { kind: "passthrough" };
};

export default handler;
