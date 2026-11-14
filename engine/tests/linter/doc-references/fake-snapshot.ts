/**
 * The in-memory `ProjectSnapshot`: the test adapter of the doc-reference port,
 * beside the filesystem one in `src/linter/doc-references/project-snapshot.ts`.
 *
 * A project is its files and their text. A directory is any path some file
 * sits beneath; a path listed in `unwalked` exists (`entryAt`, `read`) but is
 * not in `files()`, as a file beneath `.claude/` is to the project walk.
 */

import { referenceIndex } from "../../../src/linter/doc-references/reference-index";
import type { EntryKind, ProjectSnapshot, ReferenceIndex } from "../../../src/linter/doc-references/types";

export type FakeProject = Readonly<Record<string, string>>;

export function fakeSnapshot(walked: FakeProject, unwalked: FakeProject = {}): ProjectSnapshot {
  const all: FakeProject = { ...walked, ...unwalked };
  const paths = Object.keys(all);
  return Object.freeze({
    files: () => Object.keys(walked).sort(),
    entryAt: (path: string): EntryKind | null => {
      if (Object.hasOwn(all, path)) return "file";
      return paths.some((file) => file.startsWith(`${path}/`)) ? "directory" : null;
    },
    read: (path: string): string | null => (Object.hasOwn(all, path) ? all[path] ?? null : null),
  });
}

/** A spec the engine's spec parser accepts, defining FR-001, FR-002, AS-001 and OOS-001. */
export const VALID_SPEC = [
  "# Feature: Doc references",
  "",
  "## User Scenarios",
  "",
  "### US1: [P1] Resolve a reference",
  "",
  "**Acceptance Scenarios:**",
  "- AS-001: Given a governed doc, When it is linted, Then every reference resolves",
  "",
  "## Functional Requirements",
  "",
  "### Core Requirements",
  "",
  "- FR-001: System MUST resolve every backticked path",
  "- FR-002: System MUST resolve every spec id",
  "",
  "## Out of Scope",
  "",
  "- OOS-001: Reading prose as references",
  "",
  "## Appendix: Glossary",
  "",
  "| Term | Definition |",
  "|------|------------|",
  "| Doc reference | A backticked name a governed document makes |",
  "",
].join("\n");

/** The reference index of an in-memory project. */
export const fakeIndex = (walked: FakeProject, unwalked: FakeProject = {}): ReferenceIndex =>
  referenceIndex(fakeSnapshot(walked, unwalked));
