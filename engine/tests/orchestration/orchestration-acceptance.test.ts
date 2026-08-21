import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";
import {
  bindCapture,
  captureKey,
  capturesAgree,
  parseFinalPayload,
  type FinalPayloadCandidate,
  type HarnessResultIdentity,
} from "../../src/core/harness-capture";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";
import captureOrchestrationResult, {
  alreadyCapturedAttempts,
  captureClaudeResult,
  claudeFinalPayloadCandidates,
  readIssuedRequests,
} from "../../src/handlers/subagent-stop/capture-orchestration-result";
import { recordClaudeSpawnCorrelation } from "../../src/handlers/post-tool-use/record-orchestration-spawn";
import { piFinalPayloadCandidates, piResultFinalPayloadCandidates } from "../../../pi/transcript-adapter";
import { openRunDirectory } from "../../src/orchestration/run-directory-handle";
import { captureAuditLine, captureHarnessResult } from "../../src/orchestration/harness-capture-runtime";
import { buildContextPacket, encodeByteSection } from "../../src/orchestration/context-packets";
import {
  BENCHMARK_SCENARIOS,
  characterCount,
  reduction,
  replayBenchmarkScenario,
  FACADE_STATUS_COMMANDS,
  LEGACY_STATUS_COMMANDS,
  REQUIRED_CALL_REDUCTION,
  REQUIRED_CHARACTER_REDUCTION,
} from "./benchmark-fixtures";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const authority = (overrides: Partial<AgentRequestAuthority> = {}): AgentRequestAuthority =>
  agentRequestAuthority("run.acceptance-1", overrides as Record<string, unknown>);

const identity = (overrides: Partial<HarnessResultIdentity> = {}): HarnessResultIdentity => ({
  harness: "claude",
  requestId: "request:reviewer:1",
  attempt: 1,
  nativeId: "agent-abc",
  ...overrides,
});

function payloadOf(text: string) {
  const parsed = parseFinalPayload([{ origin: "test", text }]);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

// --- Exactly one unambiguous final payload ----------------------------------

describe("final payload rules", () => {
  it("accepts exactly one candidate", () => {
    const parsed = parseFinalPayload([{ origin: "content[0].text", text: "VERDICT: PASSED" }]);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.text).toBe("VERDICT: PASSED");
  });

  it("refuses a result with no final payload", () => {
    const parsed = parseFinalPayload([]);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.reason).toBe("no-final-payload");
  });

  it("refuses an ambiguous result rather than picking one", () => {
    const parsed = parseFinalPayload([
      { origin: "content[0].text", text: "thinking out loud" },
      { origin: "content[2].text", text: "VERDICT: PASSED" },
    ]);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.reason).toBe("ambiguous-final-payload");
    // The diagnostic must name both, or an operator cannot tell what collided.
    expect(parsed.error.message).toContain("content[0].text");
    expect(parsed.error.message).toContain("content[2].text");
  });

  it("refuses an empty payload", () => {
    const parsed = parseFinalPayload([{ origin: "content[0].text", text: "" }]);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.reason).toBe("empty-final-payload");
  });

  it.each([
    ["leading and trailing whitespace", "  VERDICT: PASSED  \n\n"],
    ["interior blank lines", "line one\n\n\nline two"],
    ["a trailing newline", "VERDICT: PASSED\n"],
    ["CRLF line endings", "line one\r\nline two\r\n"],
    ["non-ASCII text", "verdict: passé — ✅"],
  ])("encodes %s verbatim, without normalising", (_label, text) => {
    const parsed = parseFinalPayload([{ origin: "content[0].text", text }]);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.text).toBe(text);
    expect(Buffer.from(Uint8Array.from(parsed.value.bytes)).toString("utf-8")).toBe(text);
    expect(parsed.value.byteLength).toBe(Buffer.byteLength(text, "utf-8"));
  });
});

// --- Cross-harness parity ---------------------------------------------------

