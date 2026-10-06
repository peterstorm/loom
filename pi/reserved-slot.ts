/**
 * The authority a reserved Pi spawn slot carries, and the pure checks that
 * decide whether that authority still matches protected TaskGraph state.
 *
 * The extension stores one flat `ReservedSlotRecord` per spawned item (three
 * nullable role authorities, because the item's role is only known once the
 * admission settles). Settlement never reads that record directly: it parses
 * it once into `ReservedSlot`, a union keyed by role, so a slot carrying two
 * role authorities — or an authority for a role its agent does not play — is
 * refused at the seam instead of being half-read by whichever applier runs.
 */

import { IMPL_AGENTS, REVIEW_SUB_AGENTS } from "../engine/src/core/model-profiles";
import { waveSpecCheckDocumentsMatch } from "../engine/src/core/wave-review-authority";
import type { ImplementationAttemptAuthority } from "../engine/src/core/implementation-completion";
import type {
  TaskGraph,
  WaveReviewEpochAuthority,
  WaveSpecCheckDocumentsAuthority,
  WaveSpecCheckSlotAuthority,
} from "../engine/src/types";

type LoomTask = TaskGraph["tasks"][number];

const SPEC_CHECK_AGENT = "spec-check-invoker";

/** The exact Wave spec-check slot/attempt a spec-check reservation answers for. */
export type PiSpecCheckAttemptAuthority = Readonly<{
  runId: WaveReviewEpochAuthority["runId"];
  wave: number;
  batchEpoch: WaveReviewEpochAuthority["batchEpoch"];
  slotId: WaveSpecCheckSlotAuthority["slot_id"];
  attempt: WaveSpecCheckSlotAuthority["attempted"];
}>;

type PiReviewAttemptAuthorityBase = Readonly<{
  taskId: string;
  agentType: string;
}>;

export type PiReviewAttemptAuthority =
  | Readonly<PiReviewAttemptAuthorityBase & {
      kind: "legacy";
      generation: 0;
      packetId?: never;
      slotId?: never;
      attempted?: never;
    }>
  | Readonly<PiReviewAttemptAuthorityBase & {
      kind: "slot-bound";
      generation: number;
      packetId: string;
      slotId: string;
      attempted: 1 | 2;
    }>;

/**
 * The reservation fields as the extension stores them: every role authority is
 * present, `null` when the slot holds none. There is no third "absent" state.
 */
export type ReservedSlotRecord = Readonly<{
  agentType: string;
  taskId: string | null;
  implementationAuthority: ImplementationAttemptAuthority | null;
  reviewAuthority: PiReviewAttemptAuthority | null;
  specCheckAuthority: PiSpecCheckAttemptAuthority | null;
}>;

type ReservedSlotBase = Readonly<{ agentType: string; taskId: string | null }>;

/**
 * The reserved slot a result answers for, keyed by the one role authority it
 * carries. `legacy` is a reservation with no role authority at all — the
 * compatibility arm each applier treats under its own legacy rule.
 */
export type ReservedSlot =
  | Readonly<ReservedSlotBase & { role: "implementation"; authority: ImplementationAttemptAuthority }>
  | Readonly<ReservedSlotBase & { role: "review"; authority: PiReviewAttemptAuthority }>
  | Readonly<ReservedSlotBase & { role: "spec-check"; authority: PiSpecCheckAttemptAuthority }>
  | Readonly<ReservedSlotBase & { role: "legacy" }>;

export type ReservedSlotParse =
  | Readonly<{ ok: true; value: ReservedSlot }>
  | Readonly<{ ok: false; error: string }>;

/**
 * Parse the stored record into its role arm. Refuses a record that carries
 * more than one role authority, or an authority whose role the reserved agent
 * does not play (an implementation authority on a reviewer, for example).
 */
