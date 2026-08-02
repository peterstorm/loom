/**
 * Shared constants for loom hooks.
 * Skills AND orchestrator docs (commands/loom.md) reference these values —
 * update the docs if changed.
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

/** Orchestration role of an agent.
 *  `phase` identifies the phase the agent performs/completes; it is not the
 *  transition target. Normal phase-agent completion is handed to
 *  resolveTransition, while panel-agent completion is intentionally ignored by
 *  advance-phase so the architecture phase cannot advance mid-panel. */
type AgentRole = { readonly role: "phase" | "panel"; readonly phase: Phase };

/** Single source of truth for every architecture-orchestration agent and its
 *  role. PHASE_AGENT_MAP and ARCH_PANEL_AGENTS are DERIVED views over this map
 *  (below), so the panel/phase disjointness invariant is structural for the
 *  common case: an agent name is one object key with exactly one role, so the
 *  SAME name can never be listed as both phase and panel. (The runtime guard
 *  below is still required — it additionally catches suffix-variant collisions,
 *  e.g. a phase agent `arch-designer` vs a panel `arch-designer-agent`, which are
 *  distinct keys this structure does not rule out. See phaseLookupKeys.) */
const ARCHITECTURE_AGENTS = {
  "brainstorm-agent": { role: "phase", phase: "brainstorm" },
  "specify-agent": { role: "phase", phase: "specify" },
  "clarify-agent": { role: "phase", phase: "clarify" },
  "architecture-agent": { role: "phase", phase: "architecture" },
  "plan-alignment-agent": { role: "phase", phase: "plan-alignment" },
  "decompose-agent": { role: "phase", phase: "decompose" },
  "arch-interviewer-agent": { role: "panel", phase: "architecture" },
  "arch-designer-agent": { role: "panel", phase: "architecture" },
  "arch-judge-agent": { role: "panel", phase: "architecture" },
} as const satisfies Record<string, AgentRole>;

/** Phase agents → their phase. DERIVED from ARCHITECTURE_AGENTS (role `phase`).
 *  Frozen so post-load mutation that could smuggle a panel agent in here — and
 *  break the "only architecture-agent advances the phase" contract that
 *  advance-phase.ts relies on — is impossible at runtime. Typed
 *  `Readonly<Record<string, Phase | undefined>>` (not the mutable `Record`) so
 *  the freeze's read-only-ness survives into the type: `PHASE_AGENT_MAP[x] = ...`
 *  is a compile-time error too, not just a runtime throw. The string index
 *  signature is kept (unlike `as const`) so detectPhase's computed
 *  `PHASE_AGENT_MAP[agent]` lookups still type-check.
 *
 *  `Phase | undefined`, not `Phase`, because the lookup key is AGENT-CONTROLLED
 *  (`tool_input.subagent_type`) and most agents are not in this map. Declaring a
 *  total lookup made every consumer's existence guard look like defensive
 *  clutter the compiler said was unnecessary.
 *
 *  Null-prototype, because `Object.fromEntries` alone returns an object that
 *  inherits `Object.prototype`: `PHASE_AGENT_MAP["constructor"]` returned the
 *  `Object` constructor typed as a `Phase`, and `"toString" in phaseMap` was
 *  true — which `panelPhaseOverlap` below tests with `in`. Every guard downstream
 *  failed closed or loud on the resulting value, but they were catching a hazard
 *  the data structure should never have offered. */
export const PHASE_AGENT_MAP: Readonly<Record<string, Phase | undefined>> = Object.freeze(
  Object.assign(
    Object.create(null) as Record<string, Phase>,
    Object.fromEntries(
      Object.entries(ARCHITECTURE_AGENTS)
        .filter(([, v]) => v.role === "phase")
        .map(([name, v]): [string, Phase] => [name, v.phase]),
    ),
  ),
);

/** A read-only Set that blocks ordinary runtime mutator calls. `Object.freeze`
 *  alone does NOT stop `set.add(...)`, so the instance's `add`/`delete`/`clear`
 *  methods are shadowed with throwing functions before the object shell is
 *  frozen. This protects normal consumers; it does not claim to defeat exotic
 *  prototype calls such as `Set.prototype.add.call(set, value)`. */
