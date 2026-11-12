/**
 * no-wire-cast answers a file whose text holds neither `JSON` nor `json`
 * before it lexes it (ADR-0072). This is pinned by watching the lexer, not by
 * a timing ratio whose fast side is under a millisecond and so is decided by
 * timer noise. The rule imports `lexicalSpans` directly, so a module mock
 * stands in for it and delegates every call to the real lexer. It lives in its
 * own file so that no other suite, and none of the rule's cost measurements,
 * runs through the spy.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler as noWireCast } from "../../../src/linter/programmatic/no-wire-cast";
import { lexicalSpans } from "../../../src/linter/source-segments";

vi.mock("../../../src/linter/source-segments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/linter/source-segments")>();
  return { ...actual, lexicalSpans: vi.fn(actual.lexicalSpans) };
});

const FILE = "src/orders/load-order.ts";
const PLAIN = Array.from({ length: 200 }, (_, index) => `export const value${index} = { id: ${index} };`).join("\n");

describe("no-wire-cast early exit", () => {
  beforeEach(() => {
    vi.mocked(lexicalSpans).mockClear();
  });

  it("answers a file whose text holds neither `JSON` nor `json` without lexing it", () => {
    expect(noWireCast(PLAIN, FILE)).toEqual([]);
    expect(lexicalSpans).not.toHaveBeenCalled();
  });

  // The early exit tests for the substring, not the call: neither file names a wire call, yet each is lexed.
  it.each([
    ["json", `${PLAIN}\n// read from ./package.json`],
    ["JSON", `${PLAIN}\nexport const text = value0.toJSON();`],
  ])("lexes the same file once its text holds `%s`, though it names no wire call", (_needle, source) => {
    expect(noWireCast(source, FILE)).toEqual([]);
    expect(lexicalSpans).toHaveBeenCalledTimes(1);
    expect(lexicalSpans).toHaveBeenCalledWith(source);
  });
});
