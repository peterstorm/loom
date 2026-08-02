import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import {
  ARCH_PANEL_AGENTS,
  ARCH_PANEL_PHASE,
  PANEL_DESIGNERS_DEFAULT,
  PANEL_DESIGNERS_MIN,
  PANEL_JUDGES_DEFAULT,
  PANEL_LENS_COUNT,
  clampPanelDesigners,
  PHASE_AGENT_MAP,
  KNOWN_AGENTS,
  panelPhaseOverlap,
  assertPanelPhaseDisjoint,
  panelExecuteOverlap,
  assertPanelExecuteDisjoint,
} from "../src/config";
import { PANEL_LENSES } from "../src/core/panel-contract";

/** Count the lens sections in panel-lenses.md — the single source of truth for
 *  how many lenses exist (and therefore the cap on parallel designers). Each
 *  lens has one `## <lens-slug>` heading (lowercase, hyphenated). Matching the
 *  slug shape — not every `## ` H2 — keeps a future prose heading like
 *  `## Notes` or `## Selection` from silently inflating the count and raising
 *  the designer cap above the real number of lenses. Deriving from the file
 *  means adding or removing a lens automatically re-checks the cap below. */
function lensNames(): string[] {
  return readRepoFile("references", "panel-lenses.md")
    .match(/^## ([a-z][a-z0-9-]*)$/gm)
    ?.map((heading) => heading.slice("## ".length)) ?? [];
}

function lensCount(): number {
  return lensNames().length;
}

/** Read a repo file by path segments relative to the repo root (two levels up
 *  from engine/tests). Shared by the prose-drift tests below so config↔markdown
 *  contracts are pinned in CI rather than left to silent divergence. */
function readRepoFile(...segments: string[]): string {
  return readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", ...segments),
    "utf-8",
  );
}

/**
 * Architecture-panel config invariants (`/loom --panel`).
 *
 * The whole panel design rests on two structural facts, encoded here as tests
 * rather than comments so a future edit that breaks them fails CI:
 *
 *  1. Panel agents are DISJOINT from PHASE_AGENT_MAP. advance-phase keys off
 *     PHASE_AGENT_MAP at SubagentStop (advance-phase.ts:133) — if a designer or
 *     judge were mapped there, its completion would fire resolveTransition and
 *     the date-prefix plan fallback could advance the phase mid-panel (design
 *     constraint 2). Only architecture-agent (already in the map) advances.
 *
 *  2. Panel agents are NOT in KNOWN_AGENTS. That set gates task-graph agents;
 *     panel agents never appear in a task graph.
 */
describe("ARCH_PANEL_AGENTS invariants", () => {
  it("holds the three panel agent roles", () => {
    expect(ARCH_PANEL_AGENTS).toEqual(
      new Set(["arch-interviewer-agent", "arch-designer-agent", "arch-judge-agent"]),
    );
  });

  it("is disjoint from PHASE_AGENT_MAP keys (advance-phase must ignore panel agents)", () => {
    const phaseAgents = new Set(Object.keys(PHASE_AGENT_MAP));
    const overlap = [...ARCH_PANEL_AGENTS].filter((a) => phaseAgents.has(a));
    expect(overlap).toEqual([]);
  });

  it("keeps every panel agent out of PHASE_AGENT_MAP (undefined lookup ⇒ handler passthrough)", () => {
    // This is the exact lookup advance-phase performs. undefined ⇒ passthrough
    // BEFORE resolveTransition, so a stale same-date plan file can never advance
    // the phase on a panel agent's completion.
    for (const agent of ARCH_PANEL_AGENTS) {
      expect(PHASE_AGENT_MAP[agent]).toBeUndefined();
    }
  });

  it("keeps panel agents out of KNOWN_AGENTS (never in a task graph)", () => {
    for (const agent of ARCH_PANEL_AGENTS) {
      expect(KNOWN_AGENTS.has(agent)).toBe(false);
    }
  });
});