export function parseReservedSlot(record: ReservedSlotRecord): ReservedSlotParse {
  const base = { agentType: record.agentType, taskId: record.taskId };
  // One row per role authority the record carries: the slot it parses to, and
  // whether the reserved agent plays that role (`playedBy` names the role's
  // agents for the refusal).
  const carried: readonly Readonly<{ slot: ReservedSlot; plays: boolean; playedBy: string }>[] = [
    ...(record.implementationAuthority === null ? [] : [{
      slot: { ...base, role: "implementation" as const, authority: record.implementationAuthority },
      plays: IMPL_AGENTS.has(record.agentType),
      playedBy: "an implementation agent",
    }]),
    ...(record.reviewAuthority === null ? [] : [{
      slot: { ...base, role: "review" as const, authority: record.reviewAuthority },
      plays: REVIEW_SUB_AGENTS.has(record.agentType),
      playedBy: "a reviewer",
    }]),
    ...(record.specCheckAuthority === null ? [] : [{
      slot: { ...base, role: "spec-check" as const, authority: record.specCheckAuthority },
      plays: record.agentType === SPEC_CHECK_AGENT,
      playedBy: SPEC_CHECK_AGENT,
    }]),
  ];
  const refuse = (problem: string): ReservedSlotParse =>
    Object.freeze({ ok: false as const, error: `reserved slot for ${record.agentType} ${problem}` });
  if (carried.length > 1) {
    const roles = carried.map(({ slot }) => slot.role);
    return refuse(`carries ${carried.length} role authorities (${roles.join(", ")}); exactly one is allowed`);
  }
  const [only] = carried;
  if (only === undefined) return Object.freeze({ ok: true as const, value: Object.freeze({ ...base, role: "legacy" as const }) });
  return only.plays
    ? Object.freeze({ ok: true as const, value: Object.freeze(only.slot) })
    : refuse(`carries ${only.slot.role} authority, but the agent is not ${only.playedBy}`);
}

/** The slot's implementation authority, or `null` for every other arm and for no reservation. */
export const implementationAuthorityOf = (slot: ReservedSlot | undefined): ImplementationAttemptAuthority | null =>
  slot?.role === "implementation" ? slot.authority : null;

/** The slot's review authority, or `null` for every other arm and for no reservation. */
export const reviewAuthorityOf = (slot: ReservedSlot | undefined): PiReviewAttemptAuthority | null =>
  slot?.role === "review" ? slot.authority : null;

/** The slot's spec-check authority, or `null` for every other arm and for no reservation. */
export const specCheckAuthorityOf = (slot: ReservedSlot | undefined): PiSpecCheckAttemptAuthority | null =>
  slot?.role === "spec-check" ? slot.authority : null;

// ---------------------------------------------------------------------------
// Review authority
// ---------------------------------------------------------------------------

/**
 * Whether a Task is explicitly legacy: no Review Run, review generation,
 * retained accepted-review authority, or issued Review Packet. Authority
 * minting and validation must share this one predicate.
 */
const isExplicitlyLegacyTask = (task: LoomTask): boolean =>
  task.review_run === undefined &&
  task.review_generation === undefined &&
  task.accepted_review_authority === undefined &&
  (task.issued_review_packets?.length ?? 0) === 0;

function reviewAuthorityForTask(
  task: LoomTask,
  agentType: string,
): PiReviewAttemptAuthority | null {
  const run = task.review_run;
  if (run === undefined) {
    return isExplicitlyLegacyTask(task)
      ? Object.freeze({
          kind: "legacy" as const,
          taskId: task.id,
          agentType,
          generation: 0 as const,
        })
      : null;
  }
  const slot = run.slot_authority?.find((candidate) => candidate.agent === agentType);
  if (slot === undefined) return null;
  return Object.freeze({
    kind: "slot-bound" as const,
    taskId: task.id,
    agentType,
    generation: run.generation,
    packetId: run.packet_id,
    slotId: slot.slot_id,
    attempted: slot.attempted,
  });
}

/** Freeze exact current Task/Review Run authority for a Pi reviewer reservation. */
export function currentPiReviewAuthority(
  state: TaskGraph,
  agentType: string,
  taskId: string,
): PiReviewAttemptAuthority | null {
  const task = state.tasks.find((candidate) => candidate.id === taskId);
  return task === undefined ? null : reviewAuthorityForTask(task, agentType);
}

