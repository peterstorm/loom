/**
 * Differential oracle for the coverage ledger, plus the state-machine
 * properties that make "no unit silently unassigned" checkable.
 *
 * The oracle's direction is asymmetric on purpose: the TS port is stricter
 * than the vendored validator in exactly one place (semantic fields must equal
 * their `canonical_refs`), so the claim proved here is
 *
 *   ours accepts ⇒ upstream accepts            (no false accept, ever)
 *   constructor-built canonical ledgers agree  (no accidental drift)
 *
 * A document we accept that upstream rejects would mean we can publish a ledger
 * Cloudflare's own tooling calls invalid. The reverse — upstream accepting
 * something we reject — is the deliberate extra check.
 */

import fc from "fast-check";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COVERAGE_STATUSES,
  HUNTER_RESULT_KIND,
  admitArtifactNonce,
  assignUnits,
  catalogAgentOfOwner,
  coverageComplete,
  coverageSettled,
  deferPlannedUnits,
  incompleteReasonSource,
  mergeCritic,
  parseCoverageSeeds,
  parseLedger,
  parseCriticResult,
  parseHunterResult,
  parseOwnedArtifactPath,
  parseUnitResults,
  recordUnitResult,
  runStatusOf,
  seedCoverageUnit,
  sortLedger,
  summarizeCoverage,
  validateLedger,
  type CoverageCriticResult,
  type CoverageError,
  type CoverageLedger,
  type CoverageSeed,
  type CoverageUnit,
  type CriticError,
} from "../../src/core/security-coverage";
import type { DomainResult } from "../../src/core/orchestration-contract/identity";
import { HUNTER_ENVELOPE, aConfirmedFinding, aRefs, aSeed, aUnitResult, ok } from "./fixtures";

const require = createRequire(import.meta.url);
const FIXTURES = join(import.meta.dirname, "..", "fixtures", "security", "upstream");

type UpstreamLedgerValidator = {
  validateDocument: (ledger: unknown) => readonly string[];
};

const upstream = require(join(FIXTURES, "validate-coverage-ledger.cjs")) as UpstreamLedgerValidator;
const upstreamValid = (ledger: unknown): boolean => upstream.validateDocument(ledger).length === 0;
const oursValid = (ledger: unknown): boolean => validateLedger(ledger as CoverageLedger).length === 0;

/** Mutations of a valid ledger that the vendored validator ACCEPTS and this port
 *  rejects — the places this port is deliberately stricter. Enumerated by name,
 *  because the header's claim "stricter in exactly one place" is otherwise only
 *  prose: an empty list would mean the oracle proves nothing but agreement, and
 *  a listed name that stops being rejected would mean the check silently
 *  stopped running. */
const STRICTER_THAN_UPSTREAM: readonly string[] = [
  // Upstream never compares the unit's semantic fields against its own
  // `canonical_refs`, so a unit whose id says one thing and whose `surface`
  // says another validates there. This port derives the id FROM the refs, so
  // the disagreement is a defect it names.
  "semantic fields disagree with refs",
];

const seed = (overrides: Partial<Parameters<typeof seedCoverageUnit>[0]> = {}) =>
  ok(seedCoverageUnit({
    refs: aRefs({
      surface: "http:GET /reports/:id",
      boundary: "tenant isolation",
      subsystem: "reporting",
      attack_class: "cache-key-poisoning",
    }),
    starting_paths: ["src/reports/controller.ts"],
    ordinary_attack_class_block: "ATTACK-CLASSES.md#access-control",
    selected_companion_blocks: ["DATA-ISOLATION-AND-LIFECYCLE.md#tenant-and-object-isolation"],
    excluded_blocks: [{ block: "CLIENT-SIDE.md#dom", reason: "no browser surface" }],
    prior: null,
    ...overrides,
  }));

const evidence = (agentId: string, fingerprint: string) => ({
  agentId,
  status: "candidate" as const,
  reviewedPaths: ["src/reports/controller.ts"],
  checks: [
    {
      agent_id: agentId,
      reviewed_paths: ["src/reports/controller.ts"],
      invariant: "the cache key includes the tenant",
      method: "source" as const,
      result: "the key is derived from the path alone",
      artifact: null,
    },
  ],
  fingerprints: [fingerprint],
});

/** The one catalog hunter. A unit's first attempt runs under this name; a
 *  reassigned one under the owner id the ledger mints from it. */
const HUNTER = "security-hunter-agent";

const assigned = (ledger: CoverageLedger, coverageId: string, agentId: string, wave = 1): CoverageLedger =>
  ok(assignUnits(ledger, [{ coverageId, agentId, wave }])).ledger;

const settled = (ledger: CoverageLedger, coverageId: string, agentId: string, fingerprint: string, wave = 1): CoverageLedger =>
  ok(recordUnitResult(ledger, { coverageId, ...evidence(agentId, fingerprint), wave }));

