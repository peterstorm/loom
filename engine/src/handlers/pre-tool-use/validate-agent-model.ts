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

import { lstatSync, readFileSync, readdirSync } from "node:fs";
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
  anchoredRunDirectoryFromContextPath,
  engineIssuedClaudeModel,
  loomMarkerValue,
} from "../../core/grandfathered-spawn-model";
import { resolveRepositoryRoot } from "../../utils/git";
import { parseFrontmatterFields } from "../../utils/frontmatter";
import { parseStoredAgentRequestAuthority, type AgentRequestAuthority } from "../../core/orchestration-contract";
import { stripNamespace } from "../../utils/strip-namespace";
import { LOOM_PACKAGE_ROOT } from "../../utils/loom-package-root";
import { resolveClaudeAgentDefinitionPath } from "../../utils/agent-definition";
import { validatePiAgentDefinitionFile } from "../../utils/render-pi-agent";

type PiAgentDefinitionLookup =
  | Readonly<{ kind: "found"; path: string }>
  | Readonly<{ kind: "absent"; path: string }>
  | Readonly<{ kind: "unreadable"; path: string; error: string }>;

function piAgentDefinition(agentName: string): PiAgentDefinitionLookup {
  const home = process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent");
  const path = join(home, "agents", `${agentName}.md`);
  try {
    lstatSync(path);
    return { kind: "found", path };
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { kind: "absent", path }
      : {
          kind: "unreadable",
          path,
          error: error instanceof Error ? error.message : String(error),
        };
  }
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
  const fields = parseFrontmatterFields(content);
  if (fields === null) return { ok: true, value: null };
  return {
    ok: true,
    value: {
      name: fields.name ?? "",
      ...(fields.model ? { model: fields.model } : {}),
      ...(fields["model-profile"] ? { "model-profile": fields["model-profile"] } : {}),
    },
  };
}

