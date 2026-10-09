import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AGENT_POLICIES,
  LLM_PROFILE_IDS,
  RETIRED_LLM_PROFILE_IDS,
  currentProfileBindings,
  piCatalogAsOf,
  piModelPattern,
  profileBindingsUnder,
  recordedProfileBindings,
  type LlmProfileId,
  type LocalPiBinding,
  type PiBinding,
  type RecordedLlmProfileId,
} from "../../src/core/model-profiles";
import {
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
  type MintedAgentRosterSlot,
  type MintedHarnessBinding,
} from "../../src/core/orchestration-contract";
import { samePiBinding } from "../../src/core/orchestration-contract/roster";
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
  const identity = <Attempt extends 1 | 2>(attempt: Attempt) => ({
    runId: "run:recorded-authority", requestId: `request:recorded-authority-${attempt}`, slotId: "slot:recorded-authority",
    program: "standalone-review" as const, role: "code-reviewer" as const, attempt, contextDigest: String(attempt).repeat(64),
    outputSlot: `transcripts/slot:recorded-authority/attempt-${attempt}.raw`,
  });
  const mint = (attempt: 1 | 2): MintedAgentRequestAuthority => {
    const minted = mintAgentRequestAuthority(identity(attempt));
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

  it("rejects, at compile time, a recorded roster slot handed to an issuing seam", () => {
    const slot = parseAgentRosterSlot(mint(1), mint(2));
    if (!slot.ok) throw new Error("slot must parse");
    const storedSlots: readonly AgentRosterSlot[] = [slot.value];
    // @ts-expect-error a recorded roster slot never passed the catalog check
    const issueRecorded = () => issueExactRoster(storedSlots);
    // The minted brand is phantom: it closes the forgetting path at compile time, not at run time.
    expect(issueRecorded().ok).toBe(true);
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
  // The strategy is private to the roster volume, so it is observed through
  // the two parsers that select it: its contribution is the request's
  // `harnessBinding.pi` violations.
  const roleIssuing = (profile: LlmProfileId): string =>
    AGENT_POLICIES.find((policy) => policy.profile === profile)?.agent ?? "code-reviewer";
  const stored = (profile: RecordedLlmProfileId, pi: unknown) =>
    parseStoredAgentRequestAuthority(request(profile, pi as PiBinding));
  const issued = (profile: LlmProfileId, pi: unknown) =>
    parseAgentRequestAuthority(request(profile, pi as PiBinding, roleIssuing(profile)));

  it("admits a recorded binding exactly when the recorded profile has issued it, returning that binding", () => {
    fc.assert(fc.property(fc.constantFrom(...RECORDED_IDS), fc.constantFrom(...VOCABULARY), (profile, pi) => {
      const admitted = stored(profile, { ...pi });
      expect(admitted.ok, `${profile} ${piModelPattern(pi)}`).toBe(issuedBy(profile, pi));
      if (admitted.ok) expect(admitted.value.harnessBinding.pi).toEqual(pi);
      else expect(admitted.error.violations.map(({ field }) => field)).toEqual(["harnessBinding.pi"]);
    }));
  });

  it("admits at issuance only the catalog profile's current binding, naming each differing field", () => {
    fc.assert(fc.property(fc.constantFrom(...LLM_PROFILE_IDS), fc.constantFrom(...VOCABULARY), (profile, pi) => {
      const current = currentProfileBindings(profile).pi;
      const admitted = issued(profile, { ...pi });
      expect(piViolations(admitted).map(({ field }) => field))
        .toEqual(PI_FIELDS.filter((key) => pi[key] !== current[key]).map((key) => `harnessBinding.pi.${key}`));
      if (admitted.ok) expect(admitted.value.harnessBinding.pi).toEqual(current);
    }));
  });

  it("admits at issuance a subset of what the same profile admits as history", () => {
    fc.assert(fc.property(fc.constantFrom(...LLM_PROFILE_IDS), fc.constantFrom(...VOCABULARY), (profile, pi) => {
      fc.pre(piViolations(issued(profile, pi)).length === 0);
      expect(stored(profile, pi).ok).toBe(true);
    }));
  });

  it("refuses every non-binding shape in both origins", () => {
    const shapes = fc.oneof(
      fc.constant(undefined), fc.constant(null), fc.string(), fc.integer(), fc.array(fc.string()),
      fc.dictionary(fc.string(), fc.string()),
      fc.constantFrom(...VOCABULARY).map((pi) => ({ ...pi, extra: true })),
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
    expect(kinds(parseStoredAgentRequestAuthority({ ...request("general-review", LOCAL), modelProfile: 7 })))
      .toContain("invalid-agent-request-field:modelProfile");
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

  it("mints under a replayed catalog exactly the binding it lowers each role's profile to, which history admits (property)", () => {
    fc.assert(fc.property(fc.constantFrom(...AGENT_POLICIES), fc.constantFrom(...VOCABULARY), (policy, replayedTo) => {
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
    const catalog = piCatalogAsOf({ "general-review": SOL });
    if (!catalog.ok) throw new Error(catalog.error.message);
    const first = identity("code-reviewer", 1);
    const retry = { ...identity("code-reviewer", 2), requestId: "request:minted-retry" };
    const replayed = mintAgentRosterSlotAsOf(catalog.value.lowering, first, retry);
    const today = mintAgentRosterSlot(first, retry);
    if (!replayed.ok || !today.ok) throw new Error("mint failed");
    const rebound = today.value.attempts.map((authority) => ({ ...authority, harnessBinding: { ...authority.harnessBinding, pi: SOL } }));
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
    expect([binding.provider, profile]).toEqual([LOCAL.provider, "general-review"]);
    // @ts-expect-error a minted binding is never a retired cloud target
    const retired: MintedHarnessBinding = { pi: SOL, claude: minted.value.harnessBinding.claude };
    // @ts-expect-error a minted authority never names a retired profile
    const retiredProfile: MintedAgentRequestAuthority["modelProfile"] = "qualified-local-review";
    expect([retired.pi.provider, retiredProfile]).toEqual([SOL.provider, "qualified-local-review"]);
  });
});

describe("an issued refutation panel keeps its minted roster", () => {
  it("types the issued panel's verifier slots as minted, and a parsed panel's as history", () => {
    const runId = parseOrchestrationRunId("run:issued-panel");
    const findingId = parseWaveFindingId("T1:finding-1");
    if (!runId.ok || findingId === null) throw new Error("fixture identities must parse");
    const binding = deriveRefutationVerifierBinding(runId.value, "reproduction", [findingId]);
    if (!binding.ok) throw new Error(binding.errors.join("; "));
    const identity = <Attempt extends 1 | 2>(attempt: Attempt) => ({
      runId: runId.value,
      requestId: binding.value.requestIds[attempt - 1]!,
      slotId: binding.value.slotId,
      program: "refutation-panel" as const,
      role: "review-verifier-agent" as const,
      attempt,
      contextDigest: String(attempt).repeat(64),
      outputSlot: `transcripts/${binding.value.slotId}/attempt-${attempt}.raw`,
    });
    const slot = mintAgentRosterSlot(identity(1), identity(2));
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