describe("coverage ledger: TS port vs upstream validator", () => {
  it("agrees on constructor-built canonical ledgers", () => {
    const unit = seed();
    const planned = [unit];
    expect(oursValid(planned)).toBe(true);
    expect(upstreamValid(planned)).toBe(true);

    const inFlight = assigned(planned, unit.coverage_id, HUNTER);
    expect(oursValid(inFlight)).toBe(true);
    expect(upstreamValid(inFlight)).toBe(true);

    const candidate = settled(inFlight, unit.coverage_id, HUNTER, "tenant-scope/cache-key");
    expect(oursValid(candidate)).toBe(true);
    expect(upstreamValid(candidate)).toBe(true);

    const reassigned = ok(mergeCritic(
      candidate,
      { missingUnits: [], reassignIds: [unit.coverage_id], resolvedPriorLeads: [], stop: false },
      { wave: 2, reassignmentReasons: { [unit.coverage_id]: "critic: the cache path was not followed" } },
    ));
    expect(oursValid(reassigned.ledger)).toBe(true);
    expect(upstreamValid(reassigned.ledger)).toBe(true);

    const secondPass = settled(assigned(reassigned.ledger, unit.coverage_id, HUNTER, 2), unit.coverage_id, `${HUNTER}--2`, "tenant-scope/cache-key", 2);
    expect(oursValid(secondPass)).toBe(true);
    expect(upstreamValid(secondPass)).toBe(true);
  });

  it("never accepts a ledger upstream rejects", () => {
    const unit = seed();
    const candidate = settled(assigned([unit], unit.coverage_id, HUNTER), unit.coverage_id, HUNTER, "tenant-scope/cache-key");
    const base = candidate[0] as CoverageUnit;

    const mutations: readonly { name: string; document: unknown }[] = [
      { name: "not an array", document: {} },
      { name: "unsorted", document: [seed({ refs: aRefs({ surface: "z", boundary: "b", subsystem: "s", attack_class: "a" }) }), seed()] },
      { name: "duplicate id", document: [base, base] },
      { name: "canonical id mismatch", document: [{ ...base, coverage_id: "wrong::id" }] },
      { name: "unsafe starting path", document: [{ ...base, starting_paths: ["/etc/passwd"] }] },
      { name: "empty starting paths", document: [{ ...base, starting_paths: [] }] },
      { name: "duplicate starting path", document: [{ ...base, starting_paths: [base.starting_paths[0], base.starting_paths[0]] }] },
      { name: "selected and excluded overlap", document: [{ ...base, excluded_blocks: [{ block: base.selected_companion_blocks[0], reason: "x" }] }] },
      { name: "invalid prior status", document: [{ ...base, prior_status: "prior_nope" }] },
      { name: "invalid status", document: [{ ...base, status: "done" }] },
      { name: "wave zero", document: [{ ...base, wave: 0 }] },
      { name: "planned with owner", document: [{ ...base, status: "planned" }] },
      { name: "covered without evidence", document: [{ ...base, status: "covered", reviewed_paths: [], local_checks: [] }] },
      { name: "candidate without fingerprints", document: [{ ...base, result_fingerprints: [] }] },
      { name: "covered with fingerprints", document: [{ ...base, status: "covered" }] },
      { name: "reviewed path without a check owner", document: [{ ...base, reviewed_paths: ["src/other.ts", ...base.reviewed_paths] }] },
      { name: "local check with a foreign artifact", document: [{ ...base, local_checks: [{ ...base.local_checks[0], method: "local", artifact: "agents/hunter-b/artifacts/x.json" }] }] },
      { name: "source check with an artifact", document: [{ ...base, local_checks: [{ ...base.local_checks[0], artifact: "agents/hunter-a/artifacts/x.json" }] }] },
      { name: "attempt with a stale wave", document: [{ ...base, attempts: [{ wave: 5, status: "covered", agent_id: "security-hunter-agent--9", reviewed_paths: base.reviewed_paths, local_checks: base.local_checks, result_fingerprints: [], unresolved: [], reassignment_reason: "x" }] }] },
      { name: "current owner repeated from an attempt", document: [{ ...base, attempts: [{ wave: 1, status: "covered", agent_id: HUNTER, reviewed_paths: base.reviewed_paths, local_checks: base.local_checks, result_fingerprints: [], unresolved: [], reassignment_reason: "x" }] }] },
      { name: "semantic fields disagree with refs", document: [{ ...base, surface: "something else" }] },
      { name: "lifecycle only on the unit", document: [{ ...base, lifecycle: "retention" }] },
      { name: "unexpected canonical ref", document: [{ ...base, canonical_refs: { ...base.canonical_refs, extra: "x" } }] },
    ];

    const acceptedByUs: string[] = [];
    const acceptedByUpstream: string[] = [];
    for (const mutation of mutations) {
      const ourAnswer = oursValid(mutation.document);
      const upstreamAnswer = upstreamValid(mutation.document);
      // The forward direction, per mutation: a document WE accept that upstream
      // rejects would let the run publish a ledger Cloudflare's own tooling
      // calls invalid.
      if (ourAnswer) {
        expect({ name: mutation.name, upstreamAccepted: upstreamAnswer })
          .toEqual({ name: mutation.name, upstreamAccepted: true });
        acceptedByUs.push(mutation.name);
      }
      if (upstreamAnswer) acceptedByUpstream.push(mutation.name);
    }
    // Every mutation in the table is a defect `validateLedger` must name. This
    // is the assertion the previous loop only appeared to make: its second
    // expectation compared `upstreamAnswer` against `ourAnswer || upstreamAnswer`,
    // which fails only when `ourAnswer && !upstreamAnswer` — the exact condition
    // the first expectation already testifies to, so it could never fail on its
    // own and proved nothing.
    expect(acceptedByUs).toEqual([]);
    // And the ones the vendored validator lets through: the extra checks this
    // port adds on top of upstream, pinned by NAME so a check that stops running
    // shows up as a diff rather than as a loop that quietly did less.
    expect(acceptedByUpstream).toEqual(STRICTER_THAN_UPSTREAM);
    // The comparison is only meaningful if the loop actually reached every
    // mutation: a table that shrank would otherwise still report agreement.
    expect(mutations.length).toBeGreaterThanOrEqual(20);
  });
});

