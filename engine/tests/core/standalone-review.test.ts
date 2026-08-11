import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildStandaloneFindingBrief, parseFindingBriefJson, serializeFindingBrief } from "../../src/core/review-panel";
import {
  acceptedAgentResult,
  createAtomicInitialPublicationClaimPort,
  createInitialBatchPublicationReconciler,
  createInitialPublicationEffectPort,
  createPublicationAuthorityResolver,
  parseArtifactDigest,
  parseArtifactRef,
  parseCompleteRoster,
  parseEffectId,
  parseExactRoster,
  prepareInitialBatchPublicationIntent,
  spawnBatchAction,
  type AcceptedAgentResult,
  type AgentRequestAuthority,
  type BatchPublishedReceipt,
  type CompleteRoster,
  type PublicationAuthorityResolver,
  type SpawnRequest,
} from "../../src/core/orchestration-contract";
import {
  STANDALONE_REVIEW_SUBJECT,
  aggregateLegacyStandaloneReview,
  aggregateStandaloneReview,
  bindStandaloneCaptureAuthority,
  captureStandaloneReviewerBytes,
  capturedReviewerResultFromBytes,
  capturedReviewerResultFromText,
  completeStandaloneReviewerCapture,
  finalizeStandaloneReview,
  fingerprintCapturedReviewerResult,
  parseAdjudicatedStandaloneReview,
  parseCapturedReviewerResult,
  parsePreparedStandaloneReviewerCapture,
  parseStandaloneAggregate,
  parseStandaloneCaptureAuthority,
  parseStandalonePanelOutcomes,
  prepareFreshStandaloneReview,
  proveStandaloneRosterCompletion,
  parseStandaloneRosterCompletionProof,
  prepareStandaloneReview,
  serializeAdjudicatedStandaloneReview,
  serializeStandaloneAggregate,
  serializeStandaloneReviewAuthority,
  parseStandaloneReviewAuthority,
  type CapturedReviewerResult,
  type FrozenStandalonePanelAuthority,
  type FrozenStandaloneReviewAuthority,
  type StandaloneReviewerRole,
  type StandaloneRosterCompletionProof,
} from "../../src/core/standalone-review";
import {
  STANDALONE_REVIEW_DECLARED_TRANSITIONS,
  freezeStandaloneRefutationPanelAuthority,
  isDeclaredStandaloneReviewTransition,
  parseStandaloneRefutationCompletion,
  parseAuthoritativeStandaloneReviewResult,
  reduceStandaloneReviewMachine,
  parseStandaloneReviewMachineState,
  serializeStandaloneReviewMachineState,
  startStandaloneReviewMachine,
  type StandaloneRefutationCompletionReceipt,
  type StandaloneReviewMachineEvent,
} from "../../src/core/standalone-review-machine";
import { prepareStandaloneReviewHarnessCapture } from "../../src/handlers/helpers/standalone-review";
import {
  completePersistentRefutationPanel,
  panelRequestIdentity,
  parseRefutationPanelAuthority,
  refutationPanelCheckpoint,
  startPersistentRefutationPanel,
  submitRefutationVerdict,
  type PersistentRefutationPanelEvent,
  type RefutationPanelAuthority,
  type RefutationPanelCheckpoint,
  type RefutationPanelState,
} from "../../src/core/panel-program";

const transcript = (critical: string[] = [], advisory: string[] = []) => [
  "### Machine Summary",
  `CRITICAL_COUNT: ${critical.length}`,
  `ADVISORY_COUNT: ${advisory.length}`,
  ...critical.map((claim) => `CRITICAL: ${claim}`),
  ...advisory.map((claim) => `ADVISORY: ${claim}`),
  "",
  "```findings",
  JSON.stringify([
    ...critical.map((claim) => ({ severity: "critical", file: "src/x.ts", line: 3, claim })),
    ...advisory.map((claim) => ({ severity: "advisory", file: "src/x.ts", line: 4, claim })),
  ]),
  "```",
].join("\n");

interface MutablePanelOutcome {
  finding_id: string;
  task_id: string;
  claim: string;
  survives: boolean;
  refuted_by: string[];
  reasoning: string[];
  upheld_by: string[];
  uncertain_from: string[];
}

interface MutablePanelOutcomes {
  lenses: string[];
  threshold: number;
  surviving: number;
  refuted: number;
  outcomes: MutablePanelOutcome[];
}

function required() {
  const result = aggregateLegacyStandaloneReview({
    runId: "run.abc",
    scope: ["src/x.ts"],
    transcripts: [
      { agent: "code-reviewer", output: transcript(["real blocker"], ["small improvement"]) },
      { agent: "type-design-analyzer", output: transcript(["duplicate wording"]) },
    ],
  });
  expect(result.ok).toBe(true);
  if (!result.ok || result.value.kind !== "requires-refutation") throw new Error("expected criticals");
  return result.value;
}

