import { createHash } from "node:crypto";
import { legacyStandaloneContext, legacyFixtureReviewerProtocols } from "../fixtures/standalone-reviewer-protocol";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MAX_STRUCTURED_REPORT_BYTES, parseStructuredTestReportBytes } from "../../src/core/structured-test-report";
import { remediationCheckObservedEvent, replayRemediationCheckObservedEvent } from "../../src/handlers/helpers/programs/remediation-events";
import {
  authorizeRemediationChecks,
  compareCandidateRepositoryWitnesses,
  createCandidateRepositoryWitness,
  createRemediationCheckScope,
  prepareDefectFamilyAccounting,
  evaluateInstallableDefectFamilyAccounting,
  inspectInstallableDefectFamilyAssessment,
  parseCandidateRepositoryWitness,
  parseRegisteredRemediationCheckObservation,
  prepareDefectFamilyVerification,
  type AuthorizedRemediationCheck,
  type CandidateRepositoryWitness,
  type PreparedDefectFamilyAccounting,
  type DefectFamilyVerificationPlan,
  type EngineObservedRepairedCheck,
  type InstallableDefectFamilyAssessment,
} from "../../src/core/defect-family-accounting";
import { parseReportSummary } from "../../src/machine/test-report";
import { parseRepositorySnapshotWitness } from "../../src/core/remediation-machine";
import {
  VERIFICATION_MANIFEST_KIND,
  freezeVerificationManifest,
} from "../../src/core/verification-manifest";
import { standaloneFixture } from "../fixtures/standalone-remediation-authority";
import { buildStandaloneFindingBrief, type ReviewLens, type WaveFindingId } from "../../src/core/review-panel";
import {
  acceptedAgentResult,
  createAtomicInitialPublicationClaimPort,
  createInitialBatchPublicationReconciler,
  createInitialPublicationEffectPort,
  createPublicationAuthorityResolver,
  parseArtifactDigest,
  parseArtifactRef,
  prepareInitialBatchPublicationIntent,
  spawnBatchAction,
  type BatchPublishedReceipt,
  type InitialBatchPublicationIntent,
  type SpawnRequest,
} from "../../src/core/orchestration-contract";
import { aggregateStandaloneReview, proveStandaloneRosterCompletion } from "../../src/core/standalone-review";
import { capturedReviewerResultFromText } from "../../src/core/standalone-reviewer-capture";
import { prepareStandaloneReview } from "../../src/core/standalone-review-preparation";
import { serializeAdjudicatedStandaloneReview } from "../../src/core/standalone-review-records";
import { freezeStandaloneRefutationPanelAuthority, parseStandaloneRefutationCompletion } from "../../src/core/standalone-refutation-completion";
import {
  parseAuthoritativeStandaloneReviewResult,
  reduceStandaloneReviewMachine,
  startStandaloneReviewMachine,
  type AuthoritativeStandaloneReviewResult,
} from "../../src/core/standalone-review-machine";
import { deriveRefutationVerifierBinding, parseRefutationPanelAuthority } from "../../src/core/panel-authority";
import {
  completePersistentRefutationPanel,
  panelRequestIdentity,
  startPersistentRefutationPanel,
  submitRefutationVerdict,
} from "../../src/core/persistent-panel";
import type { NonEmpty } from "../../src/core/orchestration-contract";

const digest = (character: string): string => character.repeat(64);

