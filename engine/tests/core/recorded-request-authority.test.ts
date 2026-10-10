import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AGENT_POLICIES,
  LLM_PROFILE_IDS,
  RECORDED_LLM_PROFILE_IDS,
  RETIRED_LLM_PROFILE_IDS,
  currentProfileBindings,
  piCatalogAsOf,
  piModelPattern,
  profileBindingsUnder,
  recordedProfileBindings,
  type LlmProfileId,
  type LocalPiBinding,
  type LoomAgentName,
  type PiBinding,
  type RecordedLlmProfileId,
} from "../../src/core/model-profiles";
import {
  canonicalStructuralEquals,
  issueExactRoster,
  mintAgentRequestAuthority,
  mintAgentRosterSlot,
  mintAgentRosterSlotAsOf,
  parseAgentRequestAuthority,
  parseAgentRosterSlot,
  parseOrchestrationRunId,
  parseStoredAgentRequestAuthority,
  type AgentRosterSlot,
  type MintedAgentRequestAuthority,
  type MintedHarnessBinding,
} from "../../src/core/orchestration-contract";
import { samePiBinding } from "../../src/core/orchestration-contract/roster";
import { deriveRefutationVerifierBinding, issueRefutationPanelAuthority, parseRefutationPanelAuthority } from "../../src/core/panel-authority";
import { parseWaveFindingId } from "../../src/core/review-panel";
import { prepareFreshStandaloneReview } from "../../src/core/standalone-review-preparation";
import { agentRequestIdentity } from "../fixtures/agent-request-identity";
import { LOCAL_PI_BINDING, RECORDED_PI_VOCABULARY, RETIRED_CLOUD_PI_BINDING, RETIRED_REFUTATION_PI_BINDING } from "../fixtures/local-pi-binding";

/**
 * A request authority is issued against today's catalog and read back as
 * history. Retargeting every Pi profile to the local route (2026-10-08) and
 * retiring `qualified-local-review` must not strand a run already on disk,
 * while a binding its profile never issued stays a tamper refusal.
 */

const PI_FIELDS = ["harness", "provider", "model", "thinking"] as const;

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
    const stored = parseStoredAgentRequestAuthority(request("general-review", RETIRED_CLOUD_PI_BINDING));
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.value.harnessBinding.pi).toEqual(RETIRED_CLOUD_PI_BINDING);
  });

  it("reads back a reviewer issued under the retired qualified-local-review profile", () => {
    const stored = parseStoredAgentRequestAuthority(request("qualified-local-review", LOCAL_PI_BINDING));
    expect(stored.ok).toBe(true);
    if (stored.ok) expect(stored.value.modelProfile).toBe("qualified-local-review");
  });

  it("reports the set-level refusal even for a profile with a single recorded binding", () => {
    const violations = piViolations(parseStoredAgentRequestAuthority(request("qualified-local-review", RETIRED_CLOUD_PI_BINDING)));
    expect(violations.map(({ field }) => field)).toEqual(["harnessBinding.pi"]);
  });

  it("refuses a stored Claude model its profile never bound", () => {
    const tampered = { ...request("general-review", RETIRED_CLOUD_PI_BINDING), harnessBinding: { pi: RETIRED_CLOUD_PI_BINDING, claude: { harness: "claude-code", model: "opus" } } };
    expect(kinds(parseStoredAgentRequestAuthority(tampered))).toContain("model-binding-mismatch:harnessBinding.claude.model");
  });
});

describe("issued request authority is today's catalog", () => {
  it("issues every role under its catalog profile on the local route", () => {
    for (const policy of AGENT_POLICIES) {
      expect(parseAgentRequestAuthority(request(policy.profile, LOCAL_PI_BINDING, policy.agent)).ok, policy.agent).toBe(true);
    }
  });

  it("refuses the retired qualified-local-review profile at issuance", () => {
    expect(kinds(parseAgentRequestAuthority(request("qualified-local-review", LOCAL_PI_BINDING))))
      .toContain("invalid-agent-request-field:modelProfile");
  });

  it("raises model-policy-mismatch exactly where the profile is not the role's catalog profile", () => {
    for (const policy of AGENT_POLICIES) for (const profile of LLM_PROFILE_IDS) {
      const mismatch = kinds(parseAgentRequestAuthority(request(profile, LOCAL_PI_BINDING, policy.agent)))
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
      expect(issued.harnessBinding.pi).toEqual(LOCAL_PI_BINDING);
    }
  });
});

