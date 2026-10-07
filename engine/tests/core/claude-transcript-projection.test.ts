/**
 * The pure Claude transcript projection over plain lines: one parse feeds the
 * final-turn candidates, the spawn prompt, the emission scan and the tool
 * outputs, and a corrupt final turn is a typed failure, never a throw. The
 * file-reading shell is covered by subagent-stop/claude-final-payload.test.ts.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  claudeEmissionFrames,
  claudeEmissionScan,
  claudeToolOutputs,
  claudeTranscriptCandidates,
  claudeTranscriptSpawnPrompt,
  parseClaudeTranscript,
} from "../../src/core/claude-transcript-projection";

const line = (value: object): string => JSON.stringify(value);
const prompt = line({ type: "user", message: { role: "user", content: "LOOM_REQUEST_ID: request:a:1" } });
const assistantText = (text: string) => line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const toolUse = (id: string, name: string, input: unknown) =>
  line({ type: "assistant", message: { id: `m-${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const toolResult = (id: string, content: unknown, isError = false) =>
  line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });
const attributed = { requestId: "request:reviewer:1", version: "v2" as const };

describe("claudeTranscriptCandidates", () => {
  it("reads the final assistant text and ignores corruption in an earlier turn", () => {
    const transcript = parseClaudeTranscript(["{torn", prompt, assistantText("final"), ""]);
    expect(claudeTranscriptCandidates(transcript)).toEqual({
      ok: true,
      value: [{ origin: "transcript.line[2].block[0]", text: "final" }],
    });
  });

  it("returns a corrupt final turn as a typed failure naming its 1-based line", () => {
    const transcript = parseClaudeTranscript([prompt, toolUse("h1", "SubagentHandback", { message: "x" }), "{torn"]);
    const read = claudeTranscriptCandidates(transcript);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toMatch(/^invalid final Claude transcript JSON at line 3: /);
  });

  it("delivers a successful handback and nothing from a failed one", () => {
    const delivered = parseClaudeTranscript([prompt, toolUse("h1", "SubagentHandback", { message: "report" }), toolResult("h1", "ok")]);
    expect(claudeTranscriptCandidates(delivered)).toEqual({ ok: true, value: [{ origin: "transcript.line[1].handback", text: "report" }] });
    const failed = parseClaudeTranscript([prompt, toolUse("h1", "SubagentHandback", { message: "report" }), toolResult("h1", "no", true)]);
    expect(claudeTranscriptCandidates(failed)).toEqual({ ok: true, value: [] });
  });
});

describe("claudeTranscriptSpawnPrompt", () => {
  it("reads the opening user message and refuses a corrupt opening line", () => {
    expect(claudeTranscriptSpawnPrompt(parseClaudeTranscript(["", prompt]))).toEqual({ ok: true, value: "LOOM_REQUEST_ID: request:a:1" });
    expect(claudeTranscriptSpawnPrompt(parseClaudeTranscript([assistantText("x")]))).toEqual({ ok: true, value: null });
    const corrupt = claudeTranscriptSpawnPrompt(parseClaudeTranscript(["{broken"]));
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.error).toMatch(/^invalid opening Claude transcript JSON at line 1: /);
  });
});

describe("the one forward walk", () => {
  it("projects tool outputs and emission frames from the same parse", () => {
    const transcript = parseClaudeTranscript([
      prompt,
      toolUse("r1", "Read", { path: "a" }), toolResult("r1", "page one"),
      toolUse("r2", "Read", { path: "b" }), toolResult("r2", [{ type: "text", text: "page" }, { type: "text", text: "two" }]),
      toolUse("e1", "loom_emit_reviewer_payload", { findings: [] }), toolResult("e1", "accepted"),
      toolUse("x1", "Bash", {}), toolResult("x1", "denied", true),
    ]);
    expect(claudeToolOutputs(transcript)).toEqual(["page one", "page\ntwo", "accepted"]);
    const scan = claudeEmissionScan(transcript, attributed);
    expect(scan.walkIncompleteness).toBeNull();
    expect(scan.frames).toEqual([{
      kind: "complete",
      call: { requestId: attributed.requestId, toolCallId: "e1", kind: { kind: "reviewer-payload" }, version: "v2", arguments: { findings: [] } },
    }]);
  });

  it("counts an unclassifiable line and an orphan result as walk incompleteness, never absence", () => {
    const transcript = parseClaudeTranscript([prompt, "not json", toolResult("ghost", "x")]);
    const frames = claudeEmissionFrames(transcript, attributed);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ kind: "incomplete", toolCallId: null });
    expect(JSON.stringify(frames[0])).toContain("1 unclassifiable line(s), first at transcript.line[1]");
    expect(JSON.stringify(frames[0])).toContain("1 orphan tool result(s) with call ids ghost");
  });

  it("refuses a prefix-reserved tool the registry does not freeze as an incomplete frame", () => {
    const transcript = parseClaudeTranscript([prompt, toolUse("u1", "loom_emit_future_kind", {}), toolResult("u1", "ok")]);
    expect(claudeEmissionScan(transcript, attributed).frames).toMatchObject([{ kind: "incomplete", toolCallId: "u1" }]);
  });

  it("property: blank lines never change any projection", () => {
    const lines = [prompt, toolUse("r1", "Read", {}), toolResult("r1", "page"), assistantText("done")];
    fc.assert(fc.property(fc.array(fc.nat({ max: lines.length }), { maxLength: 5 }), (positions) => {
      const padded = [...lines];
      for (const position of [...positions].sort((left, right) => right - left)) padded.splice(position, 0, "  ");
      const plain = parseClaudeTranscript(lines);
      const spaced = parseClaudeTranscript(padded);
      expect(claudeToolOutputs(spaced)).toEqual(claudeToolOutputs(plain));
      expect(claudeEmissionScan(spaced, attributed).frames).toEqual(claudeEmissionScan(plain, attributed).frames);
      const candidates = claudeTranscriptCandidates(spaced);
      expect(candidates.ok && candidates.value.map(({ text }) => text)).toEqual(["done"]);
    }), { numRuns: 100 });
  });
});
