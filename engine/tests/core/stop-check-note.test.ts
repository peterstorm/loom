import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseStopCheckNote, renderStopCheckNotes, STOP_CHECK_NOTES_HEADING } from "../../src/core/stop-check-note";

describe("parseStopCheckNote", () => {
  it("reads a sidecar's task id and message", () => {
    expect(parseStopCheckNote({ taskId: "T2", message: "affected: timed out" })).toEqual({ taskId: "T2", message: "affected: timed out" });
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["an array", [{ taskId: "T2", message: "m" }]],
    ["a missing task id", { message: "m" }],
    ["an empty task id", { taskId: "", message: "m" }],
    ["a blank message", { taskId: "T2", message: "  \n" }],
    ["a non-string message", { taskId: "T2", message: 3 }],
  ])("is null for %s", (_label, raw) => {
    expect(parseStopCheckNote(raw)).toBeNull();
  });
});

describe("renderStopCheckNotes", () => {
  it("lists each note under its Task after the heading, indenting continuation lines", () => {
    expect(renderStopCheckNotes([
      { taskId: "T2", message: "affected-test stop check did not decide (timed out)\nrunner: npm run test:affected" },
      { taskId: "T5", message: "acceptance stop check did not decide (lock held)" },
    ])).toBe([
      STOP_CHECK_NOTES_HEADING,
      "- T2: affected-test stop check did not decide (timed out)",
      "  runner: npm run test:affected",
      "- T5: acceptance stop check did not decide (lock held)",
    ].join("\n"));
  });

  it("property: every note's task id and every message line appears, one item per note", () => {
    const line = fc.stringMatching(/^[a-z][a-z ]{0,20}$/);
    fc.assert(fc.property(
      fc.array(fc.record({ taskId: fc.stringMatching(/^T[1-9][0-9]?$/), message: fc.array(line, { minLength: 1, maxLength: 3 }).map((ls) => ls.join("\n")) }), { minLength: 1, maxLength: 5 }),
      (notes) => {
        const rendered = renderStopCheckNotes(notes as never);
        expect(rendered.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(notes.length);
        for (const { taskId, message } of notes) {
          expect(rendered).toContain(`- ${taskId}: `);
          for (const part of message.trim().split("\n")) expect(rendered).toContain(part);
        }
      },
    ));
  });
});