describe("Pi and Claude reach the same result", () => {
  const AGENT_OUTPUT = "## Machine Summary\nCRITICAL_COUNT: 0\nADVISORY: prefer a narrower type\n";

  function piCandidates(text: string): readonly FinalPayloadCandidate[] {
    const extracted = piFinalPayloadCandidates([{ type: "text", text }]);
    if (!extracted.ok) throw new Error(extracted.errors.join("; "));
    return extracted.value;
  }

  function claudeCandidates(text: string): readonly FinalPayloadCandidate[] {
    const root = mkdtempSync(join(tmpdir(), "loom-parity-"));
    cleanup.push(root);
    const transcript = join(root, "transcript.jsonl");
    writeFileSync(transcript, `${JSON.stringify({
      message: { role: "assistant", content: [{ type: "text", text }] },
    })}\n`);
    return claudeFinalPayloadCandidates(transcript);
  }

  it("extracts byte-identical payloads from both harnesses", () => {
    const pi = parseFinalPayload(piCandidates(AGENT_OUTPUT));
    const claude = parseFinalPayload(claudeCandidates(AGENT_OUTPUT));

    expect(pi.ok && claude.ok).toBe(true);
    if (!pi.ok || !claude.ok) return;
    expect(pi.value.digest).toBe(claude.value.digest);
    expect(pi.value.bytes).toEqual(claude.value.bytes);
  });

  it("produces equivalent receipts differing only in harness provenance", () => {
    const pi = parseFinalPayload(piCandidates(AGENT_OUTPUT));
    const claude = parseFinalPayload(claudeCandidates(AGENT_OUTPUT));
    if (!pi.ok || !claude.ok) throw new Error("payload extraction failed");

    const piReceipt = bindCapture({
      issued: [authority()],
      identity: identity({ harness: "pi", nativeId: "toolcall-7" }),
      payload: pi.value,
    });
    const claudeReceipt = bindCapture({
      issued: [authority()],
      identity: identity({ harness: "claude", nativeId: "agent-abc" }),
      payload: claude.value,
    });

    expect(piReceipt.ok && claudeReceipt.ok).toBe(true);
    if (!piReceipt.ok || !claudeReceipt.ok) return;
    expect(capturesAgree(piReceipt.value, claudeReceipt.value)).toBe(true);
    expect(piReceipt.value.harness).not.toBe(claudeReceipt.value.harness);
  });

  it("refuses a multi-block result through both harness adapters", () => {
    const pi = piFinalPayloadCandidates([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
    expect(pi.ok).toBe(true);
    if (!pi.ok) return;

    const root = mkdtempSync(join(tmpdir(), "loom-parity-multiblock-"));
    cleanup.push(root);
    const transcript = join(root, "transcript.jsonl");
    writeFileSync(transcript, `${JSON.stringify({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
      },
    })}\n`);

    expect(parseFinalPayload(pi.value).ok).toBe(false);
    expect(parseFinalPayload(claudeFinalPayloadCandidates(transcript)).ok).toBe(false);
  });

  it("ignores non-text Pi blocks when collecting candidates", () => {
    const extracted = piFinalPayloadCandidates([
      { type: "toolCall", id: "t1", name: "read", arguments: {} },
      { type: "text", text: "the answer" },
    ]);

    expect(extracted.ok).toBe(true);
    if (!extracted.ok) return;
    expect(extracted.value).toHaveLength(1);
    expect(extracted.value[0]?.text).toBe("the answer");
  });

  // FR-033: both harnesses capture into the SAME engine-declared slot through
  // one runtime. Previously only Claude was wired — `piFinalPayloadCandidates`
  // existed with no production caller — so a Pi-driven run captured nothing and
  // silently skipped every request/attempt/slot-authority check Claude enforces
  // for the same run.
  describe("both harnesses capture through one run-directory runtime", () => {
    async function stagedRun(): Promise<Readonly<{
      runsRoot: string;
      directory: string;
      request: AgentRequestAuthority;
    }>> {
      const runsRoot = mkdtempSync(join(tmpdir(), "loom-capture-parity-"));
      cleanup.push(runsRoot);
      const directory = join(runsRoot, "run.capture-parity");
      mkdirSync(directory, { recursive: true });
      const opened = openRunDirectory(runsRoot, directory);
      if (!opened.ok) throw new Error(opened.error.message);
      // Publish the immutable request context before reservation, exactly as
      // the spawn side does; capture re-hashes this packet before accepting
      // evidence.
      const base = authority({ runId: "run.capture-parity" as AgentRequestAuthority["runId"] });
      const section = encodeByteSection("test", "capture parity context");
      if (!section.ok) throw new Error(section.error.message);
      const packet = buildContextPacket({
        requestId: base.requestId,
        role: base.role,
        requiredSkill: "none",
        outputContract: "test output",
        fixedContext: [section.value],
        variableContext: [],
      });
      if (!packet.ok) throw new Error(packet.error.message);
      if (!(await opened.value.publishContext(packet.value)).ok) throw new Error("context publication failed");
      const request = authority({
        runId: "run.capture-parity" as AgentRequestAuthority["runId"],
        contextDigest: packet.value.digest,
      });
      const reserved = await opened.value.reserveRequest(request);
      if (!reserved.ok) throw new Error(reserved.error.message);
      return { runsRoot, directory, request };
    }

    async function correlate(
      runsRoot: string,
      directory: string,
      harness: "pi" | "claude",
      nativeId: string,
      request: AgentRequestAuthority,
    ): Promise<void> {
      const opened = openRunDirectory(runsRoot, directory);
      if (!opened.ok) throw new Error(opened.error.message);
      const recorded = await opened.value.recordHarnessCorrelator({
        schemaVersion: 1,
        harness,
        nativeId,
        requestId: request.requestId,
        role: request.role,
        attempt: request.attempt,
      });
      if (!recorded.ok) throw new Error(recorded.error.message);
    }

    it("captures a Pi result into its reserved slot", async () => {
      const { runsRoot, directory, request } = await stagedRun();
      await correlate(runsRoot, directory, "pi", "pi-native-1", request);

      const outcome = await captureHarnessResult({
        harness: "pi",
        runsRoot,
        runDirectory: directory,
        nativeId: "pi-native-1",
        candidates: piCandidates(AGENT_OUTPUT),
      });

      expect(outcome.kind).toBe("captured");
      if (outcome.kind !== "captured") return;
      expect(outcome.receipt.harness).toBe("pi");
      expect(
        readFileSync(join(directory, "transcripts", request.slotId, `attempt-${request.attempt}.raw`), "utf-8"),
      ).toBe(AGENT_OUTPUT);
    });

    it("rejects capture when the reserved immutable context was tampered with", async () => {
      const { runsRoot, directory, request } = await stagedRun();
      await correlate(runsRoot, directory, "pi", "pi-native-context", request);
      writeFileSync(join(directory, "contexts", `${request.contextDigest}.json`), "{}");

      const outcome = await captureHarnessResult({
        harness: "pi",
        runsRoot,
        runDirectory: directory,
        nativeId: "pi-native-context",
        candidates: piCandidates(AGENT_OUTPUT),
      });

      expect(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected") expect(outcome.reason).toBe("context");
    });

    it("rejects capture when the reserved context describes a different request role", async () => {
      const runsRoot = mkdtempSync(join(tmpdir(), "loom-capture-binding-"));
      cleanup.push(runsRoot);
      const directory = join(runsRoot, "run.capture-binding");
      mkdirSync(directory, { recursive: true });
      const opened = openRunDirectory(runsRoot, directory);
      if (!opened.ok) throw new Error(opened.error.message);
      const base = authority({ runId: "run.capture-binding" as AgentRequestAuthority["runId"] });
      const section = encodeByteSection("test", "capture parity context");
      if (!section.ok) throw new Error(section.error.message);
      // A legitimate packet whose identity is NOT the reserved request: the
      // request is reserved against the foreign packet's digest. The capture
      // boundary's explicit context-binding comparison is the only defense
      // left, and it must refuse instead of accepting evidence whose context
      // describes another request role.
      const foreign = buildContextPacket({
        requestId: base.requestId,
        role: "silent-failure-hunter",
        requiredSkill: "none",
        outputContract: "test output",
        fixedContext: [section.value],
        variableContext: [],
      });
      if (!foreign.ok) throw new Error(foreign.error.message);
      if (!(await opened.value.publishContext(foreign.value)).ok) {
        throw new Error("context publication failed");
      }
      const request = authority({
        runId: "run.capture-binding" as AgentRequestAuthority["runId"],
        contextDigest: foreign.value.digest,
      });
      const reserved = await opened.value.reserveRequest(request);
      if (!reserved.ok) throw new Error(reserved.error.message);
      await correlate(runsRoot, directory, "pi", "pi-native-context-foreign", request);

      const outcome = await captureHarnessResult({
        harness: "pi",
        runsRoot,
        runDirectory: directory,
        nativeId: "pi-native-context-foreign",
        candidates: piCandidates(AGENT_OUTPUT),
      });

      expect(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected") expect(outcome.reason).toBe("context-binding");
    });

    it("rejects capture when a stored correlator names a role the issued request does not have", async () => {
      const { runsRoot, directory, request } = await stagedRun();
      // A correlator planted directly into the run directory (bypassing the
      // handle's record-time role check) is structurally valid; the capture
      // boundary must still refuse it at read time.
      const nativeId = "pi-native-wrong-role";
      const digest = createHash("sha256").update(`pi\0${nativeId}`).digest("hex");
      writeFileSync(
        join(directory, "requests", "correlators", `${digest}.json`),
        JSON.stringify({
          schemaVersion: 1,
          harness: "pi",
          nativeId,
          requestId: request.requestId,
          role: "silent-failure-hunter",
          attempt: request.attempt,
        }),
      );

      const outcome = await captureHarnessResult({
        harness: "pi",
        runsRoot,
        runDirectory: directory,
        nativeId,
        candidates: piCandidates(AGENT_OUTPUT),
      });

      expect(outcome.kind).toBe("rejected");
      if (outcome.kind === "rejected") expect(outcome.reason).toBe("wrong-agent-role");
    });

    it("writes byte-identical transcripts from either harness", async () => {
      const pi = await stagedRun();
      await correlate(pi.runsRoot, pi.directory, "pi", "pi-native-1", pi.request);
      const claude = await stagedRun();
      await correlate(claude.runsRoot, claude.directory, "claude", "claude-native-1", claude.request);

      const piOutcome = await captureHarnessResult({
        harness: "pi",
        runsRoot: pi.runsRoot,
        runDirectory: pi.directory,
        nativeId: "pi-native-1",
        candidates: piCandidates(AGENT_OUTPUT),
      });
      const claudeOutcome = await captureHarnessResult({
        harness: "claude",
        runsRoot: claude.runsRoot,
        runDirectory: claude.directory,
        nativeId: "claude-native-1",
        candidates: claudeCandidates(AGENT_OUTPUT),
      });

      expect(piOutcome.kind).toBe("captured");
      expect(claudeOutcome.kind).toBe("captured");
      if (piOutcome.kind !== "captured" || claudeOutcome.kind !== "captured") return;
      expect(capturesAgree(piOutcome.receipt, claudeOutcome.receipt)).toBe(true);
    });

    it("applies the same refusals to a Pi result as to a Claude one", async () => {
      const { runsRoot, directory, request } = await stagedRun();
      await correlate(runsRoot, directory, "pi", "pi-native-1", request);

      // Unknown correlator: someone else's agent, ignored rather than failed.
      expect((await captureHarnessResult({
        harness: "pi",
        runsRoot,
        runDirectory: directory,
        nativeId: "not-this-run",
        candidates: piCandidates(AGENT_OUTPUT),
      })).kind).toBe("no-reservation");

      // Ambiguous final payload: refused on both harnesses alike.
      const ambiguous = piFinalPayloadCandidates([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]);
      if (!ambiguous.ok) throw new Error("candidate extraction failed");
      expect((await captureHarnessResult({
        harness: "pi",
        runsRoot,
        runDirectory: directory,
        nativeId: "pi-native-1",
        candidates: ambiguous.value,
      })).kind).toBe("rejected");

      // A semantically rejected attempt is terminal. Later bytes cannot
      // overwrite the rejection; recovery must use exact attempt-2 authority.
      const late = await captureHarnessResult({
        harness: "pi",
        runsRoot,
        runDirectory: directory,
        nativeId: "pi-native-1",
        candidates: piCandidates(AGENT_OUTPUT),
      });
      expect(late.kind).toBe("rejected");
      if (late.kind !== "rejected") return;
      expect(late.reason).toBe("transcript");
      expect(late.message).toContain("terminally rejected");
    });

    it("is inert outside an orchestration run", async () => {
      expect((await captureHarnessResult({
        harness: "pi",
        runsRoot: undefined,
        runDirectory: undefined,
        nativeId: "pi-native-1",
        candidates: piCandidates(AGENT_OUTPUT),
      })).kind).toBe("not-an-orchestration-run");
    });

    it("rejects and audits malformed correlator authority", async () => {
      const { runsRoot, directory, request } = await stagedRun();
      await correlate(runsRoot, directory, "pi", "pi-native-1", request);
      const correlatorDir = join(directory, "requests", "correlators");
      const file = readdirSync(correlatorDir)[0]!;
      writeFileSync(join(correlatorDir, file), "{broken", "utf-8");

      const outcome = await captureHarnessResult({
        harness: "pi",
        runsRoot,
        runDirectory: directory,
        nativeId: "pi-native-1",
        candidates: piCandidates(AGENT_OUTPUT),
      });

      expect(outcome.kind).toBe("rejected");
      expect(captureAuditLine("capture", outcome)).toContain("rejected (correlator)");
    });

    it("refuses a symlinked correlator without reading its target", async () => {
      const { runsRoot, directory, request } = await stagedRun();
      await correlate(runsRoot, directory, "pi", "pi-native-1", request);
      const correlatorDir = join(directory, "requests", "correlators");
      const file = readdirSync(correlatorDir)[0]!;
      const outside = join(runsRoot, "outside-correlator.json");
      writeFileSync(outside, JSON.stringify({
        schemaVersion: 1,
        harness: "pi",
        nativeId: "pi-native-1",
        requestId: request.requestId,
        attempt: 1,
      }));
      rmSync(join(correlatorDir, file));
      symlinkSync(outside, join(correlatorDir, file));

      const outcome = await captureHarnessResult({
        harness: "pi",
        runsRoot,
        runDirectory: directory,
        nativeId: "pi-native-1",
        candidates: piCandidates(AGENT_OUTPUT),
      });

      expect(outcome.kind).toBe("rejected");
      if (outcome.kind !== "rejected") return;
      expect(outcome.reason).toBe("correlator");
    });
  });

  // The Pi adapter reads the LAST assistant message, mirroring Claude's last
  // assistant transcript line; anything earlier is mid-conversation.
  describe("piResultFinalPayloadCandidates", () => {
    it("takes the final assistant message, not an earlier one", () => {
      const extracted = piResultFinalPayloadCandidates([
        { role: "assistant", content: [{ type: "text", text: "thinking out loud" }] },
        { role: "user", content: [{ type: "text", text: "continue" }] },
        { role: "assistant", content: [{ type: "text", text: AGENT_OUTPUT }] },
      ]);

      expect(extracted.ok).toBe(true);
      if (!extracted.ok) return;
      expect(extracted.value).toHaveLength(1);
      expect(extracted.value[0]?.text).toBe(AGENT_OUTPUT);
    });

    it("still refuses an ambiguous final message rather than picking one block", () => {
      const extracted = piResultFinalPayloadCandidates([
        { role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
      ]);

      expect(extracted.ok).toBe(true);
      if (!extracted.ok) return;
      expect(parseFinalPayload(extracted.value).ok).toBe(false);
    });

    it("yields no candidate for malformed messages instead of guessing", () => {
      expect(piResultFinalPayloadCandidates("not a message list").ok).toBe(false);
      const none = piResultFinalPayloadCandidates([
        { role: "user", content: [{ type: "text", text: "only a user turn" }] },
      ]);
      expect(none.ok).toBe(true);
      if (!none.ok) return;
      expect(none.value).toHaveLength(0);
    });
  });

  it("surfaces malformed final Claude JSON with its physical line number", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-claude-malformed-"));
    cleanup.push(root);
    const transcript = join(root, "transcript.jsonl");
    writeFileSync(transcript, [
      JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "earlier" }] } }),
      "",
      "{truncated-final",
    ].join("\n"));

    expect(() => claudeFinalPayloadCandidates(transcript))
      .toThrow(/invalid final Claude transcript JSON at line 3:.*JSON/);
  });

  it("surfaces an unreadable Claude transcript instead of returning no candidates", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-claude-loop-"));
    cleanup.push(root);
    const transcript = join(root, "loop.jsonl");
    // A symlink loop makes the transcript ELOOP: the filesystem cause must
    // surface (an existsSync pre-check would have turned it into silence).
    symlinkSync(transcript, transcript);

    expect(() => claudeFinalPayloadCandidates(transcript))
      .toThrow(/cannot read Claude transcript/);
  });
});

