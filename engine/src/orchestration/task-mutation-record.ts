/**
 * The Task mutation check's runtime record and what a stop observes of it
 * (ADR-0071). Every effect that reads or writes the record lives here or in
 * the shared record file (`task-record-file.ts`), and nothing here decides:
 * the wire form and the digest are the check's pure core
 * (`core/task-mutation-check.ts`), the standing is the Task records' shared
 * rule (`core/task-record.ts`).
 *
 * - The record is the `task-mutation` Task record: one file per repository
 *   and Task in the runtime directory, keyed by Task and written atomically.
 * - `observeTaskMutationDigest` reads the bytes of every file the Task
 *   declares under the one absence rule, so an unreadable file can never pass
 *   for a deleted one.
 * - `observeTaskMutation` is what the stop shells hand `runStopChecks`.
 *
 * Total: every function returns its fault as data and none throws.
 */

import { subagentDir } from "../config";
import type { LoomCommands } from "../core/loom-cli-command";
import { success, type DomainResult } from "../core/orchestration-contract/identity";
import {
  parseTaskMutationRecord,
  taskMutationDigest,
  taskMutationRecordJson,
  type OwedTaskMutation,
  type RecordedTaskMutation,
  type TaskMutationObservation,
  type TaskMutationRecord,
} from "../core/task-mutation-check";
import { taskRecordStanding, type TaskRecordDigest } from "../core/task-record";
import type { CanonicalRepositoryRoot } from "../utils/workspace-digest";
import { observeDeclaredFiles, readTaskRecord, taskRecordPath, writeTaskRecordFile } from "./task-record-file";

/** Where the record of `taskId` in the repository at `root` is kept. */
export function taskMutationRecordPath(root: CanonicalRepositoryRoot, taskId: string, directory: string = subagentDir()): string {
  return taskRecordPath("task-mutation", root, taskId, directory);
}

/** The record a Task's last run left, `not-run` when there is none, or why the file cannot be read as a record. */
export function readTaskMutationRecord(
  root: CanonicalRepositoryRoot,
  taskId: string,
  directory: string = subagentDir(),
): DomainResult<TaskMutationRecord, string> {
  return readTaskRecord(taskMutationRecordPath(root, taskId, directory), parseTaskMutationRecord);
}

/** Keep `record`, replacing the Task's earlier one. Atomic: a stop never reads half a record. The path written, or why not. */
export function writeTaskMutationRecord(
  root: CanonicalRepositoryRoot,
  record: RecordedTaskMutation,
  directory: string = subagentDir(),
): DomainResult<string, string> {
  return writeTaskRecordFile(taskMutationRecordPath(root, record.taskId, directory), taskMutationRecordJson(record), directory);
}

/** The digest of the Task's base and declared files as they are beneath `root` now. */
export function observeTaskMutationDigest(root: CanonicalRepositoryRoot, duty: OwedTaskMutation): DomainResult<TaskRecordDigest, string> {
  const files = observeDeclaredFiles(root, duty.declared);
  return files.ok ? success(taskMutationDigest(duty.startSha, files.value)) : files;
}

/**
 * The stop shells' observation of one Task that owes the check: how its
 * record stands against its files now, with the command that refreshes it
 * (`commands.mutationCheck`). A digest or a record that cannot be read is
 * `unavailable`, which never blocks.
 */
export function observeTaskMutation(
  commands: Pick<LoomCommands, "mutationCheck">,
  directory: () => string = subagentDir,
): (duty: OwedTaskMutation, root: CanonicalRepositoryRoot) => TaskMutationObservation {
  return (duty, root) => {
    const digest = observeTaskMutationDigest(root, duty);
    if (!digest.ok) return Object.freeze({ kind: "unavailable", reason: `its files could not be digested: ${digest.error}` });
    const record = readTaskMutationRecord(root, duty.taskId, directory());
    if (!record.ok) return Object.freeze({ kind: "unavailable", reason: `its record is unreadable: ${record.error}` });
    return Object.freeze({
      kind: "observed",
      standing: taskRecordStanding(record.value, duty.taskId, digest.value),
      command: commands.mutationCheck(duty.taskId),
    });
  };
}
