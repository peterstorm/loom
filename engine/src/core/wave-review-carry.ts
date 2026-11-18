/**
 * Carried Review Evidence (ADR-0089, ADR-0091): the one rule for when a Wave
 * Gate run may carry accepted reviews from an earlier run instead of
 * reissuing them, and the transitions that apply it.
 *
 * - `planRestartCarry` decides, once and under the restart lock, what each
 *   reviewed Task carries into the replacement of an exhausted run. The carry
 *   audit is frozen into the replacement's registration (`restart.carry`).
 * - `planSuccessorCarry` decides, at a fresh start, which reviewed Tasks carry
 *   the whole-roster acceptance of the retired run the start succeeds (a
 *   Successor Carry). The audit is frozen into the registration
 *   (`succession.carry`).
 * - Both report why each Task that does not carry is issued in full; the
 *   reasons are the operation's result, never part of the registration.
 * - `publishedRostersOf` reads, from a restart predecessor's journal, the
 *   roster each Task's whole-roster acceptance was issued under.
 * - `rebindCarriedReviewRun` installs a partly accepted Task's Review Run under
 *   the replacement's Review Packet. Each carried slot keeps the identity it was
 *   accepted under and names its origin, and each exhausted agent gets the
 *   replacement's fresh slot.
 * - `waveAcceptanceProblem` is the completion admission: an acceptance comes
 *   from this run, or it was carried along the recorded lineage, and a
 *   succession's predecessor is a protected retired run of its Wave.
 *
 * The registration boundary's parsers live in the leaf `wave-review-carry-audit`.
 *
 * One admissibility rule serves planning and the install. Evidence carries
 * only while nothing it judged has changed: the reviewer protocol descriptor,
 * the Review Generation, the derived roster, the reviewed workspace scope and
 * head, and the Subject Digest of everything else its packets presented. A
 * whole-roster acceptance's seal also binds the Findings it left; carried
 * slots also need the prior-Finding selection their reissued siblings would
 * be issued (ADR-0090), which an advisory disposition can change.
 *
 * Pure: no I/O, no clock, no randomness.
 */
import type { RetiredWaveReviewRun, Task, TaskGraph } from "../types";
import type {
  CurrentReviewRun,
  CurrentReviewRunSlotAuthority,
  IssuedReviewRunSlotAuthority,
  ReviewSlotOrigin,
  SubjectDigest,
} from "./findings-shape";
import {
  canonicalStructuralEquals,
  isNonEmpty,
  type AgentRequestAuthority,
  type DomainResult,
  type NonEmpty,
} from "./orchestration-contract";
import type { ReviewerProtocolDescriptor } from "./reviewer-contract";
import { acceptedSubjectDigest } from "./review-subject";
import { admitReviewedWorkspace, type ReviewedWorkspaceObservation } from "./reviewed-workspace";
import type {
  AcceptedTaskCarry,
  CarriedReviewAuthority,
  RegisteredWaveGateProgram,
  WaveGateSuccessionAudit,
  WaveReviewCarry,
  WaveReviewCarryAudit,
} from "./wave-gate-program";
import {
  derivedWaveTaskReview,
  taskReviewScope,
  waveReviewPriorFindings,
  waveReviewStanding,
  waveTaskSubjectDigest,
} from "./wave-review-authority";
import { sameAuthority } from "./wave-review-carry-audit";
import { issuedRoles, registeredCarry, waveReviewCarryOf, type RegisteredCarry } from "./wave-review-carry-plan";

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
export type CarryDrift =
  | "protocol" | "generation" | "prior-findings" | "roster" | "scope" | "head" | "subject" | "review-status";

