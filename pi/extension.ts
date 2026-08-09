/**
 * Loom Pi Extension
 *
 * Bridges loom's orchestration engine to pi's extension API.
 * Delegates to engine/src/core/ for all business logic.
 */

import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync, unlinkSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Engine core — harness-agnostic, no Claude Code dependency (these do fs I/O)
import { shouldBlockDirectEdit } from "../engine/src/core/block-direct-edits";
import { guardStateFileDecision } from "../engine/src/core/guard-state-file";
import { validatePhaseOrder } from "../engine/src/core/validate-phase-order";
import { classifyTaskExecutionSpawn } from "../engine/src/core/validate-task-execution";
import { validateTaskExecutionBatch } from "../engine/src/handlers/task-execution";
import { validateTemplateSubstitution } from "../engine/src/core/validate-template-substitution";
import { classifyPiSpawnItems, expectedSpawnModel } from "../engine/src/core/model-profiles";


// Engine parsers (format-aware)
import { parseFilesModified } from "../engine/src/parsers/parse-files-modified";
import { parseBashTestOutput } from "../engine/src/parsers/parse-bash-test-output";

// Engine SubagentStop logic (harness-agnostic functions already exported)
import {
  extractTestEvidence,
  collectNewTestEvidence,
  cumulativeModifiedPaths,
  applyUntrustedStopResolution,
} from "../engine/src/handlers/subagent-stop/update-task-status";
import { resolveTransition } from "../engine/src/handlers/subagent-stop/advance-phase";
import {
  applyReviewResolution,
  constrainReviewResolutionToScope,
  hasStandaloneReviewContext,
  resolveTaskReviewFindings,
  reviewResolutionLog,
} from "../engine/src/core/review-output";
import { parseSpecCheckOutput, reconcileSpecCheck } from "../engine/src/core/spec-check";
import { newWaveGate } from "../engine/src/types";

// `isReviewAgent` lives in `config`, NOT in `core/review-output` beside the three
// functions above it: it reads the review-agent roster, and `core/review-output`
// declares itself free of config so its parse/merge rules stay pure. Importing it
// from the wrong module is a LINK-time ESM failure that takes the whole extension
// with it — every hook below, not just review capture. `tests/pi-imports.test.ts`
// resolves every engine import in this file against the real exports so the next
// move of a shared symbol fails a test instead of silently disarming Pi.
import { isReviewAgent, taskGraphPath, SUBAGENT_DIR, PHASE_AGENT_MAP, IMPL_AGENTS, PHASE_ORDER, PROJECT_RULES_DIR, STALE_SUBAGENT_TTL_MS } from "../engine/src/config";
import { sweepStaleSessions } from "../engine/src/handlers/session-start/cleanup-stale-subagents";
import { StateManager } from "../engine/src/state-manager";
import { fsSessionRegistry, parseAgentId, parseSessionId, rosterAgentId } from "../engine/src/machine";
import type { AgentId } from "../engine/src/machine/evidence";
import { buildContextOutput } from "../engine/src/handlers/session-start/resume-after-clear";
import { stripNamespace } from "../engine/src/utils/strip-namespace";
import { extractTaskId } from "../engine/src/utils/extract-task-id";
import * as git from "../engine/src/utils/git";

// Linter integration (PostEdit lint via tool_result)
import { processToolResult } from "../engine/src/handlers/pi-adapter";
import { lintFile } from "../engine/src/linter/index";
import { messagesToClaudeJsonl, parsePiMessages, piStructuredTestResult, type PiMessage } from "./transcript-adapter";
import { materializePiResources } from "./resources";
import { checkAgentSkillPrompt } from "../engine/src/core/agent-skills";
import { validatePiAgentDefinitionFile } from "../engine/src/utils/render-pi-agent";
import { canonicalRepositoryPaths } from "../engine/src/utils/repository-path";
import { changedDeclaredArtifactsSince } from "../engine/src/utils/artifact-baseline";
import {
  consumePiWriteGrant,
  injectPiWriteGrant,
  issuePiWriteGrant,
  revokePiWriteGrant,
  sweepExpiredPiWriteGrants,
} from "./write-grant";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const PI_RESOURCE_CACHE = join(PI_AGENT_DIR, "cache", "loom-resources");

const isLoomOwnedResultAgent = (agentType: string): boolean =>
  PHASE_AGENT_MAP[agentType] !== undefined ||
  IMPL_AGENTS.has(agentType) ||
  isReviewAgent(agentType) ||
  agentType === "spec-check-invoker";

const PI_AGENT_ID_MARKER = /<!-- LOOM_PI_AGENT_ID:([a-z0-9-]+) -->/g;
const PI_WRITE_GRANT_MARKER = /<!-- LOOM_PI_WRITE_GRANT:[0-9a-f]{64} -->/;

export function rejectedChildWriteGrantBlock(rejected: boolean): Readonly<{ block: true; reason: string }> | null {
  return rejected
    ? { block: true, reason: "Loom Pi write grant was rejected for this session; direct edits remain blocked." }
    : null;
}

export function piSystemAgentIdentity(systemPrompt: string): string {
  PI_AGENT_ID_MARKER.lastIndex = 0;
  const matches = [...systemPrompt.matchAll(PI_AGENT_ID_MARKER)];
  if (matches.length !== 1) throw new Error("child system prompt must contain exactly one Loom Pi agent identity");
  return matches[0]![1]!;
}

/** Stable per-spawn roster identity shared by tool_call and tool_result.
 * Task text is deliberately excluded: Pi substitutes `{previous}` in chain
 * results, so it is not stable across the lifecycle. */
function piSpawnItem(raw: Record<string, unknown>, index: number): Record<string, unknown> {
  const entries = Array.isArray(raw.tasks)
    ? raw.tasks
    : Array.isArray(raw.chain)
      ? raw.chain
      : [raw];
  const entry = entries[index];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`missing Pi spawn item ${index}`);
  }
  return entry as Record<string, unknown>;
}

export function piSpawnCwd(raw: unknown, index: number, defaultCwd: string): string {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Pi subagent input must be an object before cwd resolution");
  }
  const input = raw as Record<string, unknown>;
  const entry = piSpawnItem(input, index);
  const cwd = typeof entry.cwd === "string"
    ? entry.cwd
    : typeof input.cwd === "string"
      ? input.cwd
      : defaultCwd;
  return resolve(defaultCwd, cwd);
}

export function replacePiSpawnTask(raw: unknown, index: number, task: string): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Pi subagent input must be an object before write-grant injection");
  }
  const input = raw as Record<string, unknown>;
  piSpawnItem(input, index).task = task;
}

export const piSpawnRosterId = (
  toolCallId: unknown,
  index: number,
  agent: string,
) => rosterAgentId(JSON.stringify([
  typeof toolCallId === "string" ? toolCallId : "",
  index,
  agent,
]));

