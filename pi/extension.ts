/**
 * Loom Pi Extension
 *
 * Bridges Loom's orchestration engine to Pi's extension API. This module is
 * the Pi registration shell: it wires the harness events to the engine core
 * decisions and to the Pi adapter modules beside it, and owns only the
 * per-process session state those handlers share.
 *
 * - `spawn-preparation` — the ordered observe → expand → admit pipeline
 * - `spawn-lifecycle` — reservation of an admitted batch before dispatch
 * - `subagent-stop` — settlement of a completed batch (`tool_result`)
 * - `child-write-grant` — a child's write capability and its rejection
 * - `session-shutdown` — release of every capability a session still holds
 * - `emission-readiness` — the in-child launcher readiness barrier
 * - `tool-input` — tool-call payload readers, the spawn task writer, roster ids
 * - `emission-launch-bridge` — the installed subagent launcher port
 * - `review-run-authority` — request-bound run authority and review witnesses
 * - `review-capture` — capture of one request-bound result
 * - `spawn-reservation` — the parent session's reservations and cleanup debt
 * - `cleanup-actions` — best-effort cleanup and startup hygiene
 */

import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Engine core — harness-agnostic, no Claude Code dependency (these do fs I/O)
import { shouldBlockDirectEdit } from "../engine/src/core/block-direct-edits";
// The roster read the direct-edit gate needs. It lives in the handler rather
// than in core/ because core may not import the machine's filesystem shell;
// Pi passes the same adapter Claude Code's wrapper does, so both harnesses
// authorize `pi-grant-` capability tokens off the SAME roster.
import { activeRosterProbe } from "../engine/src/handlers/pre-tool-use/block-direct-edits";
import { guardStateFileDecision } from "../engine/src/core/guard-state-file";
import { validatePhaseOrder } from "../engine/src/core/validate-phase-order";
// Both harnesses share ONE protected-state read seam, so a Pi gate and a
// Claude gate cannot disagree about what "no active plan" means.
import { realPhaseOrderDeps } from "../engine/src/handlers/pre-tool-use/validate-phase-order";
import { validateTemplateSubstitution } from "../engine/src/core/validate-template-substitution";
import { admitPiSpawnBatch } from "../engine/src/core/spawn-admission";

import { taskGraphPath, subagentDir, PROJECT_RULES_DIR, STALE_SUBAGENT_TTL_MS, probePathFailClosed } from "../engine/src/config";
import { sweepStaleSessions } from "../engine/src/handlers/session-start/cleanup-stale-subagents";
import { StateManager } from "../engine/src/state-manager";
import { currentOrchestrationStatus } from "../engine/src/handlers/helpers/orchestration";
import { fsSessionRegistry, parseSessionId } from "../engine/src/machine";
import { buildContextOutput } from "../engine/src/handlers/session-start/resume-after-clear";

