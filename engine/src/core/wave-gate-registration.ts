/**
 * Wave Gate registration — the ONE decision over whether a fresh Wave Gate run
 * may install itself as the protected active registration, and the protected
 * TaskGraph that install produces.
 *
 * Two callers ask it: the locked `registerActiveWaveGate` (state-manager)
 * transition persists `installWaveGateRegistration`'s decision under the
 * TaskGraph lock, and the `start wave-gate` preflight asks
 * `admitWaveGateRegistration` the same question of an unlocked snapshot BEFORE
 * a Run Directory is claimed. Sharing the admission keeps preflight from
 * admitting a start that registration would then refuse (or the reverse); the
 * locked call stays authoritative because the graph can move between the two
 * reads.
 *
 * Review authority retirement lives here too. Restart and orphan recovery
 * retire a run's review authority before a replacement registers, and an
 * install over an abandoned predecessor retires that predecessor's authority
 * inside the install itself — so no caller can forget, or mis-parameterise,
 * the supersession step.
 */

import type { ActiveWaveGateRegistration, RetiredWaveReviewRun, TaskGraph } from "../types";
import { preserveAcceptedReviewRunFindings } from "./findings";
import { canonicalRecord, canonicalStructuralEquals, type DomainResult, type OrchestrationRunId } from "./orchestration-contract";
import { parseAbandonmentReason, type AbandonmentReason } from "./abandonment-reason";
import { appendRetiredWaveReviewRun } from "./retired-wave-review-runs";
import { reconcileWaveBlock } from "./wave-gate-model";
import type { NarrowedTaskReview, WaveGateSuccessionAudit } from "./wave-gate-program";
import { holdsBasis } from "./review-narrowing";
import { derivedWaveTaskReview, waveGateAuthorityDigest } from "./wave-review-authority";

/** The registration identity the admission compares against protected state. */
export type WaveGateRegistrationCandidate = Readonly<{
  runId: string;
  wave: number;
  authorityDigest: string;
  runsRoot?: string | undefined;
}>;

/** What an admitted install replaces. */
export type WaveGateInstallPredecessor =
  | Readonly<{ kind: "none" }>
  /** An operator-abandoned run whose review authority the install retires. */
  | Readonly<{ kind: "abandoned"; runId: ActiveWaveGateRegistration["runId"] }>;

export type WaveGateRegistrationAdmission =
  | Readonly<{ kind: "install"; predecessor: WaveGateInstallPredecessor }>
  /** The exact candidate is already the live registration (idempotent replay). */
  | Readonly<{ kind: "replay"; existing: ActiveWaveGateRegistration }>
  | Readonly<{ kind: "refused"; message: string }>;

/** The fully formed locked install: the shell persists `state` and nothing else. */
export type WaveGateInstallDecision =
  | Readonly<{ kind: "installed"; state: TaskGraph; registration: ActiveWaveGateRegistration }>
  | Readonly<{ kind: "replayed"; registration: ActiveWaveGateRegistration }>
  | Readonly<{ kind: "refused"; message: string }>;

/** The live registration IS this candidate, untouched since its install. */
const isExactReplay = (existing: ActiveWaveGateRegistration, candidate: WaveGateRegistrationCandidate): boolean =>
  existing.runId === candidate.runId &&
  existing.wave === candidate.wave &&
  existing.authorityDigest === candidate.authorityDigest &&
  existing.runsRoot === candidate.runsRoot &&
  existing.revision === 0 &&
  existing.terminalOutcome === null;

/**
 * Decide registration for one candidate whose Run Directory published
 * `publishedTaskIds` as its roster (in protected Task order).
 */
export function admitWaveGateRegistration(
  state: TaskGraph,
  candidate: WaveGateRegistrationCandidate,
  publishedTaskIds: readonly string[],
): WaveGateRegistrationAdmission {
  return canonicalRecord(admission(state, candidate, publishedTaskIds));
}

