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

const ADR_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "adr");
const index = readFileSync(join(ADR_DIR, "README.md"), "utf-8");
const adrFiles = readdirSync(ADR_DIR).filter((name) => /^ADR-\d{4}-.+\.md$/.test(name)).sort();

type IndexRow = Readonly<{ file: string; status: string }>;

const indexRows: readonly IndexRow[] = index.split("\n").flatMap((line) => {
  const cells = line.split("|").map((cell) => cell.trim());
  const link = /^\[ADR-\d{4}\]\(([^)]+)\)$/.exec(cells[1] ?? "");
  return link === null ? [] : [{ file: link[1]!, status: cells[3] ?? "" }];
});

/** The first word of the first non-empty line under an ADR's `## Status` heading. */
const statusWordOf = (file: string): string => {
  const lines = readFileSync(join(ADR_DIR, file), "utf-8").split("\n");
  const heading = lines.findIndex((line) => /^#{2,3}\s*Status\s*$/i.test(line));
  // No Status heading is no status word, never the file's first line.
  if (heading === -1) return "";
  const first = lines.slice(heading + 1).find((line) => line.trim() !== "") ?? "";
  return /^[A-Za-z]+/.exec(first.replace(/\*/g, "").trim())?.[0] ?? "";
};

describe("docs/adr/README.md", () => {
  it("has exactly one row per ADR file, in file order", () => {
    expect(indexRows.map(({ file }) => file)).toEqual(adrFiles);
  });

  it("states each ADR's own status", () => {
    const stale = indexRows
      .map(({ file, status }) => ({ file, status, stated: statusWordOf(file) }))
      .filter(({ status, stated }) => stated === "" || !status.startsWith(stated));
    expect(stale).toEqual([]);
  });
});
