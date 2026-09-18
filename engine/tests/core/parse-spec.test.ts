import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as parserBarrel from "../../src/parsers";
import {
  parseSpec,
  parseSpecContentHash,
  specContentHash,
  specParseErrorMessage,
  type ParsedSpec,
  type SpecParseError,
} from "../../src/core/parse-spec";

const validSpec = `# Feature: Structural spec

## User Scenarios

### US1: [P1] Parse a spec

**Acceptance Scenarios:**
- AS-001: Given a canonical spec, When it is parsed, Then structural entries are returned
- AS-002: Given duplicate IDs, When it is parsed, Then parsing fails closed

## Functional Requirements

### Core Requirements

- FR-001: System MUST parse canonical requirement IDs
- FR-002: System MUST hash requirement content deterministically

## Out of Scope

Explicitly NOT part of this feature:

- OOS-001: Symbol-level source indexing
- OOS-002: LLM-derived requirement links

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Spec Index | A deterministic projection of specification entries |
| Content Hash | A SHA-256 digest of canonical entry content |
`;

/** The operator-facing surface, rendered through the one total renderer — used
 * only where the prose itself is the contract under test. */
const messagesOf = (errors: readonly SpecParseError[]): string =>
  errors.map(specParseErrorMessage).join("\n");

/** Document-absolute line of a source line, so typed line assertions track the
 * document instead of hard-coding offsets that drift when it is edited. */
const lineIn = (source: string, needle: string): number =>
  source.split("\n").findIndex((line) => line.startsWith(needle)) + 1;

const lineOf = (needle: string): number => lineIn(validSpec, needle);

const FR_002_LINE = lineOf("- FR-002:");
const AS_002_LINE = lineOf("- AS-002:");
const OOS_002_LINE = lineOf("- OOS-002:");
const SPEC_INDEX_ROW_LINE = lineOf("| Spec Index |");
const CONTENT_HASH_ROW_LINE = lineOf("| Content Hash |");

/** A reserved-family ID parked in a non-required section — the document-wide
 * net's subject, hoisted so its own line number can be derived from it. */
const misplacedIdSpec = validSpec.replace(
  "## Appendix: Glossary",
  "## Open Questions\n\n1. Is FR-003 needed?\n- FR-009: A misplaced requirement\n\n## Appendix: Glossary",
);

