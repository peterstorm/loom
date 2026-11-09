/**
 * The functional core of ADR-0067's security-verification program.
 *
 *   INV-V1  no verdict outside its brief is ever admitted — nor a brief with a
 *           fingerprint missing or voted twice;
 *   INV-V2  every admitted ballot's profile (and role, program, request, slot,
 *           attempt) is its MINTED request's, whatever the payload says;
 *   INV-V3  brief derivation is deterministic and covers every eligible
 *           confirmed candidate exactly once, in briefs of at most
 *           MAX_BRIEF_FINGERPRINTS;
 *   and the import rules: a result is accepted only for the audit, ledger and
 *   findings it was issued against, exactly once.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mintAgentRosterSlot, parseArtifactDigest, parseContextDigest } from "../../src/core/orchestration-contract";
import { parseSecurityFindings, type SecurityFinding } from "../../src/core/security-findings";
import { parseVerificationVerdicts, type VerificationVerdict } from "../../src/core/security-adjudication";
import {
  MAX_BRIEF_FINGERPRINTS,
  admitVerificationResult,
  authenticateAudit,
  bindBallots,
  buildVerificationResult,
  decideVerificationSlot,
  deriveVerificationBriefs,
  eligibleFingerprints,
  foldVerificationProgress,
  importVerificationResult,
  parseAuditReference,
  parseRegisteredSecurityVerificationProgram,
  parseSecurityVerificationStart,
  parseVerificationResult,
  planVerificationStart,
  recordedVerifierSlot,
  registerSecurityVerification,
  serializeVerificationResult,
  verificationRunName,
  verificationSlotId,
  verifierSlotIdentities,
  MAX_VERIFICATION_GENERATIONS,
  admitCachedBallots,
  renderVerificationStart,
  type AuditReference,
  type GenerationState,
  type VerificationRunProof,
  type SecurityVerificationStart,
  verificationStartOf,
  type VerificationBrief,
} from "../../src/core/security-verification";
import { aConfirmedFinding, aNeedsValidationFinding, aVerdict, ok } from "./fixtures";
import {
  ballotsAttested,
  captureAttestationEntryName,
  captureAttestationOf,
  parseCaptureAttestation,
  renderCaptureAttestation,
  type AttestationLookup,
  mintCaptureAttestation,
  type CaptureAttestationFields,
} from "../../src/core/capture-attestation";
import { CAPTURE_SCHEMA_VERSION, type CaptureReceipt } from "../../src/core/harness-capture";

const AUDIT_FIELDS = {
  locator: "/audits/run-1",
  runId: "run-1",
  ledgerDigest: "1".repeat(64),
  findingsDigest: "2".repeat(64),
} as const;

/** An audit reference minted through its one constructor, with the named fields changed. */
const auditOf = (overrides: Partial<Record<keyof typeof AUDIT_FIELDS, string>> = {}): AuditReference =>
  ok(parseAuditReference({ ...AUDIT_FIELDS, ...overrides }));

const AUDIT: AuditReference = auditOf();

const issueOf = (overrides: Partial<Pick<SecurityVerificationStart, "audit" | "wave" | "generation">> = {}): SecurityVerificationStart =>
  ok(verificationStartOf(overrides.audit ?? AUDIT, overrides.wave ?? 1, overrides.generation ?? 1));

const fingerprintArb = fc.stringMatching(/^[a-z]{1,6}\/[a-z]{1,6}:[a-z0-9-]{1,8}$/);

/** Confirmed records for `fingerprints`, plus leads that must never be briefed. */
const findingsOf = (confirmed: readonly string[], leads: readonly string[] = []): readonly SecurityFinding[] =>
  ok(parseSecurityFindings([
    ...confirmed.map((fingerprint, index) => aConfirmedFinding({ fingerprint, root_cause: `root cause ${index}` })),
    ...leads.map((fingerprint) => aNeedsValidationFinding({ fingerprint })),
  ].sort((left, right) => String(left.fingerprint).localeCompare(String(right.fingerprint)))));

const ballotOn = (fingerprint: string): VerificationVerdict =>
  ok(parseVerificationVerdicts([aVerdict({ fingerprint })]))[0]!;

const briefOf = (fingerprints: readonly string[]): VerificationBrief =>
  deriveVerificationBriefs({ issue: issueOf(), findings: findingsOf(fingerprints), verdicts: [] })[0]!;

