/**
 * Grammar properties the review found unpinned. Each of these guards a rule the
 * rest of the program assumes, and each could previously be broken with the
 * suite green:
 *
 *   INV-S3d  a fingerprint is the identity of a finding, so the grammar is the
 *            only thing making it a stable key — `""`, `"a b"` and `" a"` are
 *            not fingerprints;
 *   INV-L5   a canonical coverage id is INJECTIVE over the reference tuple:
 *            `::` separates fields, so it can never appear inside one, and two
 *            different cells therefore cannot share an id;
 *   INV-S3e  a recorded severity never exceeds the demonstrated impact, over the
 *            whole 5×5 ladder (the differential oracle only pins `high`).
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  SECURITY_FINGERPRINT_PATTERN,
  canonicalCoverageId,
  coverageSemanticKey,
  encodeCanonicalRef,
  isSecurityFingerprint,
  parseCoverageRefs,
  type CoverageRefs,
} from "../../src/core/security-audit-contract";
import { parseSecurityFindings, SEVERITY_SCORES, type SeverityScore } from "../../src/core/security-findings";
import { parseVerificationVerdicts } from "../../src/core/security-adjudication";
import { assignUnits, recordUnitResult, seedCoverageUnit } from "../../src/core/security-coverage";
import { aConfirmedFinding, aNeedsValidationFinding, aSeed, aVerdict, HUNTER_AGENT, ok } from "./fixtures";

const rejectedFingerprints = ["", "-a", " a", "a b", "a\nb", "a\tz", "a b c", "🙂"];

describe("fingerprint grammar (INV-S3d)", () => {
  it("refuses every shape outside the grammar", () => {
    for (const fingerprint of rejectedFingerprints) {
      expect(isSecurityFingerprint(fingerprint), JSON.stringify(fingerprint)).toBe(false);
    }
    expect(SECURITY_FINGERPRINT_PATTERN.source).toContain("[A-Za-z0-9]");
  });

  it("refuses a finding, a ballot, and a ledger that carry a bad fingerprint", () => {
    // The ledger's place for a fingerprint is a candidate unit's
    // `result_fingerprints`: a settlement naming a bad one is refused, so the
    // coverage record can never point at a finding no grammar admits.
    const unit = ok(seedCoverageUnit(aSeed()));
    const inFlight = ok(assignUnits([unit], [{ coverageId: unit.coverage_id, agentId: HUNTER_AGENT }])).ledger;
    const settle = (fingerprint: string) => recordUnitResult(inFlight, {
      coverageId: unit.coverage_id, agentId: HUNTER_AGENT, wave: 1, status: "candidate", reviewedPaths: ["src/api/login.ts"],
      checks: [{ agent_id: HUNTER_AGENT, reviewed_paths: ["src/api/login.ts"], invariant: "the query binds its values", method: "source", result: "it interpolates", artifact: null }],
      fingerprints: [fingerprint],
    });
    expect(settle("api/login:sqli-email").ok).toBe(true);
    for (const fingerprint of rejectedFingerprints) {
      const finding = parseSecurityFindings([aConfirmedFinding({ fingerprint })]);
      expect(finding.ok, `finding ${JSON.stringify(fingerprint)}`).toBe(false);
      const ballot = parseVerificationVerdicts([aVerdict({ fingerprint })]);
      expect(ballot.ok, `ballot ${JSON.stringify(fingerprint)}`).toBe(false);
      expect(settle(fingerprint), `ledger ${JSON.stringify(fingerprint)}`).toMatchObject({
        ok: false,
        error: { kind: "settlement-invalid", violations: expect.arrayContaining([{ path: "$[0].result_fingerprints", message: "invalid fingerprint" }]) },
      });
    }
  });

  it("is a total predicate that agrees with the parsers, over arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), (raw) => {
        const accepted = parseSecurityFindings([aConfirmedFinding({ fingerprint: raw })]).ok;
        expect(accepted).toBe(isSecurityFingerprint(raw));
        if (accepted) expect(raw).toMatch(SECURITY_FINGERPRINT_PATTERN);
      }),
      { numRuns: 300 },
    );
  });
});

const refTupleArb: fc.Arbitrary<CoverageRefs> = fc.record({
  surface: fc.constantFrom("http-ingress", "a", "a::b", "a:b", "a%3A%3Ab", "ünïcode"),
  boundary: fc.constantFrom("api-edge", "b", "b::c", "b%3A%3Ac"),
  subsystem: fc.constantFrom("auth", "c", "c::d"),
  attack_class: fc.constantFrom("injection", "d"),
}).map((raw) => ok(parseCoverageRefs(raw)));

describe("canonical coverage id (INV-L5)", () => {
  it("is injective over the reference tuple", () => {
    fc.assert(
      fc.property(refTupleArb, refTupleArb, (left, right) => {
        const sameId = canonicalCoverageId(left) === canonicalCoverageId(right);
        const sameCell = coverageSemanticKey(left) === coverageSemanticKey(right);
        expect(sameId).toBe(sameCell);
      }),
      { numRuns: 300 },
    );
  });

  it("separates two tuples that differ only in where the separator falls", () => {
    // The exact collision the review found reachable: joining fields with `::`
    // is injective only because `:` is reserved, i.e. percent-encoded.
    const left = ok(parseCoverageRefs({ surface: "a", boundary: "b::c", subsystem: "s", attack_class: "x" }));
    const right = ok(parseCoverageRefs({ surface: "a::b", boundary: "c", subsystem: "s", attack_class: "x" }));
    expect(canonicalCoverageId(left)).not.toBe(canonicalCoverageId(right));
    expect(encodeCanonicalRef("b::c")).toBe("b%3A%3Ac");
    expect(encodeCanonicalRef("b::c")).not.toContain("::");
  });

  it("encodes every reserved byte, so no field can smuggle a separator", () => {
    fc.assert(
      fc.property(refTupleArb, (refs) => {
        for (const field of [refs.surface, refs.boundary, refs.subsystem, refs.attack_class]) {
          expect(encodeCanonicalRef(field)).not.toContain("::");
        }
      }),
    );
  });
});

describe("a parsed findings document is the parser's own value", () => {
  it("never aliases the caller's input, and cannot be mutated through it", () => {
    const confirmed: Record<string, unknown> = structuredClone(aConfirmedFinding());
    const raw = [confirmed, aNeedsValidationFinding({ fingerprint: "b/lead" })];
    const parsed = ok(parseSecurityFindings(raw));
    expect(parsed).not.toBe(raw);
    expect(parsed).toEqual(raw);
    // A later edit of the document the caller still holds must not rewrite the
    // findings a decision was already made on.
    confirmed.title = "rewritten after parsing";
    const trace = confirmed.trace;
    if (Array.isArray(trace)) trace.splice(0);
    expect(parsed[0]?.title).toBe("SQL injection through the login `email` field");
    expect(parsed[0]?.trace).toHaveLength(2);
  });

  it("is deeply frozen", () => {
    const [finding] = ok(parseSecurityFindings([aConfirmedFinding()]));
    expect(Object.isFrozen(finding)).toBe(true);
    expect(Object.isFrozen(finding?.trace)).toBe(true);
    expect(Object.isFrozen(finding?.trace[0])).toBe(true);
    expect(finding?.verdict === "confirmed" && Object.isFrozen(finding.severity.impact)).toBe(true);
  });
});

const rank: Readonly<Record<SeverityScore, number>> = {
  informational: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

describe("severity ladder (INV-S3e)", () => {
  it("accepts an overall severity iff it does not exceed the demonstrated impact", () => {
    for (const impact of SEVERITY_SCORES) {
      for (const overall of SEVERITY_SCORES) {
        const parsed = parseSecurityFindings([aConfirmedFinding({
          severity: {
            likelihood: { score: "medium", reason: "a request is enough" },
            impact: { score: impact, reason: "demonstrated in the sandbox" },
            overall_severity: overall,
          },
        })]);
        expect(parsed.ok, `impact ${impact} / overall ${overall}`).toBe(rank[overall] <= rank[impact]);
      }
    }
  });

  it("is monotone: raising the impact never turns an accepted pair into a refused one", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<SeverityScore>(...SEVERITY_SCORES),
        fc.constantFrom<SeverityScore>(...SEVERITY_SCORES),
        (impact, overall) => {
          const acceptedAt = (score: SeverityScore): boolean =>
            parseSecurityFindings([aConfirmedFinding({
              severity: {
                likelihood: { score: "medium", reason: "a request is enough" },
                impact: { score, reason: "demonstrated in the sandbox" },
                overall_severity: overall,
              },
            })]).ok;
          if (!acceptedAt(impact)) return;
          for (const higher of SEVERITY_SCORES.filter((score) => rank[score] >= rank[impact])) {
            expect(acceptedAt(higher)).toBe(true);
          }
        },
      ),
    );
  });
});
