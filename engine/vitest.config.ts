import { availableParallelism } from "node:os";
import { configDefaults, defineConfig } from "vitest/config";

/**
 * Suite-wide policy lives here, not in CLI flags, so `npm run test:unit` and a
 * direct `npx vitest run` agree.
 *
 * Calibration pilots and the operator-run qualification probes live outside
 * `engine/` (they are not Runtime Revision inputs) but are still project
 * code: `npm run verify` must run their tests.
 *
 * Setup files, before every test file:
 * - `catalog-issue-route` pins the ambient reviewer issue route to the catalog
 *   route, so no suite's route election depends on which fixture it happens to
 *   import first.
 * - `task-update-yield` turns the worker's event loop after every test. Without
 *   it, a file of back-to-back synchronous tests (`spawnSync` CLI children,
 *   closure scans, gzip fixtures) never reads the main thread's reply to its
 *   `onTaskUpdate` RPC, and the worker's fixed 60s RPC timer fails a fully
 *   green run with "[vitest-worker]: Timeout calling \"onTaskUpdate\"". The
 *   file documents the event-loop mechanism.
 *
 * `testTimeout`: integration suites drive real `bun`/`git` children and full
 * reviewer fixtures; 15s is the one per-test budget for every entry point.
 * A test that is intrinsically heavier states its own timeout and why.
 *
 * `maxWorkers` is a CPU budget, never more forked workers than the host has
 * cores. Every worker also spawns cold `bun` CLI children, and contention
 * stretches each test's synchronous spans and wall time. macos-15 runners
 * expose 3 vCPUs and keep two workers; ubuntu-24.04 runners expose 4 and
 * Linux keeps the four it always pinned. Many-core developer machines stay
 * capped at the same counts.
 */
const PLATFORM_WORKER_CAP = process.platform === "darwin" ? 2 : 4;

export default defineConfig({
  test: {
    include: [...configDefaults.include, "../calibration/**/*.test.ts", "../probes/**/*.test.{ts,mjs}"],
    setupFiles: ["./tests/setup/catalog-issue-route.ts", "./tests/setup/task-update-yield.ts"],
    testTimeout: 15_000,
    maxWorkers: Math.max(1, Math.min(PLATFORM_WORKER_CAP, availableParallelism())),
  },
});
