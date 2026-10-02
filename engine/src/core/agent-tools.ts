import { canonicalRecord, type DomainResult } from "./orchestration-contract";

/**
 * Agent tool declarations are written ONCE, in Claude Code's vocabulary.
 *
 * Claude Code refuses to spawn an agent whose `tools` names it does not
 * recognise (it would run with zero tools), while Pi only knows its own
 * lowercase built-ins. Source agents therefore declare Claude names and the
 * Pi renderer lowers them through this closed mapping. A name outside it —
 * including a Pi name written directly — is a declaration error, not a
 * pass-through: passing it on would break exactly one of the two harnesses.
 */
const CLAUDE_TO_PI = {
  Read: ["read"],
  Write: ["write"],
  Edit: ["edit"],
  MultiEdit: ["edit"],
  Bash: ["bash"],
  Grep: ["grep"],
  Glob: ["find", "ls"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type ClaudeAgentTool = keyof typeof CLAUDE_TO_PI;
export type PiAgentTool = (typeof CLAUDE_TO_PI)[ClaudeAgentTool][number];

export const CLAUDE_AGENT_TOOLS = Object.freeze(Object.keys(CLAUDE_TO_PI) as ClaudeAgentTool[]);

export type DeclaredTools =
  | { readonly kind: "none" }
  | { readonly kind: "tools"; readonly names: readonly ClaudeAgentTool[] }
  | { readonly kind: "unreadable"; readonly reason: string };

export type AgentToolsError = Readonly<{
  kind: "agent-tools-unreadable";
  message: string;
}>;

/** The declared field plus the exact source span it occupies. */
type ToolsField =
  | { readonly kind: "none" }
  | { readonly kind: "unreadable"; readonly reason: string }
  | {
      readonly kind: "tools";
      readonly names: readonly ClaudeAgentTool[];
      readonly start: number;
      readonly end: number;
    };

/** One frontmatter line: text without its terminator, and its source offsets. */
type Line = Readonly<{ text: string; start: number; end: number }>;

const isClaudeAgentTool = (name: string): name is ClaudeAgentTool => Object.hasOwn(CLAUDE_TO_PI, name);

const unquote = (name: string): string => name.trim().replace(/^["']|["']$/g, "").trim();

function frontmatterLines(content: string): readonly Line[] | null {
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!fm) return null;
  const lines: Line[] = [];
  let offset = content.indexOf("\n") + 1;
  for (const raw of fm[1]!.split("\n")) {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    lines.push({ text, start: offset, end: offset + text.length });
    offset += raw.length + 1;
  }
  return lines;
}

function classify(rawNames: readonly string[], start: number, end: number): ToolsField {
  const names = rawNames.map(unquote).filter((name) => name !== "");
  if (names.length === 0) {
    return { kind: "unreadable", reason: "agent tools field is empty; omit it or declare Claude Code tool names" };
  }
  const unknown = names.filter((name) => !isClaudeAgentTool(name));
  if (unknown.length > 0) {
    return {
      kind: "unreadable",
      reason: `agent tools field declares unsupported tool(s): ${unknown.join(", ")}; `
        + `declare Claude Code tool names (${CLAUDE_AGENT_TOOLS.join(", ")}) — the Pi renderer lowers them`,
    };
  }
  return { kind: "tools", names: [...new Set(names.filter(isClaudeAgentTool))], start, end };
}

function locateToolsField(content: string): ToolsField {
  const lines = frontmatterLines(content);
  if (lines === null) return { kind: "none" };
  const keyed = lines.flatMap((line, index) => (/^tools[ \t]*:/.test(line.text) ? [index] : []));
  if (keyed.length === 0) return { kind: "none" };
  if (keyed.length > 1) return { kind: "unreadable", reason: "agent frontmatter declares the tools field more than once" };

  const index = keyed[0]!;
  const line = lines[index]!;
  const value = line.text.slice(line.text.indexOf(":") + 1).trim();

  if (value.startsWith("[")) {
    return value.endsWith("]")
      ? classify(value.slice(1, -1).split(","), line.start, line.end)
      : { kind: "unreadable", reason: "agent tools flow list is not closed on the tools line" };
  }
  if (value !== "") return classify(value.split(","), line.start, line.end);

  const following = lines.slice(index + 1);
  const listEnd = following.findIndex((next) => !/^[ \t]*-[ \t]+\S/.test(next.text));
  const items = listEnd === -1 ? following : following.slice(0, listEnd);
  return classify(
    items.map((item) => item.text.replace(/^[ \t]*-/, "")),
    line.start,
    items.at(-1)?.end ?? line.end,
  );
}

/** Parse block-, flow-, or comma-style Claude tool names from agent markdown. */
export function parseDeclaredTools(content: string): DeclaredTools {
  const field = locateToolsField(content);
  return field.kind === "tools" ? { kind: "tools", names: field.names } : field;
}

/** Pi built-ins granting the declared Claude capabilities, deduped in declaration order. */
export function lowerToolsForPi(names: readonly ClaudeAgentTool[]): readonly PiAgentTool[] {
  return [...new Set(names.flatMap((name): readonly PiAgentTool[] => CLAUDE_TO_PI[name]))];
}

/**
 * Rewrite the tools field (any form) as ONE comma-string line of Pi names —
 * the only form every Pi consumer reads — leaving all other bytes untouched.
 */
export function lowerAgentToolsForPi(content: string): DomainResult<string, AgentToolsError> {
  const field = locateToolsField(content);
  if (field.kind === "none") return canonicalRecord({ ok: true, value: content });
  if (field.kind === "unreadable") {
    return canonicalRecord({
      ok: false,
      error: canonicalRecord({ kind: "agent-tools-unreadable" as const, message: field.reason }),
    });
  }
  const line = `tools: ${lowerToolsForPi(field.names).join(", ")}`;
  return canonicalRecord({ ok: true, value: content.slice(0, field.start) + line + content.slice(field.end) });
}
