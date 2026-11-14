/**
 * Markdown structure for the doc-contract suites, read one way: headings,
 * heading sections, fenced code blocks and pipe tables.
 *
 * A suite that binds a document to the code reads a structure the document
 * owns (the substitution table of `commands/loom.md`, the Status section of an
 * ADR, the operations table of `docs/security-audit.md`) through this module
 * and no reader of its own. Every reader returns the structure or a
 * `MarkdownError` that names the source, the heading, column or row it looked
 * for, and the line it is about — never an empty result or a `-1` index.
 *
 * Edge cases this module owns, so no suite restates them:
 * - fenced code (``` or ~~~, any info string, indented under a list item):
 *   a `#` line or a `|` line inside a fence is code, never a heading or a
 *   table row, and an unclosed fence is an error;
 * - pipe tables: every line opens with a pipe, the closing pipe is optional,
 *   the alignment row (`|---|:--:|`) is required under the header, `\|` is a
 *   literal pipe inside a cell, cells are trimmed and kept verbatim otherwise
 *   (backticks included), header names are unique, and every row is as wide
 *   as its header;
 * - sections run to the next heading of the same or a higher level, so a
 *   table or fence inside a section is read in the section's line frame;
 * - a heading, table or row looked up by name must be exactly one; two is an
 *   ambiguity error, never a silent first match.
 *
 * Line numbers in errors are the document's own, 1-based, also inside a
 * section.
 */

import type { DomainResult } from "../../src/core/orchestration-contract/identity";

/** A Markdown text, the name failures cite, and the document line its first line sits on. */
export type MarkdownSource = Readonly<{ name: string; lines: readonly string[]; firstLine: number }>;

/** A fenced code block: the lines of its opening and closing fences, its info string, and its body. */
export type Fence = Readonly<{ line: number; end: number; info: string; body: string }>;

/** A table row, its cells addressed by column name. */
export type TableRow<C extends string = string> = Readonly<{ line: number; cells: Readonly<Record<C, string>> }>;

/** A pipe table: the source it was read from, the line of its header, its columns and body rows. */
export type Table<C extends string = string> = Readonly<{
  source: string;
  line: number;
  columns: readonly string[];
  rows: readonly TableRow<C>[];
}>;

/** Why a run of pipe lines is not a table. */
export type TableDefect =
  | Readonly<{ kind: "missing-alignment-row" }>
  | Readonly<{ kind: "cell-count"; expected: number; actual: number }>
  | Readonly<{ kind: "duplicate-column"; column: string }>;

export type MarkdownError =
  | Readonly<{ kind: "unclosed-fence"; source: string; line: number }>
  | Readonly<{ kind: "heading-not-found"; source: string; heading: string }>
  | Readonly<{ kind: "heading-ambiguous"; source: string; heading: string; lines: readonly number[] }>
  | Readonly<{ kind: "malformed-table"; source: string; line: number; defect: TableDefect }>
  | Readonly<{
    kind: "table-not-found";
    source: string;
    columns: readonly string[];
    tables: readonly Readonly<{ line: number; columns: readonly string[] }>[];
  }>
  | Readonly<{ kind: "table-ambiguous"; source: string; columns: readonly string[]; lines: readonly number[] }>
  | Readonly<{ kind: "row-not-found"; source: string; table: number; column: string; value: string }>
  | Readonly<{ kind: "row-ambiguous"; source: string; table: number; column: string; value: string; lines: readonly number[] }>;

const ok = <T>(value: T): DomainResult<T, never> => ({ ok: true, value });
const err = <E>(error: E): DomainResult<never, E> => ({ ok: false, error });

/** A whole document. */
export const markdown = (name: string, text: string): MarkdownSource =>
  Object.freeze({ name, lines: Object.freeze(text.split(/\r?\n/)), firstLine: 1 });

// --- Scan: one pass that separates prose lines from fenced code ------------

type ProseLine = Readonly<{ line: number; text: string }>;
type Scan = Readonly<{ prose: readonly ProseLine[]; fences: readonly Fence[] }>;
type OpenFence = Readonly<{ line: number; marker: string; info: string; body: readonly string[] }>;
type ScanState = Readonly<{ prose: readonly ProseLine[]; fences: readonly Fence[]; open: OpenFence | undefined }>;

const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*([^`]*?)\s*$/;

const closes = (open: OpenFence, text: string): boolean => {
  const marker = /^\s*(`{3,}|~{3,})\s*$/.exec(text)?.[1];
  return marker !== undefined && marker[0] === open.marker[0] && marker.length >= open.marker.length;
};