describe("coverage ledger: state machine", () => {
  it("assigns only planned units and requires the assigned owner to settle", () => {
    const unit = seed();
    const inFlight = assigned([unit], unit.coverage_id, HUNTER);
    expect(inFlight[0].status).toBe("in_progress");
    expect(inFlight[0].agent_id).toBe(HUNTER);

    const wrongOwner = recordUnitResult(inFlight, {
      coverageId: unit.coverage_id,
      agentId: `${HUNTER}--2`,
      wave: 1,
      status: "covered",
      reviewedPaths: ["src/reports/controller.ts"],
      checks: [],
    });
    expect(wrongOwner.ok).toBe(false);

    const doubleAssign = assignUnits(inFlight, [{ coverageId: unit.coverage_id, agentId: HUNTER, wave: 1 }]);
    expect(doubleAssign.ok).toBe(false);
  });

  it("refuses an agent the catalog cannot place at assignment, not at publish", () => {
    const unit = seed();
    for (const agentId of ["hunter-a", `${HUNTER}--2`, "Security-Hunter-Agent"]) {
      const refused = assignUnits([unit], [{ coverageId: unit.coverage_id, agentId }]);
      expect(refused).toEqual({ ok: false, error: { kind: "unknown-hunter", coverageId: unit.coverage_id, agentId } });
    }
  });

  it("archives the prior attempt on reassignment, and re-hunts it under a fresh owner of the same catalog agent", () => {
    const unit = seed();
    const candidate = settled(assigned([unit], unit.coverage_id, HUNTER), unit.coverage_id, HUNTER, "tenant-scope/cache-key");
    const merged = ok(mergeCritic(
      candidate,
      { missingUnits: [], reassignIds: [unit.coverage_id], resolvedPriorLeads: [], stop: false },
      { wave: 2, reassignmentReasons: { [unit.coverage_id]: "critic: sibling path unread" } },
    ));
    const [next] = merged.ledger;
    expect(next.wave).toBe(2);
    expect(next.status).toBe("planned");
    expect(next.agent_id).toBeNull();
    expect(next.reviewed_paths).toEqual([]);
    expect(next.attempts).toHaveLength(1);
    expect(next.attempts[0].agent_id).toBe(HUNTER);
    expect(next.attempts[0].reassignment_reason).toBe("critic: sibling path unread");

    // The critic-driven reassignment the ledger used to make unsatisfiable: the
    // catalog name was "not fresh", and any other name was "unplaceable" at
    // publish. The ledger now mints the fresh owner from the catalog agent.
    const reassigned = ok(assignUnits(merged.ledger, [{ coverageId: unit.coverage_id, agentId: HUNTER, wave: 2 }]));
    expect(reassigned.assigned).toEqual([{ coverageId: unit.coverage_id, ownerId: `${HUNTER}--2`, wave: 2 }]);
    expect(reassigned.ledger[0].agent_id).toBe(`${HUNTER}--2`);
    expect(catalogAgentOfOwner(`${HUNTER}--2`)).toBe(HUNTER);

    // The prior owner cannot settle the new attempt; the fresh one can.
    const stale = recordUnitResult(reassigned.ledger, { coverageId: unit.coverage_id, ...evidence(HUNTER, "tenant-scope/cache-key"), wave: 2 });
    expect(stale.ok).toBe(false);
    const rehunted = settled(reassigned.ledger, unit.coverage_id, `${HUNTER}--2`, "tenant-scope/cache-key", 2);
    expect(validateLedger(rehunted)).toEqual([]);
    expect(upstreamValid(rehunted)).toBe(true);
  });

  it("mints the lowest owner id no archived attempt has spent", () => {
    const unit = seed();
    const archived = (wave: number, agent_id: string) => ({
      wave,
      status: "covered" as const,
      agent_id,
      reviewed_paths: ["src/reports/controller.ts"],
      local_checks: [{ ...evidence(agent_id, "x").checks[0] }],
      result_fingerprints: [],
      unresolved: [],
      reassignment_reason: "critic: walk it again",
    });
    // Attempts spent the bare name and `--3` (an operator-chosen gap): the next
    // fresh owner is `--4`, never a name an attempt already used.
    const third = { ...unit, wave: 3, attempts: [archived(1, HUNTER), archived(2, `${HUNTER}--3`)] };
    expect(validateLedger([third])).toEqual([]);
    const result = ok(assignUnits([third], [{ coverageId: unit.coverage_id, agentId: HUNTER }]));
    expect(result.assigned[0].ownerId).toBe(`${HUNTER}--4`);
  });

  it("reads an owner id back to its catalog agent, and only a well-formed attempt suffix", () => {
    expect(catalogAgentOfOwner(HUNTER)).toBe(HUNTER);
    expect(catalogAgentOfOwner(`${HUNTER}--2`)).toBe(HUNTER);
    expect(catalogAgentOfOwner(`${HUNTER}--17`)).toBe(HUNTER);
    // `--1` is never minted (the first attempt is the bare name) and `--02` is
    // not canonical, so neither is read as an attempt suffix.
    expect(catalogAgentOfOwner(`${HUNTER}--1`)).toBe(`${HUNTER}--1`);
    expect(catalogAgentOfOwner(`${HUNTER}--02`)).toBe(`${HUNTER}--02`);
  });

  it("dedupes critic proposals by semantics and reports a canonical collision", () => {
    const unit = seed();
    const same = ok(mergeCritic(
      [unit],
      {
        missingUnits: [
          {
            refs: unit.canonical_refs,
            startingPaths: ["src/elsewhere.ts"],
            ordinaryAttackClassBlock: null,
            selectedCompanionBlocks: [],
            excludedBlocks: [],
          },
        ],
        reassignIds: [],
        resolvedPriorLeads: [],
        stop: false,
      },
      { wave: 1, reassignmentReasons: {} },
    ));
    expect(same.ledger).toHaveLength(1);
    expect(same.accepted).toEqual([]);
  });

  it("accepts a proposal for a new cell under its canonical id, planned at the critic's wave", () => {
    const unit = seed();
    const refs = aRefs({ surface: "http:GET /admin", boundary: "role check", subsystem: "admin", attack_class: "authz-bypass" });
    const merged = ok(mergeCritic([unit], {
      missingUnits: [{ refs, startingPaths: ["src/admin.ts"], ordinaryAttackClassBlock: null, selectedCompanionBlocks: [], excludedBlocks: [] }],
      reassignIds: [],
      resolvedPriorLeads: [],
      stop: false,
    }, { wave: 3, reassignmentReasons: {} }));
    const accepted = merged.ledger.find((entry) => entry.coverage_id === merged.accepted[0]);
    expect(merged.accepted).toHaveLength(1);
    expect(accepted).toMatchObject({ status: "planned", wave: 3, agent_id: null, starting_paths: ["src/admin.ts"] });
  });

  it("defers unreachable units with a reason and only then claims completeness", () => {
    const a = seed({ refs: aRefs({ surface: "s1", boundary: "b", subsystem: "s", attack_class: "a1" }) });
    const b = seed({ refs: aRefs({ surface: "s2", boundary: "b", subsystem: "s", attack_class: "a2" }) });
    const ledger = sortLedger([a, b]);
    expect(coverageComplete(ledger)).toBe(false);
    const deferred = ok(deferPlannedUnits(ledger, "budget_cannot_reserve_critics_and_validation"));
    expect(coverageSettled(deferred)).toBe(true);
    expect(coverageComplete(deferred)).toBe(false);
    expect(summarizeCoverage(deferred).deferred).toHaveLength(2);
    expect(validateLedger(deferred)).toEqual([]);
    expect(upstreamValid(deferred)).toBe(true);
  });

  it("keeps ids deterministic and sorted for any seed order", () => {
    const a = seed({ refs: aRefs({ surface: "s1", boundary: "b", subsystem: "s", attack_class: "a1" }) });
    const b = seed({ refs: aRefs({ surface: "s2", boundary: "b", subsystem: "s", attack_class: "a2" }) });
    expect(sortLedger([b, a]).map((unit) => unit.coverage_id)).toEqual(sortLedger([a, b]).map((unit) => unit.coverage_id));
    expect(validateLedger(sortLedger([b, a]))).toEqual([]);
  });
});

