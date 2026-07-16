/**
 * GATE_WIRED_TOOLS ↔ hooks/hooks.json sync — enforced by test, not by a
 * comment. The machine parser rejects machines enforcing tools outside
 * GATE_WIRED_TOOLS on the promise that hooks.json wires the PreToolUse gate
 * for exactly those tools; this test makes that promise checkable, and pins
 * the evidence recorder's PostToolUse coverage the same way.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { GATE_WIRED_TOOLS } from "../../src/machine/types";
import { FILE_MODIFYING_TOOLS } from "../../src/core/tool-vocabulary";
import { KNOWN_HANDLERS } from "../../src/handler-routes";

interface HookEntry {
  readonly matcher?: string;
  readonly hooks: readonly { readonly type: string; readonly command: string }[];
}

const hooksJson = JSON.parse(
  readFileSync(join(__dirname, "../../../hooks/hooks.json"), "utf-8"),
) as { hooks: Record<string, HookEntry[]> };

/**
 * Tools a matcher string covers. Matchers are regex-ish alternations
 * ("Edit", "Read|Edit|Write|MultiEdit|Bash") — assert that shape before
 * splitting so a future regex-y matcher can't silently defeat this parser.
 */
function matcherTools(matcher: string): string[] {
  const tools = matcher.split("|").map((t) => t.trim());
  for (const tool of tools) {
    expect(tool, `matcher segment ${JSON.stringify(tool)} in ${JSON.stringify(matcher)} is not a plain tool name — update matcherTools if hooks.json grows real regex matchers`).toMatch(/^[A-Za-z*]+$/);
  }
  return tools;
}

function entriesWiring(event: string, script: string): HookEntry[] {
  return (hooksJson.hooks[event] ?? []).filter((e) =>
    e.hooks.some((h) => h.command.includes(script)),
  );
}

describe("GATE_WIRED_TOOLS ↔ hooks.json (PreToolUse gate wiring)", () => {
  it("every GATE_WIRED_TOOLS entry has a PreToolUse matcher wiring enforce-phase-tools.sh", () => {
    const gateEntries = entriesWiring("PreToolUse", "enforce-phase-tools.sh");
    expect(gateEntries.length).toBeGreaterThan(0);
    const covered = new Set(gateEntries.flatMap((e) => matcherTools(e.matcher ?? "*")));

    for (const tool of GATE_WIRED_TOOLS) {
      expect(
        covered.has(tool) || covered.has("*"),
        `GATE_WIRED_TOOLS contains "${tool}" but no PreToolUse matcher wires enforce-phase-tools.sh for it — the machine would declare a guarantee the hook never delivers`,
      ).toBe(true);
    }
  });

  it("no PreToolUse matcher wires the gate for a tool OUTSIDE GATE_WIRED_TOOLS (the constant must not understate the wiring)", () => {
    const gateEntries = entriesWiring("PreToolUse", "enforce-phase-tools.sh");
    const wired = (GATE_WIRED_TOOLS as readonly string[]);
    for (const entry of gateEntries) {
      for (const tool of matcherTools(entry.matcher ?? "*")) {
        expect(
          wired.includes(tool),
          `hooks.json wires enforce-phase-tools.sh for "${tool}" but GATE_WIRED_TOOLS omits it — parseMachine would reject machines enforcing a tool the gate actually sees`,
        ).toBe(true);
      }
    }
  });
});

describe("guard-state-file ↔ hooks.json (PreToolUse Bash wiring)", () => {
  it("guard-state-file.sh is wired for the PreToolUse Bash matcher — the state-file guard and the call-start stamp both ride on it", () => {
    const guardEntries = entriesWiring("PreToolUse", "guard-state-file.sh");
    expect(guardEntries.length).toBeGreaterThan(0);
    const covered = new Set(guardEntries.flatMap((e) => matcherTools(e.matcher ?? "*")));
    expect(
      covered.has("Bash") || covered.has("*"),
      "guard-state-file.sh is not wired for Bash — state-file writes would go unguarded and call-start stamps would never be written",
    ).toBe(true);
  });
});

describe("hooks.json shim routes ⊆ cli.ts KNOWN_HANDLERS", () => {
  it("every cli.ts route a wired shim invokes is a known handler route", () => {
    const scriptsDir = join(__dirname, "../../../hooks/scripts");
    const wiredScripts = new Set(
      Object.values(hooksJson.hooks)
        .flat()
        .flatMap((entry) => entry.hooks.map((h) => basename(h.command.trim().split(/\s+/).pop() ?? ""))),
    );
    expect(wiredScripts.size).toBeGreaterThan(0);

    let routesChecked = 0;
    for (const script of wiredScripts) {
      const content = readFileSync(join(scriptsDir, script), "utf-8");
      for (const m of content.matchAll(/engine\/src\/cli\.ts"?\s+([a-z-]+)\s+([a-z-]+)/g)) {
        routesChecked++;
        const [, hookType, handler] = m;
        const typeSet = KNOWN_HANDLERS[hookType];
        expect(typeSet, `${script} invokes unknown hook type "${hookType}"`).toBeDefined();
        expect(
          typeSet?.has(handler),
          `${script} invokes cli.ts ${hookType} ${handler}, which KNOWN_HANDLERS does not route — the shim would exit "Unknown handler" at runtime`,
        ).toBe(true);
      }
    }
    // Sanity: the regex actually found routes (a format change must fail
    // loudly here, not silently check nothing).
    expect(routesChecked).toBeGreaterThan(5);
  });
});

describe("evidence recorder ↔ hooks.json (PostToolUse coverage)", () => {
  it("record-evidence.sh covers {Read, Bash} ∪ FILE_MODIFYING_TOOLS", () => {
    const recorderEntries = entriesWiring("PostToolUse", "record-evidence.sh");
    expect(recorderEntries.length).toBeGreaterThan(0);
    const covered = new Set(recorderEntries.flatMap((e) => matcherTools(e.matcher ?? "*")));

    const required = new Set(["Read", "Bash", ...FILE_MODIFYING_TOOLS]);
    for (const tool of required) {
      expect(
        covered.has(tool) || covered.has("*"),
        `record-evidence.sh's PostToolUse matcher does not cover "${tool}" — evidence for it would never reach the ledger`,
      ).toBe(true);
    }
  });
});
