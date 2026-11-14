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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { coverageCheckFailedNote, type CoverageReminder } from "../engine/src/linter/index";
import { coverageReminderAt } from "../engine/src/handlers/lint-coverage-shell";
import { piOperatorNoteSink } from "../engine/src/handlers/pi-adapter";
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
        notifyOperator(coverageCheckFailedNote(error));
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

/** What the registration reads from the process: its directory and stderr. */
export type PiLintCoverageProcess = Readonly<{
  cwd: () => string;
  writeStderrLine: (line: string) => void;
}>;

const PRODUCTION_PROCESS: PiLintCoverageProcess = Object.freeze({
  cwd: () => process.cwd(),
  writeStderrLine: (line: string) => { process.stderr.write(`${line}\n`); },
});

/**
 * Register the reminder on its own handlers, so a failed startup sweep cannot
 * silence it, nor it a sweep. The project is the one this process runs in, as
 * for the task graph: at session start no edited file exists yet to find it
 * from, unlike the post-edit lint.
 */
export function registerPiLintCoverage(
  pi: ExtensionAPI,
  reminder: PiLintCoverageReminder = createPiLintCoverageReminder(),
  host: PiLintCoverageProcess = PRODUCTION_PROCESS,
): void {
  pi.on("session_start", async (_event, ctx) => {
    reminder.sessionStarted(ctx.sessionManager.getSessionId() ?? "", host.cwd(), piOperatorNoteSink(ctx, host.writeStderrLine));
  });
  pi.on("before_agent_start", async (_event, ctx) => {
    const message = reminder.takeModelMessage(ctx.sessionManager.getSessionId() ?? "");
    return message === undefined ? undefined : { message };
  });
}
