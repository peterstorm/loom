/**
 * How a security-audit run publishes: adjudication over bound ballots only
 * (a hand-written ballot never counts), the disposition handoff derived from
 * the published records, and a published run that is closed to every
 * operation that would change it. Driven through the CLI seam
 * (`security-audit-harness.ts`, which owns `huntedRun` and `publishedRun`).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseStandaloneDispositionStartInput } from "../../src/core/standalone-disposition-machine";
import { HUNTER_ENVELOPE, aConfirmedFinding, aHunterBallot, aNeedsValidationFinding, aUnitResult, aVerdict } from "../security/fixtures";
import {
  SQLI,
  aRun,
  assignUnit,
  handWriteBallots,
  huntedRun,
  isolateSubagentDir,
  publishedRun,
  readJson,
  readPublished,
  removeRuns,
  startRun,
  unitIdFor,
} from "./security-audit-harness";
import { verifyWith } from "./security-verification-harness";

beforeEach(() => { isolateSubagentDir(); });
afterEach(removeRuns);

describe("adjudication", () => {
  it("demotes a claim to a lead when the ballot names a missing fact", async () => {
    const run = await huntedRun();
    await verifyWith(run, () => ({ vote: "advisory", missingFact: "The deployment may bind the value upstream." }));
    expect((await run.invoke(["publish"])).error).toBeNull();
    const published = readPublished(run.out);
    expect(published.map((finding) => finding.verdict)).toEqual(["needs_validation"]);
    expect(published[0].verdict === "needs_validation" ? published[0].blockers : []).toEqual(["The deployment may bind the value upstream."]);
  });

  it("rejects a claim when the ballot refutes it outright", async () => {
    const run = await huntedRun();
    await verifyWith(run, () => ({ vote: "advisory", missingFact: null }));
    expect((await run.invoke(["publish"])).error).toBeNull();
    expect(readPublished(run.out).map((finding) => finding.verdict)).toEqual(["rejected"]);
  });

  it("never counts a hand-written ballot — not even one whose binding names a verifier — and names its run as a blocker", async () => {
    const run = await huntedRun();
    // A well-formed ballot written into verdicts.json, binding and all (a
    // verifier role on the refutation profile): no verification run under
    // this audit replays it, and no harness attested its capture.
    // (INV-S3 over a REAL ballot's minted profile is the adjudication core's,
    // tests/security/security-adjudication.test.ts.)
    handWriteBallots(run, [aVerdict()]);
    const blocked = await run.invoke(["publish"]);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("are not counted");
    expect(blocked.error).toContain("no verification verdict");
    expect((await run.invoke(["findings", "--json"])).error).toBeNull();
    expect((JSON.parse(run.stdout()) as { publicationBlockers: string[] }).publicationBlockers.join("\n")).toContain("are not counted");
  });

  it("refuses a hand-written ballot bound to the hunt profile outright, as a malformed cache", async () => {
    const run = await huntedRun();
    // A verifier binding on the HUNTER's profile is not a ballot any verifier
    // spawn could cast: the cache parser refuses it before adjudication.
    handWriteBallots(run, [aHunterBallot()]);
    const refused = await run.invoke(["publish"]);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("verdicts.json is malformed");
    expect(refused.error).toContain("binding.profile");
  });

  it("refuses a ballot whose binding names no verifier spawn — a refusal, not an unverified gap (ADR-0067 D5)", async () => {
    const run = await huntedRun();
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
    const run = await startRun(aRun());
    await assignUnit(run, 0);
    const submitted = await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE,
      units: [aUnitResult({ coverageId: unitIdFor(0), status: "covered" })],
      findings: [aNeedsValidationFinding(), aConfirmedFinding()],
    }));
    expect(submitted.error).toBeNull();
    await verifyWith(run);
    expect((await run.invoke(["publish"])).error).toBeNull();
    const published = readPublished(run.out);
    expect(published.map((finding) => finding.verdict).sort()).toEqual(["confirmed", "needs_validation"]);
  });
});

describe("the disposition handoff", () => {
  it("refuses before publish instead of dispositioning unadjudicated claims", async () => {
    const run = await startRun(aRun());
    const early = await run.invoke(["disposition"]);
    expect(early.ok).toBe(false);
    expect(early.error).toContain("publish");
  });

  it("derives one decision per published record", async () => {
    const run = await publishedRun();
    expect((await run.invoke(["disposition"])).error).toBeNull();
    // `entries` is matched as a whole list: exactly one decision, for the one published record.
    expect(readJson(run.out, "disposition.json")).toMatchObject({
      entries: [{ fingerprint: SQLI, decision: "accepted" }],
      source: { locator: run.out },
    });
  });

  it("names the disposition set in the published report", async () => {
    const run = await publishedRun();
    const report = readFileSync(join(run.out, "REPORT.md"), "utf8");
    expect(report).toContain("## Disposition handoff");
    expect(report).toContain(`--runs-root '${join(run.out, "disposition-runs")}'`);
    expect(report).toContain(join(run.out, "standalone-disposition.json"));
  });

  it("writes a handoff the standalone-disposition loader can parse", async () => {
    const run = await publishedRun();
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
    const run = await publishedRun();
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

describe("a published run is closed", () => {
  it.each([
    ["assign", ["assign", "--unit", "any", "--agent", "security-hunter-agent"], ""],
    ["submit", ["submit"], JSON.stringify({ ...HUNTER_ENVELOPE, units: [], findings: [aNeedsValidationFinding()] })],
    ["defer", ["defer", "--reason", "late cut"], ""],
    ["merge-critic", ["merge-critic"], JSON.stringify({
      schemaVersion: 1, kind: "security-coverage-critic", missingUnits: [], reassignIds: [], resolvedPriorLeads: [], stop: true,
    })],
    ["verify", ["verify", "--from", "run.verify-w1-000000000000"], ""],
  ] as const)("refuses %s, naming the published run and the way forward", async (_operation, args, stdin) => {
    const run = await publishedRun();
    const before = ["ledger.json", "findings.json", "verdicts.json"].map((file) => readFileSync(join(run.out, file), "utf8"));
    const refused = await run.invoke([...args], stdin);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("is published");
    expect(refused.error).toContain("start --force");
    // Nothing moved: the committed records still describe the run beside them.
    expect(["ledger.json", "findings.json", "verdicts.json"].map((file) => readFileSync(join(run.out, file), "utf8"))).toEqual(before);
  });

  it("still re-derives its own projections and disposition", async () => {
    const run = await publishedRun();
    expect((await run.invoke(["status"])).error).toBeNull();
    expect((await run.invoke(["findings"])).error).toBeNull();
    expect((await run.invoke(["disposition"])).error).toBeNull();
  });
});
