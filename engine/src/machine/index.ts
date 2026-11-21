/** Guarded Skill Machine — public surface. */

// Pure core
export * from "./types";
export { parseMachine, parseMachineJson } from "./parse-machine";
export {
  foldEvidence,
  isToolAllowed,
  missingRequirements,
  blockExplanation,
} from "./advance";
export { judgeTestRun } from "./test-report";
export {
  attributeExit,
  classifyTestCommandDetailed,
  type ClassifiedTestCommand,
} from "./extract-evidence";
export type {
  PiEvidenceNoRecordReason,
  PiEvidenceTargetDecision,
  ToolEvidencePorts,
} from "./harness-tool-call-types";
export {
  parseEvidenceLine,
  eventsForEpoch,
  epochOf,
  parseEpoch,
  parseAgentId,
  parseAgentType,
  parseReportedAgentId,
  WRITE_GRANT_AGENT_NAMESPACE,
  parseSessionId,
  attributeEvidence,
  parseCallerIdentity,
  phaseGateTarget,
  type EvidenceAttribution,
  SESSION_SUFFIXES,
  STOP_CHECK_NOTE_SUFFIX,
  sidecarKey,
  sessionGroupKey,
  sessionGroupOfTrackingFile,
  type SessionGroupKey,
  MACHINE_SUFFIX,
  CALL_START_SUFFIX,
  IMPLEMENTATION_ATTEMPT_SIDECAR_SUFFIX,
  TASK_GRAPH_POINTER_BINDING_SUFFIX,
  TASK_GRAPH_POINTER_LEASES_SUFFIX,
  TASK_GRAPH_POINTER_SUFFIX,
  type AgentId,
  type AgentType,
  type SessionId,
  type SessionRegistry,
} from "./evidence";

// Imperative shell
export {
  ledgerPath,
  machineBindingPath,
  sessionScopedPath,
  appendEvidence,
  readEvidence,
  readEvidenceLedger,
  callStartFor,
  readBindings,
  readBindingAuthority,
  soleActiveBinding,
  countActiveAgents,
  anyActiveSubagent,
  observeAnyActiveSubagent,
  readActiveAgentRoles,
  type ActiveAgent,
  rosterAgentId,
  reportedRosterAgentId,
  markAgentActive,
  removeActiveAgent,
  removeActiveAgentStrict,
  bindMachineAgent,
  unbindMachineAgent,
  loadMachine,
  observeMachinePins,
  type LoadedMachine,
} from "./ledger";
export { fsSessionRegistry } from "./session-registry";
export { recordToolEvidence } from "./tool-evidence-recorder";
export {
  bindSessionTaskGraphPointer,
  claimPersistedSessionTaskGraphPointerBinding,
  persistSessionTaskGraphPointerBinding,
  releasePersistedSessionTaskGraphPointerBinding,
  rollbackSessionTaskGraphPointer,
  parseCanonicalTaskGraphPointer,
  parseSessionTaskGraphPointerLeaseRegistry,
  type SessionTaskGraphPointerBinding,
} from "./task-graph-pointer";
