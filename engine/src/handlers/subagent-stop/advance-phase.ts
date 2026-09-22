/**
 * Advance current_phase when phase agents complete.
 * Extracts and stores phase artifacts from transcript.
 *
 * Canonical phase-agent chain (happy path; transitions may skip stages per
 * config.VALID_TRANSITIONS — types.ts PHASES is the authoritative order,
 * which includes init as the first phase).
 */

import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { match } from "ts-pattern";
import type { HookHandler, HookResult, Phase, TaskGraph } from "../../types";
import { PHASE_AGENT_MAP, PHASE_ORDER, CLARIFY_THRESHOLD, observeTaskGraphProjectBoundary } from "../../config";
import { StateManager } from "../../state-manager";
import { parsePhaseArtifacts } from "../../parsers/parse-phase-artifacts";
import { parseSubagentStopStdin } from "../../parsers/parse-subagent-stop-input";
import { stripNamespace } from "../../utils/strip-namespace";
import { findFile } from "../../utils/find-file";
import { resolveAgentTranscriptPath, resolveAgentType } from "../../utils/agent-transcript-path";
import {
  PLAN_ARTIFACT_DIR,
  classifyPhaseArtifact,
  parseSpecArtifactDirectory,
  projectRootForStateFile,
  resolvesWithin,
  type SpecArtifactDirectory,
} from "../../core/phase-artifact-paths";
import { passthroughDiagnostic } from "../../utils/hook-diagnostic";
import { readRunBytesNoFollow } from "../../orchestration/no-follow-fs";

// Re-exported because this module's own containment rule moved to the pure core
// so the Pi shell could share it verbatim; the name stays importable from here.
export { resolvesWithin, projectRootForStateFile };

/**
 * Resolve a stored artifact path against the boundary that owns the TaskGraph.
 *
 * Artifacts are stored project-relative; the probe base is the project root
 * derived from the graph's own location (`projectRootForStateFile`), never
 * `process.cwd()` — the orchestrator may be rooted in a different checkout
 * than the run it advances. Absolute paths (test fixtures, session-pointer
 * targets) pass through untouched.
 */
function withinBoundary(path: string, baseDir: string): string {
  return isAbsolute(path) ? path : join(baseDir, path);
}

/** ENOENT is absence and a directory is not a document; every other
 * readability failure reaches the diagnostic boundary. The anchored reader
 * rejects leaf and ancestor symlinks, so lexical containment cannot import
 * bytes from outside the project boundary. */
