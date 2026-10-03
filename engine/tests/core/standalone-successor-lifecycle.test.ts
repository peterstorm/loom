import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { valueOf, standaloneFixture, publishBatch, upholdStandaloneCriticals } from "../fixtures/standalone-remediation-authority";
import { dispositionPublicationFixture } from "../fixtures/standalone-disposition-publication";
import { prepareStandaloneLineageSource, prepareStandaloneSuccessor, prepareStandaloneDisposition,
  standaloneOriginReference, standaloneDecisionReference, type PreparedStandaloneSuccessor } from "../../src/core/standalone-lineage";
import { type StandaloneReviewerPayloadV3 } from "../../src/core/standalone-lineage-contract";
import { buildStandaloneSuccessorReviewerContext, parseIssuedStandaloneSuccessorReviewer,
  standaloneSuccessorReviewerRegistration } from "../../src/core/standalone-successor-reviewer";
import { prepareFreshStandaloneReview, parseStandaloneReviewAuthority, serializeStandaloneReviewAuthority,
  capturedReviewerResultFromBytes, proveStandaloneRosterCompletion, aggregateStandaloneReview,
  serializeAdjudicatedStandaloneReview, serializeStandaloneAggregate, parseStandaloneAggregate,
  type StandaloneReviewerProtocolResolver, type StandaloneReviewState } from "../../src/core/standalone-review";
import { startStandaloneReviewMachine, reduceStandaloneReviewMachine, serializeStandaloneReviewMachineState,
  parseAuthoritativeStandaloneReviewResult, parseStandaloneReviewMachineState, readStandaloneReviewPublication, isAuthoritativeStandaloneReviewResult,
  type AuthoritativeStandaloneReviewResult, type StandaloneReviewMachineState, type StandaloneReadyToFinalizeState } from "../../src/core/standalone-review-machine";
import { acceptedAgentResult, createPublicationAuthorityResolver, parseArtifactRef, parseRequestId,
  parseOrchestrationRunId, parseIssuedSpawnRequest, prepareInitialBatchPublicationIntent,
  type PublicationAuthorityResolver } from "../../src/core/orchestration-contract";
import { resolveAgentPolicy } from "../../src/core/model-profiles";
import { sha256Bytes, sha256Hex } from "../../src/core/review-packet";
import { prepareDefectFamilyAccounting } from "../../src/core/defect-family-accounting";
import { freezePathAuthority, parseRemediationPathAuthority, createStandaloneResultPublicationAuthorityResolver } from "../../src/core/remediation-machine";
import { REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../src/core/reviewer-contract";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const parseValue = <T>(result: { ok: true; value: T } | { ok: false; errors: readonly string[] }): T => {
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.value;
};
const predecessor = (refute = false) => standaloneFixture(undefined, true, { refute }).input.standaloneResult;
const critical = REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!;
const advisory = { severity: "advisory" as const, file: null, line: null, claim: "New independent advisory", reason: "Useful, nonblocking improvement." };
const fresh = (draft = advisory): StandaloneReviewerPayloadV3["findings"][number] => ({ draft, relation: { kind: "independent" } });
const payload = (prepared: PreparedStandaloneSuccessor): StandaloneReviewerPayloadV3 => ({
  schemaVersion: 3, kind: "standalone-successor-review", lineageDigest: prepared.lineageDigest,
  snapshotDigest: prepared.snapshotDigest, findings: [],
  priorAssessments: prepared.inventory.map(row => {
    const last = row.history.at(-1);
    return last !== undefined && (last.kind !== "adjudication" || !last.survives)
      ? { origin: standaloneOriginReference(row.origin), verdict: "retained", decisionDigest: standaloneDecisionReference(last), reason: "Original decision remains applicable." }
      : { origin: standaloneOriginReference(row.origin), verdict: "still-present", reason: "Original assertion remains applicable." };
  }),
});
type Reports = (prepared: PreparedStandaloneSuccessor, index: number) => StandaloneReviewerPayloadV3;