// Linter integration (PostEdit lint via tool_result)
import { processToolResult } from "../engine/src/handlers/pi-adapter";
import { lintFile } from "../engine/src/linter/index";
import { publishLoomReviewAuthorityBridge } from "../engine/src/handlers/helpers/programs/review-authority-bridge";
import { assertAnchoredFilesystemPlatformSupported } from "../engine/src/orchestration/no-follow-fs";
import { materializePiResources } from "./resources";
import { validatePiAgentDefinitionFile } from "../engine/src/utils/render-pi-agent";
import { buildPiRoutingContext } from "../engine/src/utils/model-routing-context";
import { sweepExpiredPiWriteGrants, writeTargetViolatesScope } from "./write-grant";
import {
  captureLoomRuntimeIdentity,
  loadedRuntimeCompatibility,
  PI_EXTENSION_RUNTIME_REVISION_ENV,
  PI_EXTENSION_RUNTIME_ROOT_ENV,
} from "../engine/src/runtime-compatibility";
import {
  LOOM_INTERACTIVE_SUBAGENT_TOOL,
  registerInteractiveSubagentTool,
} from "./interactive-subagent";
import { observeSpawnBatchGraph } from "./spawn-graph";
import { renderTaskImplementationBrief } from "../engine/src/orchestration/implementation-brief";
import { prepareSpawnBatch } from "./spawn-preparation";
import { reservePiSpawnLifecycle } from "./spawn-lifecycle";
import { dispatchPiSubagentStop } from "./subagent-stop";
import {
  activatePiChildWriteGrant,
  createPiChildWriteGrants,
  rejectedChildWriteGrantBlock,
} from "./child-write-grant";
import { shutdownPiSession } from "./session-shutdown";
import { registerPiEmissionReadiness } from "./emission-readiness";
import { piBashCommand, piWriteTargetPaths, replacePiSpawnTask } from "./tool-input";
import {
  registerPiEmissionLaunchBridge,
  type PiSubagentLaunchEventBus,
} from "./emission-launch-bridge";
import {
  qualifyPiIssuedReviewRequest,
  readPiIssuedSpawnRequest,
  verifyTrustedStandaloneReview,
  type PiIssuedReviewRouteQualifier,
} from "./review-run-authority";
import { runPiStartupSweeps, type PiStartupSweepSource } from "./cleanup-actions";
import { createPiParentSessions } from "./spawn-reservation";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Capture once, while this extension module is loaded. Fresh CLI processes
// hash the checkout again before mutation; a changed checkout therefore cannot
// write a schema this in-memory runtime may not parse.
const LOADED_RUNTIME_IDENTITY = captureLoomRuntimeIdentity(PACKAGE_ROOT);
// Resource materialization remains process-scoped: one loaded extension owns
// one content-addressed cache. Spawn-facing agent discovery is session setup
// state instead and is sampled inside the extension factory below.
const PI_RESOURCE_CACHE = join(
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  "cache",
  "loom-resources",
);
const isPiSpawnTool = (toolName: string): boolean =>
  toolName === "subagent" || toolName === LOOM_INTERACTIVE_SUBAGENT_TOOL;

/**
 * Fail-closed path existence check. Returns `true` (assume active) for any
 * access error other than ENOENT — prevents EACCES, ELOOP, and other
 * non-absence errors from silently disabling orchestration guards. Delegates
 * to the shared core in config (`probePathFailClosed`): the ENOENT-only-
 * absent semantics have one home; only the operator line stays Pi-specific,
 * and it is regex-pinned by the ELOOP regression test.
 */
function pathExistsFailClosed(path: string): boolean {
  return probePathFailClosed(path, (p, cause) =>
    `loom(pi): pathExistsFailClosed cannot access ${p}: ${cause} — assuming active (fail closed)`);
}

export type PiResumeTaskGraphObservation =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "loaded"; state: ReturnType<StateManager["load"]> }>
  | Readonly<{ kind: "unavailable"; reason: string }>;

