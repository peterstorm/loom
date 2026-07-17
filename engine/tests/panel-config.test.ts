import { describe, it, expect } from "vitest";
import {
  ARCH_PANEL_AGENTS,
  PANEL_DESIGNERS_DEFAULT,
  PHASE_AGENT_MAP,
  KNOWN_AGENTS,
} from "../src/config";

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

describe("PANEL_DESIGNERS_DEFAULT", () => {
  it("is a small positive integer", () => {
    expect(Number.isInteger(PANEL_DESIGNERS_DEFAULT)).toBe(true);
    expect(PANEL_DESIGNERS_DEFAULT).toBeGreaterThanOrEqual(2);
    expect(PANEL_DESIGNERS_DEFAULT).toBeLessThanOrEqual(5);
  });
});
