/**
 * Report derivation properties. The reports are the part a human believes, so
 * the tests are about agreement between prose and records:
 *
 *   INV-S6  every published record appears in the derived prose exactly where
 *           its verdict says, and never where it does not;
 *   INV-S6b the same records always render byte-identical prose;
 *   INV-S4b no `needs_validation` lead is rendered with a severity.
 */

import { describe, expect, it } from "vitest";
import { parseSecurityFindings, type SecurityFinding } from "../../src/core/security-findings";
import { assignUnits, coverageSettled, deferPlannedUnits, recordUnitResult, runStatusOf, seedCoverageUnit, type CoverageLedger } from "../../src/core/security-coverage";
import { HUNTER_AGENT as HUNTER, aRefs, aRunMetadata, ok } from "./fixtures";
import {
  renderFindingsDetail,
  renderNeedsValidation,
  renderReport,
  renderRunDocuments,
} from "../../src/core/security-reports";

const CONFIRMED = {
  verdict: "confirmed",
  fingerprint: "authz:1",
  title: "Report export skips the tenant predicate",
  description: "The export query filters on the path id only, so a foreign tenant id exports another tenant's rows.",
  root_cause: "the export handler builds its predicate from the path parameter alone",
  intended_behavior: "every read of a report is scoped to the caller's tenant",
  trace: [
    { kind: "entrypoint", file: "src/reports/export.ts", line: 12, scope: "exportReport", description: "path id reaches the query" },
    { kind: "sink", file: "src/reports/query.ts", line: 44, scope: "selectById", description: "no tenant predicate is added" },
  ],
  evidence: [{ file: "src/reports/query.ts", line: 44, description: "predicate is id-only" }],
  conditions: [{ kind: "authorization_role", description: "any authenticated tenant user" }],
  execution: {
    attacker_perspective: "an authenticated user of tenant B",
    payloads: ["GET /reports/<tenant-A-id>/export"],
    instructions: ["authenticate as tenant B", "request tenant A's report id"],
    observed_result: "tenant A's rows are returned in the CSV",
  },
  remediation: { strategy: "add the tenant predicate to the export query" },
  severity: {
    likelihood: { score: "high", reason: "no privileged setup is needed" },
    impact: { score: "high", reason: "cross-tenant disclosure of report data" },
    overall_severity: "high",
  },
  confidence: { score: "high", reason: "the query text and the response are both observed" },
} as const;

const NEEDS_VALIDATION = {
  verdict: "needs_validation",
  fingerprint: "ssrf:1",
  title: "Webhook target may be re-resolved after validation",
  description: "Validation resolves the hostname, then the client resolves it again at connect time.",
  claimed_root_cause: "the validated address is not pinned for the request",
  trace: [
    { kind: "entrypoint", file: "src/webhooks/send.ts", line: 20, scope: "sendWebhook", description: "url comes from tenant config" },
  ],
  evidence: [{ file: "src/webhooks/validate.ts", line: 8, description: "only the first resolution is checked" }],
  blockers: ["the HTTP client's resolver is not exercised by any local test"],
  validation_plan: { local: "run a local resolver double that answers differently on the second lookup" },
} as const;

const REJECTED = {
  verdict: "rejected",
  fingerprint: "xss:1",
  title: "Report title is reflected unescaped",
  description: "The title is escaped by the template engine.",
  claimed_root_cause: "raw interpolation",
  reason: "the rendering path escapes by default and the observed page shows the entity",
  trace: [
    { kind: "sink", file: "src/reports/view.tsx", line: 9, scope: "ReportTitle", description: "the title is escaped by the template" },
  ],
  evidence: [{ file: "src/reports/view.tsx", line: 9, description: "escaped by the template" }],
} as const;

const parse = (document: unknown): readonly SecurityFinding[] => ok(parseSecurityFindings(document));

const metadata = aRunMetadata({
  runId: "audit-2026-11-07",
  target: "example/app",
  repo: "example/app",
  scope: { kind: "diff", paths: ["src/reports/export.ts", "src/reports/query.ts", "src/webhooks/send.ts"], baseRef: "0".repeat(40), headRef: "1".repeat(40) },
  scopePaths: ["src/reports/export.ts", "src/reports/query.ts", "src/webhooks/send.ts"],
  sourceRef: { commit: "1".repeat(40), worktreeDirty: false },
  budget: 24,
  selectedCompanions: ["ATTACK-CLASSES.md", "DATA-ISOLATION-AND-LIFECYCLE.md"],
});

const deferReason = "budget_cannot_reserve_critics_and_validation";

/** One unit, planned until a test settles it. */
const planned = (): CoverageLedger => [ok(seedCoverageUnit({
  refs: aRefs({ surface: "http:GET /reports/:id/export", boundary: "tenant isolation", subsystem: "reporting", attack_class: "authorization-gap" }),
  starting_paths: ["src/reports/export.ts"],
  ordinary_attack_class_block: "ATTACK-CLASSES.md#access-control",
  selected_companion_blocks: ["DATA-ISOLATION-AND-LIFECYCLE.md#tenant-and-object-isolation"],
  excluded_blocks: [],
  prior: null,
}))];

