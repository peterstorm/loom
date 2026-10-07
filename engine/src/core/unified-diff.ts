/**
 * Deterministic line-based unified diff over two already-read texts.
 *
 * The standalone read-coverage obligation (ADR-0022) freezes one diff text
 * per scoped file into the Context Packet, so the diff must be a pure function
 * of the frozen bytes: no Git process, no locale, no configuration. The edit
 * script is Myers' shortest one, found by linear-space bisection (the "middle
 * snake" divide and conquer, as in diff-match-patch's `diff_bisect`) over
 * interned lines after trimming the common prefix and suffix. Memory is O(N+M)
 * per level whatever the edit distance, so a heavily rewritten file still gets
 * a minimal diff — never an inflated whole-file replacement that would push a
 * reviewable file past the read budget.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

export const DIFF_CONTEXT_LINES = 3;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

/** One side of a diffed file: absent, or text whose final line may lack a newline. */
type Lines = Readonly<{ lines: readonly string[]; finalNewline: boolean }>;

type Edit =
  | Readonly<{ kind: "equal"; base: number; head: number }>
  | Readonly<{ kind: "delete"; base: number }>
  | Readonly<{ kind: "insert"; head: number }>;

function splitLines(text: string): Lines {
  if (text === "") return { lines: [], finalNewline: true };
  const finalNewline = text.endsWith("\n");
  const body = finalNewline ? text.slice(0, -1) : text;
  return { lines: body.split("\n"), finalNewline };
}

/** The lines the edit script compares. A final line without a newline gets a
 *  NUL sentinel, so it differs from the same text followed by a newline. */
function comparableLines(side: Lines): readonly string[] {
  return side.finalNewline ? side.lines : [...side.lines.slice(0, -1), `${side.lines.at(-1)}\u0000`];
}

/** Lines as small integers, so the inner loops compare numbers, not strings. */
function intern(base: readonly string[], head: readonly string[]): readonly [Int32Array, Int32Array] {
  const ids = new Map<string, number>();
  const id = (line: string): number => {
    let value = ids.get(line);
    if (value === undefined) { value = ids.size; ids.set(line, value); }
    return value;
  };
  return [Int32Array.from(base, id), Int32Array.from(head, id)];
}

/**
 * Append the shortest edit script of a[aLo, aHi) → b[bLo, bHi) to `out`.
 * Common prefix and suffix are emitted directly; the remaining middle is split
 * at its middle snake and each half is solved recursively.
 */
function solve(a: Int32Array, aLo: number, aHi: number, b: Int32Array, bLo: number, bHi: number, out: Edit[]): void {
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) { out.push({ kind: "equal", base: aLo, head: bLo }); aLo += 1; bLo += 1; }
  let suffix = 0;
  while (aHi - suffix > aLo && bHi - suffix > bLo && a[aHi - 1 - suffix] === b[bHi - 1 - suffix]) suffix += 1;
  const aEnd = aHi - suffix, bEnd = bHi - suffix;
  if (aLo === aEnd) {
    for (let y = bLo; y < bEnd; y += 1) out.push({ kind: "insert", head: y });
  } else if (bLo === bEnd) {
    for (let x = aLo; x < aEnd; x += 1) out.push({ kind: "delete", base: x });
  } else {
    const split = middleSnake(a, aLo, aEnd, b, bLo, bEnd);
    if (split === null) {
      for (let x = aLo; x < aEnd; x += 1) out.push({ kind: "delete", base: x });
      for (let y = bLo; y < bEnd; y += 1) out.push({ kind: "insert", head: y });
    } else {
      solve(a, aLo, split[0], b, bLo, split[1], out);
      solve(a, split[0], aEnd, b, split[1], bEnd, out);
    }
  }
  for (let i = 0; i < suffix; i += 1) out.push({ kind: "equal", base: aEnd + i, head: bEnd + i });
}

