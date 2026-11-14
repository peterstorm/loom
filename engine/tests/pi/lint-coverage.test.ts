/**
 * Pi's lint-coverage reminder (`pi/lint-coverage.ts`), the twin of Claude
 * Code's `session-start lint-coverage` hook: the operator hears at session
 * start, the model with the session's first turn, once; a subagent process
 * stays quiet; a failure to compute is said, never swallowed.
 */
import { describe, expect, it } from "vitest";
import { createPiLintCoverageReminder, PI_LINT_COVERAGE_MESSAGE_TYPE, type PiLintCoveragePorts } from "../../../pi/lint-coverage";
import type { CoverageReminder } from "../../src/linter/index";

const REMINDER: CoverageReminder = { forModel: "model: turn the linter on", forOperator: "operator: lint is off" };

const ports = (overrides: Partial<PiLintCoveragePorts> = {}): PiLintCoveragePorts => ({
  reminderAt: () => REMINDER,
  role: () => ({ kind: "parent" }),
  ...overrides,
});

describe("createPiLintCoverageReminder", () => {
  it("tells the operator at session start and hands the model its copy once, with the first turn", () => {
    const notes: string[] = [];
    const reminder = createPiLintCoverageReminder(ports());
    reminder.sessionStarted("s1", "/repo", (note) => notes.push(note));
    expect(notes).toEqual(["operator: lint is off"]);
    expect(reminder.takeModelMessage("s1")).toEqual({ customType: PI_LINT_COVERAGE_MESSAGE_TYPE, content: "model: turn the linter on", display: false });
    expect(reminder.takeModelMessage("s1")).toBeUndefined();
  });

  it("asks about the session's own directory, and keeps sessions apart", () => {
    const asked: string[] = [];
    const reminder = createPiLintCoverageReminder(ports({ reminderAt: (dir) => { asked.push(dir); return REMINDER; } }));
    reminder.sessionStarted("s1", "/repo", () => {});
    expect(asked).toEqual(["/repo"]);
    expect(reminder.takeModelMessage("other")).toBeUndefined();
    expect(reminder.takeModelMessage("s1")).toBeDefined();
  });

  it("says nothing when there is nothing to remind", () => {
    const notes: string[] = [];
    const reminder = createPiLintCoverageReminder(ports({ reminderAt: () => null }));
    reminder.sessionStarted("s1", "/repo", (note) => notes.push(note));
    expect(notes).toEqual([]);
    expect(reminder.takeModelMessage("s1")).toBeUndefined();
  });

  it("a subagent process stays quiet: its parent session was reminded", () => {
    const notes: string[] = [];
    let asked = false;
    const reminder = createPiLintCoverageReminder(ports({
      role: () => ({ kind: "subagent", parentSession: "p" }),
      reminderAt: () => { asked = true; return REMINDER; },
    }));
    reminder.sessionStarted("s1", "/repo", (note) => notes.push(note));
    expect(asked).toBe(false);
    expect(notes).toEqual([]);
    expect(reminder.takeModelMessage("s1")).toBeUndefined();
  });

  it("a coverage check that throws is told to the operator, not swallowed", () => {
    const notes: string[] = [];
    const reminder = createPiLintCoverageReminder(ports({ reminderAt: () => { throw new Error("EACCES"); } }));
    reminder.sessionStarted("s1", "/repo", (note) => notes.push(note));
    expect(notes).toEqual(["Loom lint: the coverage check could not run: EACCES"]);
    expect(reminder.takeModelMessage("s1")).toBeUndefined();
  });
});
