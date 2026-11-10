/**
 * Shared bash ANSI-C (`$'…'`) decoding, used by BOTH the guard's matching view
 * (core/guard-state-file) and the evidence scanner's redirect-target reader
 * (core/shell-write-targets). Keeping one implementation is what stops the two
 * from diverging point-wise: the guard is taught to SEE a guarded path spelled
 * `$'\x2e\x63…'`, the scanner is taught to MINT the same decoded path as a
 * FileWrite target. (The standing "shared shell tokenizer" refactor subsumes
 * this module; until it lands, this is the shared decode.)
 */

/** Index of the `'` closing a `$'…'` (ANSI-C) body opened before `start`,
 *  backslash-escape aware (`\'` and `\\` do not close). -1 when unclosed. */
export function findAnsiCClose(text: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "'") return i;
  }
  return -1;
}

/**
 * Decode a bash ANSI-C (`$'…'`) body to the characters bash produces at
 * execution: `\xHH` / `\uHHHH` / `\UHHHHHHHH` hex, `\NNN` octal, and the
 * named escapes (`\n`, `\t`, …). A decoded NUL TRUNCATES the body: bash stops
 * at the first NUL and drops the NUL and everything after it IN THAT BODY
 * (`$'a\x00b'` → `a`). Truncating (rather than merely dropping the NUL and
 * decoding on) matches bash for BOTH consumers: the guard sees the real
 * executed span, and the evidence twin (readRedirectTarget) mints the real
 * written path instead of an over-long one. A standalone `$'\x00'` body decodes
 * to empty, so any literal after the close-quote still rejoins (`x$'\x00'y` →
 * `xy`). An unknown escape drops the backslash and keeps the char
 * (reveal-monotonic).
 */
/** A numeric escape's grammar: where its digits start (after the backslash),
 *  which digits, their radix, how the value is reduced, and how it decodes. */
type NumericEscape = Readonly<{
  offset: number;
  digits: RegExp;
  radix: number;
  reduce: (value: number) => number;
  decode: (code: number) => string;
}>;

const asIs = (value: number): number => value;

/** The numeric escape introduced by `n` (`\xHH`, `\uHHHH`, `\UHHHHHHHH`, `\NNN`), or null. */
function numericEscape(n: string): NumericEscape | null {
  if (n === "x") return { offset: 2, digits: /^[0-9a-fA-F]{1,2}/, radix: 16, reduce: asIs, decode: String.fromCharCode };
  if (n === "u") return { offset: 2, digits: /^[0-9a-fA-F]{1,4}/, radix: 16, reduce: asIs, decode: String.fromCodePoint };
  if (n === "U") return { offset: 2, digits: /^[0-9a-fA-F]{1,8}/, radix: 16, reduce: asIs, decode: String.fromCodePoint };
  if (n >= "0" && n <= "7") return { offset: 1, digits: /^[0-7]{1,3}/, radix: 8, reduce: (value) => value & 0xff, decode: String.fromCharCode };
  return null;
}

export function decodeAnsiC(body: string): string {
  const NAMED: Readonly<Record<string, string>> = {
    a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n",
    r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?",
  };
  let out = "";
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== "\\") {
      out += body[i];
      continue;
    }
    const n = body[i + 1];
    if (n === undefined) {
      out += "\\";
      break;
    }
    const numeric = numericEscape(n);
    if (numeric !== null) {
      const digits = body.slice(i + numeric.offset).match(numeric.digits);
      if (digits) {
        const code = numeric.reduce(parseInt(digits[0], numeric.radix));
        if (code === 0) return out; // bash truncates the body at a NUL
        out += numeric.decode(code);
        i += numeric.offset - 1 + digits[0].length;
        continue;
      }
    } else if (n in NAMED) {
      out += NAMED[n];
      i++;
      continue;
    }
    // Unknown escape: bash keeps the char; drop the backslash (reveal-monotonic).
    out += n;
    i++;
  }
  return out;
}
