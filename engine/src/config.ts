/**
 * Shared constants for loom hooks.
 * Skills AND orchestrator docs (commands/loom.md) reference these values —
 * update the docs if changed.
 */

import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { match, P } from "ts-pattern";
import { PHASES, type Phase } from "./types";
// Panel SIZE policy is derived from the pure panel-contract lens tables, not
// restated here. Its pure-core dependencies add no cycle back to config.
import { PANEL_BASELINE_LENSES, PANEL_LENSES } from "./core/panel-contract";
// The Agent Catalog is the single identity source for every Loom-owned agent
// (kind, profile, required Skill). Its derived agent sets and phase map live in
// the pure agent-catalog-projections leaf — this import adds no cycle — and
// every consumer, shell or core, imports them from there: config does not
// re-export them. config owns only the harness-level sets below and the
// load-time disjointness guards over the catalog's sets.
import {
  ARCH_PANEL_AGENTS,
  IMPL_AGENTS,
  PHASE_AGENT_MAP,
  REVIEW_AGENTS,
  REVIEW_PANEL_AGENTS,
} from "./core/agent-catalog-projections";
import { frozenSet } from "./core/frozen";
import { UTILITY_AGENTS } from "./core/phase-policy";
import { VERIFICATION_MANIFEST_SOURCE_PATH } from "./core/verification-manifest";
import { guardedDirsOf, protectedDirsOf, type GuardedLocations } from "./core/guarded-locations";
import { nonEmptyOf, type NonEmpty } from "./core/orchestration-contract/identity";
import { projectRulesLayout } from "./linter/programmatic/config";
import { projectRootForStateFile } from "./core/phase-artifact-paths";
import { observeGitProbe, type GitProbeStep } from "./utils/git-probe";
import { observePathPresence } from "./utils/path-presence";
import { GIT_PROBE_OUTPUT_LIMIT, spawnGit, type GitSpawn } from "./utils/git-execution-policy";
import {
  describeGitOutcome,
  diagnoseGitOutcome,
  gitDiagnosticLost,
  gitExitedWith,
  gitStderrText,
  gitStdoutText,
  type GitExit,
  type GitSpawnOutcome,
} from "./utils/git-spawn-outcome";

/** Valid phase ordering — re-exported from the single source tuple in types. */
export const PHASE_ORDER: readonly Phase[] = PHASES;

/** Every PHASE_AGENT_MAP key `detectPhase` (validate-phase-order.ts) could probe
 *  when routing this panel agent, invoked either bare or `-agent`-suffixed.
 *  detectPhase tries `phaseMap[agent]` AND `phaseMap[agent + "-agent"]`, and the
 *  agent reaching it may be the stored suffixed name (`arch-designer-agent`) OR
 *  its bare form (`arch-designer`). The union of keys those probes hit is
 *  {bare, name, name + "-agent"}. The disjointness guard must forbid ALL of
 *  them — the single-source Agent Catalog projection into ARCH_PANEL_AGENTS
 *  already rules out the exact name appearing in both roles, but NOT a
 *  de-suffixed phase agent (`arch-designer`)
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

/** Review-panel agents that would be MISROUTED by colliding with a phase,
 *  architecture-panel, impl, review, or utility agent — validatePhaseOrder
 *  passes utility agents through before detectPhase; detectPhase probes bare
 *  and `-agent`-suffixed forms and reaches the remaining sets first. Must always be empty. Exported
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
  // `reviewPanelOverlap`'s `reserved` parameter carries the same default the
  // one-argument call triggers, so the branch is a pass-through and is
  // collapsed: passing `reserved` through is identical in every state.
  const overlap = reviewPanelOverlap(panel, reserved);
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
 *  by colliding with an execute-phase or utility agent. validatePhaseOrder
 *  short-circuits UTILITY agents to passthrough before detectPhase runs;
 *  detectPhase classifies IMPL/REVIEW agents as "execute" before reaching the
 *  panel branch, probing both the bare and `-agent`-suffixed forms. So a panel agent
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
      `or utility agents, but these collide: ${overlap.join(", ")}. validatePhaseOrder would ` +
      `pass them through as utility, or detectPhase would classify them as "execute", before reaching ` +
      `the panel branch, so they would never be recognized as architecture work.`,
  );
}

// Fail at module load if a panel agent collides with an execute/utility agent —
// same rationale as assertPanelPhaseDisjoint above, but for the utility check
// and detectPhase sets reached BEFORE the panel branch. Runs once per process.
assertPanelExecuteDisjoint();

/** Tool vocabulary (defined in core/tool-vocabulary — re-exported here, config stays the documented home) */
export { FILE_MODIFYING_TOOLS, SUBAGENT_SPAWN_TOOLS, TEST_COMMAND_PATTERNS } from "./core/tool-vocabulary";

