/**
 * Vitest global setup (registered FIRST in `vitest.config.ts`): one temp root
 * per run, removed when the run ends.
 *
 * Fixtures make their scratch directories under `os.tmpdir()`, and many never
 * remove them; a developer machine had collected ~36,000 suite leftovers in
 * `/tmp` (`lint-config-*`, `loom-fixture-pi-session-*`, …). Pointing TMPDIR at a
 * fresh directory before any worker starts makes every `tmpdir()` in the run —
 * workers and the `bun`/`git` children they spawn, which inherit the
 * environment — land inside it, so a whole run's scratch is deleted at once
 * and nothing one run leaves behind can be seen by the next.
 *
 * The root is NOT canonicalized: on macOS it stays under the `/var` symlink, so
 * the suite keeps exercising symlinked temp paths the way the platform hands
 * them out (tests that need a real path use `canonicalTempDir`).
 *
 * It runs before `fixture-pi-route.ts`, so that setup's agent directory lands
 * inside the root too.
 */
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_TEMP_ROOT_ENV } from "../fixtures/run-temp-root";

/** Give the owner back access to every directory under `directory` (symlinks not followed). */
function restoreOwnerAccess(directory: string): void {
  chmodSync(directory, 0o700);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) restoreOwnerAccess(join(directory, entry.name));
  }
}

/**
 * Remove the run's temp root. Permission-failure simulations chmod their
 * fixture directories read-only and do not always restore them, so a refused
 * removal restores owner access and retries once; a second failure throws,
 * because a root the run cannot delete is a fixture defect worth seeing.
 */
export function removeRunTempRoot(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    restoreOwnerAccess(root);
    rmSync(root, { recursive: true, force: true });
  }
}

export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), "loom-vitest-run-"));
  // Workers are started after global setup and inherit this environment.
  process.env[RUN_TEMP_ROOT_ENV] = root;
  process.env.TMPDIR = root;
  return () => removeRunTempRoot(root);
}
