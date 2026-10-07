/**
 * The CLI value-is-a-flag rule has one spelling (core/cli-flag-token), and
 * every grammar that applies it agrees on it: the helper shell's flag reader
 * and both Context Packet reader grammars treat exactly the `--`-prefixed
 * tokens as flags, never as values.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isFlagToken } from "../../src/core/cli-flag-token";
import { argumentValue } from "../../src/handlers/helpers/cli-args";
import { parseContextProjectionArguments, parseContextSectionArguments } from "../../src/core/context-packet-projection";

/** Tokens that exercise both sides of the rule: free strings, and flag-shaped ones. */
const tokens = fc.oneof(fc.string({ minLength: 1 }), fc.string().map((tail) => `--${tail}`), fc.constantFrom("-", "-x", "--", "---"));

describe("the CLI value-is-a-flag rule", () => {
  it.each([["--json", true], ["--", true], ["---x", true], ["-x", false], ["value", false], ["", false], ["a--b", false]] as const)(
    "classifies %j as a flag: %s", (token, flag) => {
      expect(isFlagToken(token)).toBe(flag);
    });

  it("is the one rule the helper flag reader and both packet reader grammars apply", () => {
    fc.assert(fc.property(tokens, (token) => {
      const flag = isFlagToken(token);
      expect(argumentValue(["--run", token], "--run")).toBe(flag ? null : token);
      const section = parseContextSectionArguments(["--packet", "/abs/packet.json", "--digest", "d", "--section", token]);
      expect(section.ok).toBe(!flag);
      const projection = parseContextProjectionArguments(["--packet", "/abs/packet.json", "--request", "r", "--digest", "d",
        "--role", "role", "--skill", "skill", "--section", token]);
      expect(projection.ok ? "accepted" : projection.error).toBe(flag
        ? `reader argument --section requires a value; ${token} looks like another flag`
        : "accepted");
    }));
  });
});
