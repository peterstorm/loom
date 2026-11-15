/**
 * core/subagent-authority (#177) — the guard judges each segment only in the
 * directories it may run in, following the line's `cd`s and separators. The
 * property: that set is SOUND. For any chain of `cd`/`pushd`/`popd`/`true`/
 * `false` joined by `&&`, `||`, `;`, `|` and `&`, a `rm -rf .` at its end is
 * refused whenever bash would really run it in a directory that holds a
 * protected one.
 *
 * The oracle is a small bash interpreter over a fixed directory tree: exit
 * statuses, `&&`/`||` short-circuiting on the last status, pipelines and
 * background jobs running in subshells, `OLDPWD` and the directory stack. It computes where the command RUNS; the guard computes
 * where it MAY run without executing anything. Precision is the example
 * tests' job (tests/core/subagent-authority.test.ts); this file only proves
 * nothing real is missed.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { posix } from "node:path";
import { LEXICAL_FILESYSTEM, decideSubagentAuthority, type SubagentAuthorityContext } from "../../src/core/subagent-authority";
import { AUTHORITY_HELPER_OPERATIONS, HARNESS_HOOK_ROUTES } from "../../src/handlers/pre-tool-use/subagent-authority-operations";

const START = "/start";
const DIRECTORIES: ReadonlySet<string> = new Set(["/", START, "/start/b", "/a", "/a/b", "/b"]);

const COMMANDS = [
  "cd /a", "cd /b", "cd /missing", "cd b", "cd ./b", "cd ..", "cd", "cd -",
  "pushd /a >/dev/null", "pushd /missing", "popd >/dev/null", "builtin cd /b",
  "true", "false",
] as const;
type Command = (typeof COMMANDS)[number];
type Separator = "&&" | "||" | ";" | "|" | "&";

type Shell = Readonly<{ cwd: string; oldpwd: string | null; stack: readonly string[]; status: 0 | 1 }>;

/** One command's effect, as bash runs it. `cd` with no operand goes home, which this tree lacks. */
function run(shell: Shell, command: Command): Shell {
  const failed: Shell = { ...shell, status: 1 };
  const moveTo = (target: string, stack: readonly string[] = shell.stack): Shell =>
    DIRECTORIES.has(target) ? { cwd: target, oldpwd: shell.cwd, stack, status: 0 } : failed;
  const words = command.replace(" >/dev/null", "").replace(/^builtin /, "").split(" ");
  const [head, operand] = [words[0], words[1]];
  if (head === "true") return { ...shell, status: 0 };
  if (head === "false") return failed;
  if (head === "popd") return shell.stack.length === 0 ? failed : moveTo(shell.stack[0], shell.stack.slice(1));
  if (head === "pushd") return moveTo(posix.resolve(shell.cwd, operand), [shell.cwd, ...shell.stack]);
  if (operand === undefined) return moveTo("/home/u");
  if (operand === "-") return shell.oldpwd === null ? failed : moveTo(shell.oldpwd);
  return moveTo(posix.resolve(shell.cwd, operand));
}

/**
 * Where the final segment runs, or null when the separators skip it. `|` joins
 * commands into one pipeline and `&` backgrounds one: either way each command
 * runs in a subshell, so its `cd` moves nothing. A pipeline runs or is skipped
 * as a whole, on the separator before it; its status is its last command's,
 * and a backgrounded one's is 0.
 */
function finalDirectory(commands: readonly Command[], separators: readonly Separator[]): string | null {
  const final = commands.length; // the index of the trailing `rm -rf .`
  const pipelines: number[][] = [];
  for (let index = 0; index <= final; index++) {
    if (index > 0 && separators[index - 1] === "|") pipelines[pipelines.length - 1].push(index);
    else pipelines.push([index]);
  }
  let shell: Shell = { cwd: START, oldpwd: null, stack: [], status: 0 };
  let ranIn: string | null = null;
  for (const pipeline of pipelines) {
    const before = pipeline[0] === 0 ? ";" : separators[pipeline[0] - 1];
    const runs = before === ";" || before === "&" || (before === "&&" ? shell.status === 0 : shell.status !== 0);
    if (!runs) continue;
    if (pipeline.includes(final)) ranIn = shell.cwd;
    const last = pipeline[pipeline.length - 1];
    if (last === final) break;
    const backgrounded = separators[last] === "&";
    if (pipeline.length === 1 && !backgrounded) shell = run(shell, commands[last]);
    else shell = { ...shell, status: backgrounded ? 0 : run(shell, commands[last]).status };
  }
  return ranIn;
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
    }), { numRuns: 2000 });
  });

  it("the oracle agrees with the narrowing the example tests pin", () => {
    expect(finalDirectory(["cd /a"], ["&&"])).toBe("/a");
    expect(finalDirectory(["cd /missing"], ["||"])).toBe(START);
    expect(finalDirectory(["cd /missing", "true"], ["&&", "||"])).toBe(START);
    expect(finalDirectory(["true", "true"], ["&&", "||"])).toBe(null);
    expect(finalDirectory(["true", "cd /a"], ["||", "&&"])).toBe(START);
    expect(finalDirectory(["cd /a"], ["|"])).toBe(START);
    expect(finalDirectory(["cd /a", "true"], ["&", "&&"])).toBe(START);
    expect(finalDirectory(["false", "true"], ["|", "&&"])).toBe(START);
    expect(decideSubagentAuthority(line(["cd /a"], ["&&"]), protecting(START)).kind).toBe("allow");
  });
});
