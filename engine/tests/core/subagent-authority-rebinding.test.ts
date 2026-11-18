/**
 * The subagent authority guard and the state-file guard share one rule for a
 * line that may rebind a command name (`commandNamesRebound`, loom#216). Beyond
 * `hash`, `alias`, `enable` and a function, a search-path change, the command
 * hash table, and a file or string run in this shell may each make a read-only
 * head name another program.
 */
import { describe, expect, it } from "vitest";
import {
  LEXICAL_FILESYSTEM,
  decideSubagentAuthority,
  parseInheritedEnvironment,
  type SubagentAuthorityContext,
} from "../../src/core/subagent-authority";
import { AUTHORITY_HELPER_OPERATIONS, HARNESS_HOOK_ROUTES } from "../../src/handlers/pre-tool-use/subagent-authority-operations";

const MACHINES = "/opt/loom/machines";

const context: SubagentAuthorityContext = {
  cwd: "/repo",
  home: "/home/u",
  runs: { kind: "known", directories: [] },
  protectedDirectories: ["/tmp/claude-subagents", MACHINES],
  helperOperations: AUTHORITY_HELPER_OPERATIONS,
  hookRoutes: HARNESS_HOOK_ROUTES,
  readOnlyScripts: [],
  cdSearchPath: [],
  environment: parseInheritedEnvironment({}),
  filesystem: LEXICAL_FILESYSTEM,
};

const verdict = (command: string): string => {
  const decision = decideSubagentAuthority(command, context);
  return decision.kind === "allow" ? "allow" : decision.refusal.rule;
};

describe("a read-only head is not trusted on a line that may rebind a command name", () => {
  it.each([
    ["PATH puts another cat first", `PATH=/tmp/evil:$PATH; cat -r ${MACHINES}`],
    ["a PATH prefix", `PATH=/tmp/evil cat -r ${MACHINES}`],
    ["BASH_CMDS hashes cat to rm", `BASH_CMDS[cat]=/bin/rm; cat -r ${MACHINES}`],
    ["a preloaded library runs inside cat", `LD_PRELOAD=/tmp/evil.so cat -r ${MACHINES}`],
    ["eval may define a function", `eval "$DEFS"; cat -r ${MACHINES}`],
  ])("refuses: %s", (_name, command) => {
    expect(verdict(command)).toBe("authority-path-write");
  });

  it("source of a script the guard cannot read is refused", () => {
    expect(verdict(`source /tmp/defs.sh; cat -r ${MACHINES}`)).not.toBe("allow");
  });

  it.each([
    ["a plain read", `cat -r ${MACHINES}`],
    ["a plain read of PATH", `echo "$PATH"; cat -r ${MACHINES}`],
  ])("allows: %s", (_name, command) => {
    expect(verdict(command)).toBe("allow");
  });
});