/** Why one reviewed Task carries nothing and is issued in full. */
export type NotCarriedReason =
  /** The predecessor registered another reviewer protocol: nothing carries (ADR-0084). */
  | Readonly<{ kind: "predecessor-protocol" }>
  /** A fresh start could not read the registration of the run it succeeds, with why. */
  | Readonly<{ kind: "predecessor-unreadable"; error: string }>
  | Readonly<{ kind: "workspace-unobserved" }>
  /** The observation was refused by the reviewed-workspace core, with its refusal. */
  | Readonly<{ kind: "workspace-rejected"; error: string }>
  | Readonly<{ kind: "roster-not-derivable" }>
  /** No reviewer slot was accepted, and the Task holds no current acceptance. */
  | Readonly<{ kind: "nothing-accepted" }>
  /** Every slot of the run was accepted: a settled run is never outstanding. */
  | Readonly<{ kind: "fully-accepted-run" }>
  /** The Task's review was still collecting evidence when its run ended; a fresh start reissues it. */
  | Readonly<{ kind: "review-unsettled" }>
  /** The acceptance predates the Subject Digest: a fresh start reviews it in full once. */
  | Readonly<{ kind: "legacy-acceptance" }>
  /** The acceptance was recorded by a run outside the unbroken carrying chain. */
  | Readonly<{ kind: "acceptance-off-lineage"; runId: string }>
  | Readonly<{ kind: "drift"; fields: NonEmpty<CarryDrift> }>;

/** One reviewed Task a run did not carry, and why. */
export type TaskNotCarried = Readonly<{ taskId: string; reason: NotCarriedReason }>;

/** A restart's carry decision: the audit it records, and every reviewed Task issued in full with its reason. */
export type RestartCarryPlan = Readonly<{
  carry: WaveReviewCarryAudit | undefined;
  notCarried: readonly TaskNotCarried[];
}>;

/** A fresh start's carry decision: the succession it records (only when something carries), and every Task issued in full. */
export type SuccessorCarryPlan = Readonly<{
  succession: WaveGateSuccessionAudit | undefined;
  notCarried: readonly TaskNotCarried[];
}>;

/** The operator-facing sentence for a not-carried reason. */
export function describeNotCarried(reason: NotCarriedReason): string {
  switch (reason.kind) {
    case "predecessor-protocol": return "its predecessor registered another reviewer protocol";
    case "predecessor-unreadable": return `the registration of the run it succeeds could not be read: ${reason.error}`;
    case "workspace-unobserved": return "its reviewed workspace was not observed";
    case "workspace-rejected": return `its reviewed workspace observation was refused: ${reason.error}`;
    case "roster-not-derivable": return "its review roster cannot be derived";
    case "nothing-accepted": return "none of its reviewer slots was accepted";
    case "fully-accepted-run": return "its Review Run already accepted every slot";
    case "review-unsettled": return "its review was still collecting evidence when its run ended";
    case "legacy-acceptance": return "its acceptance predates the Subject Digest";
    case "acceptance-off-lineage": return `its acceptance from run ${reason.runId} is not on the recorded lineage`;
    case "drift": return `drift in ${reason.fields.join(", ")}`;
    default: return assertNever(reason);
  }
}

function assertNever(value: never): never {
  throw new Error(`unknown carry value ${JSON.stringify(value)}`);
}

/**
 * The terms a carried whole-roster acceptance is judged by: the run's
 * protocol, the Task's derived roster, its bytes and the Subject Digest of
 * everything else its packets present.
 *
 * No prior-Finding selection: a carried Task is issued to no reviewer, so no
 * selection is presented. An advisory disposition recorded after the
 * acceptance (ADR-0090) changes only which advisories a later review would be
 * issued; it changes neither the subject nor the Findings the seal binds, so
 * it never breaks the carry.
 */
export type AcceptanceTerms = Readonly<{
  protocol: ReviewerProtocolDescriptor;
  roster: NonEmpty<string>;
  bytes: ReviewedBytes;
  subject: SubjectDigest;
}>;

