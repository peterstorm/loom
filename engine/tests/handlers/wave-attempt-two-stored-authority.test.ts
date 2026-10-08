/**
 * Regression: deriving a Wave attempt-2 retry from a STORED attempt-1.
 *
 * `deriveWaveAttemptTwo` spreads an attempt-1 authority that was read back out
 * of a run directory. Parsing that derivation with the strict issue-mode parser
 * re-checked the recorded role->profile coupling against TODAY's policy tables,
 * so promoting an agent's profile made every run already on disk throw on
 * resume — the same class of defect the origin split was introduced to fix, and
 * it also disagreed with `persistedWaveAttemptTwoCompatibilityProblem`, which
 * derives the identical attempt-2 in stored mode.
 */

import { describe, expect, it, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveWaveAttemptTwo } from "../../src/handlers/helpers/programs/wave-review-retries";
import {
  deriveWaveAttemptTwoAuthority,
  persistedWaveAttemptTwoCompatibilityProblem,
  waveAttemptTwoRequestId,
} from "../../src/core/wave-gate-membership";
import { parseWaveRetryDiagnosticSection, WAVE_RETRY_PREAMBLE, WAVE_RETRY_FIXED_TAIL } from "../../src/core/reviewer-retry";
import { openRunDirectory, type RunDirHandle } from "../../src/orchestration/run-directory-handle";
import { buildContextPacket, buildReviewerContextPacket, contextPacketDigest, parseContextPacket, encodeByteSection, type ContextPacket } from "../../src/orchestration/context-packets";
import {
  parseRequestId,
  parseSlotId,
  parseStoredAgentRequestAuthority,
  type AgentRequestAuthority,
} from "../../src/core/orchestration-contract";
import { lowerModelProfile, resolveAgentPolicy, resolveModelProfile } from "../../src/core/model-profiles";
import { value } from "../fixtures/parse-result";

const cleanup: string[] = [];
afterAll(() => {
  for (const path of cleanup) rmSync(path, { recursive: true, force: true });
});

/** The historical binding: comment-analyzer ran on `mechanical` before it was
 * promoted. The tests assert this premise so they fail loudly rather than
 * silently passing if the catalog ever moves back. */
const ROLE = "comment-analyzer";
const STORED_PROFILE = "mechanical";

/** One run directory with an attempt-1 context already published. */
function publishedAttemptOne(
  prefix: string,
  profileId: string,
  slotSeed: string,
  requestSeed: string,
  protocolVersion: 1 | 2 = 1,
): Promise<Readonly<{ handle: RunDirHandle; attemptOne: AgentRequestAuthority; packet: ContextPacket }>> {
  const profile = resolveModelProfile(profileId);
  const runsRoot = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(runsRoot);
  const runDir = join(runsRoot, "run.storedauthority");
  mkdirSync(runDir);
  const handle = value(openRunDirectory(runsRoot, runDir));

  const section = value(
    encodeByteSection("wave-review-authority", JSON.stringify({ agent: ROLE })),
  );
  const slotId = value(parseSlotId(`slot:${slotSeed.repeat(32)}`));
  const requestId = value(parseRequestId(`wave-request:${requestSeed.repeat(32)}:1`));
  const packetInput = {
    requestId,
    role: ROLE,
    requiredSkill: "none",
    outputContract: "Emit an exact Review Packet.",
    fixedContext: Object.freeze([section]),
    variableContext: Object.freeze([]),
  };
  const packet = protocolVersion === 2
    ? value(buildReviewerContextPacket(packetInput))
    : value(buildContextPacket(packetInput));

  return handle.publishContext(packet).then((published) => {
    if (!published.ok) throw new Error("test context could not be published");
    // An immutable attempt-1 record: issued under `profileId`, with a
    // harnessBinding that truthfully records the model that actually ran.
    const attemptOne = value(parseStoredAgentRequestAuthority({
      runId: handle.runId,
      requestId,
      slotId,
      program: "wave-gate",
      role: ROLE,
      attempt: 1,
      modelProfile: profileId,
      harnessBinding: {
        pi: lowerModelProfile(value(profile), "pi"),
        claude: lowerModelProfile(value(profile), "claude-code"),
      },
      requiredSkill: null,
      contextDigest: packet.digest,
      outputSlot: { kind: "fixed-artifact-slot", path: `transcripts/${slotId}/attempt-1.raw` },
    }));
    return { handle, attemptOne, packet };
  });
}

