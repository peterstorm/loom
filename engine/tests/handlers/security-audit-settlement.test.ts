/**
 * How a security-audit run's coverage settles: `defer`, `submit` (owned
 * settlement, convergent retry after a failed ledger write), `merge-critic`
 * (proposals, reassignments, resolved leads) and a reassigned unit re-hunted
 * end to end. Driven through the CLI seam (`security-audit-harness.ts`).
 */

import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HUNTER_ENVELOPE, aConfirmedFinding, aUnitResult, nSeeds } from "../security/fixtures";
import {
  SQLI,
  aRun,
  assignUnit,
  claimPayload,
  isolateSubagentDir,
  readClaims,
  readLedger,
  readPublished,
  removeRuns,
  seedFor,
  startRun,
  unitIdFor,
} from "./security-audit-harness";
import type { Run } from "./security-audit-run-seam";
import { verifyWith } from "./security-verification-harness";

beforeEach(() => { isolateSubagentDir(); });
afterEach(removeRuns);

describe("coverage settlement", () => {
  it("defers a single planned unit with a reason", async () => {
    const run = await startRun(aRun(), { units: nSeeds(2) });
    expect((await run.invoke(["defer", "--unit", unitIdFor(1), "--reason", "budget_cut"])).error).toBeNull();
    const ledger = readLedger(run.out);
    expect(ledger.find((unit) => unit.coverage_id === unitIdFor(1))?.status).toBe("deferred");
    expect(ledger.find((unit) => unit.coverage_id === unitIdFor(1))?.unresolved).toContain("budget_cut");
    expect(ledger.find((unit) => unit.coverage_id === unitIdFor(0))?.status).toBe("planned");
  });

  it("defers every planned unit when no unit is named", async () => {
    const run = await startRun(aRun(), { units: nSeeds(2) });
    expect((await run.invoke(["defer", "--reason", "scope_narrowed"])).error).toBeNull();
    expect(readLedger(run.out).every((unit) => unit.status === "deferred")).toBe(true);
  });

  it("refuses to defer a unit that is already owned", async () => {
    const run = await startRun(aRun());
    await assignUnit(run, 0);
    const deferred = await run.invoke(["defer", "--unit", unitIdFor(0), "--reason", "budget_cut"]);
    expect(deferred.ok).toBe(false);
    expect(deferred.error).toContain(unitIdFor(0));
  });

  it("refuses a settlement from an agent that does not own the unit", async () => {
    const run = await startRun(aRun());
    await assignUnit(run, 0);
    const wrong = await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE,
      units: [aUnitResult({ coverageId: unitIdFor(0), agentId: "security-critic-agent" })],
    }));
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toContain("wrong-owner");
  });

  it("refuses to publish while a unit is still planned", async () => {
    const run = await startRun(aRun(), { units: nSeeds(2) });
    const blocked = await run.invoke(["publish"]);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain("coverage ledger still has");
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
  const run = await startRun(aRun());
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
    const added = readLedger(run.out).find((unit) => unit.coverage_id === unitIdFor(1));
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
    const [unit] = readLedger(run.out);
    expect(unit!.status).toBe("planned");
    expect(unit!.wave).toBe(2);
    expect(unit!.attempts).toHaveLength(1);
    expect(unit!.attempts[0]!.reassignment_reason).toBe(reason);
    expect(unit!.attempts[0]!.agent_id).toBe("security-hunter-agent");
  });

  it("resolves a prior lead on the unit that carries it", async () => {
    const run = await settledRun({ status: "candidate", fingerprints: [SQLI], unresolved: ["lead:admin-export"] });
    const merged = await run.invoke(["merge-critic"], JSON.stringify({
      critic: aCritic({ resolvedPriorLeads: ["lead:admin-export"] }),
      priorLeadOwners: { "lead:admin-export": unitIdFor(0) },
    }));
    expect(merged.error).toBeNull();
    expect(run.stdout()).toContain("resolved 1 prior lead(s)");
    expect(readLedger(run.out)[0]!.unresolved).toEqual([]);
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

  it("refuses a reassignment without its reason, writing nothing", async () => {
    const run = await settledRun();
    const before = readFileSync(join(run.out, "ledger.json"), "utf8");
    const refused = await run.invoke(["merge-critic"], JSON.stringify(aCritic({ reassignIds: [unitIdFor(0)] })));
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain(`missing-reassignment-reason: coverageId=${unitIdFor(0)}`);
    expect(readFileSync(join(run.out, "ledger.json"), "utf8")).toBe(before);
  });
});

