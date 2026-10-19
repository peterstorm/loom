/**
 * Which files are lint rule code: the one definition the loader and the Wave
 * Gate's runtime-skew check (issue #57 D6) both read.
 *
 * A Loom checkout carries two rule trees. Declarative rules are the top-level
 * `*.json` files of `lint-rules/` (the loader reads exactly those, through
 * `readFileSync`, so a symlinked file counts as its target). Programmatic
 * rules are the TypeScript modules under `engine/src/linter/`, imported as
 * code, so symlinks resolve there too.
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

/** The declarative rules directory, relative to a checkout root. */
export const DECLARATIVE_RULES_DIRECTORY = "lint-rules";

/** The programmatic linter, relative to a checkout root: a repository that carries it is a Loom checkout. */
export const PROGRAMMATIC_RULES_DIRECTORY = join("engine", "src", "linter");

/** Reserved for programmatic rule configuration; never a declarative rule. */
const PROGRAMMATIC_CONFIG_FILE = "config.json";

/** A declarative rule file name, exactly as the loader admits one. */
export function isDeclarativeRuleFile(name: string): boolean {
  return name.endsWith(".json") && name !== PROGRAMMATIC_CONFIG_FILE;
}

/** `read()`, or `undefined` when its target is absent: ENOENT means "none", anything else propagates. */
function unlessAbsent<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Every `.ts` file under `directory`, following symlinks as an import would, visiting each real directory once. */
function programmaticRuleFiles(root: string, directory: string, visited: Set<string>): readonly string[] {
  const real = realpathSync(join(root, directory));
  if (visited.has(real)) return [];
  visited.add(real);
  return readdirSync(join(root, directory)).sort().flatMap((name) => {
    const relative = join(directory, name);
    const target = statSync(join(root, relative));
    if (target.isDirectory()) return programmaticRuleFiles(root, relative, visited);
    return target.isFile() && name.endsWith(".ts") ? [relative] : [];
  });
}

/**
 * The root-relative paths of every lint rule file `root` carries, or `null`
 * when it carries no programmatic linter (it is not a Loom checkout). A
 * missing `lint-rules/` beside a present linter contributes no declarative
 * files. Unreadable trees throw.
 */
export function lintRuleSourceFiles(root: string): readonly string[] | null {
  if (unlessAbsent(() => statSync(join(root, PROGRAMMATIC_RULES_DIRECTORY))) === undefined) return null;
  const declarative = (unlessAbsent(() => readdirSync(join(root, DECLARATIVE_RULES_DIRECTORY))) ?? [])
    .filter(isDeclarativeRuleFile)
    .sort()
    .map((name) => join(DECLARATIVE_RULES_DIRECTORY, name));
  return Object.freeze([...declarative, ...programmaticRuleFiles(root, PROGRAMMATIC_RULES_DIRECTORY, new Set())]);
}
