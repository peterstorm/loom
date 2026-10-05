import { posix } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pathExtension } from "../../src/core/scope-classification";

describe("pathExtension", () => {
  it("equals POSIX path.extname for every path over the separator/dot alphabet", () => {
    const path = fc.array(fc.constantFrom("a", "b", ".", "/", "d.ts", "README"), { maxLength: 12 })
      .map((parts) => parts.join(""));
    fc.assert(fc.property(path, (candidate) => {
      expect(pathExtension(candidate)).toBe(posix.extname(candidate));
    }), { numRuns: 2000 });
  });

  it("matches the review-scope cases the classifier depends on", () => {
    for (const candidate of ["src/a.ts", "types/x.d.ts", ".gitignore", "docs/", "a/..", "Makefile", "a.", "dir.v2/file"]) {
      expect(pathExtension(candidate)).toBe(posix.extname(candidate));
    }
  });
});