const wire = (votes: readonly Record<string, unknown>[]): string =>
  JSON.stringify({ schemaVersion: 1, kind: "security-verification-result", verdicts: votes });

const voteOn = (fingerprint: string, overrides: Record<string, unknown> = {}) =>
  ({ fingerprint, vote: "critical", reason: "The trace holds on the pinned revision.", missingFact: null, ...overrides });

/** A brief's two requests, minted by the catalog exactly as the program mints them. */
const mintedSlot = (brief: VerificationBrief, runId = "run.verify-w1-000000000000") => {
  const [first, retry] = verifierSlotIdentities(runId, brief, ["c".repeat(64), "d".repeat(64)]);
  return ok(mintAgentRosterSlot(first, retry));
};

describe("brief derivation (INV-V3)", () => {
  it("covers every eligible confirmed candidate exactly once, deterministically, in bounded briefs", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fingerprintArb, { maxLength: 14 }),
      fc.uniqueArray(fingerprintArb, { maxLength: 3 }),
      fc.array(fc.nat(), { maxLength: 6 }),
      (fingerprints, leads, balloted) => {
        const confirmed = fingerprints.filter((fingerprint) => !leads.includes(fingerprint));
        const findings = findingsOf(confirmed, leads);
        const verdicts = balloted.flatMap((index) => confirmed.length === 0 ? [] : [ballotOn(confirmed[index % confirmed.length]!)]);
        const briefs = deriveVerificationBriefs({ issue: issueOf({ wave: 2 }), findings, verdicts });
        const covered = briefs.flatMap((brief) => brief.fingerprints);
        const ballotted = new Set(verdicts.map((verdict) => verdict.fingerprint));
        const eligible = confirmed.filter((fingerprint) => !ballotted.has(fingerprint)).sort();
        expect([...covered].sort()).toEqual(eligible);
        expect(new Set(covered).size).toBe(covered.length);
        for (const brief of briefs) expect(brief.fingerprints.length).toBeLessThanOrEqual(MAX_BRIEF_FINGERPRINTS);
        expect(eligibleFingerprints(findings, verdicts)).toEqual(eligible);
        // Deterministic: the same audit in any record order derives the same briefs and run name.
        const shuffled = deriveVerificationBriefs({ issue: issueOf({ wave: 2 }), findings: [...findings].reverse(), verdicts: [...verdicts].reverse() });
        expect(shuffled).toEqual(briefs);
        if (briefs.length > 0) expect(verificationRunName(issueOf({ wave: 2 }), shuffled)).toBe(verificationRunName(issueOf({ wave: 2 }), briefs));
      },
    ));
  });

  it("binds a slot to the audit run, wave and fingerprints", () => {
    const brief = briefOf(["a/b:one"]);
    const otherWave = deriveVerificationBriefs({ issue: issueOf({ wave: 2 }), findings: findingsOf(["a/b:one"]), verdicts: [] })[0]!;
    const otherRun = deriveVerificationBriefs({ issue: issueOf({ audit: auditOf({ runId: "run-2" }) }), findings: findingsOf(["a/b:one"]), verdicts: [] })[0]!;
    expect(brief.slotId).toMatch(/^security-verification-slot:[0-9a-f]{32}$/);
    expect(new Set([brief.slotId, otherWave.slotId, otherRun.slotId]).size).toBe(3);
  });
});

