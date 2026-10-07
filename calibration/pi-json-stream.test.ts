import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { foldPiJsonStream, piContentText, readPiJsonLine, settlePiJsonStream, type PiJsonLine } from "./pi-json-stream";

const messageEnd = (message: unknown): string => JSON.stringify({ type: "message_end", message });

describe("Pi JSON stream lines", () => {
  it("keeps a message_end event's message and ignores every other event and blank lines", () => {
    const message = { role: "assistant", content: [{ type: "text", text: "hi" }] };
    expect(readPiJsonLine(messageEnd(message), 1)).toEqual({ kind: "message", message });
    expect(readPiJsonLine(JSON.stringify({ type: "message_update", message }), 2)).toEqual({ kind: "ignored" });
    expect(readPiJsonLine(JSON.stringify({ type: "message_end", message: "not a message" }), 3)).toEqual({ kind: "ignored" });
    expect(readPiJsonLine("   ", 4)).toEqual({ kind: "ignored" });
  });

  it("is malformed when it is not JSON or not an event object, naming its line", () => {
    expect(readPiJsonLine("{oops", 7)).toMatchObject({ kind: "malformed", detail: expect.stringMatching(/^line 7: /) });
    for (const value of ["42", "null", "[]", "\"text\""]) {
      expect(readPiJsonLine(value, 3)).toEqual({ kind: "malformed", detail: "line 3: not a JSON event object" });
    }
  });
});

describe("Pi JSON stream fold", () => {
  it("yields every message in stream order, or refuses the whole stream naming every malformed line", () => {
    const first = { role: "user", content: "q" };
    const second = { role: "assistant", content: "a" };
    expect(foldPiJsonStream([messageEnd(first), JSON.stringify({ type: "agent_end" }), messageEnd(second), ""].join("\n")))
      .toEqual({ ok: true, value: [first, second] });
    expect(foldPiJsonStream([messageEnd(first), "{oops", "7"].join("\n"))).toEqual({
      ok: false,
      error: expect.stringMatching(/^Pi JSON stream contained 2 malformed line\(s\): line 2: .*; line 3: not a JSON event object$/),
    });
  });

  it("decoding line by line and settling equals folding the whole stdout (property)", () => {
    const line = fc.oneof(
      fc.constant(""),
      fc.constant("{not json"),
      fc.jsonValue().map((value) => JSON.stringify(value)),
      fc.record({ role: fc.constantFrom("assistant", "user"), content: fc.string() }).map(messageEnd),
    );
    fc.assert(fc.property(fc.array(line, { maxLength: 12 }), (lines) => {
      const streamed: PiJsonLine[] = [];
      lines.forEach((entry, index) => {
        const read = readPiJsonLine(entry, index + 1);
        if (read.kind !== "ignored") streamed.push(read);
      });
      expect(settlePiJsonStream(streamed)).toEqual(foldPiJsonStream(lines.join("\n")));
    }), { numRuns: 200 });
  });
});

describe("Pi message content text", () => {
  it("is a plain string, or the concatenated text blocks of a block list", () => {
    expect(piContentText("plain")).toBe("plain");
    expect(piContentText([{ type: "text", text: "fin" }, { type: "toolCall", id: "x" }, { type: "text", text: "al" }, "stray"])).toBe("final");
    expect(piContentText(null)).toBe("");
    expect(piContentText({ type: "text", text: "not a list" })).toBe("");
  });
});
