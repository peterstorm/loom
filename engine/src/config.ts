/**
 * Shared constants for loom hooks.
 * Skills AND orchestrator docs (commands/loom.md) reference these values —
 * update the docs if changed.
 */

import { execSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PHASES, type Phase } from "./types";
// Panel SIZE policy is derived from the pure panel-contract lens tables, not
// restated here. Its pure-core dependencies add no cycle back to config.
import { PANEL_BASELINE_LENSES, PANEL_LENSES } from "./core/panel-contract";
// The Agent Catalog is the single identity source for every Loom-owned agent
// (kind, profile, required Skill). model-profiles is a pure leaf module — this
// import adds no cycle. Every agent set and phase map below is a DERIVED
// projection of the catalog, never a second source.
import {
  AGENT_POLICIES,
  agentsOfKind,
  WAVE_REVIEW_AGENTS,
} from "./core/model-profiles";
import { VERIFICATION_MANIFEST_SOURCE_PATH } from "./core/verification-manifest";

export { WAVE_REVIEW_AGENTS };

/** Markers above this trigger mandatory clarify phase */
export const CLARIFY_THRESHOLD = 3;

/** Valid phase ordering — re-exported from the single source tuple in types. */
export const PHASE_ORDER: readonly Phase[] = PHASES;

/** Phase agents → their phase. DERIVED from the Agent Catalog (kind `phase`).
 *  The catalog's AgentKind is a union, not a record with a `role` beside a
 *  `phase` both branches carry: panel agents have no per-agent phase to
 *  declare — they all run in ARCH_PANEL_PHASE by construction — so
 *  `{ kind: "arch-panel", phase: "decompose" }` is unrepresentable rather
 *  than policed by a load-time throw. Normal phase-agent completion is handed
 *  to resolveTransition, while panel-agent completion is intentionally
 *  ignored by advance-phase so the architecture phase cannot advance
 *  mid-panel. Exact-name phase/panel disjointness is structural (one catalog
 *  key, one kind); the runtime guard below remains for suffix-variant
 *  collisions, e.g. a phase agent `arch-designer` vs a panel
 *  `arch-designer-agent`, which are distinct keys no record can rule out.
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
      // `flatMap` rather than `filter().map()`: the kind union narrows inside
      // the callback that reads `phase`, so only the branch that HAS a phase can
      // contribute one. `filter` leaves the value widened, which is what made
      // the panel branch's absent `phase` a compile error rather than a proof.
      AGENT_POLICIES.flatMap(({ agent, kind }): [string, Phase][] =>
        kind.kind === "phase" ? [[agent, kind.phase]] : [],
      ),
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

/** Architecture-panel agents (`/loom --panel`): DERIVED from the Agent Catalog
 *  (kind `arch-panel`). Recognized by phase validation as architecture-phase
 *  work, but INVISIBLE to advance-phase — never in PHASE_AGENT_MAP so only
 *  architecture-agent's SubagentStop advances the phase. If a designer/judge were
 *  a phase agent, its completion would fire resolveTransition and the date-prefix
 *  plan fallback could advance the phase mid-panel. The disjointness is structural
 *  for exact names (one key, one kind) AND enforced at module load (the guard
 *  below throws on import) for suffix-variant collisions — belt and suspenders.
 *  Built via frozenSet so runtime mutation is blocked, symmetric with the frozen
 *  PHASE_AGENT_MAP. */
export const ARCH_PANEL_AGENTS: ReadonlySet<string> = frozenSet(agentsOfKind("arch-panel"));

/**
 * The phase every panel agent is classified as for phase-order validation.
 *
 * ONE constant rather than a per-agent field, because the panel is a stage
 * WITHIN a phase: an interviewer, N designers and K judges all run inside
 * `architecture` and none of them may advance out of it. `AgentRole`'s panel
 * branch therefore carries no `phase` to disagree with this, which is what
 * retired `derivePanelPhase` — a function that collected the distinct declared
 * phases and threw unless there was exactly one, policing at load time a state
 * the type now cannot express.
 *
 * detectPhase (validate-phase-order.ts) routes panel agents here via this
 * constant instead of a bare `"architecture"` literal. Must stay a phase panel
 * agents are allowed to run in, and one whose SubagentStop does NOT advance
 * (panel agents are absent from PHASE_AGENT_MAP).
 */
