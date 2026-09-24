import { spawnSync } from "node:child_process";
import { captureNativeReview } from "../../../fixtures/native-review-capture";
import { disposeFixturePiSessions, withFixturePiSession as inDirectory } from "../../../fixtures/pi-session";
import { createHash } from "node:crypto";
import { captureKey } from "../../../../src/core/harness-capture";
import { prepareDefectFamilyAccounting } from "../../../../src/core/defect-family-accounting";
import { parseStandaloneReviewMachineState } from "../../../../src/core/standalone-review-machine";
import { renderStandaloneReviewSummary } from "../../../../src/core/standalone-review";
import {
  mkdirSync,
  mkdtempSync,
  chmodSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRequestAuthority } from "../../../../src/core/orchestration-contract";
import { REMEDIATION_EVENT_RESOURCE_POLICY } from "../../../../src/handlers/helpers/programs/remediation-events";
import { parsedAuthority, publicationResolver, reviewerProtocolResolver, parseRegistration, parseRegisteredFacadeProgram } from "../../../../src/handlers/helpers/programs/helpers";
import { REVIEWER_PAYLOAD_EXAMPLE_V2 } from "../../../../src/core/reviewer-contract";
import {
  inspectRemediationFacade,
  prepareRemediationFacadeStart,
  resumeRemediationFacade,
  startRemediationFacade,
} from "../../../../src/handlers/helpers/programs/remediation";
import {
  resumeStandaloneFacade,
  replayStandaloneResultFromEvidence,
  startStandaloneFacade,
} from "../../../../src/handlers/helpers/programs/standalone";
import {
  createRunDirectory,
  parseRunEventResourcePolicy,
  type RunDirHandle,
} from "../../../../src/orchestration/run-directory-handle";

const cleanup: string[] = [];
const CHECK_ID = "project:repair-regression";
const REPORT_PATH = ".loom/completion-reports/repair.xml";

