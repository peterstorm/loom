/**
 * Loom Pi Extension
 *
 * Bridges loom's orchestration engine to pi's extension API.
 * Delegates to engine/src/core/ for all business logic.
 */

import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync, unlinkSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Engine core — harness-agnostic, no Claude Code dependency (these do fs I/O)
import { shouldBlockDirectEdit } from "../engine/src/core/block-direct-edits";
import { guardStateFile } from "../engine/src/core/guard-state-file";
import { validatePhaseOrder } from "../engine/src/core/validate-phase-order";
import { validateTaskExecutionBatch } from "../engine/src/core/validate-task-execution";
import { validateTemplateSubstitution } from "../engine/src/core/validate-template-substitution";
import { classifyPiSpawnItems, expectedSpawnModel } from "../engine/src/core/model-profiles";


// Engine parsers (format-aware)
import { parseFilesModified } from "../engine/src/parsers/parse-files-modified";
import { parseBashTestOutput } from "../engine/src/parsers/parse-bash-test-output";

// Engine SubagentStop logic (harness-agnostic functions already exported)
import { extractTestEvidence, analyzeNewTests, applyUntrustedStopResolution, isWaveComplete } from "../engine/src/handlers/subagent-stop/update-task-status";
import { resolveTransition } from "../engine/src/handlers/subagent-stop/advance-phase";
import {
  hasStandaloneReviewContext, resolveReviewFindings, applyReviewResolution, reviewResolutionLog,
} from "../engine/src/core/review-output";
import { parseSpecCheckOutput, reconcileSpecCheck } from "../engine/src/core/spec-check";
import type { ReviewStatus, Phase } from "../engine/src/types";
import { newWaveGate } from "../engine/src/types";

// `isReviewAgent` lives in `config`, NOT in `core/review-output` beside the three
// functions above it: it reads the review-agent roster, and `core/review-output`
// declares itself free of config so its parse/merge rules stay pure. Importing it
// from the wrong module is a LINK-time ESM failure that takes the whole extension
// with it — every hook below, not just review capture. `tests/pi-imports.test.ts`
// resolves every engine import in this file against the real exports so the next
// move of a shared symbol fails a test instead of silently disarming Pi.
import { isReviewAgent, TASK_GRAPH_PATH, SUBAGENT_DIR, PHASE_AGENT_MAP, IMPL_AGENTS, PHASE_ORDER, PROJECT_RULES_DIR, STALE_SUBAGENT_TTL_MS } from "../engine/src/config";
import { sweepStaleSessions } from "../engine/src/handlers/session-start/cleanup-stale-subagents";
import { StateManager } from "../engine/src/state-manager";
import { fsSessionRegistry, parseSessionId, rosterAgentId } from "../engine/src/machine";
import { buildContextOutput } from "../engine/src/handlers/session-start/resume-after-clear";
import { stripNamespace } from "../engine/src/utils/strip-namespace";
import { extractTaskId } from "../engine/src/utils/extract-task-id";
import * as git from "../engine/src/utils/git";

// Linter integration (PostEdit lint via tool_result)
import { processToolResult } from "../engine/src/handlers/pi-adapter";
import { lintFile } from "../engine/src/linter/index";
import { messagesToClaudeJsonl, piStructuredTestResult, type PiMessage } from "./transcript-adapter";
import { materializePiResources } from "./resources";
import { checkAgentSkillPrompt } from "../engine/src/core/agent-skills";
import { validatePiAgentDefinitionFile } from "../engine/src/utils/render-pi-agent";
import { canonicalRepositoryPaths } from "../engine/src/utils/repository-path";
import { changedDeclaredArtifactsSince } from "../engine/src/utils/artifact-baseline";
import { attributedChangedArtifacts } from "../engine/src/core/artifact-baseline";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const PI_RESOURCE_CACHE = join(PI_AGENT_DIR, "cache", "loom-resources");

const isLoomOwnedResultAgent = (agentType: string): boolean =>
  PHASE_AGENT_MAP[agentType] !== undefined ||
  IMPL_AGENTS.has(agentType) ||
  isReviewAgent(agentType) ||
  agentType === "spec-check-invoker";

/** Stable per-spawn roster identity shared by tool_call and tool_result. */
export const piSpawnRosterId = (
  toolCallId: unknown,
  index: number,
  agent: string,
  task: string,
) => rosterAgentId(JSON.stringify([
  typeof toolCallId === "string" ? toolCallId : "",
  index,
  agent,
  task,
]));

