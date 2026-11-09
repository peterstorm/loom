/**
 * ADR-0067 end to end: a security ballot exists only as the harness-captured
 * output of an issued `security-verifier-agent` spawn — and stays authority
 * only while its run and its capture attestation still prove it.
 *
 * The suite drives the real seams in the order an operator does: the audit's
 * hunt (`helper security-audit start/assign/submit`), `status` printing the
 * exact verification start, `helper orchestration start security-verification`
 * issuing the verifier spawn batch, the Claude Code native capture path
 * (PostToolUse correlator + SubagentStop capture, which writes the capture
 * attestation) delivering each verifier's transcript, `resume` publishing
 * `result.json`, and `verify --from` importing the bound ballots before
 * `publish`. Every refusal is driven through the same seams: stdin ballots,
 * the CLI write paths into a verifier slot, forged transcript bytes, a ballot
 * written into `verdicts.json` by hand, a tampered attestation store, a stale
 * findings digest, a hunter-role capture into a verifier slot, a tampered
 * `result.json`, and a wrong audit.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureAttestationDir, securityAuditRunRegistryDir } from "../../src/config";
import { parseVerificationVerdicts, type VerificationVerdict } from "../../src/core/security-adjudication";
import { parseVerificationResult } from "../../src/core/security-verification";
import type { SecurityFinding } from "../../src/core/security-findings";
import { registeredSecurityAuditRuns } from "../../src/orchestration/security-audit-run-registry";
import { HUNTER_ENVELOPE, aConfirmedFinding, aUnitResult } from "../security/fixtures";
import { aRun, readJson, removeRuns, seedFor, unitIdFor, type Run } from "./security-audit-harness";
import {
  deliver,
  facade,
  resumeVerification,
  startVerification,
  verificationPlan,
  verifiedRun,
  verifierResult,
  vote,
  verifyWith,
  type Plan,
  type SpawnTask,
} from "./security-verification-harness";

const SQLI = "api/login:sqli-email";
const SECOND = "api/login:sqli-name";

let scratch: string;

beforeEach(() => {
  // The real path: the capture path reads transcripts under LOOM_SUBAGENT_DIR
  // without following symlinks, so an aliased temp root (macOS `/var` →
  // `/private/var`) would refuse every capture with ELOOP.
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "loom-security-verification-")));
  vi.stubEnv("LOOM_SUBAGENT_DIR", join(scratch, "bindings"));
  // Explicit run authority belongs to the CLI child of a supervisor; the
  // Claude path under test resolves its run from the session binding.
  vi.stubEnv("LOOM_ORCHESTRATION_RUNS_ROOT", undefined);
  vi.stubEnv("LOOM_ORCHESTRATION_RUN_DIR", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  removeRuns();
  rmSync(scratch, { recursive: true, force: true });
});

// --- The audit side ---

/** An audit whose hunt filed one confirmed claim (unit 0); with two units, unit 1 is still in flight. */
async function huntedAudit(units: 1 | 2 = 2, run: Run = aRun()): Promise<Run> {
  const ok = async (args: readonly string[], stdin?: string) => {
    const invoked = await run.invoke(args, stdin);
    if (!invoked.ok) throw new Error(`${args[0]}: ${invoked.error}`);
  };
  await ok(["start", "--repo", run.out, "--source", "0".repeat(40), "--profile", "standard"],
    JSON.stringify({ units: [seedFor(0), seedFor(1)].slice(0, units), signals: { languages: ["typescript"], servesHttp: true } }));
  await ok(["assign", "--unit", unitIdFor(0), "--agent", "security-hunter-agent", "--wave", "1"]);
  if (units === 2) await ok(["assign", "--unit", unitIdFor(1), "--agent", "security-hunter-agent", "--wave", "1"]);
  await ok(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE,
    units: [aUnitResult({ coverageId: unitIdFor(0), status: "candidate", fingerprints: [SQLI] })],
    findings: [aConfirmedFinding()] }));
  return run;
}

/** Settle unit 1, filing a second confirmed claim: the audit's findings move. */
async function fileSecondClaim(run: Run): Promise<void> {
  const invoked = await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE,
    units: [aUnitResult({ coverageId: unitIdFor(1), status: "candidate", fingerprints: [SECOND] })],
    findings: [aConfirmedFinding({ fingerprint: SECOND, title: "SQL injection through the login `name` field",
      root_cause: "The name filter is concatenated into the lookup query." })] }));
  if (!invoked.ok) throw new Error(`submit: ${invoked.error}`);
}

