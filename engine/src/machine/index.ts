/** Guarded Skill Machine — public surface. */

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
  outputFileFromCommand,
  findReport,
} from "./test-report";
export {
  extractEvidence,
  extractBashOutcome,
  isTestCommand,
  classifyTestCommand,
  type BashOutcome,
} from "./extract-evidence";
export {
  ledgerPath,
  machineBindingPath,
  parseEvidenceLine,
  appendEvidence,
  readEvidence,
  eventsForEpoch,
  epochOf,
  readBindings,
  soleActiveBinding,
  markAgentActive,
  bindMachineAgent,
  unbindMachineAgent,
  machineDefPath,
  loadMachine,
  type MachineBinding,
  type LoadedMachine,
} from "./ledger";
export { machineToMermaid } from "./mermaid";
