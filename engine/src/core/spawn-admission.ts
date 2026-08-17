/**
 * Spawn Admission (see CONTEXT.md): the pure decision that accepts or blocks
 * one Pi subagent spawn batch before any state mutation.
 *
 * Functional core. Every gate that can be decided from values is decided
 * here — batch classification, size, the panel-interview refusal, agent
 * scope, spawn-model policy, the skill-prompt check. The reads the decision
 * needs (rendered-definition identity, source agent bytes, phase-order state,
 * template/file probes) enter through `SpawnAdmissionPorts`, so the sequence
 * is deterministic given its ports and testable with in-memory fakes. The Pi
 * extension is the shell: it gathers nothing up front, implements the ports
 * over the real filesystem/state, and applies the returned decision.
 *
 * The guard that decided is DATA on the block result — not ambient mutable
 * state — so a refusal always names its gate.
 */

import type { HookResult } from "../types";
import { checkAgentSkillPrompt } from "./agent-skills";
import {
  classifyPiSpawnItems,
  expectedSpawnModel,
  type LoomAgentName,
  type PiSpawnItem,
} from "./model-profiles";
import { classifyTaskExecutionSpawn, type TaskExecutionSpawn } from "./validate-task-execution";
import { stripNamespace } from "../utils/strip-namespace";

/** Pi's transport cap per native subagent call; larger engine batches are
 *  chunked by the parent. Single source — the extension imports it. */
export const MAX_PI_ORCHESTRATION_BATCH_SIZE = 8;

export type SpawnGuardName =
  | "parse-pi-subagent-batch"
  | "external-agents"
  | "batch-size"
  | "panel-interview"
  | "agent-scope"
  | "definition-identity"
  | "validate-agent-skill"
  | "validate-phase-order"
  | "validate-template-substitution";

export type SpawnAdmissionPorts = Readonly<{
  /** Is a Loom task graph active for this session? */
  graphActive: boolean;
  /** Absolute Loom package root, used verbatim in remediation messages. */
  packageRoot: string;
  /** Prove the rendered Pi definition is the one this package generated. */
  validateDefinition: (
    agent: LoomAgentName,
  ) => Readonly<{ ok: true }> | Readonly<{ ok: false; error: string }>;
  /** Read the source agent definition; a failure carries the full message. */
  readSourceAgent: (
    agent: LoomAgentName,
  ) => Readonly<{ ok: true; content: string }> | Readonly<{ ok: false; error: string }>;
  checkPhaseOrder: (agent: LoomAgentName, task: string) => HookResult;
  checkTemplateSubstitution: (task: string) => HookResult;
}>;

export type SpawnAdmission =
  | Readonly<{ kind: "pass-through" }>
  | Readonly<{
      kind: "admit";
      items: readonly PiSpawnItem[];
      /** One classification per item, index-aligned with `items`; the shell's
       *  grant planning and batch validation consume the same values the
       *  lifecycle decision was made from. */
      taskExecutionSpawns: readonly TaskExecutionSpawn[];
      needsTaskGraphLifecycle: boolean;
    }>
  | Readonly<{ kind: "block"; guard: SpawnGuardName; reason: string }>;

const block = (guard: SpawnGuardName, reason: string): SpawnAdmission =>
  Object.freeze({ kind: "block", guard, reason });

/**
 * Decide one spawn batch. The gate sequence and every reason string are the
 * exact ones the Pi extension enforced inline; a malformed sibling blocks the
 * whole batch, so one parallel item cannot bypass gates the top-level fields
 * never represented.
 */
export function admitPiSpawnBatch(rawInput: unknown, ports: SpawnAdmissionPorts): SpawnAdmission {
  const classified = classifyPiSpawnItems(rawInput);
  if (!classified.ok) return block("parse-pi-subagent-batch", classified.error.message);
  if (classified.value.kind === "external") {
    // Loom owns only its catalog outside orchestration. During an active
    // graph, an unknown agent would bypass phase/task/model gates; without
    // one, it belongs to another Pi workflow and must pass through.
    return ports.graphActive
      ? block("external-agents", "External Pi subagents cannot run while a Loom task graph is active")
      : Object.freeze({ kind: "pass-through" });
  }

  const items = classified.value.items;
  if (items.length > MAX_PI_ORCHESTRATION_BATCH_SIZE) {
    return block(
      "batch-size",
      `Pi transport accepts at most ${MAX_PI_ORCHESTRATION_BATCH_SIZE} requests per subagent call; partition the engine-issued spawn-batch into ordered chunks without changing, dropping, or duplicating requests.`,
    );
  }

  // Panel mode's interview stage requires interactive AskUserQuestion: an
  // arch-interviewer-agent must question the USER before writing the digest
  // that drives lens/judge selection. Pi children are headless (no TUI, no
  // question relay — see docs/pi-phase-agent-interviews.md), so the agent can
  // neither ask nor honestly answer. Refuse with an actionable diagnostic
  // instead of letting a fabricated digest drive the panel.
  if (items.some((item) => stripNamespace(item.agent) === "arch-interviewer-agent")) {
    return block(
      "panel-interview",
      "BLOCKED: `/loom --panel` interview stage cannot run under pi: " +
        "arch-interviewer-agent needs interactive AskUserQuestion, which pi " +
        "children do not support (docs/pi-phase-agent-interviews.md). " +
        "Panel mode currently requires Claude Code for the interview; a " +
        "headless interview path or a question relay is not yet implemented.",
    );
  }

  const requestedScope = (rawInput as { agentScope?: unknown }).agentScope ?? "user";
  if (requestedScope !== "user") {
    return block(
      "agent-scope",
      `Loom-owned Pi agents require agentScope='user' so the validated generated definition is exactly the definition Pi executes; got ${JSON.stringify(requestedScope)}.`,
    );
  }

  for (const item of items) {
    const expected = expectedSpawnModel(item.agent, "pi");
    const definition = ports.validateDefinition(item.agent);
    if (!expected.ok || !definition.ok) {
      return block(
        "definition-identity",
        expected.ok
          ? `Pi agent '${item.agent}' must be rendered from active Loom package ${ports.packageRoot}: ${definition.ok ? "unknown definition mismatch" : definition.error}. Run "${ports.packageRoot}/scripts/sync-pi-agents.sh" and /reload.`
          : expected.error.message,
      );
    }

    const source = ports.readSourceAgent(item.agent);
    if (!source.ok) return block("validate-agent-skill", source.error);
    const skillCheck = checkAgentSkillPrompt(source.content, item.task);
    if (!skillCheck.ok) {
      return block("validate-agent-skill", `Pi agent '${item.agent}' skill policy failed: ${skillCheck.error}`);
    }

    const phaseResult = ports.checkPhaseOrder(item.agent, item.task);
    if (phaseResult.kind === "block") return block("validate-phase-order", phaseResult.message);

    const templateResult = ports.checkTemplateSubstitution(item.task);
    if (templateResult.kind === "block") {
      return block("validate-template-substitution", templateResult.message);
    }
  }

  const taskExecutionSpawns = Object.freeze(items.map((item) =>
    classifyTaskExecutionSpawn({ agentType: item.agent, prompt: item.task, description: "" }),
  ));
  return Object.freeze({
    kind: "admit",
    items,
    taskExecutionSpawns,
    needsTaskGraphLifecycle: taskExecutionSpawns.some((spawn) => spawn.kind !== "standalone"),
  });
}
