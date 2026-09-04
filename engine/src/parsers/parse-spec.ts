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
  endLine: number;
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

/**
 * Recognizable structural ID syntax, with or without a Markdown prefix:
 * bare, bold (1–3 asterisks), single-bullet, nested blockquote, heading of
 * any level, or an ordered-list marker of any digit run. Families are
 * case-insensitive with any digit run, any combination of whitespace, dots,
 * and hyphens between the family and the digits, and zero or more whitespace
 * before the colon, so the enumerated near-miss variants fail closed instead
 * of vanishing. The colon and the contiguous family token are the deliberate
 * prose-disambiguation boundary: a colon-less ID-shaped line ("FR-002 and
 * FR-003 are related") and a spaced family token ("F R-002:") are prose, not
 * IDs, and stay legal. Both nets below reference this one pattern so the
 * in-body and document-wide fail-closed checks cannot drift.
 */
const STRUCTURAL_ID = /^\s*(?:\*{1,3}|[*+-]|>+|#+|\d+[.)])?\s*(?:fr|as|oos)[\s.-]*\d+\s*:\s*/iu;

const ACCEPTANCE_HEADER = /^\*\*Acceptance Scenarios:\*\*$/u;

/** CommonMark thematic break: ---, *** or ___ (three or more, whitespace allowed
 * between markers; call sites must trim leading indentation first). */
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

/** Expand leading tabs to the next 4-column tab stop (CommonMark tab
 * indentation), so fence and furniture logic sees the columns editors see.
 * Tabs inside content are untouched. */
function expandLeadingTabs(line: string): string {
  let column = 0;
  let index = 0;
  while (index < line.length && (line[index] === " " || line[index] === "\t")) {
    if (line[index] === "\t") {
      const spaces = 4 - (column % 4);
      line = line.slice(0, index) + " ".repeat(spaces) + line.slice(index + 1);
      column += spaces;
      index += spaces;
    } else {
      column += 1;
      index += 1;
    }
  }
  return line;
}

/**
 * Blank fenced examples and indented-code furniture while preserving headings
 * and line numbers outside them, aligned with CommonMark in both directions:
 * an opener is a 3+ marker of one character at up to three spaces of
 * indentation, carrying an optional info string — for backtick markers the
 * info string may not contain a backtick (CommonMark calls such a line
 * paragraph text); a closer is a marker-only line (nothing but whitespace
 * after) of the same character, equal or longer. Lines indented four or more
 * spaces are furniture only after a blank line, a fence line, or the start of
 * the document (an indented code block cannot interrupt a paragraph); lazy
 * continuations are real content. The returned flag marks an unterminated
 * fence so parseSpec can fail closed.
 */
function withoutFences(markdown: string): Readonly<{ text: string; unterminated: boolean }> {
  let marker: Readonly<{ char: string; length: number }> | null = null;
  let previousBlank = true;
  const out: string[] = [];
  for (const rawLine of markdown.replace(/\r\n?/gu, "\n").split("\n")) {
    // CommonMark expands each tab to the next 4-column tab stop: a
    // tab-indented line after a blank line is indented code, never spec text,
    // and a tab-indented fence marker at 4+ columns is code furniture, not a
    // fence boundary. Tabs inside content are untouched.
    const line = expandLeadingTabs(rawLine);
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence === null) {
      if (marker !== null) {
        out.push("");
        previousBlank = true;
        continue;
      }
      // An indented code block cannot interrupt a paragraph: a 4+-space
      // indented line is furniture only after a blank line (or the start of
      // the document); a lazy continuation is real content.
      if (previousBlank && /^ {4,}/u.test(line)) {
        out.push("");
        previousBlank = true;
        continue;
      }
      out.push(line);
      previousBlank = line.trim().length === 0;
      continue;
    }
    const rawMarker = fence[1];
    const info = fence[2] ?? "";
    // CommonMark: info strings for backtick code blocks may not contain
    // backticks — such a line is paragraph text, never a fence opener, and it
    // can never close (closers are marker-only). Inside an open fence it is
    // fence content: the fall-through below blanks it, and the closer
    // condition cannot fire (the info string is non-empty).
    if (rawMarker[0] === "`" && info.includes("`") && marker === null) {
      out.push(line);
      previousBlank = false;
      continue;
    }
    if (marker === null) {
      marker = Object.freeze({ char: rawMarker[0], length: rawMarker.length });
    } else if (marker.char === rawMarker[0] && rawMarker.length >= marker.length && info.trim().length === 0) {
      marker = null;
    }
    out.push("");
    previousBlank = true;
  }
  return Object.freeze({ text: out.join("\n"), unterminated: marker !== null });
}

