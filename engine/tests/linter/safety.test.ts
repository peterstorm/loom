import { describe, it, expect } from "vitest";
import { analyzeRegex, assertDurationWithin, createDeadlineChecker } from "../../src/linter/safety";

describe("analyzeRegex", () => {
  describe("safe patterns", () => {
    it("accepts a simple literal pattern", () => {
      const result = analyzeRegex("console\\.log\\(");
      expect(result.safe).toBe(true);
      if (result.safe) {
        expect(result.regex).toBeInstanceOf(RegExp);
        expect(result.regex.source).toBe("console\\.log\\(");
      }
    });

    it("accepts character class patterns", () => {
      const result = analyzeRegex("[a-z]+");
      expect(result.safe).toBe(true);
    });

    it("accepts anchored patterns", () => {
      const result = analyzeRegex("^\\s*import\\s");
      expect(result.safe).toBe(true);
    });

    it("accepts non-greedy quantifiers in safe context", () => {
      const result = analyzeRegex("\\w+?\\s");
      expect(result.safe).toBe(true);
    });

    it("accepts simple alternation without quantifier on group", () => {
      const result = analyzeRegex("(foo|bar)");
      expect(result.safe).toBe(true);
    });

    it("accepts bounded repetition without nesting", () => {
      const result = analyzeRegex("\\d{1,5}");
      expect(result.safe).toBe(true);
    });

    it("passes flags through to compiled regex", () => {
      const result = analyzeRegex("hello", "gi");
      expect(result.safe).toBe(true);
      if (result.safe) {
        expect(result.regex.flags).toContain("g");
        expect(result.regex.flags).toContain("i");
      }
    });

    it("accepts typical lint rule patterns", () => {
      // no-any
      expect(analyzeRegex(":\\s*any\\b").safe).toBe(true);
      // no-console
      expect(analyzeRegex("console\\.(log|warn|error)\\(").safe).toBe(true);
      // no-todo
      expect(analyzeRegex("(TODO|FIXME)\\b").safe).toBe(true);
      // no-debugger
      expect(analyzeRegex("^\\s*debugger;?\\s*$").safe).toBe(true);
    });
  });

  describe("unsafe patterns — nested quantifiers", () => {
    it("rejects (a+)+", () => {
      const result = analyzeRegex("(a+)+");
      expect(result.safe).toBe(false);
      if (!result.safe) {
        expect(result.reason).toContain("quantifier");
      }
    });

    it("rejects (a*)*", () => {
      const result = analyzeRegex("(a*)*");
      expect(result.safe).toBe(false);
    });

    it("rejects (a+)*", () => {
      const result = analyzeRegex("(a+)*");
      expect(result.safe).toBe(false);
    });

    it("rejects (\\w+)+", () => {
      const result = analyzeRegex("(\\w+)+");
      expect(result.safe).toBe(false);
    });

    it("rejects (x+y*)+", () => {
      const result = analyzeRegex("(x+y*)+");
      expect(result.safe).toBe(false);
    });

    it("rejects (a{2,}){3,}", () => {
      const result = analyzeRegex("(a{2,}){3,}");
      expect(result.safe).toBe(false);
    });
  });

  describe("unsafe patterns — overlapping alternations", () => {
    it("rejects (a|a)+", () => {
      const result = analyzeRegex("(a|a)+");
      expect(result.safe).toBe(false);
      if (!result.safe) {
        expect(result.reason.toLowerCase()).toMatch(/overlap/);
      }
    });

    it("rejects (.|a)+", () => {
      const result = analyzeRegex("(.|a)+");
      expect(result.safe).toBe(false);
    });

    it("rejects (\\w|\\d)+", () => {
      // \w includes \d, so they overlap
      const result = analyzeRegex("(\\w|\\d)+");
      expect(result.safe).toBe(false);
    });
  });

  describe("unsafe patterns — catastrophic dot-star", () => {
    it("rejects (.*a)+", () => {
      const result = analyzeRegex("(.*a)+");
      expect(result.safe).toBe(false);
      if (!result.safe) {
        // May be caught by nested quantifiers or dot-star detection — both are valid
        expect(result.reason.toLowerCase()).toMatch(/quantifier|unbounded|backtracking/);
      }
    });

    it("rejects (.+)+", () => {
      const result = analyzeRegex("(.+)+");
      expect(result.safe).toBe(false);
    });

    it("rejects (.*){2}", () => {
      const result = analyzeRegex("(.*){2}");
      expect(result.safe).toBe(false);
    });
  });

  describe("invalid regex", () => {
    it("rejects invalid regex syntax", () => {
      const result = analyzeRegex("(unclosed");
      expect(result.safe).toBe(false);
      if (!result.safe) {
        expect(result.reason).toContain("Invalid regex");
      }
    });

    it("rejects invalid flags", () => {
      const result = analyzeRegex("valid", "xyz");
      expect(result.safe).toBe(false);
      if (!result.safe) {
        expect(result.reason).toContain("Invalid regex");
      }
    });
  });
});

describe("assertDurationWithin", () => {
  it("returns result of fast function", () => {
    const result = assertDurationWithin(() => 42, 100);
    expect(result).toBe(42);
  });

  it("returns complex result types", () => {
    const result = assertDurationWithin(() => ({ a: 1, b: "hi" }), 100);
    expect(result).toEqual({ a: 1, b: "hi" });
  });

  it("propagates exceptions from the function", () => {
    expect(() =>
      assertDurationWithin(() => {
        throw new Error("inner error");
      }, 100)
    ).toThrow("inner error");
  });

  it("throws on timeout for slow function", () => {
    // Simulate a slow synchronous operation
    const slowFn = () => {
      const start = performance.now();
      while (performance.now() - start < 60) {
        // busy wait
      }
      return "done";
    };
    expect(() => assertDurationWithin(slowFn, 10)).toThrow(/exceeded timeout/);
  });
});

describe("createDeadlineChecker", () => {
  it("does not throw before deadline", () => {
    const check = createDeadlineChecker(1000);
    expect(() => check()).not.toThrow();
  });

  it("throws after deadline passes", () => {
    const check = createDeadlineChecker(1); // 1ms timeout
    // Busy wait to exceed deadline
    const start = performance.now();
    while (performance.now() - start < 5) {
      // wait
    }
    expect(() => check()).toThrow(/exceeded timeout/);
  });

  it("can be called multiple times before deadline", () => {
    const check = createDeadlineChecker(500);
    expect(() => {
      check();
      check();
      check();
    }).not.toThrow();
  });
});
