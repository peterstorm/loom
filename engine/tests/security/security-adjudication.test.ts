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
  publicationBlockers,
  type VerificationVerdict,
} from "../../src/core/security-adjudication";

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

const verdict = (fingerprint: string, overrides: Partial<VerificationVerdict> = {}): VerificationVerdict => ({
  schemaVersion: 1,
  kind: "security-verdict",
  fingerprint,
  vote: "critical",
  reason: "the trace holds in the pinned revision",
  missingFact: null,
  agent: "security-verifier-agent",
  profile: "refutation",
  wave: 1,
  ...overrides,
});

const fingerprintArb = fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/);

describe("adjudication", () => {
  it("publishes a claim only on a critical vote from another profile (INV-S3)", () => {
    const claim = findings(["authz:1"]);
    const unverified = adjudicateCandidates({ findings: claim, verdicts: [], huntProfile: "focused-review" });
    expect(unverified.confirmed).toHaveLength(0);
    expect(unverified.gaps).toEqual([{ kind: "unverified", fingerprint: "authz:1" }]);

    const sameProfile = adjudicateCandidates({
      findings: claim,
      verdicts: [verdict("authz:1", { profile: "focused-review" })],
      huntProfile: "focused-review",
    });
    expect(sameProfile.confirmed).toHaveLength(0);
    expect(sameProfile.gaps).toEqual([{ kind: "same-profile", fingerprint: "authz:1", profile: "focused-review" }]);

    const verified = adjudicateCandidates({ findings: claim, verdicts: [verdict("authz:1")], huntProfile: "focused-review" });
    expect(verified.confirmed.map((finding) => finding.fingerprint)).toEqual(["authz:1"]);
    expect(verified.gaps).toEqual([]);
  });

  it("never invents severity when it demotes (INV-S3b)", () => {
    const claim = findings(["authz:1"]);
    const demoted = adjudicateCandidates({
      findings: claim,
      verdicts: [verdict("authz:1", { vote: "advisory", reason: "the route is behind an admin guard", missingFact: "the guard's configuration in production" })],
      huntProfile: "focused-review",
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
      huntProfile: "focused-review",
    });
    expect(rejected.rejected.map((finding) => finding.reason)).toEqual(["the predicate is added by a query interceptor"]);
    expect(rejected.demoted).toHaveLength(0);
  });

  it("keeps a claim when a critical vote splits the panel (INV-S3c)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), (advisories) => {
        const verdicts = [verdict("authz:1"), ...Array.from({ length: advisories }, () => verdict("authz:1", { vote: "advisory", reason: "unsure", missingFact: "one fact" }))];
        const adjudication = adjudicateCandidates({ findings: findings(["authz:1"]), verdicts, huntProfile: "focused-review" });
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
          const adjudication = adjudicateCandidates({ findings: claims, verdicts, huntProfile: "focused-review" });
          for (const published of adjudication.confirmed) {
            expect(verdicts.some((cast) => cast.fingerprint === published.fingerprint && cast.profile !== "focused-review")).toBe(true);
          }
          expect(adjudication.gaps.map((gap) => gap.fingerprint)).toEqual(
            sorted.filter((_fingerprint, index) => votes[index] === undefined),
          );
        },
      ),
    );
  });

  it("names every reason a run may not publish", () => {
    expect(publicationBlockers({ findings: findings(["a:1"]), verdicts: [], huntProfile: "focused-review", ledgerSettled: true })).toEqual([
      "confirmed claim a:1 has no verification verdict",
    ]);
    expect(publicationBlockers({ findings: findings(["a:1"]), verdicts: [verdict("a:1")], huntProfile: "focused-review", ledgerSettled: false })).toEqual([
      "coverage ledger still has planned, in-progress or blocked units",
    ]);
    expect(publicationBlockers({ findings: findings(["a:1"]), verdicts: [verdict("a:1")], huntProfile: "focused-review", ledgerSettled: true })).toEqual([]);
  });
});