function sections(markdown: string): readonly MarkdownSection[] {
  const headings = [...markdown.matchAll(/^##\s+(.+?)\s*$/gmu)];
  const isSectionName = (value: string): value is SectionName =>
    REQUIRED_SECTIONS.some((section) => section === value);
  const lineAt = (byteOffset: number): number => markdown.slice(0, byteOffset).split("\n").length;
  return Object.freeze(headings.flatMap((match, index): readonly MarkdownSection[] => {
    const heading = match[1]?.trim();
    if (heading === undefined || !isSectionName(heading)) return [];
    const start = (match.index ?? 0) + match[0].length;
    const startLine = lineAt(start);
    const nextHeadingLine = headings[index + 1] === undefined
      ? markdown.split("\n").length + 1
      : lineAt(headings[index + 1].index ?? 0);
    return [Object.freeze({
      heading,
      body: markdown.slice(start, headings[index + 1]?.index ?? markdown.length),
      startLine,
      endLine: nextHeadingLine,
    })];
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
      // A recognizable structural ID without a "- " bullet would otherwise
      // be silently dropped; fail closed. The JSDoc above owns the full
      // accepted prefix set.
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
  const closeBlock = (headerLine: number): void => {
    errors.push(`Acceptance Scenarios block starting at line ${headerLine} contains no scenario bullets`);
  };
  let state: Readonly<{ kind: "before" }>
    | Readonly<{ kind: "inside"; headerLine: number; sawBullet: boolean }>
    | Readonly<{ kind: "after" }> = Object.freeze({ kind: "before" });
  const isCollectedBullet = (raw: string): boolean => state.kind === "inside" && raw.trim().startsWith("-");
  const strayIdError = (inside: boolean, documentLine: number): string =>
    inside
      ? `Acceptance Scenarios line ${documentLine} must be a "- ID: content" bullet`
      : `Acceptance Scenarios line ${documentLine} must be a "- ID: content" bullet under an **Acceptance Scenarios:** block`;
  for (const { raw, documentLine } of lines) {
    const line = raw.trim();
    if (ACCEPTANCE_HEADER.test(line)) {
      if (state.kind === "inside" && !state.sawBullet) closeBlock(state.headerLine);
      state = Object.freeze({ kind: "inside", headerLine: documentLine, sawBullet: false });
      continue;
    }
    const subHeading = /^###\s+/u.test(line);
    if (subHeading || isThematicBreak(line)) {
      // A ###-prefixed structural ID is not a real heading (sections() splits
      // only on ##, so the line never truncates the section body) — without
      // this check it would be silently dropped here. Fail closed, never
      // vanish; the terminator behavior is preserved either way.
      if (subHeading && STRUCTURAL_ID.test(raw)) errors.push(strayIdError(state.kind === "inside", documentLine));
      if (state.kind === "inside") {
        if (!state.sawBullet) closeBlock(state.headerLine);
        state = Object.freeze({ kind: "after" });
      }
      continue;
    }
    // A recognizable structural ID that is not a collected bullet — in or out
    // of an acceptance block — must fail closed, never vanish.
    if (STRUCTURAL_ID.test(raw) && !isCollectedBullet(raw)) errors.push(strayIdError(state.kind === "inside", documentLine));
    if (state.kind !== "inside" || !line.startsWith("-")) continue;
    // Deliberate asymmetry, stated at the seam: outside an acceptance block a
    // non-ID bullet is narrative furniture in a narrative section and passes;
    // FR/OOS are entry-only sections, so any bullet there errors.
    scenarios.push(Object.freeze({ raw, documentLine }));
    state = Object.freeze({ kind: "inside", headerLine: state.headerLine, sawBullet: true });
  }
  if (state.kind === "inside" && !state.sawBullet) closeBlock(state.headerLine);
  if (state.kind === "before") errors.push("User Scenarios must contain at least one **Acceptance Scenarios:** block");
  return Object.freeze(scenarios);
}

function parseGlossary(lines: readonly SourceLine[], errors: string[]): readonly SpecGlossaryEntry[] {
  const entries: SpecGlossaryEntry[] = [];
  // Locale-pinned so host locale cannot change dedup: en-US, always.
  const lower = (value: string): string => value.toLocaleLowerCase("en-US");
  for (const { raw, documentLine } of lines) {
    const line = raw.trim();
    if (!line.startsWith("|")) {
      // The glossary grammar is table rows only; a stray structural ID or prose
      // row would otherwise silently vanish. Thematic breaks and blank lines
      // are furniture.
      if (STRUCTURAL_ID.test(raw) || (line.length > 0 && !isThematicBreak(line))) {
        errors.push(`Glossary line ${documentLine} must be a "| Term | Definition" row`);
      }
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((cell) => canonicalContent(cell));
    if (cells.length !== 2) {
      errors.push(`Glossary line ${documentLine} must contain exactly Term and Definition columns`);
      continue;
    }
    // Silently skip only the separator row (GFM accepts 1+ hyphens per cell)
    // and the case-insensitive header shape; any reserved-term data row is
    // both dropped from entries and flagged as an error, never silently
    // dropped.
    if (cells.every((cell) => /^:?-{1,}:?$/u.test(cell))) continue;
    const [term, definition] = cells;
    if (lower(term) === "term") {
      if (lower(definition) !== "definition") {
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
  for (const term of duplicates(entries.map(({ term }) => lower(term)))) {
    errors.push(`Glossary contains duplicate term ${JSON.stringify(term)}`);
  }
  return Object.freeze(entries);
}

/** Parse one canonical specification into deterministic structural join inputs. */
export function parseSpec(markdown: string): SpecParseResult {
  const errors: string[] = [];
  const stripped = withoutFences(markdown);
  if (stripped.unterminated) errors.push("spec contains an unterminated code fence");
  const parsedSections = sections(stripped.text);
  const bySection = sectionMap(parsedSections, errors);

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

  // A reserved-family structural ID anywhere outside the parsed sections'
  // bodies — preamble, non-required section, or stray prose bullet — must fail
  // closed; template furniture stays legal.
  const collectedRanges = parsedSections.map((section) =>
    Object.freeze({ start: section.startLine, end: section.endLine }),
  );
  for (const { raw, documentLine } of sourceLines(stripped.text, 1)) {
    const consumed = collectedRanges.some((range) => documentLine >= range.start && documentLine < range.end);
    if (!consumed && STRUCTURAL_ID.test(raw)) {
      errors.push(`structural ID at line ${documentLine} is outside a parsed section`);
    }
  }

  const [head, ...tail] = errors;
  if (head === undefined) {
    return Object.freeze({ ok: true, value: Object.freeze({ frs, scenarios, oos, glossary }) });
  }
  const nonEmptyErrors: readonly [string, ...string[]] = Object.freeze([head, ...tail]);
  return Object.freeze({ ok: false, errors: nonEmptyErrors });
}
