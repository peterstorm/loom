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
  PHASE_AGENT_MAP,
  KNOWN_AGENTS,
  IMPL_AGENTS,
  UTILITY_AGENTS,
  REVIEW_SUB_AGENTS,
  REVIEW_AGENTS,
  EXECUTE_AGENTS,
  READ_ONLY_STATE_COMMANDS,
  panelPhaseOverlap,
  assertPanelPhaseDisjoint,
  panelExecuteOverlap,
  assertPanelExecuteDisjoint,
} from "../src/config";
import {
  PANEL_BASELINE_LENSES,
  PANEL_LENSES,
  parseInterviewDigest,
  selectPanelLenses,
} from "../src/core/panel-contract";

/** A digest that fires no lens signal, so the designer count alone decides the
 *  selected set — the variable under test here. */
const PANEL_DIGEST = [
  "**Primary axis:** simplicity",
  "**Testability bar:** pure functional core",
  "**Sensitive boundaries:** none",
  "**Codebase maturity:** greenfield",
  "**Codebase constraints:** none",
  "**Error-handling philosophy:** Either/Result end-to-end",
  "**Concurrency & state:** stateless and synchronous",
  "**Data & persistence:** reuse existing files",
  "**Tech preferences:** TypeScript",
  "**Observability:** structured errors",
  "**Backwards compatibility:** preserve current commands",
  "**Deployment:** no change",
  "**Out-of-scope:** nothing",
  "**Executable-model signal:** none",
].join("\n");

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
 *     PHASE_AGENT_MAP at SubagentStop — if a designer or
 *     judge were mapped there, its completion would fire resolveTransition and
 *     the date-prefix plan fallback could advance the phase mid-panel (design
 *     constraint 2). Only architecture-agent (already in the map) advances.
 *
 *  2. Panel agents are NOT in KNOWN_AGENTS. That set gates task-graph agents;
 *     panel agents never appear in a task graph.
 */
describe("exported agent-policy sets are immutable", () => {
  it.each([
    ["IMPL_AGENTS", IMPL_AGENTS],
    ["KNOWN_AGENTS", KNOWN_AGENTS],
    ["UTILITY_AGENTS", UTILITY_AGENTS],
    ["REVIEW_SUB_AGENTS", REVIEW_SUB_AGENTS],
    ["REVIEW_AGENTS", REVIEW_AGENTS],
    ["EXECUTE_AGENTS", EXECUTE_AGENTS],
  ] as const)("blocks ordinary mutation of %s", (_name, policy) => {
    const before = [...policy];
    expect(() => (policy as Set<string>).add("injected-agent")).toThrow(/immutable/);
    expect(() => (policy as Set<string>).delete(before[0] ?? "missing")).toThrow(/immutable/);
    expect(() => (policy as Set<string>).clear()).toThrow(/immutable/);
    expect([...policy]).toEqual(before);
  });
});

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

describe("ARCH_PANEL_PHASE (intentional singleton policy)", () => {
  it("is the single phase every panel agent is classified as", () => {
    // Panel roles deliberately carry no per-agent phase. One typed constant is
    // the policy source used by phase-order validation, so no panel declaration
    // can encode a conflicting phase for a retired derivation to reconcile.
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

// The designer bounds used to be pinned against `clampPanelDesigners`, an
// exported function no engine code path called. These pin the rule that is
// actually enforced — `selectLenses`' range check inside `selectPanelLenses`,
// which REJECTS rather than clamps — so the constants above cannot drift from
// the behaviour they describe.
describe("designer-count bounds (the enforced rule, not a parallel clamp)", () => {
  const digest = parseInterviewDigest(PANEL_DIGEST);
  if (!digest.ok) throw new Error(`fixture digest must parse: ${digest.errors.join("; ")}`);

  it("accepts every count from the approach-gate minimum to the lens cap", () => {
    for (let n = PANEL_DESIGNERS_MIN; n <= PANEL_LENS_COUNT; n++) {
      const selected = selectPanelLenses(digest.value, n);
      expect(selected.ok).toBe(true);
      if (selected.ok) expect(selected.value).toHaveLength(n);
    }
  });

  it("REJECTS a count below the approach-gate minimum — a one-designer panel has nothing to choose between", () => {
    for (const n of [1, 0, -4]) {
      const selected = selectPanelLenses(digest.value, n);
      expect(selected.ok).toBe(false);
      if (!selected.ok) {
        expect(selected.errors.join(" ")).toContain(
          `designer count must be an integer from ${PANEL_DESIGNERS_MIN} to ${PANEL_LENS_COUNT}`,
        );
      }
    }
  });

  it("REJECTS a count above the lens cap — two designers cannot share one lens", () => {
    for (const n of [PANEL_LENS_COUNT + 1, 99]) {
      expect(selectPanelLenses(digest.value, n).ok).toBe(false);
    }
  });

  it("REJECTS fractional and non-finite counts rather than flooring them", () => {
    for (const n of [2.9, 0.4, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(selectPanelLenses(digest.value, n).ok).toBe(false);
    }
  });

  it("property: exactly the integers in [MIN, CAP] are accepted, and each yields that many lenses", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 1000 }), (n) => {
        const viable = n >= PANEL_DESIGNERS_MIN && n <= PANEL_LENS_COUNT;
        const selected = selectPanelLenses(digest.value, n);
        if (selected.ok !== viable) return false;
        return !selected.ok || selected.value.length === n;
      }),
    );
  });

  it("derives the bounds from the lens tables rather than restating them", () => {
    expect(PANEL_DESIGNERS_MIN).toBe(PANEL_BASELINE_LENSES.length);
    expect(PANEL_LENS_COUNT).toBe(PANEL_LENSES.length);
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

  it.each([
    ["ARCH_PANEL_AGENTS", ARCH_PANEL_AGENTS, "arch-designer-agent"],
    ["READ_ONLY_STATE_COMMANDS", READ_ONLY_STATE_COMMANDS, "cat"],
  ] as const)("%s throws on add/delete/clear (frozenSet mutators shadowed)", (_name, readonlySet, retained) => {
    // Object.freeze alone does NOT stop set.add — a Set's elements live in an
    // internal slot. frozenSet shadows the mutators so these throw; without the
    // shadowing they would silently mutate a security-relevant allowlist.
    const mutable = readonlySet as Set<string>;
    expect(() => mutable.add("smuggled-entry")).toThrow(/immutable/);
    expect(() => mutable.delete(retained)).toThrow(/immutable/);
    expect(() => mutable.clear()).toThrow(/immutable/);
    expect(readonlySet.has("smuggled-entry")).toBe(false);
    expect(readonlySet.has(retained)).toBe(true);
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
