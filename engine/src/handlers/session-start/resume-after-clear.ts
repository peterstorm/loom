/**
 * Inject execution context into fresh conversation after /clear.
 * Stdout from SessionStart hooks is auto-injected as context by Claude Code.
 */

import { existsSync } from "node:fs";
import { StateManager } from "../../state-manager";
import { TASK_GRAPH_PATH } from "../../config";
import type { HookHandler } from "../../types";
import type { TaskGraph, Task } from "../../types";

function statusIcon(status: string): string {
  switch (status) {
    case "completed": return "done";
    case "implemented": return "impl";
    case "failed": return "FAIL";
    default: return status;
  }
}

function buildContextOutput(state: TaskGraph, loomDir: string): string {
  const maxWave = state.tasks.reduce((m, t) => Math.max(m, t.wave), 0);
  const currentWave = state.current_wave ?? 1;

  const taskRows = state.tasks
    .sort((a, b) => a.wave - b.wave || a.id.localeCompare(b.id))
    .map((t: Task) => `| ${t.id} | ${t.wave} | ${t.agent} | ${statusIcon(t.status)} | ${t.description} |`)
    .join("\n");

  const lines = [
    "<!-- LOOM RESUME CONTEXT -->",
    "# Active Loom Session — Execute Phase",
    "",
  ];

  if (state.spec_file) lines.push(`**Spec:** ${state.spec_file}`);
  if (state.plan_file) lines.push(`**Plan:** ${state.plan_file}`);
  if (state.github_issue && state.github_repo) {
    lines.push(`**GitHub Issue:** ${state.github_repo}#${state.github_issue}`);
  } else if (state.github_issue) {
    lines.push(`**GitHub Issue:** #${state.github_issue}`);
  }
  lines.push(`**Current Wave:** ${currentWave} of ${maxWave}`);
  lines.push("");
  lines.push("## Task Graph");
  lines.push("| ID | Wave | Agent | Status | Description |");
  lines.push("|----|------|-------|--------|-------------|");
  lines.push(taskRows);
  lines.push("");
  lines.push("## Instructions");
  lines.push(`Read the loom skill at \`${loomDir}/commands/loom.md\`, specifically Phase 5: Execute.`);
  lines.push(`Spawn all pending wave ${currentWave} tasks in parallel using the Task tool.`);
  lines.push(`Load impl-agent-context template from \`${loomDir}/commands/templates/impl-agent-context.md\`.`);
  lines.push("<!-- END LOOM RESUME CONTEXT -->");

  return lines.join("\n");
}

function resolveLoomDir(): string {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) return pluginRoot;
  // Fallback: derive from __dirname (engine/src/handlers/session-start/) → 4 levels up
  return new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
}

const handler: HookHandler = async (_stdin, _args) => {
  if (!existsSync(TASK_GRAPH_PATH)) return { kind: "passthrough" };

  const sm = StateManager.fromPath(TASK_GRAPH_PATH);
  if (!sm) return { kind: "passthrough" };

  const state = sm.load();

  // Only inject context when in execute phase with populated tasks
  if (state.current_phase !== "execute" || state.tasks.length === 0) {
    return { kind: "passthrough" };
  }

  const loomDir = resolveLoomDir();
  const output = buildContextOutput(state, loomDir);
  process.stdout.write(output + "\n");

  return { kind: "passthrough" };
};

export default handler;
