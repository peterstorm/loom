import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { agentRequestAuthority } from "../fixtures/agent-request-authority";
import { bindCapture, captureKey, nativeCaptureObservation, parseFinalPayload, recoverNativeCaptureArtifact } from "../../src/core/harness-capture";
import { value } from "../fixtures/parse-result";

function observed(text: string, harness: "pi" | "claude", attempt: 1 | 2) {
  const request = agentRequestAuthority("run.native-recovery", { attempt,
    outputSlot: { kind: "fixed-artifact-slot", path: `transcripts/slot-1/attempt-${attempt}.raw` } });
  const payload = value(parseFinalPayload([{ origin: "content[0].text", text }]));
  const identity = { harness, requestId: request.requestId, attempt, nativeId: "native-original" };
  const receipt = value(bindCapture({ issued: [request], identity, payload, alreadyCaptured: new Set() }));
  const observation = Buffer.from(nativeCaptureObservation(request, receipt, payload.origin));
  return { request, payload, receipt, observation, capturedBytes: Uint8Array.from(payload.bytes) };
}

const text = fc.string({ minLength: 1, maxLength: 256 });
const harness = fc.constantFrom("pi" as const, "claude" as const);
const attempt = fc.constantFrom(1 as const, 2 as const);

describe("native write-ahead observation reconciliation (not replay authority)", () => {
  it("recovers only the exact fresh binding and bytes, without changing legacy duplicate semantics", () => {
    fc.assert(fc.property(text, harness, attempt, (text, harness, attempt) => {
      const input = observed(text, harness, attempt);
      const result = recoverNativeCaptureArtifact(input);
      expect(result).toEqual({ ok: true, value: { runId: input.request.runId, slot: input.request.outputSlot,
        digest: input.payload.digest, byteLength: input.payload.byteLength } });
      expect(recoverNativeCaptureArtifact(input)).toEqual(result);
      expect(bindCapture({ issued: [input.request], identity: { harness, requestId: input.request.requestId,
        attempt, nativeId: input.receipt.nativeId }, payload: input.payload,
        alreadyCaptured: new Set([captureKey(input.request.slotId, attempt)]) })).toMatchObject({ ok: false, error: { reason: "duplicate-capture" } });
    }));
  });

  it("refuses absent or any byte-altered observation even when transcript bytes match", () => {
    fc.assert(fc.property(text, harness, attempt, fc.nat(), (text, harness, attempt, index) => {
      const input = observed(text, harness, attempt);
      expect(recoverNativeCaptureArtifact({ ...input, observation: null }).ok).toBe(false);
      const changed = Uint8Array.from(input.observation);
      changed[index % changed.length] = changed[index % changed.length]! ^ 1;
      expect(recoverNativeCaptureArtifact({ ...input, observation: changed }).ok).toBe(false);
    }));
  });

  it("refuses changed/truncated/extended raw bytes even when the stored binding matches", () => {
    fc.assert(fc.property(text, harness, attempt, fc.nat(), (text, harness, attempt, index) => {
      const input = observed(text, harness, attempt);
      const changed = Uint8Array.from(input.capturedBytes);
      changed[index % changed.length] = changed[index % changed.length]! ^ 1;
      for (const capturedBytes of [changed, input.capturedBytes.slice(1), Uint8Array.from([...input.capturedBytes, 0])]) {
        expect(recoverNativeCaptureArtifact({ ...input, capturedBytes }).ok).toBe(false);
      }
    }));
  });

  it("refuses newly bound foreign native IDs, payload origins, contexts, slots, requests and attempts", () => {
    fc.assert(fc.property(text, harness, attempt, (text, harness, attempt) => {
      const input = observed(text, harness, attempt);
      const requests = [
        agentRequestAuthority("run.foreign"),
        agentRequestAuthority("run.native-recovery", { requestId: "request:foreign" }),
        agentRequestAuthority("run.native-recovery", { contextDigest: "f".repeat(64) }),
        agentRequestAuthority("run.native-recovery", { attempt: attempt === 1 ? 2 : 1 }),
        agentRequestAuthority("run.native-recovery", { slotId: "slot-foreign" }),
      ];
      for (const request of requests) expect(recoverNativeCaptureArtifact({ ...input, request }).ok).toBe(false);
      expect(recoverNativeCaptureArtifact({ ...input, receipt: { ...input.receipt, nativeId: "native-new" } }).ok).toBe(false);
      expect(recoverNativeCaptureArtifact({ ...input, receipt: { ...input.receipt, harness: harness === "pi" ? "claude" : "pi" } }).ok).toBe(false);
      expect(recoverNativeCaptureArtifact({ ...input, payload: { ...input.payload, origin: "content[1].text" } }).ok).toBe(false);
      const replacement = observed(`${text} `, harness, attempt);
      expect(recoverNativeCaptureArtifact({ ...replacement, observation: input.observation, capturedBytes: input.capturedBytes }).ok).toBe(false);
    }));
  });
});
