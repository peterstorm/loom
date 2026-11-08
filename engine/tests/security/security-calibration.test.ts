/**
 * Calibration: does the program reach the defects, and does it report them?
 *
 * A security audit's failure mode is not a crash — it is a confident report over
 * a target nobody actually enumerated. `tests/fixtures/security/calibration/` is
 * a small application with exactly one planted defect per attack class the audit
 * claims to cover, each marked on a known line. This test holds the program to
 * three claims in order:
 *
 *   1. the fixture is honest — every marker is on the line `DEFECTS.json` names,
 *      and every planted file is reachable from the repository root;
 *   2. the ENUMERATION reaches every defect — the selected lenses include the one
 *      each defect names, and the seeded ledger produces a coverage unit whose
 *      starting paths include the defect's file;
 *   3. the REPORT reaches every defect — one recorded run through the helper
 *      publishes each planted defect exactly once, with complete coverage.
 *
 * Claim 3 is a golden run over recorded records, not a live hunt: it proves the
 * program's own path (seed → settle → adjudicate → publish → disposition) is
 * total, while claim 2 is what proves a hunter would be pointed at the defect.
 * Either alone is a weaker statement than the audit makes.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalCoverageId, type CoverageRefs, type SecurityRunMetadata } from "../../src/core/security-audit-contract";
import { parseCoverageSeeds, type CoverageLedger } from "../../src/core/security-coverage";
import { parseSecurityFindings, type SecurityFinding, type SeverityScore } from "../../src/core/security-findings";
import { parseVerificationVerdicts } from "../../src/core/security-adjudication";
import { SECURITY_LENSES, selectSecurityLenses, type StackSignals } from "../../src/core/security-lens-select";
import { SECURITY_PROFILE_LENSES, parseSecurityRunMetadata } from "../../src/core/security-audit-contract";
import { securityDisposition } from "../../src/core/security-disposition";
import { renderRunDocuments } from "../../src/core/security-reports";
import { aConfirmedFinding, aSeed, aUnitResult, aVerdict } from "./fixtures";
import { createSecurityAuditHandler } from "../../src/handlers/helpers/security-audit";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const CALIBRATION_ROOT = resolve(__dirname, "../fixtures/security/calibration");

type PlantedDefect = Readonly<{
  id: string;
  file: string;
  line: number;
  attack_class: string;
  surface: string;
  boundary: string;
  subsystem: string;
  lens: string;
  impact: SeverityScore;
  claim: string;
}>;

type DefectSet = Readonly<{ schemaVersion: 1; kind: string; signals: StackSignals; defects: readonly PlantedDefect[] }>;

const DEFECTS = JSON.parse(readFileSync(join(CALIBRATION_ROOT, "DEFECTS.json"), "utf-8")) as DefectSet;

const METADATA: SecurityRunMetadata = {
  schemaVersion: 1,
  runId: "calibration-run",
  repo: CALIBRATION_ROOT,
  target: CALIBRATION_ROOT,
  profile: "standard",
  scope: { paths: DEFECTS.defects.map((defect) => defect.file).sort(), kind: "tree", baseRef: null, headRef: null },
  scopePaths: [...new Set(DEFECTS.defects.map((defect) => defect.file))].sort(),
  sourceRef: { commit: "0".repeat(40), worktreeDirty: false },
  budget: 24,
  executionPolicy: "sandboxed-source-and-local-only",
  selectedCompanions: [],
  priorRuns: [],
  runStatus: "complete",
  incompleteReason: null,
};

const refsFor = (defect: PlantedDefect): CoverageRefs => ({
  surface: defect.surface,
  boundary: defect.boundary,
  subsystem: defect.subsystem,
  attack_class: defect.attack_class,
});

const seeds = (): readonly Record<string, unknown>[] => DEFECTS.defects.map((defect) => aSeed({
  refs: refsFor(defect),
  starting_paths: [defect.file],
  ordinary_attack_class_block: `Ordinary ${defect.attack_class} block for ${defect.subsystem}.`,
  selected_companion_blocks: [`${defect.lens}#${defect.attack_class}`],
}));

const ledgerOf = (): CoverageLedger => {
  const parsed = parseCoverageSeeds(seeds());
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
};

const findingFor = (defect: PlantedDefect): Record<string, unknown> => aConfirmedFinding({
  fingerprint: `calibration/${defect.id.toLowerCase()}`,
  title: `${defect.id}: ${defect.claim}`,
  description: defect.claim,
  trace: [
    { kind: "entrypoint", file: defect.file, line: defect.line, scope: defect.subsystem, description: defect.claim },
    { kind: "sink", file: defect.file, line: defect.line, scope: defect.boundary, description: defect.claim },
  ],
  evidence: [{ file: defect.file, line: defect.line, description: defect.claim }],
  severity: {
    likelihood: { score: "high", reason: "The entry point is unauthenticated in the fixture." },
    impact: { score: defect.impact, reason: `${defect.impact} impact is recorded on the planted defect.` },
    overall_severity: defect.impact,
  },
});

const parseFindings = (raw: readonly unknown[]): readonly SecurityFinding[] => {
  const parsed = parseSecurityFindings(raw);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
};

describe("the calibration fixture is honest", () => {
  it("plants at least one defect per attack class it claims", () => {
    expect(DEFECTS.kind).toBe("security-audit-calibration-target");
    expect(DEFECTS.defects.length).toBeGreaterThanOrEqual(6);
    expect(new Set(DEFECTS.defects.map((defect) => defect.attack_class)).size).toBe(DEFECTS.defects.length);
  });

  it("keeps every marker on the line DEFECTS.json names", () => {
    for (const defect of DEFECTS.defects) {
      const lines = readFileSync(join(CALIBRATION_ROOT, defect.file), "utf-8").split("\n");
      expect(lines[defect.line - 1], `${defect.id} at ${defect.file}:${defect.line}`).toContain(`CALIBRATION: ${defect.id}`);
    }
  });

  it("names a vendored lens for every defect", () => {
    for (const defect of DEFECTS.defects) {
      expect(SECURITY_LENSES as readonly string[], defect.id).toContain(defect.lens);
    }
  });
});

describe("the enumeration reaches every planted defect", () => {
  it("selects the lens each defect names at the deep profile's cap", () => {
    const selection = selectSecurityLenses(DEFECTS.signals, { maxLenses: SECURITY_PROFILE_LENSES.deep });
    const included = selection.included.map((entry) => entry.lens);
    // ATTACK-CLASSES is the floor: every run holds it first.
    expect(included[0]).toBe("ATTACK-CLASSES.md");
    for (const defect of DEFECTS.defects) {
      expect(included, `${defect.id} needs ${defect.lens}`).toContain(defect.lens);
    }
  });

  it("explains every lens the profile's cap trims instead of dropping it", () => {
    const selection = selectSecurityLenses(DEFECTS.signals, { maxLenses: SECURITY_PROFILE_LENSES.standard });
    const included = selection.included.map((entry) => entry.lens);
    const excluded = selection.excluded.map((entry) => entry.lens);
    // A capped lens is named with its rank, so an operator can raise the
    // profile rather than guess why a lens is missing.
    // ATTACK-CLASSES.md is added on top of the cap, which counts companions.
    expect(included.length).toBeLessThanOrEqual(SECURITY_PROFILE_LENSES.standard + 1);
    expect(excluded.length).toBeGreaterThan(0);
    // Two kinds of exclusion, both named: a lens with matching signals that the
    // cap trimmed (with its rank), and a lens with no signal at all.
    for (const entry of selection.excluded) {
      expect(entry.reason).toMatch(/beyond the \d+-lens cap|no matching signal/);
    }
    const trimmed = selection.excluded.filter((entry) => entry.reason.includes("beyond the"));
    expect(trimmed.length).toBeGreaterThan(0);
    for (const defect of DEFECTS.defects) {
      expect([...included, ...excluded], defect.id).toContain(defect.lens);
    }
  });

  it("seeds a unit whose starting paths include the defect's file", () => {
    const ledger = ledgerOf();
    expect(ledger).toHaveLength(DEFECTS.defects.length);
    for (const defect of DEFECTS.defects) {
      const id = canonicalCoverageId(refsFor(defect));
      const unit = ledger.find((candidate) => candidate.coverage_id === id);
      expect(unit, defect.id).toBeDefined();
      expect(unit?.starting_paths).toContain(defect.file);
      expect(unit?.status).toBe("planned");
    }
  });

  it("keeps ATTACK-CLASSES in a quick run, whatever else the cap trims", () => {
    const selection = selectSecurityLenses(DEFECTS.signals, { maxLenses: SECURITY_PROFILE_LENSES.quick });
    expect(selection.included.map((entry) => entry.lens)).toContain("ATTACK-CLASSES.md");
    expect(selection.included.length).toBeLessThanOrEqual(SECURITY_PROFILE_LENSES.quick + 1);
  });

  it("gives every unit a distinct canonical id", () => {
    const ledger = ledgerOf();
    expect(new Set(ledger.map((unit) => unit.coverage_id)).size).toBe(ledger.length);
  });
});

/** The golden run, built from the same seeds the enumeration produced: each
 *  unit is assigned, settled with the defect's fingerprint, and verified by a
 *  ballot from ANOTHER profile — the shape a real run has, and the only shape
 *  that confirms (INV-S3): the hunt runs deep, so the ballots say standard. */
