/**
 * Adjudication properties. The rule under test is the one that decides what a
 * run may call a confirmed finding:
 *
 *   INV-S3   no confirmed record is published without a verdict from another
 *            profile — a hunter's own model agreeing with itself verifies
 *            nothing;
 *   INV-S3b  demotion never invents severity (a demoted claim is a lead, and a
 *            lead has no severity by grammar);
 *   INV-S3c  a split panel does not lose a claim: any critical vote keeps it
 *            confirmed, whatever the advisory votes say.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseSecurityFindings } from "../../src/core/security-findings";
import {
  adjudicateCandidates,
  adjudicateRun,
  huntingProfiles,
  parseVerificationVerdicts,
  type VerificationVerdict,
} from "../../src/core/security-adjudication";
import type { LlmProfileId } from "../../src/core/model-profiles";
import { assignUnits, recordUnitResult, seedCoverageUnit, type CoverageLedger } from "../../src/core/security-coverage";

const confirmed = (fingerprint: string) => ({
  verdict: "confirmed" as const,
  fingerprint,
  title: `claim ${fingerprint}`,
  description: "a cross-tenant read is reachable from the export endpoint",
  root_cause: "the export query omits the tenant predicate",
  intended_behavior: "every read is tenant-scoped",
  trace: [{ kind: "entrypoint" as const, file: "src/export.ts", line: 12, scope: "exportReport", description: "path id reaches the query" }],
  evidence: [{ file: "src/query.ts", line: 44, description: "predicate is id-only" }],
  conditions: [],
  execution: {
    attacker_perspective: "an authenticated user of another tenant",
    payloads: ["GET /reports/r1/export"],
    instructions: ["authenticate", "request the foreign id"],
    observed_result: "the foreign rows are returned",
  },
  remediation: { strategy: "add the tenant predicate" },
  severity: {
    likelihood: { score: "high" as const, reason: "no setup" },
    impact: { score: "high" as const, reason: "disclosure" },
    overall_severity: "high" as const,
  },
  confidence: { score: "high" as const, reason: "observed" },
});

const findings = (fingerprints: readonly string[]) => {
  const parsed = parseSecurityFindings([...fingerprints].sort().map(confirmed));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
};

type VerdictOverrides = Partial<Omit<VerificationVerdict, "binding">> & Readonly<{ profile?: LlmProfileId }>;

let issued = 0;

/** A bound ballot from a fresh verifier request (each call is a distinct
 *  spawn), minted on `profile` — `refutation` unless a test says otherwise. */
const verdict = (fingerprint: string, { profile = "refutation", ...overrides }: VerdictOverrides = {}): VerificationVerdict => {
  const slotId = `security-verification-slot:${String(++issued).padStart(32, "0")}`;
  return {
    fingerprint,
    vote: "critical",
    reason: "the trace holds in the pinned revision",
    missingFact: null,
    wave: 1,
    binding: { program: "security-verification", runId: "run.verify-w1-000000000000", requestId: `${slotId}:1`, slotId,
      attempt: 1, role: "security-verifier-agent", profile, captureDigest: "b".repeat(64) },
    ...overrides,
  };
};

const fingerprintArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/);

