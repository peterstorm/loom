/**
 * Carried Review Evidence (ADR-0088): the one rule for when a Wave Gate restart
 * may carry accepted reviewer slots into its replacement run instead of
 * reissuing them, and the transitions that apply it.
 *
 * - `planRestartCarry` decides, once and under the restart lock, what each
 *   reviewed Task carries. The result is frozen into the replacement's
 *   registration (`restart.carry`).
 * - `rebindCarriedReviewRun` installs a partly accepted Task's Review Run under
 *   the replacement's Review Packet. Each carried slot keeps the identity it was
 *   accepted under and names its origin, and each exhausted agent gets the
 *   replacement's fresh slot.
 * - `waveAcceptanceProblem` is the completion admission: an acceptance comes
 *   from this run, or it was carried along the recorded restart lineage.
 * - `parseWaveReviewCarryAudit` is the registration boundary's parser.
 *
 * One admissibility predicate serves the restart and the install. Evidence
 * carries only while nothing it judged has changed: the reviewer protocol
 * descriptor, the Review Generation, the prior Finding IDs, the derived roster
 * and the reviewed workspace scope and head.
 *
 * Pure: no I/O, no clock, no randomness.
 */
import type { Task, TaskGraph } from "../types";
import type {
  CurrentReviewRun,
  CurrentReviewRunSlotAuthority,
  IssuedReviewRunSlotAuthority,
  ReviewSlotOrigin,
} from "./findings-shape";
import {
  canonicalStructuralEquals,
  isNonEmpty,
  parseArtifactDigest,
  parseOrchestrationRunId,
  type DomainResult,
  type NonEmpty,
} from "./orchestration-contract";
import type { ReviewerProtocolDescriptor } from "./reviewer-contract";
import { admitReviewedWorkspace, type ReviewedWorkspaceObservation } from "./reviewed-workspace";
import type {
  CarriedReviewAuthority,
  RegisteredWaveGateProgram,
  WaveReviewCarry,
  WaveReviewCarryAudit,
} from "./wave-gate-program";
import { taskReviewScope, waveReviewStanding, waveTaskReviewRoster } from "./wave-review-authority";

/** The reviewed workspace a carry is judged against: its canonical scope and content head. */
export type ReviewedBytes = Readonly<{ scope: readonly string[]; headSha: string }>;

/** What the restart shell observed for the carry decision. */
export type RestartCarryObservation = Readonly<{
  /** Every reviewed registered Task's current reviewed workspace. */
  workspaces: readonly ReviewedWorkspaceObservation[];
  /** The roles the predecessor published at attempt 1 for each Task of its
   *  current batch, in any order: the roster a whole-roster acceptance was
   *  issued under. */
  issuedRosters: ReadonlyMap<string, readonly string[]>;
}>;

/** The terms carried evidence is judged by: the replacement's protocol, the Task's derived roster and its bytes. */
type CarryTerms = Readonly<{ protocol: ReviewerProtocolDescriptor; roster: readonly string[]; bytes: ReviewedBytes }>;

const sameAuthority = (left: CarriedReviewAuthority, right: CarriedReviewAuthority): boolean =>
  left.runId === right.runId && left.authorityDigest === right.authorityDigest;

/** The same roles, whatever their order; a roster names each role once. */
const sameRoles = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && new Set(left).size === left.length && left.every((role) => right.includes(role));

/** The reviewed workspace scope `task` declares now is the one `bytes` hold. */
const bytesCoverTask = (task: Task, bytes: ReviewedBytes): boolean =>
  canonicalStructuralEquals(taskReviewScope(task), bytes.scope);

/**
 * The accepted agents of `run` that may carry, in roster order, or null when
 * the run's evidence no longer judges `task` as it stands. A run with no
 * accepted slot carries nothing, and neither does one with every slot
 * accepted: that run has already settled.
 */
function carriableSlots(task: Task, run: CurrentReviewRun, terms: CarryTerms): NonEmpty<string> | null {
  if (!canonicalStructuralEquals(run.reviewer_protocol, terms.protocol) ||
      run.generation !== (task.review_generation ?? 0) ||
      !canonicalStructuralEquals(run.prior_finding_ids, (task.findings ?? []).map(({ id }) => id)) ||
      !canonicalStructuralEquals(run.expected_agents, terms.roster) ||
      !canonicalStructuralEquals(run.workspace_scope, terms.bytes.scope) || !bytesCoverTask(task, terms.bytes) ||
      run.workspace_head_sha !== terms.bytes.headSha) {
    return null;
  }
  const accepted = run.expected_agents.filter((agent) => run.evidence.some((evidence) => evidence.agent === agent));
  return isNonEmpty(accepted) && accepted.length < run.expected_agents.length ? accepted : null;
}