/** Same initial publication, capture, completion, LC-2 and T2 adapters as production; no filesystem or harness state. */
function collect(sourceResult: AuthoritativeStandaloneReviewResult, runId: string, reports: Reports = payload,
  snapshotRevision = runId) {
  const source = valueOf(prepareStandaloneLineageSource(sourceResult, `/owned/${sourceResult.runId}`));
  const disposition = dispositionPublicationFixture(valueOf(prepareStandaloneDisposition(source, bytes({
    schemaVersion: 1, source: source.publication, provenance: "DECLARED", revision: { kind: "initial" },
    entries: source.inventory.filter(row => ("draft" in row.finding ? row.finding.draft.severity : row.finding.severity) === "advisory")
      .map(row => ({ origin: standaloneOriginReference(row.origin), decision: "accepted", reason: "Retain explicitly." })),
  })))).published;
  const prepared = valueOf(prepareStandaloneSuccessor(source, bytes({ runId, reviewers: source.reviewers,
    snapshot: source.scope.map(path => ({ kind: "present", path, mode: "100644", digest: sha256Hex(`${snapshotRevision}:${path}`) })),
  }), { kind: "selected-record", disposition }));
  const packets = prepared.reviewers.map(role => ([1, 2] as const).map(attempt => {
    const policy = valueOf(resolveAgentPolicy(role));
    return valueOf(buildStandaloneSuccessorReviewerContext(prepared, {
      runId: valueOf(parseOrchestrationRunId(runId)), requestId: valueOf(parseRequestId(`request:${sha256Hex(`${runId}\u0000${role}\u0000${attempt}`)}`)),
      role: policy.agent, attempt, requiredSkill: policy.requiredSkill,
    }, []));
  }));
  const initial = valueOf(prepareFreshStandaloneReview({ runId, successor: prepared, explicitScope: source.scope,
    changedPaths: { unstaged: source.scope, staged: [], committed: [], base_revision: null, head_revision: "1".repeat(40) },
    reviewMetadata: { requested_kinds: ["types"], docs_only: false, source_or_test_changed: false,
      types_changed: true, comments_changed: false, additions: 1, file_count: source.scope.length, new_structure: false, languages: ["TypeScript"] },
    scopeSafety: source.scope.map(path => ({ path, status: "safe" })),
    reviewerContexts: packets.map(attempts => ({ attempts: [attempts[0]!.digest, attempts[1]!.digest] })),
  }));
  const authority = parseValue(parseStandaloneReviewAuthority(JSON.parse(serializeStandaloneReviewAuthority(initial.authority)), prepared));
  const requests = authority.roster.orderedSlots.map(slot => ({ authority: slot.attempts[0],
    context: { digest: slot.attempts[0].contextDigest, slot: `contexts/${slot.attempts[0].contextDigest}.json` } }));
  const intent = valueOf(prepareInitialBatchPublicationIntent(runId, `effect:${runId}:reviewers`, requests));
  const published = publishBatch(intent, requests);
  const resolver = createPublicationAuthorityResolver(lookup => lookup.runId === runId && lookup.effectId === intent.identity.effectId
    ? { ok: true, value: published.receiptBytes } : { ok: false, error: { kind: "publication-authority-unavailable", message: "foreign publication" } });
  const protocols: StandaloneReviewerProtocolResolver = request => {
    const candidate = published.action.requests.find(value => value.authority.requestId === request.requestId);
    const packet = packets.flat().find(value => value.digest === request.contextDigest);
    if (candidate === undefined || packet === undefined) return { ok: false, error: { kind: "reviewer-protocol-failed", code: "authority-mismatch", path: "/request", message: "foreign request" } };
    const issued = parseIssuedSpawnRequest(resolver, candidate);
    if (!issued.ok) return { ok: false, error: { kind: "reviewer-protocol-failed", code: "authority-mismatch", path: "/publication", message: issued.error.message } };
    return parseIssuedStandaloneSuccessorReviewer({ request: issued.value, packet, prepared,
      registration: standaloneSuccessorReviewerRegistration(prepared) });
  };
  const accepted = published.action.requests.map((request, index) => {
    const raw = bytes(reports(prepared, index));
    const artifact = valueOf(parseArtifactRef({ runId, slot: request.authority.outputSlot, digest: sha256Bytes(raw), byteLength: raw.length }));
    return valueOf(acceptedAgentResult(request, valueOf(capturedReviewerResultFromBytes(artifact, raw))));
  });
  const completion = proveStandaloneRosterCompletion(authority, resolver, accepted, protocols);
  const awaiting = valueOf(reduceStandaloneReviewMachine(startStandaloneReviewMachine(authority), { kind: "review-batch-published", runId }));
  return { source, prepared, authority, packets, protocols, resolver, accepted, completion, awaiting };
}

