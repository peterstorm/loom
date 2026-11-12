/**
 * The Task mutation check's runtime record and what a stop observes of it
 * (ADR-0071). Every effect that reads or writes the record lives here, and
 * nothing here decides: the wire form, the digest and the standing are the
 * pure core's (`core/task-mutation-check.ts`).
 *
 * - The record is one file per repository and Task in the runtime directory
 *   (`subagentDir()`), beside the stop checks' block counters. It is keyed by
 *   Task, never by agent: `helper mutation-check` is a child process of the
 *   implementer's shell and cannot learn which agent ran it, while the digest
 *   inside the record already binds it to the exact bytes it judged. The file
 *   name encodes the Task id injectively (`taskIdFileSegment`), so no two
 *   Tasks ever share a record file. Like every unsessioned runtime file it is
 *   swept once it is older than `STALE_SUBAGENT_TTL_MS`; a swept record reads
 *   as `not-run`.
 * - `observeTaskMutationDigest` reads the bytes of every file the Task
 *   declares, and the record is read, under the one absence rule
 *   (`utils/file-absence.ts`): only absence reads as "not there", and any
 *   other filesystem refusal is a failure, so an unreadable file can never
 *   pass for a deleted one.
 * - `observeTaskMutation` is what the stop shells hand `runStopChecks`.
 *
 * Total: every function returns its fault as data and none throws.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { subagentDir } from "../config";
import { sha256Hex } from "../core/digest";
import { failure, success, type DomainResult } from "../core/orchestration-contract/identity";
import {
  parseTaskMutationRecord,
  TASK_MUTATION_NOT_RUN,
  taskMutationCommand,
  taskMutationDigest,
  taskMutationRecordJson,
  taskMutationStanding,
  type OwedTaskMutation,
  type RecordedTaskMutation,
  type TaskFileBytes,
  type TaskMutationDigest,
  type TaskMutationObservation,
  type TaskMutationRecord,
} from "../core/task-mutation-check";
import { describeCause } from "../utils/describe-cause";
import { readFileOrAbsence } from "../utils/file-absence";
import type { CanonicalRepositoryRoot } from "../utils/workspace-digest";

const UTF8 = new TextEncoder();
const KEPT = /^[A-Za-z0-9-]$/;

/**
 * A Task id as one file-name segment, injectively: letters, digits and `-`
 * stay as they are, and every other UTF-8 byte (`_` included) becomes `_`
 * and its two lowercase hex digits. Each escape has a fixed width and `_`
 * never stands for itself, so two distinct ids never share a segment, and the
 * segment holds no path separator. A kept character is one ASCII byte, and
 * every byte of a multi-byte character is above ASCII, so the rule reads
 * byte by byte.
 */
export function taskIdFileSegment(taskId: string): string {
  return Array.from(UTF8.encode(taskId), (byte) => {
    const character = String.fromCharCode(byte);
    return KEPT.test(character) ? character : `_${byte.toString(16).padStart(2, "0")}`;
  }).join("");
}

/** Where the record of `taskId` in the repository at `root` is kept. */
export function taskMutationRecordPath(root: CanonicalRepositoryRoot, taskId: string, directory: string = subagentDir()): string {
  return join(directory, `task-mutation.${sha256Hex(root).slice(0, 16)}.${taskIdFileSegment(taskId)}.json`);
}

/** The record a Task's last run left, `not-run` when there is none, or why the file cannot be read as a record. */
export function readTaskMutationRecord(
  root: CanonicalRepositoryRoot,
  taskId: string,
  directory: string = subagentDir(),
): DomainResult<TaskMutationRecord, string> {
  const path = taskMutationRecordPath(root, taskId, directory);
  const read = readFileOrAbsence(path);
  if (read.kind === "absent") return success(TASK_MUTATION_NOT_RUN);
  if (read.kind === "refused") return failure(`${path}: ${describeCause(read.cause)}`);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(read.bytes));
  } catch (cause) {
    return failure(`${path} is not JSON: ${describeCause(cause)}`);
  }
  const parsed = parseTaskMutationRecord(raw);
  return parsed.ok ? parsed : failure(`${path}: ${parsed.error}`);
}

/** Keep `record`, replacing the Task's earlier one. Atomic: a stop never reads half a record. The path written, or why not. */
export function writeTaskMutationRecord(
  root: CanonicalRepositoryRoot,
  record: RecordedTaskMutation,
  directory: string = subagentDir(),
): DomainResult<string, string> {
  const path = taskMutationRecordPath(root, record.taskId, directory);
  const staged = `${path}.${process.pid}.${randomUUID()}.staged`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(staged, taskMutationRecordJson(record), { flag: "wx", mode: 0o600 });
    renameSync(staged, path);
    return success(path);
  } catch (cause) {
    // Best effort: the write's own fault is the one reported, and a staged file that stays is swept with the directory.
    try {
      rmSync(staged, { force: true });
    } catch {
      // Removing the staged file can fail for the reason the write did.
    }
    return failure(`${path}: ${describeCause(cause)}`);
  }
}

/** One declared file's bytes beneath `root`, null when it is not there, or why the filesystem refused it. */
function fileBytes(root: CanonicalRepositoryRoot, path: string): DomainResult<TaskFileBytes, string> {
  const read = readFileOrAbsence(join(root, path));
  if (read.kind === "refused") return failure(`${path} cannot be read: ${describeCause(read.cause)}`);
  return success({ path, bytes: read.kind === "bytes" ? read.bytes : null });
}

/** The digest of the Task's base and declared files as they are beneath `root` now. */
export function observeTaskMutationDigest(root: CanonicalRepositoryRoot, duty: OwedTaskMutation): DomainResult<TaskMutationDigest, string> {
  const files: TaskFileBytes[] = [];
  for (const path of duty.declared) {
    const read = fileBytes(root, path);
    if (!read.ok) return read;
    files.push(read.value);
  }
  return success(taskMutationDigest(duty.startSha, files));
}

/**
 * The stop shells' observation of one Task that owes the check: how its
 * record stands against its files now, with the command that refreshes it
 * through the Loom package at `packageRoot`. A digest or a record that cannot
 * be read is `unavailable`, which never blocks.
 */
export function observeTaskMutation(
  packageRoot: string,
  directory: () => string = subagentDir,
): (duty: OwedTaskMutation, root: CanonicalRepositoryRoot) => TaskMutationObservation {
  return (duty, root) => {
    const digest = observeTaskMutationDigest(root, duty);
    if (!digest.ok) return Object.freeze({ kind: "unavailable", reason: `its files could not be digested: ${digest.error}` });
    const record = readTaskMutationRecord(root, duty.taskId, directory());
    if (!record.ok) return Object.freeze({ kind: "unavailable", reason: `its record is unreadable: ${record.error}` });
    return Object.freeze({
      kind: "observed",
      standing: taskMutationStanding(record.value, duty.taskId, digest.value),
      command: taskMutationCommand(packageRoot, duty.taskId),
    });
  };
}