/** Whether `task`'s whole-roster acceptance by `acceptance` still judges it as it stands. */
function carriableAcceptance(
  task: Task,
  acceptance: CarriedReviewAuthority,
  terms: Omit<CarryTerms, "roster">,
): boolean {
  const accepted = task.accepted_review_authority;
  return task.review_run === undefined && accepted?.reviewer_protocol !== undefined &&
    (task.review_status === "passed" || task.review_status === "blocked") &&
    accepted.run_id === acceptance.runId && accepted.authority_digest === acceptance.authorityDigest &&
    canonicalStructuralEquals(accepted.reviewer_protocol, terms.protocol) &&
    accepted.generation === (task.review_generation ?? 0) &&
    canonicalStructuralEquals(accepted.scope, terms.bytes.scope) && bytesCoverTask(task, terms.bytes) &&
    accepted.head_sha === terms.bytes.headSha;
}

/** The plan entry of `taskId` in a registration's carry audit, if it carries. */
export function waveReviewCarryOf(carry: WaveReviewCarryAudit | undefined, taskId: string): WaveReviewCarry | undefined {
  return carry?.carried.find((entry) => entry.taskId === taskId);
}

/**
 * The roster the run that recorded `acceptance` issued for `taskId`: the
 * predecessor's own published roster, or the roster an earlier restart carried
 * for it. A run not on the lineage has none.
 */
function acceptedRoster(
  acceptance: CarriedReviewAuthority,
  taskId: string,
  predecessor: CarriedReviewAuthority,
  predecessorCarry: WaveReviewCarryAudit | undefined,
  issuedRosters: RestartCarryObservation["issuedRosters"],
): readonly string[] | undefined {
  if (sameAuthority(acceptance, predecessor)) return issuedRosters.get(taskId);
  const entry = waveReviewCarryOf(predecessorCarry, taskId);
  return entry?.kind === "accepted-task" && sameAuthority(entry.acceptance, acceptance) ? entry.roster : undefined;
}

export type RestartCarryInput = Readonly<{
  graph: TaskGraph;
  previousRunId: string;
  previous: RegisteredWaveGateProgram;
  /** The reviewer protocol the replacement registers. */
  protocol: ReviewerProtocolDescriptor;
  observation: RestartCarryObservation;
}>;

/**
 * What each reviewed Task of an exhausted run carries into its replacement,
 * or undefined when nothing does. A predecessor that issued another protocol
 * carries nothing (ADR-0084). A Task whose evidence no longer judges it, or
 * whose workspace was not observed, carries nothing and is reset as before.
 */
export function planRestartCarry(input: RestartCarryInput): WaveReviewCarryAudit | undefined {
  const { graph, previous, previousRunId, protocol, observation } = input;
  if (previous.schemaVersion !== 2 || !canonicalStructuralEquals(previous.reviewerProtocol, protocol)) return undefined;
  const predecessor: CarriedReviewAuthority = Object.freeze({ runId: previousRunId, authorityDigest: previous.authorityDigest });
  const predecessorCarry = previous.restart?.carry;
  const carried = previous.taskIds.flatMap((taskId): readonly WaveReviewCarry[] => {
    const task = graph.tasks.find((candidate) => candidate.id === taskId);
    const workspace = observation.workspaces.find((candidate) => candidate.taskId === taskId);
    if (task === undefined || workspace === undefined || waveReviewStanding(task).kind === "exempt") return [];
    const admitted = admitReviewedWorkspace(taskId, taskReviewScope(task), workspace);
    const review = waveTaskReviewRoster(graph, 2, task);
    if (!admitted.ok || review.kind !== "roster") return [];
    const bytes: ReviewedBytes = { scope: admitted.value.scope, headSha: admitted.value.headSha };
    const run = task.review_run;
    if (run !== undefined) {
      const agents = run.reviewer_protocol === undefined ? null : carriableSlots(task, run, { protocol, roster: review.roster, bytes });
      return agents === null ? [] : [Object.freeze({ kind: "accepted-slots" as const, taskId, agents })];
    }
    const accepted = task.accepted_review_authority;
    if (accepted?.run_id === undefined) return [];
    const acceptance: CarriedReviewAuthority = Object.freeze({ runId: accepted.run_id, authorityDigest: accepted.authority_digest });
    const roster = acceptedRoster(acceptance, taskId, predecessor, predecessorCarry, observation.issuedRosters);
    return roster !== undefined && sameRoles(roster, review.roster) &&
        carriableAcceptance(task, acceptance, { protocol, bytes })
      ? [Object.freeze({ kind: "accepted-task" as const, taskId, roster: review.roster, acceptance })]
      : [];
  });
  if (!isNonEmpty(carried)) return undefined;
  const [first, ...rest] = predecessorCarry?.lineage ?? [predecessor];
  const lineage: NonEmpty<CarriedReviewAuthority> = predecessorCarry === undefined ? [first] : [first, ...rest, predecessor];
  return Object.freeze({ lineage: Object.freeze(lineage), carried: Object.freeze(carried) });
}

