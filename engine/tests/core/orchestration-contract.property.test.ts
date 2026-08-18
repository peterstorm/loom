import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import * as orchestrationContract from "../../src/core/orchestration-contract";
import {
  acceptedAgentResult,
  awaitUserAction,
  blockedAction,
  createAtomicInitialPublicationClaimPort,
  createInitialBatchPublicationReconciler,
  createInitialPublicationEffectPort,
  createPublicationAuthorityResolver,
  doneAction,
  digestRawTranscriptBytes,
  infrastructureRetryDiagnostic,
  issueInitialSpawnRequests,
  MAX_DENSE_DATA_ARRAY_LENGTH,
  MAX_DIAGNOSTIC_MESSAGE_LENGTH,
  MAX_SEMANTIC_PAYLOAD_ARRAY_LENGTH,
  parseAgentRequestAuthority,

  parseStoredAgentRequestAuthority,
  parseAgentRosterSlot,
  parseArtifactByteLength,
  parseArtifactDigest,
  parseArtifactRef,
  parseBatchPublishedReceipt,
  parseBlockedDiagnostic,
  parseCompleteRoster as parseCompleteRosterWithAuthority,
  parseIssuedSpawnRequest as parseIssuedSpawnRequestWithAuthority,
  parseContextDigest,
  parseEffectId,
  parseExactRoster,
  parseFixedArtifactSlot,
  parseOrchestrationRunId,
  parseRequestId,
  parseSlotId,
  prepareInitialBatchPublicationIntent,
  reconcileEffectReceipt,
  rehydrateIssuedSpawnRequests,
  semanticRetryDiagnostic,
  spawnBatchAction as spawnBatchActionWithAuthority,
  terminalBlockedDiagnostic,
  type AcceptedAgentResult,
  type AgentRequestAuthority,
  type AgentRosterSlot,
  type ArtifactDigest,
  type ArtifactRef,
  type AtomicInitialPublicationClaim,
  type BatchPublicationIdentity,
  type BatchPublishedReceipt,
  type ContextDigest,
  type EffectId,
  type EffectIntent,
  type EffectReceipt,
  type ExactRoster,
  type InitialPublicationEffectExecutor,
  type InitialPublicationEffectPort,
  type InitialPublicationIssuanceAuthority,
  type OrchestrationRunId,
  type PublicationAuthorityResolver,
  type RegisteredBatchPublicationAuthority,
  type TrustedPublicationRegistrationLoader,
  type RequestId,
  type SlotId,
  type SpawnRequest,
} from "../../src/core/orchestration-contract";

type Result<T, E = unknown> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: E }>;

function valueOf<T>(result: Result<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("expected a successful domain parse");
  return result.value;
}

const registeredPublicationBytes = new Map<string, readonly number[]>();
const registrationKey = (identity: Readonly<{
  runId: string;
  effectId: string;
}>): string => `${identity.runId}\u0000${identity.effectId}`;
const encodeJson = (value: unknown): readonly number[] => [...new TextEncoder().encode(JSON.stringify(value))];

const trustedRegistrationLoader: TrustedPublicationRegistrationLoader = (lookup) => {
  const bytes = registeredPublicationBytes.get(registrationKey(lookup));
  return bytes === undefined
    ? { ok: false, error: { kind: "publication-authority-unavailable", message: "publication is not registered" } }
    : { ok: true, value: bytes };
};

const publicationResolver = createPublicationAuthorityResolver(trustedRegistrationLoader);

function publicationIdentity(receipt: BatchPublishedReceipt): BatchPublicationIdentity {
  return {
    schemaVersion: 1,
    kind: "batch-publication-identity",
    runId: receipt.runId,
    effectId: receipt.effectId,
    publicationDigest: receipt.publicationDigest,
  };
}

function registerPublication(rawReceipt: unknown): RegisteredBatchPublicationAuthority {
  const receipt = valueOf(parseBatchPublishedReceipt(rawReceipt));
  registeredPublicationBytes.set(registrationKey(receipt), encodeJson(receipt));
  return valueOf(publicationResolver(publicationIdentity(receipt)));
}

const initialPublicationClaimKey = (identity: Readonly<{
  runId: string;
  effectId: string;
}>): string => `${identity.runId}\u0000${identity.effectId}`;

type DurableInitialPublicationClaims = Map<string, BatchPublicationIdentity>;

const sameClaimedPublicationIdentity = (
  left: BatchPublicationIdentity,
  right: BatchPublicationIdentity,
): boolean => left.schemaVersion === right.schemaVersion && left.kind === right.kind &&
  left.runId === right.runId && left.effectId === right.effectId &&
  left.publicationDigest === right.publicationDigest;

function atomicInitialPublicationClaim(
  claims: DurableInitialPublicationClaims,
  onCall: (identity: BatchPublicationIdentity) => void = () => undefined,
): AtomicInitialPublicationClaim {
  return (request) => {
    onCall(request.identity);
    const storageKey = initialPublicationClaimKey(request.key);
    const claimedIdentity = claims.get(storageKey);
    if (claimedIdentity === undefined) {
      claims.set(storageKey, request.identity);
      return {
        ok: true,
        value: {
          schemaVersion: 1,
          kind: "initial-publication-claimed",
          key: request.key,
          identity: request.identity,
        },
      };
    }
    if (sameClaimedPublicationIdentity(claimedIdentity, request.identity)) {
      return {
        ok: true,
        value: {
          schemaVersion: 1,
          kind: "initial-publication-matching-replay",
          key: request.key,
          identity: claimedIdentity,
        },
      };
    }
    return {
      ok: true,
      value: {
        schemaVersion: 1,
        kind: "initial-publication-conflict",
        key: request.key,
        requestedIdentity: request.identity,
        claimedIdentity,
      },
    };
  };
}

function publicationEffect(rawReceipt: unknown): InitialPublicationEffectExecutor {
  return () => ({ ok: true, value: encodeJson(rawReceipt) });
}

function prepareIntentFromReceipt(
  rawReceipt: unknown,
  rawRequests?: unknown,
) {
  const receipt = parseBatchPublishedReceipt(rawReceipt);
  if (!receipt.ok) return receipt;
  return prepareInitialBatchPublicationIntent(
    receipt.value.runId,
    receipt.value.effectId,
    rawRequests ?? receipt.value.issuedRequests,
  );
}

function reconcileTrustedInitialPublication(
  rawReceipt: unknown,
  rawRequests?: unknown,
  claims: DurableInitialPublicationClaims = new Map(),
) {
  const intent = prepareIntentFromReceipt(rawReceipt, rawRequests);
  if (!intent.ok) return intent;
  const reconciler = createInitialBatchPublicationReconciler(
    createInitialPublicationEffectPort(publicationEffect(rawReceipt)),
    createAtomicInitialPublicationClaimPort(atomicInitialPublicationClaim(claims)),
  );
  return reconciler(intent.value);
}

function spawnBatchAction(rawReceipt: unknown, rawRequests: unknown) {
  const issuanceAuthority = reconcileTrustedInitialPublication(rawReceipt, rawRequests);
  if (!issuanceAuthority.ok) return issuanceAuthority;
  const action = spawnBatchActionWithAuthority(issuanceAuthority.value, rawRequests);
  if (action.ok) {
    registeredPublicationBytes.set(registrationKey(action.value.receipt), encodeJson(action.value.receipt));
  }
  return action;
}

function parseIssuedSpawnRequest(raw: unknown) {
  return parseIssuedSpawnRequestWithAuthority(publicationResolver, raw);
}

function parseCompleteRoster<T>(
  exact: ExactRoster,
  rawResults: unknown,
  parser: (raw: unknown) => Result<T, Readonly<{ message: string }>>,
) {
  return parseCompleteRosterWithAuthority(publicationResolver, exact, rawResults, parser);
}

const digest = (n: number): string => n.toString(16).padStart(64, "0").slice(-64);
const runId = (suffix = "1"): OrchestrationRunId => valueOf(parseOrchestrationRunId(`run.contract-${suffix}`));
const requestId = (suffix: string): RequestId => valueOf(parseRequestId(`request:${suffix}`));
const slotId = (suffix: string): SlotId => valueOf(parseSlotId(`slot:${suffix}`));
const contextDigest = (n: number): ContextDigest => valueOf(parseContextDigest(digest(n)));
const artifactDigest = (n: number): ArtifactDigest => valueOf(parseArtifactDigest(digest(n)));
const effectId = (suffix: string): EffectId => valueOf(parseEffectId(`effect:${suffix}`));

const implementationBindings = {
  pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
  claude: { harness: "claude-code", model: "opus" },
} as const;

const focusedBindings = {
  pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.5", thinking: "high" },
  claude: { harness: "claude-code", model: "sonnet" },
} as const;

function rawAuthority(
  slot: number,
  attempt: 1 | 2,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    runId: runId(),
    requestId: requestId(`${slot}:${attempt}`),
    slotId: slotId(String(slot)),
    program: "wave-gate",
    role: "code-implementer-agent",
    attempt,
    modelProfile: "implementation",
    harnessBinding: implementationBindings,
    requiredSkill: "code-implementer",
    contextDigest: contextDigest(slot * 10 + attempt),
    outputSlot: `transcripts/agent-${slot}/attempt-${attempt}.raw`,
    ...overrides,
  };
}

function authority(slot: number, attempt: 1 | 2): AgentRequestAuthority {
  return valueOf(parseAgentRequestAuthority(rawAuthority(slot, attempt)));
}

function rosterSlot(slot: number, firstOverrides = {}, retryOverrides = {}): AgentRosterSlot {
  return valueOf(parseAgentRosterSlot(
    rawAuthority(slot, 1, firstOverrides),
    rawAuthority(slot, 2, retryOverrides),
  ));
}

function roster(size: number): ExactRoster {
  return valueOf(parseExactRoster(Array.from({ length: size }, (_, index) => rosterSlot(index + 1))));
}

function contextFor(request: AgentRequestAuthority): Readonly<Record<string, unknown>> {
  return {
    digest: request.contextDigest,
    slot: `contexts/${request.contextDigest}.json`,
  };
}

function rawSpawnRequest(request: AgentRequestAuthority): Readonly<Record<string, unknown>> {
  return { authority: request, context: contextFor(request) };
}

function canonicalPublicationDigest(
  requests: readonly AgentRequestAuthority[],
  effect: EffectId,
  run: OrchestrationRunId,
): ArtifactDigest {
  const canonicalContent = {
    schemaVersion: 1,
    kind: "batch-published",
    effectId: effect,
    runId: run,
    requestIds: requests.map(({ requestId: id }) => id),
    contextDigests: requests.map(({ contextDigest: id }) => id),
    issuedRequests: requests.map((request) => ({
      authority: request,
      context: {
        digest: request.contextDigest,
        slot: { kind: "fixed-artifact-slot", path: `contexts/${request.contextDigest}.json` },
      },
    })),
  };
  return createHash("sha256")
    .update(new TextEncoder().encode(JSON.stringify(canonicalContent)))
    .digest("hex") as ArtifactDigest;
}

function rawBatchReceiptForIdentity(
  requests: readonly AgentRequestAuthority[],
  effect: EffectId,
  run: OrchestrationRunId,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    kind: "batch-published",
    effectId: effect,
    runId: run,
    requestIds: requests.map(({ requestId: id }) => id),
    contextDigests: requests.map(({ contextDigest: id }) => id),
    issuedRequests: requests.map(rawSpawnRequest),
    publicationDigest: canonicalPublicationDigest(requests, effect, run),
  };
}

function rawBatchReceipt(
  requests: readonly AgentRequestAuthority[],
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const effect = effectId(`batch-${requests.map(({ requestId: id }) => id).join("-")}`.slice(0, 180));
  const run = requests[0]!.runId;
  return { ...rawBatchReceiptForIdentity(requests, effect, run), ...overrides };
}

function issueRequests(requests: readonly AgentRequestAuthority[]): readonly SpawnRequest[] {
  return valueOf(spawnBatchAction(rawBatchReceipt(requests), requests.map(rawSpawnRequest))).requests;
}

function issuedRequest(request: AgentRequestAuthority): SpawnRequest {
  return issueRequests([request])[0]!;
}

function acceptedResults(exact: ExactRoster): readonly AcceptedAgentResult<string>[] {
  const selected = exact.orderedSlots.map((slot, index) => index % 2 === 0 ? slot.attempts[0] : slot.attempts[1]);
  const issued = issueRequests(selected);
  return issued.map((request, index) => valueOf(acceptedAgentResult(request, `result-${index + 1}`)));
}

const parseStringPayload = (raw: unknown): Result<string, Readonly<{ message: string }>> =>
  typeof raw === "string"
    ? { ok: true, value: raw }
    : { ok: false, error: { message: "payload must be a string" } };

const parseObjectPayload = <T extends Readonly<Record<string, unknown>>>(
  raw: unknown,
): Result<T, Readonly<{ message: string }>> =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? { ok: true, value: raw as T }
    : { ok: false, error: { message: "payload must be an object" } };

function permute<T>(values: readonly T[], keys: readonly number[]): readonly T[] {
  return values
    .map((value, index) => ({ value, index, key: keys[index] ?? 0 }))
    .sort((left, right) => left.key - right.key || left.index - right.index)
    .map(({ value }) => value);
}

function artifact(
  run: OrchestrationRunId,
  n: number,
  path = `artifacts/${n}.json`,
  length = n,
  contentDigest = artifactDigest(100 + n),
): ArtifactRef {
  return valueOf(parseArtifactRef({
    runId: run,
    slot: path,
    digest: contentDigest,
    byteLength: length,
  }));
}

function cyclicObject(): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  value.self = value;
  return value;
}

function hostileMalformedFailureEnvelope(label: string): Readonly<{ ok: false; error: unknown }> {
  const multiMegabyteCause = `${label}:` + "x".repeat(2 * 1_024 * 1_024);
  const thrownProxy = new Proxy({}, {
    getOwnPropertyDescriptor: () => { throw new Error(multiMegabyteCause); },
  });
  const malformedError = new Proxy({}, {
    ownKeys: () => { throw thrownProxy; },
  });
  return { ok: false, error: malformedError };
}