describe("adjudication", () => {
  it("publishes a claim only on a critical vote from another profile (INV-S3)", () => {
    const claim = findings(["authz:1"]);
    const unverified = adjudicateCandidates({ findings: claim, verdicts: [], huntProfiles: ["focused-review"] });
    expect(unverified.confirmed).toHaveLength(0);
    expect(unverified.gaps).toEqual([{ kind: "unverified", fingerprint: "authz:1" }]);

    const sameProfile = adjudicateCandidates({
      findings: claim,
      verdicts: [verdict("authz:1", { profile: "focused-review" })],
      huntProfiles: ["focused-review"],
    });
    expect(sameProfile.confirmed).toHaveLength(0);
    expect(sameProfile.gaps).toEqual([{ kind: "same-profile", fingerprint: "authz:1", profile: "focused-review" }]);

    const verified = adjudicateCandidates({ findings: claim, verdicts: [verdict("authz:1")], huntProfiles: ["focused-review"] });
    expect(verified.confirmed.map((finding) => finding.fingerprint)).toEqual(["authz:1"]);
    expect(verified.gaps).toEqual([]);
  });

  it("never invents severity when it demotes (INV-S3b)", () => {
    const claim = findings(["authz:1"]);
    const demoted = adjudicateCandidates({
      findings: claim,
      verdicts: [verdict("authz:1", { vote: "advisory", reason: "the route is behind an admin guard", missingFact: "the guard's configuration in production" })],
      huntProfiles: ["focused-review"],
    });
    expect(demoted.confirmed).toHaveLength(0);
    expect(demoted.demoted).toHaveLength(1);
    expect(demoted.demoted[0]?.blockers).toEqual(["the guard's configuration in production"]);
    expect("severity" in (demoted.demoted[0] ?? {})).toBe(false);
  });

  it("rejects an advisory vote that names no missing fact", () => {
    const rejected = adjudicateCandidates({
      findings: findings(["authz:1"]),
      verdicts: [verdict("authz:1", { vote: "advisory", reason: "the predicate is added by a query interceptor" })],
      huntProfiles: ["focused-review"],
    });
    expect(rejected.rejected.map((finding) => finding.reason)).toEqual(["the predicate is added by a query interceptor"]);
    expect(rejected.demoted).toHaveLength(0);
  });

  it("keeps a claim when a critical vote splits the panel (INV-S3c)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), (advisories) => {
        const verdicts = [verdict("authz:1"), ...Array.from({ length: advisories }, () => verdict("authz:1", { vote: "advisory", reason: "unsure", missingFact: "one fact" }))];
        const adjudication = adjudicateCandidates({ findings: findings(["authz:1"]), verdicts, huntProfiles: ["focused-review"] });
        expect(adjudication.confirmed).toHaveLength(1);
        expect(adjudication.demoted).toHaveLength(0);
      }),
    );
  });

  it("never publishes an unverified claim, whatever the roster (INV-S3)", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fingerprintArb, { maxLength: 4 }),
        fc.array(fc.constantFrom("critical", "advisory") as fc.Arbitrary<"critical" | "advisory">, { maxLength: 4 }),
        (fingerprints, votes) => {
          const sorted = [...fingerprints].sort();
          const claims = findings(sorted);
          const verdicts = sorted.flatMap((fingerprint, index) =>
            votes[index] === undefined ? [] : [verdict(fingerprint, { vote: votes[index], missingFact: "one fact" })],
          );
          const adjudication = adjudicateCandidates({ findings: claims, verdicts, huntProfiles: ["focused-review"] });
          for (const published of adjudication.confirmed) {
            expect(verdicts.some((cast) => cast.fingerprint === published.fingerprint && cast.binding.profile !== "focused-review")).toBe(true);
          }
          expect(adjudication.gaps.map((gap) => gap.fingerprint)).toEqual(
            sorted.filter((_fingerprint, index) => votes[index] === undefined),
          );
        },
      ),
    );
  });

  it("refuses a claim when the ledger records no hunting profile (unattributed)", () => {
    const unattributed = adjudicateCandidates({ findings: findings(["authz:1"]), verdicts: [verdict("authz:1")], huntProfiles: [] });
    expect(unattributed.confirmed).toEqual([]);
    expect(unattributed.gaps).toEqual([{ kind: "unattributed", fingerprint: "authz:1" }]);
  });
});

const HUNTER = "security-hunter-agent";

/** One unit, assigned to `agentId` and — unless `settle` is false — settled
 *  covered by it: the ledger shape `adjudicateRun` derives its INV-S3 facts from. */
