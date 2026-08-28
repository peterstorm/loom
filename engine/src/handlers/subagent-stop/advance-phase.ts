/**
 * Advance current_phase when phase agents complete.
 * Extracts and stores phase artifacts from transcript.
 *
 * Canonical phase-agent chain (happy path; transitions may skip stages per
 * config.VALID_TRANSITIONS — types.ts PHASES is the authoritative order,
 * which includes init as the first phase).
 */

import { accessSync, constants as fsConstants, readFileSync, readdirSync } from "node:fs";
import { match } from "ts-pattern";
import type { HookHandler, Phase, TaskGraph } from "../../types";
import { PHASE_AGENT_MAP, PHASE_ORDER, CLARIFY_THRESHOLD } from "../../config";
import { StateManager } from "../../state-manager";
import { parsePhaseArtifacts } from "../../parsers/parse-phase-artifacts";
import { parseSubagentStopStdin } from "../../parsers/parse-subagent-stop-input";
import { stripNamespace } from "../../utils/strip-namespace";
import { findFile } from "../../utils/find-file";
import { resolveAgentTranscriptPath, resolveAgentType } from "../../utils/agent-transcript-path";
import {
  PLAN_ARTIFACT_DIR,
  SPEC_ARTIFACT_DIR,
  resolvesWithin,
} from "../../core/phase-artifact-paths";
import { passthroughDiagnostic } from "../../utils/hook-diagnostic";

// Re-exported because this module's own containment rule moved to the pure core
// so the Pi shell could share it verbatim; the name stays importable from here.
export { resolvesWithin };

