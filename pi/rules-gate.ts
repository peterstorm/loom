/**
 * Pi rules gate — the Pi half of the adapter pair around `core/rules-gate`.
 * The decision (requirements, full-read coverage, adherence marker, block text)
 * lives once, in the core, and is shared with the Claude Code hook
 * (`engine/src/handlers/pre-tool-use/rules-gate.ts`). This file only:
 *   - maps Pi's context entries into the core's harness-neutral events,
 *   - classifies which `tool_call`s mutate code,
 *   - decides which Pi processes are gated, and
 *   - turns a `GateDecision` into Pi's `{ block, reason }`.
 *
 * Main orchestrator vs subagents: the subagent extension spawns subagents as
 * SEPARATE pi processes (`pi --mode json -p --no-session`). That signature is
 * exempt; everything else (tui, rpc, print, json with a session) is gated.
 *
 * Escape hatches (env): LOOM_GATE=off disables; LOOM_GATE_MODES=tui,rpc gates
 * only the listed modes (overrides the subagent exemption); LOOM_RULES_DIR /
 * LOOM_SKILLS_DIR override the rules and skills directories (default: `rules/`
 * and `skills/` of this Loom package — resolved by the shared `gateDirs`).
 *
 * Skills: Pi has no Skill tool, so a required skill is satisfied by a FULL read
 * of its `SKILL.md` or by the user's `/skill:<name>` command (a `<skill>` block
 * in a user message). The block text says so (`renderGateBlock(…, "pi")`).
 */