// --- Invalid evidence classes -----------------------------------------------

describe("invalid evidence is audited but never accepted", () => {
  const payload = () => payloadOf("VERDICT: PASSED");

  it("refuses a result claiming a request the run never issued", () => {
    const bound = bindCapture({
      issued: [authority()],
      identity: identity({ requestId: "request:someone-else:1" }),
      payload: payload(),
    });

    expect(bound.ok).toBe(false);
    if (bound.ok) return;
    expect(bound.error.reason).toBe("unknown-request");
  });

  it("refuses a result claiming the wrong attempt", () => {
    const bound = bindCapture({
      issued: [authority()],
      identity: identity({ attempt: 2 }),
      payload: payload(),
    });

    expect(bound.ok).toBe(false);
    if (bound.ok) return;
    expect(bound.error.reason).toBe("attempt-mismatch");
  });

  it("refuses a late or duplicate result for a slot that already landed", () => {
    const bound = bindCapture({
      issued: [authority()],
      identity: identity(),
      payload: payload(),
      alreadyCaptured: new Set([captureKey("slot-1", 1)]),
    });

    expect(bound.ok).toBe(false);
    if (bound.ok) return;
    expect(bound.error.reason).toBe("duplicate-capture");
  });

  it("permits the canonical attempt-2 request after attempt 1 was captured", () => {
    const retry = authority({
      requestId: "request:reviewer:2" as AgentRequestAuthority["requestId"],
      attempt: 2,
      outputSlot: { kind: "fixed-artifact-slot", path: "transcripts/slot-1/attempt-2.raw" },
    });
    const bound = bindCapture({
      issued: [retry],
      identity: identity({ requestId: retry.requestId, attempt: 2 }),
      payload: payload(),
      alreadyCaptured: new Set([captureKey("slot-1", 1)]),
    });

    expect(bound.ok).toBe(true);
  });

  it("refuses a result carrying no native correlator", () => {
    const bound = bindCapture({
      issued: [authority()],
      identity: identity({ nativeId: "" }),
      payload: payload(),
    });

    expect(bound.ok).toBe(false);
    if (bound.ok) return;
    expect(bound.error.reason).toBe("identity-mismatch");
  });

  it("accepts a valid sibling while its neighbour is refused", () => {
    const issued = [authority(), authority({
      requestId: "request:reviewer:2" as AgentRequestAuthority["requestId"],
      slotId: "slot-2" as AgentRequestAuthority["slotId"],
    })];

    const refused = bindCapture({ issued, identity: identity({ requestId: "ghost" }), payload: payload() });
    const accepted = bindCapture({
      issued,
      identity: identity({ requestId: "request:reviewer:2" }),
      payload: payload(),
    });

    expect(refused.ok).toBe(false);
    expect(accepted.ok).toBe(true);
  });
});

