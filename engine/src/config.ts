/**
 * Shared constants for loom hooks.
 * Skills reference these values — update docs if changed.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/** Impl agents → all map to "execute" phase.
 *  Note: agent identifiers are intentionally `string` (no brand). Bun runs
 *  in transpile-only mode, so a TS brand would not enforce anything at
 *  runtime; the real boundary check lives in validate-task-graph.ts via
 *  KNOWN_AGENTS.has(agent). */
export const IMPL_AGENTS = new Set([
  "code-implementer-agent",
  "ts-test-agent",
  "frontend-agent",
  "security-agent",
  "dotfiles-agent",
  "adr-writer-agent",
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
  "set-phase",
  "cleanup-state",
];

/** State file patterns to guard.
 * Includes the guarded-machine evidence ledger + binding files: an agent
 * writing them via Bash would forge trusted test evidence (the ledger
 * stores facts, but consistently-forged facts still judge as trusted). */
export const STATE_FILE_PATTERNS = /active_task_graph|review-invocations|claude-subagents.*\.(evidence\.jsonl|machine)/;

/** Write patterns to block on state files.
 * Note: `(?:^|\s)>>?(?!&)` avoids matching `2>&1` redirects in read-only commands */
export const WRITE_PATTERNS = /(?:^|\s)>>?(?!&)|(?:^|\s)rm |mv |cp |tee |sed -i|perl -i|(?:^|\s)dd |sponge |chmod |python3? .*(open|write)|node .*(writeFile|fs\.)/;

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
export const VALID_TRANSITIONS: Record<Phase, Phase[]> = {
  "init":            ["brainstorm", "specify", "architecture"],
  "brainstorm":      ["brainstorm", "specify"],
  "specify":         ["specify", "clarify", "architecture"],
  "clarify":         ["clarify", "architecture"],
  "architecture":    ["architecture", "plan-alignment", "decompose"],
  "plan-alignment":  ["plan-alignment", "architecture", "decompose"],
  "decompose":       ["decompose", "execute"],
  "execute":         ["execute"],
};

/** Detect which harness is running */
function detectHarness(): "claude" | "pi" {
  if (process.env.PI_CODING_AGENT_DIR) return "pi";
  return "claude";
}

/** Which harness is running */
export const HARNESS = detectHarness();

/** Relative path within a repo root — configurable via env */
const TASK_GRAPH_RELATIVE = process.env.LOOM_STATE_PATH
  ?? (HARNESS === "pi"
    ? ".pi/state/active_task_graph.json"
    : ".claude/state/active_task_graph.json");

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
export const SUBAGENT_DIR = process.env.LOOM_SUBAGENT_DIR ?? "/tmp/claude-subagents";

/** Guarded-skill-machine definitions directory (shipped with loom, per agent type) */
export const MACHINES_DIR = process.env.LOOM_MACHINES_DIR
  ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "machines");

// --- Linter Configuration ---

/** Default rules directory (shipped with loom) — resolved from this file's location */
const CONFIG_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RULES_DIR = join(CONFIG_DIR, "..", "..", "lint-rules");

/** Project-local rules directory — resolved relative to repo root */
export const PROJECT_RULES_DIR = HARNESS === "pi"
  ? ".pi/linter/rules"
  : ".claude/linter/rules";