/** Explain why reviewer evidence cannot mutate this locked Task. */
export function piReviewAuthorityProblem(
  task: LoomTask,
  agentType: string,
  reservedAuthority: PiReviewAttemptAuthority | null,
): string | null {
  if (task.review_run?.reviewer_protocol !== undefined ||
      task.accepted_review_authority?.reviewer_protocol !== undefined) {
    return "requires registered capture and facade resume; legacy settlement refused";
  }
  const currentAuthority = reviewAuthorityForTask(task, agentType);
  if (reservedAuthority === null) {
    return isExplicitlyLegacyTask(task)
      ? null
      : "reviewer has no exact current or retained review-generation authority";
  }
  const sameBase = currentAuthority !== null &&
    currentAuthority.kind === reservedAuthority.kind &&
    currentAuthority.taskId === reservedAuthority.taskId &&
    currentAuthority.agentType === reservedAuthority.agentType &&
    currentAuthority.generation === reservedAuthority.generation;
  const matches = sameBase && currentAuthority !== null &&
    (currentAuthority.kind === "legacy" ||
      (reservedAuthority.kind === "slot-bound" &&
       currentAuthority.packetId === reservedAuthority.packetId &&
       currentAuthority.slotId === reservedAuthority.slotId &&
       currentAuthority.attempted === reservedAuthority.attempted));
  return matches
    ? null
    : "failed reviewer reservation does not match exact current Task/Review Run slot authority";
}

// ---------------------------------------------------------------------------
// Spec-check authority
// ---------------------------------------------------------------------------

/** Freeze the exact current Wave/spec-check capability for a Pi reservation. */
export function currentPiSpecCheckAuthority(state: TaskGraph): PiSpecCheckAttemptAuthority | null {
  const epoch = state.wave_review_epoch;
  const slot = epoch?.specCheckSlotAuthority;
  if (state.current_phase !== "execute" || epoch === undefined || slot === undefined ||
      state.current_wave !== epoch.wave || state.active_wave_gate?.runId !== epoch.runId ||
      state.active_wave_gate.wave !== epoch.wave) return null;
  return Object.freeze({
    runId: epoch.runId,
    wave: epoch.wave,
    batchEpoch: epoch.batchEpoch,
    slotId: slot.slot_id,
    attempt: slot.attempted,
  });
}

export type PiSpecCheckAuthorityDecision =
  | Readonly<{ kind: "accepted"; authority: PiSpecCheckAttemptAuthority }>
  | Readonly<{ kind: "rejected"; problem: string }>;

export function decidePiSpecCheckAuthority(
  state: TaskGraph,
  authority: PiSpecCheckAttemptAuthority | null,
  documents?: WaveSpecCheckDocumentsAuthority,
): PiSpecCheckAuthorityDecision {
  if (authority === null) {
    return { kind: "rejected", problem: "spec-check result has no exact reserved Wave slot/attempt authority" };
  }
  const current = currentPiSpecCheckAuthority(state);
  if (current === null) {
    return { kind: "rejected", problem: "current TaskGraph has no active exact Wave spec-check authority" };
  }
  if (documents !== undefined &&
      (!waveSpecCheckDocumentsMatch(state.wave_review_epoch?.specCheckDocuments, documents) ||
       state.spec_file !== documents.spec.path || state.plan_file !== documents.plan.path)) {
    return { kind: "rejected", problem: "current spec/plan bytes do not match exact Wave spec-check authority" };
  }
  return current.runId === authority.runId && current.wave === authority.wave &&
      current.batchEpoch === authority.batchEpoch && current.slotId === authority.slotId &&
      current.attempt === authority.attempt
    ? { kind: "accepted", authority }
    : {
        kind: "rejected",
        problem: `reserved spec-check authority ${authority.runId}/${authority.wave}/${authority.slotId}/${authority.attempt} ` +
          `does not match current ${current.runId}/${current.wave}/${current.slotId}/${current.attempt}`,
      };
}

/** Explain why a reserved spec-check capability cannot mutate this snapshot. */
export function piSpecCheckAuthorityProblem(
  state: TaskGraph,
  authority: PiSpecCheckAttemptAuthority | null,
): string | null {
  const decision = decidePiSpecCheckAuthority(state, authority);
  return decision.kind === "accepted" ? null : decision.problem;
}
