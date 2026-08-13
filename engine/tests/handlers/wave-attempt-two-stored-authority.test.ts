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

import { describe, expect, it, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveWaveAttemptTwo,
  persistedWaveAttemptTwoCompatibilityProblem,
} from "../../src/handlers/helpers/programs/wave-gate";
import { openRunDirectory } from "../../src/orchestration/run-directory-handle";
import { buildContextPacket, encodeByteSection } from "../../src/orchestration/context-packets";
import { parseStoredAgentRequestAuthority } from "../../src/core/orchestration-contract";
import { lowerModelProfile, resolveAgentPolicy, resolveModelProfile } from "../../src/core/model-profiles";

const cleanup: string[] = [];
afterAll(() => {
  for (const path of cleanup) rmSync(path, { recursive: true, force: true });
});

/** The historical binding: comment-analyzer ran on `mechanical` before it was
 * promoted. The test asserts this premise so it fails loudly rather than
 * silently passing if the catalog ever moves back. */
const ROLE = "comment-analyzer";
const STORED_PROFILE = "mechanical";

describe("Wave attempt-2 derivation from stored attempt-1 authority", () => {
  it("preserves a grandfathered profile instead of re-checking today's policy", async () => {
    const currentPolicy = resolveAgentPolicy(ROLE);
    expect(currentPolicy.ok).toBe(true);
    if (!currentPolicy.ok) return;
    // Premise: the stored profile is NOT what policy would issue today.
    expect(currentPolicy.value.profile).not.toBe(STORED_PROFILE);

    const storedProfile = resolveModelProfile(STORED_PROFILE);
    expect(storedProfile.ok).toBe(true);
    if (!storedProfile.ok) return;

    const runsRoot = mkdtempSync(join(tmpdir(), "loom-stored-attempt2-"));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.storedattempt2");
    mkdirSync(runDir);
    const opened = openRunDirectory(runsRoot, runDir);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const handle = opened.value;

    const section = encodeByteSection("wave-review-authority", JSON.stringify({ task: "T1", agent: ROLE }));
    expect(section.ok).toBe(true);
    if (!section.ok) return;
    const slotId = "slot:" + "a".repeat(32);
    const requestId = "wave-request:" + "b".repeat(32) + ":1";
    const packet = buildContextPacket({
      requestId,
      role: ROLE,
      requiredSkill: "none",
      outputContract: "Emit an exact Review Packet.",
      fixedContext: Object.freeze([section.value]),
      variableContext: Object.freeze([]),
    });
    expect(packet.ok).toBe(true);
    if (!packet.ok) return;
    const published = await handle.publishContext(packet.value);
    expect(published.ok).toBe(true);

    // An immutable attempt-1 record: issued under the OLD profile, and whose
    // harnessBinding truthfully records the model that actually ran.
    const attemptOne = parseStoredAgentRequestAuthority({
      runId: handle.runId,
      requestId,
      slotId,
      program: "wave-gate",
      role: ROLE,
      attempt: 1,
      modelProfile: STORED_PROFILE,
      harnessBinding: {
        pi: lowerModelProfile(storedProfile.value, "pi"),
        claude: lowerModelProfile(storedProfile.value, "claude-code"),
      },
      requiredSkill: null,
      contextDigest: packet.value.digest,
      outputSlot: { kind: "fixed-artifact-slot", path: `transcripts/${slotId}/attempt-1.raw` },
    });
    expect(attemptOne.ok, attemptOne.ok ? "" : JSON.stringify(attemptOne.error)).toBe(true);
    if (!attemptOne.ok) return;

    // Previously threw: "role 'comment-analyzer' requires profile
    // 'focused-review', received 'mechanical'".
    const derived = deriveWaveAttemptTwo(handle, attemptOne.value, "attempt 1 omitted REVIEW_GENERATION");

    const attemptTwo = derived.request.authority;
    expect(attemptTwo.attempt).toBe(2);
    expect(attemptTwo.modelProfile).toBe(STORED_PROFILE);
    expect(attemptTwo.harnessBinding).toEqual(attemptOne.value.harnessBinding);
    expect(attemptTwo.requestId).toBe("wave-request:" + "b".repeat(32) + ":2");
    expect(attemptTwo.outputSlot.path).toBe(`transcripts/${slotId}/attempt-2.raw`);

    // The derivation must agree with the compatibility check that validates a
    // persisted attempt-2 — the two derive the same value in the same mode.
    expect(persistedWaveAttemptTwoCompatibilityProblem(
      attemptOne.value, attemptTwo, packet.value, derived.packet,
    )).toBeNull();
  });

  it("keeps the retry on the current profile when nothing was grandfathered", async () => {
    const policy = resolveAgentPolicy(ROLE);
    expect(policy.ok).toBe(true);
    if (!policy.ok) return;
    const profile = resolveModelProfile(policy.value.profile);
    expect(profile.ok).toBe(true);
    if (!profile.ok) return;

    const runsRoot = mkdtempSync(join(tmpdir(), "loom-current-attempt2-"));
    cleanup.push(runsRoot);
    const runDir = join(runsRoot, "run.currentattempt2");
    mkdirSync(runDir);
    const opened = openRunDirectory(runsRoot, runDir);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const handle = opened.value;

    const section = encodeByteSection("wave-review-authority", JSON.stringify({ task: "T2", agent: ROLE }));
    expect(section.ok).toBe(true);
    if (!section.ok) return;
    const slotId = "slot:" + "c".repeat(32);
    const requestId = "wave-request:" + "d".repeat(32) + ":1";
    const packet = buildContextPacket({
      requestId,
      role: ROLE,
      requiredSkill: "none",
      outputContract: "Emit an exact Review Packet.",
      fixedContext: Object.freeze([section.value]),
      variableContext: Object.freeze([]),
    });
    expect(packet.ok).toBe(true);
    if (!packet.ok) return;
    expect((await handle.publishContext(packet.value)).ok).toBe(true);

    const attemptOne = parseStoredAgentRequestAuthority({
      runId: handle.runId,
      requestId,
      slotId,
      program: "wave-gate",
      role: ROLE,
      attempt: 1,
      modelProfile: policy.value.profile,
      harnessBinding: {
        pi: lowerModelProfile(profile.value, "pi"),
        claude: lowerModelProfile(profile.value, "claude-code"),
      },
      requiredSkill: null,
      contextDigest: packet.value.digest,
      outputSlot: { kind: "fixed-artifact-slot", path: `transcripts/${slotId}/attempt-1.raw` },
    });
    expect(attemptOne.ok).toBe(true);
    if (!attemptOne.ok) return;

    const derived = deriveWaveAttemptTwo(handle, attemptOne.value, "attempt 1 was malformed");

    expect(derived.request.authority.modelProfile).toBe(policy.value.profile);
    expect(persistedWaveAttemptTwoCompatibilityProblem(
      attemptOne.value, derived.request.authority, packet.value, derived.packet,
    )).toBeNull();
  });
});