describe("a minted authority is the only thing an issuing seam accepts", () => {
  const identity = <Attempt extends 1 | 2>(attempt: Attempt, role: LoomAgentName = "code-reviewer") =>
    agentRequestIdentity(role, attempt, { runId: "run:recorded-authority", slotId: "slot:recorded-authority" });
  const mint = (attempt: 1 | 2, role?: LoomAgentName): MintedAgentRequestAuthority => {
    const minted = mintAgentRequestAuthority(identity(attempt, role));
    if (!minted.ok) throw new Error(JSON.stringify(minted.error));
    return minted.value;
  };

  it("mints the same slot a stored read of the same minted requests parses", () => {
    const issued = mintAgentRosterSlot(identity(1), identity(2));
    const stored = parseAgentRosterSlot(mint(1), mint(2));
    expect(issued).toEqual(stored);
    expect(issued.ok).toBe(true);
  });

  it("refuses, at compile time and at run time, identities out of attempt order", () => {
    // @ts-expect-error the first identity of a slot authorizes attempt 1
    const swapped = mintAgentRosterSlot(identity(2), identity(1));
    expect(swapped.ok).toBe(false);
    if (!swapped.ok) expect(swapped.error.violations.map(({ kind }) => kind)).toContain("attempt-pair-mismatch");
  });

  it("never issues a recorded roster slot: the issuing seam takes identities and mints today's binding, whatever the slot recorded (property)", () => {
    fc.assert(fc.property(fc.constantFrom(...AGENT_POLICIES), fc.constantFrom(...RECORDED_PI_VOCABULARY), (policy, pi) => {
      fc.pre(issuedBy(policy.profile, pi));
      const recordedOn = (attempt: 1 | 2) => {
        const minted = mint(attempt, policy.agent);
        return { ...minted, harnessBinding: { ...minted.harnessBinding, pi } };
      };
      const recorded = parseAgentRosterSlot(recordedOn(1), recordedOn(2));
      if (!recorded.ok) throw new Error(JSON.stringify(recorded.error));
      const storedSlots: readonly AgentRosterSlot[] = [recorded.value];
      // Only the type is under test here: a recorded slot never passed the catalog check, and the seam takes identities.
      // @ts-expect-error a recorded roster slot is not an issuer's identities
      void (() => issueExactRoster(storedSlots));
      const issued = issueExactRoster([[identity(1, policy.agent), identity(2, policy.agent)]]);
      if (!issued.ok) throw new Error(JSON.stringify(issued.error));
      const current = currentProfileBindings(policy.profile).pi;
      expect(issued.value.orderedSlots[0].attempts.map(({ harnessBinding }) => harnessBinding.pi)).toEqual([current, current]);
      // The recorded slot is exactly what issuance mints when it recorded today's binding, and only then.
      expect(canonicalStructuralEquals(issued.value.orderedSlots, storedSlots), `${policy.agent} ${piModelPattern(pi)}`)
        .toBe(samePiBinding(pi, current));
    }));
  });
});