function finalize(collected: ReturnType<typeof collect>, refute = false) {
  const completion = valueOf(collected.completion);
  const aggregate: StandaloneReviewState = parseValue(aggregateStandaloneReview({ authority: collected.authority, completion }));
  const aggregating = valueOf(reduceStandaloneReviewMachine(collected.awaiting, { kind: "complete-roster-proved", completion }));
  let state: StandaloneReviewMachineState;
  let resolver: PublicationAuthorityResolver = collected.resolver;
  if (aggregate.kind === "clean") state = valueOf(reduceStandaloneReviewMachine(aggregating, { kind: "aggregate-clean", aggregate: aggregate.aggregate }));
  else {
    const panel = upholdStandaloneCriticals(collected.authority, aggregate.aggregate, refute);
    resolver = lookup => lookup.runId === collected.authority.runId ? collected.resolver(lookup) : panel.resolver(lookup);
    const awaiting = valueOf(reduceStandaloneReviewMachine(aggregating, { kind: "aggregate-has-criticals", aggregate: aggregate.aggregate,
      panelAuthority: panel.frozen, refutationAuthority: panel.authority }));
    expect(reduceStandaloneReviewMachine(awaiting, { kind: "refutation-completed", completion: {
      ...panel.completion, completedPanelState: { ...panel.completion.completedPanelState },
    } }).ok).toBe(false);
    state = valueOf(reduceStandaloneReviewMachine(awaiting, { kind: "refutation-completed", completion: panel.completion }));
  }
  if (state.kind !== "ready-to-finalize") throw Error("LC-2 must reach actual ready state");
  const ready: StandaloneReadyToFinalizeState = state;
  const serialization = serializeAdjudicatedStandaloneReview(ready.result);
  const receipt = { kind: "artifact-set-published" as const, effectId: ready.publicationIntent.effectId,
    runId: collected.authority.runId, artifacts: ready.publicationIntent.artifacts };
  const done = valueOf(reduceStandaloneReviewMachine(ready, { kind: "result-published", result: JSON.parse(serialization), receipt }));
  if (done.kind !== "done" || done.result.schemaVersion !== 3) throw Error("actual authoritative v3 done result required");
  const replay = valueOf(parseStandaloneReviewMachineState(JSON.parse(serializeStandaloneReviewMachineState(done)), resolver,
    collected.protocols, collected.authority));
  expect(replay.kind).toBe("done");
  if (replay.kind !== "done") throw Error("published replay required");
  expect(serializeAdjudicatedStandaloneReview(replay.result)).toBe(serialization);
  expect(isAuthoritativeStandaloneReviewResult(replay.result)).toBe(true);
  expect(valueOf(readStandaloneReviewPublication(replay.result, 16_777_216)).digest).toBe(sha256Hex(serialization));
  return { ...collected, aggregate, ready, done, result: done.result, serialization, receipt, resolver, replay };
}

const repaired: Reports = (prepared) => ({ ...payload(prepared), priorAssessments: prepared.inventory.map(row => ({
  origin: standaloneOriginReference(row.origin), verdict: "repaired", reason: "Verified repair against frozen successor.",
  change: { path: prepared.snapshot[0]!.path, description: "Changed relevant implementation." },
})) });