function withObjectPrototypePollution<T>(
  pollution: Readonly<Record<string, unknown>>,
  run: () => T,
): T {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  try {
    for (const [field, value] of Object.entries(pollution)) {
      previous.set(field, Object.getOwnPropertyDescriptor(Object.prototype, field));
      Object.defineProperty(Object.prototype, field, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return run();
  } finally {
    for (const [field, descriptor] of previous) {
      if (descriptor === undefined) delete (Object.prototype as Record<string, unknown>)[field];
      else Object.defineProperty(Object.prototype, field, descriptor);
    }
  }
}

describe("orchestration authority parsers", () => {
  it("is total for BigInt, cyclic, symbols, functions, and non-JSON values", () => {
    const hostile: unknown[] = [1n, cyclicObject(), Symbol("id"), () => undefined, undefined, Number.NaN, Infinity];
    for (const raw of hostile) {
      expect(() => parseOrchestrationRunId(raw)).not.toThrow();
      expect(parseOrchestrationRunId(raw).ok).toBe(false);
      expect(() => parseRequestId(raw)).not.toThrow();
      expect(() => parseAgentRequestAuthority(raw)).not.toThrow();
      expect(parseAgentRequestAuthority(raw).ok).toBe(false);
      expect(() => parseFixedArtifactSlot(raw)).not.toThrow();
    }
    expect(() => parseAgentRequestAuthority({ ...rawAuthority(1, 1), role: 1n })).not.toThrow();
    expect(() => parseAgentRequestAuthority({ ...rawAuthority(1, 1), modelProfile: cyclicObject() })).not.toThrow();
    const cyclicDiagnostic = parseOrchestrationRunId(cyclicObject());
    expect(cyclicDiagnostic.ok).toBe(false);
    expect(() => JSON.stringify(cyclicDiagnostic)).not.toThrow();
    const bigintDiagnostic = parseRequestId(1n);
    expect(() => JSON.stringify(bigintDiagnostic)).not.toThrow();
  });

  it("is total without evaluating hostile callable, accessor, array, or revoked Proxy traps", () => {
    fc.assert(fc.property(fc.string(), (trapMessage) => {
      let getterReads = 0;
      const callable = new Proxy(() => undefined, {
        get: () => { throw new Error(trapMessage); },
      });
      const accessor = new Proxy({}, {
        get: () => {
          getterReads += 1;
          throw new Error(trapMessage);
        },
      });
      const array = new Proxy([], {
        get: () => { throw new Error(trapMessage); },
      });
      const revocable = Proxy.revocable({}, {});
      revocable.revoke();
      for (const raw of [callable, accessor, array, revocable.proxy]) {
        expect(() => parseOrchestrationRunId(raw)).not.toThrow();
        expect(parseOrchestrationRunId(raw).ok).toBe(false);
      }
      expect(getterReads).toBe(0);
    }));
  });

  it("excludes arbitrary invalid authority identities", () => {
    fc.assert(fc.property(
      fc.string({ maxLength: 80 }).filter((raw) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(raw)),
      (raw) => {
        expect(parseOrchestrationRunId(raw).ok).toBe(false);
        expect(parseRequestId(raw).ok).toBe(false);
        expect(parseSlotId(raw).ok).toBe(false);
        expect(parseEffectId(raw).ok).toBe(false);
      },
    ));
  });

  it("accepts only canonical SHA-256 digests and non-negative safe byte lengths", () => {
    fc.assert(fc.property(fc.string({ maxLength: 100 }), (raw) => {
      const expected = /^[0-9a-f]{64}$/.test(raw);
      expect(parseContextDigest(raw).ok).toBe(expected);
      expect(parseArtifactDigest(raw).ok).toBe(expected);
    }));
    for (const invalid of [-1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1n]) {
      expect(parseArtifactByteLength(invalid).ok).toBe(false);
    }
    expect(parseArtifactByteLength(0).ok).toBe(true);
  });

  it("grandfathers a stored authority whose Agent policy has since changed, but still catches tampering", () => {
    // History, not policy: this authority was issued when code-implementer-agent
    // mapped to a different profile. Re-checking it against today's AGENT_POLICIES
    // would strand every run already on disk (the comment-analyzer promotion did
    // exactly that to 5 wave-gate runs).
    const drifted = rawAuthority(1, 1, {
      modelProfile: "focused-review",
      harnessBinding: focusedBindings,
      requiredSkill: "code-implementer",
    });

    // Issuance stays strict — this is what keeps a NEW request bound to policy
    // (and what keeps the Pi lowering honest).
    expect(parseAgentRequestAuthority(drifted).ok).toBe(false);

    // Reading it back succeeds, and returns the recorded facts verbatim.
    const stored = valueOf(parseStoredAgentRequestAuthority(drifted));
    expect(stored.modelProfile).toBe("focused-review");
    expect(stored.requiredSkill).toBe("code-implementer");
    expect(stored.harnessBinding.pi.model).toBe("gpt-5.5");
    expect(stored.harnessBinding.claude.model).toBe("sonnet");

    // A stored Skill that no longer matches today's table is likewise history.
    const driftedSkill = rawAuthority(1, 1, { requiredSkill: "review-and-fix" });
    expect(parseAgentRequestAuthority(driftedSkill).ok).toBe(false);
    expect(valueOf(parseStoredAgentRequestAuthority(driftedSkill)).requiredSkill).toBe("review-and-fix");

    // TAMPER CHECK — unchanged. The binding must still agree with the profile the
    // record itself claims, so a rewritten harnessBinding cannot slip through.
    expect(parseStoredAgentRequestAuthority(rawAuthority(1, 1, {
      modelProfile: "focused-review",
      harnessBinding: implementationBindings,
    })).ok).toBe(false);
    expect(parseStoredAgentRequestAuthority(rawAuthority(1, 1, {
      harnessBinding: { ...implementationBindings, claude: { harness: "claude-code", model: "haiku" } },
    })).ok).toBe(false);

    // Structural parsing is not relaxed either.
    expect(parseStoredAgentRequestAuthority(rawAuthority(1, 1, { attempt: 3 })).ok).toBe(false);
    expect(parseStoredAgentRequestAuthority(rawAuthority(1, 1, { modelProfile: "no-such-profile" })).ok).toBe(false);
  });

  it("proves model and required Skill against resolved Agent policy", () => {
    const parsed = valueOf(parseAgentRequestAuthority(rawAuthority(1, 1)));
    expect(parsed.role).toBe("code-implementer-agent");
    expect(parsed.modelProfile).toBe("implementation");
    expect(parsed.requiredSkill).toBe("code-implementer");
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.harnessBinding)).toBe(true);
    expect(Object.isFrozen(parsed.harnessBinding.pi)).toBe(true);

    expect(parseAgentRequestAuthority(rawAuthority(1, 1, { requiredSkill: "review-and-fix" })).ok).toBe(false);
    expect(parseAgentRequestAuthority(rawAuthority(1, 1, { requiredSkill: null })).ok).toBe(false);
    expect(parseAgentRequestAuthority(rawAuthority(1, 1, { modelProfile: "focused-review" })).ok).toBe(false);

    const noSkillReviewer = rawAuthority(1, 1, {
      role: "code-reviewer",
      modelProfile: "general-review",
      harnessBinding: {
        pi: implementationBindings.pi,
        claude: { harness: "claude-code", model: "sonnet" },
      },
      requiredSkill: null,
    });
    expect(parseAgentRequestAuthority(noSkillReviewer).ok).toBe(true);
    expect(parseAgentRequestAuthority({ ...noSkillReviewer, requiredSkill: "review-and-fix" }).ok).toBe(false);

    const security = rawAuthority(1, 1, {
      role: "security-agent",
      modelProfile: "focused-review",
      harnessBinding: focusedBindings,
      requiredSkill: "security-expert",
    });
    expect(parseAgentRequestAuthority(security).ok).toBe(true);
    expect(parseAgentRequestAuthority({ ...security, requiredSkill: "code-implementer" }).ok).toBe(false);
  });

  it("rejects every extra request and top-level or nested binding field", () => {
    const mutations = [
      { ...rawAuthority(1, 1), extra: true },
      { ...rawAuthority(1, 1), harnessBinding: { ...implementationBindings, inherited: true } },
      {
        ...rawAuthority(1, 1),
        harnessBinding: { ...implementationBindings, pi: { ...implementationBindings.pi, fallback: "parent" } },
      },
      {
        ...rawAuthority(1, 1),
        harnessBinding: { ...implementationBindings, pi: { ...implementationBindings.pi, provider: "parent" } },
      },
      {
        ...rawAuthority(1, 1),
        harnessBinding: { ...implementationBindings, claude: { ...implementationBindings.claude, thinking: "high" } },
      },
      {
        ...rawAuthority(1, 1),
        harnessBinding: { ...implementationBindings, claude: { ...implementationBindings.claude, model: "sonnet" } },
      },
      {
        ...rawAuthority(1, 1),
        outputSlot: { kind: "fixed-artifact-slot", path: "a/b", extra: true },
      },
    ];
    for (const mutation of mutations) expect(parseAgentRequestAuthority(mutation).ok).toBe(false);

    const callerBinding = {
      pi: { ...implementationBindings.pi },
      claude: { ...implementationBindings.claude },
    };
    const canonical = valueOf(parseAgentRequestAuthority(rawAuthority(1, 1, { harnessBinding: callerBinding })));
    expect(canonical.harnessBinding).not.toBe(callerBinding);
    expect(canonical.harnessBinding.pi).not.toBe(callerBinding.pi);
    expect(Object.keys(canonical.harnessBinding.pi)).toEqual(["harness", "provider", "model", "thinking"]);
    expect(Object.keys(canonical.harnessBinding.claude)).toEqual(["harness", "model"]);
  });

  it("never resolves request or nested binding authority through Object.prototype pollution", () => {
    withObjectPrototypePollution({
      runId: runId(),
      model: implementationBindings.pi.model,
    }, () => {
      const missingRunId = { ...rawAuthority(1, 1) } as Record<string, unknown>;
      delete missingRunId.runId;
      const missingPiModel = { ...implementationBindings.pi } as Record<string, unknown>;
      delete missingPiModel.model;
      const missingNestedBinding = {
        ...rawAuthority(1, 1),
        harnessBinding: {
          ...implementationBindings,
          pi: missingPiModel,
        },
      };

      const requestResult = parseAgentRequestAuthority(missingRunId);
      const bindingResult = parseAgentRequestAuthority(missingNestedBinding);
      expect(requestResult.ok).toBe(false);
      expect(bindingResult.ok).toBe(false);
      if (!requestResult.ok) {
        expect(requestResult.error.violations.some(({ field }) => field === "runId")).toBe(true);
      }
      if (!bindingResult.ok) {
        expect(bindingResult.error.violations.some(({ field }) => field === "harnessBinding.pi.model")).toBe(true);
      }
    });
  });

  it("rejects inherited, accessor, symbol, throwing, and revoked request authority without throwing", () => {
    let reads = 0;
    const accessor = { ...rawAuthority(1, 1) } as Record<string, unknown>;
    delete accessor.role;
    Object.defineProperty(accessor, "role", {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error("authority accessor must not run");
      },
    });
    const symbol = { ...rawAuthority(1, 1), [Symbol("hidden")]: true };
    const inherited = Object.create(rawAuthority(1, 1)) as unknown;
    const inheritedPi = {
      ...rawAuthority(1, 1),
      harnessBinding: {
        ...implementationBindings,
        pi: Object.create(implementationBindings.pi),
      },
    };
    const accessorPi = { ...implementationBindings.pi } as Record<string, unknown>;
    delete accessorPi.model;
    Object.defineProperty(accessorPi, "model", {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error("binding accessor must not run");
      },
    });
    const nestedAccessor = {
      ...rawAuthority(1, 1),
      harnessBinding: { ...implementationBindings, pi: accessorPi },
    };
    const nestedSymbol = {
      ...rawAuthority(1, 1),
      harnessBinding: {
        ...implementationBindings,
        pi: { ...implementationBindings.pi, [Symbol("hidden")]: true },
      },
    };
    const nestedThrowing = {
      ...rawAuthority(1, 1),
      harnessBinding: {
        ...implementationBindings,
        pi: new Proxy({ ...implementationBindings.pi }, {
          ownKeys: () => { throw new Error("binding ownKeys trap"); },
        }),
      },
    };
    const revokedPi = Proxy.revocable({ ...implementationBindings.pi }, {});
    const nestedRevoked = {
      ...rawAuthority(1, 1),
      harnessBinding: { ...implementationBindings, pi: revokedPi.proxy },
    };
    revokedPi.revoke();
    const throwing = new Proxy({ ...rawAuthority(1, 1) }, {
      ownKeys: () => { throw new Error("ownKeys trap"); },
    });
    const revoked = Proxy.revocable({ ...rawAuthority(1, 1) }, {});
    revoked.revoke();

    for (const hostile of [
      accessor,
      symbol,
      inherited,
      inheritedPi,
      nestedAccessor,
      nestedSymbol,
      nestedThrowing,
      nestedRevoked,
      throwing,
      revoked.proxy,
    ]) {
      expect(() => parseAgentRequestAuthority(hostile)).not.toThrow();
      expect(parseAgentRequestAuthority(hostile).ok).toBe(false);
    }
    expect(reads).toBe(0);
  });

  it("preserves safe causes from generated record and array inspection traps", () => {
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 80 }), (trapMessage) => {
      const authorityTrap = new Proxy({ ...rawAuthority(1, 1) }, {
        ownKeys: () => { throw new Error(trapMessage); },
      });
      const authorityResult = parseAgentRequestAuthority(authorityTrap);
      expect(authorityResult.ok).toBe(false);
      if (!authorityResult.ok) expect(authorityResult.error.violations[0].message).toContain(trapMessage);

      const byteTrap = new Proxy([1, 2], {
        ownKeys: () => { throw new Error(trapMessage); },
      });
      const byteResult = digestRawTranscriptBytes(byteTrap);
      expect(byteResult.ok).toBe(false);
      if (!byteResult.ok) expect(byteResult.error.message).toContain(trapMessage);
    }));
  });

  it("hashes only canonical raw transcript bytes", () => {
    fc.assert(fc.property(fc.uint8Array(), (bytes) => {
      const asNumbers = [...bytes];
      expect(valueOf(digestRawTranscriptBytes(asNumbers))).toBe(valueOf(digestRawTranscriptBytes([...asNumbers])));
    }));
    for (const invalid of [[0, 256], [0, 1.5], "not bytes", [1n], cyclicObject()]) {
      expect(() => digestRawTranscriptBytes(invalid)).not.toThrow();
      expect(digestRawTranscriptBytes(invalid).ok).toBe(false);
    }
  });

  it("rejects oversized sparse byte arrays before own-key inspection and accepts the exact finite boundary", () => {
    const oversized = [] as number[];
    oversized.length = MAX_DENSE_DATA_ARRAY_LENGTH + 1;
    let ownKeyReads = 0;
    const hostile = new Proxy(oversized, {
      ownKeys: () => {
        ownKeyReads += 1;
        throw new Error("oversized sparse array ownKeys must not run");
      },
    });

    const rejected = digestRawTranscriptBytes(hostile);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.reason).toBe("invalid-array-length");
      expect(rejected.error.index).toBeNull();
      expect(rejected.error.message).toContain(`domain maximum ${MAX_DENSE_DATA_ARRAY_LENGTH}`);
    }
    expect(ownKeyReads).toBe(0);

    const boundary = new Array<number>(MAX_DENSE_DATA_ARRAY_LENGTH).fill(0);
    expect(digestRawTranscriptBytes(boundary).ok).toBe(true);
    expect(digestRawTranscriptBytes([0, 1, 2, 255]).ok).toBe(true);
  });

  it("rejects holes, accessors, symbols, mutation, and trapping byte arrays as typed failures", () => {
    let reads = 0;
    const accessor = [1, 2] as number[];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        throw new Error("byte accessor must not run");
      },
    });
    const symbol = [1, 2] as unknown[] & Record<symbol, unknown>;
    symbol[Symbol("hidden")] = true;
    const throwing = new Proxy([1, 2], {
      ownKeys: () => { throw new Error("byte ownKeys trap"); },
    });
    const revoked = Proxy.revocable([1, 2], {});
    revoked.revoke();
    const mutationTarget = [1, 2];
    let lengthReads = 0;
    const mutating = new Proxy(mutationTarget, {
      getOwnPropertyDescriptor: (target, key) => {
        if (key === "length" && ++lengthReads === 2) target[1] = 3;
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    const hole = [1, , 2];

    for (const hostile of [accessor, symbol, throwing, revoked.proxy, hole]) {
      const result = digestRawTranscriptBytes(hostile);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("invalid-raw-transcript-bytes");
    }
    expect(reads).toBe(0);
    const mutation = digestRawTranscriptBytes(mutating);
    expect(mutation.ok).toBe(false);
    if (!mutation.ok) expect(mutation.error.message).toContain("changed while it was being inspected");
  });

  it("property-tests generated hostile ADT boundaries and preserves the exact inspection cause", () => {
    fc.assert(fc.property(
      fc.constantFrom("authority", "roster", "results", "effect", "diagnostic"),
      fc.constantFrom("getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"),
      fc.string({ minLength: 1, maxLength: 80 }),
      (boundary, trap, trapMessage) => {
        const proxyHandler: ProxyHandler<object> = {
          [trap]: () => { throw new Error(trapMessage); },
        };
        let result: Result<unknown, unknown>;
        if (boundary === "authority") {
          result = parseAgentRequestAuthority(new Proxy({ ...rawAuthority(1, 1) }, proxyHandler));
        } else if (boundary === "roster") {
          result = parseExactRoster(new Proxy([rosterSlot(1)], proxyHandler));
        } else if (boundary === "results") {
          const exact = roster(1);
          result = parseCompleteRoster(
            exact,
            new Proxy([...acceptedResults(exact)], proxyHandler),
            parseStringPayload,
          );
        } else if (boundary === "effect") {
          const [intent, receipt] = effectPairs()[0]!;
          result = reconcileEffectReceipt(new Proxy({ ...intent }, proxyHandler), receipt);
        } else {
          const diagnostic = valueOf(infrastructureRetryDiagnostic({
            category: "infrastructure-failure",
            runId: runId(),
            effectId: effectId("generated-hostile-boundary"),
            message: "generated boundary failed",
          }));
          result = parseBlockedDiagnostic(new Proxy({ ...diagnostic }, proxyHandler));
        }
        expect(result.ok).toBe(false);
        const encodedCause = JSON.stringify(trapMessage).slice(1, -1);
        expect(JSON.stringify(result)).toContain(encodedCause);
      },
    ));
  });

  it("rejects traversal and invalid ArtifactRefs before they confer authority", () => {
    const valid = { runId: runId(), slot: "artifacts/result.json", digest: artifactDigest(1), byteLength: 0 };
    expect(parseArtifactRef(valid).ok).toBe(true);
    for (const invalid of [
      { ...valid, slot: "../result.json" },
      { ...valid, slot: "/tmp/result.json" },
      { ...valid, byteLength: -1 },
      { ...valid, byteLength: 1.5 },
      { ...valid, byteLength: Infinity },
      { ...valid, byteLength: Number.NaN },
      { ...valid, extra: true },
    ]) expect(parseArtifactRef(invalid).ok).toBe(false);
  });
});

