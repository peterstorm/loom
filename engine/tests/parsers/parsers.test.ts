import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { parseFirstUserPrompt, parseTranscript } from "../../src/parsers/parse-transcript";
import { parseFilesModified, PI_SESSION_REFUSAL } from "../../src/parsers/parse-files-modified";
import { parseBashTestOutput } from "../../src/parsers/parse-bash-test-output";
import { readPersistedOutput } from "../../src/utils/persisted-output";

/** The production persisted-output reader, bound once: no test here is about it. */
const parseBashOutput = (jsonl: string): string => parseBashTestOutput(jsonl, readPersistedOutput);
import { parsePhaseArtifacts } from "../../src/parsers/parse-phase-artifacts";
import { parseSubagentLifecycleStdin } from "../../src/parsers/parse-subagent-lifecycle-input";

const parseSubagentStartStdin = (stdin: string) => parseSubagentLifecycleStdin("SubagentStart", stdin);
const parseSubagentStopStdin = (stdin: string) => parseSubagentLifecycleStdin("SubagentStop", stdin);

describe("Claude Code harness records", () => {
  // Claude Code writes request telemetry beside the conversation. Its
  // api-request-blob records carry copies of earlier turns (including a user
  // role and a stale test result) that are never the agent's activity.
  const fixture = readFileSync(new URL("../fixtures/claude-harness-records-transcript.jsonl", import.meta.url), "utf8");

  it("contribute no modified files", () => {
    expect(parseFilesModified(fixture)).toEqual({ ok: true, value: ["/repo/src/real.ts"] });
  });

  it("contribute no test output", () => {
    const output = parseBashOutput(fixture);
    expect(output).toContain("Tests: 3 passed");
    expect(output).not.toContain("1 failed");
  });

  it("contribute no transcript text", () => {
    const text = parseTranscript(fixture);
    expect(text).toContain("Done.");
    expect(text).not.toContain("1 failed");
    expect(text).not.toContain("tools just became available");
  });

  it("are skipped before the first user-authored prompt", () => {
    const content = [
      JSON.stringify({ type: "api-request-blob", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "stale" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Task ID: T1" } }),
    ].join("\n");
    expect(parseFirstUserPrompt(content)).toEqual({ ok: true, prompt: "Task ID: T1" });
  });
});

describe("Subagent lifecycle input parsers", () => {
  const valid = {
    session_id: "session-1",
    agent_id: "agent-1",
    agent_type: "code-reviewer",
    agent_transcript_path: "/tmp/transcript.jsonl",
  };

  it("projects the same immutable wire fields through both stdin parsers", () => {
    const start = parseSubagentStartStdin(JSON.stringify({ ...valid, ignored: true }));
    const stop = parseSubagentStopStdin(JSON.stringify({ ...valid, ignored: true }));

    expect(start).toEqual({ ok: true, value: valid });
    expect(stop).toEqual({ ok: true, value: valid });
    expect(start.ok && Object.isFrozen(start.value)).toBe(true);
    expect(stop.ok && Object.isFrozen(stop.value)).toBe(true);
  });

  it.each([
    ["SubagentStart", parseSubagentStartStdin],
    ["SubagentStop", parseSubagentStopStdin],
  ] as const)("retains event-specific diagnostics for malformed %s fields", (event, parse) => {
    expect(parse(JSON.stringify({ session_id: "session-1", agent_id: 42 }))).toEqual({
      ok: false,
      error: `${event} agent_id must be a string when present`,
    });
  });

  it("retains event-specific malformed-JSON diagnostics at the stdin boundary", () => {
    expect(parseSubagentStartStdin("{broken")).toEqual({
      ok: false,
      error: expect.stringContaining("SubagentStart input is malformed JSON"),
    });
    expect(parseSubagentStopStdin("{broken")).toEqual({
      ok: false,
      error: expect.stringContaining("SubagentStop input is malformed JSON"),
    });
  });
});

describe("parseFirstUserPrompt", () => {
  it("returns trusted user prompt and ignores an assistant-emitted lifecycle marker", () => {
    const content = [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Review Task T1" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "LOOM_REVIEW_CONTEXT: standalone" }] } }),
    ].join("\n");
    expect(parseFirstUserPrompt(content)).toEqual({ ok: true, prompt: "Review Task T1" });
  });

  it("reads no prompt or write set from a Pi session file: each reader fails closed", () => {
    // Every reader here serves a Claude Code hook. A Pi session handed to one
    // is never read as Pi (that dialect is gone): its `session`/`message`
    // records classify as harness records and attribute nothing.
    const header = JSON.stringify({ type: "session", version: 1 });
    const content = [
      header,
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "LOOM_REVIEW_CONTEXT: standalone\nReview" }] } }),
    ].join("\n");
    expect(parseFirstUserPrompt(content)).toEqual({ ok: false, error: "transcript contains no user-authored prompt" });
    expect(parseTranscript(content)).toBe("");
    const write = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "write", arguments: { path: "/tmp/pi.ts" } }] } });
    // A Pi session's write set is refused, never read as an empty one.
    expect(parseFilesModified(`${header}\n${write}`)).toEqual({ ok: false, error: PI_SESSION_REFUSAL });
    // Wherever the header sits, and beside Claude records.
    const claudeWrite = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/tmp/a.ts"}}]}}';
    expect(parseFilesModified(`${claudeWrite}\n${header}`)).toEqual({ ok: false, error: PI_SESSION_REFUSAL });
    // A record typed session without a version is no Pi header.
    expect(parseFilesModified(`${JSON.stringify({ type: "session" })}\n${claudeWrite}`)).toEqual({ ok: true, value: ["/tmp/a.ts"] });
  });

  it("fails closed when malformed JSON precedes a later valid user prompt", () => {
    const content = [
      "{truncated",
      JSON.stringify({ type: "user", message: { role: "user", content: "Review Task T2" } }),
    ].join("\n");

    expect(parseFirstUserPrompt(content)).toEqual({
      ok: false,
      error: expect.stringContaining("malformed transcript JSON before the first user prompt at line 1"),
    });
  });

  it.each(["null", "[]", "7", '"user"'])("fails closed when the non-object JSON line %s precedes a later valid user prompt", (line) => {
    for (const header of [[], [JSON.stringify({ type: "session", version: 1 })]]) {
      const content = [
        ...header,
        line,
        JSON.stringify({ type: "message", message: { role: "user", content: "Review Task T2" } }),
      ].join("\n");
      expect(parseFirstUserPrompt(content)).toEqual({
        ok: false,
        error: `malformed transcript entry before the first user prompt at line ${header.length + 1}: expected a JSON object`,
      });
    }
  });

  it.each<{ readonly message: unknown }>([
    { message: null },
    { message: "user" },
    { message: 7 },
    { message: ["user"] },
  ])("skips an entry whose message is $message, never reading it as the user prompt", ({ message }) => {
    const content = [
      JSON.stringify({ type: "user", message }),
      JSON.stringify({ type: "user", message: { role: "user", content: "Review Task T3" } }),
    ].join("\n");
    expect(parseFirstUserPrompt(content)).toEqual({ ok: true, prompt: "Review Task T3" });
  });

  it("returns a typed failure for malformed user content", () => {
    const content = JSON.stringify({ type: "user", message: { role: "user", content: { malformed: true } } });
    expect(parseFirstUserPrompt(content)).toEqual({
      ok: false,
      error: expect.stringContaining("unsupported content"),
    });
  });

  it("rejects a Claude tool-result envelope as the first user-authored prompt", () => {
    const content = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "Task T9" }],
      },
    });

    expect(parseFirstUserPrompt(content)).toEqual({
      ok: false,
      error: expect.stringContaining("first user-role entry is a tool result"),
    });
  });
});

