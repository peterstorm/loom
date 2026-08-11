import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildStandaloneFindingBrief } from "../../src/core/review-panel";
import {
  auditRemediationPaths,
  compareExactPathSets,
  createStandaloneResultPublicationAuthorityResolver,
  freezePathAuthority,
  parseAuditedPathSet as parseAuditedPathSetWithAuthority,
  parseCanonicalRepositoryRelativePath,
  parseDirtyPathObservation,
  parseFixedGitPathspecContract,
  parseRemediationPathAuthority as parseRemediationPathAuthorityWithAuthority,
  parseRemediationPathSet,
  parseRemediationState as parseRemediationStateWithAuthority,
  parseRepositorySnapshotWitness,
  parseStagedTemporaryIndex as parseStagedTemporaryIndexWithAuthority,
  parseVerifiedIndexInstallation as parseVerifiedIndexInstallationWithAuthority,
  parseVerifiedTemporaryIndex as parseVerifiedTemporaryIndexWithAuthority,
  prepareLiteralGitPathspec,
  prepareVerifiedIndexInstallation,
  recoveryReceiptFor,
  reduceRemediation,
  registerSupportPath,
  stageTemporaryIndex,
  startRemediation,
  verifyTemporaryIndex,
  type AuditedPathSet,
  type FrozenPathAuthority,
  type RegisteredPathAuthority,
  type RemediationEvent,
  type RemediationState,
  type RepositorySnapshotWitness,
  type StagedTemporaryIndex,
  type StandaloneResultPublicationAuthorityResolver,
  type VerifiedIndexInstallation,
  type VerifiedTemporaryIndex,
} from "../../src/core/remediation-machine";
import {
  acceptedAgentResult,
  createAtomicInitialPublicationClaimPort,
  createInitialBatchPublicationReconciler,
  createInitialPublicationEffectPort,
  createPublicationAuthorityResolver,
  parseArtifactRef,
  prepareInitialBatchPublicationIntent,
  spawnBatchAction,
  type AgentRequestAuthority,
  type ArtifactSetPublished,
  type BatchPublishedReceipt,
  type DomainResult,
  type SpawnRequest,
} from "../../src/core/orchestration-contract";
import {
  aggregateStandaloneReview,
  capturedReviewerResultFromText,
  prepareStandaloneReview,
  proveStandaloneRosterCompletion,
  serializeAdjudicatedStandaloneReview,
  type FrozenStandalonePanelAuthority,
  type FrozenStandaloneReviewAuthority,
  type StandaloneReviewAggregate,
} from "../../src/core/standalone-review";
import {
  freezeStandaloneRefutationPanelAuthority,
  parseAuthoritativeStandaloneReviewResult,
  parseStandaloneRefutationCompletion,
  reduceStandaloneReviewMachine,
  startStandaloneReviewMachine,
  type AuthoritativeStandaloneReviewResult,
  type StandaloneRefutationCompletionReceipt,
} from "../../src/core/standalone-review-machine";
import {
  completePersistentRefutationPanel,
  panelRequestIdentity,
  parseRefutationPanelAuthority,
  startPersistentRefutationPanel,
  submitRefutationVerdict,
  type RefutationPanelAuthority,
} from "../../src/core/panel-program";

type AnyResult<T> = DomainResult<T, unknown>;

function valueOf<T>(result: AnyResult<T>): T {
  expect(result.ok, `DomainResult payload: ${JSON.stringify(result)}`).toBe(true);
  if (!result.ok) throw new Error(`expected successful domain construction: ${JSON.stringify(result.error)}`);
  return result.value;
}

const digest = (n: number): string => n.toString(16).padStart(64, "0").slice(-64);
const jsonRoundTrip = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));

const reviewerBindings = {
  "code-reviewer": {
    profile: "general-review",
    pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
    claude: { harness: "claude-code", model: "sonnet" },
  },
  "type-design-analyzer": {
    profile: "focused-review",
    pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.5", thinking: "high" },
    claude: { harness: "claude-code", model: "sonnet" },
  },
} as const;

function rawStandaloneAuthority(role: keyof typeof reviewerBindings, slot: number, attempt: 1 | 2) {
  const binding = reviewerBindings[role];
  return {
    runId: "run.remediation-1",
    requestId: `request:remediation:${slot}:${attempt}`,
    slotId: `slot:remediation:${slot}`,
    program: "standalone-review",
    role,
    attempt,
    modelProfile: binding.profile,
    harnessBinding: { pi: binding.pi, claude: binding.claude },
    requiredSkill: null,
    contextDigest: (slot * 10 + attempt).toString(16).padStart(64, "0"),
    outputSlot: `transcripts/remediation-${slot}/attempt-${attempt}.raw`,
  };
}

function rawStandaloneRoster() {
  return (["code-reviewer", "type-design-analyzer"] as const).map((role, index) => ({
    slotId: `slot:remediation:${index + 1}`,
    attempts: ([1, 2] as const).map((attempt) => rawStandaloneAuthority(role, index + 1, attempt)),
  }));
}

const cleanTranscript = [
  "### Machine Summary",
  "CRITICAL_COUNT: 0",
  "ADVISORY_COUNT: 0",
  "",
  "```findings",
  "[]",
  "```",
].join("\n");

const criticalTranscript = [
  "### Machine Summary",
  "CRITICAL_COUNT: 1",
  "ADVISORY_COUNT: 0",
  "CRITICAL: remediation must retain this authoritative blocker",
  "",
  "```findings",
  JSON.stringify([{
    severity: "critical",
    file: "src/main.ts",
    line: 1,
    claim: "remediation must retain this authoritative blocker",
  }]),
  "```",
].join("\n");

function rawRequest(request: AgentRequestAuthority) {
  return {
    authority: request,
    context: { digest: request.contextDigest, slot: `contexts/${request.contextDigest}.json` },
  };
}

function upholdStandaloneCriticals(
  standaloneAuthority: FrozenStandaloneReviewAuthority,
  aggregate: StandaloneReviewAggregate,
): Readonly<{
  frozen: FrozenStandalonePanelAuthority;
  authority: RefutationPanelAuthority;
  completion: StandaloneRefutationCompletionReceipt;
}> {
  const panelRunId = "run.remediation-refutation-1";
  const lenses = ["reproduction", "intent"] as const;
  const binding = {
    profile: "refutation",
    pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
    claude: { harness: "claude-code", model: "opus" },
  } as const;
  const verifierSlots = lenses.map((_, index) => ({
    slotId: `panel-slot:remediation:${index + 1}`,
    attempts: ([1, 2] as const).map((attempt) => ({
      runId: panelRunId,
      requestId: `panel-request:remediation:${index + 1}:${attempt}`,
      slotId: `panel-slot:remediation:${index + 1}`,
      program: "refutation-panel",
      role: "review-verifier-agent",
      attempt,
      modelProfile: binding.profile,
      harnessBinding: { pi: binding.pi, claude: binding.claude },
      requiredSkill: null,
      contextDigest: (900 + index * 10 + attempt).toString(16).padStart(64, "0"),
      outputSlot: `transcripts/remediation-panel-${index + 1}/attempt-${attempt}.raw`,
    })),
  }));
  const brief = buildStandaloneFindingBrief(aggregate);
  const parsedAuthority = parseRefutationPanelAuthority({
    runId: panelRunId,
    findings: brief.findings,
    lenses,
    verifierSlots,
  });
  if (!parsedAuthority.ok) throw new Error(parsedAuthority.error.message);
  const frozen = freezeStandaloneRefutationPanelAuthority({
    standaloneAuthority,
    aggregate,
    panelAuthority: parsedAuthority.value,
    threshold: 2,
  });
  if (!frozen.ok) throw new Error(frozen.error.message);

  const requests = parsedAuthority.value.verifierRoster.orderedSlots.map(({ attempts }) => rawRequest(attempts[0]));
  const intent = prepareInitialBatchPublicationIntent(panelRunId, "effect:remediation-panel-batch", requests);
  if (!intent.ok) throw new Error(intent.error.message);
  const receipt: BatchPublishedReceipt = {
    schemaVersion: 1,
    kind: "batch-published",
    effectId: intent.value.identity.effectId,
    runId: intent.value.identity.runId,
    requestIds: intent.value.requestIds,
    contextDigests: intent.value.contextDigests,
    issuedRequests: intent.value.issuedRequests,
    publicationDigest: intent.value.identity.publicationDigest,
  };
  const receiptBytes = [...new TextEncoder().encode(JSON.stringify(receipt))];
  const issuance = createInitialBatchPublicationReconciler(
    createInitialPublicationEffectPort(() => ({ ok: true, value: receiptBytes })),
    createAtomicInitialPublicationClaimPort((claim) => ({
      ok: true,
      value: { schemaVersion: 1, kind: "initial-publication-claimed", key: claim.key, identity: claim.identity },
    })),
  )(intent.value);
  if (!issuance.ok) throw new Error(issuance.error.message);
  const action = spawnBatchAction(issuance.value, requests);
  if (!action.ok) throw new Error(action.error.message);
  const resolver = createPublicationAuthorityResolver(() => ({ ok: true, value: receiptBytes }));

  let panelState = startPersistentRefutationPanel(parsedAuthority.value).state;
  action.value.requests.forEach((request, index) => {
    const submitted = submitRefutationVerdict(
      panelState,
      resolver,
      panelRequestIdentity(request),
      JSON.stringify({
        criterion: lenses[index],
        verdicts: parsedAuthority.value.findings.map((finding) => ({
          finding_id: finding.id,
          verdict: "upheld",
          reasoning: `${lenses[index]} confirms ${finding.id}`,
        })),
      }),
    );
    if (!submitted.ok) throw new Error(submitted.error.message);
    panelState = submitted.value.state;
  });
  const completed = completePersistentRefutationPanel(panelState, resolver, 2);
  if (!completed.ok || completed.value.state.stage !== "done") {
    throw new Error(completed.ok ? "completed refutation panel required" : completed.error.message);
  }
  const completion = parseStandaloneRefutationCompletion({
    panelAuthority: frozen.value,
    aggregate,
    completedPanelState: completed.value.state,
  });
  if (!completion.ok) throw new Error(completion.error.message);
  return { frozen: frozen.value, authority: parsedAuthority.value, completion: completion.value };
}

