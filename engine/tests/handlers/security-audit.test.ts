/**
 * The security-audit helper, driven the way an operator and an agent drive it.
 *
 * These tests cross the seam the CLI actually exposes — `helper security-audit
 * <op> --out <dir>` with a stdin payload — rather than calling the pure cores.
 * The cores are already covered by `tests/security/*`; what is at stake here is
 * the program's own invariants: a closed action set, and a run that moves only
 * through it.
 *
 * The suite is split by concern; each sibling drives the same harness
 * (`security-audit-harness.ts`, which owns the run lifecycle):
 *
 *   security-audit.test.ts                 the operation set, a full run, routing, budget, status
 *   security-audit-wire.test.ts            stdin and flag payloads, parsed rather than coerced
 *   security-audit-run-directory.test.ts   fail-closed reads, missing runs, symlinked bases
 *   security-audit-settlement.test.ts      settlement, merge-critic, reassignment, submit retry
 *   security-audit-publication.test.ts     adjudication, the disposition handoff, a closed run
 *   security-audit-evidence.test.ts        local-check receipts, --force, the nonce
 *   security-audit-run-authority.test.ts   the run directory as the subagent write guard sees it
 *   security-audit-command-contract.test.ts the command and operator guide bound to the table
 */

import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { piRuntimeHandshakeRequired, routeConsumesStdin } from "../../src/handler-routes";
import { SECURITY_AUDIT_OPERATIONS, SECURITY_AUDIT_OPERATION_ORDER, parseSecurityAuditOperation, securityAuditOperationWrites } from "../../src/handlers/helpers/security-audit-operations";
import { SECURITY_AUDIT_LIMITS, type SecurityRunMetadata } from "../../src/core/security-audit-contract";
import type { CoverageUnit } from "../../src/core/security-coverage";
import type { SecurityFinding } from "../../src/core/security-findings";
import { nSeeds } from "../security/fixtures";
import { SOURCE, SQLI, aRun, claimPayload, isolateSubagentDir, readJson, removeRuns, seedFor, startInvocation, startRun, unitIdFor } from "./security-audit-harness";
import { verifyWith } from "./security-verification-harness";

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

  // The writers and the skew-available projections are asserted once each:
  // the explicit writer list in security-audit-run-authority.test.ts, the
  // projections in security-audit-command-contract.test.ts (which also binds
  // the command's prose to them).

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
      ["start", "--repo", run.out, "--source", SOURCE, "--profile", "standard", "--budget", "12"],
      JSON.stringify({ units: [seedFor(0)], signals: { languages: ["typescript"], servesHttp: true } }),
    );
    expect(started.error).toBeNull();

    const metadata = readJson<SecurityRunMetadata>(run.out, "run.json");
    expect(metadata.profile).toBe("standard");
    expect(metadata.sourceRef).toEqual({ commit: SOURCE, worktreeDirty: false });
    expect(metadata.scopePaths).toEqual(["src/subsystem-0/entry.ts"]);
    expect(metadata.selectedCompanions.length).toBeGreaterThan(0);
    expect(readJson<CoverageUnit[]>(run.out, "ledger.json")[0].status).toBe("planned");

    expect((await run.invoke(["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent", "--wave", "1"])).error).toBeNull();
    const assigned = readJson<CoverageUnit[]>(run.out, "ledger.json")[0];
    expect(assigned.status).toBe("in_progress");
    expect(assigned.agent_id).toBe("security-hunter-agent");

    const submitted = await run.invoke(["submit"], claimPayload(0));
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
    expect(readFileSync(join(run.out, "REPORT.md"), "utf8")).toContain(SQLI);
  });

  it("refuses to restart a run directory unless forced", async () => {
    const run = aRun();
    const { args, stdin } = startInvocation(run);
    expect((await run.invoke(args, stdin)).error).toBeNull();
    const second = await run.invoke(args, stdin);
    expect(second.ok).toBe(false);
    expect(second.error).toContain("--force");
    expect((await run.invoke([...args, "--force"], stdin)).error).toBeNull();
  });
});

describe("budget", () => {
  it("refuses a budget below what the wave needs", async () => {
    const run = aRun();
    const tooSmall = await run.invoke(
      ["start", "--repo", run.out, "--source", SOURCE, "--budget", "1"],
      JSON.stringify({ units: nSeeds(SECURITY_AUDIT_LIMITS.units > 4 ? 4 : 2) }),
    );
    expect(tooSmall.ok).toBe(false);
    expect(tooSmall.error ?? "").toContain("budget");
  });

  it("refuses a non-positive budget", async () => {
    const run = aRun();
    const bad = await run.invoke(["start", "--repo", run.out, "--source", SOURCE, "--budget", "0"], JSON.stringify({ units: [seedFor(0)] }));
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
    const run = await startRun(aRun());
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

describe("status derives the run's status from the ledger", () => {
  it("reports a settled, deferred run as incomplete although run.json still says in_progress", async () => {
    const run = await startRun(aRun());
    expect((await run.invoke(["defer", "--reason", "critic_budget_exhausted"])).error).toBeNull();
    // `run.json` is only rewritten by start and publish, so its copy is stale.
    expect(readJson<SecurityRunMetadata>(run.out, "run.json").runStatus).toBe("in_progress");

    expect((await run.invoke(["status", "--json"])).error).toBeNull();
    const report = JSON.parse(run.stdout()) as { runStatus: string; incompleteReason: string | null };
    expect(report.runStatus).toBe("incomplete");
    expect(report.incompleteReason).toBe("critic_budget_exhausted");
  });

  it("reports an unset budget and an empty run without inventing numbers", async () => {
    const run = await startRun(aRun());
    const status = await run.invoke(["status", "--json"]);
    expect(status.ok).toBe(true);
    const report = JSON.parse(run.stdout()) as Record<string, unknown>;
    expect(report.publicationBlockers).toEqual(["coverage ledger still has planned, in-progress or blocked units"]);
    expect((report.findings as { records: number }).records).toBe(0);
    expect((report.coverage as { complete: boolean }).complete).toBe(false);
  });
});
