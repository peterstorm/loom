import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { COMMAND_SCOPE_ARGV, COMMAND_SCOPE_CONFIG, policyBoundGitArgv } from "../../src/utils/git-command-scope";

const logicalArgv = fc.array(fc.string(), { maxLength: 8 });

describe("policyBoundGitArgv", () => {
  it("opens every invocation with the command-scope prefix built from the config table", () => {
    expect(COMMAND_SCOPE_ARGV).toEqual(COMMAND_SCOPE_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`]));
    expect(COMMAND_SCOPE_ARGV).toEqual(["-c", "core.fsmonitor=false"]);
    expect(policyBoundGitArgv(["rev-parse", "HEAD"])).toEqual(["-c", "core.fsmonitor=false", "rev-parse", "HEAD"]);
    expect(policyBoundGitArgv([])).toEqual(COMMAND_SCOPE_ARGV);
  });

  it("is the prefix followed by the logical argv, unchanged, for any argv", () => {
    fc.assert(fc.property(logicalArgv, (args) => {
      const argv = policyBoundGitArgv(args);
      expect(argv.slice(0, COMMAND_SCOPE_ARGV.length)).toEqual(COMMAND_SCOPE_ARGV);
      expect(argv.slice(COMMAND_SCOPE_ARGV.length)).toEqual(args);
    }));
  });

  it("returns a frozen argv and never mutates its input", () => {
    fc.assert(fc.property(logicalArgv, (args) => {
      const before = [...args];
      const argv = policyBoundGitArgv(args);
      expect(Object.isFrozen(argv)).toBe(true);
      expect(args).toEqual(before);
    }));
  });
});
