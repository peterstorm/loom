/**
 * docs/adr/README.md lists every ADR with the status its own file states.
 *
 * The index used to be a hand-kept list inside docs/README.md, and it drifted:
 * an ADR was missing and none carried a status. The index is derived from the
 * files, so this suite holds it to them: one row per ADR file, no row for a
 * file that does not exist, and each row's status equal to the leading word of
 * that ADR's Status section.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeMarkdownError, markdown, orFail, sectionOf, tableWithColumns } from "../support/markdown";

const ADR_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "adr");
const index = markdown("docs/adr/README.md", readFileSync(join(ADR_DIR, "README.md"), "utf-8"));
const adrFiles = readdirSync(ADR_DIR).filter((name) => /^ADR-\d{4}-.+\.md$/.test(name)).sort();

type IndexRow = Readonly<{ file: string; status: string }>;

/** The index table's rows. An ADR cell that is not a `[ADR-NNNN](file)` link is kept whole, so the file comparison names it. */
const indexRows = (): readonly IndexRow[] =>
  orFail(tableWithColumns(index, ["ADR", "Status"]), describeMarkdownError).rows.map(({ cells }) => ({
    file: /^\[ADR-\d{4}\]\(([^)]+)\)$/.exec(cells.ADR)?.[1] ?? cells.ADR,
    status: cells.Status,
  }));

/** What an ADR's Status section states: its leading word, or why there is none. */
type StatedStatus =
  | Readonly<{ kind: "word"; word: string }>
  | Readonly<{ kind: "no-word"; firstLine: string }>
  | Readonly<{ kind: "unreadable"; reason: string }>;

/** The first word of the first non-empty line under an ADR's Status heading. */
const statedStatusOf = (file: string): StatedStatus => {
  const section = sectionOf(markdown(file, readFileSync(join(ADR_DIR, file), "utf-8")), "Status");
  if (!section.ok) return { kind: "unreadable", reason: describeMarkdownError(section.error) };
  const firstLine = section.value.lines.find((line) => line.trim() !== "") ?? "";
  const word = /^[A-Za-z]+/.exec(firstLine.replace(/\*/g, "").trim())?.[0];
  return word === undefined ? { kind: "no-word", firstLine } : { kind: "word", word };
};

describe("docs/adr/README.md", () => {
  it("has exactly one row per ADR file, in file order", () => {
    expect(indexRows().map(({ file }) => file)).toEqual(adrFiles);
  });

  it("states each ADR's own status", () => {
    const stale = indexRows()
      .map(({ file, status }) => ({ file, status, stated: statedStatusOf(file) }))
      .filter(({ status, stated }) => stated.kind !== "word" || !status.startsWith(stated.word));
    expect(stale).toEqual([]);
  });
});
