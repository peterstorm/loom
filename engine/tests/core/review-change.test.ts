/**
 * Change Class (ADR-0093, loom#213 Cause 5b): what changed in a reviewed
 * Task since its last accepted review, and the reviewer roles that change
 * needs. A pure classifier over a before/after view, and a pure selection.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS,
  BASE_WAVE_REVIEW_AGENTS,
} from "../../src/core/agent-catalog-projections";
import {
  classifyReviewChange,
  selectReviewRoles,
  type ChangeClass,
  type ReviewChange,
  type ReviewChangeSide,
  type ReviewContextFacts,
  type ReviewedFile,
} from "../../src/core/review-change";
import { DEFAULT_TEST_FILE_SUFFIXES } from "../../src/core/test-file-classification";

const CONTEXT: ReviewContextFacts = {
  description: "T1 work", agent: "code-implementer-agent", planContext: null,
  specAnchors: [], specContributions: [], declaredFiles: ["src/a.ts", "src/a.test.ts", "docs/a.md"],
  planFile: null, ownerMap: { kind: "observed", text: null }, contractSurface: { kind: "observed", text: null },
};

const SOURCE = [
  "/** Adds one. */",
  "export function inc(x: number): number {",
  "  // the increment",
  "  return x + 1;",
  "}",
  "",
].join("\n");
const TEST = "import { inc } from './a';\nit('adds', () => expect(inc(1)).toBe(2));\n";
const DOC = "# A\n\nAdds one.\n";

const text = (path: string, body: string): ReviewedFile => ({ path, content: { kind: "text", text: body } });
const side = (files: Readonly<Record<string, string>>, context: ReviewContextFacts = CONTEXT): ReviewChangeSide => ({
  files: Object.entries(files).map(([path, body]) => text(path, body)),
  context,
});
const BEFORE = side({ "docs/a.md": DOC, "src/a.test.ts": TEST, "src/a.ts": SOURCE });
const after = (changes: Readonly<Record<string, string>>, context?: ReviewContextFacts): ReviewChangeSide =>
  side({ "docs/a.md": DOC, "src/a.test.ts": TEST, "src/a.ts": SOURCE, ...changes }, context);
const classify = (next: ReviewChangeSide): ReviewChange => classifyReviewChange(BEFORE, next, DEFAULT_TEST_FILE_SUFFIXES);

describe("classifyReviewChange names what changed since the basis", () => {
  it("a doc-comment edit is comment-only", () => {
    expect(classify(after({ "src/a.ts": SOURCE.replace("Adds one.", "Adds exactly one.") })))
      .toEqual({ kind: "changed", classes: ["comment"] });
  });

  it("a removed line comment and its blank line are comment-only", () => {
    expect(classify(after({ "src/a.ts": SOURCE.replace("  // the increment\n", "") })))
      .toEqual({ kind: "changed", classes: ["comment"] });
  });

  it("a code edit is code", () => {
    expect(classify(after({ "src/a.ts": SOURCE.replace("x + 1", "x + 2") })))
      .toEqual({ kind: "changed", classes: ["code"] });
  });

  it("a test-file edit is test, a doc-file edit is doc, and a mix is their union in class order", () => {
    expect(classify(after({ "src/a.test.ts": `${TEST}it('again', () => {});\n` }))).toEqual({ kind: "changed", classes: ["test"] });
    expect(classify(after({ "docs/a.md": `${DOC}More.\n` }))).toEqual({ kind: "changed", classes: ["doc"] });
    expect(classify(after({
      "docs/a.md": `${DOC}More.\n`,
      "src/a.test.ts": `${TEST}\n// note\n`,
      "src/a.ts": SOURCE.replace("the increment", "add one"),
    }))).toEqual({ kind: "changed", classes: ["comment", "doc", "test"] });
  });

  it("identical bytes and context are unchanged", () => {
    expect(classify(after({}))).toEqual({ kind: "unchanged" });
  });

  it("an added or removed path is a scope change", () => {
    expect(classify(side({ "docs/a.md": DOC, "src/a.test.ts": TEST, "src/a.ts": SOURCE, "src/b.ts": "x;\n" })))
      .toEqual({ kind: "scope-changed" });
    expect(classify(side({ "src/a.test.ts": TEST, "src/a.ts": SOURCE }))).toEqual({ kind: "scope-changed" });
  });

  it("a changed description, plan context, Requirement trace or section, or an unobserved section, is a context change", () => {
    const contexts: readonly ReviewContextFacts[] = [
      { ...CONTEXT, description: "other" },
      { ...CONTEXT, planContext: "plan" },
      { ...CONTEXT, specAnchors: ["FR-001"] },
      { ...CONTEXT, ownerMap: { kind: "observed", text: "## Owner map" } },
      { ...CONTEXT, contractSurface: { kind: "unobserved" } },
    ];
    for (const context of contexts) expect(classify(after({}, context))).toEqual({ kind: "context-changed" });
  });

  it("a file created or deleted inside the scope is classed by its path", () => {
    const absent = { ...BEFORE, files: BEFORE.files.map((file) =>
      (file.path === "src/a.ts" ? { path: file.path, content: { kind: "absent" as const } } : file)) };
    expect(classifyReviewChange(absent, after({}), DEFAULT_TEST_FILE_SUFFIXES)).toEqual({ kind: "changed", classes: ["code"] });
  });

  it("anything the comment lexer cannot read safely counts as code", () => {
    const doubtful = [
      SOURCE.replace("x + 1", "x / 2 // half"),          // a division before a comment on its line
      SOURCE.replace("x + 1", "`${x} /* not */`"),        // the edit is inside a template literal
      SOURCE.replace("x + 1", "\"unterminated"),           // an unterminated string
    ];
    for (const body of doubtful) {
      expect(classify(after({ "src/a.ts": body.replace("// the increment", "// changed") })))
        .toEqual({ kind: "changed", classes: ["code"] });
    }
  });

  it("a comment-only change in a language the lexer does not read is code", () => {
    const before = side({ "src/a.py": "# one\nx = 1\n" });
    const next = side({ "src/a.py": "# two\nx = 1\n" });
    expect(classifyReviewChange(before, next, DEFAULT_TEST_FILE_SUFFIXES)).toEqual({ kind: "changed", classes: ["code"] });
    const jsx = side({ "src/a.tsx": "const a = <p>{/* one */}</p>;\n" });
    const jsxNext = side({ "src/a.tsx": "const a = <p>{/* two */}</p>;\n" });
    expect(classifyReviewChange(jsx, jsxNext, DEFAULT_TEST_FILE_SUFFIXES)).toEqual({ kind: "changed", classes: ["code"] });
  });

  it("a changed binary file is code", () => {
    const binary = (base64: string): ReviewChangeSide => ({
      files: [{ path: "assets/a.png", content: { kind: "binary", base64 } }], context: CONTEXT,
    });
    expect(classifyReviewChange(binary("AAEC"), binary("AAED"), DEFAULT_TEST_FILE_SUFFIXES))
      .toEqual({ kind: "changed", classes: ["code"] });
  });
});

