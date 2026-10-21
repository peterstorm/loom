import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ENGINE = fileURLToPath(new URL("../../../", import.meta.url));

describe("orchestration status TaskGraph diagnostics", () => {
  it("preserves the state path and JSON parse cause instead of reporting a schema symptom", () => {
    const dir = mkdtempSync(join(tmpdir(), "loom-status-diagnostic-"));
    const statePath = join(dir, "active_task_graph.json");
    writeFileSync(statePath, '{"current_phase":');

    try {
      const output = execFileSync(
        "bun",
        ["src/cli.ts", "helper", "orchestration", "status", "--json"],
        {
          cwd: ENGINE,
          encoding: "utf-8",
          env: { ...process.env, LOOM_STATE_PATH: statePath, PI_CODING_AGENT: "" },
        },
      );
      const rendered = JSON.parse(output) as {
        next: { action: { kind: string; diagnostic: { message: string } } };
      };

      expect(rendered.next.action.kind).toBe("blocked");
      expect(rendered.next.action.diagnostic.message).toContain(`cannot read task graph at ${statePath}`);
      expect(rendered.next.action.diagnostic.message).toMatch(/JSON Parse error|Unexpected/);
      expect(rendered.next.action.diagnostic.message).not.toContain("missing current_phase");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
