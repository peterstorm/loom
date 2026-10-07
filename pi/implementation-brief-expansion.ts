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
 * Pure: the expansion reads the batch and returns the rewrites as data; it
 * never touches the payload it was given. Pi hands extensions the tool call's
 * live argument object and dispatches whatever that object holds afterwards,
 * so the shell applies the returned rewrites to it in place (see
 * `prepareSpawnBatch`).
 *
 * All-or-nothing: a batch whose marker cannot be rendered, or whose spawned
 * agent is not the Task's agent, is refused whole and yields no rewrite.
 */

import { parseImplementationBriefMarker, type ImplementationBrief } from "../engine/src/core/implementation-brief";
import type { DomainResult } from "../engine/src/core/orchestration-contract";
import { spawnBatchEntries } from "./spawn-graph";

/** Port: render one Task's brief against the batch's governing TaskGraph. */
export type RenderTaskBrief = (taskId: string) => DomainResult<ImplementationBrief, string>;

/** One marker's replacement: the batch slot whose `task` becomes `prompt`.
 *  `slot` addresses the same entry `spawnEntryAt` does, whichever spawn shape
 *  (`tasks`, `chain`, or a bare single entry) the batch used. */
export type BriefRewrite = Readonly<{ slot: number; taskId: string; prompt: string }>;

export type BriefExpansion =
  | Readonly<{ ok: true; rewrites: readonly BriefRewrite[] }>
  | Readonly<{ ok: false; reason: string }>;

export function expandImplementationBriefMarkers(raw: unknown, render: RenderTaskBrief): BriefExpansion {
  const entries = spawnBatchEntries(raw);
  if (entries === null) return Object.freeze({ ok: true, rewrites: Object.freeze([]) });
  const rewrites: BriefRewrite[] = [];
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
    rewrites.push(Object.freeze({ slot: index, taskId, prompt: rendered.value.prompt }));
  }
  return Object.freeze({ ok: true, rewrites: Object.freeze(rewrites) });
}
