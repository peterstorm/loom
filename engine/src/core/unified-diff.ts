/**
 * Deterministic line-based unified diff over two already-read texts.
 *
 * The standalone read-coverage obligation (ADR-0022) freezes one diff text
 * per scoped file into the Context Packet, so the diff must be a pure function
 * of the frozen bytes: no Git process, no locale, no configuration. The
 * algorithm is Myers' O(ND) shortest edit script over the lines left after
 * trimming the common prefix and suffix. When the remaining edit distance
 * exceeds `MAX_EDIT_DISTANCE`, the middle is emitted as one replacement
 * (every base line removed, every head line added). That is still an exact
 * diff that `applyUnifiedDiff` reproduces, only not a minimal one, and it
 * bounds the trace memory to roughly `MAX_EDIT_DISTANCE²` integers.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

export const DIFF_CONTEXT_LINES = 3;
const MAX_EDIT_DISTANCE = 2_000;
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

/** Myers forward search with a windowed trace; null once the distance cap is exceeded. */
function myersEdits(base: readonly string[], head: readonly string[]): Edit[] | null {
  const n = base.length, m = head.length, offset = n + m;
  const frontier = new Int32Array(2 * offset + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= Math.min(offset, MAX_EDIT_DISTANCE); d += 1) {
    // trace[d] holds the frontier BEFORE step d, for diagonals -d..d.
    trace.push(frontier.slice(offset - d, offset + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && frontier[offset + k - 1]! < frontier[offset + k + 1]!)
        ? frontier[offset + k + 1]!
        : frontier[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && base[x] === head[y]) { x += 1; y += 1; }
      frontier[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, base.length, head.length, d);
    }
  }
  return null;
}

function backtrack(trace: readonly Int32Array[], n: number, m: number, distance: number): Edit[] {
  const edits: Edit[] = [];
  let x = n, y = m;
  for (let d = distance; d >= 0; d -= 1) {
    const window = trace[d]!;
    const at = (k: number): number => window[k + d]!;
    const k = x - y;
    const previousK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const previousX = d === 0 ? 0 : at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) { x -= 1; y -= 1; edits.push({ kind: "equal", base: x, head: y }); }
    if (d > 0) {
      if (x === previousX) edits.push({ kind: "insert", head: previousY });
      else edits.push({ kind: "delete", base: previousX });
    }
    x = previousX; y = previousY;
  }
  return edits.reverse();
}

/** The full edit script: shared prefix and suffix, Myers (or one replacement) in between. */
function editScript(base: readonly string[], head: readonly string[]): Edit[] {
  let prefix = 0;
  while (prefix < base.length && prefix < head.length && base[prefix] === head[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < base.length - prefix && suffix < head.length - prefix &&
      base[base.length - 1 - suffix] === head[head.length - 1 - suffix]) suffix += 1;
  const baseMiddle = base.slice(prefix, base.length - suffix);
  const headMiddle = head.slice(prefix, head.length - suffix);
  const middle = myersEdits(baseMiddle, headMiddle) ?? [
    ...baseMiddle.map((_, index): Edit => ({ kind: "delete", base: index })),
    ...headMiddle.map((_, index): Edit => ({ kind: "insert", head: index })),
  ];
  const edits: Edit[] = [];
  for (let i = 0; i < prefix; i += 1) edits.push({ kind: "equal", base: i, head: i });
  for (const edit of middle) {
    if (edit.kind === "equal") edits.push({ kind: "equal", base: edit.base + prefix, head: edit.head + prefix });
    else if (edit.kind === "delete") edits.push({ kind: "delete", base: edit.base + prefix });
    else edits.push({ kind: "insert", head: edit.head + prefix });
  }
  for (let i = 0; i < suffix; i += 1) {
    edits.push({ kind: "equal", base: base.length - suffix + i, head: head.length - suffix + i });
  }
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
  // The final lines differ only by their newline: compare them as distinct.
  const leftLines = left.finalNewline ? left.lines : [...left.lines.slice(0, -1), `${left.lines.at(-1)}\u0000`];
  const rightLines = right.finalNewline ? right.lines : [...right.lines.slice(0, -1), `${right.lines.at(-1)}\u0000`];
  const edits = editScript(leftLines, rightLines);
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
