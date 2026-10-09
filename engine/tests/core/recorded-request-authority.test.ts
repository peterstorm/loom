import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AGENT_POLICIES,
  LLM_PROFILE_IDS,
  RETIRED_LLM_PROFILE_IDS,
  currentProfileBindings,
  piModelPattern,
  recordedProfileBindings,
  type LlmProfileId,
  type LocalPiBinding,
  type PiBinding,
  type RecordedLlmProfileId,
} from "../../src/core/model-profiles";
import {
  issueAgentRosterSlot,
  mintAgentRequestAuthority,
  parseAgentRequestAuthority,
  parseAgentRosterSlot,
  parseOrchestrationRunId,
  parseStoredAgentRequestAuthority,
  type AgentRequestAuthority,
  type AgentRosterSlot,
  type MintedAgentRequestAuthority,
  type MintedAgentRosterSlot,
  type MintedHarnessBinding,
} from "../../src/core/orchestration-contract";
import { parseProfileAuthority, samePiBinding } from "../../src/core/orchestration-contract/roster";
import { deriveRefutationVerifierBinding, issueRefutationPanelAuthority, parseRefutationPanelAuthority } from "../../src/core/panel-authority";
import { parseWaveFindingId } from "../../src/core/review-panel";
import { prepareFreshStandaloneReview } from "../../src/core/standalone-review-preparation";
import { LOCAL_PI_BINDING, RETIRED_CLOUD_PI_BINDING } from "../fixtures/local-pi-binding";

/**
 * A request authority is issued against today's catalog and read back as
 * history. Retargeting every Pi profile to the local route (2026-10-08) and
 * retiring `qualified-local-review` must not strand a run already on disk,
 * while a binding its profile never issued stays a tamper refusal.
 */

const RECORDED_IDS: readonly RecordedLlmProfileId[] = [...LLM_PROFILE_IDS, ...RETIRED_LLM_PROFILE_IDS];
const LOCAL: PiBinding = LOCAL_PI_BINDING;
const SOL: PiBinding = RETIRED_CLOUD_PI_BINDING;
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

describe("the profile authority admits a Pi binding by its origin's strategy", () => {
  const profileAuthority = (profile: RecordedLlmProfileId, origin: "issue" | "stored") => {
    const parsed = parseProfileAuthority(profile, origin);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.value;
  };

  it("admits a recorded binding exactly when the recorded profile has issued it, returning that binding", () => {
    fc.assert(fc.property(fc.constantFrom(...RECORDED_IDS), fc.constantFrom(...VOCABULARY), (profile, pi) => {
      const admitted = profileAuthority(profile, "stored").admitPi({ ...pi });
      expect(admitted.ok, `${profile} ${piModelPattern(pi)}`).toBe(issuedBy(profile, pi));
      if (admitted.ok) expect(admitted.value).toEqual(pi);
      else expect(admitted.error.map(({ field }) => field)).toEqual(["harnessBinding.pi"]);
    }));
  });

  it("admits at issuance only the catalog profile's current binding, naming each differing field", () => {
    fc.assert(fc.property(fc.constantFrom(...LLM_PROFILE_IDS), fc.constantFrom(...VOCABULARY), (profile, pi) => {
      const current = currentProfileBindings(profile).pi;
      const admitted = profileAuthority(profile, "issue").admitPi({ ...pi });
      expect(admitted.ok).toBe(samePiBinding(pi, current));
      if (admitted.ok) expect(admitted.value).toEqual(current);
      else expect(admitted.error.map(({ field }) => field))
        .toEqual(PI_FIELDS.filter((key) => pi[key] !== current[key]).map((key) => `harnessBinding.pi.${key}`));
    }));
  });

  it("admits at issuance a subset of what the same profile admits as history", () => {
    fc.assert(fc.property(fc.constantFrom(...LLM_PROFILE_IDS), fc.constantFrom(...VOCABULARY), (profile, pi) => {
      fc.pre(profileAuthority(profile, "issue").admitPi(pi).ok);
      expect(profileAuthority(profile, "stored").admitPi(pi).ok).toBe(true);
    }));
  });

  it("refuses every non-binding shape in both origins", () => {
    const shapes = fc.oneof(
      fc.constant(undefined), fc.constant(null), fc.string(), fc.integer(), fc.array(fc.string()),
      fc.dictionary(fc.string(), fc.string()),
      fc.constantFrom(...VOCABULARY).map((pi) => ({ ...pi, extra: true })),
    );
    const origins = fc.constantFrom("issue" as const, "stored" as const);
    fc.assert(fc.property(fc.constantFrom(...LLM_PROFILE_IDS), origins, shapes, (profile, origin, raw) => {
      const admitted = profileAuthority(profile, origin).admitPi(raw);
      expect(admitted.ok).toBe(false);
      if (!admitted.ok) expect(admitted.error.length).toBeGreaterThan(0);
    }));
  });

  it("names no retired profile at issuance and every recorded one in history", () => {
    for (const profile of RETIRED_LLM_PROFILE_IDS) {
      expect(parseProfileAuthority(profile, "issue").ok).toBe(false);
      expect(parseProfileAuthority(profile, "stored").ok).toBe(true);
    }
    expect(parseProfileAuthority(7, "stored")).toMatchObject({ ok: false });
  });
});