/** The ordered refusal ladder; the first refusal that applies wins. */
function admission(
  state: TaskGraph,
  candidate: WaveGateRegistrationCandidate,
  publishedTaskIds: readonly string[],
): WaveGateRegistrationAdmission {
  if (state.current_phase !== "execute") {
    return { kind: "refused", message: `Cannot register Wave Gate run outside execute Phase (current: ${state.current_phase})` };
  }
  if (state.current_wave !== candidate.wave) {
    return {
      kind: "refused",
      message: `Cannot register Wave Gate wave ${candidate.wave}; protected current_wave is ${state.current_wave ?? "missing"}`,
    };
  }
  const completed = state.wave_gate_history ?? [];
  if (completed.some((entry) => entry.runId === candidate.runId)) {
    return { kind: "refused", message: `Wave Gate run ${candidate.runId} is already terminal` };
  }
  if (completed.some((entry) => entry.wave >= candidate.wave)) {
    return { kind: "refused", message: `Wave ${candidate.wave} is already completed or older than terminal Wave history` };
  }
  const existing = state.active_wave_gate;
  let predecessor: WaveGateInstallPredecessor = { kind: "none" };
  if (existing !== undefined) {
    if (isExactReplay(existing, candidate)) return { kind: "replay", existing };
    if (existing.terminalOutcome === null) {
      return { kind: "refused", message: `Active Wave Gate run ${existing.runId} already owns wave ${existing.wave}` };
    }
    if (existing.terminalOutcome.kind !== "terminal-abandoned") {
      return {
        kind: "refused",
        message: `Legacy terminal Wave Gate run ${existing.runId} must be explicitly migrated to terminal history before registering another run`,
      };
    }
    if (existing.terminalOutcome.supersededBy !== null &&
        existing.terminalOutcome.supersededBy !== candidate.runId) {
      return {
        kind: "refused",
        message: `Abandoned Wave Gate run ${existing.runId} authorizes successor ${existing.terminalOutcome.supersededBy}, ` +
          `not ${candidate.runId}`,
      };
    }
    predecessor = { kind: "abandoned", runId: existing.runId };
  }
  const lockedTaskIds = state.tasks
    .filter((task) => task.wave === candidate.wave)
    .map(({ id }) => id);
  if (!canonicalStructuralEquals(lockedTaskIds, publishedTaskIds) ||
      waveGateAuthorityDigest(candidate.wave, lockedTaskIds, state) !== candidate.authorityDigest) {
    return { kind: "refused", message: "Protected Wave authority changed after Run Directory publication; active Wave Gate was not installed" };
  }
  return { kind: "install", predecessor: canonicalRecord(predecessor) };
}

/**
 * The run a fresh Wave Gate of `wave` succeeds (ADR-0091), as the retirement
 * record it has or is about to get: the Wave's abandoned tombstone, which the
 * install retires, otherwise the Wave's latest retired run. Null when the
 * Wave has no retired run to succeed. The start's preflight and the locked
 * install both ask here, so they agree on the predecessor.
 */
export function successionPredecessorOf(graph: TaskGraph, wave: number): RetiredWaveReviewRun | null {
  const active = graph.active_wave_gate;
  if (active !== undefined && active.wave === wave && active.terminalOutcome?.kind === "terminal-abandoned") {
    return retirementOf(active, "abandoned");
  }
  return (graph.retired_wave_review_runs ?? []).findLast((run) => run.wave === wave) ?? null;
}

/** The Wave Gate run whose review authority a retirement records. */
type RetiringRun = Pick<ActiveWaveGateRegistration, "runId" | "wave" | "authorityDigest">;

const retirementOf = (run: RetiringRun, retirement: RetiredWaveReviewRun["retirement"]): RetiredWaveReviewRun =>
  canonicalRecord({
    schemaVersion: 1, kind: "retired-wave-review-run", runId: run.runId, wave: run.wave,
    authorityDigest: run.authorityDigest, retirement,
  });

/** `graph` with `run` appended to its retired runs, through the one append that keeps a run retired once. */
const withRetiredRun = (graph: TaskGraph, run: RetiringRun, retirement: RetiredWaveReviewRun["retirement"]): TaskGraph => ({
  ...graph,
  retired_wave_review_runs: appendRetiredWaveReviewRun(graph.retired_wave_review_runs, retirementOf(run, retirement)),
});

