/**
 * Shared constants for loom hooks.
 * Skills reference these values — update docs if changed.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PHASES, type Phase } from "./types";

/** Markers above this trigger mandatory clarify phase */
export const CLARIFY_THRESHOLD = 3;

/** Valid phase ordering — re-exported from the single source tuple in types. */
export const PHASE_ORDER: readonly Phase[] = PHASES;

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

/** Tools that modify files (defined in core/tool-vocabulary — re-exported here, config stays the documented home) */
export { FILE_MODIFYING_TOOLS, TEST_COMMAND_PATTERNS } from "./core/tool-vocabulary";

/** Whitelisted helper scripts in guard-state-file */
export const WHITELISTED_HELPERS: readonly string[] = [
  "complete-wave-gate",
  "mark-tests-passed",
  "store-review-findings",
  "store-spec-check",
  "populate-task-graph",
  "store-test-evidence",
  "set-phase",
  "cleanup-state",
];

/** Subagent tracking directory */
export const SUBAGENT_DIR = process.env.LOOM_SUBAGENT_DIR ?? "/tmp/claude-subagents";

/**
 * One TTL for every liveness judgment about subagent tracking files: the
 * SessionStart sweep deletes files whose mtime is older than this, and the
 * machine-binding reader treats bindings whose last activity (bind stamp or
 * binding-file mtime, whichever is later) exceeds it as absent. A single
 * constant keeps the two mechanisms from drifting apart.
 */
export const STALE_SUBAGENT_TTL_MS = 60 * 60_000;

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const DEFAULT_MACHINES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "machines");

/**
 * Guarded-skill-machine definitions directory (shipped with loom, per agent
 * type), resolved lazily — reads LOOM_MACHINES_DIR at call time so the gate
 * can be pointed at fixture machines per-test without a module reload.
 */
export const machinesDir = (): string => process.env.LOOM_MACHINES_DIR ?? DEFAULT_MACHINES_DIR;

/** Machines directory — resolved once at import (consumers that never re-point) */
export const MACHINES_DIR = machinesDir();

/** State file patterns to guard — built lazily so the machine-definitions
 * dir resolves machinesDir() at decision time (a re-pointed
 * LOOM_MACHINES_DIR is guarded without a module reload, mirroring
 * mark-subagent-active / update-task-status).
 * Includes the guarded-machine subagent dir (derived from SUBAGENT_DIR, not
 * hardcoded): an agent writing the evidence ledger or binding files via Bash
 * would forge trusted test evidence, appending to `.active` would fake
 * attribution, and `rm` of the directory itself would silently disarm the
 * gate — so any reference to the dir in a segment that is not an
 * allowlisted read-only command or whitelisted helper blocks.
 * The machine-definitions dir is guarded for the same reason: `rm` of a
 * machine file via Bash would make the gate see "no machine" for a BOUND
 * agent (which now fails closed — but deleting definitions must be blocked
 * at the source too). The state DIRECTORY (dirname of the task-graph path,
 * derived from taskGraphRelative, not hardcoded) is guarded for the same
 * dir-guard reason: a glob (`active_task*.json`, `.claude/state/*.json`) or
 * brace (`active_task_{graph,x}.json`) write names the directory but never
 * the file literal, so only a dir match can catch the forgery. */
export const stateFilePatterns = (): RegExp => new RegExp(
  `active_task_graph|review-invocations|${escapeRegex(dirname(taskGraphRelative()))}|${escapeRegex(SUBAGENT_DIR)}|${escapeRegex(machinesDir())}`
);

/** Dirs whose writes are NEVER whitelisted, even for helper invocations:
 * a write into the subagent dir forges trusted evidence (`.evidence.jsonl`),
 * fakes attribution (`.active`), or disarms the gate (`.machine`), and a
 * write into the machine-definitions dir deletes/rewrites the gate's rules.
 * guard-state-file checks these BEFORE the helper allow. Built lazily for
 * the same machinesDir() re-point reason as stateFilePatterns. */
export const protectedDirPatterns = (): RegExp => new RegExp(
  `${escapeRegex(SUBAGENT_DIR)}|${escapeRegex(machinesDir())}`
);

