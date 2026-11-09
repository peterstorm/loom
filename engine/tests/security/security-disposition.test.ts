/**
 * The disposition handoff (P6).
 *
 * The trichotomy decides every entry: confirmed is accepted, a lead is
 * deferred, a rejection is dismissed. There is no policy to get wrong here,
 * which is why the tests are mostly about the two things that CAN go wrong —
 * an origin that survives an edit, and a decision set that disagrees with the
 * records it claims to dispose.
 */

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../src/core/digest";
import {
  decisionForFinding,
  dispositionHandoffPaths,
  reasonForFinding,
  renderDispositionHandoff,
  securityDisposition,
  securityFindingOrigin,
  standaloneDispositionStart,
} from "../../src/core/security-disposition";
import { parseStandaloneDispositionStartInput } from "../../src/core/standalone-disposition-machine";
import { parseSecurityFindings, type SecurityFinding } from "../../src/core/security-findings";
import { renderReport } from "../../src/core/security-reports";
import { parseCoverageSeeds } from "../../src/core/security-coverage";
import { aConfirmedFinding, aNeedsValidationFinding, aRejectedFinding, aRunMetadata, aSeed, ok } from "./fixtures";

const METADATA = aRunMetadata({ budget: 12, selectedCompanions: ["WEB-PROTOCOL-AND-AUTH.md"] });

const parse = (raw: readonly unknown[]): readonly SecurityFinding[] => ok(parseSecurityFindings(raw));

const findings = (): readonly SecurityFinding[] =>
  // The document contract requires fingerprints in sorted order: parse one
  // record at a time and hand the sorted list to the derivation.
  [
    ...parse([aNeedsValidationFinding()]),
    ...parse([aConfirmedFinding()]),
    ...parse([aRejectedFinding()]),
  ];

describe("the decision the trichotomy forces", () => {
  it("accepts a confirmed claim, defers a lead, dismisses a rejection", () => {
    expect(decisionForFinding(parse([aConfirmedFinding()])[0])).toBe("accepted");
    expect(decisionForFinding(parse([aNeedsValidationFinding()])[0])).toBe("deferred");
    expect(decisionForFinding(parse([aRejectedFinding()])[0])).toBe("dismissed");
  });

  it("cites the record's own evidence as the reason", () => {
    const confirmed = parse([aConfirmedFinding()])[0];
    expect(reasonForFinding(confirmed)).toContain("high impact");
    const lead = parse([aNeedsValidationFinding()])[0];
    expect(reasonForFinding(lead)).toContain("deployment behind the proxy");
    const rejected = parse([aRejectedFinding()])[0];
    expect(reasonForFinding(rejected)).toContain("Double escaping");
  });
});