/**
 * Why `succession` cannot install over `state`, or null. Its predecessor must
 * be the protected one (`successionPredecessorOf`), and each Task it carries
 * must still hold exactly the acceptance it names. Whether that acceptance
 * still judges the Task's bytes and Subject Digest is decided again when the
 * batch installs.
 */
function successionProblem(state: TaskGraph, wave: number, succession: WaveGateSuccessionAudit): string | null {
  const predecessor = successionPredecessorOf(state, wave);
  if (predecessor === null || predecessor.runId !== succession.previousRunId ||
      predecessor.authorityDigest !== succession.previousAuthorityDigest || predecessor.retirement !== succession.kind) {
    return `Wave Gate succession names ${succession.kind} run ${succession.previousRunId}, ` +
      `but Wave ${wave}'s protected predecessor is ${predecessor === null ? "none" : `${predecessor.retirement} run ${predecessor.runId}`}`;
  }
  const stale = succession.carry.carried.find(({ taskId, acceptance }) => {
    const accepted = state.tasks.find(({ id }) => id === taskId)?.accepted_review_authority;
    return accepted?.run_id !== acceptance.runId || accepted.authority_digest !== acceptance.authorityDigest;
  });
  return stale === undefined
    ? null
    : `Wave Gate succession carries Task ${stale.taskId}'s acceptance from run ${stale.acceptance.runId}, which the Task no longer holds`;
}

/**
 * Why a registration's narrowed reviews cannot install over `state`, or null
 * (ADR-0094). Each Task a start narrowed must still hold, as its Review Basis,
 * exactly the acceptance the narrowing was measured against, and its derived
 * roster must still be the one the narrowing was decided from: otherwise the
 * batch would quietly review it in full against a registration that says it
 * narrowed.
 */
function narrowingProblem(state: TaskGraph, narrowed: readonly NarrowedTaskReview[]): string | null {
  for (const { taskId, basis, from } of narrowed) {
    const task = state.tasks.find(({ id }) => id === taskId);
    if (task === undefined || !holdsBasis(task, basis)) {
      return `Wave Gate narrows Task ${taskId}'s review against run ${basis.runId}'s acceptance, which is no longer its Review Basis`;
    }
    const review = derivedWaveTaskReview(state, 2, task);
    if (review.kind !== "roster" || !canonicalStructuralEquals(review.roster, from)) {
      return `Wave Gate narrows Task ${taskId}'s review from a roster its review no longer derives`;
    }
  }
  return null;
}

/**
 * What the locked install reads of the run's program registration: its
 * published Tasks and the issuance plan it froze, its succession (ADR-0091)
 * and its narrowed reviews (ADR-0094). Passing the registration itself is what
 * keeps either check from being skipped by omission.
 */
export type WaveGateInstallProgram = Readonly<{
  taskIds: readonly string[];
  succession?: WaveGateSuccessionAudit;
  narrowedReviews?: readonly NarrowedTaskReview[];
}>;

/**
 * The locked install: freshness, admission, abandoned-predecessor supersession
 * and the new active registration, decided together as one pure transition.
 * Only a fresh registration — revision 0, no terminal outcome — may install;
 * that refusal precedes admission, so a stale or terminal candidate is never
 * mistaken for an exact replay. A succession in `program` must name the
 * protected predecessor; each narrowed review's Task must still hold its
 * basis and derive the roster it was narrowed from (ADR-0094).
 */
