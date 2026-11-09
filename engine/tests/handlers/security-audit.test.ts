/**
 * The security-audit helper, driven the way an operator and an agent drive it.
 *
 * These tests cross the seam the CLI actually exposes — `helper security-audit
 * <op> --out <dir>` with a stdin payload — rather than calling the pure cores.
 * The cores are already covered by `tests/security/*`; what is at stake here is
 * the program's own invariants: a closed action set, a run directory that never
 * silently accepts a half-written document, and a `publish` that refuses rather
 * than publishing an unverified claim.
 *
 * A real temp directory is used because the run directory IS the contract: the
 * files are read back by a later invocation, so a test that stubs the store
 * would not exercise the thing that breaks in production.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSecurityAuditHandler } from "../../src/handlers/helpers/security-audit";
import { parseStandaloneDispositionStartInput } from "../../src/core/standalone-disposition-machine";
import { piRuntimeHandshakeRequired, routeConsumesStdin } from "../../src/handler-routes";
import { SECURITY_AUDIT_OPERATIONS, SECURITY_AUDIT_OPERATION_ORDER, parseSecurityAuditOperation, securityAuditOperationWrites } from "../../src/handlers/helpers/security-audit-operations";
import { SECURITY_AUDIT_LIMITS, type SecurityRunMetadata } from "../../src/core/security-audit-contract";
import type { CoverageUnit } from "../../src/core/security-coverage";
import type { SecurityFinding } from "../../src/core/security-findings";
import { HUNTER_ENVELOPE, aConfirmedFinding, aHunterBallot, aNeedsValidationFinding, aSeed, aUnitResult, aVerdict, nSeeds } from "../security/fixtures";
import { aRun, handWriteBallots, isolateSubagentDir, readJson, removeRuns, seedFor, unitIdFor, type Run } from "./security-audit-harness";
import { verifyWith } from "./security-verification-harness";
import { registeredSecurityAuditRuns } from "../../src/orchestration/security-audit-run-registry";

beforeEach(() => { isolateSubagentDir(); });
afterEach(removeRuns);

describe("the operation set", () => {
  it("declares every operation exactly once, in order", () => {
    const declared = Object.keys(SECURITY_AUDIT_OPERATIONS).sort();
    expect(declared).toEqual([...SECURITY_AUDIT_OPERATION_ORDER].sort());
    expect(new Set(SECURITY_AUDIT_OPERATION_ORDER).size).toBe(SECURITY_AUDIT_OPERATION_ORDER.length);
  });

  it("refuses an operation it does not declare", () => {
    expect(parseSecurityAuditOperation("publish-all")).toBeNull();
    expect(parseSecurityAuditOperation(undefined)).toBeNull();
    expect(parseSecurityAuditOperation("status")).toBe("status");
  });

  it("prints its usage from the declared order, so the help and the table cannot drift", async () => {
    const refused = await aRun().invoke(["publish-all"]);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain(`<${SECURITY_AUDIT_OPERATION_ORDER.join("|")}>`);
  });

  it("gates every operation that writes the run behind the handshake", () => {
    for (const operation of Object.keys(SECURITY_AUDIT_OPERATIONS) as (keyof typeof SECURITY_AUDIT_OPERATIONS)[]) {
      if (!securityAuditOperationWrites(operation)) continue;
      expect(SECURITY_AUDIT_OPERATIONS[operation].runtimeSkew, `${operation} writes the run`).toBe("handshake-required");
    }
    // And the derivation is not vacuous: the writers outnumber the projections.
    expect(Object.keys(SECURITY_AUDIT_OPERATIONS).filter((operation) => securityAuditOperationWrites(operation as keyof typeof SECURITY_AUDIT_OPERATIONS))).toHaveLength(8);
  });

  it("keeps the read-only projections available during a runtime skew", () => {
    const available = Object.entries(SECURITY_AUDIT_OPERATIONS)
      .filter(([, traits]) => traits.runtimeSkew === "available")
      .map(([operation]) => operation)
      .sort();
    expect(available).toEqual(["findings", "nonce", "status"]);
  });

  it("declares nonce read-only and flags-only: it prints a binding, it never moves the run", () => {
    expect(SECURITY_AUDIT_OPERATIONS.nonce).toEqual({ input: "flags", runtimeSkew: "available" });
    expect(securityAuditOperationWrites("nonce")).toBe(false);
    expect(routeConsumesStdin("helper", "security-audit", ["nonce"])).toBe(false);
    expect(piRuntimeHandshakeRequired("helper", "security-audit", ["nonce"])).toBe(false);
    // In the order a run performs it: after the unit is assigned, before it settles.
    expect(SECURITY_AUDIT_OPERATION_ORDER.indexOf("nonce")).toBe(SECURITY_AUDIT_OPERATION_ORDER.indexOf("assign") + 1);
  });
});

describe("a full run", () => {
  it("start → assign → submit → verify → findings → publish", async () => {
    const run = aRun();

    const started = await run.invoke(
      ["start", "--repo", run.out, "--source", "0".repeat(40), "--profile", "standard", "--budget", "12"],
      JSON.stringify({ units: [seedFor(0)], signals: { languages: ["typescript"], servesHttp: true } }),
    );
    expect(started.error).toBeNull();

    const metadata = readJson<SecurityRunMetadata>(run.out, "run.json");
    expect(metadata.profile).toBe("standard");
    expect(metadata.sourceRef).toEqual({ commit: "0".repeat(40), worktreeDirty: false });
    expect(metadata.scopePaths).toEqual(["src/subsystem-0/entry.ts"]);
    expect(metadata.selectedCompanions.length).toBeGreaterThan(0);
    expect(readJson<CoverageUnit[]>(run.out, "ledger.json")[0].status).toBe("planned");

    expect((await run.invoke(["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent", "--wave", "1"])).error).toBeNull();
    const assigned = readJson<CoverageUnit[]>(run.out, "ledger.json")[0];
    expect(assigned.status).toBe("in_progress");
    expect(assigned.agent_id).toBe("security-hunter-agent");

    const submitted = await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE,
      units: [aUnitResult({ coverageId: unitIdFor(0), status: "candidate", fingerprints: ["api/login:sqli-email"] })],
      findings: [aConfirmedFinding()],
    }));
    expect(submitted.error).toBeNull();
    expect(readJson<CoverageUnit[]>(run.out, "ledger.json")[0].status).toBe("candidate");
    expect(readJson<SecurityFinding[]>(run.out, "findings.json")).toHaveLength(1);

    // Before any ballot, the confirmed claim is a publication blocker.
    const blocked = await run.invoke(["publish"]);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("no verification verdict");

    await verifyWith(run);

    const findings = await run.invoke(["findings", "--json"]);
    expect(findings.error).toBeNull();
    const rendered = JSON.parse(run.stdout()) as { findings: SecurityFinding[]; publicationBlockers: string[] };
    expect(rendered.publicationBlockers).toEqual([]);
    expect(rendered.findings.map((finding) => finding.verdict)).toEqual(["confirmed"]);

    const published = await run.invoke(["publish"]);
    expect(published.error).toBeNull();
    expect(readJson<SecurityFinding[]>(run.out, "security-findings.json")).toHaveLength(1);
    expect(readJson<SecurityRunMetadata>(run.out, "run.json").runStatus).toBe("complete");
    const written = readdirSync(run.out).sort();
    expect(written).toEqual([
      "FINDINGS-DETAIL.md",
      "NEEDS-VALIDATION.md",
      "REPORT.md",
      "findings.json",
      "ledger.json",
      "lenses.json",
      "run.json",
      "security-findings.json",
      "verdicts.json",
      "verification-runs",
    ]);
    expect(readFileSync(join(run.out, "REPORT.md"), "utf8")).toContain("api/login:sqli-email");
  });

  it("refuses to restart a run directory unless forced", async () => {
    const run = aRun();
    const start = () => run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: [seedFor(0)] }));
    expect((await start()).error).toBeNull();
    const second = await start();
    expect(second.ok).toBe(false);
    expect(second.error).toContain("--force");
    expect((await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40), "--force"], JSON.stringify({ units: [seedFor(0)] }))).error).toBeNull();
  });
});

describe("coverage settlement", () => {
  it("defers a single planned unit with a reason", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: nSeeds(2) }));
    expect((await run.invoke(["defer", "--unit", unitIdFor(1), "--reason", "budget_cut"])).error).toBeNull();
    const ledger = readJson<CoverageUnit[]>(run.out, "ledger.json");
    expect(ledger.find((unit) => unit.coverage_id === unitIdFor(1))?.status).toBe("deferred");
    expect(ledger.find((unit) => unit.coverage_id === unitIdFor(1))?.unresolved).toContain("budget_cut");
    expect(ledger.find((unit) => unit.coverage_id === unitIdFor(0))?.status).toBe("planned");
  });

  it("defers every planned unit when no unit is named", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: nSeeds(2) }));
    expect((await run.invoke(["defer", "--reason", "scope_narrowed"])).error).toBeNull();
    expect(readJson<CoverageUnit[]>(run.out, "ledger.json").every((unit) => unit.status === "deferred")).toBe(true);
  });

  it("refuses to defer a unit that is already owned", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: [seedFor(0)] }));
    await run.invoke(["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent"]);
    const deferred = await run.invoke(["defer", "--unit", unitIdFor(0), "--reason", "budget_cut"]);
    expect(deferred.ok).toBe(false);
    expect(deferred.error).toContain(unitIdFor(0));
  });

  it("refuses a settlement from an agent that does not own the unit", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: [seedFor(0)] }));
    await run.invoke(["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent", "--wave", "1"]);
    const wrong = await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE,
      units: [aUnitResult({ coverageId: unitIdFor(0), agentId: "security-critic-agent" })],
    }));
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toContain("wrong-owner");
  });

  it("refuses to publish while a unit is still planned", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: nSeeds(2) }));
    const blocked = await run.invoke(["publish"]);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("coverage ledger still has");
  });
});

describe("adjudication", () => {
  const seedAndSubmitClaim = async (run: Run) => {
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40), "--profile", "standard"], JSON.stringify({ units: [seedFor(0)] }));
    await run.invoke(["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent", "--wave", "1"]);
    await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE,
      units: [aUnitResult({ coverageId: unitIdFor(0), status: "candidate", fingerprints: ["api/login:sqli-email"] })],
      findings: [aConfirmedFinding()],
    }));
  };

  it("demotes a claim to a lead when the ballot names a missing fact", async () => {
    const run = aRun();
    await seedAndSubmitClaim(run);
    await verifyWith(run, () => ({ vote: "advisory", missingFact: "The deployment may bind the value upstream." }));
    expect((await run.invoke(["publish"])).error).toBeNull();
    const published = readJson<SecurityFinding[]>(run.out, "security-findings.json");
    expect(published.map((finding) => finding.verdict)).toEqual(["needs_validation"]);
    expect(published[0].verdict === "needs_validation" ? published[0].blockers : []).toEqual(["The deployment may bind the value upstream."]);
  });

  it("rejects a claim when the ballot refutes it outright", async () => {
    const run = aRun();
    await seedAndSubmitClaim(run);
    await verifyWith(run, () => ({ vote: "advisory", missingFact: null }));
    expect((await run.invoke(["publish"])).error).toBeNull();
    expect(readJson<SecurityFinding[]>(run.out, "security-findings.json").map((finding) => finding.verdict)).toEqual(["rejected"]);
  });

  it("never counts a hand-written ballot — not even one whose binding names a verifier — and names its run as a blocker", async () => {
    const run = aRun();
    await seedAndSubmitClaim(run);
    // A ballot written into verdicts.json, binding and all: no verification
    // run under this audit replays it, and no harness attested its capture.
    // (INV-S3 over a REAL ballot's minted profile is the adjudication core's,
    // tests/security/security-adjudication.test.ts.)
    handWriteBallots(run, [aHunterBallot()]);
    const blocked = await run.invoke(["publish"]);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("are not counted");
    expect(blocked.error).toContain("no verification verdict");
    expect((await run.invoke(["findings", "--json"])).error).toBeNull();
    expect((JSON.parse(run.stdout()) as { publicationBlockers: string[] }).publicationBlockers.join("\n")).toContain("are not counted");
  });
  it("refuses a ballot whose binding names no verifier spawn — a refusal, not an unverified gap (ADR-0065 D5)", async () => {
    const run = aRun();
    await seedAndSubmitClaim(run);
    // A hunter cannot cast a ballot by writing its own role into the binding.
    handWriteBallots(run, [aVerdict({ binding: { role: "security-hunter-agent" } })]);
    const refused = await run.invoke(["publish"]);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("verdicts.json is malformed");
    expect(refused.error).toContain("binding.role: expected security-verifier-agent");
    const { binding: _binding, ...unbound } = aVerdict();
    writeFileSync(join(run.out, "verdicts.json"), JSON.stringify([unbound]));
    expect((await run.invoke(["status"])).error).toContain("binding: expected the binding a verification run published");
  });

  it("passes a hunter's own lead and rejection through untouched", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40), "--profile", "standard"], JSON.stringify({ units: [seedFor(0)] }));
    await run.invoke(["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent", "--wave", "1"]);
    const submitted = await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE,
      units: [aUnitResult({ coverageId: unitIdFor(0), status: "covered" })],
      findings: [aNeedsValidationFinding(), aConfirmedFinding()],
    }));
    expect(submitted.error).toBeNull();
    await verifyWith(run);
    expect((await run.invoke(["publish"])).error).toBeNull();
    const published = readJson<SecurityFinding[]>(run.out, "security-findings.json");
    expect(published.map((finding) => finding.verdict).sort()).toEqual(["confirmed", "needs_validation"]);
  });
});

describe("the wire", () => {
  it("refuses a submit payload with no units and no findings", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: [seedFor(0)] }));
    const empty = await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE, units: [] }));
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain("neither unit results nor findings");
  });

  it.each([
    ["the reviewer-payload label the hunter used to borrow", { schemaVersion: 2, kind: "standalone-review", units: [aUnitResult()] },
      ['kind: expected "security-hunter-result", got "standalone-review"', "schemaVersion: expected 1"]],
    ["a bare object with no envelope", {}, ["kind: expected \"security-hunter-result\"", "units: required"]],
    ["an unknown top-level key", { ...HUNTER_ENVELOPE, units: [aUnitResult()], verdicts: [] }, ["$.verdicts: unknown field"]],
    ["units that are not an array", { ...HUNTER_ENVELOPE, units: { coverageId: "x" } }, ["units: required"]],
    ["a payload that is not an object", [aUnitResult()], ["$: expected a security-hunter-result object"]],
  ])("refuses %s, naming the envelope it expects, and writes nothing", async (_case, payload, expected) => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: [seedFor(0)] }));
    await run.invoke(["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent", "--wave", "1"]);
    const before = ["ledger.json", "findings.json"].map((file) => readFileSync(join(run.out, file), "utf8"));
    const refused = await run.invoke(["submit"], JSON.stringify(payload));
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("submit input is not a security-hunter-result");
    for (const fragment of expected) expect(refused.error).toContain(fragment);
    expect(["ledger.json", "findings.json"].map((file) => readFileSync(join(run.out, file), "utf8"))).toEqual(before);
  });

  it("accepts a findings-only result with an empty units list", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: [seedFor(0)] }));
    const filed = await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE, units: [], findings: [aNeedsValidationFinding()] }));
    expect(filed.error).toBeNull();
    expect(run.stdout()).toContain("settled 0 unit(s); run now holds 1 finding record(s)");
  });

  it("names the offending field when a unit result is malformed", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: [seedFor(0)] }));
    const malformed = await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE, units: [aUnitResult({ status: "maybe" })] }));
    expect(malformed.ok).toBe(false);
    expect(malformed.error).toContain("units[0].status");
  });

  it("refuses a recorded ballot with an invented field", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: [seedFor(0)] }));
    handWriteBallots(run, [aVerdict({ invented: "high" })]);
    const invented = await run.invoke(["status"]);
    expect(invented.ok).toBe(false);
    expect(invented.error).toContain("verdicts[0].invented: unknown field");
  });

  it("refuses an unknown flag rather than ignoring it", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: [seedFor(0)] }));
    const unknown = await run.invoke(["status", "--verbose"]);
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("unknown argument");
  });

  it("refuses a --source that is not a commit sha", async () => {
    const run = aRun();
    const bad = await run.invoke(["start", "--repo", run.out, "--source", "main"], JSON.stringify({ units: [seedFor(0)] }));
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("40-character commit sha");
  });

  it("refuses a seed list that names the same coverage cell twice", async () => {
    const run = aRun();
    const duplicate = await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: [aSeed(), aSeed()] }));
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error).toContain("duplicate coverage cell");
  });

  it("refuses a run directory whose ledger is not JSON", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: [seedFor(0)] }));
    writeFileSync(join(run.out, "ledger.json"), "{not json");
    const status = await run.invoke(["status"]);
    expect(status.ok).toBe(false);
    expect(status.error ?? "").toContain("not valid JSON");
  });

  it("refuses to follow a symlinked run file", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: [seedFor(0)] }));
    const elsewhere = join(run.out, "..", `${run.out.split("/").pop()}-elsewhere.json`);
    writeFileSync(elsewhere, "[]");
    // Replace a document the run itself wrote, so the read is the symlinked one.
    rmSync(join(run.out, "ledger.json"));
    symlinkSync(elsewhere, join(run.out, "ledger.json"));
    const status = await run.invoke(["status"]);
    expect(status.ok).toBe(false);
    expect((status.error ?? "").toLowerCase()).toMatch(/symlink|symbolic|eloop/);
    rmSync(elsewhere, { force: true });
  });

  it("reports an unset budget and an empty run without inventing numbers", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: [seedFor(0)] }));
    const status = await run.invoke(["status", "--json"]);
    expect(status.ok).toBe(true);
    const report = JSON.parse(run.stdout()) as Record<string, unknown>;
    expect(report.publicationBlockers).toEqual(["coverage ledger still has planned, in-progress or blocked units"]);
    expect((report.findings as { records: number }).records).toBe(0);
    expect((report.coverage as { complete: boolean }).complete).toBe(false);
  });
});

describe("the run directory reads", () => {
  // Every read is fail-closed: an absent or degenerate document is a REFUSAL,
  // never an empty list. Treating absence as `[]` would let a lost or deleted
  // file read as "the run has no findings", so `publish` would emit an empty
  // result and the operator would never learn the run directory was damaged.
  const started = async (run: Run): Promise<void> => {
    expect((await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: [seedFor(0)] }))).error).toBeNull();
  };

  it("refuses an empty ledger instead of claiming coverage of nothing", async () => {
    const run = aRun();
    await started(run);
    writeFileSync(join(run.out, "ledger.json"), "[]\n");
    const status = await run.invoke(["status"]);
    expect(status.ok).toBe(false);
    expect(status.error).toContain("a run always seeds at least one unit");
  });

  it("refuses a run directory with no findings document", async () => {
    const run = aRun();
    await started(run);
    rmSync(join(run.out, "findings.json"));
    const status = await run.invoke(["status"]);
    expect(status.ok).toBe(false);
    expect(status.error ?? "").toContain(join(run.out, "findings.json"));
    expect(status.error ?? "").toContain("is missing");
  });

  it("refuses a run directory with no verdicts document", async () => {
    const run = aRun();
    await started(run);
    rmSync(join(run.out, "verdicts.json"));
    const status = await run.invoke(["status"]);
    expect(status.ok).toBe(false);
    expect(status.error ?? "").toContain(join(run.out, "verdicts.json"));
    expect(status.error ?? "").toContain("is missing");
  });

  it("parses the ballot document rather than trusting it", async () => {
    const run = aRun();
    await started(run);
    // A hand-edited ballot document is the case that matters: the read path
    // must run the same parser `verify` does, so an invented key is named here
    // and not discovered by whichever operation reads it first.
    writeFileSync(join(run.out, "verdicts.json"), `${JSON.stringify([{ ...aVerdict(), voteReason: "because" }], null, 2)}\n`);
    const status = await run.invoke(["status"]);
    expect(status.ok).toBe(false);
    expect(status.error ?? "").toContain("verdicts[0].voteReason");
  });

  it("parses the findings document rather than trusting it", async () => {
    const run = aRun();
    await started(run);
    writeFileSync(join(run.out, "findings.json"), `${JSON.stringify([{ verdict: "confirmed", fingerprint: "api/login:sqli-email" }], null, 2)}\n`);
    const status = await run.invoke(["status"]);
    expect(status.ok).toBe(false);
    expect(status.error ?? "").toContain("findings.json is malformed");
    expect(status.error ?? "").toContain("$[0].title");
  });
});

describe("budget", () => {
  it("refuses a budget below what the wave needs", async () => {
    const run = aRun();
    const tooSmall = await run.invoke(
      ["start", "--repo", run.out, "--source", "0".repeat(40), "--budget", "1"],
      JSON.stringify({ units: nSeeds(SECURITY_AUDIT_LIMITS.units > 4 ? 4 : 2) }),
    );
    expect(tooSmall.ok).toBe(false);
    expect(tooSmall.error ?? "").toContain("budget");
  });

  it("refuses a non-positive budget", async () => {
    const run = aRun();
    const bad = await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40), "--budget", "0"], JSON.stringify({ units: [seedFor(0)] }));
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("positive integer");
  });
});

describe("routing", () => {
  it("declares its traits per operation, so a flags-only op never reads stdin", () => {
    // A helper that reads stdin for a flags-only operation hangs until the
    // parent's pipe closes; `routeConsumesStdin` is the one place that decides.
    expect(routeConsumesStdin("helper", "security-audit", ["status", "--out", "/tmp/x"])).toBe(false);
    expect(routeConsumesStdin("helper", "security-audit", ["findings"])).toBe(false);
    expect(routeConsumesStdin("helper", "security-audit", ["submit"])).toBe(true);
    expect(routeConsumesStdin("helper", "security-audit", ["merge-critic"])).toBe(true);
    // A mutating op must not run against a skewed Pi runtime; the read-only
    // projections must, so a run stays diagnosable while recovering.
    expect(piRuntimeHandshakeRequired("helper", "security-audit", ["status"])).toBe(false);
    expect(piRuntimeHandshakeRequired("helper", "security-audit", ["findings"])).toBe(false);
    expect(piRuntimeHandshakeRequired("helper", "security-audit", ["publish"])).toBe(true);
    expect(piRuntimeHandshakeRequired("helper", "security-audit", ["start"])).toBe(true);
  });

  it("is reachable through cli.ts as `helper security-audit`", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: [seedFor(0)] }));
    const cli = join(resolve(__dirname, "../.."), "src", "cli.ts");
    // `bun`, not `node`: the engine imports extensionless TypeScript.
    const result = spawnSync("bun", [cli, "helper", "security-audit", "status", "--out", run.out], {
      encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"],
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("coverage:");
  });
});

describe("the disposition handoff", () => {
  const publishARun = async (run: Run) => {
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40), "--profile", "standard"], JSON.stringify({ units: [seedFor(0)] }));
    await run.invoke(["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent", "--wave", "1"]);
    await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE,
      units: [aUnitResult({ coverageId: unitIdFor(0), status: "candidate", fingerprints: ["api/login:sqli-email"] })],
      findings: [aConfirmedFinding()],
    }));
    await verifyWith(run);
    expect((await run.invoke(["publish"])).error).toBeNull();
  };

  it("refuses before publish instead of dispositioning unadjudicated claims", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: [seedFor(0)] }));
    const early = await run.invoke(["disposition"]);
    expect(early.ok).toBe(false);
    expect(early.error).toContain("publish");
  });

  it("derives one decision per published record", async () => {
    const run = aRun();
    await publishARun(run);
    expect((await run.invoke(["disposition"])).error).toBeNull();
    const disposition = readJson<{ entries: readonly { fingerprint: string; decision: string }[]; source: { locator: string; runId: string } }>(run.out, "disposition.json");
    expect(disposition.entries.map((entry) => entry.decision)).toEqual(["accepted"]);
    expect(disposition.entries[0].fingerprint).toBe("api/login:sqli-email");
    expect(disposition.source.locator).toBe(run.out);
  });

  it("names the disposition set in the published report", async () => {
    const run = aRun();
    await publishARun(run);
    const report = readFileSync(join(run.out, "REPORT.md"), "utf8");
    expect(report).toContain("## Disposition handoff");
    expect(report).toContain(`--runs-root '${join(run.out, "disposition-runs")}'`);
    expect(report).toContain(join(run.out, "standalone-disposition.json"));
  });

  it("writes a handoff the standalone-disposition loader can parse", async () => {
    const run = aRun();
    await publishARun(run);
    const handedOff = await run.invoke(["disposition"]);
    expect(handedOff.error).toBeNull();
    // The printed command names this file and the runs root beside it.
    const report = readFileSync(join(run.out, "REPORT.md"), "utf8");
    const input = join(run.out, "standalone-disposition.json");
    expect(run.stdout()).toContain(input);
    expect(report).toContain(input);
    const written = JSON.parse(readFileSync(input, "utf8")) as { source: { locator: string }; record: { entries: readonly unknown[] } };
    const parsed = parseStandaloneDispositionStartInput(written);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.source.locator).toBe(run.out);
    expect(parsed.value.record.entries).toHaveLength(1);
  });

  it("keeps the decision set stable when re-derived, and moves it when a record changes", async () => {
    const run = aRun();
    await publishARun(run);
    await run.invoke(["disposition"]);
    const first = readFileSync(join(run.out, "disposition.json"), "utf8");
    await run.invoke(["disposition"]);
    expect(readFileSync(join(run.out, "disposition.json"), "utf8")).toBe(first);
    const digest = JSON.parse(first).source.resultDigest as string;
    // Re-publishing the same findings keeps the digest; the decision set is a
    // function of the records, not of when it was written.
    await run.invoke(["publish"]);
    await run.invoke(["disposition"]);
    expect((JSON.parse(readFileSync(join(run.out, "disposition.json"), "utf8")) as { source: { resultDigest: string } }).source.resultDigest).toBe(digest);
  });
});

// --- Reads never create, and a published run is closed ---

describe("a read-only projection over a run directory that does not exist", () => {
  it.each([
    ["status", []],
    ["findings", []],
    ["nonce", ["--artifact", "agents/security-hunter-agent/artifacts/repro.txt"]],
  ] as const)("%s errors and creates nothing", async (operation, extra) => {
    const parent = mkdtempSync(join(tmpdir(), "loom-security-audit-missing-"));
    try {
      const out = join(parent, "mistyped-run");
      const handler = createSecurityAuditHandler(() => undefined);
      const result = await handler("", [operation, "--out", out, ...extra]);
      expect(result?.kind).toBe("error");
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("errors and creates nothing when even the run directory's base is missing", async () => {
    const parent = mkdtempSync(join(tmpdir(), "loom-security-audit-missing-"));
    try {
      const base = join(parent, "missing-base");
      const result = await createSecurityAuditHandler(() => undefined)("", ["status", "--out", join(base, "run")]);
      expect(result?.kind).toBe("error");
      expect(String(result?.kind === "error" ? result.message : "")).toContain("missing");
      expect(existsSync(base)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

// --- A run directory under a symlinked base ---

/**
 * macOS spells its temp root `/var/folders/…/T/…`, and `/var` is a symlink to
 * `/private/var`. The run's BASE may traverse such a system symlink; the run
 * directory itself and everything below it may not. `private/var` is the real
 * directory here and `var` the alias of it, the way macOS lays them out.
 */