/** Where the replacement installs a partly accepted Task's Review Run. */
export type CarriedRunBinding = Readonly<{
  runId: string;
  authorityDigest: string;
  protocol: ReviewerProtocolDescriptor;
  generation: number;
  packetId: string;
  headSha: string;
  bytes: ReviewedBytes;
  roster: NonEmpty<string>;
  /** The replacement batch's fresh slots, one per agent the carry does not cover. */
  issued: readonly IssuedReviewRunSlotAuthority[];
}>;

/**
 * The Review Run the replacement installs for a Task carrying `carry`'s
 * slots. Rebound from the predecessor's run, each carried slot keeps its slot,
 * request and context identity and names its origin. Rebound from the run
 * already installed, it reproduces that run exactly, so an install replay is
 * idempotent. Refused when the evidence no longer judges the Task, when a
 * carried slot would name the replacement as its origin, or when a reissued
 * agent has no fresh slot.
 */
export function rebindCarriedReviewRun(
  task: Task,
  carry: Extract<WaveReviewCarry, { kind: "accepted-slots" }>,
  binding: CarriedRunBinding,
): DomainResult<CurrentReviewRun, string> {
  const refuse = (message: string): DomainResult<never, string> => ({ ok: false, error: `Task ${task.id} ${message}` });
  const run = task.review_run;
  if (run?.reviewer_protocol === undefined) return refuse("has no current Review Run to carry");
  const accepted = carriableSlots(task, run, { protocol: binding.protocol, roster: binding.roster, bytes: binding.bytes });
  if (accepted === null || !canonicalStructuralEquals(accepted, carry.agents)) {
    return refuse("carried review evidence no longer judges its reviewed workspace, Review Generation, prior Findings, roster or protocol");
  }
  const origin: ReviewSlotOrigin = Object.freeze({
    run_id: run.wave_gate_run_id, authority_digest: run.wave_gate_authority_digest, packet_id: run.packet_id,
  });
  const slots: CurrentReviewRunSlotAuthority[] = [];
  for (const agent of binding.roster) {
    const issued = binding.issued.find((slot) => slot.agent === agent);
    if (!carry.agents.includes(agent)) {
      if (issued === undefined) return refuse(`reissues ${agent} without a fresh slot`);
      slots.push(issued);
      continue;
    }
    const slot = run.slot_authority.find((candidate) => candidate.agent === agent);
    if (slot === undefined || issued !== undefined) return refuse(`carries ${agent} without exactly one accepted slot`);
    const carried = slot.carried_from === undefined ? Object.freeze({ ...slot, carried_from: origin }) : slot;
    if (carried.carried_from.run_id === binding.runId) return refuse(`cannot carry ${agent} from the run that holds it`);
    slots.push(carried);
  }
  const [first, ...rest] = slots;
  if (first === undefined) return refuse("has an empty roster");
  return { ok: true, value: Object.freeze({
    generation: binding.generation,
    packet_id: binding.packetId,
    head_sha: binding.headSha,
    expected_agents: binding.roster,
    prior_finding_ids: run.prior_finding_ids,
    reviewer_protocol: binding.protocol,
    evidence: run.evidence,
    slot_authority: Object.freeze([first, ...rest] as const),
    workspace_scope: binding.bytes.scope,
    workspace_head_sha: binding.bytes.headSha,
    wave_gate_run_id: binding.runId,
    wave_gate_authority_digest: binding.authorityDigest,
  }) };
}

/**
 * Why an `accepted-task` carry cannot be honoured at install, or null: the
 * Task must still hold exactly the acceptance the restart carried, and that
 * acceptance must still judge its reviewed bytes.
 */
export function carriedAcceptanceProblem(
  task: Task,
  carry: Extract<WaveReviewCarry, { kind: "accepted-task" }>,
  protocol: ReviewerProtocolDescriptor,
  bytes: ReviewedBytes,
): string | null {
  return carriableAcceptance(task, carry.acceptance, { protocol, bytes })
    ? null
    : `Task ${task.id} no longer holds the exact acceptance its restart carried from run ${carry.acceptance.runId}`;
}

/**
 * Completion admission of one reviewed Task's acceptance under a current
 * registration, or null when admitted. It comes from run `runId` itself, or
 * from an `accepted-task` carry whose acceptance is on the recorded restart
 * lineage. Generation and protocol must match either way.
 */