describe("standalone review aggregate", () => {
  it("parses, attributes, and preserves findings from every reviewer", () => {
    const state = required();
    expect(state.criticals.map((finding) => finding.id)).toEqual(["code-reviewer-1", "type-design-analyzer-1"]);
    expect(state.aggregate.findings.map((finding) => finding.claim)).toEqual([
      "real blocker", "small improvement", "duplicate wording",
    ]);
  });

  it("fails closed when any reviewer omits its evidence marker", () => {
    const result = aggregateLegacyStandaloneReview({
      runId: "run.abc",
      scope: ["src/x.ts"],
      transcripts: [{ agent: "code-reviewer", output: "looks fine" }],
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join("\n")).toContain("CRITICAL_COUNT marker not found");
  });

  it.each([
    ["absolute", "/tmp/outside.ts", "repository-relative"],
    ["drive-absolute", "C:/outside.ts", "repository-relative"],
    ["traversal", "src/../../outside.ts", "canonical"],
    ["dot alias", "./src/x.ts", "canonical"],
    ["repeated separator", "src//x.ts", "canonical"],
    ["backslash alias", "src\\x.ts", "POSIX"],
    ["newline", "src/bad\npath.ts", "single line without NUL"],
    ["NUL", "src/bad\0path.ts", "NUL"],
  ])("rejects malformed %s scope paths", (_label, scopePath, message) => {
    const result = aggregateLegacyStandaloneReview({
      runId: "run.abc",
      scope: [scopePath],
      transcripts: [{ agent: "code-reviewer", output: transcript() }],
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join("\n")).toContain(message);
  });

  it("rejects duplicate canonical scope paths", () => {
    const result = aggregateLegacyStandaloneReview({
      runId: "run.abc",
      scope: ["src/x.ts", "src/x.ts"],
      transcripts: [{ agent: "code-reviewer", output: transcript() }],
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join("\n")).toContain("must be distinct");
  });

  it("rejects a transcript finding outside the frozen scope", () => {
    const result = aggregateLegacyStandaloneReview({
      runId: "run.abc",
      scope: ["src/inside.ts"],
      transcripts: [{ agent: "code-reviewer", output: transcript(["outside blocker"]) }],
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join("\n")).toContain(
      "code-reviewer findings[0].file is outside the frozen review scope: src/x.ts",
    );
  });

  it("preserves an honestly unlocated finding while enforcing scope on located findings", () => {
    const output = transcript(["unlocated blocker"]).replace(
      '"file":"src/x.ts"',
      '"file":null',
    );
    const result = aggregateLegacyStandaloneReview({
      runId: "run.abc",
      scope: ["src/x.ts"],
      transcripts: [{ agent: "code-reviewer", output }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.aggregate.findings[0]?.file).toBeNull();
  });

  it("represents zero criticals as an explicit clean state", () => {
    const result = aggregateLegacyStandaloneReview({
      runId: "run.abc",
      scope: ["src/x.ts"],
      transcripts: [{ agent: "code-reviewer", output: transcript([], ["small improvement"]) }],
    });
    expect(result.ok && result.value.kind).toBe("clean");
  });

  it("round-trips the aggregate through its untrusted boundary", () => {
    const aggregate = required().aggregate;
    const parsed = parseStandaloneAggregate(JSON.parse(serializeStandaloneAggregate(aggregate)));
    expect(parsed).toEqual({ ok: true, value: aggregate });
  });

  it("rejects a stored aggregate tampered with an out-of-scope finding", () => {
    const raw = JSON.parse(serializeStandaloneAggregate(required().aggregate));
    raw.findings[0].file = "src/outside.ts";
    const parsed = parseStandaloneAggregate(raw);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.errors.join("\n")).toContain(
      "aggregate.findings[0].file is outside the frozen review scope: src/outside.ts",
    );
  });

  it("accepts and round-trips a stored aggregate with a null finding location", () => {
    const raw = JSON.parse(serializeStandaloneAggregate(required().aggregate));
    raw.findings[0].file = null;
    raw.findings[0].line = null;
    const parsed = parseStandaloneAggregate(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.findings[0]?.file).toBeNull();
  });
});

describe("standalone brief source invariant", () => {
  it("constructs only canonical standalone subjects and round-trips its output", () => {
    const brief = buildStandaloneFindingBrief(required().aggregate);
    expect(brief.taskIds).toEqual([STANDALONE_REVIEW_SUBJECT]);
    expect(brief.findings.every((finding) => finding.taskId === STANDALONE_REVIEW_SUBJECT)).toBe(true);
    expect(parseFindingBriefJson(JSON.parse(serializeFindingBrief(brief)))).toEqual({ ok: true, value: brief });
  });

  it("rejects a standalone source flag on a non-standalone subject", () => {
    const parsed = parseFindingBriefJson({
      wave: 9,
      source_kind: "standalone",
      severity: "critical",
      task_ids: ["T1"],
      findings: [{
        id: "T1:code-reviewer-1", task_id: "T1", agent: "code-reviewer",
        severity: "critical", file: null, line: null, claim: "blocker",
      }],
    });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.errors.join("\n")).toContain("standalone brief.wave must be 1");
    expect(!parsed.ok && parsed.errors.join("\n")).toContain("standalone brief.task_ids must be exactly");
  });
});

describe("standalone review adjudication", () => {
  it("partitions every critical into surviving or audibly refuted", () => {
    const state = required();
    const raw = {
      lenses: ["reproduction", "intent", "blast-radius"],
      threshold: 2,
      surviving: 1,
      refuted: 1,
      outcomes: state.criticals.map((finding, index) => ({
        finding_id: `${STANDALONE_REVIEW_SUBJECT}:${finding.id}`,
        task_id: STANDALONE_REVIEW_SUBJECT,
        claim: finding.claim,
        survives: index === 0,
        refuted_by: index === 0 ? [] : ["reproduction", "intent"],
        reasoning: index === 0 ? [] : ["cannot trigger", "deliberate"],
        upheld_by: index === 0 ? ["reproduction", "intent"] : ["blast-radius"],
        uncertain_from: index === 0 ? ["blast-radius"] : [],
      })),
    };
    const panel = parseStandalonePanelOutcomes(
      raw,
      state.criticals,
      buildStandaloneFindingBrief(state.aggregate).findings,
      ["reproduction", "intent", "blast-radius"],
    );
    expect(panel.ok).toBe(true);
    if (!panel.ok) return;
    expect(panel.value.outcomes[1]?.refutations).toEqual([
      { lens: "reproduction", reason: "cannot trigger" },
      { lens: "intent", reason: "deliberate" },
    ]);
    const result = finalizeStandaloneReview(state.aggregate, panel.value);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.survivingCriticals.map((finding) => finding.claim)).toEqual(["real blocker"]);
    expect(result.value.refutedCriticals[0]?.finding.claim).toBe("duplicate wording");
    expect(result.value.refutedCriticals[0]?.refutations).toEqual([
      { lens: "reproduction", reason: "cannot trigger" },
      { lens: "intent", reason: "deliberate" },
    ]);
    expect(result.value.advisories.map((finding) => finding.claim)).toEqual(["small improvement"]);
    const serialized = JSON.parse(serializeAdjudicatedStandaloneReview(result.value));
    expect(parseAdjudicatedStandaloneReview(serialized).ok).toBe(false);
  });

  it("rejects missing, foreign, duplicate, or threshold-inconsistent outcomes", () => {
    const state = required();
    const one = state.criticals[0]!;
    const parsed = parseStandalonePanelOutcomes({
      lenses: ["reproduction", "intent", "blast-radius"], threshold: 2,
      outcomes: [{
        finding_id: `${STANDALONE_REVIEW_SUBJECT}:${one.id}`,
        claim: one.claim,
        survives: false,
        refuted_by: ["intent"], reasoning: ["not enough"], upheld_by: [], uncertain_from: [],
      }],
    }, state.criticals, buildStandaloneFindingBrief(state.aggregate).findings, ["reproduction", "intent", "blast-radius"]);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.errors.join("\n")).toContain("must meet threshold");
    expect(!parsed.ok && parsed.errors.join("\n")).toContain("missing critical finding");
  });

  it.each([
    ["canonical claim", (raw: MutablePanelOutcomes) => { raw.outcomes[0]!.claim = "forged claim"; }],
    ["vote partition", (raw: MutablePanelOutcomes) => { raw.outcomes[0]!.upheld_by.push("reproduction"); }],
    ["refutation reasoning", (raw: MutablePanelOutcomes) => { raw.outcomes[1]!.reasoning.pop(); }],
    ["derived counts", (raw: MutablePanelOutcomes) => { raw.surviving = 2; raw.refuted = 0; }],
  ])("rejects a %s mismatch in canonical panel outcomes", (_label, corrupt) => {
    const state = required();
    const panelFindings = buildStandaloneFindingBrief(state.aggregate).findings;
    const raw: MutablePanelOutcomes = {
      lenses: ["reproduction", "intent", "blast-radius"],
      threshold: 2,
      surviving: 1,
      refuted: 1,
      outcomes: state.criticals.map((finding, index) => ({
        finding_id: `${STANDALONE_REVIEW_SUBJECT}:${finding.id}`,
        task_id: STANDALONE_REVIEW_SUBJECT,
        claim: finding.claim,
        survives: index === 0,
        refuted_by: index === 0 ? [] : ["reproduction", "intent"],
        reasoning: index === 0 ? [] : ["cannot trigger", "deliberate"],
        upheld_by: index === 0 ? ["reproduction", "intent"] : ["blast-radius"],
        uncertain_from: index === 0 ? ["blast-radius"] : [],
      })),
    };
    corrupt(raw);

    const parsed = parseStandalonePanelOutcomes(
      raw,
      state.criticals,
      panelFindings,
      ["reproduction", "intent", "blast-radius"],
    );

    expect(parsed.ok).toBe(false);
  });

  it("deep-copies and freezes every nested panel outcome, vote, and refutation record", () => {
    const aggregated = aggregateLegacyStandaloneReview({
      runId: "run.freeze-panel",
      scope: ["src/x.ts"],
      transcripts: [{ agent: "code-reviewer", output: transcript(["mutable blocker"]) }],
    });
    if (!aggregated.ok || aggregated.value.kind !== "requires-refutation") throw new Error("critical fixture required");
    const finding = aggregated.value.criticals[0]!;
    const panelFindings = buildStandaloneFindingBrief(aggregated.value.aggregate).findings;
    const raw: MutablePanelOutcomes = {
      lenses: ["reproduction", "intent"], threshold: 2, surviving: 0, refuted: 1,
      outcomes: [{
        finding_id: `${STANDALONE_REVIEW_SUBJECT}:${finding.id}`,
        task_id: STANDALONE_REVIEW_SUBJECT,
        claim: panelFindings[0]!.claim,
        survives: false,
        refuted_by: ["reproduction", "intent"],
        reasoning: ["cannot reproduce", "contradicts intent"],
        upheld_by: [], uncertain_from: [],
      }],
    };
    const parsed = parseStandalonePanelOutcomes(
      raw, aggregated.value.criticals, panelFindings, ["reproduction", "intent"],
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    raw.outcomes[0]!.reasoning[0] = "mutated after proof";
    raw.outcomes[0]!.refuted_by.length = 0;
    expect(parsed.value.outcomes[0]?.refutations[0]).toEqual({
      lens: "reproduction", reason: "cannot reproduce",
    });
    expect(Object.isFrozen(parsed.value)).toBe(true);
    expect(Object.isFrozen(parsed.value.outcomes)).toBe(true);
    expect(Object.isFrozen(parsed.value.outcomes[0])).toBe(true);
    expect(Object.isFrozen(parsed.value.outcomes[0]!.refutations)).toBe(true);
    expect(Object.isFrozen(parsed.value.outcomes[0]!.refutations[0])).toBe(true);
    expect(Object.isFrozen(parsed.value.outcomes[0]!.upheldBy)).toBe(true);
    expect(() => (parsed.value.outcomes[0]!.refutations as unknown as Array<{ lens: string; reason: string }>).push({
      lens: "forged", reason: "forged",
    })).toThrow();
  });

  it("accepts sanitized panel claims while retaining the original aggregate claim", () => {
    const aggregated = aggregateLegacyStandaloneReview({
      runId: "run.braces",
      scope: ["src/x.ts"],
      transcripts: [{ agent: "code-reviewer", output: transcript(["the {config} value is unchecked"]) }],
    });
    expect(aggregated.ok).toBe(true);
    if (!aggregated.ok || aggregated.value.kind !== "requires-refutation") return;
    const panelFindings = buildStandaloneFindingBrief(aggregated.value.aggregate).findings;
    expect(panelFindings[0]?.claim).toBe("the config value is unchecked");
    const raw = {
      lenses: ["reproduction", "intent"], threshold: 2, surviving: 1, refuted: 0,
      outcomes: [{
        finding_id: panelFindings[0]!.id,
        task_id: STANDALONE_REVIEW_SUBJECT,
        claim: panelFindings[0]!.claim,
        survives: true,
        refuted_by: [], reasoning: [], upheld_by: ["reproduction", "intent"], uncertain_from: [],
      }],
    };
    const parsed = parseStandalonePanelOutcomes(
      raw,
      aggregated.value.criticals,
      panelFindings,
      ["reproduction", "intent"],
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const finalized = finalizeStandaloneReview(aggregated.value.aggregate, parsed.value);
    expect(finalized.ok).toBe(true);
    if (finalized.ok) {
      expect(finalized.value.survivingCriticals[0]?.claim).toBe("the {config} value is unchecked");
    }
  });

  it("cannot finalize critical findings without a panel", () => {
    const result = finalizeStandaloneReview(required().aggregate, null);
    expect(result).toEqual({ ok: false, errors: ["standalone review has unadjudicated critical findings"] });
  });
});

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
    runId: "run.review-1",
    requestId: `request:${slot}:${attempt}`,
    slotId: `slot:${slot}`,
    program: "standalone-review",
    role,
    attempt,
    modelProfile: binding.profile,
    harnessBinding: { pi: binding.pi, claude: binding.claude },
    requiredSkill: null,
    contextDigest: (slot * 10 + attempt).toString(16).padStart(64, "0"),
    outputSlot: `transcripts/slot-${slot}/attempt-${attempt}.raw`,
  };
}

function rawStandaloneRoster() {
  return (["code-reviewer", "type-design-analyzer"] as const).map((role, index) => ({
    slotId: `slot:${index + 1}`,
    attempts: [
      rawStandaloneAuthority(role, index + 1, 1),
      rawStandaloneAuthority(role, index + 1, 2),
    ],
  }));
}

function preparationInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    runId: "run.review-1",
    explicitScope: ["src/x.ts"],
    changedPaths: {
      unstaged: ["src/x.ts"], staged: [], committed: [],
      base_revision: null, head_revision: "HEAD",
    },
    reviewMetadata: {
      requested_kinds: ["types"], docs_only: false, source_or_test_changed: false,
      types_changed: true, comments_changed: false, additions: 1, file_count: 1,
      new_structure: false, languages: ["TypeScript"],
    },
    scopeSafety: [{ path: "src/x.ts", status: "safe" }],
    roster: rawStandaloneRoster(),
    ...overrides,
  };
}

function preparedAuthority(): FrozenStandaloneReviewAuthority {
  const prepared = prepareStandaloneReview(preparationInput());
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error(prepared.error.errors.join("; "));
  return prepared.value.authority;
}

function rawRequest(request: AgentRequestAuthority) {
  return {
    authority: request,
    context: {
      digest: request.contextDigest,
      slot: `contexts/${request.contextDigest}.json`,
    },
  };
}

interface ProvenCapturedRoster {
  readonly roster: CompleteRoster<AcceptedAgentResult<CapturedReviewerResult>>;
  readonly completion: StandaloneRosterCompletionProof;
  readonly resolver: PublicationAuthorityResolver;
}