describe("panelPhaseOverlap (module-load invariant guard)", () => {
  it("reports no overlap for the real config (guard would have thrown at import otherwise)", () => {
    expect(panelPhaseOverlap()).toEqual([]);
  });

  it("detects a synthetic overlap — proving the guard is live, not tautological", () => {
    // If a panel agent were ever added to PHASE_AGENT_MAP, the guard must catch
    // it. Feed a synthetic phase map that violates the invariant.
    const bad = { "arch-designer-agent": "architecture" as const };
    expect(panelPhaseOverlap(ARCH_PANEL_AGENTS, bad)).toEqual(["arch-designer-agent"]);
  });

  it("detects a DE-SUFFIXED collision — a phase agent named without the -agent suffix", () => {
    // detectPhase probes PHASE_AGENT_MAP with the bare form too, so a phase agent
    // named "arch-designer" (no suffix) would capture the bare panel invocation
    // via detectPhase's FIRST probe and route it to a non-architecture phase. The
    // guard must flag it even though the exact stored key "arch-designer-agent"
    // is absent from the map — this is the case the exact-key check missed.
    const bad = { "arch-designer": "decompose" as const };
    expect(panelPhaseOverlap(ARCH_PANEL_AGENTS, bad)).toEqual(["arch-designer-agent"]);
  });

  it("detects a DOUBLY-SUFFIXED collision — detectPhase's third probe (agent + \"-agent\")", () => {
    // phaseLookupKeys returns [bare, name, name + "-agent"]. detectPhase probes
    // PHASE_AGENT_MAP[agent + "-agent"] too, so a phase agent stored under the
    // doubly-suffixed key "arch-designer-agent-agent" would capture the suffixed
    // panel invocation ("arch-designer-agent") via that third probe. The guard
    // must flag it even though neither the bare form ("arch-designer") nor the
    // exact stored key ("arch-designer-agent") is present in the map — this closes
    // the last of the three probed key shapes.
    const bad = { "arch-designer-agent-agent": "decompose" as const };
    expect(panelPhaseOverlap(ARCH_PANEL_AGENTS, bad)).toEqual(["arch-designer-agent"]);
  });

  it("handles a panel agent name WITHOUT the -agent suffix (phaseLookupKeys else branch)", () => {
    // Every REAL panel agent ends in "-agent", so the `bare === panelAgent` else
    // branch of phaseLookupKeys (config.ts) is never exercised by the real config.
    // A synthetic bare panel name "arch-designer" probes keys
    // [arch-designer, arch-designer, arch-designer-agent] — a phase map keyed by
    // the suffixed form must still be flagged via the third probe, and a disjoint
    // map must produce no false positive.
    const panel = new Set(["arch-designer"]);
    expect(
      panelPhaseOverlap(panel, { "arch-designer-agent": "decompose" as const }),
    ).toEqual(["arch-designer"]);
    expect(
      panelPhaseOverlap(panel, { "unrelated-agent": "decompose" as const }),
    ).toEqual([]);
  });

  it("assertPanelPhaseDisjoint THROWS on a synthetic overlap — the load-time guard's throw branch, not just the predicate", () => {
    // panelPhaseOverlap returning a non-empty list proves detection; this proves
    // the guard HALTS on it. Without this, a regression that dropped the `throw`
    // (leaving only the predicate) would keep every test green while letting an
    // invalid config load and advance the phase mid-panel.
    const bad = { "arch-designer-agent": "architecture" as const };
    expect(() => assertPanelPhaseDisjoint(ARCH_PANEL_AGENTS, bad)).toThrow(
      /panel agents must not be phase agents/,
    );
  });

  it("assertPanelPhaseDisjoint does NOT throw for the real config (the module loaded, so this must hold)", () => {
    expect(() => assertPanelPhaseDisjoint()).not.toThrow();
  });
});

