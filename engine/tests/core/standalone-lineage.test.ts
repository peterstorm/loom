import { describe, expect, expectTypeOf, it } from "vitest";
import fc from "fast-check";
import { dispositionPublicationFixture } from "../fixtures/standalone-disposition-publication";
import { readStandaloneReviewPublication } from "../../src/core/standalone-review-machine";
import { standaloneFixture, valueOf } from "../fixtures/standalone-remediation-authority";
import { REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../src/core/reviewer-contract";
import { parseStandaloneReviewerPayloadV3 } from "../../src/core/reviewer-protocol";
import { STANDALONE_LINEAGE_LIMITS, standaloneLineageInventorySchema, type StandaloneReviewerPayloadV3 } from "../../src/core/standalone-lineage-contract";
import { attributeFindings } from "../../src/core/findings";
import {
  prepareStandaloneLineageSource,
  prepareStandaloneDisposition,
  prepareStandaloneSuccessor,
  aggregateStandaloneAssessments,
  attributeStandaloneSuccessorFindings,
  assessStandaloneSuccessor,
  projectStandaloneLineageSource,
  type StandaloneLineageSource,
  type PreparedStandaloneDisposition,
} from "../../src/core/standalone-lineage";
import {
  parseFindingOrigin,
  parseStandaloneLineageInventory,
  standaloneOriginReference,
  standaloneDecisionReference,
  findingOf,
} from "../../src/core/standalone-finding-origin";
import { type PreparedStandaloneSuccessor } from "../../src/core/standalone-review-model";
import { isPreparedStandaloneSuccessor } from "../../src/core/standalone-review";
import { prepareFreshStandaloneReview } from "../../src/core/standalone-review-preparation";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const historical = { kind: "historical-decision-unavailable" } as const;
const scope = ["src/main.ts", "src/deleted.ts"];
const source = (critical = false, refute = false) => valueOf(prepareStandaloneLineageSource(standaloneFixture(scope, critical, { refute }).input.standaloneResult, "/owned/predecessor"));
const selected = (prior: StandaloneLineageSource, overrides: Record<string, unknown> = {}) => ({
  runId: "run.successor", snapshot: prior.scope.map(path => ({ kind: "present", path, digest: "a".repeat(64), mode: "100644" })),
  reviewers: prior.reviewers, ...overrides,
});
const successor = (prior = source(true)) => valueOf(prepareStandaloneSuccessor(prior, bytes(selected(prior)), historical));
const advisoryTranscript = "CRITICAL_COUNT: 0\nADVISORY_COUNT: 2\nADVISORY: one\nADVISORY: two";
const advisorySource = () => valueOf(prepareStandaloneLineageSource(standaloneFixture(scope, false, { firstTranscript: advisoryTranscript }).input.standaloneResult, "/owned/advisories"));
const disposition = (prior: StandaloneLineageSource, overrides: Record<string, unknown> = {}) => ({ schemaVersion: 1, source: prior.publication,
  provenance: "DECLARED", revision: { kind: "initial" }, entries: prior.inventory.filter(row => findingOf(row).severity === "advisory")
    .map(row => ({ origin: standaloneOriginReference(row.origin), decision: "deferred", reason: "Keep exact reason." })), ...overrides });
const payload = (prepared: PreparedStandaloneSuccessor, verdict = "still-present", extra: Record<string, unknown> = {}) => valueOf(parseStandaloneReviewerPayloadV3(bytes({
  schemaVersion: 3, kind: "standalone-successor-review", lineageDigest: prepared.lineageDigest, snapshotDigest: prepared.snapshotDigest,
  priorAssessments: prepared.inventory.map(row => ({ origin: standaloneOriginReference(row.origin), verdict, reason: "Current assessment.", ...extra })), findings: [],
})));
const reports = (prepared: PreparedStandaloneSuccessor, report: StandaloneReviewerPayloadV3) => prepared.reviewers.map(role => ({ role, payload: report }));
function deepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value).forEach(deepFrozen);
}

