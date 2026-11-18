/**
 * The Task owner check's runtime record and what a stop observes of it
 * (ADR-0092). Every effect that reads or writes the record lives here or in
 * the shared record file (`task-record-file.ts`), and nothing here decides:
 * the duty, the wire form, the digest and the standing are the pure core's
 * (`core/task-owner-check.ts`).
 *
 * - The record is the `task-owner-check` Task record, beside the Task
 *   mutation record: one file per repository and Task, keyed by Task and
 *   written atomically.
 * - `observeTaskOwnerCheckDigest` reads the bytes of every family input the
 *   duty names (`OwedTaskOwnerCheck.digested`) under the one absence rule.
 * - `observeTaskOwnerCheck` is what the stop shells hand `runStopChecks`. The
 *   stop imports no worktree or runner code.
 *
 * Total: every function returns its fault as data and none throws.
 */

import { subagentDir } from "../config";
import type { LoomCommands } from "../core/loom-cli-command";
import { failure, success, type DomainResult } from "../core/orchestration-contract/identity";
import {
  parseTaskOwnerCheckRecord,
  TASK_OWNER_CHECK_NOT_RUN,
  taskOwnerCheckDigest,
  taskOwnerCheckRecordJson,
  taskOwnerCheckStanding,
  type OwedTaskOwnerCheck,
  type RecordedTaskOwnerCheck,
  type TaskOwnerCheckDigest,
  type TaskOwnerCheckObservation,
  type TaskOwnerCheckRecord,
} from "../core/task-owner-check";
import type { CanonicalRepositoryRoot } from "../utils/workspace-digest";
import { observeDeclaredFiles, readTaskRecordJson, taskRecordPath, writeTaskRecordFile } from "./task-record-file";

/** Where the owner-check record of `taskId` in the repository at `root` is kept. */
export function taskOwnerCheckRecordPath(root: CanonicalRepositoryRoot, taskId: string, directory: string = subagentDir()): string {
  return taskRecordPath("task-owner-check", root, taskId, directory);
}

/** The record a Task's last owner-check run left, `not-run` when there is none, or why the file cannot be read as a record. */
export function readTaskOwnerCheckRecord(
  root: CanonicalRepositoryRoot,
  taskId: string,
  directory: string = subagentDir(),
): DomainResult<TaskOwnerCheckRecord, string> {
  const path = taskOwnerCheckRecordPath(root, taskId, directory);
  const read = readTaskRecordJson(path);
  if (!read.ok) return read;
  if (read.value.kind === "absent") return success(TASK_OWNER_CHECK_NOT_RUN);
  const parsed = parseTaskOwnerCheckRecord(read.value.raw);
  return parsed.ok ? parsed : failure(`${path}: ${parsed.error}`);
}

/** Keep `record`, replacing the Task's earlier one, atomically. The path written, or why not. */
export function writeTaskOwnerCheckRecord(
  root: CanonicalRepositoryRoot,
  record: RecordedTaskOwnerCheck,
  directory: string = subagentDir(),
): DomainResult<string, string> {
  return writeTaskRecordFile(taskOwnerCheckRecordPath(root, record.taskId, directory), taskOwnerCheckRecordJson(record), directory);
}

/** The digest of the duty's base, obligations and family inputs as they are beneath `root` now. */
export function observeTaskOwnerCheckDigest(root: CanonicalRepositoryRoot, duty: OwedTaskOwnerCheck): DomainResult<TaskOwnerCheckDigest, string> {
  const files = observeDeclaredFiles(root, duty.digested);
  return files.ok ? success(taskOwnerCheckDigest(duty, files.value)) : files;
}

/**
 * The stop shells' observation of one Task that owes the owner check: how its
 * record stands against the family now, with the command that refreshes it
 * (`commands.ownerCheck`). A digest or a record that cannot be read is
 * `unavailable`, which never blocks.
 */
export function observeTaskOwnerCheck(
  commands: Pick<LoomCommands, "ownerCheck">,
  directory: () => string = subagentDir,
): (duty: OwedTaskOwnerCheck, root: CanonicalRepositoryRoot) => TaskOwnerCheckObservation {
  return (duty, root) => {
    const digest = observeTaskOwnerCheckDigest(root, duty);
    if (!digest.ok) return Object.freeze({ kind: "unavailable", reason: `its family's files could not be digested: ${digest.error}` });
    const record = readTaskOwnerCheckRecord(root, duty.taskId, directory());
    if (!record.ok) return Object.freeze({ kind: "unavailable", reason: `its record is unreadable: ${record.error}` });
    return Object.freeze({
      kind: "observed",
      duty,
      standing: taskOwnerCheckStanding(record.value, duty.taskId, digest.value),
      command: commands.ownerCheck(duty.taskId),
    });
  };
}