const recordedRun = () => {
    const ledger = ledgerOf();
    // A findings document is sorted by fingerprint, so build it that way
    // rather than relying on the fixture's declaration order.
    const findings = parseFindings([...DEFECTS.defects]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map(findingFor));
    const verdicts = parseVerificationVerdicts(DEFECTS.defects.map((defect) =>
      aVerdict({ fingerprint: `calibration/${defect.id.toLowerCase()}`, profile: "standard" })));
    if (!verdicts.ok) throw new Error(JSON.stringify(verdicts.error));
    return { ledger, findings, verdicts: verdicts.value };
};

describe("a recorded run reaches every planted defect", () => {

  it("publishes each planted defect exactly once", () => {
    const { ledger, findings } = recordedRun();
    const metadata: SecurityRunMetadata = {
      ...METADATA,
      selectedCompanions: selectSecurityLenses(DEFECTS.signals, { maxLenses: SECURITY_PROFILE_LENSES.deep }).included.map((entry) => entry.lens),
    };
    const parsed = parseSecurityRunMetadata(metadata);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));

    const settled = ledger.map((unit) => {
      const defect = DEFECTS.defects.find((candidate) => canonicalCoverageId(refsFor(candidate)) === unit.coverage_id);
      if (defect === undefined) throw new Error(`unmapped unit ${unit.coverage_id}`);
      return { ...unit, status: "candidate" as const, agent_id: "security-hunter-agent", reviewed_paths: [defect.file] };
    });
    const documents = renderRunDocuments({ metadata: parsed.value, ledger: settled, findings, locator: "/calibration" });
    const report = documents["REPORT.md"] ?? "";

    for (const defect of DEFECTS.defects) {
      const fingerprint = `calibration/${defect.id.toLowerCase()}`;
      expect(report.split(fingerprint)).toHaveLength(2);
    }
    expect(report).toContain(`${DEFECTS.defects.length} confirmed, 0 needing validation, 0 rejected`);
    expect(report).toContain("## Disposition handoff");
  });

  it("derives one accepted decision per confirmed defect", () => {
    const { findings } = recordedRun();
    const disposition = securityDisposition({ metadata: METADATA, locator: "/calibration", findings });
    if (!disposition.ok) throw new Error(disposition.error.message);
    expect(disposition.value.entries).toHaveLength(DEFECTS.defects.length);
    expect(disposition.value.entries.every((entry) => entry.decision === "accepted")).toBe(true);
  });

  it("drives the same records through the helper's own operations", async () => {
    const out = mkdtempSync(join(tmpdir(), "loom-calibration-"));
    try {
      const printed: string[] = [];
      const handler = createSecurityAuditHandler((text) => { printed.push(text); });
      const invoke = async (args: readonly string[], stdin = "") =>
        handler(stdin, [args[0] ?? "", "--out", out, ...args.slice(1)]);

      const expectOk = (result: { kind: string; message?: string }, step: string) => {
        if (result.kind === "error") throw new Error(`${step}: ${result.message ?? "error"}`);
      };

      const started = await invoke(
        ["start", "--repo", CALIBRATION_ROOT, "--source", "0".repeat(40), "--profile", "deep", "--budget", "24"],
        JSON.stringify({ units: seeds(), signals: DEFECTS.signals }),
      );
      expectOk(started, "start");

      const results = DEFECTS.defects.map((defect) => aUnitResult({
        coverageId: canonicalCoverageId(refsFor(defect)),
        status: "candidate",
        reviewedPaths: [defect.file],
        fingerprints: [`calibration/${defect.id.toLowerCase()}`],
        checks: [{
          agent_id: "security-hunter-agent",
          reviewed_paths: [defect.file],
          invariant: `No untrusted input reaches the sink in ${defect.subsystem}.`,
          method: "source",
          result: defect.claim,
          artifact: null,
        }],
      }));

      for (const defect of DEFECTS.defects) {
        const assigned = await invoke(["assign", "--unit", canonicalCoverageId(refsFor(defect)), "--agent", "security-hunter-agent", "--wave", "1"]);
        expectOk(assigned, `assign ${defect.id}`);
      }

      const submitted = await invoke(["submit"], JSON.stringify({ units: results, findings: DEFECTS.defects.map(findingFor) }));
      expectOk(submitted, "submit");

      const verified = await invoke(["verify"], JSON.stringify({
        verdicts: DEFECTS.defects.map((defect) => aVerdict({ fingerprint: `calibration/${defect.id.toLowerCase()}`, profile: "standard" })),
      }));
      expectOk(verified, "verify");

      const published = await invoke(["publish"]);
      expectOk(published, "publish");
      const publishedFindings = JSON.parse(readFileSync(join(out, "security-findings.json"), "utf-8")) as readonly { fingerprint: string }[];
      expect(publishedFindings.map((finding) => finding.fingerprint).sort()).toEqual(
        DEFECTS.defects.map((defect) => `calibration/${defect.id.toLowerCase()}`).sort(),
      );
      expect(readFileSync(join(out, "REPORT.md"), "utf-8")).toContain("coverage");

      const disposition = await invoke(["disposition"]);
      expectOk(disposition, "disposition");
      const decisions = JSON.parse(readFileSync(join(out, "disposition.json"), "utf-8")) as { entries: readonly { decision: string }[] };
      expect(decisions.entries).toHaveLength(DEFECTS.defects.length);
      expect(decisions.entries.every((entry) => entry.decision === "accepted")).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("the fixture is not a happy-path prop", () => {
  it("fails to reach a defect whose attack class no seeded unit covers", () => {
    // Drop the access-control cell: the authorization defect now belongs to no
    // unit, which is exactly the gap the enumeration exists to make visible.
    const withoutAuthz = seeds().slice(0, -1).filter((_seed, index) => DEFECTS.defects[index].attack_class !== "broken-access-control");
    const parsed = parseCoverageSeeds(withoutAuthz);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    const covered = new Set(parsed.value.map((unit) => unit.attack_class));
    const authz = DEFECTS.defects.find((defect) => defect.attack_class === "broken-access-control");
    expect(authz).toBeDefined();
    expect(covered.has(authz?.attack_class ?? "")).toBe(false);
  });

  it("does not report a defect the run never settled", () => {
    const { findings } = recordedRun();
    const metadata: SecurityRunMetadata = { ...METADATA, selectedCompanions: ["ATTACK-CLASSES.md"] };
    const ledger = ledgerOf().map((unit) => ({ ...unit, status: "covered" as const, agent_id: "security-hunter-agent", reviewed_paths: unit.starting_paths }));
    const sqli = findings.filter((finding) => finding.fingerprint === "calibration/cal-sqli-01");
    expect(sqli).toHaveLength(1);
    const report = renderRunDocuments({ metadata, ledger, findings: sqli })["REPORT.md"] ?? "";
    expect(report).toContain("calibration/cal-sqli-01");
    for (const defect of DEFECTS.defects.slice(1)) {
      expect(report).not.toContain(`calibration/${defect.id.toLowerCase()}`);
    }
  });
});
