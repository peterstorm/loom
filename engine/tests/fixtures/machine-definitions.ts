/**
 * Guarded Skill Machine definitions for tests: the shipped machines' raw
 * definitions and one minimal machine that `parseMachineJson` accepts, so a
 * suite that needs a loadable (or pinnable) definition writes one of these
 * and a change to the machine schema is made here once.
 */

import { parseMachine, type MachineDef } from "../../src/machine";

/** The shipped code-implementer machine, as raw JSON data (machines/
 *  code-implementer-agent.machine.json without the file). A test that needs
 *  the four-phase shape — hyphenated first phase id included — parses this
 *  through the production parser instead of re-inlining the definition. */
export const CODE_IMPLEMENTER_MACHINE_RAW = {
  agent: "code-implementer-agent",
  enforcedTools: ["Edit", "Write", "MultiEdit"],
  phases: [
    { id: "read-context", allowedTools: [], advance: { event: "FileRead", min: 1 } },
    { id: "implement", allowedTools: ["Edit", "Write", "MultiEdit"], advance: { event: "FileWrite", min: 1 } },
    { id: "verify", allowedTools: ["Edit", "Write", "MultiEdit"], advance: { event: "TestRunPassed", min: 1 } },
    { id: "done", terminal: true, allowedTools: ["Edit", "Write", "MultiEdit"], requires: [{ event: "TestRunPassed", min: 1 }] },
  ],
} as const;

/** Parse a raw definition through the production parser or fail the suite.
 *  MachineDef is branded: parseMachine is its only producer, so a test never
 *  fabricates one — it builds the machine the same way production does. */
export function machineFrom(raw: unknown): MachineDef {
  const parsed = parseMachine(raw);
  if (!parsed.ok) throw new Error(`fixture machine invalid: ${parsed.error}`);
  return parsed.value;
}

/** A minimal valid machine for `agent`: one advancing phase, one terminal phase. */
export const validMachineJson = (agent: string): string => JSON.stringify({
  agent,
  enforcedTools: ["Edit"],
  phases: [
    { id: "a", allowedTools: [], advance: { event: "FileRead" } },
    { id: "z", terminal: true, allowedTools: ["Edit"], requires: [] },
  ],
});
