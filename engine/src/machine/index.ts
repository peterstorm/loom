/** Guarded Skill Machine — public surface. */

// Pure core
export * from "./types";
export { parseMachine, parseMachineJson } from "./parse-machine";
export {
  advance,
  foldEvidence,
  currentPhase,
  isToolAllowed,
  isTerminal,
  missingRequirements,
  blockExplanation,
  satisfied,
  tokensFor,
} from "./advance";
export {
  parseVitestJson,
  parseJunitXml,
  mergeSummaries,
  judgeTestRun,
  type TestVerdict,
  type TrustedTestVerdict,
} from "./test-report";
export {
  extractEvidence,
  extractBashOutcome,
  isTestCommand,
  classifyTestCommand,
  type BashOutcome,
} from "./extract-evidence";
export {
  parseEvidenceLine,
  eventsForEpoch,
  epochOf,
  parseAgentId,
  parseAgentType,
  parseBindingLine,
  formatBindingLine,
  isBindingFresh,
  type AgentId,
  type AgentType,
  type MachineBinding,
  type PersistedBinding,
  type SessionRegistry,
} from "./evidence";
export { machineToMermaid } from "./mermaid";

// Imperative shell
export { findReport, outputFileFromCommand } from "./report-discovery";
export {
  ledgerPath,
  machineBindingPath,
  appendEvidence,
  readEvidence,
  readBindings,
  soleActiveBinding,
  countActiveAgents,
  refreshBindingActivity,
  rosterAgentId,
  markAgentActive,
  removeActiveAgent,
  bindMachineAgent,
  unbindMachineAgent,
  machineDefPath,
  loadMachine,
  type LoadedMachine,
} from "./ledger";
export { fsSessionRegistry } from "./session-registry";
