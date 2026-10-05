import { createHash } from "node:crypto";
import { prepareStandaloneLineageSource } from "../../src/core/standalone-lineage";
import { findingOf } from "../../src/core/standalone-finding-origin";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildReviewerContextPacket, encodeByteSection } from "../../src/core/context-packets";
import { CURRENT_REVIEWER_PROTOCOL, REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../src/core/reviewer-contract";
import { acceptedAgentResult, createPublicationAuthorityResolver, parseArtifactRef, parseEffectId, parseIssuedSpawnRequest, parseOrchestrationRunId, parseRequestId, prepareInitialBatchPublicationIntent } from "../../src/core/orchestration-contract";
import { aggregateStandaloneReview, proveStandaloneRosterCompletion } from "../../src/core/standalone-review";
import { capturedReviewerResultFromBytes } from "../../src/core/standalone-reviewer-capture";
import { prepareFreshStandaloneReview } from "../../src/core/standalone-review-preparation";
import { renderStandaloneReviewSummary, serializeAdjudicatedStandaloneReview, serializeStandaloneAggregate } from "../../src/core/standalone-review-records";
import { parseStandaloneReviewMachineState, serializeStandaloneReviewMachineState } from "../../src/core/standalone-review-checkpoint";
import { reduceStandaloneReviewMachine, startStandaloneReviewMachine } from "../../src/core/standalone-review-machine";
import { parseAdjudicatedStandaloneReview, parseHistoricalStandaloneAggregate } from "../../src/core/legacy-archive";
import { parsedAuthority } from "../../src/handlers/helpers/programs/registration";
import { standaloneRequestId } from "../../src/handlers/helpers/programs/standalone-requests";
import { fixtureReviewerProtocols, standaloneFixtureRegistration } from "../fixtures/standalone-reviewer-protocol";

function value<T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>): T {
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
const bytes = (raw: unknown) => Buffer.from(JSON.stringify(raw));
const hash = (raw: Uint8Array) => createHash("sha256").update(raw).digest("hex");

function fixture(name = "run.current-publication") {
  const runId = value(parseOrchestrationRunId(name));
  const scope = ["src/a.ts"];
  const packets = ([1, 2] as const).map((attempt) => value(buildReviewerContextPacket({
    requestId: value(parseRequestId(standaloneRequestId(runId, "code-reviewer", attempt))), role: "code-reviewer", requiredSkill: "none",
    fixedContext: [value(encodeByteSection("standalone-review-authority", JSON.stringify({ runId, scope, role: "code-reviewer", attempt })))], variableContext: [],
  })));
  const prepared = value(prepareFreshStandaloneReview({ runId, explicitScope: scope,
    changedPaths: { unstaged: scope, staged: [], committed: [], base_revision: null, head_revision: "a".repeat(40) },
    reviewMetadata: { requested_kinds: ["types"], docs_only: false, source_or_test_changed: false, types_changed: false,
      comments_changed: false, additions: 1, file_count: 1, new_structure: false, languages: ["TypeScript"] },
    scopeSafety: [{ path: scope[0], status: "safe" }], reviewerContexts: [{ attempts: [packets[0]!.digest, packets[1]!.digest] }],
  }));
  const registration = standaloneFixtureRegistration(prepared.authority);
  const authority = value(parsedAuthority(registration));
  const request = authority.roster.orderedSlots[0].attempts[0];
  const inputs = [{ authority: request, context: { digest: request.contextDigest, slot: `contexts/${request.contextDigest}.json` } }];
  const intent = value(prepareInitialBatchPublicationIntent(runId, "effect:current-review", inputs));
  const receipt = { schemaVersion: 1, kind: "batch-published", effectId: intent.identity.effectId, runId,
    requestIds: intent.requestIds, contextDigests: intent.contextDigests, issuedRequests: intent.issuedRequests, publicationDigest: intent.identity.publicationDigest };
  const publications = createPublicationAuthorityResolver(() => ({ ok: true, value: [...bytes(receipt)] }));
  const issued = value(parseIssuedSpawnRequest(publications, { ...inputs[0], issuance: { schemaVersion: 1, kind: "issued-spawn-request-proof",
    runId, effectId: receipt.effectId, publicationDigest: receipt.publicationDigest, batchIndex: 0 } }));
  const protocols = fixtureReviewerProtocols(authority, publications, [issued], packets);
  const complete = (raw: Uint8Array) => {
    const artifact = value(parseArtifactRef({ runId, slot: request.outputSlot, digest: hash(raw), byteLength: raw.byteLength }));
    const captured = value(capturedReviewerResultFromBytes(artifact, raw));
    return proveStandaloneRosterCompletion(authority, publications, [value(acceptedAgentResult(issued, captured))], protocols);
  };
  return { authority, registration, publications, protocols, complete, issued };
}

function completed(f: ReturnType<typeof fixture>, findings: readonly unknown[] = []) {
  const completion = value(f.complete(bytes({ schemaVersion: 2, kind: "standalone-review", findings })));
  const aggregate = value(aggregateStandaloneReview({ authority: f.authority, completion }));
  const awaiting = value(reduceStandaloneReviewMachine(startStandaloneReviewMachine(f.authority), { kind: "review-batch-published", runId: f.authority.runId }));
  const aggregating = value(reduceStandaloneReviewMachine(awaiting, { kind: "complete-roster-proved", completion }));
  const ready = value(reduceStandaloneReviewMachine(aggregating, { kind: "aggregate-clean", aggregate: aggregate.aggregate }));
  if (ready.kind !== "ready-to-finalize") throw new Error("ready required");
  const done = value(reduceStandaloneReviewMachine(ready, { kind: "result-published", result: JSON.parse(serializeAdjudicatedStandaloneReview(ready.result)),
    receipt: { kind: "artifact-set-published", runId: f.authority.runId, effectId: ready.publicationIntent.effectId, artifacts: ready.publicationIntent.artifacts } }));
  if (done.kind !== "done") throw new Error("done required");
  return { done, ready, completion, aggregate: aggregate.aggregate, awaiting };
}

describe("current standalone publication authority", () => {
  it("publishes schema 2 for an empty report and retains the complete registered roster on replay", () => {
    const f = fixture();
    const c = completed(f);
    expect(c.aggregate.schemaVersion).toBe(2);
    expect(c.done.result.schemaVersion).toBe(2);
    expect(c.done.result.reviewerProtocol).toEqual(CURRENT_REVIEWER_PROTOCOL);
    expect(c.done.result.reviewerEvidence).toHaveLength(f.authority.reviewers.length);
    const checkpoint = JSON.parse(serializeStandaloneReviewMachineState(c.done));
    expect(checkpoint.schema_version).toBe(2);
    const replay = value(parseStandaloneReviewMachineState(checkpoint, f.publications, f.protocols, value(parsedAuthority(f.registration))));
    if (replay.kind !== "done") throw new Error("done replay required");
    expect(serializeAdjudicatedStandaloneReview(replay.result)).toBe(serializeAdjudicatedStandaloneReview(c.done.result));
    expect(Object.keys(JSON.parse(serializeAdjudicatedStandaloneReview(replay.result))).slice(0, 3)).toEqual(["schema_version", "reviewer_protocol", "run_id"]);
    expect(renderStandaloneReviewSummary(replay.result)).toContain("Emitted/admitted: 0 critical; 0 advisory.");
  });

  it("preserves ordered duplicates, exact strings, reason and optional complete basis through opaque done replay", () => {
    const f = fixture();
    fc.assert(fc.property(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 0, max: 100 }), (count, confidence) => {
      const basis = REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!.basis;
      if (basis === undefined) throw new Error("example basis required");
      const draft = { severity: "advisory", file: "src/a.ts", line: 1, claim: "  exact | <claim>\n text  ", reason: "  honest benefit  ", basis: { ...basis, truthConfidence: confidence } };
      const c = completed(f, Array.from({ length: count }, () => draft));
      const replay = value(parseStandaloneReviewMachineState(JSON.parse(serializeStandaloneReviewMachineState(c.done)), f.publications, f.protocols, value(parsedAuthority(f.registration))));
      if (replay.kind !== "done") throw new Error("done required");
      expect(replay.result.advisories).toEqual(Array.from({ length: count }, (_, index) => ({ protocolVersion: 2, ...draft, id: `code-reviewer-${index + 1}`, agent: "code-reviewer" })));
      expect(serializeAdjudicatedStandaloneReview(replay.result)).toBe(serializeAdjudicatedStandaloneReview(c.done.result));
      expect(renderStandaloneReviewSummary(replay.result)).toContain(`Emitted/admitted: 0 critical; ${count} advisory.`);
      expect(renderStandaloneReviewSummary(replay.result)).not.toContain("<claim>");
      expect(Object.isFrozen(replay.result.advisories[0]?.basis?.evidence)).toBe(true);
      const lineage = value(prepareStandaloneLineageSource(replay.result, "/owned/current-publication"));
      expect(lineage.inventory.map(findingOf)).toEqual(replay.result.advisories);
      expect(lineage.publication.resultDigest).toBe(c.done.outcome.digest);
      expect(lineage.inventory.every(row => "draft" in row.finding && row.finding.protocolVersion === 2)).toBe(true);
    }), { seed: 2409, numRuns: 25 });
  });

  it.each([
    "CRITICAL_COUNT: 0\nADVISORY_COUNT: 0",
    '{"schemaVersion":2,"kind":"standalone-review","findings":[],"findings":[]}',
    JSON.stringify({ schemaVersion: 2, kind: "standalone-review", findings: [{ severity: "critical", file: null, line: null, claim: "no basis" }] }),
  ])("refuses the whole invalid current response before completion: %s", (raw) => {
    const f = fixture();
    const result = f.complete(Buffer.from(raw));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("Review output parsing failed");
  });

  it("cannot aggregate a spread completion proof or use another request's minted protocol", () => {
    const f = fixture();
    const c = completed(f);
    expect(aggregateStandaloneReview({ authority: f.authority, completion: { ...c.completion } as typeof c.completion }).ok).toBe(false);
    const foreign = fixture("run.foreign-publication");
    const other = value(foreign.protocols(foreign.issued.authority));
    expect(proveStandaloneRosterCompletion(f.authority, f.publications, c.completion.results, () => ({ ok: true, value: other })).ok).toBe(false);
    const supplied = { ...f.authority };
    const proof = value(proveStandaloneRosterCompletion(supplied, f.publications, c.completion.results, f.protocols));
    Object.assign(supplied, { schemaVersion: 1 });
    expect(aggregateStandaloneReview({ authority: supplied, completion: proof }).ok).toBe(false);
  });

  it("checks independent registration before preparing, awaiting, done and recoverable predecessor branches", () => {
    const f = fixture();
    const c = completed(f);
    const preparing = startStandaloneReviewMachine(f.authority);
    const effectId = value(parseEffectId("effect:preparing-write"));
    const blocked = value(reduceStandaloneReviewMachine(preparing, { kind: "recoverable-effect-failed",
      diagnostic: { kind: "effect-blocked", category: "infrastructure-failure", runId: f.authority.runId, effectId, message: "disk unavailable",
        retry: { kind: "infrastructure", eligible: true, consumesSemanticAttempt: false }, recovery: { kind: "retry-effect", effectId } },
      intent: { kind: "reserve-agent-requests", effectId, runId: f.authority.runId, requests: [f.issued.authority] },
    }));
    const registered = value(parsedAuthority(f.registration));
    for (const state of [preparing, c.awaiting, c.done, blocked]) {
      const raw = JSON.parse(serializeStandaloneReviewMachineState(state));
      expect(parseStandaloneReviewMachineState(raw, f.publications, f.protocols, registered).ok).toBe(true);
      const old = { ...raw, schema_version: 1, authority: { ...raw.authority, schema_version: 1 } };
      delete old.authority.reviewer_protocol;
      expect(parseStandaloneReviewMachineState(old, f.publications, f.protocols, registered).ok).toBe(false);
      expect(parseStandaloneReviewMachineState({ ...raw, authority: { ...raw.authority, reviewer_protocol: null } }, f.publications, f.protocols, registered).ok).toBe(false);
      if (raw.kind === "recoverable-blocked") {
        raw.predecessor.schema_version = 1;
        expect(parseStandaloneReviewMachineState(raw, f.publications, f.protocols, registered).ok).toBe(false);
      }
    }
  });

  it("rejects descriptor, aggregate Finding basis and final result mutations during replay", () => {
    const f = fixture();
    const c = completed(f, [{ severity: "advisory", file: null, line: null, claim: "nonblocking", reason: "clearer" }]);
    const raw = JSON.parse(serializeStandaloneReviewMachineState(c.done));
    for (const changed of [
      { ...raw, aggregate: { ...raw.aggregate, schema_version: 1 } },
      { ...raw, result: { ...raw.result, reviewer_protocol: null } },
      { ...raw, aggregate: { ...raw.aggregate, findings: raw.aggregate.findings.map(({ protocolVersion: _removed, ...finding }: { protocolVersion: number }) => finding) } },
    ]) expect(parseStandaloneReviewMachineState(changed, f.publications, f.protocols, value(parsedAuthority(f.registration))).ok).toBe(false);
    expect(Object.keys(JSON.parse(serializeStandaloneAggregate(c.aggregate))).slice(0, 3)).toEqual(["schema_version", "reviewer_protocol", "run_id"]);
    expect(parseHistoricalStandaloneAggregate(JSON.parse(serializeStandaloneAggregate(c.aggregate))).ok).toBe(false);
    const current = JSON.parse(serializeAdjudicatedStandaloneReview(c.done.result));
    const { schema_version: _version, reviewer_protocol: _protocol, subject_id: _subject, reviewer_evidence: _evidence, ...stripped } = current;
    expect(parseAdjudicatedStandaloneReview(stripped).ok).toBe(false);
  });
});
