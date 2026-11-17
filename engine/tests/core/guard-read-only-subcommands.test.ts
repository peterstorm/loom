/**
 * loom#198, Cause 5: read-only `git` and `gh` invocations may name guarded
 * state in their arguments (a pattern, a pathspec, a PR body) without being
 * blocked, while every form that writes a file or runs a program stays
 * blocked. The classifiers are `read-only-git.ts` and `read-only-gh.ts`,
 * reached through `isReadOnlySubcommandInvocation`; the decision is the
 * state-file guard's, unchanged otherwise.
 */
import { describe, expect, it } from "vitest";
import { isReadOnlySubcommandInvocation } from "../../src/core/shell-command-head";
import { staticSpelling } from "../../src/core/shell-match-views";
import { isReadOnlyGhInvocation } from "../../src/core/read-only-gh";
import { GUARDED, guardDecision } from "../fixtures/guard-decision";

describe("read-only git and gh invocations that mention guarded state", () => {
  it.each([
    `git grep -n "active_task_graph" -- src`,
    `git log --oneline -- ${GUARDED}`,
    `git --no-pager diff HEAD~1 -- ${GUARDED}`,
    `git show HEAD:${GUARDED}`,
    `git status --short ${GUARDED}`,
    `git ls-files ${GUARDED}`,
    `git log --no-textconv --no-ext-diff -p -- ${GUARDED}`,
    `gh pr create --title "fix" --body "the guard read ${GUARDED} as a write"`,
    `gh issue comment 198 --body "mentions .claude/state"`,
    `gh pr view 203 --json body --jq .body | grep active_task_graph`,
    `gh api repos/o/r/issues/198 --jq .body | grep "${GUARDED}"`,
    `git log --format=%H -- ${GUARDED} | head -1`,
    // What a repository's own configuration runs (textconv, filters) is outside a
    // command-text guard (read-only-git.ts); `-C` only scopes this read.
    `git show --textconv HEAD:${GUARDED}`,
    `git -C .claude/state log --oneline`,
  ])("allows %s", (command) => {
    expect(guardDecision(command)).toBe("allow");
  });
});

describe("git and gh forms that write a file or run a program stay blocked", () => {
  it.each([
    [`git checkout -- ${GUARDED}`, "a subcommand that rewrites the work tree"],
    [`git restore ${GUARDED}`, "a subcommand that rewrites the work tree"],
    [`git 'checkout' -- ${GUARDED}`, "a quoted unlisted subcommand"],
    [`git -c core.pager=sh log -- ${GUARDED}`, "a global option that sets config"],
    [`GIT_EXTERNAL_DIFF=./x git diff -- ${GUARDED}`, "an environment prefix"],
    [`git log --output=${GUARDED}`, "--output writes a file"],
    [`git log '--output'=${GUARDED}`, "a quoted --output"],
    [`git diff --outp=${GUARDED}`, "an abbreviated --output"],
    [`git grep -nO active_task_graph`, "-O bundled after another short option"],
    [`gh pr view 1 --web --body "${GUARDED}"`, "gh --web runs a browser"],
    [`git diff --ext-diff -- ${GUARDED}`, "--ext-diff runs a program"],
    [`git grep -Orm active_task_graph`, "-O runs a program on each match"],
    [`git log -- ${GUARDED} > ${GUARDED}`, "an output redirect"],
    [`git log -- ${GUARDED} | sh`, "a pipe into a shell"],
    [`gh pr checkout 1 && rm ${GUARDED}`, "a write in the same line"],
    [`gh run download 1 --dir .claude/state`, "a gh verb that writes local files"],
    [`gh alias set x '!rm ${GUARDED}'`, "a gh alias, which can run a shell"],
    [`gh pr merge 1 --body "${GUARDED}"`, "a gh verb that can switch branches"],
    [`\\git checkout -- ${GUARDED}`, "an escaped head"],
    [`git log "--out"put=${GUARDED}`, "an option assembled from quoted parts"],
    [`git log {--output=${GUARDED},-p}`, "a brace expansion that yields an option"],
    [`git log $OUT -- ${GUARDED}`, "a parameter that could expand to an option"],
    [`git log "$OUT" -- ${GUARDED}`, "a quoted parameter that could expand to an option"],
    [`git log $(printf -- --output=${GUARDED})`, "a substitution whose output could be an option"],
    [`git log \`printf -- --output=${GUARDED}\``, "a backtick substitution"],
    [`git log --outpu?=${GUARDED}`, "a glob that could match an option-named file"],
  ])("blocks %s (%s)", (command) => {
    expect(guardDecision(command)).toBe("block");
  });
});

describe("staticSpelling", () => {
  it.each<[string, string | null]>([
    ["plain", "plain"],
    ["'--output'=x", "--output=x"],
    ['"a b"c', "a bc"],
    ["\\-O", "-O"],
    ["'$HOME'", null],
    ['"$HOME"', null],
    ["$HOME", null],
    ["{a,b}", null],
    ["*.ts", null],
    ["active_task_graph__subst__", null],
    ["∗", null],
  ])("reads %s as %s", (word, literal) => {
    expect(staticSpelling(word)).toBe(literal);
  });
});

describe("isReadOnlyGhInvocation: options that run a program the environment names", () => {
  const spelled = (command: string) => command.split(" ");
  it.each([
    "gh pr create -w", "gh pr view 1 --we", "gh pr view 1 -Rw", "gh pr view 1 --web",
    "gh pr comment 1 --editor", "gh issue create -e", "gh issue comment 1 --edit", "gh pr create -te",
  ])("refuses %s", (command) => {
    expect(isReadOnlyGhInvocation(spelled(command))).toBe(false);
  });

  it.each(["gh pr view 1 -- --web", "gh pr view 1 --jq .web", "gh pr create --title t --body b", "gh api /repos/o/r"])("admits %s", (command) => {
    expect(isReadOnlyGhInvocation(spelled(command))).toBe(true);
  });

  it("admits only listed group and verb pairs", () => {
    expect(isReadOnlyGhInvocation(spelled("gh pr merge 1"))).toBe(false);
    expect(isReadOnlyGhInvocation(spelled("gh api"))).toBe(true);
    expect(isReadOnlyGhInvocation(spelled("gh repo clone o/r"))).toBe(false);
    expect(isReadOnlyGhInvocation(["gh", "pr", null])).toBe(false);
  });
});

describe("isReadOnlySubcommandInvocation", () => {
  it("admits exactly the listed invocations", () => {
    expect(isReadOnlySubcommandInvocation("git grep x")).toBe(true);
    expect(isReadOnlySubcommandInvocation("git --no-pager log")).toBe(true);
    expect(isReadOnlySubcommandInvocation("gh pr view 1")).toBe(true);
    expect(isReadOnlySubcommandInvocation("gh api /user")).toBe(true);
    expect(isReadOnlySubcommandInvocation("git")).toBe(false);
    expect(isReadOnlySubcommandInvocation("gh pr")).toBe(false);
    expect(isReadOnlySubcommandInvocation("gh pr checkout 1")).toBe(false);
    expect(isReadOnlySubcommandInvocation("./git log")).toBe(false);
    expect(isReadOnlySubcommandInvocation("FOO=1 gh pr view 1")).toBe(false);
  });
});
