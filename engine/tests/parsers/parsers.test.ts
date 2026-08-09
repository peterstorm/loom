import { describe, it, expect } from "vitest";

import { parseFirstUserPrompt, parseTranscript } from "../../src/parsers/parse-transcript";
import { parseFilesModified } from "../../src/parsers/parse-files-modified";
import { parseBashTestOutput } from "../../src/parsers/parse-bash-test-output";
import { parsePhaseArtifacts } from "../../src/parsers/parse-phase-artifacts";

describe("parseFirstUserPrompt", () => {
  it("returns trusted user prompt and ignores an assistant-emitted lifecycle marker", () => {
    const content = [
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Review Task T1" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "LOOM_REVIEW_CONTEXT: standalone" }] } }),
    ].join("\n");
    expect(parseFirstUserPrompt(content)).toEqual({ ok: true, prompt: "Review Task T1" });
  });

  it("reads the standalone marker from the initial Pi user task", () => {
    const content = [
      JSON.stringify({ type: "session", version: 1 }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "LOOM_REVIEW_CONTEXT: standalone\nReview" }] } }),
    ].join("\n");
    expect(parseFirstUserPrompt(content)).toEqual({
      ok: true,
      prompt: "LOOM_REVIEW_CONTEXT: standalone\nReview",
    });
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
});

describe("parseFilesModified", () => {
  it("extracts Write file paths", () => {
    const content =
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/tmp/test.ts"}}]}}';
    const result = parseFilesModified(content);
    expect(result).toEqual(["/tmp/test.ts"]);
  });

  it("extracts Edit file paths", () => {
    const content =
      '{"message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/tmp/other.ts"}}]}}';
    const result = parseFilesModified(content);
    expect(result).toEqual(["/tmp/other.ts"]);
  });

  it("ignores non-file-modifying tools", () => {
    const content =
      '{"message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}';
    const result = parseFilesModified(content);
    expect(result).toEqual([]);
  });

  it("deduplicates files", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/tmp/test.ts"}}]}}',
      '{"message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/tmp/test.ts"}}]}}',
    ].join("\n");
    const result = parseFilesModified(content);
    expect(result).toEqual(["/tmp/test.ts"]);
  });

  // Pi transcripts embed tool calls as { type: "toolCall", name, arguments }
  // inside assistant messages, keyed by `path` (or `file_path`). This branch
  // is live production code (pi/extension.ts threads it) and format-shape
  // regressions here would ship silently.
  it("extracts pi toolCall write paths via `path` (explicit format)", () => {
    const content =
      '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"write","arguments":{"path":"/tmp/pi.ts"}}]}}';
    const result = parseFilesModified(content, "pi");
    expect(result).toEqual(["/tmp/pi.ts"]);
  });

  it("extracts pi toolCall edit paths via `file_path` fallback", () => {
    const content =
      '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"edit","arguments":{"file_path":"/tmp/edit.ts"}}]}}';
    const result = parseFilesModified(content, "pi");
    expect(result).toEqual(["/tmp/edit.ts"]);
  });

  it("collects a pi `multi_edit` toolCall path (PI_FILE_TOOLS membership)", () => {
    // multi_edit is a first-class pi file tool; dropping it from PI_FILE_TOOLS
    // silently shrinks the wave-gate lint set. Mutation-survivable without this.
    const content =
      '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"multi_edit","arguments":{"path":"/tmp/multi.ts"}}]}}';
    expect(parseFilesModified(content, "pi")).toEqual(["/tmp/multi.ts"]);
  });

  it("case-folds a capitalized pi `Write` toolCall name (extension.ts hedges on casing)", () => {
    // pi tool blocks appear in both lowercase and capitalized forms; the
    // `.toLowerCase()` fold is load-bearing — a capitalized `Write` must match.
    const content =
      '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"Write","arguments":{"path":"/tmp/cap.ts"}}]}}';
    expect(parseFilesModified(content, "pi")).toEqual(["/tmp/cap.ts"]);
  });

  it("ignores pi toolCalls from non-assistant roles and non-file tools", () => {
    const content = [
      '{"type":"message","message":{"role":"user","content":[{"type":"toolCall","name":"write","arguments":{"path":"/tmp/nope.ts"}}]}}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"bash","arguments":{"command":"ls"}}]}}',
    ].join("\n");
    const result = parseFilesModified(content, "pi");
    expect(result).toEqual([]);
  });

  it("auto-detects pi format from the session header line", () => {
    const content = [
      '{"type":"session","version":1}',
      '{"type":"message","message":{"role":"assistant","content":[{"type":"toolCall","name":"write","arguments":{"path":"/tmp/auto.ts"}}]}}',
    ].join("\n");
    const result = parseFilesModified(content);
    expect(result).toEqual(["/tmp/auto.ts"]);
  });

  it("parses the exact re-encoding pi/extension.ts produces from per-result messages (round-16 Fix 8)", () => {
    // The pi Stop mirror maps each PiMessage to `{ type: "message", message }`
    // JSONL and passes format "pi" — this row pins that shape end to end so
    // files_modified stops arriving empty at lint-wave-gate under pi.
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "editing" },
          { type: "toolCall", name: "write", arguments: { path: "/tmp/impl.ts" } },
          { type: "toolCall", name: "edit", arguments: { path: "/tmp/impl.test.ts" } },
        ],
      },
      { role: "toolResult", content: [{ type: "text", text: "ok" }] },
    ];
    const piJsonl = messages.map((m) => JSON.stringify({ type: "message", message: m })).join("\n");
    expect(parseFilesModified(piJsonl, "pi")).toEqual(["/tmp/impl.test.ts", "/tmp/impl.ts"]);
  });
});