describe("parseTranscript", () => {
  it("extracts text from string content", () => {
    const content = '{"message":{"content":"Hello world"}}';
    const result = parseTranscript(content);
    expect(result).toContain("Hello world");
  });

  it("extracts text from content blocks", () => {
    const content =
      '{"message":{"content":[{"type":"text","text":"Block text"}]}}';
    const result = parseTranscript(content);
    expect(result).toContain("Block text");
  });

  it("extracts tool_result content", () => {
    const content =
      '{"message":{"content":[{"type":"tool_result","content":"Result text"}]}}';
    const result = parseTranscript(content);
    expect(result).toContain("Result text");
  });

  it("uses the same text-block flattener for nested Claude tool results", () => {
    const content = JSON.stringify({
      message: { content: [{ type: "tool_result", content: [
        { type: "text", text: "first" },
        { type: "image", source: "ignored" },
        { type: "text", text: "second" },
      ] }] },
    });
    expect(parseTranscript(content)).toBe("first\nsecond");
  });
});

describe("parseFilesModified", () => {
  it("extracts Write file paths", () => {
    const content =
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/tmp/test.ts"}}]}}';
    expect(parseFilesModified(content)).toEqual({ ok: true, value: ["/tmp/test.ts"] });
  });

  it("extracts Edit file paths", () => {
    const content =
      '{"message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/tmp/other.ts"}}]}}';
    expect(parseFilesModified(content)).toEqual({ ok: true, value: ["/tmp/other.ts"] });
  });

  it("ignores non-file-modifying tools", () => {
    const content =
      '{"message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}';
    expect(parseFilesModified(content)).toEqual({ ok: true, value: [] });
  });

  it("deduplicates files", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/tmp/test.ts"}}]}}',
      '{"message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/tmp/test.ts"}}]}}',
    ].join("\n");
    expect(parseFilesModified(content)).toEqual({ ok: true, value: ["/tmp/test.ts"] });
  });
});

