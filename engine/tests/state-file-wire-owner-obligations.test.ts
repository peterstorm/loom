/**
 * T7 / AD-2: the State File wire proves `owner_obligations` before any reader
 * selects from it. Each obligation is an exact record built through the one
 * Owner Obligation constructor, so a path playing two roles is refused; an
 * Invariant id is `INV-N`; an exemption needs a non-blank reason; an absent
 * field stays absent, so a graph populated before owner verification loads
 * and owes nothing (FR-004).
 */

import { describe, expect, it } from "vitest";
import { parseTaskGraph } from "../src/state-file-wire";
import { emptyAcceptanceExpectation } from "../src/core/acceptance-contract";
import { evaluateWaveCompletionSuite, type AcceptedWaveCompletionReceipt } from "../src/core/completion-suite";
import type { ArtifactDigest } from "../src/core/orchestration-contract";
import {
  obligationsDigest,
  ownerCheckAuthority,
  ownerScopeOf,
  ownerVerificationOwed,
  type OwnerCheckAuthority,
} from "../src/core/owner-verification/obligations";
import { authorizeWaveCompletionSuite, defaultVerificationManifest } from "../src/core/verification-manifest";
import type { ActiveWaveGateRegistration, OwnerObligation, TaskGraph } from "../src/types";
import { ownerObligation } from "./fixtures/owner-obligation";

const VERIFIED: OwnerObligation = ownerObligation({
  invariant: "INV-1",
  title: "One owner",
  statement: "The rule lives in one module.",
  owner: "src/rule-owner.ts",
  siblings: [
    { path: "src/rule-sibling.ts", note: "the second entry point" },
    { path: "src/rule-third.ts", note: null },
  ],
  matrixTest: "tests/rule.matrix.test.ts",
  mutation: { kind: "verify" },
});

const EXEMPT: OwnerObligation = ownerObligation({
  invariant: "INV-2",
  title: "Generated owner",
  statement: null,
  owner: "src/generated.ts",
  siblings: [],
  matrixTest: "tests/generated.matrix.test.ts",
  mutation: { kind: "exempt", reason: "owner is generated from a schema" },
});

const graph = (extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
  current_phase: "execute",
  phase_artifacts: {},
  skipped_phases: [],
  spec_file: null,
  plan_file: "plan.md",
  tasks: [],
  wave_gates: {},
  ...extra,
} satisfies Partial<TaskGraph> & Record<string, unknown>);

const viaDisk = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const refusal = (ownerObligations: unknown): string => {
  const parsed = parseTaskGraph(viaDisk(graph({ owner_obligations: ownerObligations })));
  if (parsed.ok) throw new Error("expected the wire to refuse owner_obligations");
  return parsed.error;
};

