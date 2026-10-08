import { existsSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitResult } from "../../../fixtures/git-repository";
import { disposeFixturePiSessions, withFixturePiSession } from "../../../fixtures/pi-session";
import { addRepairTest, CHECK_ID, hash, publishedSuccessorForRemediation, repairDeclaration,
  REPORT_PATH, successorRemediationRepository } from "../../../fixtures/standalone-successor-remediation";
import { value } from "../../../fixtures/parse-result";

const roots: string[] = [];
const operations = new Set<Promise<void>>();
function owned(operation: (root: string) => Promise<void>): Promise<void> {
  const root = successorRemediationRepository(); roots.push(root);
  const pending = withFixturePiSession(root, () => operation(root));
  const settled = pending.then(() => undefined, () => undefined);
  operations.add(settled); void settled.then(() => operations.delete(settled));
  return pending;
}
afterEach(async () => {
  await Promise.all([...operations]);
  disposeFixturePiSessions();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
type Fixture = Awaited<ReturnType<typeof publishedSuccessorForRemediation>>;
function preflight(f: Fixture, run: string, defectFamily: unknown, supportPaths: readonly string[] = []) {
  return f.remediation.prepareRemediationFacadeStart({ input: { sourceRunsRoot: f.runsRoot, sourceRun: f.successor.runId, supportPaths, defectFamily },
    repositoryStartPath: f.root, remediationRunsRoot: f.runsRoot, remediationRun: run });
}
function expectPreserved(f: Fixture) {
  expect(readFileSync(join(f.source.runDirectory, "result.json"))).toEqual(f.originalBytes);
  expect(readFileSync(join(f.successor.runDirectory, "result.json"))).toEqual(f.bytes);
}

async function expectInstalled(f: Fixture, run: string, declaration: unknown, supportPaths: readonly string[], status: "not-required" | "repair-checked") {
  const prepared = value(await preflight(f, run, declaration, supportPaths));
  expect(prepared.registration.schemaVersion).toBe(2);
  expect(prepared.registration.source.inventory.sourceVersion).toBe(3);
  expect(prepared.registration.source.inventory.sourceResultJson).toBe(f.bytes.toString());
  expect(prepared.registration.source.resultDigest).toBe(hash(f.bytes));
  const candidate = readFileSync(join(f.root, "src/repair.mjs"));
  const manifest = readFileSync(join(f.root, ".loom/verification-manifest.json"));
  const handle = value(f.handles.createRunDirectory(f.runsRoot, run));
  const done = await f.remediation.startRemediationFacade(handle, prepared.registration);
  expect(done).toMatchObject({ ok: true, action: { kind: "done", outcome: { kind: "remediation-installed",
    installation: { kind: "verified-index-installed" }, defectFamilyAssessment: { status } } } });
  if (!done.ok) throw Error(done.message);
  const outcome = (done.action as { outcome: { installation: { indexDigest: string }; defectFamilyAssessment: unknown } }).outcome;
  const index = readFileSync(join(f.root, ".git/index"));
  expect(outcome.installation.indexDigest).toBe(hash(Buffer.from(gitResult(f.root, ["ls-files", "--stage", "-z"]).stdout)));
  expect(gitResult(f.root, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n")).toEqual(["src/repair.mjs", ...supportPaths]);
  expect(Buffer.from(gitResult(f.root, ["show", ":src/repair.mjs"]).stdout)).toEqual(candidate);
  for (const path of supportPaths) expect(Buffer.from(gitResult(f.root, ["show", `:${path}`]).stdout)).toEqual(readFileSync(join(f.root, path)));
  expect(readFileSync(join(f.root, "src/repair.mjs"))).toEqual(candidate);
  expect(readFileSync(join(f.root, ".loom/verification-manifest.json"))).toEqual(manifest);
  const checkpointBytes = readFileSync(join(handle.runDirectory, "checkpoint.json"));
  const checkpoint = JSON.parse(checkpointBytes.toString());
  expect(checkpoint.state.authority.sourceResultJson).toBe(f.bytes.toString());
  expect(checkpoint.state.authority.sourceResultDigest).toBe(hash(f.bytes));
  expect(checkpoint.state.authority.sourcePublicationAuthority.publicationReceipt)
    .toEqual(value(await f.sourceReader.readAuthenticatedStandaloneSource(f.runsRoot, f.successor.runId)).publicationReceipt);
  const events = await handle.readEvents();
  const resumed = await f.remediation.resumeRemediationFacade(handle, prepared.registration);
  expect(resumed).toEqual(done);
  expect(await handle.readEvents()).toEqual(events);
  expect(readFileSync(join(f.root, ".git/index"))).toEqual(index);
  expect(readFileSync(join(handle.runDirectory, "checkpoint.json"))).toEqual(checkpointBytes);
  expectPreserved(f);
  return { handle, events, outcome, prepared };
}

describe.sequential("owned v3 source → actual guarded P3 installation", { timeout: 60_000 }, () => {
  it("installs genuine not-required with complete coverage and retains full resolved/refuted/advisory lineage", () => owned(async root => {
    const f = await publishedSuccessorForRemediation(root, "complete");
    unlinkSync(join(f.successor.runDirectory, "checkpoint.json")); // P3 must replay actual captures, not trust LC-2 checkpoint.
    const source = value(await f.sourceReader.readAuthenticatedStandaloneSource(f.runsRoot, f.successor.runId));
    expect(source.result.schemaVersion).toBe(3);
    if (source.result.schemaVersion !== 3) throw Error("v3 source required");
    expect(source.result.lineage.currentCriticalCoverage).toEqual({ kind: "complete", origins: [] });
    expect(source.result.lineage.counts).toMatchObject({ new: 0, inherited: 4, survivingCritical: 0, resolved: 2, refutedCritical: 1, advisory: 1 });
    expect(source.result.panel).toBeNull();
    const inventory = value(f.accounting.prepareDefectFamilyAccounting(source.result, { kind: "not-required" })).source;
    expect(inventory.sourceResultJson).toBe(f.bytes.toString());
    expect(JSON.parse(inventory.sourceResultJson!).lineage).toEqual(source.result.lineage);
    expect(JSON.parse(inventory.sourceResultJson!).successor).toEqual(source.result.successor);
    const installed = await expectInstalled(f, "not-required", { kind: "not-required" }, [], "not-required");
    expect(installed.events).toEqual([]);
    expect(installed.prepared.registration.verification.kind).toBe("not-required");
    expect(existsSync(join(root, REPORT_PATH))).toBe(false);
    expect(existsSync(join(f.successor.runDirectory, "checkpoint.json"))).toBe(false);
  }));

  it("requires original-ID accounting and a fresh operator-owned JUnit check for an inherited blocker with no fresh panel", () => owned(async root => {
    const f = await publishedSuccessorForRemediation(root, "active");
    const source = value(await f.sourceReader.readAuthenticatedStandaloneSource(f.runsRoot, f.successor.runId));
    if (source.result.schemaVersion !== 3) throw Error("v3 source required");
    const id = source.result.survivingCriticals[0]!.id;
    expect(id).toBe(f.originalLineage.inventory[0]!.finding.id);
    expect(source.result.panel).toBeNull();
    expect(value(f.successor.readIssuedRequests()).every(request => request.program === "standalone-review")).toBe(true);
    expect(source.result.lineage.counts).toMatchObject({ new: 0, survivingCritical: 1, resolved: 1 });
    expect(source.result.lineage.inventory[0]).toEqual(f.originalLineage.inventory[0]);
    const indexBefore = readFileSync(join(root, ".git/index"));
    const refused = await preflight(f, "not-required-refused", { kind: "not-required" });
    expect(refused.ok).toBe(false);
    expect(existsSync(join(f.runsRoot, "not-required-refused"))).toBe(false);
    for (const row of f.originalLineage.inventory.slice(1)) {
      expect(f.accounting.prepareDefectFamilyAccounting(source.result, repairDeclaration(row.finding.id)).ok).toBe(false);
    }
    expect(readFileSync(join(root, ".git/index"))).toEqual(indexBefore);
    addRepairTest(root);
    const oldReport = '<testsuite tests="999" failures="0"/>';
    writeFileSync(join(root, REPORT_PATH), oldReport);
    const installed = await expectInstalled(f, "repair-checked", repairDeclaration(id), ["tests/repair.test.mjs"], "repair-checked");
    expect(installed.prepared.registration.source.inventory.survivingCriticals.map(row => row.id)).toEqual([id]);
    expect(installed.prepared.registration.verification).toMatchObject({ kind: "selected-operator-checks", checks: [{ command: {
      checkId: CHECK_ID, executable: "node", args: ["--test", "--test-reporter=junit", `--test-reporter-destination=${REPORT_PATH}`, "tests/repair.test.mjs"],
      reportPolicy: { kind: "required-file", path: REPORT_PATH }, timeoutMs: 15000,
    } }] });
    expect(installed.events).toHaveLength(1);
    expect(installed.events[0]).toMatchObject({ event: { kind: "remediation-check-observed", checkId: CHECK_ID,
      process: { kind: "observed", exitCode: 0, timedOut: false, signal: null }, report: { kind: "produced" } } });
    expect(installed.outcome.defectFamilyAssessment).toMatchObject({ status: "repair-checked", repairedChecks: [{ checkId: CHECK_ID,
      report: { summary: { total: 1, failed: 0 } } }] });
    expect(readFileSync(join(root, REPORT_PATH), "utf8")).not.toBe(oldReport);
    const after = value(await f.sourceReader.readAuthenticatedStandaloneSource(f.runsRoot, f.successor.runId));
    expect(after.result).toEqual(source.result); // Repair-Checked never creates semantic resolution.
  }));

  it("preserves actual v2 P3 registration, exact source bytes and repair-checked installation behavior", () => owned(async root => {
    const f = await publishedSuccessorForRemediation(root, "complete");
    const source = value(await f.sourceReader.readAuthenticatedStandaloneSource(f.runsRoot, f.source.runId));
    expect(source.result.schemaVersion).toBe(2);
    addRepairTest(root);
    const declaration = repairDeclaration(source.result.survivingCriticals.map(row => row.id));
    const prepared = value(await f.remediation.prepareRemediationFacadeStart({ input: { sourceRunsRoot: f.runsRoot,
      sourceRun: f.source.runId, supportPaths: ["tests/repair.test.mjs"], defectFamily: declaration },
      repositoryStartPath: root, remediationRunsRoot: f.runsRoot, remediationRun: "v2-compatible" }));
    expect(prepared.registration.schemaVersion).toBe(2);
    expect(prepared.registration.source.inventory).not.toHaveProperty("sourceVersion");
    expect(prepared.registration.source.inventory).not.toHaveProperty("sourceResultJson");
    expect(prepared.registration.source.resultDigest).toBe(hash(f.originalBytes));
    const handle = value(f.handles.createRunDirectory(f.runsRoot, "v2-compatible"));
    const done = await f.remediation.startRemediationFacade(handle, prepared.registration);
    expect(done).toMatchObject({ ok: true, action: { kind: "done", outcome: { defectFamilyAssessment: { status: "repair-checked" } } } });
    const checkpoint = JSON.parse(readFileSync(join(handle.runDirectory, "checkpoint.json"), "utf8"));
    expect(checkpoint.state.authority.sourceResultJson).toBe(f.originalBytes.toString());
    expect(checkpoint.state.receipt.indexDigest).toBe(hash(Buffer.from(gitResult(root, ["ls-files", "--stage", "-z"]).stdout)));
    expect(gitResult(root, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n")).toEqual(["src/repair.mjs", "tests/repair.test.mjs"]);
    expect(await f.remediation.resumeRemediationFacade(handle, prepared.registration)).toEqual(done);
    expect(await handle.readEvents()).toHaveLength(1);
    expectPreserved(f);
  }));

  it("refuses critical coverage limitations with zero active criticals before Run, candidate or check authority", () => owned(async root => {
    const f = await publishedSuccessorForRemediation(root, "limited");
    const source = value(await f.sourceReader.readAuthenticatedStandaloneSource(f.runsRoot, f.successor.runId));
    if (source.result.schemaVersion !== 3) throw Error("v3 source required");
    expect(source.result.survivingCriticals).toEqual([]);
    expect(source.result.lineage.currentCriticalCoverage.kind).toBe("limited");
    expect(source.result.lineage.counts.currentCriticalCoverageLimited).toBe(1);
    const index = readFileSync(join(root, ".git/index"));
    const before = readdirSync(f.runsRoot);
    const refused = await f.remediation.prepareRemediationFacadeStart({ input: { sourceRunsRoot: f.runsRoot, sourceRun: f.successor.runId,
      supportPaths: [], defectFamily: { kind: "not-required" } }, repositoryStartPath: join(root, "missing-repository"),
      remediationRunsRoot: f.runsRoot, remediationRun: "limited-refused" });
    expect(refused).toMatchObject({ ok: false, message: expect.stringContaining("current critical coverage is limited") });
    expect(readdirSync(f.runsRoot)).toEqual(before);
    expect(readFileSync(join(root, ".git/index"))).toEqual(index);
    expect(existsSync(join(root, REPORT_PATH))).toBe(false);
    expectPreserved(f);
  }));

  it.each(["bytes", "receipt", "capture-receipt", "missing-cli-receipt"] as const)("refuses wrong exact source %s at the actual authenticated preflight join", mode => owned(async root => {
    const f = await publishedSuccessorForRemediation(root, "complete");
    const index = readFileSync(join(root, ".git/index"));
    const path = mode === "bytes" ? join(f.successor.runDirectory, "result.json") : join(f.successor.runDirectory, "receipts",
      readdirSync(join(f.successor.runDirectory, "receipts")).find(name => {
        const receipt = JSON.parse(readFileSync(join(f.successor.runDirectory, "receipts", name), "utf8"));
        return receipt.kind === (mode === "receipt" ? "artifact-set-published" : "raw-transcript-captured");
      })!);
    const original = readFileSync(path);
    const raw = JSON.parse(original.toString());
    if (mode === "bytes") raw.lineage.inventory[0].finding.draft.claim = "Altered assertion with internally coherent JSON";
    else if (mode === "receipt") raw.artifacts[0].digest = "f".repeat(64);
    else raw.artifact.digest = "f".repeat(64);
    if (mode === "missing-cli-receipt") unlinkSync(path);
    else writeFileSync(path, JSON.stringify(raw, null, 2));
    try {
      const refused = await preflight(f, `wrong-${mode}`, { kind: "not-required" });
      expect(refused.ok).toBe(false);
      if (mode === "missing-cli-receipt") expect(refused).toMatchObject({ ok: false, message: expect.stringContaining("missing native or CLI provenance cannot be reconstructed") });
      expect(existsSync(join(f.runsRoot, `wrong-${mode}`))).toBe(false);
      expect(readFileSync(join(root, ".git/index"))).toEqual(index);
    } finally { writeFileSync(path, original); }
  }));

  it.each(["source-digest", "candidate-bytes"] as const)("refuses %s drift after genuine preparation without executing checks or installing", mode => owned(async root => {
    const f = await publishedSuccessorForRemediation(root, "active");
    addRepairTest(root);
    const prepared = value(await preflight(f, "drift", repairDeclaration(f.originalLineage.inventory[0]!.finding.id), ["tests/repair.test.mjs"]));
    const handle = value(f.handles.createRunDirectory(f.runsRoot, "drift"));
    value(await handle.registerProgram(prepared.registration));
    const index = readFileSync(join(root, ".git/index"));
    const registration = mode === "source-digest"
      ? { ...prepared.registration, source: { ...prepared.registration.source, resultDigest: prepared.registration.candidateBaseline.digest } }
      : prepared.registration;
    if (mode === "candidate-bytes") writeFileSync(join(root, "src/repair.mjs"), "export const repaired = () => true; // changed candidate\n");
    const refused = await f.remediation.resumeRemediationFacade(handle, registration);
    expect(refused).toMatchObject({ ok: true, action: { kind: "blocked" } });
    expect(await handle.readEvents()).toEqual([]);
    expect(await handle.readCheckpoint()).toBeNull();
    expect(readFileSync(join(root, ".git/index"))).toEqual(index);
    expect(existsSync(join(root, REPORT_PATH))).toBe(false);
    expectPreserved(f);
  }));
});
