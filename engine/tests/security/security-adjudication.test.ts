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
 *
 * Every case crosses the one seam production uses — `adjudicateRun`, which
 * derives the hunting profiles from the ledger — with ballots that went
 * through the same parser `verdicts.json` does, built by the shared fixtures.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseSecurityFindings } from "../../src/core/security-findings";
import {
  adjudicateRun,
  huntingProfiles,
  parseVerificationVerdicts,
  type Adjudication,
  type VerificationVerdict,
} from "../../src/core/security-adjudication";
import { assignUnits, recordUnitResult, seedCoverageUnit, type CoverageLedger } from "../../src/core/security-coverage";
import { AGENT_POLICIES, LOOM_AGENT_NAMESPACE, catalogProfileOfAgent, resolveAgentPolicy } from "../../src/core/model-profiles";
import { aConfirmedFinding, aRefs, aSeed, aVerdict, HUNTER_AGENT, ok, type VerdictWire } from "./fixtures";

const findings = (fingerprints: readonly string[]) =>
  ok(parseSecurityFindings([...fingerprints].sort().map((fingerprint) => aConfirmedFinding({ fingerprint, title: `claim ${fingerprint}` }))));

let issued = 0;

/** A bound ballot from a fresh verifier request (each call is a distinct
 *  spawn), as `verdicts.json` holds it. */
const wire = (fingerprint: string, overrides: Parameters<typeof aVerdict>[0] = {}): VerdictWire =>
  aVerdict({ fingerprint, wave: 1, slotId: `security-verification-slot:${String(++issued).padStart(32, "0")}`, ...overrides });

/** Ballots as adjudication receives them: through the ballot parser. */
const ballots = (...wires: readonly VerdictWire[]): readonly VerificationVerdict[] => ok(parseVerificationVerdicts(wires));

/** One unit, assigned to `agentId` and — unless `settle` is false — settled
 *  covered by it: the ledger shape `adjudicateRun` derives its INV-S3 facts from. */
const ledgerOwnedBy = (agentId: string, settle = true): CoverageLedger => {
  const seeded = ok(seedCoverageUnit(aSeed({
    refs: aRefs({ surface: "http:GET /export", boundary: "tenant", subsystem: "reports", attack_class: "idor" }),
    starting_paths: ["src/export.ts"],
    ordinary_attack_class_block: null,
    selected_companion_blocks: [],
  })));
  const assigned = ok(assignUnits([seeded], [{ coverageId: seeded.coverage_id, agentId }]));
  if (!settle) return assigned.ledger;
  const owner = assigned.assigned[0]!.ownerId;
  return ok(recordUnitResult(assigned.ledger, {
    coverageId: seeded.coverage_id,
    agentId: owner,
    wave: 1,
    status: "covered",
    reviewedPaths: ["src/export.ts"],
    checks: [{ agent_id: owner, reviewed_paths: ["src/export.ts"], invariant: "reads are tenant-scoped", method: "source", result: "the predicate holds", artifact: null }],
  }));
};

/** The hunter sits on `focused-review`; the critic shares the verifier's
 *  `refutation` profile, so a unit it hunted makes every ballot same-profile. */
const HUNTED = ledgerOwnedBy(HUNTER_AGENT);
const HUNTED_ON_THE_VERIFIER_PROFILE = ledgerOwnedBy("security-critic-agent");

const adjudicate = (ledger: CoverageLedger, claims: readonly string[], verdicts: readonly VerificationVerdict[]): Adjudication =>
  ok(adjudicateRun({ ledger, findings: findings(claims), verdicts })).adjudication;

