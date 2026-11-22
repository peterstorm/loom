/**
 * Claude spawn-side request correlator.
 *
 * The façade places the LOOM_REQUEST_ID / LOOM_CONTEXT_DIGEST authority markers
 * in every engine-issued Agent prompt (`renderSpawnTaskText`), read back by the
 * one parser beside it. Claude's PostToolUse payload is the first boundary that contains
 * both that exact prompt and the harness-native child id, so this handler
 * persists the binding — for a background spawn, before SubagentStop can
 * present result bytes. A foreground spawn finishes before its Agent call
 * returns, so its SubagentStop records the same correlator first from the
 * agent's own spawn prompt; the write is idempotent and this handler then
 * merely agrees with it.
 *
 * Which run the marker belongs to is resolved by `resolveClaudeSpawnRun`: the
 * explicit LOOM_ORCHESTRATION_* authority when set, otherwise the session run
 * binding the façade published for this Claude Code session.
 */

import type { HookHandler, HookResult } from "../../types";
import {
  claudeRunContext,
  recordClaudeSpawnCorrelator,
  resolveClaudeSpawnRun,
} from "../../orchestration/claude-run-authority";
import { explicitRun } from "../../orchestration/session-run-bindings";
import { parseIssuedTaskIdentity } from "../../core/spawn-task-text";
import { subagentDir } from "../../config";
import { stripNamespace } from "../../utils/strip-namespace";

type ClaudePostToolUseInput = Readonly<{
  session_id?: unknown;
  tool_name?: unknown;
  tool_input?: unknown;
  tool_response?: unknown;
}>;

function exactRecord(raw: unknown): Readonly<Record<string, unknown>> | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw as Readonly<Record<string, unknown>>
    : null;
}

function nativeAgentIds(raw: unknown, depth = 0): readonly string[] {
  if (depth > 5) return Object.freeze([]);
  if (Array.isArray(raw)) return Object.freeze(raw.flatMap((entry) => nativeAgentIds(entry, depth + 1)));
  const record = exactRecord(raw);
  if (record === null) return Object.freeze([]);
  const direct = [record["agent_id"], record["agentId"]]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const nested = Object.entries(record)
    .filter(([key]) => key !== "agent_id" && key !== "agentId")
    .flatMap(([, value]) => nativeAgentIds(value, depth + 1));
  return Object.freeze([...new Set([...direct, ...nested])]);
}

export async function recordClaudeSpawnCorrelation(
  raw: unknown,
  bindingDirectory: string = subagentDir(),
): Promise<HookResult> {
  const input = exactRecord(raw) as ClaudePostToolUseInput | null;
  const toolInput = exactRecord(input?.tool_input);
  const prompt = typeof toolInput?.["prompt"] === "string"
    ? toolInput["prompt"]
    : typeof toolInput?.["task"] === "string" ? toolInput["task"] : "";
  const identity = parseIssuedTaskIdentity(prompt);
  const context = claudeRunContext(input?.session_id, process.env, bindingDirectory);
  // PostToolUse is global. A call without engine markers is unrelated legacy
  // work and must not be claimed by any run — but half an explicit authority
  // is still a fault, whatever the prompt carries.
  if (identity.kind === "unbound") {
    const explicit = explicitRun(context, "claude-code");
    return explicit.ok ? { kind: "passthrough" } : { kind: "error", message: explicit.message };
  }
  if (identity.kind === "malformed") return { kind: "error", message: `Claude orchestration prompt ${identity.reason}` };
  const run = resolveClaudeSpawnRun(context, identity);
  if (!run.ok) return { kind: "error", message: run.message };

  const rawRole = toolInput?.["subagent_type"] ?? toolInput?.["agent"];
  const role = typeof rawRole === "string" ? stripNamespace(rawRole) : "";
  if (role.length === 0) return { kind: "error", message: "Claude orchestration spawn has no agent role" };
  const nativeIds = nativeAgentIds(input?.tool_response);
  if (nativeIds.length !== 1) {
    return { kind: "error", message: `Claude orchestration spawn must return exactly one native agent id; observed ${nativeIds.length}` };
  }

  const recorded = await recordClaudeSpawnCorrelator(run.value, {
    identity,
    role,
    nativeId: nativeIds[0],
  });
  return recorded.ok ? { kind: "allow" } : { kind: "error", message: recorded.message };
}

const handler: HookHandler = async (stdin) => {
  let input: unknown;
  try {
    input = JSON.parse(stdin) as unknown;
  } catch (error) {
    return { kind: "error", message: `Claude spawn correlation input is invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  return recordClaudeSpawnCorrelation(input);
};

export default handler;
