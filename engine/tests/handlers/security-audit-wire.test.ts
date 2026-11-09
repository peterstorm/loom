/**
 * The security-audit helper's wire: every stdin payload and flag is PARSED —
 * a strict envelope, a closed key set, named fields — rather than coerced, and
 * a refused payload writes nothing. Driven through the CLI seam
 * (`security-audit-harness.ts`).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SecurityRunMetadata } from "../../src/core/security-audit-contract";
import { HUNTER_ENVELOPE, aNeedsValidationFinding, aSeed, aUnitResult, aVerdict } from "../security/fixtures";
import {
  SOURCE,
  STARTED,
  aRun,
  assignUnit,
  handWriteBallots,
  isolateSubagentDir,
  readJson,
  removeRuns,
  seedFor,
  startRun,
  type Run,
} from "./security-audit-harness";

beforeEach(() => { isolateSubagentDir(); });
afterEach(removeRuns);

describe("the wire", () => {
  it("refuses a submit payload with no units and no findings", async () => {
    const run = await startRun(aRun());
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
    const run = await startRun(aRun());
    await assignUnit(run, 0);
    const before = ["ledger.json", "findings.json"].map((file) => readFileSync(join(run.out, file), "utf8"));
    const refused = await run.invoke(["submit"], JSON.stringify(payload));
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain("submit input is not a security-hunter-result");
    for (const fragment of expected) expect(refused.error).toContain(fragment);
    expect(["ledger.json", "findings.json"].map((file) => readFileSync(join(run.out, file), "utf8"))).toEqual(before);
  });

  it("accepts a findings-only result with an empty units list", async () => {
    const run = await startRun(aRun());
    const filed = await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE, units: [], findings: [aNeedsValidationFinding()] }));
    expect(filed.error).toBeNull();
    expect(run.stdout()).toContain("settled 0 unit(s); run now holds 1 finding record(s)");
  });

  it("names the offending field when a unit result is malformed", async () => {
    const run = await startRun(aRun());
    const malformed = await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE, units: [aUnitResult({ status: "maybe" })] }));
    expect(malformed.ok).toBe(false);
    expect(malformed.error).toContain("units[0].status");
  });

  it("refuses a recorded ballot with an invented field", async () => {
    const run = await startRun(aRun());
    handWriteBallots(run, [aVerdict({ invented: "high" })]);
    const invented = await run.invoke(["status"]);
    expect(invented.ok).toBe(false);
    expect(invented.error).toContain("verdicts[0].invented: unknown field");
  });

  it("refuses an unknown flag rather than ignoring it", async () => {
    const run = await startRun(aRun());
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
    const duplicate = await run.invoke(["start", "--repo", run.out, "--source", SOURCE], JSON.stringify({ units: [aSeed(), aSeed()] }));
    expect(duplicate.ok).toBe(false);
    expect(duplicate.error).toContain("duplicate coverage cell");
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