// --- End-to-end Claude capture ----------------------------------------------

describe("Claude capture against a real run directory", () => {
  async function stagedRun(): Promise<Readonly<{ runsRoot: string; runDir: string }>> {
    const root = mkdtempSync(join(tmpdir(), "loom-capture-run-"));
    cleanup.push(root);
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run.acceptance-1");
    mkdirSync(runDir, { recursive: true });

    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    const base = authority();
    const section = encodeByteSection("test", "Claude capture context");
    if (!section.ok) throw new Error(section.error.message);
    const packet = buildContextPacket({
      requestId: base.requestId,
      role: base.role,
      requiredSkill: "none",
      outputContract: "test output",
      fixedContext: [section.value],
      variableContext: [],
    });
    if (!packet.ok) throw new Error(packet.error.message);
    if (!(await opened.value.publishContext(packet.value)).ok) throw new Error("context publication failed");
    const request = authority({ contextDigest: packet.value.digest });
    const reserved = await opened.value.reserveRequest(request);
    if (!reserved.ok) throw new Error(reserved.error.message);
    const previousRoot = process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
    const previousRun = process.env.LOOM_ORCHESTRATION_RUN_DIR;
    process.env.LOOM_ORCHESTRATION_RUNS_ROOT = runsRoot;
    process.env.LOOM_ORCHESTRATION_RUN_DIR = runDir;
    try {
      const correlated = await recordClaudeSpawnCorrelation({
        tool_name: "Agent",
        tool_input: {
          subagent_type: "code-reviewer",
          prompt: `LOOM_REQUEST_ID: ${request.requestId}\nReview the reserved packet`,
        },
        tool_response: { agent_id: "agent-abc" },
      });
      if (correlated.kind === "error") throw new Error(correlated.message);
    } finally {
      if (previousRoot === undefined) delete process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
      else process.env.LOOM_ORCHESTRATION_RUNS_ROOT = previousRoot;
      if (previousRun === undefined) delete process.env.LOOM_ORCHESTRATION_RUN_DIR;
      else process.env.LOOM_ORCHESTRATION_RUN_DIR = previousRun;
    }
    return { runsRoot, runDir };
  }

  function transcript(root: string, text: string): string {
    const path = join(root, `transcript-${Buffer.from(text).length}.jsonl`);
    writeFileSync(path, `${JSON.stringify({
      message: { role: "assistant", content: [{ type: "text", text }] },
    })}\n`);
    return path;
  }

  it("persists exact Claude native-id/request/role authority at spawn acceptance", async () => {
    const { runsRoot, runDir } = await stagedRun();
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);

    const binding = opened.value.readHarnessCorrelator("claude", "agent-abc");
    expect(binding.ok).toBe(true);
    if (!binding.ok) return;
    expect(binding.value).toMatchObject({
      requestId: "request:reviewer:1",
      role: "code-reviewer",
      attempt: 1,
    });
  });

  it("rejects a Claude spawn whose exact request belongs to another role", async () => {
    const { runsRoot, runDir } = await stagedRun();
    const previousRoot = process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
    const previousRun = process.env.LOOM_ORCHESTRATION_RUN_DIR;
    process.env.LOOM_ORCHESTRATION_RUNS_ROOT = runsRoot;
    process.env.LOOM_ORCHESTRATION_RUN_DIR = runDir;
    try {
      const result = await recordClaudeSpawnCorrelation({
        tool_name: "Agent",
        tool_input: {
          subagent_type: "silent-failure-hunter",
          prompt: "LOOM_REQUEST_ID: request:reviewer:1\nReview",
        },
        tool_response: { agent_id: "agent-wrong-role" },
      });
      expect(result).toMatchObject({ kind: "error", message: expect.stringContaining("belongs to code-reviewer") });
      const opened = openRunDirectory(runsRoot, runDir);
      if (!opened.ok) throw new Error(opened.error.message);
      expect(opened.value.readHarnessCorrelator("claude", "agent-wrong-role")).toMatchObject({ ok: true, value: null });
    } finally {
      if (previousRoot === undefined) delete process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
      else process.env.LOOM_ORCHESTRATION_RUNS_ROOT = previousRoot;
      if (previousRun === undefined) delete process.env.LOOM_ORCHESTRATION_RUN_DIR;
      else process.env.LOOM_ORCHESTRATION_RUN_DIR = previousRun;
    }
  });

  it("captures a reserved request's exact bytes", async () => {
    const { runsRoot, runDir } = await stagedRun();
    const text = "## Machine Summary\nCRITICAL_COUNT: 0\n";

    const outcome = await captureClaudeResult(
      { session_id: "s1", agent_id: "agent-abc", agent_type: "code-reviewer", agent_transcript_path: transcript(runDir, text) },
      runsRoot,
      runDir,
    );

    expect(outcome.kind).toBe("captured");
    if (outcome.kind !== "captured") return;
    expect(outcome.receipt.byteLength).toBe(Buffer.byteLength(text, "utf-8"));
  });

  it("reports a stop that matches no reservation instead of capturing it", async () => {
    const { runsRoot, runDir } = await stagedRun();

    const outcome = await captureClaudeResult(
      { session_id: "s1", agent_id: "some-other-agent", agent_type: "code-reviewer", agent_transcript_path: transcript(runDir, "hello") },
      runsRoot,
      runDir,
    );

    expect(outcome.kind).toBe("no-reservation");
  });

  it("audits and errors when request-bound authority has no matching reservation", async () => {
    const { runsRoot, runDir } = await stagedRun();
    const previousRoot = process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
    const previousRun = process.env.LOOM_ORCHESTRATION_RUN_DIR;
    process.env.LOOM_ORCHESTRATION_RUNS_ROOT = runsRoot;
    process.env.LOOM_ORCHESTRATION_RUN_DIR = runDir;
    try {
      const result = await captureOrchestrationResult(JSON.stringify({
        session_id: "s1",
        agent_id: "missing-correlator",
        agent_type: "code-reviewer",
        agent_transcript_path: transcript(runDir, "unbound result"),
      }), []);

      expect(result).toEqual({
        kind: "error",
        message: "request-bound capture found no reservation for missing-correlator",
      });
      expect(captureAuditLine("capture", {
        kind: "no-reservation",
        agentId: "missing-correlator",
      })).toBe("capture: no reservation for missing-correlator\n");
    } finally {
      if (previousRoot === undefined) delete process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
      else process.env.LOOM_ORCHESTRATION_RUNS_ROOT = previousRoot;
      if (previousRun === undefined) delete process.env.LOOM_ORCHESTRATION_RUN_DIR;
      else process.env.LOOM_ORCHESTRATION_RUN_DIR = previousRun;
    }
  });

  it("is inert for an agent that is not part of an orchestration run", async () => {
    const outcome = await captureClaudeResult(
      { session_id: "s1", agent_id: "agent-abc", agent_type: "code-reviewer" },
      undefined,
      undefined,
    );

    expect(outcome.kind).toBe("not-an-orchestration-run");
  });

  it("rejects partially configured run authority instead of silently treating it as unrelated", async () => {
    const outcome = await captureHarnessResult({
      harness: "pi",
      runsRoot: "/tmp/loom-runs",
      runDirectory: undefined,
      nativeId: "pi-agent",
      candidates: [],
    });

    expect(outcome).toEqual({
      kind: "rejected",
      reason: "run-authority",
      message: "orchestration capture requires both runsRoot and runDirectory",
    });
  });

  it("refuses a second capture for a slot that already landed", async () => {
    const { runsRoot, runDir } = await stagedRun();
    const first = await captureClaudeResult(
      { session_id: "s1", agent_id: "agent-abc", agent_type: "code-reviewer", agent_transcript_path: transcript(runDir, "first result") },
      runsRoot,
      runDir,
    );
    expect(first.kind).toBe("captured");

    const second = await captureClaudeResult(
      { session_id: "s1", agent_id: "agent-abc", agent_type: "code-reviewer", agent_transcript_path: transcript(runDir, "second result") },
      runsRoot,
      runDir,
    );

    expect(second.kind).toBe("rejected");
    if (second.kind !== "rejected") return;
    expect(second.reason).toBe("duplicate-capture");
  });

  it("reads back every issued request and no more", async () => {
    const { runsRoot, runDir } = await stagedRun();
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);

    expect(readIssuedRequests(opened.value).map(({ requestId }) => requestId)).toEqual(["request:reviewer:1"]);
    expect([...alreadyCapturedAttempts(opened.value)]).toEqual([]);
  });

  it("refuses an ambiguous transcript rather than salvaging one block", async () => {
    const { runsRoot, runDir } = await stagedRun();
    const path = join(runDir, "ambiguous.jsonl");
    writeFileSync(path, `${JSON.stringify({
      message: { role: "assistant", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] },
    })}\n`);

    const outcome = await captureClaudeResult(
      { session_id: "s1", agent_id: "agent-abc", agent_type: "code-reviewer", agent_transcript_path: path },
      runsRoot,
      runDir,
    );

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.reason).toBe("no-final-payload");
  });

  it("reports an interrupted final transcript record without salvaging an earlier payload", async () => {
    const { runsRoot, runDir } = await stagedRun();
    const path = join(runDir, "truncated.jsonl");
    // A crash mid-write leaves a partial final line.
    writeFileSync(path, `${JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "ok" }] } })}\n{"message":{"role":"assist`);

    const outcome = await captureClaudeResult(
      { session_id: "s1", agent_id: "agent-abc", agent_type: "code-reviewer", agent_transcript_path: path },
      runsRoot,
      runDir,
    );

    // A malformed terminal record invalidates the final-payload boundary; an
    // earlier assistant message is never salvaged as canonical evidence.
    expect(outcome).toMatchObject({
      kind: "rejected",
      reason: "transcript-json",
      message: expect.stringContaining("invalid final Claude transcript JSON at line 2"),
    });
  });

  it("reports a missing transcript rather than capturing nothing silently", async () => {
    const { runsRoot, runDir } = await stagedRun();

    const outcome = await captureClaudeResult(
      { session_id: "s1", agent_id: "agent-abc", agent_type: "code-reviewer", agent_transcript_path: join(runDir, "absent.jsonl") },
      runsRoot,
      runDir,
    );

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.reason).toBe("no-final-payload");
  });

  it("returns a hook error for partial or malformed Claude run authority", async () => {
    const previousRoot = process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
    const previousRun = process.env.LOOM_ORCHESTRATION_RUN_DIR;
    process.env.LOOM_ORCHESTRATION_RUNS_ROOT = "/tmp/loom-partial-run-root";
    delete process.env.LOOM_ORCHESTRATION_RUN_DIR;
    try {
      const partial = await captureOrchestrationResult(JSON.stringify({
        session_id: "s1", agent_id: "agent-abc", agent_type: "code-reviewer",
      }), []);
      expect(partial).toMatchObject({ kind: "error", message: expect.stringContaining("requires both") });

      const malformed = await captureOrchestrationResult("{broken", []);
      expect(malformed).toMatchObject({ kind: "error", message: expect.stringContaining("malformed SubagentStop JSON") });
    } finally {
      if (previousRoot === undefined) delete process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
      else process.env.LOOM_ORCHESTRATION_RUNS_ROOT = previousRoot;
      if (previousRun === undefined) delete process.env.LOOM_ORCHESTRATION_RUN_DIR;
      else process.env.LOOM_ORCHESTRATION_RUN_DIR = previousRun;
    }
  });

  it("returns a hook error for rejected request-bound Claude capture", async () => {
    const { runsRoot, runDir } = await stagedRun();
    const previousRoot = process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
    const previousRun = process.env.LOOM_ORCHESTRATION_RUN_DIR;
    process.env.LOOM_ORCHESTRATION_RUNS_ROOT = runsRoot;
    process.env.LOOM_ORCHESTRATION_RUN_DIR = runDir;
    try {
      const result = await captureOrchestrationResult(JSON.stringify({
        session_id: "s1",
        agent_id: "agent-abc",
        agent_type: "code-reviewer",
        agent_transcript_path: join(runDir, "absent.jsonl"),
      }), []);
      expect(result.kind).toBe("error");
    } finally {
      if (previousRoot === undefined) delete process.env.LOOM_ORCHESTRATION_RUNS_ROOT;
      else process.env.LOOM_ORCHESTRATION_RUNS_ROOT = previousRoot;
      if (previousRun === undefined) delete process.env.LOOM_ORCHESTRATION_RUN_DIR;
      else process.env.LOOM_ORCHESTRATION_RUN_DIR = previousRun;
    }
  });
});

