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
  NO_EXTERNAL_NAMES,
  parseExternalName,
  staleExternalNames,
  type ExternalNameRefusal,
  type ReferencedWords,
} from "../../../src/linter/doc-references/external-names";
import { spanReference } from "../../../src/linter/doc-references/extract";
import { externalName, externalNameGroup as group, indexedNames } from "./external-name-fixtures";
import { fakeIndex } from "./fake-snapshot";

const read = (...words: string[]): ReferencedWords => ({ kind: "read", words: new Set(words) });

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
  const segment = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_-]{0,8}$/);
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

  it("the word generator writes dashed words, and they round-trip like `claude-opus-4-5`", () => {
    const dashed = fc.sample(referencedWord, { numRuns: 500, seed: 42 }).filter((raw) => raw.includes("-"));
    expect(dashed.length).toBeGreaterThan(0);
    for (const raw of ["claude-opus-4-5", ...dashed]) expect(parseExternalName(raw)).toEqual({ ok: true, value: raw });
  });
});

describe("externalNameIndex", () => {
  const telemetry = group("OpenTelemetry attributes emitted at runtime", "ai.llm.tokens_in", "ai.llm.tokens_out");
  const graph = group("Microsoft Graph permissions", "Sites.Selected");

  it("maps every listed name to its group, keeping the groups in order", () => {
    const index = indexedNames(telemetry, graph);
    expect(index.groups).toEqual([telemetry, graph]);
    expect([...index.byName.keys()]).toEqual(["ai.llm.tokens_in", "ai.llm.tokens_out", "Sites.Selected"]);
    expect(index.byName.get("Sites.Selected")).toBe(graph);
    expect(index.byName.get("Sites")).toBeUndefined();
  });

  it("refuses a name listed twice, in one group or across two, naming it", () => {
    const again = group("a second reason", "Mail.Send", "Sites.Selected");
    expect(externalNameIndex([graph, again])).toEqual({ ok: false, error: { kind: "listed-twice", name: "Sites.Selected" } });
    const twiceInOne = { names: [externalName("Mail.Send"), externalName("Mail.Send")] as const, reason: "x" };
    expect(externalNameIndex([twiceInOne])).toEqual({ ok: false, error: { kind: "listed-twice", name: "Mail.Send" } });
  });

  it("indexes no groups as the empty index", () => {
    expect(externalNameIndex([])).toEqual({ ok: true, value: NO_EXTERNAL_NAMES });
  });

  it("property: every name of distinct groups maps to the one group that lists it", () => {
    const names = fc.uniqueArray(fc.constantFrom("a", "b.c", "d_e", "f-g", "Mail.Send", "x.y.z"), { minLength: 1 });
    fc.assert(fc.property(names, fc.integer({ min: 1, max: 3 }), (unique, chunk) => {
      const groups = Array.from({ length: Math.ceil(unique.length / chunk) }, (_, at) => {
        const [first, ...rest] = unique.slice(at * chunk, at * chunk + chunk) as [string, ...string[]];
        return group(`group ${at}`, first, ...rest);
      });
      const indexed = externalNameIndex(groups);
      expect(indexed.ok).toBe(true);
      if (!indexed.ok) return;
      for (const listed of groups) for (const name of listed.names) expect(indexed.value.byName.get(name)).toBe(listed);
      expect(indexed.value.byName.size).toBe(unique.length);
    }));
  });
});

describe("staleExternalNames: a list that only subtracts reports its own decay", () => {
  const SOURCE = fakeIndex({ "src/eval.ts": "export const scorers = [\"faithfulness\"]; export const ai = 1; export const llm = 2;" });
  const scorers = group("Python eval scorers, named in the eval config only", "answer_correctness", "faithfulness");
  const telemetry = group("OpenTelemetry attributes emitted at runtime", "ai.llm.tokens_in", "ai.llm");

  it("keeps a referenced name the source does not resolve", () => {
    expect(staleExternalNames(indexedNames(scorers), read("answer_correctness"), fakeIndex({}))).toEqual([
      { name: "faithfulness", group: scorers, why: "unreferenced" },
    ]);
  });

  it("reports a name no governed document references", () => {
    expect(staleExternalNames(indexedNames(scorers), read("faithfulness"), fakeIndex({}))).toEqual([
      { name: "answer_correctness", group: scorers, why: "unreferenced" },
    ]);
  });

  it("reports a referenced name the source already resolves — whole, or every dotted segment — as not external", () => {
    const referenced = read("answer_correctness", "faithfulness", "ai.llm.tokens_in", "ai.llm");
    expect(staleExternalNames(indexedNames(scorers, telemetry), referenced, SOURCE)).toEqual([
      { name: "faithfulness", group: scorers, why: "in-source" },
      { name: "ai.llm", group: telemetry, why: "in-source" },
    ]);
  });

  it("names a name both unreferenced and held by the source once, as unreferenced", () => {
    expect(staleExternalNames(indexedNames(scorers), read("answer_correctness"), SOURCE)).toEqual([
      { name: "faithfulness", group: scorers, why: "unreferenced" },
    ]);
  });

  it("reports nothing for no groups", () => {
    expect(staleExternalNames(NO_EXTERNAL_NAMES, read("x"), SOURCE)).toEqual([]);
  });

  it("while the referenced words are withheld, calls no name unreferenced and still reports the names the source resolves", () => {
    expect(staleExternalNames(indexedNames(scorers, telemetry), { kind: "withheld" }, SOURCE)).toEqual([
      { name: "faithfulness", group: scorers, why: "in-source" },
      { name: "ai.llm", group: telemetry, why: "in-source" },
    ]);
  });
});