describe("ExactRoster and CompleteRoster conservation", () => {
  it("reports generated top-level roster boundary field, index, and reason without empty-roster collapse", () => {
    fc.assert(fc.property(
      fc.constantFrom("not-array", "hole", "accessor", "extra"),
      fc.integer({ min: 0, max: 7 }),
      fc.string({ minLength: 1, maxLength: 12 }).filter((field) =>
        field !== "length" && !/^(0|[1-9][0-9]*)$/.test(field)
      ),
      (variant, generatedIndex, extraField) => {
        const index = generatedIndex % 4;
        let raw: unknown;
        if (variant === "not-array") {
          raw = Object.create(null);
        } else {
          const entries: unknown[] = Array.from({ length: 4 }, (_, slotIndex) => rosterSlot(slotIndex + 1));
          if (variant === "hole") delete entries[index];
          if (variant === "accessor") {
            Object.defineProperty(entries, String(index), {
              enumerable: true,
              configurable: true,
              get: () => { throw new Error("roster accessor must not run"); },
            });
          }
          if (variant === "extra") {
            Object.defineProperty(entries, extraField, { value: true, enumerable: true, configurable: true });
          }
          raw = entries;
        }

        const parsed = parseExactRoster(raw);
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) {
          const boundary = parsed.error.violations[0];
          expect(boundary.kind).toBe("malformed-roster-boundary");
          if (boundary.kind === "malformed-roster-boundary") {
            expect(boundary.reason).toBe(variant === "not-array" ? "not-array" : variant === "accessor" ? "accessor-field" : "sparse-array");
            expect(boundary.index).toBe(variant === "hole" || variant === "accessor" ? index : null);
            expect(boundary.field).toBe(
              variant === "hole" || variant === "accessor" ? String(index) : variant === "extra" ? extraField : null,
            );
          }
        }
      },
    ));
  });

  it("keeps attempts distinct and reports every pair mismatch", () => {
    const valid = parseAgentRosterSlot(rawAuthority(1, 1), rawAuthority(1, 2));
    expect(valid.ok).toBe(true);

    const reusedIdentity = parseAgentRosterSlot(
      rawAuthority(1, 1),
      rawAuthority(1, 2, {
        requestId: requestId("1:1"),
        contextDigest: contextDigest(11),
        outputSlot: "transcripts/agent-1/attempt-1.raw",
      }),
    );
    expect(reusedIdentity.ok).toBe(false);
    if (!reusedIdentity.ok) {
      expect(reusedIdentity.error.violations.map((entry) => "field" in entry ? entry.field : null))
        .toEqual(expect.arrayContaining(["requestId", "contextDigest", "outputSlot"]));
      const collision = reusedIdentity.error.violations.find(({ kind }) => kind === "duplicate-output-path");
      expect(collision?.kind).toBe("duplicate-output-path");
      if (collision?.kind === "duplicate-output-path") {
        expect(collision.first).toEqual({ slotId: slotId("1"), requestId: requestId("1:1"), attempt: 1 });
        expect(collision.duplicate).toEqual({ slotId: slotId("1"), requestId: requestId("1:1"), attempt: 2 });
      }
    }
  });

  it("preserves nested authority violations in roster diagnostics", () => {
    const result = parseAgentRosterSlot(
      rawAuthority(1, 1, { requiredSkill: "wrong", harnessBinding: { ...implementationBindings, pi: { ...implementationBindings.pi, extra: true } } }),
      rawAuthority(1, 2),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const malformed = result.error.violations.find(({ kind }) => kind === "malformed-attempt-authority");
      expect(malformed?.kind).toBe("malformed-attempt-authority");
      if (malformed?.kind === "malformed-attempt-authority") {
        expect(malformed.authorityViolations.map(({ field }) => field))
          .toEqual(expect.arrayContaining(["requiredSkill", "harnessBinding.pi.extra"]));
        expect(Object.isFrozen(malformed.authorityViolations)).toBe(true);
      }
    }
  });

  it("rejects duplicate and cross-slot request/context identities", () => {
    const first = rosterSlot(1);
    const duplicateRequest = {
      ...rosterSlot(2),
      attempts: [
        rawAuthority(2, 1, { requestId: first.attempts[0].requestId }),
        rawAuthority(2, 2),
      ],
    };
    const duplicateContext = {
      ...rosterSlot(2),
      attempts: [
        rawAuthority(2, 1, { contextDigest: first.attempts[0].contextDigest }),
        rawAuthority(2, 2),
      ],
    };
    expect(parseExactRoster([first, first]).ok).toBe(false);
    expect(parseExactRoster([first, duplicateRequest]).ok).toBe(false);
    expect(parseExactRoster([first, duplicateContext]).ok).toBe(false);
    expect(parseExactRoster([first, null]).ok).toBe(false);
  });

  it("rejects every duplicate output path with both colliding slot authorities", () => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 8 }), fc.integer({ min: 0, max: 1 }), (size, attemptIndex) => {
      const slots = Array.from({ length: size }, (_, index) => rosterSlot(index + 1));
      const first = slots[0]!.attempts[attemptIndex]!;
      const duplicateSlot = slots[size - 1]!;
      const duplicateAttempt = duplicateSlot.attempts[1];
      const changed = {
        ...duplicateSlot,
        attempts: [
          duplicateSlot.attempts[0],
          { ...duplicateAttempt, outputSlot: first.outputSlot },
        ],
      };
      const parsed = parseExactRoster([...slots.slice(0, -1), changed]);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        const collision = parsed.error.violations.find(({ kind }) => kind === "duplicate-output-path");
        expect(collision?.kind).toBe("duplicate-output-path");
        if (collision?.kind === "duplicate-output-path") {
          expect(collision.path).toBe(first.outputSlot.path);
          expect(collision.first).toEqual({
            slotId: first.slotId,
            requestId: first.requestId,
            attempt: first.attempt,
          });
          expect(collision.duplicate).toEqual({
            slotId: duplicateAttempt.slotId,
            requestId: duplicateAttempt.requestId,
            attempt: 2,
          });
        }
      }
    }));
  });

  it("returns only the canonical roster slot type", () => {
    type EnrichedSlot = AgentRosterSlot & Readonly<{ reviewer: "claimed-by-caller" }>;
    const canonical = valueOf(parseExactRoster([rosterSlot(1)]));
    // @ts-expect-error parseExactRoster never constructs caller-selected subtype fields.
    const unsound: ExactRoster<EnrichedSlot> = canonical;
    expect("reviewer" in unsound.orderedSlots[0]).toBe(false);
  });

  it("keeps exact and complete roster proofs module-private and rejects spread or tampered exact rosters", () => {
    const exact = roster(2);
    const results = acceptedResults(exact);
    const complete = valueOf(parseCompleteRoster(exact, results, parseStringPayload));

    expect(Reflect.ownKeys(exact).filter((key) => typeof key === "symbol")).toEqual([]);
    expect(Reflect.ownKeys(complete).filter((key) => typeof key === "symbol")).toEqual([]);

    const spreadExactData = { ...exact };
    if (false) {
      // @ts-expect-error Object spread cannot retain module-private exact-roster membership.
      const copiedExactProof: ExactRoster = spreadExactData;
      void copiedExactProof;
    }
    const spreadExact = spreadExactData as unknown as ExactRoster;
    const spreadRejected = parseCompleteRoster(spreadExact, results, parseStringPayload);
    expect(spreadRejected.ok).toBe(false);
    if (!spreadRejected.ok) {
      expect(spreadRejected.error.violations).toEqual([{ kind: "untrusted-exact-roster" }]);
    }

    const tamperedExact = {
      ...exact,
      orderedSlots: Object.freeze([...exact.orderedSlots].reverse()),
    } as unknown as ExactRoster;
    const tamperedRejected = parseCompleteRoster(tamperedExact, results, parseStringPayload);
    expect(tamperedRejected.ok).toBe(false);
    if (!tamperedRejected.ok) {
      expect(tamperedRejected.error.violations[0]?.kind).toBe("untrusted-exact-roster");
    }

    const spreadComplete = { ...complete };
    if (false) {
      // @ts-expect-error Object spread cannot retain module-private complete-roster membership.
      const copiedCompleteProof: typeof complete = spreadComplete;
      void copiedCompleteProof;
    }
    expect(spreadComplete).not.toBe(complete);
    expect(Reflect.ownKeys(spreadComplete).filter((key) => typeof key === "symbol")).toEqual([]);
  });

  it("canonicalizes every issued completion order without losing a slot", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 10 }).chain((size) => fc.tuple(
        fc.constant(size),
        fc.array(fc.nat(), { minLength: size, maxLength: size }),
      )),
      ([size, keys]) => {
        const exact = roster(size);
        const submitted = permute(acceptedResults(exact), keys);
        const complete = valueOf(parseCompleteRoster(exact, submitted, parseStringPayload));
        expect(complete.ordered.map(({ authority: request }) => request.slotId))
          .toEqual(exact.orderedSlots.map(({ slotId: id }) => id));
        expect(complete.ordered.map(({ value }) => value))
          .toEqual(Array.from({ length: size }, (_, index) => `result-${index + 1}`));
        expect(complete.bySlot.size).toBe(size);
        expect(Object.isFrozen(complete)).toBe(true);
        expect(Object.isFrozen(complete.ordered)).toBe(true);
        // Immutability asserted by BEHAVIOUR, not by the absence of a key. The
        // view is a real `Map` subclass now — so that structural equality and
        // serialization see its entries instead of a bag of function properties
        // — which means `set`/`delete`/`clear` are inherited names. Each refuses.
        for (const mutator of ["set", "delete", "clear"] as const) {
          expect(mutator in complete.bySlot).toBe(true);
          expect(() => (complete.bySlot as unknown as Record<string, () => void>)[mutator]!())
            .toThrow(/immutable/);
        }
        expect(complete.bySlot.size).toBe(size);
      },
    ));
  });

  it("reports generated top-level result boundary field, index, and reason", () => {
    fc.assert(fc.property(
      fc.constantFrom("not-array", "hole", "accessor", "extra"),
      fc.integer({ min: 0, max: 20 }),
      (variant, generatedIndex) => {
        const exact = roster(3);
        const valid = [...acceptedResults(exact)] as unknown[];
        const index = generatedIndex % valid.length;
        let raw: unknown = valid;
        if (variant === "not-array") raw = Object.create(null);
        if (variant === "hole") delete valid[index];
        if (variant === "accessor") {
          Object.defineProperty(valid, String(index), {
            enumerable: true,
            configurable: true,
            get: () => { throw new Error("result accessor must not run"); },
          });
        }
        if (variant === "extra") {
          Object.defineProperty(valid, "metadata", { value: true, enumerable: true, configurable: true });
        }

        const parsed = parseCompleteRoster(exact, raw, parseStringPayload);
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) {
          const boundary = parsed.error.violations[0];
          expect(boundary.kind).toBe("malformed-result-boundary");
          if (boundary.kind === "malformed-result-boundary") {
            expect(boundary.reason).toBe(variant === "not-array" ? "not-array" : variant === "accessor" ? "accessor-field" : "sparse-array");
            expect(boundary.index).toBe(variant === "hole" || variant === "accessor" ? index : null);
            expect(boundary.field).toBe(
              variant === "hole" || variant === "accessor" ? String(index) : variant === "extra" ? "metadata" : null,
            );
          }
        }
      },
    ));
  });

  it("canonicalizes and deep-freezes semantic payloads without retaining caller references", () => {
    const exact = roster(1);
    const mutable = {
      summary: "before",
      nested: { findings: [{ message: "original" }] },
    };
    const accepted = valueOf(acceptedAgentResult(issuedRequest(exact.orderedSlots[0]!.attempts[0]), mutable));
    const complete = valueOf(parseCompleteRoster(exact, [accepted], parseObjectPayload<typeof mutable>));
    const proven = complete.ordered[0]!.value;

    expect(proven).not.toBe(mutable);
    expect(proven.nested).not.toBe(mutable.nested);
    expect(proven.nested.findings).not.toBe(mutable.nested.findings);
    expect(Object.isFrozen(proven)).toBe(true);
    expect(Object.getPrototypeOf(proven)).toBeNull();
    expect(Object.isFrozen(proven.nested)).toBe(true);
    expect(Object.getPrototypeOf(proven.nested)).toBeNull();
    expect(Object.isFrozen(proven.nested.findings)).toBe(true);
    expect(Object.isFrozen(proven.nested.findings[0])).toBe(true);

    mutable.summary = "after";
    mutable.nested.findings[0]!.message = "mutated";
    mutable.nested.findings.push({ message: "surplus" });
    expect(proven).toEqual({
      summary: "before",
      nested: { findings: [{ message: "original" }] },
    });
  });

  it("preserves canonicalization and hostile thrown-cause details without leaking exceptions", () => {
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 80 }), (trapMessage) => {
      const exact = roster(1);
      const request = issuedRequest(exact.orderedSlots[0]!.attempts[0]);
      const canonicalizationTrap = new Proxy({}, {
        ownKeys: () => { throw new Error(trapMessage); },
      });
      const acceptedTrap = valueOf(acceptedAgentResult(request, canonicalizationTrap));
      const canonicalizationResult = parseCompleteRoster(
        exact,
        [acceptedTrap],
        (raw) => ({ ok: true, value: raw }),
      );
      expect(canonicalizationResult.ok).toBe(false);
      if (!canonicalizationResult.ok) {
        const payloadFailure = canonicalizationResult.error.violations
          .find(({ kind }) => kind === "invalid-result-payload");
        expect(payloadFailure?.kind).toBe("invalid-result-payload");
        if (payloadFailure?.kind === "invalid-result-payload") {
          expect(payloadFailure.message).toContain(trapMessage);
        }
      }

      const hostileCause = new Proxy({}, {
        getOwnPropertyDescriptor: () => { throw new Error(trapMessage); },
      });
      const safeAccepted = valueOf(acceptedAgentResult(request, { safe: true }));
      const parserResult = parseCompleteRoster(exact, [safeAccepted], () => { throw hostileCause; });
      expect(parserResult.ok).toBe(false);
      if (!parserResult.ok) {
        const payloadFailure = parserResult.error.violations
          .find(({ kind }) => kind === "invalid-result-payload");
        expect(payloadFailure?.kind).toBe("invalid-result-payload");
        if (payloadFailure?.kind === "invalid-result-payload") {
          expect(payloadFailure.message).toContain(trapMessage);
          expect(payloadFailure.message).toContain("uninspectable thrown cause");
        }
      }
    }));
  });

  it("rejects payload accessors, cycles, unsupported values, and throwing parsers without leaking exceptions", () => {
    const exact = roster(1);
    const request = issuedRequest(exact.orderedSlots[0]!.attempts[0]);
    let accessorReads = 0;
    const accessorPayload = {} as Record<string, unknown>;
    Object.defineProperty(accessorPayload, "secret", {
      enumerable: true,
      get: () => {
        accessorReads += 1;
        throw new Error("must not execute");
      },
    });
    const unsafe = [
      accessorPayload,
      cyclicObject(),
      { callback: () => undefined },
      { createdAt: new Date() },
    ];
    for (const payload of unsafe) {
      const accepted = valueOf(acceptedAgentResult(request, payload));
      expect(() => parseCompleteRoster(exact, [accepted], parseObjectPayload)).not.toThrow();
      expect(parseCompleteRoster(exact, [accepted], parseObjectPayload).ok).toBe(false);
    }
    const accepted = valueOf(acceptedAgentResult(request, { safe: true }));
    expect(() => parseCompleteRoster(exact, [accepted], () => { throw new Error("parser failure"); })).not.toThrow();
    const parserFailure = parseCompleteRoster(exact, [accepted], () => { throw new Error("parser failure"); });
    expect(parserFailure.ok).toBe(false);
    if (!parserFailure.ok) {
      const invalidPayload = parserFailure.error.violations.find(({ kind }) => kind === "invalid-result-payload");
      expect(invalidPayload?.kind).toBe("invalid-result-payload");
      if (invalidPayload?.kind === "invalid-result-payload") {
        expect(invalidPayload.message).toContain("parser failure");
      }
    }
    const hostileCause = new Proxy({}, {
      getOwnPropertyDescriptor: () => { throw new Error("cause trap"); },
    });
    expect(() => parseCompleteRoster(exact, [accepted], () => { throw hostileCause; })).not.toThrow();
    expect(parseCompleteRoster(exact, [accepted], () => { throw hostileCause; }).ok).toBe(false);
    expect(accessorReads).toBe(0);
  });

  it("never resolves accepted-result envelope fields through Object.prototype pollution", () => {
    const exact = roster(1);
    const accepted = valueOf(acceptedAgentResult(
      issuedRequest(exact.orderedSlots[0]!.attempts[0]),
      "safe",
    ));
    withObjectPrototypePollution({ kind: "accepted-agent-result" }, () => {
      const missingKind = { ...accepted } as Record<string, unknown>;
      delete missingKind.kind;
      const parsed = parseCompleteRoster(exact, [missingKind], parseStringPayload);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.violations[0]?.kind).toBe("malformed-result");
    });
  });

  it("rejects inherited, accessor, symbol, throwing, and revoked accepted-result envelopes", () => {
    const exact = roster(1);
    const accepted = valueOf(acceptedAgentResult(issuedRequest(exact.orderedSlots[0]!.attempts[0]), "safe"));
    let reads = 0;
    const accessor = { ...accepted } as Record<string, unknown>;
    delete accessor.kind;
    Object.defineProperty(accessor, "kind", {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error("result accessor must not run");
      },
    });
    const symbol = { ...accepted, [Symbol("hidden")]: true };
    const inherited = Object.create(accepted) as unknown;
    const throwing = new Proxy({ ...accepted }, {
      ownKeys: () => { throw new Error("result ownKeys trap"); },
    });
    const revoked = Proxy.revocable({ ...accepted }, {});
    revoked.revoke();
    const resultAccessorArray = [accepted] as unknown[];
    Object.defineProperty(resultAccessorArray, "0", {
      enumerable: true,
      configurable: true,
      get: () => {
        reads += 1;
        throw new Error("result array accessor must not run");
      },
    });

    for (const hostile of [accessor, symbol, inherited, throwing, revoked.proxy]) {
      expect(() => parseCompleteRoster(exact, [hostile], parseStringPayload)).not.toThrow();
      expect(parseCompleteRoster(exact, [hostile], parseStringPayload).ok).toBe(false);
    }
    expect(() => parseCompleteRoster(exact, resultAccessorArray, parseStringPayload)).not.toThrow();
    expect(parseCompleteRoster(exact, resultAccessorArray, parseStringPayload).ok).toBe(false);
    expect(parseCompleteRoster(exact, new Array(1), parseStringPayload).ok).toBe(false);
    expect(reads).toBe(0);
  });

  it("canonicalizes arbitrary JSON semantic payloads", () => {
    fc.assert(fc.property(fc.jsonValue(), (payload) => {
      const exact = roster(1);
      const accepted = valueOf(acceptedAgentResult(issuedRequest(exact.orderedSlots[0]!.attempts[0]), payload));
      const complete = valueOf(parseCompleteRoster(exact, [accepted], (raw) => ({ ok: true, value: raw })));
      expect(complete.ordered[0]!.value).toEqual(payload);
      if (typeof payload === "object" && payload !== null) {
        expect(complete.ordered[0]!.value).not.toBe(payload);
        expect(Object.isFrozen(complete.ordered[0]!.value)).toBe(true);
      }
    }));
  });

  it("returns typed canonicalization diagnostics for oversized sparse payload arrays and accepts the exact boundary", () => {
    const exact = roster(1);
    const request = issuedRequest(exact.orderedSlots[0]!.attempts[0]);
    const oversized = [] as unknown[];
    oversized.length = MAX_SEMANTIC_PAYLOAD_ARRAY_LENGTH + 1;
    let ownKeyReads = 0;
    const hostile = new Proxy(oversized, {
      ownKeys: () => {
        ownKeyReads += 1;
        throw new Error("oversized semantic ownKeys must not run");
      },
    });
    const oversizedAccepted = valueOf(acceptedAgentResult(request, hostile));
    const rejected = parseCompleteRoster(
      exact,
      [oversizedAccepted],
      (raw) => ({ ok: true, value: raw }),
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      const invalid = rejected.error.violations.find(({ kind }) => kind === "invalid-result-payload");
      expect(invalid?.kind).toBe("invalid-result-payload");
      if (invalid?.kind === "invalid-result-payload") {
        expect(invalid.diagnostic).toMatchObject({
          kind: "invalid-semantic-payload",
          phase: "canonicalize",
          reason: "invalid-array-length",
          field: "length",
          index: null,
        });
        expect(invalid.message).toContain(`domain maximum ${MAX_SEMANTIC_PAYLOAD_ARRAY_LENGTH}`);
        expect(Object.isFrozen(invalid.diagnostic)).toBe(true);
      }
    }
    expect(ownKeyReads).toBe(0);

    const boundary = new Array<null>(MAX_SEMANTIC_PAYLOAD_ARRAY_LENGTH).fill(null);
    const boundaryAccepted = valueOf(acceptedAgentResult(request, boundary));
    const complete = valueOf(parseCompleteRoster(
      exact,
      [boundaryAccepted],
      (raw) => ({ ok: true, value: raw }),
    ));
    expect(complete.ordered[0]!.value).toHaveLength(MAX_SEMANTIC_PAYLOAD_ARRAY_LENGTH);
    expect(Object.isFrozen(complete.ordered[0]!.value)).toBe(true);
  });

  // Explicit timeout: this property builds a fresh roster of up to 8 slots and
  // runs six full `parseCompleteRoster` rejections per generated case, for 100
  // cases. It settles around 2.8s alone — comfortably inside the 5s default —
  // but the whole suite runs 152 files in parallel, and under that contention it
  // crosses 5s and fails the run. The budget is what is wrong, not the code:
  // the same test times out identically on an unmodified checkout. Raised
  // rather than shrunk because the generated size range IS the coverage, and
  // matching the explicit budget `session-registry.property.test.ts` already
  // gives its own property suite for the same reason.
  it("rejects missing, duplicate, surplus, malformed, and cross-slot result reuse", () => {
    fc.assert(fc.property(fc.integer({ min: 2, max: 8 }), (size) => {
      const exact = roster(size);
      const valid = acceptedResults(exact);
      expect(parseCompleteRoster(exact, valid.slice(1), parseStringPayload).ok).toBe(false);
      expect(parseCompleteRoster(exact, [valid[0]!, valid[0]!, ...valid.slice(2)], parseStringPayload).ok).toBe(false);
      const foreignIssued = issuedRequest(authority(size + 1, 1));
      const foreign = valueOf(acceptedAgentResult(foreignIssued, "surplus"));
      expect(parseCompleteRoster(exact, [...valid, foreign], parseStringPayload).ok).toBe(false);
      expect(parseCompleteRoster(exact, [{ nonsense: true }, ...valid.slice(1)], parseStringPayload).ok).toBe(false);
      expect(parseCompleteRoster(exact, null, parseStringPayload).ok).toBe(false);
      expect(parseCompleteRoster(exact, [{ ...valid[0], authority: valid[1]!.authority }, ...valid.slice(1)], parseStringPayload).ok).toBe(false);
    }));
  }, 30000);

  it("requires an engine-issued retry request before attempt 2 can complete a roster", () => {
    const exact = roster(1);
    const retry = exact.orderedSlots[0]!.attempts[1];
    const forged = {
      kind: "accepted-agent-result",
      authority: retry,
      value: "forged retry",
    };
    const rejected = parseCompleteRoster(exact, [forged], parseStringPayload);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      const unissued = rejected.error.violations.find(({ kind }) => kind === "unissued-result");
      expect(unissued?.kind).toBe("unissued-result");
      if (unissued?.kind === "unissued-result") {
        expect(unissued.cause.kind).toBe("invalid-publication-identity");
        expect(unissued.cause.message).toContain("issued spawn request");
        expect(unissued.cause.message.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_MESSAGE_LENGTH);
      }
    }

    const issuedRetry = issuedRequest(retry);
    const acceptedRetry = valueOf(acceptedAgentResult(issuedRetry, "issued retry"));
    expect(parseCompleteRoster(exact, [acceptedRetry], parseStringPayload).ok).toBe(true);

    const copiedProof = { authority: issuedRetry.authority, context: issuedRetry.context } as Record<PropertyKey, unknown>;
    for (const key of Reflect.ownKeys(issuedRetry).filter((key) => typeof key === "symbol")) {
      copiedProof[key] = (issuedRetry as unknown as Record<PropertyKey, unknown>)[key];
    }
    expect(acceptedAgentResult(copiedProof as SpawnRequest, "copied proof").ok).toBe(false);

    const initial = issuedRequest(exact.orderedSlots[0]!.attempts[0]);
    const reusedAttemptIdentity = {
      ...valueOf(acceptedAgentResult(initial, "reused")),
      authority: retry,
    };
    expect(parseCompleteRoster(exact, [reusedAttemptIdentity], parseStringPayload).ok).toBe(false);
  });

  it("rejects every stale request/context/model/Skill/attempt/output binding", () => {
    fc.assert(fc.property(
      fc.constantFrom(
        "requestId", "runId", "slotId", "program", "role-and-model", "harnessBinding",
        "contextDigest", "requiredSkill", "outputSlot", "attempt",
      ),
      (field) => {
        const exact = roster(2);
        const valid = acceptedResults(exact);
        const original = valid[0]!;
        const changed: Readonly<Record<string, unknown>> = field === "requestId"
          ? { requestId: requestId("stale") }
          : field === "runId"
            ? { runId: runId("foreign") }
            : field === "slotId"
              ? { slotId: slotId("foreign") }
              : field === "program"
                ? { program: "standalone-review" }
                : field === "role-and-model"
                  ? { role: "security-agent", modelProfile: "focused-review", harnessBinding: focusedBindings, requiredSkill: "security-expert" }
                  : field === "harnessBinding"
                    ? { harnessBinding: { ...implementationBindings, pi: { ...implementationBindings.pi, model: "gpt-5.5" } } }
                    : field === "contextDigest"
                      ? { contextDigest: contextDigest(9_000) }
                      : field === "requiredSkill"
                        ? { requiredSkill: "security-expert" }
                        : field === "outputSlot"
                          ? { outputSlot: "foreign/result.raw" }
                          : { attempt: original.authority.attempt === 1 ? 2 : 1 };
        const mismatched = [{ ...original, authority: { ...original.authority, ...changed } }, ...valid.slice(1)];
        expect(parseCompleteRoster(exact, mismatched, parseStringPayload).ok).toBe(false);
      },
    ));
  });
});

