import { describe, expect, it } from "vitest";
import { messagesToClaudeJsonl, parsePiMessages, piStructuredTestDiagnostics, piStructuredTestResult, type PiMessage } from "../../pi/transcript-adapter";
import { parseBashTestOutput } from "../src/parsers/parse-bash-test-output";
import { extractTestEvidence } from "../src/handlers/subagent-stop/update-task-status";

const testRun = (output: string, command = "bun test src/domain/calendar.test.ts"): PiMessage[] => [
  {
    role: "assistant",
    content: [{
      type: "toolCall",
      id: "call-test-1",
      name: "bash",
      arguments: { command },
    }],
  },
  {
    role: "toolResult",
    toolCallId: "call-test-1",
    toolName: "bash",
    content: [{ type: "text", text: output }],
  },
];

function claudeJsonl(messages: readonly PiMessage[]): string {
  const adapted = messagesToClaudeJsonl(messages);
  expect(adapted.ok).toBe(true);
  if (!adapted.ok) throw new Error(adapted.errors.join("; "));
  return adapted.value;
}

describe("Pi test-evidence transcript adapter", () => {
  it("preserves a real Bash test call/result pair for the anti-spoofing parser", () => {
    const output = parseBashTestOutput(claudeJsonl(testRun("654 pass\n0 fail\n")));

    expect(output).toContain("654 pass");
    expect(extractTestEvidence(output)).toEqual({
      passed: true,
      evidence: "bun: 654 pass",
    });
  });

  it("does not turn assistant prose containing pass markers into test evidence", () => {
    const messages: PiMessage[] = [{
      role: "assistant",
      content: [{ type: "text", text: "654 pass, 0 fail" }],
    }];

    const output = parseBashTestOutput(claudeJsonl(messages));
    expect(output).toBe("");
    expect(extractTestEvidence(output).passed).toBe(false);
  });

  it("does not pair a test command with another tool call's result", () => {
    const messages = testRun("654 pass\n0 fail\n");
    messages[1] = { ...messages[1], toolCallId: "different-call" };

    expect(parseBashTestOutput(claudeJsonl(messages))).toBe("");
  });

  it("rejects print-only commands that mention a test runner in data or comments", () => {
    for (const command of [
      "printf 'bun test\\n654 pass\\n'",
      "printf '654 pass\\n' # bun test",
      "echo \"npm test: 5 passing\"",
    ]) {
      expect(piStructuredTestResult(testRun("654 pass\n0 fail\n", command))).toEqual({ ok: true, value: null });
    }
  });

  it("keeps an errored Bash tool result failing even when its text looks like a pass", () => {
    const messages = testRun("654 pass\n0 fail\n");
    messages[1] = { ...messages[1], isError: true };

    expect(piStructuredTestResult(messages)).toEqual({
      ok: true,
      value: { passed: false, evidence: "bun: 654 pass" },
    });
  });

  it("requires the classified test segment to own the Bash result — unless the output summary is the verdict", () => {
    // Standard refusal: the line exit is not provably the test's.
    expect(piStructuredTestResult(testRun("654 pass\n0 fail\n", "bun test &"))).toEqual({ ok: true, value: null });
    // A red run laundered through a line-stripping pipe loses the pipeline
    // exit AND the zero-fail line: strict-summary guard refuses it.
    expect(piStructuredTestResult(testRun("654 pass\n", "bun test | grep -v fail"))).toEqual({ ok: true, value: null });
    // Exit-0 `;`/`&&` chains with the test LAST ran it green by construction
    // (a red chain would exit nonzero) — standard attribution applies.
    expect(piStructuredTestResult(testRun("654 pass\n0 fail\n", "echo skip; bun test"))).toEqual({
      ok: true,
      value: { passed: true, evidence: "bun: 654 pass" },
    });
    expect(piStructuredTestResult(testRun("654 pass\n0 fail\n", "git stash && bun test"))).toEqual({
      ok: true,
      value: { passed: true, evidence: "bun: 654 pass" },
    });
    // A NONZERO exit after `&&` is the guard's, with the test never run:
    // standard attribution refuses, and the errored line never mints green.
    const guarded = testRun("654 pass\n0 fail\n", "git stash && bun test");
    guarded[1] = { ...guarded[1], isError: true };
    expect(piStructuredTestResult(guarded)).toEqual({ ok: true, value: null });
    // An errored attributable line (sole test run) resolves to a structured FAIL.
    const errored = testRun("654 pass\n0 fail\n", "bun test");
    errored[1] = { ...errored[1], isError: true };
    expect(piStructuredTestResult(errored)).toEqual({
      ok: true,
      value: { passed: false, evidence: "bun: 654 pass" },
    });
    // IsLast + `&&` compositions keep the standard attribution.
    expect(piStructuredTestResult(testRun("654 pass\n0 fail\n", "cd engine && bun test"))).toEqual({
      ok: true,
      value: { passed: true, evidence: "bun: 654 pass" },
    });
    // The Pi structured-output relaxation: a test headed by only a `cd`
    // preamble and trailed only by PIPE stages (`| tail`, `| tee`) may use the
    // paired runner summary as its verdict even though standard exit
    // attribution refused the composition.
    expect(piStructuredTestResult(testRun("654 pass\n0 fail\n", "cd engine && bun test | tail -n 40"))).toEqual({
      ok: true,
      value: { passed: true, evidence: "bun: 654 pass" },
    });
    expect(piStructuredTestResult(testRun("654 pass\n0 fail\n", "cd engine && bun test --no-color 2>&1 | tee /tmp/out.log"))).toEqual({
      ok: true,
      value: { passed: true, evidence: "bun: 654 pass" },
    });
    // A relaxed composition whose summary shows failures still resolves to a
    // structured FAIL — the gate rejects it either way, but it is not silent.
    expect(piStructuredTestResult(testRun("600 pass\n54 fail\n", "cd engine && bun test | tail -n 40"))).toEqual({
      ok: true,
      value: { passed: false, evidence: "" },
    });
    // A `;`/`&&`/`||`/`&`-sequenced command AFTER the test can inject stdout
    // into the paired output and fabricate the verdict — the relax no longer
    // fires for it. These fall to null (transcript fallback → the gate decides
    // fail-closed) rather than minting a structured pass.
    for (const injected of [
      "bun test 2>/dev/null; echo ' 1 pass'; echo ' 0 fail'", // real output discarded, fake counters injected
      "bun test; echo ' 5 pass'; echo ' 0 fail'",             // appended counters beat the real red summary
      "bun test 2>/dev/null && echo ' 0 fail'",               // && injection
      "bun test; echo EXIT:$?",                                // benign trailer, still not trustable
      "bun test || true",                                      // trailing `|| true`
    ]) {
      expect(piStructuredTestResult(testRun("654 pass\n0 fail\n", injected))).toEqual({ ok: true, value: null });
    }
    // The fabrication is caught even when the runner genuinely FAILED: a red
    // run whose output is overwritten by injected green counters must NOT mint
    // a pass.
    expect(piStructuredTestResult(testRun(" 2 pass\n 3 fail\n 5 pass\n 0 fail\n", "bun test; echo ' 5 pass'; echo ' 0 fail'")))
      .toEqual({ ok: true, value: null });
  });

  it.each([
    ["non-array payload", null],
    ["object payload", { role: "assistant", content: [] }],
    ["null message", [null]],
    ["primitive message", [42]],
    ["missing role", [{ content: [] }]],
    ["empty role", [{ role: "", content: [] }]],
    ["non-array content", [{ role: "assistant", content: null }]],
    ["invalid optional result id", [{ role: "assistant", toolCallId: 42, content: [] }]],
    ["invalid optional error flag", [{ role: "assistant", isError: "no", content: [] }]],
    ["missing call id", [{ role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "bun test" } }] }]],
    ["missing tool name", [{ role: "assistant", content: [{ type: "toolCall", id: "call-1", arguments: { command: "bun test" } }] }]],
    ["missing Bash command", [{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }] }]],
    ["missing tool arguments", [{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read" }] }]],
    ["missing text", [{ role: "assistant", content: [{ type: "text" }] }]],
    ["non-string text", [{ role: "assistant", content: [{ type: "text", text: 42 }] }]],
    ["missing result id", [{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok" }] }]],
    ["missing result name", [{ role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "ok" }] }]],
  ] as const)("rejects malformed tool evidence without throwing: %s", (_label, messages) => {
    expect(messagesToClaudeJsonl(messages)).toMatchObject({ ok: false, errors: [expect.any(String)] });
    expect(piStructuredTestResult(messages)).toMatchObject({ ok: false, errors: [expect.any(String)] });
  });

  it.each([
    [
      "user",
      { role: "user", content: "hello from Pi" },
      { role: "user", content: [{ type: "text", text: "hello from Pi" }] },
    ],
    [
      "assistant",
      { role: "assistant", content: "working on it" },
      { role: "assistant", content: [{ type: "text", text: "working on it" }] },
    ],
    [
      "toolResult",
      { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: "command output" },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text", text: "command output" }],
      },
    ],
    [
      "custom role",
      { role: "custom", content: "custom harness output" },
      { role: "custom", content: [{ type: "text", text: "custom harness output" }] },
    ],
  ] as const)("normalizes Pi %s string content to one immutable text block", (_role, message, expected) => {
    const parsed = parsePiMessages([message]);

    expect(parsed).toEqual({ ok: true, value: [expected] });
    expect(parsed.ok && parsed.value[0]!.content).toHaveLength(1);
    expect(parsed.ok && Object.isFrozen(parsed.value[0]!.content)).toBe(true);
    expect(parsed.ok && Object.isFrozen(parsed.value[0]!.content[0])).toBe(true);
  });

  it("normalizes singleton typed text and toolCall content blocks", () => {
    const parsed = parsePiMessages([
      { role: "assistant", content: { type: "text", text: "singleton text" } },
      { role: "assistant", content: { type: "toolCall", id: "call-write-1", name: "write", arguments: { path: "target.ts" } } },
    ]);

    expect(parsed).toEqual({
      ok: true,
      value: [
        { role: "assistant", content: [{ type: "text", text: "singleton text" }] },
        { role: "assistant", content: [{ type: "toolCall", id: "call-write-1", name: "write", arguments: { path: "target.ts" } }] },
      ],
    });
    expect(parsed.ok && parsed.value[0]!.content).toHaveLength(1);
    expect(parsed.ok && parsed.value[1]!.content).toHaveLength(1);
    expect(parsed.ok && Object.isFrozen(parsed.value[0]!.content[0])).toBe(true);
    expect(parsed.ok && Object.isFrozen(parsed.value[1]!.content[0])).toBe(true);
  });

  it.each([
    ["arbitrary object", { role: "assistant", content: { text: "missing type" } }],
    ["missing text", { role: "assistant", content: { type: "text" } }],
    ["malformed tool call", { role: "assistant", content: { type: "toolCall", id: "call-1", name: "bash", arguments: {} } }],
  ] as const)("fails closed for malformed singleton content objects: %s", (_label, message) => {
    expect(parsePiMessages([message])).toMatchObject({ ok: false, errors: [expect.any(String)] });
    expect(messagesToClaudeJsonl([message])).toMatchObject({ ok: false, errors: [expect.any(String)] });
    expect(piStructuredTestResult([message])).toMatchObject({ ok: false, errors: [expect.any(String)] });
  });

  it("returns immutable parser-owned copies for singleton typed content blocks", () => {
    const singletonText = { type: "text", text: "before" };
    const singletonToolCall = {
      type: "toolCall",
      id: "call-write-1",
      name: "write",
      arguments: { path: "before.ts" },
    };
    const parsed = parsePiMessages([
      { role: "assistant", content: singletonText },
      { role: "assistant", content: singletonToolCall },
    ]);

    expect(parsed.ok).toBe(true);
    singletonText.text = "after";
    singletonToolCall.arguments.path = "after.ts";

    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const parsedText = parsed.value[0]!.content[0]!;
    const parsedToolCall = parsed.value[1]!.content[0]!;
    expect(parsedText).toEqual({ type: "text", text: "before" });
    expect(parsedToolCall.type).toBe("toolCall");
    if (parsedToolCall.type !== "toolCall") throw new Error("expected singleton toolCall block");
    expect(parsedToolCall.arguments.path).toBe("before.ts");
    expect(Object.isFrozen(parsed.value[0])).toBe(true);
    expect(Object.isFrozen(parsed.value[0]!.content)).toBe(true);
    expect(Object.isFrozen(parsedText)).toBe(true);
    expect(Object.isFrozen(parsedToolCall)).toBe(true);
    expect(Object.isFrozen(parsedToolCall.arguments)).toBe(true);
  });

  it("omits unknown-role strings from JSONL and test evidence", () => {
    const unknownMessage = {
      role: "custom",
      toolCallId: "call-test-1",
      toolName: "bash",
      content: "654 pass\n0 fail\n",
    };

    expect(messagesToClaudeJsonl([unknownMessage])).toEqual({ ok: true, value: "" });
    expect(piStructuredTestResult([testRun("")[0], unknownMessage])).toEqual({ ok: true, value: null });
  });

  it("diagnoses why structured capture did not mint (wave-gate blocker forensics)", () => {
    // No test command at all → no-test-command.
    expect(piStructuredTestDiagnostics(testRun("654 pass\n0 fail\n", "git status"))).toEqual({
      ok: true,
      value: { classifiedCommands: [], attributedPairs: 0, verdict: "no-test-command" },
    });
    // Classified but never attributable (backgrounded) → exit-not-attributable.
    expect(piStructuredTestDiagnostics(testRun("654 pass\n0 fail\n", "bun test &"))).toMatchObject({
      ok: true,
      value: expect.objectContaining({ attributedPairs: 0, verdict: "exit-not-attributable" }),
    });
    // Laundered summary (zero-fail line stripped) → strict-summary-refused.
    expect(piStructuredTestDiagnostics(testRun("654 pass\n", "bun test | grep -v fail"))).toMatchObject({
      ok: true,
      value: expect.objectContaining({ attributedPairs: 1, verdict: "strict-summary-refused" }),
    });
    // Genuine structured mint → structured.
    expect(piStructuredTestDiagnostics(testRun("654 pass\n0 fail\n", "bun test"))).toMatchObject({
      ok: true,
      value: expect.objectContaining({ attributedPairs: 1, verdict: "structured" }),
    });
    // Relaxed-but-valid pipe → relaxed.
    expect(piStructuredTestDiagnostics(testRun("654 pass\n0 fail\n", "cd engine && bun test | tail -n 40"))).toMatchObject({
      ok: true,
      value: expect.objectContaining({ attributedPairs: 1, verdict: "relaxed" }),
    });
  });

  it("pairs a string-form tool result with its real Bash call for structured evidence", () => {
    const messages = [
      testRun("")[0],
      {
        role: "toolResult",
        toolCallId: "call-test-1",
        toolName: "bash",
        content: "654 pass\n0 fail\n",
      },
    ];

    expect(piStructuredTestResult(messages)).toEqual({
      ok: true,
      value: { passed: true, evidence: "bun: 654 pass" },
    });
  });

  it.each([
    ["toolCallId", { role: "toolResult", toolName: "bash", content: "654 pass\n0 fail\n" }],
    ["toolName", { role: "toolResult", toolCallId: "call-test-1", content: "654 pass\n0 fail\n" }],
  ] as const)("fails closed when a string-form tool result is missing %s", (_field, result) => {
    const messages = [testRun("")[0], result];

    expect(parsePiMessages(messages)).toMatchObject({ ok: false, errors: [expect.any(String)] });
    expect(messagesToClaudeJsonl(messages)).toMatchObject({ ok: false, errors: [expect.any(String)] });
    expect(piStructuredTestResult(messages)).toMatchObject({ ok: false, errors: [expect.any(String)] });
  });

  it("returns immutable parser-owned copies rather than trusting harness objects", () => {
    const raw = [{ role: "assistant", content: [{ type: "text", text: "before" }] }];
    const parsed = parsePiMessages(raw);
    expect(parsed.ok).toBe(true);
    raw[0]!.content[0]!.text = "after";
    expect(parsed.ok && parsed.value[0]!.content[0]).toEqual({ type: "text", text: "before" });
    expect(parsed.ok && Object.isFrozen(parsed.value[0])).toBe(true);
    expect(parsed.ok && Object.isFrozen(parsed.value[0]!.content)).toBe(true);
  });
});