export function installWaveGateRegistration(
  state: TaskGraph,
  registration: ActiveWaveGateRegistration,
  program: WaveGateInstallProgram,
): WaveGateInstallDecision {
  const { taskIds: publishedTaskIds, succession, narrowedReviews: narrowed = [] } = program;
  if (registration.revision !== 0 || registration.terminalOutcome !== null) {
    return canonicalRecord({
      kind: "refused",
      message: "A fresh active Wave Gate registration must start at revision 0 without a terminal outcome",
    });
  }
  const admitted = admitWaveGateRegistration(state, registration, publishedTaskIds);
  switch (admitted.kind) {
    case "refused":
      return admitted;
    case "replay":
      return canonicalRecord({ kind: "replayed", registration: admitted.existing });
    case "install": {
      const problem = (succession === undefined ? null : successionProblem(state, registration.wave, succession)) ??
        narrowingProblem(state, narrowed);
      if (problem !== null) return canonicalRecord({ kind: "refused", message: problem });
      // An abandoned Run is not completion authority. Its review epoch and
      // packet-bound evidence retire with the successor install and it joins
      // the retired runs a later start may succeed (ADR-0091); the reviews it
      // accepted stay, for this start's Successor Carry to judge. Accepted
      // Findings and implementation proof survive. The tombstone is not
      // archived as a completed Wave.
      const successorBase = admitted.predecessor.kind === "abandoned"
        ? supersedeAbandonedWaveGateReview(state, admitted.predecessor.runId, publishedTaskIds)
        : state;
      return canonicalRecord({
        kind: "installed",
        state: { ...successorBase, active_wave_gate: registration },
        registration,
      });
    }
  }
}

/**
 * Retire one Wave review generation as a single aggregate transition.
 *
 * Every authority field invalidated by a replacement gate lives here so
 * restart, orphan recovery and abandoned-run supersession cannot drift through
 * shell-local object spreads. Accepted Findings survive, and packet-bound
 * review evidence is retired, except on the Tasks a restart carries (below):
 * their Review Run keeps its accepted evidence for the replacement to rebind.
 *
 * Retiring the spec-check can remove a Wave's only block cause, and `blocked`
 * is derived, never asserted: it is re-derived here through the writers' own
 * `reconcileWaveBlock`, or the State File boundary refuses the causeless
 * block and no successor gate can install.
 *
 * A restart passes `carriedRunTaskIds`, the Tasks whose accepted slots its
 * carry plan carries (ADR-0089). Their Review Run stays, unfolded, for the
 * replacement to rebind; only the exhausted slots' failure state is cleared.
 */
export function resetWaveGateReviewAuthority(
  graph: TaskGraph,
  taskIds: readonly string[],
  carriedRunTaskIds: ReadonlySet<string> = new Set(),
): TaskGraph {
  const tasks = Object.freeze(graph.tasks.map((task) => {
    if (!taskIds.includes(task.id) || task.review_run === undefined) return task;
    const carried = carriedRunTaskIds.has(task.id);
    return canonicalRecord({
      ...(carried ? task : preserveAcceptedReviewRunFindings(task)),
      review_status: "pending" as const,
      review_generation: task.review_generation,
      review_run: carried ? task.review_run : undefined,
      review_error: undefined,
      review_evidence_failures: undefined,
    });
  }));
  const affectedWaves = new Set([
    ...graph.tasks.filter(({ id }) => taskIds.includes(id)).map(({ wave }) => wave),
    ...(graph.spec_check === undefined ? [] : [graph.spec_check.wave]),
  ]);
  const waveGates = [...affectedWaves]
    .filter((wave) => graph.wave_gates[String(wave)] !== undefined)
    .reduce((gates, wave) => reconcileWaveBlock(gates, tasks, undefined, wave), graph.wave_gates);
  return canonicalRecord({
    ...graph,
    tasks,
    wave_gates: waveGates,
    spec_check: undefined,
    wave_review_epoch: undefined,
    active_wave_gate: undefined,
    active_wave_completion_suite: undefined,
  });
}

/**
 * Retire one Wave's review authority while no live gate owns it, for a caller
 * that changed what that authority judged (a Requirement trace amendment).
 *
 * - An abandoned tombstone is retired exactly as its successor's install
 *   would, except that another Wave's spec-check and block are left alone.
 * - With no gate, whatever review state survives is reset. The residue test
 *   below hand-lists the fields `resetWaveGateReviewAuthority` clears, and each
 *   listed field has a test row. Nothing fails if a field added to the reset is
 *   forgotten here, so such a field needs a clause below and a row there. With
 *   no residue the graph is returned unchanged, so an older Wave's spec-check
 *   is never cleared.
 *
 * A live or legacy-terminal gate is the caller's precondition to refuse; it is
 * an invariant violation here, never silently reset. A caller that has already
 * proven that precondition as a value retires through
 * `retireUnownedWaveReviewAuthority` instead, which cannot throw.
 */
