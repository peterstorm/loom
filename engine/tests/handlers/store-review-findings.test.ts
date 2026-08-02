import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { parseFindings, updateTaskFindings, OVERRIDE_AGENT } from "../../src/handlers/helpers/store-review-findings";
import { claimsOfSeverity } from "../../src/core/findings";
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

describe("the manual override keeps findings and its derived views in lockstep", () => {
  const reviewed: Task = {
    ...baseTask,
    review_status: "blocked",
    findings: [
      { id: "code-reviewer-1", agent: "code-reviewer", severity: "critical", file: null, line: null, claim: "false positive" },
      { id: "code-reviewer-2", agent: "code-reviewer", severity: "advisory", file: null, line: null, claim: "kept nit" },
    ],
    critical_findings: ["false positive"],
    advisory_findings: ["kept nit"],
  };

  it("rewrites the authoritative array, not only the view", () => {
    // The sanctioned false-positive downgrade used to replace
    // critical_findings and leave `findings` untouched. The dismissed critical
    // then went right back in front of the refutation panel, while an ADDED
    // critical existed only in the view and the panel could never adjudicate it.
    const updated = updateTaskFindings(reviewed, [], []);
    expect(updated.critical_findings).toEqual([]);
    expect((updated.findings ?? []).some((f) => f.severity === "critical")).toBe(false);
    expect(updated.review_status).toBe("passed");
  });

  it("gives an added critical structured identity so the panel can see it", () => {
    const updated = updateTaskFindings(reviewed, ["a real one"], []);
    expect(updated.critical_findings).toEqual(["a real one"]);
    expect((updated.findings ?? []).filter((f) => f.severity === "critical").map((f) => f.claim))
      .toEqual(["a real one"]);
    expect(updated.review_status).toBe("blocked");
  });

  it("preserves the advisories it was not asked about, identity intact", () => {
    const updated = updateTaskFindings(reviewed, ["a real one"], []);
    expect(updated.advisory_findings).toEqual(["kept nit"]);
    expect((updated.findings ?? []).find((f) => f.severity === "advisory")?.id).toBe("code-reviewer-2");
  });

  it("migrates a pre-identity task's advisories rather than dropping them", () => {
    const legacy: Task = { ...baseTask, advisory_findings: ["from before identity"] };
    const updated = updateTaskFindings(legacy, ["new critical"], []);
    expect(updated.advisory_findings).toEqual(["from before identity"]);
    expect(new Set((updated.findings ?? []).map((f) => f.id)).size).toBe(2);
  });

  it("never remints an id a refutation record still holds", () => {
    const withRefutation: Task = {
      ...reviewed,
      refuted_findings: [{
        finding: { id: "manual-override-1", agent: OVERRIDE_AGENT, severity: "critical", file: null, line: null, claim: "killed" },
        refutations: [{ lens: "intent", reason: "deliberate" }],
      }],
    };
    const updated = updateTaskFindings(withRefutation, ["a real one"], ["an advisory"]);
    const active = (updated.findings ?? []).map((f) => f.id);
    expect(active).not.toContain("manual-override-1");
    expect(new Set([...active, "manual-override-1"]).size).toBe(active.length + 1);
  });

  it("holds the derived-view invariant for any override", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 4 }),
        fc.array(fc.string({ minLength: 1, maxLength: 8 }), { maxLength: 4 }),
        (critical, advisory) => {
          const updated = updateTaskFindings(reviewed, [...critical], [...advisory]);
          expect(updated.critical_findings).toEqual(claimsOfSeverity(updated.findings ?? [], "critical"));
          expect(updated.advisory_findings).toEqual(claimsOfSeverity(updated.findings ?? [], "advisory"));
          expect(new Set((updated.findings ?? []).map((f) => f.id)).size)
            .toBe((updated.findings ?? []).length);
        },
      ),
    );
  });
});
