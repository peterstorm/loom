/**
 * Enforce agent prompt references the correct preloaded skill.
 * Reads `skills:` from agent frontmatter and checks the spawn prompt
 * mentions the skill name. Only active during loom orchestration.
 */

import { readFileSync } from "node:fs";
import type { HookHandler, PreToolUseInput } from "../../types";
import {
  TASK_GRAPH_PATH, PHASE_AGENT_MAP, IMPL_AGENTS, REVIEW_AGENTS,
  REVIEW_PANEL_AGENTS, UTILITY_AGENTS, ARCH_PANEL_AGENTS, pathExistsFailClosed,
} from "../../config";
import { SUBAGENT_SPAWN_TOOLS } from "../../core/tool-vocabulary";
import { stripNamespace } from "../../utils/strip-namespace";
import { resolveClaudeAgentDefinitionPath } from "../../utils/agent-definition";
import {
  parseDeclaredSkills,
  promptReferencesSkill,
  type DeclaredSkills,
} from "../../core/agent-skills";
import { isLoomNamespacedAgent } from "../../core/model-profiles";

export { promptReferencesSkill } from "../../core/agent-skills";
export type { DeclaredSkills } from "../../core/agent-skills";

/** All agents whose skill we validate */
export const VALIDATED_AGENTS: ReadonlySet<string> = new Set([
  ...Object.keys(PHASE_AGENT_MAP),
  ...ARCH_PANEL_AGENTS,
  ...REVIEW_PANEL_AGENTS,
  ...IMPL_AGENTS,
  ...REVIEW_AGENTS,
]);

/** Loom agents that do not require a skill preload. */
const SKILL_EXEMPT_AGENTS = new Set(["decompose-agent"]);

/** Read an agent file at the shell boundary, then use the shared pure parser. */
export function parseSkillsFromFrontmatter(filePath: string): DeclaredSkills {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (error) {
    return {
      kind: "unreadable",
      reason: `cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = parseDeclaredSkills(content);
  return parsed.kind === "unreadable"
    ? { ...parsed, reason: `${filePath}: ${parsed.reason}` }
    : parsed;
}

const handler: HookHandler = async (stdin) => {
  // ENOENT is the only "orchestration inactive" answer. Bare `existsSync`
  // reads EACCES/ELOOP/ENOTDIR/EIO as absence too, which would let every
  // subagent spawn past this gate unvalidated — the same fail-open the
  // malformed-input branch below already refuses to take.
  if (!pathExistsFailClosed(TASK_GRAPH_PATH)) return { kind: "allow" };

  let input: PreToolUseInput;
  try {
    input = JSON.parse(stdin);
  } catch (e) {
    // Malformed hook input on a spawn-gate route: fail CLOSED. An uncaught
    // parse crash exits 1 (NON-blocking for PreToolUse), letting a Task spawn
    // without its required skill. (Route is in FAIL_CLOSED_ROUTES for crashes
    // that escape this handler too.)
    return {
      kind: "block",
      message: `validate-agent-skill: malformed hook input — failing closed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!SUBAGENT_SPAWN_TOOLS.has(input.tool_name)) return { kind: "allow" };

  const subagentType = (input.tool_input?.subagent_type as string | undefined)
    ?? (input.tool_input?.agent as string | undefined)
    ?? "";
  const bareAgent = stripNamespace(subagentType);

  if (!VALIDATED_AGENTS.has(bareAgent)) {
    return isLoomNamespacedAgent(subagentType)
      ? { kind: "block", message: `BLOCKED: unknown Loom agent "${subagentType}"; skill policy cannot be proven.` }
      : { kind: "allow" };
  }
  if (UTILITY_AGENTS.has(bareAgent)) return { kind: "allow" };
  if (SKILL_EXEMPT_AGENTS.has(bareAgent)) return { kind: "allow" };

  let agentPath: string | null;
  try {
    agentPath = resolveClaudeAgentDefinitionPath(bareAgent, subagentType);
  } catch (error) {
    return {
      kind: "block",
      message: `BLOCKED: Claude Code agent-definition authority for "${subagentType}" is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!agentPath) {
    return {
      kind: "block",
      message: [
        `BLOCKED: cannot locate Loom agent definition for "${subagentType}"; skill policy cannot be proven.`,
        "",
        "Searched the executing Loom package, CLAUDE_PLUGIN_ROOT, repository/user agent catalogs, and development checkout agents.",
        "Run the Pi agent sync/reload command or repair the package root before retrying.",
      ].join("\n"),
    };
  }

  const declared = parseSkillsFromFrontmatter(agentPath);
  if (declared.kind === "unreadable") {
    return {
      kind: "block",
      message: [
        `BLOCKED: cannot determine which skills "${subagentType}" requires — failing closed.`,
        "",
        `  ${declared.reason}`,
        "",
        "An agent whose frontmatter cannot be read may require a skill this prompt omits.",
      ].join("\n"),
    };
  }
  if (declared.kind === "none") return { kind: "allow" };
  const declaredSkills = declared.names;

  const prompt = (input.tool_input?.prompt as string | undefined)
    ?? (input.tool_input?.task as string | undefined)
    ?? "";
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
