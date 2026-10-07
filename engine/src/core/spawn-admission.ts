/**
 * Spawn Admission (see CONTEXT.md): the pure decision that accepts or blocks
 * one Pi subagent spawn batch before any state mutation.
 *
 * Functional core. Every gate that can be decided from values is decided
 * here — batch classification, size, interactive-transport routing, Agent
 * scope, spawn-model policy, and the Skill-prompt check. The reads the decision
 * needs (rendered-definition identity, source agent bytes, phase-order state,
 * template/file probes, issued request authority) enter through
 * `SpawnAdmissionPorts`, so the sequence is deterministic given its ports and
 * testable with in-memory fakes. The Pi extension is the shell: it gathers
 * nothing up front, implements the ports over the real filesystem/state, and
 * applies the returned decision.
 *
 * The guard that decided is DATA on the block result — not ambient mutable
 * state — so a refusal always names its gate.
 *
 * The last gate per item is the issued emission capability decision, which
 * lives in `issued-emission-capability` (the descriptor grammar, task identity
 * markers, issued producer claims and route qualification change together
 * there). This module composes it after every other gate, so a descriptor never
 * bypasses the skill, phase, template, or definition gates, and carries the
 * admitted expectation per item for the Pi launcher barrier.
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
import {
  expectedSpawnEmissionCapability,
  spawnEmissionRefusalMessage,
  type IssuedSpawnRequestReader,
  type SpawnEmissionExpectation,
} from "./issued-emission-capability";
import { canonicalRecord } from "./orchestration-contract/identity";

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
  | "validate-template-substitution"
  | "expected-emission-capability";

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
  /** Read the reserved request from this parent session's registered Run
   *  Directory (see `IssuedSpawnRequestReader`). */
  readIssuedRequest: IssuedSpawnRequestReader;
}>;

type SpawnAdmissionBlock = Readonly<{ kind: "block"; guard: SpawnGuardName; reason: string }>;

export type AdmittedSpawnItem = Readonly<{
  item: PiSpawnItem;
  taskExecutionSpawn: TaskExecutionSpawn;
  emissionExpectation: SpawnEmissionExpectation;
}>;

export type SpawnAdmission =
  | Readonly<{ kind: "pass-through" }>
  | Readonly<{
      kind: "admit";
      /** The structural per-item admission result consumed by launchers:
       *  classification and expected capability cannot be reordered away from
       *  the item they govern. */
      itemAdmissions: readonly AdmittedSpawnItem[];
      needsTaskGraphLifecycle: boolean;
    }>
  | SpawnAdmissionBlock;

const block = (guard: SpawnGuardName, reason: string): SpawnAdmissionBlock =>
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

/** One item's gate outcome: a whole-batch block, or the item's expected
 *  emission capability. Every existing gate composes before the emission gate,
 *  so a descriptor never bypasses the skill, phase, template, or definition
 *  gates. */
type ItemGateOutcome =
  | Readonly<{ kind: "block"; block: SpawnAdmissionBlock }>
  | Readonly<{ kind: "item"; expectation: SpawnEmissionExpectation }>;

const itemBlocked = (guard: SpawnGuardName, reason: string): ItemGateOutcome =>
  canonicalRecord({ kind: "block" as const, block: block(guard, reason) });

function itemAdmission(item: PiSpawnItem, ports: SpawnAdmissionPorts): ItemGateOutcome {
  const expected = expectedSpawnModel(item.agent, "pi");
  if (!expected.ok) return itemBlocked("definition-identity", expected.error.message);

  const definition = ports.validateDefinition(item.agent);
  if (!definition.ok) {
    return itemBlocked(
      "definition-identity",
      `Pi agent '${item.agent}' must be rendered from active Loom package ${ports.packageRoot}: ${definition.error}. ` +
        `Run "${ports.packageRoot}/scripts/sync-pi-agents.sh" and /reload.`,
    );
  }
  const source = ports.readSourceAgent(item.agent);
  if (!source.ok) return itemBlocked("validate-agent-skill", source.error);
  const skillCheck = checkAgentSkillPrompt(source.content, item.task);
  if (!skillCheck.ok) return itemBlocked("validate-agent-skill", `Pi agent '${item.agent}' skill policy failed: ${skillCheck.error}`);
  const phaseResult = ports.checkPhaseOrder(item.agent, item.task);
  if (phaseResult.kind === "block") return itemBlocked("validate-phase-order", phaseResult.message);
  const templateResult = ports.checkTemplateSubstitution(item.task);
  if (templateResult.kind === "block") return itemBlocked("validate-template-substitution", templateResult.message);
  const emission = expectedSpawnEmissionCapability(item, ports.readIssuedRequest);
  return emission.ok
    ? canonicalRecord({ kind: "item" as const, expectation: emission.expectation })
    : itemBlocked("expected-emission-capability", spawnEmissionRefusalMessage(emission.refusal));
}

/** The external-batch arm of `admitPiSpawnBatch`. Interactive transport
 *  accepts exactly one interactive Loom phase Agent; Loom owns only its
 *  catalog outside orchestration, so during an active graph an unknown agent
 *  would bypass the phase/task/model gates and external agents block, while
 *  without an active graph they belong to another Pi workflow and pass
 *  through. */
function externalBatchAdmission(ports: SpawnAdmissionPorts): SpawnAdmission {
  if (ports.transport === "interactive-rpc") {
    return block(
      "interactive-transport",
      "loom_interactive_subagent accepts exactly one interactive Loom phase Agent; external Agents must use the normal subagent tool.",
    );
  }
  return ports.graphActive
    ? block("external-agents", "External Pi subagents cannot run while a Loom task graph is active")
    : Object.freeze({ kind: "pass-through" });
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
  if (classified.value.kind === "external") return externalBatchAdmission(ports);

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

  const itemAdmissions: AdmittedSpawnItem[] = [];
  for (const item of items) {
    const gate = itemAdmission(item, ports);
    if (gate.kind === "block") return gate.block;
    itemAdmissions.push(canonicalRecord({
      item,
      taskExecutionSpawn: classifyTaskExecutionSpawn({ agentType: item.agent, prompt: item.task, description: "" }),
      emissionExpectation: gate.expectation,
    }));
  }

  const admittedItems = Object.freeze(itemAdmissions);
  return Object.freeze({
    kind: "admit",
    itemAdmissions: admittedItems,
    needsTaskGraphLifecycle: admittedItems.some(({ taskExecutionSpawn }) => taskExecutionSpawn.kind !== "standalone"),
  });
}