describe("spawn and external action authority", () => {
  it("parses every batch receipt field and rejects unknown or duplicate authority", () => {
    const request = authority(1, 1);
    const valid = rawBatchReceipt([request]);
    const canonical = valueOf(parseBatchPublishedReceipt(valid));
    expect(Object.isFrozen(canonical)).toBe(true);
    expect(Object.isFrozen(canonical.requestIds)).toBe(true);
    expect(Object.isFrozen(canonical.contextDigests)).toBe(true);
    for (const invalid of [
      { ...valid, schemaVersion: 2 },
      { ...valid, kind: "published" },
      { ...valid, effectId: "" },
      { ...valid, runId: "" },
      { ...valid, requestIds: [] },
      { ...valid, contextDigests: [] },
      { ...valid, issuedRequests: [] },
      { ...valid, publicationDigest: "bad" },
      { ...valid, extra: true },
      { ...valid, requestIds: [request.requestId, request.requestId], contextDigests: [request.contextDigest, contextDigest(999)] },
      { ...valid, requestIds: [request.requestId, requestId("other")], contextDigests: [request.contextDigest, request.contextDigest] },
    ]) expect(parseBatchPublishedReceipt(invalid).ok).toBe(false);
  });

  it("keeps structural receipt parsing separate from registered publication authority", () => {
    const forgedRequest = authority(77, 1);
    const selfConsistentRawReceipt = rawBatchReceipt([forgedRequest]);
    const structuralReceipt = valueOf(parseBatchPublishedReceipt(selfConsistentRawReceipt));

    expect(orchestrationContract).not.toHaveProperty("parseRegisteredBatchPublicationAuthority");
    expect(orchestrationContract).not.toHaveProperty("reconcileInitialBatchPublication");
    if (false) {
      // @ts-expect-error Raw receipt upgrade API is intentionally absent.
      orchestrationContract.reconcileInitialBatchPublication(selfConsistentRawReceipt);
    }
    expect(spawnBatchActionWithAuthority(
      structuralReceipt as unknown as InitialPublicationIssuanceAuthority,
      [rawSpawnRequest(forgedRequest)],
    ).ok).toBe(false);
    expect(spawnBatchActionWithAuthority(
      selfConsistentRawReceipt as unknown as InitialPublicationIssuanceAuthority,
      [rawSpawnRequest(forgedRequest)],
    ).ok).toBe(false);
  });

  it("claims the prepared identity before rejecting mismatched independently returned publication bytes", () => {
    const expectedRequest = authority(80, 1);
    const forgedRequest = authority(81, 1);
    const expectedReceipt = valueOf(parseBatchPublishedReceipt(rawBatchReceipt([expectedRequest])));
    const forgedReceipt = rawBatchReceiptForIdentity(
      [forgedRequest],
      expectedReceipt.effectId,
      expectedReceipt.runId,
    );
    const intent = valueOf(prepareIntentFromReceipt(expectedReceipt));
    const durableClaims: DurableInitialPublicationClaims = new Map();
    let claimCalls = 0;
    const reconciler = createInitialBatchPublicationReconciler(
      createInitialPublicationEffectPort(publicationEffect(forgedReceipt)),
      createAtomicInitialPublicationClaimPort(atomicInitialPublicationClaim(durableClaims, () => { claimCalls += 1; })),
    );

    const rejected = reconciler(intent);
    expect(rejected.ok).toBe(false);
    expect(claimCalls).toBe(1);
    expect([...durableClaims.values()]).toEqual([publicationIdentity(expectedReceipt)]);
    if (!rejected.ok) expect(rejected.error.field).toContain("publicationEffect.receipt");
  });

  it("recovers when the claim commits and throws before the publication effect", () => {
    const request = authority(82, 1);
    const rawReceipt = rawBatchReceipt([request]);
    const intent = valueOf(prepareIntentFromReceipt(rawReceipt));
    const durableClaims: DurableInitialPublicationClaims = new Map();
    const durableClaim = atomicInitialPublicationClaim(durableClaims);
    let crashAfterFirstCommit = true;
    let effectCalls = 0;
    const effect: InitialPublicationEffectExecutor = () => {
      effectCalls += 1;
      return { ok: true, value: encodeJson(rawReceipt) };
    };
    const claimThenCrash: AtomicInitialPublicationClaim = (claimRequest) => {
      const committed = durableClaim(claimRequest);
      if (crashAfterFirstCommit) {
        crashAfterFirstCommit = false;
        throw new Error("simulated crash after durable claim commit");
      }
      return committed;
    };
    const reconciler = createInitialBatchPublicationReconciler(
      createInitialPublicationEffectPort(effect),
      createAtomicInitialPublicationClaimPort(claimThenCrash),
    );

    const interrupted = reconciler(intent);
    expect(interrupted.ok).toBe(false);
    expect(durableClaims.size).toBe(1);
    expect(effectCalls).toBe(0);
    if (!interrupted.ok) expect(interrupted.error.message).toContain("simulated crash after durable claim commit");

    const restartedIntent = valueOf(prepareIntentFromReceipt(rawReceipt));
    const restartedReconciler = createInitialBatchPublicationReconciler(
      createInitialPublicationEffectPort(effect),
      createAtomicInitialPublicationClaimPort(atomicInitialPublicationClaim(durableClaims)),
    );
    const recoveredIssuance = valueOf(restartedReconciler(restartedIntent));
    expect(effectCalls).toBe(1);
    const recoveredAction = valueOf(spawnBatchActionWithAuthority(
      recoveredIssuance,
      [rawSpawnRequest(request)],
    ));
    expect(recoveredAction.publicationIdentity).toEqual(publicationIdentity(recoveredAction.receipt));
    expect(recoveredAction.idempotencyKey).toEqual({
      runId: recoveredAction.runId,
      effectId: recoveredAction.receipt.effectId,
    });
  });

  it("reinvokes the publication effect after a matching claimed failure", () => {
    const request = authority(85, 1);
    const rawReceipt = rawBatchReceipt([request]);
    const intent = valueOf(prepareIntentFromReceipt(rawReceipt));
    const durableClaims: DurableInitialPublicationClaims = new Map();
    let effectCalls = 0;
    const effect: InitialPublicationEffectExecutor = () => {
      effectCalls += 1;
      return effectCalls === 1
        ? { ok: false, error: { kind: "initial-publication-effect-failed", message: "temporary publication failure" } }
        : { ok: true, value: encodeJson(rawReceipt) };
    };
    const reconciler = createInitialBatchPublicationReconciler(
      createInitialPublicationEffectPort(effect),
      createAtomicInitialPublicationClaimPort(atomicInitialPublicationClaim(durableClaims)),
    );

    const failed = reconciler(intent);
    expect(failed.ok).toBe(false);
    expect(effectCalls).toBe(1);
    expect(durableClaims.size).toBe(1);
    if (!failed.ok) expect(failed.error.message).toContain("temporary publication failure");

    const recovered = valueOf(reconciler(intent));
    expect(effectCalls).toBe(2);
    expect(valueOf(spawnBatchActionWithAuthority(recovered, [rawSpawnRequest(request)])).receipt)
      .toEqual(valueOf(parseBatchPublishedReceipt(rawReceipt)));
  });

  it("recovers after a post-effect crash without rewriting any durable publication bytes", () => {
    const request = authority(84, 1);
    const rawReceipt = rawBatchReceipt([request]);
    const exactPublicationBytes = Object.freeze(encodeJson(rawReceipt));
    const divergentBytes = Object.freeze([...new TextEncoder().encode("divergent bytes must remain untouched")]);
    const identity = publicationIdentity(valueOf(parseBatchPublishedReceipt(rawReceipt)));
    const canonicalKey = `publication:${registrationKey(identity)}`;
    const divergentKey = `divergent:${registrationKey(identity)}`;
    const durablePublications = new Map<string, readonly number[]>([[divergentKey, divergentBytes]]);
    const durableClaims: DurableInitialPublicationClaims = new Map();
    let crashAfterDurableWrite = true;
    let effectCalls = 0;

    const safeExactWriteEffect: InitialPublicationEffectExecutor = () => {
      effectCalls += 1;
      const existing = durablePublications.get(canonicalKey);
      if (existing === undefined) {
        durablePublications.set(canonicalKey, exactPublicationBytes);
      } else if (JSON.stringify(existing) !== JSON.stringify(exactPublicationBytes)) {
        return {
          ok: false,
          error: {
            kind: "initial-publication-effect-failed",
            message: "canonical publication contains divergent bytes",
          },
        };
      }
      if (crashAfterDurableWrite) {
        crashAfterDurableWrite = false;
        throw new Error("simulated crash after exact publication write");
      }
      return { ok: true, value: durablePublications.get(canonicalKey)! };
    };

    const firstProcess = createInitialBatchPublicationReconciler(
      createInitialPublicationEffectPort(safeExactWriteEffect),
      createAtomicInitialPublicationClaimPort(atomicInitialPublicationClaim(durableClaims)),
    );
    const interrupted = firstProcess(valueOf(prepareIntentFromReceipt(rawReceipt)));
    expect(interrupted.ok).toBe(false);
    if (!interrupted.ok) expect(interrupted.error.message).toContain("simulated crash after exact publication write");
    expect(effectCalls).toBe(1);
    expect(durablePublications.get(canonicalKey)).toEqual(exactPublicationBytes);
    expect(durablePublications.get(divergentKey)).toBe(divergentBytes);
    const bytesAfterCrash = new Map(durablePublications);

    const restartedProcess = createInitialBatchPublicationReconciler(
      createInitialPublicationEffectPort(safeExactWriteEffect),
      createAtomicInitialPublicationClaimPort(atomicInitialPublicationClaim(durableClaims)),
    );
    const reconstructedAuthority = valueOf(restartedProcess(valueOf(prepareIntentFromReceipt(rawReceipt))));
    const reconstructedAction = valueOf(spawnBatchActionWithAuthority(
      reconstructedAuthority,
      [rawSpawnRequest(request)],
    ));
    expect(effectCalls).toBe(2);
    expect(durablePublications).toEqual(bytesAfterCrash);
    expect(durablePublications.get(canonicalKey)).toBe(exactPublicationBytes);
    expect(durablePublications.get(divergentKey)).toBe(divergentBytes);

    const secondRestart = createInitialBatchPublicationReconciler(
      createInitialPublicationEffectPort(safeExactWriteEffect),
      createAtomicInitialPublicationClaimPort(atomicInitialPublicationClaim(durableClaims)),
    );
    const replayAuthority = valueOf(secondRestart(valueOf(prepareIntentFromReceipt(rawReceipt))));
    const replayAction = valueOf(spawnBatchActionWithAuthority(replayAuthority, [rawSpawnRequest(request)]));
    expect(replayAction).toEqual(reconstructedAction);
    expect(JSON.stringify(replayAction)).toBe(JSON.stringify(reconstructedAction));
    expect(durablePublications).toEqual(bytesAfterCrash);
  });

  it("preserves bounded hostile causes and exact fields from all malformed failure envelopes", () => {
    const request = authority(92, 1);
    const rawReceipt = rawBatchReceipt([request]);
    const intent = valueOf(prepareIntentFromReceipt(rawReceipt));

    const effectFailure = createInitialBatchPublicationReconciler(
      createInitialPublicationEffectPort(() =>
        hostileMalformedFailureEnvelope("effect-envelope-cause") as ReturnType<InitialPublicationEffectExecutor>
      ),
      createAtomicInitialPublicationClaimPort(atomicInitialPublicationClaim(new Map())),
    )(intent);

    const malformedClaim: AtomicInitialPublicationClaim = () =>
      hostileMalformedFailureEnvelope("claim-envelope-cause") as ReturnType<AtomicInitialPublicationClaim>;
    const claimFailure = createInitialBatchPublicationReconciler(
      createInitialPublicationEffectPort(publicationEffect(rawReceipt)),
      createAtomicInitialPublicationClaimPort(malformedClaim),
    )(intent);

    const loaderResolver = createPublicationAuthorityResolver(() =>
      hostileMalformedFailureEnvelope("loader-envelope-cause") as ReturnType<TrustedPublicationRegistrationLoader>
    );
    const loaderFailure = loaderResolver(publicationIdentity(valueOf(parseBatchPublishedReceipt(rawReceipt))));

    const persisted = JSON.parse(JSON.stringify(issuedRequest(request))) as unknown;
    const malformedResolver: PublicationAuthorityResolver = () =>
      hostileMalformedFailureEnvelope("resolver-envelope-cause") as ReturnType<PublicationAuthorityResolver>;
    const resolverFailure = parseIssuedSpawnRequestWithAuthority(malformedResolver, persisted);

    const failures = [
      { label: "effect-envelope-cause", field: "publicationEffect.error", result: effectFailure },
      { label: "claim-envelope-cause", field: "publicationClaim.error", result: claimFailure },
      { label: "loader-envelope-cause", field: "publicationRegistrationLoader.error", result: loaderFailure },
      { label: "resolver-envelope-cause", field: "publicationAuthorityResolver.error", result: resolverFailure },
    ] as const;
    for (const { label, field, result } of failures) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.field).toBe(field);
        expect(result.error.message).toContain(label);
        expect(result.error.message).toContain("uninspectable thrown cause");
        expect(result.error.message).toHaveLength(MAX_DIAGNOSTIC_MESSAGE_LENGTH);
        expect(result.error.message.endsWith("…[truncated]")).toBe(true);
      }
    }
  });

  it("returns a structurally stable action for every matching durable replay", () => {
    const requests = [authority(86, 1), authority(87, 1)];
    const rawReceipt = rawBatchReceipt(requests);
    const intent = valueOf(prepareIntentFromReceipt(rawReceipt));
    const durableClaims: DurableInitialPublicationClaims = new Map();
    const reconciler = createInitialBatchPublicationReconciler(
      createInitialPublicationEffectPort(publicationEffect(rawReceipt)),
      createAtomicInitialPublicationClaimPort(atomicInitialPublicationClaim(durableClaims)),
    );

    const firstIssuance = valueOf(reconciler(intent));
    const firstAction = valueOf(spawnBatchActionWithAuthority(firstIssuance, requests.map(rawSpawnRequest)));
    expect(spawnBatchActionWithAuthority(firstIssuance, requests.map(rawSpawnRequest)).ok).toBe(false);

    const replayIssuance = valueOf(reconciler(intent));
    const replayAction = valueOf(spawnBatchActionWithAuthority(replayIssuance, requests.map(rawSpawnRequest)));
    expect(replayAction).toEqual(firstAction);
    expect(JSON.stringify(replayAction)).toBe(JSON.stringify(firstAction));
    expect(replayAction.requests.map(({ authority: issued }) => issued.requestId))
      .toEqual(firstAction.requests.map(({ authority: issued }) => issued.requestId));
    expect(replayAction.requests.map(({ authority: issued }) => issued.outputSlot))
      .toEqual(firstAction.requests.map(({ authority: issued }) => issued.outputSlot));
    expect(replayAction.requests.map(({ authority: issued }) => ({
      contextDigest: issued.contextDigest,
      modelProfile: issued.modelProfile,
      harnessBinding: issued.harnessBinding,
      requiredSkill: issued.requiredSkill,
    }))).toEqual(firstAction.requests.map(({ authority: issued }) => ({
      contextDigest: issued.contextDigest,
      modelProfile: issued.modelProfile,
      harnessBinding: issued.harnessBinding,
      requiredSkill: issued.requiredSkill,
    })));
    expect(Object.keys(replayAction.idempotencyKey)).toEqual(["runId", "effectId"]);
    expect("publicationDigest" in replayAction.idempotencyKey).toBe(false);
  });

  it("allows exactly one digest for a run/effect under every contender order", () => {
    const firstRequest = authority(88, 1);
    const secondRequest = authority(89, 1);
    const sharedRun = firstRequest.runId;
    const sharedEffect = effectId("single-digest-per-run-effect");
    const contenders = [
      {
        request: firstRequest,
        receipt: rawBatchReceiptForIdentity([firstRequest], sharedEffect, sharedRun),
      },
      {
        request: secondRequest,
        receipt: rawBatchReceiptForIdentity([secondRequest], sharedEffect, sharedRun),
      },
    ] as const;

    for (const order of [[0, 1], [1, 0]] as const) {
      const durableClaims: DurableInitialPublicationClaims = new Map();
      const publicationStore = new Map<string, readonly number[]>();
      const effectCalls = [0, 0];
      const claim = atomicInitialPublicationClaim(durableClaims);
      const reconcile = (index: 0 | 1) => createInitialBatchPublicationReconciler(
        createInitialPublicationEffectPort(() => {
          effectCalls[index] += 1;
          const bytes = encodeJson(contenders[index].receipt);
          publicationStore.set(registrationKey({ runId: sharedRun, effectId: sharedEffect }), bytes);
          return { ok: true, value: bytes };
        }),
        createAtomicInitialPublicationClaimPort(claim),
      )(valueOf(prepareIntentFromReceipt(contenders[index].receipt)));

      const winner = valueOf(reconcile(order[0]));
      expect(reconcile(order[0]).ok).toBe(true);
      const storeBeforeConflict = new Map(publicationStore);
      const conflict = reconcile(order[1]);
      expect(conflict.ok).toBe(false);
      expect(effectCalls[order[0]]).toBe(2);
      expect(effectCalls[order[1]]).toBe(0);
      expect(publicationStore).toEqual(storeBeforeConflict);
      if (!conflict.ok) {
        expect(conflict.error.field).toBe("publicationClaim.claimedIdentity.publicationDigest");
        expect(conflict.error.message).toContain("different digest for the same run/effect");
      }
      expect(durableClaims.size).toBe(1);
      expect(publicationStore.size).toBe(1);
      const stored = [...durableClaims.values()][0]!;
      const winnerAction = valueOf(spawnBatchActionWithAuthority(
        winner,
        [rawSpawnRequest(contenders[order[0]].request)],
      ));
      expect(stored.publicationDigest).toBe(winnerAction.receipt.publicationDigest);
      expect([...durableClaims.keys()]).toEqual([`${sharedRun}\u0000${sharedEffect}`]);
    }
  });

  it("fails closed when the atomic claim returns a foreign key or identity", () => {
    const request = authority(90, 1);
    const rawReceipt = rawBatchReceipt([request]);
    const intent = valueOf(prepareIntentFromReceipt(rawReceipt));
    const foreignIdentityClaim: AtomicInitialPublicationClaim = (claimRequest) => ({
      ok: true,
      value: {
        schemaVersion: 1,
        kind: "initial-publication-matching-replay",
        key: claimRequest.key,
        identity: { ...claimRequest.identity, runId: runId("foreign-claim") },
      },
    });
    const foreignKeyClaim: AtomicInitialPublicationClaim = (claimRequest) => ({
      ok: true,
      value: {
        schemaVersion: 1,
        kind: "initial-publication-claimed",
        key: { ...claimRequest.key, effectId: effectId("foreign-claim") },
        identity: claimRequest.identity,
      },
    });

    for (const foreignClaim of [foreignIdentityClaim, foreignKeyClaim]) {
      const reconciler = createInitialBatchPublicationReconciler(
        createInitialPublicationEffectPort(publicationEffect(rawReceipt)),
        createAtomicInitialPublicationClaimPort(foreignClaim),
      );
      const rejected = reconciler(intent);
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error.message).toContain("foreign");
    }
  });

  it("does not burn local authority on malformed requests and consumes only a successful use", () => {
    const request = authority(91, 1);
    const rawReceipt = rawBatchReceipt([request]);
    const durableClaims: DurableInitialPublicationClaims = new Map();

    const issueAuthority = valueOf(reconcileTrustedInitialPublication(rawReceipt, undefined, durableClaims));
    expect(issueInitialSpawnRequests(issueAuthority, [null]).ok).toBe(false);
    expect(issueInitialSpawnRequests(issueAuthority, [rawSpawnRequest(request)]).ok).toBe(true);
    expect(issueInitialSpawnRequests(issueAuthority, [rawSpawnRequest(request)]).ok).toBe(false);

    const actionAuthority = valueOf(reconcileTrustedInitialPublication(rawReceipt, undefined, durableClaims));
    expect(spawnBatchActionWithAuthority(actionAuthority, [{ authority: request }]).ok).toBe(false);
    const action = valueOf(spawnBatchActionWithAuthority(actionAuthority, [rawSpawnRequest(request)]));
    expect(spawnBatchActionWithAuthority(actionAuthority, [rawSpawnRequest(request)]).ok).toBe(false);

    const replayAuthority = valueOf(reconcileTrustedInitialPublication(rawReceipt, undefined, durableClaims));
    const replayAction = valueOf(spawnBatchActionWithAuthority(replayAuthority, [rawSpawnRequest(request)]));
    expect(replayAction).toEqual(action);
    expect(replayAction.idempotencyKey).toEqual(action.idempotencyKey);
  });

  it("does not accept restart resolver authority as the initial publication effect port", () => {
    const request = authority(83, 1);
    const rawReceipt = rawBatchReceipt([request]);
    const intent = valueOf(prepareIntentFromReceipt(rawReceipt));
    const claimPort = createAtomicInitialPublicationClaimPort(atomicInitialPublicationClaim(new Map()));
    if (false) {
      // @ts-expect-error Restart resolvers are nominally incompatible with initial publication effect ports.
      createInitialBatchPublicationReconciler(publicationResolver, claimPort);
    }
    const reconciler = createInitialBatchPublicationReconciler(
      publicationResolver as unknown as InitialPublicationEffectPort,
      claimPort,
    );
    expect(reconciler(intent).ok).toBe(false);
  });

  it("separates single-use initial issuance from restart registration authority", () => {
    const request = authority(78, 1);
    const rawReceipt = rawBatchReceipt([request]);
    const initial = valueOf(reconcileTrustedInitialPublication(rawReceipt));
    const registered = registerPublication(rawReceipt);

    expect(initial.kind).toBe("initial-publication-issuance-authority");
    expect(Object.getPrototypeOf(initial)).toBeNull();
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Reflect.ownKeys(initial).filter((key) => typeof key === "symbol")).toEqual([]);
    expect(issueInitialSpawnRequests(
      registered as unknown as InitialPublicationIssuanceAuthority,
      [rawSpawnRequest(request)],
    ).ok).toBe(false);
    expect(spawnBatchActionWithAuthority(
      registered as unknown as InitialPublicationIssuanceAuthority,
      [rawSpawnRequest(request)],
    ).ok).toBe(false);

    const issued = valueOf(issueInitialSpawnRequests(initial, [rawSpawnRequest(request)]));
    expect(issued).toHaveLength(1);
    expect(issueInitialSpawnRequests(initial, [rawSpawnRequest(request)]).ok).toBe(false);
    expect(spawnBatchActionWithAuthority(initial, [rawSpawnRequest(request)]).ok).toBe(false);

    const copiedInitial = { ...valueOf(reconcileTrustedInitialPublication(rawReceipt)) };
    if (false) {
      // @ts-expect-error Object spread cannot retain module-private initial issuance membership.
      issueInitialSpawnRequests(copiedInitial, [rawSpawnRequest(request)]);
    }
    expect(issueInitialSpawnRequests(
      copiedInitial as unknown as InitialPublicationIssuanceAuthority,
      [rawSpawnRequest(request)],
    ).ok).toBe(false);

    if (false) {
      // @ts-expect-error Restart registration authority cannot authorize initial issuance.
      issueInitialSpawnRequests(registered, [rawSpawnRequest(request)]);
      // @ts-expect-error Restart registration authority cannot construct an initial spawn action.
      spawnBatchActionWithAuthority(registered, [rawSpawnRequest(request)]);
    }
  });

  it("derives the publication digest from canonical receipt and request content", () => {
    const request = authority(1, 1);
    const valid = rawBatchReceipt([request]);
    expect(parseBatchPublishedReceipt(valid).ok).toBe(true);

    const divergent = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    const issued = divergent.issuedRequests as Array<Record<string, unknown>>;
    issued[0]!.authority = {
      ...(issued[0]!.authority as Record<string, unknown>),
      outputSlot: "transcripts/divergent/attempt-1.raw",
    };
    const rejected = parseBatchPublishedReceipt(divergent);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.field).toBe("receipt.publicationDigest");
  });

  it("is total over malformed and null batch receipts, requests, and contexts", () => {
    const request = authority(1, 1);
    const receipt = rawBatchReceipt([request]);
    const malformed: unknown[] = [null, undefined, 1n, cyclicObject(), "x", {}, [null]];
    for (const value of malformed) {
      expect(() => spawnBatchAction(value, value)).not.toThrow();
      expect(spawnBatchAction(value, value).ok).toBe(false);
    }
    for (const badRequest of [null, {}, { authority: request }, { authority: request, context: null }, { authority: null, context: contextFor(request) }]) {
      expect(() => spawnBatchAction(receipt, [badRequest])).not.toThrow();
      expect(spawnBatchAction(receipt, [badRequest]).ok).toBe(false);
    }
  });

  it("rejects generated duplicate output-slot paths with exact typed collision authority", () => {
    fc.assert(fc.property(
      fc.integer({ min: 2, max: 8 }).chain((size) => fc.tuple(
        fc.constant(size),
        fc.integer({ min: 1, max: size - 1 }),
      )),
      ([size, duplicateIndex]) => {
        const requests = Array.from({ length: size }, (_, index) => authority(index + 1, 1));
        const first = requests[0]!;
        requests[duplicateIndex] = valueOf(parseAgentRequestAuthority(rawAuthority(duplicateIndex + 1, 1, {
          outputSlot: first.outputSlot.path,
        })));
        const duplicate = requests[duplicateIndex]!;
        const result = spawnBatchAction(rawBatchReceipt(requests), requests.map(rawSpawnRequest));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toEqual({
            kind: "spawn-output-slot-collision",
            field: "requests.authority.outputSlot.path",
            message: `spawn output slot '${first.outputSlot.path}' is authorized by requests 0 and ${duplicateIndex}`,
            path: first.outputSlot.path,
            first: {
              index: 0,
              requestId: first.requestId,
              slotId: first.slotId,
              attempt: first.attempt,
            },
            duplicate: {
              index: duplicateIndex,
              requestId: duplicate.requestId,
              slotId: duplicate.slotId,
              attempt: duplicate.attempt,
            },
          });
          expect(Object.isFrozen(result.error)).toBe(true);
          if (result.error.kind === "spawn-output-slot-collision") {
            expect(Object.isFrozen(result.error.first)).toBe(true);
            expect(Object.isFrozen(result.error.duplicate)).toBe(true);
          }
        }
      },
    ));
  });

  it("rejects duplicate IDs and context slot/digest/order drift", () => {
    const requests = [authority(1, 1), authority(2, 1)];
    const receipt = rawBatchReceipt(requests);
    const rawRequests = requests.map(rawSpawnRequest);
    expect(spawnBatchAction(receipt, rawRequests).ok).toBe(true);

    expect(spawnBatchAction({ ...receipt, requestIds: [requests[0]!.requestId, requests[0]!.requestId] }, rawRequests).ok).toBe(false);
    expect(spawnBatchAction({ ...receipt, contextDigests: [requests[0]!.contextDigest, requests[0]!.contextDigest] }, rawRequests).ok).toBe(false);
    expect(spawnBatchAction(receipt, [rawRequests[0], rawRequests[0]]).ok).toBe(false);
    expect(spawnBatchAction(receipt, [
      rawRequests[0],
      { ...rawRequests[1], context: contextFor(requests[0]!) },
    ]).ok).toBe(false);
    expect(spawnBatchAction(receipt, [
      { ...rawRequests[0], context: { ...contextFor(requests[0]!), slot: "contexts/wrong.json" } },
      rawRequests[1],
    ]).ok).toBe(false);
    expect(spawnBatchAction({
      ...receipt,
      requestIds: [...(receipt.requestIds as unknown[] ?? [])].reverse(),
    }, rawRequests).ok).toBe(false);
    expect(spawnBatchAction({
      ...receipt,
      contextDigests: [...(receipt.contextDigests as unknown[] ?? [])].reverse(),
    }, rawRequests).ok).toBe(false);
  });

  it("emits at most one attempt per semantic slot and permits attempt 2 only in a later action", () => {
    const pair = rosterSlot(1).attempts;
    const sameBatch = rawBatchReceipt([pair[0], pair[1]]);
    expect(parseBatchPublishedReceipt(sameBatch).ok).toBe(false);
    expect(spawnBatchAction(sameBatch, pair.map(rawSpawnRequest)).ok).toBe(false);

    const firstAction = valueOf(spawnBatchAction(rawBatchReceipt([pair[0]]), [rawSpawnRequest(pair[0])]));
    const retryAction = valueOf(spawnBatchAction(rawBatchReceipt([pair[1]]), [rawSpawnRequest(pair[1])]));
    expect(firstAction.requests).toHaveLength(1);
    expect(firstAction.requests[0].authority.attempt).toBe(1);
    expect(retryAction.requests).toHaveLength(1);
    expect(retryAction.requests[0].authority.attempt).toBe(2);
  });

  it("canonicalizes and deep-freezes caller-owned publication receipts", () => {
    const requests = [authority(1, 1), authority(2, 1)];
    const requestIds = requests.map(({ requestId: id }) => id);
    const contextDigests = requests.map(({ contextDigest: id }) => id);
    const mutableEffectId = effectId("mutable");
    const mutableRunId = runId();
    const mutable = {
      schemaVersion: 1,
      kind: "batch-published",
      effectId: mutableEffectId,
      runId: mutableRunId,
      requestIds,
      contextDigests,
      issuedRequests: requests.map(rawSpawnRequest),
      publicationDigest: canonicalPublicationDigest(requests, mutableEffectId, mutableRunId),
    };
    const action = valueOf(spawnBatchAction(mutable, requests.map(rawSpawnRequest)));
    expect(action.receipt).not.toBe(mutable);
    expect(action.receipt.requestIds).not.toBe(requestIds);
    expect(action.receipt.contextDigests).not.toBe(contextDigests);
    expect(Object.isFrozen(action.receipt)).toBe(true);
    expect(Object.isFrozen(action.receipt.requestIds)).toBe(true);
    expect(Object.isFrozen(action.receipt.contextDigests)).toBe(true);

    mutable.effectId = effectId("mutated");
    requestIds[0] = requestId("mutated");
    contextDigests[0] = contextDigest(999);
    expect(action.receipt.effectId).toBe(effectId("mutable"));
    expect(action.receipt.requestIds[0]).toBe(requestId("1:1"));
    expect(action.receipt.contextDigests[0]).toBe(contextDigest(11));
  });

  it("rehydrates a legitimately registered batch after JSON round-trip with identity-only proofs", () => {
    const exact = roster(3);
    const selected = exact.orderedSlots.map((slot) => slot.attempts[0]);
    const original = valueOf(spawnBatchAction(
      rawBatchReceipt(selected),
      selected.map(rawSpawnRequest),
    ));
    const persistedRequests = JSON.parse(JSON.stringify(original.requests)) as unknown;
    const trustedPublication = registerPublication(original.receipt);
    expect(spawnBatchActionWithAuthority(
      trustedPublication as unknown as InitialPublicationIssuanceAuthority,
      original.requests,
    ).ok).toBe(false);

    if (false) {
      // @ts-expect-error Initial issuance requires fresh publication-reconciliation authority, not a serialized receipt.
      spawnBatchActionWithAuthority(original.receipt, selected.map(rawSpawnRequest));
      // @ts-expect-error Restart resolver authority is type-incompatible with initial issuance authority.
      spawnBatchActionWithAuthority(trustedPublication, selected.map(rawSpawnRequest));
      // @ts-expect-error Rehydration cannot omit its independently supplied resolver port.
      rehydrateIssuedSpawnRequests(persistedRequests);
      // @ts-expect-error Issued-request parsing cannot omit its independently supplied resolver port.
      parseIssuedSpawnRequestWithAuthority(persistedRequests);
    }

    for (const request of original.requests) {
      expect(Object.keys(request.issuance)).toEqual([
        "schemaVersion", "kind", "runId", "effectId", "publicationDigest", "batchIndex",
      ]);
      expect("receipt" in request.issuance).toBe(false);
    }

    // JSON parsing creates fresh identities; only the independent registration restores proof.
    const rehydrated = valueOf(rehydrateIssuedSpawnRequests(publicationResolver, persistedRequests));
    expect(rehydrated).toHaveLength(3);
    for (let index = 0; index < rehydrated.length; index++) {
      const request = rehydrated[index]!;
      expect(valueOf(parseIssuedSpawnRequest(
        JSON.parse(JSON.stringify(request)) as unknown,
      ))).toEqual(request);
      expect(valueOf(acceptedAgentResult(request, `replayed-${index + 1}`)).authority)
        .toEqual(selected[index]);
    }

    const missingProof = JSON.parse(JSON.stringify(rehydrated[0])) as Record<string, unknown>;
    delete missingProof.issuance;
    expect(parseIssuedSpawnRequest(missingProof).ok).toBe(false);
    expect(rehydrateIssuedSpawnRequests(publicationResolver, [missingProof]).ok).toBe(false);
    expect(acceptedAgentResult(missingProof as unknown as SpawnRequest, "missing proof").ok).toBe(false);

    const serializedAccepted = rehydrated.map((request, index) =>
      JSON.parse(JSON.stringify(valueOf(acceptedAgentResult(request, `replayed-${index + 1}`)))) as unknown
    );
    const complete = valueOf(parseCompleteRoster(exact, serializedAccepted, parseStringPayload));
    expect(complete.ordered.map(({ authority: request }) => request.requestId))
      .toEqual(selected.map(({ requestId: id }) => id));
    expect(complete.ordered.map(({ value }) => value))
      .toEqual(["replayed-1", "replayed-2", "replayed-3"]);
  });

  it("caches complete-roster registrations by authoritative run/effect lookup, not caller digest", () => {
    const exact = roster(2);
    const firstRequest = exact.orderedSlots[0]!.attempts[0];
    const secondRequest = exact.orderedSlots[1]!.attempts[0];
    const sharedEffect = effectId("complete-roster-stateful-lookup");
    const sharedRun = exact.runId;
    const firstReceipt = rawBatchReceiptForIdentity([firstRequest], sharedEffect, sharedRun);
    const secondReceipt = rawBatchReceiptForIdentity([secondRequest], sharedEffect, sharedRun);
    const firstAction = valueOf(spawnBatchActionWithAuthority(
      valueOf(reconcileTrustedInitialPublication(firstReceipt)),
      [rawSpawnRequest(firstRequest)],
    ));
    const secondAction = valueOf(spawnBatchActionWithAuthority(
      valueOf(reconcileTrustedInitialPublication(secondReceipt)),
      [rawSpawnRequest(secondRequest)],
    ));
    expect(firstAction.receipt.publicationDigest).not.toBe(secondAction.receipt.publicationDigest);

    const results = [
      JSON.parse(JSON.stringify(valueOf(acceptedAgentResult(firstAction.requests[0], "first")))) as unknown,
      JSON.parse(JSON.stringify(valueOf(acceptedAgentResult(secondAction.requests[0], "second")))) as unknown,
    ];
    let calls = 0;
    const statefulLoader: TrustedPublicationRegistrationLoader = () => {
      calls += 1;
      return {
        ok: true,
        value: encodeJson(calls === 1 ? firstAction.receipt : secondAction.receipt),
      };
    };

    const parsed = parseCompleteRosterWithAuthority(
      createPublicationAuthorityResolver(statefulLoader),
      exact,
      results,
      parseStringPayload,
    );
    expect(parsed.ok).toBe(false);
    expect(calls).toBe(1);
    if (!parsed.ok) {
      const unissued = parsed.error.violations.find(({ kind }) => kind === "unissued-result");
      expect(unissued?.kind).toBe("unissued-result");
      if (unissued?.kind === "unissued-result") {
        expect(unissued.requestId).toBe(secondRequest.requestId);
        expect(unissued.cause.kind).toBe("publication-identity-mismatch");
        expect(unissued.cause.message).toContain("frozen registration");
      }
    }
  });

  it("retains bounded resolver and issued-request causes in unissued-result violations", () => {
    const exact = roster(1);
    const request = exact.orderedSlots[0]!.attempts[0];
    const action = valueOf(spawnBatchAction(rawBatchReceipt([request]), [rawSpawnRequest(request)]));
    const accepted = JSON.parse(JSON.stringify(
      valueOf(acceptedAgentResult(action.requests[0], "payload")),
    )) as Record<string, unknown>;
    const hostile = "resolver-cause:" + "x".repeat(MAX_DIAGNOSTIC_MESSAGE_LENGTH * 2);
    const unavailable: PublicationAuthorityResolver = () => ({
      ok: false,
      error: { kind: "publication-authority-unavailable", message: hostile },
    });
    const resolverFailure = parseCompleteRosterWithAuthority(
      unavailable,
      exact,
      [accepted],
      parseStringPayload,
    );
    expect(resolverFailure.ok).toBe(false);
    if (!resolverFailure.ok) {
      const unissued = resolverFailure.error.violations.find(({ kind }) => kind === "unissued-result");
      expect(unissued?.kind).toBe("unissued-result");
      if (unissued?.kind === "unissued-result") {
        expect(unissued.cause.kind).toBe("publication-authority-resolution-failed");
        expect(unissued.cause.message).toContain("resolver-cause:");
        expect(unissued.cause.message).toHaveLength(MAX_DIAGNOSTIC_MESSAGE_LENGTH);
        expect(unissued.cause.message.endsWith("…[truncated]")).toBe(true);
      }
    }

    const tampered = JSON.parse(JSON.stringify(accepted)) as Record<string, unknown>;
    const issued = tampered.issuedRequest as Record<string, unknown>;
    issued.authority = {
      ...(issued.authority as Record<string, unknown>),
      outputSlot: "transcripts/tampered/issued.raw",
    };
    const issuedFailure = parseCompleteRoster(exact, [tampered], parseStringPayload);
    expect(issuedFailure.ok).toBe(false);
    if (!issuedFailure.ok) {
      const unissued = issuedFailure.error.violations.find(({ kind }) => kind === "unissued-result");
      expect(unissued?.kind).toBe("unissued-result");
      if (unissued?.kind === "unissued-result") {
        expect(unissued.cause.kind).toBe("issued-request-invalid");
        expect(unissued.cause.message).toContain("does not match registered");
      }
    }
  });

  it("uses one frozen trusted-loader snapshot for every request in a rehydrated batch", () => {
    const requests = [authority(31, 1), authority(32, 1), authority(33, 1)];
    const action = valueOf(spawnBatchAction(rawBatchReceipt(requests), requests.map(rawSpawnRequest)));
    const persisted = JSON.parse(JSON.stringify(action.requests)) as unknown;
    const validBytes = encodeJson(action.receipt);
    const divergent = JSON.parse(JSON.stringify(action.receipt)) as Record<string, unknown>;
    const issued = divergent.issuedRequests as Array<Record<string, unknown>>;
    issued[0]!.authority = {
      ...(issued[0]!.authority as Record<string, unknown>),
      outputSlot: "transcripts/stateful-loader/divergent.raw",
    };
    const divergentBytes = encodeJson(divergent);
    let calls = 0;
    const statefulLoader: TrustedPublicationRegistrationLoader = (lookup) => {
      calls += 1;
      expect(Object.getPrototypeOf(lookup)).toBeNull();
      expect(Object.isFrozen(lookup)).toBe(true);
      return { ok: true, value: calls === 1 ? validBytes : divergentBytes };
    };

    const restored = rehydrateIssuedSpawnRequests(
      createPublicationAuthorityResolver(statefulLoader),
      persisted,
    );
    expect(restored.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("fails closed for missing, foreign, divergent, and stale trusted registrations", () => {
    const requests = [authority(41, 1), authority(42, 1)];
    const action = valueOf(spawnBatchAction(rawBatchReceipt(requests), requests.map(rawSpawnRequest)));
    const persisted = JSON.parse(JSON.stringify(action.requests)) as Array<Record<string, unknown>>;
    const identity = publicationIdentity(action.receipt);

    const missing = createPublicationAuthorityResolver(() => ({
      ok: false,
      error: { kind: "publication-authority-unavailable", message: "registration missing" },
    }));
    expect(rehydrateIssuedSpawnRequests(missing, persisted).ok).toBe(false);

    const foreignRequest = authority(43, 1);
    const foreignReceipt = valueOf(parseBatchPublishedReceipt(rawBatchReceipt([foreignRequest])));
    const foreign = createPublicationAuthorityResolver(() => ({ ok: true, value: encodeJson(foreignReceipt) }));
    expect(rehydrateIssuedSpawnRequests(foreign, persisted).ok).toBe(false);

    const divergentReceipt = JSON.parse(JSON.stringify(action.receipt)) as Record<string, unknown>;
    const divergentIssued = divergentReceipt.issuedRequests as Array<Record<string, unknown>>;
    divergentIssued[0]!.authority = {
      ...(divergentIssued[0]!.authority as Record<string, unknown>),
      outputSlot: "transcripts/same-identity-divergent.raw",
    };
    const divergent = createPublicationAuthorityResolver(() => ({
      ok: true,
      value: encodeJson(divergentReceipt),
    }));
    expect(divergent(identity).ok).toBe(false);
    expect(rehydrateIssuedSpawnRequests(divergent, persisted).ok).toBe(false);

    const stale = JSON.parse(JSON.stringify(persisted)) as Array<Record<string, unknown>>;
    stale[0]!.issuance = {
      ...(stale[0]!.issuance as Record<string, unknown>),
      publicationDigest: artifactDigest(9_001),
    };
    const validRegistration = createPublicationAuthorityResolver(() => ({
      ok: true,
      value: encodeJson(action.receipt),
    }));
    expect(rehydrateIssuedSpawnRequests(validRegistration, stale).ok).toBe(false);
  });

  it("fails closed without registration and for forged proof, resolver, order, surplus, and every authority drift", () => {
    const authorities = [authority(1, 1), authority(2, 1)];
    const receipt = rawBatchReceipt(authorities);
    const action = valueOf(spawnBatchAction(receipt, authorities.map(rawSpawnRequest)));
    const persistedRequests = JSON.parse(JSON.stringify(action.requests)) as Array<Record<string, unknown>>;
    const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    const missingResolver: PublicationAuthorityResolver = () => ({
      ok: false,
      error: { kind: "publication-authority-unavailable", message: "registration missing" },
    });

    expect(rehydrateIssuedSpawnRequests(missingResolver, persistedRequests).ok).toBe(false);
    expect(rehydrateIssuedSpawnRequests(publicationResolver, persistedRequests.slice(1)).ok).toBe(false);
    expect(rehydrateIssuedSpawnRequests(
      publicationResolver,
      [...persistedRequests, roundTrip(persistedRequests[0]!)],
    ).ok).toBe(false);
    expect(rehydrateIssuedSpawnRequests(publicationResolver, [...persistedRequests].reverse()).ok).toBe(false);

    const bare = authorities.map(rawSpawnRequest);
    expect(rehydrateIssuedSpawnRequests(publicationResolver, bare).ok).toBe(false);

    const embeddedReceipt = roundTrip(persistedRequests);
    embeddedReceipt[0]!.issuance = {
      ...(embeddedReceipt[0]!.issuance as object),
      receipt: roundTrip(action.receipt),
    };
    expect(rehydrateIssuedSpawnRequests(publicationResolver, embeddedReceipt).ok).toBe(false);

    const trusted = registerPublication(receipt);
    const forgedResolver: PublicationAuthorityResolver = () => ({
      ok: true,
      value: { ...trusted } as RegisteredBatchPublicationAuthority,
    });
    expect(rehydrateIssuedSpawnRequests(forgedResolver, persistedRequests).ok).toBe(false);

    const foreignAuthority = authority(3, 1);
    const foreignRegistration = registerPublication(rawBatchReceipt([foreignAuthority]));
    const foreignResolver: PublicationAuthorityResolver = () => ({ ok: true, value: foreignRegistration });
    expect(rehydrateIssuedSpawnRequests(foreignResolver, persistedRequests).ok).toBe(false);

    const changedRegisteredRequest = valueOf(parseAgentRequestAuthority(rawAuthority(1, 1, {
      requestId: requestId("resolver-forgery"),
    })));
    const resolverForgeryReceipt = {
      ...receipt,
      requestIds: [changedRegisteredRequest.requestId, authorities[1]!.requestId],
      issuedRequests: [rawSpawnRequest(changedRegisteredRequest), rawSpawnRequest(authorities[1]!)],
    };
    const driftingResolver = createPublicationAuthorityResolver(() => ({
      ok: true,
      value: encodeJson(resolverForgeryReceipt),
    }));
    expect(rehydrateIssuedSpawnRequests(driftingResolver, persistedRequests).ok).toBe(false);

    const mutations: readonly Readonly<Record<string, unknown>>[] = [
      { runId: runId("wrong") },
      { requestId: requestId("wrong") },
      { slotId: slotId("wrong") },
      { program: "standalone-review" },
      {
        role: "security-agent",
        modelProfile: "focused-review",
        harnessBinding: focusedBindings,
        requiredSkill: "security-expert",
      },
      { outputSlot: "transcripts/forged/output.raw" },
      { attempt: 2 },
    ];
    for (const mutation of mutations) {
      const changed = roundTrip(persistedRequests);
      changed[0]!.authority = { ...(changed[0]!.authority as object), ...mutation };
      expect(rehydrateIssuedSpawnRequests(publicationResolver, changed).ok).toBe(false);
    }

    const wrongContext = roundTrip(persistedRequests);
    const changedContext = contextDigest(9_999);
    wrongContext[0]!.authority = { ...(wrongContext[0]!.authority as object), contextDigest: changedContext };
    wrongContext[0]!.context = { digest: changedContext, slot: `contexts/${changedContext}.json` };
    expect(rehydrateIssuedSpawnRequests(publicationResolver, wrongContext).ok).toBe(false);

    const staleIdentity = roundTrip(persistedRequests);
    staleIdentity[0]!.issuance = {
      ...(staleIdentity[0]!.issuance as object),
      publicationDigest: artifactDigest(901),
    };
    expect(rehydrateIssuedSpawnRequests(publicationResolver, staleIdentity).ok).toBe(false);
  });

  it("parses and freezes the actual await-user constructor", () => {
    const run = runId();
    const context = contextDigest(700);
    const raw = {
      kind: "advisory-triage",
      requestId: requestId("decision"),
      runId: run,
      context: { digest: context, slot: `contexts/${context}.json` },
      advisories: [artifact(run, 1)],
    };
    const action = valueOf(awaitUserAction(raw));
    expect(action.kind).toBe("await-user");
    expect(Object.isFrozen(action)).toBe(true);
    expect(Object.isFrozen(action.request)).toBe(true);
    expect(Object.isFrozen(action.request.advisories)).toBe(true);
    expect(awaitUserAction({ ...raw, advisories: [{ ...raw.advisories[0], byteLength: -1 }] }).ok).toBe(false);
    expect(awaitUserAction({ ...raw, advisories: [artifact(run, 1), artifact(run, 2, "artifacts/1.json")] }).ok).toBe(false);
    expect(awaitUserAction({ ...raw, advisories: [artifact(runId("foreign"), 1)] }).ok).toBe(false);
    expect(awaitUserAction({ ...raw, context: { ...raw.context, slot: "../context.json" } }).ok).toBe(false);
    expect(awaitUserAction(null).ok).toBe(false);
  });

  it("accepts done only with a parsed valid ArtifactRef for the same run", () => {
    const run = runId();
    expect(doneAction(run, artifact(run, 1)).ok).toBe(true);
    expect(doneAction(run, artifact(runId("other"), 1)).ok).toBe(false);
    expect(doneAction(run, { ...artifact(run, 1), slot: "../out.json" }).ok).toBe(false);
    expect(doneAction(run, { ...artifact(run, 1), byteLength: -1 }).ok).toBe(false);
    expect(doneAction(1n, artifact(run, 1)).ok).toBe(false);
  });

  it("exposes only the four external action tags", () => {
    const run = runId();
    const diagnostic = valueOf(terminalBlockedDiagnostic({ category: "invalid-authority", runId: run, message: "invalid" }));
    const done = valueOf(doneAction(run, artifact(run, 1)));
    const awaitUser = valueOf(awaitUserAction({
      kind: "advisory-triage",
      requestId: requestId("decision"),
      runId: run,
      context: { digest: contextDigest(700), slot: `contexts/${contextDigest(700)}.json` },
      advisories: [artifact(run, 2)],
    }));
    const spawn = valueOf(spawnBatchAction(rawBatchReceipt([authority(1, 1)]), [rawSpawnRequest(authority(1, 1))]));
    expect(new Set([valueOf(blockedAction(diagnostic)).kind, done.kind, awaitUser.kind, spawn.kind]))
      .toEqual(new Set(["spawn-batch", "await-user", "blocked", "done"]));
  });
});

function effectPairs(): readonly (readonly [EffectIntent, EffectReceipt])[] {
  const run = runId();
  const request = authority(1, 1);
  const path = Object.freeze({ relative: "src/a.ts", absolute: "/repo/src/a.ts" });
  return [
    [
      { kind: "publish-artifact-set", effectId: effectId("publish"), runId: run, artifacts: [artifact(run, 1)] },
      { kind: "artifact-set-published", effectId: effectId("publish"), runId: run, artifacts: [artifact(run, 1)] },
    ],
    [
      { kind: "commit-protected-wave-state", effectId: effectId("commit"), runId: run, expectedRevision: 4, stateDigest: artifactDigest(2) },
      { kind: "protected-wave-state-committed", effectId: effectId("commit"), runId: run, committedRevision: 5, stateDigest: artifactDigest(2) },
    ],
    [
      { kind: "reserve-agent-requests", effectId: effectId("reserve"), runId: run, requests: [request] },
      { kind: "agent-requests-reserved", effectId: effectId("reserve"), runId: run, requestIds: [request.requestId] },
    ],
    [
      { kind: "capture-raw-transcript", effectId: effectId("capture"), runId: run, request, bytes: [0, 1, 255] },
      {
        kind: "raw-transcript-captured",
        effectId: effectId("capture"),
        runId: run,
        requestId: request.requestId,
        artifact: artifact(run, 1, request.outputSlot.path, 3, valueOf(digestRawTranscriptBytes([0, 1, 255]))),
      },
    ],
    [
      { kind: "inspect-git-remediation", effectId: effectId("inspect"), runId: run, paths: [path] },
      { kind: "git-remediation-inspected", effectId: effectId("inspect"), runId: run, witnessDigest: artifactDigest(3), paths: [path] },
    ],
    [
      { kind: "install-verified-index", effectId: effectId("install"), runId: run, indexDigest: artifactDigest(4), witnessDigest: artifactDigest(5) },
      { kind: "verified-index-installed", effectId: effectId("install"), runId: run, indexDigest: artifactDigest(4), witnessDigest: artifactDigest(5) },
    ],
  ];
}

function expectReceiptField(
  intent: unknown,
  receipt: unknown,
  field: string,
): void {
  const result = reconcileEffectReceipt(intent, receipt);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.field).toBe(field);
}