describe("actual LC-2 standalone v3 publication and lineage", () => {
  it("publishes two genuine successors, preserving original publication and high-water over resolved/refuted histories", () => {
    const first = finalize(collect(predecessor(), "run.successor-one", (prepared, index) => ({
      ...repaired(prepared, index), findings: index === 0 ? [{ draft: critical, relation: { kind: "independent" } }, fresh()] : [],
    })), true);
    expect(first.result.lineage.counts).toEqual({ new: 2, inherited: 1, total: 3, survivingCritical: 0,
      refutedCritical: 1, resolved: 1, advisory: 1, currentCriticalCoverageLimited: 0 });
    expect(first.result.lineage.inventory[0]!.finding).toEqual(first.prepared.inventory[0]!.finding);
    expect(first.result.lineage.inventory[0]!.history[0]).toEqual(first.prepared.inventory[0]!.history[0]);
    const resolution = first.result.lineage.inventory[0]!.history.at(-1)!;
    expect(resolution).toMatchObject({ kind: "successor-resolution", runId: first.authority.runId,
      snapshotDigest: first.prepared.snapshotDigest, publication: { kind: "enclosing-publication" } });
    if (resolution.kind !== "successor-resolution") throw Error("current resolution required");
    expect(resolution.assessments.map(row => row.role)).toEqual(first.prepared.reviewers);
    for (const [index, assessment] of resolution.assessments.entries()) expect(assessment).toMatchObject({
      requestId: first.accepted[index]!.authority.requestId, transcriptDigest: first.accepted[index]!.value.artifact.digest,
      contextDigest: first.accepted[index]!.authority.contextDigest, changedInput: "historical-unknown",
    });
    expect(first.result.panel?.lenses).toEqual(["reproduction", "intent", "blast-radius"]);
    expect(first.result.panel?.outcomes.map(row => row.findingId)).toEqual(["standalone-review:code-reviewer-2"]);
    const second = finalize(collect(first.replay.result, "run.successor-two", (prepared, index) => ({ ...payload(prepared), findings: index === 0 ? [fresh()] : [] })));
    expect([first, second].map(review => ({ digest: sha256Hex(review.serialization), byteLength: new TextEncoder().encode(review.serialization).length }))).toEqual([
      { digest: "8a705df2d6922a20972ac828f10882fcaaa2efcf063c60fc3c6dcc870403b7b7", byteLength: 26050 },
      { digest: "940c046503d02249b20bd4dd9d9f55218c72e5bd034e61d96312af86738a15ec", byteLength: 44814 },
    ]);
    expect(second.result.lineage.counts).toMatchObject({ new: 1, inherited: 3, total: 4, resolved: 1, refutedCritical: 1 });
    expect(second.result.lineage.inventory.map(row => row.finding.id)).toEqual(["code-reviewer-1", "code-reviewer-2", "code-reviewer-3", "code-reviewer-4"]);
    expect(second.result.panel).toBeNull();
    expect(second.result.successor.reviewHistory).toHaveLength(1);
    expect(second.result.successor.reviewHistory[0]).toMatchObject({ publication: { resultDigest: sha256Hex(first.serialization) },
      reports: first.result.lineage.reports, assessments: first.result.lineage.assessments,
      disposition: first.result.successor.disposition });
    const inheritedOriginal = second.result.lineage.inventory[0]!.origin;
    expect(inheritedOriginal).toEqual(first.prepared.inventory[0]!.origin);
    const attached = second.result.lineage.inventory[1]!.origin;
    expect(attached).toMatchObject({ kind: "published-successor", publication: { runId: first.authority.runId, resultDigest: sha256Hex(first.serialization) } });
    expect(standaloneOriginReference(attached)).toBe(standaloneOriginReference(first.result.lineage.inventory[1]!.origin));
    const thirdSource = valueOf(prepareStandaloneLineageSource(second.replay.result, `/owned/${second.result.runId}`));
    expect(thirdSource.reviewHistory).toHaveLength(2);
    expect(thirdSource.reviewHistory[0]).toEqual(second.result.successor.reviewHistory[0]);
    expect(thirdSource.inventory[1]!.origin).toEqual(attached);
    expect(thirdSource.inventory[1]!.history).toEqual(second.result.lineage.inventory[1]!.history);
    expect(first.result.lineage.inventory[1]!.origin.kind).toBe("current");
    expect(second.result.lineage.inventory[3]!.origin.kind).toBe("current");
    const accounting = valueOf(prepareDefectFamilyAccounting(second.result, { kind: "not-required" }));
    expect(accounting.source.sourceVersion).toBe(3);
    expect(accounting.source.sourceResultJson).toBe(second.serialization);
    expect(accounting.source.sourceResultDigest).toBe(sha256Hex(second.serialization));
    expect(JSON.parse(accounting.source.sourceResultJson!).lineage).toEqual(second.result.lineage);
    expect(JSON.parse(accounting.source.sourceResultJson!).successor).toEqual(second.result.successor);
  });

  it("keeps an unchanged upheld inherited critical active without any fresh panel, and retains mixed evidence honestly", () => {
    const review = finalize(collect(predecessor(), "run.upheld", (prepared, index) => ({ ...payload(prepared), findings: index === 0 ? [fresh()] : [] })));
    expect(review.aggregate.kind).toBe("clean"); // no CURRENT panel work, not zero blocking obligations
    expect(review.result.survivingCriticals.map(row => row.id)).toEqual(["code-reviewer-1"]);
    expect(review.result.survivingCriticals[0]).not.toHaveProperty("protocolVersion");
    expect(review.result.advisories[0]?.protocolVersion).toBe(2);
    expect(review.result.panel).toBeNull();
    expect(review.result.lineage.inventory[0]!.history).toEqual(review.prepared.inventory[0]!.history);
  });

  it.each(["still-present", "not-assessable"] as const)("%s is valid fresh evidence but cannot resolve", verdict => {
    const review = finalize(collect(predecessor(), `run.${verdict}`, (prepared, index) => index === 0 ? repaired(prepared, index) : ({
      ...payload(prepared), priorAssessments: prepared.inventory.map(row => ({ origin: standaloneOriginReference(row.origin), verdict, reason: "Explicit current assessment." })),
    })));
    expect(review.result.lineage.counts.resolved).toBe(0);
    expect(review.result.survivingCriticals).toHaveLength(1);
    expect(review.result.lineage.currentCriticalCoverage.kind).toBe(verdict === "not-assessable" ? "limited" : "complete");
    expect(prepareDefectFamilyAccounting(review.result, { kind: "not-required" }).ok).toBe(false);
  });

  it("never turns coverage-limited refuted history into a zero-critical P3 bypass", () => {
    const review = finalize(collect(predecessor(true), "run.retired-unknown", prepared => ({ ...payload(prepared),
      priorAssessments: prepared.inventory.map(row => ({ origin: standaloneOriginReference(row.origin), verdict: "not-assessable", reason: "Current context cannot establish applicability." })),
    })));
    expect(review.result.survivingCriticals).toEqual([]);
    expect(review.result.lineage.currentCriticalCoverage.kind).toBe("limited");
    expect(review.result.lineage.counts.currentCriticalCoverageLimited).toBe(1);
    expect(prepareDefectFamilyAccounting(review.result, { kind: "not-required" })).toMatchObject({ ok: false,
      error: { failures: [{ code: "critical-coverage-limited" }] } });
    expect(freezePathAuthority({ standaloneResult: review.result, publicationReceipt: review.receipt }).ok).toBe(false);
  });

  it("conserves full canonical v3 publication through the P3 parser and refuses arbitrary lineage-byte or receipt substitutions", () => {
    const review = finalize(collect(predecessor(), "run.p3-source", repaired));
    const authority = valueOf(freezePathAuthority({ standaloneResult: review.result, publicationReceipt: review.receipt }));
    const resolver = createStandaloneResultPublicationAuthorityResolver(() => ({ ok: true, value: review.receipt }));
    expect(authority.sourceResultJson).toBe(review.serialization);
    expect(valueOf(parseRemediationPathAuthority(JSON.parse(JSON.stringify(authority)), resolver))).toEqual(authority);
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 80 }), suffix => {
      const raw = JSON.parse(review.serialization);
      raw.lineage.inventory[0].finding.claim += suffix;
      const sourceResultJson = JSON.stringify(raw, null, 2);
      expect(parseRemediationPathAuthority({ ...authority, sourceResultJson, sourceResultDigest: sha256Hex(sourceResultJson) }, resolver).ok).toBe(false);
    }), { seed: 5403, numRuns: 40 });
    expect(freezePathAuthority({ standaloneResult: { ...review.result }, publicationReceipt: review.receipt }).ok).toBe(false);
    expect(freezePathAuthority({ standaloneResult: review.result, publicationReceipt: {
      ...review.receipt, artifacts: [{ ...review.receipt.artifacts[0], digest: "f".repeat(64) }],
    } }).ok).toBe(false);
  });

  it("uses actual inherited blockers rather than current panel counts, excluding every retired/advisory ID from mandatory accounting", () => {
    const first = finalize(collect(predecessor(), "run.p3-retired", (prepared, index) => ({
      ...repaired(prepared, index), findings: index === 0 ? [{ draft: critical, relation: { kind: "independent" } }, fresh()] : [],
    })), true);
    const review = finalize(collect(first.result, "run.p3-active", (prepared, index) => ({ ...payload(prepared),
      findings: index === 0 ? [{ draft: critical, relation: { kind: "independent" } }] : [],
    })));
    const inherited = finalize(collect(review.result, "run.p3-inherited"));
    expect(inherited.result.panel).toBeNull();
    expect(inherited.result.lineage.counts.new).toBe(0);
    const id = inherited.result.survivingCriticals[0]!.id;
    const declaration = (findingId: string) => ({ kind: "declared-defect-family-accounting", provenance: "DECLARED",
      dispositions: [{ findingId, status: "unresolved", reason: "Explicit remaining obligation" }], groups: [] });
    const accounting = valueOf(prepareDefectFamilyAccounting(inherited.result, declaration(id)));
    expect(accounting.source.sourceResultJson).toBe(inherited.serialization);
    expect(accounting.source.survivingCriticals.map(row => row.id)).toEqual([id]);
    expect(prepareDefectFamilyAccounting(inherited.result, { kind: "not-required" }).ok).toBe(false);
    const retired = inherited.result.lineage.inventory.filter(row => row.finding.id !== id).map(row => row.finding.id);
    fc.assert(fc.property(fc.constantFrom(...retired, "foreign-id"), findingId => {
      expect(prepareDefectFamilyAccounting(inherited.result, declaration(findingId)).ok).toBe(false);
    }), { seed: 5404, numRuns: 20 });
  });

  it("rejects missing/foreign coverage atomically through the actual completion seam", () => {
    const missing = collect(predecessor(), "run.missing", prepared => ({ ...payload(prepared), priorAssessments: [] }));
    expect(missing.completion.ok).toBe(false);
    const foreign = collect(predecessor(), "run.foreign-origin", prepared => ({ ...payload(prepared), priorAssessments: [{ origin: "f".repeat(64), verdict: "still-present", reason: "Foreign." }] }));
    expect(foreign.completion.ok).toBe(false);
    expect(missing.awaiting.kind).toBe("awaiting-results");
    const request = missing.accepted[0]!.authority;
    const retry = valueOf(reduceStandaloneReviewMachine(missing.awaiting, { kind: "result-rejected", request, message: "missing exact prior coverage" }));
    expect(retry.pending[0]?.expectedAttempt).toBe(2);
    expect(valueOf(parseStandaloneReviewMachineState(JSON.parse(serializeStandaloneReviewMachineState(retry)), missing.resolver, missing.protocols, missing.authority)).pending).toEqual(retry.pending);
    const secondRequest = missing.authority.roster.orderedSlots[0]!.attempts[1];
    const terminal = valueOf(reduceStandaloneReviewMachine(retry, { kind: "result-rejected", request: secondRequest, message: "still missing" }));
    expect(terminal.kind).toBe("terminal-blocked");
    expect(valueOf(parseStandaloneReviewMachineState(JSON.parse(serializeStandaloneReviewMachineState(terminal)), missing.resolver, missing.protocols, missing.authority)).kind).toBe("terminal-blocked");
  });

  it("observes changed inputs for unanimous resolution, and rejects unchanged bytes despite a different Run/HEAD", () => {
    const first = finalize(collect(predecessor(), "run.known-inputs"));
    const unchanged = collect(first.result, "run.unchanged", repaired, "run.known-inputs");
    expect(unchanged.completion.ok).toBe(false);
    const changed = finalize(collect(first.result, "run.changed", repaired));
    const resolution = changed.result.lineage.inventory[0]!.history.at(-1)!;
    expect(resolution).toMatchObject({ kind: "successor-resolution" });
    if (resolution.kind !== "successor-resolution") throw Error("resolution required");
    expect(resolution.assessments.every(row => row.changedInput === "observed-changed")).toBe(true);
  });

  it.each([true, false])("reopens exact refutation only through a fresh real full panel (refute=%s)", refute => {
    const source = predecessor(true);
    const review = finalize(collect(source, `run.reopen-${refute}`, (prepared, index) => ({ ...payload(prepared),
      priorAssessments: index !== 0 ? payload(prepared).priorAssessments : prepared.inventory.map(row => ({
        origin: standaloneOriginReference(row.origin), verdict: "reopen", reason: "New current evidence contradicts the old reason.",
        proposal: { decisionDigest: standaloneDecisionReference(row.history.at(-1)!), evidence: { kind: "execution-trace", preconditions: ["Current supported input"], steps: ["Reach the formerly excluded branch"], observed: "Original failure", expected: "Contract holds", reference: "src/main.ts" },
          changedConditions: "Changed implementation precondition.", currentApplicability: "Same original assertion now applies.", evidenceLimits: "Frozen scope only." },
      })),
    })), refute);
    expect(review.result.lineage.inventory[0]!.history.slice(0, -1)).toEqual(review.prepared.inventory[0]!.history);
    expect(review.result.lineage.inventory[0]!.finding).toEqual(review.prepared.inventory[0]!.finding);
    expect(review.result.panel?.outcomes[0]?.survives).toBe(!refute);
    expect(review.ready).toHaveProperty("panelAuthority.successorEvidence.reports", review.result.lineage.reports);
    expect(review.result.survivingCriticals.length).toBe(refute ? 0 : 1);
  });

  it("requires real LC-2 ready membership and publication before a finalized result can become a source", () => {
    const review = finalize(collect(predecessor(), "run.publication-membership"));
    const raw = JSON.parse(review.serialization);
    const unpublished = review.ready.result as AuthoritativeStandaloneReviewResult;
    expect(isAuthoritativeStandaloneReviewResult(unpublished)).toBe(false);
    expect(readStandaloneReviewPublication(unpublished, 16_777_216).ok).toBe(false);
    expect(prepareStandaloneLineageSource(unpublished, "/owned/unpublished")).toMatchObject({
      ok: false, error: { code: "source-unavailable" },
    });
    // Matching finalization/receipt hashes cannot substitute for the reducer's ready object.
    expect(parseAuthoritativeStandaloneReviewResult({ ...review.ready }, raw, review.receipt).ok).toBe(false);
    expect(reduceStandaloneReviewMachine({ ...review.ready }, {
      kind: "result-published", result: raw, receipt: review.receipt,
    }).ok).toBe(false);
    fc.assert(fc.property(fc.constantFrom("run_id", "scope", "lineage", "successor"), key => {
      expect(parseAuthoritativeStandaloneReviewResult(review.ready, { ...raw, [key]: null }, review.receipt).ok).toBe(false);
    }), { seed: 5501, numRuns: 20 });
    const published = valueOf(parseAuthoritativeStandaloneReviewResult(review.ready, raw, review.receipt));
    expect(isAuthoritativeStandaloneReviewResult(published)).toBe(true);
    expect(valueOf(prepareStandaloneLineageSource(published, "/owned/published")).publication.resultDigest)
      .toBe(sha256Hex(review.serialization));
    expect(serializeAdjudicatedStandaloneReview(published)).toBe(review.serialization);
  });

  it("re-proves authority/current evidence/panel/publication and refuses tampered checkpoints and structural sources", () => {
    const review = finalize(collect(predecessor(), "run.tamper"));
    expect(parseStandaloneReviewAuthority(JSON.parse(serializeStandaloneReviewAuthority(review.authority))).ok).toBe(false);
    expect(parseStandaloneAggregate(JSON.parse(serializeStandaloneAggregate(review.aggregate.aggregate))).ok).toBe(false);
    expect(prepareStandaloneLineageSource({ ...review.result } as AuthoritativeStandaloneReviewResult, "/owned/forged").ok).toBe(false);
    expect(reduceStandaloneReviewMachine(review.ready, { kind: "result-published", result: { ...JSON.parse(review.serialization), schema_version: 2 }, receipt: review.receipt }).ok).toBe(false);
    expect(reduceStandaloneReviewMachine(review.ready, { kind: "result-published", result: JSON.parse(review.serialization), receipt: { ...review.receipt, artifacts: [] } as unknown as typeof review.receipt }).ok).toBe(false);
    fc.assert(fc.property(fc.constantFrom("authority", "aggregate", "result", "completion"), key => {
      const raw = JSON.parse(serializeStandaloneReviewMachineState(review.done));
      raw[key] = {};
      expect(parseStandaloneReviewMachineState(raw, review.resolver, review.protocols, review.authority).ok).toBe(false);
    }), { seed: 5301, numRuns: 20 });
  });
});
