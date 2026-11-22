import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { NO_DIAGNOSTIC, parseErr, parseOk, toParseResult, type ForeignParseResult } from "../../src/core/parse-result";

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
      fc.pre(joined !== "");
      expect(toParseResult({ ok: false, errors }, label)).toEqual(parseErr(`${label}: ${joined}`));
      expect(toParseResult({ ok: false, error: { errors } }, label)).toEqual(parseErr(`${label}: ${joined}`));
      expect(toParseResult({ ok: false, error: { message: joined } }, label)).toEqual(parseErr(`${label}: ${joined}`));
    }));
  });

  it.each<[string, ForeignParseResult<never>]>([
    ["an empty errors list", { ok: false, errors: [] }],
    ["an empty error record list", { ok: false, error: { errors: [] } }],
    ["an empty message", { ok: false, error: { message: "" } }],
    ["a list of empty diagnostics", { ok: false, errors: [""] }],
  ])("never returns an empty diagnostic: %s says NO_DIAGNOSTIC", (_label, failure) => {
    expect(toParseResult(failure)).toEqual(parseErr(NO_DIAGNOSTIC));
    expect(toParseResult(failure, "field")).toEqual(parseErr(`field: ${NO_DIAGNOSTIC}`));
  });

  it("every failure carries a non-empty error, whatever the foreign diagnostics", () => {
    const foreign = fc.oneof(
      fc.array(fc.string()).map((errors): ForeignParseResult<never> => ({ ok: false, errors })),
      fc.array(fc.string()).map((errors): ForeignParseResult<never> => ({ ok: false, error: { errors } })),
      fc.string().map((message): ForeignParseResult<never> => ({ ok: false, error: { message } })),
    );
    fc.assert(fc.property(foreign, fc.option(fc.string(), { nil: undefined }), (failure, label) => {
      const result = toParseResult(failure, label);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).not.toBe("");
    }));
  });
});
