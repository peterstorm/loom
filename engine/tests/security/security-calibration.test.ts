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
 *   2. the ENUMERATION reaches every defect, in the two senses this suite can
 *      prove: lens selection over the fixture's recorded signals includes the
 *      lens each defect names (at the `deep` cap), and the seeded ledger holds a
 *      unit whose attack class and starting paths cover each planted file. The
 *      signals themselves are operator input recorded in `DEFECTS.json` — there
 *      is no production signal detector, so this does NOT prove a repository
 *      scan would have produced them;
 *   3. the REPORT reaches every defect — one recorded run through the helper
 *      publishes each planted defect exactly once, with complete coverage.
 *
 * Claim 3 is a golden run over recorded records, not a live hunt: it proves the
 * program's own path (seed → settle → adjudicate → publish → disposition) is
 * total, while claim 2 is what proves a hunter would be pointed at the defect.
 * Either alone is a weaker statement than the audit makes.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SECURITY_PROFILE_LENSES,
  canonicalCoverageId,
  isSafeSourcePath,
  isVisibleText,
  isWireRecord,
  parseSecurityRunMetadata,
  type CoverageRefs,
} from "../../src/core/security-audit-contract";
import {
  assignUnits,
  parseCoverageSeeds,
  recordUnitResult,
  validateLedger,
  type CoverageLedger,
  type CoverageSeed,
  type TerminalDisposition,
} from "../../src/core/security-coverage";
import { SEVERITY_SCORES, parseSecurityFindings, type SecurityFinding, type SeverityScore } from "../../src/core/security-findings";
import { parseVerificationVerdicts } from "../../src/core/security-adjudication";
import { SECURITY_LENSES, selectSecurityLenses, type SecurityLens, type StackSignals } from "../../src/core/security-lens-select";
import { securityDisposition } from "../../src/core/security-disposition";
import { renderRunDocuments } from "../../src/core/security-reports";
import { HUNTER_AGENT, aConfirmedFinding, aRunMetadata, aSeed, aSignals, aUnitResult, aVerdict, ok } from "./fixtures";
import { createSecurityAuditHandler } from "../../src/handlers/helpers/security-audit";

const CALIBRATION_ROOT = resolve(__dirname, "../fixtures/security/calibration");

type PlantedDefect = Readonly<{
  id: string;
  file: string;
  line: number;
  attack_class: string;
  surface: string;
  boundary: string;
  subsystem: string;
  lens: SecurityLens;
  impact: SeverityScore;
  claim: string;
}>;

type DefectSet = Readonly<{ schemaVersion: 1; kind: string; signals: StackSignals; defects: readonly PlantedDefect[] }>;

// --- Load boundary ---

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

const SIGNAL_FLAGS = [
  "servesHttp", "rendersClientSide", "drivesModelsOrTools", "usesQueuesOrRpc", "isolatesTenants",
  "deploysInfrastructure", "hasNativeMemory", "hasAppOrLocalIpc", "hasReleasePipelines", "hasSharedResourcePressure",
] as const;

const stringList = (value: unknown, path: string): readonly string[] => {
  if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === "string")) {
    throw new Error(`DEFECTS.json ${path}: expected an array of strings`);
  }
  return value;
};

const parseSignals = (raw: unknown): StackSignals => {
  if (!isWireRecord(raw)) throw new Error("DEFECTS.json signals: expected an object");
  const flags = Object.fromEntries(SIGNAL_FLAGS.map((flag) => {
    const value = raw[flag];
    if (typeof value !== "boolean") throw new Error(`DEFECTS.json signals.${flag}: expected a boolean`);
    return [flag, value];
  }));
  return aSignals({ ...flags, languages: stringList(raw.languages, "signals.languages"), manifests: stringList(raw.manifests, "signals.manifests") });
};

const parseDefect = (raw: unknown, index: number): PlantedDefect => {
  const path = `defects[${index}]`;
  if (!isWireRecord(raw)) throw new Error(`DEFECTS.json ${path}: expected an object`);
  const text = (key: string): string => {
    const value = raw[key];
    if (!isVisibleText(value)) throw new Error(`DEFECTS.json ${path}.${key}: expected visible text`);
    return value;
  };
  const { file, line, lens, impact } = raw;
  if (!isSafeSourcePath(file)) throw new Error(`DEFECTS.json ${path}.file: expected a repository-relative path`);
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) throw new Error(`DEFECTS.json ${path}.line: expected a positive integer`);
  if (!isOneOf(SECURITY_LENSES, lens)) throw new Error(`DEFECTS.json ${path}.lens: expected a vendored lens`);
  if (!isOneOf(SEVERITY_SCORES, impact)) throw new Error(`DEFECTS.json ${path}.impact: expected a severity score`);
  return {
    id: text("id"),
    file,
    line,
    attack_class: text("attack_class"),
    surface: text("surface"),
    boundary: text("boundary"),
    subsystem: text("subsystem"),
    lens,
    impact,
    claim: text("claim"),
  };
};

