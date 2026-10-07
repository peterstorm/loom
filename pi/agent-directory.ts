/**
 * Where the Pi user agent directory is, as one pure decision over the
 * environment and home directory the extension factory observes.
 *
 * Loom binds every spawn to the generated agent definition Pi itself executes,
 * so the extension's definition port and Pi must agree on this directory:
 * `PI_CODING_AGENT_DIR` when the session selects one, else `~/.pi/agent`. The
 * extension resolves it when its factory starts — not at module import — so
 * a Pi session that selects a different directory is honoured.
 */

import { join } from "node:path";

export const resolvePiAgentDirectory = (env: Readonly<Record<string, string | undefined>>, home: string): string =>
  env["PI_CODING_AGENT_DIR"] ?? join(home, ".pi", "agent");

/** The generated definition file Pi executes for one user-scope agent. */
export const piAgentDefinitionPath = (agentDirectory: string, agent: string): string =>
  join(agentDirectory, "agents", `${agent}.md`);
