/**
 * Pi expansion of implementation brief markers.
 *
 * An orchestrator dispatches an owed implementation by spawning the Task's
 * agent with the one-line task `LOOM_IMPLEMENTATION_BRIEF: T5`. Before any
 * spawn gate reads the batch, this expansion replaces each marker with the
 * engine-rendered brief, so the template, inlined rules, Requirement text and
 * retry/attestation appendix never pass through the model's tool call. The
 * gates (template substitution, Task binding, skill, attempt authority, write
 * grant) then judge exactly the bytes the child receives.
 *
 * All-or-nothing: a batch whose marker cannot be rendered, or whose spawned
 * agent is not the Task's agent, is refused whole and left unmodified.
 */

import { parseImplementationBriefMarker, type ImplementationBrief } from "../engine/src/core/implementation-brief";
import type { DomainResult } from "../engine/src/core/orchestration-contract";
import { spawnBatchEntries } from "./spawn-graph";

/** Port: render one Task's brief against the batch's governing TaskGraph. */
export type RenderTaskBrief = (taskId: string) => DomainResult<ImplementationBrief, string>;

export type BriefExpansion =
  | Readonly<{ ok: true; expandedTaskIds: readonly string[] }>
  | Readonly<{ ok: false; reason: string }>;

export function expandImplementationBriefMarkers(raw: unknown, render: RenderTaskBrief): BriefExpansion {
  const entries = spawnBatchEntries(raw);
  if (entries === null) return Object.freeze({ ok: true, expandedTaskIds: Object.freeze([]) });
  const replacements: { entry: Record<string, unknown>; prompt: string; taskId: string }[] = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.task !== "string") continue;
    const taskId = parseImplementationBriefMarker(item.task);
    if (taskId === null) continue;
    const rendered = render(taskId);
    if (!rendered.ok) {
      return Object.freeze({ ok: false, reason: `BLOCKED: spawn item ${index + 1} cannot expand its implementation brief: ${rendered.error}` });
    }
    if (item.agent !== rendered.value.agent) {
      return Object.freeze({
        ok: false,
        reason: `BLOCKED: spawn item ${index + 1} names agent ${String(item.agent)} but ${taskId} is assigned to ${rendered.value.agent}`,
      });
    }
    replacements.push({ entry: item, prompt: rendered.value.prompt, taskId });
  }
  for (const { entry, prompt } of replacements) entry.task = prompt;
  return Object.freeze({ ok: true, expandedTaskIds: Object.freeze(replacements.map(({ taskId }) => taskId)) });
}