function frozenSet<T>(values: Iterable<T>): ReadonlySet<T> {
  const s = new Set(values);
  const immutable = (): never => {
    throw new Error("loom config invariant violated: this Set is immutable");
  };
  s.add = immutable as typeof s.add;
  s.delete = immutable as typeof s.delete;
  s.clear = immutable as typeof s.clear;
  return Object.freeze(s);
}

/** Architecture-panel agents (`/loom --panel`): DERIVED from ARCHITECTURE_AGENTS
 *  (role `panel`). Recognized by phase validation as architecture-phase work, but
 *  INVISIBLE to advance-phase — never in PHASE_AGENT_MAP so only
 *  architecture-agent's SubagentStop advances the phase. If a designer/judge were
 *  a phase agent, its completion would fire resolveTransition and the date-prefix
 *  plan fallback could advance the phase mid-panel. The disjointness is structural
 *  for exact names (one key, one role) AND enforced at module load (the guard
 *  below throws on import) for suffix-variant collisions — belt and suspenders.
 *  Built via frozenSet so runtime mutation is blocked, symmetric with the frozen
 *  PHASE_AGENT_MAP. */
export const ARCH_PANEL_AGENTS: ReadonlySet<string> = frozenSet(
  Object.entries(ARCHITECTURE_AGENTS)
    .filter(([, v]) => v.role === "panel")
    .map(([name]) => name),
);

/** The single phase shared by every `role: "panel"` entry in
 *  ARCHITECTURE_AGENTS. GENUINELY derived (not a literal): we collect the
 *  distinct `phase` values of all panel entries and assert exactly one, so
 *  adding a panel agent with a divergent `phase` throws at load rather than
 *  silently splitting the panel set across phases. The one-phase invariant is
 *  what lets ARCH_PANEL_PHASE below be a single constant. Requires >= 1 panel
 *  agent — panel mode is a shipped feature and its designer/judge/interviewer
 *  entries are always present; a zero-panel config is unsupported and fails loud. */
function derivePanelPhase(): Phase {
  const phases = new Set(
    Object.values(ARCHITECTURE_AGENTS)
      .filter((v) => v.role === "panel")
      .map((v) => v.phase),
  );
  if (phases.size !== 1) {
    throw new Error(
      `loom config invariant violated: all panel agents must share exactly one ` +
        `phase, but ARCHITECTURE_AGENTS panel entries declare: ` +
        `${[...phases].join(", ") || "(none)"}. ARCH_PANEL_PHASE cannot be derived.`,
    );
  }
  return [...phases][0]!;
}

/** The phase every panel agent is classified as for phase-order validation.
 *  Derived from the panel agents' shared `phase` in ARCHITECTURE_AGENTS (see
 *  derivePanelPhase) so the set and the phase it maps to cannot drift:
 *  detectPhase (validate-phase-order.ts) routes panel agents here via this
 *  constant instead of a bare `"architecture"` literal. Must stay a phase panel
 *  agents are allowed to run in, and one whose SubagentStop does NOT advance
 *  (panel agents are absent from PHASE_AGENT_MAP). */
export const ARCH_PANEL_PHASE: Phase = derivePanelPhase();

/** Every PHASE_AGENT_MAP key `detectPhase` (validate-phase-order.ts) could probe
 *  when routing this panel agent, invoked either bare or `-agent`-suffixed.
 *  detectPhase tries `phaseMap[agent]` AND `phaseMap[agent + "-agent"]`, and the
 *  agent reaching it may be the stored suffixed name (`arch-designer-agent`) OR
 *  its bare form (`arch-designer`). The union of keys those probes hit is
 *  {bare, name, name + "-agent"}. The disjointness guard must forbid ALL of
 *  them — the single-source ARCHITECTURE_AGENTS map already rules out the exact
 *  name appearing in both roles, but NOT a de-suffixed phase agent (`arch-designer`)
 *  or a doubly-suffixed one (`arch-designer-agent-agent`) that captures the panel
 *  invocation through detectPhase's other two probes. */
function phaseLookupKeys(panelAgent: string): string[] {
  const bare = panelAgent.endsWith("-agent")
    ? panelAgent.slice(0, -"-agent".length)
    : panelAgent;
  return [bare, panelAgent, panelAgent + "-agent"];
}

