/**
 * Fail-closed path presence: ENOENT is the ONLY proof that a path is absent.
 *
 * `existsSync` answers `false` for every error — EACCES on a parent, ELOOP,
 * ENOTDIR, EIO — so a present-but-unreadable config, rule or run marker reads
 * as "not there" and whatever arms on its presence silently disarms. This
 * probe keeps the third answer: a path whose presence cannot be observed is
 * `unknown`, and each caller decides how to refuse.
 */

import { accessSync, constants as fsConstants } from "node:fs";

export type PathPresence =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "present" }>
  | Readonly<{ kind: "unknown"; cause: string }>;

const ABSENT: PathPresence = Object.freeze({ kind: "absent" });
const PRESENT: PathPresence = Object.freeze({ kind: "present" });

export function observePathPresence(path: string): PathPresence {
  try {
    accessSync(path, fsConstants.F_OK);
    return PRESENT;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ABSENT;
    return Object.freeze({ kind: "unknown", cause: error instanceof Error ? error.message : String(error) });
  }
}
