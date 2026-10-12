/**
 * Prompt contracts for the first implementation attempt and the plan it is
 * built from. Prose regresses silently, so the two orderings that matter are
 * pinned here:
 *
 * - the implementer writes the behavior's tests and watches them fail BEFORE
 *   it implements (behavior-first, not implement-then-test);
 * - plan alignment checks every Requirement against every recorded discovery
 *   in the spec directory, so a feasibility finding that contradicts a
 *   Requirement cannot coexist with a "No gaps found." report.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf-8");

/** The numbered steps of a markdown section, in order. */
function numberedSteps(source: string, heading: string): readonly string[] {
  const start = source.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const section = source.slice(start + heading.length).split(/\n## /)[0]!;
  return [...section.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]!);
}

const stepIndex = (steps: readonly string[], pattern: RegExp): number => {
  const index = steps.findIndex((step) => pattern.test(step));
  expect(index, String(pattern)).toBeGreaterThanOrEqual(0);
  return index;
};

describe("code-implementer workflow is behavior-first", () => {
  const steps = numberedSteps(read("agents", "code-implementer-agent.md"), "## Mandatory Workflow");

  it("writes the behavior's tests before implementing", () => {
    expect(stepIndex(steps, /^\*\*Write the failing tests\*\*/)).toBeLessThan(stepIndex(steps, /^\*\*Implement\*\*/));
  });

  it("runs the new tests red before implementing, and names the waiver case", () => {
    const red = steps[stepIndex(steps, /^\*\*Write the failing tests\*\*/)]!;
    expect(red).toMatch(/run them/i);
    expect(red).toMatch(/fail/i);
    expect(red).toContain("new_tests");
  });

  it("no step still says to write tests for an existing implementation", () => {
    expect(steps.some((step) => /tests\*\* for your implementation/i.test(step))).toBe(false);
  });
});

describe("the engine-rendered implementation brief is behavior-first", () => {
  const steps = numberedSteps(read("commands", "templates", "impl-agent-context.md"), "## Required Workflow");

  it("writes and runs the failing tests before implementing", () => {
    const red = stepIndex(steps, /^If `new_tests` is required, write the failing tests first/);
    expect(red).toBeLessThan(stepIndex(steps, /^Implement code/));
    expect(steps[red]).toMatch(/run them and confirm they fail/i);
  });
});

describe("plan alignment checks Requirements against recorded discoveries", () => {
  const template = read("commands", "templates", "phase-plan-alignment.md");

  it("reads every supporting document in the spec directory, feasibility records included", () => {
    expect(template).toContain("{spec_dir}");
    expect(template).toMatch(/feasibility\.md/);
    expect(template).toMatch(/every supporting document/i);
  });

  it("reports a contradicted Requirement as a FEAS gap and forbids a clean report while one stands", () => {
    expect(template).toMatch(/`FEAS-N`/);
    expect(template).toMatch(/never write "No gaps found\." while a `FEAS-N`/i);
  });

  it("the report names the supporting documents it checked", () => {
    expect(template).toMatch(/## Supporting Documents Checked/);
  });
});