describe("adjudication", () => {
  it("publishes a claim only on a critical vote from another profile (INV-S3)", () => {
    const unverified = adjudicate(HUNTED, ["authz:1"], []);
    expect(unverified.confirmed).toHaveLength(0);
    expect(unverified.gaps).toEqual([{ kind: "unverified", fingerprint: "authz:1" }]);

    const sameProfile = adjudicate(HUNTED_ON_THE_VERIFIER_PROFILE, ["authz:1"], ballots(wire("authz:1")));
    expect(sameProfile.confirmed).toHaveLength(0);
    expect(sameProfile.gaps).toEqual([{ kind: "same-profile", fingerprint: "authz:1", profile: "refutation" }]);

    const verified = adjudicate(HUNTED, ["authz:1"], ballots(wire("authz:1")));
    expect(verified.confirmed.map((finding) => finding.fingerprint)).toEqual(["authz:1"]);
    expect(verified.gaps).toEqual([]);
  });

  it("never invents severity when it demotes (INV-S3b)", () => {
    const demoted = adjudicate(HUNTED, ["authz:1"], ballots(
      wire("authz:1", { vote: "advisory", reason: "the route is behind an admin guard", missingFact: "the guard's configuration in production" }),
    ));
    expect(demoted.confirmed).toHaveLength(0);
    expect(demoted.demoted).toHaveLength(1);
    expect(demoted.demoted[0]?.blockers).toEqual(["the guard's configuration in production"]);
    expect("severity" in (demoted.demoted[0] ?? {})).toBe(false);
  });

  it("rejects an advisory vote that names no missing fact", () => {
    const rejected = adjudicate(HUNTED, ["authz:1"], ballots(wire("authz:1", { vote: "advisory", reason: "the predicate is added by a query interceptor" })));
    expect(rejected.rejected.map((finding) => finding.reason)).toEqual(["the predicate is added by a query interceptor"]);
    expect(rejected.demoted).toHaveLength(0);
  });

  it("keeps a claim when a critical vote splits the panel (INV-S3c)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), (advisories) => {
        const verdicts = ballots(wire("authz:1"), ...Array.from({ length: advisories }, () =>
          wire("authz:1", { vote: "advisory", reason: "unsure", missingFact: "one fact" })));
        const adjudication = adjudicate(HUNTED, ["authz:1"], verdicts);
        expect(adjudication.confirmed).toHaveLength(1);
        expect(adjudication.demoted).toHaveLength(0);
      }),
    );
  });

  it("never publishes an unverified claim, whatever the roster (INV-S3)", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/), { maxLength: 4 }),
        fc.array(fc.constantFrom("critical", "advisory") as fc.Arbitrary<"critical" | "advisory">, { maxLength: 4 }),
        (fingerprints, votes) => {
          const sorted = [...fingerprints].sort();
          const verdicts = ballots(...sorted.flatMap((fingerprint, index) => {
            const vote = votes[index];
            return vote === undefined ? [] : [wire(fingerprint, { vote, missingFact: "one fact" })];
          }));
          const adjudication = adjudicate(HUNTED, sorted, verdicts);
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
    const [unit] = HUNTED;
    const unhunted: CoverageLedger = [{ ...unit!, status: "planned", agent_id: null, reviewed_paths: [], local_checks: [] }];
    const unattributed = adjudicate(unhunted, ["authz:1"], ballots(wire("authz:1")));
    expect(unattributed.confirmed).toEqual([]);
    expect(unattributed.gaps).toEqual([{ kind: "unattributed", fingerprint: "authz:1" }]);
  });
});

describe("huntingProfiles", () => {
  it("derives the hunt profile from owners and archived attempts, through the owner grammar", () => {
    expect(huntingProfiles(HUNTED)).toEqual({ ok: true, value: ["focused-review"] });
    const [unit] = HUNTED;
    const reassigned = [{ ...unit!, agent_id: `${HUNTER_AGENT}--2`, wave: 2, attempts: [{
      wave: 1, status: "covered" as const, agent_id: HUNTER_AGENT, reviewed_paths: unit!.reviewed_paths,
      local_checks: unit!.local_checks, result_fingerprints: [], unresolved: [], reassignment_reason: "critic: again",
    }] }];
    expect(huntingProfiles(reassigned)).toEqual({ ok: true, value: ["focused-review"] });
  });

  it("fails closed on an owner — live or archived — the catalog cannot place", () => {
    const [unit] = HUNTED;
    expect(huntingProfiles([{ ...unit!, agent_id: "hunter-a" }])).toEqual({ ok: false, error: { kind: "unresolvable-hunter", agentId: "hunter-a" } });
    const archived = [{ ...unit!, agent_id: `${HUNTER_AGENT}--2`, wave: 2, attempts: [{
      wave: 1, status: "covered" as const, agent_id: "ghost-hunter", reviewed_paths: unit!.reviewed_paths,
      local_checks: unit!.local_checks, result_fingerprints: [], unresolved: [], reassignment_reason: "critic: again",
    }] }];
    expect(huntingProfiles(archived)).toEqual({ ok: false, error: { kind: "unresolvable-hunter", agentId: "ghost-hunter" } });
  });

  it("is empty for a ledger that names no hunter", () => {
    const [unit] = HUNTED;
    expect(huntingProfiles([{ ...unit!, status: "planned", agent_id: null, reviewed_paths: [], local_checks: [] }])).toEqual({ ok: true, value: [] });
  });
});

