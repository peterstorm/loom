/**
 * core/subagent-authority (#177) — the guard judges each segment only in the
 * directories it may run in, following the line's `cd`s and separators. The
 * property: that set is SOUND. For any chain of `cd`/`pushd`/`popd`, variable
 * and `HOME` assignments, `true` and `false` joined by `&&`, `||`, `;`, `|` and
 * `&`, a `rm -rf .` at its end is refused whenever bash would really run it in
 * a directory that holds a protected one.
 *
 * The oracle is a small bash interpreter over a fixed directory tree: exit
 * statuses, `&&`/`||` short-circuiting on the last status, pipelines running
 * each command in a subshell, `&` backgrounding the whole `&&`/`||` list
 * before it, `OLDPWD`, the directory stack (`pushd -n` edits it without
 * moving), `$T` and `HOME`. It computes where the command RUNS; the guard
 * computes where it MAY run without executing anything. Precision is the
 * example tests' job (tests/core/subagent-authority.test.ts); this file only
 * proves nothing real is missed.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { posix } from "node:path";
import { LEXICAL_FILESYSTEM, decideSubagentAuthority, type SubagentAuthorityContext } from "../../src/core/subagent-authority";
import { AUTHORITY_HELPER_OPERATIONS, HARNESS_HOOK_ROUTES } from "../../src/handlers/pre-tool-use/subagent-authority-operations";

const START = "/start";
const DIRECTORIES: ReadonlySet<string> = new Set(["/", START, "/start/b", "/a", "/a/b", "/b"]);

const COMMANDS = [
  "cd /a", "cd /b", "cd /missing", "cd b", "cd ./b", "cd ..", "cd", "cd -", "cd ~",
  "pushd /a >/dev/null", "pushd /missing", "pushd -n /a", "popd >/dev/null", "builtin cd /b",
  "T=/a", "T=/missing", "cd $T", "HOME=/b",
  "true", "false",
] as const;
type Command = (typeof COMMANDS)[number];
type Separator = "&&" | "||" | ";" | "|" | "&";

type Shell = Readonly<{
  cwd: string;
  oldpwd: string | null;
  stack: readonly string[];
  status: 0 | 1;
  t: string | undefined;
  home: string;
}>;

const INITIAL: Shell = { cwd: START, oldpwd: null, stack: [], status: 0, t: undefined, home: "/home/u" };

/** One command's effect, as bash runs it. The initial home is not in the tree. */
function run(shell: Shell, command: Command): Shell {
  const failed: Shell = { ...shell, status: 1 };
  const moveTo = (target: string, stack: readonly string[] = shell.stack): Shell =>
    DIRECTORIES.has(target) ? { ...shell, cwd: target, oldpwd: shell.cwd, stack, status: 0 } : failed;
  if (command === "T=/a" || command === "T=/missing") return { ...shell, t: command.slice(2), status: 0 };
  if (command === "HOME=/b") return { ...shell, home: "/b", status: 0 };
  const words = command.replace(" >/dev/null", "").replace(/^builtin /, "").split(" ");
  const [head, operand] = [words[0], words[1] === "$T" ? shell.t : words[1] === "~" ? shell.home : words[1]];
  if (head === "true") return { ...shell, status: 0 };
  if (head === "false") return failed;
  if (head === "popd") return shell.stack.length === 0 ? failed : moveTo(shell.stack[0], shell.stack.slice(1));
  if (head === "pushd" && operand === "-n") return { ...shell, stack: [words[2], ...shell.stack], status: 0 };
  if (head === "pushd") return moveTo(posix.resolve(shell.cwd, operand!), [shell.cwd, ...shell.stack]);
  if (operand === undefined) return moveTo(shell.home);
  if (operand === "-") return shell.oldpwd === null ? failed : moveTo(shell.oldpwd);
  return moveTo(posix.resolve(shell.cwd, operand));
}

/** One `&&`/`||` list: its pipelines (indices into the line), the operators
 *  joining them, and whether `&` sends the whole list to the background. */
type AndOrList = Readonly<{ pipelines: readonly (readonly number[])[]; joins: readonly ("&&" | "||")[]; background: boolean }>;

function andOrLists(length: number, separators: readonly Separator[]): readonly AndOrList[] {
  const lists: AndOrList[] = [];
  let pipelines: number[][] = [[0]];
  let joins: ("&&" | "||")[] = [];
  for (let index = 1; index < length; index++) {
    const separator = separators[index - 1];
    if (separator === "|") pipelines[pipelines.length - 1].push(index);
    else if (separator === "&&" || separator === "||") { joins.push(separator); pipelines.push([index]); }
    else {
      lists.push({ pipelines, joins, background: separator === "&" });
      pipelines = [[index]];
      joins = [];
    }
  }
  return [...lists, { pipelines, joins, background: false }];
}

