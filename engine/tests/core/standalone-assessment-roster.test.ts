/**
 * The Standalone Assessment Roster (issue #185): what a successor reviewer is
 * told it may say about each prior, and what the engine admits, are one rule.
 *
 * Every roster here is projected from a parser-prepared successor, so the
 * equivalence is checked against the real admission (`assessStandaloneSuccessor`),
 * not a restatement of it.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { dispositionPublicationFixture } from "../fixtures/standalone-disposition-publication";
import { standaloneFixture } from "../fixtures/standalone-remediation-authority";
import { value } from "../fixtures/parse-result";
import {
  assessStandaloneSuccessor, buildStandaloneSuccessorReviewerContext, prepareStandaloneDisposition, prepareStandaloneLineageSource,
  prepareStandaloneSuccessor, reprovesStandaloneSuccessorReviewerContext, type StandaloneLineageSource,
} from "../../src/core/standalone-review";
import { buildStandaloneReviewerContextPacketV3, encodeByteSection } from "../../src/core/context-packets";
import {
  admitsStandaloneAssessment, describeInadmissibleAssessment, standaloneAssessmentRoster, standaloneInputChange,
  type StandaloneAssessmentRosterRow, type StandaloneAssessmentVerdict,
} from "../../src/core/standalone-assessment-roster";
import { findingOf, standaloneDecisionReference, standaloneOriginReference } from "../../src/core/standalone-finding-origin";
import {
  STANDALONE_ASSESSMENT_ROSTER_SECTION, type StandaloneResolutionAssessment, type StandaloneReviewerPayloadV3,
} from "../../src/core/standalone-lineage-contract";
import type { PreparedStandaloneSuccessor, StandaloneDispositionSelection } from "../../src/core/standalone-review-model";
import { parseOrchestrationRunId, parseRequestId } from "../../src/core/orchestration-contract";
import { resolveAgentPolicy } from "../../src/core/model-profiles";

const bytes = (raw: unknown) => new TextEncoder().encode(JSON.stringify(raw));
const historical = { kind: "historical-decision-unavailable" } as const;
const scope = ["src/main.ts", "src/deleted.ts"];
const VERDICTS: readonly StandaloneAssessmentVerdict[] = ["still-present", "repaired", "retained", "reopen", "not-assessable"];
const FOREIGN_REFERENCE = "f".repeat(64);
const OUTSIDE_SCOPE = "src/elsewhere.ts";

const source = (critical: boolean, refute = false) =>
  value(prepareStandaloneLineageSource(standaloneFixture(scope, critical, { refute }).input.standaloneResult, "/owned/predecessor"));
const advisorySource = () => value(prepareStandaloneLineageSource(standaloneFixture(scope, false, {
  firstTranscript: "CRITICAL_COUNT: 0\nADVISORY_COUNT: 2\nADVISORY: one\nADVISORY: two",
}).input.standaloneResult, "/owned/advisories"));
const selection = (prior: StandaloneLineageSource) => bytes({ runId: "run.successor",
  snapshot: prior.scope.map(path => ({ kind: "present", path, digest: "a".repeat(64), mode: "100644" })), reviewers: prior.reviewers });
const successor = (prior: StandaloneLineageSource, policy: StandaloneDispositionSelection = historical) =>
  value(prepareStandaloneSuccessor(prior, selection(prior), policy));
/** A published disposition of every advisory: the initial revision, then one correction. */
function disposed(prior: StandaloneLineageSource, decision: "deferred" | "dismissed") {
  const record = { schemaVersion: 1, source: prior.publication, provenance: "DECLARED", revision: { kind: "initial" },
    entries: prior.inventory.filter(row => findingOf(row).severity === "advisory")
      .map(row => ({ origin: standaloneOriginReference(row.origin), decision, reason: "Exact reason." })) };
  const first = dispositionPublicationFixture(value(prepareStandaloneDisposition(prior, bytes(record)))).published;
  const corrected = { ...record, revision: { kind: "correction", previousDigest: first.digest },
    entries: record.entries.map(entry => ({ ...entry, reason: "Corrected reason." })) };
  return dispositionPublicationFixture(value(prepareStandaloneDisposition(prior, bytes(corrected), first))).published;
}