describe("Wave attempt-2 derivation from stored attempt-1 authority", () => {
  it("preserves a grandfathered profile instead of re-checking today's policy", async () => {
    const currentPolicy = value(resolveAgentPolicy(ROLE));
    // Premise: the stored profile is NOT what policy would issue today.
    expect(currentPolicy.profile).not.toBe(STORED_PROFILE);

    const { handle, attemptOne, packet } = await publishedAttemptOne(
      "loom-stored-attempt2-", STORED_PROFILE, "a", "b",
    );

    // Previously threw: "role 'comment-analyzer' requires profile
    // 'focused-review', received 'mechanical'".
    const derived = deriveWaveAttemptTwo(handle, attemptOne, "attempt 1 omitted REVIEW_GENERATION");
    const attemptTwo = value(parseStoredAgentRequestAuthority(derived.request.authority));

    expect(attemptTwo.attempt).toBe(2);
    expect(attemptTwo.modelProfile).toBe(STORED_PROFILE);
    expect(attemptTwo.harnessBinding).toEqual(attemptOne.harnessBinding);
    expect(attemptTwo.requestId).toBe(attemptOne.requestId.replace(/:1$/, ":2"));
    expect(attemptTwo.outputSlot.path).toBe(attemptOne.outputSlot.path.replace(/attempt-1\.raw$/, "attempt-2.raw"));

    // The derivation must agree with the compatibility check that validates a
    // persisted attempt-2 — both derive the same value in the same mode.
    expect(persistedWaveAttemptTwoCompatibilityProblem(
      attemptOne, attemptTwo, packet, derived.packet,
    )).toBeNull();
  });

  it("keeps current descriptor and fixed bytes, appending exactly one bounded diagnostic instead of a duplicate schema", async () => {
    const policy = value(resolveAgentPolicy(ROLE));
    const { handle, attemptOne, packet } = await publishedAttemptOne("loom-v2-attempt2-", policy.profile, "e", "f", 2);
    const retry = deriveWaveAttemptTwo(handle, attemptOne, "bad input\n".repeat(2000));
    const authority = value(parseStoredAgentRequestAuthority(retry.request.authority));
    expect(retry.packet.schemaVersion).toBe(2);
    expect(retry.packet.fixedContext).toEqual(packet.fixedContext);
    expect(retry.packet.variableContext).toHaveLength(1);
    const section = retry.packet.variableContext[0]!;
    const parsed = parseWaveRetryDiagnosticSection(section.bytes, 2);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Buffer.byteLength(parsed.reason)).toBeLessThanOrEqual(2048);
    expect(Buffer.from(section.bytes).toString()).toContain("unchanged reviewer-payload-schema");
    expect(Buffer.from(section.bytes).toString()).not.toContain("review_lifecycle");
    expect(persistedWaveAttemptTwoCompatibilityProblem(attemptOne, authority, packet, retry.packet)).toBeNull();
    expect(() => deriveWaveAttemptTwo(handle, attemptOne)).toThrow("requires its rejection diagnostic");
    const stripped = { ...retry.packet, variableContext: [] };
    const noDiagnostic = value(parseContextPacket({ ...stripped, digest: contextPacketDigest(stripped) }));
    const rewrittenAuthority = value(parseStoredAgentRequestAuthority({ ...authority, contextDigest: noDiagnostic.digest }));
    expect(persistedWaveAttemptTwoCompatibilityProblem(attemptOne, rewrittenAuthority, packet, noDiagnostic)).not.toBeNull();
  });

  it("preserves historical retry text exactly, including multiline rejection reasons", async () => {
    const policy = value(resolveAgentPolicy(ROLE));
    const { handle, attemptOne } = await publishedAttemptOne("loom-v1-retry-text-", policy.profile, "1", "2");
    const reason = "bad lifecycle JSON:\n  exact historical diagnostic  ";
    const retry = deriveWaveAttemptTwo(handle, attemptOne, reason);
    expect(Buffer.from(retry.packet.variableContext[0]!.bytes).toString()).toBe(`${WAVE_RETRY_PREAMBLE}${reason}\n\n${WAVE_RETRY_FIXED_TAIL}`);
    expect(parseWaveRetryDiagnosticSection(retry.packet.variableContext[0]!.bytes, 1)).toEqual({ ok: true, reason });
  });

  it("keeps the retry on the current profile when nothing was grandfathered", async () => {
    const policy = value(resolveAgentPolicy(ROLE));
    const { handle, attemptOne, packet } = await publishedAttemptOne(
      "loom-current-attempt2-", policy.profile, "c", "d",
    );

    const derived = deriveWaveAttemptTwo(handle, attemptOne, "attempt 1 was malformed");
    const attemptTwo = value(parseStoredAgentRequestAuthority(derived.request.authority));

    expect(attemptTwo.modelProfile).toBe(policy.profile);
    expect(persistedWaveAttemptTwoCompatibilityProblem(
      attemptOne, attemptTwo, packet, derived.packet,
    )).toBeNull();
  });
});

