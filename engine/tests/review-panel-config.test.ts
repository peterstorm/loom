import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARCH_PANEL_AGENTS,
  IMPL_AGENTS,
  PHASE_AGENT_MAP,
  REVIEW_AGENTS,
  REVIEW_SUB_AGENTS,
  REVIEW_PANEL_AGENTS,
  UTILITY_AGENTS,
  assertReviewPanelDisjoint,
  reviewPanelOverlap,
} from "../src/config";
import { categorize } from "../src/handlers/subagent-stop/dispatch";
import { VALIDATED_AGENTS } from "../src/handlers/pre-tool-use/validate-agent-skill";
import { KNOWN_HANDLERS } from "../src/handler-routes";
import {
  defaultRefutationThreshold,
  REVIEW_LENSES,
  REVIEW_LENSES_DEFAULT,
  REVIEW_LENSES_MIN,
} from "../src/core/review-panel";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("REVIEW_PANEL_AGENTS invariants", () => {
  it("is non-empty and frozen against runtime mutation", () => {
    expect(REVIEW_PANEL_AGENTS.size).toBeGreaterThan(0);
    expect(() => (REVIEW_PANEL_AGENTS as Set<string>).add("smuggled")).toThrow(/immutable/);
    expect(REVIEW_PANEL_AGENTS.has("smuggled")).toBe(false);
  });

  it("is deliberately NOT a review sub-agent — the whole point of the separate set", () => {
    // In REVIEW_SUB_AGENTS the verifier's transcript would route through
    // store-reviewer-findings, which would find no CRITICAL_COUNT and mark the
    // task evidence_capture_failed — a passing wave blocked by the agent that
    // was there to unblock it.
    for (const agent of REVIEW_PANEL_AGENTS) {
      expect(REVIEW_SUB_AGENTS.has(agent)).toBe(false);
      expect(REVIEW_AGENTS.has(agent)).toBe(false);
    }
  });

  it("is invisible to the SubagentStop dispatcher", () => {
    for (const agent of REVIEW_PANEL_AGENTS) {
      expect(categorize(agent)).toBe("unknown");
    }
  });

  it("does not overlap any other agent set", () => {
    expect(reviewPanelOverlap()).toEqual([]);
    for (const agent of REVIEW_PANEL_AGENTS) {
      expect(agent in PHASE_AGENT_MAP).toBe(false);
      expect(ARCH_PANEL_AGENTS.has(agent)).toBe(false);
      expect(IMPL_AGENTS.has(agent)).toBe(false);
      expect(UTILITY_AGENTS.has(agent)).toBe(false);
    }
  });

  it("reviewPanelOverlap catches a de-suffixed collision detectPhase would hit", () => {
    // detectPhase probes {bare, name, name + "-agent"}, so a reserved
    // `review-verifier` would capture `review-verifier-agent` through the bare
    // probe even though the exact names differ.
    const reserved = new Set(["review-verifier"]);
    expect(reviewPanelOverlap(REVIEW_PANEL_AGENTS, reserved)).toEqual(["review-verifier-agent"]);
  });

  it("assertReviewPanelDisjoint throws on a synthetic overlap and not on the real config", () => {
    expect(() => assertReviewPanelDisjoint(REVIEW_PANEL_AGENTS, new Set(["review-verifier-agent"])))
      .toThrow(/must not also be phase, architecture-panel, impl, review, or utility agents/);
    expect(() => assertReviewPanelDisjoint()).not.toThrow();
  });

  it("is covered by the agent-skill spawn gate", () => {
    for (const agent of REVIEW_PANEL_AGENTS) {
      expect(VALIDATED_AGENTS.has(agent)).toBe(true);
    }
  });
});

describe("review-panel helper route", () => {
  it("is registered so the CLI can dispatch to it", () => {
    expect(KNOWN_HANDLERS["helper"]!.has("review-panel")).toBe(true);
  });

  it("is NOT a whitelisted state-file helper — it never names a guarded path", () => {
    // tally writes state through StateManager, but its command line references
    // only the run directory, so it stays out of guard-state-file's scope. It
    // must not be allowlisted: that would let any Bash line mentioning both
    // "review-panel" and the state path through the guard.
    const config = readFileSync(join(REPO_ROOT, "engine", "src", "config.ts"), "utf-8");
    const whitelist = config.slice(
      config.indexOf("WHITELISTED_HELPERS"),
      config.indexOf("Subagent tracking directory"),
    );
    expect(whitelist).not.toContain("review-panel");
  });
});

describe("wave-gate.md prose tracks the review-panel contract", () => {
  const runbook = readFileSync(join(REPO_ROOT, "commands", "wave-gate.md"), "utf-8");

  it("documents every helper operation the handler implements", () => {
    for (const operation of ["brief", "manifest", "lenses", "verdict", "tally"]) {
      expect(runbook).toContain(`helper review-panel ${operation}`);
    }
  });

  it("spawns the agent the registry declares", () => {
    for (const agent of REVIEW_PANEL_AGENTS) {
      expect(runbook).toContain(agent);
    }
  });

  it("states the default panel size and the tie rule", () => {
    expect(runbook).toContain(`Default panel size is ${REVIEW_LENSES_DEFAULT}`);
    expect(runbook).toContain("Ties favor keeping the finding");
  });

  it("names the baseline lenses and both signal-driven ones", () => {
    for (const lens of REVIEW_LENSES) expect(runbook).toContain(lens);
  });

  it("quotes threshold values the formula actually produces", () => {
    // The one gap in this suite: the prose enumerates concrete pairs while
    // `defaultRefutationThreshold` computes floor(n/2)+1, and nothing bound the
    // two. Generated from the function rather than hardcoded, so changing the
    // formula fails here instead of silently making the runbook lie.
    for (const lensCount of [2, 3, 5]) {
      expect(runbook).toContain(`${defaultRefutationThreshold(lensCount)} of ${lensCount}`);
    }
  });

  it("states that a strict majority is the FLOOR, not merely the default", () => {
    // `--threshold` below the majority is now rejected by the handler; a runbook
    // that only calls it "the default" invites an orchestrator to lower it.
    expect(runbook).toMatch(/strict majority/);
    expect(runbook).toContain("--threshold");
  });
});

describe("review lens policy constants", () => {
  it("the minimum is the baseline lens count and the default sits in range", () => {
    expect(REVIEW_LENSES_MIN).toBe(2);
    expect(REVIEW_LENSES_DEFAULT).toBeGreaterThanOrEqual(REVIEW_LENSES_MIN);
    expect(REVIEW_LENSES_DEFAULT).toBeLessThanOrEqual(REVIEW_LENSES.length);
  });

  it("lens names are unique", () => {
    expect(new Set(REVIEW_LENSES).size).toBe(REVIEW_LENSES.length);
  });
});