describe("effect receipt reconciliation", () => {
  it("accepts only the receipt closing the exact effect kind, identity, and run", () => {
    const pairs = effectPairs();
    for (let index = 0; index < pairs.length; index++) {
      const [intent, receipt] = pairs[index]!;
      const reconciled = valueOf(reconcileEffectReceipt(intent, receipt));
      expect(Object.isFrozen(reconciled)).toBe(true);
      const wrongReceipt = pairs[(index + 1) % pairs.length]![1];
      expectReceiptField(intent, wrongReceipt, "receipt.effectId");
      expectReceiptField(intent, { ...receipt, effectId: effectId("foreign") }, "receipt.effectId");
      expectReceiptField(intent, { ...receipt, runId: runId("foreign") }, "receipt.runId");
    }
  });

  it("returns field-specific diagnostics for every matching receipt payload field", () => {
    const pairs = effectPairs();
    const [publishIntent, publishReceipt] = pairs[0]!;
    const publishArtifact = (publishReceipt as Extract<EffectReceipt, { kind: "artifact-set-published" }>).artifacts[0]!;
    expectReceiptField(
      publishIntent,
      { ...publishReceipt, artifacts: [publishArtifact, artifact(publishArtifact.runId, 88)] },
      "receipt.artifacts",
    );
    expectReceiptField(publishIntent, { ...publishReceipt, artifacts: [{ ...publishArtifact, runId: runId("foreign") }] }, "receipt.artifacts[0].runId");
    expectReceiptField(publishIntent, { ...publishReceipt, artifacts: [{ ...publishArtifact, slot: "other/file.json" }] }, "receipt.artifacts[0].slot");
    expectReceiptField(publishIntent, { ...publishReceipt, artifacts: [{ ...publishArtifact, digest: artifactDigest(999) }] }, "receipt.artifacts[0].digest");
    expectReceiptField(publishIntent, { ...publishReceipt, artifacts: [{ ...publishArtifact, byteLength: 99 }] }, "receipt.artifacts[0].byteLength");

    const [commitIntent, commitReceipt] = pairs[1]!;
    expectReceiptField(commitIntent, { ...commitReceipt, committedRevision: 6 }, "receipt.committedRevision");
    expectReceiptField(commitIntent, { ...commitReceipt, stateDigest: artifactDigest(999) }, "receipt.stateDigest");

    const [reserveIntent, reserveReceipt] = pairs[2]!;
    expectReceiptField(reserveIntent, { ...reserveReceipt, requestIds: [requestId("foreign"), requestId("surplus")] }, "receipt.requestIds");
    expectReceiptField(reserveIntent, { ...reserveReceipt, requestIds: [requestId("foreign")] }, "receipt.requestIds[0]");

    const [captureIntent, captureReceipt] = pairs[3]!;
    const captureArtifact = (captureReceipt as Extract<EffectReceipt, { kind: "raw-transcript-captured" }>).artifact;
    expectReceiptField(captureIntent, { ...captureReceipt, requestId: requestId("foreign") }, "receipt.requestId");
    expectReceiptField(captureIntent, { ...captureReceipt, artifact: { ...captureArtifact, runId: runId("foreign") } }, "receipt.artifact.runId");
    expectReceiptField(captureIntent, { ...captureReceipt, artifact: { ...captureArtifact, slot: "other/file.raw" } }, "receipt.artifact.slot");
    expectReceiptField(captureIntent, { ...captureReceipt, artifact: { ...captureArtifact, byteLength: 2 } }, "receipt.artifact.byteLength");
    expectReceiptField(captureIntent, { ...captureReceipt, artifact: { ...captureArtifact, digest: artifactDigest(999) } }, "receipt.artifact.digest");

    const [inspectIntent, inspectReceipt] = pairs[4]!;
    expectReceiptField(inspectIntent, { ...inspectReceipt, paths: [{ relative: "src/b.ts", absolute: "/repo/src/b.ts" }] }, "receipt.paths[0]");
    expectReceiptField(inspectIntent, { ...inspectReceipt, witnessDigest: "bad" }, "receipt.witnessDigest");

    const [installIntent, installReceipt] = pairs[5]!;
    expectReceiptField(installIntent, { ...installReceipt, indexDigest: artifactDigest(999) }, "receipt.indexDigest");
    expectReceiptField(installIntent, { ...installReceipt, witnessDigest: artifactDigest(999) }, "receipt.witnessDigest");

    expectReceiptField(publishIntent, {
      kind: "protected-wave-state-committed",
      effectId: publishIntent.effectId,
      runId: publishIntent.runId,
      committedRevision: 1,
      stateDigest: artifactDigest(1),
    }, "receipt.kind");
  });

  it("property-rejects conflicting and duplicate immutable artifact-slot assignments with both entries identified", () => {
    fc.assert(fc.property(
      fc.nat({ max: 10_000 }),
      fc.boolean(),
      (seed, changeDigest) => {
        const run = runId(`artifact-conflict-${seed}`);
        const path = `artifacts/conflict-${seed}.json`;
        const first = artifact(run, 1, path, seed, artifactDigest(seed + 1));
        const duplicate = artifact(
          run,
          2,
          path,
          changeDigest ? seed : seed + 1,
          changeDigest ? artifactDigest(seed + 2) : first.digest,
        );
        const intent = {
          kind: "publish-artifact-set",
          effectId: effectId(`artifact-conflict-${seed}`),
          runId: run,
          artifacts: [first, duplicate],
        };
        const receipt = {
          kind: "artifact-set-published",
          effectId: intent.effectId,
          runId: run,
          artifacts: [first, duplicate],
        };
        const rejected = reconcileEffectReceipt(intent, receipt);
        expect(rejected.ok).toBe(false);
        if (!rejected.ok) {
          expect(rejected.error.field).toBe("intent.artifacts[1].slot.path");
          expect(rejected.error.artifactSlotConflict).toEqual({
            path,
            first: { index: 0, artifact: first },
            duplicate: { index: 1, artifact: duplicate },
          });
          expect(Object.isFrozen(rejected.error.artifactSlotConflict)).toBe(true);
          expect(Object.isFrozen(rejected.error.artifactSlotConflict?.first)).toBe(true);
          expect(Object.isFrozen(rejected.error.artifactSlotConflict?.duplicate)).toBe(true);
        }
      },
    ));

    fc.assert(fc.property(fc.nat({ max: 10_000 }), (seed) => {
      const run = runId(`artifact-receipt-conflict-${seed}`);
      const first = artifact(run, 1, `artifacts/receipt-first-${seed}.json`, seed, artifactDigest(seed + 1));
      const second = artifact(run, 2, `artifacts/receipt-second-${seed}.json`, seed + 1, artifactDigest(seed + 2));
      const conflictingReceiptArtifact = artifact(
        run,
        3,
        first.slot.path,
        second.byteLength,
        second.digest,
      );
      const intent = {
        kind: "publish-artifact-set",
        effectId: effectId(`artifact-receipt-conflict-${seed}`),
        runId: run,
        artifacts: [first, second],
      };
      const receipt = {
        kind: "artifact-set-published",
        effectId: intent.effectId,
        runId: run,
        artifacts: [first, conflictingReceiptArtifact],
      };
      const rejected = reconcileEffectReceipt(intent, receipt);
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.error.field).toBe("receipt.artifacts[1].slot.path");
        expect(rejected.error.artifactSlotConflict).toEqual({
          path: first.slot.path,
          first: { index: 0, artifact: first },
          duplicate: { index: 1, artifact: conflictingReceiptArtifact },
        });
      }
    }));

    fc.assert(fc.property(fc.nat({ max: 10_000 }), (seed) => {
      const run = runId(`artifact-duplicate-${seed}`);
      const duplicate = artifact(run, 1, `artifacts/duplicate-${seed}.json`, seed, artifactDigest(seed + 1));
      const intent = {
        kind: "publish-artifact-set",
        effectId: effectId(`artifact-duplicate-${seed}`),
        runId: run,
        artifacts: [duplicate, duplicate],
      };
      const receipt = {
        kind: "artifact-set-published",
        effectId: intent.effectId,
        runId: run,
        artifacts: [duplicate, duplicate],
      };
      const rejected = reconcileEffectReceipt(intent, receipt);
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) {
        expect(rejected.error.field).toBe("intent.artifacts[1].slot.path");
        expect(rejected.error.artifactSlotConflict?.first.index).toBe(0);
        expect(rejected.error.artifactSlotConflict?.duplicate.index).toBe(1);
        expect(rejected.error.artifactSlotConflict?.first.artifact).toEqual(duplicate);
        expect(rejected.error.artifactSlotConflict?.duplicate.artifact).toEqual(duplicate);
      }
    }));
  });

  it("rejects invalid ArtifactRefs and malformed receipt payloads even when both sides match", () => {
    const run = runId();
    const invalidLengths = [-1, 1.5, Number.NaN, Infinity];
    for (const invalidLength of invalidLengths) {
      const rawArtifact = { runId: run, slot: "artifacts/a.json", digest: artifactDigest(1), byteLength: invalidLength };
      const intent = { kind: "publish-artifact-set", effectId: effectId("bad"), runId: run, artifacts: [rawArtifact] };
      const receipt = { kind: "artifact-set-published", effectId: effectId("bad"), runId: run, artifacts: [rawArtifact] };
      expectReceiptField(intent, receipt, "intent.artifacts[0].byteLength");
    }
    const traversal = { runId: run, slot: "../a.json", digest: artifactDigest(1), byteLength: 1 };
    expectReceiptField(
      { kind: "publish-artifact-set", effectId: effectId("path"), runId: run, artifacts: [traversal] },
      { kind: "artifact-set-published", effectId: effectId("path"), runId: run, artifacts: [traversal] },
      "intent.artifacts[0].slot",
    );
  });

  it("rejects internally inconsistent intents, duplicate requests, invalid bytes, and malformed actions", () => {
    const run = runId();
    const request = authority(1, 1);
    const foreignArtifact = artifact(runId("foreign"), 1);
    expectReceiptField(
      { kind: "publish-artifact-set", effectId: effectId("foreign-artifact"), runId: run, artifacts: [foreignArtifact] },
      { kind: "artifact-set-published", effectId: effectId("foreign-artifact"), runId: run, artifacts: [foreignArtifact] },
      "intent.artifacts.runId",
    );
    expectReceiptField(
      { kind: "reserve-agent-requests", effectId: effectId("duplicate"), runId: run, requests: [request, request] },
      { kind: "agent-requests-reserved", effectId: effectId("duplicate"), runId: run, requestIds: [request.requestId, request.requestId] },
      "intent.requests.requestId",
    );
    expectReceiptField(
      { kind: "capture-raw-transcript", effectId: effectId("bytes"), runId: run, request, bytes: [256] },
      effectPairs()[3]![1],
      "intent.bytes",
    );
    for (const malformed of [null, 1n, cyclicObject(), {}, { kind: "unknown", effectId: effectId("x"), runId: run }]) {
      expect(() => reconcileEffectReceipt(malformed, malformed)).not.toThrow();
      expect(reconcileEffectReceipt(malformed, malformed).ok).toBe(false);
    }
  });

  it("never resolves missing effect or receipt authority through Object.prototype pollution", () => {
    const [intent, receipt] = effectPairs()[0]!;
    withObjectPrototypePollution({ effectId: intent.effectId }, () => {
      const missingIntentEffectId = { ...intent } as Record<string, unknown>;
      const missingReceiptEffectId = { ...receipt } as Record<string, unknown>;
      delete missingIntentEffectId.effectId;
      delete missingReceiptEffectId.effectId;

      expectReceiptField(missingIntentEffectId, receipt, "intent.effectId");
      expectReceiptField(intent, missingReceiptEffectId, "receipt.effectId");
    });
  });

  it("rejects inherited, accessor, symbol, extra-field, throwing, and revoked effect variants", () => {
    let reads = 0;
    const accessorKind = (value: EffectIntent | EffectReceipt): Record<string, unknown> => {
      const copy = { ...value } as Record<string, unknown>;
      delete copy.kind;
      Object.defineProperty(copy, "kind", {
        enumerable: true,
        get: () => {
          reads += 1;
          throw new Error("effect accessor must not run");
        },
      });
      return copy;
    };

    for (const [intent, receipt] of effectPairs()) {
      const inheritedIntent = Object.create(intent) as unknown;
      const inheritedReceipt = Object.create(receipt) as unknown;
      const symbolIntent = { ...intent, [Symbol("hidden")]: true };
      const symbolReceipt = { ...receipt, [Symbol("hidden")]: true };
      const throwingIntent = new Proxy({ ...intent }, {
        ownKeys: () => { throw new Error("intent ownKeys trap"); },
      });
      const throwingReceipt = new Proxy({ ...receipt }, {
        ownKeys: () => { throw new Error("receipt ownKeys trap"); },
      });
      const revokedIntent = Proxy.revocable({ ...intent }, {});
      const revokedReceipt = Proxy.revocable({ ...receipt }, {});
      revokedIntent.revoke();
      revokedReceipt.revoke();

      for (const hostileIntent of [
        inheritedIntent,
        accessorKind(intent),
        symbolIntent,
        { ...intent, extra: true },
        throwingIntent,
        revokedIntent.proxy,
      ]) {
        expect(() => reconcileEffectReceipt(hostileIntent, receipt)).not.toThrow();
        const result = reconcileEffectReceipt(hostileIntent, receipt);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.field.startsWith("intent")).toBe(true);
      }
      for (const hostileReceipt of [
        inheritedReceipt,
        accessorKind(receipt),
        symbolReceipt,
        { ...receipt, extra: true },
        throwingReceipt,
        revokedReceipt.proxy,
      ]) {
        expect(() => reconcileEffectReceipt(intent, hostileReceipt)).not.toThrow();
        const result = reconcileEffectReceipt(intent, hostileReceipt);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.field.startsWith("receipt")).toBe(true);
      }
    }
    expect(reads).toBe(0);
  });

  it("returns a canonical deep-frozen receipt rather than caller-owned payload", () => {
    const [intent, receipt] = effectPairs()[0]!;
    const mutableArtifacts = [...(receipt as Extract<EffectReceipt, { kind: "artifact-set-published" }>).artifacts];
    const mutable = { ...receipt, artifacts: mutableArtifacts };
    const canonical = valueOf(reconcileEffectReceipt(intent, mutable));
    expect(canonical).not.toBe(mutable);
    if (canonical.kind === "artifact-set-published") {
      expect(canonical.artifacts).not.toBe(mutableArtifacts);
      expect(Object.isFrozen(canonical.artifacts)).toBe(true);
      expect(Object.isFrozen(canonical.artifacts[0])).toBe(true);
      mutableArtifacts[0] = artifact(runId("foreign"), 9);
      expect(canonical.artifacts[0]!.runId).toBe(runId());
    }
  });
});