/**
 * The split point of the middle snake of a[aLo, aHi) → b[bLo, bHi): forward
 * and reverse Myers searches advance one edit at a time until their furthest
 * paths overlap. Null means the halves share no line at all (both sides are
 * non-empty here, and their first and last lines already differ).
 */
function middleSnake(a: Int32Array, aLo: number, aHi: number, b: Int32Array, bLo: number, bHi: number): readonly [number, number] | null {
  const n = aHi - aLo, m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2);
  const offset = maxD, length = 2 * maxD + 2;
  const forward = new Int32Array(length).fill(-1), reverse = new Int32Array(length).fill(-1);
  forward[offset + 1] = 0; reverse[offset + 1] = 0;
  const delta = n - m, front = delta % 2 !== 0;
  let k1start = 0, k1end = 0, k2start = 0, k2end = 0;
  for (let d = 0; d < maxD; d += 1) {
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1Offset = offset + k1;
      let x1 = k1 === -d || (k1 !== d && forward[k1Offset - 1]! < forward[k1Offset + 1]!) ? forward[k1Offset + 1]! : forward[k1Offset - 1]! + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) { x1 += 1; y1 += 1; }
      forward[k1Offset] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const k2Offset = offset + delta - k1;
        if (k2Offset >= 0 && k2Offset < length && reverse[k2Offset] !== -1 && x1 >= n - reverse[k2Offset]!) return [aLo + x1, bLo + y1];
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2Offset = offset + k2;
      let x2 = k2 === -d || (k2 !== d && reverse[k2Offset - 1]! < reverse[k2Offset + 1]!) ? reverse[k2Offset + 1]! : reverse[k2Offset - 1]! + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[aHi - 1 - x2] === b[bHi - 1 - y2]) { x2 += 1; y2 += 1; }
      reverse[k2Offset] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const k1Offset = offset + delta - k2;
        if (k1Offset >= 0 && k1Offset < length && forward[k1Offset] !== -1) {
          const x1 = forward[k1Offset]!;
          const y1 = offset + x1 - k1Offset;
          if (x1 >= n - x2) return [aLo + x1, bLo + y1];
        }
      }
    }
  }
  return null;
}

/** The full shortest edit script, in base/head order. */
function editScript(base: readonly string[], head: readonly string[]): Edit[] {
  const [a, b] = intern(base, head);
  const edits: Edit[] = [];
  solve(a, 0, a.length, b, 0, b.length, edits);
  return edits;
}

/**
 * The unified diff of `base` → `head` for `path`, or `""` when they are equal.
 * A null side is an absent file (`/dev/null`). A final line without a newline
 * carries Git's `\ No newline at end of file` marker, so the text is exact.
 */
export function unifiedDiff(path: string, base: string | null, head: string | null): string {
  if (base === head) return "";
  const left = splitLines(base ?? ""), right = splitLines(head ?? "");
  const edits = editScript(comparableLines(left), comparableLines(right));
  const out: string[] = [`--- ${base === null ? "/dev/null" : `a/${path}`}`, `+++ ${head === null ? "/dev/null" : `b/${path}`}`];
  const lineText = (side: Lines, index: number): string[] => {
    const text = side.lines[index]!;
    return !side.finalNewline && index === side.lines.length - 1 ? [text, NO_NEWLINE_MARKER] : [text];
  };
  for (const { start, stop } of hunkRanges(edits)) {
    const body: string[] = [];
    let baseStart = -1, headStart = -1, baseCount = 0, headCount = 0;
    for (let i = start; i < stop; i += 1) {
      const edit = edits[i]!;
      if (edit.kind !== "insert" && baseStart < 0) baseStart = edit.base;
      if (edit.kind !== "delete" && headStart < 0) headStart = edit.head;
      if (edit.kind === "equal") {
        baseCount += 1; headCount += 1;
        body.push(...lineText(right, edit.head).map((text, n) => n === 0 ? ` ${text}` : text));
      } else if (edit.kind === "delete") {
        baseCount += 1;
        body.push(...lineText(left, edit.base).map((text, n) => n === 0 ? `-${text}` : text));
      } else {
        headCount += 1;
        body.push(...lineText(right, edit.head).map((text, n) => n === 0 ? `+${text}` : text));
      }
    }
    const range = (first: number, count: number, fallback: number): string =>
      count === 0 ? `${fallback},0` : count === 1 ? `${first + 1}` : `${first + 1},${count}`;
    const baseFallback = baseStart < 0 ? baseLineBefore(edits, start) : 0;
    const headFallback = headStart < 0 ? headLineBefore(edits, start) : 0;
    out.push(`@@ -${range(baseStart, baseCount, baseFallback)} +${range(headStart, headCount, headFallback)} @@`, ...body);
  }
  return `${out.join("\n")}\n`;
}

