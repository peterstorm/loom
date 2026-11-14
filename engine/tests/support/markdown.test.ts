/**
 * The Markdown reader several doc-contract suites stand on (panel templates,
 * the ADR index, the security-audit operations table). Each failure has to
 * name what was missing and where, because a suite reports it verbatim.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { refusal, value } from "../fixtures/parse-result";
import {
  describeMarkdownError,
  fencesOf,
  markdown,
  orFail,
  rowWhere,
  sectionOf,
  tableWithColumns,
  tablesOf,
} from "./markdown";

const doc = (...lines: readonly string[]) => markdown("doc.md", lines.join("\n"));

describe("tablesOf", () => {
  it("reads header, alignment and rows, keeping backticks and unescaping pipes", () => {
    const source = doc(
      "Intro.",
      "",
      "| Template | Variables |",
      "|:---|---:|",
      "| `phase-a.md` | `{x}`, `{y}` |",
      "| `a \\| b` | none",
    );
    expect(value(tablesOf(source))).toEqual([{
      source: "doc.md",
      line: 3,
      columns: ["Template", "Variables"],
      rows: [
        { line: 5, cells: { Template: "`phase-a.md`", Variables: "`{x}`, `{y}`" } },
        { line: 6, cells: { Template: "`a | b`", Variables: "none" } },
      ],
    }]);
  });

  it("separates adjacent tables at a non-table line and ignores pipe lines inside fences", () => {
    const source = doc(
      "| A |", "|---|", "| 1 |",
      "",
      "```text", "| not | a | table |", "```",
      "| B |", "|---|", "| 2 |",
    );
    expect(value(tablesOf(source)).map(({ line, columns }) => ({ line, columns }))).toEqual([
      { line: 1, columns: ["A"] },
      { line: 8, columns: ["B"] },
    ]);
  });

  it.each<readonly [string, readonly string[], string]>([
    ["a header with no alignment row", ["| A | B |", "| 1 | 2 |"], "doc.md: the table line 1 has no alignment row (`|---|`) under its header"],
    ["a row narrower than its header", ["| A | B |", "|---|---|", "| 1 |"], "doc.md: the table line 3 has 1 cells where its header has 2"],
    ["an alignment row wider than its header", ["| A |", "|---|---|"], "doc.md: the table line 2 has 2 cells where its header has 1"],
    ["a column named twice", ["| A | A |", "|---|---|"], "doc.md: the table line 1 names the column \"A\" twice"],
    ["an unclosed fence", ["| A |", "|---|", "```", "| x |"], "doc.md: the code fence opened on line 3 is never closed"],
  ])("refuses %s, naming the line", (_name, lines, message) => {
    expect(describeMarkdownError(refusal(tablesOf(doc(...lines))))).toBe(message);
  });

  it("round-trips any table it is given, cell for cell", () => {
    const cell = fc.string({ unit: fc.constantFrom("a", "Z", "1", " ", "|", "`", "-", ":", "#", "{", "}", "é"), maxLength: 12 })
      .map((text) => text.trim());
    const table = fc.uniqueArray(cell.filter((name) => name !== ""), { minLength: 1, maxLength: 4 }).chain((columns) =>
      fc.record({
        columns: fc.constant(columns),
        alignment: fc.array(fc.constantFrom("---", ":--", "--:", ":-:"), { minLength: columns.length, maxLength: columns.length }),
        rows: fc.array(fc.array(cell, { minLength: columns.length, maxLength: columns.length }), { maxLength: 5 }),
        closingPipe: fc.boolean(),
      }));
    fc.assert(fc.property(table, ({ columns, alignment, rows, closingPipe }) => {
      // Without a closing pipe, an empty last cell is indistinguishable from
      // one (`| a | ` reads as one cell): Markdown itself cannot say it.
      fc.pre(closingPipe || rows.every((row) => row.at(-1) !== ""));
      const line = (cells: readonly string[]) => `| ${cells.map((text) => text.replace(/\|/g, "\\|")).join(" | ")}${closingPipe ? " |" : ""}`;
      const parsed = value(tablesOf(doc(line(columns), line(alignment), ...rows.map(line))));
      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.columns).toEqual(columns);
      expect(parsed[0]?.rows.map(({ cells }) => columns.map((column) => cells[column]))).toEqual(rows);
    }), { seed: 4711, numRuns: 200 });
  });
});

describe("tableWithColumns and rowWhere", () => {
  // A template named in prose and in an unrelated table, and declared in the
  // one table with a Variables column: a first-match search on the file name
  // would take the unrelated row as its declaration.
  const contract = doc(
    "Spawn `phase-x.md` after the interview.",
    "",
    "| Template | Agent |",
    "|---|---|",
    "| `phase-x.md` | x-agent |",
    "",
    "| Template | Variables |",
    "|---|---|",
    "| `phase-y.md` | `{a}` |",
  );

  it("addresses the table whose header has every named column, and its rows by column name", () => {
    const table = value(tableWithColumns(contract, ["Template", "Variables"]));
    expect(table.line).toBe(7);
    expect(value(rowWhere(table, "Template", "`phase-y.md`")).cells.Variables).toBe("`{a}`");
  });

  it("does not take a template named only in another table or in prose as declared", () => {
    const table = value(tableWithColumns(contract, ["Template", "Variables"]));
    const missing = refusal(rowWhere(table, "Template", "`phase-x.md`"));
    expect(missing).toEqual({ kind: "row-not-found", source: "doc.md", table: 7, column: "Template", value: "`phase-x.md`" });
    expect(describeMarkdownError(missing)).toBe("the table at doc.md line 7 has no row whose Template is `phase-x.md`");
  });

  it("refuses a document whose only table naming the template has no Variables column, naming the column and the tables it has", () => {
    const unrelatedOnly = doc("| Template | Agent |", "|---|---|", "| `phase-x.md` | x-agent |");
    expect(describeMarkdownError(refusal(tableWithColumns(unrelatedOnly, ["Template", "Variables"]))))
      .toBe("doc.md has no table with the column(s) Template, Variables; its tables have: line 1 [Template, Agent]");
    expect(describeMarkdownError(refusal(tableWithColumns(doc("No tables."), ["Variables"]))))
      .toBe("doc.md has no table with the column(s) Variables; it has no table");
  });

  it("refuses two tables that both qualify, and two rows that both match", () => {
    const twice = doc("| A |", "|---|", "| 1 |", "| 1 |", "", "| A |", "|---|");
    expect(describeMarkdownError(refusal(tableWithColumns(twice, ["A"]))))
      .toBe("doc.md has 2 tables with the column(s) A (lines 1, 6); expected exactly one");
    const [first] = value(tablesOf(twice));
    if (first === undefined) throw new Error("fixture has a first table");
    expect(describeMarkdownError(refusal(rowWhere(first, "A", "1"))))
      .toBe("the table at doc.md line 1 has 2 rows whose A is 1 (lines 3, 4); expected exactly one");
  });
});

describe("sectionOf", () => {
  const adr = doc(
    "# ADR-0001",
    "## Status",
    "",
    "**Accepted** (2026-01-01).",
    "### Note",
    "| Field | Value |",
    "|---|---|",
    "| a | b |",
    "## Context",
    "```bash",
    "## Status",
    "```",
  );

  it("runs to the next heading of the same or a higher level, in the document's line frame", () => {
    const section = value(sectionOf(adr, "Status"));
    expect(section.name).toBe("doc.md § Status");
    expect(section.firstLine).toBe(3);
    expect(section.lines).toEqual(["", "**Accepted** (2026-01-01).", "### Note", "| Field | Value |", "|---|---|", "| a | b |"]);
    // A table inside the section keeps its document line and names the section.
    expect(value(tableWithColumns(section, ["Field"]))).toMatchObject({ source: "doc.md § Status", line: 6 });
  });

  it("does not take a heading inside a fence as a heading", () => {
    expect(value(sectionOf(adr, "Context")).lines).toEqual(["```bash", "## Status", "```"]);
  });

  it("refuses a missing heading and a repeated one, naming the heading and the document", () => {
    expect(describeMarkdownError(refusal(sectionOf(adr, "Decision")))).toBe('doc.md has no "Decision" heading');
    expect(describeMarkdownError(refusal(sectionOf(doc("## Status", "a", "## Status", "b"), "Status"))))
      .toBe('doc.md has 2 "Status" headings (lines 1, 3); expected exactly one');
  });

  it("reads exactly the lines between a heading and the next one", () => {
    const body = fc.array(fc.string({ unit: fc.constantFrom("a", " ", "|", "-", "*"), maxLength: 8 }), { maxLength: 4 });
    const sections = fc.uniqueArray(fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,8}[A-Za-z]$/), { minLength: 1, maxLength: 4 })
      .chain((titles) => fc.tuple(fc.constant(titles), fc.array(body, { minLength: titles.length, maxLength: titles.length })));
    fc.assert(fc.property(sections, ([titles, bodies]) => {
      const source = doc(...titles.flatMap((title, index) => [`## ${title}`, ...(bodies[index] ?? [])]));
      titles.forEach((title, index) => expect(value(sectionOf(source, title)).lines).toEqual(bodies[index]));
    }), { seed: 4712, numRuns: 200 });
  });
});

describe("fencesOf", () => {
  it("returns the blocks of one info string, with their opening and closing lines", () => {
    const source = doc("```json", "{\"a\":1}", "```", "", "~~~bash title", "echo", "~~~", "````json", "[]", "```", "````");
    expect(value(fencesOf(source, "json"))).toEqual([
      { line: 1, end: 3, info: "json", body: "{\"a\":1}" },
      { line: 8, end: 11, info: "json", body: "[]\n```" },
    ]);
    expect(value(fencesOf(source, "bash"))).toEqual([{ line: 5, end: 7, info: "bash title", body: "echo" }]);
  });
});

describe("orFail", () => {
  it("returns the value, or throws the described refusal", () => {
    expect(orFail(sectionOf(doc("## A", "x"), "A"), describeMarkdownError).lines).toEqual(["x"]);
    expect(() => orFail(sectionOf(doc("## A"), "B"), describeMarkdownError)).toThrow('doc.md has no "B" heading');
  });
});