import type { ExtensionAPI, ExtensionContext, SessionEntry, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { firstBashCodeMutationTarget } from "../engine/src/core/bash-code-mutation";
import { isRecord } from "../engine/src/core/plain-record";
import {
  ALWAYS_REQUIRED_RULES,
  READ_TOOL_MAX_LINES,
  decideRulesGate,
  renderGateBlock,
  type TranscriptEvent,
} from "../engine/src/core/rules-gate";
import { filesystemPorts, gateDirs } from "../engine/src/handlers/pre-tool-use/rules-gate";
import { stripNamespace } from "../engine/src/utils/strip-namespace";

const gateOff = (): boolean => process.env["LOOM_GATE"] === "off" || process.env["LOOM_GATE"] === "0";

const MAX_ACTION_CHARS = 120;

// ---------------------------------------------------------------------------
// Pi context entries → TranscriptEvents
// ---------------------------------------------------------------------------

const SKILL_BLOCK_RE = /<skill name="([^"]+)" location="[^"]*">/g;

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const pathArg = (args: unknown): string => (isRecord(args) ? asString(args["path"] ?? args["file_path"]) : "");

const positiveInt = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

const toolCallEvent = (part: Record<string, unknown>, messageId: string): TranscriptEvent => {
  const callId = asString(part["id"]);
  const args = isRecord(part["arguments"]) ? part["arguments"] : {};
  const path = pathArg(args);
  if (part["name"] === "read" && path !== "") {
    return {
      kind: "read", callId, messageId, path,
      offset: positiveInt(args["offset"], 1),
      limit: Math.min(READ_TOOL_MAX_LINES, positiveInt(args["limit"], READ_TOOL_MAX_LINES)),
    };
  }
  const command = asString(args["command"]);
  if (part["name"] === "bash" && command !== "") return { kind: "command", callId, messageId, command };
  return part["name"] === "write" && path !== ""
    ? { kind: "write", callId, messageId, path }
    : { kind: "other-call", callId, messageId };
};

const skillCommands = (content: unknown): readonly TranscriptEvent[] => {
  const text = typeof content === "string"
    ? content
    : (Array.isArray(content) ? content : []).map((c) => (isRecord(c) ? asString(c["text"]) : "")).join("\n");
  return [...text.matchAll(SKILL_BLOCK_RE)].map((m): TranscriptEvent => ({ kind: "skill-command", name: stripNamespace(m[1] ?? "") }));
};

const messageEvents = (message: Record<string, unknown>, messageId: string): readonly TranscriptEvent[] => {
  if (message["role"] === "toolResult") {
    return [{ kind: "result", callId: asString(message["toolCallId"]), ok: message["isError"] !== true }];
  }
  if (message["role"] === "user") return skillCommands(message["content"]);
  if (message["role"] !== "assistant" || !Array.isArray(message["content"])) return [];
  return message["content"].filter(isRecord).flatMap((part): readonly TranscriptEvent[] =>
    part["type"] === "toolCall"
      ? [toolCallEvent(part, messageId)]
      : part["type"] === "text" && typeof part["text"] === "string"
        ? [{ kind: "text", messageId, text: part["text"] }]
        : [],
  );
};

/**
 * What the model can currently see. `buildContextEntries()` already stops at
 * the last compaction, so no boundary handling is needed here. A Pi tool result
 * lands only AFTER its whole assistant message executes, so a same-message read
 * is naturally "not completed" when the gated call is checked.
 */
export function piContextEvents(entries: readonly SessionEntry[]): readonly TranscriptEvent[] {
  return entries.flatMap((entry, index) =>
    entry.type === "message" && isRecord(entry.message)
      ? messageEvents(entry.message, entry.id ?? `entry-${index}`)
      : [],
  );
}

// ---------------------------------------------------------------------------
// Which Pi processes and calls are gated
// ---------------------------------------------------------------------------

type PiGateContext = Pick<ExtensionContext, "mode" | "cwd" | "sessionManager">;

const isGated = (ctx: Pick<PiGateContext, "mode" | "sessionManager">): boolean => {
  if (gateOff()) return false;
  const override = process.env["LOOM_GATE_MODES"]?.trim();
  if (override) return override.split(",").map((s) => s.trim()).filter(Boolean).includes(ctx.mode);
  // Subagent signature: `pi --mode json -p --no-session`.
  return !(ctx.mode === "json" && !ctx.sessionManager.getSessionFile());
};

type GatedCall = Readonly<{ target: string; action: string }>;

const gatedCall = (event: ToolCallEvent): GatedCall | undefined => {
  // Type-only import above: this module is loaded by a private jiti that does not
  // alias Pi's package, so it must carry no runtime dependency on it.
  if (event.toolName === "write" || event.toolName === "edit") {
    const path = event.input.path;
    return typeof path === "string" && path !== ""
      ? { target: path, action: `${event.toolName === "write" ? "write" : "edit"} ${path}` }
      : undefined;
  }
  if (event.toolName !== "bash") return undefined;
  const command = event.input.command;
  if (typeof command !== "string") return undefined;
  const target = firstBashCodeMutationTarget(command);
  const shown = command.length > MAX_ACTION_CHARS ? `${command.slice(0, MAX_ACTION_CHARS)}…` : command;
  return target === null ? undefined : { target, action: `mutate code files via bash: ${shown}` };
};

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

export function registerRulesGate(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (gateOff()) {
      ctx.ui.notify("loom-rules-gate: DISABLED (LOOM_GATE=off)", "warning");
      return;
    }
    const { rulesDir } = gateDirs();
    const rulesOk = ALWAYS_REQUIRED_RULES.every((rule) => existsSync(join(rulesDir, rule)));
    if (rulesOk) ctx.ui.notify("loom-rules-gate active: rules/skills must be fully read and stated before code writes", "info");
    else ctx.ui.notify(`loom-rules-gate WARNING: missing rules in ${rulesDir}`, "warning");
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isGated(ctx)) return;
    const call = gatedCall(event);
    if (call === undefined) return;
    const decision = decideRulesGate(
      {
        target: call.target,
        events: piContextEvents(ctx.sessionManager.buildContextEntries()),
        pendingCallId: event.toolCallId,
        dirs: gateDirs(),
      },
      filesystemPorts(ctx.cwd),
    );
    if (decision.kind === "allow") return;
    return { block: true, reason: renderGateBlock(decision, call.action, "pi") };
  });
}

/** Pi extension entry: loaded on its own (not through `pi/extension.ts`) so the
 *  gate stays independent of the main extension's lifecycle and handler set. */
export default registerRulesGate;