export const ARCH_PANEL_PHASE: Phase = "architecture";

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

const agentCollisionOverlap = (
  panel: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
): string[] => [...panel].filter((agent) => phaseLookupKeys(agent).some((key) => reserved.has(key)));

function assertNoOverlap(overlap: readonly string[], message: string): void {
  if (overlap.length > 0) throw new Error(message);
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
  assertNoOverlap(
    overlap,
    `loom config invariant violated: panel agents must not be phase agents, ` +
      `but these are in both ARCH_PANEL_AGENTS and PHASE_AGENT_MAP: ${overlap.join(", ")}. ` +
      `A panel agent in PHASE_AGENT_MAP would advance the phase mid-panel.`,
  );
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

/** Minimum viable panel size: the mandatory approach gate needs two options.
 *
 *  DERIVED from the baseline lens set that `selectPanelLenses` always includes,
 *  mirroring the review panel's `REVIEW_LENSES_MIN = BASELINE_LENSES.length`.
 *  While it was a literal `2`, adding a third architecture baseline lens left
 *  this clamping to 2 while `selectLenses` demanded 3 — the two numbers were
 *  bound only by prose and a bare `expect(...).toBe(2)`. */
export const PANEL_DESIGNERS_MIN = PANEL_BASELINE_LENSES.length;

/** Number of distinct architecture lenses — the hard cap on parallel designers,
 *  since each designer takes exactly one lens and no two can share. Derived from
 *  the lens table itself for the reason above; panel-config.test.ts additionally
 *  asserts it equals the lens-heading count in references/panel-lenses.md, so a
 *  lens added to the markdown and not the table (or the reverse) fails CI.
 *  Referenced (with its numeric value) by commands/loom.md. */
export const PANEL_LENS_COUNT = PANEL_LENSES.length;

/** Fixed number of adversarial judge agents for `/loom --panel`. Each judge scores
 *  every candidate against exactly one criterion (primary axis, testability bar,
 *  codebase-fit + effort), so the count is bound to those three criteria and is
 *  NOT user-configurable. The criteria themselves are derived IN CODE by
 *  `deriveJudgeCriteria` (core/panel-contract.ts), not by commands/loom.md prose;
 *  this constant must equal the number of criteria that function RETURNS,
 *  which panel-contract.test.ts asserts. Single numeric source of truth referenced by loom.md and the
 *  panel-config test. */
export const PANEL_JUDGES_DEFAULT = 3;

// There is deliberately no `clampPanelDesigners` here. It existed as an
// exported, tested function that no engine code path ever called: the real
// enforcement is `selectLenses`' range check, which REJECTS an out-of-range
// designer count rather than clamping it, and `commands/loom.md` rejects
// malformed raw flag values before that. A second set of bounds that nothing
// consults is a specification wearing a function's clothes — it can drift from
// the enforced rule with no runtime consequence and no failing test. The two
// constants above are the shared policy; `selectLenses` is the enforcement.

/** Impl agents → all map to "execute" phase. DERIVED from the Agent Catalog
 *  (kind `impl`). Note: agent identifiers are intentionally `string` (no
 *  brand). Bun runs in transpile-only mode, so a TS brand would not enforce
 *  anything at runtime; the real boundary check lives in
 *  validate-task-graph.ts via KNOWN_AGENTS.has(agent). */
export const IMPL_AGENTS: ReadonlySet<string> = frozenSet(agentsOfKind("impl"));

/** Known agents for task graph validation */
export const KNOWN_AGENTS: ReadonlySet<string> = frozenSet([...IMPL_AGENTS, ...Object.keys(PHASE_AGENT_MAP)]);

/** Utility agents allowed through phase validation */
export const UTILITY_AGENTS: ReadonlySet<string> = frozenSet(["Explore", "Plan", "haiku"]);

/** Review sub-agents that produce findings per task. DERIVED from the Agent
 *  Catalog (kind `reviewer`) — membership only; the ordered wave roster is
 *  WAVE_REVIEW_AGENTS (re-exported above from the catalog module, where its
 *  index-binding order lives beside the identities it selects from). */
export const REVIEW_SUB_AGENTS: ReadonlySet<string> = frozenSet(agentsOfKind("reviewer"));

/**
 * Is this agent type one whose output carries review findings?
 *
 * Lives HERE, beside the set it queries, rather than in core/review-output.
 * That module declares itself pure — "no I/O, no clock, no randomness" — and
 * importing this file to answer a one-line membership question made the claim
 * false: `config` resolves TASK_GRAPH_PATH at import, which spawns
 * `git rev-parse --show-toplevel`, and drags in three throwing load-time
 * assertions besides (assertPanelPhaseDisjoint, assertReviewPanelDisjoint,
 * assertPanelExecuteDisjoint). Agent-name classification is a harness concern,
 * and both callers already hold the agent type before they reach the parser.
 */
export function isReviewAgent(agentType: string): boolean {
  return REVIEW_SUB_AGENTS.has(agentType);
}

/** All review-related agents (sub-agents + spec-check invoker) */
export const REVIEW_AGENTS: ReadonlySet<string> = frozenSet([
  ...REVIEW_SUB_AGENTS,
  ...agentsOfKind("spec-check"),
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
export const REVIEW_PANEL_AGENTS: ReadonlySet<string> = frozenSet(agentsOfKind("review-verifier"));

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
  return agentCollisionOverlap(panel, reserved);
}

/** Throw if a review-panel verifier collides with any other agent set. Called
 *  at module scope below, so an invalid config fails at load, not in CI. */
export function assertReviewPanelDisjoint(
  panel: ReadonlySet<string> = REVIEW_PANEL_AGENTS,
  reserved?: ReadonlySet<string>,
): void {
  const overlap = reserved ? reviewPanelOverlap(panel, reserved) : reviewPanelOverlap(panel);
  assertNoOverlap(
    overlap,
    `loom config invariant violated: review-panel verifiers must not also be phase, ` +
      `architecture-panel, impl, review, or utility agents, but these collide: ${overlap.join(", ")}. ` +
      `A verifier reached through another set would be mis-dispatched — in REVIEW_SUB_AGENTS it ` +
      `would be parsed for findings it never emits and fail the task's evidence check.`,
  );
}

assertReviewPanelDisjoint();

/** Implementation and finding-producing review agents used by execute-phase
 * dispatch sets. Refutation verifiers also classify as execute work, but remain
 * separate so SubagentStop never parses their verdicts as review findings. */
export const EXECUTE_AGENTS: ReadonlySet<string> = frozenSet([...IMPL_AGENTS, ...REVIEW_AGENTS]);

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
  return agentCollisionOverlap(panel, reserved);
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
  assertNoOverlap(
    overlap,
    `loom config invariant violated: panel agents must not also be execute-phase ` +
      `or utility agents, but these collide: ${overlap.join(", ")}. detectPhase would ` +
      `classify them as "execute" (or pass them through as utility) before reaching ` +
      `the panel branch, so they would never be recognized as architecture work.`,
  );
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
  "upgrade-spec-trace",
  "repair-task-graph",
  "review-packet",
  "store-test-evidence",
  "reconcile-implementation-proof",
  "set-phase",
  "cleanup-state",
];

/** Subagent tracking directory — resolved once at import (consumers that
 *  never re-point LOOM_SUBAGENT_DIR at runtime). */
export const SUBAGENT_DIR = process.env.LOOM_SUBAGENT_DIR ?? "/tmp/claude-subagents";

/** Subagent tracking directory, resolved LAZILY — like machinesDir(), reads
 *  LOOM_SUBAGENT_DIR at call time so pi-path consumers (write-grant
 *  directors, session registries, direct-edit guards) observe per-test or
 *  per-harness re-pointing without a module reload. Production behavior is
 *  identical to SUBAGENT_DIR (the env never changes mid-process there). */
export const subagentDir = (): string => process.env.LOOM_SUBAGENT_DIR ?? "/tmp/claude-subagents";

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
  ...new Set([
    ...taskGraphRelatives().map((path) => dirname(path)),
    dirname(VERIFICATION_MANIFEST_SOURCE_PATH),
  ]),
  subagentDir(),
  machinesDir(),
];

