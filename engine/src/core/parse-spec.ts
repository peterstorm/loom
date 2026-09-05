import { createHash } from "node:crypto";
import { match } from "ts-pattern";

declare const SPEC_ENTRY_ID: unique symbol;
declare const SPEC_CONTENT_HASH: unique symbol;
declare const HASHED_BY_CONSTRUCTION: unique symbol;

/** The structural identifier families a Spec Index projects. */
export type SpecFamily = "FR" | "AS" | "OOS";

/**
 * A canonical identifier, branded with the family it names: a `SpecEntryId<"FR">`
 * is not a `SpecEntryId<"AS">`, so the three projected collections cannot be
 * passed in each other's place.
 */
export type SpecEntryId<F extends SpecFamily = SpecFamily> = string & { readonly [SPEC_ENTRY_ID]: F };
export type SpecContentHash = string & { readonly [SPEC_CONTENT_HASH]: true };

/**
 * Phantom witness that the carrier's `contentHash` was derived from the
 * carrier's own content. It has no runtime representation; its only job is to
 * make the smart constructors below the sole origin of an entry, so an entry
 * whose hash disagrees with its content is unrepresentable outside this module.
 */
type HashedByConstruction = Readonly<{ [HASHED_BY_CONSTRUCTION]: true }>;

export type SpecEntry<F extends SpecFamily = SpecFamily> = Readonly<{
  id: SpecEntryId<F>;
  content: string;
  contentHash: SpecContentHash;
}> & HashedByConstruction;

export type SpecGlossaryEntry = Readonly<{
  term: string;
  definition: string;
  contentHash: SpecContentHash;
}> & HashedByConstruction;

export type NonEmpty<T> = readonly [T, ...T[]];

/**
 * A successful projection. Every collection is non-empty because the parser
 * proves it — an empty section is itself a parse failure — so the guarantee
 * travels in the type instead of being re-checked by each consumer.
 */
export type ParsedSpec = Readonly<{
  frs: NonEmpty<SpecEntry<"FR">>;
  scenarios: NonEmpty<SpecEntry<"AS">>;
  oos: NonEmpty<SpecEntry<"OOS">>;
  glossary: NonEmpty<SpecGlossaryEntry>;
}>;

const REQUIRED_SECTIONS = ["User Scenarios", "Functional Requirements", "Out of Scope", "Appendix: Glossary"] as const;

type SectionName = (typeof REQUIRED_SECTIONS)[number];

/** The three entry grammars as they are named in diagnostics. "Acceptance
 * Scenarios" is a block inside ## User Scenarios, not a section of its own. */
type EntrySection = "Functional Requirements" | "Acceptance Scenarios" | "Out of Scope";

/**
 * Every way one specification can fail to project into a Spec Index, as data.
 * Callers discriminate on `kind` and read the structured payload instead of
 * matching diagnostic prose; `specParseErrorMessage` is the single total
 * renderer of the operator-facing text, so rewording a message can never
 * change a caller's control flow.
 */
export type SpecParseError =
  | Readonly<{ kind: "unterminated-fence" }>
  | Readonly<{ kind: "missing-section"; section: SectionName }>
  | Readonly<{ kind: "repeated-section"; section: SectionName }>
  | Readonly<{ kind: "entry-not-bulleted"; section: EntrySection; line: number }>
  | Readonly<{ kind: "entry-not-canonical"; section: EntrySection; line: number }>
  | Readonly<{ kind: "section-has-no-entries"; section: EntrySection }>
  | Readonly<{ kind: "duplicate-entry-id"; section: EntrySection; id: string }>
  | Readonly<{ kind: "scenario-not-bulleted"; line: number; insideBlock: boolean }>
  | Readonly<{ kind: "acceptance-block-has-no-bullets"; headerLine: number }>
  | Readonly<{ kind: "no-acceptance-block" }>
  | Readonly<{ kind: "glossary-row-expected"; line: number }>
  | Readonly<{ kind: "glossary-column-count"; line: number }>
  | Readonly<{ kind: "glossary-reserved-header-term"; line: number; term: string }>
  | Readonly<{ kind: "glossary-cell-empty"; line: number }>
  | Readonly<{ kind: "glossary-has-no-terms" }>
  | Readonly<{ kind: "duplicate-glossary-term"; term: string }>
  | Readonly<{ kind: "id-outside-section"; line: number }>;

