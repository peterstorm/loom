/**
 * The handshake between the Vitest global setup (`tests/setup/isolated-home.ts`)
 * and the one acceptance suite that runs the developer's INSTALLED Pi launcher
 * code (`tests/pi/emission-installed-launcher.test.ts`). The setup replaces
 * HOME with an empty directory, so every other test is blind to the
 * developer's `~/.pi/agent`; before it does, it publishes where that agent
 * directory was under one environment variable, and this module reads it
 * back. Only the launcher's extension modules are imported from there — no
 * routing policy, `models.json` or other state.
 *
 * Dependency-free on purpose: the global setup imports it in Vitest's main
 * process, and tests import it without loading the setup module.
 */

/** The variable the global setup publishes the developer's Pi agent directory under. */
export const INSTALLED_PI_AGENT_DIR_ENV = "LOOM_TEST_INSTALLED_PI_AGENT_DIR";

/** The developer's Pi agent directory, as it resolved before the run isolated HOME. */
export function installedPiAgentDirectory(): string {
  const directory = process.env[INSTALLED_PI_AGENT_DIR_ENV];
  if (directory === undefined) throw new Error(`${INSTALLED_PI_AGENT_DIR_ENV} is unset: tests/setup/isolated-home.ts did not run`);
  return directory;
}
