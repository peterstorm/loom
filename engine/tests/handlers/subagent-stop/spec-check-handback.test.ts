import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deliveredSpecCheckText, readSpecCheckReport } from "../../../src/handlers/subagent-stop/store-spec-check-findings";
import { parseClaudeTranscript } from "../../../src/core/claude-transcript-projection";
import { parseSpecCheckOutput } from "../../../src/core/spec-check";
import { parseTranscript } from "../../../src/parsers/parse-transcript";

const REPORT = [
  "SPEC_CHECK_WAVE: 8",
  "HIGH: the pilot recorded 0 observations",
  "SPEC_CHECK_CRITICAL_COUNT: 0",
  "SPEC_CHECK_HIGH_COUNT: 1",
  "SPEC_CHECK_VERDICT: PASSED",
].join("\n");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function transcript(lines: readonly (object | string)[]): string {
  const dir = canonicalTempDir("loom-spec-check-handback-");
  dirs.push(dir);
  const path = join(dir, "agent.jsonl");
  writeFileSync(path, lines.map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n") + "\n");
  return path;
}

/** The parsed transcript the one settled read hands deliveredSpecCheckText. */
const parsedAt = (path: string) => parseClaudeTranscript(readFileSync(path, "utf8").split("\n"));

const handbackTurn = (message: string, isError = false) => [
  { type: "assistant", message: { id: "m1", role: "assistant", content: [
    { type: "tool_use", id: "h1", name: "SubagentHandback", input: { message } },
  ] } },
  { type: "user", message: { role: "user", content: [
    { type: "tool_result", tool_use_id: "h1", content: "delivered", is_error: isError },
  ] } },
  { type: "attachment" },
];

describe("deliveredSpecCheckText", () => {
  it("reads a SubagentHandback report so its finding lines reconcile with the counts", () => {
    // Current Claude subagents deliver through SubagentHandback; the legacy
    // text read parses an echoed skill template instead of the delivered report.
    const path = transcript(handbackTurn(REPORT));
    const text = deliveredSpecCheckText(parsedAt(path), "legacy text");
    expect(text).toBe(REPORT);
    const parsed = parseSpecCheckOutput(text);
    expect(parsed.high).toEqual(["the pilot recorded 0 observations"]);
    expect(parsed.highCount).toBe(1);
  });

  it("keeps the legacy text when the final turn delivered no handback", () => {
    const path = transcript([{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: REPORT }] } }]);
    expect(deliveredSpecCheckText(parsedAt(path), "legacy text")).toBe("legacy text");
  });

  it("keeps the legacy text when the handback failed, so nothing undelivered is parsed", () => {
    const path = transcript(handbackTurn(REPORT, true));
    expect(deliveredSpecCheckText(parsedAt(path), "legacy text")).toBe("legacy text");
  });

  it("keeps the legacy text when the strict final-turn read finds a torn line the legacy read tolerates", () => {
    const path = transcript([...handbackTurn(REPORT).slice(0, 2), '{"type":"attachment","torn']);
    expect(deliveredSpecCheckText(parsedAt(path), "legacy text")).toBe("legacy text");
  });

  it("documents why the legacy read cannot reconcile a handback report", () => {
    const path = transcript(handbackTurn(REPORT));
    const legacy = parseSpecCheckOutput(parseTranscript(readFileSync(path, "utf8")));
    expect(legacy.high).toEqual([]);
  });
});

describe("readSpecCheckReport — one settled, bounded read", () => {
  it("derives the delivered handback report from the same read that settled on the count marker", async () => {
    const path = transcript([
      { type: "user", message: { role: "user", content: "SPEC_CHECK_CRITICAL_COUNT: 0 (template echo)" } },
      ...handbackTurn(REPORT),
    ]);
    expect(await readSpecCheckReport(path)).toBe(REPORT);
  });

  it("returns the legacy text when no handback was delivered", async () => {
    const path = transcript([{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: REPORT }] } }]);
    expect(await readSpecCheckReport(path)).toBe(parseTranscript(readFileSync(path, "utf8")));
  });

  it("refuses a transcript over the read bound instead of decoding it", async () => {
    const path = transcript(handbackTurn(REPORT));
    await expect(readSpecCheckReport(path, 64)).rejects.toThrow();
  });

  it("refuses a located transcript that no longer exists rather than reading an empty report", async () => {
    const dir = canonicalTempDir("loom-spec-check-missing-");
    dirs.push(dir);
    await expect(readSpecCheckReport(join(dir, "gone.jsonl"))).rejects.toThrow("no transcript exists");
  });
});
