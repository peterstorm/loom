/**
 * FR-008 feasibility probe — child-side extension.
 *
 * Proves the readiness vocabulary the launcher gate relies on, against the
 * installed pi (0.83.0):
 *   1. `pi.registerTool` + `pi.getActiveTools()` — the authoritative in-process
 *      registered-and-active check.
 *   2. `pi.appendEntry(customType, data)` — emits `entry_appended` on the RPC
 *      stdout stream with NO model request and NO turn: the readiness channel.
 *      It MUST fire from an extension command invoked by the launcher
 *      (`/probe-readiness` via the RPC prompt command): startup-time events
 *      (session_start) are emitted before the RPC loop attaches its stdout
 *      subscription, so they never reach the launcher.
 *   3. `pi.registerProvider` — points the child at the counting provider
 *      substitute (a local HTTP server that counts and rejects requests).
 *   4. `before_agent_start` handler returning a pending promise — gates the
 *      first model request (the awaited-hook hold), proven by the `held`
 *      variant's ordering markers.
 *
 * Variants (env PROBE_VARIANT):
 *   matching      — readiness emitted, active verified, digest correct.
 *   contradictory — readiness emitted with a WRONG schema digest.
 *   missing       — the readiness command is never registered, so the
 *                   launcher's invocation is unknown and nothing is ever
 *                   emitted (the launcher must refuse via bounded timeout;
 *                   also covers the absent-extension case by construction:
 *                   no `-e`, no command, no signal).
 *   held          — matching readiness + a `before_agent_start` hold resolved
 *                   after PROBE_HOLD_MS, with ordering markers around the hold.
 *
 * The extension stays silent on stdout (no console.log): the RPC stream must
 * carry only protocol JSON.
 */

import { createHash } from "node:crypto";

const variant = process.env.PROBE_VARIANT ?? "matching";
const toolName = process.env.PROBE_TOOL_NAME ?? "loom_emit_probe_payload";
const revision = process.env.PROBE_REVISION ?? "probe-rev-001";
const holdMs = Number(process.env.PROBE_HOLD_MS ?? "2000");
const countBaseUrl = process.env.PROBE_COUNT_BASE_URL ?? "";
const readinessCommand = process.env.PROBE_READINESS_COMMAND ?? "probe-readiness";

/** The frozen probe schema — one small stand-in for the real per-kind bytes. */
const probeSchema = {
  type: "object",
  properties: {
    claim: { type: "string", minLength: 1 },
    severity: { type: "string", enum: ["critical", "advisory"] },
  },
  required: ["claim", "severity"],
  additionalProperties: false,
};
const digest = "sha256-" + createHash("sha256").update(JSON.stringify(probeSchema)).digest("hex");
const WRONG_DIGEST = "sha256-" + "0".repeat(64);

export default function (pi) {
  // Event-handler and command registration are allowed during extension
  // loading; action methods (registerTool/registerProvider/appendEntry/
  // getActiveTools) are NOT — the readiness command performs them at gate
  // time, when the launcher invokes it.
  if (variant === "held") {
    // The awaited-hook hold: a pending promise returned from
    // before_agent_start blocks agent-session.prompt() between
    // emitBeforeAgentStart and _runAgentPrompt — no model request until the
    // promise resolves. Ordering markers make the gate observable to the
    // driver through the same stdout pipe.
    pi.on("before_agent_start", async () => {
      pi.appendEntry("loom-emission-probe-hold", { phase: "entered", atMs: Date.now() });
      await new Promise((resolve) => setTimeout(resolve, holdMs));
      pi.appendEntry("loom-emission-probe-hold", { phase: "resolved", atMs: Date.now() });
      return undefined;
    });
  }

  if (variant !== "missing") {
    // The readiness command: the launcher invokes it via the RPC prompt
    // command ("/probe-readiness"). Extension commands execute immediately —
    // preflight succeeds without a model request — and every event they emit
    // lands on the subscribed RPC stdout. Registration + the authoritative
    // check + the readiness emission all happen HERE, at gate time.
    pi.registerCommand(readinessCommand, {
      description: "Emission readiness probe: register, verify, and report.",
      handler: async () => setupProbe(pi),
    });
  }
}

function setupProbe(pi) {
  // The counting provider substitute: a real provider registration pointing at
  // the local counting server. Every model request the child would send lands
  // there and is counted; the server rejects, so no real model is involved.
  pi.registerProvider("probe", {
    name: "Probe Counting Provider",
    baseUrl: countBaseUrl,
    apiKey: "$PROBE_COUNT_KEY",
    api: "openai-completions",
    models: [
      {
        id: "probe-model",
        name: "Probe Model",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 4_096,
      },
    ],
  });

  // The fake emission tool: same registration surface the production
  // emission-tool registration will use (registerTool + parameters as the
  // frozen schema + terminating execute). Errors are thrown, never returned
  // as objects (the harness contract: returning never sets isError).
  pi.registerTool({
    name: toolName,
    label: "Probe Emission Tool",
    description: "Feasibility probe: emit the structured payload.",
    promptSnippet: `Emit the probe payload via ${toolName}.`,
    parameters: probeSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      pi.appendEntry("loom-emission-probe-args", { tool: toolName, args: params });
      return {
        content: [{ type: "text", text: "payload acknowledged" }],
        details: {},
        terminate: true,
      };
    },
  });

  const registeredAndActive = pi.getActiveTools().includes(toolName);
  const readinessPayload = {
    kind: "readiness",
    tool: toolName,
    digest: variant === "contradictory" ? WRONG_DIGEST : digest,
    revision,
    childPid: process.pid,
    active: registeredAndActive,
    allTools: pi.getAllTools().map((t) => t.name),
  };
  pi.appendEntry("loom-emission-readiness", readinessPayload);
  return undefined;
}