/** The fixture is parsed where it is loaded: a malformed `DEFECTS.json` fails
 *  here with the field it got wrong, rather than as an `undefined` deep inside
 *  whichever assertion first reads it. */
const parseDefectSet = (raw: unknown): DefectSet => {
  if (!isWireRecord(raw)) throw new Error("DEFECTS.json: expected an object");
  if (raw.schemaVersion !== 1) throw new Error("DEFECTS.json schemaVersion: expected 1");
  if (typeof raw.kind !== "string") throw new Error("DEFECTS.json kind: expected a string");
  if (!Array.isArray(raw.defects)) throw new Error("DEFECTS.json defects: expected an array");
  return {
    schemaVersion: 1,
    kind: raw.kind,
    signals: parseSignals(raw.signals),
    defects: raw.defects.map(parseDefect),
  };
};

const DEFECTS = parseDefectSet(JSON.parse(readFileSync(join(CALIBRATION_ROOT, "DEFECTS.json"), "utf-8")));

// --- Run builders ---

const fingerprintOf = (defect: PlantedDefect): string => `calibration/${defect.id.toLowerCase()}`;

const METADATA = aRunMetadata({
  runId: "calibration-run",
  repo: CALIBRATION_ROOT,
  target: CALIBRATION_ROOT,
  scope: { paths: DEFECTS.defects.map((defect) => defect.file).sort(), kind: "tree", baseRef: null, headRef: null },
  scopePaths: [...new Set(DEFECTS.defects.map((defect) => defect.file))].sort(),
  budget: 24,
});

const refsFor = (defect: PlantedDefect): CoverageRefs => ({
  surface: defect.surface,
  boundary: defect.boundary,
  subsystem: defect.subsystem,
  attack_class: defect.attack_class,
});

const seedFor = (defect: PlantedDefect): CoverageSeed => aSeed({
  refs: refsFor(defect),
  starting_paths: [defect.file],
  ordinary_attack_class_block: `Ordinary ${defect.attack_class} block for ${defect.subsystem}.`,
  selected_companion_blocks: [`${defect.lens}#${defect.attack_class}`],
});

const seeds = (): readonly CoverageSeed[] => DEFECTS.defects.map(seedFor);

const ledgerOf = (): CoverageLedger => ok(parseCoverageSeeds(seeds()));

/** The planted defects no ledger unit would point a hunter at: no unit hunts the
 *  defect's attack class from a starting path that includes its file. Computed
 *  from the LEDGER the program built, not from the seeds handed to it. */
const unreachedDefects = (ledger: CoverageLedger): readonly string[] =>
  DEFECTS.defects
    .filter((defect) => !ledger.some((unit) => unit.attack_class === defect.attack_class && unit.starting_paths.includes(defect.file)))
    .map((defect) => defect.id);

/** Drive every seeded unit through the ledger's own transitions — assigned to
 *  the catalog hunter, then settled with one source check over the defect's
 *  file — so the settled ledger is one `validateLedger` accepts, not a forged
 *  spread of planned units. `candidate` files the defect's fingerprint. */
const settledLedger = (status: Extract<TerminalDisposition, "covered" | "candidate">): CoverageLedger => {
  const planned = ledgerOf();
  let ledger = ok(assignUnits(planned, planned.map((unit) => ({ coverageId: unit.coverage_id, agentId: HUNTER_AGENT, wave: 1 })))).ledger;
  for (const defect of DEFECTS.defects) {
    ledger = ok(recordUnitResult(ledger, {
      coverageId: canonicalCoverageId(refsFor(defect)),
      agentId: HUNTER_AGENT,
      wave: 1,
      status,
      reviewedPaths: [defect.file],
      checks: [{
        agent_id: HUNTER_AGENT,
        reviewed_paths: [defect.file],
        invariant: `No untrusted input reaches the sink in ${defect.subsystem}.`,
        method: "source",
        result: defect.claim,
        artifact: null,
      }],
      fingerprints: status === "candidate" ? [fingerprintOf(defect)] : [],
    }));
  }
  return ledger;
};