const step = (state: ScanState, text: string, line: number): ScanState => {
  const { open } = state;
  if (open !== undefined) {
    return closes(open, text)
      ? { ...state, open: undefined, fences: [...state.fences, { line: open.line, end: line, info: open.info, body: open.body.join("\n") }] }
      : { ...state, open: { ...open, body: [...open.body, text] } };
  }
  const [, marker, info] = FENCE_OPEN.exec(text) ?? [];
  return marker === undefined || info === undefined
    ? { ...state, prose: [...state.prose, { line, text }] }
    : { ...state, open: { line, marker, info, body: [] } };
};

function scan(source: MarkdownSource): DomainResult<Scan, MarkdownError> {
  const final = source.lines.reduce<ScanState>(
    (state, text, index) => step(state, text, source.firstLine + index),
    { prose: [], fences: [], open: undefined },
  );
  return final.open === undefined
    ? ok({ prose: final.prose, fences: final.fences })
    : err({ kind: "unclosed-fence", source: source.name, line: final.open.line });
}

// --- Headings and sections -------------------------------------------------

type Heading = Readonly<{ line: number; level: number; text: string }>;

const HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

const headingsOf = (prose: readonly ProseLine[]): readonly Heading[] =>
  prose.flatMap(({ line, text }) => {
    const [, hashes, title] = HEADING.exec(text) ?? [];
    return hashes === undefined || title === undefined ? [] : [{ line, level: hashes.length, text: title }];
  });

/**
 * The body under the one heading whose text is `heading`, at any level, up to
 * the next heading of the same or a higher level. Headings inside fences do
 * not count. The section is a source of its own, named `<source> § <heading>`
 * and numbered in the document's lines.
 */
export function sectionOf(source: MarkdownSource, heading: string): DomainResult<MarkdownSource, MarkdownError> {
  const scanned = scan(source);
  if (!scanned.ok) return scanned;
  const headings = headingsOf(scanned.value.prose);
  const matches = headings.filter(({ text }) => text === heading);
  const [found] = matches;
  if (found === undefined) return err({ kind: "heading-not-found", source: source.name, heading });
  if (matches.length > 1) {
    return err({ kind: "heading-ambiguous", source: source.name, heading, lines: matches.map(({ line }) => line) });
  }
  const next = headings.find(({ line, level }) => line > found.line && level <= found.level);
  const start = found.line + 1 - source.firstLine;
  const end = next === undefined ? source.lines.length : next.line - source.firstLine;
  return ok(Object.freeze({
    name: `${source.name} § ${heading}`,
    lines: Object.freeze(source.lines.slice(start, end)),
    firstLine: found.line + 1,
  }));
}

/** Every fenced block whose info string's first word is `info` (`json`, `bash`, …), in order. */
export function fencesOf(source: MarkdownSource, info: string): DomainResult<readonly Fence[], MarkdownError> {
  const scanned = scan(source);
  if (!scanned.ok) return scanned;
  return ok(scanned.value.fences.filter((fence) => fence.info.split(/\s+/)[0] === info));
}

// --- Tables ----------------------------------------------------------------

const ALIGNMENT_CELL = /^:?-+:?$/;

/** The cells of one pipe line: an optional leading and trailing pipe, `\|` kept as a literal pipe. */
const cellsOf = (text: string): readonly string[] => {
  const inner = text.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return inner.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());
};

/** Adjacent prose lines that start with a pipe: never empty, its first line the would-be header. */
type PipeRun = readonly [ProseLine, ...ProseLine[]];

/** Runs of adjacent prose lines that start with a pipe. A fence between two pipe lines ends the run. */
const pipeRuns = (prose: readonly ProseLine[]): readonly PipeRun[] =>
  prose
    .filter(({ text }) => text.trimStart().startsWith("|"))
    .reduce<readonly PipeRun[]>((runs, entry) => {
      const last = runs.at(-1);
      return last !== undefined && last[last.length - 1]?.line === entry.line - 1
        ? [...runs.slice(0, -1), [...last, entry]]
        : [...runs, [entry]];
    }, []);

function tableOf(source: string, [header, alignment, ...body]: PipeRun): DomainResult<Table, MarkdownError> {
  const malformed = (line: number, defect: TableDefect) => err({ kind: "malformed-table" as const, source, line, defect });
  const columns = cellsOf(header.text);
  const alignmentCells = alignment === undefined ? [] : cellsOf(alignment.text);
  if (alignment === undefined || !alignmentCells.every((cell) => ALIGNMENT_CELL.test(cell))) {
    return malformed(header.line, { kind: "missing-alignment-row" });
  }
  const duplicate = columns.find((column, index) => columns.indexOf(column) !== index);
  if (duplicate !== undefined) return malformed(header.line, { kind: "duplicate-column", column: duplicate });
  const widths = [alignment, ...body].map(({ line, text }) => ({ line, cells: cellsOf(text) }));
  const narrow = widths.find(({ cells }) => cells.length !== columns.length);
  if (narrow !== undefined) {
    return malformed(narrow.line, { kind: "cell-count", expected: columns.length, actual: narrow.cells.length });
  }
  // Every row is as wide as the header (checked above), so the zip drops nothing.
  const rows = widths.slice(1).map(({ line, cells }) => Object.freeze({
    line,
    cells: Object.freeze(Object.fromEntries(cells.flatMap((cell, index) => {
      const column = columns[index];
      return column === undefined ? [] : [[column, cell]];
    }))),
  }));
  return ok(Object.freeze({ source, line: header.line, columns, rows }));
}

