/**
 * A Loom package root other than the running one, for tests that print
 * commands from a fixed or awkward root (`/opt/loom`, `/home/o'brien/…`).
 *
 * Minted through the production parser, never cast: a root the engine would
 * refuse cannot reach a test as if the engine had accepted it, so a fixture
 * that asks for one fails loudly here.
 */

import { loomCommands, parseLoomPackageRoot, type LoomCommands, type LoomPackageRoot } from "../../src/core/loom-cli-command";

/** `raw` as a package root, or a thrown refusal naming why the engine would not accept it. */
export function aPackageRoot(raw: string): LoomPackageRoot {
  const parsed = parseLoomPackageRoot(raw);
  if (!parsed.ok) throw new Error(`test package root ${JSON.stringify(raw)} is refused: ${parsed.error.message}`);
  return parsed.value;
}

/** The printed commands of the Loom package at `raw`. */
export const loomCommandsAt = (raw: string): LoomCommands => loomCommands(aPackageRoot(raw));
