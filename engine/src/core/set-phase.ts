/**
 * The `set-phase` loop-back (issue #50): an operator moves `current_phase` back
 * to an earlier Phase, optionally dropping one Phase's recorded artifact.
 *
 * `execute` is not a target. `populate-task-graph` is the only writer of
 * `execute`, because it installs the approved Tasks in the same locked write
 * (#73); a loop-back that wrote `execute` itself would recreate the
 * execute-with-no-Tasks graph #50 reported. The parsed request's type
 * excludes `execute`, so no caller can apply that target.
 */

import { PHASES, type Phase } from "./phases";
import type { TaskGraph } from "../types";
import { failure, success, type DomainResult } from "./orchestration-contract/identity";

/** A Phase `set-phase` may write: every Phase but `execute`. */
export type LoopBackPhase = Exclude<Phase, "execute">;

export type SetPhaseRequest = Readonly<{ phase: LoopBackPhase; clearArtifact: Phase | null }>;

/** Why `set-phase` never writes `execute`, and what installs it instead. */
export const EXECUTE_IS_POPULATION_ONLY =
  "set-phase cannot enter execute: populate-task-graph is the only writer of execute, because it installs the " +
  "approved Tasks in the same write. Pipe the approved decompose output to `helper populate-task-graph` instead";

const isPhase = (value: string): value is Phase => (PHASES as readonly string[]).includes(value);

/** `--phase <phase> [--clear-artifact <phase>]` as a request, or why it is not one. */
export function parseSetPhaseArgs(args: readonly string[]): DomainResult<SetPhaseRequest, string> {
  let phase: string | null = null;
  let clearArtifact: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--phase" && args[i + 1]) phase = args[++i]!;
    else if (args[i] === "--clear-artifact" && args[i + 1]) clearArtifact = args[++i]!;
  }
  if (phase === null || !isPhase(phase)) {
    return failure(`Invalid or missing --phase. Valid: ${PHASES.join(", ")}`);
  }
  if (phase === "execute") return failure(EXECUTE_IS_POPULATION_ONLY);
  if (clearArtifact !== null && !isPhase(clearArtifact)) {
    return failure(`Invalid --clear-artifact. Valid: ${PHASES.join(", ")}`);
  }
  return success({ phase, clearArtifact });
}

/** The graph at the requested Phase, without the cleared artifact when one is named. */
export function applySetPhase(state: TaskGraph, request: SetPhaseRequest, updatedAt: string): TaskGraph {
  const { clearArtifact } = request;
  const phaseArtifacts = clearArtifact === null
    ? state.phase_artifacts
    : (({ [clearArtifact]: _cleared, ...rest }) => rest)(state.phase_artifacts);
  return { ...state, current_phase: request.phase, phase_artifacts: phaseArtifacts, updated_at: updatedAt };
}
