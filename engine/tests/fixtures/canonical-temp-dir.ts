import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One canonical test temp root: mkdir under the OS tmpdir, then resolve the
 * system `/tmp` and `/var` symlinks once. Tests that exercise the anchored
 * primitives need the REAL path as their base — production resolves its
 * configured base for the same reason (see `no-follow-fs` base resolution) —
 * so the wrap lives here instead of being hand-rolled per fixture file.
 */
export function canonicalTempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}
