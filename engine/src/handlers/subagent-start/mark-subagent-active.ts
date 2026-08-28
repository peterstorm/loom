/**
 * SubagentStart bookkeeping — three jobs:
 * 1. Track the agent on the session's `.active` roster so PreToolUse can
 *    allow Edit/Write from IMPLEMENTATION subagents AND contention can be
 *    counted. Roster membership alone is not a write grant — `shouldBlockDirectEdit`
 *    keeps review agents and refutation verifiers read-only while active.
 * 2. Bind the guarded skill machine for machine-gated agent types, minting
 *    the attribution epoch the recorder and gate key evidence by.
 * 3. Persist the task_graph absolute path for cross-repo SubagentStop access.
 */

import { mkdirSync } from "node:fs";
import { blockResult, type HookHandler } from "../../types";
import { machinesDir, pathExistsFailClosed, subagentDir, taskGraphPath } from "../../config";
import { isImplementationAgent } from "../../core/model-profiles";
import { stripNamespace } from "../../utils/strip-namespace";
import {
  bindMachineAgent,
  fsSessionRegistry,
  loadMachine,
  markAgentActive,
  parseAgentType,
  parseReportedAgentId,
  parseSessionId,
  removeActiveAgentStrict,
  reportedRosterAgentId,
  claimPersistedSessionTaskGraphPointerBinding,
  releasePersistedSessionTaskGraphPointerBinding,
  WRITE_GRANT_AGENT_NAMESPACE,
} from "../../machine";
import { passthroughDiagnostic } from "../../utils/hook-diagnostic";
import { resolveAgentTranscriptPath } from "../../utils/agent-transcript-path";
import { parseFirstUserPrompt } from "../../parsers/parse-transcript";
import { parseSubagentStartStdin } from "../../parsers/parse-subagent-start-input";
import { extractTaskId } from "../../utils/extract-task-id";
import { readRunBytesNoFollow } from "../../orchestration/no-follow-fs";
import { StateManager } from "../../state-manager";
import {
  publishImplementationAttemptSidecar,
  removeImplementationAttemptSidecar,
} from "../../implementation-attempt-sidecar";
import { rollbackTaskExecutionRegistration } from "../task-execution";
import type { ImplementationAttemptAuthority } from "../../core/implementation-completion";
import { parseAgentName } from "../../core/model-profiles";

export type ActiveTaskGraphObservation =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "available"; path: string; manager: StateManager }>
  | Readonly<{ kind: "unavailable"; path: string | null; reason: string }>;

