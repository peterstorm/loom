/**
 * An emitted spawn batch's request authorities, parsed once as the
 * stored-request parser admits them for the run emitting them (functional
 * core: no I/O).
 *
 * A façade spawn batch carries its requests' authorities in memory; every
 * boundary that acts on them — the Pi emission gate (`spawn-emission-gate.ts`)
 * and the session run binding the façade publishes
 * (`handlers/helpers/orchestration.ts`) — admits only what the stored-request
 * parser admits for the emitting run, never the in-memory value. The façade
 * parses the batch once, at its emission seam, and hands the one
 * `ParsedSpawnBatch` to both, so they cannot disagree about what was admitted
 * or refuse in different words.
 */
import { parseStoredAgentRequestAuthority, type AgentRequestAuthority } from "./orchestration-contract";

/** A spawn batch as the stored-request parser admits it for its run: every request, or the refusal naming the first that is not admitted. */
export type ParsedSpawnBatch =
  | Readonly<{ ok: true; requests: readonly AgentRequestAuthority[] }>
  | Readonly<{ ok: false; message: string }>;

/**
 * Parse a spawn batch's authorities in order for the run `runId`, stopping at
 * the first request that does not parse or that belongs to another run — so a
 * request of another run is named before a later request that did not parse.
 * The refusal names the harness (`label`) and the request's index, and a
 * parse refusal every violation.
 */
export function parseSpawnBatch(label: string, runId: string, authorities: readonly unknown[]): ParsedSpawnBatch {
  const requests: AgentRequestAuthority[] = [];
  for (const [index, authority] of authorities.entries()) {
    const parsed = parseStoredAgentRequestAuthority(authority);
    if (!parsed.ok) {
      return refused(`${label} orchestration spawn request ${index}: ${parsed.error.violations.map(({ message }) => message).join("; ")}`);
    }
    if (parsed.value.runId !== runId) return refused(`${label} orchestration spawn request ${index} belongs to another run`);
    requests.push(parsed.value);
  }
  return Object.freeze({ ok: true, requests: Object.freeze(requests) });
}

const refused = (message: string): ParsedSpawnBatch => Object.freeze({ ok: false, message });