/**
 * The terms carried slots are judged by: an acceptance's terms, and the prior
 * Finding ids a fresh issuance over those bytes would select
 * (`waveReviewPriorFindings` on the `fresh` basis, ADR-0090). A run whose
 * priors differ assessed another set than the replacement's reissued slots
 * would be issued.
 */
export type CarryTerms = AcceptanceTerms & Readonly<{ priorFindingIds: readonly string[] }>;

/**
 * How a carry treats an acceptance recorded before the Subject Digest. A
 * restart carries it on the facts ADR-0089 compares: the graph cannot change
 * under a live gate. A succession can be days later, so it reviews it in full.
 */
export type CarryKind = RegisteredCarry["kind"];

const notCarried = (reason: NotCarriedReason): DomainResult<never, NotCarriedReason> => ({ ok: false, error: reason });

/** The facts in `checks` that no longer hold, as a drift reason; null when every one holds. */
function driftOf(checks: readonly (readonly [CarryDrift, boolean])[]): NotCarriedReason | null {
  const fields = checks.flatMap(([field, holds]) => (holds ? [] : [field]));
  return isNonEmpty(fields) ? Object.freeze({ kind: "drift", fields: Object.freeze(fields) }) : null;
}

/** The same roles, whatever their order; a roster names each role once. */
const sameRoles = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && new Set(left).size === left.length && left.every((role) => right.includes(role));

/** The reviewed scope `task` declares now is the one `bytes` hold. */
const bytesCoverTask = (task: Task, bytes: ReviewedBytes): boolean =>
  canonicalStructuralEquals(taskReviewScope(task), bytes.scope);

/**
 * The accepted agents of `run` that may carry, in roster order, or why none
 * may: drift in what the evidence judged, no accepted slot, or every slot
 * accepted (that run has already settled). A run installed before the Subject
 * Digest is judged without it.
 */
function carriableSlots(task: Task, run: CurrentReviewRun, terms: CarryTerms): DomainResult<NonEmpty<string>, NotCarriedReason> {
  const drift = driftOf([
    ["protocol", canonicalStructuralEquals(run.reviewer_protocol, terms.protocol)],
    ["generation", run.generation === (task.review_generation ?? 0)],
    ["prior-findings", canonicalStructuralEquals(run.prior_finding_ids, terms.priorFindingIds)],
    ["roster", canonicalStructuralEquals(run.expected_agents, terms.roster)],
    ["scope", canonicalStructuralEquals(run.workspace_scope, terms.bytes.scope) && bytesCoverTask(task, terms.bytes)],
    ["head", run.workspace_head_sha === terms.bytes.headSha],
    ["subject", run.subject_digest === undefined || run.subject_digest === terms.subject],
  ]);
  if (drift !== null) return notCarried(drift);
  const accepted = run.expected_agents.filter((agent) => run.evidence.some((evidence) => evidence.agent === agent));
  if (!isNonEmpty(accepted)) return notCarried({ kind: "nothing-accepted" });
  return accepted.length < run.expected_agents.length ? { ok: true, value: accepted } : notCarried({ kind: "fully-accepted-run" });
}

/**
 * Whether `task`'s whole-roster acceptance by `acceptance`, issued under
 * `acceptedRoster`, still judges it as it stands; the reason when it does not.
 * The sealed Subject Digest binds what the packets presented together with
 * the Findings the acceptance left (`acceptedSubjectDigest`).
 */