export default function (pi: ExtensionAPI) {
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
      if (event.toolName === "edit" || event.toolName === "write") {
        currentGuard = "block-direct-edits";
        const result = shouldBlockDirectEdit(event.toolName, sessionId);
        if (result.kind === "block") {
          return { block: true, reason: result.message };
        }
      }

      // Guard state file from bash writes
      if (event.toolName === "bash") {
        currentGuard = "guard-state-file";
        const result = guardStateFile(event.input.command ?? "");
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
          if (existsSync(TASK_GRAPH_PATH)) {
            return {
              block: true,
              reason: "External Pi subagents cannot run while a Loom task graph is active",
            };
          }
          return;
        }
        const parsedItems = classifiedItems.value.items;

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
        const rosterIds = parsedItems.map((item, index) =>
          piSpawnRosterId(toolCallId, index, item.agent, item.task),
        );
        const reserved: Array<(typeof rosterIds)[number]> = [];
        let taskGraphPointerCreated = false;
        const rollbackLifecycle = async (): Promise<void> => {
          for (const agentId of [...reserved].reverse()) {
            await fsSessionRegistry.removeActive(safeSessionId, agentId);
          }
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
          if (existsSync(TASK_GRAPH_PATH)) {
            const taskGraphFile = `${SUBAGENT_DIR}/${safeSessionId}.task_graph`;
            if (!existsSync(taskGraphFile)) {
              writeFileSync(taskGraphFile, resolve(TASK_GRAPH_PATH));
              taskGraphPointerCreated = true;
            }
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
          taskResult = await validateTaskExecutionBatch(
            parsedItems.map((item) => ({ prompt: item.task, description: "" })),
          );
        } catch (error) {
          await rollbackLifecycle();
          throw error;
        }
        if (taskResult.kind === "block") {
          await rollbackLifecycle();
          return { block: true, reason: taskResult.message };
        }
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
  });

  // ─── Resume Context (before_agent_start) ──────────────────────────────
  // If there's an active task graph in execute phase, inject context
  // so the LLM knows where we are (equivalent of resume-after-clear).

  pi.on("before_agent_start", async (_event, _ctx) => {
    if (!existsSync(TASK_GRAPH_PATH)) return;

    const sm = StateManager.fromPath(TASK_GRAPH_PATH);
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

    const details = event.details as Record<string, unknown> | undefined;
    if (!details || !("results" in details)) {
      process.stderr.write(
        "loom(pi): subagent tool_result is missing details.results — no task status or findings updated\n",
      );
      return;
    }

    // Shape guard: a pi version drifting details.results away from an array
    // must be a LOUD no-op, not a silent one (or a throw mid-dispatch).
    const rawResults = details.results;
    if (!Array.isArray(rawResults)) {
      process.stderr.write(
        `loom(pi): subagent tool_result has unrecognized details.results shape (${typeof rawResults}) — no task status updated\n`,
      );
      return;
    }
    const results = rawResults as Array<{
      agent: string;
      task: string;
      exitCode: number;
      messages: unknown[];
    }>;

    for (const [resultIndex, result] of results.entries()) {
      // Per-result error isolation (mirrors dispatch.ts's safeRun): a throw
      // while processing result #1 must not abort results #2..N — that
      // leaves tasks stuck "executing" with zero diagnostics.
      try {
      const agentType = stripNamespace(result.agent);
      const sessionId = _ctx.sessionManager.getSessionId() ?? "unknown";

      // Cleanup subagent flag. Parse the session id before interpolating it
      // into the SUBAGENT_DIR path (path-traversal guard); an unsafe id could
      // never have named a tracking file, so there is nothing to clean up.
      const safeSessionId = parseSessionId(sessionId);
      if (safeSessionId === null) {
        process.stderr.write(
          `loom: invalid session id ${JSON.stringify(sessionId)} — subagent flag cleanup skipped\n`,
        );
      } else {
        try {
          const toolCallId = (event as { toolCallId?: unknown }).toolCallId;
          const rosterId = piSpawnRosterId(toolCallId, resultIndex, agentType, result.task ?? "");
          await fsSessionRegistry.removeActive(safeSessionId, rosterId);
        } catch (err) {
          process.stderr.write(`loom: subagent flag cleanup failed: ${(err as Error).message}\n`);
        }
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
        let taskId = extractTaskId(result.task ?? "") ?? extractTaskId(
          event.content.filter((c: { type: string }) => c.type === "text").map((c: { type: string; text?: string }) => c.text ?? "").join("\n")
        );
        // Build transcript from per-result messages (each parallel result has its own messages)
        const resultMessages = (result.messages ?? []) as PiMessage[];
        const transcriptText = resultMessages
          .filter((m: PiMessage) => m.role === "assistant" || m.role === "toolResult")
          .flatMap((m: PiMessage) => (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? ""))
          .join("\n");

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
        const priorVerdict = task?.test_result?.verdict;
        if (
          !task || task.status === "completed" ||
          priorVerdict === "trusted-pass" || priorVerdict === "trusted-fail"
        ) {
          await mgr.update((s) => ({
            ...s,
            executing_tasks: (s.executing_tasks ?? []).filter((id) => id !== taskId),
          }));
          process.stderr.write(
            `loom(pi): ${taskId} stopped; preserved existing state and cleared executing_tasks\n`,
          );
          continue;
        }

        // parseBashTestOutput deliberately accepts only paired Bash tool calls
        // and results in Claude-compatible JSONL. Passing flattened prose here
        // silently discards every Pi test run as spoofable free text.
        const bashOutput = parseBashTestOutput(messagesToClaudeJsonl(resultMessages));
        const transcriptEvidence = extractTestEvidence(bashOutput);
        const structuredEvidence = piStructuredTestResult(resultMessages);
        const testEvidence = structuredEvidence ?? transcriptEvidence;

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

        let proofArtifactsChanged: readonly string[];
        try {
          proofArtifactsChanged = attributedChangedArtifacts(
            changedDeclaredArtifactsSince(
              git.repositoryRoot() ?? process.cwd(),
              task.artifact_baseline,
            ),
            filesModified,
          );
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

        let newTestEvidence = { written: false, evidence: "" };
        if (git.isGitRepo()) {
          // Collect diff: prefer start_sha-based, fall back to untracked test files
          let diff = "";
          if (task.start_sha) {
            diff = git.diff(task.start_sha, "HEAD");
          }
          // Also include untracked test files (agents create new files without committing)
          const untrackedTests = git.listUntrackedTestFiles();
          for (const f of untrackedTests) {
            diff += "\n" + git.diffUntracked(f);
          }
          if (diff.trim()) {
            newTestEvidence = analyzeNewTests(diff, task.new_tests_required);
          }
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
          const applied = applyUntrustedStopResolution(s, resolvedTaskId, {
            // Pi has no Loom evidence ledger. Preserve the real provenance:
            // paired tool-result evidence may discharge Pi's structured proof
            // policy; flattened transcript output may not.
            testResult: {
              verdict: "untrusted" as const,
              passed: testEvidence.passed,
              label: structuredEvidence
                ? `pi-structured: ${structuredEvidence.evidence || "test tool result"}`
                : "transcript-regex (fallback)",
            },
            testEvidence: testEvidence.evidence,
            filesModified,
            proofArtifactsChanged,
            newTestsWritten: newTestEvidence.written,
            newTestEvidence: newTestEvidence.evidence,
          });
          skippedExistingVerdict = applied.skipped;
          if (applied.skipped) return applied.state;
          // Wave completion is decided INSIDE the same locked update the
          // resolution landed in (the old post-update load raced concurrent
          // writers), via the shared pure predicate the engine's
          // update-task-status also uses.
          const currentWave = applied.state.current_wave ?? 1;
          if (!isWaveComplete(applied.state, currentWave)) return applied.state;
          return {
            ...applied.state,
            wave_gates: {
              ...applied.state.wave_gates,
              [String(currentWave)]: {
                ...(applied.state.wave_gates[String(currentWave)] ?? newWaveGate()),
                impl_complete: true,
              },
            },
          };
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
        if (hasStandaloneReviewContext(result.task ?? "")) {
          process.stderr.write(`loom(pi): ${agentType} belongs to a standalone review run — task state untouched\n`);
          continue;
        }
        const taskId = extractTaskId(result.task ?? "") ?? extractTaskId(
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
        if (!mgr.load().tasks.some((t: { id: string }) => t.id === taskId)) {
          process.stderr.write(
            `WARNING: ${agentType} review names task ${taskId}, which is not in the task graph — findings NOT stored\n`,
          );
          continue;
        }

        // Identical decision + transform as the Claude Code SubagentStop hook —
        // one shared implementation, so findings cannot have identity on one
        // harness and not the other.
        const resolution = resolveReviewFindings(transcriptText, agentType);
        await mgr.update((s) => ({
          ...s,
          tasks: s.tasks.map((t) => (t.id === taskId ? applyReviewResolution(t, resolution) : t)),
        }));
        process.stderr.write(reviewResolutionLog(taskId, resolution) + "\n");
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
      if (!existsSync(TASK_GRAPH_PATH)) {
        ctx.ui.notify("No active loom orchestration", "info");
        return;
      }

      const sm = StateManager.fromPath(TASK_GRAPH_PATH);
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
