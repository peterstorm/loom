/**
 * The armed-attempt fixture owns process-global state: the project env, a
 * temp Git repository, the session pointer and the sidecar. It must hand all
 * of it back on every path, or a failed arm leaks into the next test in the
 * same worker.
 */

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { SUBAGENT_DIR } from "../../src/config";
import { parseEpoch } from "../../src/machine";
import {
  ARMED_EPOCH,
  REGRESSION_ONLY,
  armedClaudeImplementation,
} from "./claude-implementation-attempt";
import { withEnvOverlay } from "./env-overlay";

const SENTINEL_ENV = Object.freeze({ CLAUDE_PROJECT_DIR: "/sentinel/project", LOOM_STATE_PATH: "/sentinel/state.json" });

const armedRoots = (label: string): readonly string[] =>
  readdirSync(tmpdir()).filter((name) => name.startsWith(`loom-armed-${label}-`));

const sessionPointers = (label: string): readonly string[] =>
  existsSync(SUBAGENT_DIR)
    ? readdirSync(SUBAGENT_DIR).filter((name) => name.startsWith(`claude-armed-${label}-`))
    : [];

describe("armedClaudeImplementation", () => {
  it("names the armed Agent's epoch exactly as its stop does", () => {
    expect(ARMED_EPOCH).toBe(parseEpoch("a-1:code-implementer-agent"));
  });

  it("points the project env at the repository until dispose, then restores it", async () => {
    await withEnvOverlay(SENTINEL_ENV, async () => {
      const attempt = await armedClaudeImplementation({ label: "fixture-ok", verificationPolicy: REGRESSION_ONLY });
      expect(process.env.CLAUDE_PROJECT_DIR).toBe(attempt.root);
      expect(process.env.LOOM_STATE_PATH).toBeUndefined();
      expect(existsSync(attempt.statePath)).toBe(true);
      expect(sessionPointers("fixture-ok")).toHaveLength(1);

      attempt.dispose();

      expect(process.env).toMatchObject(SENTINEL_ENV);
      expect(existsSync(attempt.root)).toBe(false);
      expect(sessionPointers("fixture-ok")).toEqual([]);
    });
  }, 30000);

  it("restores the env and removes the repository when a setup step throws before registration", async () => {
    await withEnvOverlay(SENTINEL_ENV, async () => {
      await expect(armedClaudeImplementation({
        label: "fixture-seed-throws",
        verificationPolicy: REGRESSION_ONLY,
        seed: () => { throw new Error("injected seed failure"); },
      })).rejects.toThrow("injected seed failure");

      expect(process.env).toMatchObject(SENTINEL_ENV);
      expect(armedRoots("fixture-seed-throws")).toEqual([]);
      expect(sessionPointers("fixture-seed-throws")).toEqual([]);
    });
  }, 30000);

  it("restores the env and removes the repository when registration refuses the attempt", async () => {
    await withEnvOverlay(SENTINEL_ENV, async () => {
      await expect(armedClaudeImplementation({
        label: "fixture-refused",
        verificationPolicy: REGRESSION_ONLY,
        seed: (graph) => ({ ...graph, tasks: graph.tasks.map((task) => ({ ...task, wave: 2 })) }),
      })).rejects.toThrow("BLOCKED: Cannot execute T1 (wave 2)");

      expect(process.env).toMatchObject(SENTINEL_ENV);
      expect(armedRoots("fixture-refused")).toEqual([]);
      expect(sessionPointers("fixture-refused")).toEqual([]);
    });
  }, 30000);
});
