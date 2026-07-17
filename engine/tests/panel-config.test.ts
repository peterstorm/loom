import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARCH_PANEL_AGENTS,
  PANEL_DESIGNERS_DEFAULT,
  PHASE_AGENT_MAP,
  KNOWN_AGENTS,
  panelPhaseOverlap,
  assertPanelPhaseDisjoint,
} from "../src/config";

/** Count the lens sections in panel-lenses.md — the single source of truth for
 *  how many lenses exist (and therefore the cap on parallel designers). Each
 *  lens has one `## <lens-slug>` heading (lowercase, hyphenated). Matching the
 *  slug shape — not every `## ` H2 — keeps a future prose heading like
 *  `## Notes` or `## Selection` from silently inflating the count and raising
 *  the designer cap above the real number of lenses. Deriving from the file
 *  means adding or removing a lens automatically re-checks the cap below. */
function lensCount(): number {
  const path = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "references",
    "panel-lenses.md",
  );
  const md = readFileSync(path, "utf-8");
  return (md.match(/^## [a-z][a-z0-9-]*$/gm) ?? []).length;
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
