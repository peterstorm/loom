import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A repository file's exact bytes, or null when it is absent: the before/after side of a byte-equality proof. */
export function readRepositoryBytes(root: string, path: string): Buffer | null {
  try {
    return readFileSync(join(root, path));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