describe("parseSpec", () => {
  it("returns immutable FR, acceptance-scenario, out-of-scope, and glossary entries with hashes", () => {
    const parsed = parseSpec(validSpec);

    expect(parsed).toMatchObject({
      ok: true,
      value: {
        frs: [
          { id: "FR-001", content: "System MUST parse canonical requirement IDs" },
          { id: "FR-002", content: "System MUST hash requirement content deterministically" },
        ],
        scenarios: [{ id: "AS-001" }, { id: "AS-002" }],
        oos: [{ id: "OOS-001" }, { id: "OOS-002" }],
        glossary: [{ term: "Spec Index" }, { term: "Content Hash" }],
      },
    });
    if (!parsed.ok) return;
    const { frs, scenarios, oos, glossary } = parsed.value;
    for (const entry of [...frs, ...scenarios, ...oos, ...glossary]) {
      expect(entry.contentHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(Object.isFrozen(entry)).toBe(true);
    }
    for (const collection of [frs, scenarios, oos, glossary]) {
      expect(Object.isFrozen(collection)).toBe(true);
    }
    expect(Object.isFrozen(parsed.value)).toBe(true);
  });

  it("includes wrapped FR, AS, and OOS continuation text in canonical content and hashes", () => {
    const wrapped = validSpec
      .replace(
        "- FR-001: System MUST parse canonical requirement IDs",
        "- FR-001: System MUST parse canonical requirement IDs\n  across wrapped lines",
      )
      .replace(
        "- AS-001: Given a canonical spec, When it is parsed, Then structural entries are returned",
        "- AS-001: Given a canonical spec, When it is parsed, Then structural entries are returned\n  including continuation clauses",
      )
      .replace(
        "- OOS-001: Symbol-level source indexing",
        "- OOS-001: Symbol-level source indexing\n  and generated semantic indexes",
      );
    const parsed = parseSpec(wrapped);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.frs[0].content).toBe(
      "System MUST parse canonical requirement IDs across wrapped lines",
    );
    expect(parsed.value.scenarios[0].content).toContain("including continuation clauses");
    expect(parsed.value.oos[0].content).toContain("and generated semantic indexes");
    expect(parsed.value.frs[0].contentHash).toBe(specContentHash(parsed.value.frs[0].content));
    expect(parsed.value.frs[0].contentHash).not.toBe(
      specContentHash("System MUST parse canonical requirement IDs"),
    );
  });

  it("keeps blank-separated four-space FR, AS, and OOS paragraphs in content authority", () => {
    const wrapped = validSpec
      .replace(
        "- FR-001: System MUST parse canonical requirement IDs",
        "- FR-001: System MUST parse canonical requirement IDs\n\n    including indented requirement detail",
      )
      .replace(
        "- AS-001: Given a canonical spec, When it is parsed, Then structural entries are returned",
        "- AS-001: Given a canonical spec, When it is parsed, Then structural entries are returned\n\n    including an indented outcome",
      )
      .replace(
        "- OOS-001: Symbol-level source indexing",
        "- OOS-001: Symbol-level source indexing\n\n    including generated symbol databases",
      );
    const parsed = parseSpec(wrapped);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.frs[0].content).toContain("including indented requirement detail");
    expect(parsed.value.scenarios[0].content).toContain("including an indented outcome");
    expect(parsed.value.oos[0].content).toContain("including generated symbol databases");
    for (const entry of [parsed.value.frs[0], parsed.value.scenarios[0], parsed.value.oos[0]]) {
      expect(entry.contentHash).toBe(specContentHash(entry.content));
    }
  });

  it("keeps blank-separated nested FR, AS, and OOS clauses in content authority", () => {
    const nested = validSpec
      .replace(
        "- FR-001: System MUST parse canonical requirement IDs",
        "- FR-001: System MUST parse canonical requirement IDs\n\n    - including nested requirement detail",
      )
      .replace(
        "- AS-001: Given a canonical spec, When it is parsed, Then structural entries are returned",
        "- AS-001: Given a canonical spec, When it is parsed, Then structural entries are returned\n\n    - including a nested outcome",
      )
      .replace(
        "- OOS-001: Symbol-level source indexing",
        "- OOS-001: Symbol-level source indexing\n\n    1. including generated symbol databases",
      );
    const parsed = parseSpec(nested);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.frs[0].content).toContain("- including nested requirement detail");
    expect(parsed.value.scenarios[0].content).toContain("- including a nested outcome");
    expect(parsed.value.oos[0].content).toContain("1. including generated symbol databases");
    for (const entry of [parsed.value.frs[0], parsed.value.scenarios[0], parsed.value.oos[0]]) {
      expect(entry.contentHash).toBe(specContentHash(entry.content));
    }
  });

  it.each([
    ["adjacent", "\n"],
    ["blank-separated", "\n\n"],
  ] as const)("keeps %s ordinary nested clauses at the exact two-space continuation boundary", (_label, gap) => {
    const nested = validSpec
      .replace(
        "- FR-001: System MUST parse canonical requirement IDs",
        `- FR-001: System MUST parse canonical requirement IDs${gap}  - ordinary requirement detail`,
      )
      .replace(
        "- AS-001: Given a canonical spec, When it is parsed, Then structural entries are returned",
        `- AS-001: Given a canonical spec, When it is parsed, Then structural entries are returned${gap}  - ordinary outcome detail`,
      )
      .replace(
        "- OOS-001: Symbol-level source indexing",
        `- OOS-001: Symbol-level source indexing${gap}  1. ordinary exclusion detail`,
      );
    const parsed = parseSpec(nested);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.frs[0].content).toContain("- ordinary requirement detail");
    expect(parsed.value.scenarios[0].content).toContain("- ordinary outcome detail");
    expect(parsed.value.oos[0].content).toContain("1. ordinary exclusion detail");
  });

  it.each([
    ["FR", "- FR-001: System MUST parse canonical requirement IDs", "FR-009", "Functional Requirements"],
    ["AS", "- AS-001: Given a canonical spec, When it is parsed, Then structural entries are returned", "AS-009", "Acceptance Scenarios"],
    ["OOS", "- OOS-001: Symbol-level source indexing", "OOS-009", "Out of Scope"],
  ].flatMap(([family, original, nestedId, section]) =>
    ([2, 4] as const).flatMap((indentation) =>
      (["adjacent", "blank-separated"] as const).map((separation) =>
        [family, indentation, separation, original, nestedId, section] as const,
      ),
    ),
  ))(
    "rejects %s structural IDs nested at %i spaces when %s",
    (family, indentation, separation, original, nestedId, section) => {
      const gap = separation === "adjacent" ? "\n" : "\n\n";
      const parsed = parseSpec(validSpec.replace(
        original,
        `${original}${gap}${" ".repeat(indentation)}- ${nestedId}: must not become continuation content`,
      ));

      expect(parsed.ok, `${family} nested ID must fail closed`).toBe(false);
      if (!parsed.ok) {
        expect(parsed.errors).toContainEqual({
          kind: "entry-not-canonical",
          section,
          line: expect.any(Number),
        });
      }
    },
  );

  it.each(["* adjacent item", "+ adjacent item", "1. adjacent item"])(
    "rejects adjacent noncanonical list item %s instead of absorbing it as lazy Requirement text",
    (item) => {
      const parsed = parseSpec(validSpec.replace(
        "- FR-001: System MUST parse canonical requirement IDs",
        `- FR-001: System MUST parse canonical requirement IDs\n${item}`,
      ));
      expect(parsed).toMatchObject({ ok: false });
      if (!parsed.ok) {
        expect(parsed.errors).toContainEqual(expect.objectContaining({
          kind: "entry-not-canonical",
          section: "Functional Requirements",
        }));
      }
    },
  );

  it("ignores indented code after a heading terminates a Requirement list item", () => {
    const parsed = parseSpec(validSpec.replace(
      "- FR-001: System MUST parse canonical requirement IDs",
      "- FR-001: System MUST parse canonical requirement IDs\n### Examples\n\n    FR-999: literal code sample",
    ));
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(parsed.value.frs.map(({ id }) => id)).toEqual(["FR-001", "FR-002"]);
      expect(parsed.value.frs[0].content).not.toContain("FR-999");
    }
  });

  it("ends FR, AS, and OOS entries before unindented blocks after a blank", () => {
    const separated = validSpec
      .replace(
        "- FR-001: System MUST parse canonical requirement IDs",
        "- FR-001: System MUST parse canonical requirement IDs\n\nUnrelated FR section prose",
      )
      .replace(
        "- AS-001: Given a canonical spec, When it is parsed, Then structural entries are returned",
        "- AS-001: Given a canonical spec, When it is parsed, Then structural entries are returned\n\nUnrelated scenario prose",
      )
      .replace(
        "- OOS-001: Symbol-level source indexing",
        "- OOS-001: Symbol-level source indexing\n\n### A separate exclusions note",
      );
    const parsed = parseSpec(separated);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.frs[0].content).not.toContain("Unrelated");
    expect(parsed.value.scenarios[0].content).not.toContain("Unrelated");
    expect(parsed.value.oos[0].content).not.toContain("separate exclusions note");
  });

  it("makes an empty projection and a swapped family unrepresentable", () => {
    // Compile-time assertions, checked by `tsc` over `tests/`: each expected-
    // error directive below fails the build if its error stops occurring. They
    // pin what the runtime cannot observe — that the guarantees the parser
    // proves (every collection non-empty, each family distinct) live in the
    // type, so no consumer re-checks them and no change can quietly drop them.
    const parsed = parseSpec(validSpec);
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;

    // @ts-expect-error — an empty array is not a NonEmpty projection.
    const empty: ParsedSpec["frs"] = [];
    expect(empty).toEqual([]);

    // @ts-expect-error — a Functional Requirements collection is not an
    // Acceptance Scenarios collection, even though both hold SpecEntry values.
    const swapped: ParsedSpec["scenarios"] = parsed.value.frs;
    expect(swapped.map(({ id }) => id)).toEqual(["FR-001", "FR-002"]);

    // The head of every collection is reachable without an emptiness check.
    expect(parsed.value.frs[0].id).toBe("FR-001");
    expect(parsed.value.scenarios[0].id).toBe("AS-001");
    expect(parsed.value.oos[0].id).toBe("OOS-001");
    expect(parsed.value.glossary[0].term).toBe("Spec Index");
  });

  // The Spec Index moved out of `parsers/` and into the functional core when
  // the Requirement Coverage Projection needed it: `core/` may not import
  // `parsers/`, and opening that arrow to reach one pure projection would have
  // inverted the layering for every core module. The barrel must therefore NOT
  // re-export it — a re-export is exactly the import path the boundary refuses,
  // and it would compile until the day a core module used it.
  it("is not reachable through the parser barrel", () => {
    expect(Object.hasOwn(parserBarrel, "parseSpec")).toBe(false);
    expect(Object.hasOwn(parserBarrel, "specContentHash")).toBe(false);
  });

  it("collects scenarios from every Acceptance Scenarios block", () => {
    const multiBlock = validSpec.replace(
      /## User Scenarios[\s\S]*?## Functional Requirements/u,
      [
        "## User Scenarios",
        "",
        "### US1: [P1] First",
        "",
        "**Acceptance Scenarios:**",
        "- AS-001: given a, When b, Then c",
        "",
        "### US2: [P2] Second",
        "",
        "**Acceptance Scenarios:**",
        "- AS-002: given d, When e, Then f",
        "",
        "### US3: [P3] Third",
        "",
        "**Acceptance Scenarios:**",
        "- AS-003: given g, When h, Then i",
        "",
        "## Functional Requirements",
      ].join("\n"),
    );
    const parsed = parseSpec(multiBlock);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.scenarios.map(({ id }) => id)).toEqual(["AS-001", "AS-002", "AS-003"]);
  });

  it("ignores canonical-looking examples inside fenced blocks", () => {
    const parsed = parseSpec(validSpec.replace(
      "## Out of Scope",
      "```markdown\n## Functional Requirements\n- FR-999: quoted example\n```\n\n## Out of Scope",
    ));

    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.frs.map(({ id }) => id)).toEqual(["FR-001", "FR-002"]);
  });

  it("ignores examples inside long backtick fences that contain shorter fences", () => {
    const nested = validSpec.replace(
      "## Out of Scope",
      "````markdown\n## Functional Requirements\n- FR-998: outer example\n```markdown\n- FR-999: inner example\n```\n````\n\n## Out of Scope",
    );
    const parsed = parseSpec(nested);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.frs.map(({ id }) => id)).toEqual(["FR-001", "FR-002"]);
  });

  it("ignores examples inside tilde fences", () => {
    const parsed = parseSpec(validSpec.replace(
      "## Out of Scope",
      "~~~\n## Functional Requirements\n- FR-999: quoted example\n~~~\n\n## Out of Scope",
    ));
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.frs.map(({ id }) => id)).toEqual(["FR-001", "FR-002"]);
  });

  it("never closes a backtick fence on a tilde marker", () => {
    const mixed = validSpec.replace(
      "## Out of Scope",
      "```markdown\n## Functional Requirements\n- FR-999: quoted example\n~~~\n```\n\n## Out of Scope",
    );
    const parsed = parseSpec(mixed);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.frs.map(({ id }) => id)).toEqual(["FR-001", "FR-002"]);
  });

  it.each([
    ["yaml", "```yaml"],
    ["inner", "```inner"],
  ])("keeps an info-string line inside a fence as content, never a closer", (_kind, infoLine) => {
    const infoString = validSpec.replace(
      "## Out of Scope",
      "```markdown\n## Out of Scope\n- OOS-009: minted from fence content\n" + infoLine + "\n```\n\n## Out of Scope",
    );
    const parsed = parseSpec(infoString);
    // CommonMark: a marker with a non-empty info string is fence content, so
    // the fence stays open until the marker-only closer — the restored Out of
    // Scope section parses and the fenced OOS-009 never mints an entry.
    // Closing early on the info-string line blanks the restored section and
    // fails the parse.
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(JSON.stringify(parsed.value)).not.toContain("OOS-009");
      expect(parsed.value.oos.map(({ id }) => id)).toEqual(["OOS-001", "OOS-002"]);
    }
  });

  it("treats 4-space-indented markers as indented code, not fence boundaries", () => {
    const indented = validSpec.replace(
      "## Functional Requirements\n\n### Core Requirements",
      "## Functional Requirements\n\n    ```\n    - FR-002: System MUST hash requirement content deterministically\n    ```\n\n### Core Requirements",
    );
    const parsed = parseSpec(indented);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(parsed.value.frs.map(({ id }) => id)).toEqual(["FR-001", "FR-002"]);
    }
  });

  // The [\s.-]* separator class in STRUCTURAL_ID is pinned by the
  // dot-separator row: reverting the widening to [\s-] would make FR.002:
  // vanish with ok:true — the silent-drop class upheld across rounds 1–6.
  // One stray-ID matrix instead of two parallel ones: the case list is the
  // documentation, and a future near-miss variant has one place to go.
  it.each([
    ["bold-asterisk", "** FR-002: System MUST be recognized"],
    ["ordered-list", "1. FR-002: System MUST be recognized"],
    ["lowercase bare", "fr-002: System MUST be recognized"],
    ["two-digit ID", "FR-12: System MUST be recognized"],
    ["dot-separator", "FR.002: System MUST be recognized"],
    ["spaced separator", "FR- 002: System MUST be recognized"],
    ["space before colon", "FR-002 : System MUST be recognized"],
    ["four-digit ID", "FR-1234: System MUST be recognized"],
    ["three-digit ordered-list prefix", "123. FR-002: System MUST be recognized"],
    ["blockquote prefix", "> FR-002: System MUST be recognized"],
    ["plus-bullet", "+ FR-002: System MUST be recognized"],
    ["close-paren ordered-list", "1) FR-002: System MUST be recognized"],
    ["spaced nested blockquote", "> > FR-002: System MUST be recognized"],
    ["nested bullet", "* * FR-002: System MUST be recognized"],
    ["spaced ordered markers", "1. 2. FR-002: System MUST be recognized"],
    ["mixed marker run", "> - FR-002: System MUST be recognized"],
  ])("fails closed for a bare %s variant in a section body", (_kind, strayLine) => {
    const stray = validSpec.replace(
      "- FR-002: System MUST hash requirement content deterministically",
      strayLine,
    );
    const parsed = parseSpec(stray);
    // Any ID-shaped line — spaced separators, a space before the colon, one
    // digit past the canonical three, wider ordered-list markers, and any
    // Markdown marker run (spaced nested blockquotes, nested bullets, spaced
    // ordered markers, mixed runs) — must fail closed, never vanish.
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      // The exact typed error, not a substring of the joined prose: the whole
      // list is pinned, so a near miss that starts producing a second — or a
      // different — diagnostic is caught rather than absorbed by a `toContain`.
      expect(parsed.errors).toEqual([
        { kind: "entry-not-bulleted", section: "Functional Requirements", line: FR_002_LINE },
      ]);
    }
  });

  it("fails closed for a heading-prefixed structural ID", () => {
    const headed = validSpec.replace(
      "- FR-002: System MUST hash requirement content deterministically",
      "## FR-002: System MUST be recognized",
    );
    const parsed = parseSpec(headed);
    // A heading-shaped structural ID truncates the body and lands on the
    // section boundary: the document-wide net must fail closed on it, never
    // mint it or let it vanish.
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(messagesOf(parsed.errors)).toContain("outside a parsed section");
    }
  });

  it("fails closed for a ###-prefixed structural ID after a collected acceptance block", () => {
    const headed = validSpec.replace(
      "- AS-002: Given duplicate IDs, When it is parsed, Then parsing fails closed",
      "### AS-999: an injected heading scenario",
    );
    const parsed = parseSpec(headed);
    // Exactly three hashes never truncate the section body (sections() splits
    // only on ##), so the line stays inside the User Scenarios collected range
    // and the document-wide net skips it: without the in-branch fail-closed
    // check the ID vanishes with ok:true — AS-999 gone, no diagnostic.
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(messagesOf(parsed.errors)).toContain("must be a \"- ID: content\" bullet");
    }
  });

  it("fails closed for a ###-prefixed structural ID in the narrative region before any block", () => {
    const stray = validSpec.replace(
      "### US1: [P1] Parse a spec",
      "### US1: [P1] Parse a spec\n\n### AS-999: a stray heading scenario",
    );
    const parsed = parseSpec(stray);
    // The terminator branch consumed ###-prefixed lines before the fail-closed
    // check could fire, so the ID vanished even when the parse failed via the
    // missing-block error. The structural-ID diagnostic must fire either way.
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(messagesOf(parsed.errors)).toContain("must be a \"- ID: content\" bullet");
    }
  });

  it("fails closed for a ###-prefixed duplicate-family ID inside User Scenarios", () => {
    const dup = validSpec.replace(
      "- AS-002: Given duplicate IDs, When it is parsed, Then parsing fails closed",
      "### FR-001: an injected heading requirement",
    );
    const parsed = parseSpec(dup);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(messagesOf(parsed.errors)).toContain("must be a \"- ID: content\" bullet");
    }
  });

  it("fails closed for a ###-prefixed structural ID in the Out of Scope body", () => {
    const oos = validSpec.replace(
      "- OOS-002: LLM-derived requirement links",
      "### AS-999: a heading-shaped exclusion",
    );
    const parsed = parseSpec(oos);
    // Entry-only sections fail closed on any ID-shaped bullet or bare line;
    // the ###-prefixed form is pinned so the demanded stray-variant coverage
    // discriminates the hole rather than passing against it.
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(messagesOf(parsed.errors)).toContain("Out of Scope");
    }
  });

  it("fails closed for a ***-prefixed structural ID", () => {
    const stars = validSpec.replace(
      "- FR-002: System MUST hash requirement content deterministically",
      "*** AS-999: bold-italic variant",
    );
    const parsed = parseSpec(stars);
    // The three-asterisk form is a near-miss of the documented bold-asterisk
    // prefix; minting FR-002's sibling vanishes with ok:true.
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(messagesOf(parsed.errors)).toContain("Functional Requirements");
    }
  });

  it.each([
    ["four-digit scenario ID", "AS-1234: Given a typo, When parsed, Then it fails closed"],
    ["hyphen-space scenario ID", "AS- 002: Given a typo, When parsed, Then it fails closed"],
    ["asterisk-prefixed", "* AS-999: Given a typo, When parsed, Then it fails closed"],
    ["spaced nested blockquote", "> > AS-999: Given a typo, When parsed, Then it fails closed"],
    // The bold-asterisk pair is the in-block twin of the Functional
    // Requirements rows above; the acceptance-block matrix had no bold-asterisk
    // case, so an in-block `**`/`***` stray was unpinned here.
    ["bold-asterisk", "** AS-999: Given a typo, When parsed, Then it fails closed"],
    ["bold-italic asterisks", "*** AS-999: Given a typo, When parsed, Then it fails closed"],
  ])("fails closed for a bare %s variant in an acceptance block", (_kind, strayLine) => {
    const stray = validSpec.replace(
      "- AS-002: Given duplicate IDs, When it is parsed, Then parsing fails closed",
      strayLine,
    );
    const parsed = parseSpec(stray);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(parsed.errors).toEqual([
        { kind: "scenario-not-bulleted", line: AS_002_LINE, insideBlock: true },
      ]);
    }
  });

  it("parses CRLF and lone-CR line endings", () => {
    const crlf = parseSpec(validSpec.replace(/\n/gu, "\r\n"));
    expect(crlf).toMatchObject({ ok: true });
    if (crlf.ok) expect(crlf.value.frs.map(({ id }) => id)).toEqual(["FR-001", "FR-002"]);
    const loneCr = parseSpec(validSpec.replace(/\n/gu, "\r"));
    expect(loneCr).toMatchObject({ ok: true });
    if (loneCr.ok) expect(loneCr.value.frs.map(({ id }) => id)).toEqual(["FR-001", "FR-002"]);
  });

  it("fails closed for an empty second Acceptance Scenarios block", () => {
    const emptySecond = validSpec.replace(
      "## Functional Requirements",
      "### US2: [P2] Empty\n\n**Acceptance Scenarios:**\n\n## Functional Requirements",
    );
    const parsed = parseSpec(emptySecond);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(messagesOf(parsed.errors)).toContain("contains no scenario bullets");
    }
  });

  it("fails closed for a bare scenario ID before any Acceptance Scenarios block", () => {
    const beforeBlock = validSpec.replace(
      "**Acceptance Scenarios:**",
      "AS-009: a bare scenario ID before any block",
    );
    const parsed = parseSpec(beforeBlock);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(messagesOf(parsed.errors)).toContain("under an **Acceptance Scenarios:** block");
    }
  });

  it.each([
    ["asterisks", "***"],
    ["underscores", "___"],
  ])("skips a %s thematic break between entries as furniture", (_kind, breakLine) => {
    const furnished = validSpec.replace(
      "- FR-002: System MUST hash requirement content deterministically",
      `${breakLine}\n- FR-002: System MUST hash requirement content deterministically`,
    );
    const parsed = parseSpec(furnished);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.frs.map(({ id }) => id)).toEqual(["FR-001", "FR-002"]);
  });

  it("reports document-absolute line numbers for bullet-less ID lines", () => {
    const markdown = ["# Feature", "", "## Functional Requirements", "", "FR-002: System MUST be a bullet", ""].join("\n");
    const parsed = parseSpec(markdown);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(messagesOf(parsed.errors)).toContain("Functional Requirements line 5 must be a \"- ID: content\" bullet");
      expect(messagesOf(parsed.errors)).toContain("Functional Requirements must contain at least one entry");
    }
  });

  it("reports document-absolute line numbers for malformed entry lines", () => {
    const markdown = ["# Feature", "", "## Functional Requirements", "", "- broken line", ""].join("\n");
    const parsed = parseSpec(markdown);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(messagesOf(parsed.errors)).toContain("Functional Requirements line 5 must use a canonical Functional Requirements ID");
    }
  });

  // Every failure mode is pinned as a whole typed error value, payload
  // included: a diagnostic that is reordered, merged, or reworded can no longer
  // satisfy a substring match while the structured failure quietly changes.
  it.each<[string, string, SpecParseError]>([
    ["missing section", validSpec.replace("## Out of Scope", "## Deferred"),
      { kind: "missing-section", section: "Out of Scope" }],
    ["duplicate section", `${validSpec}\n## Out of Scope\n\n- OOS-003: duplicate section\n`,
      { kind: "repeated-section", section: "Out of Scope" }],
    ["duplicate FR", validSpec.replace("FR-002", "FR-001"),
      { kind: "duplicate-entry-id", section: "Functional Requirements", id: "FR-001" }],
    ["duplicate AS", validSpec.replace("- AS-002:", "- AS-001:"),
      { kind: "duplicate-entry-id", section: "Acceptance Scenarios", id: "AS-001" }],
    ["duplicate OOS", validSpec.replace("- OOS-002:", "- OOS-001:"),
      { kind: "duplicate-entry-id", section: "Out of Scope", id: "OOS-001" }],
    ["duplicate glossary term", validSpec.replace("| Content Hash |", "| Spec Index |"),
      { kind: "duplicate-glossary-term", term: "spec index" }],
    ["unidentified scenario", validSpec.replace("- AS-002:", "- Given"),
      { kind: "entry-not-canonical", section: "Acceptance Scenarios", line: AS_002_LINE }],
    ["unidentified exclusion", validSpec.replace("- OOS-002:", "- Deferred:"),
      { kind: "entry-not-canonical", section: "Out of Scope", line: OOS_002_LINE }],
    ["bullet-less requirement ID", validSpec.replace(
      "- FR-002: System MUST hash requirement content deterministically",
      "FR-002: System MUST hash requirement content deterministically",
    ), { kind: "entry-not-bulleted", section: "Functional Requirements", line: FR_002_LINE }],
    ["asterisk-bulleted requirement ID", validSpec.replace("- FR-002:", "* FR-002:"),
      { kind: "entry-not-bulleted", section: "Functional Requirements", line: FR_002_LINE }],
    ["bold-asterisk requirement ID", validSpec.replace("- FR-002:", "** FR-002:"),
      { kind: "entry-not-bulleted", section: "Functional Requirements", line: FR_002_LINE }],
    ["ordered-list requirement ID", validSpec.replace("- FR-002:", "1. FR-002:"),
      { kind: "entry-not-bulleted", section: "Functional Requirements", line: FR_002_LINE }],
    ["bullet-less scenario ID in an acceptance block", validSpec.replace("- AS-002:", "AS-002:"),
      { kind: "scenario-not-bulleted", line: AS_002_LINE, insideBlock: true }],
    ["reserved glossary header term", validSpec.replace(
      "| Content Hash | A SHA-256 digest of canonical entry content |",
      "| Term | A real definition |",
    ), { kind: "glossary-reserved-header-term", line: CONTENT_HASH_ROW_LINE, term: "Term" }],
    ["empty Functional Requirements", validSpec.replace(/- FR-\d{3}:[^\n]*\n/gu, ""),
      { kind: "section-has-no-entries", section: "Functional Requirements" }],
    ["empty Out of Scope", validSpec.replace(/- OOS-\d{3}:[^\n]*\n/gu, ""),
      { kind: "section-has-no-entries", section: "Out of Scope" }],
    ["empty glossary", validSpec.replace(/\| (Spec Index|Content Hash) \|[^\n]*\n/gu, ""),
      { kind: "glossary-has-no-terms" }],
    ["no Acceptance Scenarios block", validSpec.replace("**Acceptance Scenarios:**", "**Scenarios:**"),
      { kind: "no-acceptance-block" }],
    ["glossary row with three cells", validSpec.replace(
      "| Spec Index | A deterministic projection of specification entries |",
      "| Spec Index | A deterministic projection | with extra |",
    ), { kind: "glossary-column-count", line: SPEC_INDEX_ROW_LINE }],
    ["glossary row with an empty definition", validSpec.replace(
      "| Content Hash | A SHA-256 digest of canonical entry content |",
      "| Content Hash |  |",
    ), { kind: "glossary-cell-empty", line: CONTENT_HASH_ROW_LINE }],
    ["case-insensitive duplicate glossary term", validSpec.replace("| Content Hash |", "| spec index |"),
      { kind: "duplicate-glossary-term", term: "spec index" }],
    ["misplaced reserved-family ID", misplacedIdSpec,
      { kind: "id-outside-section", line: lineIn(misplacedIdSpec, "- FR-009:") }],
    ["unterminated fence", `${validSpec}\n\`\`\`markdown\n`, { kind: "unterminated-fence" }],
  ])("fails closed for %s", (_label, markdown, expected) => {
    const parsed = parseSpec(markdown);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) expect(parsed.errors).toContainEqual(expected);
  });

  it("emits and renders every failure reason in the union", () => {
    // specParseErrorMessage is exhaustive at the type level, but exhaustiveness
    // over the union is not reachability from the parser. These documents
    // provoke every kind the parser can emit and prove each renders to real
    // operator text — so a new failure reason cannot be added without both a
    // document that reaches it and a message an operator can read.
    const documents = [
      validSpec.replace("## Out of Scope", "## Deferred"),
      `${validSpec}\n## Out of Scope\n\n- OOS-003: duplicate section\n`,
      validSpec.replace("- FR-002:", "** FR-002:"),
      validSpec.replace("- OOS-002:", "- Deferred:"),
      validSpec.replace("- AS-002:", "- AS-001:"),
      validSpec.replace("- AS-002:", "AS-002:"),
      validSpec.replace("## Functional Requirements", "### US2: [P2] Empty\n\n**Acceptance Scenarios:**\n\n## Functional Requirements"),
      validSpec.replace("| Content Hash |", "| Spec Index |"),
      validSpec.replace(
        "| Spec Index | A deterministic projection of specification entries |",
        "| Spec Index | A deterministic projection of specification entries |\nSome stray prose row",
      ),
      validSpec.replace(
        "| Spec Index | A deterministic projection of specification entries |",
        "| Spec Index | A deterministic projection | with extra |",
      ),
      validSpec.replace("| Content Hash | A SHA-256 digest of canonical entry content |", "| Term | A real definition |"),
      validSpec.replace("| Content Hash | A SHA-256 digest of canonical entry content |", "| Content Hash |  |"),
      misplacedIdSpec,
      `${validSpec}\n\`\`\`markdown\n`,
      "",
    ];
    const kinds = new Set<SpecParseError["kind"]>();
    for (const markdown of documents) {
      const parsed = parseSpec(markdown);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      for (const error of parsed.errors) {
        kinds.add(error.kind);
        expect(specParseErrorMessage(error).trim().length).toBeGreaterThan(0);
      }
    }
    expect([...kinds].sort()).toEqual([
      "acceptance-block-has-no-bullets",
      "duplicate-entry-id",
      "duplicate-glossary-term",
      "entry-not-bulleted",
      "entry-not-canonical",
      "glossary-cell-empty",
      "glossary-column-count",
      "glossary-has-no-terms",
      "glossary-reserved-header-term",
      "glossary-row-expected",
      "id-outside-section",
      "missing-section",
      "no-acceptance-block",
      "repeated-section",
      "scenario-not-bulleted",
      "section-has-no-entries",
      "unterminated-fence",
    ]);
  });

  it("pins the exact ordered error list for a determinate document", () => {
    const markdown = ["# Feature", "", "## Functional Requirements", "", "FR-002: System MUST be a bullet", ""].join("\n");
    const parsed = parseSpec(markdown);
    expect(parsed).toMatchObject({ ok: false });
    if (parsed.ok) return;
    // Exact equality, in order: the strongest available regression pin. A
    // reordering, a merge, an extra diagnostic, or a dropped one changes this
    // list; a reworded message does not, because identity now lives in the
    // data. The prose surface is pinned separately, below.
    expect(parsed.errors).toEqual([
      { kind: "missing-section", section: "User Scenarios" },
      { kind: "missing-section", section: "Out of Scope" },
      { kind: "missing-section", section: "Appendix: Glossary" },
      { kind: "entry-not-bulleted", section: "Functional Requirements", line: 5 },
      { kind: "section-has-no-entries", section: "Functional Requirements" },
      { kind: "no-acceptance-block" },
      { kind: "section-has-no-entries", section: "Acceptance Scenarios" },
      { kind: "section-has-no-entries", section: "Out of Scope" },
      { kind: "glossary-has-no-terms" },
    ]);
    expect(messagesOf(parsed.errors)).toBe([
      "missing required section ## User Scenarios",
      "missing required section ## Out of Scope",
      "missing required section ## Appendix: Glossary",
      "Functional Requirements line 5 must be a \"- ID: content\" bullet",
      "Functional Requirements must contain at least one entry",
      "User Scenarios must contain at least one **Acceptance Scenarios:** block",
      "Acceptance Scenarios must contain at least one entry",
      "Out of Scope must contain at least one entry",
      "Glossary must contain at least one term",
    ].join("\n"));
  });

  it("treats a backtick fence whose info string contains backticks as paragraph text, never a fence opener", () => {
    const probe = validSpec.replace(
      "- FR-002: System MUST hash requirement content deterministically",
      "``` `snippet`\n- FR-002: System MUST hash requirement content deterministically\n```",
    );
    const parsed = parseSpec(probe);
    // CommonMark: a backtick fence whose info string contains backticks is
    // paragraph text, not a fence — the bullet after it is real content and
    // the trailing marker-only line opens an unterminated fence, so the parse
    // fails closed with the unterminated-fence diagnostic. Opening a fence on
    // the info-string line blanks FR-002 and returns ok:true.
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(messagesOf(parsed.errors)).toContain("unterminated code fence");
    }
  });

  it("rejects a structural-ID bullet at four-space lazy-continuation indentation", () => {
    const lazy = validSpec.replace(
      "- FR-002: System MUST hash requirement content deterministically",
      "    - FR-002: System MUST hash requirement content deterministically",
    );
    const parsed = parseSpec(lazy);
    // CommonMark keeps this as list-owned content, so it must reach the entry
    // grammar and fail closed as a nested structural ID rather than vanish.
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(parsed.errors).toContainEqual(expect.objectContaining({
        kind: "entry-not-canonical",
        section: "Functional Requirements",
      }));
    }
  });

  it("fails closed for an empty Acceptance Scenarios block terminated by a following header", () => {
    const consecutive = validSpec.replace(
      "**Acceptance Scenarios:**",
      "**Acceptance Scenarios:**\n\n**Acceptance Scenarios:**",
    );
    const parsed = parseSpec(consecutive);
    // The remediated invariant is "error at block close when no bullets were
    // collected" — a header line terminates the open block just like a
    // sub-heading does, so the empty first block must error, not reset.
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(messagesOf(parsed.errors)).toContain("contains no scenario bullets");
    }
  });

  it("fails closed for a lazy-continuation structural ID in a non-required section", () => {
    const lazy = validSpec.replace(
      "## Appendix: Glossary",
      "## Open Questions\n\n1. Is FR-003 needed?\n    - FR-009: An indented lazy requirement\n\n## Appendix: Glossary",
    );
    const parsed = parseSpec(lazy);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(messagesOf(parsed.errors)).toContain("outside a parsed section");
    }
  });

  it("treats a 4-space-indented structural ID after a blank line as indented code furniture", () => {
    const furniture = validSpec.replace(
      "# Feature: Structural spec\n",
      "# Feature: Structural spec\n\n    - FR-009: an indented preamble bullet\n",
    );
    const parsed = parseSpec(furniture);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.frs.map(({ id }) => id)).toEqual(["FR-001", "FR-002"]);
  });

  it("rejects a tab-indented structural bullet owned by an open Requirement", () => {
    const nested = validSpec.replace(
      "- FR-002: System MUST hash requirement content deterministically",
      "\n\t- FR-002: System MUST hash requirement content deterministically",
    );
    const parsed = parseSpec(nested);
    // The tab expands to four columns, but the open FR-001 item owns that
    // indentation. The line survives fence stripping and fails as nested ID.
    expect(parsed).toMatchObject({ ok: false });
  });

  it("rejects a tab-indented scenario bullet owned by an open scenario", () => {
    const nested = validSpec.replace(
      "- AS-002: Given duplicate IDs, When it is parsed, Then parsing fails closed",
      "\n\t- AS-002: Given duplicate IDs, When it is parsed, Then parsing fails closed",
    );
    const parsed = parseSpec(nested);
    expect(parsed).toMatchObject({ ok: false });
  });

  it("treats a tab-indented glossary row after a blank line as indented code furniture", () => {
    const furniture = validSpec.replace(
      "| Spec Index | A deterministic projection of specification entries |",
      "| Spec Index | A deterministic projection of specification entries |\n\n\t| Beta | A tab-indented term |",
    );
    const parsed = parseSpec(furniture);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(parsed.value.glossary.map(({ term }) => term)).toEqual(["Spec Index", "Content Hash"]);
    }
  });

  it("treats a tab-indented fence marker at 4+ columns as code furniture, not a fence boundary", () => {
    const fenced = validSpec.replace(
      "## Functional Requirements\n\n### Core Requirements",
      "## Functional Requirements\n\n\t```yaml\n\t- FR-002: System MUST hash requirement content deterministically\n\t```\n\n### Core Requirements",
    );
    const parsed = parseSpec(fenced);
    // CommonMark expands the tab to column 4: a tab-indented fence marker is
    // code furniture, not a fence boundary — the interior is literal code and
    // the ID-shaped text is never spec text.
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.frs.map(({ id }) => id)).toEqual(["FR-001", "FR-002"]);
  });

  it("rejects a mixed space-plus-tab structural bullet owned by an open Requirement", () => {
    const nested = validSpec.replace(
      "- FR-002: System MUST hash requirement content deterministically",
      "\n \t- FR-002: System MUST hash requirement content deterministically",
    );
    const parsed = parseSpec(nested);
    // A space then a tab expands to column 4, still owned by FR-001.
    expect(parsed).toMatchObject({ ok: false });
  });

  it("canonicalizes formatting whitespace but changes the hash when content changes", () => {
    expect(specContentHash("System MUST parse specs"))
      .toBe(specContentHash("  System   MUST parse\n specs  "));
    expect(specContentHash("System MUST parse specs"))
      .not.toBe(specContentHash("System SHOULD parse specs"));
  });

  it("distinguishes glossary hash inputs the ambiguous term-colon join collided", () => {
    // The glossary hash input is the lossless (term, definition) pair: the
    // former `${term}: ${definition}` join mapped the distinct pairs
    // ("a: b", "c") and ("a", "b: c") to one digest, so two distinct
    // glossary entries could share a content hash.
    expect(specContentHash(JSON.stringify(["a: b", "c"])))
      .not.toBe(specContentHash(JSON.stringify(["a", "b: c"])));
  });

  it("parses Loom's single-dash delimiter extension as a separator, not a data row", () => {
    const gfm = validSpec.replace(
      "| Spec Index | A deterministic projection of specification entries |",
      "| Spec Index | A deterministic projection of specification entries |\n|-|-|",
    );
    const parsed = parseSpec(gfm);
    // Loom intentionally accepts 1+ hyphens per delimiter cell; a single-dash
    // row is furniture. Misclassifying it as a data row mints a bogus entry.
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(parsed.value.glossary.map(({ term }) => term)).not.toContain("-");
    }
  });

  it("fails closed for bullets after a thematic break inside an Acceptance Scenarios block", () => {
    const furnished = validSpec.replace(
      "- AS-002: Given duplicate IDs, When it is parsed, Then parsing fails closed",
      "---\n- AS-002: Given duplicate IDs, When it is parsed, Then parsing fails closed",
    );
    const parsed = parseSpec(furnished);
    // The thematic break terminates the open block even when bullets were
    // collected; subsequent bullets are outside the block and must fail
    // closed, never be collected.
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(messagesOf(parsed.errors)).toContain("under an **Acceptance Scenarios:** block");
    }
  });

  it("fails closed for an empty Acceptance Scenarios block terminated by a thematic break", () => {
    const emptyBreak = validSpec.replace(
      "## Functional Requirements",
      "### US2: [P2] Empty\n\n**Acceptance Scenarios:**\n\n---\n\n## Functional Requirements",
    );
    const parsed = parseSpec(emptyBreak);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(messagesOf(parsed.errors)).toContain("contains no scenario bullets");
    }
  });

  it("fails closed for prose rows in the glossary", () => {
    const prose = validSpec.replace(
      "| Spec Index | A deterministic projection of specification entries |",
      "| Spec Index | A deterministic projection of specification entries |\nSome stray prose row",
    );
    const parsed = parseSpec(prose);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(messagesOf(parsed.errors)).toContain("must be a \"| Term | Definition\" row");
    }
  });

  it("fails closed for a non-indented structural ID in the preamble", () => {
    const preamble = validSpec.replace(
      "# Feature: Structural spec\n",
      "# Feature: Structural spec\n\nFR-009: a preamble requirement\n",
    );
    const parsed = parseSpec(preamble);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(messagesOf(parsed.errors)).toContain("outside a parsed section");
    }
  });

  it("skips the case-insensitive header-shape row as furniture", () => {
    const header = validSpec.replace(
      "| Spec Index | A deterministic projection of specification entries |",
      "| Spec Index | A deterministic projection of specification entries |\n| TERM | DEFINITION |",
    );
    const parsed = parseSpec(header);
    // The case-insensitive header shape is deliberately skipped — only the
    // reserved-term-with-non-matching-definition variant errors.
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(parsed.value.glossary.map(({ term }) => term)).not.toContain("TERM");
    }
  });

  it("ignores canonical-looking examples inside tilde fences carrying an info string", () => {
    const fenced = validSpec.replace(
      "## Out of Scope",
      "~~~yaml\n## Functional Requirements\n- FR-999: quoted example\n~~~\n\n## Out of Scope",
    );
    const parsed = parseSpec(fenced);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(JSON.stringify(parsed.value)).not.toContain("FR-999");
      expect(parsed.value.frs.map(({ id }) => id)).toEqual(["FR-001", "FR-002"]);
    }
  });

  it("keeps a colon-less ID-shaped line and a spaced family token as deliberate prose", () => {
    const prose = validSpec.replace(
      "- FR-002: System MUST hash requirement content deterministically",
      "FR-002 and FR-003 are related",
    );
    // CONTEXT.md Spec Index: an ID-shaped line without a colon is prose, not
    // a malformed identifier, and stays legal — pinned so a future net change
    // in either direction cannot silently alter the boundary.
    const parsed = parseSpec(prose);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.frs.map(({ id }) => id)).toEqual(["FR-001"]);

    const spaced = validSpec.replace(
      "- FR-002: System MUST hash requirement content deterministically",
      "F R-002: System MUST be recognized",
    );
    // A spaced family token breaks the contiguous family token — the second
    // deliberate prose boundary — and stays legal.
    expect(parseSpec(spaced)).toMatchObject({ ok: true });
  });

  it("fails closed for the CONTEXT.md-documented '- -' marker-run form in a section body", () => {
    const stray = validSpec.replace(
      "- FR-002: System MUST hash requirement content deterministically",
      "- - FR-002: System MUST be recognized",
    );
    const parsed = parseSpec(stray);
    // CONTEXT.md enumerates `- -` among the marker-run forms that fail closed;
    // it takes a distinct code path from its documented siblings (the line
    // starts with "-", so parseEntries skips the entry-not-bulleted branch and
    // fails via entry-not-canonical) — pinned so a prefix-handling refactor
    // cannot silently change which diagnostic the documented form produces.
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(parsed.errors).toEqual([
        { kind: "entry-not-canonical", section: "Functional Requirements", line: FR_002_LINE },
      ]);
    }
  });

  it("fails closed for the CONTEXT.md-documented '- -' marker-run form in an acceptance block", () => {
    const stray = validSpec.replace(
      "- AS-002: Given duplicate IDs, When it is parsed, Then parsing fails closed",
      "- - AS-999: Given a typo, When parsed, Then it fails closed",
    );
    const parsed = parseSpec(stray);
    // The in-block twin of the FR-section pin: the collected bullet fails via
    // entry-not-canonical (the pattern rejects the marker run), the same
    // diagnostic the unidentified-scenario row pins.
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(parsed.errors).toEqual([
        { kind: "entry-not-canonical", section: "Acceptance Scenarios", line: AS_002_LINE },
      ]);
    }
  });

  it("keeps the document-wide net covering a spec whose final line is an entry", () => {
    // The trailing-section boundary is load-bearing: the last required
    // section must end one line past the document's last line or the
    // document-wide fail-closed net stops covering that last line. No other
    // fixture ends with an ID-shaped entry, so dropping the +1 passes the
    // whole suite while this legal spec gains a spurious
    // id-outside-section diagnostic.
    const trailing = [
      "# Feature", "",
      "## User Scenarios", "", "**Acceptance Scenarios:**",
      "- AS-001: Given a canonical spec, When it is parsed, Then entries are returned",
      "",
      "## Appendix: Glossary", "",
      "| Term | Definition |",
      "| Spec Index | A deterministic projection of specification entries |",
      "",
      "## Functional Requirements", "",
      "- FR-001: System MUST parse canonical requirement IDs",
      "",
      "## Out of Scope", "",
      "- OOS-001: Symbol-level source indexing",
    ].join("\n");
    const parsed = parseSpec(trailing);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.oos.map(({ id }) => id)).toEqual(["OOS-001"]);
  });

  it("binds the CONTEXT.md Spec Index definition as the executable colon boundary", () => {
    const context = readFileSync(new URL("../../../CONTEXT.md", import.meta.url), "utf8");
    // The Spec Index entry documents the colon as the deliberate
    // prose-disambiguation boundary; this test binds the living language to
    // the parser's behavior so neither can drift from the other.
    expect(context).toMatch(/\*\*Spec Index\*\*/u);
    expect(context).toMatch(/The colon and the contiguous family token are the deliberate prose-disambiguation boundaries/u);
    const prose = validSpec.replace(
      "- FR-002: System MUST hash requirement content deterministically",
      "FR-002 and FR-003 are related",
    );
    const parsed = parseSpec(prose);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.frs.map(({ id }) => id)).toEqual(["FR-001"]);
  });

  it("passes a narrative bullet outside an acceptance block as furniture", () => {
    const narrative = validSpec.replace(
      "### US1: [P1] Parse a spec",
      "### US1: [P1] Parse a spec\n\n- Some narrative note outside any block",
    );
    const parsed = parseSpec(narrative);
    // The deliberate asymmetry's pass side: outside an acceptance block a
    // non-ID bullet is narrative furniture in a narrative section and passes;
    // pinned so a future guard change in either direction cannot silently
    // alter legal narrative-furniture behavior.
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(parsed.value.scenarios.map(({ id }) => id)).toEqual(["AS-001", "AS-002"]);
      expect(parsed.value.frs.map(({ id }) => id)).toEqual(["FR-001", "FR-002"]);
    }
  });

  it("skips a thematic break between glossary rows as furniture", () => {
    const furnished = validSpec.replace(
      "| Content Hash | A SHA-256 digest of canonical entry content |",
      "---\n| Content Hash | A SHA-256 digest of canonical entry content |",
    );
    const parsed = parseSpec(furnished);
    // A thematic break between glossary rows is furniture: the skip branch is
    // position-agnostic, and the real row after it still mints.
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(parsed.value.glossary.map(({ term }) => term)).toEqual(["Spec Index", "Content Hash"]);
    }
  });

  it("keeps a tab-indented closer inside an open fence open, failing closed", () => {
    const indented = validSpec.replace(
      "## Out of Scope",
      "```markdown\n## Out of Scope\n- OOS-009: minted from fence content\n\t```\n\n## Out of Scope",
    );
    const parsed = parseSpec(indented);
    // CommonMark: the tab expands to column 4, so the closer condition (a
    // marker-only line at up to three spaces of indentation) cannot fire —
    // the fence stays open, the interior is literal code, and the
    // unterminated fence fails the parse closed.
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(messagesOf(parsed.errors)).toContain("unterminated code fence");
    }
  });
});

