/**
 * The filesystem side of persisted Bash output (`parseBashTestOutput`'s
 * `PersistedOutputReader` port): Claude Code saves a large tool result to disk
 * and leaves its path in the transcript. Reads that file, or answers null when
 * it is absent — and when it exists but cannot be read, says so on stderr
 * before falling back, because the full results (and possibly the pass
 * markers) live in the unread file.
 */

import { existsSync, readFileSync } from "node:fs";
import type { PersistedOutputReader } from "../parsers/parse-bash-test-output";

export const readPersistedOutput: PersistedOutputReader = (filePath) => {
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf-8");
  } catch (e) {
    process.stderr.write(
      `parse-bash-test-output: persisted output file '${filePath}' unreadable — falling back to the truncated preview: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return null;
  }
};