const ledgerOwnedBy = (agentId: string, settle = true): CoverageLedger => {
  const seeded = seedCoverageUnit({
    refs: { surface: "http:GET /export", boundary: "tenant", subsystem: "reports", attack_class: "idor" },
    starting_paths: ["src/export.ts"],
    ordinary_attack_class_block: null,
    selected_companion_blocks: [],
    excluded_blocks: [],
    prior: null,
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  const assigned = assignUnits([seeded.value], [{ coverageId: seeded.value.coverage_id, agentId }]);
  if (!assigned.ok) throw new Error(JSON.stringify(assigned.error));
  if (!settle) return assigned.value.ledger;
  const owner = assigned.value.assigned[0].ownerId;
  const result = recordUnitResult(assigned.value.ledger, {
    coverageId: seeded.value.coverage_id,
    agentId: owner,
    wave: 1,
    status: "covered",
    reviewedPaths: ["src/export.ts"],
    checks: [{ agent_id: owner, reviewed_paths: ["src/export.ts"], invariant: "reads are tenant-scoped", method: "source", result: "the predicate holds", artifact: null }],
  });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
};

describe("huntingProfiles", () => {
  it("derives the hunt profile from owners and archived attempts, through the owner grammar", () => {
    expect(huntingProfiles(ledgerOwnedBy(HUNTER))).toEqual({ ok: true, value: ["focused-review"] });
    const [unit] = ledgerOwnedBy(HUNTER);
    const reassigned = [{ ...unit, agent_id: `${HUNTER}--2`, wave: 2, attempts: [{
      wave: 1, status: "covered" as const, agent_id: HUNTER, reviewed_paths: unit.reviewed_paths,
      local_checks: unit.local_checks, result_fingerprints: [], unresolved: [], reassignment_reason: "critic: again",
    }] }];
    expect(huntingProfiles(reassigned)).toEqual({ ok: true, value: ["focused-review"] });
  });

  it("fails closed on an owner — live or archived — the catalog cannot place", () => {
    const [unit] = ledgerOwnedBy(HUNTER);
    expect(huntingProfiles([{ ...unit, agent_id: "hunter-a" }])).toEqual({ ok: false, error: { kind: "unresolvable-hunter", agentId: "hunter-a" } });
    const archived = [{ ...unit, agent_id: `${HUNTER}--2`, wave: 2, attempts: [{
      wave: 1, status: "covered" as const, agent_id: "ghost-hunter", reviewed_paths: unit.reviewed_paths,
      local_checks: unit.local_checks, result_fingerprints: [], unresolved: [], reassignment_reason: "critic: again",
    }] }];
    expect(huntingProfiles(archived)).toEqual({ ok: false, error: { kind: "unresolvable-hunter", agentId: "ghost-hunter" } });
  });

  it("is empty for a ledger that names no hunter", () => {
    const [unit] = ledgerOwnedBy(HUNTER);
    expect(huntingProfiles([{ ...unit, status: "planned", agent_id: null, reviewed_paths: [], local_checks: [] }])).toEqual({ ok: true, value: [] });
  });
});

describe("adjudicateRun", () => {
  it("names every reason a run may not publish, deriving hunt profile and settlement from the ledger", () => {
    const run = (ledger: CoverageLedger, verdicts: readonly VerificationVerdict[]) => {
      const decided = adjudicateRun({ ledger, findings: findings(["a:1"]), verdicts });
      if (!decided.ok) throw new Error(JSON.stringify(decided.error));
      return decided.value.blockers;
    };
    expect(run(ledgerOwnedBy(HUNTER), [])).toEqual(["confirmed claim a:1 has no verification verdict"]);
    expect(run(ledgerOwnedBy(HUNTER, false), [verdict("a:1")])).toEqual(["coverage ledger still has planned, in-progress or blocked units"]);
    expect(run(ledgerOwnedBy(HUNTER), [verdict("a:1", { profile: "focused-review" })])).toEqual([
      "confirmed claim a:1 was verified only on the hunt profile focused-review",
    ]);
    expect(run(ledgerOwnedBy(HUNTER), [verdict("a:1")])).toEqual([]);
  });

  it("refuses rather than adjudicates when an owner cannot be placed", () => {
    const [unit] = ledgerOwnedBy(HUNTER);
    const decided = adjudicateRun({ ledger: [{ ...unit, agent_id: "hunter-a" }], findings: findings(["a:1"]), verdicts: [verdict("a:1")] });
    expect(decided).toEqual({ ok: false, error: { kind: "unresolvable-hunter", agentId: "hunter-a" } });
  });
});

describe("parseVerificationVerdicts (ADR-0067 D3/D5)", () => {
  it("round-trips bound ballots, sorted by fingerprint, run, request and wave", () => {
    const ballots = [verdict("b:2"), verdict("a:1"), verdict("a:1", { vote: "advisory", missingFact: "one fact" })];
    const parsed = parseVerificationVerdicts(JSON.parse(JSON.stringify(ballots)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.map((ballot) => ballot.fingerprint)).toEqual(["a:1", "a:1", "b:2"]);
  });

  it("refuses a ballot without a well-formed binding — a parse refusal, not an unverified gap", () => {
    const { binding: _binding, ...unbound } = verdict("a:1");
    const refusal = (raw: unknown) => {
      const parsed = parseVerificationVerdicts([raw]);
      return parsed.ok ? [] : parsed.error.violations.map((violation) => `${violation.path}: ${violation.message}`);
    };
    expect(refusal(unbound)).toContain("verdicts[0].binding: expected the binding a verification run published");
    const bound = verdict("a:1");
    expect(refusal({ ...bound, binding: { ...bound.binding, role: "security-hunter-agent" } }))
      .toContain("verdicts[0].binding.role: expected security-verifier-agent");
    expect(refusal({ ...bound, binding: { ...bound.binding, program: "refutation-panel" } }))
      .toContain("verdicts[0].binding.program: expected security-verification");
    expect(refusal({ ...bound, binding: { ...bound.binding, profile: "standard" } }))
      .toContain("verdicts[0].binding.profile: expected a catalog profile");
    expect(refusal({ ...bound, binding: { ...bound.binding, captureDigest: "nope" } }))
      .toContain("verdicts[0].binding.captureDigest: expected a sha256 capture digest");
    // Self-reported identity is not a ballot field any more.
    expect(refusal({ ...bound, agent: "security-verifier-agent", profile: "refutation" }))
      .toEqual(["verdicts[0].agent: unknown field", "verdicts[0].profile: unknown field"]);
  });

  it("refuses one request casting two ballots on one fingerprint", () => {
    const ballot = verdict("a:1");
    const parsed = parseVerificationVerdicts([ballot, { ...ballot, vote: "advisory" }]);
    expect(parsed.ok).toBe(false);
  });
});
