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

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { blockResult, type HookHandler, type SubagentStartInput } from "../../types";
import { isImplAgent, machinesDir, pathExistsFailClosed, subagentDir, taskGraphPath } from "../../config";
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
  sessionScopedPath,
  WRITE_GRANT_AGENT_NAMESPACE,
} from "../../machine";
import { passthroughDiagnostic } from "../../utils/hook-diagnostic";
import { resolveAgentTranscriptPath } from "../../utils/agent-transcript-path";
import { parseFirstUserPrompt } from "../../parsers/parse-transcript";
import { extractTaskId } from "../../utils/extract-task-id";
import { readRunBytesNoFollow } from "../../orchestration/no-follow-fs";
import { StateManager } from "../../state-manager";
import {
  publishImplementationAttemptSidecar,
  removeImplementationAttemptSidecar,
} from "../../implementation-attempt-sidecar";
import { rollbackTaskExecutionRegistration } from "../task-execution";
import type { ImplementationAttemptAuthority } from "../../core/implementation-completion";

const handler: HookHandler = async (stdin) => {
  let input: SubagentStartInput;
  try {
    input = JSON.parse(stdin);
  } catch (e) {
    // Malformed hook input: nothing can be tracked or bound. Say so loudly —
    // an untracked agent means its SubagentStop cleanup is skipped and any
    // machine binding it should have had never arms.
    return passthroughDiagnostic(`mark-subagent-active: malformed SubagentStart input — agent not tracked, cleanup skipped, bindings may leak: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  const { agent_id } = input;

  // Parse the session id at the boundary: session ids name files under
  // SUBAGENT_DIR (roster, binding, task_graph pointer — one of them a
  // WRITE), and an id like `../../x` would address files outside the dir.
  // Fail closed: no tracking, no binding, no pointer write.
  const sessionId = parseSessionId(input.session_id ?? "");
  if (sessionId === null) {
    return passthroughDiagnostic(`mark-subagent-active: invalid session_id ${JSON.stringify(input.session_id ?? "")} — refusing all session-file writes; agent not tracked, machine NOT bound, task_graph pointer not written\n`);
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
  // Refuse the machine BINDING loudly — with no binding the gate stays
  // unarmed, which the existing fail-closed handling covers. The SAME
  // constructor governs the roster entry below, so binding and roster identity
  // can never disagree about which id an agent is.
  const agentId = agent_id ? parseReportedAgentId(agent_id) : null;
  const rosterId = agent_id ? reportedRosterAgentId(agent_id) : null;
  if (agent_id && agentId === null) {
    process.stderr.write(
      `mark-subagent-active: agent_id ${JSON.stringify(agent_id)} is reserved or path-unsafe (whitespace/colon/slash/'..', or the ${WRITE_GRANT_AGENT_NAMESPACE} write-grant namespace) — machine NOT bound, it will run UNGATED; tracked on the roster as ${reportedRosterAgentId(agent_id)} for contention counting\n`,
    );
  }

  const rosterAgentTypeRaw = stripNamespace(input.agent_type ?? "");
  const rosterAgentType = rosterAgentTypeRaw ? parseAgentType(rosterAgentTypeRaw) : null;
  const modernImplementationAgent = isImplAgent(rosterAgentTypeRaw) && pathExistsFailClosed(taskGraphPath());
  let sidecarPublished = false;
  let identifiedAuthority: ImplementationAttemptAuthority | null = null;
  const rollbackIdentifiedRegistration = async (): Promise<string | null> => {
    if (identifiedAuthority === null) return null;
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
      const graphPath = taskGraphPath();
      const manager = StateManager.fromPath(graphPath);
      if (manager === null) throw new Error(`TaskGraph is unavailable at ${graphPath}`);
      const graph = manager.load();
      const task = graph.tasks.find((candidate) => candidate.id === taskId);
      if (task === undefined) throw new Error(`trusted first user prompt names unknown Task ${taskId}`);
      if (!(graph.executing_tasks ?? []).includes(taskId) || task.active_implementation_attempt === undefined) {
        throw new Error(`Task ${taskId} has no current modern implementation attempt`);
      }
      identifiedAuthority = task.active_implementation_attempt;
      publishImplementationAttemptSidecar({
        sessionId,
        agentId,
        taskGraphPath: manager.getPath(),
        authority: identifiedAuthority,
      });
      sidecarPublished = true;
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
  // coexist with an armed binding — skip the machine bind, but still write
  // the .task_graph path below (SubagentStop needs it regardless).
  //
  // The roster line also records the agent TYPE. PreToolUse authorizes writes
  // by ROLE, and on Claude Code `agent_id` is an opaque handle that no
  // agent-type name can match — identity alone cannot answer "may this agent
  // write?". Parsed here (not below) because the roster is written first.
  let rosterSound = true;
  let rosterMarked = false;
  if (rosterId !== null) {
    try {
      await markAgentActive(sessionId, rosterId, rosterAgentType);
      rosterMarked = true;
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
  let machineBound = false;
  if (rosterAgentType && rosterSound) {
    const loaded = loadMachine(machinesDir(), rosterAgentType);
    if (loaded.kind !== "none") {
      if (agentId && rosterId !== null) {
        try {
          await bindMachineAgent(sessionId, rosterAgentType, agentId);
          machineBound = true;
        } catch (error) {
          bindingFailure =
            `mark-subagent-active: bindMachineAgent failed — refusing to run ${rosterAgentType} (${agentId}) ungated: ${error instanceof Error ? error.message : String(error)}`;
        }
      } else {
        process.stderr.write(`mark-subagent-active: cannot bind machine for ${rosterAgentType} — no valid agent_id in hook input; it will run UNGATED\n`);
      }
      if (loaded.kind === "invalid") {
        process.stderr.write(`mark-subagent-active: machine invalid (gate will fail closed) — ${loaded.error}\n`);
      }
    }
  }

  // Store task graph absolute path for cross-repo access
  // SubagentStart runs in orchestrator's cwd where task graph exists
  // SubagentStop may run in different repo, needs this path.
  // taskGraphPath() resolves at CALL time (like machinesDir above) so the
  // path this handler persists can never drift from what the env says now.
  const taskGraph = taskGraphPath();
  const taskGraphFile = sessionScopedPath(sessionId, ".task_graph");
  // Refresh the pointer whenever it is ABSENT or names a DIFFERENT graph than
  // the one this SubagentStart is serving. A write-once pointer went stale when
  // a single session served a second graph (cross-repo reuse): every later
  // agent resolved to the FIRST graph, and reservation reclamation probed the
  // wrong roster. Overwriting only on a real change is safe: concurrent agents
  // of one session always share one orchestration graph, so they write the
  // identical value and never clobber each other; only a genuine graph switch
  // (sequential across repos) rewrites it.
  const currentGraph = pathExistsFailClosed(taskGraph) ? resolve(taskGraph) : null;
  let storedGraph: string | null = null;
  let taskGraphPointerCreated = false;
  try {
    storedGraph = readFileSync(taskGraphFile, "utf-8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      process.stderr.write(
        `mark-subagent-active: cannot read task_graph pointer ${taskGraphFile}: ${error instanceof Error ? error.message : String(error)} — attempting rewrite\n`,
      );
    }
  }
  if (currentGraph !== null && storedGraph !== currentGraph) {
    try {
      writeFileSync(taskGraphFile, currentGraph);
      taskGraphPointerCreated = storedGraph === null;
    } catch (e) {
      const pointerFailure =
        `mark-subagent-active: failed to write task_graph pointer for ${sessionId} — cross-repo SubagentStop authority is unavailable: ${e instanceof Error ? e.message : String(e)}`;
      process.stderr.write(`${pointerFailure}\n`);
      if (modernImplementationAgent) bindingFailure = bindingFailure ?? pointerFailure;
    }
  }

  if (bindingFailure !== null && modernImplementationAgent && agentId !== null) {
    const rollbackFailures: string[] = [];
    if (machineBound && rosterAgentType !== null) {
      try {
        await fsSessionRegistry.unbind(sessionId, rosterAgentType, agentId);
      } catch (error) {
        rollbackFailures.push(`machine-binding rollback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (rosterMarked && rosterId !== null) {
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
    if (taskGraphPointerCreated) {
      try {
        rmSync(taskGraphFile, { force: true });
      } catch (error) {
        rollbackFailures.push(`task-graph pointer rollback failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const registrationRollback = await rollbackIdentifiedRegistration();
    if (registrationRollback !== null) rollbackFailures.push(`exact registration rollback failed: ${registrationRollback}`);
    if (rollbackFailures.length > 0) bindingFailure = `${bindingFailure}; ${rollbackFailures.join("; ")}`;
  } else if (bindingFailure !== null && rosterMarked && rosterId !== null) {
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