describe("panelExecuteOverlap (module-load guard for detectPhase's check ordering)", () => {
  // detectPhase (validate-phase-order.ts:51) classifies IMPL/REVIEW agents as
  // "execute" — and utility agents are passed through elsewhere — BEFORE the
  // panel branch (line 57). A panel agent colliding with one of those sets would
  // be misrouted away from architecture classification, and because it is absent
  // from PHASE_AGENT_MAP, assertPanelPhaseDisjoint (which only inspects the phase
  // map) cannot catch it. This guard closes that gap.
  it("reports no overlap for the real config (guard would have thrown at import otherwise)", () => {
    expect(panelExecuteOverlap()).toEqual([]);
  });

  it("detects a synthetic IMPL/REVIEW collision — proving the guard is live, not tautological", () => {
    // A reserved set containing a panel agent's exact name must be flagged: this
    // is the misroute-to-execute hazard the guard exists to prevent.
    const reserved = new Set(["arch-designer-agent", "code-implementer-agent"]);
    expect(panelExecuteOverlap(ARCH_PANEL_AGENTS, reserved)).toEqual(["arch-designer-agent"]);
  });

  it("detects a DE-SUFFIXED collision — detectPhase probes the bare form too (IMPL_AGENTS.has(agent))", () => {
    // detectPhase checks IMPL_AGENTS.has(agent) with the bare invocation, so a
    // reserved agent named "arch-designer" (no suffix) would capture the bare
    // panel invocation. phaseLookupKeys covers this via its first probe, so the
    // guard must flag it even though the exact stored key is absent.
    const reserved = new Set(["arch-designer"]);
    expect(panelExecuteOverlap(ARCH_PANEL_AGENTS, reserved)).toEqual(["arch-designer-agent"]);
  });

  it("detects a SUFFIXED collision — detectPhase probes IMPL_AGENTS.has(agent + \"-agent\")", () => {
    // The suffixed probe means a reserved key "arch-designer-agent-agent" would
    // capture the suffixed panel invocation. Third phaseLookupKeys probe.
    const reserved = new Set(["arch-designer-agent-agent"]);
    expect(panelExecuteOverlap(ARCH_PANEL_AGENTS, reserved)).toEqual(["arch-designer-agent"]);
  });

  it("assertPanelExecuteDisjoint THROWS on a synthetic overlap — the load-time guard's throw branch", () => {
    // Predicate detection is not enough; this proves the guard HALTS. A regression
    // dropping the `throw` (keeping only the predicate) would otherwise stay green
    // while letting a misroutable config load.
    const reserved = new Set(["arch-designer-agent"]);
    expect(() => assertPanelExecuteDisjoint(ARCH_PANEL_AGENTS, reserved)).toThrow(
      /panel agents must not also be execute-phase or utility agents/,
    );
  });

  it("assertPanelExecuteDisjoint does NOT throw for the real config (the module loaded, so this must hold)", () => {
    expect(() => assertPanelExecuteDisjoint()).not.toThrow();
  });
});

describe("ARCH_PANEL_PHASE (derived, not a literal)", () => {
  it("is the single phase every panel agent is classified as", () => {
    // Derived from the panel entries' shared `phase` in ARCHITECTURE_AGENTS
    // (derivePanelPhase), so it cannot drift from the set. The module loading at
    // all proves the derivation found exactly one shared phase — a divergent
    // panel-agent phase would throw at import before any test runs.
    expect(ARCH_PANEL_PHASE).toBe("architecture");
  });

  it("is a phase panel agents are allowed in but that does NOT advance on their completion", () => {
    // The classification phase must NOT be one whose key set includes a panel
    // agent (else advance-phase would fire) — panel agents are absent from
    // PHASE_AGENT_MAP by construction, and this phase is where detectPhase routes
    // them for the ALLOW decision only.
    for (const agent of ARCH_PANEL_AGENTS) {
      expect(PHASE_AGENT_MAP[agent]).toBeUndefined();
    }
  });
});

describe("PANEL_DESIGNERS_DEFAULT", () => {
  it("is a small positive integer", () => {
    expect(Number.isInteger(PANEL_DESIGNERS_DEFAULT)).toBe(true);
    expect(PANEL_DESIGNERS_DEFAULT).toBeGreaterThanOrEqual(2);
  });

  it("does not exceed the number of lenses (each designer takes exactly one)", () => {
    // The cap is the lens count, not a magic 5. Derived from panel-lenses.md so
    // adding/removing a lens keeps the default honest — a designer can never be
    // asked to take a lens that does not exist, and no two share a lens.
    const lenses = lensCount();
    expect(lenses).toBeGreaterThan(0);
    expect(PANEL_DESIGNERS_DEFAULT).toBeLessThanOrEqual(lenses);
  });
});

