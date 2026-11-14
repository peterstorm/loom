/**
 * The extraction half of no-dangling-doc-reference: which marks in a governed
 * file are references, and which shapes never are. A false reference is a
 * violation nobody can fix, so the refusals are pinned as hard as the reads.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { codeSpans, extractDocReferences, spanReference } from "../../../src/linter/doc-references/extract";
import type { DocReading, DocReference } from "../../../src/linter/doc-references/types";
import { refusal, value } from "../../fixtures/parse-result";

const lines = (...text: readonly string[]): string => text.join("\n");

const extracted = (text: string, reading: DocReading = "document"): readonly DocReference[] =>
  value(extractDocReferences(text, reading));

/** Each reference as `kind:text@line`, the shape most assertions need. */
const brief = (references: readonly DocReference[]): readonly string[] =>
  references.map(({ kind, text, line }) => `${kind}:${text}@${line}`);

const span = (text: string): DocReference | null => spanReference({ line: 1, text });

describe("codeSpans", () => {
  it("pairs a run of backticks with the next run of the same width", () => {
    expect(codeSpans("a `x` and ``y ` z`` end").map(({ content }) => content)).toEqual(["x", "y ` z"]);
  });

  it("reads a run with no partner on the line as literal text", () => {
    expect(codeSpans("a ` lone and `pair`")).toEqual([{ content: "lone and", start: 2, end: 14 }]);
    expect(codeSpans("``unmatched` ")).toEqual([]);
  });

  it("trims a span's content", () => {
    expect(codeSpans("`` `ticked` ``").map(({ content }) => content)).toEqual(["`ticked`"]);
  });
});

describe("spanReference — the shapes that are references", () => {
  it.each([
    ["engine/src/core/parse-spec.ts", { kind: "path", path: "engine/src/core/parse-spec.ts", directory: false, anchor: null }],
    ["docs/adr/", { kind: "path", path: "docs/adr", directory: true, anchor: null }],
    ["README.md#scope", { kind: "path", path: "README.md", directory: false, anchor: "scope" }],
    ["docs/x.md#a-b", { kind: "path", path: "docs/x.md", directory: false, anchor: "a-b" }],
    ["engine/src/x.ts:12", { kind: "path", path: "engine/src/x.ts", directory: false, anchor: null }],
    ["engine/src/x.ts:12-30", { kind: "path", path: "engine/src/x.ts", directory: false, anchor: null }],
    ["ledger.json", { kind: "file-name", name: "ledger.json" }],
    ["CONTEXT.md", { kind: "file-name", name: "CONTEXT.md" }],
    ["voteReason", { kind: "token", segments: ["voteReason"] }],
    ["planStopCheck()", { kind: "token", segments: ["planStopCheck"] }],
    ["config.docReferences.govern", { kind: "token", segments: ["config", "docReferences", "govern"] }],
    ["needs-verification", { kind: "token", segments: ["needs-verification"] }],
    ["image/logo.png", { kind: "path", path: "image/logo.png", directory: false, anchor: null }],
    ["text/", { kind: "path", path: "text", directory: true, anchor: null }],
  ])("`%s`", (text, expected) => {
    const reference = span(text);
    expect(reference === null ? null : { ...reference, line: undefined, text: undefined })
      .toEqual(expected === null ? null : { ...expected, line: undefined, text: undefined });
  });

  it("keeps the span as written in `text`: the baseline key and the message quote it", () => {
    expect(span("engine/src/x.ts:12")).toMatchObject({ line: 1, text: "engine/src/x.ts:12" });
  });
});

