/**
 * Which `sort`, `uniq` and `find` invocations write no file and run no program
 * (functional core: words in, a verdict out; the sibling of `read-only-git.ts`
 * and `read-only-gh.ts`). Each is a read in its common form and a writer under
 * one option, operand or environment variable, which is why
 * `READ_ONLY_STATE_COMMANDS` cannot list them by name (loom#216):
 *
 * - `sort` writes its `-o`/`--output` file, puts temporary files in the
 *   `-T`/`--temporary-directory` directory (or `TMPDIR`), and runs
 *   `--compress-program`;
 * - `uniq` writes its second operand (`uniq INPUT OUTPUT`);
 * - `find` deletes (`-delete`), runs programs (`-exec`, `-execdir`, `-ok`,
 *   `-okdir`) and writes files (`-fprint`, `-fprint0`, `-fprintf`, `-fls`).
 *
 * Errs toward "no": every word must have one static spelling (the caller
 * passes null for any other), an abbreviation of a refused long option is
 * refused, a short-option bundle holding a refused letter is refused,
 * `uniq`'s option arguments count as operands, and an environment prefix may
 * name only {@link FILTER_INERT_ENVIRONMENT} variables.
 */

import { bundles, namesLongOption, splitAtEndOfOptions } from "./option-words";

/** Environment names a filter may be prefixed with: the locale, which changes
 *  only how text compares and prints. Never `TMPDIR`, where `sort` spills. */
export const FILTER_INERT_ENVIRONMENT: ReadonlySet<string> = new Set([
  "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_NUMERIC", "LC_MESSAGES", "LANG", "LANGUAGE",
]);

const SORT_REFUSED_LONG: readonly string[] = ["output", "temporary-directory", "compress-program"];
const SORT_REFUSED_SHORT: readonly string[] = ["o", "T"];

const FIND_WRITERS: ReadonlySet<string> = new Set([
  "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls",
]);

const sortReads = (args: readonly string[]): boolean =>
  splitAtEndOfOptions(args).options.every((word) =>
    !namesLongOption(word, SORT_REFUSED_LONG) && !bundles(word, SORT_REFUSED_SHORT));

function uniqReads(args: readonly string[]): boolean {
  const { options, operands } = splitAtEndOfOptions(args);
  return options.filter((word) => word === "-" || !word.startsWith("-")).length + operands.length <= 1;
}

const findReads = (args: readonly string[]): boolean => args.every((word) => !FIND_WRITERS.has(word));

const FILTERS: ReadonlyMap<string, (args: readonly string[]) => boolean> = new Map([
  ["sort", sortReads],
  ["uniq", uniqReads],
  ["find", findReads],
]);

/**
 * Does this simple command, given as each word's one static spelling (null
 * for a word with a runtime part, a glob or several spellings), run `sort`,
 * `uniq` or `find` so that it writes no file and runs no program?
 */
export function isReadOnlyFilterInvocation(spellings: readonly (string | null)[]): boolean {
  const reads = FILTERS.get(spellings[0] ?? "");
  if (reads === undefined) return false;
  const args = spellings.slice(1);
  return args.every((word): word is string => word !== null) && reads(args);
}