function valueOf<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown }): T {
  if (!result.ok) throw new Error(`fixture construction failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

function source(withCritical = true): AuthoritativeStandaloneReviewResult {
  return standaloneFixture(withCritical ? ["src/main.ts", "src/family.ts"] : ["src/clean.ts"], withCritical).input.standaloneResult;
}

function declarationRaw(
  inventory: AuthoritativeStandaloneReviewResult,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const findingId = inventory.survivingCriticals[0]?.id;
  if (findingId === undefined) return { kind: "not-required", ...overrides };
  return {
    kind: "declared-defect-family-accounting",
    provenance: "DECLARED",
    dispositions: [{ findingId, status: "repaired", repairGroupId: "family:parser" }],
    groups: [{
      kind: "declared-repair-group",
      provenance: "DECLARED",
      repairGroupId: "family:parser",
      findingIds: [findingId],
      rootCause: { provenance: "DECLARED", statement: "The parser admitted an invalid state." },
      invariant: { provenance: "DECLARED", statement: "Only parser-produced states cross the seam." },
      siblings: { kind: "none-declared", provenance: "DECLARED", reason: "No sibling paths were identified." },
      checks: [{
        checkId: "project:defect-family",
        historicalRed: {
          kind: "historical-red",
          provenance: "DECLARED",
          statement: "The regression distinguishes the vulnerable behavior.",
          reference: null,
        },
      }],
    }],
    ...overrides,
  };
}

function declaration(inventory = source()): PreparedDefectFamilyAccounting {
  return valueOf(prepareDefectFamilyAccounting(inventory, declarationRaw(inventory)));
}

function mixedDeclarationRaw(
  inventory: AuthoritativeStandaloneReviewResult,
  secondSiblingStatus: "repaired" | "checked-unmodified" = "checked-unmodified",
) {
  const [first, second] = inventory.survivingCriticals;
  if (first === undefined || second === undefined) throw new Error("two surviving criticals required");
  const group = (repairGroupId: string, findingId: string, siblingStatus: "repaired" | "checked-unmodified") => ({
    kind: "declared-repair-group",
    provenance: "DECLARED",
    repairGroupId,
    findingIds: [findingId],
    rootCause: { provenance: "DECLARED", statement: `Declared root cause for ${repairGroupId}.` },
    invariant: { provenance: "DECLARED", statement: `Declared invariant for ${repairGroupId}.` },
    siblings: {
      kind: "declared-siblings",
      provenance: "DECLARED",
      entries: [{ path: "src/shared.ts", status: siblingStatus, reason: `Declared ${siblingStatus} disposition.` }],
    },
    checks: [{
      checkId: "project:defect-family",
      historicalRed: {
        kind: "historical-red", provenance: "DECLARED",
        statement: `Declared historical RED for ${repairGroupId}.`, reference: null,
      },
    }],
  });
  return {
    kind: "declared-defect-family-accounting",
    provenance: "DECLARED",
    dispositions: [
      { findingId: first.id, status: "repaired", repairGroupId: "family:first" },
      { findingId: second.id, status: "repaired", repairGroupId: "family:second" },
    ],
    groups: [
      group("family:first", first.id, "checked-unmodified"),
      group("family:second", second.id, secondSiblingStatus),
    ],
  };
}

function frozenManifest(checkIds: readonly string[] = ["project:defect-family"]) {
  const raw = {
    schemaVersion: 1,
    kind: VERIFICATION_MANIFEST_KIND,
    checks: checkIds.map((id, index) => ({
      id,
      scope: "wave",
      executable: "bun",
      args: ["test", `tests/${index}.test.ts`],
      cwd: ".",
      timeoutMs: 60_000,
      report: { kind: "required-file", path: `.loom/completion-reports/${index}.json` },
    })),
  };
  return valueOf(freezeVerificationManifest(new TextEncoder().encode(JSON.stringify(raw))));
}

function selectedPlan(
  inventory = source(),
  parsedDeclaration = declaration(inventory),
): Extract<DefectFamilyVerificationPlan, { readonly kind: "selected-operator-checks" }> {
  const plan = valueOf(prepareDefectFamilyVerification(parsedDeclaration, frozenManifest()));
  if (plan.kind !== "selected-operator-checks") throw new Error("selected plan required");
  return plan;
}

function candidate(offset = 0): CandidateRepositoryWitness {
  const gitWitness = valueOf(parseRepositorySnapshotWitness({
    baseTreeDigest: digest(String((offset + 1) % 10)),
    indexDigest: digest(String((offset + 2) % 10)),
    worktreeDigest: digest(String((offset + 3) % 10)),
  }));
  return valueOf(createCandidateRepositoryWitness({
    kind: "candidate-repository-witness",
    repositoryRoot: "/repo",
    workspaceDigest: digest(String((offset + 4) % 10)),
    pathCount: 5,
    observedPaths: ["src/family.ts", "src/main.ts", "src/shared.ts", "src/repaired-sibling.ts", "src/stable-sibling.ts"],
    gitWitness,
    generatedReportExclusions: [".loom/completion-reports/0.json"],
  }));
}

function authorization(
  plan: Extract<DefectFamilyVerificationPlan, { readonly kind: "selected-operator-checks" }>,
  witness: CandidateRepositoryWitness,
): AuthorizedRemediationCheck {
  const scope = valueOf(createRemediationCheckScope(plan.source, witness, {
    kind: "standalone-remediation",
    remediationRunId: "run.remediation-p3",
    sourceRunId: plan.source.sourceRunId,
    registrationDigest: digest("a"),
    candidateWitnessDigest: witness.digest,
  }));
  return valueOf(authorizeRemediationChecks(plan, scope))[0];
}

function observed(
  check: AuthorizedRemediationCheck,
  witness: CandidateRepositoryWitness,
): EngineObservedRepairedCheck {
  const summary = parseReportSummary(3, 0, "vitest-json");
  if (summary === null) throw new Error("summary fixture failed");
  return valueOf(parseRegisteredRemediationCheckObservation(check, witness, witness, {
    kind: "remediation-check-observed",
    checkId: check.command.checkId,
    registrationDigest: check.scope.registrationDigest,
    authorityDigest: check.authorityDigest,
    candidateWitnessDigest: witness.digest,
    process: { exitCode: 0, timedOut: false, signal: null },
    report: {
      path: check.command.reportPolicy.path,
      digest: digest("b"),
      byteLength: 128,
      mode: 33_188,
      summary,
    },
    beforeCandidateDigest: witness.digest,
    afterCandidateDigest: witness.digest,
  }));
}

function deepFrozen(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return true;
  return Object.isFrozen(raw) && Object.values(raw).every(deepFrozen);
}

function publishBatch(intent: InitialBatchPublicationIntent, requests: readonly unknown[]) {
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

let mixedSourceInventory: AuthoritativeStandaloneReviewResult | null = null;

/** Genuine LC-2 result: two survivors, one refuted critical, and one advisory. */
function sourceWithEveryFindingClass(): AuthoritativeStandaloneReviewResult {
  if (mixedSourceInventory !== null) return mixedSourceInventory;
  const runId = "run.defect-family-mixed";
  const rawAuthority = (attempt: 1 | 2) => ({
    runId,
    requestId: `request:defect-family:mixed:${attempt}`,
    slotId: "slot:defect-family:mixed",
    program: "standalone-review",
    role: "code-reviewer",
    attempt,
    modelProfile: "general-review",
    harnessBinding: {
      pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
      claude: { harness: "claude-code", model: "sonnet" },
    },
    requiredSkill: null,
    contextDigest: legacyStandaloneContext({ runId, requestId: `request:defect-family:mixed:${attempt}`, role: "code-reviewer", attempt, requiredSkill: null }, ["src/main.ts"]).digest,
    outputSlot: `transcripts/mixed/attempt-${attempt}.raw`,
  });
  const prepared = prepareStandaloneReview({
    runId,
    explicitScope: ["src/main.ts"],
    changedPaths: {
      unstaged: ["src/main.ts"], staged: [], committed: [], base_revision: null,
      head_revision: "0123456789abcdef0123456789abcdef01234567",
    },
    reviewMetadata: {
      requested_kinds: ["types"], docs_only: false, source_or_test_changed: false,
      types_changed: false, comments_changed: false, additions: 1, file_count: 1,
      new_structure: false, languages: ["TypeScript"],
    },
    scopeSafety: [{ path: "src/main.ts", status: "safe" }],
    roster: [{ slotId: "slot:defect-family:mixed", attempts: [rawAuthority(1), rawAuthority(2)] }],
  });
  if (!prepared.ok) throw new Error(prepared.error.errors.join("; "));
  const authority = prepared.value.authority;
  const requestInputs = authority.roster.orderedSlots.map(({ attempts }) => ({
    authority: attempts[0],
    context: { digest: attempts[0].contextDigest, slot: `contexts/${attempts[0].contextDigest}.json` },
  }));
  const initialIntent = prepareInitialBatchPublicationIntent(runId, "effect:defect-family-mixed", requestInputs);
  if (!initialIntent.ok) throw new Error(initialIntent.error.message);
  const initial = publishBatch(initialIntent.value, requestInputs);
  const issued = initial.action.requests[0] as SpawnRequest;
  const findings = [
    { severity: "critical", file: "src/main.ts", line: 1, claim: "first surviving critical" },
    { severity: "critical", file: "src/main.ts", line: 2, claim: "second surviving critical" },
    { severity: "critical", file: "src/main.ts", line: 3, claim: "panel-refuted critical" },
    { severity: "advisory", file: "src/main.ts", line: 4, claim: "advisory only" },
  ] as const;
  const transcript = [
    "### Machine Summary",
    "CRITICAL_COUNT: 3",
    "ADVISORY_COUNT: 1",
    ...findings.filter(({ severity }) => severity === "critical").map(({ claim }) => `CRITICAL: ${claim}`),
    ...findings.filter(({ severity }) => severity === "advisory").map(({ claim }) => `ADVISORY: ${claim}`),
    "",
    "```findings",
    JSON.stringify(findings),
    "```",
  ].join("\n");
  const bytes = Buffer.from(transcript, "utf8");
  const artifact = parseArtifactRef({
    runId,
    slot: issued.authority.outputSlot,
    digest: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.byteLength,
  });
  if (!artifact.ok) throw new Error(artifact.error.message);
  const captured = capturedReviewerResultFromText(artifact.value, transcript);
  if (!captured.ok) throw new Error(captured.error.message);
  const accepted = acceptedAgentResult(issued, captured.value);
  if (!accepted.ok) throw new Error(accepted.error.message);
  const initialResolver = createPublicationAuthorityResolver(() => ({ ok: true, value: initial.receiptBytes }));
  const completion = proveStandaloneRosterCompletion(authority, initialResolver, [accepted.value], legacyFixtureReviewerProtocols(authority, initialResolver, initial.action.requests));
  if (!completion.ok) throw new Error(JSON.stringify(completion.error));
  const aggregate = aggregateStandaloneReview({ authority, completion: completion.value });
  if (!aggregate.ok || aggregate.value.kind !== "requires-refutation") {
    throw new Error(aggregate.ok ? "critical aggregate required" : aggregate.errors.join("; "));
  }

  const panelRunId = "run.defect-family-mixed-panel";
  const lenses = ["reproduction", "intent"] as const;
  const brief = buildStandaloneFindingBrief(aggregate.value.aggregate);
  const findingIds = brief.findings.map(({ id }) => id) as unknown as NonEmpty<WaveFindingId>;
  const panelSlots = lenses.map((lens, index) => {
    const binding = deriveRefutationVerifierBinding(panelRunId as never, lens as ReviewLens, findingIds);
    if (!binding.ok) throw new Error(binding.errors.join("; "));
    return {
      slotId: binding.value.slotId,
      attempts: ([1, 2] as const).map((attempt, attemptIndex) => ({
        runId: panelRunId,
        requestId: binding.value.requestIds[attemptIndex],
        slotId: binding.value.slotId,
        program: "refutation-panel",
        role: "review-verifier-agent",
        attempt,
        modelProfile: "refutation",
        harnessBinding: {
          pi: { harness: "pi", provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
          claude: { harness: "claude-code", model: "opus" },
        },
        requiredSkill: null,
        contextDigest: digest(String(index * 2 + attempt + 1)),
        outputSlot: `transcripts/mixed-panel-${index}/attempt-${attempt}.raw`,
      })),
    };
  });
  const panelAuthority = parseRefutationPanelAuthority({
    runId: panelRunId,
    findings: brief.findings,
    lenses,
    verifierSlots: panelSlots,
  });
  if (!panelAuthority.ok) throw new Error(panelAuthority.error.message);
  const frozenPanel = freezeStandaloneRefutationPanelAuthority({
    standaloneAuthority: authority,
    aggregate: aggregate.value.aggregate,
    panelAuthority: panelAuthority.value,
    threshold: 2,
  });
  if (!frozenPanel.ok) throw new Error(frozenPanel.error.message);
  const panelInputs = panelAuthority.value.verifierRoster.orderedSlots.map(({ attempts }) => ({
    authority: attempts[0],
    context: { digest: attempts[0].contextDigest, slot: `contexts/${attempts[0].contextDigest}.json` },
  }));
  const panelIntent = prepareInitialBatchPublicationIntent(panelRunId, "effect:defect-family-mixed-panel", panelInputs);
  if (!panelIntent.ok) throw new Error(panelIntent.error.message);
  const panelPublished = publishBatch(panelIntent.value, panelInputs);
  const panelResolver = createPublicationAuthorityResolver(() => ({ ok: true, value: panelPublished.receiptBytes }));
  let panelState = startPersistentRefutationPanel(panelAuthority.value).state;
  panelPublished.action.requests.forEach((request, lensIndex) => {
    const lens = lenses[lensIndex]!;
    const submitted = submitRefutationVerdict(
      panelState,
      panelResolver,
      panelRequestIdentity(request),
      JSON.stringify({
        criterion: lens,
        verdicts: panelAuthority.value.findings.map((finding, index) => ({
          finding_id: finding.id,
          verdict: index === 2 ? "refuted" : "upheld",
          reasoning: index === 2 ? `${lens} disproves the third finding` : `${lens} upholds survivor`,
        })),
      }),
    );
    if (!submitted.ok) throw new Error(submitted.error.message);
    panelState = submitted.value.state;
  });
  const panelDone = completePersistentRefutationPanel(panelState, panelResolver, 2);
  if (!panelDone.ok || panelDone.value.state.stage !== "done") {
    throw new Error(panelDone.ok ? "done panel required" : panelDone.error.message);
  }
  const panelCompletion = parseStandaloneRefutationCompletion({
    panelAuthority: frozenPanel.value,
    aggregate: aggregate.value.aggregate,
    completedPanelState: panelDone.value.state,
  });
  if (!panelCompletion.ok) throw new Error(panelCompletion.error.message);

  const started = startStandaloneReviewMachine(authority);
  const awaiting = reduceStandaloneReviewMachine(started, { kind: "review-batch-published", runId });
  if (!awaiting.ok) throw new Error(awaiting.error.message);
  const aggregating = reduceStandaloneReviewMachine(awaiting.value, {
    kind: "complete-roster-proved", completion: completion.value,
  });
  if (!aggregating.ok) throw new Error(aggregating.error.message);
  const routed = reduceStandaloneReviewMachine(aggregating.value, {
    kind: "aggregate-has-criticals",
    aggregate: aggregate.value.aggregate,
    panelAuthority: frozenPanel.value,
    refutationAuthority: panelAuthority.value,
  });
  if (!routed.ok) throw new Error(routed.error.message);
  const ready = reduceStandaloneReviewMachine(routed.value, {
    kind: "refutation-completed", completion: panelCompletion.value,
  });
  if (!ready.ok || ready.value.kind !== "ready-to-finalize") throw new Error("ready finalization required");
  const receipt = {
    kind: "artifact-set-published" as const,
    effectId: ready.value.publicationIntent.effectId,
    runId: authority.runId,
    artifacts: ready.value.publicationIntent.artifacts,
  };
  const authoritative = parseAuthoritativeStandaloneReviewResult(
    ready.value,
    JSON.parse(serializeAdjudicatedStandaloneReview(ready.value.result)),
    receipt,
  );
  if (!authoritative.ok) throw new Error(authoritative.error.message);
  mixedSourceInventory = authoritative.value;
  return mixedSourceInventory;
}

describe("source-bound Defect-Family Accounting", () => {
  it("derives a defensive, immutable inventory only from actual opaque LC-2 authority", () => {
    const fixture = standaloneFixture(["src/main.ts", "src/family.ts"], true);
    const accounting = valueOf(prepareDefectFamilyAccounting(fixture.input.standaloneResult, declarationRaw(fixture.input.standaloneResult)));
    const inventory = accounting.source;

    expect(inventory.sourceRunId).toBe(fixture.input.standaloneResult.runId);
    expect(inventory.sourceResultDigest).toBe(fixture.input.publicationReceipt.artifacts[0]?.digest);
    expect(inventory.survivingCriticals).toEqual(fixture.input.standaloneResult.survivingCriticals);
    expect(inventory.survivingCriticals[0]).not.toBe(fixture.input.standaloneResult.survivingCriticals[0]);
    expect(deepFrozen(inventory)).toBe(true);

    const manufactured = structuredClone(fixture.input.standaloneResult);
    expect(prepareDefectFamilyAccounting(manufactured as typeof fixture.input.standaloneResult, accounting.declaration).ok).toBe(false);
  });

  it("needs no manifest or process observation for zero criticals, but still parses audit facts", () => {
    const accounting = valueOf(prepareDefectFamilyAccounting(source(false), { kind: "not-required" }));
    const plan = valueOf(prepareDefectFamilyVerification(accounting, null));
    const witness = candidate();
    const assessment = valueOf(evaluateInstallableDefectFamilyAccounting(plan, witness, {
      auditedInstalledPaths: [], dirtyOrStagedPaths: [],
    }, []));
    expect(plan.kind).toBe("not-required");
    expect(assessment).toMatchObject({ status: "not-required", reason: "no-surviving-critical-findings" });
    expect(deepFrozen(assessment)).toBe(true);
    expect(valueOf(inspectInstallableDefectFamilyAssessment(assessment))).toMatchObject({
      status: "not-required", candidateWitnessDigest: null,
    });
    expect(inspectInstallableDefectFamilyAssessment({
      status: "historical-unknown", reason: "legacy-remediation-has-no-p3-accounting",
    } as unknown as InstallableDefectFamilyAssessment).ok).toBe(false);
    for (const raw of [null, {}, { auditedInstalledPaths: [] }, { auditedInstalledPaths: [], dirtyOrStagedPaths: null }]) {
      expect(evaluateInstallableDefectFamilyAccounting(plan, witness, raw, []).ok).toBe(false);
    }
  });

  it("accepts an all-unresolved declaration with zero groups and evaluates it as blocked", () => {
    const inventory = source();
    const findingId = inventory.survivingCriticals[0]!.id;
    const parsed = valueOf(prepareDefectFamilyAccounting(inventory, {
      kind: "declared-defect-family-accounting",
      provenance: "DECLARED",
      dispositions: [{ findingId, status: "unresolved", reason: "The repair is not implemented." }],
      groups: [],
    }));
    const plan = valueOf(prepareDefectFamilyVerification(parsed, null));
    const assessment = evaluateInstallableDefectFamilyAccounting(plan, candidate(), {
      auditedInstalledPaths: [], dirtyOrStagedPaths: [],
    }, []);
    expect(plan.kind).toBe("blocked-declaration");
    expect(assessment.ok).toBe(false);
    if (!assessment.ok) expect(assessment.error.failures.map(({ code }) => code)).toContain("unresolved-critical");
  });

  it("rejects missing, duplicate, and foreign partition members", () => {
    const inventory = source();
    const findingId = inventory.survivingCriticals[0]!.id;
    const base = declarationRaw(inventory);
    const cases = [
      { ...base, dispositions: [] },
      { ...base, dispositions: [
        { findingId, status: "repaired", repairGroupId: "family:parser" },
        { findingId, status: "repaired", repairGroupId: "family:parser" },
      ] },
      { ...base, dispositions: [{ findingId: "foreign-1", status: "repaired", repairGroupId: "family:parser" }] },
    ];
    for (const raw of cases) expect(prepareDefectFamilyAccounting(inventory, raw).ok).toBe(false);
  });

  it("never admits actual advisory or refuted Finding ids from the authoritative source", () => {
    const inventory = sourceWithEveryFindingClass();
    expect(inventory.survivingCriticals).toHaveLength(2);
    expect(inventory.advisories).toHaveLength(1);
    expect(inventory.refutedCriticals).toHaveLength(1);
    const base = mixedDeclarationRaw(inventory);
    const advisoryId = inventory.advisories[0]!.id;
    const refutedId = inventory.refutedCriticals[0]!.finding.id;
    for (const findingId of [advisoryId, refutedId]) {
      const dispositions = [...base.dispositions];
      dispositions[0] = { ...dispositions[0]!, findingId };
      const parsed = prepareDefectFamilyAccounting(inventory, { ...base, dispositions });
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.failures.map(({ code }) => code)).toContain(
          findingId === advisoryId ? "advisory-finding" : "refuted-finding",
        );
      }
    }
  });

  it("rejects process authority fields and every unknown field from declaration prose", () => {
    const inventory = source();
    const base = declarationRaw(inventory);
    const forbidden = ["executable", "args", "cwd", "timeoutMs", "report", "passed", "reportBytes", "modelClaim"];
    for (const field of forbidden) {
      expect(prepareDefectFamilyAccounting(inventory, { ...base, [field]: "forged" }).ok, field).toBe(false);
    }
    const group = (base.groups as Record<string, unknown>[])[0]!;
    expect(prepareDefectFamilyAccounting(inventory, {
      ...base,
      groups: [{ ...group, unknown: true }],
    }).ok).toBe(false);
  });

  it("rejects inherited and accessor-backed declaration records without invoking accessors", () => {
    const inventory = source();
    const inherited = Object.assign(Object.create({ executable: "sh" }), declarationRaw(inventory));
    expect(prepareDefectFamilyAccounting(inventory, inherited).ok).toBe(false);

    let accessed = false;
    const accessor = { ...declarationRaw(inventory) };
    Object.defineProperty(accessor, "groups", {
      enumerable: true,
      get: () => {
        accessed = true;
        return [];
      },
    });
    expect(prepareDefectFamilyAccounting(inventory, accessor).ok).toBe(false);
    expect(accessed).toBe(false);
  });

  it("rejects duplicate sibling paths within a group, but accepts compatible reuse across distinct groups", () => {
    const inventory = sourceWithEveryFindingClass();
    const base = mixedDeclarationRaw(inventory);
    const firstGroup = base.groups[0]!;
    const sibling = firstGroup.siblings.entries[0]!;
    expect(prepareDefectFamilyAccounting(inventory, {
      ...base,
      groups: [
        { ...firstGroup, siblings: { ...firstGroup.siblings, entries: [sibling, sibling] } },
        base.groups[1],
      ],
    }).ok).toBe(false);

    const compatible = prepareDefectFamilyAccounting(inventory, base);
    expect(compatible.ok).toBe(true);
    if (compatible.ok && compatible.value.declaration.kind === "declared-defect-family-accounting") {
      expect(compatible.value.declaration.groups).toHaveLength(2);
      expect(compatible.value.declaration.groups.map(({ repairGroupId }) => repairGroupId)).toEqual(["family:first", "family:second"]);
      expect(compatible.value.siblingPaths).toEqual(["src/shared.ts"]);
      const permuted = valueOf(prepareDefectFamilyAccounting(inventory, {
        ...base,
        dispositions: [...base.dispositions].reverse(),
        groups: [...base.groups].reverse(),
      }));
      expect(permuted).toEqual(compatible.value);

      const plan = selectedPlan(inventory, compatible.value);
      const witness = candidate();
      const check = observed(authorization(plan, witness), witness);
      const assessment = valueOf(evaluateInstallableDefectFamilyAccounting(plan, witness, {
        auditedInstalledPaths: ["src/main.ts"], dirtyOrStagedPaths: ["src/main.ts"],
      }, [check]));
      expect(assessment.status).toBe("repair-checked");
    }
    expect(prepareDefectFamilyAccounting(inventory, mixedDeclarationRaw(inventory, "repaired")).ok).toBe(false);
  });

  it("rejects protected sibling paths", () => {
    const inventory = source();
    const base = declarationRaw(inventory);
    const group = (base.groups as Record<string, unknown>[])[0]!;
    for (const path of [
      ".git/index", ".claude/state/active_task_graph.json", ".claude/reviews/run/result.json",
      ".pi/reviews/run/result.json", ".loom/verification-manifest.json", ".loom/completion-reports/result.json",
    ]) {
      expect(prepareDefectFamilyAccounting(inventory, {
        ...base,
        groups: [{
          ...group,
          siblings: {
            kind: "declared-siblings", provenance: "DECLARED",
            entries: [{ path, status: "repaired", reason: "Not admissible." }],
          },
        }],
      }).ok, path).toBe(false);
    }
  });
});