/** The panel/phase disjointness invariant, as a live predicate: the panel
 *  agents that are ALSO reachable as phase agents through any key detectPhase
 *  probes (see phaseLookupKeys). Must always be empty — see the comment on
 *  ARCH_PANEL_AGENTS for why. Exported so the invariant can be tested with a
 *  synthetic overlap rather than only asserted against the real (empty) sets. */
export function panelPhaseOverlap(
  panel: ReadonlySet<string> = ARCH_PANEL_AGENTS,
  phaseMap: Readonly<Record<string, Phase | undefined>> = PHASE_AGENT_MAP,
): string[] {
  return [...panel].filter((a) => phaseLookupKeys(a).some((k) => k in phaseMap));
}

/** Throw if any panel agent is also reachable as a phase agent — the
 *  panel/phase disjointness invariant, enforced. Exported so a test can drive
 *  the throwing branch with a synthetic overlapping map; called unconditionally
 *  at module scope below so the same check also fails at load time. */
export function assertPanelPhaseDisjoint(
  panel: ReadonlySet<string> = ARCH_PANEL_AGENTS,
  phaseMap: Readonly<Record<string, Phase | undefined>> = PHASE_AGENT_MAP,
): void {
  const overlap = panelPhaseOverlap(panel, phaseMap);
  if (overlap.length > 0) {
    throw new Error(
      `loom config invariant violated: panel agents must not be phase agents, ` +
        `but these are in both ARCH_PANEL_AGENTS and PHASE_AGENT_MAP: ${overlap.join(", ")}. ` +
        `A panel agent in PHASE_AGENT_MAP would advance the phase mid-panel.`,
    );
  }
}

// Fail at module load — not just in CI — if a panel agent is ever also a phase
// agent. Module init runs once per process, at the first import of this config
// (transitively pulled in by every handler), so an invalid state can never
// execute; it converts a CI-only guard into a load-time impossibility.
assertPanelPhaseDisjoint();

/** Default number of parallel designer agents for `/loom --panel`. The markdown
 *  orchestration runbook mirrors this value; panel-config tests fail if its
 *  concrete prose literal drifts from this executable policy constant. */
export const PANEL_DESIGNERS_DEFAULT = 3;

/** Minimum viable panel size: the mandatory approach gate needs two options. */
export const PANEL_DESIGNERS_MIN = 2;

/** Number of distinct architecture lenses in references/panel-lenses.md — the hard
 *  cap on parallel designers, since each designer takes exactly one lens and no two
 *  can share. Kept as a constant (not re-parsed at runtime) so clampPanelDesigners
 *  stays pure; panel-config.test.ts asserts it still equals the lens-heading count
 *  in the markdown, so adding/removing a lens without updating this value fails CI.
 *  Referenced (with its numeric value) by commands/loom.md. */
export const PANEL_LENS_COUNT = 5;

/** Fixed number of adversarial judge agents for `/loom --panel`. Each judge scores
 *  every candidate against exactly one criterion (primary axis, testability bar,
 *  codebase-fit + effort), so the count is bound to those three criteria and is
 *  NOT user-configurable. The criteria themselves are derived IN CODE by
 *  `deriveJudgeCriteria` (core/panel-contract.ts), not by commands/loom.md prose;
 *  this constant must equal the number of criteria that function RETURNS,
 *  which panel-contract.test.ts asserts. Single numeric source of truth referenced by loom.md and the
 *  panel-config test. */
export const PANEL_JUDGES_DEFAULT = 3;

/** Clamp a numeric designer count into the viable range
 *  [PANEL_DESIGNERS_MIN, PANEL_LENS_COUNT]. The markdown shell rejects malformed
 *  and fractional raw flag values before applying the equivalent bounds.
 *  Non-finite programmatic input falls back to PANEL_DESIGNERS_DEFAULT. */
export function clampPanelDesigners(n: number): number {
  if (!Number.isFinite(n)) return PANEL_DESIGNERS_DEFAULT;
  const floored = Math.floor(n);
  if (floored < PANEL_DESIGNERS_MIN) return PANEL_DESIGNERS_MIN;
  if (floored > PANEL_LENS_COUNT) return PANEL_LENS_COUNT;
  return floored;
}

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