describe("spanReference — the shapes that never are", () => {
  it.each([
    ["a fragment with a space", "const x = 1"],
    ["an operator", "a + b"],
    ["a quoted string", "\"x\""],
    ["a URL", "https://example.com/x.md"],
    ["a scheme", "node:fs"],
    ["an angle placeholder", "<name>.md"],
    ["a brace placeholder", "{x}"],
    ["a bracket placeholder", "[id]"],
    ["a glob", "docs/*.md"],
    ["an ellipsis", "docs/.../x.md"],
    ["NNN", "ADR-NNN-title.md"],
    ["xxx", "xxx.ts"],
    ["YYYY", "YYYY-MM-DD-plan.md"],
    ["a -N", "wave-N"],
    ["n/a", "n/a"],
    ["an absolute path", "/etc/hosts"],
    ["a home path", "~/.claude/settings.json"],
    ["a variable", "$CLAUDE_PLUGIN_ROOT/x.md"],
    ["a bare variable", "$ref"],
    ["a flag", "--write-baseline"],
    ["a package scope", "@types/node"],
    ["a commit", "70e70694"],
    ["a spec id", "FR-007"],
    ["a task id", "T1"],
    ["a decision id", "AD-2"],
    ["an ADR id", "ADR-0042"],
    ["a suffix", ".test.ts"],
    ["a trailing dot", "name."],
    ["an empty dotted segment", "a..b"],
    ["a protocol-relative path", "a//b.md"],
    ["an empty anchor", "README.md#"],
    ["an empty span", ""],
    ["a media type", "application/x-www-form-urlencoded"],
    ["a media type with a suffix", "image/svg+xml"],
    ["a vendor media type", "application/vnd.api+json"],
    ["a text media type", "text/plain"],
  ])("%s: `%s`", (_label, text) => {
    expect(span(text)).toBeNull();
  });
});

describe("extractDocReferences — a document", () => {
  it("reads code spans, links and ADR ids, at their lines", () => {
    const text = lines(
      "# Title",
      "",
      "See `engine/src/x.ts` and [the guide](docs/guide.md#setup).",
      "ADR-0042 decided it; `voteReason` is gone.",
      "[def]: ../other.md",
    );
    expect(brief(extracted(text))).toEqual([
      "path:engine/src/x.ts@3",
      "link:docs/guide.md#setup@3",
      "token:voteReason@4",
      "adr:ADR-0042@4",
      "link:../other.md@5",
    ]);
  });

  it("never reads fenced code", () => {
    const text = lines("```ts", "// `ghost.ts` and [x](gone.md)", "```", "`real.md`");
    expect(brief(extracted(text))).toEqual(["file-name:real.md@4"]);
  });

  it("refuses an unclosed fence, naming its line: everything after it would go unread", () => {
    expect(refusal(extractDocReferences(lines("intro", "```", "`hidden.md`"), "document")))
      .toEqual({ kind: "unclosed-fence", line: 2 });
  });

  it("does not read a link written inside a code span", () => {
    expect(brief(extracted("`[x](gone.md)`"))).toEqual([]);
  });

  it("does not read an HTML comment, also across lines", () => {
    const text = lines("<!-- `gone.md` -->", "keep `kept.md` <!-- start", "`hidden.md`", "end --> `after.md`");
    expect(brief(extracted(text))).toEqual(["file-name:kept.md@2", "file-name:after.md@4"]);
  });

  it("reads links as targets: an image, a title, a percent-encoded path; never a URL, a mailto or a bare anchor", () => {
    const text = lines(
      "![d](img/a%20b.png \"t\")",
      "[u](https://x.dev/a.md) [m](mailto:a@b.c) [e](#)",
      "[self](#section)",
    );
    expect(extracted(text).map((reference) => reference.kind === "link" ? [reference.path, reference.anchor] : null)).toEqual([
      ["img/a b.png", null],
      ["", "section"],
    ]);
  });

  it("reads an ADR id standing alone, not one inside a path", () => {
    const text = "`docs/adr/ADR-0042-x.md` and ADR-0007, not xADR-0001 or ADR-0002-a";
    expect(brief(extracted(text))).toEqual(["path:docs/adr/ADR-0042-x.md@1", "adr:ADR-0007@1"]);
  });
});