describe("Standalone Finding Origin and source membership", () => {
  it("refuses structural source authority before reading attacker getters", () => {
    const fixture = standaloneFixture(scope, true).input.standaloneResult;
    expect(prepareStandaloneLineageSource({ ...fixture } as typeof fixture, "/owned/predecessor").ok).toBe(false);
    let reads = 0;
    const forged = Object.defineProperty({}, "scope", { get() { reads++; throw Error("getter"); } });
    expect(prepareStandaloneLineageSource(forged as typeof fixture, "/owned/predecessor").ok).toBe(false);
    expect(reads).toBe(0);
    expect(prepareStandaloneSuccessor({ ...source() }, bytes({}), historical).ok).toBe(false);
    expectTypeOf<readonly unknown[]>().not.toMatchTypeOf<StandaloneLineageSource>();
  });
  it("lets successor custody leave the core only as a read-only predicate that a structural copy cannot satisfy", () => {
    const minted = successor();
    expect(isPreparedStandaloneSuccessor(minted)).toBe(true);
    const copy = { ...minted };
    expect(isPreparedStandaloneSuccessor(copy)).toBe(false);
    // Preparation sits above the custody core and admits a successor only through that predicate.
    const fresh = prepareFreshStandaloneReview({
      runId: minted.runId, changedPaths: {}, scopeSafety: [], reviewerContexts: [], successor: copy,
      reviewMetadata: { requested_kinds: ["all"], docs_only: false, source_or_test_changed: true, types_changed: false,
        comments_changed: false, additions: 1, file_count: 1, new_structure: false, languages: ["TypeScript"] },
    });
    expect(fresh).toMatchObject({ ok: false, error: { errors: ["successor membership is required"] } });
  });
  it("joins the original LC-2 publication bytes, not mutable legacy children or a newly computed hash", () => {
    const result = standaloneFixture(scope, false, { firstTranscript: "CRITICAL_COUNT: 0\nADVISORY_COUNT: 1\nADVISORY: isolated integrity probe" }).input.standaloneResult;
    const publication = valueOf(readStandaloneReviewPublication(result, STANDALONE_LINEAGE_LIMITS.retainedBytes));
    expect(readStandaloneReviewPublication(result, publication.byteLength - 1).ok).toBe(false);
    const finding = result.advisories[0]!;
    const original = finding.claim;
    try {
      expect(Reflect.set(finding, "claim", "changed after publication")).toBe(true);
      expect(prepareStandaloneLineageSource(result, "/owned/integrity")).toMatchObject({ ok: false, error: { code: "source-unavailable" } });
    } finally { Reflect.set(finding, "claim", original); }
    expect(prepareStandaloneLineageSource(result, "/owned/integrity").ok).toBe(true);
  });
  it("preserves exact original content, published result identity and every refutation vote", () => {
    const prior = source(true, true);
    const original = standaloneFixture(scope, true, { refute: true }).input.standaloneResult;
    expect(prior.inventory.map(findingOf)).toEqual(original.refutedCriticals.map(row => row.finding));
    expect(prior.inventory[0]?.history[0]).toMatchObject({ kind: "adjudication", survives: false, threshold: 2,
      refutations: original.panel?.outcomes[0]?.refutations });
    expect(prior.inventory[0]?.origin).toMatchObject({ kind: "published", requestId: original.reviewerEvidence[0]?.requestId,
      transcriptDigest: original.reviewerEvidence[0]?.artifact.digest, publication: prior.publication });
    deepFrozen(prior);
    expect(parseStandaloneLineageInventory(bytes(prior.inventory))).toEqual({ ok: true, value: prior.inventory });
  });
  it("same bare Finding IDs in independent source locators never join", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 100000 }), n => {
      const result = standaloneFixture(scope, true).input.standaloneResult;
      const a = valueOf(prepareStandaloneLineageSource(result, `/owned/fork-${n}`));
      const b = valueOf(prepareStandaloneLineageSource(result, `/owned/fork-${n + 1}`));
      expect(a.inventory[0]?.finding.id).toBe(b.inventory[0]?.finding.id);
      expect(standaloneOriginReference(a.inventory[0]!.origin)).not.toBe(standaloneOriginReference(b.inventory[0]!.origin));
    }), { seed: 5101, numRuns: 30 });
  });
  it.each(["/", "relative", "/a/../b", "/a//b", "/a/", "/a/./b"])("rejects noncanonical locator %s", locator => {
    expect(prepareStandaloneLineageSource(standaloneFixture().input.standaloneResult, locator).ok).toBe(false);
  });
  it("rejects wrong original Run, duplicate origins, changed ID and incomplete/incorrect panel votes", () => {
    const row = source(true, true).inventory[0]!;
    expect(parseFindingOrigin({ ...row.origin, runId: "run.foreign" }).ok).toBe(false);
    for (const inventory of [[row, row], [{ ...row, finding: { ...row.finding, id: "foreign-1" } }],
      [{ ...row, history: [{ ...row.history[0], threshold: 1 }] }], [{ ...row, history: [{ ...row.history[0], survives: true }] }],
      [{ ...row, history: [{ ...row.history[0], refutations: [] }] }]]) expect(parseStandaloneLineageInventory(bytes(inventory)).ok).toBe(false);
  });
  it.each(["code-reviewer:1", "code reviewer-1", `code-reviewer-${Number.MAX_SAFE_INTEGER}0`])(
    "rejects a stored Finding id outside the task-local FindingId grammar: %s", id => {
      const row = source(true, true).inventory[0]!;
      expect(parseStandaloneLineageInventory(bytes([{ ...row, finding: { ...row.finding, id } }])))
        .toMatchObject({ ok: false, error: { code: "invalid-data" } });
    });
  describe("the lineage row schema rehydrates exactly the minted FindingId grammar", () => {
    const FINDING_ID_REFUSAL = "Finding id must be a task-local Finding ID";
    const rowWithId = (id: string): unknown => {
      const row = source(true, true).inventory[0]!;
      return JSON.parse(JSON.stringify([{ ...row, finding: { ...row.finding, id } }]));
    };
    const legacyDraft = { severity: "advisory" as const, file: null, line: null, claim: "A minted identity probe." };
    // Agent names stay inside the row schema's 2048-byte reference bound once
    // sanitized and suffixed; a longer agent is not a reviewer role name.
    const agent = fc.string({ minLength: 0, maxLength: 256 });
    const ordinal = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
    const mintedId = fc.tuple(agent, ordinal).map(([name, start]) => attributeFindings([legacyDraft], name, start)[0]!.id);

    it("accepts every id attributeFindings mints for any agent name and positive safe ordinal", () => {
      fc.assert(fc.property(mintedId, id => {
        const parsed = standaloneLineageInventorySchema.safeParse(rowWithId(id));
        expect(parsed.success).toBe(true);
        if (parsed.success) expect(parsed.data[0]?.finding.id).toBe(id);
      }), { seed: 5141, numRuns: 200 });
    });

    const refusedFor = (id: string): boolean => {
      const parsed = standaloneLineageInventorySchema.safeParse(rowWithId(id));
      return !parsed.success && JSON.stringify(parsed.error.issues).includes(FINDING_ID_REFUSAL);
    };

    it("refuses a minted id once a ':' or whitespace is spliced in", () => {
      const separator = fc.constantFrom(":", " ", "\t", "\n", "\r", " ", " ", "　");
      fc.assert(fc.property(mintedId, separator, fc.nat(), (id, char, at) => {
        const index = at % (id.length + 1);
        expect(refusedFor(`${id.slice(0, index)}${char}${id.slice(index)}`)).toBe(true);
      }), { seed: 5142, numRuns: 200 });
    });

    it("refuses a numeric suffix beyond the safe-integer range", () => {
      const beyondSafe = fc.bigInt({ min: BigInt(Number.MAX_SAFE_INTEGER) + 1n, max: 10n ** 30n });
      fc.assert(fc.property(agent, beyondSafe, (name, suffix) => {
        const prefix = attributeFindings([legacyDraft], name, 1)[0]!.id.replace(/-1$/u, "");
        expect(refusedFor(`${prefix}-${suffix}`)).toBe(true);
      }), { seed: 5143, numRuns: 200 });
    });
  });
  it("bounds retained ingress before decoding, history count and origin ordinal", () => {
    expect(parseStandaloneLineageInventory(new Uint8Array(STANDALONE_LINEAGE_LIMITS.retainedBytes + 1))).toMatchObject({ ok: false, error: { code: "limit-exceeded" } });
    const row = source(true).inventory[0]!;
    expect(parseStandaloneLineageInventory(bytes(Array(4097).fill(row))).ok).toBe(false);
    expect(parseStandaloneLineageInventory(bytes([{ ...row, history: Array(65).fill(row.history[0]) }])).ok).toBe(false);
    expect(parseFindingOrigin({ ...row.origin, ordinal: Number.MAX_SAFE_INTEGER + 1 }).ok).toBe(false);
    expect(parseFindingOrigin({ ...row.origin, ordinal: Number.MAX_SAFE_INTEGER }).ok).toBe(true);
    const exact = Array.from({ length: 4096 }, (_, index) => ({ ...row, origin: { ...row.origin, ordinal: index + 1 },
      finding: { ...row.finding, id: `code-reviewer-${index + 1}` } }));
    expect(valueOf(parseStandaloneLineageInventory(bytes(exact)))).toHaveLength(4096);
    let getters = 0;
    const unsafe = Object.defineProperty({ ...row.origin }, "ordinal", { enumerable: true, get() { getters++; return 1; } });
    expect(parseFindingOrigin(unsafe).ok).toBe(false);
    expect(getters).toBe(0);
  });
});

