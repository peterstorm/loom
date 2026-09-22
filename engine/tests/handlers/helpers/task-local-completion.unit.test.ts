import { describe, expect, it } from "vitest";
import { isEngineOwnedRuntimePath } from "../../../src/handlers/helpers/task-local-completion";

describe("isEngineOwnedRuntimePath", () => {
  it("claims the harness state and review-run artifact domains", () => {
    expect(isEngineOwnedRuntimePath(".claude/state/active_task_graph.json")).toBe(true);
    expect(isEngineOwnedRuntimePath(".pi/state/pointers.json")).toBe(true);
    expect(isEngineOwnedRuntimePath(
      ".claude/reviews/wave-gate-runs/run.x/authority.json",
    )).toBe(true);
    expect(isEngineOwnedRuntimePath(".claude/reviews/wave-14-advisory-triage.md")).toBe(true);
    expect(isEngineOwnedRuntimePath(
      ".claude/specs/2026-08-02-baby-adventure/panel-runs/run.abc/interview.md",
    )).toBe(true);
  });

  it("leaves every Task-scope path unclaimed", () => {
    expect(isEngineOwnedRuntimePath("src/features/tracking/ui/FavoritesView.tsx")).toBe(false);
    expect(isEngineOwnedRuntimePath(".claude/plans/2026-08-02-baby-adventure.md")).toBe(false);
    expect(isEngineOwnedRuntimePath(".claude/specs/2026-08-02-baby-adventure/spec.md")).toBe(false);
    expect(isEngineOwnedRuntimePath(".claude/specs/nested/other/panel-runs-suffix.md")).toBe(false);
    expect(isEngineOwnedRuntimePath("reviews/run.json")).toBe(false);
  });
});
