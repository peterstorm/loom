/**
 * `remediationAuditBlockMessage` decides which blocked-audit cause gets the
 * "start a FRESH remediation run" advice.
 *
 * Its own docstring makes the distinction load-bearing: an unauthorized dirty
 * path is the case a run's immutable start input can never authorize, so the
 * only real recovery is a fresh run with a wider `supportPaths`. Every OTHER
 * refusal — pre-existing staged work, excluded evidence paths, an
 * expected/actual mismatch — names dirty state that IS removable in place, and
 * "start a fresh run" would trade one wrong recovery for another.
 *
 * Only the unauthorized branch had a test. This pins the other one, so a
 * regression that broadened the advice to every audit failure goes red.
 */

import { describe, expect, it } from "vitest";
import {
  recordInstalledRemediation,
  remediationAuditBlockMessage,
} from "../../../../src/handlers/helpers/programs/remediation";
import type { CanonicalRepositoryRelativePath, RemediationAuditError } from "../../../../src/core/remediation-machine";

const path = (value: string): CanonicalRepositoryRelativePath => value as CanonicalRepositoryRelativePath;

const auditError = (
  overrides: Partial<RemediationAuditError> = {},
): RemediationAuditError => ({
  kind: "remediation-audit-failed",
  field: "audit",
  unauthorizedDirtyPaths: [],
  unauthorizedPreexistingStagedPaths: [],
  preexistingStagedPathsOutsideAudited: [],
  excludedEvidencePaths: [],
  missingPaths: [],
  unexpectedPaths: [],
  observationErrors: [],
  message: "remediation audit refused",
  ...overrides,
});

const FRESH_RUN_ADVICE = "start a FRESH remediation run";

describe("recordInstalledRemediation", () => {
  it("reports a checkpoint failure as post-install and retains the receipt", async () => {
    const receipt = {
      kind: "verified-index-installed",
      effectId: "effect:remediation-install:test",
      runId: "run.remediation",
      indexDigest: "a".repeat(64),
      witnessDigest: "b".repeat(64),
    } as never;
    const handle = {
      runId: "run.remediation",
      writeCheckpoint: async () => { throw new Error("disk full"); },
    } as never;

    const result = await recordInstalledRemediation(
      handle,
      { state: "done", receipt } as never,
      receipt,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("verified index was installed");
    expect(result.message).toContain("checkpoint recording failed: disk full");
    expect(result.message).toContain('"kind":"verified-index-installed"');
    expect(result.message).not.toContain("remediation-blocked");
  });
});

describe("remediationAuditBlockMessage", () => {
  it("adds the fresh-run advice when a dirty path is unauthorized", () => {
    const message = remediationAuditBlockMessage(auditError({
      unauthorizedDirtyPaths: [path(".claude/plans/2026-08-18-pr-remediation.md")],
      message: "unauthorized dirty paths",
    }));

    expect(message).toContain("unauthorized dirty paths");
    expect(message).toContain(FRESH_RUN_ADVICE);
    expect(message).toContain("supportPath");
  });

  it.each([
    ["pre-existing staged work", { unauthorizedPreexistingStagedPaths: [path("src/a.ts")] }],
    ["staged work outside the audited set", { preexistingStagedPathsOutsideAudited: [path("src/b.ts")] }],
    ["excluded run evidence", { excludedEvidencePaths: [path(".claude/reviews/review-runs/run.x/result.json")] }],
    ["a path the audit expected but did not observe", { missingPaths: [path("src/c.ts")] }],
    ["a path observed but never expected", { unexpectedPaths: [path("src/d.ts")] }],
  ])("passes a %s refusal through unchanged", (cause, overrides) => {
    const error = auditError({ ...overrides, message: `remediation audit refused: ${cause}` });

    // Byte-identical, not merely "contains": these causes are removable in
    // place, so resuming THIS run is the correct recovery and the message must
    // not point anywhere else.
    expect(remediationAuditBlockMessage(error)).toBe(error.message);
    expect(remediationAuditBlockMessage(error)).not.toContain(FRESH_RUN_ADVICE);
  });

  it("passes a refusal with no populated cause through unchanged", () => {
    const error = auditError();

    expect(remediationAuditBlockMessage(error)).toBe(error.message);
  });
});