type AuthoritativeStandaloneInput = Readonly<{
  standaloneResult: AuthoritativeStandaloneReviewResult;
  publicationReceipt: ArtifactSetPublished;
}>;

type AuthoritativeStandaloneFixture = Readonly<{
  input: AuthoritativeStandaloneInput;
  publicationResolver: StandaloneResultPublicationAuthorityResolver;
}>;

const standaloneFixtureCache = new Map<string, AuthoritativeStandaloneFixture>();

function standaloneFixture(
  scope: readonly string[] = ["src/main.ts", "src/deleted.ts"],
  withCritical = false,
): AuthoritativeStandaloneFixture {
  const cacheKey = JSON.stringify({ scope, withCritical });
  const cached = standaloneFixtureCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const prepared = prepareStandaloneReview({
    runId: "run.remediation-1",
    explicitScope: scope,
    changedPaths: {
      unstaged: scope, staged: [], committed: [], base_revision: null, head_revision: "HEAD",
    },
    reviewMetadata: {
      requested_kinds: ["types"], docs_only: false, source_or_test_changed: false,
      types_changed: true, comments_changed: false, additions: 1, file_count: scope.length,
      new_structure: false, languages: ["TypeScript"],
    },
    scopeSafety: scope.map((path) => ({ path, status: "safe" as const })),
    roster: rawStandaloneRoster(),
  });
  if (!prepared.ok) throw new Error(prepared.error.errors.join("; "));
  const authority = prepared.value.authority;
  const requests = authority.roster.orderedSlots.map(({ attempts }) => attempts[0]);
  const rawRequests = requests.map(rawRequest);
  const intent = prepareInitialBatchPublicationIntent(authority.runId, "effect:remediation-review-batch", rawRequests);
  if (!intent.ok) throw new Error(intent.error.message);
  const receipt: BatchPublishedReceipt = {
    schemaVersion: 1,
    kind: "batch-published",
    effectId: intent.value.identity.effectId,
    runId: intent.value.identity.runId,
    requestIds: intent.value.requestIds,
    contextDigests: intent.value.contextDigests,
    issuedRequests: intent.value.issuedRequests,
    publicationDigest: intent.value.identity.publicationDigest,
  };
  const receiptBytes = [...new TextEncoder().encode(JSON.stringify(receipt))];
  const issuance = createInitialBatchPublicationReconciler(
    createInitialPublicationEffectPort(() => ({ ok: true, value: receiptBytes })),
    createAtomicInitialPublicationClaimPort((claim) => ({
      ok: true,
      value: { schemaVersion: 1, kind: "initial-publication-claimed", key: claim.key, identity: claim.identity },
    })),
  )(intent.value);
  if (!issuance.ok) throw new Error(issuance.error.message);
  const action = spawnBatchAction(issuance.value, rawRequests);
  if (!action.ok) throw new Error(action.error.message);
  const issuedBySlot = new Map(action.value.requests.map((request) => [request.authority.slotId, request] as const));
  const accepted = authority.roster.orderedSlots.map(({ slotId }, index) => {
    const request = issuedBySlot.get(slotId) as SpawnRequest;
    const transcript = withCritical && index === 0 ? criticalTranscript : cleanTranscript;
    const bytes = Buffer.from(transcript, "utf8");
    const artifact = parseArtifactRef({
      runId: authority.runId,
      slot: request.authority.outputSlot,
      digest: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
    });
    if (!artifact.ok) throw new Error(artifact.error.message);
    const captured = capturedReviewerResultFromText(artifact.value, transcript);
    if (!captured.ok) throw new Error(captured.error.message);
    const result = acceptedAgentResult(request, captured.value);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  });
  const registration = createPublicationAuthorityResolver(() => ({ ok: true, value: receiptBytes }));
  const completion = proveStandaloneRosterCompletion(authority, registration, accepted);
  if (!completion.ok) throw new Error(completion.error.violations.map(({ kind }) => kind).join(","));
  const aggregate = aggregateStandaloneReview({ authority, completion: completion.value });
  if (!aggregate.ok) throw new Error(aggregate.errors.join("; "));
  const started = startStandaloneReviewMachine(authority);
  const awaiting = reduceStandaloneReviewMachine(started, { kind: "review-batch-published", runId: authority.runId });
  if (!awaiting.ok) throw new Error(awaiting.error.message);
  const aggregating = reduceStandaloneReviewMachine(awaiting.value, {
    kind: "complete-roster-proved", completion: completion.value,
  });
  if (!aggregating.ok) throw new Error(aggregating.error.message);
  const ready = aggregate.value.kind === "clean"
    ? reduceStandaloneReviewMachine(aggregating.value, {
        kind: "aggregate-clean",
        aggregate: aggregate.value.aggregate,
      })
    : (() => {
        const panel = upholdStandaloneCriticals(authority, aggregate.value.aggregate);
        const routed = reduceStandaloneReviewMachine(aggregating.value, {
          kind: "aggregate-has-criticals",
          aggregate: aggregate.value.aggregate,
          panelAuthority: panel.frozen,
          refutationAuthority: panel.authority,
        });
        if (!routed.ok) return routed;
        return reduceStandaloneReviewMachine(routed.value, {
          kind: "refutation-completed",
          completion: panel.completion,
        });
      })();
  if (!ready.ok || ready.value.kind !== "ready-to-finalize") throw new Error("ready finalization required");
  const rawResult = JSON.parse(serializeAdjudicatedStandaloneReview(ready.value.result));
  const publicationReceipt = {
    kind: "artifact-set-published" as const,
    effectId: ready.value.publicationIntent.effectId,
    runId: authority.runId,
    artifacts: ready.value.publicationIntent.artifacts,
  };
  const authoritative = parseAuthoritativeStandaloneReviewResult(ready.value, rawResult, publicationReceipt);
  if (!authoritative.ok) throw new Error(authoritative.error.message);
  const input = { standaloneResult: authoritative.value, publicationReceipt: authoritative.receipt };
  const publicationResolver = createStandaloneResultPublicationAuthorityResolver((lookup) =>
    lookup.runId === authoritative.receipt.runId && lookup.effectId === authoritative.receipt.effectId
      ? { ok: true, value: authoritative.receipt }
      : {
          ok: false,
          error: {
            kind: "standalone-result-publication-authority-unavailable",
            field: "lookup",
            message: "LC-2 publication is not registered for this run/effect",
          },
        });
  const fixture = { input, publicationResolver };
  standaloneFixtureCache.set(cacheKey, fixture);
  return fixture;
}

