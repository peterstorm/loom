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
import { derivePublication } from "../../src/core/security-reports";
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
    const disposition = ok(securityDisposition({ metadata: METADATA, locator: "/out", findings: findings() }));
    expect(disposition.entries).toHaveLength(3);
    expect(disposition.entries.map((entry) => entry.fingerprint)).toEqual([
      "api/export:sqli-filter",
      "api/login:sqli-email",
      "api/search:sqli-terms",
    ]);
    expect(disposition.entries.map((entry) => entry.decision)).toEqual(["deferred", "accepted", "dismissed"]);
    expect(disposition.provenance).toBe("DECLARED");
    expect(disposition.source.runId).toBe("audit-1");
    expect(disposition.source.locator).toBe("/out");
  });

  it("is byte-identical across two derivations of the same records", () => {
    const once = ok(securityDisposition({ metadata: METADATA, locator: "/out", findings: findings() }));
    const twice = ok(securityDisposition({ metadata: METADATA, locator: "/out", findings: findings() }));
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });

  it("mints a different origin when the record changes", () => {
    const before = parse([aConfirmedFinding()])[0];
    const after = parse([aConfirmedFinding({ description: "The handler interpolates an unvalidated `email`." })])[0];
    expect(securityFindingOrigin("audit-1", before)).not.toBe(securityFindingOrigin("audit-1", after));
    // …and a different origin when the same record belongs to another run.
    expect(securityFindingOrigin("audit-1", before)).not.toBe(securityFindingOrigin("audit-2", before));
  });

  it("digests the decision set: exactly the four fields of each entry, in fingerprint order", () => {
    const disposition = ok(securityDisposition({ metadata: METADATA, locator: "/out", findings: findings() }));
    // The digest is over the entries as published — the same bytes a field-by-
    // field projection of them gives, so a re-derivation by a consumer agrees.
    expect(disposition.source.resultDigest).toBe(canonicalDigest(disposition.entries.map((entry) => ({
      origin: entry.origin,
      fingerprint: entry.fingerprint,
      decision: entry.decision,
      reason: entry.reason,
    }))));
  });

  it("changes the result digest when a decision changes", () => {
    const accepted = ok(securityDisposition({ metadata: METADATA, locator: "/out", findings: parse([aConfirmedFinding()]) }));
    const dismissed = ok(securityDisposition({ metadata: METADATA, locator: "/out", findings: parse([aRejectedFinding()]) }));
    expect(accepted.source.resultDigest).not.toBe(dismissed.source.resultDigest);
  });

  it("binds the published records through their origins: an edited record moves the digest, its decision unchanged", () => {
    const before = ok(securityDisposition({ metadata: METADATA, locator: "/out", findings: parse([aConfirmedFinding()]) }));
    const edited = parse([aConfirmedFinding({ description: "The handler interpolates an unvalidated `email`." })]);
    const after = ok(securityDisposition({ metadata: METADATA, locator: "/out", findings: edited }));
    expect(after.entries.map((entry) => entry.decision)).toEqual(before.entries.map((entry) => entry.decision));
    expect(after.source.resultDigest).not.toBe(before.source.resultDigest);
  });

  it("keeps the digest when only run metadata that decides nothing changes (it digests the decision set)", () => {
    const standard = ok(securityDisposition({ metadata: METADATA, locator: "/out", findings: findings() }));
    const deep = ok(securityDisposition({ metadata: { ...METADATA, profile: "deep" }, locator: "/out", findings: findings() }));
    expect(deep.profile).toBe("deep");
    expect(deep.source.resultDigest).toBe(standard.source.resultDigest);
  });

  it("emits a zero-entry decision set for a clean run instead of refusing", () => {
    const empty = ok(securityDisposition({ metadata: METADATA, locator: "/out", findings: [] }));
    expect(empty.entries).toEqual([]);
    expect(renderDispositionHandoff(empty)).toContain("nothing to remediate");
  });

  it("names the handoff command in prose", () => {
    const disposition = ok(securityDisposition({ metadata: METADATA, locator: "/out/audit-1", findings: findings() }));
    const paths = dispositionHandoffPaths("/out/audit-1", METADATA.runId);
    // The run name is carried, not re-derived by slicing the run directory apart.
    expect(paths.runName).toBe(`run.disposition-${METADATA.runId}`);
    expect(paths.runDir).toBe(`${paths.runsRoot}/${paths.runName}`);
    // The paths are the disposition's own: derived from its source, never passed beside it.
    const text = renderDispositionHandoff(disposition);
    expect(text).toContain("1 accepted, 1 deferred, 1 dismissed");
    // The command carries every flag the program requires and names the exact
    // file the handler writes.
    expect(text).toContain(`--runs-root '${paths.runsRoot}'`);
    expect(text).toContain(`--run 'run.disposition-${METADATA.runId}' < '${paths.inputFile}'`);
    expect(text).toContain(disposition.source.resultDigest);
  });

  it("quotes every path of the handoff command as one shell word, whatever it holds", () => {
    const locator = "/out/it's my audit dir";
    const disposition = ok(securityDisposition({ metadata: METADATA, locator, findings: findings() }));
    const paths = dispositionHandoffPaths(locator, METADATA.runId);
    const command = renderDispositionHandoff(disposition).split("\n")
      .filter((line) => line.startsWith("    ")).map((line) => line.trim().replace(/ \\$/, "")).join(" ");
    // A real shell splits it back into exactly the intended words.
    const echoed = spawnSync("bash", ["-c", `printf '%s\\n' ${command.replace(/ < /, " ")}`], { encoding: "utf8" });
    expect(echoed.stdout.split("\n")).toEqual(["helper", "orchestration", "start", "standalone-disposition",
      "--runs-root", paths.runsRoot, "--run", `run.disposition-${METADATA.runId}`, paths.inputFile, ""]);
  });

  it("derives a start input the standalone-disposition loader parses", () => {
    const disposition = ok(securityDisposition({ metadata: METADATA, locator: "/out/audit-1", findings: findings() }));
    const start = ok(standaloneDispositionStart(disposition));
    // The loader's OWN parser, not a re-implementation of its grammar.
    const parsed = ok(parseStandaloneDispositionStartInput(start));
    expect(parsed.source.locator).toBe("/out/audit-1");
    expect(parsed.record.entries).toHaveLength(3);
    expect(parsed.record.revision).toEqual({ kind: "initial" });
    expect(parsed.previous).toBeNull();
  });
});

describe("the report's handoff section", () => {
  it("derives the same decision set the loader will receive", () => {
    const ledger = ok(parseCoverageSeeds([aSeed()]));
    const published = findings();
    const disposition = ok(securityDisposition({ metadata: METADATA, locator: "/out", findings: published }));
    const report = ok(derivePublication({ metadata: METADATA, ledger, findings: published, locator: "/out" })).documents["REPORT.md"];
    expect(report).toContain("## Disposition handoff");
    const paths = dispositionHandoffPaths("/out", METADATA.runId);
    expect(report).toContain(`--runs-root '${paths.runsRoot}'`);
    expect(report).toContain(paths.inputFile);
    // The digest in the prose is the digest of the decision set, not a second
    // rendering of the same idea.
    expect(report).toContain(disposition.source.resultDigest);
  });

  it("names no command for a clean run, because there is nothing to load", () => {
    const ledger = ok(parseCoverageSeeds([aSeed()]));
    const report = ok(derivePublication({ metadata: METADATA, ledger, findings: [], locator: "/out" })).documents["REPORT.md"];
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
