/**
 * The one guard a scripted `node:child_process` double applies to a Git
 * spawn: the argv must open with the execution policy's command-scope prefix,
 * and the double records what follows it — the LOGICAL argv the caller asked
 * Git for. The prefix is read from production (`utils/git-command-scope`, a
 * leaf with no imports), so a policy change cannot leave a stale copy here.
 *
 * Load it from inside a `vi.mock("node:child_process", …)` factory with
 * `await import(...)`: the factory is hoisted above static imports, and this
 * module imports nothing that imports the child-process module, so loading it
 * there cannot recurse into the mock being built.
 */
import { COMMAND_SCOPE_ARGV } from "../../src/utils/git-command-scope";

/** The argv after the policy prefix; throws for a spawn outside the policy. */
export function logicalGitArgs(args: readonly string[]): readonly string[] {
  const prefixed = COMMAND_SCOPE_ARGV.every((expected, index) => args[index] === expected);
  if (!prefixed) throw new Error(`git spawned outside the execution policy: ${args.join(" ")}`);
  return args.slice(COMMAND_SCOPE_ARGV.length);
}
