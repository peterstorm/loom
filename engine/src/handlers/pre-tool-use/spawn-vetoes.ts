/**
 * The read-only Claude Code spawn vetoes, evaluated before an execution
 * reservation is written.
 *
 * Claude Code runs a matcher's PreToolUse hooks independently, so the
 * reservation `validate-task-execution` commits could land even when a sibling
 * gate blocked the same spawn. The reservation then sat `pending` with no agent
 * until the reclamation grace expired (the G1 live pilot lost ten minutes to
 * it). The reservation-taking hook therefore runs every sibling veto itself,
 * in-process and in this order, and reserves only when all of them admit the
 * spawn. The sibling hooks stay wired: each still refuses on its own, so a
 * crash in this composition cannot let a spawn skip them.
 */

import type { HookHandler, HookResult } from "../../types";
import validatePhaseOrder from "./validate-phase-order";
import validateTemplateSubstitution from "./validate-template-substitution";
import validateAgentModel from "./validate-agent-model";
import validateAgentSkill from "./validate-agent-skill";

/** One spawn veto: its hook route name (the hooks.json shim it mirrors) and handler. */
export type SpawnVetoEntry = Readonly<{ name: string; handler: HookHandler }>;

/** The vetoes in evaluation order, each named as its own hook route. */
export const SPAWN_VETOES: readonly SpawnVetoEntry[] = Object.freeze([
  { name: "validate-phase-order", handler: validatePhaseOrder },
  { name: "validate-template-substitution", handler: validateTemplateSubstitution },
  { name: "validate-agent-model", handler: validateAgentModel },
  { name: "validate-agent-skill", handler: validateAgentSkill },
]);

/** A veto's refusal. */
export type SpawnVeto = Extract<HookResult, { kind: "block" | "error" }>;

/** The first veto's refusal, or null when every veto admits the spawn. An
 *  admitting veto's operator message is not repeated here: its own wired hook
 *  already surfaces it. */
export async function firstSpawnVeto(
  stdin: string,
  vetoes: readonly SpawnVetoEntry[] = SPAWN_VETOES,
): Promise<SpawnVeto | null> {
  for (const { handler } of vetoes) {
    const result = await handler(stdin, []);
    if (result.kind === "block" || result.kind === "error") return result;
  }
  return null;
}
