import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { extractTaskId, isCanonicalFormat } from "../../src/utils/extract-task-id";

describe("extractTaskId — property tests", () => {
  it("all 7 patterns extract the same ID for any valid T\\d+ ID", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9999 }).map((n) => `T${n}`),
        (taskId) => {
          const formats = [
            `**Task ID:** ${taskId}`,
            `Task ID: ${taskId}`,
            `Task: ${taskId}`,
            `${taskId}: do something`,
            `implement ${taskId}`,
            `${taskId} Refactor the thing`,
            `some text ${taskId} more text`,
          ];
          for (const fmt of formats) {
            expect(extractTaskId(fmt)).toBe(taskId);
          }
        },
      ),
    );
  });

  it("canonical format is always recognized by isCanonicalFormat", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99999 }),
        (n) => {
          const text = `**Task ID:** T${n}`;
          expect(isCanonicalFormat(text)).toBe(true);
          expect(extractTaskId(text)).toBe(`T${n}`);
        },
      ),
    );
  });

  it("random strings without T\\d+ never produce a match", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/T\d+/.test(s)),
        (s) => {
          expect(extractTaskId(s)).toBeNull();
        },
      ),
    );
  });
});

describe("extractTaskId — edge cases", () => {
  it("returns null for empty string", () => {
    expect(extractTaskId("")).toBeNull();
  });

  it("returns null for whitespace only", () => {
    expect(extractTaskId("   \n\t  ")).toBeNull();
  });

  it("returns null for no T-prefix numbers", () => {
    expect(extractTaskId("Task 42 is important")).toBeNull();
    expect(extractTaskId("implement feature")).toBeNull();
  });

  it("returns first match when multiple task IDs present", () => {
    expect(extractTaskId("**Task ID:** T1 also T2 and T3")).toBe("T1");
    expect(extractTaskId("Fix T5 and T3")).toBe("T5");
  });

  it("handles T0 as valid (regex allows any digit)", () => {
    expect(extractTaskId("T0 something")).toBe("T0");
  });

  it("handles T00, T000 as valid", () => {
    expect(extractTaskId("T00: fix it")).toBe("T00");
    expect(extractTaskId("Task: T000")).toBe("T000");
  });

  it("handles very large IDs like T999999", () => {
    expect(extractTaskId("implement T999999")).toBe("T999999");
  });

  it("returns null for shell variable ${TASK_ID}", () => {
    // ${TASK_ID} doesn't contain literal T\d+
    expect(extractTaskId("run ${TASK_ID} now")).toBeNull();
  });

  it("extracts T1 even when inside a sentence with URL", () => {
    // Standalone T\d+ pattern should match
    const result = extractTaskId("See https://example.com/path?q=T1 for details");
    // T1 appears in URL — the \b boundary may still match
    expect(result).toBe("T1");
  });

  it("extracts task ID from verb patterns (case insensitive)", () => {
    const verbs = ["implement", "fix", "complete", "execute", "run", "start", "do", "work on", "working on"];
    for (const verb of verbs) {
      expect(extractTaskId(`${verb} T42`)).toBe("T42");
      expect(extractTaskId(`${verb.toUpperCase()} T42`)).toBe("T42");
    }
  });

  it("standalone pattern matches T-ID at word boundary", () => {
    expect(extractTaskId("XT1")).toBeNull(); // no word boundary before T
    expect(extractTaskId("T1X")).toBeNull(); // no word boundary after 1
  });
});
