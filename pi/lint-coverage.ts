/**
 * Pi's lint-coverage reminder — the twin of Claude Code's `session-start
 * lint-coverage` hook. Both compute the reminder through the same shell
 * (`engine/src/handlers/lint-coverage-shell.ts`).
 *
 * At session start the operator hears it at once, through the UI or stderr.
 * The model hears it with the session's first prompt (`before_agent_start`),
 * once: Pi has no session-start context channel, so the reminder waits for
 * the first turn. A subagent process stays quiet, because its parent session
 * has already been reminded.
 */

import type { CoverageReminder } from "../engine/src/linter/index";
import { coverageReminderAt } from "../engine/src/handlers/lint-coverage-shell";
import { currentPiProcessRole, isPiSubagent, type PiProcessRole } from "./subagent-process";

/** The custom message type the model's copy of the reminder carries. */
export const PI_LINT_COVERAGE_MESSAGE_TYPE = "loom-lint-coverage";

export type PiLintCoverageMessage = Readonly<{
  customType: typeof PI_LINT_COVERAGE_MESSAGE_TYPE;
  content: string;
  display: false;
}>;

export type PiLintCoverageReminder = Readonly<{
  /** Compute the session's reminder, tell the operator, keep the model's copy. */
  sessionStarted: (sessionId: string, cwd: string, notifyOperator: (note: string) => void) => void;
  /** The model's copy for the session's first turn; every later call returns undefined. */
  takeModelMessage: (sessionId: string) => PiLintCoverageMessage | undefined;
}>;

export type PiLintCoveragePorts = Readonly<{
  reminderAt: (directory: string) => CoverageReminder | null;
  role: () => PiProcessRole;
}>;

const PRODUCTION_PORTS: PiLintCoveragePorts = Object.freeze({
  reminderAt: (directory: string) => coverageReminderAt(directory),
  role: currentPiProcessRole,
});

export function createPiLintCoverageReminder(ports: PiLintCoveragePorts = PRODUCTION_PORTS): PiLintCoverageReminder {
  const pending = new Map<string, string>();
  return Object.freeze({
    sessionStarted: (sessionId, cwd, notifyOperator) => {
      if (isPiSubagent(ports.role())) return;
      let reminder: CoverageReminder | null;
      try {
        reminder = ports.reminderAt(cwd);
      } catch (error) {
        notifyOperator(`Loom lint: the coverage check could not run: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (reminder === null) return;
      notifyOperator(reminder.forOperator);
      pending.set(sessionId, reminder.forModel);
    },
    takeModelMessage: (sessionId) => {
      const content = pending.get(sessionId);
      if (content === undefined) return undefined;
      pending.delete(sessionId);
      return Object.freeze({ customType: PI_LINT_COVERAGE_MESSAGE_TYPE, content, display: false });
    },
  });
}