/** The subset of guardedDirs whose writes are NEVER whitelisted, even for a
 * helper invocation: a write into the subagent dir forges trusted evidence
 * (`.evidence.jsonl`), fakes attribution (`.active`), or disarms the gate
 * (`.machine`), and a write into the machine-definitions dir deletes/rewrites
 * the gate's rules. guard-state-file checks these BEFORE the helper allow. */
export const protectedDirs = (): readonly string[] => [subagentDir(), machinesDir()];

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
 * Includes the guarded-machine subagent dir (derived from the lazy
 * `subagentDir()`, not the import-frozen SUBAGENT_DIR and not hardcoded — that
 * is what makes the re-pointing above work): an agent writing the evidence
 * ledger or binding files via Bash would forge trusted test evidence,
 * appending to `.active` would fake attribution, and `rm` of the directory
 * itself would silently disarm the gate — so any reference to the dir in a
 * segment that is not an allowlisted read-only command or whitelisted helper
 * blocks.
 * The machine-definitions dir is guarded for the same reason: `rm` of a
 * machine file via Bash would make the gate see "no machine" for a BOUND
 * agent (which now fails closed — but deleting definitions must be blocked
 * at the source too). The state DIRECTORY (dirname of the task-graph path,
 * derived from `taskGraphRelatives()` — every candidate, not just the first —
 * and not hardcoded) is guarded for the same dir-guard reason: a glob
 * (`active_task*.json`, `.claude/state/*.json`) or brace
 * (`active_task_{graph,x}.json`) write names the directory but never the file
 * literal, so only a dir match can catch the forgery. */
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
 * `touch` (mtime forgery defeats report freshness),
 * `rg` (--pre <cmd> executes an arbitrary program per input file — a
 * pre-staged script receives the guarded path and can rewrite or delete it;
 * --hostname-bin <cmd> executes one program once to resolve the hostname.
 * Arbitrary program execution under any use disqualifies it),
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