/**
 * Where the final segment (the trailing `rm -rf .`) runs, or null when the
 * separators skip it. A list's pipelines run on the status before them; a
 * pipeline of several commands runs each in a subshell (its status is its last
 * command's); a backgrounded list runs in a subshell and leaves status 0.
 */
function finalDirectory(commands: readonly Command[], separators: readonly Separator[]): string | null {
  const final = commands.length;
  let shell = INITIAL;
  for (const list of andOrLists(final + 1, separators)) {
    let local = shell;
    let ranIn: string | null = null;
    list.pipelines.forEach((pipeline, position) => {
      const join = position === 0 ? null : list.joins[position - 1];
      if (join === "&&" && local.status !== 0) return;
      if (join === "||" && local.status === 0) return;
      if (pipeline.includes(final)) ranIn = local.cwd;
      const last = pipeline[pipeline.length - 1];
      if (last === final) return;
      local = pipeline.length === 1 ? run(local, commands[last]) : { ...local, status: run(local, commands[last]).status };
    });
    if (list.pipelines.some((pipeline) => pipeline.includes(final))) return ranIn;
    shell = list.background ? { ...shell, status: 0 } : local;
  }
  return null;
}

/** A context whose one protected directory lies directly inside `directory`. */
const protecting = (directory: string): SubagentAuthorityContext => ({
  cwd: START,
  home: "/home/u",
  runs: { kind: "known", directories: [] },
  protectedDirectories: [posix.join(directory, "protected")],
  helperOperations: AUTHORITY_HELPER_OPERATIONS,
  hookRoutes: HARNESS_HOOK_ROUTES,
  readOnlyScripts: [],
  cdSearchPath: [],
  filesystem: LEXICAL_FILESYSTEM,
});

const line = (commands: readonly Command[], separators: readonly Separator[]): string =>
  commands.map((command, index) => `${command} ${separators[index]} `).join("") + "rm -rf .";

const chains = fc.integer({ min: 1, max: 6 }).chain((length) => fc.tuple(
  fc.array(fc.constantFrom(...COMMANDS), { minLength: length, maxLength: length }),
  fc.array(fc.constantFrom<Separator>("&&", "||", ";", "|", "&"), { minLength: length, maxLength: length }),
));

describe("the directories a segment is judged in are sound (#177)", () => {
  it("refuses `rm -rf .` wherever bash would run it beside a protected directory", () => {
    fc.assert(fc.property(chains, ([commands, separators]) => {
      const ranIn = finalDirectory(commands, separators);
      fc.pre(ranIn !== null);
      const decision = decideSubagentAuthority(line(commands, separators), protecting(ranIn!));
      expect(decision.kind, `${line(commands, separators)} ran in ${ranIn}`).toBe("refuse");
    }), { numRuns: 3000 });
  });

  it("the oracle agrees with bash on the cases the example tests pin", () => {
    expect(finalDirectory(["cd /a"], ["&&"])).toBe("/a");
    expect(finalDirectory(["cd /missing"], ["||"])).toBe(START);
    expect(finalDirectory(["cd /missing", "true"], ["&&", "||"])).toBe(START);
    expect(finalDirectory(["true", "true"], ["&&", "||"])).toBe(null);
    expect(finalDirectory(["true", "cd /a"], ["||", "&&"])).toBe(START);
    expect(finalDirectory(["cd /a"], ["|"])).toBe(START);
    expect(finalDirectory(["cd /a", "true"], ["&", "&&"])).toBe(START);
    expect(finalDirectory(["false", "true"], ["|", "&&"])).toBe(START);
    // `&` backgrounds the whole `cd /a && true` list.
    expect(finalDirectory(["cd /a", "true"], ["&&", "&"])).toBe(START);
    expect(finalDirectory(["pushd -n /a"], ["&&"])).toBe(START);
    expect(finalDirectory(["pushd -n /a", "popd >/dev/null"], ["&&", "&&"])).toBe("/a");
    expect(finalDirectory(["T=/a", "cd $T"], [";", "&&"])).toBe("/a");
    expect(finalDirectory(["HOME=/b", "cd"], [";", "&&"])).toBe("/b");
    expect(decideSubagentAuthority(line(["cd /a"], ["&&"]), protecting(START)).kind).toBe("allow");
  });
});