afterEach(() => {
  disposeFixturePiSessions();
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(repository: string, args: readonly string[]): string {
  const result = spawnSync("git", args, { cwd: repository, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function reviewerTranscript(critical: boolean): string {
  const findings = critical
    ? [
        { ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0], severity: "critical", file: "src/repair.mjs", line: 1, claim: "  repair predicate returns the vulnerable result\n  " },
        { ...REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0], severity: "critical", file: "src/repair.mjs", line: 1, claim: "refuted sibling claim" },
        { severity: "advisory", file: "src/repair.mjs", line: 1, claim: "advisory naming improvement", reason: "Clarify the exported predicate name." },
      ]
    : [];
  return JSON.stringify({ schemaVersion: 2, kind: "standalone-review", findings });
}

function registeredStandalone(handle: RunDirHandle) {
  const stored = handle.readProgramRegistration();
  if (!stored.ok) throw new Error(stored.error.message);
  const parsed = parseRegistration(stored.value);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}

function refutationTranscript(handle: RunDirHandle, authority: AgentRequestAuthority): string {
  const context = handle.readContext(authority.contextDigest);
  if (!context.ok) throw new Error(context.error.message);
  const section = context.value.fixedContext.find(({ label }) => label === "refutation-authority");
  if (section === undefined) throw new Error("standalone refutation context lacks authority");
  const authorityInput = JSON.parse(Buffer.from(section.bytes).toString("utf8")) as {
    lens: string;
    findings: readonly { id: string; claim: string }[];
  };
  return JSON.stringify({
    criterion: authorityInput.lens,
    verdicts: authorityInput.findings.map(({ id, claim }) => ({
      finding_id: id,
      verdict: claim === "refuted sibling claim" ? "refuted" : "upheld",
      reasoning: claim === "refuted sibling claim"
        ? "The frozen source does not support this separate claim."
        : "The frozen reviewed source still exhibits the finding.",
    })),
  });
}

async function completeCriticalStandaloneReview(repository: string, runsRoot: string, native = false): Promise<Readonly<{
  sourceRun: string;
  source: RunDirHandle;
  findingId: string;
  refutedFindingId: string;
  advisoryFindingId: string;
}>> {
  const sourceRun = "run.source-critical";
  const created = createRunDirectory(runsRoot, sourceRun);
  if (!created.ok) throw new Error(created.error.message);
  const started = await inDirectory(repository, () => startStandaloneFacade(created.value, {
    kind: "all",
    files: ["src/repair.mjs"],
    dryRun: false,
  }));
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.message);
  const initial = started.action as { kind: string; requests: readonly { authority: AgentRequestAuthority }[] };
  expect(initial.kind).toBe("spawn-batch");
  for (const [index, { authority }] of initial.requests.entries()) {
    const raw = native && index === 0 ? '{"schemaVersion":2,"schemaVersion":2}' : reviewerTranscript(index === 0);
    if (native) {
      const captured = await captureNativeReview(repository, created.value, authority, index % 2 === 0 ? "claude" : "pi", [raw]);
      expect(captured.captured, captured.diagnostic).toBe(true);
      const bytes = created.value.readTranscriptBytes(authority);
      if (!bytes.ok) throw new Error(bytes.error.message);
      expect(Buffer.from(bytes.value).toString("utf8")).toBe(raw);
    } else {
      expect((await created.value.captureTranscript(authority, [...Buffer.from(raw)])).ok).toBe(true);
    }
  }

  if (native) {
    const retried = await inDirectory(repository, () => resumeStandaloneFacade(created.value, registeredStandalone(created.value)));
    if (!retried.ok) throw new Error(retried.message);
    const action = retried.action as { kind: string; requests: readonly { authority: AgentRequestAuthority }[] };
    expect(action.kind).toBe("spawn-batch");
    expect(action.requests).toHaveLength(1);
    const request = action.requests[0]!.authority;
    expect(request.attempt).toBe(2);
    const captured = await captureNativeReview(repository, created.value, request, "claude", [reviewerTranscript(true)]);
    expect(captured.captured, captured.diagnostic).toBe(true);
  }

  const panelResult = await inDirectory(repository, () => resumeStandaloneFacade(created.value, registeredStandalone(created.value)));
  expect(panelResult.ok).toBe(true);
  if (!panelResult.ok) throw new Error(panelResult.message);
  const panel = panelResult.action as { kind: string; requests: readonly { authority: AgentRequestAuthority }[] };
  expect(panel.kind).toBe("spawn-batch");
  for (const [index, { authority }] of panel.requests.entries()) {
    const raw = refutationTranscript(created.value, authority);
    if (native) {
      const captured = await captureNativeReview(repository, created.value, authority, index % 2 === 0 ? "pi" : "claude", [raw]);
      expect(captured.captured, captured.diagnostic).toBe(true);
    } else {
      expect((await created.value.captureTranscript(authority, [...Buffer.from(raw)])).ok).toBe(true);
    }
  }

  const done = await inDirectory(repository, () => resumeStandaloneFacade(created.value, registeredStandalone(created.value)));
  expect(done.ok).toBe(true);
  if (!done.ok) throw new Error(done.message);
  expect((done.action as { kind: string }).kind).toBe("done");
  const published = JSON.parse(readFileSync(join(created.value.runDirectory, "result.json"), "utf8")) as {
    surviving_critical_findings: readonly { id: string }[];
    refuted_critical_findings: readonly { finding: { id: string } }[];
    advisory_findings: readonly { id: string }[];
  };
  expect(published.surviving_critical_findings).toHaveLength(1);
  expect(published.refuted_critical_findings).toHaveLength(1);
  expect(published.advisory_findings).toHaveLength(1);
  const registered = registeredStandalone(created.value);
  const authority = parsedAuthority(registered);
  if (!authority.ok) throw new Error(authority.message);
  const replay = parseStandaloneReviewMachineState(JSON.parse(readFileSync(join(created.value.runDirectory, "checkpoint.json"), "utf8")),
    publicationResolver(created.value), reviewerProtocolResolver(created.value, registered), authority.value);
  if (!replay.ok || replay.value.kind !== "done") throw new Error(JSON.stringify(replay));
  expect(replay.value.result.schemaVersion).toBe(2);
  const accounting = prepareDefectFamilyAccounting(replay.value.result, defectFamily(published.surviving_critical_findings[0]!.id));
  if (!accounting.ok) throw new Error(JSON.stringify(accounting));
  expect(accounting.value.source.survivingCriticals).toEqual(published.surviving_critical_findings);
  expect(accounting.value.source.refutedCriticals).toEqual(published.refuted_critical_findings);
  expect(accounting.value.source.advisories).toEqual(published.advisory_findings);
  expect(accounting.value.source.survivingCriticals[0]?.basis).toEqual(REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!.basis);
  expect(accounting.value.source.survivingCriticals[0]?.claim).toBe("  repair predicate returns the vulnerable result\n  ");
  expect(accounting.value.source.refutedCriticals[0]?.finding.basis).toEqual(REVIEWER_PAYLOAD_EXAMPLE_V2.findings[0]!.basis);
  expect(accounting.value.source.sourceResultDigest).toBe(createHash("sha256").update(readFileSync(join(created.value.runDirectory, "result.json"))).digest("hex"));
  expect(renderStandaloneReviewSummary(replay.value.result)).toContain("Emitted/admitted: 2 critical; 1 advisory.");
  expect(renderStandaloneReviewSummary(replay.value.result)).toContain("After refutation: 1 surviving critical; 1 refuted critical; 1 advisory.");
  if (native) {
    const issued = created.value.readIssuedRequests();
    const captured = created.value.readCapturedAttempts();
    if (!issued.ok || !captured.ok) throw new Error("native fixture capture authority unavailable");
    const witnesses = new Map(issued.value.flatMap((request) => {
      const key = captureKey(request.slotId, request.attempt);
      if (!captured.value.has(key)) return [];
      const bytes = created.value.readTranscriptBytes(request);
      if (!bytes.ok) throw new Error(bytes.error.message);
      return [[key, { requestId: request.requestId, role: request.role, contextDigest: request.contextDigest,
        digest: createHash("sha256").update(bytes.value).digest("hex"), byteLength: bytes.value.byteLength }] as const];
    }));
    const checkpointPath = join(created.value.runDirectory, "checkpoint.json");
    const checkpoint = readFileSync(checkpointPath);
    unlinkSync(checkpointPath);
    const witnessed = replayStandaloneResultFromEvidence(created.value, registered, witnesses);
    expect(witnessed.ok, JSON.stringify(witnessed)).toBe(true);
    if (witnessed.ok) expect(Buffer.from(witnessed.json)).toEqual(readFileSync(join(created.value.runDirectory, "result.json")));
    writeFileSync(checkpointPath, checkpoint);
    const resumed = await inDirectory(repository, () => resumeStandaloneFacade(created.value, registered));
    expect(resumed).toEqual(done);
  }
  return Object.freeze({
    sourceRun,
    source: created.value,
    findingId: published.surviving_critical_findings[0]!.id,
    refutedFindingId: published.refuted_critical_findings[0]!.finding.id,
    advisoryFindingId: published.advisory_findings[0]!.id,
  });
}

async function completeCleanStandaloneReview(repository: string, runsRoot: string): Promise<string> {
  const sourceRun = "run.source-clean";
  const created = createRunDirectory(runsRoot, sourceRun);
  if (!created.ok) throw new Error(created.error.message);
  const started = await inDirectory(repository, () => startStandaloneFacade(created.value, {
    kind: "all",
    files: ["src/repair.mjs"],
    dryRun: false,
  }));
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error(started.message);
  const initial = started.action as { requests: readonly { authority: AgentRequestAuthority }[] };
  for (const { authority } of initial.requests) {
    expect((await created.value.captureTranscript(authority, [...Buffer.from(reviewerTranscript(false))])).ok).toBe(true);
  }
  const done = await inDirectory(repository, () => resumeStandaloneFacade(created.value, registeredStandalone(created.value)));
  expect(done.ok && (done.action as { kind: string }).kind).toBe("done");
  return sourceRun;
}

function defectFamily(findingId: string, checkId = CHECK_ID): unknown {
  return {
    kind: "declared-defect-family-accounting",
    provenance: "DECLARED",
    dispositions: [{ findingId, status: "repaired", repairGroupId: "group.repair-predicate" }],
    groups: [{
      kind: "declared-repair-group",
      provenance: "DECLARED",
      repairGroupId: "group.repair-predicate",
      findingIds: [findingId],
      rootCause: { provenance: "DECLARED", statement: "The predicate returned the vulnerable constant." },
      invariant: { provenance: "DECLARED", statement: "The repaired predicate returns true." },
      siblings: { kind: "none-declared", provenance: "DECLARED", reason: "The fixture has no sibling implementation paths." },
      checks: [{
        checkId,
        historicalRed: {
          kind: "historical-red",
          provenance: "DECLARED",
          statement: "The regression assertion fails against the reviewed vulnerable implementation.",
          reference: null,
        },
      }],
    }],
  };
}

function applyRepair(repository: string, testBody = 'test("repair predicate", () => assert.equal(repaired(), true));'): void {
  writeFileSync(join(repository, "src", "repair.mjs"), "export const repaired = () => true;\n");
  mkdirSync(join(repository, "tests"), { recursive: true });
  writeFileSync(join(repository, "tests", "repair.test.mjs"), [
    'import test from "node:test";',
    'import assert from "node:assert/strict";',
    'import { repaired } from "../src/repair.mjs";',
    testBody,
    "",
  ].join("\n"));
}

function repositoryFixture(): Readonly<{ repository: string; runsRoot: string }> {
  const repository = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-p3-facade-repo-")));
  const runsRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-p3-facade-runs-")));
  cleanup.push(repository, runsRoot);
  git(repository, ["init", "--quiet", "--initial-branch=main"]);
  git(repository, ["config", "user.email", "fixture@example.invalid"]);
  git(repository, ["config", "user.name", "Fixture"]);
  mkdirSync(join(repository, "src"), { recursive: true });
  mkdirSync(join(repository, ".loom", "completion-reports"), { recursive: true });
  writeFileSync(join(repository, "src", "repair.mjs"), "export const repaired = () => false;\n");
  writeFileSync(join(repository, ".gitignore"), `${REPORT_PATH}\n`);
  writeFileSync(join(repository, ".loom", "verification-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    kind: "loom-verification-manifest",
    checks: [{
      id: CHECK_ID,
      scope: "wave",
      executable: "node",
      args: [
        "--test",
        "--test-reporter=junit",
        `--test-reporter-destination=${REPORT_PATH}`,
        "tests/repair.test.mjs",
      ],
      cwd: ".",
      timeoutMs: 15_000,
      report: { kind: "required-file", path: REPORT_PATH },
    }],
  }, null, 2));
  git(repository, ["add", ".gitignore", ".loom/verification-manifest.json", "src/repair.mjs"]);
  git(repository, ["commit", "--quiet", "-m", "vulnerable baseline"]);
  writeFileSync(join(repository, "src", "repair.mjs"), "export const repaired = () => false; // reviewed vulnerable state\n");
  return Object.freeze({ repository, runsRoot });
}

function scriptedReportFixture(): Readonly<{ repository: string; runsRoot: string }> {
  const fixture = repositoryFixture();
  mkdirSync(join(fixture.repository, "tools"), { recursive: true });
  writeFileSync(join(fixture.repository, "tools", "check.mjs"), [
    'import { closeSync, openSync, readFileSync, utimesSync, writeFileSync } from "node:fs";',
    'const mode = readFileSync("check-mode.txt", "utf8").trim();',
    `const report = ${JSON.stringify(REPORT_PATH)};`,
    'if (mode === "zero") writeFileSync(report, \'<testsuite tests="0" failures="0"/>\');',
    'if (mode === "all-skip") writeFileSync(report, \'<testsuite tests="1" failures="0" skipped="1"/>\');',
    'if (mode === "failing-report") writeFileSync(report, \'<testsuite tests="1" failures="1"/>\');',
    'if (mode === "nonzero-green") { writeFileSync(report, \'<testsuite tests="1" failures="0"/>\'); process.exitCode = 7; }',
    'if (mode === "malformed") writeFileSync(report, "not a structured report");',
    'if (mode === "stale-touch") { closeSync(openSync(report, "a")); utimesSync(report, new Date(), new Date()); }',
    'if (mode === "comment") writeFileSync(report, \'<!-- <testsuite tests="1" failures="0"/> -->\');',
    'if (mode === "cdata") writeFileSync(report, \'<testsuites><![CDATA[<testsuite tests="1" failures="0"/>]]></testsuites>\');',
    'if (mode === "malformed-xml") writeFileSync(report, \'<testsuite tests="1" failures="0">\');',
    'if (mode === "oversized") writeFileSync(report, \'<testsuite tests="1" failures="0"/>\'.padEnd(8 * 1024 * 1024 + 1, " "));',
    "",
  ].join("\n"));
  writeFileSync(join(fixture.repository, ".loom", "verification-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    kind: "loom-verification-manifest",
    checks: [{
      id: CHECK_ID,
      scope: "wave",
      executable: "node",
      args: ["tools/check.mjs"],
      cwd: ".",
      timeoutMs: 15_000,
      report: { kind: "required-file", path: REPORT_PATH },
    }],
  }, null, 2));
  git(fixture.repository, ["add", "tools/check.mjs", ".loom/verification-manifest.json"]);
  git(fixture.repository, ["commit", "--quiet", "--amend", "--no-edit"]);
  return fixture;
}

