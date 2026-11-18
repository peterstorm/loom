/**
 * Reading a registration's issuance plan: its carry plan (ADR-0089, ADR-0091)
 * and its narrowed reviews (ADR-0094). Which entry a Task has, the roster its
 * Review Run is issued, and what a run still issues for it. Batch
 * preparation, the locked install, the carried-run rebinding, resume
 * classification, retries, slot membership, completion admission and
 * completed-run verification all ask here, so "issued = derived roster,
 * narrowed, minus carried" has one definition.
 *
 * A leaf below both Wave review authority and the carry rule, so neither has
 * to import the other to read a plan.
 *
 * Pure: no I/O.
 */
import {
  parseNarrowedWaveReviewRoster,
  type NarrowedWaveReviewRoster,
  type WaveReviewRoster,
} from "./agent-catalog-projections";
import type { ReviewNarrowing, ReviewRun } from "./findings-shape";
import { canonicalStructuralEquals } from "./orchestration-contract";
import { basisReferenceOf, narrowingOf } from "./review-narrowing";
import {
  waveGateOriginOf,
  type AcceptedTaskCarry,
  type NarrowedTaskReview,
  type WaveGateOriginAudit,
  type WaveReviewCarry,
  type WaveReviewCarryAudit,
  type WaveReviewNarrowingAudit,
} from "./wave-gate-program";

/**
 * How a Task's Review Run is to be issued, as its registration or its
 * installed run states it (ADR-0094): its whole derived roster, or narrowed to
 * `roster`, decided from the derived roster `narrowing.from`.
 */
export type TaskIssuance =
  | Readonly<{ kind: "whole" }>
  | Readonly<{ kind: "narrowed"; roster: readonly string[]; narrowing: ReviewNarrowing }>;

/** The issuance of a Task its registration did not narrow: its whole derived roster. */
export const WHOLE_ISSUANCE: TaskIssuance = Object.freeze({ kind: "whole" });

/** How `registration` issues `taskId`: as its narrowed review states, else whole. */
export function registeredIssuance(registration: WaveReviewNarrowingAudit, taskId: string): TaskIssuance {
  const narrowed = registration.narrowedReviews?.find((entry) => entry.taskId === taskId);
  return narrowed === undefined
    ? WHOLE_ISSUANCE
    : Object.freeze({ kind: "narrowed", roster: narrowed.roster, narrowing: reviewNarrowingOf(narrowed) });
}

/** How an installed Review Run says it was issued: its recorded narrowing over its own roster, else whole. */
export function runIssuance(run: ReviewRun): TaskIssuance {
  const narrowing = narrowingOf(run);
  return narrowing === undefined ? WHOLE_ISSUANCE : Object.freeze({ kind: "narrowed", roster: run.expected_agents, narrowing });
}

/**
 * The review a Task's Review Run is issued (ADR-0094), tagged:
 * - `whole`: its whole derived roster;
 * - `narrowed`: the narrowed roster its issuance states, with its narrowing;
 * - `widened`: its issuance named a narrowing that no longer fits the derived
 *   roster (decided from another derived roster, or not a proper part of it),
 *   so it is issued the whole roster. Callers report this; it is never silent.
 */
export type IssuedTaskReview =
  | Readonly<{ kind: "whole"; roster: WaveReviewRoster }>
  | Readonly<{ kind: "narrowed"; roster: NarrowedWaveReviewRoster; narrowing: ReviewNarrowing }>
  | Readonly<{ kind: "widened"; roster: WaveReviewRoster; narrowing: ReviewNarrowing }>;

/** The one issued-review accessor: what `issuance` makes of a Task whose derived roster is `derived`. */
export function issuedTaskReview(derived: WaveReviewRoster, issuance: TaskIssuance): IssuedTaskReview {
  if (issuance.kind === "whole") return Object.freeze({ kind: "whole", roster: derived });
  const roster = canonicalStructuralEquals(issuance.narrowing.from, derived)
    ? parseNarrowedWaveReviewRoster(derived, issuance.roster)
    : null;
  return roster === null
    ? Object.freeze({ kind: "widened", roster: derived, narrowing: issuance.narrowing })
    : Object.freeze({ kind: "narrowed", roster, narrowing: issuance.narrowing });
}

/** The Review Run record of a registration's narrowed review, in the State File's spelling. */
export function reviewNarrowingOf(narrowed: NarrowedTaskReview): ReviewNarrowing {
  return Object.freeze({ from: narrowed.from, change: narrowed.change, basis: basisReferenceOf(narrowed.basis) });
}

/**
 * The carry plan a registration froze, with what froze it: a restart's
 * (ADR-0089), which may carry slots, or a fresh start's Successor Carry
 * (ADR-0091), which carries whole-roster acceptances only. The kind decides
 * how a carried acceptance recorded before the Subject Digest is judged.
 */
export type RegisteredCarry =
  | Readonly<{ kind: "restart"; audit: WaveReviewCarryAudit }>
  | Readonly<{ kind: "succession"; audit: WaveReviewCarryAudit<AcceptedTaskCarry> }>;

/**
 * The carry a registration froze, or undefined when it carries nothing. Every
 * reader of a registration's carry asks here.
 */
export function registeredCarry(registration: WaveGateOriginAudit): RegisteredCarry | undefined {
  const origin = waveGateOriginOf(registration);
  switch (origin.kind) {
    case "restart":
      return origin.audit.carry === undefined ? undefined : Object.freeze({ kind: "restart", audit: origin.audit.carry });
    case "succession":
      return Object.freeze({ kind: "succession", audit: origin.audit.carry });
    case "fresh":
    case "orphan-recovery":
      return undefined;
    default:
      return assertNever(origin);
  }
}

/** The plan entry of `taskId` in a registration's carry, if it carries. */
export function waveReviewCarryOf(carry: RegisteredCarry | undefined, taskId: string): WaveReviewCarry | undefined {
  return carry?.audit.carried.find((entry) => entry.taskId === taskId);
}

/**
 * The roles of `roster` a replacement issues for a Task whose plan entry is
 * `entry`, in roster order: every role when nothing carries, none when the
 * whole roster carries, and otherwise the roles whose slots did not carry.
 */
export function issuedRoles<Role extends string>(roster: readonly Role[], entry: WaveReviewCarry | undefined): readonly Role[] {
  if (entry === undefined) return roster;
  switch (entry.kind) {
    case "accepted-task":
      return [];
    case "accepted-slots":
      return roster.filter((role) => !entry.agents.includes(role));
    default:
      return assertNever(entry);
  }
}

function assertNever(value: never): never {
  throw new Error(`unknown Wave review carry value ${JSON.stringify(value)}`);
}
