/**
 * One emitted spawn request's authority, re-parsed as the stored-request
 * parser admits it (functional core: no I/O).
 *
 * A façade spawn batch carries its requests' authorities in memory; every
 * boundary that acts on them — the Pi emission gate (`spawn-emission-gate.ts`)
 * and the session run binding the façade publishes
 * (`handlers/helpers/orchestration.ts`) — admits only what the stored-request
 * parser admits, never the in-memory value, and refuses in the same words.
 */
import { parseStoredAgentRequestAuthority, type AgentRequestAuthority } from "./orchestration-contract";

/** A parsed spawn request, or the refusal naming it. */
export type SpawnRequestParse<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; message: string }>;

/**
 * One spawn request's authority as the stored-request parser admits it; a
 * refusal names the harness (`label`), the request's index and every
 * violation.
 */
export function parseSpawnRequestAuthority(label: string, index: number, authority: unknown): SpawnRequestParse<AgentRequestAuthority> {
  const parsed = parseStoredAgentRequestAuthority(authority);
  return parsed.ok
    ? parsed
    : { ok: false, message: `${label} orchestration spawn request ${index}: ${parsed.error.violations.map(({ message }) => message).join("; ")}` };
}
