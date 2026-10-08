import { describe, expect, it } from "vitest";
import { platformWorkerBudget } from "../vitest-worker-budget";

describe("platformWorkerBudget", () => {
  it.each([
    { platform: "darwin", cores: 3, budget: 2, why: "a macos-15 runner keeps two of its three vCPUs" },
    { platform: "linux", cores: 64, budget: 4, why: "a many-core Linux host stays at the pinned four" },
    { platform: "linux", cores: 2, budget: 2, why: "a Linux host below the cap gets one worker per core" },
    { platform: "darwin", cores: 1, budget: 1, why: "a single-core host still gets one worker" },
    { platform: "linux", cores: 1, budget: 1, why: "a single-core host still gets one worker" },
    { platform: "linux", cores: 4, budget: 4, why: "an ubuntu-24.04 runner uses all four vCPUs" },
    { platform: "darwin", cores: 12, budget: 2, why: "a many-core Mac stays at the darwin cap" },
  ] as const)("$platform with $cores cores runs $budget workers: $why", ({ platform, cores, budget }) => {
    expect(platformWorkerBudget(platform, cores)).toBe(budget);
  });

  it("never exceeds the host's cores nor drops below one worker", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      for (let cores = 1; cores <= 128; cores += 1) {
        const budget = platformWorkerBudget(platform, cores);
        expect(budget).toBeGreaterThanOrEqual(1);
        expect(budget).toBeLessThanOrEqual(cores);
      }
    }
  });
});