const findingFor = (defect: PlantedDefect): Record<string, unknown> => aConfirmedFinding({
  fingerprint: fingerprintOf(defect),
  title: `${defect.id}: ${defect.claim}`,
  description: defect.claim,
  trace: [
    { kind: "entrypoint", file: defect.file, line: defect.line, scope: defect.subsystem, description: defect.claim },
    { kind: "sink", file: defect.file, line: defect.line, scope: defect.boundary, description: defect.claim },
  ],
  evidence: [{ file: defect.file, line: defect.line, description: defect.claim }],
  root_cause: `${defect.id}: ${defect.claim}`,
  severity: {
    likelihood: { score: "high", reason: "The entry point is unauthenticated in the fixture." },
    impact: { score: defect.impact, reason: `${defect.impact} impact is recorded on the planted defect.` },
    overall_severity: defect.impact,
  },
});

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

  it("refuses a malformed fixture at the load boundary", () => {
    const raw: unknown = JSON.parse(readFileSync(join(CALIBRATION_ROOT, "DEFECTS.json"), "utf-8"));
    if (!isWireRecord(raw)) throw new Error("DEFECTS.json is not an object");
    const [first] = DEFECTS.defects;
    expect(() => parseDefectSet({ ...raw, defects: [{ ...first, lens: "NOT-A-LENS.md" }] })).toThrow(/defects\[0\]\.lens/);
    expect(() => parseDefectSet({ ...raw, defects: [{ ...first, line: 0 }] })).toThrow(/defects\[0\]\.line/);
    expect(() => parseDefectSet({ ...raw, signals: { ...DEFECTS.signals, servesHttp: "yes" } })).toThrow(/signals\.servesHttp/);
    expect(() => parseDefectSet({ ...raw, schemaVersion: 2 })).toThrow(/schemaVersion/);
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
    expect(included.length).toBeLessThanOrEqual(SECURITY_PROFILE_LENSES.standard);
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

  it("trims exactly the client-side defect at the standard profile", () => {
    // A deliberate TRIPWIRE, not a derived fact: the calibration's reach is
    // profile-scoped, and at `standard` exactly one class is trimmed. A change to
    // the ranking rules or the fixture's signals that moves this set must be
    // looked at by a person, so the expected set is written out by hand.
    const standard = selectSecurityLenses(DEFECTS.signals, { maxLenses: SECURITY_PROFILE_LENSES.standard });
    const standardIncluded: readonly string[] = standard.included.map((entry) => entry.lens);
    const unreachable = DEFECTS.defects.filter((defect) => !standardIncluded.includes(defect.lens));
    expect(unreachable.map((defect) => defect.id)).toEqual(["CAL-XSS-01"]);
  });

  it("names every lens a capped profile trims from a defect, with its reason", () => {
    // Independent of the tripwire above: whatever set a profile trims, each
    // trimmed defect's lens is accounted for in `excluded`, never dropped.
    for (const profile of ["quick", "standard"] as const) {
      const selection = selectSecurityLenses(DEFECTS.signals, { maxLenses: SECURITY_PROFILE_LENSES[profile] });
      const included: readonly string[] = selection.included.map((entry) => entry.lens);
      for (const defect of DEFECTS.defects.filter((candidate) => !included.includes(candidate.lens))) {
        const entry = selection.excluded.find((candidate) => candidate.lens === defect.lens);
        expect(entry, `${profile}: ${defect.id} needs ${defect.lens}`).toBeDefined();
        expect(entry?.reason).toMatch(/beyond the \d+-lens cap|no matching signal/);
      }
    }
  });

  it("seeds a unit whose attack class and starting paths cover each defect's file", () => {
    const ledger = ledgerOf();
    expect(ledger).toHaveLength(DEFECTS.defects.length);
    expect(unreachedDefects(ledger)).toEqual([]);
    for (const defect of DEFECTS.defects) {
      const unit = ledger.find((candidate) => candidate.coverage_id === canonicalCoverageId(refsFor(defect)));
      expect(unit?.status, defect.id).toBe("planned");
    }
  });

  it("keeps ATTACK-CLASSES in a quick run, whatever else the cap trims", () => {
    const selection = selectSecurityLenses(DEFECTS.signals, { maxLenses: SECURITY_PROFILE_LENSES.quick });
    expect(selection.included.map((entry) => entry.lens)).toContain("ATTACK-CLASSES.md");
    expect(selection.included.length).toBeLessThanOrEqual(SECURITY_PROFILE_LENSES.quick);
  });

  it("gives every unit a distinct canonical id", () => {
    const ledger = ledgerOf();
    expect(new Set(ledger.map((unit) => unit.coverage_id)).size).toBe(ledger.length);
  });
});