describe("a run directory under a symlinked base (/var → /private/var)", () => {
  let scratch: string;
  let real: string;
  let alias: string;
  beforeEach(() => {
    scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-security-audit-alias-")));
    real = join(scratch, "private", "var");
    mkdirSync(real, { recursive: true });
    alias = join(scratch, "var");
    symlinkSync(real, alias);
  });
  afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

  const invokeAt = async (out: string, args: readonly string[], stdin = "") => {
    let printed = "";
    const result = await createSecurityAuditHandler((text) => { printed += `${text}\n`; })(stdin, [args[0] ?? "", "--out", out, ...args.slice(1)]);
    return { error: result?.kind === "error" ? String(result.message ?? "") : null, printed };
  };

  it("start, assign, submit and status succeed through the aliased spelling, under one canonical locator", async () => {
    // `folders/T` does not exist yet: the base is created, then resolved.
    const spelled = join(alias, "folders", "T", "run");
    const canonical = join(real, "folders", "T", "run");
    const started = await invokeAt(spelled, [...STARTED, "--repo", scratch], JSON.stringify({ units: [seedFor(0)] }));
    expect(started.error).toBeNull();
    expect(started.printed).toContain(canonical);
    expect(started.printed).not.toContain(spelled);
    expect(existsSync(join(canonical, "run.json"))).toBe(true);
    // The guard registry carries the one canonical spelling.
    expect(registeredSecurityAuditRuns()).toEqual([canonical]);

    expect((await invokeAt(spelled, ["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent", "--wave", "1"])).error).toBeNull();
    expect((await invokeAt(spelled, ["submit"], JSON.stringify({ ...HUNTER_ENVELOPE,
      units: [aUnitResult({ coverageId: unitIdFor(0), status: "candidate", fingerprints: ["api/login:sqli-email"] })],
      findings: [aConfirmedFinding()],
    }))).error).toBeNull();
    expect(readJson<CoverageUnit[]>(canonical, "ledger.json")[0].status).toBe("candidate");

    const status = await invokeAt(spelled, ["status"]);
    expect(status.error).toBeNull();
    // Either spelling names the same run.
    expect((await invokeAt(canonical, ["status"])).printed).toBe(status.printed);
  });

  it("still refuses a run document symlinked inside the run directory", async () => {
    const spelled = join(alias, "run");
    expect((await invokeAt(spelled, [...STARTED, "--repo", scratch], JSON.stringify({ units: [seedFor(0)] }))).error).toBeNull();
    const elsewhere = join(scratch, "elsewhere-ledger.json");
    writeFileSync(elsewhere, "[]");
    rmSync(join(real, "run", "ledger.json"));
    symlinkSync(elsewhere, join(real, "run", "ledger.json"));

    const status = await invokeAt(spelled, ["status"]);
    expect((status.error ?? "").toLowerCase()).toMatch(/symlink|symbolic|eloop/);
    const assigned = await invokeAt(spelled, ["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent", "--wave", "1"]);
    expect((assigned.error ?? "").toLowerCase()).toMatch(/symlink|symbolic|eloop/);
    expect(readFileSync(elsewhere, "utf8")).toBe("[]");
  });

  it("still refuses a run subdirectory symlinked inside the run directory", async () => {
    const spelled = join(alias, "run");
    expect((await invokeAt(spelled, [...STARTED, "--repo", scratch], JSON.stringify({ units: [seedFor(0)] }))).error).toBeNull();
    const elsewhere = join(scratch, "elsewhere-runs");
    mkdirSync(elsewhere);
    rmSync(join(real, "run", "verification-runs"), { recursive: true });
    symlinkSync(elsewhere, join(real, "run", "verification-runs"));

    // `start --force` re-prepares the verification runs root, no-follow.
    const restarted = await invokeAt(spelled, [...STARTED, "--repo", scratch, "--force"], JSON.stringify({ units: [seedFor(0)] }));
    // A no-follow directory open of a symlink: ENOTDIR on Linux, ELOOP on darwin.
    expect((restarted.error ?? "").toLowerCase()).toMatch(/symlink|symbolic|eloop|enotdir/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("still refuses a run directory that is itself a symlink", async () => {
    const target = join(real, "target-run");
    mkdirSync(target);
    const linked = join(alias, "linked-run");
    symlinkSync(target, join(real, "linked-run"));
    const started = await invokeAt(linked, [...STARTED, "--repo", scratch], JSON.stringify({ units: [seedFor(0)] }));
    // A no-follow directory open of a symlink: ENOTDIR on Linux, ELOOP on darwin.
    expect((started.error ?? "").toLowerCase()).toMatch(/symlink|symbolic|eloop|enotdir/);
    expect(readdirSync(target)).toEqual([]);
  });
});

const STARTED =["start", "--source", "0".repeat(40), "--profile", "standard"] as const;
const startOne = async (run: Run): Promise<void> => {
  expect((await run.invoke([...STARTED, "--repo", run.out], JSON.stringify({ units: [seedFor(0)] }))).error).toBeNull();
};

describe("a published run is closed", () => {
  const publishARun = async (run: Run): Promise<void> => {
    await startOne(run);
    await run.invoke(["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent", "--wave", "1"]);
    await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE,
      units: [aUnitResult({ coverageId: unitIdFor(0), status: "candidate", fingerprints: ["api/login:sqli-email"] })],
      findings: [aConfirmedFinding()],
    }));
    await verifyWith(run);
    expect((await run.invoke(["publish"])).error).toBeNull();
  };

  it.each([
    ["assign", ["assign", "--unit", "any", "--agent", "security-hunter-agent"], ""],
    ["submit", ["submit"], JSON.stringify({ ...HUNTER_ENVELOPE, units: [], findings: [aNeedsValidationFinding()] })],
    ["defer", ["defer", "--reason", "late cut"], ""],
    ["merge-critic", ["merge-critic"], JSON.stringify({
      schemaVersion: 1, kind: "security-coverage-critic", missingUnits: [], reassignIds: [], resolvedPriorLeads: [], stop: true,
    })],
    ["verify", ["verify", "--from", "run.verify-w1-000000000000"], ""],
  ] as const)("refuses %s, naming the published run and the way forward", async (_operation, args, stdin) => {
    const run = aRun();
    await publishARun(run);
    const before = ["ledger.json", "findings.json", "verdicts.json"].map((file) => readFileSync(join(run.out, file), "utf8"));
    const refused = await run.invoke([...args], stdin);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("is published");
    expect(refused.error).toContain("start --force");
    // Nothing moved: the committed records still describe the run beside them.
    expect(["ledger.json", "findings.json", "verdicts.json"].map((file) => readFileSync(join(run.out, file), "utf8"))).toEqual(before);
  });

  it("still re-derives its own projections and disposition", async () => {
    const run = aRun();
    await publishARun(run);
    expect((await run.invoke(["status"])).error).toBeNull();
    expect((await run.invoke(["findings"])).error).toBeNull();
    expect((await run.invoke(["disposition"])).error).toBeNull();
  });
});

