/**
 * Best-effort cleanup and startup hygiene for the Pi shell.
 *
 * Every action runs even when an earlier one fails, and every failure is
 * either reported or surfaced: capability revocation, roster removal and
 * pointer release are independent debts, so one failing must never strand
 * the others or hide the cause that triggered the cleanup.
 */

import {
  injectPiWriteGrant,
  revokePiWriteGrant,
  type IssuedWriteGrant,
} from "./write-grant";

export interface PiCleanupAction {
  readonly label: string;
  readonly run: () => void | Promise<void>;
}

export type PiStartupSweep = Readonly<{ name: string; run: () => void }>;
export type PiStartupSweepSource = () => readonly PiStartupSweep[];
export type PiStartupSweepPorts = Readonly<{
  /** Return false only when the channel is unavailable and wrote nothing. */
  writeDiagnostic: (diagnostic: string) => boolean;
  /** Return false when this session has no UI. */
  notifyWarning: (message: string) => boolean;
  /** Process-level fallback, kept explicit so its failure is observable. */
  writeStderr: (diagnostic: string) => boolean;
}>;

type UnreportedStartupSweepFailure = Readonly<{
  error: Error;
  message: string;
  reportingFailures: readonly string[];
}>;

const startupError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/** Run every startup hygiene sweep and reporting route before surfacing wholly unreported failures. */
export function runPiStartupSweeps(
  sweeps: readonly PiStartupSweep[],
  ports: PiStartupSweepPorts,
): void {
  const unreported: UnreportedStartupSweepFailure[] = [];
  for (const sweep of sweeps) {
    try {
      sweep.run();
    } catch (error) {
      const sweepError = startupError(error);
      const message = `session_start sweep failed: ${sweep.name}: ${sweepError.message}; ` +
        "startup continues because authority is checked at consumption";
      const diagnostic = sweepError.stack ?? sweepError.message;
      const reportingFailures: string[] = [];
      let reported = false;
      const attemptReport = (label: string, report: () => boolean): void => {
        try {
          if (report()) reported = true;
          else reportingFailures.push(`${label} unavailable`);
        } catch (reportError) {
          reportingFailures.push(
            `${label} failed: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
          );
        }
      };

      attemptReport("diagnostic writer", () =>
        ports.writeDiagnostic(`loom(pi): ${message}\n${diagnostic}\n`));
      attemptReport("warning notifier", () =>
        ports.notifyWarning(`Loom ${message}${cleanupFailureSuffix(reportingFailures)}`));
      attemptReport("stderr fallback", () =>
        ports.writeStderr(`loom(pi): ${message}${cleanupFailureSuffix(reportingFailures)}\n`));

      if (!reported) {
        unreported.push(Object.freeze({
          error: sweepError,
          message,
          reportingFailures: Object.freeze([...reportingFailures]),
        }));
      }
    }
  }
  if (unreported.length > 0) {
    const details = unreported.map(({ message, reportingFailures }) =>
      `${message}${cleanupFailureSuffix(reportingFailures)}`).join(" | ");
    throw new AggregateError(
      unreported.map(({ error }) => error),
      `Loom session_start sweep failure(s) reached no reporting channel: ${details}`,
    );
  }
}

/** Run every cleanup action even when an earlier capability/roster operation fails. */
export async function runPiCleanupActions(
  actions: readonly PiCleanupAction[],
): Promise<readonly string[]> {
  const errors: string[] = [];
  for (const action of actions) {
    try {
      await action.run();
    } catch (error) {
      errors.push(`${action.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

export const cleanupFailureSuffix = (errors: readonly string[]): string =>
  errors.length === 0 ? "" : ` Cleanup failures: ${errors.join("; ")}`;

type PiWriteGrantInjectionPorts = Readonly<{
  inject(task: string, grant: IssuedWriteGrant): string;
  revoke(token: string): void | Promise<void>;
}>;

/** Inject an issued capability without allowing failed direct revocation to hide the injection cause. */
export async function injectPiWriteGrantWithRevocation(
  task: string,
  grant: IssuedWriteGrant,
  spawnIndex: number,
  ports: PiWriteGrantInjectionPorts = {
    inject: injectPiWriteGrant,
    revoke: revokePiWriteGrant,
  },
): Promise<string> {
  try {
    return ports.inject(task, grant);
  } catch (injectionError) {
    const cleanupErrors = await runPiCleanupActions([{
      label: `directly revoke write grant for spawn item ${spawnIndex + 1}`,
      run: () => ports.revoke(grant.token),
    }]);
    throw new Error(
      `write-grant injection failed: ${injectionError instanceof Error ? injectionError.message : String(injectionError)}` +
        cleanupFailureSuffix(cleanupErrors),
      { cause: injectionError },
    );
  }
}
