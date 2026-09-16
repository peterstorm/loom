import { describe, expect, it } from "vitest";
import { piSilentStopNote } from "../../../pi/subagent-result";

/**
 * A silent stop is the failure mode every applier reads blind: the child
 * process exited cleanly (exitCode=0, non-error stopReason) but emitted no
 * assistant text, so pi renders "(no output)", the appliers parse the empty
 * transcript and report "not ready"/"no structured evidence" — none of which
 * names the stopReason that discriminates the mode.
 *
 * The note is a diagnostic, so what matters is that it fires on exactly the
 * shape that warrants it: a clean exit with no observable assistant text.
 * A failed result already carries `piSubagentFailureSignals` through
 * `applyFailedPiResult`, and assistant text refutes the silent reading —
 * a note in either case would be the engine guessing.
 */
describe("piSilentStopNote", () => {
  it("carries the stop pair, the transcript tail, and the unapplied verdict on a silent stop", () => {
    const note = piSilentStopNote({
      agent: "decompose-agent",
      task: "Decompose the spec",
      exitCode: 0,
      stopReason: "stop",
      messages: [],
    });

    expect(note).toContain("decompose-agent exited cleanly but emitted no assistant text");
    expect(note).toContain("exitCode=0, stopReason=stop");
    expect(note).toContain("transcript tail: (empty transcript)");
    expect(note).toContain("its evidence was not applied");
  });

  it("carries the harness cause line when pi emitted one", () => {
    const note = piSilentStopNote({
      agent: "decompose-agent",
      task: "t",
      exitCode: 0,
      stopReason: "stop",
      errorMessage: "Connection error.",
      messages: [],
    });

    expect(note).toContain('errorMessage="Connection error."');
  });

  it("reads a transcript with only non-assistant messages as silent, tailing what the child was doing", () => {
    const note = piSilentStopNote({
      agent: "code-implementer",
      task: "t",
      exitCode: 0,
      messages: [
        { role: "user", content: [{ type: "text", text: "Implement T1" }] },
        { role: "toolResult", content: [{ type: "text", text: "panel-kernel.ts read" }] },
      ],
    });

    expect(note).toContain("code-implementer exited cleanly but emitted no assistant text");
    expect(note).toContain("transcript tail: Implement T1 | panel-kernel.ts read");
  });

  it("stays silent when the child produced assistant text — the text refutes the silent reading", () => {
    expect(piSilentStopNote({
      agent: "decompose-agent",
      task: "t",
      exitCode: 0,
      stopReason: "stop",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Task graph valid: 14 tasks" }] }],
    })).toBeNull();
  });

  it("treats whitespace-only assistant text as absent", () => {
    expect(piSilentStopNote({
      agent: "decompose-agent",
      task: "t",
      exitCode: 0,
      stopReason: "stop",
      messages: [{ role: "assistant", content: [{ type: "text", text: "   " }] }],
    })).toContain("silent stop");
  });

  it("stays silent for failed results — they already carry piSubagentFailureSignals", () => {
    expect(piSilentStopNote({
      agent: "decompose-agent",
      task: "t",
      exitCode: 1,
      stopReason: "error",
      messages: [],
    })).toBeNull();
    expect(piSilentStopNote({
      agent: "decompose-agent",
      task: "t",
      exitCode: 0,
      stopReason: "aborted",
      messages: [],
    })).toBeNull();
  });

  it("stays silent when the transcript shape is unreadable — silence is not provable there", () => {
    expect(piSilentStopNote({
      agent: "decompose-agent",
      task: "t",
      exitCode: 0,
      stopReason: "stop",
      messages: "not-a-transcript",
    })).toBeNull();
  });

  it("degrades a missing stop reason to n/a rather than dropping the signal", () => {
    expect(piSilentStopNote({
      agent: "decompose-agent",
      task: "t",
      exitCode: 0,
      messages: [],
    })).toContain("stopReason=n/a");
  });
});