/** Subagent tracking directory — resolved once at import (consumers that
 *  never re-point LOOM_SUBAGENT_DIR at runtime). */
export const SUBAGENT_DIR = process.env.LOOM_SUBAGENT_DIR ?? "/tmp/claude-subagents";

/** Subagent tracking directory, resolved LAZILY — like machinesDir(), reads
 *  LOOM_SUBAGENT_DIR at call time so pi-path consumers (write-grant
 *  directors, session registries, direct-edit guards) observe per-test or
 *  per-harness re-pointing without a module reload. Production behavior is
 *  identical to SUBAGENT_DIR (the env never changes mid-process there). */
export const subagentDir = (): string => process.env.LOOM_SUBAGENT_DIR ?? "/tmp/claude-subagents";

declare const PERSISTENT_SUBAGENT_STORE: unique symbol;

/**
 * A store that lives in the protected subagent dir and outlives every
 * session: its entry name there, and its directory, resolved lazily like
 * `subagentDir()`. Branded and minted only by the module-private
 * `persistentStore` below, so a structurally identical `{ entry, dir }`
 * literal does not type-check: a store cannot name its directory without
 * being in `PERSISTENT_SUBAGENT_STORES`, and the stale sweep exempts it.
 */
export type PersistentSubagentStore = Readonly<{ entry: string; dir: () => string }> &
  { readonly [PERSISTENT_SUBAGENT_STORE]: true };

// The one mint of the brand.
const persistentStore = (entry: string): PersistentSubagentStore =>
  Object.freeze({ entry, dir: () => join(subagentDir(), entry) }) as PersistentSubagentStore;

/**
 * Every persistent store of the subagent dir, declared ONCE. The SessionStart
 * stale sweep's exemption set is derived from this table, so a store added
 * here survives the sweep by construction: every other subagent-dir entry is
 * per-session tracking that ages out, while an audit run outlives sessions.
 */
export const PERSISTENT_SUBAGENT_STORES = Object.freeze({
  /**
   * The security-audit run registry (ADR-0067 D6): one entry file per audit
   * run directory, registered by every writing `helper security-audit`
   * operation and by `security-verification` start and resume (idempotently,
   * so the next write rebuilds a wiped registry). Inside the protected subagent
   * dir so a subagent cannot add, rewrite or delete an entry; the subagent
   * write guard reads it to know which directories are audit runs without
   * trusting the command line. A swept registry would silently drop that
   * knowledge. Owned by `orchestration/security-audit-run-registry.ts`.
   */
  securityAuditRunRegistry: persistentStore("security-audit-runs"),
  /**
   * The capture attestation store (ADR-0067, amended): one immutable entry per
   * security verifier attempt a HARNESS captured natively, written by the
   * capturing harness process and required by `verify --from` and by the
   * audit's adjudication before a ballot counts. A swept store would make
   * every captured ballot unprovable. Owned by
   * `orchestration/capture-attestation-store.ts`.
   */
  captureAttestations: persistentStore("security-capture-attestations"),
} satisfies Readonly<Record<string, PersistentSubagentStore>>);

/** Subagent-dir entries the SessionStart stale sweep never removes: exactly
 *  the entries of `PERSISTENT_SUBAGENT_STORES`, derived, never restated. */