function standaloneInput(
  scope: readonly string[] = ["src/main.ts", "src/deleted.ts"],
): AuthoritativeStandaloneInput {
  return standaloneFixture(scope).input;
}

function standalonePublicationResolver(
  scope: readonly string[] = ["src/main.ts", "src/deleted.ts"],
): StandaloneResultPublicationAuthorityResolver {
  return standaloneFixture(scope).publicationResolver;
}

function standalonePublicationResolverForScopes(
  scopes: readonly (readonly string[])[],
): StandaloneResultPublicationAuthorityResolver {
  const receipts = scopes.map((scope) => standaloneFixture(scope).input.publicationReceipt);
  return createStandaloneResultPublicationAuthorityResolver((lookup) => {
    const receipt = receipts.find(({ runId, effectId }) => runId === lookup.runId && effectId === lookup.effectId);
    return receipt === undefined
      ? {
          ok: false,
          error: {
            kind: "standalone-result-publication-authority-unavailable",
            field: "lookup",
            message: "LC-2 publication is not registered for this run/effect",
          },
        }
      : { ok: true, value: receipt };
  });
}

const parseRemediationPathAuthority = (raw: unknown) =>
  parseRemediationPathAuthorityWithAuthority(raw, standalonePublicationResolver());
const parseAuditedPathSet = (raw: unknown) =>
  parseAuditedPathSetWithAuthority(raw, standalonePublicationResolver());
const parseStagedTemporaryIndex = (raw: unknown) =>
  parseStagedTemporaryIndexWithAuthority(raw, standalonePublicationResolver());
const parseVerifiedTemporaryIndex = (raw: unknown) =>
  parseVerifiedTemporaryIndexWithAuthority(raw, standalonePublicationResolver());
const parseVerifiedIndexInstallation = (raw: unknown) =>
  parseVerifiedIndexInstallationWithAuthority(raw, standalonePublicationResolver());
const parseRemediationState = (raw: unknown) =>
  parseRemediationStateWithAuthority(raw, standalonePublicationResolver());

function repositoryWitness(offset = 0): RepositorySnapshotWitness {
  return valueOf(parseRepositorySnapshotWitness({
    baseTreeDigest: digest(10 + offset),
    indexDigest: digest(20 + offset),
    worktreeDigest: digest(30 + offset),
  }));
}

function frozenAuthority(): FrozenPathAuthority {
  return valueOf(freezePathAuthority(standaloneInput()));
}

function registeredAuthority(): RegisteredPathAuthority {
  return valueOf(registerSupportPath(frozenAuthority(), "engine/tests/regression.test.ts"));
}

const observations = Object.freeze([
  { path: "engine/tests/regression.test.ts", change: "added", nodeKind: "file" },
  { path: "src/deleted.ts", change: "deleted", nodeKind: "missing" },
  { path: "src/main.ts", change: "modified", nodeKind: "file" },
] as const);

const remediationPaths = Object.freeze([
  "engine/tests/regression.test.ts",
  "src/deleted.ts",
  "src/main.ts",
]);

function audited(
  authority = registeredAuthority(),
  preexistingStagedPaths: readonly string[] = [],
): AuditedPathSet {
  return valueOf(auditRemediationPaths(authority, {
    expectedDirtyPaths: remediationPaths,
    actualDirtyPaths: observations,
    preexistingStagedPaths,
    repositoryWitness: repositoryWitness(),
  }));
}

function staged(audit = audited()): StagedTemporaryIndex {
  return valueOf(stageTemporaryIndex(audit, digest(40), repositoryWitness()));
}

function verified(stage = staged()): VerifiedTemporaryIndex {
  return valueOf(verifyTemporaryIndex(stage, {
    actualTemporaryIndexStagedPaths: remediationPaths,
    actualIndexDigest: digest(40),
    currentRepositoryWitness: repositoryWitness(),
  }));
}

function installation(index = verified()): VerifiedIndexInstallation {
  return valueOf(prepareVerifiedIndexInstallation(index, "effect.install-1", repositoryWitness()));
}

function installedReceipt(prepared = installation()) {
  return {
    kind: "verified-index-installed",
    effectId: prepared.intent.effectId,
    runId: prepared.intent.runId,
    indexDigest: prepared.intent.indexDigest,
    witnessDigest: prepared.intent.witnessDigest,
  } as const;
}

function lifecycleStates() {
  const start = valueOf(startRemediation(standaloneInput()));
  const registered = valueOf(reduceRemediation(start, {
    kind: "support-path-registered",
    path: "engine/tests/regression.test.ts",
  }));
  if (registered.state !== "paths-registered") throw new Error("registration fixture failed");
  const audit = audited(registered.authority);
  const auditedState = valueOf(reduceRemediation(registered, { kind: "audit-succeeded", audited: audit }));
  const stage = staged(audit);
  const stagedState = valueOf(reduceRemediation(auditedState, { kind: "temporary-index-staged", staged: stage }));
  const index = verified(stage);
  const verifiedState = valueOf(reduceRemediation(stagedState, { kind: "staged-set-verified", verified: index }));
  const prepared = installation(index);
  const done = valueOf(reduceRemediation(verifiedState, {
    kind: "index-installed",
    installation: prepared,
    receipt: installedReceipt(prepared),
  }));
  return { start, registered, auditedState, stagedState, verifiedState, done, audit, stage, index, prepared };
}

const safeName = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/);
const safePath = safeName.map((name) => `src/${name}.ts`);

