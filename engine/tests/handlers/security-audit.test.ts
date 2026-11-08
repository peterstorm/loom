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

import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSecurityAuditHandler } from "../../src/handlers/helpers/security-audit";
import { piRuntimeHandshakeRequired, routeConsumesStdin } from "../../src/handler-routes";
import { SECURITY_AUDIT_OPERATIONS, SECURITY_AUDIT_OPERATION_ORDER, parseSecurityAuditOperation, securityAuditOperationWrites } from "../../src/handlers/helpers/security-audit-operations";
import {
  SECURITY_AUDIT_LIMITS,
  canonicalCoverageId,
  type SecurityRunMetadata,
} from "../../src/core/security-audit-contract";
import type { CoverageUnit } from "../../src/core/security-coverage";
import type { SecurityFinding } from "../../src/core/security-findings";
import type { VerificationVerdict } from "../../src/core/security-adjudication";
import { aConfirmedFinding, aHunterBallot, aNeedsValidationFinding, aSeed, aUnitResult, aVerdict, nSeeds } from "../security/fixtures";

type Run = Readonly<{ out: string; stdout: () => string; invoke: (args: readonly string[], stdin?: string) => Promise<{ ok: boolean; error: string | null }> }>;

let dirs: string[] = [];

function aRun(): Run {
  const out = mkdtempSync(join(tmpdir(), "loom-security-audit-"));
  dirs.push(out);
  let printed = "";
  const handler = createSecurityAuditHandler((text) => { printed += `${text}\n`; });
  return {
    out,
    stdout: () => printed,
    invoke: async (args, stdin = "") => {
      // Each invocation starts a fresh buffer: these tests assert on ONE
      // command's output, never on the accumulated transcript.
      printed = "";
      const result = await handler(stdin, [args[0] ?? "", "--out", out, ...args.slice(1)]);
      return { ok: result?.kind !== "error", error: result?.kind === "error" ? String(result.message ?? "") : null };
    },
  };
}

const readJson = <T>(out: string, file: string): T => JSON.parse(readFileSync(join(out, file), "utf8")) as T;

/** The unit ids and their canonical refs are derived from the same seed list a
 *  `start` call receives, so a test names a unit by its coordinate tuple. */
const seedFor = (index: number) => nSeeds(index + 1)[index];
const unitIdFor = (index: number): string => {
  const seed = seedFor(index);
  return canonicalCoverageId(seed.refs as Parameters<typeof canonicalCoverageId>[0]);
};

