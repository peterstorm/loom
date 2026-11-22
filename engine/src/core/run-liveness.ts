/**
 * Whether an orchestration run bound to a session can still advance.
 *
 * A Session Run Binding is authority only while its run can still advance:
 * the run's subagent hooks resolve their issuing run through it, and the run's
 * `done` action records its result into it. So the SessionStart sweep keeps a
 * session whose binding names an open run past the idle TTL, as it keeps a
 * session bound to a TaskGraph that still exists. This module decides "open"
 * from facts the shell already read off the binding and the Run Directory; it
 * reads nothing.
 *
 * A run is finished only when its own files prove it: it was abandoned, its
 * binding recorded its published result, or its checkpoint holds one of its
 * program's terminal states. Every other reading is open: the panel programs,
 * whose end lives in their journal rather than a checkpoint, a program this
 * build does not know, and a run not yet registered. Keeping a session too
 * long costs a few kilobytes; releasing it early loses its subagents' captures.
 * The sweep bounds how long an open run can keep its session
 * (`OPEN_RUN_GRACE_MS`), so a run nobody finishes or abandons cannot keep it
 * forever.
 */

import { match } from "ts-pattern";
import { checkpointStateName, inspectableProgramOf, type InspectableProgram } from "./run-inspection";

/**
 * What the shell read off one binding and its Run Directory, as the first
 * proof it found, in the order a run proves its end. Each arm carries only
 * what was read, so no observation holds two proofs at once.
 */
export type RunLivenessObservation =
  /** The binding carries the run's published `result.json` digest; nothing else was read. */
  | Readonly<{ kind: "result-published" }>
  /** An `abandoned.json` marker is present: abandonment is terminal. */
  | Readonly<{ kind: "abandoned" }>
  /**
   * Neither: the parsed `program.json` (null when no program was registered)
   * and the parsed `checkpoint.json` (null when none was written).
   */
  | Readonly<{ kind: "run-files"; registration: unknown; checkpoint: unknown }>;

export type RunFinish = "result-published" | "abandoned" | "terminal-state";

export type RunLiveness =
  | Readonly<{ kind: "open" }>
  | Readonly<{ kind: "finished"; because: RunFinish }>;

/**
 * Each program's terminal checkpoint states, read through
 * `checkpointStateName`. A blocked run its operator may still resume
 * (`recoverable-blocked`) is open; it ends when it is resumed to `done` or
 * abandoned (`orchestration abandon --superseded-by`). The architecture and
 * refutation panels keep their state in the event journal and write no
 * checkpoint, so no checkpoint state ends them. Frozen through every list:
 * what ends a run decides what the sweep deletes, so no caller may add to it.
 */
export const TERMINAL_CHECKPOINT_STATES: Readonly<Record<InspectableProgram, readonly string[]>> = Object.freeze({
  "standalone-review": Object.freeze(["done", "terminal-blocked"]),
  "standalone-disposition": Object.freeze(["done"]),
  "remediation": Object.freeze(["done"]),
  "wave-gate": Object.freeze(["wave-gate-done", "wave-gate-retired"]),
  "architecture": Object.freeze([]),
  "refutation": Object.freeze([]),
});

const OPEN: RunLiveness = Object.freeze({ kind: "open" });
const finished = (because: RunFinish): RunLiveness => Object.freeze({ kind: "finished", because });

/** A run with neither a published result nor an abandonment: finished only by a terminal checkpoint state. */
function runFilesLiveness(registration: unknown, checkpoint: unknown): RunLiveness {
  const program = inspectableProgramOf(registration);
  if (program === null) return OPEN;
  const state = checkpointStateName(program, checkpoint);
  return state !== null && TERMINAL_CHECKPOINT_STATES[program].includes(state) ? finished("terminal-state") : OPEN;
}

/** Pure and total: whether the observed run can still advance. */
export function runLiveness(observation: RunLivenessObservation): RunLiveness {
  return match(observation)
    .with({ kind: "result-published" }, () => finished("result-published"))
    .with({ kind: "abandoned" }, () => finished("abandoned"))
    .with({ kind: "run-files" }, ({ registration, checkpoint }) => runFilesLiveness(registration, checkpoint))
    .exhaustive();
}