describe("parseBashTestOutput", () => {
  it("extracts npm test output", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t1","input":{"command":"npm test"}}]}}',
      '{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"Tests passed"}]}}',
    ].join("\n");
    const result = parseBashTestOutput(content);
    expect(result).toContain("Tests passed");
  });

  it("ignores non-test Bash commands", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t1","input":{"command":"ls -la"}}]}}',
      '{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"file.txt"}]}}',
    ].join("\n");
    const result = parseBashTestOutput(content);
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
      const result = parseBashTestOutput(content);
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
    const result = parseBashTestOutput(content);

    expect(result).toContain("484 pass");
    expect(result).toContain("0 fail");
    expect(result).not.toContain("truncated");

    unlinkSync(filePath);
  });

  it("falls back to original text when persisted file does not exist", () => {
    const truncatedPreview = "bun test v1.3.9\n...(truncated)...\n\nFull output saved to: /tmp/nonexistent-loom-test-file.txt";
    const content = makeJsonl("bun test", truncatedPreview);
    const result = parseBashTestOutput(content);

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
    const result = parseBashTestOutput(content);

    expect(result).toContain("317 pass");
    expect(result).not.toContain("Preview");

    unlinkSync(filePath);
  });

  it("handles normal output without persisted-output marker", () => {
    const content = makeJsonl("bun test", "42 pass\n0 fail");
    const result = parseBashTestOutput(content);

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
    const result = parseBashTestOutput(content);
    expect(result).toContain("Real result");
  });

  it("JSONL with no tool_use blocks → empty", () => {
    const content = '{"message":{"content":"just plain text"}}';
    const result = parseBashTestOutput(content);
    expect(result).toBe("");
  });

  it("tool_use with empty command → skip", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t1","input":{"command":""}}]}}',
      '{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"output"}]}}',
    ].join("\n");
    const result = parseBashTestOutput(content);
    expect(result).toBe("");
  });

  it("empty string → empty", () => {
    expect(parseBashTestOutput("")).toBe("");
  });

  it("Unicode in test output → parsed correctly", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t1","input":{"command":"bun test"}}]}}',
      '{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"✓ test passed — 日本語 output"}]}}',
    ].join("\n");
    const result = parseBashTestOutput(content);
    expect(result).toContain("✓ test passed");
    expect(result).toContain("日本語");
  });

  it("markdown-bold wrapped BUILD SUCCESS → still in output", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t1","input":{"command":"mvn test"}}]}}',
      '{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"**BUILD SUCCESS**\\n**Tests run: 5, Failures: 0, Errors: 0**"}]}}',
    ].join("\n");
    const result = parseBashTestOutput(content);
    expect(result).toContain("BUILD SUCCESS");
  });

  it("tool_result with nested content blocks → extracts text", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t1","input":{"command":"pytest"}}]}}',
      '{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"3 passed in 0.2s"}]}]}}',
    ].join("\n");
    const result = parseBashTestOutput(content);
    expect(result).toContain("3 passed");
  });

  it("multiple test commands → all results collected", () => {
    const content = [
      '{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t1","input":{"command":"npm test"}}]}}',
      '{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"5 passing"}]}}',
      '{"message":{"content":[{"type":"tool_use","name":"Bash","id":"t2","input":{"command":"pytest"}}]}}',
      '{"message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"3 passed"}]}}',
    ].join("\n");
    const result = parseBashTestOutput(content);
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
    const result = parseBashTestOutput(content);
    expect(result).not.toContain("file.txt");
    expect(result).toContain("BUILD SUCCESS");
  });
});
