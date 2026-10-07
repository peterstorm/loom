/**
 * The authority a reserved Pi spawn slot carries, and the pure checks that
 * decide whether that authority still matches protected TaskGraph state.
 *
 * A reservation stores `ReservedSlot`, a union keyed by the one role
 * authority the slot carries. The spawn lifecycle gathers its role claims as
 * `ReservedSlotClaims` (three nullable authorities, because which one a slot
 * holds is only known once admission settles) and parses them HERE, at the
 * producer: a slot carrying two role authorities, an authority for a role its
 * agent does not play, or an implementation authority for another Task is
 * refused before dispatch, where the spawn can still be rolled back — never
 * discovered by an applier after the child has run. `ReservedSlot` carries a
 * module-private brand, so the parse (and the authority-free
 * `legacyReservedSlot`) is the only way to obtain one.
 */

import { IMPL_AGENTS, REVIEW_SUB_AGENTS } from "../engine/src/core/agent-catalog-projections";
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
 * The role claims a spawn lifecycle gathers for one slot before it is
 * reserved: every role authority present, `null` when the slot holds none.
 * Producer input only — never stored; `parseReservedSlot` turns it into the
 * `ReservedSlot` a reservation keeps.
 */
export type ReservedSlotClaims = Readonly<{
  agentType: string;
  taskId: string | null;
  implementationAuthority: ImplementationAttemptAuthority | null;
  reviewAuthority: PiReviewAttemptAuthority | null;
  specCheckAuthority: PiSpecCheckAttemptAuthority | null;
}>;

/**
 * The module-private proof that a slot came from this module's producers.
 * The brand is type-only (no runtime property, so spreading a slot into a
 * reservation item carries it unchanged): because the symbol is never
 * exported, only `parseReservedSlot` and `legacyReservedSlot` can mint a
 * `ReservedSlot`, and an object literal of the right shape no longer
 * type-checks as one — the parse's invariants (one role authority, an agent
 * that plays the role, an implementation authority for the slot's own Task)
 * are guaranteed to every consumer by the compiler, not by convention.
 */
declare const reservedSlotBrand: unique symbol;
type ReservedSlotProof = Readonly<{ [reservedSlotBrand]: true }>;

type ReservedSlotBase = Readonly<{ agentType: string; taskId: string | null }>;

/** An implementation slot names its Task: the authority's own. */
export type ImplementationReservedSlot = ReservedSlotProof &
  Readonly<{ agentType: string; taskId: string; role: "implementation"; authority: ImplementationAttemptAuthority }>;
export type ReviewReservedSlot = ReservedSlotProof &
  Readonly<ReservedSlotBase & { role: "review"; authority: PiReviewAttemptAuthority }>;
export type SpecCheckReservedSlot = ReservedSlotProof &
  Readonly<ReservedSlotBase & { role: "spec-check"; authority: PiSpecCheckAttemptAuthority }>;
/** A reservation with no role authority at all — the compatibility arm each
 *  applier treats under its own legacy rule, and the shape cleanup debt and
 *  durably recovered reservations keep. */
export type LegacyReservedSlot = ReservedSlotProof & Readonly<ReservedSlotBase & { role: "legacy" }>;

/**
 * The reserved slot a result answers for, keyed by the one role authority it
 * carries. Minted only by `parseReservedSlot` / `legacyReservedSlot`.
 */
export type ReservedSlot =
  | ImplementationReservedSlot
  | ReviewReservedSlot
  | SpecCheckReservedSlot
  | LegacyReservedSlot;

export type ReservedSlotParse =
  | Readonly<{ ok: true; value: ReservedSlot }>
  | Readonly<{ ok: false; error: string }>;

/** A slot's fields before this module attaches its proof. */
type UnprovenReservedSlot = ReservedSlot extends infer S
  ? S extends ReservedSlot ? Omit<S, typeof reservedSlotBrand> : never
  : never;

/** The ONE place the proof is attached — reached only from the two producers
 *  below, after their checks. The assertion adds the type-only brand and
 *  nothing else. */
const proveReservedSlot = <S extends UnprovenReservedSlot>(slot: S): S & ReservedSlotProof =>
  Object.freeze(slot) as S & ReservedSlotProof;

/** The authority-free slot: total, because it claims nothing to contradict. */
export const legacyReservedSlot = (agentType: string, taskId: string | null): LegacyReservedSlot =>
  proveReservedSlot({ agentType, taskId, role: "legacy" as const });

/**
 * Parse one slot's claims into its role arm. Refuses claims that carry more
 * than one role authority, an authority whose role the reserved agent does not
 * play (an implementation authority on a reviewer, for example), or an
 * implementation authority for a Task other than the one the slot reserves —
 * in that precedence order.
 */
export function parseReservedSlot(claims: ReservedSlotClaims): ReservedSlotParse {
  const { agentType, taskId, implementationAuthority, reviewAuthority, specCheckAuthority } = claims;
  const refuse = (problem: string): ReservedSlotParse =>
    Object.freeze({ ok: false as const, error: `reserved slot for ${agentType} ${problem}` });
  const accept = (value: ReservedSlot): ReservedSlotParse => Object.freeze({ ok: true as const, value });
  // One row per role authority the claims carry: the role, whether the
  // reserved agent plays it (`playedBy` names the role's agents for the
  // refusal), and the parse of its arm — run only for the one row that
  // survives the count and plays checks.
  const carried: readonly Readonly<{ role: ReservedSlot["role"]; plays: boolean; playedBy: string; parse: () => ReservedSlotParse }>[] = [
    ...(implementationAuthority === null ? [] : [{
      role: "implementation" as const,
      plays: IMPL_AGENTS.has(agentType),
      playedBy: "an implementation agent",
      parse: (): ReservedSlotParse =>
        taskId === implementationAuthority.taskId
          ? accept(proveReservedSlot({
              agentType,
              taskId: implementationAuthority.taskId,
              role: "implementation" as const,
              authority: implementationAuthority,
            }))
          : refuse(`reserves Task ${taskId ?? "missing"}, but its implementation authority is for ${implementationAuthority.taskId}`),
    }]),
    ...(reviewAuthority === null ? [] : [{
      role: "review" as const,
      plays: REVIEW_SUB_AGENTS.has(agentType),
      playedBy: "a reviewer",
      parse: (): ReservedSlotParse =>
        accept(proveReservedSlot({ agentType, taskId, role: "review" as const, authority: reviewAuthority })),
    }]),
    ...(specCheckAuthority === null ? [] : [{
      role: "spec-check" as const,
      plays: agentType === SPEC_CHECK_AGENT,
      playedBy: SPEC_CHECK_AGENT,
      parse: (): ReservedSlotParse =>
        accept(proveReservedSlot({ agentType, taskId, role: "spec-check" as const, authority: specCheckAuthority })),
    }]),
  ];
  if (carried.length > 1) {
    const roles = carried.map(({ role }) => role);
    return refuse(`carries ${carried.length} role authorities (${roles.join(", ")}); exactly one is allowed`);
  }
  const [only] = carried;
  if (only === undefined) return accept(legacyReservedSlot(agentType, taskId));
  return only.plays
    ? only.parse()
    : refuse(`carries ${only.role} authority, but the agent is not ${only.playedBy}`);
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