function completeCapturedRoster(
  authority: FrozenStandaloneReviewAuthority,
  outputs: readonly string[],
  completionOrder: readonly number[] = [0, 1],
): ProvenCapturedRoster {
  const requests = authority.roster.orderedSlots.map((slot) => slot.attempts[0]);
  const rawRequests = requests.map(rawRequest);
  const intent = prepareInitialBatchPublicationIntent(authority.runId, "effect:review-batch", rawRequests);
  expect(intent.ok).toBe(true);
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
  const bytes = [...new TextEncoder().encode(JSON.stringify(receipt))];
  const reconciler = createInitialBatchPublicationReconciler(
    createInitialPublicationEffectPort(() => ({ ok: true, value: bytes })),
    createAtomicInitialPublicationClaimPort((claim) => ({
      ok: true,
      value: {
        schemaVersion: 1,
        kind: "initial-publication-claimed",
        key: claim.key,
        identity: claim.identity,
      },
    })),
  );
  const issuance = reconciler(intent.value);
  expect(issuance.ok).toBe(true);
  if (!issuance.ok) throw new Error(issuance.error.message);
  const action = spawnBatchAction(issuance.value, rawRequests);
  expect(action.ok).toBe(true);
  if (!action.ok) throw new Error(action.error.message);
  const issuedBySlot = new Map(action.value.requests.map((request) => [request.authority.slotId, request] as const));
  const accepted = outputs.map((output, index) => {
    const request = issuedBySlot.get(authority.roster.orderedSlots[index]!.slotId) as SpawnRequest;
    const rawBytes = Buffer.from(output, "utf-8");
    const artifact = parseArtifactRef({
      runId: authority.runId,
      slot: request.authority.outputSlot,
      digest: createHash("sha256").update(rawBytes).digest("hex"),
      byteLength: rawBytes.byteLength,
    });
    expect(artifact.ok).toBe(true);
    if (!artifact.ok) throw new Error(artifact.error.message);
    const captured = capturedReviewerResultFromText(artifact.value, output);
    expect(captured.ok).toBe(true);
    if (!captured.ok) throw new Error(captured.error.message);
    const result = acceptedAgentResult(request, captured.value);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  });
  const registration = createPublicationAuthorityResolver(() => ({ ok: true, value: bytes }));
  const exact = parseExactRoster(rawStandaloneRoster());
  expect(exact.ok).toBe(true);
  if (!exact.ok) throw new Error("exact roster failed");
  const complete = parseCompleteRoster(
    registration,
    exact.value,
    completionOrder.map((index) => accepted[index]),
    parseCapturedReviewerResult,
  );
  expect(complete.ok).toBe(true);
  if (!complete.ok) throw new Error(complete.error.violations.map(({ kind }) => kind).join(","));
  const completion = proveStandaloneRosterCompletion(
    authority,
    registration,
    completionOrder.map((index) => accepted[index]),
  );
  expect(completion.ok).toBe(true);
  if (!completion.ok) throw new Error(completion.error.violations.map(({ kind }) => kind).join(","));
  return { roster: complete.value, completion: completion.value, resolver: registration };
}

function completedRefutationPanel(
  standaloneAuthority: FrozenStandaloneReviewAuthority,
  aggregate: ReturnType<typeof required>["aggregate"],
): Readonly<{
  frozen: FrozenStandalonePanelAuthority;
  authority: RefutationPanelAuthority;
  completed: RefutationPanelState;
  checkpoint: RefutationPanelCheckpoint;
  completion: StandaloneRefutationCompletionReceipt;
  resolver: PublicationAuthorityResolver;
}> {
  const panelRunId = "run.refutation-review-1";
  const binding = {
    profile: "refutation",
    pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
    claude: { harness: "claude-code", model: "opus" },
  } as const;
  const lenses = ["reproduction", "intent"] as const;
  const verifierSlots = lenses.map((_, index) => ({
    slotId: `panel-slot:${index + 1}`,
    attempts: ([1, 2] as const).map((attempt) => ({
      runId: panelRunId,
      requestId: `panel-request:${index + 1}:${attempt}`,
      slotId: `panel-slot:${index + 1}`,
      program: "refutation-panel",
      role: "review-verifier-agent",
      attempt,
      modelProfile: binding.profile,
      harnessBinding: { pi: binding.pi, claude: binding.claude },
      requiredSkill: null,
      contextDigest: (900 + index * 10 + attempt).toString(16).padStart(64, "0"),
      outputSlot: `transcripts/panel-${index + 1}/attempt-${attempt}.raw`,
    })),
  }));
  const brief = buildStandaloneFindingBrief(aggregate);
  const parsedAuthority = parseRefutationPanelAuthority({
    runId: panelRunId,
    findings: brief.findings,
    lenses,
    verifierSlots,
  });
  expect(parsedAuthority.ok).toBe(true);
  if (!parsedAuthority.ok) throw new Error(parsedAuthority.error.message);
  const panelAuthority: RefutationPanelAuthority = parsedAuthority.value;
  const frozen = freezeStandaloneRefutationPanelAuthority({
    standaloneAuthority,
    aggregate,
    panelAuthority,
    threshold: 2,
  });
  expect(frozen.ok).toBe(true);
  if (!frozen.ok) throw new Error(frozen.error.message);

  const requests = panelAuthority.verifierRoster.orderedSlots.map(({ attempts }) => rawRequest(attempts[0]));
  const intent = prepareInitialBatchPublicationIntent(panelRunId, "effect:panel-batch", requests);
  expect(intent.ok).toBe(true);
  if (!intent.ok) throw new Error(intent.error.message);
  const rawReceipt = {
    schemaVersion: 1 as const,
    kind: "batch-published" as const,
    effectId: intent.value.identity.effectId,
    runId: intent.value.identity.runId,
    requestIds: intent.value.requestIds,
    contextDigests: intent.value.contextDigests,
    issuedRequests: intent.value.issuedRequests,
    publicationDigest: intent.value.identity.publicationDigest,
  };
  const publicationBytes = [...new TextEncoder().encode(JSON.stringify(rawReceipt))];
  const reconciler = createInitialBatchPublicationReconciler(
    createInitialPublicationEffectPort(() => ({ ok: true, value: publicationBytes })),
    createAtomicInitialPublicationClaimPort((claim) => ({
      ok: true,
      value: { schemaVersion: 1, kind: "initial-publication-claimed", key: claim.key, identity: claim.identity },
    })),
  );
  const issuance = reconciler(intent.value);
  expect(issuance.ok).toBe(true);
  if (!issuance.ok) throw new Error(issuance.error.message);
  const action = spawnBatchAction(issuance.value, requests);
  expect(action.ok).toBe(true);
  if (!action.ok) throw new Error(action.error.message);
  const resolver = createPublicationAuthorityResolver(() => ({ ok: true, value: publicationBytes }));

  let state = startPersistentRefutationPanel(panelAuthority).state;
  const events: PersistentRefutationPanelEvent[] = [];
  action.value.requests.forEach((request, index) => {
    const submitted = submitRefutationVerdict(
      state,
      resolver,
      panelRequestIdentity(request),
      JSON.stringify({
        criterion: lenses[index],
        verdicts: panelAuthority.findings.map((finding) => ({
          finding_id: finding.id,
          verdict: "refuted",
          reasoning: `${lenses[index]} disproves ${finding.id}`,
        })),
      }),
    );
    expect(submitted.ok).toBe(true);
    if (!submitted.ok || submitted.value.recordedEvent === undefined) {
      throw new Error(submitted.ok ? "submitted panel verdict did not record an event" : submitted.error.message);
    }
    events.push(submitted.value.recordedEvent);
    state = submitted.value.state;
  });
  const done = completePersistentRefutationPanel(state, resolver, 2);
  expect(done.ok && done.value.state.stage).toBe("done");
  if (!done.ok || done.value.state.stage !== "done" || done.value.recordedEvent === undefined) {
    throw new Error("completed panel required");
  }
  events.push(done.value.recordedEvent);
  const checkpoint = refutationPanelCheckpoint(done.value.state, events, resolver);
  expect(checkpoint.ok).toBe(true);
  if (!checkpoint.ok) throw new Error(checkpoint.error.message);
  const completion = parseStandaloneRefutationCompletion({
    panelAuthority: frozen.value,
    aggregate,
    completedPanelState: done.value.state,
  });
  expect(completion.ok).toBe(true);
  if (!completion.ok) throw new Error(completion.error.message);
  return {
    frozen: frozen.value,
    authority: panelAuthority,
    completed: done.value.state,
    checkpoint: checkpoint.value,
    completion: completion.value,
    resolver,
  };
}

describe("standalone v1 authority and byte-aware complete-roster aggregation", () => {
  it("derives only the sorted canonical changed-path union when explicit scope is absent", () => {
    const prepared = prepareStandaloneReview(preparationInput({
      explicitScope: undefined,
      changedPaths: {
        unstaged: ["src/z.ts"], staged: ["src/a.ts"], committed: ["src/z.ts"],
        base_revision: "main", head_revision: "HEAD",
      },
      scopeSafety: [
        { path: "src/a.ts", status: "safe" },
        { path: "src/z.ts", status: "absent" },
      ],
    }));
    expect(prepared.ok).toBe(true);
    if (prepared.ok) {
      expect(prepared.value.authority.scopeSource).toBe("changed-path-union");
      expect(prepared.value.authority.scope).toEqual(["src/a.ts", "src/z.ts"]);
    }
  });

  it.each([
    ["empty explicit", { explicitScope: [] }],
    ["traversal", { explicitScope: ["src/../../outside.ts"] }],
    ["external", { explicitScope: ["/tmp/outside.ts"] }],
    ["unsafe", { scopeSafety: [{ path: "src/x.ts", status: "symlink" }] }],
  ])("blocks %s scope rather than broadening it", (_label, override) => {
    const prepared = prepareStandaloneReview(preparationInput(override));
    expect(prepared.ok).toBe(false);
  });

  it("round-trips all frozen v1 authority including request/model/context/output slots", () => {
    const authority = preparedAuthority();
    const parsed = parseStandaloneReviewAuthority(JSON.parse(serializeStandaloneReviewAuthority(authority)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.roster.orderedSlots.map((slot) => slot.attempts.map((request) => ({
        requestId: request.requestId,
        model: request.modelProfile,
        context: request.contextDigest,
        output: request.outputSlot.path,
      })))).toEqual(authority.roster.orderedSlots.map((slot) => slot.attempts.map((request) => ({
        requestId: request.requestId,
        model: request.modelProfile,
        context: request.contextDigest,
        output: request.outputSlot.path,
      }))));
    }
  });

  it("preserves UTF-8 bytes and canonical roster order independent of completion order", () => {
    const authority = preparedAuthority();
    const first = transcript([], ["snowman ☃"]);
    const second = transcript(["typed blocker"]);
    const complete = completeCapturedRoster(authority, [first, second], [1, 0]);
    const aggregated = aggregateStandaloneReview({ authority, completion: complete.completion });
    expect(aggregated.ok).toBe(true);
    if (!aggregated.ok) return;
    expect(aggregated.value.aggregate.reviewerEvidence.map(({ agent }) => agent)).toEqual([
      "code-reviewer", "type-design-analyzer",
    ]);
    expect(aggregated.value.aggregate.reviewerEvidence[0]?.artifact.byteLength).toBe(Buffer.byteLength(first, "utf-8"));
    expect(aggregated.value.kind).toBe("requires-refutation");
  });

  it("rejects invalid UTF-8 captured bytes before findings parsing", () => {
    const authority = preparedAuthority();
    const complete = completeCapturedRoster(authority, [transcript(), transcript()]);
    const issued = complete.roster.ordered[0]!.issuedRequest;
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x61]);
    const artifact = parseArtifactRef({
      runId: authority.runId,
      slot: issued.authority.outputSlot,
      digest: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
    });
    if (!artifact.ok) throw new Error(artifact.error.message);
    const captured = capturedReviewerResultFromBytes(artifact.value, bytes);
    if (!captured.ok) throw new Error(captured.error.message);
    const accepted = acceptedAgentResult(issued, captured.value);
    if (!accepted.ok) throw new Error(accepted.error.message);
    const reproved = proveStandaloneRosterCompletion(authority, complete.resolver, [
      accepted.value,
      complete.roster.ordered[1]!,
    ]);
    expect(reproved.ok).toBe(true);
    if (!reproved.ok) return;
    const aggregated = aggregateStandaloneReview({ authority, completion: reproved.value });
    expect(aggregated.ok).toBe(false);
    expect(!aggregated.ok && aggregated.errors.join("\n")).toContain("not valid UTF-8 semantic output");
    expect(!aggregated.ok && aggregated.errors.join("\n")).not.toContain("CRITICAL_COUNT marker not found");
  });

  it("fails closed when captured byte metadata is stale", () => {
    const output = transcript();
    const artifact = parseArtifactRef({
      runId: "run.review-1", slot: "transcripts/slot-1/attempt-1.raw",
      digest: "0".repeat(64), byteLength: Buffer.byteLength(output, "utf-8"),
    });
    expect(artifact.ok).toBe(true);
    if (!artifact.ok) return;
    expect(capturedReviewerResultFromText(artifact.value, output).ok).toBe(false);
  });
});