/** Every pipe table outside fenced code, in document order. One malformed table fails the whole read. */
export function tablesOf(source: MarkdownSource): DomainResult<readonly Table[], MarkdownError> {
  const scanned = scan(source);
  if (!scanned.ok) return scanned;
  const parsed = pipeRuns(scanned.value.prose).map((run) => tableOf(source.name, run));
  const [failed] = parsed.flatMap((table) => (table.ok ? [] : [table]));
  if (failed !== undefined) return failed;
  return ok(parsed.flatMap((table) => (table.ok ? [table.value] : [])));
}

/**
 * The one table whose header has every one of `columns`, its rows addressed by
 * those names. A document that names a template in some other table, or in
 * prose, does not satisfy this: only a header with these columns does.
 */
export function tableWithColumns<C extends string>(
  source: MarkdownSource,
  columns: readonly C[],
): DomainResult<Table<C>, MarkdownError> {
  const tables = tablesOf(source);
  if (!tables.ok) return tables;
  const matches = tables.value.filter((table) => columns.every((column) => table.columns.includes(column)));
  const [found] = matches;
  if (found === undefined) {
    return err({
      kind: "table-not-found",
      source: source.name,
      columns,
      tables: tables.value.map(({ line, columns: present }) => ({ line, columns: present })),
    });
  }
  if (matches.length > 1) {
    return err({ kind: "table-ambiguous", source: source.name, columns, lines: matches.map(({ line }) => line) });
  }
  // The header was just checked to hold every one of `columns`, and every row
  // has a cell per header column.
  return ok(found as Table<C>);
}

/** The one row whose `column` cell is exactly `value` (backticks and all). */
export function rowWhere<C extends string>(table: Table<C>, column: NoInfer<C>, value: string): DomainResult<TableRow<C>, MarkdownError> {
  const matches = table.rows.filter((row) => row.cells[column] === value);
  const [found] = matches;
  const where = { source: table.source, table: table.line, column, value };
  if (found === undefined) return err({ kind: "row-not-found", ...where });
  if (matches.length > 1) return err({ kind: "row-ambiguous", ...where, lines: matches.map(({ line }) => line) });
  return ok(found);
}

// --- Failure messages ------------------------------------------------------

const list = (values: readonly (string | number)[]): string => values.join(", ");

const describeDefect = (defect: TableDefect): string => {
  switch (defect.kind) {
    case "missing-alignment-row":
      return "has no alignment row (`|---|`) under its header";
    case "cell-count":
      return `has ${defect.actual} cells where its header has ${defect.expected}`;
    case "duplicate-column":
      return `names the column "${defect.column}" twice`;
    default: {
      const unreachable: never = defect;
      return unreachable;
    }
  }
};

/** One sentence naming the source, what was looked for and where. */
export function describeMarkdownError(error: MarkdownError): string {
  switch (error.kind) {
    case "unclosed-fence":
      return `${error.source}: the code fence opened on line ${error.line} is never closed`;
    case "heading-not-found":
      return `${error.source} has no "${error.heading}" heading`;
    case "heading-ambiguous":
      return `${error.source} has ${error.lines.length} "${error.heading}" headings (lines ${list(error.lines)}); expected exactly one`;
    case "malformed-table":
      return `${error.source}: the table line ${error.line} ${describeDefect(error.defect)}`;
    case "table-not-found": {
      const present = error.tables.length === 0
        ? "it has no table"
        : `its tables have: ${error.tables.map(({ line, columns }) => `line ${line} [${list(columns)}]`).join("; ")}`;
      return `${error.source} has no table with the column(s) ${list(error.columns)}; ${present}`;
    }
    case "table-ambiguous":
      return `${error.source} has ${error.lines.length} tables with the column(s) ${list(error.columns)} (lines ${list(error.lines)}); expected exactly one`;
    case "row-not-found":
      return `the table at ${error.source} line ${error.table} has no row whose ${error.column} is ${error.value}`;
    case "row-ambiguous":
      return `the table at ${error.source} line ${error.table} has ${error.lines.length} rows whose ${error.column} is ${error.value} (lines ${list(error.lines)}); expected exactly one`;
    default: {
      const unreachable: never = error;
      return unreachable;
    }
  }
}

/** The success value, or a thrown failure carrying `describe`'s sentence for the refusal. */
export function orFail<T, E>(result: DomainResult<T, E>, describe: (error: E) => string): T {
  if (!result.ok) throw new Error(describe(result.error));
  return result.value;
}
