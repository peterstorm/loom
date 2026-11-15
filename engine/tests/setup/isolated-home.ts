/**
 * Vitest global setup (registered in `vitest.config.ts`, after
 * `run-temp-root.ts`): one empty home directory for the whole run.
 *
 * Pi's agent directory defaults to `<os.homedir()>/.pi/agent`, and the
 * routing loader falls back to the home agent directory's
 * `model-routing.json` whenever the active one has none
 * (`utils/model-routing-context.ts`). A suite that inherits the developer's
 * HOME therefore reads their live routing policy and `models.json`, and
 * passes or fails depending on whose machine runs it. So, before any worker
 * starts, HOME points at an empty directory inside the run's temp root, and
 * an ambient `PI_CODING_AGENT_DIR` (set when the suite runs inside a Pi
 * session) is removed. Workers and every child they spawn inherit both. A
 * test that needs an agent directory sets its own.
 *
 * The one exception is named, not ambient: the installed-launcher acceptance
 * suite imports the developer's installed Pi extension code, so the agent
 * directory as it resolved before isolation is published under
 * `INSTALLED_PI_AGENT_DIR_ENV` (`tests/fixtures/installed-pi-agent-directory.ts`).
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PI_AGENT_DIRECTORY_VARIABLE, resolvePiAgentDirectory } from "../../src/core/pi-agent-directory";
import { INSTALLED_PI_AGENT_DIR_ENV } from "../fixtures/installed-pi-agent-directory";
import { runTempRoot } from "../fixtures/run-temp-root";

export default function setup(): void {
  process.env[INSTALLED_PI_AGENT_DIR_ENV] = resolvePiAgentDirectory(process.env, homedir());
  const home = join(runTempRoot(), "home");
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  delete process.env[PI_AGENT_DIRECTORY_VARIABLE];
}
