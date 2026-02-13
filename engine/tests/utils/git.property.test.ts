import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { countNewTests, countAssertions } from "../../src/utils/git";

describe("countNewTests — property tests", () => {
  it("adding more +@Test lines never decreases count", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 30 }),
        (base, extra) => {
          const baseDiff = Array.from({ length: base }, () => "+    @Test").join("\n");
          const moreDiff = Array.from({ length: base + extra }, () => "+    @Test").join("\n");
          expect(countNewTests(moreDiff).total).toBeGreaterThanOrEqual(countNewTests(baseDiff).total);
        },
      ),
    );
  });

  it("removed lines are never counted", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (n) => {
        const diff = Array.from({ length: n }, () => "-    @Test").join("\n");
        expect(countNewTests(diff).total).toBe(0);
      }),
    );
  });

  it("context lines (no +/-) are never counted", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (n) => {
        const diff = Array.from({ length: n }, () => "     @Test").join("\n");
        expect(countNewTests(diff).total).toBe(0);
      }),
    );
  });

  it("mixed +/- lines: only + lines count", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 0, max: 20 }),
        (addCount, removeCount) => {
          const added = Array.from({ length: addCount }, () => "+    @Test").join("\n");
          const removed = Array.from({ length: removeCount }, () => "-    @Test").join("\n");
          const diff = `${added}\n${removed}`;
          expect(countNewTests(diff).java).toBe(addCount);
        },
      ),
    );
  });

  it("TypeScript test patterns counted correctly", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (n) => {
        const diff = Array.from({ length: n }, () => '+  it("works", () => {').join("\n");
        expect(countNewTests(diff).ts).toBe(n);
      }),
    );
  });

  it("Python test patterns counted correctly", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (n) => {
        const diff = Array.from({ length: n }, () => "+def test_something():").join("\n");
        expect(countNewTests(diff).python).toBe(n);
      }),
    );
  });
});

describe("countAssertions — property tests", () => {
  it("adding more assertions never decreases count", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 30 }),
        (base, extra) => {
          const baseDiff = Array.from({ length: base }, () => "+    assertThat(x).isTrue();").join("\n");
          const moreDiff = Array.from({ length: base + extra }, () => "+    assertThat(x).isTrue();").join("\n");
          expect(countAssertions(moreDiff)).toBeGreaterThanOrEqual(countAssertions(baseDiff));
        },
      ),
    );
  });

  it("removed assertions never counted", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (n) => {
        const diff = Array.from({ length: n }, () => "-    assertThat(x).isTrue();").join("\n");
        expect(countAssertions(diff)).toBe(0);
      }),
    );
  });

  it("max 1 assertion per line", () => {
    // Even if a line contains multiple assertion keywords, it should count at most 1
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (n) => {
        const diff = Array.from(
          { length: n },
          () => "+    assertThat(expect(x).toBe(42)).isTrue();",
        ).join("\n");
        // Each line has both assertThat AND expect, but should count max 1 per line
        expect(countAssertions(diff)).toBe(n);
      }),
    );
  });
});