describe("status derives the run's status from the ledger", () => {
  it("reports a settled, deferred run as incomplete although run.json still says in_progress", async () => {
    const run = aRun();
    await startOne(run);
    expect((await run.invoke(["defer", "--reason", "critic_budget_exhausted"])).error).toBeNull();
    // `run.json` is only rewritten by start and publish, so its copy is stale.
    expect(readJson<SecurityRunMetadata>(run.out, "run.json").runStatus).toBe("in_progress");

    expect((await run.invoke(["status", "--json"])).error).toBeNull();
    const report = JSON.parse(run.stdout()) as { runStatus: string; incompleteReason: string | null };
    expect(report.runStatus).toBe("incomplete");
    expect(report.incompleteReason).toBe("critic_budget_exhausted");
  });
});

// --- The start payload is parsed, not coerced ---

describe("start payload", () => {
  const startWith = (run: Run, payload: Record<string, unknown>) =>
    run.invoke([...STARTED, "--repo", run.out], JSON.stringify(payload));

  it.each([
    ["no units", { signals: {} }, "units: start input requires a `units` array"],
    ["an unknown top-level key", { units: [seedFor(0)], scopes: { kind: "tree" } }, "$.scopes: unknown field"],
    ["an unknown scope kind", { units: [seedFor(0)], scope: { kind: "branch" } }, "scope.kind: expected tree or diff"],
    ["a scope that is not an object", { units: [seedFor(0)], scope: "diff" }, "scope: expected an object"],
    ["an unknown scope key", { units: [seedFor(0)], scope: { kind: "diff", base: "x" } }, "scope.base: unknown field"],
    ["a mistyped ref", { units: [seedFor(0)], scope: { kind: "diff", baseRef: 7 } }, "scope.baseRef: expected a string or null"],
    ["signals that are not an object", { units: [seedFor(0)], signals: ["ts"] }, "signals: expected an object of stack signals"],
    ["an unknown signal", { units: [seedFor(0)], signals: { servesHTTP: true } }, "signals.servesHTTP: unknown field"],
    ["a mistyped boolean signal", { units: [seedFor(0)], signals: { servesHttp: "yes" } }, "signals.servesHttp: expected a boolean"],
    ["a mistyped list signal", { units: [seedFor(0)], signals: { languages: "ts" } }, "signals.languages: expected an array of strings"],
  ])("refuses %s, naming the field", async (_case, payload, expected) => {
    const run = aRun();
    const refused = await startWith(run, payload);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain(expected);
    // A refused start leaves no run behind.
    expect(existsSync(join(run.out, "run.json"))).toBe(false);
  });

  it("refuses a payload that is not JSON or not an object", async () => {
    const run = aRun();
    expect((await run.invoke([...STARTED, "--repo", run.out], "{nope")).error).toContain("start input is not valid JSON");
    expect((await run.invoke([...STARTED, "--repo", run.out], "[]")).error).toContain("start input must be an object");
  });

  it("records an explicit diff scope and defaults absent signals to none", async () => {
    const run = aRun();
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    expect((await startWith(run, { units: [seedFor(0)], scope: { kind: "diff", baseRef: base, headRef: head } })).error).toBeNull();
    const metadata = readJson<SecurityRunMetadata>(run.out, "run.json");
    expect(metadata.scope).toEqual({ paths: ["src/subsystem-0/entry.ts"], kind: "diff", baseRef: base, headRef: head });
    // No signals: only the always-included base lens.
    expect(metadata.selectedCompanions).toEqual(["ATTACK-CLASSES.md"]);
  });
});

