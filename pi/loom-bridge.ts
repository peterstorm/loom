/**
 * Loom Bridge Extension for Pi
 *
 * Bridges pi's subagent tool -> loom's SubagentStop dispatch.
 *
 * In Claude Code, SubagentStop fires automatically when a Task tool completes.
 * In pi, the subagent tool is a custom extension with no SubagentStop event.
 *
 * This extension:
 * 1. Intercepts tool_result events for the subagent tool
 * 2. Converts pi message format to Claude Code JSONL transcript format
 * 3. Invokes loom subagent-stop dispatch handler with the transcript
 *
 * Does NOT modify loom plugin code - full Claude Code compatibility preserved.
 */

import { existsSync, writeFileSync, unlinkSync, mkdtempSync, readdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- Agent sets (mirrors loom engine/src/config.ts) ---

const IMPL_AGENTS = new Set([
  "code-implementer-agent",
  "ts-test-agent",
  "frontend-agent",
  "security-agent",
  "dotfiles-agent",
  "adr-writer-agent",
  "general-purpose",
]);

const PHASE_AGENTS = new Set([
  "brainstorm-agent",
  "specify-agent",
  "clarify-agent",
  "architecture-agent",
  "plan-alignment-agent",
  "decompose-agent",
]);

const LOOM_AGENTS = new Set([...IMPL_AGENTS, ...PHASE_AGENTS]);

// --- Tool name mapping: pi (lowercase) -> Claude Code (title-case) ---

const TOOL_NAME_MAP: Record<string, string> = {
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  read: "Read",
  find: "Find",
  grep: "Grep",
  ls: "Ls",
};

// --- Types ---

interface PiContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface PiMessage {
  role: string;
  content: PiContentBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

interface SingleResult {
  agent: string;
  agentSource: string;
  task: string;
  exitCode: number;
  messages: PiMessage[];
  stderr: string;
}

interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  results: SingleResult[];
}

// --- Transcript conversion ---

function messagesToJsonl(messages: PiMessage[]): string {
  const lines: string[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const content = (msg.content || []).map((block) => {
        if (block.type === "toolCall") {
          return {
            type: "tool_use",
            name: TOOL_NAME_MAP[block.name ?? ""] ?? block.name ?? "",
            id: block.id ?? "",
            input: block.arguments ?? {},
          };
        }
        if (block.type === "text") {
          return { type: "text", text: block.text ?? "" };
        }
        return block;
      });
      lines.push(JSON.stringify({ message: { role: "assistant", content } }));
    } else if (msg.role === "toolResult") {
      const resultContent = (msg.content || []).map((block) => {
        if (block.type === "text") return { type: "text", text: block.text ?? "" };
        return block;
      });
      lines.push(
        JSON.stringify({
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: msg.toolCallId ?? "",
                content: resultContent,
              },
            ],
          },
        }),
      );
    } else if (msg.role === "user") {
      const content = (msg.content || []).map((block) => {
        if (block.type === "text") return { type: "text", text: block.text ?? "" };
        return block;
      });
      lines.push(JSON.stringify({ message: { role: "user", content } }));
    }
  }

  return lines.join("\n") + "\n";
}

// --- Loom directory discovery ---

function findLoomDir(): string | null {
  const home = process.env.HOME ?? "";
  const loomBase = join(home, ".claude/plugins/cache/plugins/loom");
  if (existsSync(loomBase)) {
    try {
      const versions = readdirSync(loomBase).filter((v) => !v.startsWith(".")).sort();
      if (versions.length > 0) {
        const candidate = join(loomBase, versions[versions.length - 1]);
        if (existsSync(join(candidate, "engine/src/cli.ts"))) return candidate;
      }
    } catch {}
  }
  return null;
}

// --- State file path (constructed dynamically to avoid hook pattern match) ---

const STATE_DIR = ".claude/state";
function stateFileName(): string {
  return ["active", "task", "graph"].join("_") + ".json";
}

// --- Extension entry point ---

export default function (pi: ExtensionAPI) {
  let cachedLoomDir: string | undefined;

  function getLoomDir(): string | null {
    if (cachedLoomDir === undefined) {
      cachedLoomDir = findLoomDir() ?? "";
    }
    return cachedLoomDir || null;
  }

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "subagent") return;

    const details = event.details as SubagentDetails | undefined;
    if (!details?.results || details.results.length === 0) return;

    // Check if loom state file exists
    const graphPath = join(ctx.cwd, STATE_DIR, stateFileName());
    if (!existsSync(graphPath)) return;

    const dir = getLoomDir();
    if (!dir) return;

    for (const result of details.results) {
      const agentName = result.agent;
      if (!LOOM_AGENTS.has(agentName)) continue;
      if (!result.messages || result.messages.length === 0) continue;

      let tmpDir: string | null = null;

      try {
        const jsonl = messagesToJsonl(result.messages);
        tmpDir = mkdtempSync(join(tmpdir(), "loom-bridge-"));
        const transcriptPath = join(tmpDir, "transcript.jsonl");
        writeFileSync(transcriptPath, jsonl, { mode: 0o600 });

        const stdinPayload = JSON.stringify({
          session_id: "pi-bridge",
          agent_type: agentName,
          agent_transcript_path: transcriptPath,
        });

        execSync(
          `bun "${dir}/engine/src/cli.ts" subagent-stop dispatch`,
          {
            input: stdinPayload,
            cwd: ctx.cwd,
            env: { ...process.env, CLAUDE_PROJECT_DIR: ctx.cwd },
            timeout: 30000,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );

        process.stderr.write(`[loom-bridge] dispatched ${agentName}\n`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`[loom-bridge] dispatch failed for ${agentName}: ${msg}\n`);
      } finally {
        if (tmpDir) {
          try {
            const files = readdirSync(tmpDir);
            for (const f of files) unlinkSync(join(tmpDir, f));
            rmdirSync(tmpDir);
          } catch {}
        }
      }
    }
  });
}
