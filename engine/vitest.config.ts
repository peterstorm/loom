import { defineConfig } from "vitest/config";

/**
 * The suite's worker budget lives here, not in a CLI flag, because it is a
 * platform policy. The previous unconditional `--maxWorkers=4` was the right
 * cap for uncapped many-core machines (the same "Timeout calling
 * \"onTaskUpdate\"" failure class once fixed there), but macos-15 CI runners
 * expose 3 vCPUs: four forked workers — each also spawning cold `bun` CLI
 * children — oversubscribed the box until the Vitest main thread stayed
 * unresponsive past the worker's 60s RPC deadline, and fully green suites
 * (9060/9060 passing) failed the run. Two workers keep darwin unsaturated;
 * Linux keeps the four the command always pinned.
 */
export default defineConfig({
  test: {
    maxWorkers: process.platform === "darwin" ? 2 : 4,
  },
});
