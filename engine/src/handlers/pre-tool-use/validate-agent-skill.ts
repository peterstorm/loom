/**
 * Enforce agent prompt references the correct preloaded skill.
 * Reads `skills:` from agent frontmatter and checks the spawn prompt
 * mentions the skill name. Only active during loom orchestration.
 */

import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { allowWithNotice } from "../../types";
import type { HookHandler, PreToolUseInput } from "../../types";
import {
  TASK_GRAPH_PATH, PHASE_AGENT_MAP, IMPL_AGENTS, REVIEW_AGENTS,
  REVIEW_PANEL_AGENTS, UTILITY_AGENTS, ARCH_PANEL_AGENTS,
} from "../../config";
import { SUBAGENT_SPAWN_TOOLS } from "../../core/tool-vocabulary";
import { stripNamespace, extractNamespace } from "../../utils/strip-namespace";
import { LOOM_PACKAGE_ROOT } from "../../utils/loom-package-root";
import {
  parseDeclaredSkills,
  promptReferencesSkill,
  type DeclaredSkills,
} from "../../core/agent-skills";

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

/** Agents that don't require a skill (tools-only or general-purpose) */
const SKILL_EXEMPT_AGENTS = new Set([
  "decompose-agent",
  "general-purpose",
]);

/** Resolve an agent definition without crossing harness/package boundaries. */
function resolveAgentPath(agentName: string, fullAgentType: string): string | null {
  const candidates: string[] = [];
  const namespace = extractNamespace(fullAgentType);

  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    candidates.push(join(pluginRoot, "agents", `${agentName}.md`));
  }

  if (namespace === "loom") {
    candidates.push(join(LOOM_PACKAGE_ROOT, "agents", `${agentName}.md`));
  }

  try {
    const root = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
    candidates.push(join(root, ".claude/agents", `${agentName}.md`));
  } catch {}

  candidates.push(join(process.env.HOME ?? "", ".claude/agents", `${agentName}.md`));
  return candidates.find((p) => existsSync(p)) ?? null;
}

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
  if (!existsSync(TASK_GRAPH_PATH)) return { kind: "allow" };

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

  if (!VALIDATED_AGENTS.has(bareAgent)) return { kind: "allow" };
  if (UTILITY_AGENTS.has(bareAgent)) return { kind: "allow" };
  if (SKILL_EXEMPT_AGENTS.has(bareAgent)) return { kind: "allow" };

  const agentPath = resolveAgentPath(bareAgent, subagentType);
  if (!agentPath) {
    // The same uncertainty the `unreadable` branch below BLOCKS on — we cannot
    // determine which skills this agent requires — but reached by a different
    // route: no CLAUDE_PLUGIN_ROOT, a cwd outside a git repo, an agent defined
    // somewhere the four candidate paths do not cover. Users legitimately
    // define agents outside those paths, so blocking every such spawn would
    // break working installs to enforce a rule we cannot even read.
    //
    // What is NOT acceptable is the silence: this used to return `allow` with
    // nothing on stderr, so a panel designer spawning without its preloaded
    // `architecture-tech-lead` skill looked exactly like one that passed the
    // check. The gate says out loud that it did not run.
    //
    // Through `systemMessage`, NOT stderr. An exit-0 PreToolUse hook's stderr is
    // not surfaced outside `--debug`, so the announcement this branch exists to
    // make was still, in practice, silent — the skipped gate looked exactly like
    // a passed one to the operator it was written for. Kept on stderr as well
    // for the log.
    const notice =
      `[loom] validate-agent-skill: no agent file found for "${subagentType}" — ` +
      `skill enforcement SKIPPED for this spawn (searched the executing Loom package, ` +
      `CLAUDE_PLUGIN_ROOT, <git-root>/.claude/agents, and ~/.claude/agents)`;
    process.stderr.write(notice + "\n");
    return allowWithNotice(notice);
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