describe("per-brief admission (INV-V1)", () => {
  it("admits no verdict outside its brief, and no brief with a fingerprint missing or voted twice", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fingerprintArb, { minLength: 1, maxLength: MAX_BRIEF_FINGERPRINTS }),
      fc.array(fingerprintArb, { maxLength: 4 }),
      fc.array(fc.nat(), { maxLength: 8 }),
      (assigned, strangers, picks) => {
        const brief = briefOf(assigned);
        const pool = [...brief.fingerprints, ...strangers];
        const voted = picks.map((pick) => pool[pick % pool.length]!);
        const admitted = admitVerificationResult(brief, wire(voted.map((fingerprint) => voteOn(fingerprint))));
        if (!admitted.ok) return;
        expect(admitted.value.every((vote) => brief.fingerprints.includes(vote.fingerprint))).toBe(true);
        expect(admitted.value.map((vote) => vote.fingerprint)).toEqual([...brief.fingerprints]);
      },
    ));
  });

  it("names why it refuses, so the retry can be told", () => {
    const brief = briefOf(["a/b:one", "a/b:two"]);
    expect(admitVerificationResult(brief, wire([voteOn("a/b:one"), voteOn("a/b:two")])).ok).toBe(true);
    expect(admitVerificationResult(brief, wire([voteOn("a/b:one"), voteOn("x/y:three")]))).toEqual({ ok: false,
      error: "verdict for x/y:three, which is not in this brief (a/b:one, a/b:two)" });
    expect(admitVerificationResult(brief, wire([voteOn("a/b:one"), voteOn("a/b:one")]))).toEqual({ ok: false, error: "duplicate verdict for a/b:one" });
    expect(admitVerificationResult(brief, wire([voteOn("a/b:one")]))).toEqual({ ok: false, error: "no verdict for a/b:two" });
    expect(admitVerificationResult(brief, "not json")).toEqual({ ok: false, error: "the result is not one JSON object" });
    // Identity is not the verifier's to report (D2).
    const forged = admitVerificationResult(brief, wire([voteOn("a/b:one", { agent: "security-verifier-agent", profile: "refutation", wave: 1 }), voteOn("a/b:two")]));
    expect(forged.ok ? "" : forged.error).toContain("$.verdicts[0].agent: unknown field");
    expect(admitVerificationResult(brief, JSON.stringify({ schemaVersion: 1, kind: "security-verdict", verdicts: [] })).ok).toBe(false);
  });
});

describe("ballot binding (INV-V2)", () => {
  it("takes every binding field from the minted request, never from the payload", () => {
    fc.assert(fc.property(
      fc.uniqueArray(fingerprintArb, { minLength: 1, maxLength: MAX_BRIEF_FINGERPRINTS }),
      fc.constantFrom(1 as const, 2 as const),
      fc.stringMatching(/^[0-9a-f]{64}$/),
      (assigned, attempt, digest) => {
        const brief = briefOf(assigned);
        const slot = mintedSlot(brief);
        const authority = slot.attempts[attempt - 1];
        const votes = ok(admitVerificationResult(brief, wire(brief.fingerprints.map((fingerprint) => voteOn(fingerprint)))));
        const ballots = ok(bindBallots({ votes, authority, captureDigest: digest, wave: 3 }));
        for (const ballot of ballots) {
          expect(ballot.binding).toEqual({
            program: "security-verification", runId: authority.runId, requestId: authority.requestId, slotId: authority.slotId,
            attempt, role: "security-verifier-agent", profile: authority.modelProfile, captureDigest: digest,
          });
          expect(ballot.binding.profile).toBe("refutation");
          expect(ballot.wave).toBe(3);
        }
        expect(ok(parseVerificationVerdicts(ballots))).toHaveLength(ballots.length);
      },
    ));
  });

  it("binds nothing to a request that is not a security verifier request", () => {
    const brief = briefOf(["a/b:one"]);
    const authority = mintedSlot(brief).attempts[0];
    const votes = ok(admitVerificationResult(brief, wire([voteOn("a/b:one")])));
    expect(bindBallots({ votes, authority: { ...authority, program: "refutation-panel" }, captureDigest: "e".repeat(64), wave: 1 }).ok).toBe(false);
    expect(bindBallots({ votes, authority, captureDigest: "nope", wave: 1 }).ok).toBe(false);
    // A verifier request recorded under a profile the catalog never gives the
    // verifier role binds nothing: the ballot parser would refuse it anyway.
    const offProfile = bindBallots({ votes, authority: { ...authority, modelProfile: "focused-review" }, captureDigest: "e".repeat(64), wave: 1 });
    expect(offProfile.ok ? "" : offProfile.error).toContain("profile focused-review is not refutation");
  });

  it("reads a recorded slot back as history, refusing one that differs from the brief's request", () => {
    const brief = briefOf(["a/b:one"]);
    const identities = verifierSlotIdentities("run.verify-w1-000000000000", brief, ["c".repeat(64), "d".repeat(64)]);
    const slot = mintedSlot(brief);
    expect(ok(recordedVerifierSlot(identities, slot.attempts[0])).attempts).toEqual(slot.attempts);
    expect(recordedVerifierSlot(identities, { ...slot.attempts[0], contextDigest: ok(parseContextDigest("f".repeat(64))) }).ok).toBe(false);
  });
});