/** Resolve, probe, open, and parse TaskGraph authority as one fail-closed observation. */
export function observeActiveTaskGraph(
  resolvePath: () => string = taskGraphPath,
  exists: (path: string) => boolean = pathExistsFailClosed,
  open: (path: string) => StateManager | null = StateManager.fromPath,
): ActiveTaskGraphObservation {
  let path: string | null = null;
  try {
    path = resolvePath();
    if (!exists(path)) return Object.freeze({ kind: "absent" });
    const manager = open(path);
    if (manager === null) {
      return Object.freeze({ kind: "unavailable", path, reason: "TaskGraph could not be opened" });
    }
    manager.load();
    return Object.freeze({ kind: "available", path, manager });
  } catch (error) {
    return Object.freeze({
      kind: "unavailable",
      path,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

const handler: HookHandler = async (stdin) => {
  const parsedInput = parseSubagentStartStdin(stdin);

  // Resolve all TaskGraph authority before publishing roster, sidecar,
  // machine, directory, or pointer capabilities. Only proven absence permits
  // ad-hoc passthrough; every discovery/open/load uncertainty blocks.
  const graph = observeActiveTaskGraph();
  if (!parsedInput.ok) {
    const cause = parsedInput.error;
    if (graph.kind === "absent") {
      return passthroughDiagnostic(
        `mark-subagent-active: malformed ad-hoc SubagentStart input — no TaskGraph exists; agent not tracked: ${cause}\n`,
      );
    }
    const authority = graph.kind === "available"
      ? `TaskGraph ${graph.path} is active`
      : `TaskGraph authority is unobservable${graph.path === null ? "" : ` at ${graph.path}`}: ${graph.reason}`;
    return blockResult(
      `mark-subagent-active: malformed SubagentStart input while ${authority} — refusing spawn: ${cause}`,
    );
  }
  if (graph.kind === "absent") return { kind: "passthrough" };
  if (graph.kind === "unavailable") {
    return blockResult(
      `mark-subagent-active: TaskGraph authority${graph.path === null ? "" : ` at ${graph.path}`} is unobservable: ${graph.reason}; refusing spawn`,
    );
  }
  const input = parsedInput.value;
  const { agent_id } = input;
  const activeGraphPath = graph.path;
  const activeGraphManager = graph.manager;

  // Parse the session id at the boundary: session ids name files under
  // SUBAGENT_DIR (roster, binding, task_graph pointer — one of them a
  // WRITE), and an id like `../../x` would address files outside the dir.
  // Fail closed: no tracking, no binding, no pointer write.
  const sessionId = parseSessionId(input.session_id ?? "");
  if (sessionId === null) {
    return blockResult(
      `mark-subagent-active: invalid session_id ${JSON.stringify(input.session_id ?? "")} while a TaskGraph is active — exact authority cannot be bound; refusing spawn`,
    );
  }

  try {
    mkdirSync(subagentDir(), { recursive: true, mode: 0o700 });
  } catch (e) {
    // Every session file below lives under this dir — name the blast radius
    // instead of surfacing an uncontextualized "Hook error". The guarded
    // per-write handling below (roster, bind, pointer) reports its own
    // consequences when the writes then fail.
    process.stderr.write(
      `mark-subagent-active: cannot create ${subagentDir()} — roster tracking, machine binding, and the task_graph pointer will all fail for ${sessionId}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }

  // Parse identity at the boundary. `agent_id` is HARNESS-REPORTED, so it goes
  // through the reported-id constructor, which refuses two classes:
  //   - reserved or path-unsafe characters (whitespace / colon / slash / `..`),
  //     which would desync the binding file and the epoch key and silently
  //     degrade evidence attribution; and
  //   - the reserved write-grant namespace, which the write gate reads as a
  //     capability — a reported id shaped like one would be granted Edit/Write
  //     with no grant ever consumed.
  // Machine authority and roster counting deliberately diverge for rejected
  // identities: parseReportedAgentId returns null (no capability), while
  // reportedRosterAgentId mints a deterministic non-authorizing placeholder so
  // the running Agent still counts against sole-agent attribution. A guarded
  // role with no machine-capable identity is blocked before publication.
  const agentId = agent_id ? parseReportedAgentId(agent_id) : null;
  const rosterId = agent_id ? reportedRosterAgentId(agent_id) : null;
  if (agent_id && agentId === null) {
    process.stderr.write(
      `mark-subagent-active: agent_id ${JSON.stringify(agent_id)} is reserved or path-unsafe (whitespace/colon/slash/'..', or the ${WRITE_GRANT_AGENT_NAMESPACE} write-grant namespace) — no machine identity can be bound\n`,
    );
  }

  const rosterAgentTypeRaw = stripNamespace(input.agent_type ?? "");
  const rosterAgentType = rosterAgentTypeRaw ? parseAgentType(rosterAgentTypeRaw) : null;
  const guardedMachine = rosterAgentType === null
    ? { kind: "none" as const }
    : loadMachine(machinesDir(), rosterAgentType);
  if (guardedMachine.kind !== "none" && (agentId === null || rosterId === null)) {
    return blockResult(
      `mark-subagent-active: ${rosterAgentType} has a Guarded Skill Machine but no valid agent_id; refusing to run it ungated`,
    );
  }
  const modernImplementationAgent = isImplementationAgent(rosterAgentTypeRaw);
  const loomOwnedAgent = parseAgentName(rosterAgentTypeRaw).ok || modernImplementationAgent;
  let sidecarPublished = false;
  let sidecarAlreadyOwned = false;
  let identifiedAuthority: ImplementationAttemptAuthority | null = null;
  const rollbackIdentifiedRegistration = async (): Promise<string | null> => {
    if (identifiedAuthority === null || sidecarAlreadyOwned) return null;
    const rolledBack = await rollbackTaskExecutionRegistration([identifiedAuthority]);
    return rolledBack.kind === "block" ? rolledBack.message : null;
  };
  if (modernImplementationAgent) {
    if (agentId === null || rosterId === null || rosterAgentType === null) {
      return blockResult(
        `mark-subagent-active: implementation agent identity is invalid; exact attempt authority cannot be bound`,
      );
    }
    try {
      const transcriptPath = resolveAgentTranscriptPath(input);
      if (transcriptPath === null) throw new Error("child transcript could not be resolved");
      const firstPrompt = parseFirstUserPrompt(readRunBytesNoFollow(transcriptPath).toString("utf8"));
      if (!firstPrompt.ok) throw new Error(firstPrompt.error);
      const taskId = extractTaskId(firstPrompt.prompt);
      if (taskId === null) throw new Error("trusted first user prompt contains no Task id");
      const manager = activeGraphManager;
      const graph = manager.load();
      const task = graph.tasks.find((candidate) => candidate.id === taskId);
      if (task === undefined) throw new Error(`trusted first user prompt names unknown Task ${taskId}`);
      if (!(graph.executing_tasks ?? []).includes(taskId) || task.active_implementation_attempt === undefined) {
        throw new Error(`Task ${taskId} has no current modern implementation attempt`);
      }
      identifiedAuthority = task.active_implementation_attempt;
      const sidecar = publishImplementationAttemptSidecar({
        sessionId,
        agentId,
        taskGraphPath: manager.getPath(),
        authority: identifiedAuthority,
      });
      sidecarPublished = sidecar.disposition === "published";
      sidecarAlreadyOwned = sidecar.disposition === "already-owned";
      if (sidecar.cleanupFailure !== null) {
        process.stderr.write(
          `mark-subagent-active: implementation sidecar is live but staged cleanup failed for ${agentId}/${sessionId}: ${sidecar.cleanupFailure}\n`,
        );
      }
    } catch (error) {
      const rollbackFailure = await rollbackIdentifiedRegistration();
      return blockResult(
        `mark-subagent-active: implementation authority binding failed: ${error instanceof Error ? error.message : String(error)}` +
        (rollbackFailure === null ? "" : `; exact registration rollback failed: ${rollbackFailure}`),
      );
    }
  }

  // Track active agent for cleanup AND contention counting — appended under
  // the same per-session lock cleanup uses to rewrite the roster
  // (append-vs-cleanup race). An UNPARSEABLE id is still tracked, via a
  // sanitized placeholder (reportedRosterAgentId): the roster only needs to COUNT
  // agents, and an invisible agent alongside a validly-bound one would let
  // soleActiveBinding cross-credit its tool calls into the bound epoch.
  //
  // A roster FAILURE (lock/fs error) makes attribution unsound: an agent
  // off the roster runs invisibly, so soleActiveBinding would cross-credit
  // its tool calls into whatever binding exists. An unsound roster must not
  // coexist with an armed binding. Machine-bearing roles are blocked; a
  // machine-less role still writes the .task_graph path for SubagentStop.
  //
  // The roster line also records the agent TYPE. PreToolUse authorizes writes
  // by ROLE, and on Claude Code `agent_id` is an opaque handle that no
  // agent-type name can match — identity alone cannot answer "may this agent
  // write?". Parsed here (not below) because the roster is written first.
  let rosterSound = true;
  let rosterCreated = false;
  if (rosterId !== null) {
    try {
      const rosterAcquisition = await markAgentActive(sessionId, rosterId, rosterAgentType);
      rosterCreated = rosterAcquisition === "created";
    } catch (e) {
      rosterSound = false;
      const message = `mark-subagent-active: roster update failed — attribution unsound; refusing to arm machine binding for ${agent_id}/${sessionId}: ${e instanceof Error ? e.message : String(e)}`;
      process.stderr.write(`${message}\n`);
      if (modernImplementationAgent) {
        const rollbackFailures: string[] = [];
        try {
          if (sidecarPublished && agentId !== null) removeImplementationAttemptSidecar(sessionId, agentId);
        } catch (rollbackError) {
          rollbackFailures.push(`sidecar rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
        const registrationRollback = await rollbackIdentifiedRegistration();
        if (registrationRollback !== null) rollbackFailures.push(`exact registration rollback failed: ${registrationRollback}`);
        return blockResult(rollbackFailures.length === 0 ? message : `${message}; ${rollbackFailures.join("; ")}`);
      }
      if (guardedMachine.kind !== "none") return blockResult(message);
    }
  }

  // Bind guarded skill machine when this agent type ships one (opt-in per
  // agent). The agent_type is PARSED before loadMachine: the branded
  // AgentType is what proves the machine-definition path stays inside
  // machinesDir. An INVALID machine binds too: the PreToolUse gate then
  // fails closed with the parse error, instead of a corrupt machine file
  // silently switching enforcement off. Binding requires agent_id (the
  // epoch key). machinesDir() is resolved at CALL time — the same
  // resolution the PreToolUse gate uses, so bind and gate can never see
  // different dirs.
  if (rosterAgentTypeRaw && rosterAgentType === null && rosterSound) {
    process.stderr.write(
      `mark-subagent-active: agent_type ${JSON.stringify(rosterAgentTypeRaw)} contains reserved or path-unsafe characters (whitespace/colon/slash/'..') — no machine looked up or bound; it will run UNGATED\n`,
    );
  }
  let bindingFailure: string | null = null;
  let machineBindingCreated = false;
  if (rosterAgentType && rosterSound) {
    if (guardedMachine.kind !== "none") {
      if (agentId && rosterId !== null) {
        try {
          const machineAcquisition = await bindMachineAgent(sessionId, rosterAgentType, agentId);
          machineBindingCreated = machineAcquisition === "created";
        } catch (error) {
          bindingFailure =
            `mark-subagent-active: bindMachineAgent failed — refusing to run ${rosterAgentType} (${agentId}) ungated: ${error instanceof Error ? error.message : String(error)}`;
        }
      } else {
        bindingFailure = `mark-subagent-active: cannot bind machine for ${rosterAgentType} — no valid agent_id; refusing ungated execution`;
      }
      if (guardedMachine.kind === "invalid") {
        process.stderr.write(`mark-subagent-active: machine invalid (gate will fail closed) — ${guardedMachine.error}\n`);
      }
    }
  }

  // Store task graph absolute path for cross-repo access
  // SubagentStart runs in orchestrator's cwd where task graph exists
  // SubagentStop may run in different repo, needs this path.
  // taskGraphPath() resolves at CALL time (like machinesDir above) so the
  // path this handler persists can never drift from what the env says now.
  let pointerLeaseCreated = false;
  if (rosterId !== null) {
    try {
      const claim = await claimPersistedSessionTaskGraphPointerBinding(sessionId, rosterId, activeGraphPath);
      pointerLeaseCreated = claim.kind === "persisted";
    } catch (error) {
      const pointerFailure =
        `mark-subagent-active: failed to persist task_graph pointer authority for ${sessionId}/${rosterId} — cross-repo SubagentStop cleanup is unavailable: ${error instanceof Error ? error.message : String(error)}`;
      process.stderr.write(`${pointerFailure}\n`);
      if (loomOwnedAgent) bindingFailure = bindingFailure ?? pointerFailure;
    }
  } else if (loomOwnedAgent) {
    bindingFailure = bindingFailure ??
      `mark-subagent-active: cannot bind task_graph pointer for Loom Agent without a cleanup-capable agent_id`;
  }

  if (bindingFailure !== null && agentId !== null) {
    const rollbackFailures: string[] = [];
    if (machineBindingCreated && rosterAgentType !== null) {
      try {
        await fsSessionRegistry.unbind(sessionId, rosterAgentType, agentId);
      } catch (error) {
        rollbackFailures.push(`machine-binding rollback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (rosterCreated && rosterId !== null) {
      try {
        await removeActiveAgentStrict(sessionId, rosterId);
      } catch (error) {
        rollbackFailures.push(`active-roster rollback could not be proven: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (sidecarPublished) {
      try {
        removeImplementationAttemptSidecar(sessionId, agentId);
      } catch (error) {
        rollbackFailures.push(`sidecar rollback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (pointerLeaseCreated && rosterId !== null) {
      try {
        const rolledBack = await releasePersistedSessionTaskGraphPointerBinding(sessionId, rosterId);
        if (rolledBack !== "rolled-back") {
          rollbackFailures.push(`task-graph pointer rollback lost exact ownership (${rolledBack})`);
        }
      } catch (error) {
        rollbackFailures.push(`task-graph pointer rollback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const registrationRollback = await rollbackIdentifiedRegistration();
    if (registrationRollback !== null) rollbackFailures.push(`exact registration rollback failed: ${registrationRollback}`);
    if (rollbackFailures.length > 0) bindingFailure = `${bindingFailure}; ${rollbackFailures.join("; ")}`;
  } else if (bindingFailure !== null && rosterCreated && rosterId !== null) {
    try {
      await removeActiveAgentStrict(sessionId, rosterId);
    } catch (error) {
      bindingFailure = `${bindingFailure}; active-roster rollback could not be proven: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return bindingFailure === null
    ? { kind: "passthrough" }
    : blockResult(bindingFailure);
};

export default handler;