describe("the decision set", () => {
  it("carries one entry per published record, sorted by fingerprint", () => {
    const disposition = securityDisposition({ metadata: METADATA, locator: "/out", findings: findings() });
    if (!disposition.ok) throw new Error("expected a disposition set");
    expect(disposition.value.entries).toHaveLength(3);
    expect(disposition.value.entries.map((entry) => entry.fingerprint)).toEqual([
      "api/export:sqli-filter",
      "api/login:sqli-email",
      "api/search:sqli-terms",
    ]);
    expect(disposition.value.entries.map((entry) => entry.decision)).toEqual(["deferred", "accepted", "dismissed"]);
    expect(disposition.value.provenance).toBe("DECLARED");
    expect(disposition.value.source.runId).toBe("audit-1");
    expect(disposition.value.source.locator).toBe("/out");
  });

  it("is byte-identical across two derivations of the same records", () => {
    const once = securityDisposition({ metadata: METADATA, locator: "/out", findings: findings() });
    const twice = securityDisposition({ metadata: METADATA, locator: "/out", findings: findings() });
    if (!once.ok || !twice.ok) throw new Error("expected disposition sets");
    expect(JSON.stringify(once.value)).toBe(JSON.stringify(twice.value));
  });

  it("mints a different origin when the record changes", () => {
    const before = parse([aConfirmedFinding()])[0];
    const after = parse([aConfirmedFinding({ description: "The handler interpolates an unvalidated `email`." })])[0];
    expect(securityFindingOrigin("audit-1", before)).not.toBe(securityFindingOrigin("audit-1", after));
    // …and a different origin when the same record belongs to another run.
    expect(securityFindingOrigin("audit-1", before)).not.toBe(securityFindingOrigin("audit-2", before));
  });

  it("digests exactly the four fields of each entry, in fingerprint order", () => {
    const disposition = securityDisposition({ metadata: METADATA, locator: "/out", findings: findings() });
    if (!disposition.ok) throw new Error("expected a disposition set");
    // The digest is over the entries as published — the same bytes a field-by-
    // field projection of them gives, so a re-derivation by a consumer agrees.
    expect(disposition.value.source.resultDigest).toBe(canonicalDigest(disposition.value.entries.map((entry) => ({
      origin: entry.origin,
      fingerprint: entry.fingerprint,
      decision: entry.decision,
      reason: entry.reason,
    }))));
  });

  it("changes the result digest when a decision changes", () => {
    const accepted = securityDisposition({ metadata: METADATA, locator: "/out", findings: parse([aConfirmedFinding()]) });
    const dismissed = securityDisposition({ metadata: METADATA, locator: "/out", findings: parse([aRejectedFinding()]) });
    if (!accepted.ok || !dismissed.ok) throw new Error("expected disposition sets");
    expect(accepted.value.source.resultDigest).not.toBe(dismissed.value.source.resultDigest);
  });

  it("emits a zero-entry decision set for a clean run instead of refusing", () => {
    const empty = securityDisposition({ metadata: METADATA, locator: "/out", findings: [] });
    expect(empty.ok).toBe(true);
    expect(empty.ok ? empty.value.entries : ["unexpected"]).toEqual([]);
    expect(empty.ok ? renderDispositionHandoff(empty.value) : "").toContain("nothing to remediate");
  });

  it("names the handoff command in prose", () => {
    const disposition = securityDisposition({ metadata: METADATA, locator: "/out/audit-1", findings: findings() });
    if (!disposition.ok) throw new Error("expected a disposition set");
    const paths = dispositionHandoffPaths("/out/audit-1", METADATA.runId);
    // The run name is carried, not re-derived by slicing the run directory apart.
    expect(paths.runName).toBe(`run.disposition-${METADATA.runId}`);
    expect(paths.runDir).toBe(`${paths.runsRoot}/${paths.runName}`);
    const text = renderDispositionHandoff(disposition.value, paths);
    expect(text).toContain("1 accepted, 1 deferred, 1 dismissed");
    // The command carries every flag the program requires and names the exact
    // file the handler writes. The old spelling (`--run <locator>`, no stdin)
    // named neither, so no reader could execute it.
    expect(text).toContain(`--runs-root '${paths.runsRoot}'`);
    expect(text).toContain(`--run 'run.disposition-${METADATA.runId}' < '${paths.inputFile}'`);
    expect(text).toContain(disposition.value.source.resultDigest);
  });

  it("quotes every path of the handoff command as one shell word, whatever it holds (H)", () => {
    const locator = "/out/it's my audit dir";
    const disposition = securityDisposition({ metadata: METADATA, locator, findings: findings() });
    if (!disposition.ok) throw new Error("expected a disposition set");
    const paths = dispositionHandoffPaths(locator, METADATA.runId);
    const command = renderDispositionHandoff(disposition.value, paths).split("\n")
      .filter((line) => line.startsWith("    ")).map((line) => line.trim().replace(/ \\$/, "")).join(" ");
    // A real shell splits it back into exactly the intended words.
    const echoed = spawnSync("bash", ["-c", `printf '%s\\n' ${command.replace(/ < /, " ")}`], { encoding: "utf8" });
    expect(echoed.stdout.split("\n")).toEqual(["helper", "orchestration", "start", "standalone-disposition",
      "--runs-root", paths.runsRoot, "--run", `run.disposition-${METADATA.runId}`, paths.inputFile, ""]);
  });

  it("derives a start input the standalone-disposition loader parses", () => {
    const disposition = securityDisposition({ metadata: METADATA, locator: "/out/audit-1", findings: findings() });
    if (!disposition.ok) throw new Error("expected a disposition set");
    const start = standaloneDispositionStart(disposition.value);
    if (!start.ok) throw new Error(start.error.message);
    // The loader's OWN parser, not a re-implementation of its grammar.
    const parsed = parseStandaloneDispositionStartInput(start.value);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.source.locator).toBe("/out/audit-1");
    expect(parsed.value.record.entries).toHaveLength(3);
    expect(parsed.value.record.revision).toEqual({ kind: "initial" });
    expect(parsed.value.previous).toBeNull();
  });
});

describe("the report's handoff section", () => {
  it("derives the same decision set the loader will receive", () => {
    const ledger = parseCoverageSeeds([aSeed()]);
    if (!ledger.ok) throw new Error("expected a ledger");
    const published = findings();
    const disposition = securityDisposition({ metadata: METADATA, locator: "/out", findings: published });
    if (!disposition.ok) throw new Error("expected a disposition set");
    const report = renderReport({ metadata: METADATA, ledger: ledger.value, findings: published, locator: "/out" });
    expect(report).toContain("## Disposition handoff");
    const paths = dispositionHandoffPaths("/out", METADATA.runId);
    expect(report).toContain(`--runs-root '${paths.runsRoot}'`);
    expect(report).toContain(paths.inputFile);
    // The digest in the prose is the digest of the decision set, not a second
    // rendering of the same idea.
    expect(report).toContain(disposition.value.source.resultDigest);
  });

  it("names no command for a clean run, because there is nothing to load", () => {
    const ledger = parseCoverageSeeds([aSeed()]);
    if (!ledger.ok) throw new Error("expected a ledger");
    const report = renderReport({ metadata: METADATA, ledger: ledger.value, findings: [], locator: "/out" });
    expect(report).toContain("## Disposition handoff");
    expect(report).toContain("nothing to remediate");
    expect(report).not.toContain("standalone-disposition --runs-root");
  });
});

describe("origins", () => {
  it("are the digest of the record, not an index into the list", () => {
    const [first] = parse([aConfirmedFinding()]);
    expect(securityFindingOrigin("audit-1", first)).toBe(
      canonicalDigest({ kind: "security-audit-finding", runId: "audit-1", fingerprint: first.fingerprint, record: first }),
    );
  });
});