describe("canonical null-prototype records", () => {
  it("does not expose Object.prototype pollution through exported authority and ADT values", () => {
    withObjectPrototypePollution({ pollutedAuthority: "inherited", kind: "forged-kind" }, () => {
      const exact = roster(1);
      const requestAuthority = exact.orderedSlots[0]!.attempts[0];
      const action = valueOf(spawnBatchAction(
        rawBatchReceipt([requestAuthority]),
        [rawSpawnRequest(requestAuthority)],
      ));
      const registeredPublication = registerPublication(action.receipt);
      const accepted = valueOf(acceptedAgentResult(action.requests[0], "safe"));
      const complete = valueOf(parseCompleteRoster(exact, [accepted], parseStringPayload));
      const diagnostic = valueOf(infrastructureRetryDiagnostic({
        category: "infrastructure-failure",
        runId: runId(),
        effectId: effectId("null-prototype"),
        message: "publication failed",
      }));
      const blocked = valueOf(blockedAction(diagnostic));
      const done = valueOf(doneAction(runId(), artifact(runId(), 1)));
      const [intent, rawReceipt] = effectPairs()[0]!;
      const effectReceipt = valueOf(reconcileEffectReceipt(intent, rawReceipt));

      const records: readonly object[] = [
        requestAuthority,
        requestAuthority.harnessBinding,
        requestAuthority.harnessBinding.pi,
        requestAuthority.outputSlot,
        exact,
        registeredPublication,
        registeredPublication.identity,
        action,
        action.publicationIdentity,
        action.idempotencyKey,
        action.receipt,
        action.receipt.issuedRequests[0]!,
        action.requests[0],
        action.requests[0].issuance,
        accepted,
        complete,
        diagnostic,
        diagnostic.retry,
        diagnostic.recovery,
        blocked,
        done,
        effectReceipt,
      ];
      for (const record of records) {
        expect(Object.getPrototypeOf(record)).toBeNull();
        expect(Object.isFrozen(record)).toBe(true);
        expect(Object.keys(record)).not.toContain("pollutedAuthority");
        expect("pollutedAuthority" in record).toBe(false);
        const serialized = JSON.stringify(record);
        expect(serialized).not.toContain("pollutedAuthority");
        expect(JSON.parse(serialized)).toEqual(JSON.parse(JSON.stringify(record)));
      }

      expect(action.kind).toBe("spawn-batch");
      expect(registeredPublication.kind).toBe("registered-batch-publication-authority");
      expect(registeredPublication.identity.kind).toBe("batch-publication-identity");
      expect(action.receipt.kind).toBe("batch-published");
      expect(action.requests[0].issuance.kind).toBe("issued-spawn-request-proof");
      expect(accepted.kind).toBe("accepted-agent-result");
      expect(diagnostic.kind).toBe("effect-blocked");
      expect(blocked.kind).toBe("blocked");
      expect(done.kind).toBe("done");
      expect(effectReceipt.kind).toBe("artifact-set-published");
      expect(Object.keys(action)).toEqual([
        "kind", "runId", "publicationIdentity", "idempotencyKey", "receipt", "requests",
      ]);
      expect(Object.keys(action.requests[0])).toEqual(["authority", "context", "issuance"]);
    });
  });
});