describe("slot decisions", () => {
  const brief = briefOf(["a/b:one"]);
  const good = { kind: "captured" as const, text: wire([voteOn("a/b:one")]), digest: "a".repeat(64) };
  const bad = { kind: "captured" as const, text: "{}", digest: "b".repeat(64) };
  const absent = { kind: "absent" as const };
  const rejected = { kind: "capture-rejected" as const, diagnostic: "transcript-json" };

  it("awaits attempt 1, admits it, retries once when it fails, and blocks when the retry fails", () => {
    expect(decideVerificationSlot(brief, absent, absent)).toEqual({ kind: "awaiting", attempt: 1, diagnostic: null });
    expect(decideVerificationSlot(brief, good, absent)).toMatchObject({ kind: "admitted", attempt: 1 });
    expect(decideVerificationSlot(brief, bad, absent)).toMatchObject({ kind: "awaiting", attempt: 2 });
    expect(decideVerificationSlot(brief, rejected, absent)).toEqual({ kind: "awaiting", attempt: 2, diagnostic: "capture rejected: transcript-json" });
    expect(decideVerificationSlot(brief, bad, good)).toMatchObject({ kind: "admitted", attempt: 2, digest: "a".repeat(64) });
    expect(decideVerificationSlot(brief, bad, bad)).toMatchObject({ kind: "blocked" });
    expect(decideVerificationSlot(brief, bad, rejected)).toMatchObject({ kind: "blocked" });
  });

  it("lets a blocked brief block the run, and completes only when every brief is admitted", () => {
    const admitted = decideVerificationSlot(brief, good, absent);
    const awaiting = decideVerificationSlot(brief, absent, absent);
    const blocked = decideVerificationSlot(brief, bad, bad);
    expect(foldVerificationProgress([{ slot: 1, decision: admitted }, { slot: 2, decision: awaiting }]).kind).toBe("awaiting");
    expect(foldVerificationProgress([{ slot: 1, decision: blocked }, { slot: 2, decision: awaiting }]).kind).toBe("blocked");
    expect(foldVerificationProgress([{ slot: 1, decision: admitted }]).kind).toBe("complete");
  });
});

/** A registration and the result it publishes, for the import rules. */
const nothingOnDisk = () => "absent" as const;
const planOf = (fingerprints: readonly string[], verdicts: readonly VerificationVerdict[] = [], audit: AuditReference = AUDIT,
  observe: (run: string) => GenerationState = nothingOnDisk) =>
  ok(planVerificationStart({ audit, wave: 1, findings: findingsOf(fingerprints), verdicts, observe }));

const publishedRun = (fingerprints: readonly string[] = ["a/b:one"], digest = "a".repeat(64)) => {
  const plan = planOf(fingerprints)!;
  const registration = ok(registerSecurityVerification(plan.run, plan.input, plan.briefs));
  const ballots = plan.briefs.flatMap((brief) => {
    const authority = mintedSlot(brief, registration.runId).attempts[0];
    const votes = ok(admitVerificationResult(brief, wire(brief.fingerprints.map((fingerprint) => voteOn(fingerprint)))));
    return ok(bindBallots({ votes, authority, captureDigest: digest, wave: 1 }));
  });
  return { registration, result: ok(buildVerificationResult(registration, ballots)) };
};