describe("the profile authority admits a Pi binding by its origin's strategy", () => {
  // The strategy is private to the roster volume, so it is observed through
  // the two parsers that select it: its contribution is the request's
  // `harnessBinding.pi` violations.
  const roleIssuing = (profile: LlmProfileId): string =>
    AGENT_POLICIES.find((policy) => policy.profile === profile)?.agent ?? "code-reviewer";
  const stored = (profile: RecordedLlmProfileId, pi: unknown) =>
    parseStoredAgentRequestAuthority(request(profile, pi as PiBinding));
  const issued = (profile: LlmProfileId, pi: unknown) =>
    parseAgentRequestAuthority(request(profile, pi as PiBinding, roleIssuing(profile)));

  it("admits a recorded binding exactly when the recorded profile has issued it, returning that binding, and refuses it once against the whole recorded set", () => {
    fc.assert(fc.property(fc.constantFrom(...RECORDED_LLM_PROFILE_IDS), fc.constantFrom(...RECORDED_PI_VOCABULARY), (profile, pi) => {
      const admitted = stored(profile, { ...pi });
      expect(admitted.ok, `${profile} ${piModelPattern(pi)}`).toBe(issuedBy(profile, pi));
      if (admitted.ok) {
        expect(admitted.value.harnessBinding.pi).toEqual(pi);
        return;
      }
      const [refusal, ...others] = admitted.error.violations;
      expect(others).toEqual([]);
      expect([refusal.kind, refusal.field]).toEqual(["model-binding-mismatch", "harnessBinding.pi"]);
      for (const recorded of recordedProfileBindings(profile).pi) expect(refusal.message).toContain(piModelPattern(recorded));
    }));
  });

  it("admits at issuance, for any role, exactly the catalog profile's current binding on the role's own profile, naming each differing field", () => {
    fc.assert(fc.property(
      fc.constantFrom(...AGENT_POLICIES), fc.constantFrom(...LLM_PROFILE_IDS), fc.constantFrom(...RECORDED_PI_VOCABULARY),
      (policy, profile, pi) => {
        const current = currentProfileBindings(profile).pi;
        const admitted = parseAgentRequestAuthority(request(profile, { ...pi }, policy.agent));
        // The Pi admission depends on the profile alone; the role decides only whether the profile is its own.
        expect(piViolations(admitted).map(({ field }) => field))
          .toEqual(PI_FIELDS.filter((key) => pi[key] !== current[key]).map((key) => `harnessBinding.pi.${key}`));
        expect(admitted.ok, `${policy.agent} ${profile} ${piModelPattern(pi)}`)
          .toBe(policy.profile === profile && samePiBinding(pi, current));
        if (admitted.ok) expect(admitted.value.harnessBinding.pi).toEqual(current);
      },
    ));
  });

  it("admits at issuance a subset of what the same profile admits as history", () => {
    fc.assert(fc.property(fc.constantFrom(...LLM_PROFILE_IDS), fc.constantFrom(...RECORDED_PI_VOCABULARY), (profile, pi) => {
      fc.pre(piViolations(issued(profile, pi)).length === 0);
      expect(stored(profile, pi).ok).toBe(true);
    }));
  });

  it("refuses every non-binding shape in both origins", () => {
    const shapes = fc.oneof(
      fc.constant(undefined), fc.constant(null), fc.string(), fc.integer(), fc.array(fc.string()),
      fc.dictionary(fc.string(), fc.string()),
      fc.constantFrom(...RECORDED_PI_VOCABULARY).map((pi) => ({ ...pi, extra: true })),
    );
    const origins = fc.constantFrom(issued, stored);
    fc.assert(fc.property(fc.constantFrom(...LLM_PROFILE_IDS), origins, shapes, (profile, parse, raw) => {
      expect(piViolations(parse(profile, raw)).length).toBeGreaterThan(0);
    }));
  });

  it("names no retired profile at issuance and every recorded one in history", () => {
    for (const profile of RETIRED_LLM_PROFILE_IDS) {
      const pi = recordedProfileBindings(profile).pi[0];
      expect(kinds(parseAgentRequestAuthority(request(profile, pi)))).toContain("invalid-agent-request-field:modelProfile");
      expect(stored(profile, pi).ok).toBe(true);
    }
    expect(kinds(parseStoredAgentRequestAuthority({ ...request("general-review", LOCAL_PI_BINDING), modelProfile: 7 })))
      .toContain("invalid-agent-request-field:modelProfile");
  });
});