export type SpecParseResult =
  | Readonly<{ ok: true; value: ParsedSpec }>
  | Readonly<{ ok: false; errors: NonEmpty<SpecParseError> }>;

/**
 * The total renderer for every `SpecParseError`. Exhaustive by construction: a
 * new failure reason cannot reach the error channel without being given
 * operator-facing text here.
 */
export function specParseErrorMessage(error: SpecParseError): string {
  return match(error)
    .with({ kind: "unterminated-fence" }, () => "spec contains an unterminated code fence")
    .with({ kind: "missing-section" }, ({ section }) => `missing required section ## ${section}`)
    .with({ kind: "repeated-section" }, ({ section }) => `section ## ${section} must appear exactly once`)
    .with({ kind: "entry-not-bulleted" }, ({ section, line }) =>
      `${section} line ${line} must be a "- ID: content" bullet`)
    .with({ kind: "entry-not-canonical" }, ({ section, line }) =>
      `${section} line ${line} must use a canonical ${section} ID`)
    .with({ kind: "section-has-no-entries" }, ({ section }) => `${section} must contain at least one entry`)
    .with({ kind: "duplicate-entry-id" }, ({ section, id }) => `${section} contains duplicate ID ${id}`)
    .with({ kind: "scenario-not-bulleted" }, ({ line, insideBlock }) =>
      `Acceptance Scenarios line ${line} must be a "- ID: content" bullet`
      + (insideBlock ? "" : " under an **Acceptance Scenarios:** block"))
    .with({ kind: "acceptance-block-has-no-bullets" }, ({ headerLine }) =>
      `Acceptance Scenarios block starting at line ${headerLine} contains no scenario bullets`)
    .with({ kind: "no-acceptance-block" }, () =>
      "User Scenarios must contain at least one **Acceptance Scenarios:** block")
    .with({ kind: "glossary-row-expected" }, ({ line }) =>
      `Glossary line ${line} must be a "| Term | Definition" row`)
    .with({ kind: "glossary-column-count" }, ({ line }) =>
      `Glossary line ${line} must contain exactly Term and Definition columns`)
    .with({ kind: "glossary-reserved-header-term" }, ({ line, term }) =>
      `Glossary line ${line} uses the reserved header term ${JSON.stringify(term)}`)
    .with({ kind: "glossary-cell-empty" }, ({ line }) =>
      `Glossary line ${line} requires a non-empty term and definition`)
    .with({ kind: "glossary-has-no-terms" }, () => "Glossary must contain at least one term")
    .with({ kind: "duplicate-glossary-term" }, ({ term }) =>
      `Glossary contains duplicate term ${JSON.stringify(term)}`)
    .with({ kind: "id-outside-section" }, ({ line }) => `structural ID at line ${line} is outside a parsed section`)
    .exhaustive();
}

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

type EntryGrammar = Readonly<{ section: EntrySection; pattern: RegExp }>;

/** One keyed table owns each family's canonical bullet pattern and the name it
 * is diagnosed under, so the two cannot drift apart. */
const ENTRY_GRAMMARS: Readonly<Record<SpecFamily, EntryGrammar>> = Object.freeze({
  FR: Object.freeze({ section: "Functional Requirements", pattern: /^-\s+(FR-\d{3}):\s+(.+?)\s*$/u }),
  AS: Object.freeze({ section: "Acceptance Scenarios", pattern: /^-\s+(AS-\d{3}):\s+(.+?)\s*$/u }),
  OOS: Object.freeze({ section: "Out of Scope", pattern: /^-\s+(OOS-\d{3}):\s+(.+?)\s*$/u }),
});