// --- merge-critic ---

const aCritic = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1,
  kind: "security-coverage-critic",
  missingUnits: [],
  reassignIds: [],
  resolvedPriorLeads: [],
  stop: false,
  ...overrides,
});

/** The critic's proposal for the cell `seedFor(index)` describes. */
const aProposal = (index: number): Record<string, unknown> => {
  const seed = seedFor(index);
  return {
    refs: seed.refs,
    startingPaths: seed.starting_paths,
    ordinaryAttackClassBlock: seed.ordinary_attack_class_block,
    selectedCompanionBlocks: seed.selected_companion_blocks,
    excludedBlocks: [],
  };
};

/** A one-unit run whose unit has settled, so the critic may reassign it. */
const settledRun = async (unit: Record<string, unknown> = {}): Promise<Run> => {
  const run = aRun();
  await startOne(run);
  expect((await run.invoke(["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent"])).error).toBeNull();
  expect((await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE, units: [aUnitResult({ coverageId: unitIdFor(0), ...unit })] }))).error).toBeNull();
  return run;
};

describe("merge-critic", () => {
  it("accepts a bare critic document and seeds its proposals at the run's latest wave", async () => {
    const run = await settledRun();
    const merged = await run.invoke(["merge-critic"], JSON.stringify(aCritic({ missingUnits: [aProposal(1)] })));
    expect(merged.error).toBeNull();
    expect(run.stdout()).toContain("accepted 1 unit(s)");
    expect(run.stdout()).toContain("reassigned 0");
    expect(run.stdout()).toContain("resolved 0 prior lead(s)");
    expect(run.stdout()).toContain("critic stop: false");
    const added = readJson<CoverageUnit[]>(run.out, "ledger.json").find((unit) => unit.coverage_id === unitIdFor(1));
    expect(added?.status).toBe("planned");
    expect(added?.wave).toBe(1);
  });

  it("accepts a wrapped critic and archives the reassigned attempt under the critic's reason", async () => {
    const run = await settledRun();
    const reason = "The first pass never read the admin route.";
    const merged = await run.invoke(["merge-critic", "--wave", "1"], JSON.stringify({
      critic: aCritic({ reassignIds: [unitIdFor(0)] }),
      reassignmentReasons: { [unitIdFor(0)]: reason },
    }));
    expect(merged.error).toBeNull();
    expect(run.stdout()).toContain("reassigned 1");
    const [unit] = readJson<CoverageUnit[]>(run.out, "ledger.json");
    expect(unit!.status).toBe("planned");
    expect(unit!.wave).toBe(2);
    expect(unit!.attempts).toHaveLength(1);
    expect(unit!.attempts[0]!.reassignment_reason).toBe(reason);
    expect(unit!.attempts[0]!.agent_id).toBe("security-hunter-agent");
  });

  it("resolves a prior lead on the unit that carries it", async () => {
    const run = await settledRun({ status: "candidate", fingerprints: ["api/login:sqli-email"], unresolved: ["lead:admin-export"] });
    const merged = await run.invoke(["merge-critic"], JSON.stringify({
      critic: aCritic({ resolvedPriorLeads: ["lead:admin-export"] }),
      priorLeadOwners: { "lead:admin-export": unitIdFor(0) },
    }));
    expect(merged.error).toBeNull();
    expect(run.stdout()).toContain("resolved 1 prior lead(s)");
    expect(readJson<CoverageUnit[]>(run.out, "ledger.json")[0]!.unresolved).toEqual([]);
  });

  it("refuses a malformed critic document, naming the field", async () => {
    const run = await settledRun();
    const refused = await run.invoke(["merge-critic"], JSON.stringify({ critic: aCritic({ missingUnit: [] }) }));
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("critic.missingUnit: unknown field");
  });

  it.each([
    ["reasons that are not an object", { reassignmentReasons: ["why"] }, "reassignmentReasons: expected an object of string values"],
    ["a reason that is not a string", { reassignmentReasons: { [unitIdFor(0)]: 7 } }, `reassignmentReasons.${unitIdFor(0)}: expected a string`],
    ["owners that are not an object", { priorLeadOwners: "unit" }, "priorLeadOwners: expected an object of string values"],
    ["a wrapper key the merge does not read", { reasons: {} }, "reasons: unknown field"],
  ])("refuses %s instead of dropping it", async (_case, extra, expected) => {
    const run = await settledRun();
    const before = readFileSync(join(run.out, "ledger.json"), "utf8");
    const refused = await run.invoke(["merge-critic"], JSON.stringify({ critic: aCritic({ reassignIds: [unitIdFor(0)] }), ...extra }));
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain(expected);
    expect(readFileSync(join(run.out, "ledger.json"), "utf8")).toBe(before);
  });
});

