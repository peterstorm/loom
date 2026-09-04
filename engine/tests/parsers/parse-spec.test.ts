import { describe, expect, it } from "vitest";
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

  it("keeps an info-string line inside a fence as content, never a closer", () => {
    const infoString = validSpec.replace(
      "## Out of Scope",
      "```markdown\n## Out of Scope\n- OOS-009: minted from fence content\n```yaml\n```\n\n## Out of Scope",
    );
    const parsed = parseSpec(infoString);
    // CommonMark: the ```yaml line is fence content, so the fence stays open
    // until the marker-only closer — the restored Out of Scope section parses
    // and the fenced OOS-009 never mints an entry. Closing early on the
    // info-string line blanks the restored section and fails the parse.
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(JSON.stringify(parsed.value)).not.toContain("OOS-009");
      expect(parsed.value.oos.map(({ id }) => id)).toEqual(["OOS-001", "OOS-002"]);
    }
  });

  it("never closes a fence on a same-character marker carrying trailing content", () => {
    const trailing = validSpec.replace(
      "## Out of Scope",
      "```markdown\n## Out of Scope\n- OOS-009: minted from fence content\n```inner\n```\n\n## Out of Scope",
    );
    const parsed = parseSpec(trailing);
    // CommonMark: ```inner carries an info string, so it is fence content and
    // never a closer; the fence closes on the marker-only line that follows.
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

  it.each([
    ["bold-asterisk", "** FR-002: System MUST be recognized"],
    ["ordered-list", "1. FR-002: System MUST be recognized"],
    ["lowercase bare", "fr-002: System MUST be recognized"],
    ["two-digit bare", "FR-02: System MUST be recognized"],
    ["two-digit hyphenated", "FR-12: System MUST be recognized"],
    ["single-digit", "AS-1: System MUST be recognized"],
  ])("fails closed for %s near-miss IDs", (_kind, strayLine) => {
    const stray = validSpec.replace(
      "- FR-002: System MUST hash requirement content deterministically",
      `- FR-001: System MUST parse canonical requirement IDs\n${strayLine}`,
    );
    const parsed = parseSpec(stray);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(parsed.errors.join("\n")).toContain("Functional Requirements");
    }
  });

  it("fails closed for misplaced reserved-family IDs in non-required sections", () => {
    const misplaced = validSpec.replace(
      "## Appendix: Glossary",
      "## Open Questions\n\n1. Is FR-003 needed?\n- FR-009: A misplaced requirement\n\n## Appendix: Glossary",
    );
    const parsed = parseSpec(misplaced);
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) {
      expect(parsed.errors.join("\n")).toContain("outside a parsed section");
    }
  });

  it("parses CRLF line endings", () => {
    const parsed = parseSpec(validSpec.replace(/\n/gu, "\r\n"));
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.value.frs.map(({ id }) => id)).toEqual(["FR-001", "FR-002"]);
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

  it("canonicalizes formatting whitespace but changes the hash when content changes", () => {
    expect(specContentHash("System MUST parse specs"))
      .toBe(specContentHash("  System   MUST parse\n specs  "));
    expect(specContentHash("System MUST parse specs"))
      .not.toBe(specContentHash("System SHOULD parse specs"));
  });
});
