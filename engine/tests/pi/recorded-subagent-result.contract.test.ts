/**
 * Contract test against a REAL recorded Pi `subagent` tool_result.
 *
 * Every other Pi capture test hand-builds its event (`input: {}`, `content: []`,
 * one text block, no `stopReason`). A real result differs: it carries the
 * spawn input, a summary `content` block, routing/usage/model fields, dozens
 * of intermediate assistant and toolResult messages, and a final assistant
 * message holding a `thinking` block beside the payload text. If Pi drifts
 * that shape, hand-built fixtures stay green while live capture breaks; this
 * replays the recorded envelope through the same seams production uses, from
 * `details.results` to the bytes in the reserved transcript slot.
 *
 * Refresh the fixture from a newer session when Pi's subagent tool changes —
 * see the fixture's `provenance` for how it was cut.
 */

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";
import { buildContextPacket, encodeByteSection } from "../../src/orchestration/context-packets";
import { openRunDirectory } from "../../src/orchestration/run-directory-handle";
import { captureHarnessResult } from "../../src/orchestration/harness-capture-runtime";
import { parsePiMessages, piResultFinalPayloadCandidates } from "../../../pi/transcript-adapter";
import { parsePiSubagentResults, piSilentStopNote, piSubagentResultFailed } from "../../../pi/subagent-result-batch";
import { piSpawnRosterId } from "../../../pi/tool-input";

const FIXTURE = fileURLToPath(new URL("../fixtures/pi-recorded/subagent-code-reviewer-result.json", import.meta.url));

type RecordedEvent = Readonly<{
  toolName: string;
  toolCallId: string;
  input: Readonly<{ agent: string; task: string }>;
  details: Readonly<{ results: readonly unknown[] }>;
}>;

const recorded = (): RecordedEvent => (JSON.parse(readFileSync(FIXTURE, "utf8")) as { event: RecordedEvent }).event;

/** The reviewer's answer as Pi recorded it: the text block of the last message. */
function recordedPayload(event: RecordedEvent): string {
  const result = event.details.results[0] as { messages: readonly { content: readonly { type: string; text?: string }[] }[] };
  const text = result.messages.at(-1)?.content.find(({ type }) => type === "text")?.text;
  if (text === undefined) throw new Error("fixture lost its final text block");
  return text;
}

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("a recorded Pi subagent result crosses every capture seam", () => {
  it("is a subagent result whose final message carries thinking beside the payload — the shape this test pins", () => {
    const event = recorded();
    expect(event.toolName).toBe("subagent");
    expect(event.input.agent).toBe("code-reviewer");
    const result = event.details.results[0] as { messages: readonly { role: string; content: readonly { type: string }[] }[] };
    expect(result.messages.length).toBeGreaterThan(2);
    expect(result.messages.some(({ role }) => role === "toolResult")).toBe(true);
    expect(result.messages.at(-1)?.content.map(({ type }) => type)).toEqual(["thinking", "text"]);
  });

  it("parses as a successful, non-silent result envelope", () => {
    const entries = parsePiSubagentResults(recorded().details.results);
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (entry === undefined || !entry.ok) throw new Error(`envelope refused: ${JSON.stringify(entry)}`);
    expect(entry.result.agent).toBe("code-reviewer");
    expect(piSubagentResultFailed(entry.result)).toBe(false);
    expect(piSilentStopNote(entry.result)).toBeNull();
  });

  it("parses the whole real transcript, intermediate tool traffic included", () => {
    const [entry] = parsePiSubagentResults(recorded().details.results);
    if (entry === undefined || !entry.ok) throw new Error("envelope refused");
    const parsed = parsePiMessages(entry.result.messages);
    expect(parsed.ok ? [] : parsed.errors).toEqual([]);
  });

  it("selects exactly the final text block as the payload, never the thinking", () => {
    const event = recorded();
    const [entry] = parsePiSubagentResults(event.details.results);
    if (entry === undefined || !entry.ok) throw new Error("envelope refused");
    const candidates = piResultFinalPayloadCandidates(entry.result.messages);
    expect(candidates.ok ? candidates.value.map(({ text }) => text) : candidates.errors).toEqual([recordedPayload(event)]);
  });

  it("captures the payload byte-exactly into the request's reserved slot", async () => {
    const event = recorded();
    const runsRoot = canonicalTempDir("loom-pi-recorded-");
    cleanup.push(runsRoot);
    const runDirectory = join(runsRoot, "run.pi-recorded");
    mkdirSync(runDirectory, { recursive: true });
    const opened = openRunDirectory(runsRoot, runDirectory);
    if (!opened.ok) throw new Error(opened.error.message);
    const base = agentRequestAuthority("run.pi-recorded", { role: "code-reviewer" });
    const section = encodeByteSection("test", "recorded Pi capture context");
    if (!section.ok) throw new Error(section.error.message);
    const packet = buildContextPacket({
      requestId: base.requestId, role: base.role, requiredSkill: "none",
      outputContract: "test output", fixedContext: [section.value], variableContext: [],
    });
    if (!packet.ok) throw new Error(packet.error.message);
    expect((await opened.value.publishContext(packet.value)).ok).toBe(true);
    const request: AgentRequestAuthority = { ...base, contextDigest: packet.value.digest };
    expect((await opened.value.reserveRequest(request)).ok).toBe(true);
    // The correlator the spawn side records for this exact recorded call.
    const nativeId = piSpawnRosterId(event.toolCallId, 0, event.input.agent);
    expect((await opened.value.recordHarnessCorrelator({
      schemaVersion: 1, harness: "pi", nativeId, requestId: request.requestId, role: request.role, attempt: request.attempt,
    })).ok).toBe(true);

    const [entry] = parsePiSubagentResults(event.details.results);
    if (entry === undefined || !entry.ok) throw new Error("envelope refused");
    const candidates = piResultFinalPayloadCandidates(entry.result.messages);
    if (!candidates.ok) throw new Error(candidates.errors.join("; "));
    const outcome = await captureHarnessResult({ harness: "pi", runsRoot, runDirectory, nativeId, candidates: candidates.value });

    expect(outcome.kind).toBe("captured");
    expect(readFileSync(join(runDirectory, "transcripts", request.slotId, `attempt-${request.attempt}.raw`), "utf8"))
      .toBe(recordedPayload(event));
  });
});
