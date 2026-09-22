import { describe, expect, it } from "vitest";
import {
  authoritativeStateRepositoryPath,
  isEngineOwnedRuntimePath,
} from "../../../src/handlers/helpers/task-local-completion";

describe("exact Task-local runtime ownership", () => {
  it("projects only an in-repository authoritative State File", () => {
    expect(authoritativeStateRepositoryPath(
      "/project",
      "/project/.custom/state/active_task_graph.json",
    )).toBe(".custom/state/active_task_graph.json");
    expect(authoritativeStateRepositoryPath("/project", "/other/state.json")).toBeNull();
  });

  it("claims only the exact authoritative State File", () => {
    const statePath = ".custom/state/active_task_graph.json";
    expect(isEngineOwnedRuntimePath(statePath, statePath)).toBe(true);
    expect(isEngineOwnedRuntimePath(".claude/state/other.json", statePath)).toBe(false);
    expect(isEngineOwnedRuntimePath(
      ".claude/reviews/wave-gate-runs/run.x/authority.json",
      statePath,
    )).toBe(false);
    expect(isEngineOwnedRuntimePath(
      ".claude/specs/feature/panel-runs/run.abc/interview.md",
      statePath,
    )).toBe(false);
  });
});
