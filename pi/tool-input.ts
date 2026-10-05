/**
 * Pi tool-call payload adapters.
 *
 * The readers the `tool_call` guards apply to Pi's raw tool input (one spawn
 * item and its cwd, a bash command, every write target), the one writer that
 * replaces a spawn item's task in place, and the stable per-slot roster
 * identity shared by the spawn and result sides of a batch. Pi hands
 * extensions the live argument object it dispatches afterwards, so the writer
 * mutates that object by design; everything else here only reads.
 */

import { resolve } from "node:path";
import type { AdmittedSpawnItem } from "../engine/src/core/spawn-admission";
import { isRecord } from "../engine/src/core/plain-record";
import { rosterAgentId } from "../engine/src/machine";
import type { AgentId } from "../engine/src/machine/evidence";
import {
  WRITE_TARGET_KEYS,
  writeTargetPathOf,
} from "./transcript-adapter";
import { spawnEntryAt } from "./spawn-graph";

/** The raw batch entry at `index`, whichever spawn shape the caller used
 *  (`tasks`, `chain`, or a bare single entry). Returned by reference: callers
 *  such as `replacePiSpawnTask` write its `task` field in place. The
 *  batch-shape read lives in `pi/spawn-graph.ts` — one home shared with the
 *  spawn-graph observation, so the two can never disagree about the shape. */
export function piSpawnItem(raw: Record<string, unknown>, index: number): Record<string, unknown> {
  const entry = spawnEntryAt(raw, index);
  if (entry === null) throw new Error(`missing Pi spawn item ${index}`);
  return entry;
}

export function piSpawnCwd(raw: unknown, index: number, defaultCwd: string): string {
  if (!isRecord(raw)) {
    throw new Error("Pi subagent input must be an object before cwd resolution");
  }
  const input = raw as Record<string, unknown>;
  const entry = piSpawnItem(input, index);
  let cwd: string;
  if (typeof entry.cwd === "string") {
    cwd = entry.cwd;
  } else if (typeof input.cwd === "string") {
    cwd = input.cwd;
  } else {
    cwd = defaultCwd;
  }
  return resolve(defaultCwd, cwd);
}

/** The string command carried by a well-formed Pi bash call. Malformed
 * external input remains distinguishable so an armed state-file guard can fail
 * closed instead of treating input-shape drift as an allowed empty command. */
export function piBashCommand(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const command = (raw as Record<string, unknown>).command;
  return typeof command === "string" ? command : null;
}

export type PiWriteTargetPathsResult =
  | Readonly<{ ok: true; value: readonly [string, ...string[]] }>
  | Readonly<{ ok: false; error: string }>;

const writeTarget = (input: Record<string, unknown>, path: string): PiWriteTargetPathsResult => {
  const target = writeTargetPathOf(input);
  return target !== null
    ? Object.freeze({ ok: true, value: Object.freeze([target]) as readonly [string] })
    : Object.freeze({ ok: false, error: `${path} must name one non-empty path, file_path, or filePath target` });
};

/** Parse every target before a scoped write can proceed; no partial batch exists. */
export function piWriteTargetPaths(raw: unknown): PiWriteTargetPathsResult {
  if (!isRecord(raw)) {
    return Object.freeze({ ok: false, error: "write input must be a plain object" });
  }
  const input = raw as Record<string, unknown>;
  if (WRITE_TARGET_KEYS.some((key) => key in input)) return writeTarget(input, "write input");
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    return Object.freeze({ ok: false, error: "write input must contain a target or a non-empty edits array" });
  }
  const paths: string[] = [];
  for (const [index, edit] of input.edits.entries()) {
    if (!isRecord(edit)) {
      return Object.freeze({ ok: false, error: `write input.edits[${index}] must be a plain object` });
    }
    const parsed = writeTarget(edit as Record<string, unknown>, `write input.edits[${index}]`);
    if (!parsed.ok) return parsed;
    const target = parsed.value[0];
    if (!paths.includes(target)) paths.push(target);
  }
  return Object.freeze({ ok: true, value: Object.freeze(paths) as readonly [string, ...string[]] });
}

export function replacePiSpawnTask(raw: unknown, index: number, task: string): void {
  if (!isRecord(raw)) {
    throw new Error("Pi subagent input must be an object before write-grant injection");
  }
  const input = raw as Record<string, unknown>;
  piSpawnItem(input, index).task = task;
}

/** Stable per-spawn roster identity shared by tool_call and tool_result.
 *  Task text is deliberately excluded: Pi substitutes `{previous}` in chain
 *  results, so it is not stable across the lifecycle. */
export const piSpawnRosterId = (
  toolCallId: unknown,
  index: number,
  agent: string,
) => rosterAgentId(JSON.stringify([
  typeof toolCallId === "string" ? toolCallId : "",
  index,
  agent,
]));

/**
 * One admitted Pi spawn item carried through the parent shell as a structural
 * value. The core admission has already paired the item, lifecycle guard, and
 * emission expectation; this adapter adds only the transport slot and stable
 * roster identity. Keeping that association intact prevents mixed batches
 * from granting or guarding one child with a sibling's positional metadata.
 */
export type PiSpawnLifecycleAssociation = Readonly<{
  slot: number;
  rosterId: AgentId;
  admission: AdmittedSpawnItem;
}>;

export function associatePiSpawnLifecycle(
  itemAdmissions: readonly AdmittedSpawnItem[],
  toolCallId: string,
): readonly PiSpawnLifecycleAssociation[] {
  return Object.freeze(itemAdmissions.map((admission, slot) => Object.freeze({
    slot,
    rosterId: piSpawnRosterId(toolCallId, slot, admission.item.agent),
    admission,
  })));
}
