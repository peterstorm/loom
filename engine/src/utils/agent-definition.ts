import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { extractNamespace } from "./strip-namespace";
import { LOOM_PACKAGE_ROOT } from "./loom-package-root";

/**
 * One Claude agent-definition resolver shared by model and skill policy gates.
 * Pi uses generated definitions under PI_CODING_AGENT_DIR and intentionally
 * remains a separate boundary.
 */
export function resolveClaudeAgentDefinitionPath(
  agentName: string,
  fullAgentType: string,
): string | null {
  const candidates: string[] = [];
  const namespace = extractNamespace(fullAgentType);

  if (namespace) {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    if (pluginRoot) candidates.push(join(pluginRoot, "agents", `${agentName}.md`));
    if (namespace === "loom") candidates.push(join(LOOM_PACKAGE_ROOT, "agents", `${agentName}.md`));
  }

  let repositoryRoot: string | null = null;
  try {
    repositoryRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
  } catch {
    // A non-repository install can still resolve package, home, or cwd agents.
  }

  if (!namespace) {
    if (repositoryRoot) candidates.push(join(repositoryRoot, ".claude", "agents", `${agentName}.md`));
    candidates.push(join(process.env.HOME ?? "", ".claude", "agents", `${agentName}.md`));
  }

  // Development checkout: policy code and source agents ship together. Include
  // both lexical cwd and the repository root because hooks may execute below it.
  candidates.push(join(process.cwd(), "agents", `${agentName}.md`));
  if (repositoryRoot) candidates.push(join(repositoryRoot, "agents", `${agentName}.md`));

  return candidates.find((path) => existsSync(path)) ?? null;
}
