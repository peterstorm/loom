/**
 * T7 / AD-2: the State File wire proves `owner_obligations` before any reader
 * selects from it. Each obligation is an exact record; an exemption needs a
 * non-blank reason; an absent field stays absent, so a graph populated before
 * owner verification loads and owes nothing (FR-004).
 */

import { describe, expect, it } from "vitest";
import { parseTaskGraph } from "../src/state-file-wire";
import { ownerCheckAuthority, ownerVerificationOwed } from "../src/core/owner-verification/obligations";
import type { OwnerObligation, TaskGraph } from "../src/types";

const VERIFIED: OwnerObligation = {
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
};

const EXEMPT: OwnerObligation = {
  invariant: "INV-2",
  title: "Generated owner",
  statement: null,
  owner: "src/generated.ts",
  siblings: [],
  matrixTest: "tests/generated.matrix.test.ts",
  mutation: { kind: "exempt", reason: "owner is generated from a schema" },
};

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
    expect(ownerVerificationOwed(parsed.value, 1)).toEqual([]);
    expect(ownerCheckAuthority(parsed.value, 1)).toBeNull();
  });

  it("round-trips an empty stamp as present and empty", () => {
    const parsed = parseTaskGraph(viaDisk(graph({ owner_obligations: [] })));
    expect(parsed.ok && parsed.value.owner_obligations).toEqual([]);
    if (!parsed.ok) return;
    expect(ownerCheckAuthority(parsed.value, 1)).not.toBeNull();
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

  it("refuses blank or non-string paths and names", () => {
    for (const field of ["invariant", "title", "owner", "matrixTest"] as const) {
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