const owedPlan = async (run: Run): Promise<Plan> => {
  const plan = await verificationPlan(run);
  if (plan === null) throw new Error("the audit owes no verification run");
  return plan;
};

const transcriptPath = (plan: Plan, request: SpawnTask) =>
  join(plan.runsRoot, plan.run, "transcripts", request.authority.slotId, `attempt-${request.authority.attempt}.raw`);

describe("security verification, end to end (ADR-0067)", () => {
  it("hunt → status → start security-verification → native capture → verify --from → publish", async () => {
    const run = await huntedAudit(1);
    const plan = await owedPlan(run);
    expect(plan.awaitingBallots).toBe(1);
    expect(plan.runsRoot).toBe(join(run.out, "verification-runs"));
    expect(plan.run).toMatch(/^run\.verify-w1-g1-[0-9a-f]{12}$/);
    expect(plan.input.generation).toBe(1);
    expect(plan.command).toContain(`helper orchestration start security-verification --runs-root '${plan.runsRoot}' --run '${plan.run}'`);
    expect(plan.importCommand).toBe(`loom helper security-audit verify --out '${run.out}' --from '${plan.run}'`);

    // The batch is issued: one security-verifier-agent request on the refutation profile.
    const batch = await startVerification(plan);
    expect(batch.kind).toBe("spawn-batch");
    expect(batch.requests).toHaveLength(1);
    const [request] = batch.requests!;
    expect(request!.authority).toMatchObject({ program: "security-verification", role: "security-verifier-agent", modelProfile: "refutation", attempt: 1 });
    expect(request!.task).toContain(`LOOM_REQUEST_ID: ${request!.authority.requestId}`);
    // The verifier reads its brief through the digest-verifying section reader the task names.
    const reader = /^LOOM_CONTEXT_SECTION_COMMAND: (.+)$/m.exec(request!.task)?.[1];
    expect(reader).toBeDefined();
    const read = spawnSync("bash", ["-c", `${reader!} --section security-verification-brief`], { encoding: "utf8" });
    expect(read.status, read.stderr).toBe(0);
    const brief = JSON.parse(read.stdout) as { fingerprints: string[]; candidates: { fingerprint: string }[]; requestId: string };
    expect(brief).toMatchObject({ fingerprints: [SQLI], requestId: request!.authority.requestId });
    expect(brief.candidates.map((candidate) => candidate.fingerprint)).toEqual([SQLI]);

    expect(await deliver(plan, request!, verifierResult([vote(SQLI)]))).toEqual({ ok: true, message: "captured" });
    // The capturing harness attested exactly what it captured.
    const [attestation] = readdirSync(captureAttestationDir()).map((name) => JSON.parse(readFileSync(join(captureAttestationDir(), name), "utf8")));
    expect(attestation).toMatchObject({ kind: "security-capture-attestation", requestId: request!.authority.requestId,
      slotId: request!.authority.slotId, attempt: 1, role: "security-verifier-agent", harness: "claude",
      runDirectory: realpathSync(join(plan.runsRoot, plan.run)) });
    const done = await resumeVerification(plan);
    expect(done.action?.kind).toBe("done");

    // result.json binds the ballot to the issued request, never to a payload claim.
    const published = parseVerificationResult(JSON.parse(readFileSync(join(plan.runsRoot, plan.run, "result.json"), "utf8")));
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.value.ballots).toHaveLength(1);
    expect(published.value.ballots[0]!.binding).toMatchObject({
      program: "security-verification", runId: plan.run, requestId: request!.authority.requestId,
      slotId: request!.authority.slotId, attempt: 1, role: "security-verifier-agent", profile: "refutation",
      captureDigest: attestation.digest,
    });

    expect((await run.invoke(["verify", "--from", plan.run])).error).toBeNull();
    expect(run.stdout()).toContain("imported 1 bound verdict(s)");
    const verdicts = readJson<VerificationVerdict[]>(run.out, "verdicts.json");
    expect(parseVerificationVerdicts(verdicts).ok).toBe(true);
    expect(verdicts[0]!.binding.requestId).toBe(request!.authority.requestId);
    // Importing the same run again adds nothing.
    expect((await run.invoke(["verify", "--from", join(plan.runsRoot, plan.run)])).error).toBeNull();
    expect(run.stdout()).toContain("already imported");
    expect(readJson<VerificationVerdict[]>(run.out, "verdicts.json")).toHaveLength(1);

    expect(await verificationPlan(run)).toBeNull();
    const publishedRun = await run.invoke(["publish"]);
    expect(publishedRun.error).toBeNull();
    expect(readJson<SecurityFinding[]>(run.out, "security-findings.json").map((finding) => finding.verdict)).toEqual(["confirmed"]);
  });

  it("gives a malformed answer exactly one retry, told why, and binds the retry's ballot", async () => {
    const run = await huntedAudit();
    const plan = await owedPlan(run);
    const batch = await startVerification(plan);
    // A verdict outside the brief is refused at admission, not merged.
    expect((await deliver(plan, batch.requests![0]!, verifierResult([vote(SQLI), vote("api/other:not-in-brief")]))).ok).toBe(true);
    const retry = await resumeVerification(plan);
    expect(retry.action?.kind).toBe("spawn-batch");
    const [second] = retry.action!.requests!;
    expect(second!.authority.attempt).toBe(2);
    expect(second!.task).toContain("not in this brief");
    expect((await deliver(plan, second!, verifierResult([vote(SQLI, { vote: "advisory", missingFact: "whether the WAF strips the quote" })]))).ok).toBe(true);
    const done = await resumeVerification(plan);
    expect(done.action?.kind).toBe("done");
    const published = JSON.parse(readFileSync(join(plan.runsRoot, plan.run, "result.json"), "utf8")) as { ballots: VerificationVerdict[] };
    expect(published.ballots.map((ballot) => [ballot.vote, ballot.binding.attempt])).toEqual([["advisory", 2]]);
    expect((await run.invoke(["verify", "--from", plan.run])).error).toBeNull();
  });

  it("blocks a brief whose retry is refused too — and status names the NEXT generation (E)", async () => {
    const run = await huntedAudit();
    const plan = await owedPlan(run);
    const batch = await startVerification(plan);
    await deliver(plan, batch.requests![0]!, "not json");
    const retry = await resumeVerification(plan);
    await deliver(plan, retry.action!.requests![0]!, verifierResult([]));
    const blocked = await resumeVerification(plan);
    expect(blocked.action).toMatchObject({ kind: "blocked", diagnostic: { kind: "security-verification-blocked" } });
    expect(blocked.action!.diagnostic!.message).toContain(`no verdict for ${SQLI}`);
    expect((await run.invoke(["verify", "--from", plan.run])).error).toContain("has published no result.json");

    // The audit did not change, yet the blocked run no longer owns the claim set.
    const next = await owedPlan(run);
    expect(next.input.generation).toBe(2);
    expect(next.run).toMatch(/^run\.verify-w1-g2-/);
    await verifiedRun(run);
    expect((await run.invoke(["verify", "--from", next.run])).error).toBeNull();
    expect((await run.invoke(["status"])).error).toBeNull();
    expect(run.stdout()).not.toContain("verification:");
  });
});

