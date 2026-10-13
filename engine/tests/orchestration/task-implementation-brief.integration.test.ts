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

/** A protected graph on disk: T1 (Wave 1) and its dependent T2 (Wave 2). With
 *  `plan`, the graph's plan_file names a plan at `.claude/plans/plan.md` (the
 *  text, or `null` for a plan_file that names no existing file). */
function graphWith(t1Status: "completed" | "implemented", plan?: string | null): string {
  // The canonical root: macOS tmpdir() sits behind the /var symlink, which the
  // State File boundary refuses to follow.
  const root = canonicalTempDir("loom-brief-");
  roots.push(root);
  mkdirSync(join(root, ".claude", "state"), { recursive: true });
  mkdirSync(join(root, ".claude", "plans"), { recursive: true });
  if (typeof plan === "string") writeFileSync(join(root, ".claude", "plans", "plan.md"), plan);
  const path = join(root, ".claude", "state", "active_task_graph.json");
  writeFileSync(path, JSON.stringify({
    current_phase: "execute", current_wave: 2, phase_artifacts: {}, skipped_phases: [],
    spec_file: null, plan_file: plan === undefined ? null : ".claude/plans/plan.md", wave_gates: {},
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

  it("renders the plan's invariant ownership for the Task that changes a sibling entry point", () => {
    const plan = [
      "# Plan", "", "## Invariants", "",
      "### INV-1: The seam owns parsing", "",
      "**Tier:** advisory",
      "**Owner module:** `src/seam.ts`",
      "**Sibling entry points:**",
      "- `src/use.ts` — consumer",
      "**Matrix test:** `src/seam.matrix.test.ts`",
      "**Statement:** Only the seam parses input.", "",
    ].join("\n");
    const rendered = renderTaskImplementationBrief(graphWith("completed", plan), LOOM_PACKAGE_ROOT, "T2");
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.prompt).toContain("**INV-1: The seam owns parsing**");
    expect(rendered.value.prompt).toContain("- Sibling: you change `src/use.ts`. Call the owner module `src/seam.ts`; never re-implement the rule.");
  });

  it("refuses when the recorded plan cannot be read, rather than dropping its invariants", () => {
    const rendered = renderTaskImplementationBrief(graphWith("completed", null), LOOM_PACKAGE_ROOT, "T2");
    expect(rendered.ok).toBe(false);
    if (rendered.ok) return;
    expect(rendered.error).toContain("cannot read the plan");
    expect(rendered.error).toContain("plan.md");
  });

  it("refuses a dependent whose dependency has not passed its Wave Gate", () => {
    const rendered = renderTaskImplementationBrief(graphWith("implemented"), LOOM_PACKAGE_ROOT, "T2");
    expect(rendered).toEqual({
      ok: false,
      error: "T2: dependency T1 is implemented, not completed; a dependent is dispatched only after its dependencies pass their Wave Gate",
    });
  });
});
