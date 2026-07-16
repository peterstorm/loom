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
  extractShellWriteTargets,
  isTestCommand,
  isToolFailure,
  attributeExit,
  classifyTestCommand,
  classifyTestCommandDetailed,
  type BashOutcome,
  type ClassifiedTestCommand,
  type CommandSegment,
  type SegmentOp,
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
  parseCallStartEntries,
  pruneCallStarts,
  callStartOf,
  type CallStartEntry,
  SESSION_SUFFIXES,
  MACHINE_SUFFIX,
  CALL_START_SUFFIX,
  CALL_START_CAP,
  type AgentId,
  type AgentType,
  type SessionFileSuffix,
  type SessionId,
  type MachineBinding,
  type PersistedBinding,
  type SessionRegistry,
} from "./evidence";
export { machineToMermaid } from "./mermaid";

// Imperative shell
export { findReport, outputFileFromCommand, CALL_START_SLACK_MS } from "./report-discovery";
export {
  ledgerPath,
  machineBindingPath,
  sessionScopedPath,
  appendEvidence,
  readEvidence,
  recordCallStart,
  callStartFor,
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
