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
import {
  engineIssuedClaudeModelFromRunDir,
  loomMarkerValue,
  runDirectoryFromContextPath,
} from "../../core/grandfathered-spawn-model";
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
  const requestedModel = input.tool_input?.model;
  const requested = validateExplicitSpawnModel(agent, "claude-code", requestedModel);
  // A current-policy MISMATCH (the orchestrator supplied a model, just not
  // today's) may be a grandfathered wave-reviewer retry: the engine issued
  // attempt-2 from a stored attempt-1 whose profile predates a promotion. If
  // the engine's own issued authority for THIS request authorizes exactly the
  // supplied model, honor it. A missing model (inheritance) or a frontmatter
  // fault is never grandfathered — only a mismatch against a proven authority.
  if (
    frontmatter.ok &&
    !requested.ok &&
    typeof requestedModel === "string" &&
    spawnModelIsEngineAuthorized(input, requestedModel)
  ) {
    return { kind: "allow" };
  }
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

/**
 * Did the engine itself issue `requestedModel` for the request this spawn
 * carries? Reads the issued authorities directly from the run directory the
 * spawn self-identifies (LOOM_CONTEXT_PATH), keyed on its LOOM_REQUEST_ID.
 * Every failure — no markers, unreadable dir, no matching authority — returns
 * false so the caller keeps the original block: the rescue can only ADD an
 * allow when a real, guarded, tamper-evident authority proves the model, never
 * remove one.
 */
function spawnModelIsEngineAuthorized(input: PreToolUseInput, requestedModel: string): boolean {
  const prompt = typeof input.tool_input?.prompt === "string" ? input.tool_input.prompt : "";
  const requestId = loomMarkerValue(prompt, "REQUEST_ID");
  const contextPath = loomMarkerValue(prompt, "CONTEXT_PATH");
  if (requestId === null || contextPath === null) return false;
  const runDirectory = runDirectoryFromContextPath(contextPath);
  if (runDirectory === null) return false;
  return engineIssuedClaudeModelFromRunDir(runDirectory, requestId) === requestedModel;
}

export default handler;
