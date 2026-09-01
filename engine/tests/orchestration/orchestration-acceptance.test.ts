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
  captureClaudeResult,
  claudeFinalPayloadCandidates,
} from "../../src/handlers/subagent-stop/capture-orchestration-result";
import { recordClaudeSpawnCorrelation } from "../../src/handlers/post-tool-use/record-orchestration-spawn";
import { piFinalPayloadCandidates, piResultFinalPayloadCandidates } from "../../../pi/transcript-adapter";
import { openRunDirectory, type RunDirHandle } from "../../src/orchestration/run-directory-handle";
import {
  captureAuditLine,
  captureHarnessResult,
  resolveCorrelatedRequest,
  terminalCaptureRefusal,
  terminalizeCaptureRejection,
} from "../../src/orchestration/harness-capture-runtime";
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
      alreadyCaptured: new Set(),
    });
    const claudeReceipt = bindCapture({
      issued: [authority()],
      identity: identity({ harness: "claude", nativeId: "agent-abc" }),
      payload: claude.value,
      alreadyCaptured: new Set(),
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

      expect(outcome.kind).toBe("retriable-failure");
      if (outcome.kind === "retriable-failure") expect(outcome.reason).toBe("context");
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

      expect(outcome.kind).toBe("terminal-rejection");
      if (outcome.kind === "terminal-rejection") expect(outcome.reason).toBe("context-binding");
    });

    it.each([
      ["role", { role: "silent-failure-hunter", attempt: 1 }],
      ["attempt", { role: "code-reviewer", attempt: 2 }],
    ] as const)("rejects a planted correlator whose %s disagrees with issued authority", async (_field, mismatch) => {
      const { runsRoot, directory, request } = await stagedRun();
      // Plant a structurally valid correlator behind the record-time guard.
      // Resolution itself must reject it, before any caller can act on the
      // request it names.
      const nativeId = `pi-native-wrong-${_field}`;
      const digest = createHash("sha256").update(`pi\0${nativeId}`).digest("hex");
      writeFileSync(
        join(directory, "requests", "correlators", `${digest}.json`),
        JSON.stringify({
          schemaVersion: 1,
          harness: "pi",
          nativeId,
          requestId: request.requestId,
          ...mismatch,
        }),
      );

      const resolved = resolveCorrelatedRequest({
        harness: "pi",
        runsRoot,
        runDirectory: directory,
        nativeId,
      });

      expect(resolved).toEqual({
        ok: false,
        outcome: {
          kind: "terminal-rejection",
          reason: "correlator-authority",
          message: expect.stringContaining("does not match issued request"),
        },
      });
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
      })).kind).toBe("terminal-rejection");

      // A semantically rejected attempt is terminal. Later bytes cannot
      // overwrite the rejection; recovery must use exact attempt-2 authority.
      const late = await captureHarnessResult({
        harness: "pi",
        runsRoot,
        runDirectory: directory,
        nativeId: "pi-native-1",
        candidates: piCandidates(AGENT_OUTPUT),
      });
      expect(late.kind).toBe("terminal-rejection");
      if (late.kind !== "terminal-rejection") return;
      expect(late.reason).toBe("transcript");
      expect(late.message).toContain("terminally rejected");
    });

    it("does not observe a transcript before resolving a reservation", async () => {
      const { runsRoot, directory } = await stagedRun();
      let observed = false;

      const outcome = await captureHarnessResult({
        harness: "pi",
        runsRoot,
        runDirectory: directory,
        nativeId: "not-this-run",
        observe: () => {
          observed = true;
          return terminalCaptureRefusal("transcript-shape", "must not be observed");
        },
      });

      expect(outcome.kind).toBe("no-reservation");
      expect(observed).toBe(false);
    });

    it("keeps captured-attempt read faults retriable without tombstoning the request", async () => {
      const { runsRoot, directory, request } = await stagedRun();
      await correlate(runsRoot, directory, "pi", "pi-native-transient", request);
      const outside = join(runsRoot, "outside-slot");
      mkdirSync(outside);
      symlinkSync(outside, join(directory, "transcripts", "slot-corrupt"));

      const outcome = await captureHarnessResult({
        harness: "pi",
        runsRoot,
        runDirectory: directory,
        nativeId: "pi-native-transient",
        candidates: piCandidates(AGENT_OUTPUT),
      });

      expect(outcome).toMatchObject({ kind: "retriable-failure", reason: "transcripts" });
      const opened = openRunDirectory(runsRoot, directory);
      if (!opened.ok) throw new Error(opened.error.message);
      expect(opened.value.readCaptureRejection(request)).toEqual({ ok: true, value: null });
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

      expect(outcome.kind).toBe("retriable-failure");
      expect(captureAuditLine("capture", outcome)).toContain("retriable failure (correlator)");
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

      expect(outcome.kind).toBe("retriable-failure");
      if (outcome.kind !== "retriable-failure") return;
      expect(outcome.reason).toBe("correlator");
    });
  });

  describe("shared capture-rejection terminalization", () => {
    it("preserves the original refusal when marker persistence fails", async () => {
      const request = authority();
      const handle = {
        rejectCapture: async () => ({
          ok: false,
          error: { kind: "invalid-run-directory", field: "transcript", message: "disk is read-only" },
        }),
      } as unknown as RunDirHandle;

      const outcome = await terminalizeCaptureRejection(
        handle,
        request,
        terminalCaptureRefusal("no-final-payload", "agent said nothing"),
      );

      expect(outcome).toEqual({
        kind: "retriable-failure",
        reason: "rejection-persistence",
        message: expect.stringContaining("no-final-payload: agent said nothing"),
      });
      expect(outcome).toMatchObject({ message: expect.stringContaining("disk is read-only") });
    });

    it("never throws when rejection persistence itself throws", async () => {
      const request = authority();
      const handle = {
        rejectCapture: async () => { throw new Error("marker store unavailable"); },
      } as unknown as RunDirHandle;

      const outcome = await terminalizeCaptureRejection(
        handle,
        request,
        terminalCaptureRefusal("no-final-payload", "agent said nothing"),
      );

      expect(outcome).toEqual({
        kind: "retriable-failure",
        reason: "rejection-persistence",
        message: expect.stringContaining("capture refused (no-final-payload: agent said nothing)"),
      });
      expect(outcome).toMatchObject({ message: expect.stringContaining("marker store unavailable") });
    });

    it("never throws when audit append fails after the tombstone lands", async () => {
      const request = authority();
      const handle = {
        rejectCapture: async () => ({ ok: true, value: captureKey(request.slotId, request.attempt) }),
        appendEvent: async () => { throw new Error("journal unavailable"); },
      } as unknown as RunDirHandle;

      await expect(terminalizeCaptureRejection(
        handle,
        request,
        terminalCaptureRefusal("no-final-payload", "agent said nothing"),
      )).resolves.toMatchObject({
        kind: "terminal-rejection",
        reason: "rejection-audit-unsynchronized",
        message: expect.stringContaining("journal unavailable"),
      });
    });

    it("replays one refusal as exactly one marker and one journal record", async () => {
      const runsRoot = mkdtempSync(join(tmpdir(), "loom-capture-rejection-replay-"));
      cleanup.push(runsRoot);
      const directory = join(runsRoot, "run.acceptance-1");
      mkdirSync(directory);
      const opened = openRunDirectory(runsRoot, directory);
      if (!opened.ok) throw new Error(opened.error.message);
      const request = authority();
      const reserved = await opened.value.reserveRequest(request);
      if (!reserved.ok) throw new Error(reserved.error.message);
      const refusal = terminalCaptureRefusal("no-final-payload", "agent said nothing");

      expect((await terminalizeCaptureRejection(opened.value, request, refusal)).kind)
        .toBe("terminal-rejection");
      expect((await terminalizeCaptureRejection(opened.value, request, refusal)).kind)
        .toBe("terminal-rejection");

      expect(opened.value.readCaptureRejection(request)).toEqual({
        ok: true,
        value: "no-final-payload: agent said nothing",
      });
      const rejectionEvents = (await opened.value.readEvents())
        .filter(({ event }) => (event as { kind?: string }).kind === "request-capture-rejected");
      expect(rejectionEvents).toHaveLength(1);
      expect(readdirSync(join(directory, "transcripts", request.slotId))
        .filter((name) => name.endsWith(".rejected"))).toHaveLength(1);
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

  it("reports a resolved transcript that disappeared as a filesystem read failure", () => {
    const root = mkdtempSync(join(tmpdir(), "loom-claude-disappeared-"));
    cleanup.push(root);
    const transcript = join(root, "disappeared.jsonl");

    expect(() => claudeFinalPayloadCandidates(transcript))
      .toThrow(/cannot read Claude transcript .*disappeared\.jsonl:.*ENOENT/);
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
      alreadyCaptured: new Set(),
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
      alreadyCaptured: new Set(),
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
      alreadyCaptured: new Set(),
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

    const refused = bindCapture({
      issued,
      identity: identity({ requestId: "ghost" }),
      payload: payload(),
      alreadyCaptured: new Set(),
    });
    const accepted = bindCapture({
      issued,
      identity: identity({ requestId: "request:reviewer:2" }),
      payload: payload(),
      alreadyCaptured: new Set(),
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

  async function expectTerminalCaptureRejection(
    runsRoot: string,
    runDir: string,
    reason: string,
  ): Promise<void> {
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    const issued = opened.value.readIssuedRequests();
    if (!issued.ok || issued.value[0] === undefined) throw new Error(issued.ok ? "missing issued request" : issued.error.message);
    const marker = opened.value.readCaptureRejection(issued.value[0]);
    expect(marker.ok).toBe(true);
    if (!marker.ok) return;
    expect(marker.value).toContain(reason);
    const events = await opened.value.readEvents();
    const matching = events.filter(({ event }) =>
      typeof event === "object" && event !== null &&
      (event as Record<string, unknown>).kind === "request-capture-rejected" &&
      String((event as Record<string, unknown>).diagnostic).includes(reason));
    expect(matching).toHaveLength(1);
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

  it("reports a stop that matches no reservation before touching its missing transcript", async () => {
    const { runsRoot, runDir } = await stagedRun();

    const outcome = await captureClaudeResult(
      {
        session_id: "s1",
        agent_id: "some-other-agent",
        agent_type: "code-reviewer",
        agent_transcript_path: join(runDir, "does-not-exist.jsonl"),
      },
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
      kind: "retriable-failure",
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

    expect(second.kind).toBe("terminal-rejection");
    if (second.kind !== "terminal-rejection") return;
    expect(second.reason).toBe("duplicate-capture");
  });

  it("reads back every issued request and no more", async () => {
    const { runsRoot, runDir } = await stagedRun();
    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);

    const issued = opened.value.readIssuedRequests();
    const capturedAttempts = opened.value.readCapturedAttempts();
    if (!issued.ok) throw new Error(issued.error.message);
    if (!capturedAttempts.ok) throw new Error(capturedAttempts.error.message);

    expect(issued.value.map(({ requestId }) => requestId)).toEqual(["request:reviewer:1"]);
    expect([...capturedAttempts.value]).toEqual([]);
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

    expect(outcome.kind).toBe("terminal-rejection");
    if (outcome.kind !== "terminal-rejection") return;
    // One candidate PER text block, so a two-block final is named as the
    // ambiguity it is instead of being silently downgraded to "no final".
    expect(outcome.reason).toBe("ambiguous-final-payload");
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
      kind: "terminal-rejection",
      reason: "transcript-json",
      message: expect.stringContaining("invalid final Claude transcript JSON at line 2"),
    });
    await expectTerminalCaptureRejection(runsRoot, runDir, "transcript-json");
  });

  it("reports a missing transcript rather than capturing nothing silently", async () => {
    const { runsRoot, runDir } = await stagedRun();

    const outcome = await captureClaudeResult(
      { session_id: "s1", agent_id: "agent-abc", agent_type: "code-reviewer", agent_transcript_path: join(runDir, "absent.jsonl") },
      runsRoot,
      runDir,
    );

    expect(outcome.kind).toBe("terminal-rejection");
    if (outcome.kind !== "terminal-rejection") return;
    // An absent transcript is a LOCATOR fault (Claude Code stopped sending
    // `agent_transcript_path`), and must not be reported as an Agent that said
    // nothing.
    expect(outcome.reason).toBe("transcript-locator");
    await expectTerminalCaptureRejection(runsRoot, runDir, "transcript-locator");
  });

  it("terminalises a reserved request whose located transcript cannot be read", async () => {
    const { runsRoot, runDir } = await stagedRun();
    const unreadable = join(runDir, "transcript-directory");
    mkdirSync(unreadable);

    const outcome = await captureClaudeResult(
      { session_id: "s1", agent_id: "agent-abc", agent_type: "code-reviewer", agent_transcript_path: unreadable },
      runsRoot,
      runDir,
    );

    expect(outcome).toMatchObject({ kind: "terminal-rejection", reason: "transcript-read" });
    await expectTerminalCaptureRejection(runsRoot, runDir, "transcript-read");
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
      for (const stdin of ["null", "42", "[]", JSON.stringify({ session_id: "s1", agent_type: 7 })]) {
        const wrongShape = await captureOrchestrationResult(stdin, []);
        expect(wrongShape).toMatchObject({
          kind: "error",
          message: expect.stringContaining("malformed SubagentStop JSON or domain shape"),
        });
      }
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