describe("parseBashTestOutput", () => {
  it("extracts npm test output", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t1","input":{"command":"npm test"}}]}}',
      '{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"Tests passed"}]}}',
    ].join("\n");
    const result = parseBashOutput(content);
    expect(result).toContain("Tests passed");
  });

  it("ignores non-test Bash commands", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t1","input":{"command":"ls -la"}}]}}',
      '{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"file.txt"}]}}',
    ].join("\n");
    const result = parseBashOutput(content);
    expect(result).toBe("");
  });

  it("matches various test runners", () => {
    const testCases = [
      "pytest",
      "cargo test",
      "go test ./...",
      "mvn test",
      "./gradlew test",
      "npx vitest",
    ];

    for (const cmd of testCases) {
      const content = [
        `{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t1","input":{"command":"${cmd}"}}]}}`,
        '{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"OK"}]}}',
      ].join("\n");
      const result = parseBashOutput(content);
      expect(result).toContain("OK");
    }
  });
});

describe("parsePhaseArtifacts", () => {
  it("extracts spec_file from Write to .claude/specs/", () => {
    const content =
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/project/.claude/specs/2025-01-15-auth/spec.md"}}]}}';
    const result = parsePhaseArtifacts(content);
    expect(result.spec_file).toBe(
      "/project/.claude/specs/2025-01-15-auth/spec.md"
    );
    expect(result.plan_file).toBeUndefined();
  });

  it("extracts plan_file from Write to .claude/plans/", () => {
    const content =
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/project/.claude/plans/2025-01-15-auth.md"}}]}}';
    const result = parsePhaseArtifacts(content);
    expect(result.plan_file).toBe(
      "/project/.claude/plans/2025-01-15-auth.md"
    );
    expect(result.spec_file).toBeUndefined();
  });

  it("extracts both spec_file and plan_file", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/project/.claude/specs/2025-01-15-auth/spec.md"}}]}}',
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/project/.claude/plans/2025-01-15-auth.md"}}]}}',
    ].join("\n");
    const result = parsePhaseArtifacts(content);
    expect(result.spec_file).toBe(
      "/project/.claude/specs/2025-01-15-auth/spec.md"
    );
    expect(result.plan_file).toBe(
      "/project/.claude/plans/2025-01-15-auth.md"
    );
  });

  it("ignores Write to non-artifact paths", () => {
    const content =
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/project/src/auth.ts"}}]}}';
    const result = parsePhaseArtifacts(content);
    expect(result.spec_file).toBeUndefined();
    expect(result.plan_file).toBeUndefined();
  });

  it("ignores non-.md files", () => {
    const content =
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/project/.claude/specs/data.json"}}]}}';
    const result = parsePhaseArtifacts(content);
    expect(result.spec_file).toBeUndefined();
  });

  it("prefers deeper spec path", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/project/.claude/specs/spec.md"}}]}}',
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/project/.claude/specs/2025-01-15-auth/spec.md"}}]}}',
    ].join("\n");
    const result = parsePhaseArtifacts(content);
    expect(result.spec_file).toBe(
      "/project/.claude/specs/2025-01-15-auth/spec.md"
    );
  });

  it("handles filePath variant", () => {
    const content =
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"filePath":"/project/.claude/specs/2025-01-15-auth/spec.md"}}]}}';
    const result = parsePhaseArtifacts(content);
    expect(result.spec_file).toBe(
      "/project/.claude/specs/2025-01-15-auth/spec.md"
    );
  });

  it("returns empty object for empty transcript", () => {
    const result = parsePhaseArtifacts("");
    expect(result).toEqual({});
  });

  it("returns empty object for transcript with no Write calls", () => {
    const content =
      '{"message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}';
    const result = parsePhaseArtifacts(content);
    expect(result).toEqual({});
  });

  it("prefers spec.md over brainstorm.md in same dir", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/p/.claude/specs/2025-01-15-auth/brainstorm.md"}}]}}',
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/p/.claude/specs/2025-01-15-auth/spec.md"}}]}}',
    ].join("\n");
    const result = parsePhaseArtifacts(content);
    expect(result.spec_file).toBe("/p/.claude/specs/2025-01-15-auth/spec.md");
  });

  it("prefers spec.md even when brainstorm.md written after", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/p/.claude/specs/2025-01-15-auth/spec.md"}}]}}',
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/p/.claude/specs/2025-01-15-auth/brainstorm.md"}}]}}',
    ].join("\n");
    const result = parsePhaseArtifacts(content);
    expect(result.spec_file).toBe("/p/.claude/specs/2025-01-15-auth/spec.md");
  });

  it("brainstorm.md alone → spec_file undefined", () => {
    const content =
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/p/.claude/specs/2025-01-15-auth/brainstorm.md"}}]}}';
    const result = parsePhaseArtifacts(content);
    expect(result.spec_file).toBeUndefined();
  });

  it("deeply nested spec path → longest path wins", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/p/.claude/specs/spec.md"}}]}}',
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/p/.claude/specs/foo/bar/baz/spec.md"}}]}}',
    ].join("\n");
    const result = parsePhaseArtifacts(content);
    expect(result.spec_file).toBe("/p/.claude/specs/foo/bar/baz/spec.md");
  });

  it("Edit tool (not Write) → not counted as artifact", () => {
    const content =
      '{"message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/p/.claude/specs/2025/spec.md"}}]}}';
    const result = parsePhaseArtifacts(content);
    expect(result.spec_file).toBeUndefined();
  });

  it(".md.bak extension → ignored", () => {
    const content =
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/p/.claude/specs/spec.md.bak"}}]}}';
    const result = parsePhaseArtifacts(content);
    expect(result.spec_file).toBeUndefined();
  });
});

