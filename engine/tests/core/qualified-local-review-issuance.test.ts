import { describe, expect, it } from "vitest";
import {
  AGENT_POLICIES,
  isIssuableProfile,
  issuedReviewerProfile,
  LLM_PROFILE_IDS,
  lowerModelProfile,
  QUALIFIED_LOCAL_REVIEW_PROGRAMS,
  resolveModelProfile,
} from "../../src/core/model-profiles";
import { parseAgentRequestAuthority, parseStoredAgentRequestAuthority } from "../../src/core/orchestration-contract";
import { ORCHESTRATION_PROGRAMS } from "../../src/core/orchestration-contract/artifacts";
import { prepareFreshStandaloneReview, parseStandaloneReviewAuthority } from "../../src/core/standalone-review-preparation";
import { serializeStandaloneReviewAuthority } from "../../src/core/standalone-review-records";

const local = resolveModelProfile("qualified-local-review");
if (!local.ok) throw new Error(local.error.message);
const binding = {
  pi: lowerModelProfile(local.value, "pi"),
  claude: lowerModelProfile(local.value, "claude-code"),
};

function request(role: string, program: string, harnessBinding: unknown = binding) {
  return {
    runId: "run:qualified-local-issuance",
    requestId: "request:qualified-local-issuance",
    slotId: "slot:qualified-local-issuance",
    program,
    role,
    attempt: 1,
    modelProfile: "qualified-local-review",
    harnessBinding,
    requiredSkill: null,
    contextDigest: "a".repeat(64),
    outputSlot: "transcripts/slot:qualified-local-issuance/attempt-1.raw",
  };
}

/** Exact bindings for any catalog profile, so a policy verdict is never masked
 *  by a binding mismatch. */
function bindingOf(profileId: string) {
  const profile = resolveModelProfile(profileId);
  if (!profile.ok) throw new Error(profile.error.message);
  return { pi: lowerModelProfile(profile.value, "pi"), claude: lowerModelProfile(profile.value, "claude-code") };
}

describe("issuer and issue-mode parser share one eligibility rule", () => {
  it("the parser raises model-policy-mismatch exactly where isIssuableProfile refuses", () => {
    for (const policy of AGENT_POLICIES) for (const program of ORCHESTRATION_PROGRAMS) for (const id of LLM_PROFILE_IDS) {
      const parsed = parseAgentRequestAuthority({
        ...request(policy.agent, program, bindingOf(id)), modelProfile: id, requiredSkill: policy.requiredSkill,
      });
      const policyMismatch = !parsed.ok && parsed.error.violations.some(({ kind }) => kind === "model-policy-mismatch");
      expect(policyMismatch, `${policy.agent}/${program}/${id}`).toBe(!isIssuableProfile(policy, program, id));
    }
  });

  it("every request the issuer elects on either route is accepted by the parser", () => {
    for (const policy of AGENT_POLICIES) for (const program of QUALIFIED_LOCAL_REVIEW_PROGRAMS) {
      for (const route of ["catalog", "qualified-local"] as const) {
        const profile = issuedReviewerProfile(policy.agent, program, route);
        if (!profile.ok) throw new Error(profile.error.message);
        const parsed = parseAgentRequestAuthority({
          ...request(policy.agent, program, bindingOf(profile.value.id)),
          modelProfile: profile.value.id, requiredSkill: policy.requiredSkill,
        });
        expect(parsed.ok, `${policy.agent}/${program}/${route}`).toBe(true);
      }
    }
  });
});

describe("issued qualified-local reviewer profile", () => {
  it.each(["wave-gate", "standalone-review"])("mints a complete exact %s reviewer request", (program) => {
    const issued = parseAgentRequestAuthority(request("code-reviewer", program));
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect(issued.value.harnessBinding).toEqual(binding);
    expect(parseStoredAgentRequestAuthority(JSON.parse(JSON.stringify(issued.value)))).toEqual(issued);
  });

  it.each([
    ["review-verifier-agent", "wave-gate"],
    ["spec-check-invoker", "wave-gate"],
    ["code-reviewer", "refutation-panel"],
    ["code-implementer-agent", "standalone-review"],
  ])("never applies a local reviewer alternative to %s in %s", (role, program) => {
    const rejected = parseAgentRequestAuthority(request(role, program));
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.violations.map(({ kind }) => kind)).toContain("model-policy-mismatch");
  });

  it("prepares and reopens exact local standalone v2 reviewer requests with both attempts frozen", () => {
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
      reviewerIssueRoute: "qualified-local",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.authority.schemaVersion).toBe(2);
    expect(prepared.value.authority.roster.orderedSlots.flatMap(({ attempts }) => attempts.map((request) =>
      [request.modelProfile, request.harnessBinding.pi]))).toEqual(Array(4).fill(null).map(() =>
      ["qualified-local-review", binding.pi]));
    const restored = parseStandaloneReviewAuthority(JSON.parse(serializeStandaloneReviewAuthority(prepared.value.authority)));
    expect(restored.ok).toBe(true);
  });

  it("refuses swapping the local binding's provider, model, thinking or Claude model", () => {
    const changed = [
      { pi: { ...binding.pi, provider: "openai-codex" }, claude: binding.claude },
      { pi: { ...binding.pi, model: "glm-5.3-flash-spark-tp2-v15" }, claude: binding.claude },
      { pi: { ...binding.pi, thinking: "medium" }, claude: binding.claude },
      { pi: binding.pi, claude: { ...binding.claude, model: "opus" } },
    ];
    for (const swapped of changed) {
      expect(parseAgentRequestAuthority(request("code-reviewer", "wave-gate", swapped))).toMatchObject({
        ok: false, error: { violations: [{ kind: "model-binding-mismatch" }] },
      });
    }
  });
});
