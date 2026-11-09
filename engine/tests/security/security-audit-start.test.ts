/**
 * The `start` payload and what a run derives from it. The parser stands
 * between an operator's JSON and every later decision of the run — scope and
 * lens selection are fixed here — so its properties are about REFUSAL:
 *
 *   INV-ST1  any well-typed subset of the known signals parses to exactly those
 *            signals, with every omitted one absent (`[]`/`false`);
 *   INV-ST2  an unknown key at any level, or a mistyped field, is a named
 *            violation — never coerced, never dropped;
 *   INV-ST3  every violation is reported at once.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseSecurityAuditStart, startMetadata } from "../../src/core/security-audit-start";
import { parseCoverageSeeds } from "../../src/core/security-coverage";
import { parseSecurityRunMetadata } from "../../src/core/security-audit-contract";
import { aSeed, aSignals, ok } from "./fixtures";

const BOOLEAN_SIGNALS = [
  "servesHttp", "rendersClientSide", "drivesModelsOrTools", "usesQueuesOrRpc", "isolatesTenants",
  "deploysInfrastructure", "hasNativeMemory", "hasAppOrLocalIpc", "hasReleasePipelines", "hasSharedResourcePressure",
] as const;

describe("parseSecurityAuditStart", () => {
  it("defaults an absent scope to a tree and absent signals to none", () => {
    expect(ok(parseSecurityAuditStart({ units: [] }))).toEqual({
      units: [],
      scope: { kind: "tree", baseRef: null, headRef: null },
      signals: aSignals(),
    });
  });

  it("INV-ST1: parses any well-typed subset of the signals to exactly those signals", () => {
    fc.assert(fc.property(
      fc.subarray([...BOOLEAN_SIGNALS]),
      fc.array(fc.constantFrom("ts", "rs", "tsx"), { maxLength: 3 }),
      (enabled, languages) => {
        const signals = { ...Object.fromEntries(enabled.map((name) => [name, true])), languages };
        expect(ok(parseSecurityAuditStart({ units: [], signals })).signals).toEqual(
          aSignals({ ...Object.fromEntries(enabled.map((name) => [name, true])), languages }),
        );
      },
    ));
  });

  it("INV-ST2/3: names every unknown or mistyped field at once", () => {
    const refused = parseSecurityAuditStart({
      units: "all",
      extra: 1,
      scope: { kind: "branch", baseRef: 1, extra: true },
      signals: { servesHttp: "yes", manifests: [1], servesHTTP: true },
    });
    expect(refused).toEqual({
      ok: false,
      error: {
        kind: "invalid-security-audit-start",
        violations: [
          { path: "$.extra", message: "unknown field" },
          { path: "units", message: "start input requires a `units` array" },
          { path: "scope.extra", message: "unknown field" },
          { path: "scope.kind", message: "expected tree or diff" },
          { path: "scope.baseRef", message: "expected a string or null" },
          { path: "signals.servesHTTP", message: "unknown field" },
          { path: "signals.manifests", message: "expected an array of strings" },
          { path: "signals.servesHttp", message: "expected a boolean" },
        ],
      },
    });
  });

  it.each([[null], [[]], ["units"], [7]] as const)("refuses a payload that is not an object (%j)", (raw: unknown) => {
    expect(parseSecurityAuditStart(raw)).toEqual({
      ok: false,
      error: { kind: "invalid-security-audit-start", violations: [{ path: "$", message: "start input must be an object" }] },
    });
  });

  it("refuses a null scope or null signals rather than reading them as absent", () => {
    expect(parseSecurityAuditStart({ units: [], scope: null }).ok).toBe(false);
    expect(parseSecurityAuditStart({ units: [], signals: null }).ok).toBe(false);
  });
});

describe("startMetadata", () => {
  const facts = {
    directoryName: "audit-dir",
    repo: "/repo",
    runId: null,
    profile: "standard" as const,
    budget: null,
    sourceRef: { commit: "a".repeat(40), worktreeDirty: false },
  };
  const ledger = ok(parseCoverageSeeds([aSeed()]));

  it("derives a run the metadata schema accepts, with the default id, the seeds' paths and the payload's scope", () => {
    const payload = ok(parseSecurityAuditStart({ units: [], scope: { kind: "diff", baseRef: "b".repeat(40), headRef: null } }));
    const { metadata } = startMetadata(facts, payload, ledger);
    expect(parseSecurityRunMetadata(metadata).ok).toBe(true);
    expect(metadata.runId).toBe(`audit-dir-${"a".repeat(12)}`);
    expect(metadata.scope).toEqual({ paths: ["src/api/login.ts"], kind: "diff", baseRef: "b".repeat(40), headRef: null });
    expect(metadata.runStatus).toBe("in_progress");
    expect(metadata.published).toBe(false);
  });

  it("keeps the caller's run id and caps lenses at the profile", () => {
    const payload = ok(parseSecurityAuditStart({ units: [], signals: { servesHttp: true, drivesModelsOrTools: true, isolatesTenants: true, hasReleasePipelines: true } }));
    const { metadata, selection } = startMetadata({ ...facts, runId: "chosen", profile: "quick" }, payload, ledger);
    expect(metadata.runId).toBe("chosen");
    expect(selection.included).toHaveLength(2);
    expect(metadata.selectedCompanions).toEqual(selection.included.map((entry) => entry.lens));
  });
});
