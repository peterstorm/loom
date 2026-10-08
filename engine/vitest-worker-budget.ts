/**
 * The suite's forked-worker budget: a CPU budget, never more workers than the
 * host has cores. Every worker also spawns cold `bun` CLI children, and
 * contention stretches each test's synchronous spans and wall time. macos-15
 * runners expose 3 vCPUs and keep two workers; ubuntu-24.04 runners expose 4
 * and Linux keeps the four it always pinned. Many-core developer machines stay
 * capped at the same counts, and a single-core host still gets one worker.
 *
 * Pure: the caller supplies the platform and core count, so the policy is
 * testable for every host, not only the one running the suite.
 */
export function platformWorkerBudget(platform: NodeJS.Platform, cores: number): number {
  const cap = platform === "darwin" ? 2 : 4;
  return Math.max(1, Math.min(cap, cores));
}