describe("fresh preparation and request-bound byte capture", () => {
  it("constructs fresh run/roster authority without caller-authored attribution", () => {
    const contexts = [1, 2].map((slot) => ({
      attempts: [
        (slot * 100 + 1).toString(16).padStart(64, "0"),
        (slot * 100 + 2).toString(16).padStart(64, "0"),
      ] as const,
    }));
    const fresh = prepareFreshStandaloneReview({
      ...preparationInput(),
      reviewerContexts: contexts,
    });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.value.authority.reviewers).toEqual(["code-reviewer", "type-design-analyzer"]);
    expect(fresh.value.authority.roster.orderedSlots.map((slot) => ({
      role: slot.attempts[0].role,
      slot: slot.slotId,
      profile: slot.attempts[0].modelProfile,
      outputs: slot.attempts.map((attempt) => attempt.outputSlot.path),
    }))).toEqual([
      {
        role: "code-reviewer",
        slot: "standalone-slot:1:code-reviewer",
        profile: "general-review",
        outputs: ["transcripts/1-code-reviewer/attempt-1.raw", "transcripts/1-code-reviewer/attempt-2.raw"],
      },
      {
        role: "type-design-analyzer",
        slot: "standalone-slot:2:type-design-analyzer",
        profile: "focused-review",
        outputs: ["transcripts/2-type-design-analyzer/attempt-1.raw", "transcripts/2-type-design-analyzer/attempt-2.raw"],
      },
    ]);
    expect(new Set(fresh.value.authority.roster.orderedSlots.flatMap((slot) =>
      slot.attempts.map(({ requestId }) => requestId))).size).toBe(4);
  });

  it("preserves reviewer-specific context preparation failure causes", () => {
    const malformedContexts = [
      { attempts: ["a".repeat(64), "b".repeat(64)] as const },
      { attempts: ["c".repeat(64)] as unknown as readonly [unknown, unknown] },
    ];
    const fresh = prepareFreshStandaloneReview({
      ...preparationInput(),
      reviewerContexts: malformedContexts,
    });
    expect(fresh.ok).toBe(false);
    if (!fresh.ok) {
      expect(fresh.error.errors.join("\n")).toContain("type-design-analyzer");
      expect(fresh.error.errors.join("\n")).toContain("exactly two immutable attempt context digests");
    }
  });

  it("resolves all attribution internally from an issued request identity", () => {
    const authority = preparedAuthority();
    const complete = completeCapturedRoster(authority, [transcript(), transcript()]);
    const bound = bindStandaloneCaptureAuthority(authority, complete.roster.ordered.map(({ issuedRequest }) => issuedRequest));
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    const issued = complete.roster.ordered[0]!.issuedRequest;
    const bytes = Uint8Array.from([0xff, 0xfe, 0x00, 0x61]);
    const prepared = captureStandaloneReviewerBytes(bound.value, issued.authority.requestId, bytes);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.request).toBe(issued.authority);
    expect(prepared.value.intent.runId).toBe(authority.runId);
    expect(prepared.value.intent.request.role).toBe("code-reviewer");
    expect(prepared.value.intent.request.contextDigest).toBe(issued.authority.contextDigest);
    expect(prepared.value.expectedArtifact.slot.path).toBe(issued.authority.outputSlot.path);
    expect(Buffer.from(prepared.value.rawBytes.data, "base64")).toEqual(Buffer.from(bytes));

    const completed = completeStandaloneReviewerCapture(prepared.value, {
      kind: "raw-transcript-captured",
      effectId: prepared.value.intent.effectId,
      runId: authority.runId,
      requestId: issued.authority.requestId,
      artifact: prepared.value.expectedArtifact,
    });
    expect(completed.ok).toBe(true);
    if (completed.ok) {
      expect(completed.value.value.rawBytes.data).toBe(Buffer.from(bytes).toString("base64"));
      expect(JSON.stringify(completed.value.value)).not.toContain("�");
      expect(parseCapturedReviewerResult(completed.value.value).ok).toBe(true);
    }
  });

  it("rehydrates issued-request and prepared-byte capture authority from durable receipts", () => {
    const authority = preparedAuthority();
    const complete = completeCapturedRoster(authority, [transcript(), transcript()]);
    const issued = complete.roster.ordered.map(({ issuedRequest }) => issuedRequest);
    const persistedRequests = JSON.parse(JSON.stringify(issued));
    const rebound = parseStandaloneCaptureAuthority(authority, persistedRequests, (request) => {
      const expected = issued.find(({ authority: candidate }) => candidate.requestId === request.authority.requestId);
      return expected !== undefined && JSON.stringify(expected) === JSON.stringify(request)
        ? { ok: true, value: expected }
        : { ok: false, error: { kind: "standalone-capture-rejected" as const, message: "issuance receipt mismatch" } };
    });
    expect(rebound.ok).toBe(true);
    if (!rebound.ok) return;
    const bytes = Buffer.from(transcript([], ["captured without parent publication"]), "utf-8");
    const prepared = prepareStandaloneReviewHarnessCapture({
      captureAuthority: rebound.value,
      requestId: issued[0]!.authority.requestId,
      rawBytes: bytes,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const reloaded = parsePreparedStandaloneReviewerCapture(
      rebound.value,
      JSON.parse(JSON.stringify(prepared.value)),
    );
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) {
      expect(reloaded.value.intent.bytes).toEqual([...bytes]);
      expect(reloaded.value.expectedArtifact.digest).toBe(createHash("sha256").update(bytes).digest("hex"));
      const consumed = completeStandaloneReviewerCapture(reloaded.value, {
        kind: "raw-transcript-captured",
        effectId: reloaded.value.intent.effectId,
        runId: authority.runId,
        requestId: issued[0]!.authority.requestId,
        artifact: reloaded.value.expectedArtifact,
      });
      expect(consumed.ok).toBe(true);
      if (consumed.ok) {
        expect(consumed.value.authority.requestId).toBe(issued[0]!.authority.requestId);
        expect(Buffer.from(consumed.value.value.rawBytes.data, "base64")).toEqual(bytes);
      }
    }
  });

  it("rejects route mismatch and every capture receipt authority tamper before aggregation", () => {
    const authority = preparedAuthority();
    const complete = completeCapturedRoster(authority, [transcript(), transcript()]);
    const bound = bindStandaloneCaptureAuthority(authority, complete.roster.ordered.map(({ issuedRequest }) => issuedRequest));
    expect(bound.ok).toBe(true);
    if (!bound.ok) return;
    expect(captureStandaloneReviewerBytes(bound.value, "request:foreign", [1]).ok).toBe(false);

    const issued = complete.roster.ordered[0]!.issuedRequest;
    const prepared = captureStandaloneReviewerBytes(bound.value, issued.authority.requestId, [1, 2, 3]);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const base = {
      kind: "raw-transcript-captured" as const,
      effectId: prepared.value.intent.effectId,
      runId: authority.runId,
      requestId: issued.authority.requestId,
      artifact: prepared.value.expectedArtifact,
    };
    const wrongArtifact = (field: "runId" | "slot" | "digest" | "byteLength") => ({
      ...base.artifact,
      ...(field === "runId" ? { runId: "run.foreign" } : {}),
      ...(field === "slot" ? { slot: "transcripts/foreign.raw" } : {}),
      ...(field === "digest" ? { digest: "0".repeat(64) } : {}),
      ...(field === "byteLength" ? { byteLength: base.artifact.byteLength + 1 } : {}),
    });
    const tampered = [
      { ...base, runId: "run.foreign" },
      { ...base, requestId: "request:foreign" },
      ...(["runId", "slot", "digest", "byteLength"] as const).map((field) => ({ ...base, artifact: wrongArtifact(field) })),
    ];
    for (const receipt of tampered) expect(completeStandaloneReviewerCapture(prepared.value, receipt).ok).toBe(false);
  });
});

