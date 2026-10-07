/**
 * Where the Pi user agent directory is — the ONE resolution rule every Loom
 * reader of Pi's agent directory shares, as a pure decision over the
 * environment and the home directory its shell observed.
 *
 * Loom binds every Pi spawn to the generated agent definition Pi itself
 * executes, and reads Pi's `model-routing.json` beside it, so Loom and Pi must
 * agree on this directory byte for byte. The rule is Pi's own `getAgentDir`:
 *
 * - `PI_CODING_AGENT_DIR` when it is set to a non-empty value, with a leading
 *   `~` / `~/` expanded against the home directory and a `file://` URL read as
 *   its path;
 * - otherwise `<home>/.pi/agent`.
 *
 * `home` is what the shell's `os.homedir()` answers — the same source Pi uses —
 * never `$HOME` read raw: with `HOME` unset, `os.homedir()` falls back to the
 * account's passwd entry, where `$HOME ?? ""` silently produced the
 * cwd-relative `.pi/agent`. The Pi extension factory, the routing-config
 * loader and the PreToolUse model guard all call this module; none spells the
 * rule itself.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The environment variable a Pi session selects its agent directory with. */
export const PI_AGENT_DIRECTORY_VARIABLE = "PI_CODING_AGENT_DIR";

/** The default agent directory under one home directory. */
export const piHomeAgentDirectory = (home: string): string => join(home, ".pi", "agent");

/** Pi's path normalisation for a selected directory: `~` expansion against
 *  `home`, then a `file://` URL as its path; anything else verbatim. */
const normalizeSelectedDirectory = (selected: string, home: string): string => {
  if (selected === "~") return home;
  if (selected.startsWith("~/")) return join(home, selected.slice(2));
  return /^file:\/\//.test(selected) ? fileURLToPath(selected) : selected;
};

/** The active Pi agent directory for this environment and home directory. */
export const resolvePiAgentDirectory = (
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string => {
  const selected = env[PI_AGENT_DIRECTORY_VARIABLE];
  return selected === undefined || selected === ""
    ? piHomeAgentDirectory(home)
    : normalizeSelectedDirectory(selected, home);
};

/** The generated definition file Pi executes for one user-scope agent. */
export const piAgentDefinitionPath = (agentDirectory: string, agent: string): string =>
  join(agentDirectory, "agents", `${agent}.md`);