describe("what a ballot cannot be (ADR-0067 refusals)", () => {
  it("refuses stdin ballots, pointing at the new flow", async () => {
    const run = await huntedAudit();
    const piped = await run.invoke(["verify"], JSON.stringify({ verdicts: [vote(SQLI)] }));
    expect(piped.error).toContain("no longer accepts ballots on stdin");
    expect(piped.error).toContain("verify --out <run-dir> --from <verification-run>");
    expect((await run.invoke(["verify"])).error).toContain("start security-verification");
    expect(readJson<unknown[]>(run.out, "verdicts.json")).toEqual([]);
  });

  it("refuses orchestration submit and correlate into a verifier slot (A)", async () => {
    const run = await huntedAudit();
    const plan = await owedPlan(run);
    const batch = await startVerification(plan);
    const { requestId, slotId, attempt } = batch.requests![0]!.authority;
    const location = ["--runs-root", plan.runsRoot, "--run", plan.run];
    const submitted = await facade(["submit", ...location, "--request", requestId, "--slot", slotId, "--attempt", String(attempt)],
      verifierResult([vote(SQLI)]));
    expect(submitted.error).toContain("orchestration submit refused: security-verification verifier output is captured natively only");
    const correlated = await facade(["correlate", ...location, "--request", requestId, "--harness", "claude",
      "--native-id", "forged-agent", "--agent", "security-verifier-agent"]);
    expect(correlated.error).toContain("orchestration correlate refused");
    // Nothing landed: the slot still awaits its native capture.
    expect(existsSync(transcriptPath(plan, batch.requests![0]!))).toBe(false);
    expect((await resumeVerification(plan)).action?.kind).toBe("spawn-batch");
  });

  it("refuses forged transcript bytes written straight into a verifier slot (B)", async () => {
    const run = await huntedAudit();
    const plan = await owedPlan(run);
    const batch = await startVerification(plan);
    const request = batch.requests![0]!;
    // No harness captured anything: the bytes are simply written into the run.
    mkdirSync(join(plan.runsRoot, plan.run, "transcripts", request.authority.slotId), { recursive: true });
    writeFileSync(transcriptPath(plan, request), verifierResult([vote(SQLI)]));
    expect((await resumeVerification(plan)).action?.kind).toBe("done");
    const refused = await run.invoke(["verify", "--from", plan.run]);
    expect(refused.error).toContain("was not natively captured: no capture attestation");
    expect(readJson<unknown[]>(run.out, "verdicts.json")).toEqual([]);
    // The unimportable run is dead: status names the next generation.
    expect((await owedPlan(run)).input.generation).toBe(2);
  });

  it("refuses a natively captured transcript whose bytes were rewritten afterwards (B)", async () => {
    const run = await huntedAudit();
    const plan = await owedPlan(run);
    const batch = await startVerification(plan);
    const request = batch.requests![0]!;
    expect((await deliver(plan, request, verifierResult([vote(SQLI, { vote: "advisory", missingFact: "x" })]))).ok).toBe(true);
    writeFileSync(transcriptPath(plan, request), verifierResult([vote(SQLI)]));
    expect((await resumeVerification(plan)).action?.kind).toBe("done");
    expect((await run.invoke(["verify", "--from", plan.run])).error).toContain("does not match its capture attestation (capture digest)");
  });

  it("never counts a ballot hand-written into verdicts.json, even a verbatim copy of a real one (B)", async () => {
    const audit = await huntedAudit(1);
    await verifyWith(audit);
    const genuine = readJson<VerificationVerdict[]>(audit.out, "verdicts.json");

    // The same ballot copied into another audit's cache: no run of THAT audit replays it.
    const other = await huntedAudit(1);
    writeFileSync(join(other.out, "verdicts.json"), JSON.stringify(genuine));
    const refused = await other.invoke(["publish"]);
    expect(refused.error).toContain("publish refused");
    expect(refused.error).toContain(`ballots of verification run ${genuine[0]!.binding.runId} (${SQLI}) are not counted`);

    // A cached ballot altered in place: its run no longer replays it.
    writeFileSync(join(audit.out, "verdicts.json"), JSON.stringify([{ ...genuine[0]!, vote: "advisory", missingFact: null }]));
    const altered = await audit.invoke(["publish"]);
    expect(altered.error).toContain("verdicts.json does not hold exactly the ballots");
    expect((await audit.invoke(["status"])).error).toBeNull();
    expect(audit.stdout()).toContain("publication: blocked");
  });

  it("fails closed on a tampered or deleted attestation store (B)", async () => {
    const run = await huntedAudit(1);
    await verifyWith(run);
    const [entry] = readdirSync(captureAttestationDir());
    const path = join(captureAttestationDir(), entry!);
    const original = readFileSync(path, "utf8");

    writeFileSync(path, "{ not an attestation");
    expect((await run.invoke(["publish"])).error).toContain("is not JSON");
    writeFileSync(path, original.replace(/"digest":"[0-9a-f]{64}"/, `"digest":"${"0".repeat(64)}"`));
    expect((await run.invoke(["publish"])).error).toContain("(capture digest)");
    rmSync(captureAttestationDir(), { recursive: true });
    expect((await run.invoke(["publish"])).error).toContain("not natively captured");
    // Restored, the same cache counts again.
    mkdirSync(captureAttestationDir());
    writeFileSync(path, original);
    expect((await run.invoke(["publish"])).error).toBeNull();
  });

  it("refuses a hunter-role capture into a verifier slot", async () => {
    const run = await huntedAudit();
    const plan = await owedPlan(run);
    const batch = await startVerification(plan);
    const refused = await deliver(plan, batch.requests![0]!, verifierResult([vote(SQLI)]), "security-hunter-agent");
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("belongs to security-verifier-agent, not security-hunter-agent");
    expect((await resumeVerification(plan)).action?.kind).toBe("spawn-batch");
  });

  it("refuses a run issued against older findings, and names a new run (E)", async () => {
    const run = await huntedAudit();
    const plan = await verifiedRun(run);
    await fileSecondClaim(run);
    const stale = await run.invoke(["verify", "--from", plan.run]);
    expect(stale.error).toContain("audit findings changed since the verification run was issued");
    expect(readJson<unknown[]>(run.out, "verdicts.json")).toEqual([]);
    // The audit now owes a run over both claims, under a different name.
    const next = await owedPlan(run);
    expect(next.awaitingBallots).toBe(2);
    expect(next.run).not.toBe(plan.run);
  });

  it("names a new run when only the ledger moved after start (E)", async () => {
    const run = await huntedAudit();
    const plan = await owedPlan(run);
    await startVerification(plan);
    // A critic reassignment moves the ledger, not the claim set.
    const merged = await run.invoke(["merge-critic"], JSON.stringify({
      critic: { schemaVersion: 1, kind: "security-coverage-critic", missingUnits: [], reassignIds: [unitIdFor(0)], resolvedPriorLeads: [], stop: false },
      reassignmentReasons: { [unitIdFor(0)]: "The first pass never read the admin route." },
    }));
    expect(merged.error).toBeNull();
    const next = await owedPlan(run);
    expect(next.input.audit.ledgerDigest).not.toBe(plan.input.audit.ledgerDigest);
    expect(next.input.audit.findingsDigest).toBe(plan.input.audit.findingsDigest);
    expect(next.run).not.toBe(plan.run);
    expect(next.input.generation).toBe(1);
    expect((await startVerification(next)).kind).toBe("spawn-batch");
  });

  it("refuses a result.json altered after publication", async () => {
    const run = await huntedAudit();
    const plan = await verifiedRun(run);
    const path = join(plan.runsRoot, plan.run, "result.json");
    writeFileSync(path, readFileSync(path, "utf8").replace("\"critical\"", "\"advisory\""));
    const tampered = await run.invoke(["verify", "--from", plan.run]);
    expect(tampered.error).toContain("does not match the result its captured evidence replays");
    expect(readJson<unknown[]>(run.out, "verdicts.json")).toEqual([]);
  });

  it("refuses a run of another audit, at start and at import", async () => {
    const audit = await huntedAudit();
    const other = await huntedAudit();
    const plan = await verifiedRun(audit);
    // Import from the other audit: the run is not under ITS verification runs.
    const foreign = await other.invoke(["verify", "--from", join(plan.runsRoot, plan.run)]);
    expect(foreign.error).toContain(`--from must name a run under ${join(other.out, "verification-runs")}`);
    // Start a run for one audit under the other's runs root.
    const otherPlan = await owedPlan(other);
    const misplaced = await facade(["start", "security-verification", "--runs-root", plan.runsRoot, "--run", otherPlan.run], JSON.stringify(otherPlan.input));
    expect(misplaced.error).toContain(`a verification run lives under ${otherPlan.runsRoot}`);
  });

  it("refuses a start whose input names a stale audit or a foreign run name", async () => {
    const run = await huntedAudit();
    const plan = await owedPlan(run);
    const stale = { ...plan.input, audit: { ...plan.input.audit, findingsDigest: "f".repeat(64) } };
    expect((await facade(["start", "security-verification", "--runs-root", plan.runsRoot, "--run", plan.run], JSON.stringify(stale))).error)
      .toContain("audit findings changed");
    expect((await facade(["start", "security-verification", "--runs-root", plan.runsRoot, "--run", "run.verify-w1-g1-000000000000"], JSON.stringify(plan.input))).error)
      .toContain(`must be named ${plan.run}`);
  });
});