describe("owner_obligations on the State File wire", () => {
  it("FR-004: a graph without the field loads without it and owes nothing", () => {
    const parsed = parseTaskGraph(viaDisk(graph()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect("owner_obligations" in parsed.value).toBe(false);
    expect(ownerVerificationOwed(ownerScopeOf(parsed.value), 1)).toEqual([]);
    expect(ownerCheckAuthority(ownerScopeOf(parsed.value), 1)).toBeNull();
  });

  it("round-trips an empty stamp as present and empty", () => {
    const parsed = parseTaskGraph(viaDisk(graph({ owner_obligations: [] })));
    expect(parsed.ok && parsed.value.owner_obligations).toEqual([]);
    if (!parsed.ok) return;
    expect(ownerCheckAuthority(ownerScopeOf(parsed.value), 1)).not.toBeNull();
  });

  it("round-trips verify and exempt obligations exactly, in order", () => {
    const parsed = parseTaskGraph(viaDisk(graph({ owner_obligations: [VERIFIED, EXEMPT] })));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.owner_obligations).toEqual([VERIFIED, EXEMPT]);
    expect(viaDisk(parsed.value.owner_obligations)).toEqual(viaDisk([VERIFIED, EXEMPT]));
  });

  it("returns a frozen copy that does not alias the raw JSON", () => {
    const raw = viaDisk(graph({ owner_obligations: [VERIFIED] })) as Record<string, unknown>;
    const parsed = parseTaskGraph(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    ((raw.owner_obligations as Record<string, unknown>[])[0] as Record<string, unknown>).owner = "src/elsewhere.ts";
    expect(parsed.value.owner_obligations?.[0]?.owner).toBe("src/rule-owner.ts");
    expect(Object.isFrozen(parsed.value.owner_obligations)).toBe(true);
    expect(Object.isFrozen(parsed.value.owner_obligations?.[0])).toBe(true);
    expect(Object.isFrozen(parsed.value.owner_obligations?.[0]?.siblings)).toBe(true);
  });

  it("refuses a non-array stamp", () => {
    expect(refusal({})).toContain("owner_obligations must be an array");
    expect(refusal(null)).toContain("owner_obligations must be an array");
  });

  it("refuses an obligation that is not an exact record", () => {
    expect(refusal(["INV-1"])).toContain("owner_obligations[0] must be an object");
    expect(refusal([{ ...VERIFIED, extra: true }])).toContain("owner_obligations[0] contains unknown field(s): extra");
    const { matrixTest: _matrixTest, ...missing } = VERIFIED;
    expect(refusal([missing])).toContain("owner_obligations[0] is missing field(s): matrixTest");
  });

  it("refuses an invariant id that is not the plan grammar's INV-N", () => {
    for (const invariant of [" ", 7, "INV-", "inv-1", "LC-1", "INV-1 "]) {
      expect(refusal([{ ...VERIFIED, invariant }])).toContain("owner_obligations[0].invariant must be an Invariant id (INV-N)");
    }
  });

  it.each([
    ["the owner is also a sibling", { siblings: [{ path: "./src/rule-owner.ts", note: null }] }, "'./src/rule-owner.ts' is both the owner module and a sibling entry point"],
    ["the matrix test is the owner", { matrixTest: "src/rule-owner.ts" }, "'src/rule-owner.ts' is both the owner module and the matrix test"],
    ["the matrix test is a sibling", { matrixTest: "src/rule-third.ts" }, "'src/rule-third.ts' is both a sibling entry point and the matrix test"],
    ["a sibling is listed twice", { siblings: [{ path: "src/a.ts", note: null }, { path: "./src/a.ts", note: "again" }] }, "sibling entry point './src/a.ts' is listed twice"],
  ] as const)("refuses a hand-edited stamp the plan grammar could never derive: %s", (_case, change, message) => {
    expect(refusal([{ ...VERIFIED, ...change }])).toContain(`owner_obligations[0]: INV-1: ${message}`);
  });

  it("refuses blank or non-string paths and names", () => {
    for (const field of ["title", "owner", "matrixTest"] as const) {
      expect(refusal([{ ...VERIFIED, [field]: " " }])).toContain(`owner_obligations[0].${field} must be non-blank text`);
      expect(refusal([{ ...VERIFIED, [field]: 7 }])).toContain(`owner_obligations[0].${field} must be non-blank text`);
    }
  });

  it("refuses a statement that is neither text nor null", () => {
    expect(refusal([{ ...VERIFIED, statement: 3 }])).toContain("owner_obligations[0].statement must be a string or null");
  });

  it("refuses malformed siblings", () => {
    expect(refusal([{ ...VERIFIED, siblings: {} }])).toContain("owner_obligations[0].siblings must be an array");
    expect(refusal([{ ...VERIFIED, siblings: [{ path: "src/a.ts" }] }]))
      .toContain("owner_obligations[0].siblings[0] is missing field(s): note");
    expect(refusal([{ ...VERIFIED, siblings: [{ path: "src/a.ts", note: null, why: "x" }] }]))
      .toContain("owner_obligations[0].siblings[0] contains unknown field(s): why");
    expect(refusal([{ ...VERIFIED, siblings: [{ path: "", note: null }] }]))
      .toContain("owner_obligations[0].siblings[0].path must be non-blank text");
    expect(refusal([{ ...VERIFIED, siblings: [{ path: "src/a.ts", note: 1 }] }]))
      .toContain("owner_obligations[0].siblings[0].note must be a string or null");
  });

  it("refuses an exemption with a blank or missing reason", () => {
    expect(refusal([{ ...EXEMPT, mutation: { kind: "exempt", reason: "" } }]))
      .toContain("owner_obligations[0].mutation.reason must be non-blank text");
    expect(refusal([{ ...EXEMPT, mutation: { kind: "exempt", reason: "   \t" } }]))
      .toContain("owner_obligations[0].mutation.reason must be non-blank text");
    expect(refusal([{ ...EXEMPT, mutation: { kind: "exempt", reason: 4 } }]))
      .toContain("owner_obligations[0].mutation.reason must be non-blank text");
    expect(refusal([{ ...EXEMPT, mutation: { kind: "exempt" } }]))
      .toContain("owner_obligations[0].mutation is missing field(s): reason");
  });

  it("refuses an unknown mutation policy and a verify policy that carries a reason", () => {
    expect(refusal([{ ...VERIFIED, mutation: { kind: "skip" } }]))
      .toContain("owner_obligations[0].mutation.kind must be verify or exempt");
    expect(refusal([{ ...VERIFIED, mutation: "verify" }])).toContain("owner_obligations[0].mutation must be an object");
    expect(refusal([{ ...VERIFIED, mutation: { kind: "verify", reason: "x" } }]))
      .toContain("owner_obligations[0].mutation contains unknown field(s): reason");
  });

  it("refuses two obligations for the same Invariant", () => {
    expect(refusal([VERIFIED, { ...EXEMPT, invariant: "INV-1" }]))
      .toContain("owner_obligations names INV-1 more than once");
  });

  it("names the failing entry by index", () => {
    expect(refusal([VERIFIED, { ...EXEMPT, owner: "" }])).toContain("owner_obligations[1].owner must be non-blank text");
  });
});

describe("active_wave_completion_suite on the State File wire re-derives the owner check from the stamp", () => {
  const MANIFEST = defaultVerificationManifest();
  const WORKSPACE = "b".repeat(64) as ArtifactDigest;
  const ACTIVE: ActiveWaveGateRegistration = {
    schemaVersion: 1, kind: "active-wave-gate", runId: "run.wire-owner-roster" as ActiveWaveGateRegistration["runId"],
    wave: 1, authorityDigest: "a".repeat(64) as ArtifactDigest, revision: 0, terminalOutcome: null,
  };

  /** A receipt accepted under `owner`: every check passed, and the owner check (if any) verified its owed ids. */
  function receiptUnder(owner: OwnerCheckAuthority | null): AcceptedWaveCompletionReceipt {
    const suite = authorizeWaveCompletionSuite(MANIFEST, ACTIVE, WORKSPACE, owner);
    if (!suite.ok) throw new Error(suite.error.errors.join("; "));
    const evaluation = evaluateWaveCompletionSuite(suite.value, {
      kind: "wave-completion-suite-result",
      runId: suite.value.runId, wave: suite.value.wave, revision: suite.value.revision, authorityDigest: suite.value.authorityDigest,
      manifestDigest: suite.value.manifestDigest, suiteDigest: suite.value.suiteDigest, workspaceDigest: suite.value.workspaceDigest,
      checks: suite.value.checks.map(({ checkId }) => ({
        checkId, scope: "wave",
        outcome: { kind: "observed", exitCode: 0, timedOut: false, signal: null, report: { kind: "not-required" } },
      })),
      ...(owner === null ? {} : { ownerVerification: { kind: "verified", obligationsDigest: owner.obligationsDigest, boundMs: 0, verdicts: [] } }),
    }, emptyAcceptanceExpectation(1));
    if (evaluation.kind !== "accepted") throw new Error(`receipt fixture rejected: ${JSON.stringify(evaluation)}`);
    return evaluation.receipt;
  }

  /** The stamp's own authority for Wave 1: no Task, so nothing owed, yet the check is present. */
  const stampAuthority: OwnerCheckAuthority = { obligationsDigest: obligationsDigest([VERIFIED]), owed: [] };

  const suiteGraph = (receipt: AcceptedWaveCompletionReceipt, stamp?: readonly OwnerObligation[]) => graph({
    current_wave: 1,
    verification_manifest: MANIFEST,
    active_wave_gate: ACTIVE,
    active_wave_completion_suite: receipt,
    ...(stamp === undefined ? {} : { owner_obligations: stamp }),
  });

  it("loads a receipt whose roster the stamp authorizes, with or without the stamp", () => {
    expect(parseTaskGraph(viaDisk(suiteGraph(receiptUnder(stampAuthority), [VERIFIED]))).ok).toBe(true);
    expect(parseTaskGraph(viaDisk(suiteGraph(receiptUnder(null)))).ok).toBe(true);
  });

  it.each([
    ["a receipt missing loom:owner-verification under a stamp", () => suiteGraph(receiptUnder(null), [VERIFIED])],
    ["a receipt carrying loom:owner-verification without a stamp", () => suiteGraph(receiptUnder(stampAuthority))],
    ["a receipt bound to another stamp's digest", () => suiteGraph(receiptUnder({ ...stampAuthority, obligationsDigest: obligationsDigest([EXEMPT]) }), [VERIFIED])],
  ])("refuses %s", (_case, build) => {
    const parsed = parseTaskGraph(viaDisk(build()));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("active_wave_completion_suite.suiteDigest does not match verification_manifest authority");
  });
});