/** ENOENT is absence; every other readability failure reaches the diagnostic boundary. */
function phaseArtifactExists(path: string): boolean {
  try {
    accessSync(path, fsConstants.R_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error(
      `cannot access phase artifact ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Count NEEDS CLARIFICATION markers in a file */
export function countMarkers(filePath: string): number {
  try {
    return (readFileSync(filePath, "utf-8").match(/NEEDS CLARIFICATION/g) ?? []).length;
  } catch (e) {
    process.stderr.write(`WARNING: countMarkers failed for ${filePath}: ${(e as Error).message}\n`);
    return CLARIFY_THRESHOLD + 1; // force clarify on read failure
  }
}

function readableSpecArtifact(state: TaskGraph): string | null {
  let spec = state.spec_file;
  if (spec && !resolvesWithin(spec, SPEC_ARTIFACT_DIR)) spec = null;
  if ((!spec || !phaseArtifactExists(spec)) && state.spec_dir) {
    spec = findFile(state.spec_dir, "spec.md");
  }
  return spec && phaseArtifactExists(spec) ? spec : null;
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
      const spec = readableSpecArtifact(state);
      if (spec === null) return null;
      const markers = countMarkers(spec);
      if (markers > CLARIFY_THRESHOLD) {
        return { nextPhase: "clarify" as Phase, artifact: spec };
      }
      return { nextPhase: "architecture" as Phase, artifact: spec, skipClarify: true };
    })
    .with("clarify", () => {
      const spec = readableSpecArtifact(state);
      if (spec === null) return null;
      const markers = countMarkers(spec);
      if (markers > 0) return null; // All markers must be resolved before advancing
      return { nextPhase: "architecture" as Phase, artifact: spec };
    })
    .with("architecture", () => {
      // Try state.plan_file first, fall back to deriving plan path from spec_dir slug
      let plan = state.plan_file;
      if (plan && !resolvesWithin(plan, PLAN_ARTIFACT_DIR)) {
        // plan_file set but not in expected location — reject. Resolved
        // containment for the same reason as the spec branches: substring
        // containment carries `..` segments through unharmed.
        return null;
      }
      if (!plan || !phaseArtifactExists(plan)) {
        // plan_file not set or file missing — try deriving from spec_dir slug
        if (state.spec_dir) {
          const slug = state.spec_dir.split("/").pop() ?? "";
          if (slug) {
            const candidate = `.claude/plans/${slug}.md`;
            if (phaseArtifactExists(candidate)) plan = candidate;
          }
          // Final fallback: look for any plan matching the date prefix
          if (!plan || !phaseArtifactExists(plan)) {
            const datePrefix = slug.slice(0, 10); // "2026-05-18"
            if (datePrefix && phaseArtifactExists(".claude/plans")) {
              const files = readdirSync(".claude/plans").filter(
                (f: string) => f.startsWith(datePrefix) && f.endsWith(".md")
              );
              if (files.length === 1) plan = `.claude/plans/${files[0]}`;
            }
          }
        }
      }
      if (!plan || !phaseArtifactExists(plan)) return null;
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
  const parsedInput = parseSubagentStopStdin(stdin);
  if (!parsedInput.ok) {
    return {
      kind: "error",
      message: `advance-phase: invalid SubagentStop input — phase transition NOT evaluated: ${parsedInput.error}`,
    };
  }
  const input = parsedInput.value;

  const completedPhase = PHASE_AGENT_MAP[stripNamespace(resolveAgentType(input))];
  if (!completedPhase) return { kind: "passthrough" };

  let mgr: StateManager | null;
  try {
    mgr = StateManager.fromSession(input.session_id);
  } catch (error) {
    return passthroughDiagnostic(
      `advance-phase: session TaskGraph authority unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  if (!mgr) return { kind: "passthrough" };

  // Guard: skip if phase already advanced past this one
  const currentState = mgr.load();
  const currentIdx = PHASE_ORDER.indexOf(currentState.current_phase);
  const completedIdx = PHASE_ORDER.indexOf(completedPhase);
  if (completedIdx >= 0 && currentIdx > completedIdx) {
    return passthroughDiagnostic(`Phase ${completedPhase} already past (current: ${currentState.current_phase}), skipping.\n`);
  }

  // Extract artifacts from transcript before checking transition. Resolved,
  // not read off the payload: without the derived fallback a harness that
  // sends no `agent_transcript_path` records no spec_file/plan_file here and
  // leans entirely on the filesystem sweep further down.
  const transcriptPath = resolveAgentTranscriptPath(input);
  if (transcriptPath) {
    let transcriptContent: string;
    try {
      transcriptContent = readFileSync(transcriptPath, "utf-8");
    } catch (e) {
      return passthroughDiagnostic(`advance-phase: failed to read transcript at ${transcriptPath}: ${(e as Error).message}\n`);
    }
    const artifacts = parsePhaseArtifacts(transcriptContent, currentState.spec_dir);

    try {
      await mgr.update((s) => {
        const updates: { spec_file?: string | null; plan_file?: string | null } = {};

        // RESOLVED containment, not substring containment. These paths come
        // from an agent's transcript and become the authoritative
        // `spec_file`/`plan_file` every downstream phase transition reads, so
        // `String.includes(".claude/specs/")` was the wrong test: a path like
        // `.claude/specs/../../../../tmp/evil/spec.md` contains the substring
        // while resolving well outside the tree, and both this check and the
        // parser's used the same weak form.
        if (artifacts.spec_file && phaseArtifactExists(artifacts.spec_file)
            && resolvesWithin(artifacts.spec_file, SPEC_ARTIFACT_DIR)) {
          updates.spec_file = artifacts.spec_file;
        }
        if (!s.plan_file && artifacts.plan_file && phaseArtifactExists(artifacts.plan_file)
            && resolvesWithin(artifacts.plan_file, PLAN_ARTIFACT_DIR)) {
          updates.plan_file = artifacts.plan_file;
        }

        return Object.keys(updates).length > 0 ? { ...s, ...updates } : s;
      });
    } catch (e) {
      return passthroughDiagnostic(`advance-phase: failed to persist artifacts: ${(e as Error).message}\n`);
    }
  }

  // Reload after potential artifact writes
  const state = mgr.load();
  let transition: ReturnType<typeof resolveTransition>;
  try {
    transition = resolveTransition(completedPhase, state);
  } catch (error) {
    return passthroughDiagnostic(
      `advance-phase: phase artifact discovery failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  if (!transition) return { kind: "passthrough" };

  const { nextPhase, artifact, skipClarify } = transition;

  try {
    await mgr.update((s) => ({
      ...s,
      current_phase: nextPhase,
      phase_artifacts: { ...s.phase_artifacts, [completedPhase]: artifact },
      skipped_phases: skipClarify
        ? ([...new Set([...s.skipped_phases, "clarify" as Phase])] as Phase[])
        : s.skipped_phases,
      updated_at: new Date().toISOString(),
    }));
  } catch (e) {
    return passthroughDiagnostic(`advance-phase: failed to write phase transition: ${(e as Error).message}\n`);
  }

  process.stderr.write(`Phase advanced: ${completedPhase} → ${nextPhase}\n`);
  if (skipClarify) {
    process.stderr.write(`  (clarify auto-skipped: markers ≤ ${CLARIFY_THRESHOLD})\n`);
  }

  return { kind: "passthrough" };
};

export default handler;