export function retireWaveReviewAuthority(graph: TaskGraph, wave: number): TaskGraph {
  const active = graph.active_wave_gate;
  if (active !== undefined && active.terminalOutcome?.kind !== "terminal-abandoned") {
    throw new Error(`Wave ${wave} review authority belongs to unretired Wave Gate run ${active.runId}`);
  }
  return retireUnownedWaveReviewAuthority(graph, wave, active?.runId ?? null);
}

/**
 * `retireWaveReviewAuthority` for a graph whose `active_wave_gate` is already
 * known to be absent (`abandonedRunId` null) or the terminal-abandoned
 * tombstone of run `abandonedRunId`: the caller proved it (see
 * `reopenableWave`), so nothing is left here to refuse.
 */
export function retireUnownedWaveReviewAuthority(
  graph: TaskGraph,
  wave: number,
  abandonedRunId: string | null,
): TaskGraph {
  const waveTaskIds = graph.tasks.filter((task) => task.wave === wave).map(({ id }) => id);
  const residue = abandonedRunId !== null ||
    graph.wave_review_epoch !== undefined ||
    graph.active_wave_completion_suite !== undefined ||
    graph.spec_check?.wave === wave ||
    graph.tasks.some((task) => task.wave === wave && task.review_run !== undefined);
  if (!residue) return graph;
  return withOtherWaveSpecCheckHeld(graph, wave, (scoped) => abandonedRunId === null
    ? resetWaveGateReviewAuthority(scoped, waveTaskIds)
    : supersedeAbandonedWaveGateReview(scoped, abandonedRunId, waveTaskIds));
}

/**
 * Run `retire` with another Wave's spec-check held aside, then restore it. That
 * check is not this Wave's authority: the reset would clear it and re-derive
 * that Wave's block without it.
 */
function withOtherWaveSpecCheckHeld(
  graph: TaskGraph,
  wave: number,
  retire: (scoped: TaskGraph) => TaskGraph,
): TaskGraph {
  const held = graph.spec_check;
  if (held === undefined || held.wave === wave) return retire(graph);
  const { spec_check: _held, ...scoped } = graph;
  return { ...retire(scoped), spec_check: held };
}

/**
 * A fresh Wave Gate run superseding an operator-abandoned one. Abandonment only
 * stamps a terminal tombstone; the abandoned run's review epoch, spec-check
 * record and packet-bound review state stay behind and contradict any
 * successor (an epoch must belong to the active run). This retires that review
 * authority exactly as restart and orphan recovery do — accepted findings and
 * Review Generations survive — and records the abandoned run in
 * `retired_wave_review_runs`, the protected provenance of a Successor Carry
 * (ADR-0091). The reviews the abandoned run accepted stay: the successor
 * carries each one whose subject is unchanged and reissues the rest, and a
 * reopened Task's acceptance is cleared by its own revalidation. A Requirement
 * trace amendment over the same tombstone retires it identically, through
 * `retireWaveReviewAuthority`.
 */
export function supersedeAbandonedWaveGateReview(
  graph: TaskGraph,
  abandonedRunId: string,
  taskIds: readonly string[],
): TaskGraph {
  const tombstone = graph.active_wave_gate;
  const reset = resetWaveGateReviewAuthority(graph, taskIds);
  return tombstone?.runId === abandonedRunId ? withRetiredRun(reset, tombstone, "abandoned") : reset;
}

/** `graph` with the completed run `completed`, now reopened, recorded for a later start to succeed (ADR-0091). */
export function retireReopenedWaveReview(graph: TaskGraph, completed: RetiringRun): TaskGraph {
  return withRetiredRun(graph, completed, "completed-reopened");
}

declare const WAVE_GATE_ABANDONMENT: unique symbol;

