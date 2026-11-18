/**
 * The state-file guard judges what a line can write, not what it mentions
 * (loom#216, following #198 Cause 5). Three halves:
 *
 *  - a line that may rebind a command name never trusts a read-only head, so
 *    `cat(){ rm "$1"; }; cat <state>` cannot pass as a read;
 *  - commands that write nothing are admitted whatever they mention: filters,
 *    loops and bindings over reads, redirects to known unguarded files, and
 *    the GitHub invocations that change only GitHub;
 *  - every write that reaches guarded state stays blocked, however spelled.
 */
import { describe, expect, it } from "vitest";
import { GUARDED, guardDecision } from "../fixtures/guard-decision";

const MARKER = "/tmp/claude-subagents/agent-1.active";

describe("a line that may rebind a command name trusts no read-only head", () => {
  it.each([
    ["a function", `cat(){ rm "$1"; }; cat ${GUARDED}`],
    ["a spaced function", `cat() { rm -f "$1"; }; cat ${GUARDED}`],
    ["the function keyword", `function cat { rm "$1"; }; cat ${GUARDED}`],
    ["an alias", `alias cat=rm; cat ${GUARDED}`],
    ["an alias with expand_aliases", `shopt -s expand_aliases; alias cat=rm; cat ${GUARDED}`],
    ["enable -n", `enable -n echo; echo ${GUARDED}`],
    ["hash -p", `hash -p /bin/rm cat; cat ${GUARDED}`],
    ["a PATH assignment", `PATH=/tmp/evil:$PATH; cat ${GUARDED}`],
    ["a PATH prefix", `PATH=/tmp/evil cat ${GUARDED}`],
    ["an exported PATH", `export PATH=/tmp/evil; cat ${GUARDED}`],
    ["printf -v PATH", `printf -v PATH /tmp/evil; cat ${GUARDED}`],
    ["read PATH", `read PATH <<< /tmp/evil; cat ${GUARDED}`],
    ["BASH_CMDS", `BASH_CMDS[cat]=/bin/rm; cat ${GUARDED}`],
    ["a preloaded library", `LD_PRELOAD=/tmp/evil.so cat ${GUARDED}`],
    ["an inserted dylib", `export DYLD_INSERT_LIBRARIES=/tmp/evil.dylib; cat ${GUARDED}`],
    ["source", `source /tmp/defs.sh; cat ${GUARDED}`],
    ["dot", `. /tmp/defs.sh; cat ${GUARDED}`],
    ["eval of runtime text", `eval "$DEFS"; cat ${GUARDED}`],
    ["eval of a literal definition", `eval 'cat(){ rm "$1"; }'; cat ${GUARDED}`],
  ])("blocks: %s", (_name, command) => {
    expect(guardDecision(command)).toBe("block");
  });

  it("a plain read of PATH rebinds nothing", () => {
    expect(guardDecision(`echo "$PATH"; cat ${GUARDED}`)).toBe("allow");
  });
});

describe("commands that write nothing are admitted whatever they mention", () => {
  it.each([
    ["sort and uniq in a pipe", `grep -o x ${GUARDED} | sort -u | uniq -c | head`],
    ["sort with keys", `jq -r '.tasks[].id' ${GUARDED} | sort -t, -k2,2nr`],
    ["comm, tac, rev, paste, column", `cat ${GUARDED} | rev | tac | paste -sd, | column -t`],
    ["find with prune and print", "find . -path ./.claude/state -prune -o -type f -print"],
    ["a for loop over reads", `for f in ${GUARDED} ${MARKER}; do cat "$f"; done`],
    ["a while loop reading state", `while read -r line; do echo "$line"; done < ${GUARDED}`],
    ["an if over a read", `if grep -q T1 ${GUARDED}; then echo yes; else echo no; fi`],
    ["a group over reads", `{ cat ${GUARDED}; ls /tmp/claude-subagents; }`],
    ["a binding used by a read", `F=${GUARDED}; jq . "$F"`],
    ["a note binding", `N="Earlier attempts failed on ${GUARDED}, now exempt."; echo "$N"`],
    ["a read redirected to a scratch file", `jq . ${GUARDED} > /tmp/scratch/graph.json`],
    ["a printf appended to .gitignore", "printf '.claude/state/\\n' >> .gitignore"],
    ["a loop redirected to a scratch file", `for f in ${GUARDED}; do cat "$f"; done > /tmp/scratch/all.txt`],
    ["git check-ignore", `git check-ignore -v ${GUARDED}`],
    ["gh issue close with a comment", `gh issue close 198 -R o/r --reason completed --comment "see ${MARKER}"`],
    ["gh with a token prefix", `GH_TOKEN=abc gh pr create --title t --body "mentions ${GUARDED}"`],
    ["gh with a substituted token", `GH_TOKEN=$(gh auth token) gh issue comment 1 --body "${MARKER}"`],
    ["gh pr review", `gh pr review 1 --comment --body "${GUARDED}"`],
    ["a helper's own state redirect on a binding line", `F=x; bun cli.ts helper set-phase execute > ${GUARDED}`],
  ])("allows: %s", (_name, command) => {
    expect(guardDecision(command)).toBe("allow");
  });
});

