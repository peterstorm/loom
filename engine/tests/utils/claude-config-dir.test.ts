/**
 * utils/claude-config-dir — Claude Code's configuration directory
 * (`CLAUDE_CONFIG_DIR`, else `~/.claude`, read at call time) and the shell
 * state it carries between Bash calls.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeConfigDir, claudeShellStateDirs } from "../../src/utils/claude-config-dir";

describe("claudeConfigDir", () => {
  let saved: string | undefined;
  beforeEach(() => { saved = process.env.CLAUDE_CONFIG_DIR; });
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  });

  it("is ~/.claude when CLAUDE_CONFIG_DIR is unset or blank", () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeConfigDir()).toBe(join(homedir(), ".claude"));
    process.env.CLAUDE_CONFIG_DIR = "   ";
    expect(claudeConfigDir()).toBe(join(homedir(), ".claude"));
  });

  it("honours CLAUDE_CONFIG_DIR, trimmed, read at call time", () => {
    process.env.CLAUDE_CONFIG_DIR = " /cfg/a ";
    expect(claudeConfigDir()).toBe("/cfg/a");
    process.env.CLAUDE_CONFIG_DIR = "/cfg/b";
    expect(claudeShellStateDirs()).toEqual(["/cfg/b/shell-snapshots", "/cfg/b/session-env"]);
  });
});
