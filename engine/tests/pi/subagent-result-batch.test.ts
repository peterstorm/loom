import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parsePiSubagentResults, piSubagentFailureSignals } from "../../../pi/subagent-result-batch";

describe("parsePiSubagentResults", () => {
  it("rejects a missing transcript and preserves the following result's position", () => {
    const parsed = parsePiSubagentResults([
      { agent: "silent-failure-hunter", task: "Task: T1", exitCode: 0 },
      { agent: "code-reviewer", task: "Task: T1", exitCode: 0, messages: [] },
    ]);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      ok: false,
      problem: expect.stringContaining("messages is missing"),
    });
    expect(parsed[1]).toMatchObject({
      ok: true,
      result: { agent: "code-reviewer" },
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects non-safe-integer exitCode %s",
    (exitCode) => {
      const [parsed] = parsePiSubagentResults([{
        agent: "code-reviewer",
        task: "Task: T1",
        exitCode,
        messages: [],
      }]);

      expect(parsed).toMatchObject({
        ok: false,
        problem: expect.stringContaining("exitCode must be a finite safe integer"),
      });
    },
  );

  it("retains exactly one positional entry for every unknown result", () => {
    fc.assert(fc.property(fc.array(fc.anything()), (raw) => {
      expect(parsePiSubagentResults(raw)).toHaveLength(raw.length);
    }));
  });
});

/**
 * An infrastructure fault and an agent-contract fault must not read alike. The
 * fields that separate them are in scope wherever the diagnostic is composed;
 * the whole point of this helper is that none of them get dropped.
 */
describe("piSubagentFailureSignals", () => {
  it("reports the exit/stop pair and the harness cause line", () => {
    expect(piSubagentFailureSignals({ exitCode: 0, stopReason: "error", errorMessage: "Connection error." }))
      .toBe('exitCode=0, stopReason=error, errorMessage="Connection error."');
  });

  it("omits the cause line rather than printing an empty or absent one", () => {
    expect(piSubagentFailureSignals({ exitCode: 1, stopReason: "aborted" }))
      .toBe("exitCode=1, stopReason=aborted");
    expect(piSubagentFailureSignals({ exitCode: 1, stopReason: "aborted", errorMessage: "   " }))
      .toBe("exitCode=1, stopReason=aborted");
    expect(piSubagentFailureSignals({ exitCode: 1, stopReason: "aborted", errorMessage: { not: "a string" } }))
      .toBe("exitCode=1, stopReason=aborted");
  });

  it("degrades a malformed exit code or stop reason to n/a instead of undefined", () => {
    expect(piSubagentFailureSignals({})).toBe("exitCode=n/a, stopReason=n/a");
    expect(piSubagentFailureSignals({ exitCode: "1", stopReason: 7 })).toBe("exitCode=n/a, stopReason=n/a");
  });
});
