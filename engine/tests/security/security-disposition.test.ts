/**
 * The disposition handoff (P6).
 *
 * The trichotomy decides every entry: confirmed is accepted, a lead is
 * deferred, a rejection is dismissed. There is no policy to get wrong here,
 * which is why the tests are mostly about the two things that CAN go wrong —
 * an origin that survives an edit, and a decision set that disagrees with the
 * records it claims to dispose.
 */

import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../../src/core/digest";
import {
  decisionForFinding,
  reasonForFinding,
  renderDispositionHandoff,
  securityDisposition,
  securityFindingOrigin,
} from "../../src/core/security-disposition";
import type { SecurityRunMetadata } from "../../src/core/security-audit-contract";
import { parseSecurityFindings, type SecurityFinding } from "../../src/core/security-findings";
import { renderReport } from "../../src/core/security-reports";
import { parseCoverageSeeds } from "../../src/core/security-coverage";
import { aConfirmedFinding, aNeedsValidationFinding, aRejectedFinding, aSeed } from "../security/fixtures";

const METADATA: SecurityRunMetadata = {
  schemaVersion: 1,
  runId: "audit-1",
  repo: "/repo",
  target: "/repo",
  profile: "standard",
  scope: { paths: ["src/api/login.ts"], kind: "tree", baseRef: null, headRef: null },
  scopePaths: ["src/api/login.ts"],
  sourceRef: { commit: "0".repeat(40), worktreeDirty: false },
  budget: 12,
  executionPolicy: "sandboxed-source-and-local-only",
  selectedCompanions: ["WEB-PROTOCOL-AND-AUTH.md"],
  priorRuns: [],
  runStatus: "complete",
  incompleteReason: null,
};

const parse = (raw: readonly unknown[]): readonly SecurityFinding[] => {
  const parsed = parseSecurityFindings(raw);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
};

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

  it("changes the result digest when a decision changes", () => {
    const accepted = securityDisposition({ metadata: METADATA, locator: "/out", findings: parse([aConfirmedFinding()]) });
    const dismissed = securityDisposition({ metadata: METADATA, locator: "/out", findings: parse([aRejectedFinding()]) });
    if (!accepted.ok || !dismissed.ok) throw new Error("expected disposition sets");
    expect(accepted.value.source.resultDigest).not.toBe(dismissed.value.source.resultDigest);
  });

  it("refuses an empty publication rather than emitting an empty decision set", () => {
    const empty = securityDisposition({ metadata: METADATA, locator: "/out", findings: [] });
    expect(empty.ok).toBe(false);
    expect(empty.ok ? "" : empty.error.message).toContain("nothing to disposition");
  });

  it("names the handoff command in prose", () => {
    const disposition = securityDisposition({ metadata: METADATA, locator: "/out/audit-1", findings: findings() });
    if (!disposition.ok) throw new Error("expected a disposition set");
    const text = renderDispositionHandoff(disposition.value);
    expect(text).toContain("1 accepted, 1 deferred, 1 dismissed");
    expect(text).toContain("standalone-disposition --run /out/audit-1");
    expect(text).toContain(disposition.value.source.resultDigest);
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
    expect(report).toContain("standalone-disposition --run /out");
    // The digest in the prose is the digest of the decision set, not a second
    // rendering of the same idea.
    expect(report).toContain(disposition.value.source.resultDigest);
  });

  it("states the handoff without a path when no locator is given", () => {
    const ledger = parseCoverageSeeds([aSeed()]);
    if (!ledger.ok) throw new Error("expected a ledger");
    const report = renderReport({ metadata: METADATA, ledger: ledger.value, findings: findings() });
    expect(report).toContain("## Disposition handoff");
    expect(report).toContain("standalone-disposition --run .");
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
