/**
 * Loom Pi Extension
 *
 * Bridges loom's orchestration engine to pi's extension API.
 * Delegates to engine/src/core/ for all business logic.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, unlinkSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType, parseFrontmatter } from "@earendil-works/pi-coding-agent";

// Engine core — pure functions, no Claude Code dependency
import { shouldBlockDirectEdit } from "../engine/src/core/block-direct-edits";
import { guardStateFile } from "../engine/src/core/guard-state-file";
import { validatePhaseOrder } from "../engine/src/core/validate-phase-order";
import { validateTaskExecution } from "../engine/src/core/validate-task-execution";
import { validateTemplateSubstitution } from "../engine/src/core/validate-template-substitution";

// Engine parsers (format-aware)
import { parseTranscript } from "../engine/src/parsers/parse-transcript";
import { parseFilesModified } from "../engine/src/parsers/parse-files-modified";
import { parseBashTestOutput } from "../engine/src/parsers/parse-bash-test-output";
import { parsePhaseArtifacts } from "../engine/src/parsers/parse-phase-artifacts";

// Engine SubagentStop logic (pure functions already exported)
import { extractTestEvidence, analyzeNewTests } from "../engine/src/handlers/subagent-stop/update-task-status";
import { resolveTransition } from "../engine/src/handlers/subagent-stop/advance-phase";
import {
  isReviewAgent, parseMachineSummary, parseLegacyFindings,
  reconcileFindings, mergeFindings, buildEvidenceFailureMessage,
} from "../engine/src/handlers/subagent-stop/store-reviewer-findings";
import { parseSpecCheckOutput } from "../engine/src/handlers/subagent-stop/store-spec-check-findings";
import type { ReviewStatus, SpecCheck, Phase } from "../engine/src/types";

import { TASK_GRAPH_PATH, SUBAGENT_DIR, HARNESS, PHASE_AGENT_MAP, IMPL_AGENTS, PHASE_ORDER, PROJECT_RULES_DIR, STALE_SUBAGENT_TTL_MS } from "../engine/src/config";
import { sweepStaleSessions } from "../engine/src/handlers/session-start/cleanup-stale-subagents";
import { StateManager } from "../engine/src/state-manager";
import { fsSessionRegistry, parseSessionId } from "../engine/src/machine";
import { buildContextOutput } from "../engine/src/handlers/session-start/resume-after-clear";
import { stripNamespace } from "../engine/src/utils/strip-namespace";
import { extractTaskId } from "../engine/src/utils/extract-task-id";
import * as git from "../engine/src/utils/git";

// Linter integration (PostEdit lint via tool_result)
import { processToolResult } from "../engine/src/handlers/pi-adapter";
import { lintFile } from "../engine/src/linter/index";
import type { PiMessage } from "./loom-bridge";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const AGENTS_DIR = join(PACKAGE_ROOT, "agents");
const SKILLS_DIR = join(PACKAGE_ROOT, "skills");

export default function (pi: ExtensionAPI) {
  // ─── Resource Discovery ───────────────────────────────────────────────
  // Contribute skills from this package that aren't in the pi manifest's
  // auto-discovery (the manifest covers skills/ and commands/ already,
  // but we also register agents dir for the subagent tool).

  // Resource paths handled by package.json "pi" manifest.
  // Only register paths NOT covered there.
  // pi.on("resources_discover", () => ({ ... }));

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
      if (isToolCallEventType("edit", event) || isToolCallEventType("write", event)) {
        currentGuard = "block-direct-edits";
        const result = shouldBlockDirectEdit(event.toolName, sessionId);
        if (result.kind === "block") {
          return { block: true, reason: result.message };
        }
      }

      // Guard state file from bash writes
      if (isToolCallEventType("bash", event)) {
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

      // Subagent tool → phase and task validation
      if (event.toolName === "subagent") {
        const agent = (event.input as Record<string, unknown>).agent as string | undefined;
        const task = (event.input as Record<string, unknown>).task as string | undefined;

        if (agent && task) {
          // Phase order validation
          currentGuard = "validate-phase-order";
          const phaseResult = validatePhaseOrder({
            agentType: agent,
            prompt: task,
          });
          if (phaseResult.kind === "block") {
            return { block: true, reason: phaseResult.message };
          }

          // Template substitution check
          currentGuard = "validate-template-substitution";
          const templateResult = validateTemplateSubstitution(task);
          if (templateResult.kind === "block") {
            return { block: true, reason: templateResult.message };
          }

          // Task execution validation (wave order, deps, review gates)
          currentGuard = "validate-task-execution";
          const taskResult = await validateTaskExecution({
            prompt: task,
            description: (event.input as Record<string, unknown>).description as string ?? "",
          });
          if (taskResult.kind === "block") {
            return { block: true, reason: taskResult.message };
          }

          // Mark subagent active (equivalent of SubagentStart hook).
          // Parse the session id before interpolating it into SUBAGENT_DIR paths
          // — a raw id with a separator/`..`/whitespace could address files
          // outside the subagent dir. Stand down loudly on an unsafe id, mirroring
          // the engine's record-evidence boundary.
          currentGuard = "subagent-tracking";
          const safeSessionId = parseSessionId(sessionId);
          if (safeSessionId === null) {
            process.stderr.write(
              `loom: invalid session id ${JSON.stringify(sessionId)} — subagent tracking skipped\n`,
            );
          } else {
            try {
              mkdirSync(SUBAGENT_DIR, { recursive: true, mode: 0o700 });
              appendFileSync(`${SUBAGENT_DIR}/${safeSessionId}.active`, `${agent}\n`);
              if (existsSync(TASK_GRAPH_PATH)) {
                const taskGraphFile = `${SUBAGENT_DIR}/${safeSessionId}.task_graph`;
                if (!existsSync(taskGraphFile)) {
                  writeFileSync(taskGraphFile, resolve(TASK_GRAPH_PATH));
                }
              }
            } catch (err) {
              process.stderr.write(`loom: subagent tracking write failed: ${(err as Error).message}\n`);
            }
          }
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
    if (!details) return;

    // Shape guard: a pi version drifting details.results away from an array
    // must be a LOUD no-op, not a silent one (or a throw mid-dispatch).
    const rawResults = details.results ?? [];
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

    for (const result of results) {
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
          const activeFile = `${SUBAGENT_DIR}/${safeSessionId}.active`;
          if (existsSync(activeFile)) unlinkSync(activeFile);
        } catch (err) {
          process.stderr.write(`loom: subagent flag cleanup failed: ${(err as Error).message}\n`);
        }
      }

      const mgr = StateManager.fromSession(sessionId);
      if (!mgr) continue;

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
              if (filePath.includes(".claude/specs/") && filePath.endsWith("/spec.md")) {
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
            }
            await mgr.update((s) => ({ ...s, executing_tasks: [] }));
            continue;
          }
        }

        const state = mgr.load();
        const task = state.tasks.find((t) => t.id === taskId);
        if (!task || task.status === "completed") continue;
        // Trust-aware skip (mirrors update-task-status): a trusted verdict is
        // preserved only against an UNTRUSTED incoming resolution — newer
        // ground truth supersedes older. pi has no evidence ledger, so this
        // handler's resolution is ALWAYS untrusted (see below): the rule
        // degenerates to "never overwrite a trusted verdict here".
        const priorVerdict = task.test_result?.verdict;
        if (priorVerdict === "trusted-pass" || priorVerdict === "trusted-fail") continue;

        const bashOutput = parseBashTestOutput(transcriptText);
        const testEvidence = extractTestEvidence(bashOutput);

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

        await mgr.update((s) => ({
          ...s,
          tasks: s.tasks.map((t) =>
            t.id === taskId
              ? {
                  ...t,
                  status: "implemented" as const,
                  // pi has no evidence ledger — transcript regex is the only
                  // source here, so the verdict is always untrusted+labeled.
                  test_result: {
                    verdict: "untrusted" as const,
                    passed: testEvidence.passed,
                    label: "transcript-regex (fallback)",
                  },
                  test_evidence: testEvidence.evidence,
                  new_tests_written: newTestEvidence.written,
                  new_test_evidence: newTestEvidence.evidence,
                }
              : t
          ),
          executing_tasks: (s.executing_tasks ?? []).filter((id) => id !== taskId),
        }));

        // Check wave completion
        const updated = mgr.load();
        const currentWave = updated.current_wave ?? 1;
        const waveComplete = !updated.tasks
          .filter((t) => t.wave === currentWave)
          .some((t) => t.status !== "implemented" && t.status !== "completed");

        if (waveComplete) {
          await mgr.update((s) => ({
            ...s,
            wave_gates: {
              ...s.wave_gates,
              [String(currentWave)]: {
                ...(s.wave_gates[String(currentWave)] ?? { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false }),
                impl_complete: true,
              },
            },
          }));
        }
        continue;
      }

      // --- Review agent → store findings ---
      if (isReviewAgent(agentType)) {
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

        const findings = parseMachineSummary(transcriptText) ?? parseLegacyFindings(transcriptText);

        if (findings.criticalCount === null) {
          const errorMsg = buildEvidenceFailureMessage(findings);
          await mgr.update((s) => ({
            ...s,
            tasks: s.tasks.map((t) =>
              t.id === taskId
                ? { ...t, review_status: "evidence_capture_failed" as const, review_error: errorMsg }
                : t
            ),
          }));
          continue;
        }

        const reconciled = reconcileFindings(findings);
        await mgr.update((s) => ({
          ...s,
          tasks: s.tasks.map((t) => t.id === taskId ? mergeFindings(t, reconciled) : t),
        }));
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

        if (findings.criticalCount === null) {
          await mgr.update((s) => ({
            ...s,
            spec_check: {
              wave,
              run_at: new Date().toISOString(),
              verdict: "EVIDENCE_CAPTURE_FAILED",
              error: "SPEC_CHECK_CRITICAL_COUNT marker not found - re-run /wave-gate",
            },
          }));
          continue;
        }

        const specCheck: SpecCheck = {
          wave,
          run_at: new Date().toISOString(),
          critical_count: findings.criticalCount,
          high_count: findings.highCount ?? 0,
          critical_findings: findings.critical,
          high_findings: findings.high,
          medium_findings: findings.medium,
          verdict: findings.verdict ?? "UNKNOWN",
        };

        await mgr.update((s) => {
          const updated = { ...s, spec_check: specCheck };
          if (findings.criticalCount! > 0) {
            const waveKey = String(wave);
            updated.wave_gates = {
              ...s.wave_gates,
              [waveKey]: {
                ...(s.wave_gates[waveKey] ?? { impl_complete: false, tests_passed: null, reviews_complete: false, blocked: false }),
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
