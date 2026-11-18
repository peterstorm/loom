/**
 * Carried Review Evidence (ADR-0089): the one rule for when a Wave Gate restart
 * may carry accepted reviewer slots into its replacement run instead of
 * reissuing them, and the transitions that apply it.
 *
 * - `planRestartCarry` decides, once and under the restart lock, what each
 *   reviewed Task carries, and why each Task that does not carry is issued in
 *   full. The carry audit is frozen into the replacement's registration
 *   (`restart.carry`); the not-carried reasons are reported by the restart.
 * - `publishedRostersOf` reads, from the predecessor's journal, the roster each
 *   Task's whole-roster acceptance was issued under.
 * - `rebindCarriedReviewRun` installs a partly accepted Task's Review Run under
 *   the replacement's Review Packet. Each carried slot keeps the identity it was
 *   accepted under and names its origin, and each exhausted agent gets the
 *   replacement's fresh slot.
 * - `waveAcceptanceProblem` is the completion admission: an acceptance comes
 *   from this run, or it was carried along the recorded restart lineage.
 * - `parseWaveReviewCarryAudit` is the registration boundary's parser.
 *
 * One admissibility rule serves the restart and the install. Evidence carries
 * only while nothing it judged has changed: the reviewer protocol descriptor,
 * the Review Generation, the prior Finding IDs, the derived roster and the
 * reviewed workspace scope and head.
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
  type AgentRequestAuthority,
  type DomainResult,
  type NonEmpty,
} from "./orchestration-contract";
import type { ReviewerProtocolDescriptor } from "./reviewer-contract";
import { admitReviewedWorkspace, type ReviewedWorkspaceObservation } from "./reviewed-workspace";
import { issuedPriorFindings } from "./advisory-disposition";
import type {
  CarriedReviewAuthority,
  RegisteredWaveGateProgram,
  WaveReviewCarry,
  WaveReviewCarryAudit,
} from "./wave-gate-program";
import { taskReviewScope, waveReviewStanding, waveTaskReviewRoster } from "./wave-review-authority";
import { issuedRoles, waveReviewCarryOf } from "./wave-review-carry-plan";

/** The reviewed workspace a carry is judged against: its canonical scope and content head. */
export type ReviewedBytes = Readonly<{ scope: readonly string[]; headSha: string }>;

/** What the restart shell observed for the carry decision. */
export type RestartCarryObservation = Readonly<{
  /** Every reviewed registered Task's current reviewed workspace. */
  workspaces: readonly ReviewedWorkspaceObservation[];
  /** The roles the predecessor published at attempt 1 for each Task of its
   *  current batch, in any order: the roster a whole-roster acceptance was
   *  issued under (`publishedRostersOf`). */
  issuedRosters: ReadonlyMap<string, readonly string[]>;
}>;

/** One judged fact that changed since the evidence was accepted. */
export type CarryDrift = "protocol" | "generation" | "prior-findings" | "roster" | "scope" | "head" | "review-status";

/** Why one reviewed Task carries nothing and is issued in full. */
export type NotCarriedReason =
  /** The predecessor registered another reviewer protocol: nothing carries (ADR-0084). */
  | Readonly<{ kind: "predecessor-protocol" }>
  | Readonly<{ kind: "workspace-unobserved" }>
  /** The observation was refused by the reviewed-workspace core, with its refusal. */
  | Readonly<{ kind: "workspace-rejected"; error: string }>
  | Readonly<{ kind: "roster-not-derivable" }>
  /** No reviewer slot was accepted, and the Task holds no current acceptance. */
  | Readonly<{ kind: "nothing-accepted" }>
  /** Every slot of the run was accepted: a settled run is never outstanding. */
  | Readonly<{ kind: "fully-accepted-run" }>
  /** The acceptance was recorded by a run outside the unbroken carrying chain. */
  | Readonly<{ kind: "acceptance-off-lineage"; runId: string }>
  | Readonly<{ kind: "drift"; fields: NonEmpty<CarryDrift> }>;

/** One reviewed Task a restart did not carry, and why. */
export type TaskNotCarried = Readonly<{ taskId: string; reason: NotCarriedReason }>;

/** A restart's carry decision: the audit it records, and every reviewed Task issued in full with its reason. */
export type RestartCarryPlan = Readonly<{
  carry: WaveReviewCarryAudit | undefined;
  notCarried: readonly TaskNotCarried[];
}>;

