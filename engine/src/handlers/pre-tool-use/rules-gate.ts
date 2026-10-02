/**
 * Claude Code rules gate — blocks code edits until the Loom rules/skills are in
 * the model's context and adherence is stated. Twin of the Pi `loom-rules-gate`
 * extension.
 *
 * Imperative shell: parses the hook payload at the boundary, reads the session
 * transcript, supplies the filesystem ports, and maps the pure core's
 * `GateDecision` to a `HookResult`. Fails CLOSED on anything it cannot prove:
 * exit 1 is non-blocking for PreToolUse, so an unreadable transcript must block
 * rather than silently waving the edit through.
 *
 * Escape hatches (env): LOOM_GATE=off disables; LOOM_RULES_DIR / LOOM_SKILLS_DIR
 * override the rules and skills directories (default: rules/ and skills/ of the
 * owning Loom package). A skill is satisfied by the Skill tool, a user slash
 * command, or a full Read of `<skills>/<name>/SKILL.md`.
 * Subagents are exempt — they carry the rules in their task prompt and the
 * orchestrator owns compliance (`agent_id` is set only inside a subagent).
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { HookHandler, HookResult, PreToolUseInput } from "../../types";
import { blockResult, passthroughResult } from "../../types";
import { firstBashCodeMutationTarget } from "../../core/bash-code-mutation";
import { decideRulesGate, renderGateBlock, type GateDirs, type GatePorts } from "../../core/rules-gate";
import { parseTranscriptEvents } from "./claude-transcript-events";
import { LOOM_PACKAGE_ROOT } from "../../utils/loom-package-root";

const gateDisabled = (): boolean => process.env["LOOM_GATE"] === "off" || process.env["LOOM_GATE"] === "0";

const MAX_ACTION_CHARS = 120;

type GatedCall = Readonly<{ target: string; action: string }>;

/** Which path would this tool call write? `undefined` = not a code-mutating call. */
const gatedCall = (input: PreToolUseInput): GatedCall | undefined => {
  const filePath = input.tool_input["file_path"];
  const command = input.tool_input["command"];
  if (["Edit", "Write", "MultiEdit"].includes(input.tool_name)) {
    return typeof filePath === "string" && filePath !== ""
      ? { target: filePath, action: `${input.tool_name === "Write" ? "write" : "edit"} ${filePath}` }
      : undefined;
  }
  if (input.tool_name !== "Bash" || typeof command !== "string") return undefined;
  const target = firstBashCodeMutationTarget(command);
  const shown = command.length > MAX_ACTION_CHARS ? `${command.slice(0, MAX_ACTION_CHARS)}…` : command;
  return target === null ? undefined : { target, action: `mutate code files via bash: ${shown}` };
};

/**
 * Where the gate's rules and skills live — one resolution shared by both harness
 * adapters (the Pi gate imports it), so an override means the same thing on each.
 */
export const gateDirs = (): GateDirs => ({
  rulesDir: process.env["LOOM_RULES_DIR"] ?? join(LOOM_PACKAGE_ROOT, "rules"),
  skillsDir: process.env["LOOM_SKILLS_DIR"] ?? join(LOOM_PACKAGE_ROOT, "skills"),
});

const countLines = (content: string): number =>
  content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);

/** Real filesystem adapter for the core's ports. `cwd` anchors relative paths. */
export const filesystemPorts = (cwd: string): GatePorts => {
  const realpaths = new Map<string, string>();
  return {
    canonicalPath: (raw) => {
      const absolute = raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : isAbsolute(raw) ? raw : join(cwd, raw);
      const cached = realpaths.get(absolute);
      if (cached !== undefined) return cached;
      const resolved = (() => {
        try {
          return realpathSync(absolute);
        } catch {
          return resolve(absolute);
        }
      })();
      realpaths.set(absolute, resolved);
      return resolved;
    },
    lineCount: (canonical) => {
      try {
        return countLines(readFileSync(canonical, "utf8"));
      } catch {
        return Number.POSITIVE_INFINITY;
      }
    },
    exists: existsSync,
  };
};

const isPreToolUseInput = (value: unknown): value is PreToolUseInput =>
  typeof value === "object" && value !== null && "tool_name" in value && typeof value.tool_name === "string" &&
  "tool_input" in value && typeof value.tool_input === "object" && value.tool_input !== null;

const parseInput = (stdin: string): PreToolUseInput | undefined => {
  try {
    const parsed: unknown = JSON.parse(stdin);
    return isPreToolUseInput(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const decide = (input: PreToolUseInput, call: GatedCall): HookResult => {
  if (input.transcript_path === undefined || input.transcript_path === "") {
    return blockResult("loom-rules-gate: hook input carries no transcript_path — failing closed (set LOOM_GATE=off to bypass)");
  }
  const transcript = (() => {
    try {
      return readFileSync(input.transcript_path, "utf8");
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  })();
  if (transcript instanceof Error) {
    return blockResult(`loom-rules-gate: cannot read transcript ${input.transcript_path}: ${transcript.message} — failing closed (set LOOM_GATE=off to bypass)`);
  }
  const decision = decideRulesGate(
    {
      target: call.target,
      events: parseTranscriptEvents(transcript),
      pendingCallId: input.tool_use_id,
      dirs: gateDirs(),
    },
    filesystemPorts(input.cwd ?? process.cwd()),
  );
  return decision.kind === "allow" ? passthroughResult() : blockResult(renderGateBlock(decision, call.action, "claude-code"));
};

const handler: HookHandler = async (stdin) => {
  if (gateDisabled()) return passthroughResult();
  const input = parseInput(stdin);
  if (input === undefined) return blockResult("loom-rules-gate: malformed hook input — failing closed");
  if (input.agent_id !== undefined) return passthroughResult();
  const call = gatedCall(input);
  return call === undefined ? passthroughResult() : decide(input, call);
};

export default handler;
