import { accessSync, constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { extractNamespace } from "./strip-namespace";
import { LOOM_PACKAGE_ROOT } from "./loom-package-root";
import { resolveRepositoryRoot } from "./git";

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

  // A non-repository install can still resolve package, home, or cwd agents —
  // but the failure is REPORTED, not swallowed: an unresolved root silently
  // drops the repository-relative candidates below, so a definition that
  // exists at `<repo>/agents/<name>.md` reads as "cannot locate agent
  // definition" and the policy gate blocks with a misleading cause.
  const repositoryRoot = resolveRepositoryRoot("Claude agent-definition resolution") ?? null;

  if (!namespace) {
    if (repositoryRoot) candidates.push(join(repositoryRoot, ".claude", "agents", `${agentName}.md`));
    candidates.push(join(process.env.HOME ?? "", ".claude", "agents", `${agentName}.md`));
  }

  // Development checkout: policy code and source agents ship together. Include
  // both lexical cwd and the repository root because hooks may execute below it.
  candidates.push(join(process.cwd(), "agents", `${agentName}.md`));
  if (repositoryRoot) candidates.push(join(repositoryRoot, "agents", `${agentName}.md`));

  for (const path of candidates) {
    try {
      accessSync(path, fsConstants.F_OK);
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error(
        `cannot inspect authoritative Claude agent definition candidate ${path}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return null;
}
