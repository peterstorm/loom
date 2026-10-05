import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { corpusCaseResult, finalAssistantText, parseFindings } from "./corpus-calibration";

const messageEnd = (role: string, ...texts: string[]): string =>
  JSON.stringify({ type: "message_end", message: { role, content: texts.map((text) => ({ type: "text", text })) } });

describe("finalAssistantText (Pi JSON stream folding)", () => {
  it("keeps the last non-blank assistant text, ignoring other events and roles", () => {
    const stream = [
      JSON.stringify({ type: "agent_start" }),
      messageEnd("assistant", "first"),
      messageEnd("user", "not an answer"),
      messageEnd("assistant", "   "),
      messageEnd("assistant", "fin", "al"),
      "",
    ].join("\n");
    expect(finalAssistantText(stream)).toEqual({ ok: true, value: "final" });
    expect(finalAssistantText(messageEnd("user", "x"))).toEqual({ ok: true, value: null });
  });

  it("refuses the whole stream on any malformed line, naming every one", () => {
    const result = finalAssistantText([messageEnd("assistant", "answer"), "{oops", "also bad"].join("\n"));
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/^Pi JSON stream contained 2 malformed line\(s\): line 2: .*; line 3: /) });
  });
});

describe("parseFindings", () => {
  it("parses a bare or fenced JSON array and refuses anything else", () => {
    expect(parseFindings('[{"id":1}]')).toEqual({ ok: true, value: [{ id: 1 }] });
    expect(parseFindings('```json\n[{"id":1}]\n```')).toEqual({ ok: true, value: [{ id: 1 }] });
    expect(parseFindings("```\n[]\n```")).toEqual({ ok: true, value: [] });
    expect(parseFindings('{"id":1}')).toEqual({ ok: false, error: "model output was not a JSON array" });
    expect(parseFindings("not json").ok).toBe(false);
  });

  it("round-trips any JSON array through an optional fence (property)", () => {
    fc.assert(fc.property(fc.array(fc.jsonValue()), fc.constantFrom("", "```", "```json", "```JSON"), (array, fence) => {
      const body = JSON.stringify(array);
      const text = fence === "" ? body : `${fence}\n${body}\n\`\`\``;
      expect(parseFindings(text)).toEqual({ ok: true, value: JSON.parse(body) });
    }));
  });
});

describe("corpusCaseResult", () => {
  const exited = (status: number | null, stdout: string, stderr = "") => ({ kind: "exited" as const, status, stdout, stderr });

  it("executes a case whose final answer is a findings array", () => {
    expect(corpusCaseResult("c1", exited(0, messageEnd("assistant", "[]")))).toEqual({ case_id: "c1", status: "executed", findings: [] });
  });

  it("records every failure as not executed, with its reason", () => {
    expect(corpusCaseResult("c1", { kind: "unlaunched", reason: "could not build prompt for c1" }))
      .toEqual({ case_id: "c1", status: "not-executed", reason: "could not build prompt for c1" });
    expect(corpusCaseResult("c1", exited(2, "", "  boom \n"))).toEqual({ case_id: "c1", status: "not-executed", reason: "boom" });
    expect(corpusCaseResult("c1", exited(null, ""))).toEqual({ case_id: "c1", status: "not-executed", reason: "pi exited null" });
    expect(corpusCaseResult("c1", exited(0, ""))).toEqual({ case_id: "c1", status: "not-executed", reason: "Pi produced no final assistant text" });
    expect(corpusCaseResult("c1", exited(0, "{bad"))).toMatchObject({ status: "not-executed", reason: expect.stringContaining("malformed line") });
    expect(corpusCaseResult("c1", exited(0, messageEnd("assistant", "{}")))).toEqual({ case_id: "c1", status: "not-executed", reason: "model output was not a JSON array" });
  });
});
