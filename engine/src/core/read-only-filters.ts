/**
 * Which `sort`, `uniq` and `find` invocations write no file and run no program
 * (functional core: words in, a verdict out; the sibling of `read-only-git.ts`
 * and `read-only-gh.ts`). Each is a read in its common form and a writer under
 * one option or operand, which is why `READ_ONLY_STATE_COMMANDS` cannot list
 * them by name (loom#216):
 *
 * - `sort` writes its `-o`/`--output` file, puts temporary files in the
 *   `-T`/`--temporary-directory` directory, and runs `--compress-program`;
 * - `uniq` writes its second operand (`uniq INPUT OUTPUT`);
 * - `find` deletes (`-delete`), runs programs (`-exec`, `-execdir`, `-ok`,
 *   `-okdir`) and writes files (`-fprint`, `-fprint0`, `-fprintf`, `-fls`).
 *
 * Errs toward "no": every word must have one static spelling (the caller
 * passes null for any other), an abbreviation of a refused long option is
 * refused, a short-option bundle holding a refused letter is refused, and
 * `uniq`'s option arguments count as operands.
 */

import { bundles, namesLongOption } from "./read-only-git";

type SortRefusals =Readonly<{ long: readonly string[]; short: readonly string[] }>;

const SORT_REFUSALS: SortRefusals = {
  long: ["output", "temporary-directory", "compress-program"],
  short: ["o", "T"],
};

const FIND_WRITERS: ReadonlySet<string> = new Set([
  "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls",
]);

function sortReads(args: readonly string[]): boolean {
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  return options.every((word) => !namesLongOption(word, SORT_REFUSALS.long) && !bundles(word, SORT_REFUSALS.short));
}

function uniqReads(args: readonly string[]): boolean {
  const end = args.indexOf("--");
  const before = end === -1 ? args : args.slice(0, end);
  const operands = before.filter((word) => word === "-" || !word.startsWith("-")).length +
    (end === -1 ? 0 : args.length - end - 1);
  return operands <= 1;
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
