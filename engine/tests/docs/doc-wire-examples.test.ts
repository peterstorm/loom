/**
 * Every wire example a doc shows is admitted by the parser that owns its shape.
 *
 * A doc that teaches a shape the parser refuses is an agent or operator whose
 * output the engine refuses, discovered at run time. The suite closes that from
 * both sides: every JSON example in the governed docs must declare what it is
 * (a registered shape, or `none` with a reason), every registered shape must be
 * taught somewhere, and every declared example goes through the production
 * parser as written.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  UNGOVERNED,
  examplesOf,
  governedExamples,
  heredocBodies,
  isGoverned,
  jsonTextsOf,
  markerDefects,
  parseDocJson,
  parseWireMarker,
  readGovernedDocs,
  renderOptOutMarker,
  renderShapeMarker,
  resolvePlaceholders,
  scanDoc,
  sequence,
} from "../support/doc-wire-examples";
import { WIRE_SHAPES, WIRE_SHAPE_IDS, parseDocumentedExample, parseWireShapeId } from "../support/doc-wire-shapes";

const docs = readGovernedDocs();
const examples = governedExamples(docs);

describe("the governed docs declare every wire example", () => {
  it("leaves no JSON example unmarked, no marker malformed, dangling or naming an unregistered shape", () => {
    expect(docs.flatMap((doc) => markerDefects(doc.scan, doc.file, WIRE_SHAPE_IDS))).toEqual([]);
  });

  it("gives every opt-out a reason a reader can act on", () => {
    const reasons = docs.flatMap((doc) => doc.scan.fences.flatMap((fence) => (fence.marker?.kind === "none" ? [fence.marker.reason] : [])));
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) expect(reason.length, reason).toBeGreaterThanOrEqual(20);
  });

  it("teaches every registered shape in at least one doc", () => {
    const taught = new Set(examples.map((example) => example.shapeId));
    expect(WIRE_SHAPE_IDS.filter((id) => !taught.has(id))).toEqual([]);
  });

  it("reads the stamped reviewer regions as generated, not as hand-written examples", () => {
    const reviewer = docs.find((doc) => doc.file === "agents/code-reviewer.md");
    expect(reviewer?.scan.fences.filter((fence) => jsonTextsOf(fence).length > 0)).toEqual([]);
  });

  it("names only paths that exist in its ungoverned list", () => {
    const governedOrNot = (path: string): boolean => isGoverned(path.endsWith("/") ? `${path}x.md` : path);
    expect(UNGOVERNED.filter((entry) => governedOrNot(entry.path))).toEqual([]);
  });
});

describe("every documented example parses", () => {
  it.each(examples.map((example) => [`${example.file}:${example.line}`, example.shapeId, example] as const))(
    "%s (%s)",
    (_at, _shapeId, example) => {
      const parsed = parseDocumentedExample(example);
      expect(parsed.ok ? [] : parsed.errors).toEqual([]);
    },
  );
});

describe("every registered shape reaches a parser that can refuse", () => {
  // A registry entry whose `parse` admitted everything would turn the suite
  // above into a check that the docs hold well-formed JSON.
  it.each(WIRE_SHAPE_IDS.map((id) => [id] as const))("%s refuses a document that is not its shape", (id) => {
    const shape = WIRE_SHAPES[id];
    const foreign = shape.format === "text" ? "not a wire line" : { "not-a-field-of-any-wire-shape": true };
    expect(shape.parse(foreign).ok).toBe(false);
  });

  it("admits no documented example under another shape's id, so a marker naming the wrong shape fails", () => {
    const misfiled = examples.flatMap((example) => WIRE_SHAPE_IDS
      .filter((id) => id !== example.shapeId && parseDocumentedExample({ ...example, shapeId: id }).ok)
      .map((id) => `${example.file}:${example.line} (${example.shapeId}) also parses as ${id}`));
    expect(misfiled).toEqual([]);
  });

  it("reports an unreadable example as a refusal instead of throwing", () => {
    const at = { file: "doc.md", line: 1 };
    expect(parseDocumentedExample({ ...at, shapeId: "wave-gate-start", text: "{ not json" }).ok).toBe(false);
    expect(parseDocumentedExample({ ...at, shapeId: "wave-gate-start", text: '{"wave":"<no entry for this key>"}' }).ok).toBe(false);
    expect(parseDocumentedExample({ ...at, shapeId: "no-such-shape", text: "{}" }).ok).toBe(false);
    expect(parseDocumentedExample({ ...at, shapeId: "wave-gate-start", text: '{"wave":null}' }).ok).toBe(true);
  });
});

// --- The extraction itself ---

const shapeIds = fc.constantFrom(...WIRE_SHAPE_IDS);
/** Prose that is neither blank, a fence nor a marker. */
const proseLines = fc.stringMatching(/^[A-Za-z][A-Za-z ,.]{0,40}$/);
const reasons = fc.stringMatching(/^[a-z][a-z ]{0,30}[a-z]$/);
const jsonValues = fc.jsonValue().map((value) => JSON.stringify(value, null, 2));
const jsonObjects = fc.dictionary(fc.string(), fc.jsonValue()).map((value) => JSON.stringify(value, null, 2));

