/**
 * The vendored security lens documents, by their upstream filenames (see
 * `references/security-lenses/ATTRIBUTION.md`).
 *
 * A leaf: it imports nothing. The selector (`security-lens-select`) ranks these
 * names and the package's printed spellings (`loom-cli-command`) turn one into
 * an absolute path; each imports the list from here, so neither has to import
 * the other for it, and the selector can take the `LoomCommands` value without
 * closing an import cycle.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

export const SECURITY_LENSES = [
  "ATTACK-CLASSES.md",
  "WEB-PROTOCOL-AND-AUTH.md",
  "CLIENT-SIDE.md",
  "AI-AND-LLM.md",
  "MEMORY-SAFETY-AND-BINARY.md",
  "SUPPLY-CHAIN-AND-RELEASE.md",
  "CLOUD-AND-DEPLOYMENT.md",
  "PROTOCOLS-RPC-AND-MESSAGING.md",
  "RESOURCE-EXHAUSTION-AND-AVAILABILITY.md",
  "DATA-ISOLATION-AND-LIFECYCLE.md",
  "DESKTOP-MOBILE-AND-LOCAL-IPC.md",
] as const;

export type SecurityLens = (typeof SECURITY_LENSES)[number];
