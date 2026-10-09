/**
 * A `git` executable stand-in that a suite puts first on PATH to inject one
 * fault into the engine's policy-bound Git children.
 *
 * Every engine Git child runs under the execution policy: its argv opens with
 * the command-scope prefix and its environment is allow-listed, so the shim
 * can neither read its configuration from the environment nor match the
 * caller's command at fixed argv positions. The generator reads the prefix
 * from its owner (`policyBoundGitArgv` in `utils/git-command-scope`), strips
 * it, and dispatches on the LOGICAL argv the engine asked Git for; a policy
 * change therefore cannot leave a stale position here. Every path the shim
 * embeds is quoted as one shell word, so a path containing a quote is safe.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { policyBoundGitArgv } from "../../src/utils/git-command-scope";
import { withEnvOverlay } from "./env-overlay";

/** `value` as one single-quoted POSIX shell word, whatever characters it holds. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The fault a shim injects: when a policy-bound child's logical argv opens
 * with `command`, the shim runs `script` first. Inside `script`, `"$@"` is the
 * logical argv, `policy_git` runs Git under the policy prefix (the child
 * exactly as the engine asked for it) and `real_git` runs Git with its
 * arguments as given. A `script` that does not exit falls through to running
 * the child unchanged.
 */
export type GitShimFault = Readonly<{ command: readonly string[]; script: string }>;

/** A shell condition: the positional parameters open with `words`. */
function argvOpensWith(words: readonly string[]): string {
  return [`[ "$#" -ge ${words.length} ]`, ...words.map((word, index) => `[ "\${${index + 1}}" = ${shellQuote(word)} ]`)].join(" && ");
}

/** The shim's source for the Git binary at `realGit`. Pure. */
export function gitShimScript(realGit: string, fault: GitShimFault): string {
  const prefix = policyBoundGitArgv([]);
  const git = shellQuote(realGit);
  const policyGit = [git, ...prefix.map(shellQuote)].join(" ");
  return [
    "#!/bin/sh",
    `real_git() { ${git} "$@"; }`,
    `policy_git() { ${policyGit} "$@"; }`,
    `if ${argvOpensWith(prefix)}; then`,
    `  shift ${prefix.length}`,
    `  if ${argvOpensWith(fault.command)}; then`,
    ...fault.script.split("\n").map((line) => `    ${line}`),
    "  fi",
    `  exec ${policyGit} "$@"`,
    "fi",
    `exec ${git} "$@"`,
    "",
  ].join("\n");
}

/**
 * Write the shim for `fault` into `directory` (created), resolving the real
 * Git from the current PATH, and run `operation` with `directory` first on
 * PATH — restored afterwards, including on rejection.
 */
export async function withGitShim<T>(directory: string, fault: GitShimFault, operation: () => T | Promise<T>): Promise<T> {
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  if (realGit === "") throw new Error("git is not on PATH; the shim has nothing to stand in for");
  mkdirSync(directory, { recursive: true });
  const shim = join(directory, "git");
  writeFileSync(shim, gitShimScript(realGit, fault));
  chmodSync(shim, 0o755);
  return withEnvOverlay({ PATH: `${directory}:${process.env.PATH ?? ""}` }, operation);
}