const fenced = (language: string, body: string): string => `\`\`\`${language}\n${body}\n\`\`\``;

describe("markers", () => {
  it("round-trips a shape marker and an opt-out marker", () => {
    fc.assert(fc.property(shapeIds, reasons, (shapeId, reason) => {
      expect(parseWireMarker(renderShapeMarker(shapeId))).toEqual({ kind: "shape", shapeId });
      expect(parseWireMarker(renderOptOutMarker(reason))).toEqual({ kind: "none", reason });
    }));
  });

  it("reads no marker out of prose", () => {
    fc.assert(fc.property(proseLines, (line) => {
      expect(parseWireMarker(line)).toBeNull();
    }));
  });

  it.each([
    ["an opt-out with no reason", "<!-- wire-example: none -->"],
    ["an opt-out with a hyphen for the dash", "<!-- wire-example: none - illustrative -->"],
    ["an empty marker", "<!-- wire-example: -->"],
    ["two ids", "<!-- wire-example: judge-verdict refutation-verdict -->"],
    ["an id that is not kebab-case", "<!-- wire-example: Judge_Verdict -->"],
  ])("keeps %s as a malformed marker", (_label, line) => {
    expect(parseWireMarker(line)?.kind).toBe("malformed");
  });

  it("resolves a registered id and nothing else", () => {
    fc.assert(fc.property(fc.string(), (raw) => {
      expect(parseWireShapeId(raw)).toBe(WIRE_SHAPE_IDS.find((id) => id === raw) ?? null);
    }));
  });
});

describe("scanning a doc", () => {
  it("yields a marked JSON fence as exactly its example, wherever prose surrounds it", () => {
    fc.assert(fc.property(shapeIds, jsonValues, fc.array(proseLines), fc.array(proseLines), (shapeId, json, before, after) => {
      const source = [...before, "", renderShapeMarker(shapeId), fenced("json", json), "", ...after].join("\n");
      const scan = scanDoc("doc.md", source);
      expect(markerDefects(scan, "doc.md", WIRE_SHAPE_IDS)).toEqual([]);
      const found = scan.fences.flatMap(examplesOf);
      expect(found.map((example) => example.shapeId)).toEqual([shapeId]);
      expect(parseDocJson(found[0].text)).toEqual(JSON.parse(json));
    }));
  });

  it("reports an unmarked JSON fence and an unmarked JSON heredoc, and yields no example for either", () => {
    fc.assert(fc.property(jsonObjects, fc.array(proseLines, { minLength: 1 }), (json, before) => {
      const heredoc = fenced("bash", `loom helper x <<'JSON'\n${json}\nJSON`);
      for (const block of [fenced("json", json), heredoc]) {
        const scan = scanDoc("doc.md", [...before, "", block].join("\n"));
        expect(markerDefects(scan, "doc.md", WIRE_SHAPE_IDS)).toHaveLength(1);
        expect(scan.fences.flatMap(examplesOf)).toEqual([]);
      }
    }));
  });

  it("asks no marker of a fence that shows no JSON", () => {
    fc.assert(fc.property(fc.constantFrom("", "text", "bash", "typescript"), fc.array(proseLines, { minLength: 1 }), (language, body) => {
      const scan = scanDoc("doc.md", fenced(language, body.join("\n")));
      expect(markerDefects(scan, "doc.md", WIRE_SHAPE_IDS)).toEqual([]);
    }));
  });

  it("accepts an opt-out and yields no example for it", () => {
    fc.assert(fc.property(reasons, jsonValues, (reason, json) => {
      const scan = scanDoc("doc.md", [renderOptOutMarker(reason), fenced("json", json)].join("\n"));
      expect(markerDefects(scan, "doc.md", WIRE_SHAPE_IDS)).toEqual([]);
      expect(scan.fences.flatMap(examplesOf)).toEqual([]);
    }));
  });

  it("reports a marker that prose separates from its fence", () => {
    fc.assert(fc.property(shapeIds, proseLines, jsonObjects, (shapeId, prose, json) => {
      const scan = scanDoc("doc.md", [renderShapeMarker(shapeId), prose, fenced("json", json)].join("\n"));
      expect(scan.danglingMarkerLines).toEqual([1]);
      expect(scan.fences.flatMap(examplesOf)).toEqual([]);
    }));
  });

  it("reports a marker naming a shape the registry does not hold", () => {
    const scan = scanDoc("doc.md", [renderShapeMarker("no-such-shape"), fenced("json", "{}")].join("\n"));
    expect(markerDefects(scan, "doc.md", WIRE_SHAPE_IDS)).toEqual(["doc.md:2 wire-example marker names an unregistered shape: no-such-shape"]);
  });

  it("reads a marked fence inside a list item, indentation and all", () => {
    const source = ["- an item:", "", `  ${renderShapeMarker("wave-gate-start")}`, "  ```json", '  {"wave":null}', "  ```"].join("\n");
    const found = scanDoc("doc.md", source).fences.flatMap(examplesOf);
    expect(found.map((example) => parseDocJson(example.text))).toEqual([{ wave: null }]);
  });

  it("takes a marked non-JSON fence's body as a text example", () => {
    const source = [renderShapeMarker("implementation-brief-request"), fenced("text", "LOOM_IMPLEMENTATION_BRIEF: T5")].join("\n");
    expect(scanDoc("doc.md", source).fences.flatMap(examplesOf).map((example) => example.text)).toEqual(["LOOM_IMPLEMENTATION_BRIEF: T5"]);
  });
});

