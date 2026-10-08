import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { evaluateWaveCompletionSuite } from "../../src/core/completion-suite";
import {
  authorizeWaveCompletionSuite,
  defaultVerificationManifest,
  deriveProjectVerificationCoverage,
  freezeVerificationManifest,
  renderProjectVerificationCoverage,
} from "../../src/core/verification-manifest";
import { value } from "../fixtures/parse-result";

function manifest(ids: readonly string[]) {
  return value(freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    schemaVersion: 1,
    kind: "loom-verification-manifest",
    checks: ids.map((id) => ({
      id, scope: "wave", executable: "npm", args: ["run", "verify"], cwd: ".",
      timeoutMs: 1_000, report: { kind: "not-required" },
    })),
  }))));
}

const ids = fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,15}$/), { maxLength: 10 })
  .map((suffixes) => suffixes.map((suffix) => `project:${suffix}`));

function deepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Object.values(value).every(deepFrozen);
}

describe("Project Verification Coverage projection", () => {
  it("is immutable, deterministic, permutation-invariant and configured iff the exact project roster is nonempty", () => {
    fc.assert(fc.property(ids, (checkIds) => {
      const authority = manifest(checkIds);
      const before = JSON.stringify(authority);
      const coverage = deriveProjectVerificationCoverage(authority);
      expect(coverage).toEqual(checkIds.length === 0
        ? { kind: "not-configured", reason: "empty-operator-manifest" }
        : { kind: "configured", checkIds: [...checkIds].sort() });
      expect(deriveProjectVerificationCoverage(authority)).toEqual(coverage);
      expect(deriveProjectVerificationCoverage(manifest([...checkIds].reverse()))).toEqual(coverage);
      expect(deepFrozen(coverage)).toBe(true);
      expect(JSON.stringify(authority)).toBe(before);
      const diagnostic = renderProjectVerificationCoverage(coverage);
      expect(diagnostic).not.toMatch(/passed|waived|waiver/i);
      expect(diagnostic).toContain(checkIds.length === 0 ? "NOT CONFIGURED" : "checks configured:");
      if (coverage.kind === "configured") expect(coverage.checkIds.length).toBeGreaterThan(0);
    }), { numRuns: 200 });
  });

  it("projects historical project IDs only from the archived exact result, without claiming absent-versus-empty provenance", () => {
    fc.assert(fc.property(ids, (checkIds) => {
      const authority = value(authorizeWaveCompletionSuite(manifest(checkIds), {
        runId: "run.coverage-property", wave: 1, revision: 0, authorityDigest: "a".repeat(64),
      }, "b".repeat(64)));
      const evaluation = evaluateWaveCompletionSuite(authority, {
        kind: "wave-completion-suite-result",
        runId: authority.runId, wave: authority.wave, revision: authority.revision,
        authorityDigest: authority.authorityDigest, manifestDigest: authority.manifestDigest,
        suiteDigest: authority.suiteDigest, workspaceDigest: authority.workspaceDigest,
        checks: authority.checks.map((check) => ({
          checkId: check.checkId, scope: "wave",
          outcome: { kind: "observed", exitCode: 0, timedOut: false, signal: null, report: { kind: "not-required" } },
        })),
      });
      if (evaluation.kind !== "accepted") throw new Error("historical receipt fixture must be accepted");
      const receipt = evaluation.receipt;
      const before = JSON.stringify(receipt);
      const coverage = deriveProjectVerificationCoverage(receipt);
      expect(coverage).toEqual(checkIds.length === 0
        ? { kind: "not-configured", reason: "historical-unknown" }
        : { kind: "configured", checkIds: [...checkIds].sort() });
      expect(deepFrozen(coverage)).toBe(true);
      expect(JSON.stringify(receipt)).toBe(before);
    }), { numRuns: 200 });
  });

  it("distinguishes absent source from explicit operator emptiness without adding persisted truth", () => {
    const absent = defaultVerificationManifest();
    const empty = manifest([]);
    expect(deriveProjectVerificationCoverage(absent)).toEqual({ kind: "not-configured", reason: "engine-default" });
    expect(deriveProjectVerificationCoverage(empty)).toEqual({ kind: "not-configured", reason: "empty-operator-manifest" });
    for (const authority of [absent, empty]) {
      expect(authority.projectChecks).toEqual([]);
      expect(Object.keys(authority).sort()).toEqual(["kind", "manifestDigest", "projectChecks", "schemaVersion", "source"]);
      expect(renderProjectVerificationCoverage(deriveProjectVerificationCoverage(authority))).toContain("reserved checks only");
    }
  });
});
