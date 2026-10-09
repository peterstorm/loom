import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AGENT_POLICIES,
  LLM_PROFILE_IDS,
  RETIRED_LLM_PROFILE_IDS,
  currentProfileBindings,
  piModelPattern,
  recordedProfileBindings,
  type PiBinding,
  type RecordedLlmProfileId,
} from "../../src/core/model-profiles";
import {
  issueAgentRosterSlot,
  parseAgentRequestAuthority,
  parseAgentRosterSlot,
  parseStoredAgentRequestAuthority,
  type AgentRequestAuthority,
  type AgentRosterSlot,
  type MintedAgentRequestAuthority,
} from "../../src/core/orchestration-contract";
import { samePiBinding } from "../../src/core/orchestration-contract/roster";
import { issueRefutationPanelAuthority } from "../../src/core/panel-authority";
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
const PI_FIELDS = ["harness", "provider", "model", "thinking"] as const;

/** Every Pi binding the vocabulary can record, across all profiles, keyed by its model pattern. */
const VOCABULARY: readonly PiBinding[] = [...new Map(RECORDED_IDS.flatMap((id) => recordedProfileBindings(id).pi)
  .map((binding) => [piModelPattern(binding), binding])).values()];

const issuedBy = (profile: RecordedLlmProfileId, pi: PiBinding): boolean =>
  recordedProfileBindings(profile).pi.some((candidate) => samePiBinding(pi, candidate));

function request(
  modelProfile: RecordedLlmProfileId,
  pi: PiBinding,
  role = "code-reviewer",
  program = "standalone-review",
  attempt: 1 | 2 = 1,
) {
  const policy = AGENT_POLICIES.find(({ agent }) => agent === role)!;
  return {
    runId: "run:recorded-authority",
    requestId: `request:recorded-authority-${attempt}`,
    slotId: "slot:recorded-authority",
    program,
    role,
    attempt,
    modelProfile,
    harnessBinding: { pi, claude: recordedProfileBindings(modelProfile).claude },
    requiredSkill: policy.requiredSkill,
    contextDigest: String(attempt).repeat(64),
    outputSlot: `transcripts/slot:recorded-authority/attempt-${attempt}.raw`,
  };
}

const kinds = (result: ReturnType<typeof parseStoredAgentRequestAuthority>): readonly string[] =>
  result.ok ? [] : result.error.violations.map(({ kind, field }) => `${kind}:${field}`);

const piViolations = (result: ReturnType<typeof parseStoredAgentRequestAuthority>) =>
  result.ok ? [] : result.error.violations.filter(({ field }) => field.startsWith("harnessBinding.pi"));

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
      const stored = parseStoredAgentRequestAuthority(request(profile, pi));
      expect(stored.ok, `${profile} ${piModelPattern(pi)}`).toBe(issuedBy(profile, pi));
    }));
  });

  it("refuses a stored binding its profile never issued once, against the whole recorded set", () => {
    fc.assert(fc.property(fc.constantFrom(...RECORDED_IDS), fc.constantFrom(...VOCABULARY), (profile, pi) => {
      fc.pre(!issuedBy(profile, pi));
      const violations = piViolations(parseStoredAgentRequestAuthority(request(profile, pi)));
      expect(violations).toHaveLength(1);
      expect(violations[0]!.kind).toBe("model-binding-mismatch");
      expect(violations[0]!.field).toBe("harnessBinding.pi");
      for (const admitted of recordedProfileBindings(profile).pi) {
        expect(violations[0]!.message).toContain(piModelPattern(admitted));
      }
    }));
  });

  it("reports the set-level refusal even for a profile with a single recorded binding", () => {
    const violations = piViolations(parseStoredAgentRequestAuthority(request("qualified-local-review", SOL)));
    expect(violations.map(({ field }) => field)).toEqual(["harnessBinding.pi"]);
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

  it("admits at issuance exactly the profile's current catalog lowering", () => {
    fc.assert(fc.property(fc.constantFrom(...AGENT_POLICIES), fc.constantFrom(...VOCABULARY), (policy, pi) => {
      const current = currentProfileBindings(policy.profile).pi;
      const issued = parseAgentRequestAuthority(request(policy.profile, pi, policy.agent));
      expect(issued.ok, `${policy.agent} ${piModelPattern(pi)}`).toBe(samePiBinding(pi, current));
    }));
  });

  it("names exactly the differing fields of a binding refused at issuance", () => {
    fc.assert(fc.property(fc.constantFrom(...AGENT_POLICIES), fc.constantFrom(...VOCABULARY), (policy, pi) => {
      const current = currentProfileBindings(policy.profile).pi;
      const differing = PI_FIELDS.filter((key) => pi[key] !== current[key]).map((key) => `harnessBinding.pi.${key}`);
      const fields = piViolations(parseAgentRequestAuthority(request(policy.profile, pi, policy.agent))).map(({ field }) => field);
      expect(fields).toEqual(differing);
    }));
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

describe("a minted authority is the only thing an issuing seam accepts", () => {
  const mint = (attempt: 1 | 2): MintedAgentRequestAuthority => {
    const minted = parseAgentRequestAuthority(request("general-review", LOCAL, "code-reviewer", "standalone-review", attempt));
    if (!minted.ok) throw new Error(JSON.stringify(minted.error));
    return minted.value;
  };

  it("issues the same slot a stored read of the same requests parses", () => {
    const issued = issueAgentRosterSlot(mint(1), mint(2));
    const stored = parseAgentRosterSlot(mint(1), mint(2));
    expect(issued).toEqual(stored);
    expect(issued.ok).toBe(true);
  });

  it("refuses a slot whose minted requests are out of attempt order", () => {
    const swapped = issueAgentRosterSlot(mint(2), mint(1));
    expect(swapped.ok).toBe(false);
    if (!swapped.ok) {
      expect(swapped.error.violations.map((v) => v.kind)).toEqual(["malformed-attempt-authority", "malformed-attempt-authority"]);
    }
  });

  it("rejects, at compile time, a stored authority or roster slot handed to an issuing seam", () => {
    const stored = parseStoredAgentRequestAuthority(request("general-review", SOL));
    if (!stored.ok) throw new Error("stored authority must parse");
    const recorded: AgentRequestAuthority = stored.value;
    // @ts-expect-error a stored authority never passed the catalog check
    expect(issueAgentRosterSlot(recorded, recorded).ok).toBe(false);

    const slot = parseAgentRosterSlot(mint(1), mint(2));
    if (!slot.ok) throw new Error("slot must parse");
    const storedSlots: readonly AgentRosterSlot[] = [slot.value];
    const panel = () => issueRefutationPanelAuthority({
      runId: "run:recorded-authority",
      findings: [],
      lenses: [],
      // @ts-expect-error a re-read roster slot is history, not an issued one
      verifierSlots: storedSlots,
    });
    expect(panel().ok).toBe(false);
  });
});