describe("registration and the published result", () => {
  it("round-trips, and refuses a tampered registration or result", () => {
    const { registration, result } = publishedRun(["a/b:one", "a/b:two"]);
    expect(ok(parseRegisteredSecurityVerificationProgram(JSON.parse(JSON.stringify(registration))))).toEqual(registration);
    expect(parseRegisteredSecurityVerificationProgram({ ...registration, input: { ...registration.input, wave: 2 } }).ok).toBe(false);
    expect(parseRegisteredSecurityVerificationProgram({ ...registration, registrationDigest: "0".repeat(64) }).ok).toBe(false);
    expect(ok(parseVerificationResult(JSON.parse(serializeVerificationResult(result))))).toEqual(result);
  });

  it("refuses a result that does not cover the registered briefs exactly once", () => {
    const { registration, result } = publishedRun(["a/b:one", "a/b:two"]);
    expect(buildVerificationResult(registration, result.ballots.slice(1)).ok).toBe(false);
  });

  it("refuses a run with nothing to verify, or under a name its briefs do not derive", () => {
    const plan = planOf(["a/b:one"])!;
    expect(registerSecurityVerification(plan.run, plan.input, []).ok).toBe(false);
    expect(registerSecurityVerification("run.verify-w1-g1-000000000000", plan.input, plan.briefs).ok).toBe(false);
    expect(registerSecurityVerification(plan.run, { ...plan.input, generation: 2 }, plan.briefs).ok).toBe(false);
    expect(planOf(["a/b:one"], [ballotOn("a/b:one")])).toBeNull();
  });

  it("refuses a registration whose briefs break the brief rule, however it was built (INV-V3)", () => {
    const input = issueOf();
    const briefFor = (...fingerprints: string[]) => {
      const [head, ...rest] = fingerprints;
      return { slotId: verificationSlotId(input, fingerprints), fingerprints: [head!, ...rest] as const };
    };
    const refusal = (...briefs: ReturnType<typeof briefFor>[]) => {
      const registered = registerSecurityVerification("run.verify-w1-g1-000000000000", input, briefs);
      return registered.ok ? "" : registered.error;
    };
    expect(refusal(briefFor("a/b:one", "a/b:one"))).toContain("names a fingerprint twice");
    expect(refusal(briefFor("a/b:one", "a/b:two"), briefFor("a/b:two"))).toContain("fingerprint a/b:two sits in more than one brief");
    expect(refusal(briefFor(" a/b:one"))).toContain("names a malformed fingerprint");
    expect(refusal(briefFor("a/b:1", "a/b:2", "a/b:3", "a/b:4", "a/b:5"))).toContain(`must name 1..${MAX_BRIEF_FINGERPRINTS} fingerprints`);
    // The same rules hold on read back: a stored registration whose brief repeats a fingerprint does not parse.
    const plan = planOf(["a/b:one"])!;
    const registration = ok(registerSecurityVerification(plan.run, plan.input, plan.briefs));
    const doubled = { ...registration, briefs: [{ ...registration.briefs[0]!, fingerprints: ["a/b:one", "a/b:one"] }] };
    expect(parseRegisteredSecurityVerificationProgram(JSON.parse(JSON.stringify(doubled))).ok).toBe(false);
  });

  it("names a new run when the ledger or findings move, even over the same claim set (E)", () => {
    const base = planOf(["a/b:one"])!;
    expect(base.run).toMatch(/^run\.verify-w1-g1-[0-9a-f]{12}$/);
    const ledgerMoved = planOf(["a/b:one"], [], auditOf({ ledgerDigest: "4".repeat(64) }))!;
    const findingsMoved = planOf(["a/b:one"], [], auditOf({ findingsDigest: "5".repeat(64) }))!;
    expect(ledgerMoved.briefs.map((brief) => brief.fingerprints)).toEqual(base.briefs.map((brief) => brief.fingerprints));
    expect(new Set([base.run, ledgerMoved.run, findingsMoved.run]).size).toBe(3);
    // No two issuances share a slot (a harness resolves a spawn to its run by request id).
    const slots = [base, ledgerMoved, findingsMoved].flatMap((plan) => plan.briefs.map((brief) => brief.slotId));
    expect(new Set(slots).size).toBe(slots.length);
  });

  it("offers the next generation while the current one is dead, and stops at the cap (E)", () => {
    const first = planOf(["a/b:one"])!;
    expect(first.input.generation).toBe(1);
    // A live (in-flight or importable) generation is the one to drive.
    expect(planOf(["a/b:one"], [], AUDIT, (run) => (run === first.run ? "live" : "absent"))!.run).toBe(first.run);
    const second = planOf(["a/b:one"], [], AUDIT, (run) => (run === first.run ? "dead" : "absent"))!;
    expect(second.input.generation).toBe(2);
    expect(second.run).toMatch(/^run\.verify-w1-g2-/);
    expect(second.briefs[0]!.slotId).not.toBe(first.briefs[0]!.slotId);
    expect(ok(registerSecurityVerification(second.run, second.input, second.briefs)).runId).toBe(second.run);
    const exhausted = planVerificationStart({ audit: AUDIT, wave: 1, findings: findingsOf(["a/b:one"]), verdicts: [], observe: () => "dead" });
    expect(exhausted.ok ? "" : exhausted.error).toContain(`every one of the ${MAX_VERIFICATION_GENERATIONS} verification generations`);
  });

  it("renders the start command with every path as one shell-quoted word (H)", () => {
    const plan = planOf(["a/b:one"])!;
    const command = renderVerificationStart(plan, "/tmp/my audit's runs/verification-runs");
    expect(command.split("\n")[0]).toContain(`--runs-root '/tmp/my audit'\\''s runs/verification-runs' --run '${plan.run}'`);
  });

  it("parses the D1 start input exactly", () => {
    const input = { schemaVersion: 1, audit: AUDIT, wave: 1, generation: 1 };
    expect(ok(parseSecurityVerificationStart(input))).toEqual(input);
    expect(parseSecurityVerificationStart({ ...input, extra: true }).ok).toBe(false);
    expect(parseSecurityVerificationStart({ ...input, audit: { ...AUDIT_FIELDS, locator: "relative/run" } }).ok).toBe(false);
    expect(parseSecurityVerificationStart({ ...input, audit: { ...AUDIT_FIELDS, locator: "/a/../b" } }).ok).toBe(false);
    expect(parseSecurityVerificationStart({ ...input, audit: { ...AUDIT_FIELDS, ledgerDigest: "x" } }).ok).toBe(false);
    expect(parseSecurityVerificationStart({ ...input, wave: 0 }).ok).toBe(false);
    expect(parseSecurityVerificationStart({ ...input, generation: 0 }).ok).toBe(false);
    expect(parseSecurityVerificationStart({ ...input, generation: MAX_VERIFICATION_GENERATIONS + 1 }).ok).toBe(false);
    const { generation: _omitted, ...withoutGeneration } = input;
    expect(parseSecurityVerificationStart(withoutGeneration).ok).toBe(false);
  });

  it("mints an audit reference only through its one constructor, naming each refusal", () => {
    expect(ok(parseAuditReference(AUDIT_FIELDS))).toEqual(AUDIT_FIELDS);
    const refusal = (raw: unknown): string => {
      const parsed = parseAuditReference(raw);
      return parsed.ok ? "" : parsed.error;
    };
    expect(refusal({ ...AUDIT_FIELDS, extra: 1 })).toBe("audit must contain exactly locator, runId, ledgerDigest and findingsDigest");
    expect(refusal({ ...AUDIT_FIELDS, locator: "/a/./b" })).toBe("audit.locator must be an absolute canonical path");
    expect(refusal({ ...AUDIT_FIELDS, locator: "/a/b/" })).toBe("audit.locator must be an absolute canonical path");
    expect(refusal({ ...AUDIT_FIELDS, runId: "" })).toBe("audit.runId must be the audit's run id");
    expect(refusal({ ...AUDIT_FIELDS, runId: "run\n1" })).toBe("audit.runId must be the audit's run id");
    expect(refusal({ ...AUDIT_FIELDS, findingsDigest: "F".repeat(64) })).toBe("audit.ledgerDigest and audit.findingsDigest must be sha256 digests");
  });
});

