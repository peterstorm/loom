import { describe, it, expect, vi } from "vitest";
import { passthroughDiagnostic } from "../../src/utils/hook-diagnostic";

/**
 * Pins the dual-channel contract of `passthroughDiagnostic`: the one message
 * must reach BOTH channels in exactly the right shape — stderr with a trailing
 * newline (one, added only when missing) and the harness-surfaced
 * `systemMessage` with ALL trailing newlines stripped — because 9 hook call
 * sites depend on "a discarded finding can never look like a clean review".
 */

describe("passthroughDiagnostic", () => {
  let stderrText: string;

  const call = (diagnostic: string) => {
    stderrText = "";
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrText += String(chunk);
        return true;
      });
    try {
      return passthroughDiagnostic(diagnostic);
    } finally {
      stderrSpy.mockRestore();
    }
  };

  it("adds exactly one trailing newline to stderr when the input has none", () => {
    expect(call("review discarded: no report")).toEqual({
      kind: "passthrough",
      systemMessage: "review discarded: no report",
    });
    expect(stderrText).toBe("review discarded: no report\n");
  });

  it("keeps a single existing trailing newline untouched on stderr", () => {
    expect(call("done\n")).toEqual({
      kind: "passthrough",
      systemMessage: "done",
    });
    expect(stderrText).toBe("done\n");
  });

  it("writes multiple existing trailing newlines as-is on stderr (no collapsing)", () => {
    expect(call("done\n\n\n")).toEqual({
      kind: "passthrough",
      systemMessage: "done",
    });
    expect(stderrText).toBe("done\n\n\n");
  });

  it("strips ALL trailing newlines from the systemMessage", () => {
    const result = call("line one\nline two\n\n");
    expect(result).toEqual({ kind: "passthrough", systemMessage: "line one\nline two" });
    // Internal newlines survive on both channels.
    expect(stderrText).toBe("line one\nline two\n\n");
  });

  it("preserves internal newlines on both channels", () => {
    expect(call("a\nb")).toEqual({ kind: "passthrough", systemMessage: "a\nb" });
    expect(stderrText).toBe("a\nb\n");
  });

  it("writes a bare newline to stderr for an empty diagnostic and substitutes the placeholder message", () => {
    expect(call("")).toEqual({
      kind: "passthrough",
      systemMessage: "<no message provided>",
    });
    expect(stderrText).toBe("\n");
  });

  it("keeps both channels consistent: systemMessage is the stderr line minus trailing newlines", () => {
    for (const diagnostic of ["x", "x\n", "x\n\n", "a\nb", "a\nb\n"]) {
      const result = call(diagnostic);
      expect(result.kind).toBe("passthrough");
      if (result.kind === "passthrough" && result.systemMessage !== undefined) {
        expect(stderrText.replace(/\n+$/, "")).toBe(result.systemMessage);
      }
    }
  });
});
