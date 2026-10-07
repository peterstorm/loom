/**
 * Pi spawn-input parsing: the untrusted `subagent` tool input, parsed into one
 * exact single/parallel/chain batch and classified as Loom-owned or external
 * before Loom applies any model policy to it.
 *
 * This is a boundary parser over the Pi tool schema, so it changes when that
 * schema changes — not when the model catalog does. It consumes only the
 * catalog's agent-name parser and namespace rule (`model-profiles.ts`).
 *
 * Refusals carry their failure class in `PolicyError.kind`: a payload that is
 * not one well-formed batch is `malformed-spawn-input`; a well-formed batch
 * naming an unknown Loom-namespaced Agent, mixing Loom-owned with external
 * Agents, or (for `parsePiSpawnItems`) carrying no Loom Agent is `unknown-agent`.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import {
  isLoomNamespacedAgent,
  parseAgentName,
  type LoomAgentName,
  type PolicyError,
  type PolicyResult,
} from "./model-profiles";
import { isRecord } from "./plain-record";

const success = <T>(value: T): PolicyResult<T> => Object.freeze({ ok: true, value });
const failure = <T>(error: PolicyError): PolicyResult<T> =>
  Object.freeze({ ok: false, error: Object.freeze(error) });

export type PiSpawnItem = Readonly<{ agent: LoomAgentName; task: string }>;
export type ExternalPiSpawnItem = Readonly<{ agent: string; task: string }>;
export type ClassifiedPiSpawnBatch =
  | Readonly<{ kind: "loom-owned"; items: readonly PiSpawnItem[] }>
  | Readonly<{ kind: "external"; items: readonly ExternalPiSpawnItem[] }>;

const malformed = <T>(message: string): PolicyResult<T> => failure({ kind: "malformed-spawn-input", message });

function parseRawPiSpawnItems(raw: unknown): PolicyResult<readonly ExternalPiSpawnItem[]> {
  if (!isRecord(raw)) return malformed("Pi subagent input must be an object");
  // The candidate entry lists, one per populated mode. A populated single form
  // is a mode; a vacuous one is not. Models echo the tool schema's optional
  // top-level fields with empty strings alongside a populated parallel/chain
  // payload, and counting that echo as a second mode would refuse an
  // unambiguous batch. Empty strings are filtered here, not downstream: the
  // item loop below still rejects any entry whose agent/task is missing or blank.
  const modeEntries: (readonly unknown[])[] = [];
  if (
    typeof raw.agent === "string" && raw.agent.trim() !== "" &&
    typeof raw.task === "string" && raw.task.trim() !== ""
  ) {
    modeEntries.push([raw]);
  }
  if (Array.isArray(raw.tasks) && raw.tasks.length > 0) modeEntries.push(raw.tasks);
  if (Array.isArray(raw.chain) && raw.chain.length > 0) modeEntries.push(raw.chain);
  const [entries, ...ambiguous] = modeEntries;
  if (entries === undefined || ambiguous.length > 0) {
    return malformed("Pi subagent input must provide exactly one non-empty single, parallel, or chain mode");
  }
  const items: ExternalPiSpawnItem[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (
      !isRecord(entry) || typeof entry.agent !== "string" || entry.agent.trim() === "" ||
      typeof entry.task !== "string" || entry.task.trim() === ""
    ) {
      return malformed(`Pi subagent item ${index + 1} must contain a non-empty agent and task`);
    }
    items.push(Object.freeze({ agent: entry.agent, task: entry.task }));
  }
  return success(Object.freeze(items));
}

/**
 * Classify a structurally valid Pi batch before Loom applies its own policy.
 * Mixed ownership is rejected: passing only the external siblings through
 * would let one malformed/unknown item bypass an otherwise Loom-owned batch.
 */
export function classifyPiSpawnItems(raw: unknown): PolicyResult<ClassifiedPiSpawnBatch> {
  const parsed = parseRawPiSpawnItems(raw);
  if (!parsed.ok) return parsed;
  // Each item zipped once with its catalog resolution: the Loom-owned arm is
  // built from the resolved items themselves, so no index can disagree.
  const resolved = parsed.value.map((item) => ({ item, agent: parseAgentName(item.agent) }));
  const unknownOwned = resolved.find(({ item, agent }) => !agent.ok && isLoomNamespacedAgent(item.agent));
  if (unknownOwned !== undefined) {
    return failure({
      kind: "unknown-agent",
      message: `no Loom model policy for agent '${unknownOwned.item.agent}'`,
    });
  }
  const owned = resolved.flatMap(({ item, agent }): PiSpawnItem[] =>
    agent.ok ? [Object.freeze({ agent: agent.value, task: item.task })] : []);
  if (owned.length === 0) return success(Object.freeze({ kind: "external", items: parsed.value }));
  if (owned.length !== parsed.value.length) {
    return failure({
      kind: "unknown-agent",
      message: "Pi subagent batches must not mix Loom-owned and external agents",
    });
  }
  return success(Object.freeze({ kind: "loom-owned", items: Object.freeze(owned) }));
}

/** Parse an all-Loom Pi batch for callers that require Loom ownership. */
export function parsePiSpawnItems(raw: unknown): PolicyResult<readonly PiSpawnItem[]> {
  const classified = classifyPiSpawnItems(raw);
  if (!classified.ok) return classified;
  if (classified.value.kind === "external") {
    return failure({
      kind: "unknown-agent",
      message: `no Loom model policy for agent '${classified.value.items[0]?.agent ?? "<empty>"}'`,
    });
  }
  return success(classified.value.items);
}
