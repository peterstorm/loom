/**
 * core/read-only-git — which `git` invocations write nothing outside the
 * repository's own `.git`, so the subagent authority guard may treat them as
 * reads (`git -C <checkout> fetch` from a checkout holding a protected
 * directory). Examples pin each rule; a property proves no writing option,
 * however abbreviated or placed among the options, is ever accepted.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isReadOnlyGitInvocation, READ_ONLY_GIT_SUBCOMMANDS } from "../../src/core/read-only-git";

const words = (command: string): readonly string[] => command.split(" ");
const readOnly = (command: string): boolean => isReadOnlyGitInvocation(words(command));

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
    ["log --output", "git log --output=machines/a.json"],
    ["an abbreviated --output", "git diff --outp=machines/a.json"],
    ["a bare --output", "git show --output machines/a.json HEAD"],
    ["grep -O", "git grep -O rm x"],
    ["grep -O in a bundle", "git grep -inO rm x"],
    ["grep --open-files-in-pager", "git grep --open-files-in-pager=rm x"],
    ["--ext-diff", "git diff --ext-diff"],
    ["fetch --upload-pack", "git fetch --upload-pack=rm origin"],
    ["fetch -u", "git fetch -u rm origin"],
    ["ls-remote --upload-pack", "git ls-remote --upload-pack=rm origin"],
  ])("does not read: %s", (_label, command) => {
    expect(readOnly(command)).toBe(false);
  });

  it("refuses a word with no static spelling before --, and allows one after it", () => {
    expect(isReadOnlyGitInvocation(["git", "-C", null, "fetch"])).toBe(false);
    expect(isReadOnlyGitInvocation(["git", null, "status"])).toBe(false);
    expect(isReadOnlyGitInvocation(["git", "log", null])).toBe(false);
    expect(isReadOnlyGitInvocation(["git", "log", "--", null])).toBe(true);
  });

  it("never accepts a writing option, in any abbreviation, among otherwise safe options", () => {
    const dangerous = fc.oneof(
      fc.tuple(fc.constantFrom("output", "open-files-in-pager", "ext-diff"), fc.boolean()).chain(([option, withValue]) =>
        fc.integer({ min: 1, max: option.length }).map((length) => `--${option.slice(0, length)}${withValue ? "=x" : ""}`)),
    );
    const safe = fc.constantFrom("--oneline", "-5", "--stat", "HEAD", "-p", "--name-only");
    fc.assert(fc.property(
      fc.constantFrom(...READ_ONLY_GIT_SUBCOMMANDS, "fetch"),
      fc.array(safe, { maxLength: 4 }),
      dangerous,
      fc.array(safe, { maxLength: 4 }),
      (subcommand, before, option, after) => {
        expect(isReadOnlyGitInvocation(["git", "-C", "/opt/loom", subcommand, ...before, option, ...after])).toBe(false);
      },
    ));
  });
});
