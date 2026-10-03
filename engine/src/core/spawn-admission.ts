/**
 * Spawn Admission (see CONTEXT.md): the pure decision that accepts or blocks
 * one Pi subagent spawn batch before any state mutation.
 *
 * Functional core. Every gate that can be decided from values is decided
 * here — batch classification, size, interactive-transport routing, Agent
 * scope, spawn-model policy, and the Skill-prompt check. The reads the decision
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
  agentRequiresInteractiveTransport,
  classifyPiSpawnItems,
  expectedSpawnModel,
  type LoomAgentName,
  type PiSpawnItem,
} from "./model-profiles";
import { classifyTaskExecutionSpawn, type TaskExecutionSpawn } from "./validate-task-execution";

/** Pi's transport cap per native subagent call; larger engine batches are
 *  chunked by the parent. Single source — the extension imports it. */
export const MAX_PI_ORCHESTRATION_BATCH_SIZE = 8;

export type PiSpawnTransport = "headless" | "interactive-rpc";

export type SpawnGuardName =
  | "parse-pi-subagent-batch"
  | "external-agents"
  | "batch-size"
  | "interactive-transport"
  | "agent-scope"
  | "definition-identity"
  | "validate-agent-skill"
  | "validate-phase-order"
  | "validate-template-substitution";

export type SpawnAdmissionPorts = Readonly<{
  /** Is a Loom task graph active for this session? */
  graphActive: boolean;
  /** Which parent-owned transport will execute this exact batch. */
  transport: PiSpawnTransport;
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

function transportAdmission(
  items: readonly PiSpawnItem[],
  transport: PiSpawnTransport,
): SpawnAdmission | null {
  const interactiveItems = items.filter((item) => agentRequiresInteractiveTransport(item.agent));
  if (transport === "headless" && interactiveItems.length > 0) {
    return block(
      "interactive-transport",
      `BLOCKED: ${interactiveItems.map(({ agent }) => agent).join(", ")} requires live user questions. ` +
        "Use Loom's loom_interactive_subagent Pi tool so the same child Agent can question the parent TUI over RPC.",
    );
  }
  return transport === "interactive-rpc" && (items.length !== 1 || interactiveItems.length !== items.length)
    ? block(
        "interactive-transport",
        "loom_interactive_subagent accepts exactly one interactive Loom phase Agent; use the normal subagent tool for every headless role.",
      )
    : null;
}

function itemAdmission(item: PiSpawnItem, ports: SpawnAdmissionPorts): SpawnAdmission | null {
  const expected = expectedSpawnModel(item.agent, "pi");
  if (!expected.ok) return block("definition-identity", expected.error.message);

  const definition = ports.validateDefinition(item.agent);
  if (!definition.ok) {
    return block(
      "definition-identity",
      `Pi agent '${item.agent}' must be rendered from active Loom package ${ports.packageRoot}: ${definition.error}. ` +
        `Run "${ports.packageRoot}/scripts/sync-pi-agents.sh" and /reload.`,
    );
  }
  const source = ports.readSourceAgent(item.agent);
  if (!source.ok) return block("validate-agent-skill", source.error);
  const skillCheck = checkAgentSkillPrompt(source.content, item.task);
  if (!skillCheck.ok) return block("validate-agent-skill", `Pi agent '${item.agent}' skill policy failed: ${skillCheck.error}`);
  const phaseResult = ports.checkPhaseOrder(item.agent, item.task);
  if (phaseResult.kind === "block") return block("validate-phase-order", phaseResult.message);
  const templateResult = ports.checkTemplateSubstitution(item.task);
  return templateResult.kind === "block"
    ? block("validate-template-substitution", templateResult.message)
    : null;
}

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
    if (ports.transport === "interactive-rpc") {
      return block(
        "interactive-transport",
        "loom_interactive_subagent accepts exactly one interactive Loom phase Agent; external Agents must use the normal subagent tool.",
      );
    }
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

  const transport = transportAdmission(items, ports.transport);
  if (transport !== null) return transport;

  const requestedScope = (rawInput as { agentScope?: unknown }).agentScope ?? "user";
  if (requestedScope !== "user") {
    return block(
      "agent-scope",
      `Loom-owned Pi agents require agentScope='user' so the validated generated definition is exactly the definition Pi executes; got ${JSON.stringify(requestedScope)}.`,
    );
  }

  for (const item of items) {
    const rejected = itemAdmission(item, ports);
    if (rejected !== null) return rejected;
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