/**
 * Edit-index ranges of the hunks: each run of changes padded by the context
 * lines, with runs separated by at most twice the context merged into one.
 */
function hunkRanges(edits: readonly Edit[]): readonly Readonly<{ start: number; stop: number }>[] {
  const ranges: { start: number; stop: number }[] = [];
  edits.forEach((edit, index) => {
    if (edit.kind === "equal") return;
    const start = Math.max(0, index - DIFF_CONTEXT_LINES);
    const stop = Math.min(edits.length, index + 1 + DIFF_CONTEXT_LINES);
    const last = ranges.at(-1);
    if (last !== undefined && start <= last.stop) last.stop = stop;
    else ranges.push({ start, stop });
  });
  return ranges;
}

/** Lines of base consumed before `index`: the anchor of an insertion-only hunk. */
function baseLineBefore(edits: readonly Edit[], index: number): number {
  return edits.slice(0, index).filter((edit) => edit.kind !== "insert").length;
}

function headLineBefore(edits: readonly Edit[], index: number): number {
  return edits.slice(0, index).filter((edit) => edit.kind !== "delete").length;
}

/**
 * Apply a diff produced by `unifiedDiff` to `base`, reproducing `head`.
 * Exists so the diff's exactness is executable (property-tested) rather than
 * asserted; it accepts only this module's own output shape.
 */
export function applyUnifiedDiff(base: string | null, diff: string): string | null {
  if (diff === "") return base;
  const lines = diff.slice(0, -1).split("\n");
  const headAbsent = lines[1] === "+++ /dev/null";
  const source = splitLines(base ?? "");
  const result: string[] = [];
  let resultFinalNewline = true;
  let cursor = 0;
  let i = 2;
  while (i < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@$/.exec(lines[i]!);
    if (header === null) throw new Error(`malformed hunk header: ${lines[i]}`);
    const count = header[2] === undefined ? 1 : Number(header[2]);
    const first = count === 0 ? Number(header[1]) : Number(header[1]) - 1;
    while (cursor < first) result.push(source.lines[cursor++]!);
    i += 1;
    while (i < lines.length && !lines[i]!.startsWith("@@ ")) {
      const line = lines[i]!;
      const noNewline = lines[i + 1] === NO_NEWLINE_MARKER;
      if (line.startsWith(" ")) { result.push(line.slice(1)); cursor += 1; if (noNewline) resultFinalNewline = false; }
      else if (line.startsWith("-")) cursor += 1;
      else if (line.startsWith("+")) { result.push(line.slice(1)); if (noNewline) resultFinalNewline = false; }
      i += noNewline ? 2 : 1;
    }
  }
  while (cursor < source.lines.length) {
    result.push(source.lines[cursor]!);
    if (cursor === source.lines.length - 1 && !source.finalNewline) resultFinalNewline = false;
    cursor += 1;
  }
  if (headAbsent) return null;
  if (result.length === 0) return "";
  return result.join("\n") + (resultFinalNewline ? "\n" : "");
}
