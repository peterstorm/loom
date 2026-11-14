/**
 * Pi's lint-coverage reminder (`pi/lint-coverage.ts`), the twin of Claude
 * Code's `session-start lint-coverage` hook: the operator hears at session
 * start, the model with the session's first turn, once; a subagent process
 * stays quiet; a failure to compute is said, never swallowed.
 */
import { describe, expect, it } from "vitest";
import {
  createPiLintCoverageReminder,
  PI_LINT_COVERAGE_MESSAGE_TYPE,
  registerPiLintCoverage,
  type PiLintCoveragePorts,
} from "../../../pi/lint-coverage";
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

describe("registerPiLintCoverage — the extension's wiring", () => {
  type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

  /** The registration on a fake Pi, its handlers by event name. */
  const registered = (reminderAt: PiLintCoveragePorts["reminderAt"], cwd = "/repo") => {
    const handlers = new Map<string, Handler>();
    const stderr: string[] = [];
    const pi = { on: (name: string, handler: Handler) => void handlers.set(name, handler) };
    registerPiLintCoverage(pi as never, createPiLintCoverageReminder(ports({ reminderAt })), {
      cwd: () => cwd,
      writeStderrLine: (line) => stderr.push(line),
    });
    return { handlers, stderr };
  };

  const ctx = (sessionId: string, notified: string[] | null) => ({
    hasUI: notified !== null,
    ui: { notify: (message: string) => notified?.push(message) },
    sessionManager: { getSessionId: () => sessionId },
  });

  it("registers one session_start and one before_agent_start handler", () => {
    expect([...registered(() => REMINDER).handlers.keys()]).toEqual(["session_start", "before_agent_start"]);
  });

  it("session start asks about this process's directory and tells the UI; the first turn carries the model's copy, once", async () => {
    const asked: string[] = [];
    const notified: string[] = [];
    const { handlers } = registered((dir) => { asked.push(dir); return REMINDER; }, "/work/repo");
    await handlers.get("session_start")?.({}, ctx("s1", notified));
    expect(asked).toEqual(["/work/repo"]);
    expect(notified).toEqual(["operator: lint is off"]);
    const turn = handlers.get("before_agent_start");
    expect(await turn?.({}, ctx("s1", notified))).toEqual({
      message: { customType: PI_LINT_COVERAGE_MESSAGE_TYPE, content: "model: turn the linter on", display: false },
    });
    expect(await turn?.({}, ctx("s1", notified))).toBeUndefined();
  });

  it("a headless session tells the operator on stderr", async () => {
    const { handlers, stderr } = registered(() => REMINDER);
    await handlers.get("session_start")?.({}, ctx("s1", null));
    expect(stderr).toEqual(["[loom] operator: lint is off"]);
  });
});
