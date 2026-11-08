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

import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assignUnits,
  coverageComplete,
  coverageSettled,
  deferPlannedUnits,
  mergeCritic,
  recordUnitResult,
  seedCoverageUnit,
  sortLedger,
  summarizeCoverage,
  validateLedger,
  type CoverageLedger,
  type CoverageUnit,
} from "../../src/core/security-coverage";
import { ok } from "./fixtures";

const require = createRequire(import.meta.url);
const FIXTURES = join(import.meta.dirname, "..", "fixtures", "security", "upstream");

type UpstreamLedgerValidator = {
  validateDocument: (ledger: unknown) => readonly string[];
};

const upstream = require(join(FIXTURES, "validate-coverage-ledger.cjs")) as UpstreamLedgerValidator;
const upstreamValid = (ledger: unknown): boolean => upstream.validateDocument(ledger).length === 0;
const oursValid = (ledger: unknown): boolean => validateLedger(ledger as CoverageLedger).length === 0;

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

const assigned = (ledger: CoverageLedger, coverageId: string, agentId: string, wave = 1): CoverageLedger => {
  const result = assignUnits(ledger, [{ coverageId, agentId, wave }]);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
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

    const inFlight = assigned(planned, unit.coverage_id, "hunter-a");
    expect(oursValid(inFlight)).toBe(true);
    expect(upstreamValid(inFlight)).toBe(true);

    const candidate = settled(inFlight, unit.coverage_id, "hunter-a", "tenant-scope/cache-key");
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

    const secondPass = settled(assigned(reassigned.value.ledger, unit.coverage_id, "hunter-b", 2), unit.coverage_id, "hunter-b", "tenant-scope/cache-key", 2);
    expect(oursValid(secondPass)).toBe(true);
    expect(upstreamValid(secondPass)).toBe(true);
  });

  it("never accepts a ledger upstream rejects", () => {
    const unit = seed();
    const candidate = settled(assigned([unit], unit.coverage_id, "hunter-a"), unit.coverage_id, "hunter-a", "tenant-scope/cache-key");
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
      { name: "attempt with a stale wave", document: [{ ...base, attempts: [{ wave: 5, status: "covered", agent_id: "hunter-z", reviewed_paths: base.reviewed_paths, local_checks: base.local_checks, result_fingerprints: [], unresolved: [], reassignment_reason: "x" }] }] },
      { name: "current owner repeated from an attempt", document: [{ ...base, attempts: [{ wave: 1, status: "covered", agent_id: "hunter-a", reviewed_paths: base.reviewed_paths, local_checks: base.local_checks, result_fingerprints: [], unresolved: [], reassignment_reason: "x" }] }] },
      { name: "semantic fields disagree with refs", document: [{ ...base, surface: "something else" }] },
      { name: "lifecycle only on the unit", document: [{ ...base, lifecycle: "retention" }] },
      { name: "unexpected canonical ref", document: [{ ...base, canonical_refs: { ...base.canonical_refs, extra: "x" } }] },
    ];

    for (const mutation of mutations) {
      const ourAnswer = oursValid(mutation.document);
      const upstreamAnswer = upstreamValid(mutation.document);
      if (ourAnswer) {
        expect({ name: mutation.name, valid: upstreamAnswer }).toEqual({ name: mutation.name, valid: true });
      }
      expect({ name: mutation.name, upstreamAccepted: upstreamAnswer }).toEqual({
        name: mutation.name,
        upstreamAccepted: ourAnswer || upstreamAnswer,
      });
    }
  });
});

describe("coverage ledger: state machine", () => {
  it("assigns only planned units and requires the assigned owner to settle", () => {
    const unit = seed();
    const inFlight = assigned([unit], unit.coverage_id, "hunter-a");
    expect(inFlight[0].status).toBe("in_progress");
    expect(inFlight[0].agent_id).toBe("hunter-a");

    const wrongOwner = recordUnitResult(inFlight, {
      coverageId: unit.coverage_id,
      agentId: "hunter-b",
      wave: 1,
      status: "covered",
      reviewedPaths: ["src/reports/controller.ts"],
      checks: [],
    });
    expect(wrongOwner.ok).toBe(false);

    const doubleAssign = assignUnits(inFlight, [{ coverageId: unit.coverage_id, agentId: "hunter-b", wave: 1 }]);
    expect(doubleAssign.ok).toBe(false);
  });

  it("archives the prior attempt on reassignment and refuses a reused owner", () => {
    const unit = seed();
    const candidate = settled(assigned([unit], unit.coverage_id, "hunter-a"), unit.coverage_id, "hunter-a", "tenant-scope/cache-key");
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
    expect(next.attempts[0].agent_id).toBe("hunter-a");
    expect(next.attempts[0].reassignment_reason).toBe("critic: sibling path unread");

    const reused = assignUnits(merged.value.ledger, [{ coverageId: unit.coverage_id, agentId: "hunter-a", wave: 2 }]);
    expect(reused.ok).toBe(false);
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