describe("import (D4)", () => {
  it("imports once, idempotently, and accumulates across verification runs", () => {
    const first = publishedRun(["a/b:one"]);
    const imported = ok(importVerificationResult({ ...first, audit: AUDIT, existing: [] }));
    expect(imported.added).toBe(1);
    expect(ok(importVerificationResult({ ...first, audit: AUDIT, existing: imported.verdicts }))).toEqual({ verdicts: imported.verdicts, added: 0 });
    const second = publishedRun(["a/b:two"]);
    const both = ok(importVerificationResult({ ...second, audit: AUDIT, existing: imported.verdicts }));
    expect(both.verdicts.map((ballot) => ballot.fingerprint)).toEqual(["a/b:one", "a/b:two"]);
  });

  it("refuses a stale ledger or findings digest, another audit, a partial import and a foreign result", () => {
    const { registration, result } = publishedRun(["a/b:one"]);
    const refused = (audit: AuditReference, existing: readonly VerificationVerdict[] = [], published = result) => {
      const outcome = importVerificationResult({ registration, result: published, audit, existing });
      return outcome.ok ? "" : outcome.error;
    };
    expect(refused(auditOf({ findingsDigest: "3".repeat(64) }))).toContain("audit findings changed");
    expect(refused(auditOf({ ledgerDigest: "3".repeat(64) }))).toContain("audit ledger changed");
    expect(refused(auditOf({ runId: "run-2" }))).toContain("was issued for audit run-1");
    expect(refused(auditOf({ locator: "/audits/other" }))).toContain("was issued for audit run-1");
    const altered = { ...result.ballots[0]!, vote: "advisory" as const };
    expect(refused(AUDIT, [altered])).toContain("already holds a different ballot set");
    expect(refused(AUDIT, [], { ...result, wave: 2 })).toContain("does not describe verification run");
    expect(authenticateAudit(AUDIT, AUDIT).ok).toBe(true);
  });
});