describe("the catalog mints a request from its identity alone", () => {
  const identity = <Attempt extends 1 | 2>(role: (typeof AGENT_POLICIES)[number]["agent"], attempt: Attempt) => ({
    runId: "run:minted-authority",
    requestId: `request:minted-${role}-${attempt}`,
    slotId: `slot:minted-${role}`,
    program: "standalone-review" as const,
    role,
    attempt,
    contextDigest: String(attempt).repeat(64),
    outputSlot: `transcripts/slot:minted-${role}/attempt-${attempt}.raw`,
  });

  it("fills every role's catalog profile, current bindings and Skill, and agrees with the strict parse", () => {
    for (const policy of AGENT_POLICIES) {
      const minted = mintAgentRequestAuthority(identity(policy.agent, 1));
      expect(minted.ok, policy.agent).toBe(true);
      if (!minted.ok) continue;
      expect(minted.value.modelProfile).toBe(policy.profile);
      expect(minted.value.requiredSkill).toBe(policy.requiredSkill);
      expect(minted.value.harnessBinding).toEqual(currentProfileBindings(policy.profile));
      expect(parseAgentRequestAuthority(minted.value)).toEqual(minted);
    }
  });

  it("keeps the attempt it was asked to mint, so a minted pair issues a slot", () => {
    const first = mintAgentRequestAuthority(identity("code-reviewer", 1));
    const retry = mintAgentRequestAuthority({ ...identity("code-reviewer", 2), requestId: "request:minted-retry" });
    if (!first.ok || !retry.ok) throw new Error("mint failed");
    expect(issueAgentRosterSlot(first.value, retry.value).ok).toBe(true);
  });

  it("refuses an identity whose own fields do not parse", () => {
    expect(mintAgentRequestAuthority({ ...identity("code-reviewer", 1), contextDigest: "not-a-digest" }))
      .toMatchObject({ ok: false, error: { violations: [expect.objectContaining({ field: "contextDigest" })] } });
  });

  it("types a minted authority narrower than history: a catalog profile on the local route", () => {
    const minted = mintAgentRequestAuthority(identity("code-reviewer", 1));
    if (!minted.ok) throw new Error("mint failed");
    const binding: LocalPiBinding = minted.value.harnessBinding.pi;
    const profile: LlmProfileId = minted.value.modelProfile;
    expect([binding.provider, profile]).toEqual([LOCAL.provider, "general-review"]);
    // @ts-expect-error a minted binding is never a retired cloud target
    const retired: MintedHarnessBinding = { pi: SOL, claude: minted.value.harnessBinding.claude };
    // @ts-expect-error a minted authority never names a retired profile
    const retiredProfile: MintedAgentRequestAuthority["modelProfile"] = "qualified-local-review";
    expect([retired.pi.provider, retiredProfile]).toEqual(["openai-codex", "qualified-local-review"]);
  });
});

describe("an issued refutation panel keeps its minted roster", () => {
  it("types the issued panel's verifier slots as minted, and a parsed panel's as history", () => {
    const runId = parseOrchestrationRunId("run:issued-panel");
    const findingId = parseWaveFindingId("T1:finding-1");
    if (!runId.ok || findingId === null) throw new Error("fixture identities must parse");
    const binding = deriveRefutationVerifierBinding(runId.value, "reproduction", [findingId]);
    if (!binding.ok) throw new Error(binding.errors.join("; "));
    const mint = <Attempt extends 1 | 2>(attempt: Attempt) => {
      const minted = mintAgentRequestAuthority({
        runId: runId.value,
        requestId: binding.value.requestIds[attempt - 1]!,
        slotId: binding.value.slotId,
        program: "refutation-panel",
        role: "review-verifier-agent",
        attempt,
        contextDigest: String(attempt).repeat(64),
        outputSlot: `transcripts/${binding.value.slotId}/attempt-${attempt}.raw`,
      });
      if (!minted.ok) throw new Error(JSON.stringify(minted.error));
      return minted.value;
    };
    const slot = issueAgentRosterSlot(mint(1), mint(2));
    if (!slot.ok) throw new Error("slot must issue");
    const input = {
      runId: runId.value,
      findings: [{ id: findingId, taskId: "T1", agent: "code-reviewer", severity: "critical", file: null, line: null, claim: "c" }],
      lenses: ["reproduction"],
      verifierSlots: [slot.value],
    };
    const issued = issueRefutationPanelAuthority(input);
    if (!issued.ok) throw new Error(issued.error.message);
    const minted: MintedAgentRosterSlot = issued.value.verifierRoster.orderedSlots[0];
    expect(minted.attempts[0].harnessBinding.pi).toEqual(LOCAL);

    const parsed = parseRefutationPanelAuthority(input);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value).toEqual(issued.value);
    // @ts-expect-error a parsed (recorded) panel's roster is history, not issuance
    const recorded: MintedAgentRosterSlot = parsed.value.verifierRoster.orderedSlots[0];
    expect(recorded).toEqual(minted);
  });
});