describe("adjudicateRun", () => {
  it("names every reason a run may not publish, deriving hunt profile and settlement from the ledger", () => {
    const blockers = (ledger: CoverageLedger, verdicts: readonly VerificationVerdict[]) =>
      ok(adjudicateRun({ ledger, findings: findings(["a:1"]), verdicts })).blockers;
    expect(blockers(HUNTED, [])).toEqual(["confirmed claim a:1 has no verification verdict"]);
    expect(blockers(ledgerOwnedBy(HUNTER_AGENT, false), ballots(wire("a:1")))).toEqual(["coverage ledger still has planned, in-progress or blocked units"]);
    expect(blockers(HUNTED_ON_THE_VERIFIER_PROFILE, ballots(wire("a:1")))).toEqual([
      "confirmed claim a:1 was verified only on the hunt profile refutation",
    ]);
    expect(blockers(HUNTED, ballots(wire("a:1")))).toEqual([]);
  });

  it("refuses rather than adjudicates when an owner cannot be placed", () => {
    const [unit] = HUNTED;
    const decided = adjudicateRun({ ledger: [{ ...unit!, agent_id: "hunter-a" }], findings: findings(["a:1"]), verdicts: ballots(wire("a:1")) });
    expect(decided).toEqual({ ok: false, error: { kind: "unresolvable-hunter", agentId: "hunter-a" } });
  });
});

describe("parseVerificationVerdicts (ADR-0067 D3/D5)", () => {
  const refusal = (raw: unknown): readonly string[] => {
    const parsed = parseVerificationVerdicts([raw]);
    return parsed.ok ? [] : parsed.error.violations.map((violation) => `${violation.path}: ${violation.message}`);
  };

  it("round-trips bound ballots, sorted by fingerprint, run, request and wave", () => {
    const parsed = ballots(wire("b:2"), wire("a:1"), wire("a:1", { vote: "advisory", missingFact: "one fact" }));
    expect(parsed.map((ballot) => ballot.fingerprint)).toEqual(["a:1", "a:1", "b:2"]);
    expect(ok(parseVerificationVerdicts(JSON.parse(JSON.stringify(parsed))))).toEqual(parsed);
  });

  it("refuses a ballot without a well-formed binding — a parse refusal, not an unverified gap", () => {
    const { binding: _binding, ...unbound } = wire("a:1");
    expect(refusal(unbound)).toContain("verdicts[0].binding: expected the binding a verification run published");
    const bound = wire("a:1");
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

  it("refuses a binding whose profile is not the one the catalog gives the verifier role", () => {
    // A catalog profile, but the hunter's: a verifier spawn never ran under it,
    // so a binding naming it is a tampered `verdicts.json`, refused at parse.
    expect(refusal(wire("a:1", { profile: "focused-review" })))
      .toEqual(["verdicts[0].binding.profile: profile focused-review is not refutation, the profile the catalog assigns security-verifier-agent"]);
  });

  it("refuses a blank missing fact — `null` is how a vote says it names none", () => {
    // One rule, in the vote grammar: a blank string is neither "no fact" nor a
    // fact, so adjudication never has to re-check it.
    for (const blank of ["", "  ", "​"]) {
      expect(refusal(wire("a:1", { vote: "advisory", missingFact: blank })))
        .toEqual(["verdicts[0].missingFact: expected null or visible prose"]);
    }
  });

  it("refuses one request casting two ballots on one fingerprint", () => {
    const ballot = wire("a:1");
    expect(parseVerificationVerdicts([ballot, { ...ballot, vote: "advisory" }]).ok).toBe(false);
  });
});

describe("catalogProfileOfAgent: the profile the independence rule compares", () => {
  it("places the security agents on the profiles that make same-profile detection meaningful", () => {
    expect(catalogProfileOfAgent("security-hunter-agent")).toBe("focused-review");
    expect(catalogProfileOfAgent("security-verifier-agent")).toBe("refutation");
    expect(catalogProfileOfAgent("security-critic-agent")).toBe("refutation");
  });

  it("reads a namespaced id and a bare one alike, and answers null for anything the catalog does not hold", () => {
    expect(catalogProfileOfAgent(`${LOOM_AGENT_NAMESPACE}:security-hunter-agent`)).toBe("focused-review");
    for (const unknown of ["hunter-a", "other:security-hunter-agent", "", "security-hunter-agent--2", 7, null, undefined, {}]) {
      expect(catalogProfileOfAgent(unknown), JSON.stringify(unknown)).toBeNull();
    }
  });

  it("is a projection of the one catalog lookup, for every catalog agent under either spelling", () => {
    for (const { agent, profile } of AGENT_POLICIES) {
      expect(catalogProfileOfAgent(agent)).toBe(profile);
      expect(catalogProfileOfAgent(`${LOOM_AGENT_NAMESPACE}:${agent}`)).toBe(profile);
      const resolved = resolveAgentPolicy(agent);
      expect(resolved.ok ? resolved.value.profile : null).toBe(profile);
    }
  });
});