describe.sequential("Defect-Family Accounting production facade", () => {
  it("installs not-required work for an actual zero-critical source without reading a manifest or running checks", async () => {
    const fixture = repositoryFixture();
    unlinkSync(join(fixture.repository, ".loom", "verification-manifest.json"));
    git(fixture.repository, ["add", "-u", ".loom/verification-manifest.json"]);
    git(fixture.repository, ["commit", "--quiet", "--amend", "--no-edit"]);
    const sourceRun = await completeCleanStandaloneReview(fixture.repository, fixture.runsRoot);
    writeFileSync(join(fixture.repository, "src", "repair.mjs"), "export const repaired = () => true;\n");
    const remediationRun = "run.not-required";
    const prepared = await prepareRemediationFacadeStart({
      input: {
        sourceRunsRoot: fixture.runsRoot,
        sourceRun,
        supportPaths: [],
        defectFamily: { kind: "not-required" },
      },
      repositoryStartPath: fixture.repository,
      remediationRunsRoot: fixture.runsRoot,
      remediationRun,
    });
    expect(prepared.ok, prepared.ok ? "" : prepared.message).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.value.registration.verification.kind).toBe("not-required");
    const remediation = createRunDirectory(fixture.runsRoot, remediationRun);
    expect(remediation.ok).toBe(true);
    if (!remediation.ok) return;
    const done = await startRemediationFacade(remediation.value, prepared.value.registration);
    expect(done.ok && (done.action as { kind: string }).kind).toBe("done");
    expect(done.ok && (done.action as {
      outcome: { defectFamilyAssessment: { status: string } };
    }).outcome.defectFamilyAssessment.status).toBe("not-required");
    expect(await remediation.value.readEvents()).toEqual([]);
    expect(git(fixture.repository, ["diff", "--cached", "--name-only"]).trim()).toBe("src/repair.mjs");
  }, 30_000);

  it("refuses foreign, refuted, advisory, missing, unresolved, and unknown-check accounting before creating a run", async () => {
    const fixture = repositoryFixture();
    const source = await completeCriticalStandaloneReview(fixture.repository, fixture.runsRoot);
    applyRepair(fixture.repository);
    const indexBefore = readFileSync(join(fixture.repository, ".git", "index"));
    const declarations = [
      ["foreign", defectFamily("code-reviewer:foreign")],
      ["refuted", defectFamily(source.refutedFindingId)],
      ["advisory", defectFamily(source.advisoryFindingId)],
      ["missing", {
        kind: "declared-defect-family-accounting",
        provenance: "DECLARED",
        dispositions: [],
        groups: [],
      }],
      ["unresolved", {
        kind: "declared-defect-family-accounting",
        provenance: "DECLARED",
        dispositions: [{ findingId: source.findingId, status: "unresolved", reason: "The repair remains blocked." }],
        groups: [],
      }],
      ["unknown-check", defectFamily(source.findingId, "project:not-registered")],
    ] as const;

    for (const [label, declaration] of declarations) {
      const run = `run.preflight-${label}`;
      const prepared = await prepareRemediationFacadeStart({
        input: {
          sourceRunsRoot: fixture.runsRoot,
          sourceRun: source.sourceRun,
          supportPaths: ["tests/repair.test.mjs"],
          defectFamily: declaration,
        },
        repositoryStartPath: fixture.repository,
        remediationRunsRoot: fixture.runsRoot,
        remediationRun: run,
      });
      expect(prepared.ok, label).toBe(false);
      expect(() => readFileSync(join(fixture.runsRoot, run, "authority.json"))).toThrow();
      expect(readFileSync(join(fixture.repository, ".git", "index"))).toEqual(indexBefore);
    }
  }, 30_000);

  it("refuses current source result, packet, registration and publication-receipt tampering before remediation authority", async () => {
    const fixture = repositoryFixture();
    const source = await completeCriticalStandaloneReview(fixture.repository, fixture.runsRoot);
    applyRepair(fixture.repository);
    const before = readFileSync(join(fixture.repository, ".git", "index"));
    const requests = source.source.readIssuedRequests();
    if (!requests.ok) throw new Error(requests.error.message);
    const reviewer = requests.value.find(({ program }) => program === "standalone-review")!;
    const receiptDirectory = join(source.source.runDirectory, "receipts");
    const receiptName = readdirSync(receiptDirectory).find((name) => JSON.parse(readFileSync(join(receiptDirectory, name), "utf8")).kind === "artifact-set-published");
    if (receiptName === undefined) throw new Error("real result publication receipt required");
    const cases = [
      { label: "result-basis", path: join(source.source.runDirectory, "result.json"), field: "basis" },
      { label: "program", path: join(source.source.runDirectory, "program.json"), field: "reviewerProtocol" },
      { label: "context", path: join(source.source.runDirectory, "contexts", `${reviewer.contextDigest}.json`), field: "reviewerProtocol" },
      { label: "receipt", path: join(receiptDirectory, receiptName), field: null },
    ];
    for (const entry of cases) {
      const original = readFileSync(entry.path);
      unlinkSync(entry.path);
      if (entry.field !== null) {
        const corrupted = JSON.parse(original.toString());
        if (entry.field === "basis") delete corrupted.surviving_critical_findings[0].basis;
        else delete corrupted[entry.field];
        writeFileSync(entry.path, JSON.stringify(corrupted, null, 2));
      }
      try {
        const prepared = await prepareRemediationFacadeStart({ input: { sourceRunsRoot: fixture.runsRoot, sourceRun: source.sourceRun,
          supportPaths: ["tests/repair.test.mjs"], defectFamily: defectFamily(source.findingId) },
          repositoryStartPath: fixture.repository, remediationRunsRoot: fixture.runsRoot, remediationRun: `run.tamper-${entry.label}` });
        expect(prepared.ok, entry.label).toBe(false);
        expect(readFileSync(join(fixture.repository, ".git", "index"))).toEqual(before);
      } finally {
        if (entry.field !== null) unlinkSync(entry.path);
        writeFileSync(entry.path, original, { mode: 0o444 });
      }
    }
  }, 30_000);

  it("rejects a missing manifest and a report-not-required check before creating a run", async () => {
    const fixture = repositoryFixture();
    const source = await completeCriticalStandaloneReview(fixture.repository, fixture.runsRoot);
    applyRepair(fixture.repository);
    const manifestPath = join(fixture.repository, ".loom", "verification-manifest.json");
    const manifestBytes = readFileSync(manifestPath);
    const indexBefore = readFileSync(join(fixture.repository, ".git", "index"));

    unlinkSync(manifestPath);
    const missing = await prepareRemediationFacadeStart({
      input: {
        sourceRunsRoot: fixture.runsRoot,
        sourceRun: source.sourceRun,
        supportPaths: ["tests/repair.test.mjs"],
        defectFamily: defectFamily(source.findingId),
      },
      repositoryStartPath: fixture.repository,
      remediationRunsRoot: fixture.runsRoot,
      remediationRun: "run.missing-manifest",
    });
    expect(missing.ok).toBe(false);
    expect(() => readFileSync(join(fixture.runsRoot, "run.missing-manifest", "authority.json"))).toThrow();

    writeFileSync(manifestPath, manifestBytes);
    const raw = JSON.parse(manifestBytes.toString("utf8")) as {
      checks: { report: unknown }[];
    };
    raw.checks[0]!.report = { kind: "not-required" };
    writeFileSync(manifestPath, JSON.stringify(raw));
    const reportNotRequired = await prepareRemediationFacadeStart({
      input: {
        sourceRunsRoot: fixture.runsRoot,
        sourceRun: source.sourceRun,
        supportPaths: ["tests/repair.test.mjs"],
        defectFamily: defectFamily(source.findingId),
      },
      repositoryStartPath: fixture.repository,
      remediationRunsRoot: fixture.runsRoot,
      remediationRun: "run.report-not-required",
    });
    expect(reportNotRequired.ok).toBe(false);
    expect(() => readFileSync(join(fixture.runsRoot, "run.report-not-required", "authority.json"))).toThrow();
    expect(readFileSync(join(fixture.repository, ".git", "index"))).toEqual(indexBefore);
  }, 30_000);

  it("refuses checkpoint-only and foreign-event terminal claims without touching the index", async () => {
    const fixture = scriptedReportFixture();
    const source = await completeCriticalStandaloneReview(fixture.repository, fixture.runsRoot);
    applyRepair(fixture.repository);
    writeFileSync(join(fixture.repository, "check-mode.txt"), "missing\n");
    const indexBefore = readFileSync(join(fixture.repository, ".git", "index"));

    for (const kind of ["checkpoint-only", "foreign-event"] as const) {
      const run = `run.${kind}`;
      const prepared = await prepareRemediationFacadeStart({
        input: {
          sourceRunsRoot: fixture.runsRoot,
          sourceRun: source.sourceRun,
          supportPaths: ["tests/repair.test.mjs", "check-mode.txt"],
          defectFamily: defectFamily(source.findingId),
        },
        repositoryStartPath: fixture.repository,
        remediationRunsRoot: fixture.runsRoot,
        remediationRun: run,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) continue;
      const remediation = createRunDirectory(fixture.runsRoot, run);
      expect(remediation.ok).toBe(true);
      if (!remediation.ok) continue;
      expect((await remediation.value.registerProgram(prepared.value.registration)).ok).toBe(true);
      if (kind === "foreign-event") {
        await remediation.value.appendEvent({
          schemaVersion: 1,
          sequence: 0,
          dedupKey: "foreign-observation",
          recordedAtMs: 1,
          event: {
            kind: "remediation-check-observed",
            schemaVersion: 1,
            registrationDigest: "0".repeat(64),
            authorityDigest: "1".repeat(64),
            candidateWitnessDigest: "2".repeat(64),
            checkId: CHECK_ID,
            process: { kind: "observed", exitCode: 0, timedOut: false, signal: null },
            report: null,
            beforeCandidateDigest: "2".repeat(64),
            afterCandidateDigest: "2".repeat(64),
          },
        });
      }
      await remediation.value.writeCheckpoint(JSON.stringify({ schemaVersion: 2, state: { state: "done" } }));
      const resumed = await resumeRemediationFacade(remediation.value, prepared.value.registration);
      expect(resumed).toMatchObject({ ok: false, message: expect.stringMatching(/checkpoint.*audit.*paths/i) });
      expect(readFileSync(join(fixture.repository, ".git", "index"))).toEqual(indexBefore);
    }
  }, 30_000);

  it("refuses candidate byte, mode, and path-roster drift after registration", async () => {
    const mutations = [
      ["bytes", (root: string) => writeFileSync(join(root, "src", "repair.mjs"), "export const repaired = () => true; // drift\n")],
      ["mode", (root: string) => chmodSync(join(root, "src", "repair.mjs"), 0o755)],
      ["roster", (root: string) => writeFileSync(join(root, "foreign.txt"), "new roster entry\n")],
    ] as const;
    for (const [kind, mutate] of mutations) {
      const fixture = repositoryFixture();
      const source = await completeCriticalStandaloneReview(fixture.repository, fixture.runsRoot);
      applyRepair(fixture.repository);
      const indexBefore = readFileSync(join(fixture.repository, ".git", "index"));
      const run = `run.drift-${kind}`;
      const prepared = await prepareRemediationFacadeStart({
        input: {
          sourceRunsRoot: fixture.runsRoot,
          sourceRun: source.sourceRun,
          supportPaths: ["tests/repair.test.mjs"],
          defectFamily: defectFamily(source.findingId),
        },
        repositoryStartPath: fixture.repository,
        remediationRunsRoot: fixture.runsRoot,
        remediationRun: run,
      });
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) continue;
      const remediation = createRunDirectory(fixture.runsRoot, run);
      expect(remediation.ok).toBe(true);
      if (!remediation.ok) continue;
      expect((await remediation.value.registerProgram(prepared.value.registration)).ok).toBe(true);
      mutate(fixture.repository);
      const resumed = await resumeRemediationFacade(remediation.value, prepared.value.registration);
      expect(resumed.ok && (resumed.action as { kind: string }).kind, kind).toBe("blocked");
      expect(await remediation.value.readEvents()).toHaveLength(0);
      expect(readFileSync(join(fixture.repository, ".git", "index"))).toEqual(indexBefore);
    }
  }, 30_000);

  it("keeps completed v1 runs historical-unknown and blocks unfinished v1 runs", async () => {
    const fixture = repositoryFixture();
    const indexBefore = readFileSync(join(fixture.repository, ".git", "index"));
    const registration = {
      schemaVersion: 1 as const,
      kind: "remediation" as const,
      input: { sourceRunsRoot: fixture.runsRoot, sourceRun: "run.legacy-source", supportPaths: [] },
    };
    const completed = createRunDirectory(fixture.runsRoot, "run.legacy-done");
    const pending = createRunDirectory(fixture.runsRoot, "run.legacy-pending");
    expect(completed.ok && pending.ok).toBe(true);
    if (!completed.ok || !pending.ok) return;
    expect((await completed.value.registerProgram(registration)).ok).toBe(true);
    expect((await pending.value.registerProgram(registration)).ok).toBe(true);
    await completed.value.writeCheckpoint(JSON.stringify({
      schemaVersion: 1,
      state: {
        state: "done",
        receipt: {
          kind: "verified-index-installed",
          effectId: "effect:legacy-install",
          runId: completed.value.runId,
          indexDigest: "a".repeat(64),
          witnessDigest: "b".repeat(64),
        },
      },
    }));

    const checkpointBefore = readFileSync(join(completed.value.runDirectory, "checkpoint.json"));
    const historical = await resumeRemediationFacade(completed.value, registration);
    expect(historical.ok && (historical.action as {
      outcome: { defectFamilyAssessment: { status: string } };
    }).outcome.defectFamilyAssessment.status).toBe("historical-unknown");
    expect(readFileSync(join(completed.value.runDirectory, "checkpoint.json"))).toEqual(checkpointBefore);
    const refused = await resumeRemediationFacade(pending.value, registration);
    expect(refused.ok && (refused.action as { kind: string }).kind).toBe("blocked");
    expect(readFileSync(join(fixture.repository, ".git", "index"))).toEqual(indexBefore);
  });

  it("persists zero/all-skip/failing/nonzero/missing/malformed/stale outcomes as terminal same-run blocks", async () => {
    const fixture = scriptedReportFixture();
    const source = await completeCriticalStandaloneReview(fixture.repository, fixture.runsRoot);
    applyRepair(fixture.repository);
    const indexBefore = readFileSync(join(fixture.repository, ".git", "index"));
    const modes = ["zero", "all-skip", "failing-report", "nonzero-green", "missing", "malformed", "stale", "stale-touch", "comment", "cdata", "malformed-xml", "oversized"] as const;

    for (const mode of modes) {
      writeFileSync(join(fixture.repository, "check-mode.txt"), `${mode}\n`);
      if (mode === "stale" || mode === "stale-touch") {
        writeFileSync(join(fixture.repository, REPORT_PATH), '<testsuite tests="1" failures="0"/>');
      }
      const run = `run.failed-${mode}`;
      const prepared = await prepareRemediationFacadeStart({
        input: {
          sourceRunsRoot: fixture.runsRoot,
          sourceRun: source.sourceRun,
          supportPaths: ["tests/repair.test.mjs", "check-mode.txt"],
          defectFamily: defectFamily(source.findingId),
        },
        repositoryStartPath: fixture.repository,
        remediationRunsRoot: fixture.runsRoot,
        remediationRun: run,
      });
      expect(prepared.ok, prepared.ok ? mode : prepared.message).toBe(true);
      if (!prepared.ok) continue;
      const remediation = createRunDirectory(fixture.runsRoot, run);
      expect(remediation.ok).toBe(true);
      if (!remediation.ok) continue;
      const blocked = await startRemediationFacade(remediation.value, prepared.value.registration);
      expect(blocked.ok).toBe(true);
      expect(blocked.ok && (blocked.action as { kind: string }).kind, mode).toBe("blocked");
      expect(readFileSync(join(fixture.repository, ".git", "index"))).toEqual(indexBefore);
      const events = await remediation.value.readEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ event: { kind: "remediation-check-observed" } });
      if (mode === "comment" || mode === "cdata" || mode === "malformed-xml" || mode === "stale-touch") {
        expect(events[0]).toMatchObject({ event: {
          process: { kind: "observed", exitCode: 0, timedOut: false, signal: null },
          report: { kind: "produced" },
        } });
      }
      if (mode === "stale-touch") expect(events[0]).toMatchObject({ event: { report: { byteLength: 0, bytes: "" } } });
      if (mode === "oversized") expect(events[0]).toMatchObject({ event: {
        report: { kind: "unreadable", message: expect.stringContaining("byte limit") },
      } });
      const replay = await resumeRemediationFacade(remediation.value, prepared.value.registration);
      expect(replay.ok && (replay.action as { kind: string }).kind, mode).toBe("blocked");
      expect(await remediation.value.readEvents()).toHaveLength(1);
      expect(readFileSync(join(fixture.repository, ".git", "index"))).toEqual(indexBefore);
    }
  }, 90_000);

  it("fails closed on oversized durable report replay without changing the real index", async () => {
    const fixture = scriptedReportFixture();
    const source = await completeCriticalStandaloneReview(fixture.repository, fixture.runsRoot);
    applyRepair(fixture.repository);
    writeFileSync(join(fixture.repository, "check-mode.txt"), "nonzero-green\n");
    const prepared = await prepareRemediationFacadeStart({
      input: {
        sourceRunsRoot: fixture.runsRoot, sourceRun: source.sourceRun,
        supportPaths: ["tests/repair.test.mjs", "check-mode.txt"], defectFamily: defectFamily(source.findingId),
      },
      repositoryStartPath: fixture.repository, remediationRunsRoot: fixture.runsRoot, remediationRun: "run.oversized-replay",
    });
    if (!prepared.ok) throw new Error(prepared.message);
    const remediation = createRunDirectory(fixture.runsRoot, "run.oversized-replay");
    if (!remediation.ok) throw new Error(remediation.error.message);
    const indexBefore = readFileSync(join(fixture.repository, ".git", "index"));
    const first = await startRemediationFacade(remediation.value, prepared.value.registration);
    expect(first.ok && (first.action as { kind: string }).kind).toBe("blocked");
    // Corrupt an actual retained observation, not hand-built live source/check authority.
    // The retained observation is selected by SHAPE, never by readdir order:
    // entry order within one directory is platform-defined, and mutating the
    // wrong retained event would write into an unrelated record.
    const eventsDirectory = join(remediation.value.runDirectory, "events");
    const eventPath = ((): string => {
      for (const name of readdirSync(eventsDirectory).sort()) {
        if (!name.endsWith(".json")) continue;
        const candidatePath = join(eventsDirectory, name);
        const candidate = JSON.parse(readFileSync(candidatePath, "utf8")) as {
          event?: { process?: unknown; report?: unknown };
        };
        if (candidate.event?.process !== undefined && candidate.event?.report !== undefined) return candidatePath;
      }
      throw new Error("runner did not retain its real check observation");
    })();
    const retained = JSON.parse(readFileSync(eventPath, "utf8"));
    const original = readFileSync(eventPath);
    retained.event.process.exitCode = 0;
    retained.event.report.byteLength = 8 * 1024 * 1024 + 1;
    retained.event.report.bytes = Buffer.alloc(8 * 1024 * 1024 + 1, 32).toString("base64");
    writeFileSync(eventPath, JSON.stringify(retained));
    try {
      const replay = await resumeRemediationFacade(remediation.value, prepared.value.registration);
      expect(replay.ok && (replay.action as { kind: string }).kind).toBe("blocked");
      expect(readFileSync(join(fixture.repository, ".git", "index"))).toEqual(indexBefore);
    } finally { writeFileSync(eventPath, original); }
  });

  it("bounds actual V2 journal reads and append reconciliation before decoding, without index effects", async () => {
    const fixture = repositoryFixture();
    const source = await completeCriticalStandaloneReview(fixture.repository, fixture.runsRoot);
    applyRepair(fixture.repository);
    const indexBefore = readFileSync(join(fixture.repository, ".git", "index"));
    expect(REMEDIATION_EVENT_RESOURCE_POLICY).toEqual({
      maxEventBytes: 12 * 1024 * 1024, maxJournalBytes: 64 * 1024 * 1024, maxRecords: 1024,
    });
    for (const mode of ["oversize", "aggregate", "count", "append-size", "append-reconciliation"] as const) {
      const run = `run.journal-${mode}`;
      const prepared = await prepareRemediationFacadeStart({
        input: {
          sourceRunsRoot: fixture.runsRoot, sourceRun: source.sourceRun,
          supportPaths: ["tests/repair.test.mjs"], defectFamily: defectFamily(source.findingId),
        },
        repositoryStartPath: fixture.repository, remediationRunsRoot: fixture.runsRoot, remediationRun: run,
      });
      if (!prepared.ok) throw new Error(prepared.message);
      const created = createRunDirectory(fixture.runsRoot, run);
      if (!created.ok) throw new Error(created.error.message);
      const handle = created.value;
      expect((await handle.registerProgram(prepared.value.registration)).ok).toBe(true);
      const events = join(handle.runDirectory, "events");
      // Corrupt retained bytes in a disposable, genuinely registered Run. No fabricated admission.
      const first = join(events, "000000-corrupt.json");
      const tinyEvent = JSON.stringify({ schemaVersion: 1, sequence: 0, dedupKey: "corrupt", recordedAtMs: 1, event: {} });
      const limit = Buffer.byteLength(tinyEvent);
      const parsedBudget = parseRunEventResourcePolicy({ maxEventBytes: limit, maxJournalBytes: limit, maxRecords: 1 });
      if (!parsedBudget.ok) throw new Error(parsedBudget.error.message);
      if (mode === "oversize") { writeFileSync(first, "{"); truncateSync(first, 1024 * 1024 * 1024); }
      if (mode === "aggregate") {
        writeFileSync(first, tinyEvent);
        writeFileSync(join(events, "000001-second.json"), "{");
      }
      if (mode === "count") {
        writeFileSync(first, "{");
        writeFileSync(join(events, "000001-second.json"), "{");
      }
      const aggregateBudget = parseRunEventResourcePolicy({ maxEventBytes: limit, maxJournalBytes: limit, maxRecords: 2 });
      if (!aggregateBudget.ok) throw new Error(aggregateBudget.error.message);
      let reads = 0;
      let appends = 0;
      const bounded: RunDirHandle = {
        ...handle,
        readEvents: async (policy) => {
          expect(policy).toBe(REMEDIATION_EVENT_RESOURCE_POLICY);
          reads++;
          return handle.readEvents(mode === "oversize" ? policy : mode === "aggregate" ? aggregateBudget.value : parsedBudget.value);
        },
        appendEvent: async (record, policy) => {
          expect(policy).toBe(REMEDIATION_EVENT_RESOURCE_POLICY);
          appends++;
          if (mode === "append-reconciliation") { writeFileSync(first, "{"); truncateSync(first, 1024 * 1024 * 1024); }
          return handle.appendEvent(record, mode === "append-reconciliation" ? policy : parsedBudget.value);
        },
      };
      const result = await resumeRemediationFacade(bounded, prepared.value.registration);
      expect(result).toMatchObject({ ok: true, action: {
        kind: "blocked", diagnostic: { message: expect.stringMatching(mode === "count" ? /journal.*record limit/ : /journal.*byte limit/) },
      } });
      expect(reads).toBe(1);
      expect(appends).toBe(mode.startsWith("append") ? 1 : 0);
      expect(readdirSync(events).filter(name => name.endsWith(".lock"))).toEqual([]);
      expect(readFileSync(join(fixture.repository, ".git", "index"))).toEqual(indexBefore);
      expect(await handle.readCheckpoint()).toBeNull();
      if (mode === "oversize") {
        const inspection = spawnSync("bun", [
          new URL("../../../../src/cli.ts", import.meta.url).pathname,
          "helper", "orchestration", "inspect", "--runs-root", fixture.runsRoot, "--run", run, "--json",
        ], { cwd: fixture.repository, encoding: "utf8" });
        expect(inspection.status, inspection.stderr).toBe(0);
        expect(inspection.stdout).toMatch(/event log.*byte limit/);
        expect(readFileSync(join(fixture.repository, ".git", "index"))).toEqual(indexBefore);
      }
    }
  }, 90_000);

  it("records report removal failure durably, never launches, and cannot retry it in the same Run", async () => {
    expect(process.getuid?.()).not.toBe(0);
    const fixture = scriptedReportFixture();
    const source = await completeCriticalStandaloneReview(fixture.repository, fixture.runsRoot);
    applyRepair(fixture.repository);
    writeFileSync(join(fixture.repository, "check-mode.txt"), "nonzero-green\n");
    writeFileSync(join(fixture.repository, REPORT_PATH), "old sentinel");
    const indexBefore = readFileSync(join(fixture.repository, ".git", "index"));
    const prepared = await prepareRemediationFacadeStart({
      input: {
        sourceRunsRoot: fixture.runsRoot, sourceRun: source.sourceRun,
        supportPaths: ["tests/repair.test.mjs", "check-mode.txt"], defectFamily: defectFamily(source.findingId),
      },
      repositoryStartPath: fixture.repository, remediationRunsRoot: fixture.runsRoot, remediationRun: "run.removal-failed",
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error(prepared.message);
    const remediation = createRunDirectory(fixture.runsRoot, "run.removal-failed");
    if (!remediation.ok) throw new Error(remediation.error.message);
    const parent = join(fixture.repository, ".loom", "completion-reports");
    chmodSync(parent, 0o500);
    try {
      const blocked = await startRemediationFacade(remediation.value, prepared.value.registration);
      expect(blocked.ok && (blocked.action as { kind: string }).kind).toBe("blocked");
      expect(await remediation.value.readEvents()).toMatchObject([{ event: {
        kind: "remediation-check-runner-failed", message: expect.stringContaining("report reset failed before launch"),
      } }]);
      expect(readFileSync(join(fixture.repository, REPORT_PATH), "utf8")).toBe("old sentinel");
      expect(readFileSync(join(fixture.repository, ".git", "index"))).toEqual(indexBefore);
    } finally { chmodSync(parent, 0o700); }
    const replay = await resumeRemediationFacade(remediation.value, prepared.value.registration);
    expect(replay.ok && (replay.action as { kind: string }).kind).toBe("blocked");
    expect(await remediation.value.readEvents()).toHaveLength(1);
    expect(readFileSync(join(fixture.repository, REPORT_PATH), "utf8")).toBe("old sentinel");
    expect(readFileSync(join(fixture.repository, ".git", "index"))).toEqual(indexBefore);
  });

  it("runs one distinct fixed check and installs the exact repair-checked index from a mixed Claude/Pi native source", async () => {
    const fixture = repositoryFixture();
    const source = await completeCriticalStandaloneReview(fixture.repository, fixture.runsRoot, true);
    applyRepair(fixture.repository);

    const remediationRun = "run.remediation-p3";
    const prepared = await prepareRemediationFacadeStart({
      input: {
        sourceRunsRoot: fixture.runsRoot,
        sourceRun: source.sourceRun,
        supportPaths: ["tests/repair.test.mjs"],
        defectFamily: defectFamily(source.findingId),
      },
      repositoryStartPath: fixture.repository,
      remediationRunsRoot: fixture.runsRoot,
      remediationRun,
    });
    expect(prepared.ok, prepared.ok ? "" : prepared.message).toBe(true);
    if (!prepared.ok) return;
    const remediation = createRunDirectory(fixture.runsRoot, remediationRun);
    expect(remediation.ok).toBe(true);
    if (!remediation.ok) return;

    // A seeded old report must not prevent a real reporter from writing anew.
    writeFileSync(join(fixture.repository, REPORT_PATH), '<testsuite tests="1" failures="0"/>');
    const driven = await startRemediationFacade(remediation.value, prepared.value.registration);
    expect(driven.ok, driven.ok ? "" : driven.message).toBe(true);
    if (!driven.ok) return;
    const action = driven.action as {
      kind: string;
      outcome: {
        kind: string;
        defectFamilyAssessment: {
          status: string;
          provenance: Record<string, string>;
          repairedChecks: readonly { checkId: string; report: { summary: { total: number; failed: number } } }[];
        };
      };
    };
    expect(action.kind).toBe("done");
    expect(action.outcome.kind).toBe("remediation-installed");
    expect(action.outcome.defectFamilyAssessment).toMatchObject({
      status: "repair-checked",
      provenance: {
        grouping: "DECLARED",
        rootCause: "DECLARED",
        invariant: "DECLARED",
        siblingAccounting: "DECLARED",
        historicalRed: "DECLARED",
        repairedTests: "ENGINE_OBSERVED",
      },
    });
    expect(action.outcome.defectFamilyAssessment.repairedChecks).toHaveLength(1);
    expect(action.outcome.defectFamilyAssessment.repairedChecks[0]).toMatchObject({
      checkId: CHECK_ID,
      report: { summary: { total: 1, failed: 0 } },
    });
    expect(git(fixture.repository, ["diff", "--cached", "--name-only"]).trim().split("\n").sort())
      .toEqual(["src/repair.mjs", "tests/repair.test.mjs"]);

    const stored = remediation.value.readProgramRegistration();
    expect(stored.ok && stored.value !== null).toBe(true);
    if (!stored.ok || stored.value === null) return;
    const parsed = parseRegisteredFacadeProgram(stored.value);
    expect(parsed.kind).toBe("registered");
    if (parsed.kind !== "registered" || parsed.program.kind !== "remediation") return;
    const inspection = await inspectRemediationFacade(remediation.value, parsed.program);
    expect(inspection).toEqual({ ok: true, label: "repair-checked" });
    const firstEvents = await remediation.value.readEvents();
    expect(firstEvents.filter(({ event }) => (event as { kind?: string }).kind === "remediation-check-observed")).toHaveLength(1);
    const resumed = await resumeRemediationFacade(remediation.value, parsed.program);
    expect(resumed.ok && (resumed.action as { kind: string }).kind).toBe("done");
    const replayEvents = await remediation.value.readEvents();
    expect(replayEvents.filter(({ event }) => (event as { kind?: string }).kind === "remediation-check-observed")).toHaveLength(1);
    const checkpoint = JSON.parse((await remediation.value.readCheckpoint())!);
    const indexAfter = readFileSync(join(fixture.repository, ".git", "index"));
    for (const field of ["auditedPaths", "dirtyPaths"]) {
      for (const malformed of [undefined, null, {}, { paths: null }, { paths: "src/repair.mjs" }, { paths: [42] }]) {
        const corrupt = structuredClone(checkpoint);
        corrupt.state.verified.evidence[field] = malformed;
        await remediation.value.writeCheckpoint(JSON.stringify(corrupt));
        const refused = await resumeRemediationFacade(remediation.value, parsed.program);
        expect(refused).toMatchObject({ ok: false, message: expect.stringMatching(/checkpoint.*audit.*paths/i) });
        expect(readFileSync(join(fixture.repository, ".git", "index"))).toEqual(indexAfter);
      }
    }
    await remediation.value.writeCheckpoint(JSON.stringify(checkpoint));
  }, 30_000);
});