beforeEach(() => { dirs = []; });
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

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
    expect(available).toEqual(["findings", "status"]);
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

    const submitted = await run.invoke(["submit"], JSON.stringify({
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

    expect((await run.invoke(["verify"], JSON.stringify({ verdicts: [aVerdict()] }))).error).toBeNull();

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
    const wrong = await run.invoke(["submit"], JSON.stringify({
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
    await run.invoke(["submit"], JSON.stringify({
      units: [aUnitResult({ coverageId: unitIdFor(0), status: "candidate", fingerprints: ["api/login:sqli-email"] })],
      findings: [aConfirmedFinding()],
    }));
  };

  it("demotes a claim to a lead when the ballot names a missing fact", async () => {
    const run = aRun();
    await seedAndSubmitClaim(run);
    await run.invoke(["verify"], JSON.stringify({
      verdicts: [aVerdict({ vote: "advisory", missingFact: "The deployment may bind the value upstream." })],
    }));
    expect((await run.invoke(["publish"])).error).toBeNull();
    const published = readJson<SecurityFinding[]>(run.out, "security-findings.json");
    expect(published.map((finding) => finding.verdict)).toEqual(["needs_validation"]);
    expect(published[0].verdict === "needs_validation" ? published[0].blockers : []).toEqual(["The deployment may bind the value upstream."]);
  });

  it("rejects a claim when the ballot refutes it outright", async () => {
    const run = aRun();
    await seedAndSubmitClaim(run);
    await run.invoke(["verify"], JSON.stringify({ verdicts: [aVerdict({ vote: "advisory", missingFact: null })] }));
    expect((await run.invoke(["publish"])).error).toBeNull();
    expect(readJson<SecurityFinding[]>(run.out, "security-findings.json").map((finding) => finding.verdict)).toEqual(["rejected"]);
  });

  it("refuses a ballot cast by the hunter that filed the claim", async () => {
    const run = aRun();
    await seedAndSubmitClaim(run);
    // The hunter's own ballot: its agent AND its catalog profile. This is the
    // shape INV-S3 exists to refuse, and the one the budget-profile comparison
    // let through.
    const verified = await run.invoke(["verify"], JSON.stringify({ verdicts: [aHunterBallot()] }));
    expect(verified.ok).toBe(true);
    const blocked = await run.invoke(["publish"]);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("verified only on the hunt profile");
  });

  it("refuses a ballot whose profile is not the one its agent sits on", async () => {
    const run = aRun();
    await seedAndSubmitClaim(run);
    // A hunter cannot borrow the verifier's profile by writing it down.
    const refused = await run.invoke(["verify"], JSON.stringify({
      verdicts: [aVerdict({ agent: "security-hunter-agent", profile: "refutation" })],
    }));
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("sits on profile focused-review");
  });

  it("accumulates ballots across waves instead of replacing them", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40), "--profile", "standard"], JSON.stringify({ units: nSeeds(2) }));
    await run.invoke(["verify"], JSON.stringify({ verdicts: [aVerdict({ fingerprint: "a:one" })] }));
    await run.invoke(["verify"], JSON.stringify({ verdicts: [aVerdict({ fingerprint: "b:two", wave: 3 })] }));
    const verdicts = readJson<VerificationVerdict[]>(run.out, "verdicts.json");
    expect(verdicts.map((verdict) => verdict.fingerprint)).toEqual(["a:one", "b:two"]);
  });

  it("passes a hunter's own lead and rejection through untouched", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40), "--profile", "standard"], JSON.stringify({ units: [seedFor(0)] }));
    await run.invoke(["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent", "--wave", "1"]);
    const submitted = await run.invoke(["submit"], JSON.stringify({
      units: [aUnitResult({ coverageId: unitIdFor(0), status: "covered" })],
      findings: [aNeedsValidationFinding(), aConfirmedFinding()],
    }));
    expect(submitted.error).toBeNull();
    await run.invoke(["verify"], JSON.stringify({ verdicts: [aVerdict()] }));
    expect((await run.invoke(["publish"])).error).toBeNull();
    const published = readJson<SecurityFinding[]>(run.out, "security-findings.json");
    expect(published.map((finding) => finding.verdict).sort()).toEqual(["confirmed", "needs_validation"]);
  });
});

describe("the wire", () => {
  it("refuses a submit payload with no units and no findings", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: [seedFor(0)] }));
    const empty = await run.invoke(["submit"], JSON.stringify({}));
    expect(empty.ok).toBe(false);
    expect(empty.error).toContain("neither unit results nor findings");
  });

  it("names the offending field when a unit result is malformed", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: [seedFor(0)] }));
    const malformed = await run.invoke(["submit"], JSON.stringify({ units: [aUnitResult({ status: "maybe" })] }));
    expect(malformed.ok).toBe(false);
    expect(malformed.error).toContain("units[0].status");
  });

  it("refuses a verdict with an invented field", async () => {
    const run = aRun();
    await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40)], JSON.stringify({ units: [seedFor(0)] }));
    const invented = await run.invoke(["verify"], JSON.stringify({ verdicts: [aVerdict({ invented: "high" })] }));
    expect(invented.ok).toBe(false);
    expect(invented.error).toContain("unknown field");
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
    await run.invoke(["submit"], JSON.stringify({
      units: [aUnitResult({ coverageId: unitIdFor(0), status: "candidate", fingerprints: ["api/login:sqli-email"] })],
      findings: [aConfirmedFinding()],
    }));
    await run.invoke(["verify"], JSON.stringify({ verdicts: [aVerdict()] }));
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
    expect(report).toContain(`standalone-disposition --run ${run.out}`);
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
