/**
 * SessionStart: say so when the session's project does not have every lint
 * rule family on — no lint setup at all, or an opt-in family neither
 * configured nor declined (`linter/lint-coverage.ts`).
 *
 * Both audiences hear it: the model through `additionalContext`, so it can
 * offer to turn the rules on, and the user through `systemMessage`. A
 * repository on the user's ignore list stays quiet. The hook never blocks a
 * session: a failure to compute the reminder becomes an operator line.
 */

import type { HookHandler } from "../../types";
import { passthroughResult } from "../../types";
import { isRecord } from "../../core/plain-record";
import type { CoverageReminder } from "../../linter/index";
import { coverageReminderAt } from "../lint-coverage-shell";

/** The JSON a SessionStart hook prints so the model gets the context and the
 *  user the one-line summary. */
export function sessionStartOutput(reminder: CoverageReminder): string {
  return JSON.stringify({
    systemMessage: reminder.forOperator,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: reminder.forModel },
  });
}

/** The session's working directory from the hook payload, else this process's. */
export function sessionDirectory(stdin: string, fallback: string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(stdin);
  } catch {
    return fallback;
  }
  return isRecord(raw) && typeof raw.cwd === "string" && raw.cwd !== "" ? raw.cwd : fallback;
}

const handler: HookHandler = async (stdin) => {
  try {
    const reminder = coverageReminderAt(sessionDirectory(stdin, process.cwd()));
    if (reminder !== null) process.stdout.write(`${sessionStartOutput(reminder)}\n`);
    return passthroughResult();
  } catch (error) {
    return passthroughResult(`Loom lint: the coverage check could not run: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export default handler;
