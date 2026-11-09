/**
 * READ_ONLY_STATE_COMMANDS is a deny-by-default allowlist whose membership
 * criterion — "cannot write a file under ANY flag combination" — used to live
 * only in prose. These tests pin each documented exclusion at the interface
 * the guard actually consults (hasReadOnlyHead), and through the state-file
 * guard decision for the exclusion that was once a member (`file`).
 */
import { describe, expect, it } from "vitest";
import { READ_ONLY_STATE_COMMANDS } from "../../src/core/tool-vocabulary";
import { hasReadOnlyHead } from "../../src/core/shell-command-head";
import { guardStateFileDecision } from "../../src/core/guard-state-file";

const GUARDED = ".claude/state/active_task_graph.json";

const guardDecision = (command: string): "allow" | "block" =>
  guardStateFileDecision(command).kind === "block" ? "block" : "allow";

describe("READ_ONLY_STATE_COMMANDS — documented exclusions stay excluded", () => {
  it.each([
    ["sort", "sort -o out in"],
    ["uniq", "uniq in out"],
    ["less", "less -o log in"],
    ["xxd", "xxd -r dump out"],
    ["base64", "base64 -o out in"],
    ["file", "file -C -m magic"],
    ["sed", "sed -i s/a/b/ f"],
    ["awk", "awk '{print > \"f\"}' in"],
    ["find", "find . -delete"],
    ["git", "git checkout -- f"],
    ["touch", "touch f"],
    ["rg", "rg --pre ./x pat"],
    ["more", "more f"],
    ["cd", "cd .claude/state"],
    ["env", "env rm f"],
    ["xargs", "xargs rm"],
    ["sudo", "sudo rm f"],
    ["timeout", "timeout 5 rm f"],
    ["nohup", "nohup rm f"],
    ["nice", "nice rm f"],
    ["command", "command rm f"],
    ["bash", "bash -c 'rm f'"],
    ["sh", "sh -c 'rm f'"],
  ])("%s is not a read-only head (%s)", (name, segment) => {
    expect(READ_ONLY_STATE_COMMANDS.has(name)).toBe(false);
    expect(hasReadOnlyHead(segment)).toBe(false);
  });

  it("blocks `file -C` against a guarded path — it writes a compiled magic database", () => {
    expect(guardDecision(`file -C -m ${GUARDED}`)).toBe("block");
    expect(guardDecision(`file ${GUARDED}`)).toBe("block");
  });

  it("still allows a member read of a guarded path", () => {
    expect(guardDecision(`cat ${GUARDED}`)).toBe("allow");
  });
});

describe("hasReadOnlyHead — the head is the literal first word, resolved like analyzeCommandHead's", () => {
  it.each([
    ["a plain member", "cat f"],
    ["an env prefix", "CI=1 jq . f"],
    ["a quoted head", `"cat" f`],
    ["an escaped head (bash runs cat)", "\\cat f"],
    ["an escape inside the head", "c\\at f"],
    ["the [[ test compound", "[[ -f f ]]"],
  ])("%s is read-only", (_name, segment) => {
    expect(hasReadOnlyHead(segment)).toBe(true);
  });

  it.each([
    // A function definition: the body is the write; skipping the `name()`
    // prefix the way analyzeCommandHead does would read it as a `cat` read.
    ["a function definition named like a member", "cat() { rm f"],
    ["a subshell", "( cat f"],
    ["a brace group", "{ cat f"],
    ["a negation", "! cat f"],
    ["a path-qualified member", "./cat f"],
    ["a quoted word that only starts with a member", `'cat f'`],
    ["a pure assignment", "F=active_task_graph.json"],
    ["an empty segment", ""],
  ])("%s is not read-only", (_name, segment) => {
    expect(hasReadOnlyHead(segment)).toBe(false);
  });

  it("blocks a guarded function definition whose name shadows a member", () => {
    expect(guardDecision(`cat() { rm ${GUARDED}; }; cat`)).toBe("block");
  });
});