/** Observe resume authority once; only a proven missing State File is absent. */
export function observePiResumeTaskGraph(
  resolvePath: () => string = taskGraphPath,
  exists: (path: string) => boolean = pathExistsFailClosed,
  open: (path: string) => StateManager | null = StateManager.fromPath,
): PiResumeTaskGraphObservation {
  let path: string;
  try {
    path = resolvePath();
  } catch (error) {
    return Object.freeze({
      kind: "unavailable",
      reason: `task graph path could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  try {
    if (!exists(path)) return Object.freeze({ kind: "absent" });
    const manager = open(path);
    if (manager === null) {
      return Object.freeze({ kind: "unavailable", reason: `task graph could not be opened at ${path}` });
    }
    return Object.freeze({ kind: "loaded", state: manager.load() });
  } catch (error) {
    return Object.freeze({
      kind: "unavailable",
      reason: `task graph unreadable: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/** Fail CLOSED on a crashed `tool_call` guard, loudly naming it. */
function guardCrashBlock(guard: string, err: unknown): Readonly<{ block: true; reason: string }> {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `loom(pi): tool_call guard '${guard}' crashed — blocking the call (fail-closed): ${message}\n`,
  );
  return {
    block: true,
    reason: `loom guard '${guard}' crashed (failing closed): ${message}`,
  };
}

const productionPiStartupSweeps: PiStartupSweepSource = () => Object.freeze([
  Object.freeze({
    name: "sweepStaleSessions",
    run: (): void => { sweepStaleSessions(subagentDir(), Date.now() - STALE_SUBAGENT_TTL_MS); },
  }),
  Object.freeze({ name: "sweepExpiredPiWriteGrants", run: (): void => sweepExpiredPiWriteGrants() }),
]);

export default function (
  pi: ExtensionAPI,
  startupSweepSource: PiStartupSweepSource = productionPiStartupSweeps,
  qualifyIssuedRoute: PiIssuedReviewRouteQualifier = qualifyPiIssuedReviewRequest,
) {
  assertAnchoredFilesystemPlatformSupported();
  const piAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  registerInteractiveSubagentTool(pi, PACKAGE_ROOT, piAgentDir);
  publishLoomReviewAuthorityBridge(globalThis, { verify: verifyTrustedStandaloneReview });
  const emissionLaunchBridge = registerPiEmissionLaunchBridge(
    pi.events as unknown as PiSubagentLaunchEventBus | undefined,
  );

  const parentSessions = createPiParentSessions();
  const childWriteGrants = createPiChildWriteGrants();

  // ─── Resource Discovery ───────────────────────────────────────────────
  // The package.json "pi" manifest declares NO raw skills or prompt
  // templates (empty arrays): pi would otherwise load the unrendered trees
  // AND the rendered copies below, warn about every same-name collision,
  // and keep the unrendered file first. This handler is therefore the
  // package's single skill/prompt source — RENDERED, content-addressed
  // copies (package-relative tokens expanded) under the Loom resource
  // cache — and materialization is fatal on failure so a broken install
  // cannot silently ship unexpanded ${CLAUDE_PLUGIN_ROOT} paths.

  // Pi does not expand Claude Code's CLAUDE_PLUGIN_ROOT token in markdown.
  // Render package-owned prompts and skills from THIS extension's import URL;
  // cwd and the Claude plugin cache are never package identity.
  process.env.LOOM_PLUGIN_ROOT = LOADED_RUNTIME_IDENTITY.packageRoot;
  // Make package-relative references work in Pi subprocesses (notably the
  // subagent example extension, which inherits process.env when it spawns `pi`).
  process.env.CLAUDE_PLUGIN_ROOT = LOADED_RUNTIME_IDENTITY.packageRoot;
  // Commands executed by Pi's Bash tool inherit process environment. This
  // handshake binds every fresh mutating CLI process to the exact source bytes
  // this extension loaded, preventing mutable-checkout split brain.
  process.env[PI_EXTENSION_RUNTIME_ROOT_ENV] = LOADED_RUNTIME_IDENTITY.packageRoot;
  process.env[PI_EXTENSION_RUNTIME_REVISION_ENV] = LOADED_RUNTIME_IDENTITY.revision;
  pi.on("resources_discover", () => {
    let resources;
    try {
      resources = materializePiResources(PACKAGE_ROOT, PI_RESOURCE_CACHE);
    } catch (error) {
      // Name the failure, then RE-THROW: a swallowed crash would make Pi
      // discover zero Loom resources and continue as if the package were
      // intentionally quiet — the breakage would only surface later, as
      // missing skills, far from its cause. Failing discovery loudly keeps
      // the operator at the point of failure.
      process.stderr.write(
        `loom(pi): resource materialization failed — skills/agents unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      throw error;
    }
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
      // Re-hash only before a spawn, where stale parser/policy code matters.
      // Ordinary read/edit tools stay cheap. A future source update is caught
      // here even before the agent asks a fresh CLI mutator to run.
      if (isPiSpawnTool(event.toolName)) {
        currentGuard = "runtime-compatibility";
        const compatibility = loadedRuntimeCompatibility(
          LOADED_RUNTIME_IDENTITY,
          captureLoomRuntimeIdentity(PACKAGE_ROOT),
        );
        if (!compatibility.ok) return { block: true, reason: compatibility.message };
      }

      const sessionId = ctx.sessionManager.getSessionId() ?? "unknown";
      const safeSessionId = parseSessionId(sessionId);
      const graphIsActive = pathExistsFailClosed(taskGraphPath()) ||
        childWriteGrants.rejectedSessions.has(sessionId) ||
        (safeSessionId !== null && pathExistsFailClosed(`${subagentDir()}/${safeSessionId}.task_graph`));

      // Block direct edits during orchestration
      if (event.toolName === "edit" || event.toolName === "write" || event.toolName === "multi_edit") {
        currentGuard = "block-direct-edits";
        const rejectedGrant = rejectedChildWriteGrantBlock(childWriteGrants.rejectedSessions.has(sessionId));
        if (rejectedGrant !== null) return rejectedGrant;
        const result = shouldBlockDirectEdit(
          event.toolName,
          sessionId,
          () => graphIsActive,
          // No ArtifactWriteRequest: Pi cannot name the calling agent here.
          // Phase/panel writers are admitted as scoped write-grant holders and
          // confined to their grant's scope dirs just below.
          activeRosterProbe,
        );
        if (result.kind === "block") {
          return { block: true, reason: result.message };
        }
        // Phase/panel agents hold SCOPED grants: Edit/Write may target only the
        // artifact dirs the grant names. Unscoped (implementation) grants and
        // ungranted sessions are untouched. A scoped session whose target
        // cannot be verified fails closed.
        const granted = childWriteGrants.active.get(sessionId);
        if (granted !== undefined && granted.scopeDirs !== undefined && granted.scopeDirs.length > 0) {
          const targets = piWriteTargetPaths(event.input);
          if (!targets.ok) {
            return {
              block: true,
              reason: `BLOCKED: cannot verify every write target for a scoped phase-agent write grant: ${targets.error}; refusing the edit.`,
            };
          }
          for (const target of targets.value) {
            const violation = writeTargetViolatesScope(target, granted.scopeDirs, granted.grantCwd ?? ctx.cwd);
            if (violation !== null) {
              return {
                block: true,
                reason: `BLOCKED: ${violation}.\nAllowed write scope: ${granted.scopeDirs.join(", ")}`,
              };
            }
          }
        }
      }

      // Guard state file from bash writes
      if (event.toolName === "bash") {
        currentGuard = "guard-state-file";
        const command = graphIsActive ? piBashCommand(event.input) : "";
        let result: ReturnType<typeof guardStateFileDecision> = { kind: "allow" };
        if (command === null) {
          result = { kind: "block", message: "BLOCKED: malformed Pi bash input while the Loom state-file guard is active." };
        } else if (graphIsActive) {
          result = guardStateFileDecision(command);
        }
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

      // Subagent tool → `prepareSpawnBatch` owns the ordered observe → expand →
      // admit pipeline, with the pure Spawn Admission core deciding at its
      // end; this shell only implements its ports over the real
      // filesystem/state and applies the decision. A malformed sibling blocks
      // the whole batch; otherwise one parallel item could bypass the gates
      // that the top-level `agent`/`task` fields never represented. The
      // pipeline names the gate executing at every outcome, so a crash in a
      // port fails closed under its own name; past it, the lifecycle reservation
      // names each of its stages through `currentGuard`.
      if (isPiSpawnTool(event.toolName)) {
        currentGuard = "parse-pi-subagent-batch";
        if (event.toolName === LOOM_INTERACTIVE_SUBAGENT_TOOL && !ctx.hasUI) {
          return {
            block: true,
            reason: "loom_interactive_subagent requires a parent TUI or RPC UI client; refusing to start an unanswerable interview.",
          };
        }
        const prepared = prepareSpawnBatch(event.input, {
          // Which graph authority does this batch target? The spawn's declared
          // cwd is the boundary-trusted source: the graph that governs a
          // repository lives IN that repository, so a batch whose items declare
          // a linked worktree is an orchestration dispatch against the
          // worktree's graph even when the orchestrator runtime is rooted in
          // the main checkout. A malformed batch resolves to the runtime
          // polarity and the admission's parse still refuses it.
          observeGraph: (input) => observeSpawnBatchGraph(input, ctx.cwd),
          runtimeGraph: { active: graphIsActive, path: () => taskGraphPath() },
          renderBrief: (graphPath, taskId) => renderTaskImplementationBrief(graphPath, PACKAGE_ROOT, taskId),
          // Pi dispatches the live argument object it handed this handler, so
          // the rendered brief is written into it in place.
          rewriteTask: (slot, task) => replacePiSpawnTask(event.input, slot, task),
          admit: (input, graph, enterGuard) => {
            // A spawn's rendered agent may carry the declared binding or a
            // routing-authorized inherit of the (local) parent model; the
            // routing context is observed once per batch for the definition
            // check.
            const routing = buildPiRoutingContext();
            return admitPiSpawnBatch(input, {
              graphActive: graph.active,
              transport: event.toolName === LOOM_INTERACTIVE_SUBAGENT_TOOL ? "interactive-rpc" : "headless",
              packageRoot: PACKAGE_ROOT,
              validateDefinition: (agent) =>
                validatePiAgentDefinitionFile(join(piAgentDir, "agents", `${agent}.md`), agent, PACKAGE_ROOT, routing.context),
              readSourceAgent: (agent) => {
                enterGuard("validate-agent-skill");
                const sourceAgentPath = join(PACKAGE_ROOT, "agents", `${agent}.md`);
                try {
                  return { ok: true, content: readFileSync(sourceAgentPath, "utf-8") };
                } catch (error) {
                  return {
                    ok: false,
                    error: `Cannot read active Loom agent definition ${sourceAgentPath}: ${error instanceof Error ? error.message : String(error)}`,
                  };
                }
              },
              checkPhaseOrder: (agent, task) => {
                enterGuard("validate-phase-order");
                return validatePhaseOrder({ agentType: agent, prompt: task }, realPhaseOrderDeps);
              },
              checkTemplateSubstitution: (task) => {
                enterGuard("validate-template-substitution");
                return validateTemplateSubstitution(task, graph.active);
              },
              readIssuedRequest: (requestId, contextDigest, agent) => {
                enterGuard("expected-emission-capability");
                return readPiIssuedSpawnRequest(safeSessionId, requestId, contextDigest, agent, qualifyIssuedRoute);
              },
            });
          },
        });
        if (prepared.kind === "crashed") return guardCrashBlock(prepared.guard, prepared.cause);
        if (prepared.kind === "block") return { block: true, reason: prepared.reason };
        if (prepared.kind === "pass-through") return;
        // Admitted: reserve the batch's lifecycle before Pi may dispatch it.
        const refusal = await reservePiSpawnLifecycle({
          event,
          cwd: ctx.cwd,
          sessionId,
          safeSessionId,
          admission: prepared.admission,
          graph: prepared.graph,
        }, {
          parentSessions,
          emissionLaunchBridge,
          runtimeRevision: LOADED_RUNTIME_IDENTITY.revision,
          graphExists: pathExistsFailClosed,
          enterGuard: (guard) => { currentGuard = guard; },
        });
        if (refusal !== undefined) return refusal;
      }
    } catch (err) {
      return guardCrashBlock(currentGuard, err);
    }
    // Every guard passed: no opinion, let the call proceed.
    return undefined;
  });

  // ─── Session Lifecycle ────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    // Cleanup stale subagent tracking files — the ENGINE's sweep, not a
    // per-file twin: staleness is judged per session GROUP (max mtime across
    // the session's files), and the TTL is the shared STALE_SUBAGENT_TTL_MS,
    // so a live session's roster/ledger can't be reaped out from under a
    // fresh `.machine` anchor.
    //
    // Each sweep is guarded on its own: a crash in one must not prevent the
    // other. Hygiene is not authority — expired or invalid grants are still
    // refused at consumption — but a failure that reaches no diagnostic, UI,
    // or stderr route escapes as one post-batch aggregate so the harness can
    // surface it instead of silently losing the only operator signal.
    runPiStartupSweeps(startupSweepSource(), {
      writeDiagnostic: (diagnostic) => { process.stderr.write(diagnostic); return true; },
      notifyWarning: (message) => {
        if (!ctx.hasUI) return false;
        ctx.ui.notify(message, "warning");
        return true;
      },
      writeStderr: (diagnostic) => { process.stderr.write(diagnostic); return true; },
    });
  });

  // Each Pi subagent is a separate `pi --no-session` process. Parent-session
  // roster entries therefore cannot authorize child Edit/Write calls. Consume
  // the one-time capability injected into THIS child's task and bind its own
  // session before the first model turn.
  pi.on("before_agent_start", async (event, ctx) => activatePiChildWriteGrant(event, ctx, childWriteGrants));

  // ─── Emission Readiness (launcher barrier, AD-4/FR-008) ───────────────
  registerPiEmissionReadiness(pi, LOADED_RUNTIME_IDENTITY.revision);

  pi.on("session_shutdown", async (_event, ctx) => {
    await shutdownPiSession(ctx.sessionManager.getSessionId() ?? "", {
      parentSessions,
      childWriteGrants,
      emissionLaunchBridge,
    });
  });

  // ─── Resume Context (before_agent_start) ──────────────────────────────
  // If there's an active task graph in execute phase, inject context
  // so the LLM knows where we are (equivalent of resume-after-clear).

  pi.on("before_agent_start", async (_event, ctx) => {
    const failResumeContext = (reason: string) => {
      const message = `Loom resume context unavailable: ${reason}`;
      process.stderr.write(`loom(pi): ${message}\n`);
      ctx.ui.notify(message, "error");
      ctx.abort();
      return {
        message: {
          customType: "loom-context-error",
          content: `${message}. Do not proceed with this turn.`,
          display: true,
        },
      };
    };

    const observation = observePiResumeTaskGraph();
    if (observation.kind === "absent") return;
    if (observation.kind === "unavailable") return failResumeContext(observation.reason);
    const state = observation.state;
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


  // ─── PostEdit Lint (tool_result event for edit/write/multi_edit) ──────
  // After edit/write lands on disk, run immediate-tier lint.
  // If violations: report error content so the agent can remediate the landed edit.
  // If pass: return undefined (no injection).
  // If the lint engine errors: report the failure; this post-edit hook cannot roll back the mutation.

  pi.on("tool_result", async (event, _ctx) => {
    try {
      if (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "multi_edit") return;

      // Skip if the tool itself errored (file may not exist on disk)
      if (event.isError) return;

      const projectRoot = process.cwd();
      const projectRulesPath = join(projectRoot, PROJECT_RULES_DIR);
      const projectRulesDir = pathExistsFailClosed(projectRulesPath) ? projectRulesPath : null;

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
      // Fail-closed: return error feedback so the agent must repair the edit
      // already on disk; this post-edit hook does not roll the write back.
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text" as const, text: `\u274c LINT ENGINE ERROR: ${message}` }],
        isError: true,
      };
    }
    return undefined;
  });

  // ─── SubagentStop Dispatch (tool_result event) ────────────────────────
  // When a subagent completes, `pi/subagent-stop` settles its batch: phase
  // advancement, task status updates, and review findings — equivalent of
  // SubagentStop hooks.

  pi.on("tool_result", async (event, ctx) => {
    if (!isPiSpawnTool(event.toolName)) return;
    return dispatchPiSubagentStop(event, ctx, { parentSessions, emissionLaunchBridge });
  });

  // ─── Commands ─────────────────────────────────────────────────────────

  pi.registerCommand("loom-status", {
    description: "Show current loom orchestration status",
    handler: async (_args, ctx) => {
      const activeTaskGraphPath = taskGraphPath();
      if (!pathExistsFailClosed(activeTaskGraphPath)) {
        ctx.ui.notify("No active loom orchestration", "info");
        return;
      }

      try {
        const rendered = await currentOrchestrationStatus([], activeTaskGraphPath);
        ctx.ui.notify(rendered, rendered.includes("- location: unavailable (") ? "error" : "info");
      } catch (error) {
        ctx.ui.notify(`Error: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