describe("selectReviewRoles follows the operator's role table", () => {
  const changed = (first: ChangeClass, ...rest: ChangeClass[]): ReviewChange => ({ kind: "changed", classes: [first, ...rest] });

  const narrowed = (roster: readonly string[], ...change: ChangeClass[]) => ({ kind: "narrowed", roster, change });
  const WHOLE = { kind: "whole" };

  it("a comment- or doc-only change issues comment-analyzer only", () => {
    expect(selectReviewRoles(BASE_WAVE_REVIEW_AGENTS, changed("comment"), [])).toEqual(narrowed(["comment-analyzer"], "comment"));
    expect(selectReviewRoles(ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS, changed("doc"), [])).toEqual(narrowed(["comment-analyzer"], "doc"));
  });

  it("a test-only change issues code-reviewer and pr-test-analyzer", () => {
    expect(selectReviewRoles(BASE_WAVE_REVIEW_AGENTS, changed("test"), []))
      .toEqual(narrowed(["code-reviewer", "pr-test-analyzer"], "test"));
  });

  it("a mix issues the union, in roster order", () => {
    expect(selectReviewRoles(BASE_WAVE_REVIEW_AGENTS, changed("comment", "test"), []))
      .toEqual(narrowed(["code-reviewer", "pr-test-analyzer", "comment-analyzer"], "comment", "test"));
  });

  it("the owner of an open prior Finding on the derived roster is always issued", () => {
    expect(selectReviewRoles(BASE_WAVE_REVIEW_AGENTS, changed("comment"), ["code-reviewer", "recovered-view"]))
      .toEqual(narrowed(["code-reviewer", "comment-analyzer"], "comment"));
    expect(selectReviewRoles(ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS, changed("comment"), ["architecture-tech-lead"]))
      .toEqual(narrowed(["comment-analyzer", "architecture-tech-lead"], "comment"));
  });

  it("a code, scope, context or no detected change issues the whole derived roster", () => {
    const full: readonly ReviewChange[] = [
      changed("code"), changed("comment", "code"), { kind: "scope-changed" }, { kind: "context-changed" }, { kind: "unchanged" },
    ];
    for (const change of full) {
      expect(selectReviewRoles(BASE_WAVE_REVIEW_AGENTS, change, [])).toEqual(WHOLE);
      expect(selectReviewRoles(ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS, change, [])).toEqual(WHOLE);
    }
  });

  it("a selection that covers the whole roster is the whole roster", () => {
    expect(selectReviewRoles(BASE_WAVE_REVIEW_AGENTS, changed("comment"), [...BASE_WAVE_REVIEW_AGENTS])).toEqual(WHOLE);
  });

  it("is monotone in code: adding any code change to any change issues the full roster", () => {
    const file = fc.record({
      path: fc.constantFrom("src/a.ts", "src/a.test.ts", "docs/a.md"),
      body: fc.constantFrom("// c\n", "x;\n", "# h\n", "it('t', () => {});\n"),
    });
    const original: Readonly<Record<string, string>> = { "docs/a.md": DOC, "src/a.test.ts": TEST, "src/a.ts": SOURCE };
    fc.assert(fc.property(fc.array(file, { maxLength: 3 }), fc.subarray([...BASE_WAVE_REVIEW_AGENTS]), (edits, owners) => {
      const edited: Record<string, string> = {};
      for (const { path, body } of edits) edited[path] = `${edited[path] ?? original[path]}${body}`;
      const withCode = { ...edited, "src/a.ts": `${edited["src/a.ts"] ?? SOURCE}export const changed = 1;\n` };
      expect(selectReviewRoles(BASE_WAVE_REVIEW_AGENTS, classify(after(withCode)), owners)).toEqual({ kind: "whole" });
    }));
  });
});
