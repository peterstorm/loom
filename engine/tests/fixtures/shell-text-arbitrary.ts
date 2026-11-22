/**
 * Generated shell command text for the shell-grammar property tests: short
 * strings built from the syntax every walker must agree on — quotes of all
 * three kinds, escapes, `$(`, backticks, `${…}` forms, separators, every
 * redirect operator (`> >> >| &> 2>&1 <> >(`), heredoc openers and comments —
 * mixed with ordinary words. Unbalanced and nonsensical text is generated on
 * purpose: the fail-closed paths are the ones a refactor breaks.
 */
import fc from "fast-check";

export const SHELL_PIECES: readonly string[] = [
  "a", "b", "x", "/", "-", ".", "=", "A=", "A=1", "cat", "bash", "tee", "mv", "cp", "env", "bun", "cli.ts", "helper",
  " ", " ", "\t", "\n", ";", "&&", "||", "|", "|&", "&",
  ">", ">>", ">|", "&>", "&>>", "2>", "2>&1", ">&2", ">&-", ">&x", "<>", "<", "<<<", ">(", "<(", "(", ")", "{", "}",
  "$(", "`", "${", "${x:-", "${x:+", "$x", "'", "\"", "\\", "\\ ", "$'", "$\"", "\\n", "\\x2f",
  "<<", "<<'EOF'", "<<EOF", "<<-EOF", "EOF", "#", "2>/dev/null", "/dev/null", "1", "2",
];

/** One generated command line. */
export const shellText: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...SHELL_PIECES), { minLength: 0, maxLength: 14 })
  .map((pieces) => pieces.join(""));
