/**
 * The one absence rule the mutation checks read repository files by: Owner
 * Verification's repository reads (ADR-0036) and the Task mutation check's
 * digest and record reads (ADR-0071).
 *
 * Only absence reads as "not there": no such path (`ENOENT`), a parent that is
 * not a directory (`ENOTDIR`), or a directory where a file was expected
 * (`EISDIR`). Any other refusal (EACCES, ELOOP, EIO, EMFILE, ...) is a failure
 * the caller reports, so an unreadable file can never pass for a deleted one.
 * This module is that rule's one home: the two checks cannot disagree about
 * what counts as absent.
 */

import { readFileSync } from "node:fs";

/** The errno codes that mean "not there", and only those. */
export const ABSENCE_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

const errnoCode = (cause: unknown): unknown =>
  typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;

/** Whether a thrown filesystem error says the path is absent, rather than refused. */
export function isAbsence(cause: unknown): boolean {
  const code = errnoCode(cause);
  return typeof code === "string" && ABSENCE_CODES.has(code);
}

/** One file's bytes, its absence, or the refusal that kept it from being read. */
export type FileRead =
  | Readonly<{ kind: "bytes"; bytes: Uint8Array }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "refused"; cause: unknown }>;

const ABSENT: FileRead = Object.freeze({ kind: "absent" });

/** Read `path` under the absence rule. Never throws. */
export function readFileOrAbsence(path: string): FileRead {
  try {
    return Object.freeze({ kind: "bytes", bytes: Uint8Array.from(readFileSync(path)) });
  } catch (cause) {
    return isAbsence(cause) ? ABSENT : Object.freeze({ kind: "refused", cause });
  }
}