describe("the catalog mints a request from its identity alone", () => {
  const identity = <Attempt extends 1 | 2>(role: LoomAgentName, attempt: Attempt) =>
    agentRequestIdentity(role, attempt, { runId: "run:minted-authority", slotId: `slot:minted-${role}` });

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

  it("mints under a replayed catalog exactly the binding it lowers each role's profile to, which history admits (property)", () => {
    fc.assert(fc.property(fc.constantFrom(...AGENT_POLICIES), fc.constantFrom(...RECORDED_PI_VOCABULARY), (policy, replayedTo) => {
      const catalog = piCatalogAsOf({ [policy.profile]: replayedTo });
      fc.pre(catalog.ok);
      if (!catalog.ok) return;
      const lowered = profileBindingsUnder(catalog.value.lowering, policy.profile);
      const slot = mintAgentRosterSlotAsOf(catalog.value.lowering, identity(policy.agent, 1),
        { ...identity(policy.agent, 2), requestId: `request:replayed-${policy.agent}-2` });
      expect(slot.ok, policy.agent).toBe(true);
      if (!slot.ok) return;
      for (const authority of slot.value.attempts) {
        expect(authority.harnessBinding).toEqual(lowered);
        expect(samePiBinding(authority.harnessBinding.pi, replayedTo)).toBe(true);
        // Whatever a replay mints is history its profile has issued.
        expect(parseStoredAgentRequestAuthority(authority)).toEqual({ ok: true, value: authority });
      }
    }));
  });

  it("mints a slot under a replayed catalog as history: today's slot, on the binding the replay lowers to", () => {
    const catalog = piCatalogAsOf({ "general-review": RETIRED_CLOUD_PI_BINDING });
    if (!catalog.ok) throw new Error(catalog.error.message);
    const first = identity("code-reviewer", 1);
    const retry = { ...identity("code-reviewer", 2), requestId: "request:minted-retry" };
    const replayed = mintAgentRosterSlotAsOf(catalog.value.lowering, first, retry);
    const today = mintAgentRosterSlot(first, retry);
    if (!replayed.ok || !today.ok) throw new Error("mint failed");
    const rebound = today.value.attempts.map((authority) => ({ ...authority, harnessBinding: { ...authority.harnessBinding, pi: RETIRED_CLOUD_PI_BINDING } }));
    expect(replayed.value.attempts).toEqual(rebound);
    // History parses back unchanged, as any recorded slot does.
    expect(parseAgentRosterSlot(replayed.value.attempts[0], replayed.value.attempts[1])).toEqual(replayed);
    // A role whose profile the replay leaves alone mints exactly today's slot.
    const untouched = <Attempt extends 1 | 2>(attempt: Attempt) =>
      ({ ...identity("review-verifier-agent", attempt), requestId: `request:verifier-${attempt}` });
    expect(mintAgentRosterSlotAsOf(catalog.value.lowering, untouched(1), untouched(2)))
      .toEqual(mintAgentRosterSlot(untouched(1), untouched(2)));
  });

  it("keeps the attempt it was asked to mint, so a slot mints from the same pair", () => {
    const retryIdentity = { ...identity("code-reviewer", 2), requestId: "request:minted-retry" };
    const first = mintAgentRequestAuthority(identity("code-reviewer", 1));
    const retry = mintAgentRequestAuthority(retryIdentity);
    if (!first.ok || !retry.ok) throw new Error("mint failed");
    expect([first.value.attempt, retry.value.attempt]).toEqual([1, 2]);
    expect(mintAgentRosterSlot(identity("code-reviewer", 1), retryIdentity)).toEqual(parseAgentRosterSlot(first.value, retry.value));
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
    expect([binding.provider, profile]).toEqual([LOCAL_PI_BINDING.provider, "general-review"]);
    // @ts-expect-error a minted binding is never a retired cloud target
    const retired: MintedHarnessBinding = { pi: RETIRED_CLOUD_PI_BINDING, claude: minted.value.harnessBinding.claude };
    // @ts-expect-error a minted authority never names a retired profile
    const retiredProfile: MintedAgentRequestAuthority["modelProfile"] = "qualified-local-review";
    expect([retired.pi.provider, retiredProfile]).toEqual([RETIRED_CLOUD_PI_BINDING.provider, "qualified-local-review"]);
  });
});