/** Refutation-panel verifiers (wave gate Step 3.5): execute-phase work like
 *  every other reviewer, but deliberately NOT in REVIEW_SUB_AGENTS and NOT in
 *  REVIEW_AGENTS.
 *
 *  A verifier emits pure JSON that the `review-panel` helper validates; it has
 *  no findings of its own to store. In REVIEW_SUB_AGENTS its transcript would
 *  route through store-reviewer-findings, which would find no CRITICAL_COUNT
 *  and mark the task `evidence_capture_failed` — a passing wave blocked by the
 *  agent that was there to unblock it. Kept as its own set for the same reason
 *  ARCH_PANEL_AGENTS is: recognized by phase validation, invisible to the
 *  SubagentStop dispatcher. Frozen, symmetric with ARCH_PANEL_AGENTS. */
export const REVIEW_PANEL_AGENTS: ReadonlySet<string> = frozenSet(["review-verifier-agent"]);

/** Review-panel agents that would be MISROUTED by colliding with a phase,
 *  impl, review, or utility agent — detectPhase probes bare and `-agent`-
 *  suffixed forms and reaches those sets first. Must always be empty. Exported
 *  so the guard can be driven with a synthetic overlap in tests. */
export function reviewPanelOverlap(
  panel: ReadonlySet<string> = REVIEW_PANEL_AGENTS,
  reserved: ReadonlySet<string> = new Set([
    ...Object.keys(PHASE_AGENT_MAP), ...ARCH_PANEL_AGENTS,
    ...IMPL_AGENTS, ...REVIEW_AGENTS, ...UTILITY_AGENTS,
  ]),
): string[] {
  return [...panel].filter((a) => phaseLookupKeys(a).some((k) => reserved.has(k)));
}

/** Throw if a review-panel verifier collides with any other agent set. Called
 *  at module scope below, so an invalid config fails at load, not in CI. */
export function assertReviewPanelDisjoint(
  panel: ReadonlySet<string> = REVIEW_PANEL_AGENTS,
  reserved?: ReadonlySet<string>,
): void {
  const overlap = reserved ? reviewPanelOverlap(panel, reserved) : reviewPanelOverlap(panel);
  if (overlap.length > 0) {
    throw new Error(
      `loom config invariant violated: review-panel verifiers must not also be phase, ` +
        `architecture-panel, impl, review, or utility agents, but these collide: ${overlap.join(", ")}. ` +
        `A verifier reached through another set would be mis-dispatched — in REVIEW_SUB_AGENTS it ` +
        `would be parsed for findings it never emits and fail the task's evidence check.`,
    );
  }
}

assertReviewPanelDisjoint();

/** All agents that map to execute phase (impl + review) */
export const EXECUTE_AGENTS = new Set([...IMPL_AGENTS, ...REVIEW_AGENTS]);

/** Panel agents that would be MISROUTED away from architecture classification
 *  by colliding with an execute-phase or utility agent. detectPhase
 *  (validate-phase-order.ts) classifies IMPL/REVIEW agents as "execute" — and
 *  short-circuits UTILITY agents to passthrough — BEFORE it reaches the panel
 *  branch, probing both the bare and `-agent`-suffixed forms. So a panel agent
 *  whose name (or any phaseLookupKeys variant of it) is also an
 *  IMPL/REVIEW/UTILITY agent would never be recognized as architecture work, and
 *  no PHASE_AGENT_MAP entry exists for it — so assertPanelPhaseDisjoint above,
 *  which only inspects PHASE_AGENT_MAP, cannot catch this class. Must always be
 *  empty. Exported so the guard can be driven with a synthetic overlap in tests. */
export function panelExecuteOverlap(
  panel: ReadonlySet<string> = ARCH_PANEL_AGENTS,
  reserved: ReadonlySet<string> = new Set([...IMPL_AGENTS, ...REVIEW_AGENTS, ...UTILITY_AGENTS]),
): string[] {
  return [...panel].filter((a) => phaseLookupKeys(a).some((k) => reserved.has(k)));
}