describe("one fingerprint, one verification run (H)", () => {
  it("refuses importing a run whose fingerprint already carries another run's ballot", () => {
    const first = publishedRun(["a/b:one"]);
    const imported = ok(importVerificationResult({ ...first, audit: AUDIT, existing: [] }));
    // A second generation over the same claim set, finished too.
    const plan = planOf(["a/b:one"], [], AUDIT, (run) => (run === first.registration.runId ? "dead" : "absent"))!;
    const registration = ok(registerSecurityVerification(plan.run, plan.input, plan.briefs));
    const brief = plan.briefs[0]!;
    const votes = ok(admitVerificationResult(brief, wire([voteOn("a/b:one", { vote: "advisory", missingFact: "x" })])));
    const ballots = ok(bindBallots({ votes, authority: mintedSlot(brief, registration.runId).attempts[0], captureDigest: "b".repeat(64), wave: 1 }));
    const second = { registration, result: ok(buildVerificationResult(registration, ballots)) };
    const refused = importVerificationResult({ ...second, audit: AUDIT, existing: imported.verdicts });
    expect(refused.ok ? "" : refused.error).toContain(`already carries a ballot from verification run ${first.registration.runId}`);
  });
});

describe("verdicts.json is a cache (B)", () => {
  const RUN_DIRECTORY = "/audits/run-1/verification-runs/run";
  const attestationOf = (ballot: VerificationVerdict, overrides: Partial<CaptureAttestationFields> = {}): AttestationLookup => ({
    kind: "attested",
    attestation: ok(mintCaptureAttestation({
      runId: ballot.binding.runId, runDirectory: RUN_DIRECTORY, requestId: ballot.binding.requestId,
      slotId: ballot.binding.slotId, attempt: ballot.binding.attempt, harness: "claude", nativeId: "agent-1",
      digest: ballot.binding.captureDigest, byteLength: 10, ...overrides,
    })),
  });
  const proofOf = (run: ReturnType<typeof publishedRun>, lookup: (requestId: string) => AttestationLookup): VerificationRunProof =>
    ({ kind: "proven", registration: run.registration, replayed: run.result, runDirectory: RUN_DIRECTORY, attestations: lookup });

  it("counts a cached ballot only while its run proves it, naming every run that fails", () => {
    const run = publishedRun(["a/b:one"]);
    const [ballot] = run.result.ballots;
    const decide = (verdicts: readonly VerificationVerdict[], proof: VerificationRunProof) =>
      admitCachedBallots({ audit: AUDIT, verdicts, proofs: new Map([[run.registration.runId, proof]]) });

    expect(decide(run.result.ballots, proofOf(run, () => attestationOf(ballot!)))).toEqual({ admitted: run.result.ballots, blockers: [] });
    const refusals: readonly [VerificationRunProof, string][] = [
      [proofOf(run, () => ({ kind: "absent" })), "not natively captured"],
      [proofOf(run, () => ({ kind: "refused", reason: "capture attestation x is not JSON" })), "is not JSON"],
      [proofOf(run, () => attestationOf(ballot!, { digest: "f".repeat(64) })), "(capture digest)"],
      [proofOf(run, () => attestationOf(ballot!, { attempt: 2 })), "(attempt)"],
      [proofOf(run, () => attestationOf(ballot!, { runDirectory: "/elsewhere" })), "(run directory)"],
      // The pure check does not trust the lookup to answer only for the request it was asked about.
      [proofOf(run, () => attestationOf(ballot!, { requestId: `${ballot!.binding.slotId}:2` })), "(request)"],
      [{ kind: "unprovable", reason: "its evidence cannot be replayed: boom" }, "boom"],
    ];
    for (const [proof, reason] of refusals) {
      const decided = decide(run.result.ballots, proof);
      expect(decided.admitted, reason).toEqual([]);
      expect(decided.blockers.join("\n"), reason).toContain(reason);
    }
    // A ballot written into verdicts.json by hand: not what the run replays.
    const forged = ok(parseVerificationVerdicts([{ ...ballot!, vote: "advisory", missingFact: "forged" }]))[0]!;
    expect(decide([forged], proofOf(run, () => attestationOf(forged))).blockers.join()).toContain("does not hold exactly the ballots");
    // A run issued for another audit proves nothing here.
    const foreign = admitCachedBallots({ audit: auditOf({ runId: "run-9" }), verdicts: run.result.ballots,
      proofs: new Map([[run.registration.runId, proofOf(run, () => attestationOf(ballot!))]]) });
    expect(foreign.blockers.join()).toContain("not this audit");
    // No proof read at all.
    expect(admitCachedBallots({ audit: AUDIT, verdicts: run.result.ballots, proofs: new Map() }).admitted).toEqual([]);
  });
});