// --- Benchmark ---------------------------------------------------------------

describe("deterministic parent-call benchmark", () => {
  it.each(BENCHMARK_SCENARIOS)("replays $id to the same canonical terminal outcome and artifacts", (scenario) => {
    const legacy = replayBenchmarkScenario(scenario, "legacy");
    const facade = replayBenchmarkScenario(scenario, "facade");

    expect(facade.terminal).toBe(legacy.terminal);
    expect(facade.artifacts).toEqual(legacy.artifacts);
  });

  it("covers all five approved lifecycle scenarios", () => {
    expect(BENCHMARK_SCENARIOS.map(({ id }) => id)).toEqual([
      "two-task-clean-wave",
      "missing-reviewer-retry",
      "mixed-refutation-wave",
      "standalone-six-reviewers",
      "remediation-add-delete",
    ]);
  });

  it("moves journals, transcript publication, model loops, and raw-output embedding out of facade calls", () => {
    const forbidden = FACADE_STATUS_COMMANDS.filter((command) =>
      /\bjq\b|active_task_graph\.json|model-profiles agent|reviewers\/\d+\.md|review-panel verdict|GIT_INDEX_FILE/.test(command));
    expect(forbidden).toEqual([]);
  });

  // Measured from the transcribed command sequences, never from prose.
  const legacyCalls = LEGACY_STATUS_COMMANDS.length;
  const facadeCalls = FACADE_STATUS_COMMANDS.length;
  const legacyChars = characterCount(LEGACY_STATUS_COMMANDS);
  const facadeChars = characterCount(FACADE_STATUS_COMMANDS);

  it("cuts deterministic parent calls by at least the mandated 70%", () => {
    expect(reduction(legacyCalls, facadeCalls)).toBeGreaterThanOrEqual(REQUIRED_CALL_REDUCTION);
  });

  it("cuts emitted command characters by at least the mandated 80%", () => {
    expect(reduction(legacyChars, facadeChars)).toBeGreaterThanOrEqual(REQUIRED_CHARACTER_REDUCTION);
  });

  it("emits zero parent-side jq invocations against the protected state file", () => {
    const offending = FACADE_STATUS_COMMANDS.filter(
      (command) => command.includes("jq") || command.includes("active_task_graph.json"),
    );

    // A mandated zero count: the façade must not have simply renamed the
    // recipes it replaced.
    expect(offending).toEqual([]);
  });

  it("keeps the fixtures honest — a shrunk legacy set cannot fake the win", () => {
    // If someone trims the legacy fixture to make the ratio look better, the
    // absolute floor catches it: the recipes really were this many.
    expect(legacyCalls).toBeGreaterThanOrEqual(8);
    expect(legacyChars).toBeGreaterThanOrEqual(800);
  });
});

