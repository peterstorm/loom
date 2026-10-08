import { describe, expect, it } from "vitest";
import type { ExactRoster } from "../../src/core/orchestration-contract";
import type { ArchitecturePanelAuthority, RefutationPanelAuthority } from "../../src/core/panel-authority";
import {
  canonicalPanelStateJson,
  type PanelAuthorityRosterField,
  type PanelAuthorityRosterFields,
} from "../../src/core/persistent-panel";

/** Compile-time equality: `true` only when `A` and `B` are the same type. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assertType = <T extends true>(): T => true as T;

/** An authority shape with a roster that may be absent: still a roster field. */
type OptionalRosterAuthority = Readonly<{ runId: string; primary: ExactRoster; fallback?: ExactRoster | null }>;

describe("panel authority roster fields are derived from the authority type", () => {
  it("names exactly the roster-valued fields of each authority", () => {
    assertType<Equals<PanelAuthorityRosterField<ArchitecturePanelAuthority>, "candidateRoster" | "judgeRoster">>();
    assertType<Equals<PanelAuthorityRosterField<RefutationPanelAuthority>, "verifierRoster">>();
    assertType<Equals<PanelAuthorityRosterField<OptionalRosterAuthority>, "primary" | "fallback">>();
  });

  it("refuses a roster field left out, a non-roster field named, or an authority left unnamed", () => {
    // @ts-expect-error a roster field of the authority is missing from the set.
    const missing: PanelAuthorityRosterFields<ArchitecturePanelAuthority> = { candidateRoster: true };
    // @ts-expect-error a non-roster field cannot be canonicalized as a roster.
    const foreign: PanelAuthorityRosterFields<RefutationPanelAuthority> = { verifierRoster: true, findings: true };
    // @ts-expect-error an optional roster is still a roster field.
    const optional: PanelAuthorityRosterFields<OptionalRosterAuthority> = { primary: true };
    // @ts-expect-error omitting the Authority type argument leaves a parameter no value satisfies.
    const unnamed = canonicalPanelStateJson({ verifierRoster: true });
    // @ts-expect-error naming `never` is the omission spelled out, refused the same way.
    const nothing = canonicalPanelStateJson<never>({ verifierRoster: true });
    // @ts-expect-error an authority with no roster field has no roster set to name.
    const rosterless = canonicalPanelStateJson<Readonly<{ runId: string }>>({ runId: true });
    void [missing, foreign, optional, unnamed, nothing, rosterless];
  });
});

describe("canonicalPanelStateJson", () => {
  const canonical = canonicalPanelStateJson<OptionalRosterAuthority>({ primary: true, fallback: true });
  const canonicalRoster = { runId: "run", program: "refutation-panel", orderedSlots: [{ slotId: "s1" }] };
  const roster = (byId: unknown) => ({ ...canonicalRoster, byId });

  it("drops the derived view of every named roster, whichever way it serialized, and keeps key order", () => {
    const state = (byId: unknown) => ({ stage: "done", authority: { runId: "run", primary: roster(byId), fallback: roster(byId) }, slots: [] });
    const expected = { stage: "done", authority: { runId: "run", primary: canonicalRoster, fallback: canonicalRoster }, slots: [] };
    for (const byId of [{}, { size: 1 }]) {
      const result = canonical(state(byId));
      expect(result).toEqual(expected);
      expect(JSON.stringify(result)).toBe(JSON.stringify(expected));
    }
  });

  it("leaves every unnamed field untouched, even one shaped like a roster", () => {
    const state = { authority: { runId: "run", primary: roster({}), unnamed: roster({ size: 1 }) }, byId: { size: 1 } };
    const result = canonical(state) as { authority: Record<string, unknown>; byId: unknown };
    expect(result.authority["unnamed"]).toEqual(roster({ size: 1 }));
    expect(result.byId).toEqual({ size: 1 });
    expect(result.authority["primary"]).not.toHaveProperty("byId");
  });

  it("passes a non-record state or authority through unchanged", () => {
    for (const state of [null, 7, "state", [1, 2], { authority: null }, { authority: [roster({})] }]) {
      expect(canonical(state)).toBe(state);
    }
  });
});