/** The paths of a refusal, or `[]` for an acceptance — so a test can say WHICH
 *  field was named, not merely that something was. */
const refusedPaths = (result: DomainResult<unknown, CoverageError>): readonly string[] =>
  result.ok ? [] : result.error.violations.map((entry) => entry.path);

describe("mergeCritic fails closed rather than dropping a lead or erasing an attempt", () => {
  const unit = seed();
  const candidate = (): CoverageLedger => settled(assigned([unit], unit.coverage_id, HUNTER), unit.coverage_id, HUNTER, "tenant-scope/cache-key");
  /** A settled unit carrying one unresolved prior lead, as a blocked hunt leaves it. */
  const blockedWithLead = (): CoverageLedger => ok(recordUnitResult(assigned([unit], unit.coverage_id, HUNTER), {
    coverageId: unit.coverage_id,
    ...evidence(HUNTER, "unused"),
    status: "blocked",
    fingerprints: [],
    unresolved: ["prior/lead-1", "the cache configuration is not in the repository"],
    wave: 1,
  }));
  const critic = (overrides: Partial<CoverageCriticResult>): CoverageCriticResult =>
    ({ missingUnits: [], reassignIds: [], resolvedPriorLeads: [], stop: false, ...overrides });
  const REASON = { [unit.coverage_id]: "critic: the cache path was not followed" };

  it.each<readonly [string, () => CoverageLedger, CoverageCriticResult, Readonly<{ reassignmentReasons: Readonly<Record<string, string>>; priorLeadOwners?: Readonly<Record<string, string>> }>, Partial<CriticError> & Readonly<{ kind: CriticError["kind"] }>]>([
    ["a resolution with no owning unit recorded", blockedWithLead, critic({ resolvedPriorLeads: ["prior/lead-1"] }), { reassignmentReasons: {} },
      { kind: "unplaceable-resolution", fingerprint: "prior/lead-1", reason: "no owning unit recorded" }],
    ["a resolution naming an unknown coverage id", blockedWithLead, critic({ resolvedPriorLeads: ["prior/lead-1"] }),
      { reassignmentReasons: {}, priorLeadOwners: { "prior/lead-1": "no::such::cell::x" } },
      { kind: "unplaceable-resolution", fingerprint: "prior/lead-1", reason: "unknown coverage ID no::such::cell::x" }],
    ["a resolution on a unit that does not carry the lead", blockedWithLead, critic({ resolvedPriorLeads: ["prior/other"] }),
      { reassignmentReasons: {}, priorLeadOwners: { "prior/other": unit.coverage_id } },
      { kind: "unplaceable-resolution", fingerprint: "prior/other", reason: `${unit.coverage_id} does not carry this lead` }],
    ["reassigning a planned unit", () => [unit], critic({ reassignIds: [unit.coverage_id] }), { reassignmentReasons: REASON },
      { kind: "reassign-unit-has-no-evidence", coverageId: unit.coverage_id, status: "planned" }],
    ["reassigning an in-flight unit", () => assigned([unit], unit.coverage_id, HUNTER), critic({ reassignIds: [unit.coverage_id] }), { reassignmentReasons: REASON },
      { kind: "reassign-unit-has-no-evidence", coverageId: unit.coverage_id, status: "in_progress" }],
    ["a reassignment with no reason", candidate, critic({ reassignIds: [unit.coverage_id] }), { reassignmentReasons: {} },
      { kind: "missing-reassignment-reason", coverageId: unit.coverage_id }],
    ["a reassignment whose reason is blank", candidate, critic({ reassignIds: [unit.coverage_id] }), { reassignmentReasons: { [unit.coverage_id]: "  " } },
      { kind: "missing-reassignment-reason", coverageId: unit.coverage_id }],
    ["a settled unit with no recorded owner", () => [{ ...candidate()[0]!, agent_id: null }], critic({ reassignIds: [unit.coverage_id] }), { reassignmentReasons: REASON },
      { kind: "terminal-unit-has-no-owner", coverageId: unit.coverage_id, status: "candidate" }],
  ])("refuses %s, naming it", (_case, ledger, result, maps, expected) => {
    const refused = mergeCritic(ledger(), result, { wave: 2, ...maps });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? null : refused.error).toEqual(expected);
  });

  it("refuses a reassignment of an unknown coverage id as a named violation", () => {
    const refused = mergeCritic(candidate(), critic({ reassignIds: ["no::such::cell::x"] }), { wave: 2, reassignmentReasons: {} });
    expect(refusedPaths(refused as DomainResult<unknown, CoverageError>)).toEqual(["reassignIds"]);
    expect(refused.ok ? "" : JSON.stringify(refused.error)).toContain("unknown coverage ID no::such::cell::x");
  });

  it("never invents an owner: every archived attempt names the owner that ran it", () => {
    const merged = ok(mergeCritic(candidate(), critic({ reassignIds: [unit.coverage_id] }), { wave: 2, reassignmentReasons: REASON }));
    expect(merged.ledger[0]!.attempts.map((attempt) => attempt.agent_id)).toEqual([HUNTER]);
  });

  it("resolves a lead the named unit carries", () => {
    const merged = ok(mergeCritic(blockedWithLead(), critic({ resolvedPriorLeads: ["prior/lead-1"] }),
      { wave: 2, reassignmentReasons: {}, priorLeadOwners: { "prior/lead-1": unit.coverage_id } }));
    expect(merged.resolved).toEqual(["prior/lead-1"]);
    expect(merged.ledger[0]!.unresolved).toEqual(["the cache configuration is not in the repository"]);
  });
});

