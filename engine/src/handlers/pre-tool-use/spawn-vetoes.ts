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
 *
 * Each veto declares which payload it judges. Most judge the expanded brief:
 * the bytes the child receives. `validate-template-substitution` judges the
 * spawn request as the parent wrote it, because an engine-rendered brief has
 * no parent-filled template variables; it expands the marker itself only to
 * prove the brief renders, exactly as its wired sibling hook does.
 */

import type { HookHandler, HookResult } from "../../types";
import validatePhaseOrder from "./validate-phase-order";
import validateTemplateSubstitution from "./validate-template-substitution";
import validateAgentModel from "./validate-agent-model";
import validateAgentSkill from "./validate-agent-skill";

/** Which payload a veto judges: the expanded brief the child receives, or
 *  the spawn request as the parent wrote it (a marker stays a marker). */
export type SpawnVetoPayload = "expanded-brief" | "spawn-request";

/** One spawn veto: its hook route name (the hooks.json shim it mirrors), the
 *  payload it judges, and its handler. */
export type SpawnVetoEntry = Readonly<{ name: string; judges: SpawnVetoPayload; handler: HookHandler }>;

/** The hook payloads of one spawn: as requested, and with any brief marker
 *  expanded (the same bytes when there was no marker). */
export type SpawnVetoPayloads = Readonly<Record<SpawnVetoPayload, string>>;

/** The vetoes in evaluation order, each named as its own hook route. */
export const SPAWN_VETOES: readonly SpawnVetoEntry[] = Object.freeze([
  { name: "validate-phase-order", judges: "expanded-brief", handler: validatePhaseOrder },
  { name: "validate-template-substitution", judges: "spawn-request", handler: validateTemplateSubstitution },
  { name: "validate-agent-model", judges: "expanded-brief", handler: validateAgentModel },
  { name: "validate-agent-skill", judges: "expanded-brief", handler: validateAgentSkill },
]);

/** A veto's refusal. */
export type SpawnVeto = Extract<HookResult, { kind: "block" | "error" }>;

/** The first veto's refusal, or null when every veto admits the spawn. An
 *  admitting veto's operator message is not repeated here: its own wired hook
 *  already surfaces it. */
export async function firstSpawnVeto(
  payloads: SpawnVetoPayloads,
  vetoes: readonly SpawnVetoEntry[] = SPAWN_VETOES,
): Promise<SpawnVeto | null> {
  for (const { judges, handler } of vetoes) {
    const result = await handler(payloads[judges], []);
    if (result.kind === "block" || result.kind === "error") return result;
  }
  return null;
}