describe("the audit stays registered while verification runs (D)", () => {
  it("start and resume re-register an audit whose registry was wiped", async () => {
    const run = await huntedAudit();
    const plan = await owedPlan(run);
    rmSync(securityAuditRunRegistryDir(), { recursive: true, force: true });
    const batch = await startVerification(plan);
    expect(registeredSecurityAuditRuns()).toContain(realpathSync(run.out));
    rmSync(securityAuditRunRegistryDir(), { recursive: true, force: true });
    expect(await deliver(plan, batch.requests![0]!, verifierResult([vote(SQLI)]))).toMatchObject({ ok: true });
    expect((await resumeVerification(plan)).action?.kind).toBe("done");
    expect(registeredSecurityAuditRuns()).toContain(realpathSync(run.out));
  });

  it("refuses to start or resume when the audit cannot be registered", async () => {
    const run = await huntedAudit();
    const plan = await owedPlan(run);
    rmSync(securityAuditRunRegistryDir(), { recursive: true, force: true });
    writeFileSync(securityAuditRunRegistryDir(), "not a directory");
    expect((await facade(["start", "security-verification", "--runs-root", plan.runsRoot, "--run", plan.run], JSON.stringify(plan.input))).error)
      .toContain("cannot register audit run");
    rmSync(securityAuditRunRegistryDir());
    await startVerification(plan);
    rmSync(securityAuditRunRegistryDir(), { recursive: true, force: true });
    writeFileSync(securityAuditRunRegistryDir(), "not a directory");
    expect((await resumeVerification(plan)).error).toContain("cannot register audit run");
  });
});