// --- Consolidation is reported, never silent ---

describe("submit reports what consolidation absorbed", () => {
  it("names a filing of a held defect under a new fingerprint, and the record kept in its place", async () => {
    const run = await startRun(aRun(), { units: nSeeds(2) });
    await assignUnit(run, 0);
    await assignUnit(run, 1);
    // The run holds the confirmed claim SQLI (unit 0).
    expect((await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE,
      units: [aUnitResult({ coverageId: unitIdFor(0), status: "candidate", fingerprints: [SQLI] })],
      findings: [aConfirmedFinding()],
    }))).error).toBeNull();
    // A second hunter files the same sink and root cause under a new fingerprint.
    const refiled = aConfirmedFinding({ fingerprint: "api/auth:sqli-login-email" });
    const submitted = await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE,
      units: [aUnitResult({ coverageId: unitIdFor(1), status: "candidate", fingerprints: ["api/auth:sqli-login-email"] })],
      findings: [refiled],
    }));
    expect(submitted.error).toBeNull();
    expect(run.stdout()).toContain(`absorbed api/auth:sqli-login-email: same sink and root cause as ${SQLI}, which the run keeps in its place`);
    expect(readClaims(run.out).map((finding) => finding.fingerprint)).toEqual([SQLI]);
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
        fingerprints: [SQLI],
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
    expect(readPublished(run.out).map((finding) => finding.verdict)).toEqual(["confirmed"]);
  });
});

// --- A submit retried after a failed ledger write converges ---

describe("a submit whose ledger write fails", () => {
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

  it.skipIf(isRoot)("keeps the findings, leaves the units in flight, and a retry converges", async () => {
    const run = await startRun(aRun());
    await assignUnit(run, 0);
    const payload = claimPayload(0);

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
    expect(readClaims(run.out).map((finding) => finding.fingerprint)).toEqual([SQLI]);
    expect(readLedger(run.out)[0]!.status).toBe("in_progress");

    const retried = await run.invoke(["submit"], payload);
    expect(retried.error).toBeNull();
    expect(run.stdout()).toContain("run now holds 1 finding record(s)");
    expect(run.stdout()).not.toContain("not merged");
    expect(readClaims(run.out)).toHaveLength(1);
    expect(readLedger(run.out)[0]!.status).toBe("candidate");
  });

  it("refuses a re-filed fingerprint whose record differs, before writing anything", async () => {
    const run = await startRun(aRun(), { units: nSeeds(2) });
    await assignUnit(run, 0);
    await assignUnit(run, 1);
    expect((await run.invoke(["submit"], claimPayload(0))).error).toBeNull();
    const before = ["ledger.json", "findings.json"].map((file) => readFileSync(join(run.out, file), "utf8"));

    // The conflicting submit ALSO carries a unit that would settle cleanly: the
    // refusal must come before the ledger write, not after it.
    const refiled = await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE,
      units: [aUnitResult({ coverageId: unitIdFor(1), reviewedPaths: ["src/api/login.ts"] })],
      findings: [aConfirmedFinding({ title: "A different title for the same defect" })],
    }));
    expect(refiled.ok).toBe(false);
    expect(refiled.error).toContain("filed findings refused");
    expect(refiled.error).toContain(`the run already holds a different record for ${SQLI}`);
    expect(refiled.error).toContain("re-file byte-identical");
    expect(["ledger.json", "findings.json"].map((file) => readFileSync(join(run.out, file), "utf8"))).toEqual(before);
    expect(readLedger(run.out).find((unit) => unit.coverage_id === unitIdFor(1))?.status).toBe("in_progress");
  });

  it("keeps one copy of a verbatim re-file, whatever its key order", async () => {
    const run = await startRun(aRun());
    await assignUnit(run, 0);
    expect((await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE, units: [], findings: [aConfirmedFinding()] }))).error).toBeNull();
    const reordered = Object.fromEntries(Object.entries(aConfirmedFinding()).reverse());
    const again = await run.invoke(["submit"], JSON.stringify({ ...HUNTER_ENVELOPE, units: [], findings: [reordered] }));
    expect(again.error).toBeNull();
    expect(readClaims(run.out)).toHaveLength(1);
  });
});
