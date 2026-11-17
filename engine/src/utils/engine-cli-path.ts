/**
 * Which script is this Loom package's own CLI (loom#198, Cause 1).
 *
 * An engine-run TestRun is minted only from a `helper run-tests` receipt
 * printed by the engine's own `engine/src/cli.ts`: a look-alike script
 * elsewhere would print text, not facts. Both evidence recorders (Claude
 * Code's PostToolUse handler and Pi's) hand this predicate to the shared
 * minting shell as a port, so the filesystem check stays out of `machine/`.
 */

import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** This package's CLI, by real path, resolved once: symlinked installs compare equal. */
const ENGINE_CLI_REAL_PATH = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli.ts"));

/**
 * Whether `scriptWord`, resolved against `cwd` and through every symlink,
 * is this package's own `cli.ts`. A path that does not resolve is not it.
 */
export function isEngineCliScript(cwd: string, scriptWord: string): boolean {
  try {
    return realpathSync(resolve(cwd, scriptWord)) === ENGINE_CLI_REAL_PATH;
  } catch {
    return false;
  }
}
