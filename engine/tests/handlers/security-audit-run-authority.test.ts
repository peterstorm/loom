/**
 * The security-audit run directory as the subagent write guard sees it
 * (ADR-0067 D6), driven through the real CLI handler:
 *
 *  - ONE owner of the run's entry names (`core/audit-run-authority.ts`): every
 *    entry a full audit run writes, and every runs root it names, is an
 *    authority entry the guard refuses a subagent's write onto;
 *  - every WRITING operation re-registers the run before it writes, so a
 *    registry wiped mid-audit is rebuilt — and an operation whose run cannot be
 *    registered writes nothing.
 */

import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SECURITY_AUDIT_AUTHORITY_ENTRIES,
  SECURITY_AUDIT_DISPOSITION_RUNS_DIR,
  SECURITY_AUDIT_RUN_FILES,
  SECURITY_AUDIT_VERIFICATION_RUNS_DIR,
} from "../../src/core/audit-run-authority";
import { dispositionHandoffPaths } from "../../src/core/security-disposition";
import { decideSubagentAuthority } from "../../src/core/subagent-authority";
import { verificationRunsRoot } from "../../src/handlers/helpers/security-audit-run";
import {
  SECURITY_AUDIT_OPERATION_ORDER,
  securityAuditOperationWrites,
  type SecurityAuditOperation,
} from "../../src/handlers/helpers/security-audit-operations";
import { AUTHORITY_HELPER_OPERATIONS, HARNESS_HOOK_ROUTES } from "../../src/handlers/pre-tool-use/subagent-authority-operations";
import { GUARD_FILESYSTEM } from "../../src/handlers/pre-tool-use/guard-subagent-authority";
import { registeredSecurityAuditRuns } from "../../src/orchestration/security-audit-run-registry";
import { securityAuditRunRegistryDir } from "../../src/config";
import { HUNTER_ENVELOPE, aConfirmedFinding, aUnitResult } from "../security/fixtures";
import { verifyWith } from "./security-verification-harness";
import { aRun, isolateSubagentDir, removeRuns, seedFor, unitIdFor, writeArtifact, type Run } from "./security-audit-harness";

beforeEach(() => { isolateSubagentDir(); });
afterEach(removeRuns);

const startRun = async (run: Run): Promise<void> => {
  const started = await run.invoke(["start", "--repo", run.out, "--source", "0".repeat(40), "--profile", "standard"],
    JSON.stringify({ units: [seedFor(0)] }));
  expect(started.error).toBeNull();
};

/** A whole audit through the CLI: start → assign → submit → ballots → publish → disposition. */
const completeRun = async (run: Run): Promise<void> => {
  await startRun(run);
  expect((await run.invoke(["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent", "--wave", "1"])).error).toBeNull();
  writeArtifact(run, "agents/security-hunter-agent/scratch/notes.txt", "hunter working space");
  expect((await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE,
    units: [aUnitResult({ coverageId: unitIdFor(0), status: "candidate", fingerprints: ["api/login:sqli-email"] })],
    findings: [aConfirmedFinding()],
  }))).error).toBeNull();
  await verifyWith(run);
  expect((await run.invoke(["publish"])).error).toBeNull();
  expect((await run.invoke(["disposition"])).error).toBeNull();
};

/** The guard's decision for a subagent writing `entry` under the registered run. */
const subagentWrite = (runDirectory: string, entry: string): string => {
  const decision = decideSubagentAuthority(`echo forged > ${join(runDirectory, entry)}`, {
    cwd: "/repo",
    home: "/home/u",
    runs: { kind: "known", directories: registeredSecurityAuditRuns() },
    protectedDirectories: [],
    helperOperations: AUTHORITY_HELPER_OPERATIONS,
    hookRoutes: HARNESS_HOOK_ROUTES,
    filesystem: GUARD_FILESYSTEM,
  });
  return decision.kind === "allow" ? "allow" : decision.refusal.rule;
};

