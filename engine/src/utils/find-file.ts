/**
 * Recursively search for a file by name under a directory.
 * Shared utility — replaces duplicate implementations in advance-phase, validate-phase-order, phase-init.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function findFile(dir: string, filename: string): string | null {
  if (!existsSync(dir)) return null;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name === filename) return join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findFile(join(dir, entry.name), filename);
        if (found) return found;
      }
    }
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      process.stderr.write(`findFile error in ${dir}: [${code}] ${(e as Error).message}\n`);
    }
  }
  return null;
}