describe("parseBashTestOutput — persisted output resolution", () => {
  const { writeFileSync, unlinkSync, mkdtempSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");

  function makeJsonl(cmd: string, toolResult: string): string {
    return [
      `{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t1","input":{"command":"${cmd}"}}]}}`,
      `{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":${JSON.stringify(toolResult)}}]}}`,
    ].join("\n");
  }

  it("resolves persisted output file and returns full content", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-persist-"));
    const filePath = join(dir, "bash-output.txt");
    writeFileSync(filePath, "484 pass\n0 fail\n1201 expect() calls\n");

    const truncatedPreview = `bun test v1.3.9\n\nsrc/config.test.ts:\n...(truncated)...\n\nFull output saved to: ${filePath}`;
    const content = makeJsonl("bun test", truncatedPreview);
    const result = parseBashOutput(content);

    expect(result).toContain("484 pass");
    expect(result).toContain("0 fail");
    expect(result).not.toContain("truncated");

    unlinkSync(filePath);
  });

  it("falls back to original text when persisted file does not exist", () => {
    const truncatedPreview = "bun test v1.3.9\n...(truncated)...\n\nFull output saved to: /tmp/nonexistent-loom-test-file.txt";
    const content = makeJsonl("bun test", truncatedPreview);
    const result = parseBashOutput(content);

    expect(result).toContain("truncated");
    expect(result).toContain("Full output saved to");
  });

  it("resolves persisted output in nested content blocks", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-persist-"));
    const filePath = join(dir, "nested-output.txt");
    writeFileSync(filePath, "317 pass\n0 fail\n");

    const toolResult = JSON.stringify([
      { type: "text", text: `Preview...\n\nFull output saved to: ${filePath}` },
    ]);
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t1","input":{"command":"bun test"}}]}}',
      `{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":${toolResult}}]}}`,
    ].join("\n");
    const result = parseBashOutput(content);

    expect(result).toContain("317 pass");
    expect(result).not.toContain("Preview");

    unlinkSync(filePath);
  });

  it("handles normal output without persisted-output marker", () => {
    const content = makeJsonl("bun test", "42 pass\n0 fail");
    const result = parseBashOutput(content);

    expect(result).toContain("42 pass");
    expect(result).toContain("0 fail");
  });
});

