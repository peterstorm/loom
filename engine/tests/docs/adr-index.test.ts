/**
 * docs/adr/README.md lists every ADR with the status its own file states.
 *
 * The index used to be a hand-kept list inside docs/README.md, and it drifted:
 * an ADR was missing and none carried a status. The index is derived from the
 * files, so this suite holds it to them: one row per ADR file, no row for a
 * file that does not exist, and each row's status equal to the leading word of
 * that ADR's Status section.
 *
 * The two readers it holds them with — a row's file, an ADR's stated status —
 * are pure over Markdown text, and pinned on inline documents first, so a
 * reader that went blind to a malformed ADR fails here rather than passing
 * the live check vacuously.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeMarkdownError, markdown, sectionOf, tableWithColumns, type MarkdownSource } from "../../src/linter/markdown";
import { orFail } from "../support/or-fail";

const ADR_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "adr");

type IndexRow = Readonly<{ file: string; status: string }>;

/** One index row. An ADR cell that is not a `[ADR-NNNN](file)` link is kept whole, so the file comparison names it. */
const indexRowOf = (cells: Readonly<Record<"ADR" | "Status", string>>): IndexRow => ({
  file: /^\[ADR-\d{4}\]\(([^)]+)\)$/.exec(cells.ADR)?.[1] ?? cells.ADR,
  status: cells.Status,
});

/** The index table's rows. */
const indexRowsOf = (index: MarkdownSource): readonly IndexRow[] =>
  orFail(tableWithColumns(index, ["ADR", "Status"]), describeMarkdownError).rows.map(({ cells }) => indexRowOf(cells));

/** What an ADR's Status section states: its leading word, or why there is none. */
type StatedStatus =
  | Readonly<{ kind: "word"; word: string }>
  | Readonly<{ kind: "no-word"; firstLine: string }>
  | Readonly<{ kind: "unreadable"; reason: string }>;

/** The first word of the first non-empty line under an ADR's Status heading, emphasis aside. */
const statedStatusOf = (adr: MarkdownSource): StatedStatus => {
  const section = sectionOf(adr, "Status");
  if (!section.ok) return { kind: "unreadable", reason: describeMarkdownError(section.error) };
  const firstLine = section.value.lines.find((line) => line.trim() !== "") ?? "";
  const word = /^[A-Za-z]+/.exec(firstLine.replace(/\*/g, "").trim())?.[0];
  return word === undefined ? { kind: "no-word", firstLine } : { kind: "word", word };
};

const anAdr = (...body: readonly string[]) => markdown("ADR-0001-x.md", ["# ADR-0001: X", "", ...body].join("\n"));

describe("statedStatusOf", () => {
  it("reads the leading word of the Status section, emphasis aside", () => {
    expect(statedStatusOf(anAdr("## Status", "", "**Accepted** (2026-11-14)", "", "## Context", "Later."))).toEqual({ kind: "word", word: "Accepted" });
  });

  it("names a missing Status heading as unreadable", () => {
    expect(statedStatusOf(anAdr("## Context", "", "Accepted by nobody."))).toEqual({
      kind: "unreadable",
      reason: describeMarkdownError({ kind: "heading-not-found", source: "ADR-0001-x.md", heading: "Status" }),
    });
  });

  it("finds no word in an empty Status section", () => {
    expect(statedStatusOf(anAdr("## Status", "", "## Context", "Accepted."))).toEqual({ kind: "no-word", firstLine: "" });
  });

  it("finds no word in a Status line that opens with something other than a letter", () => {
    expect(statedStatusOf(anAdr("## Status", "", "- Accepted", "Superseded by ADR-0002."))).toEqual({ kind: "no-word", firstLine: "- Accepted" });
  });
});

describe("indexRowOf", () => {
  it("reads the file a `[ADR-NNNN](file)` link points at", () => {
    expect(indexRowOf({ ADR: "[ADR-0007](ADR-0007-x.md)", Status: "Accepted" })).toEqual({ file: "ADR-0007-x.md", status: "Accepted" });
  });

  it.each(["ADR-0007-x.md", "[ADR-7](ADR-0007-x.md)", "[ADR-0007](ADR-0007-x.md) and more"])(
    "keeps the cell %j whole when it is not exactly one ADR link",
    (cell) => {
      expect(indexRowOf({ ADR: cell, Status: "Accepted" }).file).toBe(cell);
    },
  );
});

describe("docs/adr/README.md", () => {
  const index = markdown("docs/adr/README.md", readFileSync(join(ADR_DIR, "README.md"), "utf-8"));
  const adrFiles = readdirSync(ADR_DIR).filter((name) => /^ADR-\d{4}-.+\.md$/.test(name)).sort();
  const adrOf = (file: string) => markdown(file, readFileSync(join(ADR_DIR, file), "utf-8"));

  it("has exactly one row per ADR file, in file order", () => {
    expect(indexRowsOf(index).map(({ file }) => file)).toEqual(adrFiles);
  });

  it("states each ADR's own status", () => {
    const stale = indexRowsOf(index)
      .map(({ file, status }) => ({ file, status, stated: statedStatusOf(adrOf(file)) }))
      .filter(({ status, stated }) => stated.kind !== "word" || !status.startsWith(stated.word));
    expect(stale).toEqual([]);
  });
});