function carriableAcceptance(
  task: Task,
  acceptance: CarriedReviewAuthority,
  acceptedRoster: readonly string[],
  terms: AcceptanceTerms,
  kind: CarryKind,
): DomainResult<true, NotCarriedReason> {
  const accepted = task.accepted_review_authority;
  if (task.review_run !== undefined || accepted?.reviewer_protocol === undefined ||
      accepted.run_id !== acceptance.runId || accepted.authority_digest !== acceptance.authorityDigest) {
    return notCarried({ kind: "nothing-accepted" });
  }
  if (accepted.subject_digest === undefined && kind === "succession") return notCarried({ kind: "legacy-acceptance" });
  const drift = driftOf([
    ["protocol", canonicalStructuralEquals(accepted.reviewer_protocol, terms.protocol)],
    ["generation", accepted.generation === (task.review_generation ?? 0)],
    ["roster", sameRoles(acceptedRoster, terms.roster)],
    ["scope", canonicalStructuralEquals(accepted.scope, terms.bytes.scope) && bytesCoverTask(task, terms.bytes)],
    ["head", accepted.head_sha === terms.bytes.headSha],
    ["subject", accepted.subject_digest === undefined || accepted.subject_digest === acceptedSubjectDigest(terms.subject, task)],
    ["review-status", task.review_status === "passed" || task.review_status === "blocked"],
  ]);
  return drift === null ? { ok: true, value: true } : notCarried(drift);
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

/**
 * Where a carry plan reads its predecessor's own acceptances' rosters: a
 * restart from the predecessor's journal; a succession from the Subject
 * Digest, which already binds the roster the run was issued under.
 */
type CarrySource =
  | Readonly<{ kind: "restart"; issuedRosters: RestartCarryObservation["issuedRosters"] }>
  | Readonly<{ kind: "succession" }>;

/** Everything one carry plan decides against. */
type CarryContext = Readonly<{
  graph: TaskGraph;
  /** The predecessor's registration. */
  previous: RegisteredWaveGateProgram;
  predecessor: CarriedReviewAuthority;
  /** The reviewer protocol the new run registers. */
  protocol: ReviewerProtocolDescriptor;
  workspaces: readonly ReviewedWorkspaceObservation[];
  source: CarrySource;
}>;

/**
 * The roster the run that recorded `acceptance` issued for `taskId`: for the
 * predecessor's own acceptance, the roster its source names; for one the
 * predecessor itself carried, the roster it recorded. A run outside that
 * chain has none.
 */
function acceptedRoster(
  context: CarryContext,
  acceptance: CarriedReviewAuthority,
  taskId: string,
  terms: AcceptanceTerms,
): readonly string[] | undefined {
  if (sameAuthority(acceptance, context.predecessor)) {
    return context.source.kind === "restart" ? context.source.issuedRosters.get(taskId) : terms.roster;
  }
  const entry = waveReviewCarryOf(registeredCarry(context.previous), taskId);
  return entry?.kind === "accepted-task" && sameAuthority(entry.acceptance, acceptance) ? entry.roster : undefined;
}

/**
 * The terms `task` is judged by, why it cannot be judged, or null for a Task
 * that owes no review. The roster and the Subject Digest come from one
 * derivation of the Task's review.
 */
function carryTermsOf(context: CarryContext, task: Task): DomainResult<CarryTerms, NotCarriedReason> | null {
  const { graph, previous, protocol, workspaces } = context;
  if (waveReviewStanding(task).kind === "exempt") return null;
  if (previous.schemaVersion !== 2 || !canonicalStructuralEquals(previous.reviewerProtocol, protocol)) {
    return notCarried({ kind: "predecessor-protocol" });
  }
  const workspace = workspaces.find((candidate) => candidate.taskId === task.id);
  if (workspace === undefined) return notCarried({ kind: "workspace-unobserved" });
  const admitted = admitReviewedWorkspace(task.id, taskReviewScope(task), workspace);
  if (!admitted.ok) return notCarried({ kind: "workspace-rejected", error: admitted.error });
  const review = derivedWaveTaskReview(graph, 2, task);
  if (review.kind !== "roster") return notCarried({ kind: "roster-not-derivable" });
  const bytes: ReviewedBytes = { scope: admitted.value.scope, headSha: admitted.value.headSha };
  return {
    ok: true,
    value: {
      protocol,
      roster: review.roster,
      bytes,
      subject: waveTaskSubjectDigest(graph, task, review, protocol, bytes),
      priorFindingIds: waveReviewPriorFindings(graph, task, admitted.value.artifacts, "fresh").ids,
    },
  };
}

/** `task`'s whole-roster acceptance as a carry entry, or why it does not carry. */
function acceptanceCarry(context: CarryContext, task: Task, terms: AcceptanceTerms): DomainResult<AcceptedTaskCarry, NotCarriedReason> {
  const accepted = task.accepted_review_authority;
  if (accepted?.run_id === undefined) return notCarried({ kind: "nothing-accepted" });
  const acceptance: CarriedReviewAuthority = Object.freeze({ runId: accepted.run_id, authorityDigest: accepted.authority_digest });
  const roster = acceptedRoster(context, acceptance, task.id, terms);
  if (roster === undefined) return notCarried({ kind: "acceptance-off-lineage", runId: acceptance.runId });
  const carriable = carriableAcceptance(task, acceptance, roster, terms, context.source.kind);
  return carriable.ok
    ? { ok: true, value: Object.freeze({ kind: "accepted-task", taskId: task.id, roster: terms.roster, acceptance }) }
    : carriable;
}

/** What one reviewed Task carries into a restart's replacement, or why it carries nothing. */
function restartTaskCarry(context: CarryContext, task: Task): DomainResult<WaveReviewCarry, NotCarriedReason> | null {
  const terms = carryTermsOf(context, task);
  if (terms === null || !terms.ok) return terms;
  const run = task.review_run;
  if (run === undefined) return acceptanceCarry(context, task, terms.value);
  if (run.reviewer_protocol === undefined) return notCarried({ kind: "drift", fields: ["protocol"] });
  const agents = carriableSlots(task, run, terms.value);
  return agents.ok ? { ok: true, value: Object.freeze({ kind: "accepted-slots", taskId: task.id, agents: agents.value }) } : agents;
}

/**
 * What one reviewed Task carries into a fresh start, or why it carries
 * nothing. A succession carries whole-roster acceptances only: a Review Run
 * still collecting evidence retires with its run.
 */
function successorTaskCarry(context: CarryContext, task: Task): DomainResult<AcceptedTaskCarry, NotCarriedReason> | null {
  const terms = carryTermsOf(context, task);
  if (terms === null || !terms.ok) return terms;
  return task.review_run === undefined ? acceptanceCarry(context, task, terms.value) : notCarried({ kind: "review-unsettled" });
}

/** Each Task of `taskIds` the graph holds, with what it carries; Tasks owing no review are left out. */
function decide<Carry>(
  graph: TaskGraph,
  taskIds: readonly string[],
  decideTask: (task: Task) => DomainResult<Carry, NotCarriedReason> | null,
): Readonly<{ carried: readonly Carry[]; notCarried: readonly TaskNotCarried[] }> {
  const decisions = taskIds.flatMap((taskId) => {
    const task = graph.tasks.find((candidate) => candidate.id === taskId);
    const decision = task === undefined ? null : decideTask(task);
    return decision === null ? [] : [{ taskId, decision }];
  });
  return Object.freeze({
    carried: decisions.flatMap(({ decision }) => (decision.ok ? [decision.value] : [])),
    notCarried: Object.freeze(decisions.flatMap(({ taskId, decision }) =>
      (decision.ok ? [] : [Object.freeze({ taskId, reason: decision.error })]))),
  });
}

/**
 * The lineage a carry along `predecessor` records: the predecessor's own
 * lineage when it carried, then the predecessor. A predecessor that carried
 * nothing starts the chain afresh.
 */
function lineageThrough(context: CarryContext): NonEmpty<CarriedReviewAuthority> {
  const predecessorCarry = registeredCarry(context.previous);
  return Object.freeze(predecessorCarry === undefined
    ? [context.predecessor]
    : [...predecessorCarry.audit.lineage, context.predecessor]);
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
 * and why each other reviewed Task is issued in full. The audit is undefined
 * when nothing carries. A predecessor that issued another protocol carries
 * nothing (ADR-0084). The lineage extends the predecessor's own only when the
 * predecessor itself carried, so it lists the unbroken chain of carrying runs
 * that led here, oldest first.
 */
export function planRestartCarry(input: RestartCarryInput): RestartCarryPlan {
  const { graph, previous, previousRunId, protocol, observation } = input;
  const context: CarryContext = {
    graph, previous, protocol, workspaces: observation.workspaces,
    predecessor: Object.freeze({ runId: previousRunId, authorityDigest: previous.authorityDigest }),
    source: { kind: "restart", issuedRosters: observation.issuedRosters },
  };
  const { carried, notCarried: skipped } = decide(graph, previous.taskIds, (task) => restartTaskCarry(context, task));
  if (!isNonEmpty(carried)) return Object.freeze({ carry: undefined, notCarried: skipped });
  return Object.freeze({
    carry: Object.freeze({ lineage: lineageThrough(context), carried: Object.freeze(carried) }),
    notCarried: skipped,
  });
}

export type SuccessorCarryInput = Readonly<{
  graph: TaskGraph;
  /** The fresh start's registered Task IDs. */
  taskIds: readonly string[];
  /** The reviewer protocol the fresh start registers. */
  protocol: ReviewerProtocolDescriptor;
  /** The retired run the start succeeds: the Wave's abandoned tombstone, else its latest retired run. */
  predecessor: RetiredWaveReviewRun;
  /** The predecessor's registration as the shell read it from its Run Directory, or why it could not. */
  previous: DomainResult<RegisteredWaveGateProgram, string>;
  /** Every reviewed registered Task's current reviewed workspace. */
  workspaces: readonly ReviewedWorkspaceObservation[];
}>;

/** The predecessor's registration, proven to be the run the protected record retired. */
function retiredPredecessorRegistration(input: SuccessorCarryInput): DomainResult<RegisteredWaveGateProgram, string> {
  const { previous, predecessor } = input;
  if (!previous.ok) return previous;
  return previous.value.authorityDigest === predecessor.authorityDigest && previous.value.input.wave === predecessor.wave
    ? previous
    : { ok: false, error: `run ${predecessor.runId} registered another Wave authority than the one retired` };
}

/**
 * A Successor Carry (ADR-0091): which reviewed Tasks of a fresh start carry
 * the whole-roster acceptance their unchanged subject still holds, from the
 * retired run the start succeeds or from that run's own lineage, and why each
 * other reviewed Task is issued in full. A Task carries whatever its
 * siblings did. The succession is undefined when nothing carries, so such a
 * start registers exactly as it did before carry existed.
 */
export function planSuccessorCarry(input: SuccessorCarryInput): SuccessorCarryPlan {
  const { graph, taskIds, predecessor, protocol, workspaces } = input;
  const previous = retiredPredecessorRegistration(input);
  if (!previous.ok) {
    const unreadable: NotCarriedReason = Object.freeze({ kind: "predecessor-unreadable", error: previous.error });
    return Object.freeze({
      succession: undefined,
      notCarried: decide(graph, taskIds, (task) => (waveReviewStanding(task).kind === "exempt" ? null : notCarried(unreadable))).notCarried,
    });
  }
  const context: CarryContext = {
    graph, previous: previous.value, protocol, workspaces,
    predecessor: Object.freeze({ runId: predecessor.runId, authorityDigest: predecessor.authorityDigest }),
    source: { kind: "succession" },
  };
  const { carried, notCarried: skipped } = decide(graph, taskIds, (task) => successorTaskCarry(context, task));
  if (!isNonEmpty(carried)) return Object.freeze({ succession: undefined, notCarried: skipped });
  return Object.freeze({
    succession: Object.freeze({
      previousRunId: predecessor.runId,
      previousAuthorityDigest: predecessor.authorityDigest,
      kind: predecessor.retirement,
      carry: Object.freeze({ lineage: lineageThrough(context), carried: Object.freeze(carried) }),
    }),
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
  /** The Subject Digest of the Task as the replacement's packets present it. */
  subject: SubjectDigest;
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
 * agent has no fresh slot. The rebound run keeps a Subject Digest only when
 * the carried run recorded one.
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
    protocol: binding.protocol, roster: binding.roster, bytes: binding.bytes,
    subject: binding.subject, priorFindingIds: binding.priorFindingIds,
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
    ...(run.subject_digest === undefined ? {} : { subject_digest: binding.subject }),
  }) };
}

/**
 * Why an `accepted-task` carry cannot be honoured at install, or null: the
 * Task must still hold exactly the acceptance its plan carried, and that
 * acceptance must still judge it as it stands, under the roster the plan
 * recorded.
 */
export function carriedAcceptanceProblem(
  task: Task,
  carry: AcceptedTaskCarry,
  terms: AcceptanceTerms,
  kind: CarryKind,
): string | null {
  const carriable = carriableAcceptance(task, carry.acceptance, carry.roster, terms, kind);
  return carriable.ok
    ? null
    : `Task ${task.id} cannot keep the acceptance its ${kind} carried from run ${carry.acceptance.runId}: ${describeNotCarried(carriable.error)}`;
}

/**
 * Whether `retired` holds the protected record of the run `succession`
 * succeeds, for `wave`: the provenance every Successor Carry rests on.
 */
function successionIsProtected(
  succession: WaveGateSuccessionAudit,
  wave: number,
  retired: readonly RetiredWaveReviewRun[],
): boolean {
  return retired.some((run) => run.runId === succession.previousRunId && run.wave === wave &&
    run.authorityDigest === succession.previousAuthorityDigest && run.retirement === succession.kind);
}

/**
 * Completion admission of one reviewed Task's acceptance under a current
 * registration, or null when admitted. It comes from run `runId` itself, or
 * from an `accepted-task` carry whose acceptance is on the recorded lineage;
 * a Successor Carry is admitted only while its predecessor is a protected
 * retired run of the registration's exact Wave (`retired`), and never for a
 * registration without one. Generation and protocol must match either way.
 */
export function waveAcceptanceProblem(
  task: Task,
  registration: RegisteredWaveGateProgram,
  runId: string,
  retired: readonly RetiredWaveReviewRun[],
): string | null {
  if (registration.schemaVersion !== 2) return null;
  const accepted = task.accepted_review_authority;
  if (accepted?.reviewer_protocol === undefined || accepted.generation !== (task.review_generation ?? 0) ||
      !canonicalStructuralEquals(accepted.reviewer_protocol, registration.reviewerProtocol)) {
    return `Task ${task.id} holds no accepted review at its generation under the registered protocol`;
  }
  if (accepted.run_id === runId && accepted.authority_digest === registration.authorityDigest) return null;
  const acceptance: CarriedReviewAuthority = { runId: accepted.run_id, authorityDigest: accepted.authority_digest };
  const carry = registeredCarry(registration);
  const entry = waveReviewCarryOf(carry, task.id);
  if (entry?.kind !== "accepted-task" || !sameAuthority(entry.acceptance, acceptance) ||
      carry?.audit.lineage.some((onLineage) => sameAuthority(onLineage, acceptance)) !== true) {
    return `Task ${task.id} acceptance from run ${accepted.run_id} is neither this run's nor carried along its recorded lineage`;
  }
  const { succession, input: { wave } } = registration;
  return succession === undefined || (wave !== null && successionIsProtected(succession, wave, retired))
    ? null
    : `Task ${task.id} acceptance was carried from run ${succession.previousRunId}, which is no protected retired run of its Wave`;
}