/** The operator-facing sentence for a not-carried reason. */
export function describeNotCarried(reason: NotCarriedReason): string {
  switch (reason.kind) {
    case "predecessor-protocol": return "its predecessor registered another reviewer protocol";
    case "workspace-unobserved": return "its reviewed workspace was not observed";
    case "workspace-rejected": return `its reviewed workspace observation was refused: ${reason.error}`;
    case "roster-not-derivable": return "its review roster cannot be derived";
    case "nothing-accepted": return "none of its reviewer slots was accepted";
    case "fully-accepted-run": return "its Review Run already accepted every slot";
    case "acceptance-off-lineage": return `its acceptance from run ${reason.runId} is not on the restart lineage`;
    case "drift": return `drift in ${reason.fields.join(", ")}`;
    default: return assertNever(reason);
  }
}

function assertNever(value: never): never {
  throw new Error(`unknown not-carried reason ${JSON.stringify(value)}`);
}

/** The terms a carried acceptance is judged by: the replacement's protocol, the Task's derived roster and its bytes. */
export type AcceptanceTerms = Readonly<{ protocol: ReviewerProtocolDescriptor; roster: readonly string[]; bytes: ReviewedBytes }>;

/**
 * The terms carried slots are judged by: an acceptance's terms, and the prior
 * Finding ids a fresh issuance over those bytes would select
 * (`issuedPriorFindings`, ADR-0090). A run whose priors differ assessed
 * another set than the replacement would issue.
 */
export type CarryTerms = AcceptanceTerms & Readonly<{ priorFindingIds: readonly string[] }>;

const notCarried = (reason: NotCarriedReason): DomainResult<never, NotCarriedReason> => ({ ok: false, error: reason });

/** The facts in `checks` that no longer hold, as a drift reason; null when every one holds. */
function driftOf(checks: readonly (readonly [CarryDrift, boolean])[]): NotCarriedReason | null {
  const fields = checks.flatMap(([field, holds]) => (holds ? [] : [field]));
  return isNonEmpty(fields) ? Object.freeze({ kind: "drift", fields: Object.freeze(fields) }) : null;
}

const sameAuthority = (left: CarriedReviewAuthority, right: CarriedReviewAuthority): boolean =>
  left.runId === right.runId && left.authorityDigest === right.authorityDigest;

/** The same roles, whatever their order; a roster names each role once. */
const sameRoles = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && new Set(left).size === left.length && left.every((role) => right.includes(role));

/** The reviewed scope `task` declares now is the one `bytes` hold. */
const bytesCoverTask = (task: Task, bytes: ReviewedBytes): boolean =>
  canonicalStructuralEquals(taskReviewScope(task), bytes.scope);

/**
 * The accepted agents of `run` that may carry, in roster order, or why none
 * may: drift in what the evidence judged, no accepted slot, or every slot
 * accepted (that run has already settled).
 */
function carriableSlots(task: Task, run: CurrentReviewRun, terms: CarryTerms): DomainResult<NonEmpty<string>, NotCarriedReason> {
  const drift = driftOf([
    ["protocol", canonicalStructuralEquals(run.reviewer_protocol, terms.protocol)],
    ["generation", run.generation === (task.review_generation ?? 0)],
    ["prior-findings", canonicalStructuralEquals(run.prior_finding_ids, terms.priorFindingIds)],
    ["roster", canonicalStructuralEquals(run.expected_agents, terms.roster)],
    ["scope", canonicalStructuralEquals(run.workspace_scope, terms.bytes.scope) && bytesCoverTask(task, terms.bytes)],
    ["head", run.workspace_head_sha === terms.bytes.headSha],
  ]);
  if (drift !== null) return notCarried(drift);
  const accepted = run.expected_agents.filter((agent) => run.evidence.some((evidence) => evidence.agent === agent));
  if (!isNonEmpty(accepted)) return notCarried({ kind: "nothing-accepted" });
  return accepted.length < run.expected_agents.length ? { ok: true, value: accepted } : notCarried({ kind: "fully-accepted-run" });
}

/**
 * Whether `task`'s whole-roster acceptance by `acceptance`, issued under
 * `acceptedRoster`, still judges it as it stands; the reason when it does not.
 */
