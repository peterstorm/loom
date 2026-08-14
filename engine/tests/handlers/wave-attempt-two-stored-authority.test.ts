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
import {
  deriveWaveAttemptTwo,
  persistedWaveAttemptTwoCompatibilityProblem,
} from "../../src/handlers/helpers/programs/wave-gate";
import { openRunDirectory, type RunDirHandle } from "../../src/orchestration/run-directory-handle";
import { buildContextPacket, encodeByteSection, type ContextPacket } from "../../src/orchestration/context-packets";
import {
  parseRequestId,
  parseSlotId,
  parseStoredAgentRequestAuthority,
  type AgentRequestAuthority,
} from "../../src/core/orchestration-contract";
import { lowerModelProfile, resolveAgentPolicy, resolveModelProfile } from "../../src/core/model-profiles";

const cleanup: string[] = [];
afterAll(() => {
  for (const path of cleanup) rmSync(path, { recursive: true, force: true });
});

const authorityValue = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(`invalid test authority: ${JSON.stringify(result.error)}`);
  return result.value;
};

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
): Promise<Readonly<{ handle: RunDirHandle; attemptOne: AgentRequestAuthority; packet: ContextPacket }>> {
  const profile = resolveModelProfile(profileId);
  const runsRoot = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(runsRoot);
  const runDir = join(runsRoot, "run.storedauthority");
  mkdirSync(runDir);
  const handle = authorityValue(openRunDirectory(runsRoot, runDir));

  const section = authorityValue(
    encodeByteSection("wave-review-authority", JSON.stringify({ agent: ROLE })),
  );
  const slotId = authorityValue(parseSlotId(`slot:${slotSeed.repeat(32)}`));
  const requestId = authorityValue(parseRequestId(`wave-request:${requestSeed.repeat(32)}:1`));
  const packet = authorityValue(buildContextPacket({
    requestId,
    role: ROLE,
    requiredSkill: "none",
    outputContract: "Emit an exact Review Packet.",
    fixedContext: Object.freeze([section]),
    variableContext: Object.freeze([]),
  }));

  return handle.publishContext(packet).then((published) => {
    if (!published.ok) throw new Error("test context could not be published");
    // An immutable attempt-1 record: issued under `profileId`, with a
    // harnessBinding that truthfully records the model that actually ran.
    const attemptOne = authorityValue(parseStoredAgentRequestAuthority({
      runId: handle.runId,
      requestId,
      slotId,
      program: "wave-gate",
      role: ROLE,
      attempt: 1,
      modelProfile: profileId,
      harnessBinding: {
        pi: lowerModelProfile(authorityValue(profile), "pi"),
        claude: lowerModelProfile(authorityValue(profile), "claude-code"),
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
    const currentPolicy = authorityValue(resolveAgentPolicy(ROLE));
    // Premise: the stored profile is NOT what policy would issue today.
    expect(currentPolicy.profile).not.toBe(STORED_PROFILE);

    const { handle, attemptOne, packet } = await publishedAttemptOne(
      "loom-stored-attempt2-", STORED_PROFILE, "a", "b",
    );

    // Previously threw: "role 'comment-analyzer' requires profile
    // 'focused-review', received 'mechanical'".
    const derived = deriveWaveAttemptTwo(handle, attemptOne, "attempt 1 omitted REVIEW_GENERATION");
    const attemptTwo = authorityValue(parseStoredAgentRequestAuthority(derived.request.authority));

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

  it("keeps the retry on the current profile when nothing was grandfathered", async () => {
    const policy = authorityValue(resolveAgentPolicy(ROLE));
    const { handle, attemptOne, packet } = await publishedAttemptOne(
      "loom-current-attempt2-", policy.profile, "c", "d",
    );

    const derived = deriveWaveAttemptTwo(handle, attemptOne, "attempt 1 was malformed");
    const attemptTwo = authorityValue(parseStoredAgentRequestAuthority(derived.request.authority));

    expect(attemptTwo.modelProfile).toBe(policy.profile);
    expect(persistedWaveAttemptTwoCompatibilityProblem(
      attemptOne, attemptTwo, packet, derived.packet,
    )).toBeNull();
  });
});
