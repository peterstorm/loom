/**
 * Round-14 remediation: the prose surfaces `runbook-contract.test.ts` does not
 * reach.
 *
 * That file binds `commands/loom.md` and `commands/wave-gate.md` to their
 * handlers, in both directions, and is honest that it pins names/flags/order
 * rather than semantics. What it does NOT read at all is `README.md`,
 * `CONTEXT.md`, or the prompt templates — and between them those duplicate both
 * lens tables, the panel defaults, and the claim that the finalize ranking is
 * engine-computed. Every doc-drift finding this round came from exactly there.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PANEL_LENSES } from "../src/core/panel-contract";
import { REVIEW_LENSES, REVIEW_LENSES_DEFAULT } from "../src/core/review-panel";
import { PANEL_DESIGNERS_DEFAULT, PANEL_JUDGES_DEFAULT, PANEL_LENS_COUNT } from "../src/config";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf-8");

const README = read("README.md");
const CONTEXT = read("CONTEXT.md");

describe("README.md and CONTEXT.md name the engine's lens vocabularies", () => {
  const SURFACES = [
    ["README.md", README],
    ["CONTEXT.md", CONTEXT],
  ] as const;

  it.each(SURFACES)("%s names every design lens", (_name, prose) => {
    const missing = PANEL_LENSES.filter((lens) => !prose.includes(lens));
    expect(missing, `undocumented design lenses: ${missing.join(", ")}`).toEqual([]);
  });

  it.each(SURFACES)("%s names every refutation lens", (_name, prose) => {
    const missing = REVIEW_LENSES.filter((lens) => !prose.includes(lens));
    expect(missing, `undocumented refutation lenses: ${missing.join(", ")}`).toEqual([]);
  });

  it.each(SURFACES)("%s invents no lens the engine does not have", (_name, prose) => {
    // The inverse direction, which is the one that catches a RENAME: prose
    // keeping the old name reads as authoritative to anyone who trusts it.
    const known = new Set<string>([...PANEL_LENSES, ...REVIEW_LENSES]);
    const cited = [...prose.matchAll(/`([a-z]+(?:-[a-z]+)+)`/g)]
      .map((m) => m[1]!)
      .filter((token) => /-(first|fp|conventionist|radius|coverage)$/.test(token) || token === "test-coverage");
    const invented = [...new Set(cited)].filter((token) => !known.has(token));
    expect(invented, `names lenses the engine does not define: ${invented.join(", ")}`).toEqual([]);
  });
});

describe("README.md states the panel defaults the engine actually uses", () => {
  it("quotes the review panel's default size", () => {
    expect(README).toContain(`Default panel size is ${REVIEW_LENSES_DEFAULT}`);
  });

  it("quotes the architecture panel's designer, judge and lens counts", () => {
    // Bound by VALUE, not by the presence of a number: a constant changed in
    // config with the prose left alone is the whole failure mode.
    for (const [label, value] of [
      ["designers", PANEL_DESIGNERS_DEFAULT],
      ["judges", PANEL_JUDGES_DEFAULT],
      ["lenses", PANEL_LENS_COUNT],
    ] as const) {
      expect(
        new RegExp(`${value}\\s+${label}|${label}[^.\\n]{0,40}${value}`, "i").test(README),
        `README does not state ${value} ${label}`,
      ).toBe(true);
    }
  });
});

describe("the finalize template does not reclaim the ranking the engine computes", () => {
  const FINALIZE = read("commands", "templates", "phase-arch-finalize.md");

  it("tells the agent the ranking is authoritative and must not be recomputed", () => {
    // `aggregateVerdicts` exists BECAUSE this step used to be the one place in
    // the panel pipeline an LLM did arithmetic by hand. Nothing bound the
    // template's promise to the engine, so a regression to hand-ranking would be
    // caught only by someone reading the prompt.
    expect(FINALIZE).toContain("helper panel-contract aggregate");
    expect(FINALIZE).toMatch(/do not recompute it/i);
    expect(FINALIZE).toMatch(/do not re-derive the ranking by hand/i);
  });

  it("describes the tie-break the engine implements, in the engine's order", () => {
    // highest total → each criterion in order → lexicographically smallest
    // filename. The template must not describe a positional shortcut, which is
    // what coupled it to the criteria order in loom.md before aggregation moved
    // into code.
    const total = FINALIZE.search(/highest total score/i);
    const criteria = FINALIZE.search(/each criterion in order/i);
    const lexical = FINALIZE.search(/lexicographically smallest/i);
    expect(total, "template must state the total-score rule").toBeGreaterThanOrEqual(0);
    expect(criteria).toBeGreaterThan(total);
    expect(lexical).toBeGreaterThan(criteria);
  });

  it("tells the agent to stop rather than fall back to computing it", () => {
    expect(FINALIZE).toMatch(/stop and report the error/i);
  });
});