describe("report observation resource limits", () => {
  it("rejects oversized summary-only observations independently of the byte parser", () => {
    const witness = candidate();
    const check = authorization(selectedPlan(), witness);
    const { report, process } = observed(check, witness);
    const raw = {
      kind: "remediation-check-observed", checkId: check.command.checkId,
      registrationDigest: check.scope.registrationDigest, authorityDigest: check.authorityDigest,
      candidateWitnessDigest: witness.digest, beforeCandidateDigest: witness.digest, afterCandidateDigest: witness.digest,
      process, report: { ...report, byteLength: MAX_STRUCTURED_REPORT_BYTES },
    };
    expect(parseRegisteredRemediationCheckObservation(check, witness, witness, raw).ok).toBe(true);
    fc.assert(fc.property(fc.integer({ min: MAX_STRUCTURED_REPORT_BYTES + 1, max: MAX_STRUCTURED_REPORT_BYTES * 2 }), (byteLength) => {
      expect(parseRegisteredRemediationCheckObservation(check, witness, witness, {
        ...raw, report: { ...raw.report, byteLength },
      }).ok).toBe(false);
    }));
  });

  it("limits durable serialization before copying and replay before base64 decoding", () => {
    const witness = candidate();
    const check = authorization(selectedPlan(), witness);
    const bytes = new TextEncoder().encode('<testsuite tests="1" failures="0"/>');
    const execution = {
      kind: "remediation-check-execution" as const,
      checkId: check.command.checkId, scope: check.scope, manifestDigest: check.manifestDigest, authorityDigest: check.authorityDigest,
      process: { kind: "observed" as const, exitCode: 0, timedOut: false, signal: null },
      report: {
        outcome: { kind: "produced" as const, path: check.command.reportPolicy.path, digest: valueOf(parseArtifactDigest(createHash("sha256").update(bytes).digest("hex"))), byteLength: bytes.byteLength },
        bytes, mode: 33_188, parsedReportFacts: parseStructuredTestReportBytes(bytes),
      },
      diagnostics: { stdoutTail: "", stderrTail: "", stdoutTruncated: false, stderrTruncated: false },
    };
    const event = remediationCheckObservedEvent(execution, witness, witness);
    expect(replayRemediationCheckObservedEvent(event, check, witness)).toMatchObject({ ok: true, value: { kind: "passed" } });
    if (event.report?.kind !== "produced") throw new Error("produced fixture required");
    const atLimit = Buffer.from('<testsuite tests="1" failures="0"/>'.padEnd(MAX_STRUCTURED_REPORT_BYTES, " "));
    expect(replayRemediationCheckObservedEvent({ ...event, report: {
      ...event.report, byteLength: atLimit.byteLength, bytes: atLimit.toString("base64"),
      digest: createHash("sha256").update(atLimit).digest("hex"),
    } }, check, witness)).toMatchObject({ ok: true, value: { kind: "passed" } });
    const overLimit = "A".repeat(4 * Math.ceil(MAX_STRUCTURED_REPORT_BYTES / 3));
    for (const report of [
      { ...event.report, byteLength: MAX_STRUCTURED_REPORT_BYTES + 1, bytes: "!" },
      { ...event.report, bytes: overLimit },
      { ...event.report, bytes: overLimit + "!" },
    ]) {
      expect(replayRemediationCheckObservedEvent({ ...event, report }, check, witness)).toMatchObject({
        ok: false, error: { message: expect.stringContaining("before base64 decoding") },
      });
    }
    const oversized = new Uint8Array(MAX_STRUCTURED_REPORT_BYTES + 1);
    let copied = false;
    Object.defineProperty(oversized, Symbol.iterator, { value() { copied = true; throw new Error("must not copy"); } });
    expect(remediationCheckObservedEvent({
      ...execution, report: { ...execution.report, bytes: oversized },
    }, witness, witness).report).toMatchObject({ kind: "unreadable" });
    expect(copied).toBe(false);
  });
});

