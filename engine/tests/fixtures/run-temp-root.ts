/**
 * The handshake between the Vitest global setup (`tests/setup/run-temp-root.ts`)
 * and the test workers: the setup creates one temp root per run, points
 * TMPDIR at it before any worker starts, and publishes it under one
 * environment variable that `runTempRoot` reads back. One name, one read, one
 * failure mode.
 *
 * Dependency-free on purpose: the global setup imports it in Vitest's main
 * process, and tests import it without loading the setup module.
 */

/** The variable the global setup publishes the run's temp root under. */
export const RUN_TEMP_ROOT_ENV = "LOOM_TEST_RUN_TEMP_ROOT";

/** This run's temp root: every `tmpdir()` in the run, workers and their children, resolves to it. */
export function runTempRoot(): string {
  const root = process.env[RUN_TEMP_ROOT_ENV];
  if (root === undefined) throw new Error(`${RUN_TEMP_ROOT_ENV} is unset: tests/setup/run-temp-root.ts did not run`);
  return root;
}