describe("an issued refutation panel is the panel its record parses as", () => {
  it("issues from its slots' identities exactly the panel its minted slots parse as, and never issues a recorded slot", () => {
    const runId = parseOrchestrationRunId("run:issued-panel");
    const findingId = parseWaveFindingId("T1:finding-1");
    if (!runId.ok || findingId === null) throw new Error("fixture identities must parse");
    const binding = deriveRefutationVerifierBinding(runId.value, "reproduction", [findingId]);
    if (!binding.ok) throw new Error(binding.errors.join("; "));
    const identity = <Attempt extends 1 | 2>(attempt: Attempt) => agentRequestIdentity("review-verifier-agent", attempt, {
      runId: runId.value,
      slotId: binding.value.slotId,
      requestId: binding.value.requestIds[attempt - 1]!,
      program: "refutation-panel",
    });
    const slot = mintAgentRosterSlot(identity(1), identity(2));
    if (!slot.ok) throw new Error("slot must issue");
    const panel = {
      runId: runId.value,
      findings: [{ id: findingId, taskId: "T1", agent: "code-reviewer", severity: "critical", file: null, line: null, claim: "c" }],
      lenses: ["reproduction"],
    };
    const issued = issueRefutationPanelAuthority({ ...panel, verifierSlots: [[identity(1), identity(2)]] });
    if (!issued.ok) throw new Error(JSON.stringify(issued.error));
    expect(issued.value.verifierRoster.orderedSlots[0].attempts[0].harnessBinding.pi).toEqual(LOCAL_PI_BINDING);
    expect(parseRefutationPanelAuthority({ ...panel, verifierSlots: [slot.value] })).toEqual(issued);

    // The same panel recorded on its profile's retired binding is history: it parses, and is never issued.
    const onRetired = (authority: MintedAgentRequestAuthority) =>
      ({ ...authority, harnessBinding: { ...authority.harnessBinding, pi: RETIRED_REFUTATION_PI_BINDING } });
    const retired = parseAgentRosterSlot(onRetired(slot.value.attempts[0]), onRetired(slot.value.attempts[1]));
    if (!retired.ok) throw new Error(JSON.stringify(retired.error));
    expect(parseRefutationPanelAuthority({ ...panel, verifierSlots: [retired.value] }).ok).toBe(true);
    // Only the type is under test here: the issuing seam takes identities, so a re-read slot cannot be passed to it.
    // @ts-expect-error a re-read roster slot is history, not an issuer's identities
    void (() => issueRefutationPanelAuthority({ ...panel, verifierSlots: [retired.value] }));
  });

  it("refuses a verifier slot the catalog will not mint before checking the panel itself", () => {
    const runId = parseOrchestrationRunId("run:issued-panel");
    if (!runId.ok) throw new Error(runId.error.message);
    const identity = <Attempt extends 1 | 2>(attempt: Attempt) => agentRequestIdentity("review-verifier-agent", attempt, {
      runId: runId.value,
      slotId: "slot:unmintable",
      program: "refutation-panel",
      contextDigest: "not-a-digest",
    });
    const minted = mintAgentRosterSlot(identity(1), identity(2));
    if (minted.ok) throw new Error("the fixture must not mint");
    // An empty lens list is a panel refusal too; the unmintable slot is named first.
    expect(issueRefutationPanelAuthority({ runId: runId.value, findings: [], lenses: [], verifierSlots: [[identity(1), identity(2)]] }))
      .toEqual({ ok: false, error: { kind: "unmintable-roster-slot", slotId: "slot:unmintable", error: minted.error } });
  });
});