function phaseArtifactExists(path: string, baseDir: string): boolean {
  try {
    readRunBytesNoFollow(withinBoundary(path, baseDir));
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return false;
    throw new Error(
      `cannot access phase artifact ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** Count NEEDS CLARIFICATION markers; unreadable authority fails the transition.
 *
 * `baseDir` is REQUIRED: the artifact is probed against the project boundary
 * that owns the TaskGraph, never the caller's ambient cwd — an optional base
 * here silently reintroduces the cross-checkout drift this seam was built to
 * close. The only cwd default in the module lives on the documented
 * compatibility shell `resolveTransition`. */
export function countMarkers(filePath: string, baseDir: string): number {
  try {
    return (readRunBytesNoFollow(withinBoundary(filePath, baseDir)).toString("utf-8")
      .match(/NEEDS CLARIFICATION/g) ?? []).length;
  } catch (error) {
    throw new Error(
      `cannot read phase artifact ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/** The two outcomes `readableSpecArtifact` can produce. The declared set
 *  equals the produced set — the helper never returns a full ready
 *  transition — so the specify/clarify call sites narrow on the union's own
 *  `kind` discriminant instead of a typeof convention. */
type ReadableSpecArtifact =
  | Readonly<{ kind: "ready"; artifact: string }>
  | Readonly<{ kind: "not-ready"; reason: string }>;

function readableSpecArtifact(
  state: TaskGraph,
  specDir: SpecArtifactDirectory,
  baseDir: string,
): ReadableSpecArtifact {
  const recorded = state.spec_file;
  if (recorded !== null) {
    if (!resolvesWithin(recorded, specDir, baseDir)) {
      return transitionNotReady(`spec_file ${recorded} is outside run spec_dir ${specDir}`);
    }
    return phaseArtifactExists(recorded, baseDir)
      ? { kind: "ready", artifact: recorded }
      : transitionNotReady(`recorded spec_file ${recorded} is not readable`);
  }
  const discovered = discoverArtifactWithin(specDir, "spec.md", baseDir);
  return discovered !== null && phaseArtifactExists(discovered, baseDir)
    ? { kind: "ready", artifact: discovered }
    : transitionNotReady(`no readable spec.md is available inside ${specDir}`);
}

/**
 * Find an artifact under `specDir` and return it in the form it is STORED in.
 *
 * A relative `specDir` is boundary-joined and the found path is re-relativized
 * against the boundary, so the stored form stays canonical project-relative.
 * An absolute `specDir` is searched directly and the absolute hit is returned,
 * exactly as the pre-boundary behavior did — `join` would otherwise splice a
 * relative base onto an absolute path and search a directory that does not
 * exist.
 */
function discoverArtifactWithin(
  specDir: string,
  filename: string,
  baseDir: string,
): string | null {
  const found = findFile(withinBoundary(specDir, baseDir), filename);
  if (found === null) return null;
  return isAbsolute(specDir) ? found : relative(baseDir, found);
}

/** Resolve the Plan artifact for the architecture arm: recorded authority
 * first, then the canonical slug path, then an exact-one date-prefix fallback.
 * Every candidate must be a readable regular file and all containment is
 * resolved against the TaskGraph Project Boundary. */
function resolvePlanArtifact(
  state: Pick<TaskGraph, "plan_file" | "spec_dir">,
  baseDir: string,
): ReadableSpecArtifact {
  const recorded = state.plan_file;
  if (recorded && !resolvesWithin(recorded, PLAN_ARTIFACT_DIR, baseDir)) {
    return transitionNotReady(`plan_file ${recorded} is outside ${PLAN_ARTIFACT_DIR}`);
  }
  if (recorded !== null && recorded !== "" && phaseArtifactExists(recorded, baseDir)) {
    return { kind: "ready", artifact: recorded };
  }
  const fallback = derivedPlanCandidate(state.spec_dir, baseDir);
  if (fallback.kind === "ambiguous") {
    return transitionNotReady(
      `multiple readable plan artifacts match ${fallback.datePrefix} inside ${PLAN_ARTIFACT_DIR}; ` +
      "set plan_file or remove the extra candidates",
    );
  }
  return fallback.kind === "candidate"
    ? { kind: "ready", artifact: fallback.path }
    : transitionNotReady(`no readable plan artifact is available inside ${PLAN_ARTIFACT_DIR}`);
}

type DerivedPlanCandidate =
  | Readonly<{ kind: "candidate"; path: string }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "ambiguous"; datePrefix: string }>;

/** Resolve the documented fallback without guessing: zero valid candidates is
 * unavailable, one is authority, and multiple remain an explicit ambiguity. */
function derivedPlanCandidate(
  specDir: string | null | undefined,
  baseDir: string,
): DerivedPlanCandidate {
  const slug = !specDir ? "" : (specDir.split("/").pop() ?? "");
  const bySlug = slug === "" ? null : `.claude/plans/${slug}.md`;
  if (bySlug !== null && phaseArtifactExists(bySlug, baseDir)) {
    return Object.freeze({ kind: "candidate", path: bySlug });
  }
  const datePrefix = slug.slice(0, 10);
  if (datePrefix === "") return Object.freeze({ kind: "unavailable" });
  let names: string[];
  try {
    names = readdirSync(join(baseDir, ".claude", "plans"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.freeze({ kind: "unavailable" });
    throw error;
  }
  const candidates = names
    .filter((name) => name.startsWith(datePrefix) && name.endsWith(".md"))
    .map((name) => `.claude/plans/${name}`)
    .filter((path) => phaseArtifactExists(path, baseDir));
  if (candidates.length === 0) return Object.freeze({ kind: "unavailable" });
  return candidates.length === 1
    ? Object.freeze({ kind: "candidate", path: candidates[0]! })
    : Object.freeze({ kind: "ambiguous", datePrefix });
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

/**
 * An exact current-Phase completion is always eligible, including `init` for
 * compatibility callers. The first brainstorm result may additionally
 * bootstrap `init`; every other result must match the active Phase exactly.
 */
export function isPhaseResultEligible(
  currentPhase: Phase,
  completedPhase: Phase,
): boolean {
  return currentPhase === completedPhase ||
    (currentPhase === "init" && completedPhase === "brainstorm");
}

type ReadyPhaseTransition = Readonly<
  Omit<Extract<PhaseTransitionResolution, { kind: "ready" }>, "kind">
>;

/** Pure locked-state command: apply a ready transition only while eligible. */
export function applyEligiblePhaseTransition(
  state: TaskGraph,
  completedPhase: Phase,
  transition: ReadyPhaseTransition,
  updatedAt: string,
): TaskGraph {
  if (!isPhaseResultEligible(state.current_phase, completedPhase)) return state;
  return {
    ...state,
    current_phase: transition.nextPhase,
    ...(completedPhase === "architecture" ? { plan_file: transition.artifact } : {}),
    phase_artifacts: {
      ...state.phase_artifacts,
      [completedPhase]: transition.artifact,
    },
    skipped_phases: transition.skipClarify
      ? ([...new Set([...state.skipped_phases, "clarify" as Phase])] as Phase[])
      : state.skipped_phases,
    updated_at: updatedAt,
  };
}

type PhaseTransitionAuthority = Readonly<{
  currentPhase: Phase;
  specDir: string | null;
  specFile: string | null;
  planFile: string | null;
  skippedPhases: readonly Phase[];
}>;

export type PhaseTransitionObservation = Readonly<{
  authority: PhaseTransitionAuthority;
  resolution: PhaseTransitionResolution;
}>;

function transitionAuthority(state: TaskGraph): PhaseTransitionAuthority {
  return Object.freeze({
    currentPhase: state.current_phase,
    specDir: state.spec_dir ?? null,
    specFile: state.spec_file,
    planFile: state.plan_file,
    skippedPhases: Object.freeze([...state.skipped_phases]),
  });
}

/** Pure exact authority recheck used inside the TaskGraph lock. */
export function transitionAuthorityMatches(
  state: TaskGraph,
  authority: PhaseTransitionAuthority,
): boolean {
  return state.current_phase === authority.currentPhase &&
    (state.spec_dir ?? null) === authority.specDir &&
    state.spec_file === authority.specFile &&
    state.plan_file === authority.planFile &&
    state.skipped_phases.length === authority.skippedPhases.length &&
    state.skipped_phases.every((phase, index) => phase === authority.skippedPhases[index]);
}

/** Exact phase capability check shared by every unlocked/locked observation. */
function phaseAuthorityRefusal(current: Phase, completed: Phase): HookResult | null {
  if (isPhaseResultEligible(current, completed)) return null;
  const currentIdx = PHASE_ORDER.indexOf(current);
  const completedIdx = PHASE_ORDER.indexOf(completed);
  return currentIdx > completedIdx
    ? passthroughDiagnostic(`Phase ${completed} already past (current: ${current}), skipping.\n`)
    : {
        kind: "error",
        message: `advance-phase: ${completed} result cannot advance current phase ${current}; exact phase authority required`,
      };
}

/** Imperative-shell observation of phase artifacts. Never call under the TaskGraph lock.
 *
 * `baseDir` is REQUIRED — the project boundary every relative artifact path is
 * probed against: production callers pass the root derived from the TaskGraph's
 * own location (`projectRootForStateFile`), because the runtime's cwd may be a
 * different checkout than the run being advanced. Requiring the argument makes
 * the omission a compile error instead of a silent cross-checkout drift; the
 * historical cwd anchoring survives only on the compatibility shell
 * `resolveTransition`, whose default documents itself as such.
 */
export function observePhaseTransition(
  completedPhase: Phase,
  state: TaskGraph,
  specDir: SpecArtifactDirectory,
  baseDir: string,
): PhaseTransitionObservation {
  const resolution = match(completedPhase)
    .with("brainstorm", () => {
      // The parser supplies the current run directory, or the legacy root fallback.
      const file = discoverArtifactWithin(specDir, "brainstorm.md", baseDir);
      if (!file) return transitionNotReady(`brainstorm.md was not found under ${specDir}`);
      return transitionReady("specify", file);
    })
    .with("specify", () => {
      const spec = readableSpecArtifact(state, specDir, baseDir);
      if (spec.kind === "not-ready") return spec;
      const markers = countMarkers(spec.artifact, baseDir);
      if (markers > CLARIFY_THRESHOLD) return transitionReady("clarify", spec.artifact);
      return transitionReady("architecture", spec.artifact, true);
    })
    .with("clarify", () => {
      const spec = readableSpecArtifact(state, specDir, baseDir);
      if (spec.kind === "not-ready") return spec;
      const markers = countMarkers(spec.artifact, baseDir);
      if (markers > 0) {
        return transitionNotReady(`${markers} NEEDS CLARIFICATION marker(s) remain unresolved in ${spec.artifact}`);
      }
      return transitionReady("architecture", spec.artifact);
    })
    .with("architecture", () => {
      const plan = resolvePlanArtifact(state, baseDir);
      if (plan.kind === "not-ready") return plan;
      return state.skipped_phases.includes("plan-alignment")
        ? transitionReady("decompose", plan.artifact)
        : transitionReady("plan-alignment", plan.artifact);
    })
    .with("plan-alignment", () => {
      // Loop-back (re-running architecture) is orchestrator-driven via `set-phase` helper,
      // not handled in this hook. We only advance to decompose when the gap report exists.
      const gapReport = discoverArtifactWithin(specDir, "plan-alignment.md", baseDir);
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
  return Object.freeze({ authority: transitionAuthority(state), resolution });
}

/** Compatibility shell for direct callers: parse scope, then observe.
 *  This is the module's ONLY cwd default — production callers observe through
 *  `observePhaseTransition` with an explicit graph-derived base (required
 *  there), so a harness adapter cannot reintroduce the worktree/cwd-drift
 *  failure by omission. */
export function resolveTransition(
  completedPhase: Phase,
  state: TaskGraph,
  baseDir: string = process.cwd(),
): PhaseTransitionResolution {
  const parsedSpecDir = parseSpecArtifactDirectory(state.spec_dir);
  return parsedSpecDir.ok
    ? observePhaseTransition(completedPhase, state, parsedSpecDir.value, baseDir).resolution
    : transitionNotReady(parsedSpecDir.message);
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
  // Every relative artifact path is probed against the project root that owns
  // this TaskGraph, not process.cwd(): the runtime's cwd may be a different
  // checkout (a parent session in the main checkout advancing a worktree run).
  const artifactBaseDir = observeTaskGraphProjectBoundary(mgr.getPath()).root;
  const initialSpecDir = parseSpecArtifactDirectory(currentState.spec_dir);
  if (!initialSpecDir.ok) {
    return { kind: "error", message: `advance-phase: ${initialSpecDir.message}; phase NOT advanced` };
  }

  // Extract artifacts from transcript before checking transition. Resolved,
  // not read off the payload: without the derived fallback a harness that
  // sends no `agent_transcript_path` records no spec_file/plan_file here and
  // leans entirely on the filesystem sweep further down.
  const transcriptPath = resolveAgentTranscriptPath(input);
  if (input.agent_transcript_path?.trim() && transcriptPath === null) {
    return {
      kind: "error",
      message: `advance-phase: supplied transcript is unavailable: ${input.agent_transcript_path}`,
    };
  }
  if (transcriptPath) {
    let artifacts: ReturnType<typeof parsePhaseArtifacts>;
    try {
      const transcriptContent = readFileSync(transcriptPath, "utf-8");
      artifacts = parsePhaseArtifacts(transcriptContent, initialSpecDir.value);
    } catch (e) {
      return {
        kind: "error",
        message: `advance-phase: failed to read or parse transcript at ${transcriptPath}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // Observe candidate artifact readability before taking the TaskGraph lock.
    // Classification precedes every probe, so an out-of-scope path is never stat'd.
    const updates: { spec_file?: string; plan_file?: string } = {};
    try {
      if (artifacts.spec_file &&
          classifyPhaseArtifact(artifacts.spec_file, initialSpecDir.value, artifactBaseDir) === "spec" &&
          phaseArtifactExists(artifacts.spec_file, artifactBaseDir)) {
        updates.spec_file = artifacts.spec_file;
      }
      if (currentState.plan_file === null && artifacts.plan_file &&
          classifyPhaseArtifact(artifacts.plan_file, initialSpecDir.value, artifactBaseDir) === "plan" &&
          phaseArtifactExists(artifacts.plan_file, artifactBaseDir)) {
        updates.plan_file = artifacts.plan_file;
      }
    } catch (e) {
      return {
        kind: "error",
        message: `advance-phase: failed to observe phase artifacts: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const artifactAuthority = transitionAuthority(currentState);
    let artifactPhaseRefusal: HookResult | null = null;
    try {
      await mgr.update((s) => {
        artifactPhaseRefusal = phaseAuthorityRefusal(s.current_phase, completedPhase);
        if (artifactPhaseRefusal !== null) return s;
        if (!transitionAuthorityMatches(s, artifactAuthority)) {
          artifactPhaseRefusal = {
            kind: "error",
            message: "advance-phase: TaskGraph artifact authority changed before persistence; phase artifacts NOT stored",
          };
          return s;
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
  const specDir = parseSpecArtifactDirectory(state.spec_dir);
  if (!specDir.ok) {
    return { kind: "error", message: `advance-phase: ${specDir.message}; phase NOT advanced` };
  }

  let observation: PhaseTransitionObservation;
  try {
    observation = observePhaseTransition(completedPhase, state, specDir.value, artifactBaseDir);
  } catch (error) {
    return {
      kind: "error",
      message: `advance-phase: phase artifact discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (observation.resolution.kind === "not-ready") {
    return {
      kind: "error",
      message: `advance-phase: ${completedPhase} completed but phase transition is not ready: ${observation.resolution.reason}; phase NOT advanced`,
    };
  }

  type LockedTransitionOutcome =
    | PhaseTransitionResolution
    | Readonly<{ kind: "refused"; result: HookResult }>;

  let lockedOutcome: LockedTransitionOutcome;
  try {
    lockedOutcome = await mgr.updateAndReturn<LockedTransitionOutcome>((s) => {
      const refusal = phaseAuthorityRefusal(s.current_phase, completedPhase);
      if (refusal !== null) return { state: s, value: { kind: "refused", result: refusal } };

      // Filesystem observation happened before the lock. Commit only when the
      // locked TaskGraph still names that exact phase/artifact authority.
      if (!transitionAuthorityMatches(s, observation.authority)) {
        return {
          state: s,
          value: transitionNotReady("TaskGraph phase artifact authority changed after filesystem observation"),
        };
      }
      const lockedTransition = observation.resolution;
      if (lockedTransition.kind === "not-ready") return { state: s, value: lockedTransition };
      return {
        state: applyEligiblePhaseTransition(
          s,
          completedPhase,
          lockedTransition,
          new Date().toISOString(),
        ),
        value: lockedTransition,
      };
    });
  } catch (e) {
    return {
      kind: "error",
      message: `advance-phase: failed to write phase transition: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (lockedOutcome.kind === "refused") return lockedOutcome.result;
  if (lockedOutcome.kind === "not-ready") {
    return {
      kind: "error",
      message: `advance-phase: ${completedPhase} completed but locked phase transition is not ready: ${lockedOutcome.reason}; phase NOT advanced`,
    };
  }

  process.stderr.write(`Phase advanced: ${completedPhase} → ${lockedOutcome.nextPhase}\n`);
  if (lockedOutcome.skipClarify) {
    process.stderr.write(`  (clarify auto-skipped: markers ≤ ${CLARIFY_THRESHOLD})\n`);
  }

  return { kind: "passthrough" };
};

export default handler;
