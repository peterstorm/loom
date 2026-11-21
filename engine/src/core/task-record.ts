/**
 * The pure core both Task-level checks share (ADR-0071, ADR-0092): the Task
 * mutation check and the Task owner check each leave one runtime record a
 * stop reads, and everything about that record except its result is decided
 * here, once, generic over the result:
 *
 * - `TaskFileBytes` and `taskRecordDigest`: the identity of what one run
 *   judged, over a check-specific head (its version label, base and duty) and
 *   the bytes or absence of every file it read, independent of file order.
 *   `TaskRecordDigest` is minted only here.
 * - `TaskRecord`, `taskRecordJson` and `parseTaskRecord`: the wire envelope
 *   (`schemaVersion`, `kind`, `taskId`, `digest`, `result`), its fixed key
 *   order, and its parser, which hands only the `result` to the check's own
 *   parser. `exactKeys` is the one key-set rule both result parsers use.
 * - `taskRecordStanding`: the digest-versus-record rule. A record of another
 *   Task or of other bytes is stale.
 * - `TaskRecordObservation` and `TaskRecordStopVerdict`: what a stop shell
 *   observed for a record-reading arm, and what the arm decides from it.
 * - `TASK_RECORD_CHECK_DEADLINE_MS`, `TASK_RECORD_CHECK_BASH_TIMEOUT_MS` and
 *   `taskRecordAnswerLines`: the budget both helpers run under, and how both
 *   arms end their part of a block message.
 *
 * Pure and total: no I/O, no clock, no throw.
 */

import { blocksRemainingLine } from "./affected-stop-check";
import { sha256Bytes, sha256Hex } from "./digest";
import { failure, success, type DomainResult } from "./orchestration-contract/identity";
import { compareStrings } from "./ordering";
import { isRecord, type UnknownRecord } from "./plain-record";

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

declare const TASK_RECORD_DIGEST: unique symbol;

/** The identity of what one Task-level run judged: only `taskRecordDigest` and `parseTaskRecord` hold one. */
export type TaskRecordDigest = string & { readonly [TASK_RECORD_DIGEST]: true };

const DIGEST = /^[0-9a-f]{64}$/;
const mintDigest = (hex: string): TaskRecordDigest => hex as TaskRecordDigest;

/** One file as a run saw it: its bytes, or null when it does not exist. */
export type TaskFileBytes = Readonly<{ path: string; bytes: Uint8Array | null }>;

/**
 * sha256 over `[label, ...head, files]`, the files sorted by path with each
 * one's bytes digested (null for an absent file). It changes when the head,
 * the set of paths, a file's presence or a single byte changes, and not with
 * the order the files are given in.
 */
export function taskRecordDigest(label: string, head: readonly unknown[], files: readonly TaskFileBytes[]): TaskRecordDigest {
  const entries = files
    .map(({ path, bytes }): readonly [string, string | null] => [path, bytes === null ? null : sha256Bytes(bytes)])
    .sort(([left], [right]) => compareStrings(left, right));
  return mintDigest(sha256Hex(JSON.stringify([label, ...head, entries])));
}

// ---------------------------------------------------------------------------
// The record and its wire envelope
// ---------------------------------------------------------------------------

/** What a Task's last run of one check left: nothing, or its result bound to the digest of what it judged. */
export type TaskRecord<Result> =
  | Readonly<{ kind: "not-run" }>
  | RecordedTask<Result>;

export type RecordedTask<Result> = Readonly<{ kind: "recorded"; taskId: string; digest: TaskRecordDigest; result: Result }>;

export const TASK_RECORD_NOT_RUN: Readonly<{ kind: "not-run" }> = Object.freeze({ kind: "not-run" });

/** A run's record: `result` bound to `taskId` and the digest of what it judged. */
export const recordedTask = <Result>(taskId: string, digest: TaskRecordDigest, result: Result): RecordedTask<Result> =>
  Object.freeze({ kind: "recorded", taskId, digest, result });

/** Which record a document is: its `kind` and schema version. */
export type TaskRecordWire = Readonly<{ kind: string; schemaVersion: number; path: string }>;

/** The record's wire document. Property order is fixed, so equal records serialize to equal bytes. */
export function taskRecordJson<Result>(wire: TaskRecordWire, { taskId, digest, result }: RecordedTask<Result>): string {
  return JSON.stringify({ schemaVersion: wire.schemaVersion, kind: wire.kind, taskId, digest, result });
}