/** Valid phase transitions: from → allowed targets. Both the record and
 * each member are frozen: a readonly annotation alone would not protect the
 * runtime state-machine policy from ordinary consumer mutation. */
const frozenPhases = (...phases: Phase[]): readonly Phase[] => Object.freeze(phases);

export const VALID_TRANSITIONS: Readonly<Record<Phase, readonly Phase[]>> = Object.freeze({
  "init":            frozenPhases("brainstorm", "specify", "architecture"),
  "brainstorm":      frozenPhases("brainstorm", "specify"),
  "specify":         frozenPhases("specify", "clarify", "architecture"),
  "clarify":         frozenPhases("clarify", "architecture"),
  "architecture":    frozenPhases("architecture", "plan-alignment", "decompose"),
  "plan-alignment":  frozenPhases("plan-alignment", "architecture", "decompose"),
  "decompose":       frozenPhases("decompose", "execute"),
  "execute":         frozenPhases("execute"),
});

/** Detect which harness is running */
function detectHarness(): "claude" | "pi" {
  // PI_CODING_AGENT is Pi's process identity. PI_CODING_AGENT_DIR is only an
  // optional resource-directory override, retained as a compatibility signal
  // for older launchers and isolated tests.
  if (process.env.PI_CODING_AGENT || process.env.PI_CODING_AGENT_DIR) return "pi";
  return "claude";
}

/** Which harness is running */
export const HARNESS = detectHarness();

const PI_TASK_GRAPH_PATH = ".pi/state/active_task_graph.json";
const CLAUDE_TASK_GRAPH_PATH = ".claude/state/active_task_graph.json";

/** Ordered task-graph locations. An explicit override is authoritative. Pi
 * otherwise prefers its native state directory but can resume Loom sessions
 * created before the Pi state split from the legacy Claude-compatible path. */