/**
 * Recognizable structural ID syntax, with or without a Markdown prefix:
 * bare, or a run of one or more Markdown marker characters (`#`, `>`, `*`,
 * `+`, `-`) or ordered-list markers (`1.`, `1)`), optionally separated by
 * whitespace (e.g. `> >`, `- -`, `* *`, `1. 2.`, `> -`) — the CommonMark
 * spaced forms of nested blockquotes, nested bullets, and ordered lists are
 * recognized syntax, not prose. Families are case-insensitive with any digit
 * run, any combination of whitespace, dots, and hyphens between the family
 * and the digits, and zero or more whitespace before the colon, so the
 * enumerated near-miss variants fail closed instead of vanishing. The colon
 * and the contiguous family token are the deliberate prose-disambiguation
 * boundary: a colon-less ID-shaped line ("FR-002 and FR-003 are related")
 * and a spaced family token ("F R-002:") are prose, not IDs, and stay legal.
 * Both nets below reference this one pattern so the in-body and
 * document-wide fail-closed checks cannot drift.
 */
const STRUCTURAL_ID = /^\s*(?:(?:[#>*+-]|\d+[.)])\s*)*(?:fr|as|oos)[\s.-]*\d+\s*:\s*/iu;

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

/** The exact shape `specContentHash` mints: lowercase SHA-256 hex. */
const SPEC_CONTENT_HASH_SHAPE = /^[0-9a-f]{64}$/u;

/**
 * The only way a hash persisted by an earlier phase re-enters the type. Its
 * content is deliberately unavailable here — a recorded hash is compared
 * against a freshly derived one, never re-derived — so this admits the minted
 * shape and nothing else. `null` for anything else, which stops a truncated or
 * hand-edited value from entering the type and then merely failing to match,
 * where it would read as ordinary Requirement drift.
 */
export function parseSpecContentHash(raw: unknown): SpecContentHash | null {
  return typeof raw === "string" && SPEC_CONTENT_HASH_SHAPE.test(raw) ? raw as SpecContentHash : null;
}

/** The only mint for a `SpecEntry`: canonicalizes the content and derives the
 * hash from that same canonical text, so the pair cannot disagree. */
function specEntry<F extends SpecFamily>(id: string, rawContent: string): SpecEntry<F> {
  const content = canonicalContent(rawContent);
  return Object.freeze({
    id: id as SpecEntryId<F>,
    content,
    contentHash: specContentHash(content),
  }) as SpecEntry<F>;
}

/** The only mint for a `SpecGlossaryEntry`; same construction invariant. */
function glossaryEntry(term: string, definition: string): SpecGlossaryEntry {
  return Object.freeze({
    term,
    definition,
    contentHash: specContentHash(`${term}: ${definition}`),
  }) as SpecGlossaryEntry;
}

/** Every duplicated value, in order of each value's first duplicate occurrence, once each. */
function duplicates(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values.filter((value, index) => values.indexOf(value) !== index))]);
}

/** Expand leading tabs to the next 4-column tab stop (CommonMark tab
 * indentation), so fence and furniture logic sees the columns editors see.
 * Tabs inside content are untouched. */
