/**
 * The handshake between the Vitest global setup (`tests/setup/fixture-pi-route.ts`)
 * and the test workers: the setup publishes the fixture Pi agent directory —
 * whose `models.json` names its fake local route — under one environment
 * variable before any worker starts, and every worker reads it back through
 * `fixturePiAgentDirectory`. One name, one read, one failure mode.
 *
 * Dependency-free on purpose: the global setup imports it in Vitest's main
 * process, and fixtures import it without loading the setup module.
 */

/** The variable the global setup publishes the fixture Pi agent directory under. */
export const FIXTURE_PI_AGENT_DIR_ENV = "LOOM_FIXTURE_PI_AGENT_DIR";

/** The fixture Pi agent directory, whose models.json names the global setup's fake local route. */
export function fixturePiAgentDirectory(): string {
  const directory = process.env[FIXTURE_PI_AGENT_DIR_ENV];
  if (directory === undefined) throw new Error(`${FIXTURE_PI_AGENT_DIR_ENV} is unset: tests/setup/fixture-pi-route.ts did not run`);
  return directory;
}
