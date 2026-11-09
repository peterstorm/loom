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
  assignUnits,
  catalogAgentOfOwner,
  coverageComplete,
  coverageSettled,
  deferPlannedUnits,
  mergeCritic,
  parseCoverageSeeds,
  parseCriticResult,
  parseUnitResults,
  recordUnitResult,
  seedCoverageUnit,
  sortLedger,
  summarizeCoverage,
  validateLedger,
  type CoverageError,
  type CoverageLedger,
  type CoverageSeed,
  type CoverageUnit,
} from "../../src/core/security-coverage";
import type { DomainResult } from "../../src/core/orchestration-contract/identity";
import { aSeed, aUnitResult, ok } from "./fixtures";

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

const seed = (overrides: Partial<Parameters<typeof seedCoverageUnit>[0]> = {}) => {
  const seeded = seedCoverageUnit({
    refs: {
      surface: "http:GET /reports/:id",
      boundary: "tenant isolation",
      subsystem: "reporting",
      attack_class: "cache-key-poisoning",
    },
    starting_paths: ["src/reports/controller.ts"],
    ordinary_attack_class_block: "ATTACK-CLASSES.md#access-control",
    selected_companion_blocks: ["DATA-ISOLATION-AND-LIFECYCLE.md#tenant-and-object-isolation"],
    excluded_blocks: [{ block: "CLIENT-SIDE.md#dom", reason: "no browser surface" }],
    prior: null,
    ...overrides,
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  return seeded.value;
};

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

const assigned = (ledger: CoverageLedger, coverageId: string, agentId: string, wave = 1): CoverageLedger => {
  const result = assignUnits(ledger, [{ coverageId, agentId, wave }]);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value.ledger;
};

const settled = (ledger: CoverageLedger, coverageId: string, agentId: string, fingerprint: string, wave = 1): CoverageLedger => {
  const result = recordUnitResult(ledger, { coverageId, ...evidence(agentId, fingerprint), wave });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

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

    const reassigned = mergeCritic(
      candidate,
      { missingUnits: [], reassignIds: [unit.coverage_id], resolvedPriorLeads: [], stop: false },
      { wave: 2, reassignmentReasons: { [unit.coverage_id]: "critic: the cache path was not followed" } },
    );
    if (!reassigned.ok) throw new Error(JSON.stringify(reassigned.error));
    expect(oursValid(reassigned.value.ledger)).toBe(true);
    expect(upstreamValid(reassigned.value.ledger)).toBe(true);

    const secondPass = settled(assigned(reassigned.value.ledger, unit.coverage_id, HUNTER, 2), unit.coverage_id, `${HUNTER}--2`, "tenant-scope/cache-key", 2);
    expect(oursValid(secondPass)).toBe(true);
    expect(upstreamValid(secondPass)).toBe(true);
  });

  it("never accepts a ledger upstream rejects", () => {
    const unit = seed();
    const candidate = settled(assigned([unit], unit.coverage_id, HUNTER), unit.coverage_id, HUNTER, "tenant-scope/cache-key");
    const base = candidate[0] as CoverageUnit;

    const mutations: readonly { name: string; document: unknown }[] = [
      { name: "not an array", document: {} },
      { name: "unsorted", document: [seed({ refs: { surface: "z", boundary: "b", subsystem: "s", attack_class: "a" } }), seed()] },
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
    const merged = mergeCritic(
      candidate,
      { missingUnits: [], reassignIds: [unit.coverage_id], resolvedPriorLeads: [], stop: false },
      { wave: 2, reassignmentReasons: { [unit.coverage_id]: "critic: sibling path unread" } },
    );
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    const [next] = merged.value.ledger;
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
    const reassigned = assignUnits(merged.value.ledger, [{ coverageId: unit.coverage_id, agentId: HUNTER, wave: 2 }]);
    if (!reassigned.ok) throw new Error(JSON.stringify(reassigned.error));
    expect(reassigned.value.assigned).toEqual([{ coverageId: unit.coverage_id, ownerId: `${HUNTER}--2`, wave: 2 }]);
    expect(reassigned.value.ledger[0].agent_id).toBe(`${HUNTER}--2`);
    expect(catalogAgentOfOwner(`${HUNTER}--2`)).toBe(HUNTER);

    // The prior owner cannot settle the new attempt; the fresh one can.
    const stale = recordUnitResult(reassigned.value.ledger, { coverageId: unit.coverage_id, ...evidence(HUNTER, "tenant-scope/cache-key"), wave: 2 });
    expect(stale.ok).toBe(false);
    const rehunted = settled(reassigned.value.ledger, unit.coverage_id, `${HUNTER}--2`, "tenant-scope/cache-key", 2);
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
    const result = assignUnits([third], [{ coverageId: unit.coverage_id, agentId: HUNTER }]);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.assigned[0].ownerId).toBe(`${HUNTER}--4`);
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
    const same = mergeCritic(
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
    );
    if (!same.ok) throw new Error(JSON.stringify(same.error));
    expect(same.value.ledger).toHaveLength(1);
    expect(same.value.accepted).toEqual([]);
  });

  it("defers unreachable units with a reason and only then claims completeness", () => {
    const a = seed({ refs: { surface: "s1", boundary: "b", subsystem: "s", attack_class: "a1" } });
    const b = seed({ refs: { surface: "s2", boundary: "b", subsystem: "s", attack_class: "a2" } });
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
    const a = seed({ refs: { surface: "s1", boundary: "b", subsystem: "s", attack_class: "a1" } });
    const b = seed({ refs: { surface: "s2", boundary: "b", subsystem: "s", attack_class: "a2" } });
    expect(sortLedger([b, a]).map((unit) => unit.coverage_id)).toEqual(sortLedger([a, b]).map((unit) => unit.coverage_id));
    expect(validateLedger(sortLedger([b, a]))).toEqual([]);
  });
});

/** The paths of a refusal, or `[]` for an acceptance — so a test can say WHICH
 *  field was named, not merely that something was. */
const refusedPaths = (result: DomainResult<unknown, CoverageError>): readonly string[] =>
  result.ok ? [] : result.error.violations.map((entry) => entry.path);

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
