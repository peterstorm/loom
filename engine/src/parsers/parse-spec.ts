import { createHash } from "node:crypto";

declare const SPEC_ENTRY_ID: unique symbol;
declare const SPEC_CONTENT_HASH: unique symbol;

export type SpecEntryId = string & { readonly [SPEC_ENTRY_ID]: true };
export type SpecContentHash = string & { readonly [SPEC_CONTENT_HASH]: true };

export type SpecEntry = Readonly<{
  id: SpecEntryId;
  content: string;
  contentHash: SpecContentHash;
}>;

export type SpecGlossaryEntry = Readonly<{
  term: string;
  definition: string;
  contentHash: SpecContentHash;
}>;

export type ParsedSpec = Readonly<{
  frs: readonly SpecEntry[];
  scenarios: readonly SpecEntry[];
  oos: readonly SpecEntry[];
  glossary: readonly SpecGlossaryEntry[];
}>;

export type SpecParseResult =
  | Readonly<{ ok: true; value: ParsedSpec }>
  | Readonly<{ ok: false; errors: readonly [string, ...string[]] }>;

const REQUIRED_SECTIONS = ["User Scenarios", "Functional Requirements", "Out of Scope", "Appendix: Glossary"] as const;

type SectionName = (typeof REQUIRED_SECTIONS)[number];

type MarkdownSection = Readonly<{
  heading: SectionName;
  body: string;
  startLine: number;
}>;

type SourceLine = Readonly<{
  raw: string;
  documentLine: number;
}>;

const ENTRY_PATTERNS = Object.freeze({
  frs: /^-\s+(FR-\d{3}):\s+(.+?)\s*$/u,
  scenarios: /^-\s+(AS-\d{3}):\s+(.+?)\s*$/u,
  oos: /^-\s+(OOS-\d{3}):\s+(.+?)\s*$/u,
});

/** Recognizable structural ID syntax, with or without a Markdown bullet. */
const STRUCTURAL_ID = /^\s*[*+-]?\s*[A-Z]{2,3}-\d{3}:\s*/u;

const ACCEPTANCE_HEADER = /^\*\*Acceptance Scenarios:\*\*$/u;

/** CommonMark thematic break: ---, *** or ___ (three or more, spaces allowed). */
const THEMATIC_BREAK = /^(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/u;

function isThematicBreak(line: string): boolean {
  return THEMATIC_BREAK.test(line);
}

function canonicalContent(content: string): string {
  return content.trim().replace(/\s+/gu, " ");
}

export function specContentHash(content: string): SpecContentHash {
  return createHash("sha256").update(canonicalContent(content), "utf8").digest("hex") as SpecContentHash;
}

/** Every duplicated value, in order of each value's first duplicate occurrence, once each. */
function duplicates(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.filter((value, index) => values.indexOf(value) !== index))]);
}

/**
 * Blank fenced examples while preserving headings and line numbers outside them.
 * Closing follows CommonMark: a fence closes only on an equal-or-longer marker of
 * the same character, so 4+ backtick fences cannot be closed early by ``` fences.
 * Fence detection itself accepts any leading whitespace, diverging from
 * CommonMark's three-space limit. The returned flag marks an unterminated fence
 * so parseSpec can fail closed.
 */
function withoutFences(markdown: string): Readonly<{ text: string; unterminated: boolean }> {
  let marker: Readonly<{ char: string; length: number }> | null = null;
  const text = markdown
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => {
      const fence = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
      if (fence !== undefined) {
        if (marker === null) marker = Object.freeze({ char: fence[0], length: fence.length });
        else if (marker.char === fence[0] && fence.length >= marker.length) marker = null;
        return "";
      }
      return marker === null ? line : "";
    })
    .join("\n");
  return Object.freeze({ text, unterminated: marker !== null });
}

