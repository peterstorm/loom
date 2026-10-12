import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderTaskImplementationBrief } from "../../src/orchestration/implementation-brief";
import { LOOM_PACKAGE_ROOT } from "../../src/utils/loom-package-root";
import { canonicalTempDir } from "../fixtures/canonical-temp-dir";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A protected graph on disk: T1 (Wave 1) and its dependent T2 (Wave 2). */
function graphWith(t1Status: "completed" | "implemented"): string {
  // The canonical root: macOS tmpdir() sits behind the /var symlink, which the
  // State File boundary refuses to follow.
  const root = canonicalTempDir("loom-brief-");
  roots.push(root);
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  const path = join(root, ".claude", "state", "active_task_graph.json");
  writeFileSync(path, JSON.stringify({
    current_phase: "execute", current_wave: 2, phase_artifacts: {}, skipped_phases: [],
    spec_file: null, plan_file: null, wave_gates: {},
    tasks: [
      {
        id: "T1", description: "Build the seam", agent: "code-implementer-agent", wave: 1, depends_on: [],
        file_list: ["src/seam.ts", "src/seam-types.ts"], files_modified: ["src/seam.ts", "src/extra.ts"],
        status: t1Status, legacy_missing_proof: true,
      },
      {
        id: "T2", description: "Use the seam", agent: "code-implementer-agent", wave: 2, depends_on: ["T1"],
        file_list: ["src/use.ts"], status: "pending",
      },
    ],
  }));
  return path;
}

describe("renderTaskImplementationBrief predecessor output", () => {
  it("shows the dependent what its completed dependency actually changed, read from the protected graph", () => {
    const rendered = renderTaskImplementationBrief(graphWith("completed"), LOOM_PACKAGE_ROOT, "T2");
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.prompt).toContain([
      "## What Your Dependencies Produced",
      "",
      "- **T1** — Build the seam",
      "  - Completed: no Requirement Completion Claims",
      "  - Changed:",
      "    - src/seam.ts",
      "    - src/extra.ts",
      "  - Declared but unchanged:",
      "    - src/seam-types.ts",
    ].join("\n"));
  });

  it("refuses a dependent whose dependency has not passed its Wave Gate", () => {
    const rendered = renderTaskImplementationBrief(graphWith("implemented"), LOOM_PACKAGE_ROOT, "T2");
    expect(rendered).toEqual({
      ok: false,
      error: "T2: dependency T1 is implemented, not completed; a dependent is dispatched only after its dependencies pass their Wave Gate",
    });
  });
});
