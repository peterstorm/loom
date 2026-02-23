/**
 * Shared constants for loom hooks.
 * Skills reference these values — update docs if changed.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Phase } from "./types";

/** Markers above this trigger mandatory clarify phase */
export const CLARIFY_THRESHOLD = 3;

/** Valid phase ordering */
export const PHASE_ORDER: readonly Phase[] = [
  "init", "brainstorm", "specify", "clarify", "architecture", "plan-alignment", "decompose", "execute",
] as const;

/** Phase agents → map to their phase */
export const PHASE_AGENT_MAP: Record<string, Phase> = {
  "brainstorm-agent": "brainstorm",
  "specify-agent": "specify",
  "clarify-agent": "clarify",
  "architecture-agent": "architecture",
  "plan-alignment-agent": "plan-alignment",
  "decompose-agent": "decompose",
};

/** Impl agents → all map to "execute" phase */
export const IMPL_AGENTS = new Set([
  "code-implementer-agent",
  "ts-test-agent",
  "frontend-agent",
  "security-agent",
  "dotfiles-agent",
  "general-purpose",
]);

/** Known agents for task graph validation */
export const KNOWN_AGENTS = new Set([...IMPL_AGENTS, ...Object.keys(PHASE_AGENT_MAP)]);

/** Utility agents allowed through phase validation */
export const UTILITY_AGENTS = new Set(["Explore", "Plan", "haiku"]);

/** Review sub-agents that produce findings per task */
export const REVIEW_SUB_AGENTS = new Set([
  "code-reviewer",
  "silent-failure-hunter",
  "pr-test-analyzer",
  "type-design-analyzer",
  "comment-analyzer",
  "code-simplifier",
]);

/** All review-related agents (sub-agents + spec-check invoker) */
export const REVIEW_AGENTS = new Set([
  ...REVIEW_SUB_AGENTS,
  "spec-check-invoker",
]);

/** All agents that map to execute phase (impl + review) */
export const EXECUTE_AGENTS = new Set([...IMPL_AGENTS, ...REVIEW_AGENTS]);

/** Tools that modify files */
export const FILE_MODIFYING_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

/** Whitelisted helper scripts in guard-state-file */
export const WHITELISTED_HELPERS = [
  "complete-wave-gate",
  "mark-tests-passed",
  "store-review-findings",
  "store-spec-check",
  "populate-task-graph",
  "store-test-evidence",
];

/** State file patterns to guard */
export const STATE_FILE_PATTERNS = /active_task_graph|review-invocations/;

/** Write patterns to block on state files.
 * Note: `(?:^|\s)>>?(?!&)` avoids matching `2>&1` redirects in read-only commands */
export const WRITE_PATTERNS = /(?:^|\s)>>?(?!&)|mv |cp |tee |sed -i|perl -i|(?:^|\s)dd |sponge |chmod |python3? .*(open|write)|node .*(writeFile|fs\.)/;

/** Test command patterns (for bash test output parsing) */
export const TEST_COMMAND_PATTERNS = [
  "mvn test", "mvn verify", "mvn -pl",
  "mvnw test", "mvnw verify",
  "./gradlew test", "./gradlew check",
  "gradle test", "gradle check",
  "npm test", "npm run test",
  "npx vitest", "npx jest",
  "yarn test", "pnpm test", "bun test",
  "pytest", "python -m pytest", "python3 -m pytest",
  "cargo test", "go test", "dotnet test",
  "mix test", "make test", "make check",
];

/** Valid phase transitions: from → allowed targets */
export const VALID_TRANSITIONS: Record<string, Phase[]> = {
  "init":            ["brainstorm", "specify", "architecture"],
  "brainstorm":      ["brainstorm", "specify"],
  "specify":         ["specify", "clarify", "architecture"],
  "clarify":         ["clarify", "architecture"],
  "architecture":    ["architecture", "plan-alignment"],
  "plan-alignment":  ["plan-alignment", "architecture", "decompose"],
  "decompose":       ["decompose", "execute"],
  "execute":         ["execute"],
};

/** Relative path within a repo root */
const TASK_GRAPH_RELATIVE = ".claude/state/active_task_graph.json";

/** Find task graph by walking up from cwd to git root */
function findTaskGraphPath(): string {
  // Try relative first (works when cwd = repo root)
  if (existsSync(TASK_GRAPH_RELATIVE)) return TASK_GRAPH_RELATIVE;

  // Walk up via git rev-parse
  try {
    const root = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
    const abs = join(root, TASK_GRAPH_RELATIVE);
    if (existsSync(abs)) return abs;
  } catch {}

  // Fallback to relative (callers check existsSync anyway)
  return TASK_GRAPH_RELATIVE;
}

/** Task graph path — resolved from cwd or git root */
export const TASK_GRAPH_PATH = findTaskGraphPath();

/** Subagent tracking directory */
export const SUBAGENT_DIR = "/tmp/claude-subagents";