function expandLeadingTabs(line: string): string {
  const leading = /^[\t ]+/u.exec(line);
  if (leading === null) return line;
  const head = leading[0];
  let column = 0;
  let expanded = "";
  for (const char of head) {
    if (char === "\t") {
      const spaces = 4 - (column % 4);
      expanded += " ".repeat(spaces);
      column += spaces;
    } else {
      expanded += " ";
      column += 1;
    }
  }
  return expanded + line.slice(head.length);
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
    const info = fence[2];
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
  return Object.freeze(headings.flatMap((heading, index): readonly MarkdownSection[] => {
    const name = heading[1].trim();
    if (!isSectionName(name)) return [];
    const start = (heading.index ?? 0) + heading[0].length;
    const startLine = lineAt(start);
    // Collected ranges are half-open [startLine, endLine), so the trailing
    // section must end one line past the document's last line or the
    // document-wide fail-closed net stops covering that last line. Both
    // branches count through the same `lineAt`, so the two ends cannot drift.
    const endLine = headings[index + 1] === undefined
      ? lineAt(markdown.length) + 1
      : lineAt(headings[index + 1].index ?? 0);
    return [Object.freeze({
      heading: name,
      body: markdown.slice(start, headings[index + 1]?.index ?? markdown.length),
      startLine,
      endLine,
    })];
  }));
}

function sectionMap(
  parsed: readonly MarkdownSection[],
  errors: SpecParseError[],
): ReadonlyMap<SectionName, MarkdownSection> {
  const map = new Map<SectionName, MarkdownSection>();
  for (const section of REQUIRED_SECTIONS) {
    const matching = parsed.filter((candidate) => candidate.heading === section);
    if (matching.length === 0) errors.push(Object.freeze({ kind: "missing-section", section }));
    else if (matching.length > 1) errors.push(Object.freeze({ kind: "repeated-section", section }));
    else map.set(section, matching[0]);
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

/** Returns the family's entries, or `null` after recording why none exist. An
 * empty section is a parse failure, so the success shape cannot represent it. */
function parseEntries<F extends SpecFamily>(
  family: F,
  lines: readonly SourceLine[],
  errors: SpecParseError[],
): NonEmpty<SpecEntry<F>> | null {
  const { section, pattern } = ENTRY_GRAMMARS[family];
  const entries: SpecEntry<F>[] = [];
  for (const { raw, documentLine } of lines) {
    const line = raw.trim();
    if (!line.startsWith("-")) {
      // A recognizable structural ID without a "- " bullet would otherwise
      // be silently dropped; fail closed. The JSDoc above owns the full
      // accepted prefix set.
      if (STRUCTURAL_ID.test(raw)) {
        errors.push(Object.freeze({ kind: "entry-not-bulleted", section, line: documentLine }));
      }
      continue;
    }
    if (isThematicBreak(line)) continue;
    const matched = pattern.exec(line);
    if (matched === null) {
      errors.push(Object.freeze({ kind: "entry-not-canonical", section, line: documentLine }));
      continue;
    }
    entries.push(specEntry<F>(matched[1], matched[2]));
  }
  if (entries.length === 0) {
    errors.push(Object.freeze({ kind: "section-has-no-entries", section }));
    return null;
  }
  for (const id of duplicates(entries.map(({ id }) => id))) {
    errors.push(Object.freeze({ kind: "duplicate-entry-id", section, id }));
  }
  const [head, ...tail] = entries;
  return Object.freeze([head, ...tail]);
}

/**
 * Collects the scenario bullet lines of the User Scenarios section and fails
 * closed on every stray structural ID, in or out of an acceptance block.
 * Deliberate asymmetry, stated at the seam: outside an acceptance block a
 * non-ID bullet is narrative furniture in a narrative section and passes;
 * FR/OOS are entry-only sections, so any bullet there errors.
 */
function acceptanceScenarioLines(lines: readonly SourceLine[], errors: SpecParseError[]): readonly SourceLine[] {
  const scenarios: SourceLine[] = [];
  const closeBlock = (headerLine: number): void => {
    errors.push(Object.freeze({ kind: "acceptance-block-has-no-bullets", headerLine }));
  };
  let state: Readonly<{ kind: "before" }>
    | Readonly<{ kind: "inside"; headerLine: number; sawBullet: boolean }>
    | Readonly<{ kind: "after" }> = Object.freeze({ kind: "before" });
  const isCollectedBullet = (raw: string): boolean => state.kind === "inside" && raw.trim().startsWith("-");
  const strayId = (documentLine: number): SpecParseError =>
    Object.freeze({ kind: "scenario-not-bulleted", line: documentLine, insideBlock: state.kind === "inside" });
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
      if (subHeading && STRUCTURAL_ID.test(raw)) errors.push(strayId(documentLine));
      if (state.kind === "inside") {
        if (!state.sawBullet) closeBlock(state.headerLine);
        state = Object.freeze({ kind: "after" });
      }
      continue;
    }
    // A recognizable structural ID that is not a collected bullet — in or out
    // of an acceptance block — must fail closed, never vanish.
    if (STRUCTURAL_ID.test(raw) && !isCollectedBullet(raw)) errors.push(strayId(documentLine));
    if (state.kind !== "inside" || !line.startsWith("-")) continue;
    scenarios.push(Object.freeze({ raw, documentLine }));
    state = Object.freeze({ kind: "inside", headerLine: state.headerLine, sawBullet: true });
  }
  if (state.kind === "inside" && !state.sawBullet) closeBlock(state.headerLine);
  if (state.kind === "before") errors.push(Object.freeze({ kind: "no-acceptance-block" }));
  return Object.freeze(scenarios);
}

