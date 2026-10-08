import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AGENT_POLICIES,
  LLM_PROFILE_IDS,
  RETIRED_LLM_PROFILE_IDS,
  recordedProfileBindings,
  type PiBinding,
  type RecordedLlmProfileId,
} from "../../src/core/model-profiles";
import { parseAgentRequestAuthority, parseStoredAgentRequestAuthority } from "../../src/core/orchestration-contract";
import { prepareFreshStandaloneReview } from "../../src/core/standalone-review-preparation";

/**
 * A request authority is issued against today's catalog and read back as
 * history. Retargeting every Pi profile to the local route (2026-10-08) and
 * retiring `qualified-local-review` must not strand a run already on disk,
 * while a binding its profile never issued stays a tamper refusal.
 */

const RECORDED_IDS: readonly RecordedLlmProfileId[] = [...LLM_PROFILE_IDS, ...RETIRED_LLM_PROFILE_IDS];
const LOCAL: PiBinding = Object.freeze({
  harness: "pi", provider: "desktop-vllm", model: "glm-5.3-flash-spark-tp2-v14", thinking: "high",
});
const SOL: PiBinding = Object.freeze({ harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" });

/** Every Pi binding the vocabulary can record, across all profiles. */
const VOCABULARY: readonly PiBinding[] = [...new Map(RECORDED_IDS.flatMap((id) => recordedProfileBindings(id).pi)
  .map((binding) => [`${binding.provider}/${binding.model}:${binding.thinking}`, binding])).values()];

function request(modelProfile: RecordedLlmProfileId, pi: PiBinding, role = "code-reviewer", program = "standalone-review") {
  const policy = AGENT_POLICIES.find(({ agent }) => agent === role)!;
  return {
    runId: "run:recorded-authority",
    requestId: "request:recorded-authority",
    slotId: "slot:recorded-authority",
    program,
    role,
    attempt: 1,
    modelProfile,
    harnessBinding: { pi, claude: recordedProfileBindings(modelProfile).claude },
    requiredSkill: policy.requiredSkill,
    contextDigest: "a".repeat(64),
    outputSlot: "transcripts/slot:recorded-authority/attempt-1.raw",
  };
}

const kinds = (result: ReturnType<typeof parseAgentRequestAuthority>): readonly string[] =>
  result.ok ? [] : result.error.violations.map(({ kind, field }) => `${kind}:${field}`);

describe("stored request authority is history", () => {
  it("reads back a reviewer issued on the retired cloud route", () => {
    const stored = parseStoredAgentRequestAuthority(request("general-review", SOL));
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.value.harnessBinding.pi).toEqual(SOL);
  });

  it("reads back a reviewer issued under the retired qualified-local-review profile", () => {
    const stored = parseStoredAgentRequestAuthority(request("qualified-local-review", LOCAL));
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.value.modelProfile).toBe("qualified-local-review");
  });

  it("admits a stored Pi binding exactly when its recorded profile has issued it", () => {
    fc.assert(fc.property(fc.constantFrom(...RECORDED_IDS), fc.constantFrom(...VOCABULARY), (profile, pi) => {
      const issuedByProfile = recordedProfileBindings(profile).pi
        .some((candidate) => JSON.stringify(candidate) === JSON.stringify(pi));
      const stored = parseStoredAgentRequestAuthority(request(profile, pi));
      expect(stored.ok, `${profile} ${JSON.stringify(pi)}`).toBe(issuedByProfile);
      if (!issuedByProfile) {
        expect(kinds(stored).some((kind) => kind.startsWith("model-binding-mismatch:harnessBinding.pi"))).toBe(true);
      }
    }));
  });

  it("refuses a stored Claude model its profile never bound", () => {
    const tampered = { ...request("general-review", SOL), harnessBinding: { pi: SOL, claude: { harness: "claude-code", model: "opus" } } };
    expect(kinds(parseStoredAgentRequestAuthority(tampered))).toContain("model-binding-mismatch:harnessBinding.claude.model");
  });
});

describe("issued request authority is today's catalog", () => {
  it("issues every role under its catalog profile on the local route", () => {
    for (const policy of AGENT_POLICIES) {
      expect(parseAgentRequestAuthority(request(policy.profile, LOCAL, policy.agent)).ok, policy.agent).toBe(true);
    }
  });

  it("refuses a retired cloud binding at issuance", () => {
    expect(kinds(parseAgentRequestAuthority(request("general-review", SOL))))
      .toContain("model-binding-mismatch:harnessBinding.pi.provider");
  });

  it("refuses the retired qualified-local-review profile at issuance", () => {
    expect(kinds(parseAgentRequestAuthority(request("qualified-local-review", LOCAL))))
      .toContain("invalid-agent-request-field:modelProfile");
  });

  it("raises model-policy-mismatch exactly where the profile is not the role's catalog profile", () => {
    for (const policy of AGENT_POLICIES) for (const profile of LLM_PROFILE_IDS) {
      const mismatch = kinds(parseAgentRequestAuthority(request(profile, LOCAL, policy.agent)))
        .includes("model-policy-mismatch:modelProfile");
      expect(mismatch, `${policy.agent}/${profile}`).toBe(profile !== policy.profile);
    }
  });

  it("prepares every fresh standalone reviewer request under its catalog profile on the local route", () => {
    const prepared = prepareFreshStandaloneReview({
      runId: "run.review-local",
      explicitScope: ["src/x.ts"],
      changedPaths: {
        unstaged: ["src/x.ts"], staged: [], committed: [], base_revision: null,
        head_revision: "0123456789abcdef0123456789abcdef01234567",
      },
      reviewMetadata: {
        requested_kinds: ["types"], docs_only: false, source_or_test_changed: false,
        types_changed: true, comments_changed: false, additions: 1, file_count: 1,
        new_structure: false, languages: ["TypeScript"],
      },
      scopeSafety: [{ path: "src/x.ts", status: "safe" }],
      reviewerContexts: [
        { attempts: ["1".repeat(64), "2".repeat(64)] },
        { attempts: ["3".repeat(64), "4".repeat(64)] },
      ],
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const requests = prepared.value.authority.roster.orderedSlots.flatMap(({ attempts }) => attempts);
    expect(requests).toHaveLength(4);
    for (const issued of requests) {
      expect(issued.modelProfile).toBe(AGENT_POLICIES.find(({ agent }) => agent === issued.role)!.profile);
      expect(issued.harnessBinding.pi).toEqual(LOCAL);
    }
  });
});