/** The golden run, built from the same seeds the enumeration produced: each
 *  unit is assigned, settled with the defect's fingerprint, and verified by a
 *  ballot from ANOTHER profile — the shape a real run has, and the only shape
 *  that confirms (INV-S3): the hunters sit on `focused-review`, so the ballots
 *  come from `refutation`. The run's BUDGET profile (`deep`) is not a ballot
 *  profile at all — conflating the two is what made INV-S3 vacuous. */
const recordedRun = () => {
  // A findings document is sorted by fingerprint, so build it that way rather
  // than relying on the fixture's declaration order.
  const findings: readonly SecurityFinding[] = ok(parseSecurityFindings([...DEFECTS.defects]
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    .map(findingFor)));
  const verdicts = ok(parseVerificationVerdicts(DEFECTS.defects.map((defect) => aVerdict({ fingerprint: fingerprintOf(defect) }))));
  return { ledger: settledLedger("candidate"), findings, verdicts };
};

describe("a recorded run reaches every planted defect", () => {
  it("settles a ledger the state machine itself accepts", () => {
    const { ledger } = recordedRun();
    expect(validateLedger(ledger)).toEqual([]);
    expect(ledger.every((unit) => unit.status === "candidate")).toBe(true);
  });

  it("publishes each planted defect exactly once", () => {
    const { ledger, findings } = recordedRun();
    const metadata = ok(parseSecurityRunMetadata({
      ...METADATA,
      selectedCompanions: selectSecurityLenses(DEFECTS.signals, { maxLenses: SECURITY_PROFILE_LENSES.deep }).included.map((entry) => entry.lens),
    }));
    const documents = renderRunDocuments({ metadata, ledger, findings, locator: "/calibration" });
    const report = documents["REPORT.md"] ?? "";

    for (const defect of DEFECTS.defects) {
      expect(report.split(fingerprintOf(defect))).toHaveLength(2);
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
        fingerprints: [fingerprintOf(defect)],
        checks: [{
          agent_id: HUNTER_AGENT,
          reviewed_paths: [defect.file],
          invariant: `No untrusted input reaches the sink in ${defect.subsystem}.`,
          method: "source",
          result: defect.claim,
          artifact: null,
        }],
      }));

      for (const defect of DEFECTS.defects) {
        const assigned = await invoke(["assign", "--unit", canonicalCoverageId(refsFor(defect)), "--agent", HUNTER_AGENT, "--wave", "1"]);
        expectOk(assigned, `assign ${defect.id}`);
      }

      const submitted = await invoke(["submit"], JSON.stringify({ units: results, findings: DEFECTS.defects.map(findingFor) }));
      expectOk(submitted, "submit");

      const verified = await invoke(["verify"], JSON.stringify({
        verdicts: DEFECTS.defects.map((defect) => aVerdict({ fingerprint: fingerprintOf(defect) })),
      }));
      expectOk(verified, "verify");

      const published = await invoke(["publish"]);
      expectOk(published, "publish");
      const publishedFindings = JSON.parse(readFileSync(join(out, "security-findings.json"), "utf-8")) as readonly { fingerprint: string }[];
      expect(publishedFindings.map((finding) => finding.fingerprint).sort()).toEqual(
        DEFECTS.defects.map(fingerprintOf).sort(),
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
  it("reports exactly the defect whose cell the seeds dropped as unreached", () => {
    // Drop the access-control cell, then ask the LEDGER the program built — not
    // the reduced seed list — which planted defects no unit would hunt. The
    // answer must be the dropped one and only it: the gap the enumeration exists
    // to make visible.
    const authz = DEFECTS.defects.find((defect) => defect.attack_class === "broken-access-control");
    if (authz === undefined) throw new Error("the fixture plants no broken-access-control defect");
    const reduced = ok(parseCoverageSeeds(DEFECTS.defects.filter((defect) => defect !== authz).map(seedFor)));
    expect(unreachedDefects(reduced)).toEqual([authz.id]);
  });

  it("does not report a defect the run never settled", () => {
    const { findings } = recordedRun();
    const metadata = aRunMetadata({ ...METADATA, selectedCompanions: ["ATTACK-CLASSES.md"] });
    const ledger = settledLedger("covered");
    expect(validateLedger(ledger)).toEqual([]);
    const sqli = findings.filter((finding) => finding.fingerprint === "calibration/cal-sqli-01");
    expect(sqli).toHaveLength(1);
    const report = renderRunDocuments({ metadata, ledger, findings: sqli, locator: "/calibration" })["REPORT.md"] ?? "";
    expect(report).toContain("calibration/cal-sqli-01");
    for (const defect of DEFECTS.defects.slice(1)) {
      expect(report).not.toContain(fingerprintOf(defect));
    }
  });
});