// --- A reassigned unit is re-hunted under a fresh owner and still publishes ---

describe("a reassigned unit, end to end", () => {
  it("re-hunts under the minted owner and publishes with an independent ballot", async () => {
    const run = await settledRun();
    expect((await run.invoke(["merge-critic"], JSON.stringify({
      critic: aCritic({ reassignIds: [unitIdFor(0)] }),
      reassignmentReasons: { [unitIdFor(0)]: "The first pass never read the admin route." },
    }))).error).toBeNull();

    // The catalog agent is named again; the ledger mints the fresh owner.
    expect((await run.invoke(["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent"])).error).toBeNull();
    expect(run.stdout()).toContain(`assigned ${unitIdFor(0)} to owner security-hunter-agent--2 at wave 2`);

    const owner = "security-hunter-agent--2";
    const settled = await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE,
      units: [aUnitResult({
        coverageId: unitIdFor(0),
        agentId: owner,
        wave: 2,
        status: "candidate",
        fingerprints: ["api/login:sqli-email"],
        checks: [{
          agent_id: owner,
          reviewed_paths: ["src/api/login.ts"],
          invariant: "Every request field reaches the query as a bound parameter.",
          method: "source",
          result: "The `email` field is interpolated into the query string.",
          artifact: null,
        }],
      })],
      findings: [aConfirmedFinding()],
    }));
    expect(settled.error).toBeNull();

    await verifyWith(run);
    // The owner `security-hunter-agent--2` resolves to its catalog agent, so the
    // run can prove the ballot came from another profile — no
    // unresolvable-hunter refusal.
    const published = await run.invoke(["publish"]);
    expect(published.error).toBeNull();
    expect(readJson<SecurityFinding[]>(run.out, "security-findings.json").map((finding) => finding.verdict)).toEqual(["confirmed"]);
  });
});