/** Commands allowed to touch guarded state paths: deny-by-default allowlist.
 *
 * This replaced the WRITE_PATTERNS denylist after rounds 11-14 each shipped
 * a critical bypass of the same class ("write tool not yet enumerated" —
 * substitution escapes, `bun -e`, glob paths, `ln`/`truncate`). An allowlist
 * inverts the residual: instead of enumerating writers (unbounded), it
 * enumerates readers (small, stable), so an unknown command on a guarded
 * path blocks instead of slipping through.
 *
 * Membership criterion: the command must be unable to write a file under ANY
 * flag combination. Deliberately excluded, with the flag that disqualifies
 * them: `sort` (-o), `uniq` (second file operand), `less` (-o/-O),
 * `xxd` (-r <outfile>), `base64` (macOS -o), `sed`/`awk` (-i / in-script
 * `w`/`print >`), `find` (-delete/-exec), `git` (checkout/restore rewrite the
 * work tree — a `git checkout -- <state>` is a verdict-restore forgery),
 * `touch` (mtime forgery defeats report freshness), `rg` (--pre <cmd> /
 * --hostname-bin <cmd> execute an arbitrary program per input file — a
 * pre-staged script receives the guarded path and can rewrite or delete it),
 * `more` (interactive shell escape via `!cmd`/`v`; non-interactive it acts
 * like cat, but membership requires no write capability under ANY use), and
 * wrapper/executor commands that run OTHER commands (`env`, `xargs`, `sudo`,
 * `timeout`, `nohup`, `nice`, `command`, shells, interpreters) — a wrapper
 * inherits the write capability of whatever it wraps. Heads match exactly
 * (no basename resolution): `./cat` or `/tmp/evil/jq` must not inherit the
 * trust of a PATH-resolved name. */
export const READ_ONLY_STATE_COMMANDS: ReadonlySet<string> = new Set([
  "jq", "cat", "grep", "egrep", "fgrep",
  "head", "tail", "wc", "ls", "stat", "file",
  "diff", "cmp", "md5sum", "sha1sum", "sha256sum",
  "cut", "tr", "nl", "od", "hexdump", "strings",
  "echo", "printf", "test", "[", "[[", "true", "false",
  "cd", "pwd", "dirname", "basename", "readlink", "realpath", "du",
]);

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

/** Relative path within a repo root — configurable via env (read at call time).
 * Calls detectHarness() rather than the HARNESS const (identical result) so
 * it is callable regardless of module-init order — stateFilePatterns()
 * derives the guarded state dir from this at call time, above HARNESS. */
function taskGraphRelative(): string {
  return process.env.LOOM_STATE_PATH
    ?? (detectHarness() === "pi"
      ? ".pi/state/active_task_graph.json"
      : ".claude/state/active_task_graph.json");
}

/** Find task graph by walking up from cwd to git root */
function findTaskGraphPath(): string {
  const relative = taskGraphRelative();

  // Try relative first (works when cwd = repo root)
  if (existsSync(relative)) return relative;

  // Walk up via git rev-parse
  try {
    const root = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
    const abs = join(root, relative);
    if (existsSync(abs)) return abs;
  } catch (e) {
    // Not a git repo (or git missing): the walk-up is skipped and only the
    // cwd-relative path can resolve — say so, or a task graph sitting at the
    // repo root looks mysteriously absent from a subdirectory cwd.
    process.stderr.write(
      `loom: git rev-parse walk-up failed while locating ${relative} — falling back to cwd-relative: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }

  // Fallback to relative (callers check existsSync anyway)
  return relative;
}

/**
 * Task graph path, resolved lazily — reads LOOM_STATE_PATH at call time so
 * handlers observe per-test env changes without a module reload.
 */
export const taskGraphPath = (): string => findTaskGraphPath();

/** Task graph path — resolved once at import (consumers that never re-point) */
export const TASK_GRAPH_PATH = findTaskGraphPath();

// --- Linter Configuration ---

/** Default rules directory (shipped with loom) — resolved from this file's location */
const CONFIG_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RULES_DIR = join(CONFIG_DIR, "..", "..", "lint-rules");

/** Project-local rules directory — resolved relative to repo root */
export const PROJECT_RULES_DIR = HARNESS === "pi"
  ? ".pi/linter/rules"
  : ".claude/linter/rules";