describe("retry diagnostics", () => {
  it("distinguishes semantic retry consumption from infrastructure retry", () => {
    const run = runId();
    const slot = rosterSlot(1);
    const semantic = valueOf(semanticRetryDiagnostic({
      category: "malformed-result",
      failedRequest: slot.attempts[0],
      retryRequest: slot.attempts[1],
      message: "result is malformed",
    }));
    const infrastructure = valueOf(infrastructureRetryDiagnostic({
      category: "partial-publication",
      runId: run,
      effectId: effectId("publish"),
      message: "publication was interrupted",
    }));
    expect(semantic.requestId).not.toBe(semantic.recovery.requestId);
    expect(semantic.retry).toEqual({ kind: "semantic-attempt", eligible: true, attempt: 2 });
    expect(semantic.recovery).toEqual({
      kind: "retry-request",
      requestId: slot.attempts[1].requestId,
      slotId: slot.slotId,
      attempt: 2,
    });
    expect(infrastructure.retry).toEqual({
      kind: "infrastructure",
      eligible: true,
      consumesSemanticAttempt: false,
    });
    expect(infrastructure.recovery).toEqual({ kind: "retry-effect", effectId: effectId("publish") });
  });

  it("derives semantic identities only from the parsed canonical attempt pair", () => {
    const failed = { ...rawAuthority(1, 1) };
    const retry = { ...rawAuthority(1, 2) };
    const diagnostic = valueOf(semanticRetryDiagnostic({
      category: "missing-result",
      failedRequest: failed as unknown as AgentRequestAuthority<1>,
      retryRequest: retry as unknown as AgentRequestAuthority<2>,
      message: "result was not captured",
    }));
    expect(diagnostic.runId).toBe(runId());
    expect(diagnostic.requestId).toBe(requestId("1:1"));
    expect(diagnostic.recovery.requestId).toBe(requestId("1:2"));
    expect(diagnostic.slotId).toBe(slotId("1"));
    expect(diagnostic.attemptPair).toMatchObject({
      schemaVersion: 1,
      kind: "semantic-attempt-pair-authority",
      attempt1: { requestId: requestId("1:1"), attempt: 1 },
      attempt2: { requestId: requestId("1:2"), attempt: 2 },
    });
    expect(Object.isFrozen(diagnostic.attemptPair)).toBe(true);

    failed.runId = runId("mutated");
    failed.requestId = requestId("mutated");
    retry.requestId = requestId("mutated-retry");
    expect(diagnostic.runId).toBe(runId());
    expect(diagnostic.requestId).toBe(requestId("1:1"));
    expect(diagnostic.recovery.requestId).toBe(requestId("1:2"));
  });

  it("cannot derive recovery from a mutated retry-request authority", () => {
    const retryRequest = { ...rawAuthority(1, 2) };
    retryRequest.requiredSkill = "wrong";

    const rejected = semanticRetryDiagnostic({
      category: "malformed-result",
      failedRequest: rawAuthority(1, 1) as unknown as AgentRequestAuthority<1>,
      retryRequest: retryRequest as unknown as AgentRequestAuthority<2>,
      message: "result violates the output contract",
    });

    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.error.field).toBe("requests");
      const malformedRetry = rejected.error.rosterViolations?.find(
        (violation) => violation.kind === "malformed-attempt-authority" && violation.attempt === 2,
      );
      expect(malformedRetry?.kind).toBe("malformed-attempt-authority");
      if (malformedRetry?.kind === "malformed-attempt-authority") {
        expect(malformedRetry.authorityViolations.some(({ field }) => field === "requiredSkill")).toBe(true);
      }
    }
  });

  it("preserves generated authority inspection causes in semantic retry diagnostics", () => {
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 80 }), (trapMessage) => {
      const failedRequest = new Proxy({ ...rawAuthority(1, 1) }, {
        ownKeys: () => { throw new Error(trapMessage); },
      });
      const result = semanticRetryDiagnostic({
        category: "malformed-result",
        failedRequest: failedRequest as unknown as AgentRequestAuthority<1>,
        retryRequest: authority(1, 2) as AgentRequestAuthority<2>,
        message: "result violates the output contract",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toContain(trapMessage);
    }));
  });

  it("never evaluates semantic input accessors and preserves nested roster violations", () => {
    let reads = 0;
    const accessorInput = {
      failedRequest: authority(1, 1),
      retryRequest: authority(1, 2),
      message: "actionable",
    } as Record<string, unknown>;
    Object.defineProperty(accessorInput, "category", {
      enumerable: true,
      get: () => {
        reads += 1;
        throw new Error("must not execute");
      },
    });
    expect(() => semanticRetryDiagnostic(accessorInput as unknown as Parameters<typeof semanticRetryDiagnostic>[0])).not.toThrow();
    expect(semanticRetryDiagnostic(accessorInput as unknown as Parameters<typeof semanticRetryDiagnostic>[0]).ok).toBe(false);
    expect(reads).toBe(0);

    const invalid = semanticRetryDiagnostic({
      category: "malformed-result",
      failedRequest: rawAuthority(1, 1, { requiredSkill: "wrong" }) as unknown as AgentRequestAuthority<1>,
      retryRequest: rawAuthority(1, 2) as unknown as AgentRequestAuthority<2>,
      message: "result violates the output contract",
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.error.message).toContain("requiredSkill");
      expect(invalid.error.rosterViolations).toBeDefined();
      const malformed = invalid.error.rosterViolations?.find(({ kind }) => kind === "malformed-attempt-authority");
      expect(malformed?.kind).toBe("malformed-attempt-authority");
      if (malformed?.kind === "malformed-attempt-authority") {
        expect(malformed.authorityViolations.some(({ field }) => field === "requiredSkill")).toBe(true);
      }
    }
  });

  it("requires a distinct attempt-2 recovery request and exact blocked slot authority", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 100 }), (slotNumber) => {
      const slot = rosterSlot(slotNumber);
      const canonical = valueOf(semanticRetryDiagnostic({
        category: "missing-result",
        failedRequest: slot.attempts[0],
        retryRequest: slot.attempts[1],
        message: "attempt 1 result was not captured",
      }));
      const sameRequest = parseBlockedDiagnostic({
        ...canonical,
        recovery: { ...canonical.recovery, requestId: canonical.requestId },
      });
      expect(sameRequest.ok).toBe(false);
      if (!sameRequest.ok) expect(sameRequest.error.field).toBe("recovery.requestId");

      const neverIssued = parseBlockedDiagnostic({
        ...canonical,
        recovery: { ...canonical.recovery, requestId: requestId(`never-issued-${slotNumber}`) },
      });
      expect(neverIssued.ok).toBe(false);
      if (!neverIssued.ok) {
        expect(neverIssued.error.field).toBe("recovery.requestId");
        expect(neverIssued.error.message).toContain("exact canonical engine-issued attempt-2 request");
      }

      const wrongSlot = parseBlockedDiagnostic({
        ...canonical,
        recovery: { ...canonical.recovery, slotId: slotId(`foreign-${slotNumber}`) },
      });
      expect(wrongSlot.ok).toBe(false);
      if (!wrongSlot.ok) expect(wrongSlot.error.field).toBe("recovery.slotId");

      const serialized = JSON.parse(JSON.stringify(canonical)) as unknown;
      const replayed = valueOf(blockedAction(serialized));
      expect(replayed.diagnostic).toEqual(canonical);
      expect(Object.isFrozen(replayed.diagnostic)).toBe(true);
      if (replayed.diagnostic.kind === "request-blocked") {
        expect(replayed.diagnostic.attemptPair.schemaVersion).toBe(1);
        expect(Object.isFrozen(replayed.diagnostic.attemptPair)).toBe(true);
      }

      const reparsed = valueOf(parseBlockedDiagnostic(canonical));
      expect(reparsed.kind).toBe("request-blocked");
      if (reparsed.kind === "request-blocked") {
        expect(reparsed.requestId).toBe(slot.attempts[0].requestId);
        expect(reparsed.slotId).toBe(slot.slotId);
        expect(reparsed.recovery.requestId).toBe(slot.attempts[1].requestId);
        expect(reparsed.recovery.slotId).toBe(slot.slotId);
      }
    }));
  });

  it("terminal diagnostics do not resolve request authority through Object.prototype pollution", () => {
    const blockedRequestId = requestId("duplicate");
    const canonical = valueOf(terminalBlockedDiagnostic({
      category: "duplicate-result",
      runId: runId(),
      requestId: blockedRequestId,
      slotId: slotId("duplicate"),
      message: "duplicate result cannot be accepted",
    }));
    withObjectPrototypePollution({ requestId: blockedRequestId }, () => {
      const missingRequestId = { ...canonical } as Record<string, unknown>;
      delete missingRequestId.requestId;
      const parsed = parseBlockedDiagnostic(missingRequestId);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.field).toBe("requestId");
    });
  });

  it("terminally blocks each exhausted attempt-2 result category with canonical attribution", () => {
    const attemptPair = rosterSlot(3);
    const initialRetry = valueOf(semanticRetryDiagnostic({
      category: "missing-result",
      failedRequest: attemptPair.attempts[0],
      retryRequest: attemptPair.attempts[1],
      message: "attempt 1 result was not captured",
    }));
    const failed = { ...attemptPair.attempts[1] };
    expect(initialRetry.recovery.requestId).toBe(failed.requestId);
    expect(initialRetry.recovery.slotId).toBe(failed.slotId);
    for (const category of ["missing-result", "malformed-result", "result-binding-mismatch"] as const) {
      const diagnostic = valueOf(terminalBlockedDiagnostic({
        category,
        failedRequest: failed as unknown as AgentRequestAuthority<2>,
        message: `attempt 2 cannot recover from ${category}`,
      }));
      expect(diagnostic).toMatchObject({
        kind: "terminal-blocked",
        category,
        runId: runId(),
        requestId: requestId("3:2"),
        slotId: slotId("3"),
        attempt: 2,
        message: `attempt 2 cannot recover from ${category}`,
        retry: { kind: "not-retryable", eligible: false },
        recovery: { kind: "inspect-run-and-stop" },
      });
      const action = valueOf(blockedAction(diagnostic));
      expect(action.runId).toBe(runId());
      expect(action.diagnostic).toEqual(diagnostic);
    }

    failed.runId = runId("mutated");
    failed.requestId = requestId("mutated");
    const initialAttempt = terminalBlockedDiagnostic({
      category: "missing-result",
      failedRequest: rawAuthority(3, 1) as unknown as AgentRequestAuthority<2>,
      message: "attempt 1 still has a retry",
    });
    expect(initialAttempt.ok).toBe(false);
    if (!initialAttempt.ok) expect(initialAttempt.error.field).toBe("failedRequest");
  });

  it("deterministically bounds hostile multi-megabyte diagnostic and Error messages", () => {
    const hostile = "hostile-cause:" + "x".repeat(3 * 1_024 * 1_024);
    const trappedAuthority = new Proxy({ ...rawAuthority(1, 1) }, {
      ownKeys: () => { throw new Error(hostile); },
    });
    const trapped = parseAgentRequestAuthority(trappedAuthority);
    expect(trapped.ok).toBe(false);
    if (!trapped.ok) {
      const message = trapped.error.violations[0].message;
      expect(message).toHaveLength(MAX_DIAGNOSTIC_MESSAGE_LENGTH);
      expect(message.endsWith("…[truncated]")).toBe(true);
      expect(parseAgentRequestAuthority(trappedAuthority)).toEqual(trapped);
    }

    const durableRequest = JSON.parse(JSON.stringify(issuedRequest(authority(1, 1)))) as unknown;
    const throwingResolver: PublicationAuthorityResolver = () => { throw new Error(hostile); };
    const resolverFailure = parseIssuedSpawnRequestWithAuthority(throwingResolver, durableRequest);
    expect(resolverFailure.ok).toBe(false);
    if (!resolverFailure.ok) {
      expect(resolverFailure.error.message).toHaveLength(MAX_DIAGNOSTIC_MESSAGE_LENGTH);
      expect(resolverFailure.error.message.endsWith("…[truncated]")).toBe(true);
      expect(parseIssuedSpawnRequestWithAuthority(throwingResolver, durableRequest)).toEqual(resolverFailure);
    }

    const pair = rosterSlot(1);
    const messages = [
      valueOf(semanticRetryDiagnostic({
        category: "malformed-result",
        failedRequest: pair.attempts[0],
        retryRequest: pair.attempts[1],
        message: hostile,
      })).message,
      valueOf(infrastructureRetryDiagnostic({
        category: "infrastructure-failure",
        runId: runId(),
        effectId: effectId("bounded-message"),
        message: hostile,
      })).message,
      valueOf(terminalBlockedDiagnostic({
        category: "invalid-authority",
        runId: runId(),
        message: hostile,
      })).message,
    ];
    for (const message of messages) {
      expect(message).toHaveLength(MAX_DIAGNOSTIC_MESSAGE_LENGTH);
      expect(message.endsWith("…[truncated]")).toBe(true);
    }
  });

  it("requires non-empty trimmed messages for every diagnostic family", () => {
    const slot = rosterSlot(1);
    for (const message of ["", "   ", " leading", "trailing "]) {
      expect(semanticRetryDiagnostic({
        category: "malformed-result",
        failedRequest: slot.attempts[0],
        retryRequest: slot.attempts[1],
        message,
      }).ok).toBe(false);
      expect(infrastructureRetryDiagnostic({
        category: "infrastructure-failure",
        runId: runId(),
        effectId: effectId("infra"),
        message,
      }).ok).toBe(false);
      expect(terminalBlockedDiagnostic({
        category: "invalid-authority",
        runId: runId(),
        message,
      }).ok).toBe(false);
    }
  });

  it("rejects unknown diagnostic fields and constructs exact canonical variants", () => {
    const infrastructureInput = {
      category: "infrastructure-failure",
      runId: runId(),
      effectId: effectId("infra"),
      message: "filesystem operation failed",
    } as const;
    const infrastructure = valueOf(infrastructureRetryDiagnostic(infrastructureInput));
    expect(infrastructure).not.toBe(infrastructureInput);
    expect(Object.keys(infrastructure)).toEqual([
      "kind", "category", "runId", "effectId", "message", "retry", "recovery",
    ]);
    expect(infrastructureRetryDiagnostic({ ...infrastructureInput, leaked: true } as typeof infrastructureInput).ok).toBe(false);

    const terminalInput = {
      category: "duplicate-result",
      runId: runId(),
      requestId: requestId("duplicate"),
      slotId: slotId("1"),
      message: "a second result targeted an accepted slot",
    } as const;
    const terminal = valueOf(terminalBlockedDiagnostic(terminalInput));
    expect(terminal).not.toBe(terminalInput);
    expect(Object.keys(terminal)).toEqual([
      "kind", "category", "runId", "requestId", "slotId", "message", "retry", "recovery",
    ]);
    expect(terminalBlockedDiagnostic({ ...terminalInput, leaked: true } as typeof terminalInput).ok).toBe(false);
    expect(terminalBlockedDiagnostic({
      category: "invalid-authority",
      runId: runId(),
      requestId: requestId("not-allowed"),
      slotId: slotId("not-allowed"),
      message: "authority is invalid",
    } as unknown as Parameters<typeof terminalBlockedDiagnostic>[0]).ok).toBe(false);
  });

  it("parses and deep-freezes blocked diagnostics without retaining nested recovery data", () => {
    const canonical = valueOf(infrastructureRetryDiagnostic({
      category: "partial-publication",
      runId: runId(),
      effectId: effectId("publish"),
      message: "publication stopped before the commit marker",
    }));
    const retry = { ...canonical.retry };
    const recovery = { ...canonical.recovery };
    const callerOwned = { ...canonical, retry, recovery };
    const action = valueOf(blockedAction(callerOwned));

    expect(action.diagnostic).not.toBe(callerOwned);
    expect(action.diagnostic.retry).not.toBe(retry);
    expect(action.diagnostic.recovery).not.toBe(recovery);
    expect(Object.isFrozen(action)).toBe(true);
    expect(Object.isFrozen(action.diagnostic)).toBe(true);
    expect(Object.isFrozen(action.diagnostic.retry)).toBe(true);
    expect(Object.isFrozen(action.diagnostic.recovery)).toBe(true);

    recovery.effectId = effectId("mutated");
    expect(action.diagnostic.kind).toBe("effect-blocked");
    if (action.diagnostic.kind === "effect-blocked") {
      expect(action.diagnostic.recovery.effectId).toBe(effectId("publish"));
    }
  });

  it("rejects a nested blocked-action hidden field independently of every identity mismatch", () => {
    const canonical = valueOf(infrastructureRetryDiagnostic({
      category: "partial-publication",
      runId: runId(),
      effectId: effectId("hidden-field"),
      message: "publication stopped before the commit marker",
    }));
    const hiddenField = blockedAction({
      ...canonical,
      recovery: { ...canonical.recovery, hidden: true },
    });
    expect(hiddenField.ok).toBe(false);
    if (!hiddenField.ok) {
      expect(hiddenField.error.field).toBe("diagnostic.recovery.hidden");
      expect(hiddenField.error.message).toContain("unknown field(s): hidden");
    }
  });
});

