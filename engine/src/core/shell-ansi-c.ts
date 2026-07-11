/**
 * Shared bash ANSI-C (`$'…'`) decoding, used by BOTH the guard's matching view
 * (core/guard-state-file) and the evidence scanner's redirect-target reader
 * (machine/extract-evidence). Keeping one implementation is what stops the two
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
    if (n === "x") {
      const hex = body.slice(i + 2).match(/^[0-9a-fA-F]{1,2}/);
      if (hex) {
        const code = parseInt(hex[0], 16);
        if (code === 0) return out; // bash truncates the body at a NUL
        out += String.fromCharCode(code);
        i += 1 + hex[0].length;
        continue;
      }
    } else if (n === "u" || n === "U") {
      const hex = body.slice(i + 2).match(n === "u" ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/);
      if (hex) {
        const code = parseInt(hex[0], 16);
        if (code === 0) return out; // bash truncates the body at a NUL
        out += String.fromCodePoint(code);
        i += 1 + hex[0].length;
        continue;
      }
    } else if (n >= "0" && n <= "7") {
      const oct = body.slice(i + 1).match(/^[0-7]{1,3}/)!;
      const code = parseInt(oct[0], 8) & 0xff;
      if (code === 0) return out; // bash truncates the body at a NUL
      out += String.fromCharCode(code);
      i += oct[0].length;
      continue;
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
