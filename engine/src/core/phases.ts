/**
 * Phase vocabulary leaf. Both the legacy schema root and Agent Catalog depend
 * on this tuple, so it must not import either domain back into itself.
 */
export const PHASES = Object.freeze([
  "init",
  "brainstorm",
  "specify",
  "clarify",
  "architecture",
  "plan-alignment",
  "decompose",
  "execute",
] as const);

export type Phase = (typeof PHASES)[number];