describe("canonical remediation authority and path algebra", () => {
  it("starts only from a parser-accepted authoritative standalone result", () => {
    const started = valueOf(startRemediation(standaloneInput()));
    expect(started.state).toBe("authority-frozen");
    expect(started.authority.reviewedScope.paths).toEqual(["src/deleted.ts", "src/main.ts"]);

    expect(freezePathAuthority({
      runId: "run.arbitrary",
      reviewedScope: ["outside/caller-selected.ts"],
    }).ok).toBe(false);
    const authoritativeInput = standaloneInput();
    const forgedSchemaV1 = JSON.parse(serializeAdjudicatedStandaloneReview(authoritativeInput.standaloneResult));
    expect(freezePathAuthority({
      standaloneResult: forgedSchemaV1,
      publicationReceipt: authoritativeInput.publicationReceipt,
    }).ok).toBe(false);
    expect(freezePathAuthority({
      ...authoritativeInput,
      publicationReceipt: { ...authoritativeInput.publicationReceipt, effectId: "effect:foreign-publication" },
    }).ok).toBe(false);
    expect(freezePathAuthority({
      standaloneResult: {
        run_id: "run.historical", scope: ["outside/caller-selected.ts"],
        surviving_critical_findings: [], advisory_findings: [], refuted_critical_findings: [], panel: null,
      },
      publicationReceipt: standaloneInput().publicationReceipt,
    }).ok).toBe(false);
  });

  it("accepts a critical-bearing LC-2 fixture only through its trusted result publication", () => {
    const fixture = standaloneFixture(["src/main.ts", "src/deleted.ts"], true);
    expect(fixture.input.standaloneResult.survivingCriticals).toHaveLength(1);
    const authority = valueOf(freezePathAuthority(fixture.input));
    expect(parseRemediationPathAuthorityWithAuthority(
      jsonRoundTrip(authority),
      fixture.publicationResolver,
    ).ok).toBe(true);
    expect(parseRemediationPathAuthority(jsonRoundTrip(authority)).ok).toBe(false);
  });

  it("round-trips every generated canonical repository-relative path", () => {
    fc.assert(fc.property(safePath, (path) => {
      const parsed = parseCanonicalRepositoryRelativePath(path);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value).toBe(path);
    }));
  });

  it("rejects traversal, separators, whitespace, NUL, CR, and LF attacks", () => {
    fc.assert(fc.property(safeName, (name) => {
      const attacks = [
        `/tmp/${name}`,
        `C:\\repo\\${name}`,
        `..\\${name}`,
        `../${name}`,
        `src/../${name}`,
        `./src/${name}`,
        `src//${name}`,
        `src\\${name}`,
        ` src/${name}`,
        `src/${name} `,
        `src/${name}\0evil`,
        `src/${name}\rmalicious`,
        `src/${name}\nmalicious`,
      ];
      for (const attack of attacks) expect(parseCanonicalRepositoryRelativePath(attack).ok, attack).toBe(false);
    }));
  });

  it("conserves set identity and digest across arbitrary permutations", () => {
    fc.assert(fc.property(
      fc.uniqueArray(safePath, { minLength: 1, maxLength: 20 }),
      fc.integer(),
      (paths, seed) => {
        const rotation = Math.abs(seed) % paths.length;
        const permuted = [...paths.slice(rotation), ...paths.slice(0, rotation)].reverse();
        const left = valueOf(parseRemediationPathSet(paths));
        const right = valueOf(parseRemediationPathSet(permuted));
        expect(right.paths).toEqual(left.paths);
        expect(right.digest).toBe(left.digest);
        expect(Object.isFrozen(right.paths)).toBe(true);
      },
    ));
  });

  it("rejects duplicates rather than silently collapsing authority", () => {
    fc.assert(fc.property(safePath, (path) => {
      const parsed = parseRemediationPathSet([path, path]);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.duplicates).toEqual([path]);
    }));
  });

  it("reports exact missing and unexpected sets", () => {
    const expected = valueOf(parseRemediationPathSet(["src/a.ts", "src/b.ts"]));
    const actual = valueOf(parseRemediationPathSet(["src/b.ts", "src/c.ts"]));
    const compared = compareExactPathSets(expected, actual);
    expect(compared.ok).toBe(false);
    if (!compared.ok) {
      expect(compared.error.missing).toEqual(["src/a.ts"]);
      expect(compared.error.unexpected).toEqual(["src/c.ts"]);
    }
  });

  it("requires explicit support registration without mutating predecessor authority", () => {
    const authority = frozenAuthority();
    const registered = valueOf(registerSupportPath(authority, "engine/tests/regression.test.ts"));
    expect(registered.registeredSupportPaths.paths).toEqual(["engine/tests/regression.test.ts"]);
    expect(registered.authorizedPaths.paths).toEqual(remediationPaths);
    expect(authority.registeredSupportPaths.paths).toEqual([]);
  });

  it("conserves registered authority across support-path permutations", () => {
    fc.assert(fc.property(safeName, safeName, (leftName, rightName) => {
      fc.pre(leftName !== rightName);
      const initial = frozenAuthority();
      const left = `engine/tests/${leftName}.test.ts`;
      const right = `engine/tests/${rightName}.test.ts`;
      const leftThenRight = valueOf(registerSupportPath(valueOf(registerSupportPath(initial, left)), right));
      const rightThenLeft = valueOf(registerSupportPath(valueOf(registerSupportPath(initial, right)), left));
      expect(leftThenRight.authorizedPaths.paths).toEqual(rightThenLeft.authorizedPaths.paths);
      expect(leftThenRight.digest).toBe(rightThenLeft.digest);
    }));
  });

  it("canonically rejects every Loom evidence and Run Directory layout at freeze and registration", () => {
    const attacks = [
      ".git/index",
      ".claude/state/active_task_graph.json",
      ".claude/reviews/packets/run.x/T5.json",
      ".claude/reviews/panel-runs/run.x/outcomes.json",
      ".claude/reviews/review-runs/run.x/result.json",
      ".claude/reviews/review-and-fix-runs/run.x/result.json",
      ".claude/specs/2026-x/panel-runs/run.x/manifest.json",
      ".claude/specs/2026-x/review-runs/run.x/result.json",
      ".claude/custom/wave-gate-runs/run.x/events.json",
      ".claude/custom/orchestration-runs/run.x/checkpoint.json",
    ];
    for (const attack of attacks) {
      expect(freezePathAuthority(standaloneInput([attack])).ok, `freeze ${attack}`).toBe(false);
      expect(registerSupportPath(frozenAuthority(), attack).ok, `register ${attack}`).toBe(false);
    }
    expect(registerSupportPath(frozenAuthority(), ".gitignore").ok).toBe(true);
  });

  it("strictly rehydrates standalone-bound authority and rejects source or nested digest drift", () => {
    const authority = registeredAuthority();
    const parsed = valueOf(parseRemediationPathAuthority(jsonRoundTrip(authority)));
    expect(parsed.digest).toBe(authority.digest);
    expect(registerSupportPath(parsed, "engine/tests/second.test.ts").ok).toBe(true);

    const sourceDrift = jsonRoundTrip(authority) as Record<string, unknown>;
    sourceDrift.sourceResultDigest = digest(999);
    expect(parseRemediationPathAuthority(sourceDrift).ok).toBe(false);

    const scopeDrift = jsonRoundTrip(authority) as { reviewedScope: { paths: string[] } };
    scopeDrift.reviewedScope.paths.push("outside.ts");
    expect(parseRemediationPathAuthority(scopeDrift).ok).toBe(false);

    const publicationDrift = jsonRoundTrip(authority) as {
      sourcePublicationAuthority: { publicationReceipt: { artifacts: Array<{ digest: string }> } };
    };
    publicationDrift.sourcePublicationAuthority.publicationReceipt.artifacts[0]!.digest = digest(998);
    expect(parseRemediationPathAuthority(publicationDrift).ok).toBe(false);
  });

  it("rejects self-consistent caller publication JSON unless trusted LC-2 authority resolves it", () => {
    const foreignScope = ["src/caller-fabricated-result.ts"] as const;
    const foreign = valueOf(freezePathAuthority(standaloneInput(foreignScope)));
    const rawForeign = jsonRoundTrip(foreign);

    expect(parseRemediationPathAuthorityWithAuthority(
      rawForeign,
      standalonePublicationResolver(),
    ).ok).toBe(false);

    const fabricatedResolver = (() => ({
      ok: true,
      value: (rawForeign as { sourcePublicationAuthority: unknown }).sourcePublicationAuthority,
    })) as unknown as StandaloneResultPublicationAuthorityResolver;
    expect(parseRemediationPathAuthorityWithAuthority(rawForeign, fabricatedResolver).ok).toBe(false);

    expect(parseRemediationPathAuthorityWithAuthority(
      rawForeign,
      standalonePublicationResolver(foreignScope),
    ).ok).toBe(true);
  });
});

describe("literal NUL Git path contract", () => {
  it("preserves valid pathspec-looking repository filenames only in literal NUL stdin", () => {
    const authority = valueOf(freezePathAuthority(
      standaloneInput([":(glob)**", "src/*.ts", "src/[abc].ts", "--option-like"]),
    ));
    const audit = valueOf(auditRemediationPaths(authority, {
      expectedDirtyPaths: [":(glob)**", "src/*.ts", "src/[abc].ts", "--option-like"],
      actualDirtyPaths: [
        { path: ":(glob)**", change: "modified", nodeKind: "file" },
        { path: "src/*.ts", change: "modified", nodeKind: "file" },
        { path: "src/[abc].ts", change: "modified", nodeKind: "file" },
        { path: "--option-like", change: "modified", nodeKind: "file" },
      ],
      preexistingStagedPaths: [],
      repositoryWitness: repositoryWitness(),
    }));
    const contract = valueOf(prepareLiteralGitPathspec(audit));
    expect(contract.globalArgs).toEqual(["--literal-pathspecs"]);
    expect(contract.pathspecArgs).toEqual(["--pathspec-from-file=-", "--pathspec-file-nul"]);
    expect([...contract.globalArgs, ...contract.pathspecArgs].some((arg) => audit.paths.paths.includes(arg as never))).toBe(false);
    const decoded = Buffer.from(contract.manifest.bytes).toString("utf8").split("\0").slice(0, -1);
    expect(decoded).toEqual(audit.paths.paths);
    expect(contract.manifest.bytes.at(-1)).toBe(0);
  });

  it("strictly rehydrates the fixed contract and rejects selector or byte tampering", () => {
    const contract = valueOf(prepareLiteralGitPathspec(audited()));
    expect(parseFixedGitPathspecContract(jsonRoundTrip(contract)).ok).toBe(true);

    const args = jsonRoundTrip(contract) as { globalArgs: string[] };
    args.globalArgs.push("src/*.ts");
    expect(parseFixedGitPathspecContract(args).ok).toBe(false);

    const bytes = jsonRoundTrip(contract) as { manifest: { bytes: number[] } };
    bytes.manifest.bytes[0] = 0;
    expect(parseFixedGitPathspecContract(bytes).ok).toBe(false);
  });
});

