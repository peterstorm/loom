/**
 * Guarded Skill Machine definitions for tests: one minimal machine that
 * `parseMachineJson` accepts, so a suite that needs a loadable (or pinnable)
 * definition writes this one and a change to the machine schema is made here
 * once.
 */

/** A minimal valid machine for `agent`: one advancing phase, one terminal phase. */
export const validMachineJson = (agent: string): string => JSON.stringify({
  agent,
  enforcedTools: ["Edit"],
  phases: [
    { id: "a", allowedTools: [], advance: { event: "FileRead" } },
    { id: "z", terminal: true, allowedTools: ["Edit"], requires: [] },
  ],
});