/** Returns the glossary terms, or `null` after recording that there are none. */
function parseGlossary(lines: readonly SourceLine[], errors: SpecParseError[]): NonEmpty<SpecGlossaryEntry> | null {
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
        errors.push(Object.freeze({ kind: "glossary-row-expected", line: documentLine }));
      }
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((cell) => canonicalContent(cell));
    if (cells.length !== 2) {
      errors.push(Object.freeze({ kind: "glossary-column-count", line: documentLine }));
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
        errors.push(Object.freeze({ kind: "glossary-reserved-header-term", line: documentLine, term }));
      }
      continue;
    }
    if (term === "" || definition === "") {
      errors.push(Object.freeze({ kind: "glossary-cell-empty", line: documentLine }));
      continue;
    }
    entries.push(glossaryEntry(term, definition));
  }
  if (entries.length === 0) {
    errors.push(Object.freeze({ kind: "glossary-has-no-terms" }));
    return null;
  }
  for (const term of duplicates(entries.map(({ term }) => lower(term)))) {
    errors.push(Object.freeze({ kind: "duplicate-glossary-term", term }));
  }
  const [head, ...tail] = entries;
  return Object.freeze([head, ...tail]);
}

/** Parse one canonical specification into deterministic structural join inputs. */
export function parseSpec(markdown: string): SpecParseResult {
  const errors: SpecParseError[] = [];
  const stripped = withoutFences(markdown);
  if (stripped.unterminated) errors.push(Object.freeze({ kind: "unterminated-fence" }));
  const parsedSections = sections(stripped.text);
  const bySection = sectionMap(parsedSections, errors);

  const frs = parseEntries("FR", sectionLines(bySection.get("Functional Requirements")), errors);
  const scenarios = parseEntries(
    "AS",
    acceptanceScenarioLines(sectionLines(bySection.get("User Scenarios")), errors),
    errors,
  );
  const oos = parseEntries("OOS", sectionLines(bySection.get("Out of Scope")), errors);
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
      errors.push(Object.freeze({ kind: "id-outside-section", line: documentLine }));
    }
  }

  // A `null` collection and a recorded diagnostic are the same condition: each
  // collector records its own emptiness before returning `null`, so this guard
  // never reports a failure without a reason, and the success branch carries
  // four proven-non-empty collections.
  if (frs === null || scenarios === null || oos === null || glossary === null || errors.length > 0) {
    const [head, ...tail] = errors;
    const recorded: NonEmpty<SpecParseError> = Object.freeze([head, ...tail]);
    return Object.freeze({ ok: false, errors: recorded });
  }
  return Object.freeze({ ok: true, value: Object.freeze({ frs, scenarios, oos, glossary }) });
}