/** One parser-prepared successor per standing and citation shape the roster distinguishes. */
const SUCCESSORS: readonly (readonly [string, () => PreparedStandaloneSuccessor])[] = [
  ["an upheld critical (active, one surviving adjudication)", () => successor(source(true))],
  ["a refuted critical (retired, one refuting adjudication)", () => successor(source(true, true))],
  ["deferred advisories (active, two disposition revisions)", () => { const prior = advisorySource(); return successor(prior, { kind: "selected-record", disposition: disposed(prior, "deferred") }); }],
  ["dismissed advisories (retired, two disposition revisions)", () => { const prior = advisorySource(); return successor(prior, { kind: "selected-record", disposition: disposed(prior, "dismissed") }); }],
  ["advisories without a selected policy (active, nothing citable)", () => successor(advisorySource())],
];

/** One assessment of `verdict`, citing `reference` and naming `path` where the verdict carries them. */
function assessment(origin: string, verdict: StandaloneAssessmentVerdict, reference: string, path: string): StandaloneResolutionAssessment {
  const reason = "Current assessment.";
  switch (verdict) {
    case "still-present": return { origin, verdict, reason };
    case "not-assessable": return { origin, verdict, reason };
    case "retained": return { origin, verdict, reason, decisionDigest: reference };
    case "repaired": return { origin, verdict, reason, change: { path, description: "Changed." } };
    case "reopen": return { origin, verdict, reason, proposal: { decisionDigest: reference,
      evidence: { kind: "reproduction", execution: "not-executed", setup: "s", input: "i", observed: "o", expected: "e", reference: "r" },
      changedConditions: "c", currentApplicability: "a", evidenceLimits: "l" } };
    default: return verdict satisfies never;
  }
}

/** A whole payload: `chosen` at `index`, every other prior not assessable. */
const payloadWith = (prepared: PreparedStandaloneSuccessor, index: number, chosen: StandaloneResolutionAssessment): StandaloneReviewerPayloadV3 => ({
  schemaVersion: 3, kind: "standalone-successor-review", lineageDigest: prepared.lineageDigest, snapshotDigest: prepared.snapshotDigest,
  priorAssessments: prepared.inventory.map((row, at) => at === index ? chosen : assessment(standaloneOriginReference(row.origin), "not-assessable", "", "")),
  findings: [],
});

const citations = (prior: StandaloneAssessmentRosterRow) => [...prior.decisions.map(decision => decision.reference), FOREIGN_REFERENCE];
const paths = (roster: ReturnType<typeof standaloneAssessmentRoster>) => [...roster.repairablePaths.map(entry => entry.path), OUTSIDE_SCOPE];

function deepFrozen(raw: unknown): void {
  if (raw === null || typeof raw !== "object") return;
  expect(Object.isFrozen(raw)).toBe(true);
  Object.values(raw).forEach(deepFrozen);
}

describe("the Standalone Assessment Roster projects each prior's standing, citations and verdicts", () => {
  it.each(SUCCESSORS)("for %s, carries every prior in issued order with its exact references", (_name, make) => {
    const prepared = make();
    const roster = standaloneAssessmentRoster(prepared);
    expect(roster.lineageDigest).toBe(prepared.lineageDigest);
    expect(roster.snapshotDigest).toBe(prepared.snapshotDigest);
    expect(roster.priors.map(prior => prior.origin)).toEqual(prepared.inventory.map(row => standaloneOriginReference(row.origin)));
    for (const [index, prior] of roster.priors.entries()) {
      const row = prepared.inventory[index]!;
      // History first, oldest first, then each disposition revision naming the origin.
      const history = row.history.map(standaloneDecisionReference);
      const revisions = prepared.disposition.kind === "selected-record"
        ? [...prepared.disposition.disposition.history, prepared.disposition.disposition]
          .filter(revision => revision.record.entries.some(entry => entry.origin === prior.origin)).map(revision => revision.digest)
        : [];
      expect(prior.decisions.map(decision => decision.reference)).toEqual([...history, ...revisions]);
      expect(prior.finding).toEqual((({ agent, severity, file, line, claim }) => ({ agent, severity, file, line, claim }))(findingOf(row)));
    }
    expect(roster.repairablePaths.map(entry => entry.path)).toEqual(prepared.snapshot
      .filter(entry => standaloneInputChange(prepared, entry.path) !== "unchanged").map(entry => entry.path));
    deepFrozen(roster);
  });

  it.each(SUCCESSORS)("for %s, admits a retired prior only through its cited history, and always as not assessable", (_name, make) => {
    for (const prior of standaloneAssessmentRoster(make()).priors) {
      expect(prior.verdicts.includes("still-present")).toBe(prior.standing === "active");
      expect(prior.verdicts.includes("repaired")).toBe(prior.standing === "active");
      expect(prior.verdicts.includes("retained")).toBe(prior.decisions.length > 0);
      expect(prior.verdicts.includes("reopen")).toBe(prior.decisions.length > 0);
      expect(prior.verdicts.at(-1)).toBe("not-assessable");
      expect(prior.verdicts).toEqual(VERDICTS.filter(verdict => prior.verdicts.includes(verdict)));
    }
  });

  it("names each standing the fixtures were built to show", () => {
    const standings = SUCCESSORS.map(([, make]) => standaloneAssessmentRoster(make()).priors.map(prior => prior.standing));
    expect(standings).toEqual([["active"], ["retired"], ["active", "active"], ["retired", "retired"], ["active", "active"]]);
  });
});