describe("PANEL_JUDGES_DEFAULT", () => {
  it("is a small positive integer", () => {
    expect(Number.isInteger(PANEL_JUDGES_DEFAULT)).toBe(true);
    expect(PANEL_JUDGES_DEFAULT).toBeGreaterThanOrEqual(1);
  });

  it("is fixed at 3 — one judge per criterion (primary axis, testability, fit+effort)", () => {
    // K is bound to the three criteria `deriveJudgeCriteria` returns, not a
    // user-tunable knob. Pinning it here fails CI if the count drifts; the
    // arity is asserted directly against the function in panel-contract.test.ts.
    expect(PANEL_JUDGES_DEFAULT).toBe(3);
  });
});

describe("PANEL_LENS_COUNT", () => {
  it("keeps the typed manifest lens vocabulary aligned with panel-lenses.md", () => {
    expect([...PANEL_LENSES]).toEqual(lensNames());
  });

  it("equals the number of lens headings in references/panel-lenses.md", () => {
    // The constant is the runtime source of truth for the designer cap; this test
    // is the inverse of the lensCount() derivation — it asserts the constant still
    // matches the markdown, so adding/removing a lens without updating the constant
    // (or vice versa) fails CI.
    expect(PANEL_LENS_COUNT).toBe(lensCount());
  });

  it("is at least the default designer count (the default must fit under the cap)", () => {
    expect(PANEL_LENS_COUNT).toBeGreaterThanOrEqual(PANEL_DESIGNERS_DEFAULT);
  });
});

describe("clampPanelDesigners", () => {
  it("passes through viable in-range integers unchanged", () => {
    expect(clampPanelDesigners(PANEL_DESIGNERS_MIN)).toBe(PANEL_DESIGNERS_MIN);
    expect(clampPanelDesigners(3)).toBe(3);
    expect(clampPanelDesigners(PANEL_LENS_COUNT)).toBe(PANEL_LENS_COUNT);
  });

  it("clamps below the approach-gate minimum up to two", () => {
    expect(PANEL_DESIGNERS_MIN).toBe(2);
    expect(clampPanelDesigners(1)).toBe(PANEL_DESIGNERS_MIN);
    expect(clampPanelDesigners(0)).toBe(PANEL_DESIGNERS_MIN);
    expect(clampPanelDesigners(-4)).toBe(PANEL_DESIGNERS_MIN);
  });

  it("clamps above the lens count down to the cap", () => {
    expect(clampPanelDesigners(PANEL_LENS_COUNT + 1)).toBe(PANEL_LENS_COUNT);
    expect(clampPanelDesigners(99)).toBe(PANEL_LENS_COUNT);
  });

  it("floors fractional programmatic input before clamping", () => {
    expect(clampPanelDesigners(2.9)).toBe(2);
    expect(clampPanelDesigners(0.4)).toBe(PANEL_DESIGNERS_MIN);
  });

  it("falls back to the default for non-finite input", () => {
    expect(clampPanelDesigners(Number.NaN)).toBe(PANEL_DESIGNERS_DEFAULT);
    expect(clampPanelDesigners(Number.POSITIVE_INFINITY)).toBe(PANEL_DESIGNERS_DEFAULT);
    expect(clampPanelDesigners(Number.NEGATIVE_INFINITY)).toBe(PANEL_DESIGNERS_DEFAULT);
  });

  it("property: every finite input maps into [PANEL_DESIGNERS_MIN, PANEL_LENS_COUNT]", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 1000 }), (n) => {
        const out = clampPanelDesigners(n);
        return out >= PANEL_DESIGNERS_MIN && out <= PANEL_LENS_COUNT && Number.isInteger(out);
      }),
    );
  });

  it("property: viable values are returned unchanged", () => {
    fc.assert(
      fc.property(fc.integer({ min: PANEL_DESIGNERS_MIN, max: PANEL_LENS_COUNT }), (n) => {
        return clampPanelDesigners(n) === n;
      }),
    );
  });
});

