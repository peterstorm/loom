/**
 * core/read-only-git — which `git` invocations write nothing outside the
 * repository's own `.git`, so the subagent authority guard may treat them as
 * reads (`git -C <checkout> fetch` from a checkout holding a protected
 * directory). Examples pin each rule. Two properties over the module's own
 * option table prove the invariant both ways: no option that runs a command or
 * writes a file, however abbreviated or placed among safe options, is ever
 * accepted, and safe options alone never cost a listed subcommand its read.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isReadOnlyGitInvocation, READ_ONLY_GIT_SUBCOMMANDS } from "../../src/core/read-only-git";

const words = (command: string): readonly string[] => command.split(" ");
const readOnly = (command: string): boolean => isReadOnlyGitInvocation(words(command));

const SUBCOMMANDS = [...READ_ONLY_GIT_SUBCOMMANDS.keys()];

/** Options no subcommand in the table refuses. */
const SAFE_OPTIONS = ["--oneline", "-5", "--stat", "HEAD", "-p", "--name-only"];

describe("read-only git invocations", () => {
  it.each([
    "git fetch",
    "git -C /opt/loom fetch",
    "git -C /opt/loom fetch origin main",
    "git -C /opt/loom status --short",
    "git -C /a -C b log --oneline -5",
    "git --no-pager -C /opt/loom show HEAD:machines/a.json",
    "git -P diff HEAD~1 -- machines/a.json",
    "git --no-optional-locks status",
    "git rev-parse --show-toplevel",
    "git ls-files machines",
    "git grep -n helper",
    "git log --output-indicator-new=+ -p",
    "git log --oneline",
    "git diff -u HEAD",
    "git log -- --output=x",
    // -u is --update-head-ok for fetch (it moves a ref) and untracked files for status.
    "git fetch -u origin main",
    "git status -u",
    // diff -O<file> reads an order file; only grep's -O runs a pager.
    "git diff -Oorder.txt",
    // git takes the word after -C as the directory, whatever it looks like.
    "git -C --git-dir=/x status",
  ])("reads: %s", (command) => {
    expect(readOnly(command)).toBe(true);
  });

  it.each([
    ["not git", "gitk --all"],
    ["no subcommand", "git -C /opt/loom"],
    ["a -C with no directory", "git -C"],
    ["a writing subcommand", "git -C /opt/loom checkout -- machines"],
    ["clean", "git -C /opt/loom clean -fdx"],
    ["stash", "git stash"],
    ["config", "git config core.fsmonitor x"],
    ["branch", "git branch -D main"],
    ["a config value on the command line", "git -c core.fsmonitor=x status"],
    ["another git directory", "git --git-dir=/x/.git status"],
    ["another work tree", "git --work-tree=/opt/loom/machines status"],
    ["another exec path", "git --exec-path=/tmp/bin status"],
    ["a config value from the environment", "git --config-env=core.fsmonitor=X status"],
    ["-- before the subcommand", "git -- status"],
    ["log --output", "git log --output=machines/a.json"],
    ["an abbreviated --output", "git diff --outp=machines/a.json"],
    ["a bare --output", "git show --output machines/a.json HEAD"],
    ["grep -O", "git grep -O rm x"],
    ["grep -O in a bundle", "git grep -inO rm x"],
    ["grep --open-files-in-pager", "git grep --open-files-in-pager=rm x"],
    ["--ext-diff", "git diff --ext-diff"],
    ["fetch --upload-pack", "git fetch --upload-pack=rm origin"],
    ["fetch --upload-pack abbreviated", "git fetch --upl=rm origin"],
    ["ls-remote --upload-pack", "git ls-remote --upload-pack=rm origin"],
    ["ls-remote --exec, the hidden synonym of --upload-pack", "git ls-remote --exec=rm origin"],
    ["ls-remote --exec with a separate value", "git ls-remote --exec rm origin"],
    ["ls-remote --exec abbreviated", "git ls-remote --exe=rm origin"],
    ["ls-remote -u, which older git reads as --upload-pack", "git ls-remote -u rm origin"],
  ])("does not read: %s", (_label, command) => {
    expect(readOnly(command)).toBe(false);
  });

  it("refuses a word with no static spelling before --, and allows one after it", () => {
    expect(isReadOnlyGitInvocation(["git", "-C", null, "fetch"])).toBe(false);
    expect(isReadOnlyGitInvocation(["git", null, "status"])).toBe(false);
    expect(isReadOnlyGitInvocation(["git", "log", null])).toBe(false);
    expect(isReadOnlyGitInvocation(["git", "log", "--", null])).toBe(true);
  });

  /** Every spelling git accepts for one of a subcommand's risky options. */
  const riskySpelling = (subcommand: string): fc.Arbitrary<string> => {
    const { long, short } = READ_ONLY_GIT_SUBCOMMANDS.get(subcommand) ?? { long: [], short: [] };
    const longSpelling = fc.tuple(fc.constantFrom(...long), fc.boolean()).chain(([option, withValue]) =>
      fc.integer({ min: 1, max: option.length }).map((length) => `--${option.slice(0, length)}${withValue ? "=x" : ""}`));
    if (short.length === 0) return longSpelling;
    const bundle = fc.tuple(fc.constantFrom("", "i", "in"), fc.constantFrom(...short), fc.constantFrom("", "n", "rm"))
      .map(([before, letter, after]) => `-${before}${letter}${after}`);
    return fc.oneof(longSpelling, bundle);
  };

  it("never accepts an option that runs a command or writes a file, in any spelling, among safe options", () => {
    const invocation = fc.constantFrom(...SUBCOMMANDS).chain((subcommand) => fc.tuple(
      fc.constant(subcommand),
      fc.array(fc.constantFrom(...SAFE_OPTIONS), { maxLength: 4 }),
      riskySpelling(subcommand),
      fc.array(fc.constantFrom(...SAFE_OPTIONS), { maxLength: 4 }),
    ));
    fc.assert(fc.property(invocation, ([subcommand, before, option, after]) => {
      expect(isReadOnlyGitInvocation(["git", "-C", "/opt/loom", subcommand, ...before, option, ...after])).toBe(false);
    }));
  });

  it("accepts every listed subcommand given only safe options", () => {
    fc.assert(fc.property(
      fc.constantFrom(...SUBCOMMANDS),
      fc.array(fc.constantFrom(...SAFE_OPTIONS), { maxLength: 6 }),
      (subcommand, options) => {
        expect(isReadOnlyGitInvocation(["git", "-C", "/opt/loom", subcommand, ...options])).toBe(true);
      },
    ));
  });

  it("lists git's hidden --exec beside --upload-pack for ls-remote", () => {
    expect(READ_ONLY_GIT_SUBCOMMANDS.get("ls-remote")?.long).toEqual(expect.arrayContaining(["upload-pack", "exec"]));
    expect(READ_ONLY_GIT_SUBCOMMANDS.get("fetch")?.long).toEqual(expect.arrayContaining(["upload-pack"]));
  });
});
