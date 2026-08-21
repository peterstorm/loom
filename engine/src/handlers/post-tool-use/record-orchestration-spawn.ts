/**
 * Claude spawn-side request correlator.
 *
 * The façade places one LOOM_REQUEST_ID marker in every engine-issued Agent
 * prompt. Claude's PostToolUse payload is the first boundary that contains
 * both that exact prompt and the harness-native child id, so this handler
 * persists the binding before SubagentStop can present result bytes.
 */

import type { HookHandler, HookResult } from "../../types";
import { openRunDirectory } from "../../orchestration/run-directory-handle";
import { RUN_DIR_ENV, RUNS_ROOT_ENV } from "../../orchestration/harness-capture-runtime";
import { stripNamespace } from "../../utils/strip-namespace";

const REQUEST_MARKER = /^LOOM_REQUEST_ID:[ \t]*(\S+)[ \t]*$/gm;

type ClaudePostToolUseInput = Readonly<{
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

export async function recordClaudeSpawnCorrelation(raw: unknown): Promise<HookResult> {
  const runsRoot = process.env[RUNS_ROOT_ENV];
  const runDirectory = process.env[RUN_DIR_ENV];
  if (runsRoot === undefined && runDirectory === undefined) return { kind: "passthrough" };
  if (runsRoot === undefined || runDirectory === undefined) {
    return { kind: "error", message: "Claude orchestration spawn requires both run-root and run-directory authority" };
  }

  const input = exactRecord(raw) as ClaudePostToolUseInput | null;
  const toolInput = exactRecord(input?.tool_input);
  const prompt = typeof toolInput?.["prompt"] === "string"
    ? toolInput["prompt"]
    : typeof toolInput?.["task"] === "string" ? toolInput["task"] : "";
  const markers = [...prompt.matchAll(REQUEST_MARKER)].map((match) => match[1]!);
  // PostToolUse is global. A call without an engine marker is unrelated legacy
  // work and must not be claimed by this run.
  if (markers.length === 0) return { kind: "passthrough" };
  if (markers.length !== 1) return { kind: "error", message: "Claude orchestration prompt must carry exactly one LOOM_REQUEST_ID marker" };

  const rawRole = toolInput?.["subagent_type"] ?? toolInput?.["agent"];
  const role = typeof rawRole === "string" ? stripNamespace(rawRole) : "";
  if (role.length === 0) return { kind: "error", message: "Claude orchestration spawn has no agent role" };
  const nativeIds = nativeAgentIds(input?.tool_response);
  if (nativeIds.length !== 1) {
    return { kind: "error", message: `Claude orchestration spawn must return exactly one native agent id; observed ${nativeIds.length}` };
  }

  const opened = openRunDirectory(runsRoot, runDirectory);
  if (!opened.ok) return { kind: "error", message: opened.error.message };
  const issued = opened.value.readIssuedRequests();
  if (!issued.ok) return { kind: "error", message: issued.error.message };
  const request = issued.value.find(({ requestId }) => requestId === markers[0]);
  if (request === undefined) return { kind: "error", message: `Claude spawn claims unissued request ${markers[0]}` };
  if (request.role !== role) {
    return { kind: "error", message: `Claude spawn request ${request.requestId} belongs to ${request.role}, not ${role}` };
  }
  const recorded = await opened.value.recordHarnessCorrelator({
    schemaVersion: 1,
    harness: "claude",
    nativeId: nativeIds[0]!,
    requestId: request.requestId,
    role: request.role,
    attempt: request.attempt,
  });
  return recorded.ok ? { kind: "allow" } : { kind: "error", message: recorded.error.message };
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
