import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseErr, parseOk, toParseResult } from "../../src/core/parse-result";

describe("toParseResult", () => {
  it("keeps a success's value", () => {
    const value = { id: "T1" };
    expect(toParseResult({ ok: true, value })).toEqual(parseOk(value));
    expect(toParseResult({ ok: true, value }, "field")).toEqual(parseOk(value));
  });

  it("joins a diagnostics list with \"; \", in order", () => {
    expect(toParseResult({ ok: false, errors: ["a missing", "b empty"] })).toEqual(parseErr("a missing; b empty"));
    expect(toParseResult({ ok: false, error: { errors: ["a missing", "b empty"] } })).toEqual(parseErr("a missing; b empty"));
  });

  it("renders a domain error by its message", () => {
    expect(toParseResult({ ok: false, error: { message: "runId must be a UUID" } })).toEqual(parseErr("runId must be a UUID"));
  });

  it("prefixes the field label, for every failure shape", () => {
    fc.assert(fc.property(fc.string(), fc.array(fc.string(), { minLength: 1 }), (label, errors) => {
      const joined = errors.join("; ");
      expect(toParseResult({ ok: false, errors }, label)).toEqual(parseErr(`${label}: ${joined}`));
      expect(toParseResult({ ok: false, error: { errors } }, label)).toEqual(parseErr(`${label}: ${joined}`));
      expect(toParseResult({ ok: false, error: { message: joined } }, label)).toEqual(parseErr(`${label}: ${joined}`));
    }));
  });
});
