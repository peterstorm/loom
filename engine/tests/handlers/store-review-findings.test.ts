import { describe, it, expect } from "vitest";
import { parseFindings, updateTaskFindings } from "../../src/handlers/helpers/store-review-findings";
import type { Task } from "../../src/types";

const baseTask: Task = {
  id: "T1",
  description: "Test task",
  agent: "test",
  wave: 1,
  status: "implemented",
  depends_on: [],
};

describe("parseFindings (pure)", () => {
  it("parses critical and advisory lines", () => {
    const stdin = "CRITICAL: SQL injection\nADVISORY: Consider refactor";
    const result = parseFindings(stdin);

    expect(result.critical).toEqual(["SQL injection"]);
    expect(result.advisory).toEqual(["Consider refactor"]);
  });

  it("handles multiple findings of each type", () => {
    const stdin = "CRITICAL: Issue 1\nCRITICAL: Issue 2\nADVISORY: Advice 1\nADVISORY: Advice 2";
    const result = parseFindings(stdin);

    expect(result.critical).toEqual(["Issue 1", "Issue 2"]);
    expect(result.advisory).toEqual(["Advice 1", "Advice 2"]);
  });

  it("returns empty arrays when no findings", () => {
    const result = parseFindings("");
    expect(result.critical).toEqual([]);
    expect(result.advisory).toEqual([]);
  });

  it("ignores non-matching lines", () => {
    const stdin = "Some text\nCRITICAL: Issue 1\nMore text\nADVISORY: Advice 1\nExtra";
    const result = parseFindings(stdin);

    expect(result.critical).toEqual(["Issue 1"]);
    expect(result.advisory).toEqual(["Advice 1"]);
  });
});

describe("updateTaskFindings (pure)", () => {
  it("stores critical and advisory when both provided", () => {
    const updated = updateTaskFindings(baseTask, ["SQL injection"], ["Consider refactor"]);

    expect(updated.critical_findings).toEqual(["SQL injection"]);
    expect(updated.advisory_findings).toEqual(["Consider refactor"]);
    expect(updated.review_status).toBe("blocked");
  });

  it("preserves existing advisories when none provided", () => {
    const taskWithAdvisories: Task = {
      ...baseTask,
      advisory_findings: ["Existing advisory 1", "Existing advisory 2"],
      critical_findings: ["Old critical"],
    };

    const updated = updateTaskFindings(taskWithAdvisories, ["New critical"], []);

    expect(updated.critical_findings).toEqual(["New critical"]);
    expect(updated.advisory_findings).toEqual(["Existing advisory 1", "Existing advisory 2"]);
    expect(updated.review_status).toBe("blocked");
  });

  it("clears criticals and sets status to passed when no criticals", () => {
    const taskWithFindings: Task = {
      ...baseTask,
      critical_findings: ["Old critical"],
      advisory_findings: ["Old advisory"],
      review_status: "blocked",
    };

    const updated = updateTaskFindings(taskWithFindings, [], []);

    expect(updated.critical_findings).toEqual([]);
    expect(updated.advisory_findings).toEqual(["Old advisory"]);
    expect(updated.review_status).toBe("passed");
  });

  it("overwrites advisories when new ones provided", () => {
    const taskWithAdvisories: Task = {
      ...baseTask,
      advisory_findings: ["Old advisory"],
    };

    const updated = updateTaskFindings(taskWithAdvisories, [], ["New advisory 1", "New advisory 2"]);

    expect(updated.advisory_findings).toEqual(["New advisory 1", "New advisory 2"]);
    expect(updated.review_status).toBe("passed");
  });

  it("sets blocked status when criticals present", () => {
    const updated = updateTaskFindings(baseTask, ["Critical issue"], ["Advisory"]);
    expect(updated.review_status).toBe("blocked");
  });

  it("sets passed status when no criticals", () => {
    const updated = updateTaskFindings(baseTask, [], ["Advisory"]);
    expect(updated.review_status).toBe("passed");
  });
});