describe("complete immutable DECLARED advisory policy", () => {
  it("is idempotent, retains exact prose/reasons, and corrections fork without editing predecessors", () => {
    const prior = advisorySource();
    const first = valueOf(prepareStandaloneDisposition(prior, bytes(disposition(prior))));
    expect(prepareStandaloneDisposition(prior, bytes(disposition(prior)))).toEqual({ ok: true, value: first });
    const before = JSON.stringify(first);
    for (const reason of ["corrected A", "corrected B"]) {
      const record = { ...first.record, revision: { kind: "correction", previousDigest: first.digest },
        entries: first.record.entries.map(entry => ({ ...entry, reason })) };
      const next = dispositionPublicationFixture(valueOf(prepareStandaloneDisposition(prior, bytes(record), dispositionPublicationFixture(first).published))).published;
      expect(next.digest).not.toBe(first.digest);
      expect(valueOf(prepareStandaloneSuccessor(prior, bytes(selected(prior)), { kind: "selected-record", disposition: next })).disposition).toEqual({ kind: "selected-record", disposition: next });
    }
    expect(JSON.stringify(first)).toBe(before);
    const imported = valueOf(prepareStandaloneDisposition(prior, bytes(disposition(prior, {
      revision: { kind: "historical-import", proseReference: "original note", prose: "  Exact historical\nprose.  " },
    }))));
    expect(imported.record.revision).toEqual({ kind: "historical-import", proseReference: "original note", prose: "  Exact historical\nprose.  " });
    deepFrozen(imported);
  });
  it("retains every exact published correction reason/reference in current context and refuses a 65th revision", () => {
    const prior = advisorySource();
    let current = dispositionPublicationFixture(valueOf(prepareStandaloneDisposition(prior, bytes(disposition(prior))))).published;
    const revisions = [current];
    for (let ordinal = 2; ordinal <= 64; ordinal++) {
      const record = { ...current.record, revision: { kind: "correction", previousDigest: current.digest },
        entries: current.record.entries.map(entry => ({ ...entry, reason: `  Revision ${ordinal}\nExact reason  ` })) };
      current = dispositionPublicationFixture(valueOf(prepareStandaloneDisposition(prior, bytes(record), current))).published;
      revisions.push(current);
    }
    expect(current.history).toEqual(revisions.slice(0, -1).map(({ record, digest, publication }) => ({ record, digest, publication })));
    const prepared = valueOf(prepareStandaloneSuccessor(prior, bytes(selected(prior)), { kind: "selected-record", disposition: current }));
    for (const revision of revisions) {
      expect(assessStandaloneSuccessor(prepared, payload(prepared, "retained", { decisionDigest: revision.digest })).ok).toBe(true);
    }
    const projection = valueOf(projectStandaloneLineageSource(prior, { kind: "selected-record", disposition: current }));
    expect(projection.inventory[0]?.policy).toHaveLength(64);
    expect(projection.inventory[0]?.policy.map(row => row.reason)).toEqual(revisions.map(row => row.record.entries[0]!.reason));
    expect(projection.advisoryInventory.map(row => row.origin)).toEqual(prior.inventory.map(row => standaloneOriginReference(row.origin)));
    expect(projection.counts).toEqual({ total: 2, survivingCritical: 0, refutedCritical: 0, resolved: 0, advisory: 2 });
    expect(prepareStandaloneDisposition(prior, bytes({ ...current.record,
      revision: { kind: "correction", previousDigest: current.digest } }), current)).toMatchObject({ ok: false, error: { code: "limit-exceeded" } });
    expect(projectStandaloneLineageSource({ ...prior }, historical).ok).toBe(false);
    expect(projectStandaloneLineageSource(prior, { kind: "selected-record", disposition: { ...current } }).ok).toBe(false);
    expect(projectStandaloneLineageSource(source(), { kind: "selected-record", disposition: current }).ok).toBe(false);
    deepFrozen(projection);
  });
  it("dismissed advisory policy requires explicit reopening, while policy never closes a critical", () => {
    const prior = advisorySource();
    const raw = disposition(prior);
    const record = dispositionPublicationFixture(valueOf(prepareStandaloneDisposition(prior, bytes({ ...raw, entries: raw.entries.map(entry => ({ ...entry, decision: "dismissed" })) })))).published;
    const prepared = valueOf(prepareStandaloneSuccessor(prior, bytes(selected(prior)), { kind: "selected-record", disposition: record }));
    expect(assessStandaloneSuccessor(prepared, payload(prepared)).ok).toBe(false);
    expect(valueOf(aggregateStandaloneAssessments(prepared, reports(prepared, payload(prepared, "retained", { decisionDigest: record.digest })))).every(row => row.state === "retained")).toBe(true);
    const criticalSource = source(true);
    const emptyPolicy = dispositionPublicationFixture(valueOf(prepareStandaloneDisposition(criticalSource, bytes(disposition(criticalSource))))).published;
    const criticalSuccessor = valueOf(prepareStandaloneSuccessor(criticalSource, bytes(selected(criticalSource)), { kind: "selected-record", disposition: emptyPolicy }));
    expect(valueOf(aggregateStandaloneAssessments(criticalSuccessor, reports(criticalSuccessor, payload(criticalSuccessor))))[0]?.state).toBe("active");
    const report = payload(prepared, "not-assessable");
    expect(assessStandaloneSuccessor(prepared, { ...report, priorAssessments: [...report.priorAssessments].reverse() }).ok).toBe(false);
    expect(assessStandaloneSuccessor(prepared, { ...report, priorAssessments: [report.priorAssessments[0]!, report.priorAssessments[0]!] }).ok).toBe(false);
  });
  it("rejects foreign, critical, missing, duplicate, reordered and malformed advisory rows", () => {
    const prior = advisorySource();
    const raw = disposition(prior);
    for (const entries of [[], raw.entries.slice(1), [...raw.entries, raw.entries[0]], [...raw.entries].reverse(),
      raw.entries.map(entry => ({ ...entry, reason: " " })), raw.entries.map(entry => ({ ...entry, decision: "resolved" })),
      [{ ...raw.entries[0], origin: standaloneOriginReference(source(true).inventory[0]!.origin) }, raw.entries[1]]]) {
      expect(prepareStandaloneDisposition(prior, bytes({ ...raw, entries })).ok).toBe(false);
    }
    expect(prepareStandaloneDisposition(source(true), bytes(raw)).ok).toBe(false);
    const first = dispositionPublicationFixture(valueOf(prepareStandaloneDisposition(prior, bytes(raw)))).published;
    expect(prepareStandaloneDisposition(prior, bytes({ ...raw, revision: { kind: "correction", previousDigest: "f".repeat(64) } }), first).ok).toBe(false);
    expect(prepareStandaloneDisposition(prior, bytes({ ...raw, revision: { kind: "correction", previousDigest: first.digest } }), { ...first }).ok).toBe(false);
    expect(prepareStandaloneDisposition(prior, bytes(raw), first).ok).toBe(false);
    expect(prepareStandaloneSuccessor(prior, bytes(selected(prior)), { kind: "selected-record", disposition: { ...first } }).ok).toBe(false);
    expectTypeOf<StandaloneLineageSource>().not.toMatchTypeOf<PreparedStandaloneDisposition>();
  });
});

