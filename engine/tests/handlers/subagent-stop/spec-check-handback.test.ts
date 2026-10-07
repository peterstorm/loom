import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { canonicalTempDir } from "../../fixtures/canonical-temp-dir";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readSpecCheckReport,
  settleSpecCheckReportRead,
  specCheckTranscriptDelivery,
} from "../../../src/handlers/subagent-stop/store-spec-check-findings";
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

/** The parsed transcript the one settled read hands specCheckTranscriptDelivery. */
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

/** A handback turn whose last line is torn: the legacy text read tolerates it, the strict projection does not. */
const tornTurn = () => [...handbackTurn(REPORT).slice(0, 2), '{"type":"attachment","torn'];

describe("specCheckTranscriptDelivery", () => {
  it("reads a SubagentHandback report so its finding lines reconcile with the counts", () => {
    // Current Claude subagents deliver through SubagentHandback; the legacy
    // text read parses an echoed skill template instead of the delivered report.
    const path = transcript(handbackTurn(REPORT));
    expect(specCheckTranscriptDelivery(parsedAt(path), "legacy text"))
      .toEqual({ kind: "delivered", text: REPORT });
    const parsed = parseSpecCheckOutput(REPORT);
    expect(parsed.high).toEqual(["the pilot recorded 0 observations"]);
    expect(parsed.highCount).toBe(1);
  });

  it("keeps the legacy text when the final turn delivered no handback", () => {
    const path = transcript([{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: REPORT }] } }]);
    expect(specCheckTranscriptDelivery(parsedAt(path), "legacy text"))
      .toEqual({ kind: "delivered", text: "legacy text" });
  });

  it("keeps the legacy text when the handback failed, so nothing undelivered is parsed", () => {
    const path = transcript(handbackTurn(REPORT, true));
    expect(specCheckTranscriptDelivery(parsedAt(path), "legacy text"))
      .toEqual({ kind: "delivered", text: "legacy text" });
  });

  it("reports a torn final turn as corrupt, carrying the projection's typed error beside the legacy text", () => {
    const path = transcript(tornTurn());
    const delivery = specCheckTranscriptDelivery(parsedAt(path), "legacy text");
    if (delivery.kind !== "corrupt-final-turn") throw new Error(`expected a corrupt final turn, got ${delivery.kind}`);
    expect(delivery.legacyText).toBe("legacy text");
    expect(delivery.error).toMatch(/line/);
  });

  it("documents why the legacy read cannot reconcile a handback report", () => {
    const path = transcript(handbackTurn(REPORT));
    const legacy = parseSpecCheckOutput(parseTranscript(readFileSync(path, "utf8")));
    expect(legacy.high).toEqual([]);
  });
});

describe("readSpecCheckReport — one settled, bounded read, every outcome a value", () => {
  it("derives the delivered handback report from the same read that settled on the count marker", async () => {
    const path = transcript([
      { type: "user", message: { role: "user", content: "SPEC_CHECK_CRITICAL_COUNT: 0 (template echo)" } },
      ...handbackTurn(REPORT),
    ]);
    expect(await readSpecCheckReport(path)).toEqual({ kind: "delivered", text: REPORT });
  });

  it("returns the legacy text when no handback was delivered", async () => {
    const path = transcript([{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: REPORT }] } }]);
    expect(await readSpecCheckReport(path))
      .toEqual({ kind: "delivered", text: parseTranscript(readFileSync(path, "utf8")) });
  });

  it("returns a corrupt final turn as its own outcome with the legacy text of the same bytes", async () => {
    const path = transcript([
      { type: "user", message: { role: "user", content: "SPEC_CHECK_CRITICAL_COUNT: 0" } },
      ...tornTurn(),
    ]);
    expect(await readSpecCheckReport(path)).toMatchObject({
      kind: "corrupt-final-turn",
      legacyText: parseTranscript(readFileSync(path, "utf8")),
    });
  });

  it("returns a transcript over the read bound as unreadable instead of decoding it", async () => {
    const path = transcript(handbackTurn(REPORT));
    expect((await readSpecCheckReport(path, 64)).kind).toBe("unreadable");
  });

  it("returns a non-UTF-8 transcript as unreadable", async () => {
    const dir = canonicalTempDir("loom-spec-check-binary-");
    dirs.push(dir);
    const path = join(dir, "agent.jsonl");
    writeFileSync(path, Buffer.from([0xff, 0xfe, 0x0a]));
    expect((await readSpecCheckReport(path)).kind).toBe("unreadable");
  });

  it("returns a located transcript that no longer exists as missing rather than an empty report", async () => {
    const dir = canonicalTempDir("loom-spec-check-missing-");
    dirs.push(dir);
    const gone = join(dir, "gone.jsonl");
    expect(await readSpecCheckReport(gone)).toEqual({ kind: "missing", path: gone });
  });
});

describe("settleSpecCheckReportRead — the visible settlement policy", () => {
  it("settles a missing transcript as the byte-identical capture failure", () => {
    expect(settleSpecCheckReportRead({ kind: "missing", path: "/t/gone.jsonl" }))
      .toEqual({ kind: "failure", reason: "spec-check transcript is unreadable: no transcript exists at /t/gone.jsonl" });
  });

  it("settles an unreadable transcript as a capture failure carrying its cause", () => {
    expect(settleSpecCheckReportRead({ kind: "unreadable", message: "EISDIR" }))
      .toEqual({ kind: "failure", reason: "spec-check transcript is unreadable: EISDIR" });
  });

  it("parses the legacy text of a corrupt final turn and surfaces the typed error as a diagnostic", () => {
    const settled = settleSpecCheckReportRead({ kind: "corrupt-final-turn", error: "line 3 is not JSON", legacyText: "legacy" });
    if (settled.kind !== "report") throw new Error("expected a report");
    expect(settled.text).toBe("legacy");
    expect(settled.diagnostic).toContain("line 3 is not JSON");
  });

  it("parses a delivered report with no diagnostic", () => {
    expect(settleSpecCheckReportRead({ kind: "delivered", text: REPORT }))
      .toEqual({ kind: "report", text: REPORT, diagnostic: null });
  });
});
