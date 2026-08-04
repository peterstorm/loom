/**
 * Fail-closed LLM-profile enforcement for every Loom-owned agent.
 *
 * Claude Code supplies the requested model on the Agent/Task call. Pi's
 * generic subagent tool obtains it from the selected agent definition, so the
 * Pi path reads that frontmatter instead. Neither path may inherit the parent
 * session's current model.
 */

import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import type { HookHandler, PreToolUseInput } from "../../types";
import { TASK_GRAPH_PATH } from "../../config";
import { SUBAGENT_SPAWN_TOOLS } from "../../core/tool-vocabulary";
import {
  parseAgentName,
  validateExplicitSpawnModel,
  validateAgentPolicyFrontmatter,
} from "../../core/model-profiles";
import { extractNamespace, stripNamespace } from "../../utils/strip-namespace";
import { LOOM_PACKAGE_ROOT } from "../../utils/loom-package-root";
import { validatePiAgentDefinitionFile } from "../../utils/render-pi-agent";

function claudeAgentPath(agentName: string, fullAgentType: string): string | null {
  const candidates: string[] = [];
  const namespace = extractNamespace(fullAgentType);
  if (namespace) {
    // The executing engine and its agent catalog are one package. Import URL is
    // authoritative under local Pi installs, npm/git packages, Nix stores, and
    // Claude Code; another harness's cache is never consulted.
    if (process.env.CLAUDE_PLUGIN_ROOT) {
      candidates.push(join(process.env.CLAUDE_PLUGIN_ROOT, "agents", `${agentName}.md`));
    }
    if (namespace === "loom") {
      candidates.push(join(LOOM_PACKAGE_ROOT, "agents", `${agentName}.md`));
    }
  } else {
    try {
      const root = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
      candidates.push(join(root, ".claude/agents", `${agentName}.md`));
    } catch {}
    candidates.push(join(process.env.HOME ?? "", ".claude/agents", `${agentName}.md`));
  }
  // Development checkout: the policy and the agent definition ship together.
  candidates.push(join(process.cwd(), "agents", `${agentName}.md`));
  return candidates.find(existsSync) ?? null;
}

function piAgentPath(agentName: string): string | null {
  const home = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
  const candidates = [join(home, "agents", `${agentName}.md`)];
  return candidates.find(existsSync) ?? null;
}

function modelFrontmatter(path: string): { name: string; model?: string; "model-profile"?: string } | null {
  try {
    const content = readFileSync(path, "utf-8");
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;
    const fields: Record<string, string> = {};
    for (const line of match[1]!.split(/\r?\n/)) {
      const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
      if (field && field[2] !== "") fields[field[1]!] = field[2]!;
    }
    return {
      name: fields.name ?? "",
      ...(fields.model ? { model: fields.model } : {}),
      ...(fields["model-profile"] ? { "model-profile": fields["model-profile"] } : {}),
    };
  } catch {
    return null;
  }
}

const handler: HookHandler = async (stdin) => {
  if (!existsSync(TASK_GRAPH_PATH)) return { kind: "allow" };

  let input: PreToolUseInput;
  try {
    input = JSON.parse(stdin);
  } catch (error) {
    return {
      kind: "block",
      message: `validate-agent-model: malformed hook input — failing closed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!SUBAGENT_SPAWN_TOOLS.has(input.tool_name)) return { kind: "allow" };

  const rawAgent = (input.tool_input?.subagent_type as string | undefined)
    ?? (input.tool_input?.agent as string | undefined)
    ?? "";
  const parsedAgent = parseAgentName(rawAgent);
  // Non-Loom utility agents remain outside Loom model policy.
  if (!parsedAgent.ok) return { kind: "allow" };
  const agent = stripNamespace(parsedAgent.value);

  if (input.tool_name === "subagent") {
    const requestedScope = input.tool_input?.agentScope ?? "user";
    if (requestedScope !== "user") {
      return {
        kind: "block",
        message: `BLOCKED: Loom-owned Pi agents require agentScope='user'; got ${JSON.stringify(requestedScope)}.`,
      };
    }
    const path = piAgentPath(agent);
    if (!path) {
      return {
        kind: "block",
        message: `BLOCKED: Pi agent '${agent}' has no generated definition. Run scripts/sync-pi-agents.sh; current-model inheritance is forbidden.`,
      };
    }
    const validation = validatePiAgentDefinitionFile(path, agent, LOOM_PACKAGE_ROOT);
    return validation.ok
      ? { kind: "allow" }
      : {
          kind: "block",
          message: `BLOCKED: Pi agent policy failed for '${agent}' (${path}):\n  - ${validation.error}`,
        };
  }

  const path = claudeAgentPath(agent, rawAgent);
  if (!path) {
    return {
      kind: "block",
      message: `BLOCKED: cannot locate agent definition for '${rawAgent}'; model policy cannot be proven.`,
    };
  }
  const fields = modelFrontmatter(path);
  const frontmatter = validateAgentPolicyFrontmatter(fields);
  const requested = validateExplicitSpawnModel(agent, "claude-code", input.tool_input?.model);
  const errors = [
    ...(frontmatter.ok ? [] : frontmatter.errors),
    ...(requested.ok ? [] : requested.errors),
  ];
  return errors.length === 0
    ? { kind: "allow" }
    : {
        kind: "block",
        message: `BLOCKED: Claude Code model policy failed for '${rawAgent}' (${path}):\n${errors.map((e) => `  - ${e}`).join("\n")}`,
      };
};

export default handler;