describe("extractDocReferences — a plan", () => {
  const plan = (header: string): string => lines(
    "# Plan",
    header,
    "Builds `engine/src/new-module.ts` and `notYetWritten`.",
    "Covers FR-001, AS-002 and OOS-003; ADR-0042 holds. Not FR-01 or FR-0001.",
  );

  it.each([
    ["bold", "**Spec:** .claude/specs/x/spec.md"],
    ["backticked", "**Spec:** `.claude/specs/x/spec.md`"],
    ["a list item", "- **Spec:** .claude/specs/x/spec.md"],
  ])("reads the spec header (%s), the spec ids it cites and ADR ids — never paths or tokens", (_label, header) => {
    expect(brief(extracted(plan(header), "plan"))).toEqual([
      "spec:.claude/specs/x/spec.md@2",
      "spec-id:FR-001@4",
      "spec-id:AS-002@4",
      "spec-id:OOS-003@4",
      "adr:ADR-0042@4",
    ]);
    const cited = extracted(plan(header), "plan").flatMap((reference) => (reference.kind === "spec-id" ? [reference.spec] : []));
    expect(cited).toEqual([".claude/specs/x/spec.md", ".claude/specs/x/spec.md", ".claude/specs/x/spec.md"]);
  });

  it("reads no spec id when the plan has no spec header: there is nothing to check it against", () => {
    expect(brief(extracted(plan("No header."), "plan"))).toEqual(["adr:ADR-0042@4"]);
  });
});

describe("extractDocReferences — source comments", () => {
  it("reads code spans and ADR ids in comments only, at their lines", () => {
    const source = lines(
      "/**",
      " * Reads `core/parse-spec.ts`",
      " * per ADR-0042.",
      " */",
      "const s = \"`notAComment.ts`\";",
      "const t = `template ${s}`;",
      "// `lineComment` here",
    );
    expect(brief(extracted(source, "source-comments"))).toEqual([
      "path:core/parse-spec.ts@2",
      "adr:ADR-0042@3",
      "token:lineComment@7",
    ]);
  });
});

describe("extractDocReferences — properties", () => {
  const word = fc.stringMatching(/^[a-z][A-Za-z0-9]{2,10}$/);
  const proseLine = fc.oneof(
    word.map((name) => `see \`${name}\``),
    word.map((name) => `[x](${name}.md)`),
    word.map((name) => `\`docs/${name}.md#${name}\` and ADR-0042`),
    fc.constant("plain prose"),
  );

  it("never reads a token written inside a fence", () => {
    fc.assert(fc.property(fc.array(proseLine, { maxLength: 5 }), word, fc.array(proseLine, { maxLength: 5 }), (before, fenced, after) => {
      const text = lines(...before, "```", `\`${fenced}Fenced\``, "```", ...after);
      expect(extracted(text).map(({ text: written }) => written)).not.toContain(`${fenced}Fenced`);
    }));
  });

  it("reads every reference from a line that holds its text", () => {
    fc.assert(fc.property(fc.array(proseLine, { maxLength: 12 }), (prose) => {
      const text = lines(...prose);
      const textLines = text.split("\n");
      for (const reference of extracted(text)) expect(textLines[reference.line - 1]).toContain(reference.text);
    }));
  });

  const neverAReference = fc.oneof(
    fc.stringMatching(/^[0-9a-f]{7,40}$/),
    word.map((name) => `https://example.com/${name}.md`),
    word.map((name) => `node:${name}`),
    word.map((name) => `<${name}>.md`),
    word.map((name) => `${name}-NNN.md`),
    word.map((name) => `docs/${name}/*.md`),
    word.map((name) => `{${name}}`),
    word.map((name) => `${name}-N`),
  );

  it("never reads a placeholder, a commit or a URL as a reference", () => {
    fc.assert(fc.property(neverAReference, (written) => {
      expect(span(written)).toBeNull();
      expect(extracted(`see \`${written}\``)).toEqual([]);
    }));
  });
});

describe("extractDocReferences — totality", () => {
  const anyText = fc.array(
    fc.oneof(fc.constantFrom("`", "``", "```", "\n", "#", "[", "](", ")", "<!--", "-->", "/", ".md", "ADR-0001", "FR-001", "**Spec:** "), fc.string({ maxLength: 6 })),
    { maxLength: 40 },
  ).map((parts) => parts.join(""));

  it.each(["document", "plan", "source-comments"] as const)("never throws, and every reference sits on a line of the text (%s)", (reading) => {
    fc.assert(fc.property(anyText, (text) => {
      const extraction = extractDocReferences(text, reading);
      const lineCount = text.split("\n").length;
      const linesOf = extraction.ok ? extraction.value.map(({ line }) => line) : [extraction.error.line];
      expect(linesOf.filter((line) => line < 1 || line > lineCount)).toEqual([]);
    }));
  });
});
