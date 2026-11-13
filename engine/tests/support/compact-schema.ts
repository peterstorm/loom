/**
 * The reviewer payload schema as the wire-contract fragment presents it.
 *
 * `renderReviewerWireContract` shows the issued `reviewer-payload-schema`
 * section in compact form: a `## reviewer-payload-schema` heading, one
 * sentence saying the packet copy governs, then exactly one ```json block
 * holding the schema minified on one line. The rendered fragment, the
 * stamped `references/reviewer-wire/wire-contract.md` and every reviewer's
 * stamped region carry it, and several suites compare it to the issued
 * schema by value. This module is the one reader of that convention: a
 * change in how the fragment presents the schema is fixed here once, and a
 * fragment that drifts from it fails with the reason.
 */

import type { DomainResult } from "../../src/core/orchestration-contract/identity";
import { describeMarkdownError, fencesOf, sectionOf, type MarkdownError, type MarkdownSource } from "./markdown";

const SCHEMA_SECTION = "reviewer-payload-schema";

/** The schema block: its exact text, and that text parsed. */
export type CompactSchema = Readonly<{ text: string; value: unknown }>;

export type CompactSchemaError =
  | Readonly<{ kind: "markdown"; error: MarkdownError }>
  | Readonly<{ kind: "no-schema-block"; source: string }>
  | Readonly<{ kind: "several-schema-blocks"; source: string; lines: readonly number[] }>
  | Readonly<{ kind: "missing-lead-sentence"; source: string }>
  | Readonly<{ kind: "stray-section-content"; source: string; lines: readonly number[] }>
  | Readonly<{ kind: "schema-not-json"; source: string; line: number; message: string }>
  | Readonly<{ kind: "schema-not-compact"; source: string; line: number }>;

const err = (error: CompactSchemaError): DomainResult<never, CompactSchemaError> => ({ ok: false, error });

function parseJson(text: string): DomainResult<unknown, string> {
  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch (cause) {
    if (cause instanceof SyntaxError) return { ok: false, error: cause.message };
    throw cause;
  }
}

/** The schema of a wire-contract fragment, presented the one compact way. */
export function compactSchemaOf(source: MarkdownSource): DomainResult<CompactSchema, CompactSchemaError> {
  const section = sectionOf(source, SCHEMA_SECTION);
  if (!section.ok) return err({ kind: "markdown", error: section.error });
  const { name, lines, firstLine } = section.value;
  const blocks = fencesOf(section.value, "json");
  if (!blocks.ok) return err({ kind: "markdown", error: blocks.error });
  const [block] = blocks.value;
  if (block === undefined) return err({ kind: "no-schema-block", source: name });
  if (blocks.value.length > 1) {
    return err({ kind: "several-schema-blocks", source: name, lines: blocks.value.map(({ line }) => line) });
  }

  // Outside the block, the section holds its one lead sentence and blank lines.
  const [lead, ...stray] = lines
    .map((text, index) => ({ text, line: firstLine + index }))
    .filter(({ text, line }) => text.trim() !== "" && (line < block.line || line > block.end));
  if (lead === undefined || lead.line > block.line) return err({ kind: "missing-lead-sentence", source: name });
  if (stray.length > 0) return err({ kind: "stray-section-content", source: name, lines: stray.map(({ line }) => line) });

  const parsed = parseJson(block.body);
  if (!parsed.ok) return err({ kind: "schema-not-json", source: name, line: block.line + 1, message: parsed.error });
  if (block.body !== JSON.stringify(parsed.value)) return err({ kind: "schema-not-compact", source: name, line: block.line + 1 });
  return { ok: true, value: Object.freeze({ text: block.body, value: parsed.value }) };
}

/** One sentence naming the source and how its schema section departs from the convention. */
export function describeCompactSchemaError(error: CompactSchemaError): string {
  switch (error.kind) {
    case "markdown":
      return describeMarkdownError(error.error);
    case "no-schema-block":
      return `${error.source} has no \`\`\`json schema block`;
    case "several-schema-blocks":
      return `${error.source} has ${error.lines.length} \`\`\`json blocks (lines ${error.lines.join(", ")}); expected exactly one schema block`;
    case "missing-lead-sentence":
      return `${error.source} does not open with the one sentence that precedes the schema block`;
    case "stray-section-content":
      return `${error.source} holds content besides its lead sentence and schema block (lines ${error.lines.join(", ")})`;
    case "schema-not-json":
      return `${error.source}: the schema block at line ${error.line} is not JSON (${error.message})`;
    case "schema-not-compact":
      return `${error.source}: the schema block at line ${error.line} is not the one-line minified form of its value`;
    default: {
      const unreachable: never = error;
      return unreachable;
    }
  }
}