export const PERSISTENT_SUBAGENT_DIR_ENTRIES: ReadonlySet<string> =
  frozenSet(Object.values(PERSISTENT_SUBAGENT_STORES).map((store) => store.entry));

/**
 * One TTL for every liveness judgment about subagent tracking files: the
 * SessionStart sweep deletes files whose mtime is older than this, and the
 * machine-binding reader treats bindings whose last activity (bind stamp or
 * binding-file mtime, whichever is later) exceeds it as absent. A single
 * constant keeps the two mechanisms from drifting apart.
 */
export const STALE_SUBAGENT_TTL_MS = 60 * 60_000;

const DEFAULT_MACHINES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "machines");

/**
 * Guarded-skill-machine definitions directory (shipped with loom, per agent
 * type), resolved lazily — reads LOOM_MACHINES_DIR at call time so the gate
 * can be pointed at fixture machines per-test without a module reload.
 */
export const machinesDir = (): string => process.env.LOOM_MACHINES_DIR ?? DEFAULT_MACHINES_DIR;

/** Machines directory — resolved once at import (consumers that never re-point) */
export const MACHINES_DIR = machinesDir();

/** The guarded directories, resolved LAZILY from configuration (LOOM_STATE_PATH,
 * LOOM_SUBAGENT_DIR and LOOM_MACHINES_DIR are read at call time, so a re-pointed
 * directory is guarded without a module reload). The state DIRECTORY of every
 * task-graph candidate — derived from `taskGraphRelatives()`, not just the
 * first and not hardcoded — is guarded so a glob/brace write that names the dir
 * but not the file literal is still caught. Shells resolve this once per
 * decision and pass it to the pure guards (`core/guarded-locations`). */
export const guardedLocations = (): GuardedLocations => Object.freeze({
  stateDirs: Object.freeze([
    ...new Set([
      ...taskGraphRelatives().map((path) => dirname(path)),
      dirname(VERIFICATION_MANIFEST_SOURCE_PATH),
    ]),
  ]),
  subagentDir: subagentDir(),
  machinesDir: machinesDir(),
});

/** Every guarded directory, single source of truth (see `guardedDirsOf`). */
export const guardedDirs = (): readonly string[] => guardedDirsOf(guardedLocations());

/** The subset of guardedDirs whose writes are NEVER whitelisted, even for a
 * helper invocation (see `protectedDirsOf`). guard-state-file checks these
 * BEFORE the helper allow, and block-direct-edits guards them for file tools
 * wherever they lie (ADR-0046). */
export const protectedDirs = (): readonly [string, ...string[]] => protectedDirsOf(guardedLocations());

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
function taskGraphRelatives(): NonEmpty<string> {
  if (process.env.LOOM_STATE_PATH) return nonEmptyOf(process.env.LOOM_STATE_PATH);
  return detectHarness() === "pi"
    ? nonEmptyOf(PI_TASK_GRAPH_PATH, CLAUDE_TASK_GRAPH_PATH)
    : nonEmptyOf(CLAUDE_TASK_GRAPH_PATH);
}

/** Primary relative path used when no existing graph can be found. */
function taskGraphRelative(): string {
  const [primary] = taskGraphRelatives();
  return primary;
}

/**
 * Fail-closed existence probe for gates that arm on a path's presence: it
 * answers exactly as `pathMayExist` (`utils/path-presence` — ENOENT is the
 * ONLY absent answer) and also writes a stderr line saying why when presence
 * is unknown, so the gate fails closed visibly. The operator line is built by `diagnostic` so each
 * harness keeps its own name (and the ELOOP regression tests can tell the
 * probes apart) while the ENOENT-only-absent semantics live in one place.
 */
export function probePathFailClosed(
  path: string,
  diagnostic: (path: string, cause: string) => string,
): boolean {
  const presence = observePathPresence(path);
  if (presence.kind === "unknown") process.stderr.write(`${diagnostic(path, presence.cause)}\n`);
  return presence.kind !== "absent";
}

