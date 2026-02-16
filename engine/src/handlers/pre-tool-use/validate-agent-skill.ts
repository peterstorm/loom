/**
 * Enforce agent prompt references the correct preloaded skill.
 * Reads `skills:` from agent frontmatter and checks the Task prompt
 * mentions the skill name. Only active during loom orchestration.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import type { HookHandler, PreToolUseInput } from "../../types";
import {
  TASK_GRAPH_PATH, PHASE_AGENT_MAP, IMPL_AGENTS, REVIEW_AGENTS,
  UTILITY_AGENTS,
} from "../../config";
import { stripNamespace, extractNamespace } from "../../utils/strip-namespace";

/** All agents whose skill we validate */
const VALIDATED_AGENTS = new Set([
  ...Object.keys(PHASE_AGENT_MAP),
  ...IMPL_AGENTS,
  ...REVIEW_AGENTS,
]);

/** Agents that don't require a skill (tools-only or general-purpose) */
const SKILL_EXEMPT_AGENTS = new Set([
  "decompose-agent",
  "general-purpose",
]);

/** Resolve agent .md path — checks git root, home dir, and plugin cache */
function resolveAgentPath(agentName: string, fullAgentType: string): string | null {
  const candidates: string[] = [];

  try {
    const root = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
    candidates.push(join(root, ".claude/agents", `${agentName}.md`));
  } catch {}

  candidates.push(join(process.env.HOME ?? "", ".claude/agents", `${agentName}.md`));

  const namespace = extractNamespace(fullAgentType);
  if (namespace) {
    const pluginBase = join(process.env.HOME ?? "", ".claude/plugins/cache/plugins", namespace);
    try {
      for (const version of readdirSync(pluginBase)) {
        candidates.push(join(pluginBase, version, "agents", `${agentName}.md`));
      }
    } catch {}
  }

  return candidates.find((p) => existsSync(p)) ?? null;
}

/** Parse skills list from YAML frontmatter */
export function parseSkillsFromFrontmatter(filePath: string): string[] {
  try {
    const content = readFileSync(filePath, "utf-8");
    const fm = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) return [];
    const skillsBlock = fm[1].match(/^skills:\s*\n((?:\s+-\s+.+\n?)*)/m);
    if (!skillsBlock) return [];
    return [...skillsBlock[1].matchAll(/^\s+-\s+(.+)$/gm)].map((m) => m[1].trim());
  } catch {
    return [];
  }
}

/** Check if prompt references a skill (by name or /name pattern) */
export function promptReferencesSkill(prompt: string, skill: string): boolean {
  const lower = prompt.toLowerCase();
  const skillLower = skill.toLowerCase();
  // Match: skill name as word, /skill-name, or "skill-name" in quotes
  return lower.includes(skillLower);
}

const handler: HookHandler = async (stdin) => {
  if (!existsSync(TASK_GRAPH_PATH)) return { kind: "allow" };

  const input: PreToolUseInput = JSON.parse(stdin);
  if (input.tool_name !== "Task") return { kind: "allow" };

  const subagentType = (input.tool_input?.subagent_type as string) ?? "";
  const bareAgent = stripNamespace(subagentType);

  if (!VALIDATED_AGENTS.has(bareAgent)) return { kind: "allow" };
  if (UTILITY_AGENTS.has(bareAgent)) return { kind: "allow" };
  if (SKILL_EXEMPT_AGENTS.has(bareAgent)) return { kind: "allow" };

  const agentPath = resolveAgentPath(bareAgent, subagentType);
  if (!agentPath) return { kind: "allow" };

  const declaredSkills = parseSkillsFromFrontmatter(agentPath);
  if (declaredSkills.length === 0) return { kind: "allow" };

  const prompt = (input.tool_input?.prompt as string) ?? "";
  if (!prompt) {
    return {
      kind: "block",
      message: [
        `BLOCKED: Task call for "${subagentType}" has no prompt.`,
        "",
        `Agent declares skills: ${declaredSkills.join(", ")}`,
        "The prompt must reference the skill so the agent preloads it.",
      ].join("\n"),
    };
  }

  const missing = declaredSkills.filter((s) => !promptReferencesSkill(prompt, s));

  if (missing.length > 0) {
    return {
      kind: "block",
      message: [
        `BLOCKED: Prompt for "${subagentType}" doesn't reference required skill(s).`,
        "",
        `  Missing: ${missing.join(", ")}`,
        `  Declared: ${declaredSkills.join(", ")}`,
        "",
        `Add skill reference to the prompt (e.g. "Use the ${missing[0]} skill" or "/${missing[0]}").`,
      ].join("\n"),
    };
  }

  return { kind: "allow" };
};

export default handler;
