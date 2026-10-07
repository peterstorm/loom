/**
 * The authoritative standalone-review fixture, shared by every suite that
 * needs REAL remediation authority.
 *
 * Building one is not a two-line affair: a genuine `FrozenPathAuthority`
 * requires a prepared standalone review, a published spawn batch, accepted
 * reviewer results, a proved complete roster, an aggregate, a refutation panel
 * driven to `done`, a finalized result, and the publication receipt that
 * resolves it. That is exactly why the DAG suites drove only their `blocked`
 * arms — the success path needed authority no test could cheaply construct, so
 * `remediation-operations`' documented safety property (the ONE conditional
 * edge into `EMIT_INTENT`) went unexercised.
 *
 * Extracted here verbatim from `remediation-machine.property.test.ts` so both
 * suites build the same authority from one definition rather than two.
 */
import { createHash } from "node:crypto";
import { legacyStandaloneContext, legacyFixtureReviewerProtocols } from "./standalone-reviewer-protocol";
import { buildStandaloneFindingBrief, type ReviewLens, type WaveFindingId } from "../../src/core/review-panel";
import {
  createStandaloneResultPublicationAuthorityResolver,
  type StandaloneResultPublicationAuthorityResolver,
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
  type InitialBatchPublicationIntent,
  type SpawnBatchAction,
  type SpawnRequest,
  type PublicationAuthorityResolver,
} from "../../src/core/orchestration-contract";
import {
  aggregateStandaloneReview,
  proveStandaloneRosterCompletion,
  parseAuthoritativeStandaloneReviewResult,
  reduceStandaloneReviewMachine,
  startStandaloneReviewMachine,
  type AuthoritativeStandaloneReviewResult,
} from "../../src/core/standalone-review";
import { standaloneCurrentPanelCriticals, type FrozenStandalonePanelAuthority } from "../../src/core/standalone-refutation-panel";
import { capturedReviewerResultFromText } from "../../src/core/standalone-reviewer-capture";
import { prepareStandaloneReview } from "../../src/core/standalone-review-preparation";
import { serializeAdjudicatedStandaloneReview } from "../../src/core/standalone-review-records";
import { type FrozenStandaloneReviewAuthority, type StandaloneReviewAggregate } from "../../src/core/standalone-review-model";
import { freezeStandaloneRefutationPanelAuthority, parseStandaloneRefutationCompletion, type StandaloneRefutationCompletionReceipt } from "../../src/core/standalone-refutation-completion";
import {
  deriveRefutationVerifierBinding,
  parseRefutationPanelAuthority,
  type RefutationPanelAuthority,
} from "../../src/core/panel-authority";
import {
  completePersistentRefutationPanel,
  panelRequestIdentity,
  startPersistentRefutationPanel,
  submitRefutationVerdict,
} from "../../src/core/persistent-panel";
import type { NonEmpty } from "../../src/core/orchestration-contract";

export const digest = (n: number): string => n.toString(16).padStart(64, "0").slice(-64);

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

function rawStandaloneAuthority(role: keyof typeof reviewerBindings, slot: number, attempt: 1 | 2, scope: readonly string[]) {
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
    contextDigest: legacyStandaloneContext({ runId: "run.remediation-1", requestId: `request:remediation:${slot}:${attempt}`, role, attempt, requiredSkill: null }, scope).digest,
    outputSlot: `transcripts/remediation-${slot}/attempt-${attempt}.raw`,
  };
}