// ---------------------------------------------------------------------------
// Round-33: every terminal-blocked category, not only the five in use
// ---------------------------------------------------------------------------

/**
 * `TerminalBlockedDiagnostic` carries eleven categories, and which one a caller
 * passes decides which fields the constructor demands: run-scoped categories
 * take a runId, request-scoped ones additionally require a requestId and slotId,
 * and the exhausted-result ones require a complete attempt-2 authority instead.
 * Only five were ever constructed in a test, so moving a category between those
 * groups — silently widening or narrowing what a blocked diagnostic must prove —
 * changed no assertion.
 */
describe("terminal blocked diagnostics cover every declared category", () => {
  const RUN_SCOPED = ["invalid-authority", "roster-invalid"] as const;
  const REQUEST_SCOPED = [
    "duplicate-result", "stale-request", "surplus-result",
    "context-drift", "model-mismatch", "skill-mismatch",
  ] as const;
  const EXHAUSTED = ["missing-result", "malformed-result", "result-binding-mismatch"] as const;

  it.each(RUN_SCOPED)("constructs the run-scoped category %s from a runId alone", (category) => {
    const run = runId();
    const diagnostic = valueOf(terminalBlockedDiagnostic({ category, runId: run, message: `${category} occurred` }));
    expect(diagnostic).toMatchObject({
      kind: "terminal-blocked",
      category,
      runId: run,
      retry: { kind: "not-retryable", eligible: false },
      recovery: { kind: "inspect-run-and-stop" },
    });
    expect(diagnostic).not.toHaveProperty("requestId");
    expect(diagnostic).not.toHaveProperty("slotId");
  });

  it.each(RUN_SCOPED)("refuses request fields on the run-scoped category %s", (category) => {
    expect(terminalBlockedDiagnostic({
      category, runId: runId(), requestId: requestId("r"), slotId: slotId("s"), message: "extra fields",
    } as never).ok).toBe(false);
  });

  it.each(REQUEST_SCOPED)("constructs the request-scoped category %s with its request identity", (category) => {
    const run = runId();
    const diagnostic = valueOf(terminalBlockedDiagnostic({
      category, runId: run, requestId: requestId(category), slotId: slotId(category), message: `${category} occurred`,
    }));
    expect(diagnostic).toMatchObject({
      kind: "terminal-blocked",
      category,
      runId: run,
      requestId: requestId(category),
      slotId: slotId(category),
      retry: { kind: "not-retryable", eligible: false },
    });
  });

  it.each(REQUEST_SCOPED)("refuses the request-scoped category %s when its request identity is missing", (category) => {
    expect(terminalBlockedDiagnostic({ category, runId: runId(), message: "no request identity" } as never).ok).toBe(false);
  });

  it.each(EXHAUSTED)("constructs the exhausted-result category %s from a complete attempt-2 authority", (category) => {
    const failedRequest = authority(1, 2);
    const diagnostic = valueOf(terminalBlockedDiagnostic({
      category, failedRequest, message: `${category} occurred`,
    } as never));
    expect(diagnostic).toMatchObject({
      kind: "terminal-blocked",
      category,
      runId: failedRequest.runId,
      requestId: failedRequest.requestId,
      slotId: failedRequest.slotId,
      attempt: 2,
    });
  });

  it.each(EXHAUSTED)("refuses the exhausted-result category %s on a first-attempt authority", (category) => {
    expect(terminalBlockedDiagnostic({ category, failedRequest: authority(1, 1), message: "attempt one" } as never).ok)
      .toBe(false);
  });

  it("refuses a category outside the declared set", () => {
    expect(terminalBlockedDiagnostic({ category: "not-a-category", runId: runId(), message: "nope" } as never).ok)
      .toBe(false);
  });

  it("covers all eleven declared categories between the three groups", () => {
    expect(new Set([...RUN_SCOPED, ...REQUEST_SCOPED, ...EXHAUSTED]).size).toBe(11);
  });
});