describe("one owner of the run directory's entry names", () => {
  it("authority entries are exactly the owner's documents plus both runs roots", () => {
    expect([...SECURITY_AUDIT_AUTHORITY_ENTRIES].sort()).toEqual([
      ...Object.values(SECURITY_AUDIT_RUN_FILES),
      SECURITY_AUDIT_VERIFICATION_RUNS_DIR,
      SECURITY_AUDIT_DISPOSITION_RUNS_DIR,
    ].sort());
  });

  it("the runs roots and handoff file the CLI names are the owner's names", () => {
    const paths = dispositionHandoffPaths("/audits/run-1", "rid");
    expect(paths.runsRoot).toBe(`/audits/run-1/${SECURITY_AUDIT_DISPOSITION_RUNS_DIR}`);
    expect(paths.inputFile).toBe(`/audits/run-1/${SECURITY_AUDIT_RUN_FILES.dispositionHandoff}`);
    expect(basename(verificationRunsRoot("/audits/run-1"))).toBe(SECURITY_AUDIT_VERIFICATION_RUNS_DIR);
  });

  it("every entry a full audit writes is an authority entry the guard protects", async () => {
    const run = aRun();
    await completeRun(run);
    const out = realpathSync(run.out);
    const written = readdirSync(out).filter((entry) => entry !== "agents").sort();
    // Not vacuous: the lifecycle wrote every document, the handoff and the runs root.
    expect(written).toEqual([...Object.values(SECURITY_AUDIT_RUN_FILES), SECURITY_AUDIT_VERIFICATION_RUNS_DIR].sort());
    for (const entry of written) {
      expect(SECURITY_AUDIT_AUTHORITY_ENTRIES, entry).toContain(entry);
      expect(subagentWrite(out, entry), entry).toBe("authority-path-write");
    }
    // The runs root the handoff command names, before remediation creates it.
    expect(subagentWrite(out, `${SECURITY_AUDIT_DISPOSITION_RUNS_DIR}/run.disposition-x/result.json`)).toBe("authority-path-write");
    expect(subagentWrite(out, `${SECURITY_AUDIT_VERIFICATION_RUNS_DIR}/run.verify-w1-x/result.json`)).toBe("authority-path-write");
    // The hunter's own working space stays writable.
    expect(subagentWrite(out, "agents/security-hunter-agent/scratch/notes.txt")).toBe("allow");
  });
});

const WRITERS_AFTER_START: readonly SecurityAuditOperation[] =
  SECURITY_AUDIT_OPERATION_ORDER.filter((operation) => operation !== "start" && securityAuditOperationWrites(operation));
const READERS: readonly SecurityAuditOperation[] =
  SECURITY_AUDIT_OPERATION_ORDER.filter((operation) => !securityAuditOperationWrites(operation));

/** Minimal flags per operation: enough to reach the handler; the operation
 *  itself may refuse on domain grounds — registration happens first. */
const ARGS: Readonly<Record<SecurityAuditOperation, readonly string[]>> = {
  start: [],
  assign: ["--unit", "nope", "--agent", "security-hunter-agent"],
  nonce: ["--artifact", "agents/x/artifacts/y"],
  submit: [],
  defer: ["--reason", "out of scope"],
  "merge-critic": [],
  verify: ["--from", "run.verify-w1-missing"],
  findings: [],
  publish: [],
  disposition: [],
  status: [],
};

describe("every writing operation refreshes the run registry (ADR-0067 D6)", () => {
  it("covers every writer the table declares", () => {
    expect(WRITERS_AFTER_START).toEqual(["assign", "submit", "defer", "merge-critic", "verify", "publish", "disposition"]);
  });

  it.each(WRITERS_AFTER_START)("%s re-registers a run whose registry was wiped mid-audit", async (operation) => {
    const run = aRun();
    await startRun(run);
    rmSync(securityAuditRunRegistryDir(), { recursive: true, force: true });
    expect(registeredSecurityAuditRuns()).toEqual([]);
    await run.invoke([operation, ...ARGS[operation]], "{}");
    expect(registeredSecurityAuditRuns()).toEqual([realpathSync(run.out)]);
  });

  it.each(READERS)("%s (read-only) registers nothing", async (operation) => {
    const run = aRun();
    await startRun(run);
    rmSync(securityAuditRunRegistryDir(), { recursive: true, force: true });
    await run.invoke([operation, ...ARGS[operation]]);
    expect(registeredSecurityAuditRuns()).toEqual([]);
  });

  it("a directory that holds no run is not registered", async () => {
    const run = aRun();
    const refused = await run.invoke(["defer", "--reason", "x"]);
    expect(refused.ok).toBe(false);
    expect(registeredSecurityAuditRuns()).toEqual([]);
  });

  it("refuses the operation, writing nothing, when the run cannot be registered", async () => {
    const run = aRun();
    await startRun(run);
    const ledger = readFileSync(join(run.out, SECURITY_AUDIT_RUN_FILES.ledger), "utf8");
    // A plain file where the registry directory must be: registration fails.
    rmSync(securityAuditRunRegistryDir(), { recursive: true, force: true });
    mkdirSync(join(securityAuditRunRegistryDir(), ".."), { recursive: true });
    writeFileSync(securityAuditRunRegistryDir(), "not a directory");

    const refused = await run.invoke(["defer", "--reason", "out of scope"]);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("defer refused");
    expect(refused.error).toContain("subagent write guard");
    expect(readFileSync(join(run.out, SECURITY_AUDIT_RUN_FILES.ledger), "utf8")).toBe(ledger);
  });
});