function carriableAcceptance(
  task: Task,
  acceptance: CarriedReviewAuthority,
  acceptedRoster: readonly string[],
  terms: AcceptanceTerms,
): DomainResult<true, NotCarriedReason> {
  const accepted = task.accepted_review_authority;
  if (task.review_run !== undefined || accepted?.reviewer_protocol === undefined ||
      accepted.run_id !== acceptance.runId || accepted.authority_digest !== acceptance.authorityDigest) {
    return notCarried({ kind: "nothing-accepted" });
  }
  const drift = driftOf([
    ["protocol", canonicalStructuralEquals(accepted.reviewer_protocol, terms.protocol)],
    ["generation", accepted.generation === (task.review_generation ?? 0)],
    ["roster", sameRoles(acceptedRoster, terms.roster)],
    ["scope", canonicalStructuralEquals(accepted.scope, terms.bytes.scope) && bytesCoverTask(task, terms.bytes)],
    ["head", accepted.head_sha === terms.bytes.headSha],
    ["review-status", task.review_status === "passed" || task.review_status === "blocked"],
  ]);
  return drift === null ? { ok: true, value: true } : notCarried(drift);
}

/**
 * The roster the run that recorded `acceptance` issued for `taskId`: the
 * predecessor's own published roster, or the roster the predecessor itself
 * carried for it. A run outside that chain has none.
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

/** One request a predecessor published, with the batch epoch and Task its loaded context names (null when none). */
export type PublishedRequest = Readonly<{
  authority: Readonly<{ program: AgentRequestAuthority["program"]; attempt: 1 | 2; role: string }>;
  batchEpoch: string | null;
  taskId: string | null;
}>;

/**
 * The roles each Task's packets published in a predecessor's current batch,
 * in journal order, read from its already-loaded attempt-1 requests. Only Wave
 * reviewer requests of the current `batchEpoch` count: a retry, the
 * spec-check, another program's request or a stale epoch's packet publishes no
 * roster. A predecessor with no current epoch published none.
 */
export function publishedRostersOf(
  candidates: readonly PublishedRequest[],
  batchEpoch: string | undefined,
): ReadonlyMap<string, readonly string[]> {
  const rosters = new Map<string, readonly string[]>();
  if (batchEpoch === undefined) return rosters;
  for (const { authority, batchEpoch: published, taskId } of candidates) {
    if (authority.program !== "wave-gate" || authority.attempt !== 1 || authority.role === "spec-check-invoker" ||
        published !== batchEpoch || taskId === null) continue;
    rosters.set(taskId, [...(rosters.get(taskId) ?? []), authority.role]);
  }
  return rosters;
}

export type RestartCarryInput = Readonly<{
  graph: TaskGraph;
  previousRunId: string;
  previous: RegisteredWaveGateProgram;
  /** The reviewer protocol the replacement registers. */
  protocol: ReviewerProtocolDescriptor;
  observation: RestartCarryObservation;
}>;

/** What one reviewed Task carries, or why it carries nothing; null for a Task that owes no review. */
function taskCarry(
  input: RestartCarryInput,
  task: Task,
  predecessor: CarriedReviewAuthority,
): DomainResult<WaveReviewCarry, NotCarriedReason> | null {
  const { graph, previous, protocol, observation } = input;
  if (waveReviewStanding(task).kind === "exempt") return null;
  if (previous.schemaVersion !== 2 || !canonicalStructuralEquals(previous.reviewerProtocol, protocol)) {
    return notCarried({ kind: "predecessor-protocol" });
  }
  const workspace = observation.workspaces.find((candidate) => candidate.taskId === task.id);
  if (workspace === undefined) return notCarried({ kind: "workspace-unobserved" });
  const admitted = admitReviewedWorkspace(task.id, taskReviewScope(task), workspace);
  if (!admitted.ok) return notCarried({ kind: "workspace-rejected", error: admitted.error });
  const review = waveTaskReviewRoster(graph, 2, task);
  if (review.kind !== "roster") return notCarried({ kind: "roster-not-derivable" });
  const terms: CarryTerms = {
    protocol,
    roster: review.roster,
    bytes: { scope: admitted.value.scope, headSha: admitted.value.headSha },
    priorFindingIds: issuedPriorFindings(task, graph.advisory_dispositions, admitted.value.artifacts).map(({ id }) => id),
  };
  const run = task.review_run;
  if (run !== undefined) {
    if (run.reviewer_protocol === undefined) return notCarried({ kind: "drift", fields: ["protocol"] });
    const agents = carriableSlots(task, run, terms);
    return agents.ok ? { ok: true, value: Object.freeze({ kind: "accepted-slots", taskId: task.id, agents: agents.value }) } : agents;
  }
  const accepted = task.accepted_review_authority;
  if (accepted?.run_id === undefined) return notCarried({ kind: "nothing-accepted" });
  const acceptance: CarriedReviewAuthority = Object.freeze({ runId: accepted.run_id, authorityDigest: accepted.authority_digest });
  const roster = acceptedRoster(acceptance, task.id, predecessor, previous.restart?.carry, observation.issuedRosters);
  if (roster === undefined) return notCarried({ kind: "acceptance-off-lineage", runId: acceptance.runId });
  const carriable = carriableAcceptance(task, acceptance, roster, terms);
  return carriable.ok
    ? { ok: true, value: Object.freeze({ kind: "accepted-task", taskId: task.id, roster: review.roster, acceptance }) }
    : carriable;
}

