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
import { describe, expect, expectTypeOf, it } from "vitest";
import { parseSecurityAuditStart, startMetadata } from "../../src/core/security-audit-start";
import { parseCoverageSeeds } from "../../src/core/security-coverage";
import { parseSecurityRunMetadata, type CommitId } from "../../src/core/security-audit-contract";
import { STACK_SIGNAL_NAMES, STACK_SIGNAL_SHAPES } from "../../src/core/security-lens-select";
import { aSeed, aSignals, BOOLEAN_SIGNALS, ok } from "./fixtures";


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
        // One value: the parsed signals equal the input signals.
        const signals = { ...Object.fromEntries(enabled.map((name) => [name, true])), languages };
        expect(ok(parseSecurityAuditStart({ units: [], signals })).signals).toEqual(aSignals(signals));
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
          { path: "units", message: "start input requires a `units` array" },
          { path: "scope.kind", message: "expected tree or diff" },
          { path: "scope.baseRef", message: "expected a string or null" },
          { path: "scope.extra", message: "unknown field" },
          { path: "signals.manifests[0]", message: "expected a string" },
          { path: "signals.servesHttp", message: "expected a boolean" },
          { path: "signals.servesHTTP", message: "unknown field" },
          { path: "extra", message: "unknown field" },
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

  it("pairs a scope's refs with its kind: a diff names both commits, a tree names neither", () => {
    const commit = "a".repeat(40);
    const violations = (scope: unknown) => {
      const parsed = parseSecurityAuditStart({ units: [], scope });
      return parsed.ok ? [] : parsed.error.violations;
    };
    expect(ok(parseSecurityAuditStart({ units: [], scope: { kind: "diff", baseRef: commit, headRef: commit } })).scope)
      .toEqual({ kind: "diff", baseRef: commit, headRef: commit });
    expect(violations({ kind: "diff" })).toEqual([
      { path: "scope.baseRef", message: "a diff scope names both refs" },
      { path: "scope.headRef", message: "a diff scope names both refs" },
    ]);
    expect(violations({ kind: "diff", baseRef: commit, headRef: null })).toEqual([{ path: "scope.headRef", message: "a diff scope names both refs" }]);
    expect(violations({ kind: "diff", baseRef: "main", headRef: commit })).toEqual([{ path: "scope.baseRef", message: "expected a 40- or 64-hex commit id" }]);
    expect(violations({ kind: "tree", baseRef: commit, headRef: commit })).toEqual([
      { path: "scope.baseRef", message: "a tree scope names no refs" },
      { path: "scope.headRef", message: "a tree scope names no refs" },
    ]);
    // A mistyped ref is named once, by its type, not again as missing.
    expect(violations({ kind: "diff", baseRef: 7, headRef: commit })).toEqual([{ path: "scope.baseRef", message: "expected a string or null" }]);
  });

  it("hands a diff's refs on as branded commit ids, and names every ref that is not one", () => {
    const scope = ok(parseSecurityAuditStart({ units: [], scope: { kind: "diff", baseRef: "a".repeat(64), headRef: "b".repeat(40) } })).scope;
    if (scope.kind !== "diff") throw new Error("expected a diff scope");
    expectTypeOf(scope.baseRef).toEqualTypeOf<CommitId>();
    expectTypeOf(scope.headRef).toEqualTypeOf<CommitId>();
    // @ts-expect-error — a plain string is no commit id: only the parse brands one.
    const forged: CommitId = "main";
    void forged;
    const refused = parseSecurityAuditStart({ units: [], scope: { kind: "diff", baseRef: "A".repeat(40), headRef: "b".repeat(41) } });
    expect(refused.ok ? [] : refused.error.violations).toEqual([
      { path: "scope.baseRef", message: "expected a 40- or 64-hex commit id" },
      { path: "scope.headRef", message: "expected a 40- or 64-hex commit id" },
    ]);
  });

  it("parses every signal the selector's table names, each by its own shape", () => {
    for (const name of STACK_SIGNAL_NAMES) {
      const mistyped = STACK_SIGNAL_SHAPES[name] === "boolean" ? "yes" : true;
      const refused = parseSecurityAuditStart({ units: [], signals: { [name]: mistyped } });
      expect(refused.ok ? [] : refused.error.violations, name).toEqual([{
        path: `signals.${name}`,
        message: STACK_SIGNAL_SHAPES[name] === "boolean" ? "expected a boolean" : "expected an array of strings",
      }]);
    }
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
    const payload = ok(parseSecurityAuditStart({ units: [], scope: { kind: "diff", baseRef: "b".repeat(40), headRef: "c".repeat(64) } }));
    const { metadata } = startMetadata(facts, payload, ledger);
    expect(parseSecurityRunMetadata(metadata).ok).toBe(true);
    expect(metadata.runId).toBe(`audit-dir-${"a".repeat(12)}`);
    expect(metadata.scope).toEqual({ paths: ["src/api/login.ts"], kind: "diff", baseRef: "b".repeat(40), headRef: "c".repeat(64) });
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