/**
 * The operator's terminal abandonment of one run, as `helper orchestration
 * abandon` recorded it in the Run Directory (`parseRunAbandonment`): an
 * `AbandonmentReason` and a successor that is never the run itself. Minted
 * only by `parseWaveGateAbandonment`, so no caller can stamp a value that
 * breaks either rule; the State File boundary re-proves both on load.
 */
export type WaveGateAbandonment = Readonly<{
  runsRoot: string;
  runId: OrchestrationRunId;
  reason: AbandonmentReason;
  supersededBy: OrchestrationRunId | null;
}> & Readonly<{ [WAVE_GATE_ABANDONMENT]: true }>;

/** Parse an abandonment to stamp: the reason is parsed as an `AbandonmentReason`
 *  and a run that names itself as its successor is refused. */
export function parseWaveGateAbandonment(input: Readonly<{
  runsRoot: string;
  runId: OrchestrationRunId;
  reason: string;
  supersededBy: OrchestrationRunId | null;
}>): DomainResult<WaveGateAbandonment, string> {
  const reason = parseAbandonmentReason(input.reason);
  if (!reason.ok) return reason;
  if (input.supersededBy === input.runId) {
    return Object.freeze({ ok: false, error: `Wave Gate run ${input.runId} cannot supersede itself` });
  }
  const abandonment = canonicalRecord({
    runsRoot: input.runsRoot,
    runId: input.runId,
    reason: reason.value,
    supersededBy: input.supersededBy,
  });
  return Object.freeze({ ok: true, value: abandonment as WaveGateAbandonment });
}

export type AbandonedWaveGateRegistration = Extract<
  ActiveWaveGateRegistration,
  { terminalOutcome: { kind: "terminal-abandoned" } }
>;

/** Why the abandonment did, or did not, change the protected registration. */
export type ActiveWaveGateAbandonmentResult =
  | Readonly<{ kind: "stamped"; registration: AbandonedWaveGateRegistration }>
  | Readonly<{ kind: "replayed"; registration: AbandonedWaveGateRegistration }>
  | Readonly<{
      kind: "not-targeted";
      reason: "registration-absent" | "authority-mismatch" | "terminal-conflict";
    }>;

/**
 * Stamp the operator's terminal abandonment onto the protected registration.
 *
 * The Run Directory marker is immutable; this stamps the SAME terminal
 * decision onto the active registration, so a tombstoned registration stops
 * being active authority and a fresh `start` can supersede it. Only the run the
 * marker names, under the same runs-root, is targeted; an exact repeat is a
 * replay that leaves `state` itself, and any other terminal outcome is a
 * conflict. Terminalizing the gate retires its correlated live-suite authority
 * in the same transition: live suites require a nonterminal active gate.
 */
export function abandonWaveGateRegistration(
  state: TaskGraph,
  abandonment: WaveGateAbandonment,
): Readonly<{ state: TaskGraph; value: ActiveWaveGateAbandonmentResult }> {
  const unchanged = (value: ActiveWaveGateAbandonmentResult) => ({ state, value: Object.freeze(value) });
  const active = state.active_wave_gate;
  if (active === undefined) return unchanged({ kind: "not-targeted", reason: "registration-absent" });
  if (active.runsRoot !== abandonment.runsRoot || active.runId !== abandonment.runId) {
    return unchanged({ kind: "not-targeted", reason: "authority-mismatch" });
  }
  const terminal = active.terminalOutcome;
  if (terminal !== null) {
    return terminal.kind === "terminal-abandoned" &&
        terminal.reason === abandonment.reason && terminal.supersededBy === abandonment.supersededBy
      ? unchanged({ kind: "replayed", registration: Object.freeze({ ...active, terminalOutcome: terminal }) })
      : unchanged({ kind: "not-targeted", reason: "terminal-conflict" });
  }
  const registration = Object.freeze({
    ...active,
    terminalOutcome: Object.freeze({
      kind: "terminal-abandoned" as const,
      reason: abandonment.reason,
      supersededBy: abandonment.supersededBy,
    }),
  });
  return {
    state: { ...state, active_wave_gate: registration, active_wave_completion_suite: undefined },
    value: Object.freeze({ kind: "stamped", registration }),
  };
}