export function waveAcceptanceProblem(task: Task, registration: RegisteredWaveGateProgram, runId: string): string | null {
  if (registration.schemaVersion !== 2) return null;
  const accepted = task.accepted_review_authority;
  if (accepted?.reviewer_protocol === undefined || accepted.generation !== (task.review_generation ?? 0) ||
      !canonicalStructuralEquals(accepted.reviewer_protocol, registration.reviewerProtocol)) {
    return `Task ${task.id} holds no accepted review at its generation under the registered protocol`;
  }
  if (accepted.run_id === runId && accepted.authority_digest === registration.authorityDigest) return null;
  const acceptance: CarriedReviewAuthority = { runId: accepted.run_id, authorityDigest: accepted.authority_digest };
  const carry = registration.restart?.carry;
  const entry = waveReviewCarryOf(carry, task.id);
  return entry?.kind === "accepted-task" && sameAuthority(entry.acceptance, acceptance) &&
      carry?.lineage.some((onLineage) => sameAuthority(onLineage, acceptance)) === true
    ? null
    : `Task ${task.id} acceptance from run ${accepted.run_id} is neither this run's nor carried along its restart lineage`;
}

// ---------------------------------------------------------------------------
// The registration boundary
// ---------------------------------------------------------------------------

const exactKeys = (raw: unknown, keys: readonly string[]): raw is Readonly<Record<string, unknown>> =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw) &&
  Object.keys(raw).length === keys.length && keys.every((key) => Object.hasOwn(raw, key));

/** A non-empty array of distinct non-blank strings. */
function parseRoles(raw: unknown): NonEmpty<string> | null {
  if (!Array.isArray(raw) || raw.some((role) => typeof role !== "string" || role.trim() === "")) return null;
  const roles: readonly string[] = raw;
  return isNonEmpty(roles) && new Set(roles).size === roles.length ? Object.freeze(roles) : null;
}

function parseAuthority(raw: unknown): CarriedReviewAuthority | null {
  if (!exactKeys(raw, ["runId", "authorityDigest"])) return null;
  const runId = parseOrchestrationRunId(raw.runId);
  const digest = parseArtifactDigest(raw.authorityDigest);
  return runId.ok && digest.ok ? Object.freeze({ runId: runId.value, authorityDigest: digest.value }) : null;
}

const parseTaskId = (raw: unknown): string | null => (typeof raw === "string" && raw.trim() !== "" ? raw : null);

function parseCarry(raw: unknown, lineage: readonly CarriedReviewAuthority[]): WaveReviewCarry | null {
  if (exactKeys(raw, ["kind", "taskId", "roster", "acceptance"]) && raw.kind === "accepted-task") {
    const taskId = parseTaskId(raw.taskId);
    const roster = parseRoles(raw.roster);
    const acceptance = parseAuthority(raw.acceptance);
    return taskId !== null && roster !== null && acceptance !== null &&
        lineage.some((onLineage) => sameAuthority(onLineage, acceptance))
      ? Object.freeze({ kind: "accepted-task", taskId, roster, acceptance })
      : null;
  }
  if (exactKeys(raw, ["kind", "taskId", "agents"]) && raw.kind === "accepted-slots") {
    const taskId = parseTaskId(raw.taskId);
    const agents = parseRoles(raw.agents);
    return taskId === null || agents === null ? null : Object.freeze({ kind: "accepted-slots", taskId, agents });
  }
  return null;
}

/** Every entry parsed, as a non-empty list; null when the list is empty or any entry was refused. */
function allParsed<T>(entries: readonly (T | null)[]): NonEmpty<T> | null {
  const parsed = entries.flatMap((entry) => (entry === null ? [] : [entry]));
  return isNonEmpty(parsed) && parsed.length === entries.length ? Object.freeze(parsed) : null;
}

/**
 * Parse a registration's stored carry plan. The lineage names distinct runs;
 * every carried Task appears once; an `accepted-task` acceptance is on the
 * lineage; each carried role list is a non-empty set.
 */
export function parseWaveReviewCarryAudit(raw: unknown): DomainResult<WaveReviewCarryAudit, string> {
  const refused = (detail: string): DomainResult<never, string> =>
    ({ ok: false, error: `wave-gate registration restart carry ${detail}` });
  if (!exactKeys(raw, ["lineage", "carried"]) || !Array.isArray(raw.lineage) || !Array.isArray(raw.carried)) {
    return refused("must contain exactly lineage and carried arrays");
  }
  const runs = allParsed(raw.lineage.map(parseAuthority));
  if (runs === null) return refused("lineage must name at least one exact run and authority digest");
  if (new Set(runs.map(({ runId }) => runId)).size !== runs.length) return refused("lineage repeats a run");
  const entries = allParsed(raw.carried.map((entry) => parseCarry(entry, runs)));
  if (entries === null) return refused("must list at least one well-formed carried Task whose acceptance is on the lineage");
  if (new Set(entries.map(({ taskId }) => taskId)).size !== entries.length) return refused("repeats a carried Task");
  return { ok: true, value: Object.freeze({ lineage: Object.freeze(runs), carried: Object.freeze(entries) }) };
}
