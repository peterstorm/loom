/**
 * External names: which strings the config may list (exactly the words the
 * extractor reads as a word reference), the index the resolver reads, and the
 * two ways a listed name decays.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  describeExternalNameRefusal,
  externalNameIndex,
  parseExternalName,
  staleExternalNames,
  type ExternalNameRefusal,
} from "../../../src/linter/doc-references/external-names";
import { spanReference } from "../../../src/linter/doc-references/extract";
import type { ExternalName, ExternalNameGroup } from "../../../src/linter/doc-references/types";
import { fakeIndex } from "./fake-snapshot";

const named = (raw: string): ExternalName => {
  const parsed = parseExternalName(raw);
  if (!parsed.ok) throw new Error(`not an external name: ${raw}`);
  return parsed.value;
};

const group = (reason: string, ...names: [string, ...string[]]): ExternalNameGroup => {
  const [first, ...rest] = names;
  return { names: [named(first), ...rest.map(named)], reason };
};

describe("parseExternalName: exactly the words a document can reference", () => {
  it.each(["ai.llm.tokens_in", "answer_correctness", "faithfulness", "Sites.Selected", "Mail.Send", "claude-opus-4-5", "gpt-4o"])(
    "accepts `%s`",
    (raw) => {
      expect(parseExternalName(raw)).toEqual({ ok: true, value: raw });
    },
  );

  it.each<[string, ExternalNameRefusal["kind"]]>([
    ["ai.llm.*", "pattern"],
    ["Sites.?", "pattern"],
    ["{a,b}", "pattern"],
    ["[ab]c", "pattern"],
    ["Mail Send", "whitespace"],
    [" faithfulness", "whitespace"],
    ["docs/guide.md", "not-a-word"],
    ["ledger.json", "not-a-word"],
    ["parseSpec()", "not-a-word"],
    ["FR-007", "not-a-word"],
    ["--flag", "not-a-word"],
    ["node:fs", "not-a-word"],
    ["trailing.", "not-a-word"],
    ["a..b", "not-a-word"],
    ["9lives", "not-a-word"],
    ["", "not-a-word"],
  ])("refuses `%s` as %s, naming it", (raw, kind) => {
    const parsed = parseExternalName(raw);
    expect(parsed).toEqual({ ok: false, error: { kind, raw } });
    if (!parsed.ok) expect(describeExternalNameRefusal(parsed.error)).toContain(`'${raw}'`);
  });

  /** A word as the extractor's grammar writes one: dotted segments of identifier characters and dashes. */
  const segment = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,8}$/);
  const word = fc.array(segment, { minLength: 1, maxLength: 4 }).map((segments) => segments.join("."));

  it("property: a name is accepted exactly when the extractor reads the same text as a word reference", () => {
    fc.assert(fc.property(fc.oneof(word, fc.string({ maxLength: 16 })), (raw) => {
      const reference = spanReference({ line: 1, text: raw });
      const isWord = reference?.kind === "token" && reference.text === raw && !raw.endsWith("()") && !/[*?[\]{}\s]/.test(raw);
      expect(parseExternalName(raw).ok).toBe(isWord);
    }));
  });

  /** A word the extractor reads as a word reference: not placeholder grammar (`_n_`) or a document id. */
  const referencedWord = word.filter((raw) => spanReference({ line: 1, text: raw })?.kind === "token");

  it("property: an accepted name round-trips unchanged — the list is exact", () => {
    fc.assert(fc.property(referencedWord, (raw) => {
      const parsed = parseExternalName(raw);
      expect(parsed.ok && parsed.value === raw).toBe(true);
    }));
  });
});

describe("externalNameIndex", () => {
  it("maps every listed name to its group", () => {
    const telemetry = group("OpenTelemetry attributes emitted at runtime", "ai.llm.tokens_in", "ai.llm.tokens_out");
    const graph = group("Microsoft Graph permissions", "Sites.Selected");
    const index = externalNameIndex([telemetry, graph]);
    expect([...index.keys()]).toEqual(["ai.llm.tokens_in", "ai.llm.tokens_out", "Sites.Selected"]);
    expect(index.get("Sites.Selected")).toBe(graph);
    expect(index.get("Sites")).toBeUndefined();
  });
});

describe("staleExternalNames: a list that only subtracts reports its own decay", () => {
  const SOURCE = fakeIndex({ "src/eval.ts": "export const scorers = [\"faithfulness\"]; export const ai = 1; export const llm = 2;" });
  const scorers = group("Python eval scorers, named in the eval config only", "answer_correctness", "faithfulness");
  const telemetry = group("OpenTelemetry attributes emitted at runtime", "ai.llm.tokens_in", "ai.llm");

  it("keeps a referenced name the source does not resolve", () => {
    expect(staleExternalNames([scorers], new Set(["answer_correctness"]), fakeIndex({}))).toEqual([
      { name: "faithfulness", group: scorers, why: "unreferenced" },
    ]);
  });

  it("reports a name no governed document references", () => {
    expect(staleExternalNames([scorers], new Set(["faithfulness"]), fakeIndex({}))).toEqual([
      { name: "answer_correctness", group: scorers, why: "unreferenced" },
    ]);
  });

  it("reports a referenced name the source already resolves — whole, or every dotted segment — as not external", () => {
    const referenced = new Set(["answer_correctness", "faithfulness", "ai.llm.tokens_in", "ai.llm"]);
    expect(staleExternalNames([scorers, telemetry], referenced, SOURCE)).toEqual([
      { name: "faithfulness", group: scorers, why: "in-source" },
      { name: "ai.llm", group: telemetry, why: "in-source" },
    ]);
  });

  it("names a name both unreferenced and held by the source once, as unreferenced", () => {
    expect(staleExternalNames([scorers], new Set(["answer_correctness"]), SOURCE)).toEqual([
      { name: "faithfulness", group: scorers, why: "unreferenced" },
    ]);
  });

  it("reports nothing for no groups", () => {
    expect(staleExternalNames([], new Set(["x"]), SOURCE)).toEqual([]);
  });
});
