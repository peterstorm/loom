/**
 * Exit the process once everything written to stdout and stderr has drained
 * (loom#198, Cause 5).
 *
 * A write to a pipe is asynchronous: `process.exit` right after
 * `process.stdout.write` drops whatever has not reached the pipe yet, which a
 * reader saw as CLI output cut at the pipe's buffer. Measured under Bun 1.4,
 * against a reader that pauses: an immediate exit delivered 128 KiB of 1 MiB,
 * and the callback of a trailing empty write fires before earlier data has
 * drained, so it is no barrier either. A process whose work is done and that
 * ends on its own drains every pending write first.
 *
 * So set the exit code and let the process end. A handle some handler left
 * open would keep it alive indefinitely, so an unref'd timer forces the exit
 * after {@link FORCED_EXIT_MS}; being unref'd, it never itself delays an exit.
 */

/** How long a process whose output has drained may be kept alive by a stray handle. */
export const FORCED_EXIT_MS = 5_000;

export function exitAfterFlush(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), FORCED_EXIT_MS).unref();
}