const ledger = (): CoverageLedger => {
  const [unit] = planned();
  const assigned = ok(assignUnits([unit!], [{ coverageId: unit!.coverage_id, agentId: HUNTER, wave: 1 }]));
  return ok(recordUnitResult(assigned.ledger, {
    coverageId: unit!.coverage_id,
    wave: 1,
    agentId: HUNTER,
    status: "candidate",
    reviewedPaths: ["src/reports/export.ts"],
    checks: [{ agent_id: HUNTER, reviewed_paths: ["src/reports/export.ts"], invariant: "tenant predicate present", method: "source", result: "absent", artifact: null }],
    fingerprints: ["authz:1"],
  }));
};

describe("report derivation", () => {
  it("renders every published record exactly where its verdict says (INV-S6)", () => {
    const findings = parse([CONFIRMED, NEEDS_VALIDATION, REJECTED]);
    const documents = renderRunDocuments({ metadata, ledger: ledger(), findings, locator: "/out" });

    const report = documents["REPORT.md"] ?? "";
    expect(report.match(/authz:1/g)?.length).toBe(1);
    expect(report).toContain("Report export skips the tenant predicate");
    expect(report).toContain("Webhook target may be re-resolved after validation");
    expect(report).toContain("xss:1");
    // The rejected claim is retained as a fingerprint, never as a finding row.
    expect(report).toContain("Rejected claims");
    expect(report).not.toContain("Report title is reflected unescaped");

    const needsValidation = documents["NEEDS-VALIDATION.md"] ?? "";
    expect(needsValidation).toContain("ssrf:1");
    expect(needsValidation).not.toContain("authz:1");
    expect(needsValidation).not.toContain("xss:1");

    const detail = documents["FINDINGS-DETAIL.md"] ?? "";
    expect(detail).toContain("authz:1");
    expect(detail).not.toContain("ssrf:1");
  });

  it("gives a needs_validation lead no severity anywhere (INV-S4b)", () => {
    const findings = parse([NEEDS_VALIDATION]);
    const needsValidation = renderNeedsValidation({ metadata, ledger: ledger(), findings, locator: "/out" });
    expect(needsValidation).not.toMatch(/\b(critical|high|medium|low)\b/i);
    expect(needsValidation).not.toContain("Severity:");
    expect(needsValidation).toContain("Blockers:");
  });

  it("is byte-identical for identical records (INV-S6b)", () => {
    const findings = parse([CONFIRMED, NEEDS_VALIDATION, REJECTED]);
    const first = renderRunDocuments({ metadata, ledger: ledger(), findings, locator: "/out" });
    const second = renderRunDocuments({ metadata, ledger: ledger(), findings, locator: "/out" });
    expect(first).toEqual(second);
    expect(renderReport({ metadata, ledger: ledger(), findings, locator: "/out" })).toBe(renderReport({ metadata, ledger: ledger(), findings, locator: "/out" }));
  });

  it("discloses an incomplete run instead of claiming coverage", () => {
    const deferred = ok(deferPlannedUnits(ledger(), deferReason));
    expect(coverageSettled(deferred)).toBe(true);
    const report = renderReport({
      metadata: { ...metadata, runStatus: "incomplete", incompleteReason: deferReason },
      ledger: deferred,
      findings: [],
      locator: "/out",
    });
    expect(report).toContain("Run status: incomplete");
    expect(report).toContain(deferReason);
    expect(report).toContain("deferred");
  });

  it("marks an incomplete reason no deferral recorded as inferred, and a recorded one as itself", () => {
    const render = (deferred: CoverageLedger) =>
      renderReport({ metadata: { ...metadata, ...runStatusOf(deferred) }, ledger: deferred, findings: [], locator: "/out" });
    const prose = ok(deferPlannedUnits(planned(), "the export endpoint was unreachable from the sandbox"));
    const inferred = render(prose);
    expect(inferred).toContain("`validation_budget_exhausted` (inferred: no deferred unit recorded an upstream reason");
    // The deferral's own reason stays the authority, listed beside the token.
    expect(inferred).toContain("the export endpoint was unreachable from the sandbox");
    const recorded = render(ok(deferPlannedUnits(planned(), deferReason)));
    expect(recorded).toContain(`\`${deferReason}\`.**`);
    expect(recorded).not.toContain("inferred");
  });

  it("prints a diff scope by its two commits", () => {
    expect(renderReport({ metadata, ledger: ledger(), findings: [], locator: "/out" })).toContain(`- Scope: ${"0".repeat(40)}..${"1".repeat(40)}`);
  });

  it("renders the positive case without inventing findings", () => {
    const settledLedger = ok(deferPlannedUnits(ledger(), "no_remaining_work"));
    const report = renderReport({ metadata, ledger: settledLedger, findings: [], locator: "/out", hardening: ["Parameterized queries are used throughout the export path."] });
    expect(report).toContain("0 confirmed, 0 needing validation, 0 rejected");
    expect(report).toContain("Parameterized queries are used throughout the export path.");
    expect(renderFindingsDetail({ metadata, ledger: settledLedger, findings: [], locator: "/out" })).toContain("No medium-or-higher confirmed finding");
    expect(renderNeedsValidation({ metadata, ledger: settledLedger, findings: [], locator: "/out" })).toContain("No unresolved lead");
  });
});