describe("fixed command, candidate, and engine-observation authority", () => {
  it("selects only required-report project commands from frozen operator authority", () => {
    const inventory = source();
    const parsedDeclaration = declaration(inventory);
    const plan = selectedPlan(inventory, parsedDeclaration);

    expect(plan.commands.map(({ checkId }) => checkId)).toEqual(["project:defect-family"]);
    expect(plan.commands[0]?.reportPolicy.kind).toBe("required-file");
    expect(parsedDeclaration.selectedCheckIds).toEqual(["project:defect-family"]);

    const noReportRaw = {
      schemaVersion: 1,
      kind: VERIFICATION_MANIFEST_KIND,
      checks: [{
        id: "project:defect-family", scope: "wave", executable: "bun", args: ["test"], cwd: ".",
        timeoutMs: 60_000, report: { kind: "not-required" },
      }],
    };
    const noReport = valueOf(freezeVerificationManifest(new TextEncoder().encode(JSON.stringify(noReportRaw))));
    expect(prepareDefectFamilyVerification(parsedDeclaration, noReport).ok).toBe(false);
    expect(prepareDefectFamilyVerification(parsedDeclaration, null).ok).toBe(false);
  });

  it("parses candidate identity canonically and detects byte, Git, roster, and exclusion drift", () => {
    const left = candidate();
    const same = valueOf(parseCandidateRepositoryWitness({
      ...left,
      generatedReportExclusions: [...left.generatedReportExclusions].reverse(),
    }));
    expect(same).toEqual(left);
    expect(compareCandidateRepositoryWitnesses(left, same).ok).toBe(true);

    for (const mutation of [
      { ...left, workspaceDigest: digest("9") },
      { ...left, pathCount: left.pathCount + 1 },
      { ...left, generatedReportExclusions: [".loom/completion-reports/other.json"] },
      { ...left, gitWitness: { ...left.gitWitness, worktreeDigest: digest("8") } },
    ]) {
      const parsed = parseCandidateRepositoryWitness(mutation);
      if (parsed.ok) expect(compareCandidateRepositoryWitnesses(left, parsed.value).ok).toBe(false);
      else expect(parsed.ok).toBe(false);
    }
  });

  it("mints a repair-checked assessment only from exact engine-observed repaired checks", () => {
    const plan = selectedPlan();
    const witness = candidate();
    const check = authorization(plan, witness);
    const observation = observed(check, witness);
    const assessment = valueOf(evaluateInstallableDefectFamilyAccounting(plan, witness, {
      auditedInstalledPaths: ["src/family.ts"], dirtyOrStagedPaths: ["src/family.ts"],
    }, [observation]));

    expect(assessment.status).toBe("repair-checked");
    if (assessment.status !== "repair-checked") return;
    expect(assessment.provenance).toEqual({
      grouping: "DECLARED",
      rootCause: "DECLARED",
      invariant: "DECLARED",
      siblingAccounting: "DECLARED",
      historicalRed: "DECLARED",
      repairedTests: "ENGINE_OBSERVED",
    });
    const projection = valueOf(inspectInstallableDefectFamilyAssessment(assessment));
    expect(projection).toMatchObject({
      status: "repair-checked",
      sourceRunId: plan.source.sourceRunId,
      assessmentDigest: assessment.digest,
      candidateWitnessDigest: witness.digest,
    });
    expect(inspectInstallableDefectFamilyAssessment({ ...assessment } as typeof assessment).ok).toBe(false);
  });

  it("refuses forged aggregate authority and observation rosters before accessing fields", () => {
    const accounting = declaration();
    const plan = valueOf(prepareDefectFamilyVerification(accounting, frozenManifest()));
    if (plan.kind !== "selected-operator-checks") throw new Error("selected plan required");
    const witness = candidate();
    const observation = observed(authorization(plan, witness), witness);
    const audit = { auditedInstalledPaths: ["src/family.ts"], dirtyOrStagedPaths: ["src/family.ts"] };
    expect(prepareDefectFamilyVerification({ ...accounting }, frozenManifest()).ok).toBe(false);
    expect(evaluateInstallableDefectFamilyAccounting({ ...plan }, witness, audit, [observation]).ok).toBe(false);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    let accessed = false;
    const accessor = { get checkId() { accessed = true; throw new Error("must not access"); } };
    for (const forged of [structuredClone(observation), revoked.proxy, accessor]) {
      expect(evaluateInstallableDefectFamilyAccounting(plan, witness, audit, [forged as EngineObservedRepairedCheck]).ok).toBe(false);
    }
    expect(accessed).toBe(false);
    fc.assert(fc.property(fc.integer({ min: 0, max: 8 }).filter(count => count !== 1), count => {
      const result = evaluateInstallableDefectFamilyAccounting(plan, witness, audit, Array.from({ length: count }, () => observation));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.failures.map(({ code }) => code)).toContain(count === 0 ? "missing-repair-check" : "duplicate-repair-check");
    }));
    expect(evaluateInstallableDefectFamilyAccounting(plan, candidate(1), audit, [observation]).ok).toBe(false);
    expect(evaluateInstallableDefectFamilyAccounting(plan, witness, audit, [observation]).ok).toBe(true);
  });

  it("rejects stale source, registration, authority, check, candidate, and impossible report facts", () => {
    const plan = selectedPlan();
    const witness = candidate();
    const check = authorization(plan, witness);
    const summary = parseReportSummary(2, 0, "junit-xml");
    if (summary === null) throw new Error("summary fixture failed");
    const base = {
      kind: "remediation-check-observed",
      checkId: check.command.checkId,
      registrationDigest: check.scope.registrationDigest,
      authorityDigest: check.authorityDigest,
      candidateWitnessDigest: witness.digest,
      process: { exitCode: 0, timedOut: false, signal: null },
      report: {
        path: check.command.reportPolicy.path,
        digest: digest("b"), byteLength: 64, mode: 33_188, summary,
      },
      beforeCandidateDigest: witness.digest,
      afterCandidateDigest: witness.digest,
    } as const;
    const cases = [
      { ...base, checkId: "project:foreign" },
      { ...base, registrationDigest: digest("1") },
      { ...base, authorityDigest: digest("2") },
      { ...base, candidateWitnessDigest: digest("3") },
      { ...base, beforeCandidateDigest: digest("4") },
      { ...base, afterCandidateDigest: digest("5") },
      { ...base, process: { ...base.process, exitCode: 1 } },
      { ...base, process: { ...base.process, timedOut: true } },
      { ...base, report: { ...base.report, summary: { total: 0, failed: 0, source: "junit-xml" } } },
      { ...base, report: { ...base.report, summary: { total: 1, failed: 2, source: "junit-xml" } } },
      { ...base, report: { ...base.report, path: ".loom/completion-reports/foreign.json" } },
      { ...base, unexpected: true },
    ];
    for (const raw of cases) {
      expect(parseRegisteredRemediationCheckObservation(check, witness, witness, raw).ok).toBe(false);
    }

    const foreignSource = valueOf(prepareDefectFamilyAccounting(source(false), { kind: "not-required" })).source;
    const foreignScope = valueOf(createRemediationCheckScope(foreignSource, witness, {
      kind: "standalone-remediation",
      remediationRunId: "run.remediation-p3",
      sourceRunId: foreignSource.sourceRunId,
      registrationDigest: digest("a"),
      candidateWitnessDigest: witness.digest,
    }));
    expect(authorizeRemediationChecks(plan, foreignScope).ok).toBe(false);
  });

  it("requires repaired and checked-unmodified sibling path evidence without conflating groups", () => {
    const inventory = source();
    const base = declarationRaw(inventory);
    const group = (base.groups as Record<string, unknown>[])[0]!;
    const parsed = valueOf(prepareDefectFamilyAccounting(inventory, {
      ...base,
      groups: [{
        ...group,
        siblings: {
          kind: "declared-siblings",
          provenance: "DECLARED",
          entries: [
            { path: "src/repaired-sibling.ts", status: "repaired", reason: "Same parser invariant." },
            { path: "src/stable-sibling.ts", status: "checked-unmodified", reason: "Already conformed." },
          ],
        },
      }],
    }));
    const plan = selectedPlan(inventory, parsed);
    const witness = candidate();
    const observation = observed(authorization(plan, witness), witness);
    const accepted = valueOf(evaluateInstallableDefectFamilyAccounting(plan, witness, {
      auditedInstalledPaths: ["src/family.ts", "src/repaired-sibling.ts"],
      dirtyOrStagedPaths: ["src/family.ts", "src/repaired-sibling.ts"],
    }, [observation]));
    expect(accepted.status).toBe("repair-checked");

    const staleStable = evaluateInstallableDefectFamilyAccounting(plan, witness, {
      auditedInstalledPaths: ["src/family.ts", "src/repaired-sibling.ts", "src/stable-sibling.ts"],
      dirtyOrStagedPaths: ["src/family.ts", "src/repaired-sibling.ts", "src/stable-sibling.ts"],
    }, [observation]);
    expect(staleStable.ok).toBe(false);
    if (!staleStable.ok) expect(staleStable.error.failures.map(({ code }) => code)).toContain("checked-unmodified-sibling-dirty");
  });
});