// --- A submit retried after a failed ledger write converges ---

describe("a submit whose ledger write fails", () => {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it.skipIf(isRoot)("keeps the findings, leaves the units in flight, and a retry converges", async () => {
    const run = aRun();
    await startOne(run);
    await run.invoke(["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent", "--wave", "1"]);
    const payload = JSON.stringify({ ...HUNTER_ENVELOPE,
      units: [aUnitResult({ coverageId: unitIdFor(0), status: "candidate", fingerprints: ["api/login:sqli-email"] })],
      findings: [aConfirmedFinding()],
    });

    // The ledger stays readable but refuses the write: the second of the two
    // writes fails after the first landed.
    const ledger = join(run.out, "ledger.json");
    chmodSync(ledger, 0o444);
    try {
      const failed = await run.invoke(["submit"], payload);
      expect(failed.ok).toBe(false);
      expect(failed.error).toContain(`cannot write ${ledger}`);
    } finally {
      chmodSync(ledger, 0o644);
    }
    // Findings were written FIRST, so nothing filed was lost; the unit is still
    // in flight, so the retry can still settle it.
    expect(readJson<SecurityFinding[]>(run.out, "findings.json").map((finding) => finding.fingerprint)).toEqual(["api/login:sqli-email"]);
    expect(readJson<CoverageUnit[]>(run.out, "ledger.json")[0]!.status).toBe("in_progress");

    const retried = await run.invoke(["submit"], payload);
    expect(retried.error).toBeNull();
    expect(run.stdout()).toContain("run now holds 1 finding record(s)");
    expect(run.stdout()).not.toContain("not merged");
    expect(readJson<SecurityFinding[]>(run.out, "findings.json")).toHaveLength(1);
    expect(readJson<CoverageUnit[]>(run.out, "ledger.json")[0]!.status).toBe("candidate");
  });

  it("refuses a re-filed fingerprint whose record differs, before writing anything", async () => {
    const run = aRun();
    await run.invoke([...STARTED, "--repo", run.out], JSON.stringify({ units: nSeeds(2) }));
    await run.invoke(["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent", "--wave", "1"]);
    await run.invoke(["assign", "--unit", unitIdFor(1), "--agent", "security-hunter-agent", "--wave", "1"]);
    await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE,
      units: [aUnitResult({ coverageId: unitIdFor(0), status: "candidate", fingerprints: ["api/login:sqli-email"] })],
      findings: [aConfirmedFinding()],
    }));
    const before = ["ledger.json", "findings.json"].map((file) => readFileSync(join(run.out, file), "utf8"));

    // The conflicting submit ALSO carries a unit that would settle cleanly: the
    // refusal must come before the ledger write, not after it.
    const refiled = await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE,
      units: [aUnitResult({ coverageId: unitIdFor(1), reviewedPaths: ["src/api/login.ts"] })],
      findings: [aConfirmedFinding({ title: "A different title for the same defect" })],
    }));
    expect(refiled.ok).toBe(false);
    expect(refiled.error).toContain("filed findings refused");
    expect(refiled.error).toContain("the run already holds a different record for api/login:sqli-email");
    expect(refiled.error).toContain("re-file byte-identical");
    expect(["ledger.json", "findings.json"].map((file) => readFileSync(join(run.out, file), "utf8"))).toEqual(before);
    expect(readJson<CoverageUnit[]>(run.out, "ledger.json").find((unit) => unit.coverage_id === unitIdFor(1))?.status).toBe("in_progress");
  });

  it("keeps one copy of a verbatim re-file, whatever its key order", async () => {
    const run = aRun();
    await startOne(run);
    await run.invoke(["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent", "--wave", "1"]);
    expect((await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE, units: [], findings: [aConfirmedFinding()] }))).error).toBeNull();
    const reordered = Object.fromEntries(Object.entries(aConfirmedFinding()).reverse());
    const again = await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE, units: [], findings: [reordered] }));
    expect(again.error).toBeNull();
    expect(readJson<SecurityFinding[]>(run.out, "findings.json")).toHaveLength(1);
  });
});
