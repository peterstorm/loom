/**
 * An emitted spawn batch's request authorities, parsed once as the
 * stored-request parser admits them (functional core: no I/O).
 *
 * A façade spawn batch carries its requests' authorities in memory; every
 * boundary that acts on them — the Pi emission gate (`spawn-emission-gate.ts`)
 * and the session run binding the façade publishes
 * (`handlers/helpers/orchestration.ts`) — admits only what the stored-request
 * parser admits, never the in-memory value. The façade parses the batch once,
 * at its emission seam, and hands the one `ParsedSpawnBatch` to both, so they
 * cannot disagree about what parsed or refuse in different words.
 */
import { parseStoredAgentRequestAuthority, type AgentRequestAuthority } from "./orchestration-contract";

/**
 * A spawn batch as the stored-request parser admits it: every request, or the
 * refusal naming the first that does not parse together with the requests
 * before it (`admitted`), which a boundary that checks each request in order
 * still checks before reporting the refusal.
 */
export type ParsedSpawnBatch =
  | Readonly<{ ok: true; requests: readonly AgentRequestAuthority[] }>
  | Readonly<{ ok: false; admitted: readonly AgentRequestAuthority[]; message: string }>;

/**
 * Parse a spawn batch's authorities in order, stopping at the first that does
 * not parse; its refusal names the harness (`label`), the request's index and
 * every violation.
 */
export function parseSpawnBatch(label: string, authorities: readonly unknown[]): ParsedSpawnBatch {
  const admitted: AgentRequestAuthority[] = [];
  for (const [index, authority] of authorities.entries()) {
    const parsed = parseStoredAgentRequestAuthority(authority);
    if (!parsed.ok) {
      return Object.freeze({
        ok: false,
        admitted: Object.freeze(admitted),
        message: `${label} orchestration spawn request ${index}: ${parsed.error.violations.map(({ message }) => message).join("; ")}`,
      });
    }
    admitted.push(parsed.value);
  }
  return Object.freeze({ ok: true, requests: Object.freeze(admitted) });
}
