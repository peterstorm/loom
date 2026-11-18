import type { RegisteredWaveGateProgram, WaveGateOriginAudit } from "../../src/core/wave-gate-program";

/**
 * `registration` with its origin audit replaced by `origin` (none for a fresh
 * start): the origin arms are exclusive, so a test that varies the audit
 * rebuilds it here instead of spreading a second audit beside the first.
 */
export function withOrigin(registration: RegisteredWaveGateProgram, origin: WaveGateOriginAudit = {}): RegisteredWaveGateProgram {
  const { restart: _restart, orphanRecovery: _orphanRecovery, succession: _succession, ...base } = registration;
  return { ...base, ...origin };
}
