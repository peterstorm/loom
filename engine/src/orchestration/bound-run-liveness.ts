/**
 * Shell: observe whether the run one Session Run Binding names is still open.
 *
 * Every read is synchronous, because the SessionStart sweep that asks runs
 * synchronously in Pi. The decision itself is the pure `runLiveness`; this
 * module only reads the files it decides from, and keeps three answers apart:
 *   - `absent`: the Run Directory is gone, so the binding names nothing a hook
 *     could still resolve;
 *   - `observed`: the files were read and judged;
 *   - `unreadable`: something is there but cannot be read, which the sweep
 *     treats as possibly open and reports.
 */

import { runLiveness, type RunLiveness } from "../core/run-liveness";
import { inspectRunDirectoryEntry, openRegisteredRunDirectory, readCheckpointNow } from "./run-directory-handle";
import type { SessionRunBinding } from "./session-run-bindings";

export type BoundRunObservation =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "observed"; liveness: RunLiveness }>
  | Readonly<{ kind: "unreadable"; cause: string }>;

/** The program and checkpoint bound every other whole-file reader of a run uses. */
const RUN_FILE_READ_LIMIT = 16_777_216;

const ABSENT: BoundRunObservation = Object.freeze({ kind: "absent" });
const unreadable = (cause: string): BoundRunObservation => Object.freeze({ kind: "unreadable", cause });
const observed = (liveness: RunLiveness): BoundRunObservation => Object.freeze({ kind: "observed", liveness });

/** A checkpoint's parsed JSON, or the reason it cannot be read as JSON. */
function parsedCheckpoint(text: string | null): Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; cause: string }> {
  if (text === null) return { ok: true, value: null };
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, cause: `run checkpoint is invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function observeBoundRun(binding: SessionRunBinding): BoundRunObservation {
  const unread = { resultPublished: false, abandoned: false, registration: null, checkpoint: null } as const;
  // A recorded result digest is the run's own proof of its end; nothing to read.
  if (binding.resultDigest !== null) return observed(runLiveness({ ...unread, resultPublished: true }));
  const entry = inspectRunDirectoryEntry(binding.runsRoot, binding.runDirectory);
  if (!entry.ok) return unreadable(entry.error.message);
  if (entry.value.kind === "absent") return ABSENT;
  if (entry.value.kind === "occupied") {
    return unreadable(`run directory entry ${binding.runDirectory} is a ${entry.value.entryKind}, not a directory`);
  }
  const handle = openRegisteredRunDirectory(binding.runsRoot, binding.runDirectory);
  if (!handle.ok) return unreadable(handle.error.message);
  const abandonment = handle.value.readAbandonment();
  if (!abandonment.ok) return unreadable(abandonment.error.message);
  if (abandonment.value !== null) return observed(runLiveness({ ...unread, abandoned: true }));
  const registration = handle.value.readProgramRegistration(RUN_FILE_READ_LIMIT);
  if (!registration.ok) return unreadable(registration.error.message);
  const checkpointText = readCheckpointNow(handle.value, RUN_FILE_READ_LIMIT);
  if (!checkpointText.ok) return unreadable(checkpointText.error.message);
  const checkpoint = parsedCheckpoint(checkpointText.value);
  if (!checkpoint.ok) return unreadable(checkpoint.cause);
  return observed(runLiveness({ ...unread, registration: registration.value, checkpoint: checkpoint.value }));
}
