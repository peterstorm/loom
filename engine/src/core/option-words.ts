/**
 * How a command's option words are read, the primitives every read-only
 * classifier (`read-only-git.ts`, `read-only-filters.ts`) judges options with.
 * Pure: words in, a verdict out. Each matcher errs toward "this names the
 * option", so a classifier that refuses an option also refuses every spelling
 * of it the command would accept.
 */

/** Does `--name[=value]` spell, or abbreviate, one of `options`? Long options
 *  are accepted by any unambiguous prefix (getopt_long, git's parse-options). */
export function namesLongOption(word: string, options: readonly string[]): boolean {
  if (!word.startsWith("--")) return false;
  const name = word.slice(2).split("=")[0] as string;
  return options.some((option) => option.startsWith(name));
}

/** Does a bundle of short options (`-inO`) hold one of `letters`? */
export const bundles = (word: string, letters: readonly string[]): boolean =>
  /^-[A-Za-z]/.test(word) && letters.some((letter) => word.includes(letter));

/** A command's arguments split at the first `--`: the words that may be
 *  options, and the operands after it. */
export type OptionSplit = Readonly<{ options: readonly string[]; operands: readonly string[] }>;

export function splitAtEndOfOptions(args: readonly string[]): OptionSplit {
  const end = args.indexOf("--");
  return end === -1 ? { options: args, operands: [] } : { options: args.slice(0, end), operands: args.slice(end + 1) };
}