const ownedGrammarMatrix = ([
  { family: "FR", collection: "frs", section: "Functional Requirements" },
  { family: "AS", collection: "scenarios", section: "Acceptance Scenarios" },
  { family: "OOS", collection: "oos", section: "Out of Scope" },
] as const).flatMap((family) => ([
  { indentation: "two spaces", indent: "  " },
  { indentation: "four spaces", indent: "    " },
  { indentation: "tab", indent: "\t" },
  { indentation: "mixed", indent: " \t" },
] as const).flatMap((indentation) => ([
  { separation: "adjacent", gap: "\n" },
  { separation: "blank-separated", gap: "\n\n" },
] as const).map((separation) => ({ ...family, ...indentation, ...separation }))));

/** The entire finite ownership matrix crosses the public parser, not its lexer. */
describe.each(ownedGrammarMatrix)(
  "owned grammar: $family / $indentation / $separation",
  ({ family, collection, section, indent, gap }) => {
    const appendBody = (body: string): string => validSpec.replace(
      new RegExp(`(- ${family}-001:[^\\n]*)`, "u"),
      `$1${gap}${body}`,
    );
    const baseline = parseSpec(validSpec);
    if (!baseline.ok) throw new Error("canonical matrix fixture must parse");

    it.each([
      "ordinary detail",
      "- ordinary nested clause",
      "+ ordinary nested clause",
      "1. ordinary nested clause",
      "FR-009 and AS-009 are related",
      "F R-009: deliberate prose",
      "### Nested detail",
      "---",
      "**Acceptance Scenarios:**",
      "```text\nliteral detail\n```",
      "~~~text\nliteral detail\n~~~",
    ])("preserves owned body and hash: %s", (body) => {
      const rawBody = body.split("\n").map((line) => `${indent}${line}`).join("\n");
      const parsed = parseSpec(appendBody(`${rawBody}${gap}${indent}tail clause`));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(messagesOf(parsed.errors));
      const expected = `${baseline.value[collection][0].content} ${body.replace(/\s+/gu, " ")} tail clause`;
      expect(parsed.value[collection][0]).toEqual({
        id: `${family}-001`, content: expected, contentHash: specContentHash(expected),
      });
      expect(parsed.value[collection].slice(1)).toEqual(baseline.value[collection].slice(1));
    });

    it.each((["FR", "AS", "OOS"] as const).flatMap((nestedFamily) =>
      ["", "- ", "+ ", "1. ", "> > ", "### ", "- - "].map((prefix) =>
        `${prefix}${nestedFamily}-009: unsupported nested ID`),
    ))("refuses every owned colon-full ID: %s", (body) => {
      const markdown = appendBody(`${indent}${body}`);
      const parsed = parseSpec(markdown);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error("nested structural ID unexpectedly indexed");
      expect(parsed.errors).toContainEqual({
        kind: body.startsWith(`- ${family}-009:`) ? "entry-not-canonical" : "entry-not-bulleted",
        section,
        line: lineIn(markdown, `${indent}${body}`),
      });
    });

    it.each(["```", "~~~"])("ignores genuine top-level %s examples without changing entries", (fence) => {
      const markdown = appendBody(`${indent}owned clause${gap}` + [
        `${fence}markdown`,
        `${indent}- ${family}-009: literal example`,
        "## Functional Requirements",
        fence,
      ].join("\n"));
      const parsed = parseSpec(markdown);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(messagesOf(parsed.errors));
      const expected = `${baseline.value[collection][0].content} owned clause`;
      expect(parsed.value[collection][0]).toEqual({
        id: `${family}-001`, content: expected, contentHash: specContentHash(expected),
      });
      expect(parsed.value[collection].slice(1)).toEqual(baseline.value[collection].slice(1));
    });

    it.each(["```", "~~~"])("never hides nested IDs inside owned %s markers", (fence) => {
      const nested = `${indent}- ${family}-009: unsupported nested ID`;
      const markdown = appendBody(`${indent}${fence}${gap}${nested}${gap}${indent}${fence}`);
      const parsed = parseSpec(markdown);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error("owned fence hid a structural ID");
      expect(parsed.errors).toContainEqual({
        kind: "entry-not-canonical", section, line: lineIn(markdown, nested),
      });
    });

    it("retains parent ownership after a nested list dedents", () => {
      const parsed = parseSpec(appendBody(`${indent}- nested clause\n\n  parent paragraph\n\n    final clause`));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error(messagesOf(parsed.errors));
      const expected = `${baseline.value[collection][0].content} - nested clause parent paragraph final clause`;
      expect(parsed.value[collection][0].content).toBe(expected);
      expect(parsed.value[collection][0].contentHash).toBe(specContentHash(expected));
    });
  },
);

