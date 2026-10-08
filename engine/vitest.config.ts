import { availableParallelism } from "node:os";
import { configDefaults, defineConfig } from "vitest/config";
import { platformWorkerBudget } from "./vitest-worker-budget";

/**
 * Suite-wide policy lives here, not in CLI flags, so `npm run test:unit` and a
 * direct `npx vitest run` agree.
 *
 * Calibration pilots and the operator-run qualification probes live outside
 * `engine/` (they are not Runtime Revision inputs) but are still project
 * code: `npm run verify` must run their tests.
 *
 * Setup files, before every test file:
 * - `scrub-parent-model` clears the ambient Pi parent model (PI_PROVIDER,
 *   PI_MODEL, PI_REASONING_LEVEL) that spawn-time routing reads, so a wrapper
 *   Pi session running the suite never leaks its model into a fixture child.
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
 * `maxWorkers` is this host's `platformWorkerBudget`; that module documents
 * the per-platform caps.
 *
 * `globalSetup` (`tests/setup/fixture-pi-route.ts`) serves the one fake local
 * Pi route every fixture Pi session spawns onto, so the route-reachability
 * gate never consults the operator's real models.json.
 */
export default defineConfig({
  test: {
    include: [...configDefaults.include, "../calibration/**/*.test.ts", "../probes/**/*.test.{ts,mjs}"],
    globalSetup: ["./tests/setup/fixture-pi-route.ts"],
    setupFiles: ["./tests/setup/scrub-parent-model.ts", "./tests/setup/task-update-yield.ts"],
    testTimeout: 15_000,
    maxWorkers: platformWorkerBudget(process.platform, availableParallelism()),
  },
});
