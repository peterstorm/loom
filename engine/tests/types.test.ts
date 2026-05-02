import { describe, it, expect } from "vitest";
import { nonEmptyMessage, errorResult, blockResult, allowResult, passthroughResult } from "../src/types";

describe("nonEmptyMessage (boundary defense)", () => {
  it("preserves non-empty input", () => {
    expect(nonEmptyMessage("validation failed")).toBe("validation failed");
  });

  it("rewrites empty string to sentinel", () => {
    expect(nonEmptyMessage("")).toBe("<no message provided>");
  });

  it("rewrites whitespace-only string to sentinel", () => {
    expect(nonEmptyMessage("   \n\t")).toBe("<no message provided>");
  });

  it("rewrites null/undefined to sentinel", () => {
    expect(nonEmptyMessage(null)).toBe("<no message provided>");
    expect(nonEmptyMessage(undefined)).toBe("<no message provided>");
  });
});

describe("HookResult smart constructors", () => {
  it("errorResult sanitizes empty messages", () => {
    const r = errorResult("");
    expect(r).toEqual({ kind: "error", message: "<no message provided>" });
  });

  it("blockResult sanitizes empty messages", () => {
    const r = blockResult("   ");
    expect(r).toEqual({ kind: "block", message: "<no message provided>" });
  });

  it("errorResult preserves real messages", () => {
    const r = errorResult("oops");
    expect(r).toEqual({ kind: "error", message: "oops" });
  });

  it("allowResult and passthroughResult have no payload", () => {
    expect(allowResult()).toEqual({ kind: "allow" });
    expect(passthroughResult()).toEqual({ kind: "passthrough" });
  });
});