function taskGraphRelatives(): readonly string[] {
  if (process.env.LOOM_STATE_PATH) return [process.env.LOOM_STATE_PATH];
  return detectHarness() === "pi"
    ? [PI_TASK_GRAPH_PATH, CLAUDE_TASK_GRAPH_PATH]
    : [CLAUDE_TASK_GRAPH_PATH];
}

/** Primary relative path used when no existing graph can be found. */
function taskGraphRelative(): string {
  return taskGraphRelatives()[0]!;
}

/**
 * Fail-closed existence probe core: ENOENT is the ONLY absent answer.
 * `existsSync` returns `false` for ANY error — EACCES, ELOOP, ENOTDIR, EIO
 * all read as "no file" — so an unreadable task-graph path would silently
 * disarm the gates that arm on its presence. Non-ENOENT access errors
 * therefore mean "cannot prove absence": assume present, say why, and let
 * the gate fail closed. The operator line is built by `diagnostic` so each
 * harness keeps its own name (and the ELOOP regression tests can tell the
 * probes apart) while the ENOENT-only-absent semantics live in exactly one
 * place.
 */
export function probePathFailClosed(
  path: string,
  diagnostic: (path: string, cause: string) => string,
): boolean {
  try {
    accessSync(path, fsConstants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    const cause = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${diagnostic(path, cause)}\n`);
    return true;
  }
}

/** Engine-side fail-closed existence probe (see `probePathFailClosed`). */
export function pathExistsFailClosed(path: string): boolean {
  return probePathFailClosed(path, (p, cause) =>
    `loom: cannot access ${p}: ${cause} — assuming present (fail closed)`);
}

/** Find task graph by walking up from cwd to git root. */
function findTaskGraphPath(): string {
  const relatives = taskGraphRelatives();

  // Try cwd-relative candidates first (works when cwd = repo root). A
  // non-ENOENT-unreadable candidate is treated as PRESENT (fail closed):
  // skipping it would point TASK_GRAPH_PATH at a creation path while the real
  // graph sits unreadable, compounding the fail-open below.
  for (const relative of relatives) {
    if (pathExistsFailClosed(relative)) return relative;
  }

  // Walk up via git rev-parse and preserve candidate priority at the root.
  try {
    const root = execSync("git rev-parse --show-toplevel", { encoding: "utf-8" }).trim();
    for (const relative of relatives) {
      const absolute = join(root, relative);
      if (pathExistsFailClosed(absolute)) return absolute;
    }
  } catch (e) {
    // Not a git repo (or git missing): the walk-up is skipped and only the
    // cwd-relative candidates can resolve.
    process.stderr.write(
      `loom: git rev-parse walk-up failed while locating ${relatives.join(" or ")} — falling back to cwd-relative: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }

  // No graph exists yet: retain the harness-native creation path.
  return taskGraphRelative();
}

/**
 * Task graph path, resolved lazily — reads LOOM_STATE_PATH at call time so
 * handlers observe per-test env changes without a module reload.
 */
export const taskGraphPath = (): string => findTaskGraphPath();

/** Task graph path — resolved once at import (consumers that never re-point) */
export const TASK_GRAPH_PATH = findTaskGraphPath();

/**
 * The ONE default task-graph existence probe: the fail-closed probe on the
 * import-time-resolved graph path. Core guards (`block-direct-edits`,
 * `guard-state-file`) inject it instead of declaring byte-identical twins;
 * Pi passes its own override built on the same `probePathFailClosed` core.
 */
export const defaultTaskGraphExists = (): boolean => pathExistsFailClosed(TASK_GRAPH_PATH);

// --- Linter Configuration ---

/** Default rules directory (shipped with loom) — resolved from this file's location */
const CONFIG_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RULES_DIR = join(CONFIG_DIR, "..", "..", "lint-rules");

/** Project-local rules directory — resolved relative to repo root */
export const PROJECT_RULES_DIR = HARNESS === "pi"
  ? ".pi/linter/rules"
  : ".claude/linter/rules";