describe("historical standalone result compatibility and v1 authority", () => {
  const criticalFinding = {
    id: "code-reviewer-1", agent: "code-reviewer", severity: "critical" as const,
    file: "src/x.ts", line: 3, claim: "the {config} value is unchecked",
  };
  const advisoryFinding = {
    id: "code-reviewer-2", agent: "code-reviewer", severity: "advisory" as const,
    file: "src/x.ts", line: 4, claim: "rename this value",
  };

  it("reads the genuine unversioned serializer shape and normalizes old panel fields/task identity", () => {
    // Historical serializer shape: no schema/subject/evidence, no panel
    // counts, and no outcome task_id.
    const historical = {
      run_id: "run.historical",
      scope: ["src/x.ts"],
      surviving_critical_findings: [criticalFinding],
      advisory_findings: [advisoryFinding],
      refuted_critical_findings: [],
      panel: {
        lenses: ["reproduction", "intent", "blast-radius"], threshold: 2,
        outcomes: [{
          finding_id: "standalone-review:code-reviewer-1",
          claim: "the config value is unchecked", survives: true,
          refuted_by: [], reasoning: [], upheld_by: ["reproduction", "intent"], uncertain_from: ["blast-radius"],
        }],
      },
    };
    const parsed = parseAdjudicatedStandaloneReview(historical);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.authorityKind).toBe("unauthenticated-historical");
      expect(parsed.value.panel?.outcomes[0]?.findingId).toBe("standalone-review:code-reviewer-1");
      expect(parsed.value.panel?.outcomes[0]?.claim).toBe("the config value is unchecked");
    }
  });

  it("reads a pre-panel critical disposition only when it is genuinely unversioned", () => {
    const historical = {
      run_id: "run.pre-panel", scope: ["src/x.ts"],
      surviving_critical_findings: [criticalFinding], advisory_findings: [], refuted_critical_findings: [], panel: null,
    };
    expect(parseAdjudicatedStandaloneReview(historical).ok).toBe(true);
    expect(parseAdjudicatedStandaloneReview({
      schema_version: 1, subject_id: "standalone-review", reviewer_evidence: [], ...historical,
    }).ok).toBe(false);
  });

  it("rejects both clean and critical schema-v1 values without LC-2 publication authority", () => {
    const critical = required();
    const panelFindings = buildStandaloneFindingBrief(critical.aggregate).findings;
    const panel = parseStandalonePanelOutcomes({
      lenses: ["reproduction", "intent"], threshold: 2, surviving: 2, refuted: 0,
      outcomes: critical.criticals.map((finding) => ({
        finding_id: `${STANDALONE_REVIEW_SUBJECT}:${finding.id}`,
        task_id: STANDALONE_REVIEW_SUBJECT,
        claim: panelFindings.find(({ id }) => id === `${STANDALONE_REVIEW_SUBJECT}:${finding.id}`)!.claim,
        survives: true, refuted_by: [], reasoning: [],
        upheld_by: ["reproduction", "intent"], uncertain_from: [],
      })),
    }, critical.criticals, panelFindings, ["reproduction", "intent"]);
    if (!panel.ok) throw new Error(panel.errors.join("; "));
    const criticalResult = finalizeStandaloneReview(critical.aggregate, panel.value);
    const clean = aggregateLegacyStandaloneReview({
      runId: "run.clean-v1", scope: ["src/x.ts"],
      transcripts: [{ agent: "code-reviewer", output: transcript() }],
    });
    if (!criticalResult.ok || !clean.ok) throw new Error("result fixtures failed");
    const cleanResult = finalizeStandaloneReview(clean.value.aggregate, null);
    if (!cleanResult.ok) throw new Error(cleanResult.errors.join("; "));

    for (const raw of [criticalResult.value, cleanResult.value].map((result) =>
      JSON.parse(serializeAdjudicatedStandaloneReview(result)))) {
      const parsed = parseAdjudicatedStandaloneReview(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.errors.join("\n")).toContain("authoritative LC-2 publication parsing");
    }
  });

  it("enforces frozen scope for every final disposition and canonical claim authority", () => {
    const state = required();
    const panelFindings = buildStandaloneFindingBrief(state.aggregate).findings;
    const panel = parseStandalonePanelOutcomes({
      lenses: ["reproduction", "intent"], threshold: 2, surviving: 2, refuted: 0,
      outcomes: state.criticals.map((finding) => ({
        finding_id: `standalone-review:${finding.id}`, task_id: "standalone-review",
        claim: panelFindings.find(({ id }) => id === `standalone-review:${finding.id}`)!.claim,
        survives: true, refuted_by: [], reasoning: [], upheld_by: ["reproduction", "intent"], uncertain_from: [],
      })),
    }, state.criticals, panelFindings, ["reproduction", "intent"]);
    expect(panel.ok).toBe(true);
    if (!panel.ok) return;
    const finalized = finalizeStandaloneReview(state.aggregate, panel.value);
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;
    const canonical = JSON.parse(serializeAdjudicatedStandaloneReview(finalized.value)) as {
      surviving_critical_findings: Array<{ file: string }>;
      advisory_findings: Array<{ file: string }>;
      panel: { outcomes: Array<{ claim: string }> };
    };
    const outsideSurvivor = structuredClone(canonical);
    outsideSurvivor.surviving_critical_findings[0]!.file = "src/outside.ts";
    const outsideAdvisory = structuredClone(canonical);
    outsideAdvisory.advisory_findings[0]!.file = "src/outside.ts";
    const replacedClaim = structuredClone(canonical);
    replacedClaim.panel.outcomes[0]!.claim = "self-authenticated replacement";
    const outsideRefuted = structuredClone(canonical) as typeof canonical & {
      refuted_critical_findings: Array<{
        finding: { file: string };
        refutations: Array<{ lens: string; reason: string }>;
      }>;
    };
    const moved = outsideRefuted.surviving_critical_findings.shift()!;
    moved.file = "src/outside.ts";
    outsideRefuted.refuted_critical_findings = [{
      finding: moved,
      refutations: [
        { lens: "reproduction", reason: "not reproducible" },
        { lens: "intent", reason: "intentional" },
      ],
    }];
    const movedOutcome = outsideRefuted.panel.outcomes[0]! as typeof outsideRefuted.panel.outcomes[number] & {
      survives: boolean; refuted_by: string[]; reasoning: string[]; upheld_by: string[];
    };
    movedOutcome.survives = false;
    movedOutcome.refuted_by = ["reproduction", "intent"];
    movedOutcome.reasoning = ["not reproducible", "intentional"];
    movedOutcome.upheld_by = [];
    for (const raw of [outsideSurvivor, outsideAdvisory, outsideRefuted, replacedClaim]) {
      expect(parseAdjudicatedStandaloneReview(raw).ok).toBe(false);
    }
  });
});