/** Engine-side fail-closed existence probe (see `probePathFailClosed`). */
export function pathExistsFailClosed(path: string): boolean {
  return probePathFailClosed(path, (p, cause) =>
    `loom: cannot access ${p}: ${cause} — assuming present (fail closed)`);
}

const NOT_A_GIT_REPOSITORY = /^fatal: not a git repository(?: \(or any of the parent directories\))?:/m;

/** Prove no ancestor contains repository metadata; only ENOENT is absence. */
function proveNoGitMetadataInAncestorsFrom(cwd: string): void {
  let directory = cwd;
  while (true) {
    const candidate = join(directory, ".git");
    try {
      lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(
          `cannot inspect repository metadata candidate ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const parent = dirname(directory);
      if (parent === directory) return;
      directory = parent;
      continue;
    }
    throw new Error(`git reported no repository, but repository metadata exists at ${candidate}`);
  }
}

/** One root probe's classified answer, read from one outcome alone. Two
 *  answers are EMPTY observations the bounded retry re-runs (see
 *  `observeGitProbe`): a status-0 root with no stdout, and a fatal exit whose
 *  stderr arrived empty — Git writes a diagnostic for every fatal exit, so
 *  that silence is a lost capture, and without the text the not-a-repository
 *  answer cannot be told apart from a failed probe. `not-repository` is Git's
 *  answer only; the shell still proves it against the filesystem. */
type RootAnswer =
  | Readonly<{ kind: "root"; root: string }>
  | Readonly<{ kind: "not-repository" }>;

type EmptyRootAnswer =
  | Readonly<{ kind: "empty-root"; outcome: GitExit<0> }>
  | Readonly<{ kind: "diagnostic-lost"; outcome: GitExit }>;

type RootProbe = RootAnswer | EmptyRootAnswer;

const emptyRootProbe = (probe: RootProbe): probe is EmptyRootAnswer =>
  probe.kind === "empty-root" || probe.kind === "diagnostic-lost";

/** A refused root probe, naming its directory, its rendered ending, and
 *  whether the bounded retries confirmed it. */
function rootProbeFailure(cwd: string, outcome: GitSpawnOutcome, attempts: "first" | "confirmed"): Error {
  const { head, detail } = diagnoseGitOutcome(outcome);
  const confirmed = attempts === "confirmed" ? " (confirmed after bounded retries)" : "";
  return new Error(`git rev-parse failed (${head}) for ${cwd}${confirmed}${detail === null ? "" : `: ${detail}`}`);
}

const rootProbeRefused = (error: Error): GitProbeStep<RootProbe, Error> => Object.freeze({ ok: false, error });
const rootProbeAnswered = (probe: RootProbe): GitProbeStep<RootProbe, Error> =>
  Object.freeze({ ok: true, value: Object.freeze(probe) });

/** Classify one `rev-parse --show-toplevel` exit (pure). */
function classifyRootExit(cwd: string, exit: GitExit): GitProbeStep<RootProbe, Error> {
  if (gitExitedWith(exit, [0])) {
    const root = gitStdoutText(exit).trim();
    return rootProbeAnswered(root === "" ? { kind: "empty-root", outcome: exit } : { kind: "root", root });
  }
  if (gitDiagnosticLost(exit)) return rootProbeAnswered({ kind: "diagnostic-lost", outcome: exit });
  if (exit.status === 128 && NOT_A_GIT_REPOSITORY.test(gitStderrText(exit))) return rootProbeAnswered({ kind: "not-repository" });
  return rootProbeRefused(rootProbeFailure(cwd, exit, "first"));
}

/** Classify one root-probe outcome (pure): only an exit can answer; a child
 *  that never started, faulted, timed out, outgrew its budget or was
 *  signalled refuses with its rendered outcome. */
function classifyRootProbe(cwd: string, outcome: GitSpawnOutcome): GitProbeStep<RootProbe, Error> {
  return match(outcome)
    .with({ kind: "spawn-failed" }, (failed) => rootProbeRefused(new Error(`git rev-parse ${describeGitOutcome(failed)}`)))
    .with({ kind: "exited" }, (exit) => classifyRootExit(cwd, exit))
    .with({ kind: P.union("faulted", "timed-out", "over-budget", "signalled") }, (ended) =>
      rootProbeRefused(rootProbeFailure(cwd, ended, "first")))
    .exhaustive();
}

/** The refusal of a root probe that stayed empty through the bounded retries. */
function confirmedEmptyRootFailure(cwd: string, probe: EmptyRootAnswer): Error {
  return match(probe)
    .with({ kind: "diagnostic-lost" }, ({ outcome }) => rootProbeFailure(cwd, outcome, "confirmed"))
    .with({ kind: "empty-root" }, ({ outcome }) => {
      const stderr = gitStderrText(outcome);
      return new Error(
        `git rev-parse returned an empty repository root for ${cwd} (confirmed after bounded retries)` +
        ` status=${outcome.status} stdoutLength=${gitStdoutText(outcome).length}` +
        " signal=none" +
        (stderr === "" ? "" : ` stderr: ${stderr}`),
      );
    })
    .exhaustive();
}

/** The cwd-explicit core (the spawn-cwd runtime polarity): the probe runs with
 *  the explicit cwd, so the governing graph lives in the repository the caller
 *  declares — the bounded retry here discharges the transients documented at
 *  `observeGitProbe` (an empty root, a lost fatal diagnostic); a confirmed
 *  anomaly throws with the full probe evidence. The probe runs under the
 *  shared `git-execution-policy`, whose `LANG=C`/`LC_ALL=C` keeps the English
 *  diagnostic the not-a-repository match reads. `spawn` is the
 *  status-returning seam as a port, so tests script outcomes directly. Git's
 *  not-a-repository answer is accepted only once no ancestor holds repository
 *  metadata. */
function gitRepositoryRootFrom(cwd: string, spawn: GitSpawn): string | null {
  const observed = observeGitProbe(
    () => classifyRootProbe(cwd, spawn(["rev-parse", "--show-toplevel"], { cwd, maxBuffer: GIT_PROBE_OUTPUT_LIMIT })),
    emptyRootProbe,
  );
  if (observed.kind === "failed") throw observed.error;
  if (observed.kind === "confirmed-empty") throw confirmedEmptyRootFailure(cwd, observed.third);
  if (observed.value.kind === "root") return observed.value.root;
  proveNoGitMetadataInAncestorsFrom(cwd);
  return null;
}

export type TaskGraphProjectBoundary =
  | Readonly<{ kind: "git-repository"; root: string }>
  | Readonly<{ kind: "state-layout"; root: string }>;

/** Observe the project boundary owning one authoritative absolute TaskGraph.
 *
 * Every selected State File is probed from its own parent, never by resolving
 * a possibly-relative LOOM_STATE_PATH against the caller's later cwd. A Git
 * repository supplies first-class boundary authority. Proven non-repositories
 * retain the canonical/legacy layout fallback used before Git authority was
 * recorded; Git observation failures throw rather than fabricate a boundary.
 * `spawn` defaults to the policy-bound `spawnGit`; tests pass a fake. */
export function observeTaskGraphProjectBoundary(statePath: string, spawn: GitSpawn = spawnGit): TaskGraphProjectBoundary {
  const absolute = resolve(statePath);
  const root = gitRepositoryRootFrom(dirname(absolute), spawn);
  return root === null
    ? Object.freeze({ kind: "state-layout", root: projectRootForStateFile(absolute) })
    : Object.freeze({ kind: "git-repository", root: projectRootForStateFile(absolute, root) });
}

/** Find the task graph by walking up from the GIVEN cwd to its git root.
 *  Returns an absolute path so consumers rooted at a different cwd (a spawn
 *  whose declared cwd names a linked worktree) resolve the same file the
 *  observation probed: the graph that governs a repository lives IN that
 *  repository, so the cwd is the boundary-trusted source for which graph
 *  authority a caller targets. The engine's ONE task-graph resolution core —
 *  both this finder and the runtime `taskGraphPath()` wrapper below compose
 *  it, so no two callers can disagree about where the graph sits. */
export function findTaskGraphPathFrom(cwd: string): string {
  const relatives = taskGraphRelatives();

  // Try cwd-relative candidates first (works when cwd = repo root). A
  // non-ENOENT-unreadable candidate is treated as PRESENT (fail closed):
  // skipping it would point the caller at a creation path while the real
  // graph sits unreadable, compounding the fail-open below.
  for (const relative of relatives) {
    const candidate = resolve(cwd, relative);
    if (pathExistsFailClosed(candidate)) return candidate;
  }

  // Walk up via git rev-parse and preserve candidate priority at the root.
  // Only a proven non-repository permits fallback. Missing Git, permission,
  // safe-directory, I/O, and malformed-output failures throw so callers cannot
  // mistake an unobservable repository-root graph for no graph.
  const root = gitRepositoryRootFrom(cwd, spawnGit);
  if (root !== null) {
    for (const candidateRelative of relatives) {
      const absolute = join(root, candidateRelative);
      if (pathExistsFailClosed(absolute)) return absolute;
    }
  }

  // No graph exists yet: retain the harness-native creation path.
  return resolve(cwd, taskGraphRelative());
}

/** Find task graph by walking up from cwd to git root. */
function findTaskGraphPath(): string {
  // The explicit LOOM_STATE_PATH override is authoritative and returned
  // as-written: the composition below relativizes only its own discovery
  // resolutions, and relativizing an absolute override that happens to sit
  // under cwd would rewrite an authoritative path into a bare relative one.
  const override = process.env.LOOM_STATE_PATH;
  if (override !== undefined && pathExistsFailClosed(override)) return override;
  const absolute = findTaskGraphPathFrom(process.cwd());
  // The return is RELATIVE exactly when the resolved absolute path sits under
  // process.cwd() — whichever loop found it; every consumer resolves paths
  // against process.cwd(), so the two spellings read the same file. In
  // practice only the first loop produces such a result: the walk-up root is
  // cwd itself or an ancestor, so a root-joined candidate is under cwd only
  // when the cwd-joined probe already found it.
  const underCwd = relative(process.cwd(), absolute);
  return underCwd.startsWith("..") ? absolute : underCwd;
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
 * import-time-resolved graph path. The `block-direct-edits` core guard and the
 * `guard-state-file` hook shell inject it instead of declaring byte-identical
 * twins; Pi passes its own override built on the same `probePathFailClosed`
 * core.
 */
export const defaultTaskGraphExists = (): boolean => pathExistsFailClosed(TASK_GRAPH_PATH);

// --- Linter Configuration ---

/** Default rules directory (shipped with loom) — resolved from this file's location */
const CONFIG_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RULES_DIR = join(CONFIG_DIR, "..", "..", "lint-rules");

/** How long an edit waits for advisory type diagnostics before moving on. A
 *  run that misses it keeps going in the background to warm the cache. */
export const TYPE_DIAGNOSTICS_DEADLINE_MS = 30_000;

/** Incremental build-info and repeat memory for advisory type diagnostics.
 *  Outside every repository, so no checkout or state guard ever sees it. */
export const typeDiagnosticsCacheDir = (env: Readonly<Record<string, string | undefined>> = process.env): string =>
  env.LOOM_TYPE_DIAGNOSTICS_CACHE ??
  join(env.XDG_CACHE_HOME ?? join(env.HOME ?? tmpdir(), ".cache"), "loom", "type-diagnostics");

/** The project's rules directory under `root` (default: cwd), or null when it
 *  has none. Harness-independent: the lookup order is the linter's
 *  (`projectRulesLayout`), so Claude Code and Pi read the same directory.
 *  Null means "no project rules": every caller hands it to `loadRules`, which
 *  then loads the shipped defaults only — no other directory is consulted.
 *  `helper validate-lint-rules` is where a misplaced directory surfaces: it
 *  names both layouts it looked for and reports 0 project rules. */
export const projectRulesDir = (root: string = process.cwd()): string | null => {
  const layout = projectRulesLayout((candidate) => pathExistsFailClosed(join(root, candidate)));
  return layout === null ? null : join(root, layout);
};