/** Pi result failure boundary. Missing/malformed exit codes fail closed. */
export function piSubagentResultFailed(result: {
  readonly exitCode?: unknown;
  readonly stopReason?: unknown;
}): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export default function (pi: ExtensionAPI) {
  const issuedWriteGrants = new Map<string, string[]>();
  const spawnReservations = new Map<string, Readonly<{
    sessionId: NonNullable<ReturnType<typeof parseSessionId>>;
    items: readonly Readonly<{
      agentType: string;
      rosterId: AgentId;
      taskId: string | null;
      implementation: boolean;
      standalone: boolean;
    }>[];
  }>>();
  const activeChildWriteGrants = new Map<string, { agentId: AgentId; pointerCreated: boolean }>();
  const rejectedChildWriteGrantSessions = new Set<string>();

  // ─── Resource Discovery ───────────────────────────────────────────────
  // Contribute skills from this package that aren't in the pi manifest's
  // auto-discovery (the manifest covers skills/ and commands/ already,
  // but we also register agents dir for the subagent tool).

  // Pi does not expand Claude Code's CLAUDE_PLUGIN_ROOT token in markdown.
  // Render package-owned prompts and skills from THIS extension's import URL;
  // cwd and the Claude plugin cache are never package identity.
  process.env.LOOM_PLUGIN_ROOT = PACKAGE_ROOT;
  pi.on("resources_discover", () => {
    const resources = materializePiResources(PACKAGE_ROOT, PI_RESOURCE_CACHE);
    return {
      promptPaths: [...resources.promptPaths],
      skillPaths: [...resources.skillPaths],
    };
  });

  // ─── PreToolUse Guards (tool_call event) ──────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    // Fail CLOSED on a crashed guard: an uncaught throw in this chain has
    // undefined polarity in pi (whether the tool proceeds is the harness's
    // choice) — a guard that dies must block, loudly naming itself, or a
    // crash in e.g. guardStateFile silently waves state-file writes through.
    let currentGuard = "session-id";
    try {
      const sessionId = ctx.sessionManager.getSessionId() ?? "unknown";

      // Block direct edits during orchestration
      if (event.toolName === "edit" || event.toolName === "write" || event.toolName === "multi_edit") {
        currentGuard = "block-direct-edits";
        const rejectedGrant = rejectedChildWriteGrantBlock(rejectedChildWriteGrantSessions.has(sessionId));
        if (rejectedGrant !== null) return rejectedGrant;
        const safeSessionId = parseSessionId(sessionId);
        const result = shouldBlockDirectEdit(event.toolName, sessionId, () =>
          existsSync(taskGraphPath()) ||
          (safeSessionId !== null && existsSync(`${SUBAGENT_DIR}/${safeSessionId}.task_graph`))
        );
        if (result.kind === "block") {
          return { block: true, reason: result.message };
        }
      }

      // Guard state file from bash writes
      if (event.toolName === "bash") {
        currentGuard = "guard-state-file";
        const safeSessionId = parseSessionId(sessionId);
        const graphIsActive = existsSync(taskGraphPath()) ||
          rejectedChildWriteGrantSessions.has(sessionId) ||
          (safeSessionId !== null && existsSync(`${SUBAGENT_DIR}/${safeSessionId}.task_graph`));
        const result = graphIsActive
          ? guardStateFileDecision(event.input.command ?? "")
          : { kind: "allow" as const };
        // Call-start stamp (PRODUCER only — pi has no PostToolUse evidence
        // recorder yet, so nothing on the pi side consumes these stamps;
        // they exist so the engine's recorder can order artifacts if it
        // reads the same session): decided FIRST, stamped AFTER, in its own
        // catch — a thrown stamp write must never change the guard's
        // polarity (and must not trip the fail-closed outer catch). The
        // tool-call id is read defensively; absent → no stamp, and the
        // engine recorder fails closed on artifact-backed reports.
        try {
          const toolUseId = (event as { toolCallId?: unknown }).toolCallId;
          const safeSessionId = parseSessionId(sessionId);
          if (safeSessionId !== null && typeof toolUseId === "string" && toolUseId !== "") {
            await fsSessionRegistry.recordCallStart(safeSessionId, toolUseId, Date.now());
          }
        } catch (err) {
          process.stderr.write(
            `loom(pi): call-start stamp failed (guard decision unaffected): ${err instanceof Error ? err.message : String(err)}\n`,
          );
        }
        if (result.kind === "block") {
          return { block: true, reason: result.message };
        }
      }

      // Subagent tool → parse and preflight EVERY single/parallel/chain item
      // before any tracking mutation. A malformed sibling blocks the whole
      // batch; otherwise one parallel item could bypass the gates that the
      // top-level `agent`/`task` fields never represented.
      if (event.toolName === "subagent") {
        currentGuard = "parse-pi-subagent-batch";
        const classifiedItems = classifyPiSpawnItems(event.input);
        if (!classifiedItems.ok) return { block: true, reason: classifiedItems.error.message };
        if (classifiedItems.value.kind === "external") {
          // Loom owns only its catalog outside orchestration. During an active
          // graph, an unknown agent would bypass phase/task/model gates; without
          // one, it belongs to another Pi workflow and must pass through.
          if (existsSync(taskGraphPath())) {
            return {
              block: true,
              reason: "External Pi subagents cannot run while a Loom task graph is active",
            };
          }
          return;
        }
        const parsedItems = classifiedItems.value.items;
        const taskExecutionSpawns = parsedItems.map((item) => classifyTaskExecutionSpawn({
          agentType: item.agent,
          prompt: item.task,
          description: "",
        }));
        const needsTaskGraphLifecycle = taskExecutionSpawns.some((spawn) => spawn.kind !== "standalone");

        const requestedScope = (event.input as { agentScope?: unknown }).agentScope ?? "user";
        if (requestedScope !== "user") {
          return {
            block: true,
            reason: `Loom-owned Pi agents require agentScope='user' so the validated generated definition is exactly the definition Pi executes; got ${JSON.stringify(requestedScope)}.`,
          };
        }

        for (const item of parsedItems) {
          const expected = expectedSpawnModel(item.agent, "pi");
          const definitionPath = join(PI_AGENT_DIR, "agents", `${item.agent}.md`);
          const definition = validatePiAgentDefinitionFile(
            definitionPath,
            item.agent,
            PACKAGE_ROOT,
          );
          if (!expected.ok || !definition.ok) {
            return {
              block: true,
              reason: expected.ok
                ? `Pi agent '${item.agent}' must be rendered from active Loom package ${PACKAGE_ROOT}: ${definition.ok ? "unknown definition mismatch" : definition.error}. Run \"${PACKAGE_ROOT}/scripts/sync-pi-agents.sh\" and /reload.`
                : expected.error.message,
            };
          }

          currentGuard = "validate-agent-skill";
          const sourceAgentPath = join(PACKAGE_ROOT, "agents", `${item.agent}.md`);
          let sourceAgent: string;
          try {
            sourceAgent = readFileSync(sourceAgentPath, "utf-8");
          } catch (error) {
            return {
              block: true,
              reason: `Cannot read active Loom agent definition ${sourceAgentPath}: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          const skillCheck = checkAgentSkillPrompt(sourceAgent, item.task);
          if (!skillCheck.ok) {
            return {
              block: true,
              reason: `Pi agent '${item.agent}' skill policy failed: ${skillCheck.error}`,
            };
          }

          currentGuard = "validate-phase-order";
          const phaseResult = validatePhaseOrder({ agentType: item.agent, prompt: item.task });
          if (phaseResult.kind === "block") return { block: true, reason: phaseResult.message };

          currentGuard = "validate-template-substitution";
          const templateResult = validateTemplateSubstitution(item.task);
          if (templateResult.kind === "block") return { block: true, reason: templateResult.message };

        }

        // Reserve every lifecycle identity before task-state mutation. A roster
        // failure can now refuse the spawn without leaving executing_tasks or
        // artifact baselines claiming work began. The ids include batch ordinal
        // and task text, so repeated verifier/designer types remain distinct.
        currentGuard = "subagent-tracking";
        const safeSessionId = parseSessionId(sessionId);
        if (safeSessionId === null) {
          return {
            block: true,
            reason: `Cannot record Loom subagent lifecycle evidence for invalid session id ${JSON.stringify(sessionId)}; refusing spawn.`,
          };
        }
        const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
        const implementationIndexes = taskExecutionSpawns.flatMap((spawn, index) =>
          spawn.kind === "implementation" ? [index] : []
        );
        if (typeof toolCallId !== "string" || toolCallId === "") {
          return {
            block: true,
            reason: "Cannot bind Loom subagent lifecycle cleanup without a subagent toolCallId; refusing spawn.",
          };
        }
        const rosterIds = parsedItems.map((item, index) =>
          piSpawnRosterId(toolCallId, index, item.agent),
        );
        const reserved: Array<(typeof rosterIds)[number]> = [];
        const writeGrants: Array<{ index: number; token: string; task: string; originalTask: string; injected: boolean }> = [];
        let taskGraphPointerCreated = false;
        const rollbackLifecycle = async (): Promise<void> => {
          for (const agentId of [...reserved].reverse()) {
            await fsSessionRegistry.removeActive(safeSessionId, agentId);
          }
          for (const grant of writeGrants) {
            revokePiWriteGrant(grant.token);
            if (grant.injected) {
              try { replacePiSpawnTask(event.input, grant.index, grant.originalTask); }
              catch (error) {
                process.stderr.write(
                  `loom(pi): lifecycle rollback could not restore child prompt: ${error instanceof Error ? error.message : String(error)}\n`,
                );
              }
            }
          }
          if (typeof toolCallId === "string") issuedWriteGrants.delete(toolCallId);
          if (taskGraphPointerCreated) {
            try { unlinkSync(`${SUBAGENT_DIR}/${safeSessionId}.task_graph`); }
            catch (error) {
              process.stderr.write(
                `loom(pi): lifecycle rollback could not remove task-graph pointer: ${error instanceof Error ? error.message : String(error)}\n`,
              );
            }
          }
        };
        try {
          mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
          for (const agentId of rosterIds) {
            await fsSessionRegistry.markActive(safeSessionId, agentId);
            reserved.push(agentId);
          }
          const activeTaskGraphPath = taskGraphPath();
          if (needsTaskGraphLifecycle && existsSync(activeTaskGraphPath)) {
            const taskGraphFile = `${SUBAGENT_DIR}/${safeSessionId}.task_graph`;
            if (!existsSync(taskGraphFile)) {
              writeFileSync(taskGraphFile, resolve(activeTaskGraphPath));
              taskGraphPointerCreated = true;
            }
          }
          for (const index of implementationIndexes) {
            const item = parsedItems[index]!;
            const taskId = extractTaskId(item.task);
            if (!taskId) throw new Error(`implementation item ${index + 1} has no Task ID for write-grant binding`);
            const grant = issuePiWriteGrant({
              agent: item.agent,
              taskId,
              cwd: piSpawnCwd(event.input, index, ctx.cwd),
              taskGraphPath: taskGraphPath(),
            });
            try {
              writeGrants.push({
                index,
                token: grant.token,
                task: injectPiWriteGrant(item.task, grant),
                originalTask: item.task,
                injected: false,
              });
            } catch (error) {
              revokePiWriteGrant(grant.token);
              throw error;
            }
          }
          // Mutate before task-state validation. Rollback restores prompts and
          // revokes grants, leaving no post-validation operation that can fail
          // after executing_tasks/baselines have committed.
          for (const grant of writeGrants) {
            replacePiSpawnTask(event.input, grant.index, grant.task);
            grant.injected = true;
          }
        } catch (error) {
          await rollbackLifecycle();
          return {
            block: true,
            reason: `Cannot record Loom subagent lifecycle evidence; refusing spawn: ${error instanceof Error ? error.message : String(error)}`,
          };
        }

        currentGuard = "validate-task-execution";
        let taskResult;
        try {
          const executionMode = Array.isArray((event.input as { chain?: unknown }).chain)
            ? "sequential" as const
            : "parallel" as const;
          taskResult = await validateTaskExecutionBatch(taskExecutionSpawns, executionMode);
        } catch (error) {
          await rollbackLifecycle();
          throw error;
        }
        if (taskResult.kind === "block") {
          await rollbackLifecycle();
          return { block: true, reason: taskResult.message };
        }
        if (writeGrants.length > 0) {
          issuedWriteGrants.set(toolCallId, writeGrants.map((grant) => grant.token));
        }
        spawnReservations.set(toolCallId, {
          sessionId: safeSessionId,
          items: parsedItems.map((item, index) => ({
            agentType: item.agent,
            rosterId: rosterIds[index]!,
            taskId: extractTaskId(item.task),
            implementation: taskExecutionSpawns[index]?.kind === "implementation",
            standalone: taskExecutionSpawns[index]?.kind === "standalone",
          })),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `loom(pi): tool_call guard '${currentGuard}' crashed — blocking the call (fail-closed): ${message}\n`,
      );
      return {
        block: true,
        reason: `loom guard '${currentGuard}' crashed (failing closed): ${message}`,
      };
    }
  });

  // ─── Session Lifecycle ────────────────────────────────────────────────

  pi.on("session_start", async (_event, _ctx) => {
    // Cleanup stale subagent tracking files — the ENGINE's sweep, not a
    // per-file twin: staleness is judged per session GROUP (max mtime across
    // the session's files), and the TTL is the shared STALE_SUBAGENT_TTL_MS,
    // so a live session's roster/ledger can't be reaped out from under a
    // fresh `.machine` anchor.
    sweepStaleSessions(SUBAGENT_DIR, Date.now() - STALE_SUBAGENT_TTL_MS);
    sweepExpiredPiWriteGrants();
  });

  // Each Pi subagent is a separate `pi --no-session` process. Parent-session
  // roster entries therefore cannot authorize child Edit/Write calls. Consume
  // the one-time capability injected into THIS child's task and bind its own
  // session before the first model turn.
  pi.on("before_agent_start", async (event, ctx) => {
    let partialBinding: { sessionId: NonNullable<ReturnType<typeof parseSessionId>>; agentId: AgentId } | null = null;
    try {
      if (!PI_WRITE_GRANT_MARKER.test(event.prompt)) return;
      const childAgent = piSystemAgentIdentity(event.systemPrompt);
      const grant = consumePiWriteGrant(event.prompt, ctx.cwd, childAgent);
      if (!grant) return;
      const sessionId = parseSessionId(ctx.sessionManager.getSessionId() ?? "");
      const agentId = parseAgentId(grant.agentId);
      if (!sessionId || !agentId) throw new Error("child session or grant agent identity is invalid");
      await fsSessionRegistry.markActive(sessionId, agentId);
      partialBinding = { sessionId, agentId };
      const pointer = `${SUBAGENT_DIR}/${sessionId}.task_graph`;
      const pointerCreated = !existsSync(pointer);
      if (pointerCreated) writeFileSync(pointer, grant.taskGraphPath, { mode: 0o600 });
      activeChildWriteGrants.set(sessionId, { agentId, pointerCreated });
      partialBinding = null;
      process.stderr.write(`loom(pi): activated child write grant for ${grant.taskId}/${sessionId}\n`);
    } catch (error) {
      const rejectedSession = ctx.sessionManager.getSessionId() ?? "";
      if (parseSessionId(rejectedSession)) rejectedChildWriteGrantSessions.add(rejectedSession);
      if (partialBinding) {
        await fsSessionRegistry.removeActive(partialBinding.sessionId, partialBinding.agentId);
      }
      const message = `loom(pi): child write grant rejected — edits remain blocked: ${error instanceof Error ? error.message : String(error)}`;
      process.stderr.write(message + "\n");
      return {
        message: { customType: "loom-write-grant-error", content: message, display: false },
      };
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const rawSessionId = ctx.sessionManager.getSessionId() ?? "";
    const sessionId = parseSessionId(rawSessionId);
    const binding = activeChildWriteGrants.get(rawSessionId);
    if (sessionId && binding) {
      await fsSessionRegistry.removeActive(sessionId, binding.agentId);
      activeChildWriteGrants.delete(rawSessionId);
      if (binding.pointerCreated) rmSync(`${SUBAGENT_DIR}/${sessionId}.task_graph`, { force: true });
    }
    rejectedChildWriteGrantSessions.delete(rawSessionId);
    for (const tokens of issuedWriteGrants.values()) {
      for (const token of tokens) revokePiWriteGrant(token);
    }
    issuedWriteGrants.clear();
    for (const reservation of spawnReservations.values()) {
      for (const item of reservation.items) {
        try {
          await fsSessionRegistry.removeActive(reservation.sessionId, item.rosterId);
        } catch (error) {
          process.stderr.write(
            `loom(pi): shutdown cleanup failed for ${item.agentType}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
    }
    spawnReservations.clear();
  });

  // ─── Resume Context (before_agent_start) ──────────────────────────────
  // If there's an active task graph in execute phase, inject context
  // so the LLM knows where we are (equivalent of resume-after-clear).

  pi.on("before_agent_start", async (_event, _ctx) => {
    const activeTaskGraphPath = taskGraphPath();
    if (!existsSync(activeTaskGraphPath)) return;

    const sm = StateManager.fromPath(activeTaskGraphPath);
    if (!sm) return;

    let state;
    try {
      state = sm.load();
    } catch (err) {
      process.stderr.write(
        `loom(pi): resume context skipped — task graph unreadable: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return;
    }

    if (state.current_phase !== "execute" || state.tasks.length === 0) return;

    const output = buildContextOutput(state, PACKAGE_ROOT);
    return {
      message: {
        customType: "loom-context",
        content: output,
        display: false,
      },
    };
  });


  // ─── PostEdit Lint (tool_result event for edit/write) ─────────────────
  // After edit/write lands on disk, run immediate-tier lint.
  // If violations: inject error content so agent sees and fixes.
  // If pass: return undefined (no injection).
  // If error: fail-closed — inject error content.

  pi.on("tool_result", async (event, _ctx) => {
    try {
      if (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "multi_edit") return;

      // Skip if the tool itself errored (file may not exist on disk)
      if (event.isError) return;

      const projectRoot = process.cwd();
      const projectRulesPath = join(projectRoot, PROJECT_RULES_DIR);
      const projectRulesDir = existsSync(projectRulesPath) ? projectRulesPath : null;

      const loomDefaultRulesDir = join(PACKAGE_ROOT, "lint-rules");
      const response = processToolResult(
        event.toolName,
        event.input,
        (filePath) => lintFile(filePath, "immediate", loomDefaultRulesDir, projectRulesDir)
      );

      if (response) {
        return {
          content: response.content.map(c => ({ type: c.type as "text", text: c.text })),
          isError: response.isError,
        };
      }
    } catch (error: unknown) {
      // Fail-closed: any error \u2192 inject error content to block the edit
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `\u274c LINT ENGINE ERROR: ${message}` }],
        isError: true,
      };
    }
  });

  // ─── SubagentStop Dispatch (tool_result event) ────────────────────────
  // When a subagent completes, handle phase advancement, task status
  // updates, and review findings — equivalent of SubagentStop hooks.

  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName !== "subagent") return;

    const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
    const reservation = typeof toolCallId === "string" ? spawnReservations.get(toolCallId) : undefined;
    if (typeof toolCallId === "string") {
      for (const token of issuedWriteGrants.get(toolCallId) ?? []) revokePiWriteGrant(token);
      issuedWriteGrants.delete(toolCallId);
      spawnReservations.delete(toolCallId);
    }

    // Release roster authority before consulting any result-envelope field.
    // The immutable reservation still owns standalone/task attribution and
    // failed-attempt cleanup after the child process has stopped.
    if (reservation) {
      for (const item of reservation.items) {
        try {
          await fsSessionRegistry.removeActive(reservation.sessionId, item.rosterId);
        } catch (error) {
          process.stderr.write(
            `loom(pi): reserved subagent cleanup failed for ${item.agentType}: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      }
    }

    const finalizeReservedImplementations = async (rawResults: readonly unknown[]): Promise<void> => {
      if (!reservation || !reservation.items.some((item) => item.implementation)) return;
      const manager = StateManager.fromSession(reservation.sessionId);
      if (!manager) {
        process.stderr.write(
          `loom(pi): cannot finalize reserved implementation attempts for session ${reservation.sessionId} — task graph unavailable\n`,
        );
        return;
      }
      const root = git.repositoryRoot() ?? process.cwd();
      try {
        await manager.update((initial) => {
          let state = initial;
          for (const [index, item] of reservation.items.entries()) {
            if (!item.implementation || item.taskId === null) continue;
            const raw = rawResults[index];
            const envelope = typeof raw === "object" && raw !== null && !Array.isArray(raw)
              ? raw as Record<string, unknown>
              : null;
            const resultAgent = typeof envelope?.agent === "string"
              ? stripNamespace(envelope.agent)
              : null;
            const succeeded = resultAgent === item.agentType && !piSubagentResultFailed({
              exitCode: envelope?.exitCode,
              stopReason: envelope?.stopReason,
            });
            if (succeeded) continue;

            const task = state.tasks.find((candidate) => candidate.id === item.taskId);
            if (!task) {
              state = {
                ...state,
                executing_tasks: (state.executing_tasks ?? []).filter((id) => id !== item.taskId),
              };
              continue;
            }

            let changedDeclaredArtifacts: readonly string[] = [];
            let bytesChangedSinceAttempt = true;
            try {
              changedDeclaredArtifacts = changedDeclaredArtifactsSince(root, task.artifact_baseline);
              bytesChangedSinceAttempt = task.attempt_artifact_baseline === undefined ||
                changedDeclaredArtifactsSince(root, task.attempt_artifact_baseline).length > 0;
            } catch (error) {
              // Comparison failure cannot prove the old evidence still matches
              // current bytes. Fail closed by invalidating it and retain the
              // concrete diagnostic for the operator.
              process.stderr.write(
                `loom(pi): failed-attempt baseline comparison failed for ${item.taskId}: ${error instanceof Error ? error.message : String(error)} — invalidating stale evidence\n`,
              );
            }

            if (!bytesChangedSinceAttempt) {
              state = {
                ...state,
                executing_tasks: (state.executing_tasks ?? []).filter((id) => id !== item.taskId),
              };
              continue;
            }

            const failure = resultAgent !== null && resultAgent !== item.agentType
              ? `reserved ${item.agentType} result was returned as ${resultAgent}`
              : envelope === null
                ? "reserved implementation result was missing or malformed"
                : `${item.agentType} failed before implementation evidence completed`;
            state = applyUntrustedStopResolution(state, item.taskId, {
              taskCompleted: false,
              testResult: { verdict: "untrusted", passed: false, label: "pi-implementation-failed" },
              testEvidence: failure,
              filesModified: [],
              changedDeclaredArtifacts,
              bytesChangedSinceAttempt: true,
              newTestsWritten: false,
              newTestEvidence: "",
            }).state;
          }
          return state;
        });
      } catch (error) {
        process.stderr.write(
          `loom(pi): reserved implementation finalization failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    };

    const details = event.details as Record<string, unknown> | undefined;
    const rawResults = details && "results" in details && Array.isArray(details.results)
      ? details.results
      : [];
    await finalizeReservedImplementations(rawResults);

    if (!details || !("results" in details)) {
      process.stderr.write(
        "loom(pi): subagent tool_result is missing details.results — successful evidence was not applied\n",
      );
      return;
    }

    // Shape guard: a pi version drifting details.results away from an array
    // must be a LOUD no-op, not a silent one (or a throw mid-dispatch).
    if (!Array.isArray(details.results)) {
      process.stderr.write(
        `loom(pi): subagent tool_result has unrecognized details.results shape (${typeof details.results}) — successful evidence was not applied\n`,
      );
      return;
    }
    const results = rawResults as Array<{
      agent: string;
      task: string;
      exitCode: number;
      stopReason?: string;
      messages: unknown[];
    }>;

    for (const [resultIndex, result] of results.entries()) {
      // Per-result error isolation (mirrors dispatch.ts's safeRun): a throw
      // while processing result #1 must not abort results #2..N — that
      // leaves tasks stuck "executing" with zero diagnostics.
      try {
      const agentType = stripNamespace(result.agent);
      const sessionId = _ctx.sessionManager.getSessionId() ?? "unknown";
      const reservedItem = reservation?.items[resultIndex];
      if (reservedItem && agentType !== reservedItem.agentType) {
        process.stderr.write(
          `loom(pi): result ${resultIndex + 1} agent ${JSON.stringify(agentType)} does not match reserved ${JSON.stringify(reservedItem.agentType)} — evidence ignored\n`,
        );
        continue;
      }

      // Cleanup subagent flag. Parse the session id before interpolating it
      // into the SUBAGENT_DIR path (path-traversal guard); an unsafe id could
      // never have named a tracking file, so there is nothing to clean up.
      const safeSessionId = parseSessionId(sessionId);
      if (safeSessionId === null) {
        process.stderr.write(
          `loom: invalid session id ${JSON.stringify(sessionId)} — subagent flag cleanup skipped\n`,
        );
      } else if (!reservedItem) {
        // Compatibility for a result emitted by an older Pi call that predates
        // reservation capture. New calls always release above from authority.
        try {
          const rosterId = piSpawnRosterId(toolCallId, resultIndex, agentType);
          await fsSessionRegistry.removeActive(safeSessionId, rosterId);
        } catch (err) {
          process.stderr.write(`loom: subagent flag cleanup failed: ${(err as Error).message}\n`);
        }
      }

      // Standalone review/refutation results are run artifacts. Short-circuit
      // before StateManager resolution so an unrelated local graph is neither
      // read nor mutated merely because it exists.
      if (reservedItem?.standalone ?? hasStandaloneReviewContext(result.task ?? "")) {
        process.stderr.write(
          piSubagentResultFailed(result)
            ? `loom(pi): failed standalone ${agentType} result ignored — task state untouched\n`
            : `loom(pi): ${agentType} belongs to a standalone review run — task state untouched\n`,
        );
        continue;
      }

      const mgr = StateManager.fromSession(sessionId);
      if (!mgr) {
        if (isLoomOwnedResultAgent(agentType)) {
          process.stderr.write(
            `loom(pi): no task graph for session ${JSON.stringify(sessionId)}; ${agentType} completion was NOT applied\n`,
          );
        }
        continue;
      }

      // A failed process may retain valid-looking assistant text. Never parse
      // that text as completion/review/spec evidence, but do persist the
      // failed CAPTURE for gate-owned agents so a healthy sibling or stale pass
      // cannot make the missing evidence disappear.
      if (piSubagentResultFailed(result)) {
        const failure = `${agentType} failed before evidence capture completed (exitCode=${String(result.exitCode)}, stopReason=${String(result.stopReason ?? "unset")})`;
        if (isReviewAgent(agentType)) {
          const failedTaskId = reservedItem?.taskId ?? extractTaskId(result.task ?? "");
          if (failedTaskId === null || !mgr.load().tasks.some((task) => task.id === failedTaskId)) {
            process.stderr.write(
              `loom(pi): ${failure}; trusted task binding is missing or unknown — review evidence NOT stored\n`,
            );
            continue;
          }
          const resolution = { kind: "evidence-failed" as const, agent: agentType, message: failure };
          await mgr.update((s) => ({
            ...s,
            tasks: s.tasks.map((task) =>
              task.id === failedTaskId ? applyReviewResolution(task, resolution) : task
            ),
          }));
          process.stderr.write(reviewResolutionLog(failedTaskId, resolution) + "\n");
          continue;
        }
        if (agentType === "spec-check-invoker") {
          const runAt = new Date().toISOString();
          await mgr.update((s) => ({
            ...s,
            spec_check: {
              wave: s.current_wave ?? 1,
              run_at: runAt,
              verdict: "EVIDENCE_CAPTURE_FAILED" as const,
              error: failure,
            },
          }));
          process.stderr.write(`loom(pi): ${failure} — marking spec-check evidence_capture_failed\n`);
          continue;
        }
        if (IMPL_AGENTS.has(agentType) && !reservedItem) {
          const failedTaskId = extractTaskId(result.task ?? "");
          if (failedTaskId !== null) {
            await mgr.update((s) => ({
              ...s,
              executing_tasks: (s.executing_tasks ?? []).filter((id) => id !== failedTaskId),
            }));
          }
        }
        process.stderr.write(`loom(pi): ${failure} — completion evidence ignored\n`);
        continue;
      }

      // --- Phase agent → advance phase ---
      const completedPhase = PHASE_AGENT_MAP[agentType];
      if (completedPhase) {
        // Extract spec_file/plan_file from subagent messages (Pi format)
        // Pi messages use { type: "toolCall", name: "write", arguments: { path } }
        try {
          const specDir = mgr.load().spec_dir ?? ".claude/specs";
          for (const msg of (result.messages ?? []) as PiMessage[]) {
            if (msg.role !== "assistant") continue;
            for (const block of msg.content ?? []) {
              if (block.type !== "toolCall" || (block.name !== "write" && block.name !== "Write")) continue;
              const filePath = (block.arguments as Record<string, unknown>)?.path as string
                ?? (block.arguments as Record<string, unknown>)?.file_path as string;
              if (!filePath) continue;
              if (filePath.includes(specDir) && filePath.endsWith("/spec.md")) {
                await mgr.update((s) => ({ ...s, spec_file: filePath }));
              }
              if (filePath.includes(".claude/plans/") && filePath.endsWith(".md")) {
                await mgr.update((s) => ({ ...s, plan_file: filePath }));
              }
            }
          }
        } catch (err) {
          process.stderr.write(`loom: spec/plan extraction failed: ${(err as Error).message}\n`);
        }

        const state = mgr.load();
        const currentIdx = PHASE_ORDER.indexOf(state.current_phase);
        const completedIdx = PHASE_ORDER.indexOf(completedPhase);

        if (!(completedIdx >= 0 && currentIdx > completedIdx)) {
          const transition = resolveTransition(completedPhase, state);
          if (transition) {
            try {
              await mgr.update((s) => ({
                ...s,
                current_phase: transition.nextPhase,
                phase_artifacts: { ...s.phase_artifacts, [completedPhase]: transition.artifact },
                // Also persist spec_file/plan_file if transition found them
                ...(transition.artifact.endsWith("/spec.md") ? { spec_file: transition.artifact } : {}),
                ...(transition.artifact.includes(".claude/plans/") ? { plan_file: transition.artifact } : {}),
                skipped_phases: transition.skipClarify
                  ? ([...new Set([...s.skipped_phases, "clarify" as const])])
                  : s.skipped_phases,
                updated_at: new Date().toISOString(),
              }));
            } catch (err) {
              process.stderr.write(`loom: phase advancement failed: ${(err as Error).message}\n`);
            }
          }
        }
        continue;
      }

      // --- Impl agent → update task status ---
      if (IMPL_AGENTS.has(agentType)) {
        // Extract task ID from the original task prompt (works in parallel mode)
        // Then get transcript from per-result messages for test evidence
        let taskId = reservedItem?.taskId ?? extractTaskId(result.task ?? "") ?? extractTaskId(
          event.content.filter((c: { type: string }) => c.type === "text").map((c: { type: string; text?: string }) => c.text ?? "").join("\n")
        );
        // Parse per-result messages at the untrusted harness boundary before
        // any consumer dereferences their content.
        const parsedMessages = parsePiMessages(result.messages ?? []);

        // Mirrors the engine's update-task-status: an unextractable task ID
        // must not vanish silently. Exactly one executing task → infer it;
        // ambiguous/empty → warn and clear executing_tasks (never mark tasks
        // failed — that cascades into evidence overwrites downstream).
        if (!taskId) {
          const st = mgr.load();
          const executing = st.executing_tasks ?? [];
          if (executing.length === 1) {
            process.stderr.write(
              `WARNING: ${agentType} task ID extraction failed, inferred task ${executing[0]} from executing_tasks\n`,
            );
            taskId = executing[0];
          } else {
            if (executing.length > 0) {
              process.stderr.write(
                `WARNING: ${agentType} completed without task ID, ${executing.length} tasks executing (ambiguous)\n`,
              );
            } else {
              process.stderr.write(
                `WARNING: ${agentType} completed without task ID and executing_tasks is empty — task status was NOT recorded\n`,
              );
            }
            await mgr.update((s) => ({ ...s, executing_tasks: [] }));
            continue;
          }
        }

        // Pre-lock snapshot: needed for start_sha / new_tests_required in the
        // evidence collection below. The skip guards here are only a cheap
        // fast path — the authoritative re-check runs INSIDE the locked
        // update (TOCTOU, see below).
        const state = mgr.load();
        const task = state.tasks.find((t) => t.id === taskId);
        // Evidence collection below needs a live unresolved task. A stopped
        // missing/completed/trusted task still needs locked execution cleanup;
        // skipping it outright leaves a ghost marker forever.
        if (!task || task.status === "completed") {
          await mgr.update((s) => ({
            ...s,
            executing_tasks: (s.executing_tasks ?? []).filter((id) => id !== taskId),
          }));
          process.stderr.write(
            `loom(pi): ${taskId} stopped; preserved completed/missing state and cleared executing_tasks\n`,
          );
          continue;
        }

        // parseBashTestOutput deliberately accepts only paired Bash tool calls
        // and results in Claude-compatible JSONL. Passing flattened prose here
        // silently discards every Pi test run as spoofable free text.
        const adaptedTranscript = parsedMessages.ok
          ? messagesToClaudeJsonl(parsedMessages.value)
          : parsedMessages;
        const structuredEvidence = parsedMessages.ok
          ? piStructuredTestResult(parsedMessages.value)
          : parsedMessages;
        if (!adaptedTranscript.ok || !structuredEvidence.ok || !parsedMessages.ok) {
          const errors = !parsedMessages.ok
            ? parsedMessages.errors
            : !adaptedTranscript.ok
              ? adaptedTranscript.errors
              : !structuredEvidence.ok
                ? structuredEvidence.errors
                : [];
          const failureReason = `Pi transcript evidence capture failed: ${errors.join("; ")}`;
          const root = git.repositoryRoot() ?? process.cwd();
          await mgr.update((current) => {
            const currentTarget = current.tasks.find((candidate) => candidate.id === taskId);
            if (currentTarget === undefined || currentTarget.status === "completed") {
              return {
                ...current,
                executing_tasks: (current.executing_tasks ?? []).filter((id) => id !== taskId),
              };
            }
            let changedArtifacts: readonly string[];
            let bytesChangedSinceAttempt: boolean;
            try {
              changedArtifacts = changedDeclaredArtifactsSince(root, currentTarget.artifact_baseline);
              bytesChangedSinceAttempt = currentTarget.attempt_artifact_baseline === undefined ||
                changedDeclaredArtifactsSince(root, currentTarget.attempt_artifact_baseline).length > 0;
            } catch (error) {
              changedArtifacts = currentTarget.file_list ?? [];
              bytesChangedSinceAttempt = true;
              process.stderr.write(
                `loom(pi): cannot compare malformed-transcript attempt baseline for ${taskId}: ${error instanceof Error ? error.message : String(error)} — invalidating stale evidence\n`,
              );
            }
            if (!bytesChangedSinceAttempt) {
              return {
                ...current,
                executing_tasks: (current.executing_tasks ?? []).filter((id) => id !== taskId),
                tasks: current.tasks.map((candidate) =>
                  candidate.id === taskId && candidate.status === "pending"
                    ? { ...candidate, failure_reason: failureReason }
                    : candidate
                ),
              };
            }
            return applyUntrustedStopResolution(current, taskId, {
              taskCompleted: false,
              testResult: { verdict: "untrusted", passed: false, label: "pi-transcript-capture-failed" },
              testEvidence: failureReason,
              filesModified: [],
              changedDeclaredArtifacts: changedArtifacts,
              bytesChangedSinceAttempt,
              newTestsWritten: false,
              newTestEvidence: "",
            }).state;
          });
          process.stderr.write(`loom(pi): ${failureReason} — ${taskId} evidence was not accepted\n`);
          continue;
        }
        const resultMessages = parsedMessages.value;
        const bashOutput = parseBashTestOutput(adaptedTranscript.value);
        const transcriptEvidence = extractTestEvidence(bashOutput);
        const structuredTestEvidence = structuredEvidence.value;
        const testEvidence = structuredTestEvidence ?? transcriptEvidence;

        // files_modified feeds lint-wave-gate's target collection (it
        // collects lint targets EXCLUSIVELY from tasks' files_modified) —
        // parse it from the per-result messages, re-encoded as the pi-format
        // JSONL parseFilesModified's pi branch reads, so the pi path
        // persists the same field the engine path does (round-16 fix: the
        // omission made every wave-gate lint under pi run over an empty set).
        const piJsonl = resultMessages
          .map((m) => JSON.stringify({ type: "message", message: m }))
          .join("\n");
        const rawFilesModified = parseFilesModified(piJsonl, "pi");
        let filesModified: readonly string[];
        try {
          filesModified = canonicalRepositoryPaths(
            git.repositoryRoot() ?? process.cwd(),
            rawFilesModified,
            "Pi transcript files_modified",
          );
        } catch (error) {
          await mgr.update((s) => ({
            ...s,
            executing_tasks: (s.executing_tasks ?? []).filter((id) => id !== taskId),
          }));
          process.stderr.write(
            `loom(pi): unsafe modified-file evidence for ${taskId}: ${error instanceof Error ? error.message : String(error)} — task left pending\n`,
          );
          continue;
        }

        let changedArtifacts: readonly string[];
        let bytesChangedSinceAttempt: boolean;
        try {
          const root = git.repositoryRoot() ?? process.cwd();
          changedArtifacts = changedDeclaredArtifactsSince(root, task.artifact_baseline);
          const attemptBaselinePaths = new Set(
            task.attempt_artifact_baseline?.map(({ artifact }) => artifact) ?? [],
          );
          bytesChangedSinceAttempt = task.attempt_artifact_baseline === undefined ||
            changedDeclaredArtifactsSince(root, task.attempt_artifact_baseline).length > 0 ||
            filesModified.some((path) => !attemptBaselinePaths.has(path));
        } catch (error) {
          await mgr.update((s) => ({
            ...s,
            executing_tasks: (s.executing_tasks ?? []).filter((id) => id !== taskId),
          }));
          process.stderr.write(
            `loom(pi): cannot compare declared-artifact baseline for ${taskId}: ${error instanceof Error ? error.message : String(error)} — task left pending\n`,
          );
          continue;
        }

        // Atomic state write. The completed/trusted-verdict guards above ran
        // on a PRE-LOCK snapshot that a concurrent writer can outdate before
        // this write lands (TOCTOU) — so the decision runs INSIDE the locked
        // update via the shared pure applyUntrustedStopResolution (engine's
        // update-task-status module), which re-finds and re-checks the target.
        // The incoming resolution is ALWAYS untrusted here, so an existing
        // trusted verdict (or a completed task) always stands.
        const resolvedTaskId = taskId;
        let skippedExistingVerdict = false;
        await mgr.update((s) => {
          const currentTarget = s.tasks.find((candidate) => candidate.id === resolvedTaskId);
          const cumulativeFiles = cumulativeModifiedPaths(currentTarget?.files_modified, filesModified);
          const newTestEvidence = git.isGitRepo()
            ? collectNewTestEvidence(
                cumulativeFiles,
                currentTarget?.new_tests_required,
              )
            : { written: false, evidence: "" };
          const applied = applyUntrustedStopResolution(s, resolvedTaskId, {
            taskCompleted: true,
            // Pi has no Loom evidence ledger. Preserve the real provenance:
            // paired tool-result evidence may discharge Pi's structured proof
            // policy; flattened transcript output may not.
            testResult: {
              verdict: "untrusted" as const,
              passed: testEvidence.passed,
              label: structuredTestEvidence !== null
                ? `pi-structured: ${structuredTestEvidence.evidence || "test tool result"}`
                : "transcript-regex (fallback)",
            },
            testEvidence: testEvidence.evidence,
            filesModified,
            changedDeclaredArtifacts: changedArtifacts,
            bytesChangedSinceAttempt,
            newTestsWritten: newTestEvidence.written,
            newTestEvidence: newTestEvidence.evidence,
          });
          skippedExistingVerdict = applied.skipped;
          // applyUntrustedStopResolution reconciles impl_complete in both
          // directions in the same locked state transition as the proof.
          return applied.state;
        });

        if (skippedExistingVerdict) {
          process.stderr.write(
            `loom(pi): ${taskId} is completed or carries a trusted verdict this untrusted resolution cannot supersede — leaving it untouched\n`,
          );
        }
        continue;
      }

      // --- Review agent → store findings ---
      if (isReviewAgent(agentType)) {
        const taskId = reservedItem?.taskId ?? extractTaskId(result.task ?? "") ?? extractTaskId(
          event.content.filter((c: { type: string }) => c.type === "text").map((c: { type: string; text?: string }) => c.text ?? "").join("\n")
        );
        const resultMessages = (result.messages ?? []) as PiMessage[];
        const transcriptText = resultMessages
          .filter((m: PiMessage) => m.role === "assistant" || m.role === "toolResult")
          .flatMap((m: PiMessage) => (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? ""))
          .join("\n");
        if (!taskId) {
          // A review whose task ID is unextractable stores nothing — its
          // findings silently never gate the wave. Say so instead of
          // vanishing (review agents don't sit in executing_tasks, so there
          // is no inference to fall back on).
          process.stderr.write(
            `WARNING: ${agentType} review completed without an extractable task ID — findings NOT stored\n`,
          );
          continue;
        }

        // `tasks.map` over an id no task holds is a total no-op, and the log
        // below asserts the findings were stored regardless. `extractTaskId`
        // falls back to any standalone `T\d+` in the transcript, so a reviewer
        // quoting an unrelated id resolves to a task the graph does not have —
        // and that reviewer's criticals were discarded while stderr reported
        // them recorded. Both harnesses guard it, or they drift.
        const reviewTask = mgr.load().tasks.find((t: { id: string }) => t.id === taskId);
        if (!reviewTask) {
          process.stderr.write(
            `WARNING: ${agentType} review names task ${taskId}, which is not in the task graph — findings NOT stored\n`,
          );
          continue;
        }

        // Identical decision + transform as the Claude Code SubagentStop hook —
        // one shared implementation, so findings cannot have identity on one
        // harness and not the other. Scope is the Review Packet's canonical
        // declared/observed file union.
        const resolution = constrainReviewResolutionToScope(
          resolveTaskReviewFindings(
            transcriptText,
            agentType,
            reviewTask.review_run,
            reviewTask.review_generation,
          ),
          [...(reviewTask.file_list ?? []), ...(reviewTask.files_modified ?? [])],
        );
        let appliedTask = reviewTask;
        let applicationChanged = false;
        await mgr.update((s) => ({
          ...s,
          tasks: s.tasks.map((t) => {
            if (t.id !== taskId) return t;
            appliedTask = applyReviewResolution(t, resolution);
            applicationChanged = appliedTask !== t;
            return appliedTask;
          }),
        }));
        process.stderr.write(
          reviewResolutionLog(taskId, resolution, appliedTask, applicationChanged) + "\n",
        );
        continue;
      }

      // --- Spec-check invoker → store spec-check findings ---
      if (agentType === "spec-check-invoker") {
        const resultMessages = (result.messages ?? []) as PiMessage[];
        const transcriptText = resultMessages
          .filter((m: PiMessage) => m.role === "assistant" || m.role === "toolResult")
          .flatMap((m: PiMessage) => (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? ""))
          .join("\n");

        const findings = parseSpecCheckOutput(transcriptText);
        const state = mgr.load();
        const wave = findings.wave ?? state.current_wave ?? 1;

        const resolution = reconcileSpecCheck(findings, wave, new Date().toISOString());
        if (resolution.kind === "evidence-failed") {
          process.stderr.write(
            `loom(pi): ${resolution.specCheck.error} — marking spec-check evidence_capture_failed\n`,
          );
          await mgr.update((s) => ({ ...s, spec_check: resolution.specCheck }));
          continue;
        }

        await mgr.update((s) => {
          const updated = { ...s, spec_check: resolution.specCheck };
          if (resolution.specCheck.critical_count > 0) {
            const waveKey = String(wave);
            updated.wave_gates = {
              ...s.wave_gates,
              [waveKey]: {
                ...(s.wave_gates[waveKey] ?? newWaveGate()),
                blocked: true,
              },
            };
          }
          return updated;
        });
        continue;
      }
      } catch (err) {
        // Loud + isolated: name the agent, the task (best effort), and the
        // cause, then continue with the next result.
        let taskIdForLog = "<unknown>";
        try {
          taskIdForLog = extractTaskId(result?.task ?? "") ?? "<unknown>";
        } catch {
          /* best-effort only — the log line must never throw */
        }
        process.stderr.write(
          `loom(pi): subagent-stop processing failed for agent ${String(result?.agent ?? "<unknown>")} (task ${taskIdForLog}): ${err instanceof Error ? err.message : String(err)} — continuing with remaining results\n`,
        );
      }
    }
  });

  // ─── Commands ─────────────────────────────────────────────────────────

  pi.registerCommand("loom-status", {
    description: "Show current loom orchestration status",
    handler: async (_args, ctx) => {
      const activeTaskGraphPath = taskGraphPath();
      if (!existsSync(activeTaskGraphPath)) {
        ctx.ui.notify("No active loom orchestration", "info");
        return;
      }

      const sm = StateManager.fromPath(activeTaskGraphPath);
      if (!sm) {
        ctx.ui.notify("Could not load task graph", "error");
        return;
      }

      try {
        const state = sm.load();
        const totalTasks = state.tasks.length;
        const completed = state.tasks.filter(t => t.status === "completed").length;
        const failed = state.tasks.filter(t => t.status === "failed").length;
        const pending = state.tasks.filter(t => t.status === "pending").length;

        ctx.ui.notify(
          [
            `Phase: ${state.current_phase}`,
            `Wave: ${state.current_wave ?? 1}`,
            `Tasks: ${completed}/${totalTasks} done, ${pending} pending, ${failed} failed`,
            state.github_issue ? `Issue: #${state.github_issue}` : "",
          ].filter(Boolean).join(" | "),
          "info",
        );
      } catch (e) {
        ctx.ui.notify(`Error: ${(e as Error).message}`, "error");
      }
    },
  });
}