describe("LC-2 standalone lifecycle machine", () => {
  it("routes zero criticals directly to finalization and criticals only to refutation", () => {
    const authority = preparedAuthority();
    const enterAggregation = (complete: ProvenCapturedRoster) => {
      const started = startStandaloneReviewMachine(authority);
      const awaiting = reduceStandaloneReviewMachine(started, { kind: "review-batch-published", runId: authority.runId });
      if (!awaiting.ok) throw new Error(awaiting.error.message);
      const aggregating = reduceStandaloneReviewMachine(awaiting.value, {
        kind: "complete-roster-proved", completion: complete.completion,
      });
      if (!aggregating.ok) throw new Error(aggregating.error.message);
      return aggregating.value;
    };

    const cleanRoster = completeCapturedRoster(authority, [transcript(), transcript([], ["small advisory"])], [1, 0]);
    const cleanAggregate = aggregateStandaloneReview({ authority, completion: cleanRoster.completion });
    expect(cleanAggregate.ok && cleanAggregate.value.kind).toBe("clean");
    if (!cleanAggregate.ok) return;
    const ready = reduceStandaloneReviewMachine(enterAggregation(cleanRoster), {
      kind: "aggregate-clean", aggregate: cleanAggregate.value.aggregate,
    });
    expect(ready.ok && ready.value.kind).toBe("ready-to-finalize");

    const criticalRoster = completeCapturedRoster(authority, [transcript(), transcript(["blocker"])], [1, 0]);
    const criticalAggregate = aggregateStandaloneReview({ authority, completion: criticalRoster.completion });
    expect(criticalAggregate.ok && criticalAggregate.value.kind).toBe("requires-refutation");
    if (!criticalAggregate.ok) return;
    const panel = completedRefutationPanel(authority, criticalAggregate.value.aggregate);
    const awaitingRefutation = reduceStandaloneReviewMachine(enterAggregation(criticalRoster), {
      kind: "aggregate-has-criticals",
      aggregate: criticalAggregate.value.aggregate,
      panelAuthority: panel.frozen,
      refutationAuthority: panel.authority,
    });
    expect(awaitingRefutation.ok && awaitingRefutation.value.kind).toBe("awaiting-refutation");
    const criticalLabeledClean = reduceStandaloneReviewMachine(enterAggregation(criticalRoster), {
      kind: "aggregate-clean",
      aggregate: criticalAggregate.value.aggregate,
    });
    expect(criticalLabeledClean.ok).toBe(false);
    if (!criticalLabeledClean.ok) expect(criticalLabeledClean.error.kind).toBe("aggregate-route-mismatch");
  });

  it("rejects a route label that disagrees with the canonical aggregate", () => {
    const authority = preparedAuthority();
    const cleanRoster = completeCapturedRoster(authority, [transcript(), transcript()]);
    const clean = aggregateStandaloneReview({ authority, completion: cleanRoster.completion });
    expect(clean.ok && clean.value.kind).toBe("clean");
    if (!clean.ok) return;
    const started = startStandaloneReviewMachine(authority);
    const awaiting = reduceStandaloneReviewMachine(started, { kind: "review-batch-published", runId: authority.runId });
    if (!awaiting.ok) return;
    const aggregating = reduceStandaloneReviewMachine(awaiting.value, {
      kind: "complete-roster-proved", completion: cleanRoster.completion,
    });
    if (!aggregating.ok) return;
    const criticalRoster = completeCapturedRoster(authority, [transcript(["panel authority source"]), transcript()]);
    const critical = aggregateStandaloneReview({ authority, completion: criticalRoster.completion });
    if (!critical.ok) return;
    const panel = completedRefutationPanel(authority, critical.value.aggregate);
    const mismatched = reduceStandaloneReviewMachine(aggregating.value, {
      kind: "aggregate-has-criticals",
      aggregate: clean.value.aggregate,
      panelAuthority: panel.frozen,
      refutationAuthority: panel.authority,
    });
    expect(mismatched.ok).toBe(false);
    if (!mismatched.ok) expect(mismatched.error.kind).toBe("aggregate-route-mismatch");
  });

  it("requires opaque T2 completed-panel authority; caller panel/result values cannot self-prove", () => {
    const authority = preparedAuthority();
    const roster = completeCapturedRoster(authority, [transcript(["blocker"]), transcript()]);
    const aggregate = aggregateStandaloneReview({ authority, completion: roster.completion });
    if (!aggregate.ok || aggregate.value.kind !== "requires-refutation") throw new Error("critical aggregate required");
    const panel = completedRefutationPanel(authority, aggregate.value.aggregate);
    const started = startStandaloneReviewMachine(authority);
    const awaiting = reduceStandaloneReviewMachine(started, { kind: "review-batch-published", runId: authority.runId });
    if (!awaiting.ok) throw new Error(awaiting.error.message);
    const aggregating = reduceStandaloneReviewMachine(awaiting.value, {
      kind: "complete-roster-proved", completion: roster.completion,
    });
    if (!aggregating.ok) throw new Error(aggregating.error.message);
    const routed = reduceStandaloneReviewMachine(aggregating.value, {
      kind: "aggregate-has-criticals",
      aggregate: aggregate.value.aggregate,
      panelAuthority: panel.frozen,
      refutationAuthority: panel.authority,
    });
    if (!routed.ok || routed.value.kind !== "awaiting-refutation") throw new Error("refutation state required");

    const callerSupplied = reduceStandaloneReviewMachine(routed.value, {
      kind: "refutation-completed",
      panel: panel.completion.panel,
      result: finalizeStandaloneReview(aggregate.value.aggregate, panel.completion.panel),
    } as unknown as StandaloneReviewMachineEvent);
    expect(callerSupplied.ok).toBe(false);

    const persistedReceipt = JSON.parse(JSON.stringify(panel.completion)) as StandaloneRefutationCompletionReceipt;
    expect(reduceStandaloneReviewMachine(routed.value, {
      kind: "refutation-completed",
      completion: persistedReceipt,
    }).ok).toBe(false);
    const forgedReceipt = { ...persistedReceipt, outcomeDigest: "0".repeat(64) } as StandaloneRefutationCompletionReceipt;
    expect(reduceStandaloneReviewMachine(routed.value, {
      kind: "refutation-completed",
      completion: forgedReceipt,
    }).ok).toBe(false);
    const persistedCompletedState = JSON.parse(JSON.stringify(panel.completed)) as RefutationPanelState;
    expect(parseStandaloneRefutationCompletion({
      panelAuthority: panel.frozen,
      aggregate: aggregate.value.aggregate,
      completedPanelState: persistedCompletedState,
    }).ok).toBe(false);
    expect(parseStandaloneRefutationCompletion({
      panelAuthority: panel.frozen,
      aggregate: aggregate.value.aggregate,
      completedPanelState: persistedCompletedState,
      publicationResolver: panel.resolver,
    }).ok).toBe(true);
    const forgedCompletedState = {
      ...persistedCompletedState,
      decision: { ...(persistedCompletedState as Extract<RefutationPanelState, { stage: "done" }>).decision, threshold: 1 },
    } as RefutationPanelState;
    expect(parseStandaloneRefutationCompletion({
      panelAuthority: panel.frozen,
      aggregate: aggregate.value.aggregate,
      completedPanelState: forgedCompletedState,
      publicationResolver: panel.resolver,
    }).ok).toBe(false);
    const emptySlotCompletion = {
      ...persistedCompletedState,
      slots: (persistedCompletedState as Extract<RefutationPanelState, { stage: "done" }>).slots.map((slot, index) =>
        index === 0 ? { slotId: slot.slotId, status: "pending", nextAttempt: 1 } : slot),
    } as unknown as RefutationPanelState;
    expect(parseStandaloneRefutationCompletion({
      panelAuthority: panel.frozen,
      aggregate: aggregate.value.aggregate,
      completedPanelState: emptySlotCompletion,
      publicationResolver: panel.resolver,
    }).ok).toBe(false);

    const ready = reduceStandaloneReviewMachine(routed.value, {
      kind: "refutation-completed",
      completion: panel.completion,
    });
    expect(ready.ok && ready.value.kind).toBe("ready-to-finalize");
    if (!ready.ok || ready.value.kind !== "ready-to-finalize") return;
    const finalizationBeforeMutation = serializeAdjudicatedStandaloneReview(ready.value.result);
    const outcome = panel.completion.panel.outcomes[0]!;
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.refutations)).toBe(true);
    expect(Object.isFrozen(outcome.refutations[0])).toBe(true);
    expect(Object.isFrozen(outcome.upheldBy)).toBe(true);
    expect(() => (outcome.refutations as unknown as Array<{ lens: string; reason: string }>).push({
      lens: "forged", reason: "post-proof mutation",
    })).toThrow();
    expect(serializeAdjudicatedStandaloneReview(ready.value.result)).toBe(finalizationBeforeMutation);
  });

  it("rejects structurally identical or forged roster-completion values", () => {
    const authority = preparedAuthority();
    const complete = completeCapturedRoster(authority, [transcript(), transcript()]);
    const started = startStandaloneReviewMachine(authority);
    const awaiting = reduceStandaloneReviewMachine(started, { kind: "review-batch-published", runId: authority.runId });
    if (!awaiting.ok || awaiting.value.kind !== "awaiting-results") throw new Error("awaiting state required");

    const structuralClone = structuredClone(complete.completion) as StandaloneRosterCompletionProof;
    expect(aggregateStandaloneReview({ authority, completion: structuralClone }).ok).toBe(false);
    const rehydrated = parseStandaloneRosterCompletionProof(authority, complete.resolver, structuralClone);
    expect(rehydrated.ok).toBe(true);
    if (rehydrated.ok) expect(aggregateStandaloneReview({ authority, completion: rehydrated.value }).ok).toBe(true);
    expect(reduceStandaloneReviewMachine(awaiting.value, {
      kind: "complete-roster-proved",
      completion: structuralClone,
    }).ok).toBe(false);

    const forged = {
      ...complete.completion,
      accepted: complete.completion.accepted.map((entry, index) => index === 0
        ? { ...entry, requestId: "request:forged" }
        : entry),
    } as unknown as StandaloneRosterCompletionProof;
    expect(aggregateStandaloneReview({ authority, completion: forged }).ok).toBe(false);

    const malformed = parseStandaloneRosterCompletionProof(authority, complete.resolver, {});
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) {
      expect(malformed.error.violations).toEqual([expect.objectContaining({
        kind: "malformed-result-boundary",
        message: expect.stringContaining("persisted standalone roster completion"),
      })]);
      expect(malformed.error.violations).not.toContainEqual({ kind: "empty-roster" });
    }
  });

  it("rejects the full run/agent/request/context/model/output authority tamper matrix before aggregation", () => {
    const authority = preparedAuthority();
    const complete = completeCapturedRoster(authority, [transcript(), transcript()]);
    const started = startStandaloneReviewMachine(authority);
    const awaiting = reduceStandaloneReviewMachine(started, { kind: "review-batch-published", runId: authority.runId });
    if (!awaiting.ok || awaiting.value.kind !== "awaiting-results") throw new Error("awaiting state required");
    const original = complete.roster.ordered[0]!;
    const changedAuthorities = [
      { ...original.authority, runId: "run.foreign" },
      { ...original.authority, role: "type-design-analyzer" },
      { ...original.authority, requestId: "request:foreign" },
      { ...original.authority, contextDigest: "f".repeat(64) },
      { ...original.authority, modelProfile: "focused-review" },
      { ...original.authority, outputSlot: { kind: "fixed-artifact-slot", path: "transcripts/foreign.raw" } },
      {
        ...original.authority,
        harnessBinding: { ...original.authority.harnessBinding, claude: { harness: "claude-code", model: "opus" } },
      },
    ];
    for (const changed of changedAuthorities) {
      const tampered = { ...original, authority: changed } as unknown as AcceptedAgentResult<CapturedReviewerResult>;
      expect(reduceStandaloneReviewMachine(awaiting.value, { kind: "result-accepted", result: tampered }).ok).toBe(false);
    }
  });

  it("retains the canonical accepted payload/artifact fingerprint across complete-roster proof", () => {
    const authority = preparedAuthority();
    const complete = completeCapturedRoster(authority, [transcript([], ["accepted"]), transcript()]);
    const started = startStandaloneReviewMachine(authority);
    const awaiting = reduceStandaloneReviewMachine(started, { kind: "review-batch-published", runId: authority.runId });
    if (!awaiting.ok || awaiting.value.kind !== "awaiting-results") throw new Error("awaiting state required");
    const accepted = reduceStandaloneReviewMachine(awaiting.value, {
      kind: "result-accepted", result: complete.roster.ordered[0]!,
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok || accepted.value.kind !== "awaiting-results") return;

    const request = complete.roster.ordered[0]!.issuedRequest;
    const replacementText = transcript([], ["payload was swapped"]);
    const bytes = Buffer.from(replacementText, "utf-8");
    const replacementArtifact = parseArtifactRef({
      runId: authority.runId,
      slot: request.authority.outputSlot,
      digest: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
    });
    expect(replacementArtifact.ok).toBe(true);
    if (!replacementArtifact.ok) return;
    const replacementPayload = capturedReviewerResultFromText(replacementArtifact.value, replacementText);
    expect(replacementPayload.ok).toBe(true);
    if (!replacementPayload.ok) return;
    expect(fingerprintCapturedReviewerResult(replacementPayload.value)).not.toBe(
      fingerprintCapturedReviewerResult(complete.roster.ordered[0]!.value),
    );
    const replacement = acceptedAgentResult(request, replacementPayload.value);
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;
    const forgedCompletion = {
      ...complete.completion,
      accepted: complete.completion.accepted.map((entry, index) => index === 0
        ? { ...entry, payloadFingerprint: fingerprintCapturedReviewerResult(replacement.value.value) }
        : entry),
    } as unknown as StandaloneRosterCompletionProof;
    const rejected = reduceStandaloneReviewMachine(accepted.value, {
      kind: "complete-roster-proved", completion: forgedCompletion,
    });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.message).toContain("opaque roster-completion proof");
  });

  it("rehydrates durable authority at aggregating, refutation, finalization, and publication boundaries", () => {
    const authority = preparedAuthority();
    const enterAggregation = (complete: ProvenCapturedRoster) => {
      const awaiting = reduceStandaloneReviewMachine(startStandaloneReviewMachine(authority), {
        kind: "review-batch-published", runId: authority.runId,
      });
      if (!awaiting.ok) throw new Error(awaiting.error.message);
      const aggregating = reduceStandaloneReviewMachine(awaiting.value, {
        kind: "complete-roster-proved", completion: complete.completion,
      });
      if (!aggregating.ok) throw new Error(aggregating.error.message);
      return aggregating.value;
    };
    const reload = (state: Parameters<typeof serializeStandaloneReviewMachineState>[0], resolver: PublicationAuthorityResolver) => {
      const parsed = parseStandaloneReviewMachineState(
        JSON.parse(serializeStandaloneReviewMachineState(state)),
        resolver,
      );
      expect(parsed.ok, parsed.ok ? "" : parsed.error.message).toBe(true);
      if (!parsed.ok) throw new Error(parsed.error.message);
      return parsed.value;
    };

    const cleanRoster = completeCapturedRoster(authority, [transcript(), transcript([], ["durable advisory"])]);
    const awaitingResults = reduceStandaloneReviewMachine(startStandaloneReviewMachine(authority), {
      kind: "review-batch-published", runId: authority.runId,
    });
    if (!awaitingResults.ok) throw new Error(awaitingResults.error.message);
    const partiallyAccepted = reduceStandaloneReviewMachine(awaitingResults.value, {
      kind: "result-accepted", result: cleanRoster.roster.ordered[0]!,
    });
    if (!partiallyAccepted.ok) throw new Error(partiallyAccepted.error.message);
    const reloadedPartial = reload(partiallyAccepted.value, cleanRoster.resolver);
    expect(reloadedPartial.accepted).toEqual(partiallyAccepted.value.accepted);
    expect(reloadedPartial.pending).toEqual(partiallyAccepted.value.pending);
    const cleanAggregate = aggregateStandaloneReview({ authority, completion: cleanRoster.completion });
    if (!cleanAggregate.ok) throw new Error(cleanAggregate.errors.join("; "));
    const reloadedAggregating = reload(enterAggregation(cleanRoster), cleanRoster.resolver);
    expect(reloadedAggregating.kind).toBe("aggregating");
    const ready = reduceStandaloneReviewMachine(reloadedAggregating, {
      kind: "aggregate-clean", aggregate: cleanAggregate.value.aggregate,
    });
    if (!ready.ok || ready.value.kind !== "ready-to-finalize") throw new Error("ready state required");
    const reloadedReady = reload(ready.value, cleanRoster.resolver);
    expect(reloadedReady.kind).toBe("ready-to-finalize");
    if (reloadedReady.kind !== "ready-to-finalize") return;
    const result = JSON.parse(serializeAdjudicatedStandaloneReview(reloadedReady.result));
    const receipt = {
      kind: "artifact-set-published" as const,
      effectId: reloadedReady.publicationIntent.effectId,
      runId: authority.runId,
      artifacts: reloadedReady.publicationIntent.artifacts,
    };
    const done = reduceStandaloneReviewMachine(reloadedReady, { kind: "result-published", result, receipt });
    if (!done.ok || done.value.kind !== "done") throw new Error("done state required");
    const reloadedDone = reload(done.value, cleanRoster.resolver);
    expect(reloadedDone.kind).toBe("done");

    const criticalRoster = completeCapturedRoster(authority, [transcript(["restart blocker"]), transcript()]);
    const criticalAggregate = aggregateStandaloneReview({ authority, completion: criticalRoster.completion });
    if (!criticalAggregate.ok || criticalAggregate.value.kind !== "requires-refutation") {
      throw new Error("critical aggregate required");
    }
    const panel = completedRefutationPanel(authority, criticalAggregate.value.aggregate);
    const awaitingRefutation = reduceStandaloneReviewMachine(enterAggregation(criticalRoster), {
      kind: "aggregate-has-criticals",
      aggregate: criticalAggregate.value.aggregate,
      panelAuthority: panel.frozen,
      refutationAuthority: panel.authority,
    });
    if (!awaitingRefutation.ok || awaitingRefutation.value.kind !== "awaiting-refutation") {
      throw new Error("awaiting refutation required");
    }
    const reloadedRefutation = reload(awaitingRefutation.value, criticalRoster.resolver);
    expect(reloadedRefutation.kind).toBe("awaiting-refutation");
    const rehydratedPanelCompletion = parseStandaloneRefutationCompletion({
      panelAuthority: panel.frozen,
      aggregate: criticalAggregate.value.aggregate,
      completedPanelState: JSON.parse(JSON.stringify(panel.completed)),
      publicationResolver: panel.resolver,
    });
    if (!rehydratedPanelCompletion.ok) throw new Error(rehydratedPanelCompletion.error.message);
    const criticalReady = reduceStandaloneReviewMachine(reloadedRefutation, {
      kind: "refutation-completed", completion: rehydratedPanelCompletion.value,
    });
    expect(criticalReady.ok && criticalReady.value.kind,
      criticalReady.ok ? "unexpected state" : criticalReady.error.message).toBe("ready-to-finalize");
    if (criticalReady.ok) {
      const durableResolver: PublicationAuthorityResolver = (claim) => {
        const panelResolution = panel.resolver(claim);
        return panelResolution.ok ? panelResolution : criticalRoster.resolver(claim);
      };
      expect(reload(criticalReady.value, durableResolver).kind).toBe("ready-to-finalize");
    }
  });

  it("replays a canonical T2 panel checkpoint and round-trips critical-bearing standalone done", () => {
    const authority = preparedAuthority();
    const roster = completeCapturedRoster(authority, [transcript(["durable blocker"]), transcript()]);
    const aggregate = aggregateStandaloneReview({ authority, completion: roster.completion });
    if (!aggregate.ok || aggregate.value.kind !== "requires-refutation") {
      throw new Error("critical aggregate required");
    }
    const panel = completedRefutationPanel(authority, aggregate.value.aggregate);
    const awaitingResults = reduceStandaloneReviewMachine(startStandaloneReviewMachine(authority), {
      kind: "review-batch-published", runId: authority.runId,
    });
    if (!awaitingResults.ok) throw new Error(awaitingResults.error.message);
    const aggregating = reduceStandaloneReviewMachine(awaitingResults.value, {
      kind: "complete-roster-proved", completion: roster.completion,
    });
    if (!aggregating.ok) throw new Error(aggregating.error.message);
    const awaitingRefutation = reduceStandaloneReviewMachine(aggregating.value, {
      kind: "aggregate-has-criticals",
      aggregate: aggregate.value.aggregate,
      panelAuthority: panel.frozen,
      refutationAuthority: panel.authority,
    });
    if (!awaitingRefutation.ok || awaitingRefutation.value.kind !== "awaiting-refutation") {
      throw new Error("awaiting-refutation state required");
    }

    const canonicalCompletion = parseStandaloneRefutationCompletion({
      panelAuthority: panel.frozen,
      aggregate: aggregate.value.aggregate,
      completedPanelState: JSON.parse(JSON.stringify(panel.checkpoint)),
      publicationResolver: panel.resolver,
    });
    expect(canonicalCompletion.ok, canonicalCompletion.ok ? "" : canonicalCompletion.error.message).toBe(true);
    if (!canonicalCompletion.ok) return;
    expect(canonicalCompletion.value.completedPanelCheckpoint).toEqual(panel.checkpoint);

    const ready = reduceStandaloneReviewMachine(awaitingRefutation.value, {
      kind: "refutation-completed",
      completion: canonicalCompletion.value,
    });
    expect(ready.ok && ready.value.kind, ready.ok ? "unexpected state" : ready.error.message).toBe("ready-to-finalize");
    if (!ready.ok || ready.value.kind !== "ready-to-finalize") return;
    const durableResolver: PublicationAuthorityResolver = (claim) => {
      const panelResolution = panel.resolver(claim);
      return panelResolution.ok ? panelResolution : roster.resolver(claim);
    };
    const reloadedReady = parseStandaloneReviewMachineState(
      JSON.parse(serializeStandaloneReviewMachineState(ready.value)),
      durableResolver,
    );
    expect(reloadedReady.ok, reloadedReady.ok ? "" : reloadedReady.error.message).toBe(true);
    if (!reloadedReady.ok || reloadedReady.value.kind !== "ready-to-finalize") return;

    const receipt = {
      kind: "artifact-set-published" as const,
      effectId: reloadedReady.value.publicationIntent.effectId,
      runId: authority.runId,
      artifacts: reloadedReady.value.publicationIntent.artifacts,
    };
    const done = reduceStandaloneReviewMachine(reloadedReady.value, {
      kind: "result-published",
      result: JSON.parse(serializeAdjudicatedStandaloneReview(reloadedReady.value.result)),
      receipt,
    });
    expect(done.ok && done.value.kind).toBe("done");
    if (!done.ok || done.value.kind !== "done") return;
    const reloadedDone = parseStandaloneReviewMachineState(
      JSON.parse(serializeStandaloneReviewMachineState(done.value)),
      durableResolver,
    );
    expect(reloadedDone.ok, reloadedDone.ok ? "" : reloadedDone.error.message).toBe(true);
    if (reloadedDone.ok && reloadedDone.value.kind === "done") {
      expect(reloadedDone.value.result.refutedCriticals).toHaveLength(1);
      expect(reloadedDone.value.result.panel?.outcomes).toHaveLength(1);
      expect(reloadedDone.value.outcome).toEqual(done.value.outcome);
      expect(reloadedDone.value.publicationReceipt).toEqual(done.value.publicationReceipt);
    }
  });

  it("reaches done only from the pre-issued result effect identity and exact canonical receipt", () => {
    const authority = preparedAuthority();
    const complete = completeCapturedRoster(authority, [transcript(), transcript()]);
    const aggregate = aggregateStandaloneReview({ authority, completion: complete.completion });
    expect(aggregate.ok && aggregate.value.kind).toBe("clean");
    if (!aggregate.ok) return;
    const started = startStandaloneReviewMachine(authority);
    const awaiting = reduceStandaloneReviewMachine(started, { kind: "review-batch-published", runId: authority.runId });
    if (!awaiting.ok) return;
    const aggregating = reduceStandaloneReviewMachine(awaiting.value, {
      kind: "complete-roster-proved", completion: complete.completion,
    });
    if (!aggregating.ok) return;
    const ready = reduceStandaloneReviewMachine(aggregating.value, {
      kind: "aggregate-clean", aggregate: aggregate.value.aggregate,
    });
    if (!ready.ok || ready.value.kind !== "ready-to-finalize") throw new Error("ready state required");
    const rawResult = JSON.parse(serializeAdjudicatedStandaloneReview(ready.value.result));
    const receipt = {
      kind: "artifact-set-published" as const,
      effectId: ready.value.publicationIntent.effectId,
      runId: authority.runId,
      artifacts: ready.value.publicationIntent.artifacts,
    };
    const emptyEvidence = structuredClone(rawResult);
    emptyEvidence.reviewer_evidence = [];
    expect(parseAuthoritativeStandaloneReviewResult(ready.value, emptyEvidence, receipt).ok).toBe(false);
    const changedFinalization = structuredClone(rawResult);
    changedFinalization.advisory_findings = [{
      id: "forged-1", agent: "code-reviewer", severity: "advisory",
      file: "src/x.ts", line: 1, claim: "forged after finalization",
    }];
    expect(parseAuthoritativeStandaloneReviewResult(ready.value, changedFinalization, receipt).ok).toBe(false);
    expect(parseAuthoritativeStandaloneReviewResult(
      { ...ready.value }, rawResult, receipt,
    ).ok).toBe(false);

    const wrongEffect = parseEffectId("effect:receipt-selected-identity");
    if (!wrongEffect.ok) throw new Error(wrongEffect.error.message);
    expect(parseAuthoritativeStandaloneReviewResult(ready.value, rawResult, {
      ...receipt, effectId: wrongEffect.value,
    }).ok).toBe(false);
    expect(reduceStandaloneReviewMachine(ready.value, {
      kind: "result-published", result: rawResult, receipt: { ...receipt, effectId: wrongEffect.value },
    }).ok).toBe(false);

    const artifact = ready.value.publicationIntent.artifacts[0];
    const unrelated = parseArtifactRef({ ...artifact, slot: "unrelated.json" });
    const wrongDigest = parseArtifactRef({ ...artifact, digest: "0".repeat(64) });
    const wrongLength = parseArtifactRef({ ...artifact, byteLength: artifact.byteLength + 1 });
    expect(unrelated.ok && wrongDigest.ok && wrongLength.ok).toBe(true);
    if (!unrelated.ok || !wrongDigest.ok || !wrongLength.ok) return;
    for (const wrongReceipt of [
      { ...receipt, artifacts: [unrelated.value] as const },
      { ...receipt, artifacts: [wrongDigest.value] as const },
      { ...receipt, artifacts: [wrongLength.value] as const },
      { ...receipt, artifacts: [artifact, unrelated.value] as const },
    ]) {
      expect(reduceStandaloneReviewMachine(ready.value, {
        kind: "result-published", result: rawResult, receipt: wrongReceipt,
      }).ok).toBe(false);
    }
    const done = reduceStandaloneReviewMachine(ready.value, {
      kind: "result-published", result: rawResult, receipt,
    });
    expect(done.ok && done.value.kind).toBe("done");
    if (done.ok && done.value.kind === "done") {
      expect(done.value.outcome).toEqual(artifact);
      expect(done.value.publicationReceipt).toEqual(receipt);
    }
  });

  it("round-trips accepted progress and terminal-blocks exactly on rejected attempt 2", () => {
    const authority = preparedAuthority();
    const complete = completeCapturedRoster(authority, [transcript([], ["accepted sibling"]), transcript()]);
    const started = startStandaloneReviewMachine(authority);
    const awaiting = reduceStandaloneReviewMachine(started, { kind: "review-batch-published", runId: authority.runId });
    expect(awaiting.ok).toBe(true);
    if (!awaiting.ok || awaiting.value.kind !== "awaiting-results") return;
    const accepted = reduceStandaloneReviewMachine(awaiting.value, {
      kind: "result-accepted", result: complete.roster.ordered[0]!,
    });
    if (!accepted.ok || accepted.value.kind !== "awaiting-results") throw new Error("accepted sibling required");
    const slot = authority.roster.orderedSlots[1]!;
    const retry = reduceStandaloneReviewMachine(accepted.value, {
      kind: "result-rejected",
      request: slot.attempts[0],
      message: "malformed result",
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok || retry.value.kind !== "awaiting-results") return;
    expect(retry.value.pending.find(({ slotId }) => slotId === slot.slotId)?.expectedAttempt).toBe(2);
    const terminal = reduceStandaloneReviewMachine(retry.value, {
      kind: "result-rejected",
      request: slot.attempts[1],
      message: "still malformed",
    });
    expect(terminal.ok && terminal.value.kind).toBe("terminal-blocked");
    if (!terminal.ok || terminal.value.kind !== "terminal-blocked") return;
    const restored = parseStandaloneReviewMachineState(
      JSON.parse(serializeStandaloneReviewMachineState(terminal.value)),
      createPublicationAuthorityResolver(() => ({ ok: true, value: [] })),
    );
    expect(restored.ok && restored.value.kind).toBe("terminal-blocked");
    if (restored.ok && restored.value.kind === "terminal-blocked") {
      expect(restored.value.failed).toEqual(terminal.value.failed);
      expect(restored.value.accepted).toEqual(terminal.value.accepted);
      expect(restored.value.pending).toEqual(terminal.value.pending);
    }
    const forged = JSON.parse(serializeStandaloneReviewMachineState(terminal.value));
    forged.failed.requestId = slot.attempts[0].requestId;
    expect(parseStandaloneReviewMachineState(
      forged,
      createPublicationAuthorityResolver(() => ({ ok: true, value: [] })),
    ).ok).toBe(false);
  });

  it("restores the exact predecessor only from a matching recovery receipt", () => {
    const authority = preparedAuthority();
    const started = startStandaloneReviewMachine(authority);
    const effect = parseEffectId("effect:publish");
    if (!effect.ok) throw new Error(effect.error.message);
    const diagnostic = {
      kind: "effect-blocked", category: "infrastructure-failure", runId: authority.runId,
      effectId: effect.value, message: "disk unavailable",
      retry: { kind: "infrastructure", eligible: true, consumesSemanticAttempt: false },
      recovery: { kind: "retry-effect", effectId: effect.value },
    } as const;
    const requests = authority.roster.orderedSlots.map(({ attempts }) => attempts[0]);
    const intent = {
      kind: "reserve-agent-requests" as const,
      effectId: effect.value,
      runId: authority.runId,
      requests: Object.freeze(requests) as [typeof requests[number], ...typeof requests[number][]],
    };
    const blocked = reduceStandaloneReviewMachine(started, { kind: "recoverable-effect-failed", diagnostic, intent });
    expect(blocked.ok && blocked.value.kind).toBe("recoverable-blocked");
    if (!blocked.ok || blocked.value.kind !== "recoverable-blocked") return;
    const resolver = createPublicationAuthorityResolver(() => ({ ok: true, value: [] }));
    const serializedBlocked = JSON.parse(serializeStandaloneReviewMachineState(blocked.value));
    const restoredBlocked = parseStandaloneReviewMachineState(serializedBlocked, resolver);
    expect(restoredBlocked.ok && restoredBlocked.value.kind).toBe("recoverable-blocked");
    if (restoredBlocked.ok && restoredBlocked.value.kind === "recoverable-blocked") {
      expect(serializeStandaloneReviewMachineState(restoredBlocked.value.predecessor)).toBe(
        serializeStandaloneReviewMachineState(started),
      );
      expect(restoredBlocked.value.diagnostic).toEqual(diagnostic);
      expect(restoredBlocked.value.expectedIntent).toEqual(intent);
    }
    const staleDigest = structuredClone(serializedBlocked);
    staleDigest.expectedIntentDigest = "0".repeat(64);
    expect(parseStandaloneReviewMachineState(staleDigest, resolver).ok).toBe(false);
    const malformedIntent = structuredClone(serializedBlocked);
    malformedIntent.expectedIntent.requests = [];
    malformedIntent.expectedIntentDigest = createHash("sha256")
      .update(JSON.stringify(malformedIntent.expectedIntent))
      .digest("hex");
    expect(parseStandaloneReviewMachineState(malformedIntent, resolver).ok).toBe(false);
    const malformedDiagnostic = structuredClone(serializedBlocked);
    malformedDiagnostic.diagnostic.message = " padded diagnostic ";
    expect(parseStandaloneReviewMachineState(malformedDiagnostic, resolver).ok).toBe(false);
    const changedPredecessor = structuredClone(serializedBlocked);
    changedPredecessor.predecessor.kind = "done";
    expect(parseStandaloneReviewMachineState(changedPredecessor, resolver).ok).toBe(false);

    const replacement = {
      ...intent,
      requests: Object.freeze([requests[0]!]) as [typeof requests[number]],
    };
    expect(reduceStandaloneReviewMachine(blocked.value, {
      kind: "recoverable-effect-failed", diagnostic, intent: replacement,
    }).ok).toBe(false);
    expect(reduceStandaloneReviewMachine(blocked.value, {
      kind: "recovery-receipt-accepted",
      receipt: {
        kind: "agent-requests-reserved", effectId: effect.value, runId: authority.runId,
        requestIds: [requests[0]!.requestId],
      },
    }).ok).toBe(false);
    const indexDigest = parseArtifactDigest("a".repeat(64));
    const witnessDigest = parseArtifactDigest("b".repeat(64));
    if (!indexDigest.ok || !witnessDigest.ok) throw new Error("digest fixture failed");
    expect(reduceStandaloneReviewMachine(blocked.value, {
      kind: "recovery-receipt-accepted",
      receipt: {
        kind: "verified-index-installed", effectId: effect.value, runId: authority.runId,
        indexDigest: indexDigest.value, witnessDigest: witnessDigest.value,
      },
    }).ok).toBe(false);

    const reloadedBlocked = restoredBlocked.ok && restoredBlocked.value.kind === "recoverable-blocked"
      ? restoredBlocked.value
      : null;
    expect(reloadedBlocked).not.toBeNull();
    if (reloadedBlocked === null) return;
    const recovered = reduceStandaloneReviewMachine(reloadedBlocked, {
      kind: "recovery-receipt-accepted",
      receipt: {
        kind: "agent-requests-reserved", effectId: effect.value, runId: authority.runId,
        requestIds: requests.map(({ requestId }) => requestId) as [typeof requests[number]["requestId"], ...typeof requests[number]["requestId"][]],
      },
    });
    expect(recovered.ok).toBe(true);
    if (recovered.ok) {
      expect(recovered.value.kind).toBe("preparing");
      expect(serializeStandaloneReviewMachineState(recovered.value)).toBe(
        serializeStandaloneReviewMachineState(started),
      );
    }
  });

  it("property: terminal states reject every late, stale, or surplus event", () => {
    const authority = preparedAuthority();
    const started = startStandaloneReviewMachine(authority);
    const awaiting = reduceStandaloneReviewMachine(started, { kind: "review-batch-published", runId: authority.runId });
    if (!awaiting.ok || awaiting.value.kind !== "awaiting-results") throw new Error("awaiting state required");
    const slot = authority.roster.orderedSlots[0]!;
    const retry = reduceStandaloneReviewMachine(awaiting.value, { kind: "result-rejected", request: slot.attempts[0], message: "bad" });
    if (!retry.ok || retry.value.kind !== "awaiting-results") throw new Error("retry state required");
    const terminal = reduceStandaloneReviewMachine(retry.value, { kind: "result-rejected", request: slot.attempts[1], message: "bad again" });
    if (!terminal.ok) throw new Error("terminal state required");
    const lateEffect = parseEffectId("effect:late");
    if (!lateEffect.ok) throw new Error(lateEffect.error.message);
    const events: readonly StandaloneReviewMachineEvent[] = [
      { kind: "review-batch-published", runId: authority.runId },
      { kind: "result-rejected", request: slot.attempts[1], message: "late" },
      { kind: "recoverable-effect-failed", diagnostic: {
        kind: "effect-blocked", category: "partial-publication", runId: authority.runId,
        effectId: lateEffect.value, message: "late", retry: { kind: "infrastructure", eligible: true, consumesSemanticAttempt: false },
        recovery: { kind: "retry-effect", effectId: lateEffect.value },
      }, intent: {
        kind: "reserve-agent-requests", effectId: lateEffect.value, runId: authority.runId,
        requests: [authority.roster.orderedSlots[0]!.attempts[0]],
      } },
    ];
    fc.assert(fc.property(fc.constantFrom(...events), (event) => {
      const result = reduceStandaloneReviewMachine(terminal.value, event);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("undeclared-transition");
    }));
  });

  it("property: the closed transition table is exact and every undeclared pair is denied", () => {
    expect(STANDALONE_REVIEW_DECLARED_TRANSITIONS).toEqual({
      preparing: ["review-batch-published", "recoverable-effect-failed"],
      "awaiting-results": ["result-accepted", "result-rejected", "complete-roster-proved", "recoverable-effect-failed"],
      aggregating: ["aggregate-clean", "aggregate-has-criticals", "recoverable-effect-failed"],
      "awaiting-refutation": ["refutation-completed", "recoverable-effect-failed"],
      "ready-to-finalize": ["result-published", "recoverable-effect-failed"],
      "recoverable-blocked": ["recoverable-effect-failed", "recovery-receipt-accepted"],
      done: [],
      "terminal-blocked": [],
    });
    const states = Object.keys(STANDALONE_REVIEW_DECLARED_TRANSITIONS) as (keyof typeof STANDALONE_REVIEW_DECLARED_TRANSITIONS)[];
    const events: StandaloneReviewMachineEvent["kind"][] = [
      "review-batch-published", "result-accepted", "result-rejected", "complete-roster-proved",
      "aggregate-clean", "aggregate-has-criticals", "refutation-completed", "result-published",
      "recoverable-effect-failed", "recovery-receipt-accepted",
    ];
    fc.assert(fc.property(fc.constantFrom(...states), fc.constantFrom(...events), (state, event) => {
      expect(isDeclaredStandaloneReviewTransition(state, event)).toBe(
        (STANDALONE_REVIEW_DECLARED_TRANSITIONS[state] as readonly string[]).includes(event),
      );
    }));

    const authority = preparedAuthority();
    const preparing = startStandaloneReviewMachine(authority);
    const invalidEvents: readonly StandaloneReviewMachineEvent[] = [
      { kind: "aggregate-clean", aggregate: required().aggregate },
      {
        kind: "result-rejected",
        request: authority.roster.orderedSlots[0]!.attempts[0],
        message: "result cannot arrive before publication",
      },
    ];
    fc.assert(fc.property(fc.constantFrom(...invalidEvents), (event) => {
      expect(reduceStandaloneReviewMachine(preparing, event).ok).toBe(false);
    }));
  });
});