describe("exact audited, dirty, and staged evidence", () => {
  it("represents additions, modifications, both rename sides, deletion, and absence without symlinks", () => {
    const cases = [
      { path: "a", change: "added", nodeKind: "file" },
      { path: "b", change: "modified", nodeKind: "file" },
      { path: "c", change: "renamed-from", nodeKind: "missing" },
      { path: "d", change: "renamed-to", nodeKind: "file" },
      { path: "e", change: "deleted", nodeKind: "missing" },
      { path: "f", change: "absent", nodeKind: "missing" },
    ] as const;
    for (const observation of cases) expect(parseDirtyPathObservation(observation).ok).toBe(true);
    for (const change of PATH_PRESENT_CHANGES) {
      expect(parseDirtyPathObservation({ path: "x", change, nodeKind: "missing" }).ok).toBe(false);
    }
    for (const change of PATH_ABSENT_CHANGES) {
      expect(parseDirtyPathObservation({ path: "x", change, nodeKind: "file" }).ok).toBe(false);
    }
  });

  it("rejects every symlink observation", () => {
    fc.assert(fc.property(safePath, fc.constantFrom(
      "added", "modified", "renamed-from", "renamed-to", "deleted", "absent",
    ), (path, change) => {
      expect(parseDirtyPathObservation({ path, change, nodeKind: "symlink" }).ok).toBe(false);
    }));
  });

  it("is permutation invariant and publishes exact audited=dirty evidence", () => {
    fc.assert(fc.property(fc.integer(), (seed) => {
      const rotation = Math.abs(seed) % observations.length;
      const actualDirtyPaths = [...observations.slice(rotation), ...observations.slice(0, rotation)];
      const result = valueOf(auditRemediationPaths(registeredAuthority(), {
        expectedDirtyPaths: [...remediationPaths].reverse(),
        actualDirtyPaths,
        preexistingStagedPaths: [],
        repositoryWitness: repositoryWitness(),
      }));
      expect(result.evidence.kind).toBe("audited-dirty-evidence");
      expect(result.evidence.auditedEqualsDirty.expectedDigest)
        .toBe(result.evidence.auditedEqualsDirty.actualDigest);
      expect(result.digest).toBe(audited().digest);
    }));
  });

  it("accepts only authorized pre-existing staged paths already represented by the audited dirty set", () => {
    const audit = audited(registeredAuthority(), ["src/main.ts"]);
    expect(audit.evidence.preexistingStagedPaths.paths).toEqual(["src/main.ts"]);
    expect(audit.evidence.preexistingStagedWithinAudited.subset.paths).toEqual(["src/main.ts"]);
    expect(audit.evidence.preexistingStagedWithinAudited.superset.paths).toEqual(remediationPaths);
    const stage = staged(audit);
    const index = valueOf(verifyTemporaryIndex(stage, {
      actualTemporaryIndexStagedPaths: remediationPaths,
      actualIndexDigest: digest(40),
      currentRepositoryWitness: repositoryWitness(),
    }));
    expect(index.evidence.kind).toBe("audited-dirty-temporary-index-evidence");
    expect(index.evidence.auditedEqualsDirty.expectedDigest).toBe(index.evidence.auditedEqualsDirty.actualDigest);
    expect(index.evidence.auditedEqualsTemporaryIndexStaged.expectedDigest)
      .toBe(index.evidence.auditedEqualsTemporaryIndexStaged.actualDigest);
    expect(index.evidence.temporaryIndexStagedPaths.paths).toEqual(remediationPaths);
  });

  it("blocks without mutation authority and identifies every unrelated pre-existing staged path", () => {
    const expectedDirtyPaths = [...remediationPaths];
    const actualDirtyPaths = observations.map((observation) => ({ ...observation }));
    const preexistingStagedPaths = ["src/main.ts", "user/also-staged.ts", "user/preserved.ts"];
    const immutableInputBefore = JSON.stringify({ expectedDirtyPaths, actualDirtyPaths, preexistingStagedPaths });
    const result = auditRemediationPaths(registeredAuthority(), {
      expectedDirtyPaths,
      actualDirtyPaths,
      preexistingStagedPaths,
      repositoryWitness: repositoryWitness(),
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify({ expectedDirtyPaths, actualDirtyPaths, preexistingStagedPaths })).toBe(immutableInputBefore);
    if (!result.ok) {
      expect(result.error.unauthorizedPreexistingStagedPaths).toEqual([
        "user/also-staged.ts",
        "user/preserved.ts",
      ]);
      expect(result.error.preexistingStagedPathsOutsideAudited).toEqual([
        "user/also-staged.ts",
        "user/preserved.ts",
      ]);
    }
  });

  it("rejects an authorized pre-existing staged path that is outside the exact audited dirty set", () => {
    const result = auditRemediationPaths(registeredAuthority(), {
      expectedDirtyPaths: ["src/main.ts"],
      actualDirtyPaths: [{ path: "src/main.ts", change: "modified", nodeKind: "file" }],
      preexistingStagedPaths: ["src/deleted.ts"],
      repositoryWitness: repositoryWitness(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.unauthorizedPreexistingStagedPaths).toEqual([]);
      expect(result.error.preexistingStagedPathsOutsideAudited).toEqual(["src/deleted.ts"]);
    }
  });

  it("fails closed and identifies unauthorized dirty and excluded evidence paths", () => {
    const result = auditRemediationPaths(registeredAuthority(), {
      expectedDirtyPaths: ["src/main.ts", "outside/user.ts"],
      actualDirtyPaths: [
        { path: "src/main.ts", change: "modified", nodeKind: "file" },
        { path: "outside/user.ts", change: "modified", nodeKind: "file" },
        { path: ".claude/specs/x/panel-runs/run.x/result.json", change: "modified", nodeKind: "file" },
      ],
      preexistingStagedPaths: [".claude/state/active_task_graph.json"],
      repositoryWitness: repositoryWitness(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.unauthorizedDirtyPaths).toEqual([
        ".claude/specs/x/panel-runs/run.x/result.json",
        "outside/user.ts",
      ]);
      expect(result.error.excludedEvidencePaths).toEqual([
        ".claude/specs/x/panel-runs/run.x/result.json",
        ".claude/state/active_task_graph.json",
      ]);
    }
  });

  it("fails exact audit on every missing or surplus dirty path", () => {
    fc.assert(fc.property(fc.boolean(), (surplus) => {
      const result = auditRemediationPaths(registeredAuthority(), {
        expectedDirtyPaths: surplus ? ["src/main.ts"] : ["src/main.ts", "src/deleted.ts"],
        actualDirtyPaths: surplus
          ? [
              { path: "src/main.ts", change: "modified", nodeKind: "file" },
              { path: "src/deleted.ts", change: "deleted", nodeKind: "missing" },
            ]
          : [{ path: "src/main.ts", change: "modified", nodeKind: "file" }],
        preexistingStagedPaths: [],
        repositoryWitness: repositoryWitness(),
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(surplus ? result.error.unexpectedPaths : result.error.missingPaths)
        .toEqual(["src/deleted.ts"]);
    }));
  });

  it("rejects both missing subsets and surplus temporary-index staging without changing the staged witness", () => {
    const stage = staged();
    const stageBefore = JSON.stringify(stage);
    const missing = verifyTemporaryIndex(stage, {
      actualTemporaryIndexStagedPaths: remediationPaths.slice(1),
      actualIndexDigest: digest(40),
      currentRepositoryWitness: repositoryWitness(),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.pathMismatch?.missing).toEqual([remediationPaths[0]]);

    const surplus = verifyTemporaryIndex(stage, {
      actualTemporaryIndexStagedPaths: [...remediationPaths, "outside.ts"],
      actualIndexDigest: digest(40),
      currentRepositoryWitness: repositoryWitness(),
    });
    expect(surplus.ok).toBe(false);
    if (!surplus.ok) expect(surplus.error.pathMismatch?.unexpected).toEqual(["outside.ts"]);
    expect(JSON.stringify(stage)).toBe(stageBefore);
  });
});

const PATH_PRESENT_CHANGES = ["added", "modified", "renamed-to"] as const;
const PATH_ABSENT_CHANGES = ["renamed-from", "deleted", "absent"] as const;

describe("nominal proof chain, durable parsers, and TOCTOU", () => {
  it("makes only audited staging and only verified installation type-correct", () => {
    if (false) {
      // @ts-expect-error Frozen authority lacks the unexported AuditedPathSet nominal brand.
      stageTemporaryIndex(frozenAuthority(), digest(40), repositoryWitness());
      // @ts-expect-error Staged index lacks the unexported VerifiedTemporaryIndex nominal brand.
      prepareVerifiedIndexInstallation(staged(), "effect.invalid", repositoryWitness());
    }
    const forgedAudit = jsonRoundTrip(audited()) as AuditedPathSet;
    const forgedVerified = jsonRoundTrip(verified()) as VerifiedTemporaryIndex;
    expect(stageTemporaryIndex(forgedAudit, digest(40), repositoryWitness()).ok).toBe(false);
    expect(prepareVerifiedIndexInstallation(forgedVerified, "effect.invalid", repositoryWitness()).ok).toBe(false);
  });

  it("strictly rehydrates audited, staged, verified, and installation proofs", () => {
    const audit = valueOf(parseAuditedPathSet(jsonRoundTrip(audited())));
    const stage = valueOf(parseStagedTemporaryIndex(jsonRoundTrip(staged(audit))));
    const index = valueOf(parseVerifiedTemporaryIndex(jsonRoundTrip(verified(stage))));
    const prepared = valueOf(parseVerifiedIndexInstallation(jsonRoundTrip(installation(index))));
    expect(stageTemporaryIndex(audit, digest(41), repositoryWitness()).ok).toBe(true);
    expect(verifyTemporaryIndex(stage, {
      actualTemporaryIndexStagedPaths: remediationPaths,
      actualIndexDigest: digest(40),
      currentRepositoryWitness: repositoryWitness(),
    }).ok).toBe(true);
    expect(prepareVerifiedIndexInstallation(index, "effect.install-2", repositoryWitness()).ok).toBe(true);
    expect(prepared.intent.runId).toBe(index.runId);
  });

  it("recomputes nested proof digests and rejects relationship tampering", () => {
    const auditRaw = jsonRoundTrip(audited()) as { evidence: { digest: string } };
    auditRaw.evidence.digest = digest(800);
    expect(parseAuditedPathSet(auditRaw).ok).toBe(false);

    const stageRaw = jsonRoundTrip(staged()) as { expectedPaths: { paths: string[] } };
    stageRaw.expectedPaths.paths.pop();
    expect(parseStagedTemporaryIndex(stageRaw).ok).toBe(false);

    const verifiedRaw = jsonRoundTrip(verified()) as { evidence: { temporaryIndexStagedPaths: { digest: string } } };
    verifiedRaw.evidence.temporaryIndexStagedPaths.digest = digest(801);
    expect(parseVerifiedTemporaryIndex(verifiedRaw).ok).toBe(false);

    const installRaw = jsonRoundTrip(installation()) as { intent: { witnessDigest: string } };
    installRaw.intent.witnessDigest = digest(802);
    expect(parseVerifiedIndexInstallation(installRaw).ok).toBe(false);
  });

  it("fails TOCTOU at staging, verification, and installation for every witness component", () => {
    fc.assert(fc.property(fc.constantFrom("baseTreeDigest", "indexDigest", "worktreeDigest"), (field) => {
      const current = repositoryWitness();
      const drifted = valueOf(parseRepositorySnapshotWitness({
        baseTreeDigest: field === "baseTreeDigest" ? digest(101) : current.baseTreeDigest,
        indexDigest: field === "indexDigest" ? digest(102) : current.indexDigest,
        worktreeDigest: field === "worktreeDigest" ? digest(103) : current.worktreeDigest,
      }));
      expect(stageTemporaryIndex(audited(), digest(40), drifted).ok).toBe(false);
      const stage = staged();
      expect(verifyTemporaryIndex(stage, {
        actualTemporaryIndexStagedPaths: remediationPaths,
        actualIndexDigest: digest(40),
        currentRepositoryWitness: drifted,
      }).ok).toBe(false);
      expect(prepareVerifiedIndexInstallation(verified(stage), "effect.install-2", drifted).ok).toBe(false);
    }));
  });

  it("does not throw while checking digest presence on hostile repository witness proxies", () => {
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor: () => { throw new TypeError("repository witness descriptor revoked"); },
    });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();

    for (const raw of [hostile, revoked.proxy]) {
      expect(() => parseRepositorySnapshotWitness(raw)).not.toThrow();
      const parsed = parseRepositorySnapshotWitness(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.field).toBe("repositoryWitness");
    }
  });
});

describe("durable LC-3 lifecycle and recovery", () => {
  it("rejects structurally forged states until the strict parser re-mints them", () => {
    const start = lifecycleStates().start;
    const forged = { ...start } as RemediationState;
    expect(reduceRemediation(forged, {
      kind: "recoverable-effect-failed",
      recoveryAttemptId: "attempt.forged",
      effectId: "effect.forged",
      message: "must not transition",
    }).ok).toBe(false);

    const parsed = valueOf(parseRemediationState(jsonRoundTrip(start)));
    expect(reduceRemediation(parsed, {
      kind: "recoverable-effect-failed",
      recoveryAttemptId: "attempt.parsed",
      effectId: "effect.parsed",
      message: "parser-minted state",
    }).ok).toBe(true);
  });

  it("continues after JSON rehydration from every LC-3 state", () => {
    const initial = lifecycleStates();

    const start = valueOf(parseRemediationState(jsonRoundTrip(initial.start)));
    expect(reduceRemediation(start, { kind: "support-path-registered", path: "engine/tests/other.test.ts" }).ok).toBe(true);

    const registered = valueOf(parseRemediationState(jsonRoundTrip(initial.registered)));
    if (registered.state !== "paths-registered") throw new Error("expected paths-registered");
    const reparsedAudit = audited(registered.authority);
    expect(reduceRemediation(registered, { kind: "audit-succeeded", audited: reparsedAudit }).ok).toBe(true);

    const auditedState = valueOf(parseRemediationState(jsonRoundTrip(initial.auditedState)));
    if (auditedState.state !== "audited") throw new Error("expected audited");
    const reparsedStage = staged(auditedState.audited);
    expect(reduceRemediation(auditedState, { kind: "temporary-index-staged", staged: reparsedStage }).ok).toBe(true);

    const stagedState = valueOf(parseRemediationState(jsonRoundTrip(initial.stagedState)));
    if (stagedState.state !== "staged-temporary-index") throw new Error("expected staged");
    const reparsedVerified = verified(stagedState.staged);
    expect(reduceRemediation(stagedState, { kind: "staged-set-verified", verified: reparsedVerified }).ok).toBe(true);

    const verifiedState = valueOf(parseRemediationState(jsonRoundTrip(initial.verifiedState)));
    if (verifiedState.state !== "verified") throw new Error("expected verified");
    const reparsedInstall = installation(verifiedState.verified);
    expect(reduceRemediation(verifiedState, {
      kind: "index-installed",
      installation: reparsedInstall,
      receipt: installedReceipt(reparsedInstall),
    }).ok).toBe(true);

    const done = valueOf(parseRemediationState(jsonRoundTrip(initial.done)));
    expect(done.state).toBe("done");
    expect(reduceRemediation(done, {
      kind: "recoverable-effect-failed",
      recoveryAttemptId: "attempt.late",
      effectId: "effect.late",
      message: "late",
    }).ok).toBe(false);
  });

  it("round-trips recovery for every active predecessor state", () => {
    const states = lifecycleStates();
    const predecessors = [states.start, states.registered, states.auditedState, states.stagedState, states.verifiedState];
    predecessors.forEach((predecessor, index) => {
      const blocked = valueOf(reduceRemediation(predecessor, {
        kind: "recoverable-effect-failed",
        recoveryAttemptId: `attempt.${index}`,
        effectId: `effect.failure-${index}`,
        message: "transient adapter failure",
      }));
      const resumedBlocked = valueOf(parseRemediationState(jsonRoundTrip(blocked)));
      expect(resumedBlocked.state).toBe("recoverable-blocked");
      if (resumedBlocked.state !== "recoverable-blocked") return;
      const receipt = valueOf(recoveryReceiptFor(resumedBlocked, `receipt.${index}`));
      const recovered = valueOf(reduceRemediation(resumedBlocked, {
        kind: "recovery-receipt-accepted",
        receipt: jsonRoundTrip(receipt),
      }));
      expect(recovered.state).toBe(predecessor.state);
      expect(recovered.recoveryAttemptIds).toContain(`attempt.${index}`);
      expect(recovered.consumedRecoveryReceiptIds).toContain(`receipt.${index}`);
    });
  });

  it("persists consumed receipt IDs and rejects stale receipts across failures and restarts", () => {
    const { auditedState } = lifecycleStates();
    const firstBlocked = valueOf(reduceRemediation(auditedState, {
      kind: "recoverable-effect-failed",
      recoveryAttemptId: "attempt.first",
      effectId: "effect.retry",
      message: "first failure",
    }));
    if (firstBlocked.state !== "recoverable-blocked") throw new Error("expected blocked");
    const firstReceipt = valueOf(recoveryReceiptFor(firstBlocked, "receipt.first"));
    const firstRecovered = valueOf(reduceRemediation(firstBlocked, {
      kind: "recovery-receipt-accepted",
      receipt: firstReceipt,
    }));
    const restarted = valueOf(parseRemediationState(jsonRoundTrip(firstRecovered)));
    const secondBlocked = valueOf(reduceRemediation(restarted, {
      kind: "recoverable-effect-failed",
      recoveryAttemptId: "attempt.second",
      effectId: "effect.retry",
      message: "second failure",
    }));
    if (secondBlocked.state !== "recoverable-blocked") throw new Error("expected blocked");

    const stale = reduceRemediation(secondBlocked, {
      kind: "recovery-receipt-accepted",
      receipt: firstReceipt,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.kind).toBe("invalid-recovery-receipt");
    expect(recoveryReceiptFor(secondBlocked, "receipt.first").ok).toBe(false);

    const secondReceipt = valueOf(recoveryReceiptFor(secondBlocked, "receipt.second"));
    const secondRecovered = valueOf(reduceRemediation(
      valueOf(parseRemediationState(jsonRoundTrip(secondBlocked))),
      { kind: "recovery-receipt-accepted", receipt: secondReceipt },
    ));
    expect(secondRecovered.consumedRecoveryReceiptIds).toEqual(["receipt.first", "receipt.second"]);
    expect(secondRecovered.recoveryAttemptIds).toEqual(["attempt.first", "attempt.second"]);
  });

  it("rejects property-generated receipt-surplus histories in active, blocked, and done states", () => {
    const states = lifecycleStates();
    const blocked = valueOf(reduceRemediation(states.auditedState, {
      kind: "recoverable-effect-failed",
      recoveryAttemptId: "attempt.cardinality-blocked",
      effectId: "effect.cardinality-blocked",
      message: "blocked",
    }));
    const variants = [
      states.start,
      states.registered,
      states.auditedState,
      states.stagedState,
      states.verifiedState,
      blocked,
      states.done,
    ];

    fc.assert(fc.property(
      fc.constantFrom(...variants),
      fc.integer({ min: 0, max: 5 }),
      fc.integer({ min: 1, max: 3 }),
      (variant, attemptCount, receiptSurplus) => {
        const raw = jsonRoundTrip(variant) as {
          recoveryAttemptIds: string[];
          consumedRecoveryReceiptIds: string[];
        };
        raw.recoveryAttemptIds = Array.from(
          { length: attemptCount },
          (_, index) => `attempt.impossible-${index}`,
        );
        raw.consumedRecoveryReceiptIds = Array.from(
          { length: attemptCount + receiptSurplus },
          (_, index) => `receipt.impossible-${index}`,
        );
        const parsed = parseRemediationState(raw);
        expect(parsed.ok).toBe(false);
        if (!parsed.ok) {
          expect(parsed.error.field).toBe("history");
          expect(parsed.error.message).toContain("more consumed recovery receipts");
        }
      },
    ));
  });

  it("rejects state-specific impossible active, blocked, and done history cardinalities", () => {
    const states = lifecycleStates();
    for (const variant of [states.auditedState, states.done]) {
      const raw = jsonRoundTrip(variant) as {
        recoveryAttemptIds: string[];
        consumedRecoveryReceiptIds: string[];
      };
      raw.recoveryAttemptIds = ["attempt.without-accepted-receipt"];
      raw.consumedRecoveryReceiptIds = [];
      const parsed = parseRemediationState(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.field).toBe("history");
    }

    const blocked = valueOf(reduceRemediation(states.auditedState, {
      kind: "recoverable-effect-failed",
      recoveryAttemptId: "attempt.equal-history",
      effectId: "effect.equal-history",
      message: "blocked",
    }));
    const blockedRaw = jsonRoundTrip(blocked) as { consumedRecoveryReceiptIds: string[] };
    blockedRaw.consumedRecoveryReceiptIds = ["receipt.equal-history"];
    const parsedBlocked = parseRemediationState(blockedRaw);
    expect(parsedBlocked.ok).toBe(false);
    if (!parsedBlocked.ok) expect(parsedBlocked.error.field).toBe("history");
  });

  it("round-trips repeated blocked recovery failures without fabricating consumed receipts", () => {
    const firstBlocked = valueOf(reduceRemediation(lifecycleStates().auditedState, {
      kind: "recoverable-effect-failed",
      recoveryAttemptId: "attempt.retry-first",
      effectId: "effect.retry-first",
      message: "first recovery attempt failed",
    }));
    const secondBlocked = valueOf(reduceRemediation(firstBlocked, {
      kind: "recoverable-effect-failed",
      recoveryAttemptId: "attempt.retry-second",
      effectId: "effect.retry-second",
      message: "second recovery attempt failed",
    }));
    const reparsedBlocked = valueOf(parseRemediationState(jsonRoundTrip(secondBlocked)));
    if (reparsedBlocked.state !== "recoverable-blocked") throw new Error("expected blocked");
    expect(reparsedBlocked.recoveryAttemptIds).toEqual(["attempt.retry-first", "attempt.retry-second"]);
    expect(reparsedBlocked.consumedRecoveryReceiptIds).toEqual([]);

    const receipt = valueOf(recoveryReceiptFor(reparsedBlocked, "receipt.retry-second"));
    const recovered = valueOf(reduceRemediation(reparsedBlocked, {
      kind: "recovery-receipt-accepted",
      receipt,
    }));
    expect(recovered.recoveryAttemptIds).toEqual(["attempt.retry-first", "attempt.retry-second"]);
    expect(recovered.consumedRecoveryReceiptIds).toEqual(["receipt.retry-second"]);
    expect(parseRemediationState(jsonRoundTrip(recovered)).ok).toBe(true);
  });

  it("requires a fresh recovery attempt identity for each failure", () => {
    const { auditedState } = lifecycleStates();
    const blocked = valueOf(reduceRemediation(auditedState, {
      kind: "recoverable-effect-failed",
      recoveryAttemptId: "attempt.same",
      effectId: "effect.one",
      message: "first",
    }));
    const reused = reduceRemediation(blocked, {
      kind: "recoverable-effect-failed",
      recoveryAttemptId: "attempt.same",
      effectId: "effect.two",
      message: "second",
    });
    expect(reused.ok).toBe(false);
  });

  it("binds receipt ID, attempt, effect, predecessor, witness, run, and digest", () => {
    const blocked = valueOf(reduceRemediation(lifecycleStates().auditedState, {
      kind: "recoverable-effect-failed",
      recoveryAttemptId: "attempt.bound",
      effectId: "effect.bound",
      message: "failure",
    }));
    if (blocked.state !== "recoverable-blocked") throw new Error("expected blocked");
    const receipt = valueOf(recoveryReceiptFor(blocked, "receipt.bound"));
    const mutations = [
      { ...receipt, receiptId: "receipt.foreign" },
      { ...receipt, recoveryAttemptId: "attempt.foreign" },
      { ...receipt, runId: "run.foreign" },
      { ...receipt, effectId: "effect.foreign" },
      { ...receipt, predecessorState: "verified" },
      { ...receipt, witnessDigest: digest(777) },
      { ...receipt, digest: digest(778) },
    ];
    fc.assert(fc.property(fc.constantFrom(...mutations), (mutation) => {
      const result = reduceRemediation(blocked, { kind: "recovery-receipt-accepted", receipt: mutation });
      expect(result.ok).toBe(false);
    }));
  });

  it("rejects every undeclared event/state pair and keeps done monotonic", () => {
    const states = lifecycleStates();
    const blocked = valueOf(reduceRemediation(states.auditedState, {
      kind: "recoverable-effect-failed",
      recoveryAttemptId: "attempt.blocked",
      effectId: "effect.blocked",
      message: "blocked",
    }));
    if (blocked.state !== "recoverable-blocked") throw new Error("expected blocked");
    const events: Readonly<Record<RemediationEvent["kind"], RemediationEvent>> = {
      "support-path-registered": { kind: "support-path-registered", path: "engine/tests/second.test.ts" },
      "audit-succeeded": { kind: "audit-succeeded", audited: states.audit },
      "temporary-index-staged": { kind: "temporary-index-staged", staged: states.stage },
      "staged-set-verified": { kind: "staged-set-verified", verified: states.index },
      "index-installed": { kind: "index-installed", installation: states.prepared, receipt: installedReceipt(states.prepared) },
      "recoverable-effect-failed": { kind: "recoverable-effect-failed", recoveryAttemptId: "attempt.event", effectId: "effect.event", message: "failure" },
      "recovery-receipt-accepted": { kind: "recovery-receipt-accepted", receipt: valueOf(recoveryReceiptFor(blocked, "receipt.blocked")) },
    };
    const allowed: Readonly<Record<RemediationState["state"], readonly RemediationEvent["kind"][]>> = {
      "authority-frozen": ["support-path-registered", "audit-succeeded", "recoverable-effect-failed"],
      "paths-registered": ["support-path-registered", "audit-succeeded", "recoverable-effect-failed"],
      audited: ["temporary-index-staged", "recoverable-effect-failed"],
      "staged-temporary-index": ["staged-set-verified", "recoverable-effect-failed"],
      verified: ["index-installed", "recoverable-effect-failed"],
      "recoverable-blocked": ["recovery-receipt-accepted", "recoverable-effect-failed"],
      done: [],
    };
    const stateValues = [states.start, states.registered, states.auditedState, states.stagedState, states.verifiedState, blocked, states.done];
    const undeclared = stateValues.flatMap((state) => Object.values(events)
      .filter((event) => !allowed[state.state].includes(event.kind))
      .map((event) => ({ state, event })));
    fc.assert(fc.property(fc.constantFrom(...undeclared), ({ state, event }) => {
      const result = reduceRemediation(state, event);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("invalid-remediation-transition");
    }));
  });

  it("rejects stale and foreign installation receipts", () => {
    const states = lifecycleStates();
    const receipt = installedReceipt(states.prepared);
    const mutations = [
      { ...receipt, effectId: "effect.foreign" },
      { ...receipt, runId: "run.foreign" },
      { ...receipt, indexDigest: digest(444) },
      { ...receipt, witnessDigest: digest(445) },
    ];
    fc.assert(fc.property(fc.constantFrom(...mutations), (mutated) => {
      const result = reduceRemediation(states.verifiedState, {
        kind: "index-installed",
        installation: states.prepared,
        receipt: mutated,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("index-installation-receipt-mismatch");
    }));
  });

  it("strictly binds blocked recovery-attempt history to its predecessor during JSON replay", () => {
    const firstBlocked = valueOf(reduceRemediation(lifecycleStates().auditedState, {
      kind: "recoverable-effect-failed",
      recoveryAttemptId: "attempt.history-first",
      effectId: "effect.history-first",
      message: "first failure",
    }));
    if (firstBlocked.state !== "recoverable-blocked") throw new Error("expected first blocked state");
    const firstReceipt = valueOf(recoveryReceiptFor(firstBlocked, "receipt.history-first"));
    const recovered = valueOf(reduceRemediation(firstBlocked, {
      kind: "recovery-receipt-accepted",
      receipt: firstReceipt,
    }));
    const secondBlocked = valueOf(reduceRemediation(recovered, {
      kind: "recoverable-effect-failed",
      recoveryAttemptId: "attempt.history-second",
      effectId: "effect.history-second",
      message: "second failure",
    }));
    expect(parseRemediationState(jsonRoundTrip(secondBlocked)).ok).toBe(true);

    const mutations: readonly (readonly string[])[] = [
      ["attempt.history-second"],
      ["attempt.history-second", "attempt.history-first"],
      ["attempt.foreign", "attempt.history-second"],
      ["attempt.history-first", "attempt.history-first", "attempt.history-second"],
    ];
    for (const recoveryAttemptIds of mutations) {
      const mutated = jsonRoundTrip(secondBlocked) as { recoveryAttemptIds: string[] };
      mutated.recoveryAttemptIds = [...recoveryAttemptIds];
      const parsed = parseRemediationState(mutated);
      expect(parsed.ok, recoveryAttemptIds.join(",")).toBe(false);
      if (!parsed.ok) expect(parsed.error.kind).toBe("invalid-remediation-state");
    }
  });

  it("is total for hostile and revoked Proxy states and preserves a bounded parser cause", () => {
    const longCause = `proxy trap ${"x".repeat(1_000)}`;
    const hostileInputs = [
      new Proxy({}, { getPrototypeOf: () => { throw new Error(longCause); } }),
      new Proxy({}, { ownKeys: () => { throw new Error(longCause); } }),
      new Proxy({ state: "audited" }, {
        getOwnPropertyDescriptor: () => { throw new Error(longCause); },
      }),
    ];
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    hostileInputs.push(revoked.proxy);

    for (const raw of hostileInputs) {
      expect(() => parseRemediationState(raw)).not.toThrow();
      const parsed = parseRemediationState(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.kind).toBe("invalid-remediation-state");
        expect(parsed.error.cause).not.toBeNull();
        expect(parsed.error.cause!.message.length).toBeLessThanOrEqual(256);
      }
    }
  });

  it("is total and cause-preserving for hostile recoverable predecessor parsing", () => {
    const blocked = valueOf(reduceRemediation(lifecycleStates().auditedState, {
      kind: "recoverable-effect-failed",
      recoveryAttemptId: "attempt.hostile-predecessor",
      effectId: "effect.hostile-predecessor",
      message: "failure",
    }));
    const raw = jsonRoundTrip(blocked) as { predecessor: unknown };
    raw.predecessor = new Proxy({}, {
      getOwnPropertyDescriptor: () => { throw new TypeError("predecessor descriptor revoked"); },
    });
    expect(() => parseRemediationState(raw)).not.toThrow();
    const parsed = parseRemediationState(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.field).toBe("predecessor");
      expect(parsed.error.cause).toEqual({
        name: "TypeError",
        message: "predecessor descriptor revoked",
      });
    }

    const nested = jsonRoundTrip(blocked) as { predecessor: { authority: unknown } };
    nested.predecessor.authority = new Proxy({}, {
      ownKeys: () => { throw new TypeError("nested authority keys revoked"); },
    });
    const nestedParsed = parseRemediationState(nested);
    expect(nestedParsed.ok).toBe(false);
    if (!nestedParsed.ok) {
      expect(nestedParsed.error.field).toBe("predecessor.authority");
      expect(nestedParsed.error.cause).toEqual({
        name: "TypeError",
        message: "nested authority keys revoked",
      });
    }
  });

  it("guards hostile outer authority parsing in recoverable and done states", () => {
    const states = lifecycleStates();
    const blocked = valueOf(reduceRemediation(states.auditedState, {
      kind: "recoverable-effect-failed",
      recoveryAttemptId: "attempt.hostile-authority",
      effectId: "effect.hostile-authority",
      message: "failure",
    }));

    for (const variant of [blocked, states.done]) {
      const raw = jsonRoundTrip(variant) as { authority: unknown };
      raw.authority = new Proxy({}, {
        getPrototypeOf: () => { throw new TypeError(`${variant.state} authority revoked`); },
      });
      expect(() => parseRemediationState(raw)).not.toThrow();
      const parsed = parseRemediationState(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.field).toBe("authority");
        expect(parsed.error.cause).toEqual({
          name: "TypeError",
          message: `${variant.state} authority revoked`,
        });
      }
    }
  });

  it("strict state parser rejects unknown fields and cross-proof replacement", () => {
    const unknown = jsonRoundTrip(lifecycleStates().auditedState) as Record<string, unknown>;
    unknown.extra = true;
    expect(parseRemediationState(unknown).ok).toBe(false);

    const replaced = jsonRoundTrip(lifecycleStates().verifiedState) as { staged: { digest: string } };
    replaced.staged.digest = digest(999);
    expect(parseRemediationState(replaced).ok).toBe(false);
  });

  it("rejects same-run outer authority replacement in a done state", () => {
    const defaultScope = ["src/main.ts", "src/deleted.ts"] as const;
    const replacementScope = ["src/same-run-foreign.ts"] as const;
    const replacementAuthority = valueOf(freezePathAuthority(standaloneInput(replacementScope)));
    const replaced = jsonRoundTrip(lifecycleStates().done) as { authority: unknown };
    replaced.authority = jsonRoundTrip(replacementAuthority);

    const parsed = parseRemediationStateWithAuthority(
      replaced,
      standalonePublicationResolverForScopes([defaultScope, replacementScope]),
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.field).toBe("installation");
      expect(parsed.error.message).toContain("exact verified authority");
    }
  });
});