/** The one canonical attempt-2 envelope both retry issuance and the
 *  persisted-retry compatibility check derive. */
describe("deriveWaveAttemptTwoAuthority", () => {
  it("is exactly the envelope retry issuance publishes", async () => {
    const policy = value(resolveAgentPolicy(ROLE));
    const { handle, attemptOne } = await publishedAttemptOne("loom-envelope-attempt2-", policy.profile, "3", "4");
    const derived = deriveWaveAttemptTwo(handle, attemptOne, "attempt 1 was malformed");
    const published = value(parseStoredAgentRequestAuthority(derived.request.authority));
    expect(deriveWaveAttemptTwoAuthority(attemptOne, derived.packet.digest)).toEqual({ ok: true, value: published });
    expect(waveAttemptTwoRequestId(attemptOne)).toEqual({ ok: true, value: published.requestId });
  });

  it("refuses, with one message on every path, an attempt 1 whose request id has no attempt suffix", async () => {
    const policy = value(resolveAgentPolicy(ROLE));
    const { handle, attemptOne, packet } = await publishedAttemptOne("loom-envelope-suffix-", policy.profile, "5", "6");
    const unsuffixed = { ...attemptOne, requestId: value(parseRequestId(`wave-request:${"7".repeat(32)}`)) };
    const message = `Wave request ${unsuffixed.requestId} cannot derive canonical attempt-2 identity`;
    expect(waveAttemptTwoRequestId(unsuffixed)).toEqual({ ok: false, error: message });
    expect(deriveWaveAttemptTwoAuthority(unsuffixed, packet.digest)).toEqual({ ok: false, error: message });
    expect(persistedWaveAttemptTwoCompatibilityProblem(unsuffixed, attemptOne, packet, packet)).toBe(message);
    expect(() => deriveWaveAttemptTwo(handle, unsuffixed, "reason")).toThrow(message);
  });

  it("refuses a persisted retry whose envelope drifted from the derivation", async () => {
    const policy = value(resolveAgentPolicy(ROLE));
    const { handle, attemptOne, packet } = await publishedAttemptOne("loom-envelope-drift-", policy.profile, "8", "9");
    const derived = deriveWaveAttemptTwo(handle, attemptOne, "attempt 1 was malformed");
    const published = value(parseStoredAgentRequestAuthority(derived.request.authority));
    const drifted = { ...published, modelProfile: "mechanical" } as typeof published;
    expect(persistedWaveAttemptTwoCompatibilityProblem(attemptOne, drifted, packet, derived.packet))
      .toBe("persisted attempt-2 request envelope does not derive from attempt 1");
  });
});
