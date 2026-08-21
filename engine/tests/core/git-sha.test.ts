import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { isExactGitSha } from "../../src/core/git-sha";

/**
 * The exact-object-id grammar is the trust boundary for every revision a task
 * graph, context packet, or remediation index names: a malformed sha is an
 * unrepresentable state, not a fallback to looser matching. The SHA-256
 * branch (40 + 24 hex) had no pins at all — only the SHA-1 shape was ever
 * exercised.
 */
describe("isExactGitSha (pure)", () => {
  const hex40 = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0"; // 40
  const hex24 = "0123456789abcdef01234567"; // 24
  const hex64 = `${hex40}${hex24}`; // 64

  it("accepts a 40-char lowercase hex SHA-1 id", () => {
    expect(isExactGitSha(hex40)).toBe(true);
  });

  it("accepts a 64-char lowercase hex SHA-256 id", () => {
    expect(isExactGitSha(hex64)).toBe(true);
  });

  it("rejects lengths between and around the two valid shapes", () => {
    for (const length of [0, 39, 41, 63, 65, 128]) {
      const raw = "a".repeat(length);
      expect(isExactGitSha(raw), `length ${length}`).toBe(false);
    }
  });

  it("rejects non-hex and uppercase characters at any length", () => {
    expect(isExactGitSha("g".repeat(40))).toBe(false);
    expect(isExactGitSha(hex40.toUpperCase())).toBe(false);
    expect(isExactGitSha(`${hex40}g`.padEnd(64, "a"))).toBe(false);
  });

  it("rejects non-string input without throwing", () => {
    expect(isExactGitSha(undefined)).toBe(false);
    expect(isExactGitSha(null)).toBe(false);
    expect(isExactGitSha(0xabcd)).toBe(false);
    expect(isExactGitSha({})).toBe(false);
  });

  it("property: exactly the two valid lengths over the hex alphabet are accepted", () => {
    const hexChar = fc.constantFrom(..."0123456789abcdef".split(""));
    fc.assert(
      fc.property(
        fc.tuple(fc.integer({ min: 38, max: 66 }), fc.array(hexChar, { minLength: 1, maxLength: 66 })),
        ([length, chars]) => {
          const raw = (chars.join("") + "a".repeat(66)).slice(0, length);
          return isExactGitSha(raw) === (length === 40 || length === 64);
        },
      ),
    );
  });
});
