import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as parserBarrel from "../../src/parsers";
import { parseSpec, specContentHash } from "../../src/parsers/parse-spec";

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

  it("exports parseSpec and specContentHash through the parser barrel", () => {
    expect(parserBarrel.parseSpec).toBe(parseSpec);
    expect(parserBarrel.specContentHash).toBe(specContentHash);
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
  it.each([
    ["bold-asterisk", "** FR-002: System MUST be recognized"],
    ["ordered-list", "1. FR-002: System MUST be recognized"],
    ["lowercase bare", "fr-002: System MUST be recognized"],
    ["two-digit ID", "FR-12: System MUST be recognized"],
    ["dot-separator", "FR.002: System MUST be recognized"],
  ])("fails closed for %s near-miss IDs", (_kind, strayLine) => {
    const stray = validSpec.replace(
      "- FR-002: System MUST hash requirement content deterministically",
      strayLine,
    );
    const parsed = parseSpec(stray);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(parsed.errors.join("\n")).toContain("Functional Requirements");
    }
  });

  it.each([
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
      expect(parsed.errors.join("\n")).toContain("Functional Requirements");
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
      expect(parsed.errors.join("\n")).toContain("outside a parsed section");
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
      expect(parsed.errors.join("\n")).toContain("must be a \"- ID: content\" bullet");
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
      expect(parsed.errors.join("\n")).toContain("must be a \"- ID: content\" bullet");
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
      expect(parsed.errors.join("\n")).toContain("must be a \"- ID: content\" bullet");
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
      expect(parsed.errors.join("\n")).toContain("Out of Scope");
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
      expect(parsed.errors.join("\n")).toContain("Functional Requirements");
    }
  });

  it.each([
    ["four-digit scenario ID", "AS-1234: Given a typo, When parsed, Then it fails closed"],
    ["hyphen-space scenario ID", "AS- 002: Given a typo, When parsed, Then it fails closed"],
    ["asterisk-prefixed", "* AS-999: Given a typo, When parsed, Then it fails closed"],
    ["spaced nested blockquote", "> > AS-999: Given a typo, When parsed, Then it fails closed"],
  ])("fails closed for a bare %s variant in an acceptance block", (_kind, strayLine) => {
    const stray = validSpec.replace(
      "- AS-002: Given duplicate IDs, When it is parsed, Then parsing fails closed",
      strayLine,
    );
    const parsed = parseSpec(stray);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(parsed.errors.join("\n")).toContain("Acceptance Scenarios");
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
      expect(parsed.errors.join("\n")).toContain("contains no scenario bullets");
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
      expect(parsed.errors.join("\n")).toContain("under an **Acceptance Scenarios:** block");
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
      expect(parsed.errors.join("\n")).toContain("Functional Requirements line 5 must be a \"- ID: content\" bullet");
      expect(parsed.errors.join("\n")).toContain("Functional Requirements must contain at least one entry");
    }
  });

  it("reports document-absolute line numbers for malformed entry lines", () => {
    const markdown = ["# Feature", "", "## Functional Requirements", "", "- broken line", ""].join("\n");
    const parsed = parseSpec(markdown);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(parsed.errors.join("\n")).toContain("Functional Requirements line 5 must use a canonical Functional Requirements ID");
    }
  });

  it.each([
    ["missing section", validSpec.replace("## Out of Scope", "## Deferred"), "missing required section ## Out of Scope"],
    ["duplicate section", `${validSpec}\n## Out of Scope\n\n- OOS-003: duplicate section\n`, "must appear exactly once"],
    ["duplicate FR", validSpec.replace("FR-002", "FR-001"), "duplicate ID FR-001"],
    ["duplicate AS", validSpec.replace("- AS-002:", "- AS-001:"), "duplicate ID AS-001"],
    ["duplicate OOS", validSpec.replace("- OOS-002:", "- OOS-001:"), "duplicate ID OOS-001"],
    ["duplicate glossary term", validSpec.replace("| Content Hash |", "| Spec Index |"), "duplicate term"],
    ["unidentified scenario", validSpec.replace("- AS-002:", "- Given"), "canonical Acceptance Scenarios ID"],
    ["unidentified exclusion", validSpec.replace("- OOS-002:", "- Deferred:"), "canonical Out of Scope ID"],
    ["bullet-less requirement ID", validSpec.replace(
      "- FR-002: System MUST hash requirement content deterministically",
      "FR-002: System MUST hash requirement content deterministically",
    ), "must be a \"- ID: content\" bullet"],
    ["asterisk-bulleted requirement ID", validSpec.replace("- FR-002:", "* FR-002:"), "must be a \"- ID: content\" bullet"],
    ["bold-asterisk requirement ID", validSpec.replace("- FR-002:", "** FR-002:"), "must be a \"- ID: content\" bullet"],
    ["ordered-list requirement ID", validSpec.replace("- FR-002:", "1. FR-002:"), "must be a \"- ID: content\" bullet"],
    ["bullet-less scenario ID in an acceptance block", validSpec.replace("- AS-002:", "AS-002:"), "must be a \"- ID: content\" bullet"],
    ["reserved glossary header term", validSpec.replace(
      "| Content Hash | A SHA-256 digest of canonical entry content |",
      "| Term | A real definition |",
    ), "reserved header term"],
    ["empty Functional Requirements", validSpec.replace(/- FR-\d{3}:[^\n]*\n/gu, ""), "must contain at least one entry"],
    ["empty Out of Scope", validSpec.replace(/- OOS-\d{3}:[^\n]*\n/gu, ""), "must contain at least one entry"],
    ["empty glossary", validSpec.replace(/\| (Spec Index|Content Hash) \|[^\n]*\n/gu, ""), "Glossary must contain at least one term"],
    ["no Acceptance Scenarios block", validSpec.replace("**Acceptance Scenarios:**", "**Scenarios:**"), "must contain at least one **Acceptance Scenarios:** block"],
    ["glossary row with three cells", validSpec.replace(
      "| Spec Index | A deterministic projection of specification entries |",
      "| Spec Index | A deterministic projection | with extra |",
    ), "exactly Term and Definition columns"],
    ["glossary row with an empty definition", validSpec.replace(
      "| Content Hash | A SHA-256 digest of canonical entry content |",
      "| Content Hash |  |",
    ), "requires a non-empty term and definition"],
    ["case-insensitive duplicate glossary term", validSpec.replace("| Content Hash |", "| spec index |"), "duplicate term"],
    ["misplaced reserved-family ID", validSpec.replace(
      "## Appendix: Glossary",
      "## Open Questions\n\n1. Is FR-003 needed?\n- FR-009: A misplaced requirement\n\n## Appendix: Glossary",
    ), "outside a parsed section"],
    ["unterminated fence", `${validSpec}\n\`\`\`markdown\n`, "unterminated code fence"],
  ])("fails closed for %s", (_label, markdown, diagnostic) => {
    const parsed = parseSpec(markdown);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) expect(parsed.errors.join("\n")).toContain(diagnostic);
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
      expect(parsed.errors.join("\n")).toContain("unterminated code fence");
    }
  });

  it("collects a lazy-continuation bullet indented four spaces after a non-blank line", () => {
    const lazy = validSpec.replace(
      "- FR-002: System MUST hash requirement content deterministically",
      "    - FR-002: System MUST hash requirement content deterministically",
    );
    const parsed = parseSpec(lazy);
    // CommonMark: an indented code block cannot interrupt a paragraph — a
    // 4+-space-indented line directly after a non-blank line is a lazy
    // continuation, i.e. real content. Blanking it as furniture drops FR-002
    // with ok:true.
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.frs.map(({ id }) => id)).toEqual(["FR-001", "FR-002"]);
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
      expect(parsed.errors.join("\n")).toContain("contains no scenario bullets");
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
      expect(parsed.errors.join("\n")).toContain("outside a parsed section");
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

  it("treats a tab-indented structural bullet after a blank line as indented code furniture", () => {
    const furniture = validSpec.replace(
      "- FR-002: System MUST hash requirement content deterministically",
      "\n\t- FR-002: System MUST hash requirement content deterministically",
    );
    const parsed = parseSpec(furniture);
    // CommonMark expands each tab to the next 4-column tab stop: a
    // tab-indented line after a blank line is an indented code block — literal
    // code, never spec text. Minting FR-002 returns ok:true with a phantom
    // entry; the 4-space twin is pinned inert above.
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.frs.map(({ id }) => id)).toEqual(["FR-001"]);
  });

  it("treats a tab-indented scenario bullet after a blank line as indented code furniture", () => {
    const furniture = validSpec.replace(
      "- AS-002: Given duplicate IDs, When it is parsed, Then parsing fails closed",
      "\n\t- AS-002: Given duplicate IDs, When it is parsed, Then parsing fails closed",
    );
    const parsed = parseSpec(furniture);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.scenarios.map(({ id }) => id)).toEqual(["AS-001"]);
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

  it("treats a mixed space-plus-tab leading-indentation twin as indented code furniture", () => {
    const furniture = validSpec.replace(
      "- FR-002: System MUST hash requirement content deterministically",
      "\n \t- FR-002: System MUST hash requirement content deterministically",
    );
    const parsed = parseSpec(furniture);
    // Two spaces then a tab expands to column 4 — the mixed twin of the pure
    // leading-tab twin pinned above; blanking it is the 4-space behavior.
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.frs.map(({ id }) => id)).toEqual(["FR-001"]);
  });

  it("canonicalizes formatting whitespace but changes the hash when content changes", () => {
    expect(specContentHash("System MUST parse specs"))
      .toBe(specContentHash("  System   MUST parse\n specs  "));
    expect(specContentHash("System MUST parse specs"))
      .not.toBe(specContentHash("System SHOULD parse specs"));
  });

  it("parses a GFM single-dash delimiter row as a separator, not a data row", () => {
    const gfm = validSpec.replace(
      "| Spec Index | A deterministic projection of specification entries |",
      "| Spec Index | A deterministic projection of specification entries |\n|-|-|",
    );
    const parsed = parseSpec(gfm);
    // GFM accepts 1+ hyphens per delimiter cell; a single-dash row is
    // furniture. Misclassifying it as a data row mints a bogus entry.
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
      expect(parsed.errors.join("\n")).toContain("under an **Acceptance Scenarios:** block");
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
      expect(parsed.errors.join("\n")).toContain("contains no scenario bullets");
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
      expect(parsed.errors.join("\n")).toContain("must be a \"| Term | Definition\" row");
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
      expect(parsed.errors.join("\n")).toContain("outside a parsed section");
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
      expect(parsed.errors.join("\n")).toContain("unterminated code fence");
    }
  });
});
