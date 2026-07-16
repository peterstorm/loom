/**
 * Pure MachineDef → Mermaid stateDiagram-v2 renderer.
 * The machine JSON is the source of truth; the diagram is a derived view.
 */

import type { MachineDef, Requirement } from "./types";

function guardLabel(req: Requirement): string {
  return req.min === 1 ? req.event : `${req.event} >= ${req.min}`;
}

export function machineToMermaid(machine: MachineDef): string {
  const lines: string[] = ["stateDiagram-v2"];

  lines.push(`    [*] --> ${machine.phases[0].id}`);

  for (let i = 0; i < machine.phases.length; i++) {
    const phase = machine.phases[i];
    if (phase.terminal) {
      const requires = phase.requires.map(guardLabel).join(" AND ");
      lines.push(`    ${phase.id} --> [*]${requires ? ` : requires ${requires}` : ""}`);
    } else if (i + 1 < machine.phases.length) {
      lines.push(`    ${phase.id} --> ${machine.phases[i + 1].id} : ${guardLabel(phase.advance)}`);
    }
    if (phase.allowedTools.length > 0) {
      lines.push(`    note right of ${phase.id} : allows ${phase.allowedTools.join(", ")}`);
    }
  }

  return lines.join("\n");
}
