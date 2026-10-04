import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";
import {
  bindCapture,
  captureKey,
  capturesAgree,
  parseFinalPayload,
  type FinalPayloadCandidate,
  type HarnessResultIdentity,
} from "../../src/core/harness-capture";
import { admitEmissionArguments, EMISSION_TOOL_SPECS } from "../../src/core/emission-tool";
import { CURRENT_REVIEWER_PROTOCOL, REVIEWER_PAYLOAD_EXAMPLE_V2, reviewerPayloadV2Schema } from "../../src/core/reviewer-contract";
import { sha256Hex } from "../../src/core/review-packet";
import type { EmissionCallFrame } from "../../src/core/harness-capture";
import type { AgentRequestAuthority } from "../../src/core/orchestration-contract";
import captureOrchestrationResult, {
  captureClaudeResult,
  claudeEmissionFramesFromLines,
  claudeEmissionToolFamily,
  claudeFinalPayloadCandidates,
} from "../../src/handlers/subagent-stop/capture-orchestration-result";
import { recordClaudeSpawnCorrelation } from "../../src/handlers/post-tool-use/record-orchestration-spawn";
import { piFinalPayloadCandidates, piResultFinalPayloadCandidates } from "../../../pi/transcript-adapter";
import { createRunDirectory, openRunDirectory, type RunDirHandle } from "../../src/orchestration/run-directory-handle";
import {
  captureAuditLine,
  captureEmissionObservation,
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
    const root = canonicalTempDir("loom-parity-");
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

    const root = canonicalTempDir("loom-parity-multiblock-");
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
      const runsRoot = canonicalTempDir("loom-capture-parity-");
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
      const runsRoot = canonicalTempDir("loom-capture-binding-");
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
      const runsRoot = canonicalTempDir("loom-capture-rejection-replay-");
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
    const root = canonicalTempDir("loom-claude-malformed-");
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
    const root = canonicalTempDir("loom-claude-loop-");
    cleanup.push(root);
    const transcript = join(root, "loop.jsonl");
    // A symlink loop makes the transcript ELOOP: the filesystem cause must
    // surface (an existsSync pre-check would have turned it into silence).
    symlinkSync(transcript, transcript);

    expect(() => claudeFinalPayloadCandidates(transcript))
      .toThrow(/cannot read Claude transcript/);
  });

  it("reports a resolved transcript that disappeared as a filesystem read failure", () => {
    const root = canonicalTempDir("loom-claude-disappeared-");
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
    const root = canonicalTempDir("loom-capture-run-");
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

  it("rethrows an unexpected payload-reader defect without terminalizing request authority", async () => {
    const { runsRoot, runDir } = await stagedRun();
    const path = transcript(runDir, "unobserved payload");
    const engineFault = new Error("payload reader invariant failed");

    await expect(captureClaudeResult(
      { session_id: "s1", agent_id: "agent-abc", agent_type: "code-reviewer", agent_transcript_path: path },
      runsRoot,
      runDir,
      () => { throw engineFault; },
    )).rejects.toBe(engineFault);

    const opened = openRunDirectory(runsRoot, runDir);
    if (!opened.ok) throw new Error(opened.error.message);
    const issued = opened.value.readIssuedRequests();
    if (!issued.ok || issued.value[0] === undefined) throw new Error(issued.ok ? "missing request" : issued.error.message);
    expect(opened.value.readCaptureRejection(issued.value[0])).toEqual({ ok: true, value: null });
    const captured = opened.value.readCapturedAttempts();
    if (!captured.ok) throw new Error(captured.error.message);
    expect([...captured.value]).toEqual([]);
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


// ---------------------------------------------------------------------------
// The engine capture seam's canonical selection (T7; AD-8/AD-9/AD-10, FR-009)
// ---------------------------------------------------------------------------

describe("the engine capture seam selects the canonical emission source", () => {
  const V2_SPEC = EMISSION_TOOL_SPECS["reviewer-payload"];
  const V2_DIGEST = sha256Hex(V2_SPEC.schemaVersions["v2"]!.schemaBytes);

  const reviewerV2Arguments = (): unknown => reviewerPayloadV2Schema.parse({
    schemaVersion: 2,
    kind: "standalone-review",
    findings: [{ ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, claim: "the qualified route carried the frozen schema" }],
  });

  /** The engine-refined refusal class: whitespace-only prose passes the frozen
   *  bytes' shape but refuses through the registry's admission (AD-5). */
  const whitespaceV2Arguments = (): unknown => {
    const finding = reviewerPayloadV2Schema.parse({
      schemaVersion: 2,
      kind: "standalone-review",
      findings: [{ ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!, claim: "real claim" }],
    }).findings[0]!;
    return { schemaVersion: 2, kind: "standalone-review", findings: [{ ...finding, claim: "   " }] };
  };

  const completeFrame = (
    request: AgentRequestAuthority,
    toolCallId: string,
    args: unknown,
    overrides: Partial<{ requestId: string; kind: string; version: string }> = {},
  ) => Object.freeze({
    kind: "complete" as const,
    call: Object.freeze({
      requestId: overrides.requestId ?? request.requestId,
      toolCallId,
      kind: Object.freeze({ kind: overrides.kind ?? "reviewer-payload" }),
      version: overrides.version ?? "v2",
      arguments: args,
    }),
  });

  const textCandidate = (origin: string, text: string): FinalPayloadCandidate =>
    Object.freeze({ origin, text });

  interface StagedWaveRun {
    readonly runsRoot: string;
    readonly directory: string;
    readonly request: AgentRequestAuthority;
    readonly handle: RunDirHandle;
  }

  /** A real registered wave-gate v2 run with one reserved, correlated reviewer
   *  request — the same durable authority the render path projects its
   *  descriptor from, so the capture seam resolves the SAME issuance join. */
  async function stagedWaveRun(options: Readonly<{
    harness?: "pi" | "claude";
    qualifiedRoute?: boolean;
    nativeId?: string;
  }> = {}): Promise<StagedWaveRun> {
    const harness = options.harness ?? "pi";
    const qualifiedRoute = options.qualifiedRoute ?? true;
    const runsRoot = canonicalTempDir("loom-emission-seam-");
    cleanup.push(runsRoot);
    const directory = join(runsRoot, "run.emission-seam");
    const created = createRunDirectory(runsRoot, "run.emission-seam");
    if (!created.ok) throw new Error(created.error.message);
    // The issuance join at the digest level: the registered protocol's issued
    // descriptor certifies the SAME frozen bytes the registry cell carries,
    // so a binding minted from the registration and a binding minted from the
    // registry are the same identity.
    expect(CURRENT_REVIEWER_PROTOCOL.schemaDigest).toBe(V2_DIGEST);
    const registered = {
      schemaVersion: 2 as const,
      kind: "wave-gate" as const,
      input: { wave: 1 },
      taskIds: ["T1"],
      authorityDigest: "b".repeat(64),
      reviewerProtocol: CURRENT_REVIEWER_PROTOCOL,
    };
    const program = await created.value.registerProgram(registered);
    if (!program.ok) throw new Error(program.error.message);
    const section = encodeByteSection("test", "emission seam context");
    if (!section.ok) throw new Error(section.error.message);
    const base = authority({ runId: "run.emission-seam" as AgentRequestAuthority["runId"] });
    const packet = buildContextPacket({
      requestId: base.requestId,
      role: base.role,
      requiredSkill: "none",
      outputContract: "test output",
      fixedContext: [section.value],
      variableContext: [],
    });
    if (!packet.ok) throw new Error(packet.error.message);
    if (!(await created.value.publishContext(packet.value)).ok) throw new Error("context publication failed");
    const request = authority({
      runId: "run.emission-seam" as AgentRequestAuthority["runId"],
      // The model profile resolves the harness binding: the qualified-local
      // review profile is the one whose pi target IS the qualified desktop
      // route, so the emission-enabled request must carry it.
      modelProfile: qualifiedRoute ? "qualified-local-review" : "general-review",
      contextDigest: packet.value.digest,
      harnessBinding: {
        pi: qualifiedRoute
          ? { harness: "pi" as const, provider: "desktop-vllm" as const,
              model: "glm-5.3-flash-spark-tp2-v14" as const, thinking: "high" as const }
          : { harness: "pi" as const, provider: "openai-codex" as const,
              model: "gpt-5.6-sol" as const, thinking: "high" as const },
        claude: { harness: "claude-code" as const, model: "sonnet" as const },
      },
    });
    const reserved = await created.value.reserveRequest(request);
    if (!reserved.ok) throw new Error(reserved.error.message);
    const correlated = await created.value.recordHarnessCorrelator({
      schemaVersion: 1,
      harness,
      nativeId: options.nativeId ?? "pi-native-emission",
      requestId: request.requestId,
      role: request.role,
      attempt: request.attempt,
    });
    if (!correlated.ok) throw new Error(correlated.error.message);
    const reopened = openRunDirectory(runsRoot, directory);
    if (!reopened.ok) throw new Error(reopened.error.message);
    return { runsRoot, directory, request, handle: reopened.value };
  }

  const captureEmission = (
    staged: StagedWaveRun,
    frames: readonly unknown[],
    candidates: readonly FinalPayloadCandidate[],
  ): Promise<Awaited<ReturnType<typeof captureHarnessResult>>> =>
    captureHarnessResult({
      harness: "pi",
      runsRoot: staged.runsRoot,
      runDirectory: staged.directory,
      nativeId: "pi-native-emission",
      observe: () => captureEmissionObservation(frames as never, candidates),
    });

  const sourceRecord = (staged: StagedWaveRun): Record<string, unknown> | null => {
    const read = staged.handle.readArtifactBytes(`capture-sources/${staged.request.requestId}.json`, 16_384);
    if (!read.ok) throw new Error(read.error.message);
    return read.value === null ? null : JSON.parse(Buffer.from(read.value).toString("utf-8")) as Record<string, unknown>;
  };

  it("captures a tool-only reviewer v2 emission payload and publishes its accepted-source record", async () => {
    const staged = await stagedWaveRun();
    const args = reviewerV2Arguments();
    const outcome = await captureEmission(staged, [completeFrame(staged.request, "call-tool-only", args)], []);

    expect(outcome.kind).toBe("captured");
    if (outcome.kind !== "captured") return;
    const bytes = readFileSync(join(staged.directory, "transcripts", staged.request.slotId, `attempt-${staged.request.attempt}.raw`), "utf-8");
    expect(bytes).toBe(JSON.stringify(args, null, 2));
    expect(outcome.receipt.digest).toBe(createHash("sha256").update(bytes).digest("hex"));

    // The accepted source is durable BEFORE acceptance is declared, and it is
    // the selection's own provenance: accepted call identity, the ISSUED
    // schema digest, and the accepted payload identity — never reconstructed
    // from the transcript later.
    const record = sourceRecord(staged);
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      schemaVersion: 1,
      kind: "capture-source",
      requestId: staged.request.requestId,
      slotId: staged.request.slotId,
      attempt: staged.request.attempt,
      harness: "pi",
      source: "emission-tool",
      toolCallId: "call-tool-only",
      producerKind: "reviewer-payload",
      emissionSchemaVersion: "v2",
      schemaDigest: V2_DIGEST,
      payloadDigest: outcome.receipt.digest,
    });
  });

  it("accepts extraction over a single refused call, retains the refusal in the source record, and consumes no attempt", async () => {
    const staged = await stagedWaveRun();
    const refusalArgs = whitespaceV2Arguments();
    const finalText = "VERDICT: PASSED\n";
    const outcome = await captureEmission(staged,
      [completeFrame(staged.request, "call-refused", refusalArgs)],
      [textCandidate("content[0].text", finalText)]);

    expect(outcome.kind).toBe("captured");
    if (outcome.kind !== "captured") return;
    const bytes = readFileSync(join(staged.directory, "transcripts", staged.request.slotId, `attempt-${staged.request.attempt}.raw`), "utf-8");
    expect(bytes).toBe(finalText);

    const expected = admitEmissionArguments(V2_SPEC, "v2", refusalArgs);
    if (expected.kind !== "refused") throw new Error("fixture must be engine-refused");
    const record = sourceRecord(staged);
    expect(record).toMatchObject({
      source: "extraction",
      emissionRefusal: { code: expected.code, message: expected.message },
    });
    expect(record).not.toHaveProperty("toolCallId");

    // Extraction over a refused call consumed NO retry: the attempt is
    // accepted, not tombstoned (FR-006/AD-9).
    const rejected = staged.handle.readCaptureRejection(staged.request);
    expect(rejected.ok).toBe(true);
    if (rejected.ok) expect(rejected.value).toBeNull();
  });

  it("terminalises two distinct emission calls as ONE ambiguity rejection naming both identities", async () => {
    const staged = await stagedWaveRun();
    const outcome = await captureEmission(staged, [
      completeFrame(staged.request, "call-first", reviewerV2Arguments()),
      completeFrame(staged.request, "call-second", reviewerV2Arguments()),
    ], [textCandidate("content[0].text", "usable final text")]);

    expect(outcome.kind).toBe("terminal-rejection");
    if (outcome.kind !== "terminal-rejection") return;
    expect(outcome.reason).toBe("ambiguous-emission-call");
    expect(outcome.message).toContain("call-first");
    expect(outcome.message).toContain("call-second");
    // Valid final text cannot rescue the ambiguity: no transcript landed.
    expect(() => readFileSync(join(staged.directory, "transcripts", staged.request.slotId, "attempt-1.raw"))).toThrow();
    const rejected = staged.handle.readCaptureRejection(staged.request);
    expect(rejected.ok).toBe(true);
    if (rejected.ok) expect(rejected.value).toContain("ambiguous-emission-call");
  });

  it("refuses a misbound emission call before schema selection and terminalises the attempt", async () => {
    const staged = await stagedWaveRun();
    const outcome = await captureEmission(staged,
      [completeFrame(staged.request, "call-misbound", reviewerV2Arguments(), { requestId: "request:reviewer:other" })], []);

    expect(outcome.kind).toBe("terminal-rejection");
    if (outcome.kind !== "terminal-rejection") return;
    expect(outcome.reason).toBe("wrong-request");
    const rejected = staged.handle.readCaptureRejection(staged.request);
    expect(rejected.ok).toBe(true);
    if (rejected.ok) expect(rejected.value).not.toBeNull();
  });

  it("refuses an unusable observation instead of reclassifying it as absence", async () => {
    const staged = await stagedWaveRun();
    const outcome = await captureEmission(staged, [
      { kind: "incomplete", toolCallId: "call-partial", reason: "emission tool call call-partial has no finalized tool result" },
    ], [textCandidate("content[0].text", "usable final text")]);

    expect(outcome.kind).toBe("terminal-rejection");
    if (outcome.kind !== "terminal-rejection") return;
    expect(outcome.reason).toBe("unusable-observation");
    expect(outcome.message).toContain("call-partial");
  });

  it("keeps extraction-only authority un-upgradable by an observed emission call, with the zero-call baseline unchanged", async () => {
    // An unqualified provider route is extraction-only by issuance (AD-7):
    // the observed call is refused — it can never upgrade extraction-only
    // authority — and the tombstone records it.
    const extractionOnly = await stagedWaveRun({ qualifiedRoute: false });
    const outcome = await captureEmission(extractionOnly,
      [completeFrame(extractionOnly.request, "call-rogue", reviewerV2Arguments())], []);
    expect(outcome.kind).toBe("terminal-rejection");
    if (outcome.kind !== "terminal-rejection") return;
    expect(outcome.reason).toBe("unexpected-emission-call");
    expect(outcome.message).toContain("extraction-only authority cannot be upgraded");

    // The zero-call extraction baseline on an extraction-only route is
    // byte-identical to the pre-emission seam: captured, and NO source record
    // (selection only publishes provenance where a selection decision ran).
    const baseline = await stagedWaveRun({ qualifiedRoute: false });
    const captured = await captureEmission(baseline, [], [textCandidate("content[0].text", "VERDICT: PASSED\n")]);
    expect(captured.kind).toBe("captured");
    expect(sourceRecord(baseline)).toBeNull();
  });

  it("refuses an exact replayed capture as duplicate and leaves the published source record byte-identical", async () => {
    const staged = await stagedWaveRun();
    const first = await captureEmission(staged, [completeFrame(staged.request, "call-replay", reviewerV2Arguments())], []);
    expect(first.kind).toBe("captured");
    const published = sourceRecord(staged);
    expect(published).not.toBeNull();

    const replay = await captureEmission(staged, [completeFrame(staged.request, "call-replay", reviewerV2Arguments())], []);
    expect(replay.kind).toBe("terminal-rejection");
    if (replay.kind !== "terminal-rejection") return;
    expect(replay.reason).toBe("duplicate-capture");
    expect(sourceRecord(staged)).toEqual(published);
  });

  it("reports unreadable issued emission authority as retriable infrastructure that preserves the attempt", async () => {
    const staged = await stagedWaveRun();
    writeFileSync(join(staged.directory, "program.json"), "{corrupt");
    const outcome = await captureEmission(staged, [completeFrame(staged.request, "call-infra", reviewerV2Arguments())], []);

    expect(outcome.kind).toBe("retriable-failure");
    if (outcome.kind !== "retriable-failure") return;
    // The registration read is the first gate that reports the corruption;
    // whether the purpose read ("registration") or the emission-authority
    // resolution ("emission-authority") surfaces it, the failure is retriable
    // infrastructure and the attempt is preserved — never a semantic refusal.
    expect(["registration", "emission-authority"]).toContain(outcome.reason);
    const rejected = staged.handle.readCaptureRejection(staged.request);
    expect(rejected.ok).toBe(true);
    if (rejected.ok) expect(rejected.value).toBeNull();
  });

  describe("the AD-10 controls against the production capture path", () => {
    it("the bypassed-selection control fails the tool-only acceptance through the production candidates arm", async () => {
      const staged = await stagedWaveRun();
      // Tool-only completion, selection bypassed: the runtime sees candidates
      // only, so the tool-only transcript has no final payload to admit and
      // the attempt is terminalised. The SAME observation captured through the
      // selection seam above ("captures a tool-only reviewer v2 emission
      // payload") — the acceptance criterion is discriminating.
      const bypassed = await captureHarnessResult({
        harness: "pi",
        runsRoot: staged.runsRoot,
        runDirectory: staged.directory,
        nativeId: "pi-native-emission",
        candidates: [],
      });
      expect(bypassed.kind).toBe("terminal-rejection");
      if (bypassed.kind !== "terminal-rejection") return;
      expect(bypassed.reason).toBe("no-final-payload");
    });

    it("the always-accept control would ingest exactly what the binding check refuses", async () => {
      const staged = await stagedWaveRun();
      const misbound = completeFrame(staged.request, "call-misbound", reviewerV2Arguments(), { requestId: "request:reviewer:other" });
      // What an always-accept seam (registry admission without the binding
      // check) would ingest: the arguments themselves are schema-valid.
      const admitted = admitEmissionArguments(V2_SPEC, "v2", reviewerV2Arguments());
      expect(admitted.kind).toBe("valid");
      // Production refuses: the call was observed under another request.
      const outcome = await captureEmission(staged, [misbound], []);
      expect(outcome.kind).toBe("terminal-rejection");
      if (outcome.kind !== "terminal-rejection") return;
      expect(outcome.reason).toBe("wrong-request");
    });

    it("the always-reject control replaces acceptance with the observation refusal production does not produce", async () => {
      const staged = await stagedWaveRun();
      // Always-reject seam posture: every emission observation is refused as
      // unusable. Through the production path that posture terminalises the
      // attempt with the unusable-observation refusal — detectably different
      // from the valid observation's capture above.
      const alwaysReject = await captureEmission(staged, [
        { kind: "incomplete", toolCallId: "call-any", reason: "always-reject control: the observation is refused unconditionally" },
      ], [textCandidate("content[0].text", "usable final text")]);
      expect(alwaysReject.kind).toBe("terminal-rejection");
      if (alwaysReject.kind !== "terminal-rejection") return;
      expect(alwaysReject.reason).toBe("unusable-observation");
    });
  });

  describe("the Claude transcript scan observes the emission family", () => {
    const REVIEWER_TOOL = EMISSION_TOOL_SPECS["reviewer-payload"].toolName;

    it("classifies tool names by the frozen registry, never by shape", () => {
      expect(claudeEmissionToolFamily(REVIEWER_TOOL)).toEqual({ kind: "registered", producerKind: "reviewer-payload" });
      expect(claudeEmissionToolFamily("loom_emit_unknown_future_kind")).toEqual({ kind: "unregistered-emission-name" });
      expect(claudeEmissionToolFamily("Bash")).toEqual({ kind: "unrelated" });
      expect(claudeEmissionToolFamily(42)).toEqual({ kind: "unrelated" });
    });

    it("projects complete frames only for successfully executed calls, and refuses-class frames otherwise", () => {
      const lines = [
        JSON.stringify({ message: { role: "assistant", content: [
          { type: "tool_use", id: "tu-ok", name: REVIEWER_TOOL, input: { schemaVersion: 2, kind: "standalone-review", findings: [] } },
          { type: "tool_use", id: "tu-failed", name: REVIEWER_TOOL, input: { schemaVersion: 2 } },
          { type: "tool_use", id: "tu-noresult", name: REVIEWER_TOOL, input: { schemaVersion: 2 } },
          { type: "tool_use", name: REVIEWER_TOOL, input: { schemaVersion: 2 } },
          { type: "tool_use", id: "tu-foreign", name: "loom_emit_unknown_future_kind", input: {} },
          { type: "tool_use", id: "tu-scratch", name: "Bash", input: { command: "ls" } },
          { type: "text", text: "{\"schemaVersion\":2}\n" },
        ] } }),
        JSON.stringify({ message: { role: "user", content: [
          { type: "tool_result", tool_use_id: "tu-ok", is_error: false },
          { type: "tool_result", tool_use_id: "tu-failed", is_error: true },
        ] } }),
      ];
      const frames = claudeEmissionFramesFromLines(lines, { requestId: "request:reviewer:1", version: "v2" });
      const complete = frames.filter((frame) => frame.kind === "complete");
      expect(complete).toHaveLength(1);
      if (complete[0]!.kind !== "complete") throw new Error("narrowing");
      expect(complete[0]!.call).toMatchObject({ requestId: "request:reviewer:1", toolCallId: "tu-ok", kind: { kind: "reviewer-payload" }, version: "v2" });
      // The text block stayed a candidate vocabulary item: it never became a frame.
      expect(frames.some((frame) => frame.kind === "complete" && frame.call.toolCallId !== "tu-ok")).toBe(false);
      const incomplete = frames.filter((frame): frame is Extract<EmissionCallFrame, { kind: "incomplete" }> => frame.kind === "incomplete");
      const reasons = incomplete.map(({ reason }) => reason);
      expect(reasons.some((reason) => reason.includes("tu-failed") && reason.includes("failed"))).toBe(true);
      expect(reasons.some((reason) => reason.includes("tu-noresult") && reason.includes("no finalized tool result"))).toBe(true);
      expect(reasons.some((reason) => reason.includes("without a recoverable tool-call identity"))).toBe(true);
      expect(reasons.some((reason) => reason.includes("loom_emit_unknown_future_kind") && reason.includes("no frozen registry producer kind"))).toBe(true);
      // The unrelated Bash call is not an emission observation at all.
      expect(reasons.some((reason) => reason.includes("Bash"))).toBe(false);
    });

    it("refuses a rogue emission call through the real Claude capture without upgrading extraction-only authority", async () => {
      const staged = await stagedWaveRun({ harness: "claude", nativeId: "agent-abc" });
      const args = reviewerV2Arguments();
      const transcriptPath = join(staged.directory, "rogue-transcript.jsonl");
      writeFileSync(transcriptPath, [
        JSON.stringify({ message: { role: "assistant", content: [
          { type: "tool_use", id: "tu-rogue", name: EMISSION_TOOL_SPECS["reviewer-payload"].toolName, input: args },
        ] } }),
        JSON.stringify({ message: { role: "user", content: [
          { type: "tool_result", tool_use_id: "tu-rogue", is_error: false },
        ] } }),
        JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "VERDICT: PASSED\n" }] } }),
      ].join("\n") + "\n");

      const outcome = await captureClaudeResult(
        { session_id: "s1", agent_id: "agent-abc", agent_type: "code-reviewer", agent_transcript_path: transcriptPath },
        staged.runsRoot,
        staged.directory,
      );
      // A Claude harness has no Pi emission parent: the issued authority is
      // extraction-only, and the observed call refuses instead of upgrading it
      // or being absorbed as absence — even with usable final text.
      expect(outcome.kind).toBe("terminal-rejection");
      if (outcome.kind !== "terminal-rejection") return;
      expect(outcome.reason).toBe("unexpected-emission-call");
      const rejected = staged.handle.readCaptureRejection(staged.request);
      expect(rejected.ok).toBe(true);
      if (rejected.ok) expect(rejected.value).toContain("unexpected-emission-call");
    });

    it("keeps a Claude capture with no emission call on the unchanged extraction baseline", async () => {
      const staged = await stagedWaveRun({ harness: "claude", nativeId: "agent-abc" });
      const text = "## Machine Summary\nCRITICAL_COUNT: 0\n";
      const transcriptPath = join(staged.directory, "plain-transcript.jsonl");
      writeFileSync(transcriptPath, `${JSON.stringify({
        message: { role: "assistant", content: [{ type: "text", text }] },
      })}\n`);
      const outcome = await captureClaudeResult(
        { session_id: "s1", agent_id: "agent-abc", agent_type: "code-reviewer", agent_transcript_path: transcriptPath },
        staged.runsRoot,
        staged.directory,
      );
      expect(outcome.kind).toBe("captured");
      if (outcome.kind !== "captured") return;
      expect(outcome.receipt.byteLength).toBe(Buffer.byteLength(text, "utf-8"));
      // No selection decision ran: no source record on the extraction baseline.
      const read = staged.handle.readArtifactBytes(`capture-sources/${staged.request.requestId}.json`, 16_384);
      expect(read.ok).toBe(true);
      if (read.ok) expect(read.value).toBeNull();
    });

    it("represents an unclassifiable line as an incomplete frame instead of provable absence (AD-8)", () => {
      // The upheld capture-review critical's exact scenario: the emission
      // tool_use line is truncated (partial flush), the final line still
      // parses as usable text. The tolerant walk cannot claim "no emission
      // calls" — the corrupted line may hide the call — so the scan must
      // surface the incompleteness in the closed vocabulary.
      const lines = [
        JSON.stringify({ message: { role: "assistant", content: [
          { type: "text", text: "thinking" },
        ] } }),
        `{"message":{"role":"assistant","content":[{"type":"tool_use","id":"tu-lost","name":"${REVIEWER_TOOL}"`,
        JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "VERDICT: PASSED\n" }] } }),
      ];
      const frames = claudeEmissionFramesFromLines(lines, { requestId: "request:reviewer:1", version: "v2" });
      expect(frames).toHaveLength(1);
      if (frames[0]!.kind !== "incomplete") throw new Error("narrowing");
      expect(frames[0]!.reason).toContain("unclassifiable line");
      expect(frames[0]!.reason).toContain("transcript.line[1]");
      expect(frames[0]!.reason).toContain("cannot claim absence");
    });

    it("represents orphan tool results as incomplete frames naming the lost call ids", () => {
      // The emission call's tool_use line was lost; its tool_result survived.
      // The orphan id is the walk's only witness to the lost call.
      const lines = [
        JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "thinking" }] } }),
        JSON.stringify({ message: { role: "user", content: [
          { type: "tool_result", tool_use_id: "tu-orphan", is_error: false },
        ] } }),
        JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "VERDICT: PASSED\n" }] } }),
      ];
      const frames = claudeEmissionFramesFromLines(lines, { requestId: "request:reviewer:1", version: "v2" });
      expect(frames).toHaveLength(1);
      if (frames[0]!.kind !== "incomplete") throw new Error("narrowing");
      expect(frames[0]!.reason).toContain("orphan tool result");
      expect(frames[0]!.reason).toContain("tu-orphan");
    });

    it("keeps a clean zero-call walk on the ordinary no-tool observation", () => {
      // The incompleteness guard must not fire on well-formed transcripts:
      // a blank-padded, message-shaped walk with no unparseable lines and no
      // orphan results observes absence legitimately.
      const lines = [
        "",
        JSON.stringify({ message: { role: "assistant", content: [
          { type: "tool_use", id: "tu-scratch", name: "Bash", input: { command: "ls" } },
        ] } }),
        JSON.stringify({ message: { role: "user", content: [
          { type: "tool_result", tool_use_id: "tu-scratch", is_error: false },
        ] } }),
        JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
        "",
      ];
      expect(claudeEmissionFramesFromLines(lines, { requestId: "request:reviewer:1", version: "v2" })).toEqual([]);
    });

    it("refuses a capture whose transcript lost an emission call to a corrupted line instead of silently extracting", async () => {
      const staged = await stagedWaveRun({ harness: "claude", nativeId: "agent-abc" });
      const transcriptPath = join(staged.directory, "corrupted-emission-transcript.jsonl");
      // Line 1 carried the emission tool_use and was truncated mid-write; the
      // final line's text would pass extraction. Pre-fix this captured as a
      // plain extraction fallback with no trace of the lost call.
      writeFileSync(transcriptPath, [
        `{"message":{"role":"assistant","content":[{"type":"tool_use","id":"tu-lost","name":"${REVIEWER_TOOL}"`,
        JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "VERDICT: PASSED\n" }] } }),
      ].join("\n") + "\n");

      const outcome = await captureClaudeResult(
        { session_id: "s1", agent_id: "agent-abc", agent_type: "code-reviewer", agent_transcript_path: transcriptPath },
        staged.runsRoot,
        staged.directory,
      );
      // The incomplete walk yields a frame; extraction-only authority cannot
      // be upgraded by an observed emission call, so the capture terminalises
      // with the refusal naming the unreadable line — never silence.
      expect(outcome.kind).toBe("terminal-rejection");
      if (outcome.kind !== "terminal-rejection") return;
      expect(outcome.reason).toBe("unexpected-emission-call");
      const rejected = staged.handle.readCaptureRejection(staged.request);
      expect(rejected.ok).toBe(true);
      if (rejected.ok) expect(rejected.value).toContain("unexpected-emission-call");
    });

    it("surfaces a corrupted-line walk through the qualified route as an unusable observation naming the unreadable lines", async () => {
      const staged = await stagedWaveRun();
      const lines = [
        `{"message":{"role":"assistant","content":[{"type":"tool_use","id":"tu-lost","name":"${REVIEWER_TOOL}"`,
        JSON.stringify({ message: { role: "assistant", content: [{ type: "text", text: "VERDICT: PASSED\n" }] } }),
      ];
      const frames = claudeEmissionFramesFromLines(lines, { requestId: staged.request.requestId, version: "v2" });
      expect(frames.some((frame) => frame.kind === "incomplete")).toBe(true);
      const outcome = await captureEmission(staged, frames, [textCandidate("content[0].text", "VERDICT: PASSED\n")]);

      // The incomplete walk is represented as itself in the closed vocabulary:
      // an unusable observation that terminalises the attempt with the reason
      // naming the unreadable lines — usable final text never papers over a
      // transcript known to have lost lines (the same class the sole
      // incomplete-frame arm terminalises with).
      expect(outcome.kind).toBe("terminal-rejection");
      if (outcome.kind !== "terminal-rejection") return;
      expect(outcome.reason).toBe("unusable-observation");
      expect(outcome.message).toContain("unclassifiable line");
      expect(outcome.message).toContain("cannot claim absence");
      const rejected = staged.handle.readCaptureRejection(staged.request);
      expect(rejected.ok).toBe(true);
      if (rejected.ok) expect(rejected.value).toContain("unclassifiable line");
    });
  });
});
