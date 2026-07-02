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
  MACHINE_INVARIANT_VIOLATED,
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
  isToolFailure,
  classifyTestCommand,
  type BashOutcome,
} from "./extract-evidence";
export {
  parseEvidenceLine,
  eventsForEpoch,
  epochOf,
  parseEpoch,
  parseAgentId,
  parseAgentType,
  parseSessionId,
  parseBindingLine,
  formatBindingLine,
  isBindingFresh,
  resolveSoleActiveBinding,
  type AgentId,
  type AgentType,
  type SessionId,
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
  sessionScopedPath,
  type SessionFileSuffix,
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
