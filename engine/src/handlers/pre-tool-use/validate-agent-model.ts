/**
 * Fail-closed LLM-profile enforcement for every Loom-owned agent.
 *
 * Claude Code supplies the requested model on the Agent/Task call; it must
 * match the agent's declared profile binding exactly. Inheritance is never a
 * fallback on that path.
 *
 * On Pi the launcher (the machine's subagent tool plus its model-routing
 * policy) decides the effective model at spawn. Loom's Pi agents are rendered
 * with their declared binding, but the launcher may deliberately override it
 * — for example inheriting the parent session's model when the parent runs a
 * local model. This guard therefore proves the Pi definition is the synced
 * render and the spawn scope is user-global; it does not veto the launcher's
 * routing decision.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookHandler, PreToolUseInput } from "../../types";
import { SUBAGENT_SPAWN_TOOLS } from "../../core/tool-vocabulary";
import {
  isLoomNamespacedAgent,
  parseAgentName,
  validateExplicitSpawnModel,
  validateAgentPolicyFrontmatter,
} from "../../core/model-profiles";
import { stripNamespace } from "../../utils/strip-namespace";
import { LOOM_PACKAGE_ROOT } from "../../utils/loom-package-root";
import { resolveClaudeAgentDefinitionPath } from "../../utils/agent-definition";
import { validatePiAgentDefinitionFile } from "../../utils/render-pi-agent";

function piAgentPath(agentName: string): string | null {
  const home = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
  const candidates = [join(home, "agents", `${agentName}.md`)];
  return candidates.find(existsSync) ?? null;
}

type ModelFrontmatterRead =
  | Readonly<{ ok: true; value: { name: string; model?: string; "model-profile"?: string } | null }>
  | Readonly<{ ok: false; error: string }>;

function modelFrontmatter(path: string): ModelFrontmatterRead {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { ok: true, value: null };
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (field && field[2] !== "") fields[field[1]!] = field[2]!;
  }
  return {
    ok: true,
    value: {
      name: fields.name ?? "",
      ...(fields.model ? { model: fields.model } : {}),
      ...(fields["model-profile"] ? { "model-profile": fields["model-profile"] } : {}),
    },
  };
}

const handler: HookHandler = async (stdin) => {
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
  // Non-Loom utility agents remain outside Loom model policy. An unknown name
  // that claims Loom's reserved namespace is Loom-owned and fails closed.
  if (!parsedAgent.ok) {
    return isLoomNamespacedAgent(rawAgent)
      ? { kind: "block", message: `BLOCKED: ${parsedAgent.error.message}` }
      : { kind: "allow" };
  }
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
        message: `BLOCKED: Pi agent '${agent}' has no generated definition. Run scripts/sync-pi-agents.sh; model routing cannot prove a binding without the synced render.`,
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

  const path = resolveClaudeAgentDefinitionPath(agent, rawAgent);
  if (!path) {
    return {
      kind: "block",
      message: `BLOCKED: cannot locate agent definition for '${rawAgent}'; model policy cannot be proven.`,
    };
  }
  const fields = modelFrontmatter(path);
  if (!fields.ok) {
    return {
      kind: "block",
      message: `BLOCKED: cannot read Claude Code agent definition '${rawAgent}' (${path}): ${fields.error}`,
    };
  }
  const frontmatter = validateAgentPolicyFrontmatter(fields.value);
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