/** An untrusted `tool_input` field as a string, or `undefined` if it is not one. */
const readString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

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

  // Read, not cast. `tool_input` is `Record<string, unknown>` straight off
  // untrusted hook JSON: `as string | undefined` let a non-string value through
  // as if it were an agent name, and the very next call fed it to a parser that
  // assumes a string. A non-string is simply not a name — it reads as absent.
  const rawAgent = readString(input.tool_input?.subagent_type)
    ?? readString(input.tool_input?.agent)
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
    const definition = piAgentDefinition(agent);
    if (definition.kind === "absent") {
      return {
        kind: "block",
        message: `BLOCKED: Pi agent '${agent}' has no generated definition. Run scripts/sync-pi-agents.sh; model routing cannot prove a binding without the synced render.`,
      };
    }
    if (definition.kind === "unreadable") {
      return {
        kind: "block",
        message: `BLOCKED: cannot inspect Pi agent definition '${agent}' (${definition.path}): ${definition.error}`,
      };
    }
    const validation = validatePiAgentDefinitionFile(definition.path, agent, LOOM_PACKAGE_ROOT);
    return validation.ok
      ? { kind: "allow" }
      : {
          kind: "block",
          message: `BLOCKED: Pi agent policy failed for '${agent}' (${definition.path}):\n  - ${validation.error}`,
        };
  }

  let path: string | null;
  try {
    path = resolveClaudeAgentDefinitionPath(agent, rawAgent);
  } catch (error) {
    return {
      kind: "block",
      message: `BLOCKED: Claude Code agent-definition authority for '${rawAgent}' is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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
  const grandfathered = frontmatter.ok && !requested.ok && typeof requestedModel === "string"
    ? grandfatheredModelAuthorization(input, requestedModel)
    : null;
  if (grandfathered?.authorized) return { kind: "allow" };
  const errors = [
    ...(frontmatter.ok ? [] : frontmatter.errors),
    ...(requested.ok ? [] : requested.errors),
    ...(grandfathered?.diagnostic === undefined ? [] : [grandfathered.diagnostic]),
  ];
  return errors.length === 0
    ? { kind: "allow" }
    : {
        kind: "block",
        message: `BLOCKED: Claude Code model policy failed for '${rawAgent}' (${path}):\n${errors.map((e) => `  - ${e}`).join("\n")}`,
      };
};

export type EngineIssuedClaudeModelLookup =
  | Readonly<{ kind: "found"; model: string }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "unavailable"; message: string }>;

/** Read engine-issued model authority without collapsing corruption into absence. */
export function lookupEngineIssuedClaudeModel(
  runDirectory: string,
  requestId: string,
): EngineIssuedClaudeModelLookup {
  let names: readonly string[];
  try {
    names = readdirSync(join(runDirectory, "requests"));
  } catch (error) {
    return {
      kind: "unavailable",
      message: `cannot read issued request directory ${join(runDirectory, "requests")}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const issued: AgentRequestAuthority[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(runDirectory, "requests", name);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    } catch (error) {
      return {
        kind: "unavailable",
        message: `cannot read issued request authority ${path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const parsed = parseStoredAgentRequestAuthority(raw);
    if (!parsed.ok) {
      return {
        kind: "unavailable",
        message: `issued request authority ${path} is invalid: ${parsed.error.violations.map(({ message }) => message).join("; ")}`,
      };
    }
    issued.push(parsed.value);
  }
  const model = engineIssuedClaudeModel(issued, requestId);
  return model === null ? { kind: "absent" } : { kind: "found", model };
}

/** Compatibility projection: only positive authority yields a model. */
export function engineIssuedClaudeModelFromRunDir(
  runDirectory: string,
  requestId: string,
): string | null {
  const lookup = lookupEngineIssuedClaudeModel(runDirectory, requestId);
  return lookup.kind === "found" ? lookup.model : null;
}

/**
 * Did the engine itself issue `requestedModel` for the request this spawn
 * carries? Keyed on the spawn's LOOM_REQUEST_ID, read from the run directory
 * its LOOM_CONTEXT_PATH names — but only after that directory is ANCHORED to a
 * canonical, in-repository Run Directory (`anchoredRunDirectoryFromContextPath`).
 *
 * The anchor is the whole security property. Both markers are written by the
 * spawning agent, and a stored authority proves only internal self-consistency,
 * never authorship; without anchoring, a self-consistent authority JSON under
 * ANY writable path (`/tmp/x/requests/a.json`) let a spawn name whatever model
 * it liked. Anchoring confines the read to directories the engine creates and
 * guards.
 *
 * Every failure — no markers, an unanchored path, an unreadable dir, no
 * matching authority — returns false so the caller keeps the original block:
 * the rescue can only ADD an allow when a real, guarded authority proves the
 * model, never remove one.
 */
type GrandfatheredModelAuthorization =
  | Readonly<{ authorized: true }>
  | Readonly<{ authorized: false; diagnostic: string }>;

function grandfatheredModelAuthorization(
  input: PreToolUseInput,
  requestedModel: string,
): GrandfatheredModelAuthorization {
  const prompt = typeof input.tool_input?.prompt === "string" ? input.tool_input.prompt : "";
  const requestId = loomMarkerValue(prompt, "REQUEST_ID");
  const contextPath = loomMarkerValue(prompt, "CONTEXT_PATH");
  if (requestId === null || contextPath === null) {
    return { authorized: false, diagnostic: "grandfathered model authority requires exact request and context markers" };
  }
  const repositoryRoot = resolveRepositoryRoot();
  if (repositoryRoot === undefined) {
    return { authorized: false, diagnostic: "grandfathered model authority cannot resolve the repository root" };
  }
  const runDirectory = anchoredRunDirectoryFromContextPath(repositoryRoot, contextPath);
  if (runDirectory === null) {
    return { authorized: false, diagnostic: "grandfathered model authority context is not anchored to an in-repository Run Directory" };
  }
  const lookup = lookupEngineIssuedClaudeModel(runDirectory, requestId);
  if (lookup.kind === "unavailable") {
    return { authorized: false, diagnostic: `grandfathered model authority is unreadable: ${lookup.message}` };
  }
  if (lookup.kind === "absent") {
    return { authorized: false, diagnostic: `grandfathered model authority has no issued request ${requestId}` };
  }
  return lookup.model === requestedModel
    ? { authorized: true }
    : {
        authorized: false,
        diagnostic: `grandfathered model authority issued ${JSON.stringify(lookup.model)}, not ${JSON.stringify(requestedModel)}`,
      };
}

export function spawnModelIsEngineAuthorized(input: PreToolUseInput, requestedModel: string): boolean {
  return grandfatheredModelAuthorization(input, requestedModel).authorized;
}

export default handler;