// Once a genuine top-level fence ends the list, a later indented example is
// furniture, not a continuation of the earlier Requirement.
it("ends list ownership at a genuine top-level fence", () => {
  const markdown = validSpec.replace(
    "- FR-001: System MUST parse canonical requirement IDs",
    "- FR-001: System MUST parse canonical requirement IDs\n\n```text\nexample\n```\n\n    FR-009: indented code",
  );
  expect(parseSpec(markdown)).toEqual(parseSpec(validSpec));
});

describe("parseSpecContentHash", () => {
  it("admits exactly the shape specContentHash mints", () => {
    const minted = specContentHash("System MUST parse specs");
    expect(parseSpecContentHash(minted)).toBe(minted);
    expect(parseSpecContentHash("0".repeat(64))).toBe("0".repeat(64));
  });

  it("refuses every value the engine could not have written", () => {
    // The gate treats a rejected value as corrupt authority, so admitting a
    // near-miss here would launder a tampered graph into ordinary drift.
    for (const bad of [
      "deadbeef",                 // too short
      "0".repeat(63),             // one short
      "0".repeat(65),             // one long
      "A".repeat(64),             // uppercase hex is not what the mint emits
      `${"0".repeat(63)}g`,       // non-hex character
      ` ${"0".repeat(64)}`,       // leading space
      `${"0".repeat(64)}\n`,      // trailing newline
      "",
    ]) {
      expect(parseSpecContentHash(bad)).toBeNull();
    }
    for (const bad of [null, undefined, 42, {}, ["0".repeat(64)]]) {
      expect(parseSpecContentHash(bad)).toBeNull();
    }
  });
});