describe("capture attestations (B)", () => {
  const run = publishedRun(["a/b:one"], "c".repeat(64));
  const ballot = run.result.ballots[0]!;
  const authority = mintedSlot({ slotId: ballot.binding.slotId, fingerprints: ["a/b:one"] }, run.registration.runId).attempts[0];
  const receipt: CaptureReceipt = {
    schemaVersion: CAPTURE_SCHEMA_VERSION, kind: "capture-receipt", harness: "pi", requestId: authority.requestId,
    slotId: authority.slotId, attempt: authority.attempt, nativeId: "tool-call:0", byteLength: 12,
    digest: ok(parseArtifactDigest("c".repeat(64))),
  };

  it("derives the attestation from authority and receipt only, round-tripping through its canonical bytes", () => {
    const attestation = ok(captureAttestationOf(authority, receipt, "/runs/r")!);
    expect(attestation).toMatchObject({ requestId: authority.requestId, slotId: authority.slotId, harness: "pi", digest: "c".repeat(64) });
    const name = captureAttestationEntryName("/runs/r", authority.requestId);
    expect(ok(parseCaptureAttestation(name, renderCaptureAttestation(attestation)))).toEqual(attestation);
    expect(ballotsAttested([ballot], "/runs/r", () => ({ kind: "attested", attestation })).ok).toBe(true);
    expect(captureAttestationOf({ ...authority, program: "refutation-panel" } as never, receipt, "/runs/r")).toBeNull();
    expect(captureAttestationOf({ ...authority, role: "security-hunter-agent" } as never, receipt, "/runs/r")?.ok).toBe(false);
  });

  it("mints a fresh capture's attestation with the store's own field bounds", () => {
    // One constructor: a harness-supplied native id outside the stored grammar
    // is refused at capture, not written and then refused on every read.
    const unbounded = captureAttestationOf(authority, { ...receipt, nativeId: "x".repeat(1_025) }, "/runs/r");
    expect(unbounded?.ok ? "" : unbounded?.error).toContain("names a malformed run, request, slot or native id");
    expect(captureAttestationOf(authority, receipt, "relative/run")?.ok).toBe(false);
    expect(mintCaptureAttestation({
      runId: "r", runDirectory: "/runs/r", requestId: "q", slotId: "s", attempt: 3, harness: "claude",
      nativeId: "n", digest: "c".repeat(64), byteLength: 1,
    }).ok).toBe(false);
  });

  it("fails closed on a malformed, renamed or non-canonical record", () => {
    const attestation = ok(captureAttestationOf(authority, receipt, "/runs/r")!);
    const bytes = renderCaptureAttestation(attestation);
    const name = captureAttestationEntryName("/runs/r", authority.requestId);
    expect(parseCaptureAttestation(name, "{").ok).toBe(false);
    expect(parseCaptureAttestation(captureAttestationEntryName("/runs/other", authority.requestId), bytes).ok).toBe(false);
    expect(parseCaptureAttestation(name, bytes.replace(/\n$/, " \n")).ok).toBe(false);
    expect(parseCaptureAttestation(name, bytes.replace("\"digest\":\"c", "\"digest\":\"Z")).ok).toBe(false);
    expect(parseCaptureAttestation(name, `${JSON.stringify({ ...attestation, extra: 1 })}\n`).ok).toBe(false);
    fc.assert(fc.property(fc.string(), (text) => { expect(parseCaptureAttestation(name, text).ok).toBe(text === bytes); }));
  });
});