describe("parseLedger returns its own proof, never the caller's array", () => {
  it("hands back a deep frozen copy: mutating the raw document afterwards changes nothing", () => {
    const unit = seed();
    const raw: unknown = JSON.parse(JSON.stringify(settled(assigned([unit], unit.coverage_id, HUNTER), unit.coverage_id, HUNTER, "tenant-scope/cache-key")));
    const parsed = ok(parseLedger(raw));
    expect(parsed).not.toBe(raw);
    const document = raw as { status: string; reviewed_paths: string[] }[];
    document[0]!.status = "planned";
    document[0]!.reviewed_paths.push("src/forged.ts");
    expect(parsed[0]!.status).toBe("candidate");
    expect(parsed[0]!.reviewed_paths).toEqual(["src/reports/controller.ts"]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed[0])).toBe(true);
    expect(Object.isFrozen(parsed[0]!.reviewed_paths)).toBe(true);
  });

  it("still drives every transition from the frozen ledger it returned", () => {
    const unit = seed();
    const parsed = ok(parseLedger(JSON.parse(JSON.stringify([unit]))));
    const inFlight = assigned(parsed, unit.coverage_id, HUNTER);
    expect(validateLedger(settled(inFlight, unit.coverage_id, HUNTER, "tenant-scope/cache-key"))).toEqual([]);
  });
});

