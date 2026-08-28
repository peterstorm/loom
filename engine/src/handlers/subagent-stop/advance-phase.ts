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
import type { HookHandler, HookResult, Phase, TaskGraph } from "../../types";
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

/** Count NEEDS CLARIFICATION markers; unreadable authority fails the transition. */
export function countMarkers(filePath: string): number {
  try {
    return (readFileSync(filePath, "utf-8").match(/NEEDS CLARIFICATION/g) ?? []).length;
  } catch (error) {
    throw new Error(
      `cannot read phase artifact ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
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

export type PhaseTransitionResolution =
  | Readonly<{ kind: "ready"; nextPhase: Phase; artifact: string; skipClarify?: boolean }>
  | Readonly<{ kind: "not-ready"; reason: string; nextPhase?: never; artifact?: never; skipClarify?: never }>;

const transitionReady = (
  nextPhase: Phase,
  artifact: string,
  skipClarify?: boolean,
): PhaseTransitionResolution => ({
  kind: "ready",
  nextPhase,
  artifact,
  ...(skipClarify === undefined ? {} : { skipClarify }),
});

const transitionNotReady = (reason: string): PhaseTransitionResolution => ({ kind: "not-ready", reason });

/** Exact phase capability check shared by every unlocked/locked observation. */
function phaseAuthorityRefusal(current: Phase, completed: Phase): HookResult | null {
  if (current === completed) return null;
  const currentIdx = PHASE_ORDER.indexOf(current);
  const completedIdx = PHASE_ORDER.indexOf(completed);
  return currentIdx > completedIdx
    ? passthroughDiagnostic(`Phase ${completed} already past (current: ${current}), skipping.\n`)
    : {
        kind: "error",
        message: `advance-phase: ${completed} result cannot advance current phase ${current}; exact phase authority required`,
      };
}

/** Determine the next phase or the exact artifact condition blocking it. */
export function resolveTransition(
  completedPhase: Phase,
  state: TaskGraph,
): PhaseTransitionResolution {
  return match(completedPhase)
    .with("brainstorm", () => {
      // Scope search to current run's spec_dir to avoid finding stale artifacts
      const searchDir = state.spec_dir ?? ".claude/specs";
      const file = findFile(searchDir, "brainstorm.md");
      if (!file) return transitionNotReady(`brainstorm.md was not found under ${searchDir}`);
      return transitionReady("specify", file);
    })
    .with("specify", () => {
      const spec = readableSpecArtifact(state);
      if (spec === null) {
        return transitionNotReady(`no readable spec.md is available inside ${SPEC_ARTIFACT_DIR}`);
      }
      const markers = countMarkers(spec);
      if (markers > CLARIFY_THRESHOLD) return transitionReady("clarify", spec);
      return transitionReady("architecture", spec, true);
    })
    .with("clarify", () => {
      const spec = readableSpecArtifact(state);
      if (spec === null) {
        return transitionNotReady(`no readable spec.md is available inside ${SPEC_ARTIFACT_DIR}`);
      }
      const markers = countMarkers(spec);
      if (markers > 0) {
        return transitionNotReady(`${markers} NEEDS CLARIFICATION marker(s) remain unresolved in ${spec}`);
      }
      return transitionReady("architecture", spec);
    })
    .with("architecture", () => {
      // Try state.plan_file first, fall back to deriving plan path from spec_dir slug
      let plan = state.plan_file;
      if (plan && !resolvesWithin(plan, PLAN_ARTIFACT_DIR)) {
        // plan_file set but not in expected location — reject. Resolved
        // containment for the same reason as the spec branches: substring
        // containment carries `..` segments through unharmed.
        return transitionNotReady(`plan_file ${plan} is outside ${PLAN_ARTIFACT_DIR}`);
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
      if (!plan || !phaseArtifactExists(plan)) {
        return transitionNotReady(`no readable plan artifact is available inside ${PLAN_ARTIFACT_DIR}`);
      }
      return state.skipped_phases.includes("plan-alignment")
        ? transitionReady("decompose", plan)
        : transitionReady("plan-alignment", plan);
    })
    .with("plan-alignment", () => {
      // Loop-back (re-running architecture) is orchestrator-driven via `set-phase` helper,
      // not handled in this hook. We only advance to decompose when the gap report exists.
      const specDir = state.spec_dir ?? ".claude/specs";
      const gapReport = findFile(specDir, "plan-alignment.md");
      if (!gapReport) {
        return transitionNotReady(`plan-alignment.md was not found under ${specDir}`);
      }
      return transitionReady("decompose", gapReport);
    })
    .with("decompose", () => {
      return transitionReady("execute", "task_graph");
    })
    .with("init", () => transitionNotReady("init has no completed phase transition"))
    .with("execute", () => transitionNotReady("execute is terminal and has no next phase"))
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
    return {
      kind: "error",
      message: `advance-phase: session TaskGraph authority unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!mgr) {
    return {
      kind: "error",
      message: `advance-phase: no TaskGraph authority for session ${JSON.stringify(input.session_id)}`,
    };
  }

  // The phase result is a capability for exactly one current phase. A stale
  // duplicate is a diagnosed no-op; a result from the future cannot skip work.
  let currentState: TaskGraph;
  try {
    currentState = mgr.load();
  } catch (error) {
    return {
      kind: "error",
      message: `advance-phase: failed to read TaskGraph authority: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const initialPhaseRefusal = phaseAuthorityRefusal(currentState.current_phase, completedPhase);
  if (initialPhaseRefusal !== null) return initialPhaseRefusal;

  // Extract artifacts from transcript before checking transition. Resolved,
  // not read off the payload: without the derived fallback a harness that
  // sends no `agent_transcript_path` records no spec_file/plan_file here and
  // leans entirely on the filesystem sweep further down.
  const transcriptPath = resolveAgentTranscriptPath(input);
  if (input.agent_transcript_path !== undefined && transcriptPath === null) {
    return {
      kind: "error",
      message: `advance-phase: supplied transcript is unavailable: ${input.agent_transcript_path}`,
    };
  }
  if (transcriptPath) {
    let artifacts: ReturnType<typeof parsePhaseArtifacts>;
    try {
      const transcriptContent = readFileSync(transcriptPath, "utf-8");
      artifacts = parsePhaseArtifacts(transcriptContent, currentState.spec_dir);
    } catch (e) {
      return {
        kind: "error",
        message: `advance-phase: failed to read or parse transcript at ${transcriptPath}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    let artifactPhaseRefusal: HookResult | null = null;
    try {
      await mgr.update((s) => {
        artifactPhaseRefusal = phaseAuthorityRefusal(s.current_phase, completedPhase);
        if (artifactPhaseRefusal !== null) return s;
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
      return {
        kind: "error",
        message: `advance-phase: failed to persist artifacts: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (artifactPhaseRefusal !== null) return artifactPhaseRefusal;
  }

  // Reload after potential artifact writes and prove the phase capability is
  // still current before doing artifact-dependent transition work.
  let state: TaskGraph;
  try {
    state = mgr.load();
  } catch (error) {
    return {
      kind: "error",
      message: `advance-phase: failed to reload TaskGraph authority: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const reloadedPhaseRefusal = phaseAuthorityRefusal(state.current_phase, completedPhase);
  if (reloadedPhaseRefusal !== null) return reloadedPhaseRefusal;

  let transition: ReturnType<typeof resolveTransition>;
  try {
    transition = resolveTransition(completedPhase, state);
  } catch (error) {
    return {
      kind: "error",
      message: `advance-phase: phase artifact discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (transition.kind === "not-ready") {
    return {
      kind: "error",
      message: `advance-phase: ${completedPhase} completed but phase transition is not ready: ${transition.reason}; phase NOT advanced`,
    };
  }

  const { nextPhase, artifact, skipClarify } = transition;

  let commitPhaseRefusal: HookResult | null = null;
  try {
    await mgr.update((s) => {
      commitPhaseRefusal = phaseAuthorityRefusal(s.current_phase, completedPhase);
      if (commitPhaseRefusal !== null) return s;
      return {
        ...s,
        current_phase: nextPhase,
        phase_artifacts: { ...s.phase_artifacts, [completedPhase]: artifact },
        skipped_phases: skipClarify
          ? ([...new Set([...s.skipped_phases, "clarify" as Phase])] as Phase[])
          : s.skipped_phases,
        updated_at: new Date().toISOString(),
      };
    });
  } catch (e) {
    return {
      kind: "error",
      message: `advance-phase: failed to write phase transition: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (commitPhaseRefusal !== null) return commitPhaseRefusal;

  process.stderr.write(`Phase advanced: ${completedPhase} → ${nextPhase}\n`);
  if (skipClarify) {
    process.stderr.write(`  (clarify auto-skipped: markers ≤ ${CLARIFY_THRESHOLD})\n`);
  }

  return { kind: "passthrough" };
};

export default handler;
