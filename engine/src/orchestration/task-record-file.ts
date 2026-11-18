/**
 * The runtime file a Task-level check leaves for its stop arm to read: the
 * Task mutation record (ADR-0071) and the Task owner record (ADR-0092). Both
 * are one file per repository and Task in the runtime directory
 * (`subagentDir()`), beside the stop checks' block counters, and differ only
 * in their file-name prefix and their wire form, which each pure core owns.
 *
 * - Keyed by Task, never by agent: each helper is a child process of the
 *   implementer's shell and cannot learn which agent ran it, while the digest
 *   inside a record binds it to the exact bytes it judged. The file name
 *   encodes the Task id injectively (`taskIdFileSegment`), so no two Tasks
 *   ever share a record file.
 * - Read under the one absence rule (`utils/file-absence.ts`): only absence
 *   reads as "not there"; any other refusal, and bytes that are not JSON, are
 *   failures. Written atomically, so a stop never reads half a record.
 * - `observeDeclaredFiles` reads the bytes (or absence) of the files a digest
 *   covers, under the same rule, so an unreadable file can never pass for a
 *   deleted one.
 * - Like every unsessioned runtime file a record is swept once it is older
 *   than `STALE_SUBAGENT_TTL_MS`; a swept record reads as not run.
 *
 * Total: every function returns its fault as data and none throws.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { subagentDir } from "../config";
import { sha256Hex } from "../core/digest";
import { failure, success, type DomainResult } from "../core/orchestration-contract/identity";
import type { TaskFileBytes } from "../core/task-mutation-check";
import { describeCause } from "../utils/describe-cause";
import { readFileOrAbsence } from "../utils/file-absence";
import type { CanonicalRepositoryRoot } from "../utils/workspace-digest";

const UTF8 = new TextEncoder();
const KEPT = /^[A-Za-z0-9-]$/;

/** The record kinds a Task keeps, by the file-name prefix each is stored under. */
export type TaskRecordKind = "task-mutation" | "task-owner-check";

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

/** Where the `kind` record of `taskId` in the repository at `root` is kept. */
export function taskRecordPath(kind: TaskRecordKind, root: CanonicalRepositoryRoot, taskId: string, directory: string = subagentDir()): string {
  return join(directory, `${kind}.${sha256Hex(root).slice(0, 16)}.${taskIdFileSegment(taskId)}.json`);
}

/** A record file's JSON value, `absent` when there is no file, or why it cannot be read as JSON. */
export type TaskRecordRead = Readonly<{ kind: "absent" }> | Readonly<{ kind: "json"; raw: unknown }>;

export function readTaskRecordJson(path: string): DomainResult<TaskRecordRead, string> {
  const read = readFileOrAbsence(path);
  if (read.kind === "absent") return success({ kind: "absent" });
  if (read.kind === "refused") return failure(`${path}: ${describeCause(read.cause)}`);
  try {
    const raw: unknown = JSON.parse(new TextDecoder().decode(read.bytes));
    return success({ kind: "json", raw });
  } catch (cause) {
    return failure(`${path} is not JSON: ${describeCause(cause)}`);
  }
}

/** Write `text` at `path` in `directory`, replacing any earlier record, atomically. The path written, or why not. */
export function writeTaskRecordFile(path: string, text: string, directory: string): DomainResult<string, string> {
  const staged = `${path}.${process.pid}.${randomUUID()}.staged`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(staged, text, { flag: "wx", mode: 0o600 });
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

/** The bytes of each path beneath `root`, null for one that is not there, in the order given, or why the filesystem refused one. */
export function observeDeclaredFiles(root: CanonicalRepositoryRoot, paths: readonly string[]): DomainResult<readonly TaskFileBytes[], string> {
  const files: TaskFileBytes[] = [];
  for (const path of paths) {
    const read = readFileOrAbsence(join(root, path));
    if (read.kind === "refused") return failure(`${path} cannot be read: ${describeCause(read.cause)}`);
    files.push({ path, bytes: read.kind === "bytes" ? read.bytes : null });
  }
  return success(files);
}