describe("the roster and successor admission are one rule", () => {
  it.each(SUCCESSORS)("for %s, every verdict, citation and repair path is admitted exactly when its roster row allows it", (_name, make) => {
    const prepared = make();
    const roster = standaloneAssessmentRoster(prepared);
    let admittedCount = 0;
    for (const [index, prior] of roster.priors.entries()) {
      for (const verdict of VERDICTS) for (const reference of citations(prior)) for (const path of paths(roster)) {
        const chosen = assessment(prior.origin, verdict, reference, path);
        const allowed = admitsStandaloneAssessment(roster, prior, chosen);
        const assessed = assessStandaloneSuccessor(prepared, payloadWith(prepared, index, chosen));
        expect(assessed.ok, `${prior.origin} ${verdict} ${reference} ${path}`).toBe(allowed);
        if (allowed) admittedCount++;
        if (!assessed.ok) {
          expect(assessed.error.message).toContain(`priorAssessments[${index}] (origin ${prior.origin}, ${prior.standing}) says ${verdict}`);
          expect(assessed.error.message).toContain(`allows ${prior.verdicts.join(", ")}`);
          expect(new TextEncoder().encode(assessed.error.message).length).toBeLessThanOrEqual(2_048);
        }
      }
    }
    // Never vacuous: every fixture admits at least the not-assessable arm.
    expect(admittedCount).toBeGreaterThan(0);
  });

  it("admits any payload built only from the roster's own rows (property)", () => {
    const prepared = SUCCESSORS.map(([, make]) => make());
    fc.assert(fc.property(fc.integer({ min: 0, max: prepared.length - 1 }), fc.array(fc.nat(), { minLength: 8, maxLength: 8 }), (which, picks) => {
      const successor = prepared[which]!;
      const roster = standaloneAssessmentRoster(successor);
      const priorAssessments = roster.priors.map((prior, index) => {
        const pick = picks[index % picks.length]!;
        const verdict = prior.verdicts[pick % prior.verdicts.length]!;
        const reference = prior.decisions[pick % Math.max(prior.decisions.length, 1)]?.reference ?? FOREIGN_REFERENCE;
        const path = roster.repairablePaths[pick % Math.max(roster.repairablePaths.length, 1)]?.path ?? OUTSIDE_SCOPE;
        return assessment(prior.origin, verdict, reference, path);
      });
      const payload: StandaloneReviewerPayloadV3 = { schemaVersion: 3, kind: "standalone-successor-review",
        lineageDigest: roster.lineageDigest, snapshotDigest: roster.snapshotDigest, priorAssessments, findings: [] };
      expect(assessStandaloneSuccessor(successor, payload).ok).toBe(true);
    }), { seed: 185, numRuns: 200 });
  });

  it("refuses a retired prior said to be still present, naming what its row allows (the live #185 refusal)", () => {
    const prepared = successor(source(true, true));
    const [prior] = standaloneAssessmentRoster(prepared).priors;
    const chosen = assessment(prior!.origin, "still-present", "", "");
    expect(describeInadmissibleAssessment(0, prior!, chosen)).toBe(
      "Assessment must respect the exact prior decision and explicitly reopen retired history: " +
      `priorAssessments[0] (origin ${prior!.origin}, retired) says still-present; ` +
      `its ${STANDALONE_ASSESSMENT_ROSTER_SECTION} row allows retained, reopen, not-assessable, citing only: ${prior!.decisions[0]!.reference}.`,
    );
    expect(assessStandaloneSuccessor(prepared, payloadWith(prepared, 0, chosen))).toMatchObject({ ok: false,
      error: { message: describeInadmissibleAssessment(0, prior!, chosen) } });
  });

  it("says a refused repair must name a repairable path", () => {
    const [prior] = standaloneAssessmentRoster(successor(source(true))).priors;
    expect(describeInadmissibleAssessment(0, prior!, assessment(prior!.origin, "repaired", "", OUTSIDE_SCOPE)))
      .toMatch(/says repaired naming src\/elsewhere\.ts; .* A repair must name one of the roster's repairablePaths\.$/);
  });
});

describe("the issued successor packet carries the roster admission judges by", () => {
  const request = (prepared: PreparedStandaloneSuccessor, attempt: 1 | 2 = 1) => {
    const policy = value(resolveAgentPolicy("code-reviewer"));
    return { runId: value(parseOrchestrationRunId(prepared.runId)), requestId: value(parseRequestId(`request:code-reviewer:${attempt}`)),
      role: policy.agent, attempt, requiredSkill: policy.requiredSkill };
  };

  it("re-proves a packet issued before the roster under its own layout, and refuses a forged roster", () => {
    const prepared = successor(source(true));
    const current = value(buildStandaloneSuccessorReviewerContext(prepared, request(prepared), []));
    // The pre-#185 layout: the same authority and lineage sections, no roster.
    const [authority, lineage] = current.fixedContext;
    const earlier = value(buildStandaloneReviewerContextPacketV3({ requestId: current.requestId, role: current.role,
      requiredSkill: current.requiredSkill, fixedContext: [authority!, lineage!], variableContext: [] }));
    expect(earlier.fixedContext.map(section => section.label)).toEqual([
      "standalone-successor-authority", "standalone-lineage", "reviewer-payload-schema", "reviewer-impact-rubric",
    ]);
    for (const packet of [current, earlier]) {
      expect(reprovesStandaloneSuccessorReviewerContext(prepared, request(prepared), [], packet.digest)).toBe(true);
      // Bound to its request: attempt 2's identity never re-proves attempt 1's packet.
      expect(reprovesStandaloneSuccessorReviewerContext(prepared, request(prepared, 2), [], packet.digest)).toBe(false);
    }
    // A roster other than the one this lineage projects is not an issued layout.
    const foreignRoster = value(encodeByteSection(STANDALONE_ASSESSMENT_ROSTER_SECTION,
      JSON.stringify(standaloneAssessmentRoster(successor(source(true, true))))));
    const forged = value(buildStandaloneReviewerContextPacketV3({ requestId: current.requestId, role: current.role,
      requiredSkill: current.requiredSkill, fixedContext: [authority!, lineage!, foreignRoster], variableContext: [] }));
    expect(reprovesStandaloneSuccessorReviewerContext(prepared, request(prepared), [], forged.digest)).toBe(false);
  });

  it("encodes the exact roster between the lineage and the frozen schema", () => {
    const prepared = successor(source(true));
    const packet = value(buildStandaloneSuccessorReviewerContext(prepared, request(prepared), []));
    expect(packet.fixedContext.map(section => section.label)).toEqual([
      "standalone-successor-authority", "standalone-lineage", STANDALONE_ASSESSMENT_ROSTER_SECTION, "reviewer-payload-schema", "reviewer-impact-rubric",
    ]);
    const section = packet.fixedContext.find(({ label }) => label === STANDALONE_ASSESSMENT_ROSTER_SECTION)!;
    expect(new TextDecoder().decode(Uint8Array.from(section.bytes))).toBe(JSON.stringify(standaloneAssessmentRoster(prepared)));
  });
});
