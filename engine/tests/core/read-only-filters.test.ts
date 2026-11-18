/**
 * `isReadOnlyFilterInvocation` (loom#216): `sort`, `uniq` and `find` read
 * unless an option, an operand or a word the shell completes at runtime makes
 * them write a file or run a program. Each refusal is pinned in every spelling
 * the command accepts, because the guard's safety rests on these tables.
 */
import { describe, expect, it } from "vitest";
import { isReadOnlyFilterInvocation } from "../../src/core/read-only-filters";

const words = (line: string): readonly string[] => line.split(" ");

describe("isReadOnlyFilterInvocation", () => {
  it.each([
    "sort",
    "sort -u",
    "sort -t , -k2,2nr file",
    "sort -rn -- -o",
    "uniq",
    "uniq -c",
    "uniq file",
    "uniq -- file",
    "uniq - ",
    "find . -type f -print",
    "find . -path ./x -prune -o -name *.ts -print",
  ])("reads: %s", (line) => {
    expect(isReadOnlyFilterInvocation(words(line.trim()))).toBe(true);
  });

  it.each([
    ["sort -o", "sort -o out in"],
    ["sort -o bundled", "sort -uo out in"],
    ["sort --output", "sort --output=out in"],
    ["sort --output abbreviated", "sort --out=out in"],
    ["sort -T", "sort -T dir in"],
    ["sort --temporary-directory abbreviated", "sort --temp=dir in"],
    ["sort --compress-program abbreviated", "sort --compress=sh in"],
    ["uniq output operand", "uniq in out"],
    ["uniq output operand after --", "uniq -- in out"],
    ["uniq option argument counted as an operand", "uniq -f 1 in"],
    ...["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]
      .map((writer): [string, string] => [`find ${writer}`, `find . ${writer} x`]),
    ["another command", "cat file"],
  ])("refuses: %s", (_name, line) => {
    expect(isReadOnlyFilterInvocation(words(line))).toBe(false);
  });

  it("refuses a word the shell completes at runtime", () => {
    expect(isReadOnlyFilterInvocation(["find", ".", null])).toBe(false);
    expect(isReadOnlyFilterInvocation(["sort", null])).toBe(false);
  });
});
