/**
 * Contract test against a REAL recorded Pi `subagent` tool_result.
 *
 * Every other Pi capture test hand-builds its event (`input: {}`, `content: []`,
 * one text block, no `stopReason`). A real result differs: it carries the
 * spawn input, a summary `content` block, routing/usage/model fields, dozens
 * of intermediate assistant and toolResult messages, and a final assistant
 * message holding a `thinking` block beside the payload text. If Pi drifts
 * that shape, hand-built fixtures stay green while live capture breaks.
 *
 * These cases pin each seam on its own, so a drift names the seam it broke.
 * The same event through the real extension `tool_result` handler is pinned
 * beside the other extension capture cases in `pi-extension-review-events.test.ts`.
 *
 * Refresh the fixture from a newer session when Pi's subagent tool changes —
 * see the fixture's `provenance` for how it was cut.
 */

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import { recordedSubagentEvent } from "../fixtures/pi-recorded/recorded-subagent-result";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";
import { buildContextPacket, encodeByteSection } from "../../src/orchestration/context-packets";
import { openRunDirectory } from "../../src/orchestration/run-directory-handle";
import { captureHarnessResult } from "../../src/orchestration/harness-capture-runtime";
import { parsePiMessages, piResultFinalPayloadCandidates } from "../../../pi/transcript-adapter";
import { parsePiSubagentResults, piSilentStopNote, piSubagentResultFailed } from "../../../pi/subagent-result-batch";
import { piSpawnRosterId } from "../../../pi/tool-input";

/** The recorded result, as the production envelope parser accepts it. */
function recordedEntry() {
  const entries = parsePiSubagentResults(recordedSubagentEvent().results);
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined || !entry.ok) {
    throw new Error(`envelope refused: ${JSON.stringify(entries)}`);
  }
  return entry.result;
}

/** The recorded result's payload candidates, as production selects them. */
function recordedCandidates() {
  const candidates = piResultFinalPayloadCandidates(recordedEntry().messages);
  if (!candidates.ok) throw new Error(`payload selection refused: ${candidates.errors.join("; ")}`);
  return candidates.value;
}

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("a recorded Pi subagent result crosses every capture seam", () => {
  it("is a subagent result whose final message carries thinking beside the payload — the shape this test pins", () => {
    const event = recordedSubagentEvent();
    expect(event.toolName).toBe("subagent");
    expect(event.input.agent).toBe("code-reviewer");
    expect(event.messages.length).toBeGreaterThan(2);
    expect(event.messages.some(({ role }) => role === "toolResult")).toBe(true);
    expect(event.messages.at(-1)?.content.map(({ type }) => type)).toEqual(["thinking", "text"]);
  });

  it("parses as a successful, non-silent result envelope", () => {
    const result = recordedEntry();
    expect(result.agent).toBe("code-reviewer");
    expect(piSubagentResultFailed(result)).toBe(false);
    expect(piSilentStopNote(result)).toBeNull();
  });

  it("parses the whole real transcript, intermediate tool traffic included", () => {
    const parsed = parsePiMessages(recordedEntry().messages);
    expect(parsed.ok ? [] : parsed.errors).toEqual([]);
  });

  it("selects exactly the final text block as the payload, never the thinking", () => {
    expect(recordedCandidates().map(({ text }) => text)).toEqual([recordedSubagentEvent().payload]);
  });

  it("captures the payload byte-exactly into the request's reserved slot", async () => {
    const event = recordedSubagentEvent();
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

    const outcome = await captureHarnessResult({ harness: "pi", runsRoot, runDirectory, nativeId, candidates: recordedCandidates() });

    expect(outcome.kind).toBe("captured");
    expect(readFileSync(join(runDirectory, "transcripts", request.slotId, `attempt-${request.attempt}.raw`), "utf8"))
      .toBe(event.payload);
  });
});
