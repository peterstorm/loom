/**
 * The shell half of "a ballot is authoritative only while its run proves it"
 * (`security-verification-proofs.ts`), and the one refusal renderer every audit
 * shell prints through (`describeAuditRefusal`), each branch asserted on its
 * own. The end-to-end suites reach these only through whole runs, where one
 * branch's regression can hide behind another's success; here every
 * fail-closed branch is driven by injecting exactly its fault into a real run.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeAuditRefusal, readAuditSnapshot, verificationRunsRoot } from "../../src/handlers/helpers/security-audit-run";
import {
  observeVerificationGenerations,
  proveCachedBallots,
  proveVerificationSource,
  readVerificationSource,
} from "../../src/handlers/helpers/security-verification-proofs";
import { aVerdict } from "../security/fixtures";
import { handWriteBallots, huntedRun, isolateSubagentDir, removeRuns } from "./security-audit-harness";
import { verificationPlan, verifiedRun, startVerification } from "./security-verification-harness";

beforeEach(() => { isolateSubagentDir(); });
afterEach(removeRuns);

describe("describeAuditRefusal renders every refusal shape as prose", () => {
  it.each([
    ["a string, as-is", "the run is published", "the run is published"],
    ["violations, one `path: message` per line",
      { violations: [{ path: "$[0].wave", message: "expected a positive integer" }, { path: "$[1]", message: "expected an object" }] },
      "$[0].wave: expected a positive integer\n$[1]: expected an object"],
    ["a violation missing its path or message", { violations: [{}, "junk"] }, "$: invalid\n$: invalid"],
    ["issues, one per line", { issues: ["runId: required", "budget: expected a number"] }, "runId: required\nbudget: expected a number"],
    ["a message", { kind: "invalid-security-disposition", message: "duplicate fingerprint a/b" }, "duplicate fingerprint a/b"],
    ["a tagged refusal with its facts", { kind: "missing-reassignment-reason", coverageId: "a::b::c::d", count: 2 },
      "missing-reassignment-reason: coverageId=a::b::c::d count=2"],
    ["a bare tag", { kind: "unit-not-planned" }, "unit-not-planned"],
    ["anything else, as JSON", 42, "42"],
    ["an array, as JSON", ["a", 1], "[\"a\",1]"],
  ] as const)("%s", (_case, refusal, expected) => {
    expect(describeAuditRefusal(refusal)).toBe(expected);
  });
});

describe("readVerificationSource refuses every source it cannot read", () => {
  it("refuses a --from outside the audit's own verification runs root", async () => {
    const run = await huntedRun();
    const read = readVerificationSource(run.out, "../elsewhere");
    expect(read.ok ? "" : read.error).toContain(`--from must name a run under ${verificationRunsRoot(run.out)}`);
  });

  it("refuses a directory that is not a registered security-verification run", async () => {
    const run = await huntedRun();
    mkdirSync(join(verificationRunsRoot(run.out), "run.verify-w1-g1-planted"), { recursive: true });
    const read = readVerificationSource(run.out, "run.verify-w1-g1-planted");
    expect(read.ok).toBe(false);
  });

  it("refuses a run that has published no result.json yet", async () => {
    const run = await huntedRun();
    const plan = await verificationPlan(run);
    await startVerification(plan!);
    const read = readVerificationSource(run.out, plan!.run);
    expect(read.ok ? "" : read.error).toContain("has published no result.json");
  });

  it("refuses a result.json that is not JSON, or not a published result", async () => {
    const run = await huntedRun();
    const plan = await verifiedRun(run);
    const result = join(plan.runsRoot, plan.run, "result.json");
    writeFileSync(result, "{not json");
    const garbled = readVerificationSource(run.out, plan.run);
    expect(garbled.ok ? "" : garbled.error).toContain("result.json is not valid JSON");
    writeFileSync(result, "{}\n");
    const foreign = readVerificationSource(run.out, plan.run);
    expect(foreign.ok ? "" : foreign.error).toContain("result.json is malformed");
  });
});

describe("proveVerificationSource proves result.json against the run's own evidence", () => {
  it("accepts the result the captured evidence replays", async () => {
    const run = await huntedRun();
    const plan = await verifiedRun(run);
    const source = readVerificationSource(run.out, plan.run);
    if (!source.ok) throw new Error(source.error);
    expect(await proveVerificationSource(source.value)).toEqual({ ok: true, value: undefined });
  });

  it("refuses a result.json altered after publication, even one that still parses", async () => {
    const run = await huntedRun();
    const plan = await verifiedRun(run);
    const path = join(plan.runsRoot, plan.run, "result.json");
    writeFileSync(path, readFileSync(path, "utf8").replace("\"critical\"", "\"advisory\""));
    const source = readVerificationSource(run.out, plan.run);
    if (!source.ok) throw new Error(source.error);
    const proven = await proveVerificationSource(source.value);
    expect(proven.ok ? "" : proven.error).toContain("altered after publication");
  });
});

describe("observeVerificationGenerations fails closed into data", () => {
  it("reports nothing when the audit has no runs root at all", async () => {
    const run = await huntedRun();
    rmSync(verificationRunsRoot(run.out), { recursive: true, force: true });
    const observed = await observeVerificationGenerations(run.out);
    expect(observed.ok ? [...observed.value] : null).toEqual([]);
  });

  it("refuses an unlistable runs root rather than reporting it empty", async () => {
    const run = await huntedRun();
    rmSync(verificationRunsRoot(run.out), { recursive: true, force: true });
    writeFileSync(verificationRunsRoot(run.out), "not a directory\n");
    const observed = await observeVerificationGenerations(run.out);
    expect(observed.ok ? "" : observed.error).toContain(`cannot list ${verificationRunsRoot(run.out)}`);
  });

  it("calls an in-flight run live and a planted unopenable one dead, with its reason", async () => {
    const run = await huntedRun();
    const plan = await verificationPlan(run);
    await startVerification(plan!);
    mkdirSync(join(verificationRunsRoot(run.out), "run.verify-w1-g9-planted"));
    const observed = await observeVerificationGenerations(run.out);
    if (!observed.ok) throw new Error(observed.error);
    expect(observed.value.get(plan!.run)).toEqual({ state: "live" });
    const planted = observed.value.get("run.verify-w1-g9-planted");
    expect(planted?.state).toBe("dead");
    expect(planted?.state === "dead" ? planted.reason : "").toContain("it cannot be opened");
  });

  it("calls a finished run whose capture no longer replays to an attested ballot dead (unimportable)", async () => {
    const run = await huntedRun();
    const plan = await verifiedRun(run);
    // Rewrite the captured transcript: the replay now binds a digest no
    // capture attestation names.
    const transcripts = join(plan.runsRoot, plan.run, "transcripts");
    const [slot] = readdirSync(transcripts);
    const attempt = join(transcripts, slot!, "attempt-1.raw");
    writeFileSync(attempt, readFileSync(attempt, "utf8").replace("critical", "advisory").replace("\"missingFact\":null", "\"missingFact\":\"forged\""));
    const observed = await observeVerificationGenerations(run.out);
    if (!observed.ok) throw new Error(observed.error);
    const state = observed.value.get(plan.run);
    expect(state?.state).toBe("dead");
    expect(state?.state === "dead" ? state.reason : "").toMatch(/unimportable|blocked/);
  });
});

describe("proveCachedBallots never counts a ballot its run cannot prove", () => {
  it("names the run of a hand-written ballot as unprovable and counts none of its ballots", async () => {
    const run = await huntedRun();
    handWriteBallots(run, [aVerdict({ wave: 1, binding: { runId: "run.verify-w1-g1-nowhere" } })]);
    const snapshot = readAuditSnapshot(run.out);
    if (!snapshot.ok) throw new Error(snapshot.error);
    const admission = await proveCachedBallots(snapshot.value);
    expect(admission.admitted).toEqual([]);
    expect(admission.blockers).toHaveLength(1);
    expect(admission.blockers[0]).toContain("ballots of verification run run.verify-w1-g1-nowhere");
    expect(admission.blockers[0]).toContain("are not counted");
  });
});
