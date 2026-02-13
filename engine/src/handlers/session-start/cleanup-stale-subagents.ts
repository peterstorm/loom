/**
 * Clean up stale subagent tracking files from previous sessions.
 * Only deletes files older than 60 minutes to avoid breaking parallel sessions.
 */

import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { HookHandler } from "../../types";
import { SUBAGENT_DIR } from "../../config";

const STALE_MINUTES = 60;

const handler: HookHandler = async (_stdin, _args) => {
  if (!existsSync(SUBAGENT_DIR)) return { kind: "passthrough" };

  const cutoff = Date.now() - STALE_MINUTES * 60_000;

  try {
    for (const entry of readdirSync(SUBAGENT_DIR)) {
      const path = join(SUBAGENT_DIR, entry);
      try {
        if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
      } catch {}
    }
  } catch {}

  return { kind: "passthrough" };
};

export default handler;
