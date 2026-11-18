/**
 * Pure MachineDef → Mermaid stateDiagram-v2 renderer.
 * The machine JSON is the source of truth; the diagram is a derived view.
 *
 * State ids must render as bare identifier tokens: mermaid's stateDiagram
 * grammar (v10 and v11 alike) rejects hyphens and most punctuation in a
 * state reference — `[*] --> read-context` is a parse error. A phase id the
 * grammar cannot carry is declared up front with an alias line,
 * `state "id" as token`, and every reference — entry, transition, note —
 * uses the token. The quoted display string carries no raw double quote and
 * no line break. Distinct ids map to distinct tokens: safe ids are reserved
 * before aliases are minted, and a colliding alias gets a numeric suffix.
 */

import type { MachineDef, Requirement } from "./types";

/** The token shape mermaid's stateDiagram grammar accepts as a bare state reference. */
const SAFE_TOKEN = /^[A-Za-z0-9_]+$/;

/** A phase id as it appears inside the alias's quoted display string: no raw
 *  double quote (an apostrophe carries the visual), no line break, no
 *  backslash (an escape sequence inside a quoted string is grammar risk). */
function displayOf(id: string): string {
  return id.replace(/\\/g, "/").replace(/"/g, "'").replace(/\r\n?/g, " ").replace(/\n/g, " ");
}

type RenderedPhase = { readonly token: string; readonly aliased: boolean; readonly display: string };

/** Two-pass rendering plan: reserve every grammar-safe id first, then mint
 *  alias tokens for the rest, so an alias can never collide with a safe id
 *  or with another alias. Phase ids are unique (parseMachine enforces it). */
function renderPlan(phases: readonly { id: string }[]): readonly RenderedPhase[] {
  const taken = new Set<string>();
  for (const phase of phases) {
    if (SAFE_TOKEN.test(phase.id)) taken.add(phase.id);
  }
  return phases.map((phase) => {
    if (SAFE_TOKEN.test(phase.id)) return { token: phase.id, aliased: false, display: phase.id };
    const base = phase.id.replace(/[^A-Za-z0-9_]/g, "_");
    let token = base;
    for (let n = 1; taken.has(token); n++) token = `${base}_${n}`;
    taken.add(token);
    return { token, aliased: true, display: displayOf(phase.id) };
  });
}

function guardLabel(req: Requirement): string {
  return req.min === 1 ? req.event : `${req.event} >= ${req.min}`;
}

export function machineToMermaid(machine: MachineDef): string {
  const plan = renderPlan(machine.phases);

  const lines: string[] = ["stateDiagram-v2"];
  for (const phase of plan) {
    if (phase.aliased) lines.push(`    state "${phase.display}" as ${phase.token}`);
  }

  lines.push(`    [*] --> ${plan[0].token}`);

  for (let i = 0; i < machine.phases.length; i++) {
    const phase = machine.phases[i];
    const token = plan[i].token;
    if (phase.terminal) {
      const requires = phase.requires.map(guardLabel).join(" AND ");
      lines.push(`    ${token} --> [*]${requires ? ` : requires ${requires}` : ""}`);
    } else if (i + 1 < machine.phases.length) {
      lines.push(`    ${token} --> ${plan[i + 1].token} : ${guardLabel(phase.advance)}`);
    }
    if (phase.allowedTools.length > 0) {
      lines.push(`    note right of ${token} : allows ${phase.allowedTools.join(", ")}`);
    }
  }

  return lines.join("\n");
}
