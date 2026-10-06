import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { canonicalizeEmissionWireArguments } from "../../src/core/emission-tool";

/**
 * The wire-form canonicalization parses only JSON encodings: a number or
 * integer position accepts the JSON number grammar (never JavaScript's looser
 * `Number()` forms), and a string-admitting position keeps a legitimate string
 * verbatim instead of coercing it toward a sibling non-string type.
 */
describe("canonicalizeEmissionWireArguments parses JSON encodings only", () => {
  const numeric = {
    type: "object",
    properties: { count: { type: "integer" }, ratio: { type: "number" } },
  } as const;

  it.each(["0x10", "+5", ".5", "5.", "0b11", "0o7", "Infinity", "1_000", "1e999"])(
    "leaves the non-JSON number form %j verbatim at number and integer positions",
    (raw) => {
      expect(canonicalizeEmissionWireArguments(numeric, { count: raw, ratio: raw })).toEqual({ count: raw, ratio: raw });
    },
  );

  it.each([
    ["5", 5, 5],
    ["-0.25", "-0.25", -0.25],
    ["1e2", 100, 100],
    [" 7 ", 7, 7],
  ] as const)("parses the JSON number %j", (raw, count, ratio) => {
    expect(canonicalizeEmissionWireArguments(numeric, { count: raw, ratio: raw })).toEqual({ count, ratio });
  });

  it("parses a declared number exactly when the string is a finite JSON number (property)", () => {
    fc.assert(fc.property(fc.string(), (raw) => {
      const { ratio } = canonicalizeEmissionWireArguments(numeric, { ratio: raw }) as { ratio: unknown };
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        json = undefined;
      }
      const isJsonNumber = typeof json === "number" && Number.isFinite(json);
      expect(ratio).toBe(isJsonNumber ? json : raw);
    }));
  });

  it("keeps a literal \"null\" string at an anyOf [string, null] field", () => {
    const schema = {
      type: "object",
      properties: {
        file: { anyOf: [{ type: "string" }, { type: "null" }] },
        label: { type: ["string", "integer"] },
        line: { anyOf: [{ type: "integer" }, { type: "null" }] },
      },
    } as const;
    expect(canonicalizeEmissionWireArguments(schema, { file: "null", label: "3", line: "null" })).toEqual({
      file: "null",
      label: "3",
      line: null,
    });
  });
});
