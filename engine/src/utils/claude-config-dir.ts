/**
 * Claude Code's configuration directory, and the parts of it Loom reads or
 * guards: `CLAUDE_CONFIG_DIR` when set (trimmed, non-empty), else `~/.claude`,
 * read at call time so a re-pointed directory is honoured without a reload.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** `CLAUDE_CONFIG_DIR`, or `~/.claude`. */
export function claudeConfigDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? configured : join(homedir(), ".claude");
}

/**
 * Where Claude Code keeps the shell state it carries from one Bash call of a
 * session to the next, both applied before every command:
 * - shell-snapshots: the snapshot of the user's shell (functions, aliases
 *   with alias expansion on, options, exported variables);
 * - session-env: the per-session environment scripts hooks write through
 *   CLAUDE_ENV_FILE.
 * A process that writes either rebinds what every later command of the session
 * runs, so the subagent authority guard protects both.
 */
export const claudeShellStateDirs = (): readonly string[] =>
  ["shell-snapshots", "session-env"].map((entry) => join(claudeConfigDir(), entry));