function rawStandaloneRoster(scope: readonly string[]) {
  return (["code-reviewer", "type-design-analyzer"] as const).map((role, index) => ({
    slotId: `slot:remediation:${index + 1}`,
    attempts: ([1, 2] as const).map((attempt) => rawStandaloneAuthority(role, index + 1, attempt, scope)),
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

/**
 * Reconcile an initial batch publication into its spawn action, plus the receipt
 * bytes an authority resolver must return for it.
 *
 * Both fixture builders in this file constructed the receipt, encoded it, drove
 * `createInitialBatchPublicationReconciler` through the same two fake ports, and
 * unwrapped the action — verbatim. A fixture that publishes differently from its
 * sibling proves nothing about the contract the tests share.
 */
export function publishBatch(
  intent: InitialBatchPublicationIntent,
  requests: readonly unknown[],
): Readonly<{ action: SpawnBatchAction; receiptBytes: readonly number[] }> {
  const receipt: BatchPublishedReceipt = {
    schemaVersion: 1,
    kind: "batch-published",
    effectId: intent.identity.effectId,
    runId: intent.identity.runId,
    requestIds: intent.requestIds,
    contextDigests: intent.contextDigests,
    issuedRequests: intent.issuedRequests,
    publicationDigest: intent.identity.publicationDigest,
  };
  const receiptBytes = [...new TextEncoder().encode(JSON.stringify(receipt))];
  const issuance = createInitialBatchPublicationReconciler(
    createInitialPublicationEffectPort(() => ({ ok: true, value: receiptBytes })),
    createAtomicInitialPublicationClaimPort((claim) => ({
      ok: true,
      value: { schemaVersion: 1, kind: "initial-publication-claimed", key: claim.key, identity: claim.identity },
    })),
  )(intent);
  if (!issuance.ok) throw new Error(issuance.error.message);
  const action = spawnBatchAction(issuance.value, requests);
  if (!action.ok) throw new Error(action.error.message);
  return { action: action.value, receiptBytes };
}

export function upholdStandaloneCriticals(
  standaloneAuthority: FrozenStandaloneReviewAuthority,
  aggregate: StandaloneReviewAggregate,
  refute = false,
): Readonly<{
  frozen: FrozenStandalonePanelAuthority;
  authority: RefutationPanelAuthority;
  completion: StandaloneRefutationCompletionReceipt;
  resolver: PublicationAuthorityResolver;
}> {
  const panelRunId = standaloneAuthority.schemaVersion === 3 ? `${standaloneAuthority.runId}-refutation` : "run.remediation-refutation-1";
  const lenses = standaloneAuthority.schemaVersion === 3 ? ["reproduction", "intent", "blast-radius"] as const : ["reproduction", "intent"] as const;
  const binding = {
    profile: "refutation",
    pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
    claude: { harness: "claude-code", model: "opus" },
  } as const;
  const brief = buildStandaloneFindingBrief({ subjectId: aggregate.subjectId, findings: standaloneCurrentPanelCriticals(aggregate) });
  // Verifier roster identities are semantic: each slot derives from the run,
  // its lens, and the exact finding set.
  const findingIds = brief.findings.map(({ id }) => id) as unknown as NonEmpty<WaveFindingId>;
  const verifierSlots = lenses.map((lens, index) => {
    const derived = deriveRefutationVerifierBinding(
      panelRunId as import("../../src/core/orchestration-contract").OrchestrationRunId,
      lens as ReviewLens,
      findingIds,
    );
    if (!derived.ok) throw new Error(derived.errors.join("; "));
    return {
      slotId: derived.value.slotId,
      attempts: ([1, 2] as const).map((attempt, attemptIndex) => ({
        runId: panelRunId,
        requestId: derived.value.requestIds[attemptIndex],
        slotId: derived.value.slotId,
        program: "refutation-panel",
        role: "review-verifier-agent",
        attempt,
        modelProfile: binding.profile,
        harnessBinding: { pi: binding.pi, claude: binding.claude },
        requiredSkill: null,
        contextDigest: (900 + index * 10 + attempt).toString(16).padStart(64, "0"),
        outputSlot: `transcripts/remediation-panel-${index + 1}/attempt-${attempt}.raw`,
      })),
    };
  });
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
  const { action, receiptBytes } = publishBatch(intent.value, requests);
  const resolver = createPublicationAuthorityResolver(() => ({ ok: true, value: receiptBytes }));

  let panelState = startPersistentRefutationPanel(parsedAuthority.value).state;
  action.requests.forEach((request, index) => {
    const submitted = submitRefutationVerdict(
      panelState,
      resolver,
      panelRequestIdentity(request),
      JSON.stringify({
        criterion: lenses[index],
        verdicts: parsedAuthority.value.findings.map((finding) => ({
          finding_id: finding.id,
          verdict: refute ? "refuted" : "upheld",
          reasoning: `${lenses[index]} ${refute ? "refutes" : "confirms"} ${finding.id}`,
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
  return { frozen: frozen.value, authority: parsedAuthority.value, completion: completion.value, resolver };
}

export type AuthoritativeStandaloneInput = Readonly<{
  standaloneResult: AuthoritativeStandaloneReviewResult;
  publicationReceipt: ArtifactSetPublished;
}>;

export type AuthoritativeStandaloneFixture = Readonly<{
  input: AuthoritativeStandaloneInput;
  publicationResolver: StandaloneResultPublicationAuthorityResolver;
}>;

const standaloneFixtureCache = new Map<string, AuthoritativeStandaloneFixture>();

export function standaloneFixture(
  scope: readonly string[] = ["src/main.ts", "src/deleted.ts"],
  withCritical = false,
  options: Readonly<{ firstTranscript?: string; refute?: boolean }> = {},
): AuthoritativeStandaloneFixture {
  const cacheKey = JSON.stringify({ scope, withCritical, options });
  const cached = standaloneFixtureCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const prepared = prepareStandaloneReview({
    runId: "run.remediation-1",
    explicitScope: scope,
    changedPaths: {
      unstaged: scope, staged: [], committed: [], base_revision: null, head_revision: "0123456789abcdef0123456789abcdef01234567",
    },
    reviewMetadata: {
      requested_kinds: ["types"], docs_only: false, source_or_test_changed: false,
      types_changed: true, comments_changed: false, additions: 1, file_count: scope.length,
      new_structure: false, languages: ["TypeScript"],
    },
    scopeSafety: scope.map((path) => ({ path, status: "safe" as const })),
    roster: rawStandaloneRoster(scope),
  });
  if (!prepared.ok) throw new Error(prepared.error.errors.join("; "));
  const authority = prepared.value.authority;
  const requests = authority.roster.orderedSlots.map(({ attempts }) => attempts[0]);
  const rawRequests = requests.map(rawRequest);
  const intent = prepareInitialBatchPublicationIntent(authority.runId, "effect:remediation-review-batch", rawRequests);
  if (!intent.ok) throw new Error(intent.error.message);
  const { action, receiptBytes } = publishBatch(intent.value, rawRequests);
  const issuedBySlot = new Map(action.requests.map((request) => [request.authority.slotId, request] as const));
  const accepted = authority.roster.orderedSlots.map(({ slotId }, index) => {
    const request = issuedBySlot.get(slotId) as SpawnRequest;
    const transcript = index === 0 ? (options.firstTranscript ?? (withCritical ? criticalTranscript : cleanTranscript)) : cleanTranscript;
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
  const completion = proveStandaloneRosterCompletion(authority, registration, accepted, legacyFixtureReviewerProtocols(authority, registration, action.requests));
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
        const panel = upholdStandaloneCriticals(authority, aggregate.value.aggregate, options.refute);
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

export function standaloneInput(
  scope: readonly string[] = ["src/main.ts", "src/deleted.ts"],
): AuthoritativeStandaloneInput {
  return standaloneFixture(scope).input;
}

export function standalonePublicationResolver(
  scope: readonly string[] = ["src/main.ts", "src/deleted.ts"],
): StandaloneResultPublicationAuthorityResolver {
  return standaloneFixture(scope).publicationResolver;
}

export function standalonePublicationResolverForScopes(
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