describe("every write that reaches guarded state stays blocked", () => {
  it.each([
    ["sort -o", `sort -o ${GUARDED} /tmp/x`],
    ["sort --output", `cat /tmp/x | sort --output=${GUARDED}`],
    ["sort -o bundled", `sort -uo ${GUARDED} /tmp/x`],
    ["sort -T into a guarded dir", `sort -T .claude/state ${GUARDED}`],
    ["sort --compress-program", `sort --compress-program=sh ${GUARDED}`],
    ["uniq with an output operand", `uniq /tmp/x ${GUARDED}`],
    ["find -delete", "find .claude/state -name '*.json' -delete"],
    ["find -exec", "find .claude/state -exec rm {} +"],
    ["find -fprint", "find . -path ./.claude/state -fprint .claude/state/x"],
    ["find with a runtime word", `find .claude/state $ACTION`],
    ["a loop writing state", `for f in ${GUARDED}; do rm "$f"; done`],
    ["a loop binding PATH", `for PATH in /tmp/evil; do cat ${GUARDED}; done`],
    ["a binding reaching rm", `F=${GUARDED}; rm "$F"`],
    ["a binding reaching a redirect", `F=${GUARDED}; echo x > "$F"`],
    ["a binding reaching an unrelated chain", `F=${MARKER}; touch "$F"`],
    ["a binding of IFS", `IFS=/; cat ${GUARDED}`],
    ["a relative target after cd", `cd .claude && jq . state/active_task_graph.json > state/x.json`],
    ["a relative target after pushd", `pushd /tmp; jq . ${GUARDED} > out.json`],
    ["a dot-segment target", `jq . ${GUARDED} > .claude/./state/x.json`],
    ["a doubled-slash target", `jq . ${GUARDED} > .claude//state/x.json`],
    ["a dot-dot target", `jq . ${GUARDED} > .claude/x/../state/x.json`],
    ["a redirect to state", `echo x > ${GUARDED}`],
    ["an append to state", `printf x >> ${GUARDED}`],
    ["a quote-split redirect target", `echo x > .cl'aude'/state/active_task_graph.json`],
    ["a glob redirect target", `jq . ${GUARDED} > .claude/stat*/x.json`],
    ["a brace redirect target", `jq . ${GUARDED} > /tmp/{a,b}.json`],
    ["a runtime redirect target", `jq . ${GUARDED} > "$OUT"`],
    ["a home redirect target", `jq . ${GUARDED} > ~/x.json`],
    ["a file dup", `echo x >&${GUARDED}`],
    ["a read-write open", `cat <> ${GUARDED}`],
    ["a redirect to the marker", `echo x > ${MARKER}`],
    ["a helper redirect through a binding", `F=${MARKER}; bun cli.ts helper set-phase execute > "$F"`],
    ["a non-read-only head", `touch ${GUARDED}`],
    ["a group redirected into state", `{ echo x; } > ${GUARDED}`],
    ["gh with a pager prefix", `GH_PAGER=sh gh pr view 1 --comments "${GUARDED}"`],
    ["gh with a mixed prefix", `GH_TOKEN=a GH_BROWSER=sh gh pr view 1 "${GUARDED}"`],
    ["gh pr checkout", `GH_TOKEN=a gh pr checkout "${GUARDED}"`],
    ["gh pr close", `gh pr close 1 --delete-branch --comment "${GUARDED}"`],
  ])("blocks: %s", (_name, command) => {
    expect(guardDecision(command)).toBe("block");
  });
});