/** Throw if any panel agent also collides with an execute-phase or utility
 *  agent — the complement of assertPanelPhaseDisjoint, closing detectPhase's
 *  check-ordering gap (see panelExecuteOverlap). Exported so a test can drive
 *  the throwing branch with a synthetic overlap; called unconditionally at
 *  module scope below so the same check fails at load, not just in CI. */
export function assertPanelExecuteDisjoint(
  panel: ReadonlySet<string> = ARCH_PANEL_AGENTS,
  reserved: ReadonlySet<string> = new Set([...IMPL_AGENTS, ...REVIEW_AGENTS, ...UTILITY_AGENTS]),
): void {
  const overlap = panelExecuteOverlap(panel, reserved);
  if (overlap.length > 0) {
    throw new Error(
      `loom config invariant violated: panel agents must not also be execute-phase ` +
        `or utility agents, but these collide: ${overlap.join(", ")}. detectPhase would ` +
        `classify them as "execute" (or pass them through as utility) before reaching ` +
        `the panel branch, so they would never be recognized as architecture work.`,
    );
  }
}

// Fail at module load if a panel agent collides with an execute/utility agent —
// same rationale as assertPanelPhaseDisjoint above, but for the sets detectPhase
// consults BEFORE the panel branch. Runs once per process at first import.
assertPanelExecuteDisjoint();

/** Tool vocabulary (defined in core/tool-vocabulary — re-exported here, config stays the documented home) */
export { FILE_MODIFYING_TOOLS, SUBAGENT_SPAWN_TOOLS, TEST_COMMAND_PATTERNS } from "./core/tool-vocabulary";

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

/** Guarded directories, single source of truth, resolved lazily (LOOM_*
 * re-point without a module reload). The state DIR (dirname of the task-graph
 * path) is guarded so a glob/brace write that names the dir but not the file
 * literal is still caught; the subagent and machine-definition dirs are
 * additionally PROTECTED (never helper-writable — see protectedDirs). */
export const guardedDirs = (): readonly string[] => [
  dirname(taskGraphRelative()),
  SUBAGENT_DIR,
  machinesDir(),
];

/** The subset of guardedDirs whose writes are NEVER whitelisted, even for a
 * helper invocation: a write into the subagent dir forges trusted evidence
 * (`.evidence.jsonl`), fakes attribution (`.active`), or disarms the gate
 * (`.machine`), and a write into the machine-definitions dir deletes/rewrites
 * the gate's rules. guard-state-file checks these BEFORE the helper allow. */
export const protectedDirs = (): readonly string[] => [SUBAGENT_DIR, machinesDir()];

const toSegments = (dir: string): string[] => dir.split("/").filter((s) => s !== "");

/** guardedDirs / protectedDirs as `/`-split segment lists (empty segments
 * dropped) for the guard's glob-intersection scope test: a glob path reaching
 * AT or INTO one of these dirs could name a guarded file even when no literal
 * survives quote-collapse, so it must enter scope. */
export const guardedDirSegments = (): readonly (readonly string[])[] =>
  guardedDirs().map(toSegments);
export const protectedDirSegments = (): readonly (readonly string[])[] =>
  protectedDirs().map(toSegments);

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
  ["active_task_graph", "review-invocations", ...guardedDirs()].map(escapeRegex).join("|"),
);

export const protectedDirPatterns = (): RegExp => new RegExp(
  protectedDirs().map(escapeRegex).join("|"),
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
 * like cat, but membership requires no write capability under ANY use),
 * `cd` (writes nothing itself, but it RE-SCOPES path resolution:
 * `cd .claude/state && rm *.json` names the guarded dir only in the cd
 * segment while the writer names no guarded literal, so its chain is
 * skipped as out-of-scope — allowlisting cd hands every later segment an
 * unguarded relative namespace. Excluding it costs only fail-closed reads:
 * reads never need to cd INTO a guarded dir, and
 * `cd <unguarded-dir> && jq . <state>` still allows because the cd chain is
 * simply out of scope. Residual, documented: multi-hop
 * `cd .claude; cd state; rm *.json` never names a guarded literal anywhere
 * on the line and stays invisible to any raw-text gate — see
 * machines/README.md known residual limits), and
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
  "pwd", "dirname", "basename", "readlink", "realpath", "du",
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