/**
 * What each reviewed Task of an exhausted run carries into its replacement,
 * and why each other reviewed Task is issued in full. The audit is undefined
 * when nothing carries. A predecessor that issued another protocol carries
 * nothing (ADR-0084). The lineage extends the predecessor's own only when the
 * predecessor itself carried, so it lists the unbroken chain of carrying
 * restarts that led here, oldest first.
 */
export function planRestartCarry(input: RestartCarryInput): RestartCarryPlan {
  const { graph, previous, previousRunId } = input;
  const predecessor: CarriedReviewAuthority = Object.freeze({ runId: previousRunId, authorityDigest: previous.authorityDigest });
  const decisions = previous.taskIds.flatMap((taskId) => {
    const task = graph.tasks.find((candidate) => candidate.id === taskId);
    const decision = task === undefined ? null : taskCarry(input, task, predecessor);
    return decision === null ? [] : [{ taskId, decision }];
  });
  const carried = decisions.flatMap(({ decision }) => (decision.ok ? [decision.value] : []));
  const skipped = Object.freeze(decisions.flatMap(({ taskId, decision }) =>
    (decision.ok ? [] : [Object.freeze({ taskId, reason: decision.error })])));
  if (!isNonEmpty(carried)) return Object.freeze({ carry: undefined, notCarried: skipped });
  const predecessorCarry = previous.restart?.carry;
  const lineage: NonEmpty<CarriedReviewAuthority> = predecessorCarry === undefined
    ? [predecessor]
    : [...predecessorCarry.lineage, predecessor];
  return Object.freeze({
    carry: Object.freeze({ lineage: Object.freeze(lineage), carried: Object.freeze(carried) }),
    notCarried: skipped,
  });
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
  /** The prior Finding ids a fresh issuance over `bytes` selects (`CarryTerms`). */
  priorFindingIds: readonly string[];
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
  const accepted = carriableSlots(task, run, {
    protocol: binding.protocol, roster: binding.roster, bytes: binding.bytes, priorFindingIds: binding.priorFindingIds,
  });
  if (!accepted.ok) return refuse(`carried review evidence no longer judges it: ${describeNotCarried(accepted.error)}`);
  if (!canonicalStructuralEquals(accepted.value, carry.agents)) {
    return refuse("holds accepted slots other than the ones its restart carried");
  }
  const origin: ReviewSlotOrigin = Object.freeze({
    run_id: run.wave_gate_run_id, authority_digest: run.wave_gate_authority_digest, packet_id: run.packet_id,
  });
  const reissued = issuedRoles(binding.roster, carry);
  const slots: CurrentReviewRunSlotAuthority[] = [];
  for (const agent of binding.roster) {
    const issued = binding.issued.find((slot) => slot.agent === agent);
    if (reissued.includes(agent)) {
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
 * acceptance must still judge it as it stands, under the roster the restart
 * recorded.
 */
export function carriedAcceptanceProblem(
  task: Task,
  carry: Extract<WaveReviewCarry, { kind: "accepted-task" }>,
  terms: AcceptanceTerms,
): string | null {
  const carriable = carriableAcceptance(task, carry.acceptance, carry.roster, terms);
  return carriable.ok
    ? null
    : `Task ${task.id} cannot keep the acceptance its restart carried from run ${carry.acceptance.runId}: ${describeNotCarried(carriable.error)}`;
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