describe("printed commands survive any path (H)", () => {
  it("status prints commands that run verbatim for an audit under a path with spaces and quotes", async () => {
    const parent = join(scratch, "it's an audit dir");
    mkdirSync(parent);
    const run = await huntedAudit(1, aRun(join(basename(scratch), "it's an audit dir", "run ")));
    expect(run.out).toContain("it's an audit dir/run ");
    const plan = await owedPlan(run);
    // Run the printed start through a real shell, with only `loom` replaced.
    const loom = join(scratch, "loom");
    writeFileSync(loom, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(join(scratch, "argv"))}\n`, { mode: 0o755 });
    const ran = spawnSync("bash", ["-c", plan.command], { encoding: "utf8", env: { ...process.env, PATH: `${scratch}:${process.env.PATH}` } });
    expect(ran.status, ran.stderr).toBe(0);
    expect(readFileSync(join(scratch, "argv"), "utf8").split("\n"))
      .toEqual(["helper", "orchestration", "start", "security-verification", "--runs-root", plan.runsRoot, "--run", plan.run, ""]);
    const imported = spawnSync("bash", ["-c", plan.importCommand], { encoding: "utf8", env: { ...process.env, PATH: `${scratch}:${process.env.PATH}` } });
    expect(imported.status).toBe(0);
    expect(readFileSync(join(scratch, "argv"), "utf8").split("\n").slice(0, 7))
      .toEqual(["helper", "security-audit", "verify", "--out", run.out, "--from", plan.run]);
  });
});

describe("Pi capture routing and the parent's import gate (ADR-0067)", () => {
  const PI_SESSION = "pi-session";

  /** A verifier request captured through the Pi path, the run left at
   *  `spawn-batch`: the caller decides whether this session witnessed it. */
  async function piCapturedRun() {
    const { authenticatePiIssuedReviewRequest, classifyPiSecurityVerificationRequest } = await import("../../../pi/review-run-authority");
    const { capturePiSubagentResult } = await import("../../../pi/review-capture");
    const { piSpawnRosterId } = await import("../../../pi/tool-input");
    const { openRegisteredRunDirectory } = await import("../../src/orchestration/run-directory-handle");
    const { createTrustedReviewWitnesses } = await import("../../../pi/trusted-review-witness");

    const run = await huntedAudit(1);
    const plan = await owedPlan(run);
    const batch = await startVerification(plan);
    const opened = openRegisteredRunDirectory(plan.runsRoot, join(plan.runsRoot, plan.run));
    if (!opened.ok) throw new Error(opened.error.message);
    const handle = opened.value;
    const issued = handle.readIssuedRequests();
    if (!issued.ok) throw new Error(issued.error.message);
    const request = issued.value.find(({ requestId }) => requestId === batch.requests![0]!.authority.requestId)!;

    const toolCallId = "pi-verifier-call";
    const recorded = await handle.recordHarnessCorrelator({ schemaVersion: 1, harness: "pi",
      nativeId: piSpawnRosterId(toolCallId, 0, request.role), requestId: request.requestId, role: request.role, attempt: request.attempt });
    if (!recorded.ok) throw new Error(recorded.error.message);
    const binding = Object.freeze({ ...handle.identity, requestIds: Object.freeze([request.requestId]), resultDigest: null });
    const captured = await capturePiSubagentResult(toolCallId, 0, request.role,
      [{ role: "assistant", content: [{ type: "text", text: verifierResult([vote(SQLI)]) }] }], binding);
    if (captured.kind !== "captured") throw new Error(`capture: ${JSON.stringify(captured)}`);
    const witnesses = createTrustedReviewWitnesses();
    const witness = () => witnesses.remember(PI_SESSION, binding, request.role, batch.requests![0]!.task, captured);
    const finish = async () => {
      const done = await resumeVerification(plan);
      expect(done.action?.kind).toBe("done");
      return done;
    };
    const transcript = transcriptPath(plan, batch.requests![0]!);
    return { run, plan, handle, request, witnesses, witness, finish, transcript, authenticatePiIssuedReviewRequest, classifyPiSecurityVerificationRequest };
  }

  /** The parent session's Pi context. */
  const parentCtx = (sessionId = PI_SESSION) => ({
    mode: "tui", cwd: "/repo", hasUI: false,
    sessionManager: { getSessionFile: () => "/s.jsonl", getSessionId: () => sessionId },
  }) as never;
  const bash = (command: string) => ({ toolName: "bash", input: { command } }) as never;
  const verifyCommand = (out: string, from: string) => `loom helper security-audit verify --out ${out} --from ${from}`;

  it("authenticates a verifier request as extraction-only, captures it into its slot and attests the capture", async () => {
    const pi = await piCapturedRun();
    expect(pi.authenticatePiIssuedReviewRequest(pi.handle, pi.request))
      .toMatchObject({ kind: "authenticated", classified: { kind: "security-verification-extraction", claim: { version: "v1" } } });
    expect(pi.classifyPiSecurityVerificationRequest(pi.handle.runId, { ...pi.request, role: "security-hunter-agent" }).ok).toBe(false);
    expect(pi.classifyPiSecurityVerificationRequest("run.other", pi.request).ok).toBe(false);
    const attestations = readdirSync(captureAttestationDir()).map((name) => JSON.parse(readFileSync(join(captureAttestationDir(), name), "utf8")));
    expect(attestations).toEqual([expect.objectContaining({ harness: "pi", requestId: pi.request.requestId, nativeId: expect.stringContaining("pi-verifier-call") })]);

    // The in-process witness still proves what it witnessed.
    const proof = { sessionId: PI_SESSION, runsRoot: pi.handle.identity.runsRoot, runDirectory: pi.handle.runDirectory };
    await expect(pi.witnesses.verifySecurityVerification(proof)).rejects.toThrow("was witnessed");
    pi.witness();
    const done = await pi.finish();
    const receipt = await pi.witnesses.verifySecurityVerification(proof);
    expect(receipt).toMatchObject({ runId: pi.plan.run, requestIds: [pi.request.requestId] });
    expect(receipt.resultDigest).toBe((done.action!.outcome as { digest: string }).digest);
    expect((await pi.run.invoke(["verify", "--from", pi.plan.run])).error).toBeNull();
    expect((await pi.run.invoke(["publish"])).error).toBeNull();
  });

  it("allows the parent's import of a witnessed run, by name or by absolute directory, in every wrapped form", async () => {
    const { piParentVerifyWitnessDecision } = await import("../../../pi/subagent-authority-gate");
    const pi = await piCapturedRun();
    pi.witness();
    await pi.finish();
    for (const from of [pi.plan.run, pi.handle.runDirectory]) {
      expect(await piParentVerifyWitnessDecision(bash(verifyCommand(pi.run.out, from)), parentCtx(), pi.witnesses), from).toBeUndefined();
    }
    for (const command of [
      `cd /tmp && FOO=1 ${verifyCommand(pi.run.out, pi.plan.run)}`,
      `bash -c '${verifyCommand(pi.run.out, pi.plan.run)}'`,
      `bun /plugins/loom/engine/src/cli.ts helper security-audit verify --out ${pi.run.out} --from ${pi.plan.run}`,
      pi.plan.importCommand,
    ]) {
      expect(await piParentVerifyWitnessDecision(bash(command), parentCtx(), pi.witnesses), command).toBeUndefined();
    }
  });

  it("closes the restart gap: an attested run imports without this process's witness", async () => {
    const { piParentVerifyWitnessDecision } = await import("../../../pi/subagent-authority-gate");
    const pi = await piCapturedRun();
    await pi.finish(); // captured and attested — but never witnessed in THIS process (a restart, another session)
    const command = verifyCommand(pi.run.out, pi.plan.run);
    expect(await piParentVerifyWitnessDecision(bash(command), parentCtx(), pi.witnesses)).toBeUndefined();
    expect(await piParentVerifyWitnessDecision(bash(command), parentCtx("other-session"), pi.witnesses)).toBeUndefined();
    expect((await pi.run.invoke(["verify", "--from", pi.plan.run])).error).toBeNull();
  });

  it("blocks the parent's import when neither the witness nor the attestations prove the run", async () => {
    const { piParentVerifyWitnessDecision } = await import("../../../pi/subagent-authority-gate");
    const pi = await piCapturedRun();
    pi.witness();
    // The transcript is rewritten after capture: witness and attestation both contradict it.
    writeFileSync(pi.transcript, verifierResult([vote(SQLI, { vote: "advisory", missingFact: "forged" })]));
    await pi.finish();
    const command = verifyCommand(pi.run.out, pi.plan.run);
    for (const wrapped of [command, `echo start && ${command}`, `bash -c '${command}'`, `eval '${command}'`]) {
      const blocked = await piParentVerifyWitnessDecision(bash(wrapped), parentCtx(), pi.witnesses);
      expect(blocked?.block, wrapped).toBe(true);
      expect(blocked?.reason).toContain("security-verification witness (ADR-0067)");
      expect(blocked?.reason).toContain("(capture digest)");
    }
  });

  it("blocks the parent's import once result.json is altered", async () => {
    const { piParentVerifyWitnessDecision } = await import("../../../pi/subagent-authority-gate");
    const pi = await piCapturedRun();
    pi.witness();
    await pi.finish();
    const resultPath = join(pi.handle.runDirectory, "result.json");
    writeFileSync(resultPath, readFileSync(resultPath, "utf8").replace("\"critical\"", "\"advisory\""));
    const blocked = await piParentVerifyWitnessDecision(bash(verifyCommand(pi.run.out, pi.plan.run)), parentCtx(), pi.witnesses);
    expect(blocked?.reason).toContain("does not match the witnessed evidence replay");
    expect(blocked?.reason).toContain("altered after publication");
  });

  it("blocks an import it cannot place without trusting runtime shell state", async () => {
    const { piParentVerifyWitnessDecision } = await import("../../../pi/subagent-authority-gate");
    const pi = await piCapturedRun();
    pi.witness();
    await pi.finish();
    for (const [command, reason] of [
      [`loom helper security-audit verify --out "$OUT" --from ${pi.plan.run}`, "completed by the shell at runtime"],
      [`loom helper security-audit verify --out ${pi.run.out} --from "$(ls -t | head -1)"`, "completed by the shell at runtime"],
      [`loom helper security-audit $OP --out ${pi.run.out} --from ${pi.plan.run}`, "completed by the shell at runtime"],
      [`cd ${pi.run.out}/.. && loom helper security-audit verify --out ${basename(pi.run.out)} --from ${pi.plan.run}`, "is relative"],
      [`loom helper security-audit verify --out ${pi.run.out} --from verification-runs/${pi.plan.run}`, "is a relative path"],
    ] as const) {
      const blocked = await piParentVerifyWitnessDecision(bash(command), parentCtx(), pi.witnesses);
      expect(blocked?.reason, command).toContain(reason);
    }
  });

  it("has no opinion on anything that imports nothing, or in a subagent process", async () => {
    const { piParentVerifyWitnessDecision } = await import("../../../pi/subagent-authority-gate");
    const pi = await piCapturedRun();
    for (const command of [
      `loom helper security-audit status --out ${pi.run.out}`,
      `loom helper security-audit verify --out ${pi.run.out}`, // no --from: the CLI refuses it
      `loom helper security-audit verify --out ${pi.run.out} --from /elsewhere/run.verify-w1-g1-000000000000`, // not under this audit
      "grep -rn 'helper security-audit verify --from' docs/",
      `echo loom helper security-audit verify --out ${pi.run.out} --from ${pi.plan.run}`,
    ]) {
      expect(await piParentVerifyWitnessDecision(bash(command), parentCtx(), pi.witnesses), command).toBeUndefined();
    }
    const verify = bash(verifyCommand(pi.run.out, pi.plan.run));
    expect(await piParentVerifyWitnessDecision(verify, parentCtx(), pi.witnesses, { kind: "subagent", parentSession: PI_SESSION })).toBeUndefined();
    expect(await piParentVerifyWitnessDecision({ toolName: "read", input: { path: "x" } } as never, parentCtx(), pi.witnesses)).toBeUndefined();
  });

  it("leaves Claude Code's parent untouched by the subagent guard", async () => {
    const { runGuardSubagentAuthority } = await import("../../src/handlers/pre-tool-use/guard-subagent-authority");
    const pi = await piCapturedRun();
    await pi.finish();
    const parent = await runGuardSubagentAuthority(JSON.stringify({
      session_id: "claude-session", cwd: "/repo", hook_event_name: "PreToolUse", tool_name: "Bash",
      tool_input: { command: verifyCommand(pi.run.out, pi.plan.run) },
    }));
    expect(parent.kind).toBe("passthrough");
  });
});