describe("runtime immutability of derived config", () => {
  // The doc comments on PHASE_AGENT_MAP and frozenSet promise post-load mutation
  // is impossible so a panel agent can never be smuggled into the phase map at
  // runtime. Pin those promises here — a refactor dropping Object.freeze or the
  // frozenSet mutator-shadowing would otherwise pass every other test.
  it("PHASE_AGENT_MAP is frozen", () => {
    expect(Object.isFrozen(PHASE_AGENT_MAP)).toBe(true);
  });

  it("ARCH_PANEL_AGENTS throws on add/delete/clear (frozenSet mutators shadowed)", () => {
    // Object.freeze alone does NOT stop set.add — a Set's elements live in an
    // internal slot. frozenSet shadows the mutators so these throw; without the
    // shadowing they would silently succeed and mutate the "immutable" set.
    const mutable = ARCH_PANEL_AGENTS as Set<string>;
    expect(() => mutable.add("smuggled-phase-agent")).toThrow(/immutable/);
    expect(() => mutable.delete("arch-designer-agent")).toThrow(/immutable/);
    expect(() => mutable.clear()).toThrow(/immutable/);
    // And the set is genuinely unchanged after the failed mutations.
    expect(ARCH_PANEL_AGENTS.has("smuggled-phase-agent")).toBe(false);
    expect(ARCH_PANEL_AGENTS.has("arch-designer-agent")).toBe(true);
  });
});

describe("commands/loom.md prose literals track the config constants", () => {
  // loom.md hardcodes the lens cap and judge/designer counts as prose literals so
  // the orchestrator reads a concrete number. panel-config pins those constants
  // against panel-lenses.md, but nothing pins the loom.md prose against the
  // constants — so a count change (or a bumped lens) leaves the prose silently
  // stale. Each case asserts the regex still matches (fails loud if the prose is
  // reworded past recognition) AND that the captured literal equals the constant.
  const loomMd = readRepoFile("commands", "loom.md");
  const cases: ReadonlyArray<{ label: string; re: RegExp; expected: number }> = [
    { label: "options: distinct lenses cap", re: /distinct lenses \((\d+)\)/, expected: PANEL_LENS_COUNT },
    { label: "Defaults: minimum count", re: /PANEL_DESIGNERS_MIN` \(currently (\d+)\)/, expected: PANEL_DESIGNERS_MIN },
    { label: "Defaults: maximum lens count", re: /PANEL_LENS_COUNT` \(currently (\d+)\)/, expected: PANEL_LENS_COUNT },
    { label: "Defaults: designer count", re: /PANEL_DESIGNERS_DEFAULT` \(currently (\d+)\)/, expected: PANEL_DESIGNERS_DEFAULT },
    { label: "Defaults: judge count", re: /PANEL_JUDGES_DEFAULT` judges\*\* \(currently (\d+)/, expected: PANEL_JUDGES_DEFAULT },
  ];

  for (const { label, re, expected } of cases) {
    it(`${label} literal equals ${expected}`, () => {
      const match = loomMd.match(re);
      expect(match, `loom.md prose no longer matches ${re} — reworded? re-pin this test`).not.toBeNull();
      expect(Number(match![1])).toBe(expected);
    });
  }
});

describe("interview digest-label contract (producer ↔ runbook)", () => {
  // arch-interviewer-agent.md writes these labels and the typed panel-contract
  // parser validates them before loom.md selects lenses. Pin their documentation
  // in both producer and runbook; parser behavior has direct unit coverage.
  const labels = [
    "**Primary axis:**",
    "**Testability bar:**",
    "**Sensitive boundaries:**",
    "**Codebase maturity:**",
    "**Codebase constraints:**",
    "**Error-handling philosophy:**",
    "**Concurrency & state:**",
    "**Data & persistence:**",
    "**Tech preferences:**",
    "**Observability:**",
    "**Backwards compatibility:**",
    "**Deployment:**",
    "**Out-of-scope:**",
    "**Executable-model signal:**",
  ] as const;
  const interviewer = readRepoFile("agents", "arch-interviewer-agent.md");
  const interviewTemplate = readRepoFile("commands", "templates", "phase-arch-interview.md");
  const parser = readRepoFile("engine", "src", "core", "panel-contract.ts");

  for (const label of labels) {
    it(`${label} appears in agent, template, and typed parser`, () => {
      expect(interviewer, `arch-interviewer-agent.md no longer writes ${label}`).toContain(label);
      expect(interviewTemplate, `phase-arch-interview.md no longer requests ${label}`).toContain(label);
      expect(parser, `panel-contract.ts no longer parses ${label}`).toContain(label);
    });
  }
});