function sections(markdown: string): readonly MarkdownSection[] {
  const headings = [...markdown.matchAll(/^##\s+(.+?)\s*$/gmu)];
  return Object.freeze(headings.flatMap((match, index): readonly MarkdownSection[] => {
    const heading = match[1]?.trim() as SectionName | undefined;
    if (heading === undefined || !REQUIRED_SECTIONS.includes(heading)) return [];
    const start = (match.index ?? 0) + match[0].length;
    const end = headings[index + 1]?.index ?? markdown.length;
    const startLine = markdown.slice(0, start).split("\n").length;
    return [Object.freeze({ heading, body: markdown.slice(start, end), startLine })];
  }));
}

function sectionMap(parsed: readonly MarkdownSection[], errors: string[]): ReadonlyMap<SectionName, MarkdownSection> {
  const map = new Map<SectionName, MarkdownSection>();
  for (const heading of REQUIRED_SECTIONS) {
    const matching = parsed.filter((section) => section.heading === heading);
    if (matching.length === 0) errors.push(`missing required section ## ${heading}`);
    else if (matching.length > 1) errors.push(`section ## ${heading} must appear exactly once`);
    else map.set(heading, matching[0]);
  }
  return map;
}

function sourceLines(body: string, startLine: number): readonly SourceLine[] {
  return Object.freeze(
    body.split("\n").map((raw, index) => Object.freeze({ raw, documentLine: startLine + index })),
  );
}

/** One owner for the missing-section fallback; fires only after sectionMap has already errored. */
function sectionLines(section: MarkdownSection | undefined): readonly SourceLine[] {
  return sourceLines(section?.body ?? "", section?.startLine ?? 1);
}

function parseEntries(
  lines: readonly SourceLine[],
  pattern: RegExp,
  label: string,
  errors: string[],
): readonly SpecEntry[] {
  const entries: SpecEntry[] = [];
  for (const { raw, documentLine } of lines) {
    const line = raw.trim();
    if (!line.startsWith("-")) {
      // A recognizable structural ID without a "- " bullet would otherwise be
      // silently dropped; fail closed instead of continuing past it.
      if (STRUCTURAL_ID.test(raw)) errors.push(`${label} line ${documentLine} must be a "- ID: content" bullet`);
      continue;
    }
    if (isThematicBreak(line)) continue;
    const match = pattern.exec(line);
    if (match === null) {
      errors.push(`${label} line ${documentLine} must use a canonical ${label} ID`);
      continue;
    }
    const id = match[1] as SpecEntryId;
    const content = canonicalContent(match[2]);
    entries.push(Object.freeze({ id, content, contentHash: specContentHash(content) }));
  }
  if (entries.length === 0) errors.push(`${label} must contain at least one entry`);
  for (const id of duplicates(entries.map(({ id }) => id))) {
    errors.push(`${label} contains duplicate ID ${id}`);
  }
  return Object.freeze(entries);
}

function acceptanceScenarioLines(lines: readonly SourceLine[], errors: string[]): readonly SourceLine[] {
  const scenarios: SourceLine[] = [];
  let phase: "before" | "inside" | "after" = "before";
  for (const { raw, documentLine } of lines) {
    const line = raw.trim();
    if (ACCEPTANCE_HEADER.test(line)) {
      phase = "inside";
      continue;
    }
    if (/^###\s+/u.test(line) || isThematicBreak(line)) {
      if (phase === "inside") phase = "after";
      continue;
    }
    // A recognizable structural ID that is not a collected bullet — in or out
    // of an acceptance block — must fail closed, never vanish.
    if (STRUCTURAL_ID.test(raw) && !(phase === "inside" && line.startsWith("-"))) {
      errors.push(
        phase === "inside"
          ? `Acceptance Scenarios line ${documentLine} must be a "- ID: content" bullet`
          : `Acceptance Scenarios line ${documentLine} must be a "- ID: content" bullet under an **Acceptance Scenarios:** block`,
      );
      continue;
    }
    if (phase !== "inside" || !line.startsWith("-")) continue;
    scenarios.push(Object.freeze({ raw, documentLine }));
  }
  if (phase === "before") errors.push("User Scenarios must contain at least one **Acceptance Scenarios:** block");
  return Object.freeze(scenarios);
}

function parseGlossary(lines: readonly SourceLine[], errors: string[]): readonly SpecGlossaryEntry[] {
  const entries: SpecGlossaryEntry[] = [];
  for (const { raw, documentLine } of lines) {
    const line = raw.trim();
    if (!line.startsWith("|")) {
      // The glossary grammar is table rows only; a stray structural ID would
      // otherwise silently vanish.
      if (STRUCTURAL_ID.test(raw)) {
        errors.push(`Glossary line ${documentLine} must be a "| Term | Definition" row`);
      }
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((cell) => canonicalContent(cell));
    if (cells.length !== 2) {
      errors.push(`Glossary line ${documentLine} must contain exactly Term and Definition columns`);
      continue;
    }
    // Silently skip only the separator row and the exact header shape; any
    // reserved-term data row is both dropped from entries and flagged as an
    // error, never silently dropped.
    if (cells.every((cell) => /^:?-{2,}:?$/u.test(cell))) continue;
    const [term, definition] = cells;
    if (term.toLocaleLowerCase("en-US") === "term") {
      if (definition.toLocaleLowerCase("en-US") !== "definition") {
        errors.push(`Glossary line ${documentLine} uses the reserved header term ${JSON.stringify(term)}`);
      }
      continue;
    }
    if (term === "" || definition === "") {
      errors.push(`Glossary line ${documentLine} requires a non-empty term and definition`);
      continue;
    }
    entries.push(Object.freeze({
      term,
      definition,
      contentHash: specContentHash(`${term}: ${definition}`),
    }));
  }
  if (entries.length === 0) errors.push("Glossary must contain at least one term");
  for (const term of duplicates(entries.map(({ term }) => term.toLocaleLowerCase("en-US")))) {
    errors.push(`Glossary contains duplicate term ${JSON.stringify(term)}`);
  }
  return Object.freeze(entries);
}

/** Parse one canonical specification into deterministic structural join inputs. */
export function parseSpec(markdown: string): SpecParseResult {
  const errors: string[] = [];
  const stripped = withoutFences(markdown);
  if (stripped.unterminated) errors.push("spec contains an unterminated code fence");
  const bySection = sectionMap(sections(stripped.text), errors);

  const frs = parseEntries(
    sectionLines(bySection.get("Functional Requirements")),
    ENTRY_PATTERNS.frs,
    "Functional Requirements",
    errors,
  );
  const scenarios = parseEntries(
    acceptanceScenarioLines(sectionLines(bySection.get("User Scenarios")), errors),
    ENTRY_PATTERNS.scenarios,
    "Acceptance Scenarios",
    errors,
  );
  const oos = parseEntries(
    sectionLines(bySection.get("Out of Scope")),
    ENTRY_PATTERNS.oos,
    "Out of Scope",
    errors,
  );
  const glossary = parseGlossary(sectionLines(bySection.get("Appendix: Glossary")), errors);

  const [head, ...tail] = errors;
  if (head === undefined) {
    return Object.freeze({ ok: true, value: Object.freeze({ frs, scenarios, oos, glossary }) });
  }
  const nonEmptyErrors: readonly [string, ...string[]] = Object.freeze([head, ...tail]);
  return Object.freeze({ ok: false, errors: nonEmptyErrors });
}
