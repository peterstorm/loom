/**
 * The one reader of the wire-contract fragment's compact schema section. Four
 * suites compare the schema it returns to the issued one, so each way the
 * section can depart from the convention must be refused with its reason.
 */

import { describe, expect, it } from "vitest";
import { renderReviewerWireContract } from "../../src/core/reviewer-protocol";
import { REVIEWER_PAYLOAD_SCHEMA_V2 } from "../../src/core/reviewer-contract";
import { refusal, value } from "../fixtures/parse-result";
import { compactSchemaOf, describeCompactSchemaError } from "./compact-schema";
import { markdown } from "../../src/linter/markdown";

const LEAD = "The issued Context Packet's `reviewer-payload-schema` section in compact form; the packet copy governs.";
const EXAMPLE = ["## Example (standalone-review only)", "", "```json", "{", '  "kind": "standalone-review"', "}", "```"];
const fragment = (...section: readonly string[]) =>
  markdown("fragment.md", ["Emit exactly one JSON object.", "", "## reviewer-payload-schema", "", ...section, "", ...EXAMPLE].join("\n"));

describe("compactSchemaOf", () => {
  it("reads the one minified block after the lead sentence, and no block of a later section", () => {
    expect(value(compactSchemaOf(fragment(LEAD, "", "```json", '{"type":"object"}', "```"))))
      .toEqual({ text: '{"type":"object"}', value: { type: "object" } });
  });

  it("reads the rendered wire contract as the issued schema value", () => {
    const schema = value(compactSchemaOf(markdown("renderReviewerWireContract()", renderReviewerWireContract())));
    expect(schema.value).toEqual(JSON.parse(REVIEWER_PAYLOAD_SCHEMA_V2));
    expect(schema.text).toBe(JSON.stringify(JSON.parse(REVIEWER_PAYLOAD_SCHEMA_V2)));
  });

  it.each<readonly [string, readonly string[], string]>([
    ["a section without a schema block", [LEAD],
      "fragment.md § reviewer-payload-schema has no ```json schema block"],
    ["a section with two schema blocks", [LEAD, "", "```json", "{}", "```", "", "```json", "[]", "```"],
      "fragment.md § reviewer-payload-schema has 2 ```json blocks (lines 7, 11); expected exactly one schema block"],
    ["a block with no lead sentence", ["```json", "{}", "```"],
      "fragment.md § reviewer-payload-schema does not open with the one sentence that precedes the schema block"],
    ["prose after the block", [LEAD, "", "```json", "{}", "```", "", "An afterthought."],
      "fragment.md § reviewer-payload-schema holds content besides its lead sentence and schema block (lines 11)"],
    ["a second lead paragraph", [LEAD, "", "Another sentence.", "", "```json", "{}", "```"],
      "fragment.md § reviewer-payload-schema holds content besides its lead sentence and schema block (lines 7)"],
    ["a pretty-printed schema", [LEAD, "", "```json", "{", '  "type": "object"', "}", "```"],
      "fragment.md § reviewer-payload-schema: the schema block at line 8 is not the one-line minified form of its value"],
  ])("refuses %s, naming the reason", (_name, section, message) => {
    expect(describeCompactSchemaError(refusal(compactSchemaOf(fragment(...section))))).toBe(message);
  });

  it("refuses a block that is not JSON, carrying the parser's reason", () => {
    const error = refusal(compactSchemaOf(fragment(LEAD, "", "```json", "{oops}", "```")));
    expect(error).toMatchObject({ kind: "schema-not-json", source: "fragment.md § reviewer-payload-schema", line: 8 });
  });

  it("refuses a fragment with no schema section, naming the heading and the source", () => {
    const error = refusal(compactSchemaOf(markdown("agents/x.md wire-contract region", EXAMPLE.join("\n"))));
    expect(describeCompactSchemaError(error)).toBe('agents/x.md wire-contract region has no "reviewer-payload-schema" heading');
  });
});
