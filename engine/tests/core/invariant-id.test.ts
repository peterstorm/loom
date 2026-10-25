/**
 * `parseInvariantId` is the only minting point of the branded `InvariantId`,
 * so its anchored grammar (`^INV-\d+$`) is pinned here directly rather than
 * only through the plan grammar and the wire parsers that call it.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { INVARIANT_ID_PATTERN, parseInvariantId } from "../../src/core/invariant-id";

describe("parseInvariantId", () => {
  it.each(["INV-0", "INV-1", "INV-12", "INV-007", "INV-9007199254740993"])("accepts %j as itself", (raw) => {
    expect(parseInvariantId(raw)).toEqual({ ok: true, value: raw });
  });

  it.each([
    ["", "empty"],
    ["INV-", "no number"],
    ["INV-1\n", "trailing newline"],
    [" INV-1", "leading space"],
    ["INV-1 ", "trailing space"],
    ["inv-1", "lower case"],
    ["Inv-1", "mixed case"],
    ["INV-1a", "trailing letter"],
    ["INV-a1", "letter before the number"],
    ["INV1", "no dash"],
    ["INV--1", "negative"],
    ["INV-1.5", "fraction"],
    ["xINV-1", "leading text"],
    ["INV-1\nINV-2", "two ids on two lines"],
    ["INV-١", "non-ASCII digit"],
    ["LC-1", "another model's id"],
  ])("refuses %j (%s), naming the raw value", (raw) => {
    expect(parseInvariantId(raw)).toEqual({ ok: false, error: { kind: "not-an-invariant-id", raw } });
  });

  it("property — accepts exactly `INV-` followed by one or more ASCII digits", () => {
    fc.assert(fc.property(fc.string({ maxLength: 12 }), (raw) => {
      expect(parseInvariantId(raw).ok).toBe(/^INV-[0-9]+$/.test(raw));
    }));
    fc.assert(fc.property(fc.nat(), (n) => {
      expect(parseInvariantId(`INV-${n}`)).toEqual({ ok: true, value: `INV-${n}` });
    }));
  });

  it("the exported pattern is anchored and carries no flags that loosen it", () => {
    expect(INVARIANT_ID_PATTERN.source.startsWith("^")).toBe(true);
    expect(INVARIANT_ID_PATTERN.source.endsWith("$")).toBe(true);
    expect(INVARIANT_ID_PATTERN.flags).toBe("");
  });
});