/** Null when `raw` holds exactly `keys`, or the refusal naming the unknown keys first, then the missing ones. */
export function exactKeys(raw: Readonly<UnknownRecord>, keys: readonly string[], path: string): string | null {
  const unknown = Object.keys(raw).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in raw));
  if (unknown.length > 0) return `${path} has unknown key(s) ${unknown.join(", ")}`;
  return missing.length > 0 ? `${path} lacks ${missing.join(", ")}` : null;
}

/** A record document as a record, or the first reason it is not one; `parseResult` reads only its `result`. */
export function parseTaskRecord<Result>(
  raw: unknown,
  wire: TaskRecordWire,
  parseResult: (raw: unknown, path: string) => DomainResult<Result, string>,
): DomainResult<RecordedTask<Result>, string> {
  const { path } = wire;
  if (!isRecord(raw)) return failure(`${path} must be an object`);
  const shape = exactKeys(raw, ["schemaVersion", "kind", "taskId", "digest", "result"], path);
  if (shape !== null) return failure(shape);
  if (raw.schemaVersion !== wire.schemaVersion) return failure(`${path}.schemaVersion must be ${wire.schemaVersion}`);
  if (raw.kind !== wire.kind) return failure(`${path}.kind must be "${wire.kind}"`);
  if (typeof raw.taskId !== "string" || raw.taskId === "") return failure(`${path}.taskId must be a non-empty string`);
  if (typeof raw.digest !== "string" || !DIGEST.test(raw.digest)) return failure(`${path}.digest must be a sha256 hex digest`);
  const result = parseResult(raw.result, `${path}.result`);
  return result.ok
    ? success(recordedTask(raw.taskId, mintDigest(raw.digest), result.value))
    : result;
}

// ---------------------------------------------------------------------------
// The stop
// ---------------------------------------------------------------------------

/** How a Task's record stands against its files now: its result, when it judged these very bytes. */
export type TaskRecordStanding<Result> =
  | Readonly<{ kind: "not-run" }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "current"; result: Result }>;

/** The record's standing for `taskId` at `digest`: a record of another Task or of other bytes is stale. */
export function taskRecordStanding<Result>(record: TaskRecord<Result>, taskId: string, digest: TaskRecordDigest): TaskRecordStanding<Result> {
  if (record.kind === "not-run") return Object.freeze({ kind: "not-run" });
  return record.taskId === taskId && record.digest === digest
    ? Object.freeze({ kind: "current", result: record.result })
    : Object.freeze({ kind: "stale" });
}

/** A fault that kept a stop shell from observing a record. Every arm reads it as a note, never a block. */
export type TaskRecordUnavailable = Readonly<{ kind: "unavailable"; reason: string }>;

/**
 * What a stop shell observed for one record-reading arm: the Task owes
 * nothing, or its record's standing with the command that refreshes it (and
 * whatever else the arm's verdict reads, `Context`), or the fault.
 */
export type TaskRecordObservation<Result, Context extends object = object> =
  | Readonly<{ kind: "off" }>
  | (Readonly<{ kind: "observed"; standing: TaskRecordStanding<Result>; command: string }> & Readonly<Context>)
  | TaskRecordUnavailable;

/** The observation of a stop that asks nothing of a record-reading arm. */
export const TASK_RECORD_CHECK_OFF: Readonly<{ kind: "off" }> = Object.freeze({ kind: "off" });

/** What a record-reading arm decides at one stop: nothing, a pass, a note, or a block for `Cause`. */
export type TaskRecordStopVerdict<Cause> =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "passed" }>
  | Readonly<{ kind: "note"; note: string }>
  | Readonly<{ kind: "failing"; cause: Cause; command: string }>;

/** The longest one record check's helper run (`helper mutation-check`, `helper owner-check`) may take; a run it cannot fit is not judged. */
export const TASK_RECORD_CHECK_DEADLINE_MS = 480_000;

/** The tool-call timeout an implementer gives that helper: the deadline, plus room to open and remove its worktrees. */
export const TASK_RECORD_CHECK_BASH_TIMEOUT_MS = 600_000;

/** How a record arm's part of a block message ends: the one command that answers it, and how many more blocks it may issue. */
export const taskRecordAnswerLines = (command: string, blocksRemaining: number): readonly string[] => [
  "",
  `Run it as one Bash call with a timeout of ${TASK_RECORD_CHECK_BASH_TIMEOUT_MS} ms, then your final verification run:`,
  `  ${command}`,
  blocksRemainingLine(blocksRemaining),
];