describe("heredocs", () => {
  it("returns each heredoc body of a shell block, in order", () => {
    fc.assert(fc.property(fc.array(jsonObjects, { minLength: 1, maxLength: 3 }), fc.boolean(), (bodies, quoted) => {
      const tag = quoted ? "'JSON'" : "JSON";
      const shell = bodies.map((body) => `loom helper x --flag <<${tag}\n${body}\nJSON\necho done`).join("\n");
      expect(heredocBodies(shell)).toEqual(bodies);
    }));
  });

  it("counts only the JSON heredocs of a shell fence as wire candidates", () => {
    const shell = ["cat <<'NOTE'", "plain words", "NOTE", "loom helper x <<'JSON'", '{"wave":null}', "JSON"].join("\n");
    const [fence] = scanDoc("doc.md", fenced("bash", shell)).fences;
    expect(jsonTextsOf(fence)).toEqual(['{"wave":null}']);
  });
});

describe("reading an example as data", () => {
  it("parses strict JSON as JSON.parse does", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      const text = JSON.stringify(value, null, 2);
      expect(parseDocJson(text)).toEqual(JSON.parse(text));
    }));
  });

  it("repairs a block comment, an elided list and a dangling comma, and nothing else", () => {
    expect(parseDocJson('{ "checks": [ … ], "findings": [ /* one per "fingerprint" */ ], "wave": 1, }')).toEqual({ checks: [], findings: [], wave: 1 });
    expect(() => parseDocJson('[{"anchor":"FR-003"},...]')).toThrow();
  });

  it("leaves a string that looks like a repair exactly as written", () => {
    const strings = { ",]": "", "a": "/* kept */", "b": "[ … ]", "c": "x, }", "d": "\\\", ]" };
    expect(parseDocJson(JSON.stringify(strings, null, 2))).toEqual(strings);
  });
});

describe("placeholder resolution", () => {
  const plain = fc.jsonValue().filter((value) => !/[<|]/.test(JSON.stringify(value)));

  it("keeps a document with no placeholder exactly as written", () => {
    fc.assert(fc.property(plain, (value) => {
      expect(resolvePlaceholders(value, {})).toEqual(value);
    }));
  });

  it("is idempotent once every placeholder resolves to a plain value", () => {
    fc.assert(fc.property(plain, plain, (value, resolution) => {
      const document = { field: "<replace me>", kept: value, list: ["<replace me too>"] };
      const once = resolvePlaceholders(document, { field: resolution, list: resolution });
      expect(resolvePlaceholders(once, {})).toEqual(once);
      expect(once).toEqual({ field: resolution, kept: value, list: [resolution] });
    }));
  });

  it("resolves a choice to its first option and a null-allowing hint to null", () => {
    expect(resolvePlaceholders({ status: "covered | candidate | blocked", artifact: "<a path, or null>" }, {}))
      .toEqual({ status: "covered", artifact: null });
  });

  it("gives each entry of a placeholder list its own value from a sequence", () => {
    expect(resolvePlaceholders({ lenses: ["<lens 1>", "<lens N>"] }, { lenses: sequence("a", "b") })).toEqual({ lenses: ["a", "b"] });
    expect(() => resolvePlaceholders({ lenses: ["<1>", "<2>", "<3>"] }, { lenses: sequence("a", "b") })).toThrow(/no entry 2/);
  });

  it("refuses a placeholder whose key has no resolution", () => {
    expect(() => resolvePlaceholders({ criterion: "<your lens>" }, {})).toThrow(/"criterion"/);
  });
});
