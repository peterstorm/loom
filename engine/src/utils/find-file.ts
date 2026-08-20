/**
 * Recursively search for a file by name under a directory.
 * Shared utility — replaces duplicate implementations in advance-phase, validate-phase-order, phase-init.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

export function findFile(dir: string, filename: string): string | null {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === filename) return join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findFile(join(dir, entry.name), filename);
        if (found) return found;
      }
    }
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      `findFile error in ${dir}: [${(error as NodeJS.ErrnoException).code ?? "UNKNOWN"}] ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
