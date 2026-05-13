/**
 * Core: Guard state files from direct modification via Bash.
 * Pure function — no stdin parsing.
 */

import { existsSync } from "node:fs";
import type { HookResult } from "../types";
import { TASK_GRAPH_PATH, WHITELISTED_HELPERS, STATE_FILE_PATTERNS, WRITE_PATTERNS } from "../config";

export function guardStateFile(command: string): HookResult {
  if (!existsSync(TASK_GRAPH_PATH)) return { kind: "allow" };
  if (!command) return { kind: "allow" };

  // Allow whitelisted helper scripts
  if (WHITELISTED_HELPERS.some((h) => command.includes(h))) {
    return { kind: "allow" };
  }

  // Only inspect commands that reference state files
  if (!STATE_FILE_PATTERNS.test(command)) return { kind: "allow" };

  // Block write patterns
  if (WRITE_PATTERNS.test(command)) {
    return {
      kind: "block",
      message: [
        "BLOCKED: Write to state file not allowed during loom workflow.",
        "State is managed by hooks and helper scripts only.",
        "Read access (jq, cat) is allowed.",
      ].join("\n"),
    };
  }

  return { kind: "allow" };
}