describe("successor coverage, semantic resolution and identity allocation", () => {
  it("refuses narrower scope/roles, unknown current context and same Run; permits expansion", () => {
    const prior = source(true);
    for (const overrides of [{ snapshot: selected(prior).snapshot.slice(1) }, { reviewers: prior.reviewers.slice(1) },
      { reviewers: [...prior.reviewers, prior.reviewers[0]] }, { runId: prior.publication.runId },
      { snapshot: prior.scope.map(path => ({ kind: "historical-unknown", path })) }]) {
      expect(prepareStandaloneSuccessor(prior, bytes(selected(prior, overrides)), historical).ok).toBe(false);
    }
    const expanded = valueOf(prepareStandaloneSuccessor(prior, bytes(selected(prior, { reviewers: [...prior.reviewers, "architecture-tech-lead"],
      snapshot: [...selected(prior).snapshot, { kind: "absent", path: "new.ts" }] })), historical));
    expect(expanded.reviewers).toHaveLength(3);
    expect(expanded.disposition).toEqual(historical);
    const changed = valueOf(prepareStandaloneSuccessor(prior, bytes(selected(prior, { snapshot: selected(prior).snapshot.map(row => ({ ...row, digest: "b".repeat(64) })) })), historical));
    expect(changed.snapshotDigest).not.toBe(successor(prior).snapshotDigest);
    expect(changed.lineageDigest).not.toBe(successor(prior).lineageDigest);
    deepFrozen(expanded);
  });
  it("only whole-roster repaired judgments resolve; disagreement, unavailability, missing or foreign rows cannot close", () => {
    const prepared = successor();
    const repaired = payload(prepared, "repaired", { change: { path: scope[0], description: "The implementation now enforces the contract." } });
    const all = reports(prepared, repaired);
    expect(valueOf(aggregateStandaloneAssessments(prepared, all))[0]?.state).toBe("resolved");
    for (const verdict of ["still-present", "not-assessable"]) {
      const changed = all.map((report, index) => index === 0 ? { ...report, payload: payload(prepared, verdict) } : report);
      expect(valueOf(aggregateStandaloneAssessments(prepared, changed))[0]?.state).toBe(verdict === "not-assessable" ? "coverage-limited" : "active");
    }
    expect(aggregateStandaloneAssessments(prepared, all.slice(1)).ok).toBe(false);
    expect(aggregateStandaloneAssessments(prepared, [...all].reverse()).ok).toBe(false);
    expect(assessStandaloneSuccessor(prepared, { ...repaired, priorAssessments: [] }).ok).toBe(false);
    expect(assessStandaloneSuccessor(prepared, { ...repaired, snapshotDigest: "f".repeat(64) }).ok).toBe(false);
    expect(assessStandaloneSuccessor(prepared, payload(prepared, "repaired", { change: { path: "foreign.ts", description: "changed" } })).ok).toBe(false);
  });
  it("refuses repaired claims on unchanged known bytes/absence, but preserves honest historical uncertainty", () => {
    const result = standaloneFixture(scope, true).input.standaloneResult;
    const previous = [{ kind: "present" as const, path: scope[0]!, digest: "a".repeat(64), mode: "100644" as const },
      { kind: "absent" as const, path: scope[1]! }] as const;
    const prior = valueOf(prepareStandaloneLineageSource(result, "/owned/observed", previous));
    const check = (snapshot: unknown, path: string) => {
      const prepared = valueOf(prepareStandaloneSuccessor(prior, bytes(selected(prior, { snapshot })), historical));
      return assessStandaloneSuccessor(prepared, payload(prepared, "repaired", { change: { path, description: "Relevant implementation change." } }));
    };
    expect(check(previous, scope[0]!).ok).toBe(false);
    expect(check(previous, scope[1]!).ok).toBe(false);
    expect(check([{ ...previous[0], digest: "b".repeat(64) }, previous[1]], scope[0]!).ok).toBe(true);
    expect(check([{ ...previous[0], mode: "100755" }, previous[1]], scope[0]!).ok).toBe(true);
    expect(check([{ kind: "absent", path: scope[0] }, previous[1]], scope[0]!).ok).toBe(true);
    expect(check(previous.map(row => ({ kind: "present", path: row.path, digest: "b".repeat(64), mode: "100644" })), scope[1]!).ok).toBe(true);
    const unknownMode = valueOf(prepareStandaloneLineageSource(result, "/owned/unknown-mode", [{ ...previous[0]!, mode: null }, previous[1]!]));
    const prepared = valueOf(prepareStandaloneSuccessor(unknownMode, bytes(selected(unknownMode, {
      snapshot: [{ ...previous[0], mode: "100755" }, previous[1]],
    })), historical));
    expect(prepared.previousSnapshot[0]).toHaveProperty("mode", null);
    expect(assessStandaloneSuccessor(prepared, payload(prepared, "repaired", { change: { path: scope[0], description: "Mode allegedly changed." } })).ok).toBe(false);
    expect(prepareStandaloneLineageSource(result, "/owned/wrong-order", [...previous].reverse()).ok).toBe(false);
    expect(prepareStandaloneLineageSource(result, "/owned/oversized", Array(4097).fill(previous[0])).ok).toBe(false);
  });
  it("known-input repair admission depends on observed bytes/modes, never a change description alone", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 1000 }), fc.boolean(), (n, modeChanged) => {
      const originalDigest = n.toString(16).padStart(64, "0");
      const nextDigest = (n + 1).toString(16).padStart(64, "0");
      const observation = scope.map(path => ({ kind: "present" as const, path, digest: originalDigest, mode: "100644" as const }));
      const prior = valueOf(prepareStandaloneLineageSource(standaloneFixture(scope, true).input.standaloneResult, "/owned/property", observation));
      for (const changed of [false, true]) {
        const snapshot = observation.map(row => ({ ...row, digest: changed && !modeChanged ? nextDigest : originalDigest,
          mode: changed && modeChanged ? "100755" : "100644" }));
        const prepared = valueOf(prepareStandaloneSuccessor(prior, bytes(selected(prior, { snapshot })), historical));
        const report = payload(prepared, "repaired", { change: { path: scope[0], description: "Reviewer says it changed." } });
        expect(assessStandaloneSuccessor(prepared, report).ok).toBe(changed);
      }
    }), { seed: 5131, numRuns: 30 });
  });
  it("retired critical history requires explicit reopening evidence and retains prior votes", () => {
    const prepared = successor(source(true, true));
    const row = prepared.inventory[0]!;
    const reference = standaloneDecisionReference(row.history[0]!);
    expect(assessStandaloneSuccessor(prepared, payload(prepared)).ok).toBe(false);
    expect(assessStandaloneSuccessor(prepared, payload(prepared, "repaired", { change: { path: scope[0], description: "change" } })).ok).toBe(false);
    const retained = payload(prepared, "retained", { decisionDigest: reference });
    expect(valueOf(aggregateStandaloneAssessments(prepared, reports(prepared, retained)))[0]?.state).toBe("retained");
    const example = REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!;
    if (example.severity !== "critical") throw Error("critical fixture required");
    const proposal = { decisionDigest: reference, evidence: example.basis.evidence, changedConditions: "The old precondition is now reachable.",
      currentApplicability: "It applies on this snapshot.", evidenceLimits: "Static evidence only." };
    const reopened = payload(prepared, "reopen", { proposal });
    expect(valueOf(aggregateStandaloneAssessments(prepared, reports(prepared, reopened)))[0]?.state).toBe("reopening-required");
    expect(assessStandaloneSuccessor(prepared, payload(prepared, "reopen", { proposal: { ...proposal, decisionDigest: "f".repeat(64) } })).ok).toBe(false);
    expect(prepared.inventory[0]).toEqual(row);
  });
  it("continues high-water across all refuted origins and forks never share current origin identity", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 15 }), count => {
      const transcript = `CRITICAL_COUNT: ${count}\nADVISORY_COUNT: 0\n` + Array.from({ length: count }, (_, i) => `CRITICAL: assertion ${i}`).join("\n");
      const prior = valueOf(prepareStandaloneLineageSource(standaloneFixture(scope, false, { firstTranscript: transcript, refute: true }).input.standaloneResult, "/owned/high-water"));
      const prepared = successor(prior);
      const report = payload(prepared, "not-assessable");
      const draft = { severity: "advisory" as const, file: null, line: null, claim: "Distinct new assertion", reason: "Nonblocking." };
      const withNew = { ...report, findings: [{ draft, relation: { kind: "independent" as const } }] };
      const attributed = valueOf(attributeStandaloneSuccessorFindings(prepared, { role: "code-reviewer", requestId: "request:successor:1", transcriptDigest: "c".repeat(64), payload: withNew }));
      expect(attributed[0]?.finding.id).toBe(`code-reviewer-${count + 1}`);
      expect(attributed[0]?.origin).not.toHaveProperty("publication");
      expect(attributed[0]?.finding).toMatchObject({ protocolVersion: 2, draft });
      const fork = valueOf(prepareStandaloneSuccessor(prior, bytes(selected(prior, { runId: "run.other-fork" })), historical));
      const forkRows = valueOf(attributeStandaloneSuccessorFindings(fork, { role: "code-reviewer", requestId: "request:successor:1", transcriptDigest: "c".repeat(64), payload: { ...withNew, lineageDigest: fork.lineageDigest } }));
      expect(forkRows[0]?.finding.id).toBe(attributed[0]?.finding.id);
      expect(standaloneOriginReference(forkRows[0]!.origin)).not.toBe(standaloneOriginReference(attributed[0]!.origin));
    }), { seed: 5102, numRuns: 20 });
  });
});