describe("coverage ledger: construction enforces the ledger's own state rule", () => {
  const seedResult = (overrides: Partial<CoverageSeed>) => seedCoverageUnit({ ...aSeed(), ...overrides });

  it("refuses every start the ledger would call illegal, naming the seed field", () => {
    const cases: readonly (readonly [string, Partial<CoverageSeed>, string])[] = [
      ["deferred without a reason", { status: "deferred" }, "unresolved"],
      ["out of scope without a reason", { status: "out_of_scope", unresolved: [] }, "unresolved"],
      ["not applicable without a reason", { status: "not_applicable" }, "unresolved"],
      ["planned with something unresolved", { unresolved: ["why"] }, "unresolved"],
      ["an invisible reason", { status: "deferred", unresolved: ["​"] }, "unresolved"],
      ["a duplicated reason", { status: "deferred", unresolved: ["why", "why"] }, "unresolved"],
      ["wave zero", { wave: 0 }, "wave"],
      ["a fractional wave", { wave: 1.5 }, "wave"],
      ["a negative wave", { wave: -2 }, "wave"],
      ["an in-flight start", { status: "in_progress" }, "status"],
    ];
    for (const [name, overrides, path] of cases) {
      expect(refusedPaths(seedResult(overrides)), name).toContain(path);
    }
  });

  it("builds only units `validateLedger` accepts, for every start it admits", () => {
    const starts = fc.record({
      status: fc.constantFrom(...COVERAGE_STATUSES),
      unresolved: fc.array(fc.constantFrom("budget_cannot_reserve_critics_and_validation", "no browser surface", " ", "​"), { maxLength: 3 }),
      wave: fc.oneof(fc.integer({ min: -2, max: 6 }), fc.constantFrom(0.5, Number.NaN)),
    });
    fc.assert(
      fc.property(starts, ({ status, unresolved, wave }) => {
        const built = seedResult({ status, unresolved, wave });
        // Construction and validation are ONE rule: whatever the constructor
        // admits is a legal ledger, so no caller can seed a unit `start` would
        // later refuse as a ledger.
        if (built.ok) expect(validateLedger([built.value])).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it("still admits every legal seeded start", () => {
    expect(seedResult({}).ok).toBe(true);
    expect(seedResult({ wave: 3 }).ok).toBe(true);
    for (const status of ["deferred", "out_of_scope", "not_applicable"] as const) {
      expect(seedResult({ status, unresolved: ["no browser surface"] }).ok, status).toBe(true);
    }
  });
});

describe("coverage ledger: present-but-malformed wire fields are named, never dropped", () => {
  it("refuses a seed whose optional fields are the wrong type", () => {
    const cases: readonly (readonly [string, Record<string, unknown>, string])[] = [
      ["a numeric lifecycle", { lifecycle: 5 }, "units[0].lifecycle"],
      ["a string wave", { wave: "2" }, "units[0].wave"],
      ["a scalar unresolved", { status: "deferred", unresolved: "budget" }, "units[0].unresolved"],
      ["a non-string companion block", { selected_companion_blocks: [7] }, "units[0].selected_companion_blocks"],
      ["an object for excluded blocks", { excluded_blocks: {} }, "units[0].excluded_blocks"],
      ["an exclusion with no reason", { excluded_blocks: [{ block: "CLIENT-SIDE.md#dom" }] }, "units[0].excluded_blocks[0]"],
      ["refs that are not a canonical tuple", { refs: { surface: "s" } }, "units[0].canonical_refs"],
    ];
    for (const [name, overrides, path] of cases) {
      expect(refusedPaths(parseCoverageSeeds([{ ...aSeed(), ...overrides }])), name).toContain(path);
    }
  });

  it("refuses a unit result whose optional lists are malformed, and keeps well-formed ones", () => {
    expect(refusedPaths(parseUnitResults([aUnitResult({ fingerprints: "api/login:sqli-email" })]))).toContain("units[0].fingerprints");
    expect(refusedPaths(parseUnitResults([aUnitResult({ fingerprints: [42] })]))).toContain("units[0].fingerprints");
    expect(refusedPaths(parseUnitResults([aUnitResult({ unresolved: { why: "x" } })]))).toContain("units[0].unresolved");

    const absent = ok(parseUnitResults([aUnitResult()]))[0];
    expect(absent?.fingerprints).toBeUndefined();
    expect(absent?.unresolved).toBeUndefined();
    const present = ok(parseUnitResults([aUnitResult({ status: "candidate", fingerprints: ["api/login:sqli-email"], unresolved: [] })]))[0];
    expect(present?.fingerprints).toEqual(["api/login:sqli-email"]);
    expect(present?.unresolved).toEqual([]);
  });

  it("parses exclusions once, the same way for a seed and a critic proposal", () => {
    const malformed = [{ block: "CLIENT-SIDE.md#dom", reason: " " }];
    const fromSeed = refusedPaths(parseCoverageSeeds([{ ...aSeed(), excluded_blocks: malformed }]));
    const fromCritic = refusedPaths(parseCriticResult({
      schemaVersion: 1,
      kind: "security-coverage-critic",
      missingUnits: [{ refs: aSeed().refs, startingPaths: ["src/a.ts"], ordinaryAttackClassBlock: null, selectedCompanionBlocks: [], excludedBlocks: malformed }],
      reassignIds: [],
      resolvedPriorLeads: [],
    }));
    expect(fromSeed).toContain("units[0].excluded_blocks[0]");
    expect(fromCritic).toContain("critic.missingUnits[0].excludedBlocks[0]");
  });
});

// --- Owned artifact paths and the nonce they may be bound to ---

describe("parseOwnedArtifactPath", () => {
  it("reads the owner out of agents/<owner>/artifacts/<file…>", () => {
    expect(parseOwnedArtifactPath(`agents/${HUNTER}/artifacts/repro.txt`)).toEqual({ path: `agents/${HUNTER}/artifacts/repro.txt`, owner: HUNTER });
    expect(parseOwnedArtifactPath(`agents/${HUNTER}--2/artifacts/deep/repro.txt`)?.owner).toBe(`${HUNTER}--2`);
  });

  it.each([
    ["the artifacts root itself", `agents/${HUNTER}/artifacts`],
    ["a scratch path", `agents/${HUNTER}/scratch/repro.txt`],
    ["a non-canonical owner", "agents/Hunter/artifacts/repro.txt"],
    ["a traversal", `agents/${HUNTER}/artifacts/../../x`],
    ["an absolute path", `/agents/${HUNTER}/artifacts/repro.txt`],
    ["a non-string", 7],
  ])("refuses %s", (_case, value) => {
    expect(parseOwnedArtifactPath(value)).toBeNull();
  });
});

describe("admitArtifactNonce", () => {
  const other = () => seed({ refs: aRefs({ surface: "http:GET /admin", boundary: "role check", subsystem: "admin", attack_class: "authz-bypass" }) });
  const artifact = `agents/${HUNTER}/artifacts/repro.txt`;

  it("admits an artifact of an owner with a unit in flight, naming every unit it holds", () => {
    const [first, second] = [seed(), other()];
    const ledger = assigned(assigned(sortLedger([first, second]), first.coverage_id, HUNTER), second.coverage_id, HUNTER);
    const admitted = ok(admitArtifactNonce(ledger, artifact));
    expect(admitted.artifact).toEqual({ path: artifact, owner: HUNTER });
    expect([...admitted.coverageIds].sort()).toEqual([first.coverage_id, second.coverage_id].sort());
  });

  it("refuses a malformed artifact path", () => {
    const refused = admitArtifactNonce(assigned([seed()], seed().coverage_id, HUNTER), `agents/${HUNTER}/scratch/repro.txt`);
    expect(refused.ok ? null : refused.error.kind).toBe("malformed-artifact-path");
  });

  it("refuses an owner with no unit in flight: planned, settled, or another owner's", () => {
    const unit = seed();
    expect(admitArtifactNonce([unit], artifact).ok ? null : "refused").toBe("refused");
    const done = settled(assigned([unit], unit.coverage_id, HUNTER), unit.coverage_id, HUNTER, "tenant-scope/cache-key");
    const afterSettle = admitArtifactNonce(done, artifact);
    expect(afterSettle.ok ? null : afterSettle.error).toMatchObject({ kind: "no-in-flight-unit", owner: HUNTER });
    const someoneElse = admitArtifactNonce(assigned([unit], unit.coverage_id, HUNTER), "agents/security-critic-agent/artifacts/repro.txt");
    expect(someoneElse.ok ? null : someoneElse.error.kind).toBe("no-in-flight-unit");
  });

  it("refuses an artifact an archived attempt already cited, even for a live owner", () => {
    const [first, second] = [seed(), other()];
    const localCheck = {
      agent_id: HUNTER,
      reviewed_paths: ["src/reports/controller.ts"],
      invariant: "the cache key includes the tenant",
      method: "local" as const,
      result: "the second tenant read the first tenant's report",
      artifact,
    };
    const inFlight = assigned(assigned(sortLedger([first, second]), first.coverage_id, HUNTER), second.coverage_id, HUNTER);
    const settledLocal = ok(recordUnitResult(inFlight, {
      coverageId: first.coverage_id, agentId: HUNTER, wave: 1, status: "covered", reviewedPaths: ["src/reports/controller.ts"], checks: [localCheck],
    }));
    const reassigned = ok(mergeCritic(
      settledLocal,
      { missingUnits: [], reassignIds: [first.coverage_id], resolvedPriorLeads: [], stop: false },
      { wave: 2, reassignmentReasons: { [first.coverage_id]: "critic: the receipt's tenant pair was never varied" } },
    )).ledger;
    // HUNTER is still in flight on the second unit, so only the archive refuses.
    const refused = admitArtifactNonce(reassigned, artifact);
    expect(refused.ok ? null : refused.error).toMatchObject({ kind: "archived-artifact", coverageId: first.coverage_id });
    expect(ok(admitArtifactNonce(reassigned, `agents/${HUNTER}/artifacts/fresh.txt`)).coverageIds).toEqual([second.coverage_id]);
  });
});

// --- The hunter's own envelope ---

describe("parseHunterResult", () => {
  const unit = () => aUnitResult();

  it("parses the envelope, its unit results and its records (sorted before the parse)", () => {
    const parsed = ok(parseHunterResult({
      ...HUNTER_ENVELOPE,
      units: [unit()],
      findings: [aConfirmedFinding({ fingerprint: "z/late" }), aConfirmedFinding({ fingerprint: "a/early", root_cause: "Another cause." })],
    }));
    expect(parsed.units).toHaveLength(1);
    expect(parsed.findings.map((finding) => finding.fingerprint)).toEqual(["a/early", "z/late"]);
    expect(ok(parseHunterResult({ ...HUNTER_ENVELOPE, units: [unit()] })).findings).toEqual([]);
  });

  it("names its own kind", () => {
    expect(HUNTER_RESULT_KIND).toBe("security-hunter-result");
    expect(HUNTER_ENVELOPE.kind).toBe(HUNTER_RESULT_KIND);
  });

  it.each([
    ["the borrowed reviewer label", { schemaVersion: 2, kind: "standalone-review", units: [aUnitResult()] }, ["kind", "schemaVersion"]],
    ["an unknown top-level key", { ...HUNTER_ENVELOPE, units: [aUnitResult()], extra: true }, ["$.extra"]],
    ["a missing units list", { ...HUNTER_ENVELOPE, findings: [] }, ["units"]],
    ["units that are not a list", { ...HUNTER_ENVELOPE, units: "all" }, ["units"]],
    ["a non-object", "units", ["$"]],
    ["an empty result", { ...HUNTER_ENVELOPE, units: [], findings: [] }, ["$"]],
  ])("refuses %s, naming the path", (_case, raw, paths) => {
    const refused = parseHunterResult(raw);
    expect(refused.ok).toBe(false);
    expect(refused.ok ? [] : refused.error.violations.map((entry) => entry.path).sort()).toEqual(paths);
  });

  it("reports a malformed unit and a malformed record together, each under its own list", () => {
    const refused = parseHunterResult({ ...HUNTER_ENVELOPE, units: [aUnitResult({ status: "maybe" })], findings: [{ verdict: "maybe" }] });
    const paths = refused.ok ? [] : refused.error.violations.map((entry) => entry.path);
    expect(paths).toContain("units[0].status");
    expect(paths).toContain("findings[0].verdict");
  });
});

describe("parseCriticResult parses each proposal's refs", () => {
  it("refuses a proposal whose refs are not a canonical tuple, at the proposal's own path", () => {
    const refused = parseCriticResult({
      schemaVersion: 1,
      kind: "security-coverage-critic",
      missingUnits: [{ refs: { surface: "x" }, startingPaths: ["src/a.ts"], ordinaryAttackClassBlock: null, selectedCompanionBlocks: [], excludedBlocks: [] }],
      reassignIds: [],
      resolvedPriorLeads: [],
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? [] : refused.error.violations.map((entry) => entry.path)).toEqual(["critic.missingUnits[0].refs"]);
  });
});

// --- Each defect is reported once ---

describe("a defect is reported once, wherever it sits", () => {
  const UNSAFE = "../etc/passwd";
  const unsafeEvidence = (agent_id: string) => ({
    reviewed_paths: [UNSAFE],
    local_checks: [{ ...evidence(agent_id, "x").checks[0], reviewed_paths: [UNSAFE] }],
  });
  const violationsAt = (violations: readonly { path: string; message: string }[], path: string) =>
    violations.filter((entry) => entry.path === path);

  it("names an archived attempt's unsafe reviewed path once, exactly as a live unit's", () => {
    const unit = seed();
    const live = { ...unit, status: "covered" as const, agent_id: HUNTER, ...unsafeEvidence(HUNTER) };
    const archived = {
      ...unit,
      wave: 2,
      attempts: [{
        wave: 1,
        status: "covered" as const,
        agent_id: HUNTER,
        ...unsafeEvidence(HUNTER),
        result_fingerprints: [],
        unresolved: [],
        reassignment_reason: "critic: walk it again",
      }],
    };
    const liveViolations = violationsAt(validateLedger([live]), "$[0].reviewed_paths");
    const archivedViolations = violationsAt(validateLedger([archived]), "$[0].attempts[0].reviewed_paths");
    expect(liveViolations).toEqual([{ path: "$[0].reviewed_paths", message: "unsafe source path" }]);
    expect(archivedViolations).toEqual([{ path: "$[0].attempts[0].reviewed_paths", message: "unsafe source path" }]);
  });

  const CRITIC: Readonly<Record<string, unknown>> = { schemaVersion: 1, kind: "security-coverage-critic", missingUnits: [], reassignIds: [], resolvedPriorLeads: [] };

  it.each([
    ["missingUnits", "expected an array of proposals"],
    ["reassignIds", "expected an array of strings"],
    ["resolvedPriorLeads", "expected an array of strings"],
  ])("names a present but non-array critic %s once", (key, message) => {
    const refused = parseCriticResult({ ...CRITIC, [key]: "not-a-list" });
    expect(refused.ok ? [] : refused.error.violations).toEqual([{ path: `critic.${key}`, message }]);
  });

  it.each(["missingUnits", "reassignIds", "resolvedPriorLeads"])("names a missing critic %s once, as required", (key) => {
    const { [key]: _omitted, ...rest } = CRITIC;
    const refused = parseCriticResult(rest);
    expect(refused.ok ? [] : refused.error.violations).toEqual([{ path: `critic.${key}`, message: "required: expected an array" }]);
  });
});

// --- One local-check contract, wherever a check arrives ---

describe("a local check is parsed by one contract, on the hunter wire and in a stored ledger", () => {
  const check = (overrides: Record<string, unknown> = {}) => ({ ...evidence(HUNTER, "x").checks[0], ...overrides });
  /** A settled ledger whose one check is `localCheck`, as stored wire data. */
  const settledWith = (localCheck: Record<string, unknown>): unknown => {
    const unit = seed();
    const [settledUnit] = settled(assigned([unit], unit.coverage_id, HUNTER), unit.coverage_id, HUNTER, "tenant-scope/cache-key");
    return [{ ...settledUnit!, local_checks: [localCheck] }];
  };
  const ledgerMessages = (localCheck: Record<string, unknown>) =>
    validateLedger(settledWith(localCheck) as CoverageLedger).filter((entry) => entry.path.startsWith("$[0].local_checks[0]"));
  const wireMessages = (localCheck: Record<string, unknown>) => {
    const parsed = parseUnitResults([aUnitResult({ checks: [localCheck] })]);
    return parsed.ok ? [] : parsed.error.violations.filter((entry) => entry.path.startsWith("units[0].checks[0]"));
  };

  it.each([
    ["a method that is neither source nor local", { method: "manual" }, ".method", "expected source or local"],
    ["a missing method", { method: undefined }, ".method", "expected source or local"],
    ["a key the check shape does not name", { severity: "high" }, ".severity", "unknown field"],
    ["a local check with no receipt", { method: "local", artifact: null }, ".artifact", "a local check must name its receipt"],
    ["a local check citing another owner's artifact", { method: "local", artifact: "agents/security-critic-agent/artifacts/x.txt" }, ".artifact",
      "a local check cites an artifact under its own agent's artifacts root"],
    ["a source check citing an artifact", { artifact: `agents/${HUNTER}/artifacts/x.txt` }, ".artifact", "a source check must use null"],
  ])("refuses %s with the same violation on both paths", (_case, overrides, field, message) => {
    const localCheck = check(overrides);
    expect(ledgerMessages(localCheck)).toContainEqual({ path: `$[0].local_checks[0]${field}`, message });
    expect(wireMessages(localCheck)).toContainEqual({ path: `units[0].checks[0]${field}`, message });
  });

  it("admits a well-formed check on both paths", () => {
    expect(ledgerMessages(check())).toEqual([]);
    expect(wireMessages(check())).toEqual([]);
  });
});

describe("seeds and critic proposals: a malformed optional field is named, never dropped", () => {
  it("refuses a seed key the seed shape does not name, so a misspelling cannot seed another cell", () => {
    const misspelled = parseCoverageSeeds([{ ...aSeed(), lifeCycle: "retention" }]);
    expect(misspelled.ok ? [] : misspelled.error.violations).toContainEqual({ path: "units[0].lifeCycle", message: "unknown field" });
    const camel = parseCoverageSeeds([{ ...aSeed(), selectedCompanionBlocks: ["X.md#y"] }]);
    expect(camel.ok ? [] : camel.error.violations).toContainEqual({ path: "units[0].selectedCompanionBlocks", message: "unknown field" });
  });

  it("refuses a seed lifecycle its canonical refs do not carry", () => {
    // The refs name no lifecycle: honouring the seed's would seed a different
    // cell than its refs identify, and dropping it would seed one it never named.
    expect(refusedPaths(parseCoverageSeeds([{ ...aSeed(), lifecycle: "retention" }]))).toContain("units[0].lifecycle");
    expect(refusedPaths(parseCoverageSeeds([{ ...aSeed({ refs: aRefs({ lifecycle: "retention" }) }), lifecycle: "deletion" }]))).toContain("units[0].lifecycle");
    expect(refusedPaths(parseCoverageSeeds([{ ...aSeed({ refs: aRefs({ lifecycle: "retention" }) }), lifecycle: "retention" }]))).toEqual([]);
  });

  it("refuses a proposal whose ordinary block is not prose, instead of reading it as none", () => {
    const proposal = (ordinaryAttackClassBlock: unknown) => parseCriticResult({
      schemaVersion: 1, kind: "security-coverage-critic", reassignIds: [], resolvedPriorLeads: [],
      missingUnits: [{ refs: aSeed().refs, startingPaths: ["src/a.ts"], ordinaryAttackClassBlock, selectedCompanionBlocks: [], excludedBlocks: [] }],
    });
    expect(refusedPaths(proposal(42))).toEqual(["critic.missingUnits[0].ordinaryAttackClassBlock"]);
    expect(refusedPaths(proposal(" "))).toEqual(["critic.missingUnits[0].ordinaryAttackClassBlock"]);
    expect(ok(proposal(null)).missingUnits[0]?.ordinaryAttackClassBlock).toBeNull();
    expect(ok(proposal("ATTACK-CLASSES.md#injection")).missingUnits[0]?.ordinaryAttackClassBlock).toBe("ATTACK-CLASSES.md#injection");
  });
});

describe("the coverage lifecycle has one definition", () => {
  const blockedLedger = (): CoverageLedger => {
    const unit = seed();
    return ok(recordUnitResult(assigned([unit], unit.coverage_id, HUNTER), {
      coverageId: unit.coverage_id, ...evidence(HUNTER, "x"), status: "blocked", fingerprints: [], unresolved: ["the fixture service would not start"], wave: 1,
    }));
  };

  it("keeps a run in progress while a blocked unit awaits a critic's decision", () => {
    const blocked = blockedLedger();
    expect(coverageSettled(blocked)).toBe(false);
    expect(coverageComplete(blocked)).toBe(false);
    expect(runStatusOf(blocked)).toEqual({ runStatus: "in_progress", incompleteReason: null });
    expect(incompleteReasonSource(blocked)).toBeNull();
  });

  it("reports an incomplete run's reason as recorded only when a deferral recorded an upstream token", () => {
    const [unit] = [seed()];
    const recorded = ok(deferPlannedUnits([unit], "critic_budget_exhausted"));
    expect(runStatusOf(recorded)).toEqual({ runStatus: "incomplete", incompleteReason: "critic_budget_exhausted" });
    expect(incompleteReasonSource(recorded)).toBe("recorded");
    // A hunter's own prose names no upstream token: the class is reported, and
    // the source says it was INFERRED, so nothing presents it as the cause.
    const prose = ok(deferPlannedUnits([unit], "the admin surface was unreachable from the sandbox"));
    expect(runStatusOf(prose)).toEqual({ runStatus: "incomplete", incompleteReason: "validation_budget_exhausted" });
    expect(incompleteReasonSource(prose)).toBe("inferred");
    expect(incompleteReasonSource([unit])).toBeNull();
  });
});

describe("an archived attempt's local artifacts are spent as they are read", () => {
  it("names a second check of one archived attempt that cites the artifact its first check spent", () => {
    const unit = seed();
    const artifact = `agents/${HUNTER}/artifacts/repro.txt`;
    const local = { ...evidence(HUNTER, "x").checks[0], method: "local" as const, artifact };
    const attempt = {
      wave: 1, status: "covered" as const, agent_id: HUNTER, reviewed_paths: ["src/reports/controller.ts"],
      local_checks: [local, local], result_fingerprints: [], unresolved: [], reassignment_reason: "critic: again",
    };
    const violations = validateLedger([{ ...unit, wave: 2, attempts: [attempt] }]);
    expect(violations).toContainEqual({ path: "$[0].attempts[0].local_checks[1].artifact", message: "an archived artifact cannot be reused" });
  });
});
