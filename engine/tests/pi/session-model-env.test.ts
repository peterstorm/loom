/**
 * The parent-model projection, and the routing consequence it exists for.
 *
 * Loom's routing readers all observe `PI_PROVIDER`/`PI_MODEL`. Pi exports that
 * pair once at process start, so a session that switched model mid-run has a
 * stale pair until Loom projects the live context model. These tests pin the
 * pure projection AND the end-to-end consequence: the same child role resolves
 * on the routed model after projection, so admission and the spawn render
 * cannot disagree about an emission route.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSessionModelIntoEnv, sessionModelEnv } from "../../../pi/session-model-env";
import { routedChildLaunchRoute } from "../../src/utils/child-launch-route";
import { withEnvOverlaySync } from "../fixtures/env-overlay";

const LOCAL_INHERIT_ROUTING = Object.freeze({
  schemaVersion: 1,
  defaultClass: "cloud",
  modelClasses: { local: ["desktop-vllm/*"] },
  targets: {},
  rules: [{ id: "local-children-inherit-parent", when: { parentClass: "local" }, use: { kind: "parent" } }],
});

const withRoutingConfig = <T>(routing: unknown, operation: (agentDir: string) => T): T => {
  const agentDir = mkdtempSync(join(tmpdir(), "loom-session-model-"));
  writeFileSync(join(agentDir, "model-routing.json"), JSON.stringify(routing));
  try {
    return operation(agentDir);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
};

describe("sessionModelEnv", () => {
  it("projects exactly the provider and model id, and nothing when Pi exposed no model", () => {
    expect(sessionModelEnv({ provider: "desktop-vllm", id: "warmind-1017-native" })).toEqual({
      PI_PROVIDER: "desktop-vllm",
      PI_MODEL: "warmind-1017-native",
    });
    // An unusable model must never erase an environment it cannot describe.
    for (const model of [null, undefined, { provider: "", id: "x" }, { provider: "desktop-vllm", id: "" }]) {
      expect(sessionModelEnv(model as never)).toBeNull();
    }
  });
});

describe("projectSessionModelIntoEnv", () => {
  it("reprojects a mid-run model switch, is idempotent, and leaves an unknown model's environment untouched", () => {
    withEnvOverlaySync({ PI_PROVIDER: "desktop-vllm", PI_MODEL: "glm-5.3-flash-spark-tp2-v14" }, () => {
      expect(projectSessionModelIntoEnv({ provider: "desktop-vllm", id: "warmind-1017-native" })).toBe(true);
      expect([process.env["PI_PROVIDER"], process.env["PI_MODEL"]])
        .toEqual(["desktop-vllm", "warmind-1017-native"]);
      expect(projectSessionModelIntoEnv({ provider: "desktop-vllm", id: "warmind-1017-native" })).toBe(true);
      expect([process.env["PI_PROVIDER"], process.env["PI_MODEL"]])
        .toEqual(["desktop-vllm", "warmind-1017-native"]);
      expect(projectSessionModelIntoEnv(undefined)).toBe(false);
      expect([process.env["PI_PROVIDER"], process.env["PI_MODEL"]])
        .toEqual(["desktop-vllm", "warmind-1017-native"]);
    });
  });

  it("makes the routed child launch route follow the live session model, not the exported one", () => {
    withRoutingConfig(LOCAL_INHERIT_ROUTING, (agentDir) => {
      withEnvOverlaySync({ PI_CODING_AGENT_DIR: agentDir, PI_PROVIDER: "desktop-vllm", PI_MODEL: "glm-5.3-flash-spark-tp2-v14" }, () => {
        // Before: the exported (start) model decides the child's route.
        expect(routedChildLaunchRoute("code-reviewer")).toEqual({
          provider: "desktop-vllm",
          model: "glm-5.3-flash-spark-tp2-v14",
        });
        projectSessionModelIntoEnv({ provider: "desktop-vllm", id: "warmind-1017-native" });
        // After: every Loom reader of the parent sees the session's real model.
        for (const role of ["code-reviewer", "pr-test-analyzer", "architecture-tech-lead"]) {
          expect(routedChildLaunchRoute(role)).toEqual({
            provider: "desktop-vllm",
            model: "warmind-1017-native",
          });
        }
      });
    });
  });
});