describe("parseBashTestOutput — malformed inputs", () => {
  it("malformed JSONL (missing closing brace) → graceful skip", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t1","input":{"command":"npm test"}}]}}',
      '{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"OK"',  // truncated
      '{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"Real result"}]}}',
    ].join("\n");
    const result = parseBashOutput(content);
    expect(result).toContain("Real result");
  });

  it("JSONL with no tool_use blocks → empty", () => {
    const content = '{"message":{"content":"just plain text"}}';
    const result = parseBashOutput(content);
    expect(result).toBe("");
  });

  it("tool_use with empty command → skip", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t1","input":{"command":""}}]}}',
      '{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"output"}]}}',
    ].join("\n");
    const result = parseBashOutput(content);
    expect(result).toBe("");
  });

  it("empty string → empty", () => {
    expect(parseBashOutput("")).toBe("");
  });

  it("Unicode in test output → parsed correctly", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t1","input":{"command":"bun test"}}]}}',
      '{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"✓ test passed — 日本語 output"}]}}',
    ].join("\n");
    const result = parseBashOutput(content);
    expect(result).toContain("✓ test passed");
    expect(result).toContain("日本語");
  });

  it("markdown-bold wrapped BUILD SUCCESS → still in output", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t1","input":{"command":"mvn test"}}]}}',
      '{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"**BUILD SUCCESS**\\n**Tests run: 5, Failures: 0, Errors: 0**"}]}}',
    ].join("\n");
    const result = parseBashOutput(content);
    expect(result).toContain("BUILD SUCCESS");
  });

  it("tool_result with nested content blocks → extracts text", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t1","input":{"command":"pytest"}}]}}',
      '{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"3 passed in 0.2s"}]}]}}',
    ].join("\n");
    const result = parseBashOutput(content);
    expect(result).toContain("3 passed");
  });

  it("multiple test commands → all results collected", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t1","input":{"command":"npm test"}}]}}',
      '{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"5 passing"}]}}',
      '{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t2","input":{"command":"pytest"}}]}}',
      '{"message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"3 passed"}]}}',
    ].join("\n");
    const result = parseBashOutput(content);
    expect(result).toContain("5 passing");
    expect(result).toContain("3 passed");
  });

  it("non-test command interleaved → only test results captured", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t1","input":{"command":"ls -la"}}]}}',
      '{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"file.txt"}]}}',
      '{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t2","input":{"command":"mvn test"}}]}}',
      '{"message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"BUILD SUCCESS"}]}}',
    ].join("\n");
    const result = parseBashOutput(content);
    expect(result).not.toContain("file.txt");
    expect(result).toContain("BUILD SUCCESS");
  });
});
