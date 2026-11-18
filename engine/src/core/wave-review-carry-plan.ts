/**
 * Reading a registration's issuance plan: its carry plan (ADR-0089, ADR-0091)
 * and its narrowed reviews (ADR-0093). Which entry a Task has, the roster its
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
  type IssuedWaveReviewRoster,
  type WaveReviewRoster,
} from "./agent-catalog-projections";
import type { ReviewNarrowing } from "./findings-shape";
import { canonicalStructuralEquals } from "./orchestration-contract";
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
 * What decides a narrowed roster: the derived roster it was narrowed from and
 * the roles it kept. A registration's `NarrowedTaskReview` and an installed
 * Review Run (`runRosterNarrowing`) both state it.
 */
export type RosterNarrowing = Readonly<{ from: readonly string[]; roster: readonly string[] }>;

/** The narrowed review `registration` froze for `taskId`, if it narrowed one. */
export function registeredNarrowing(registration: WaveReviewNarrowingAudit, taskId: string): NarrowedTaskReview | undefined {
  return registration.narrowedReviews?.find((entry) => entry.taskId === taskId);
}

/** The narrowing an installed Review Run states: its `narrowing.from` and its own roster. */
export function runRosterNarrowing(
  run: Readonly<{ expected_agents: readonly string[]; narrowing?: ReviewNarrowing }>,
): RosterNarrowing | undefined {
  return run.narrowing === undefined ? undefined : Object.freeze({ from: run.narrowing.from, roster: run.expected_agents });
}

/**
 * The roster a Task's Review Run is issued (ADR-0093): `derived` narrowed as
 * `narrowing` states, while `narrowing` was decided from this same derived
 * roster; otherwise `derived` itself. A Task whose derived roster moved since
 * its narrowing was decided is reviewed in full.
 */
export function issuedWaveTaskRoster(derived: WaveReviewRoster, narrowing: RosterNarrowing | undefined): IssuedWaveReviewRoster {
  if (narrowing === undefined || !canonicalStructuralEquals(narrowing.from, derived)) return derived;
  return parseNarrowedWaveReviewRoster(derived, narrowing.roster) ?? derived;
}

/** The Review Run record of a registration's narrowed review, in the State File's spelling. */
export function reviewNarrowingOf(narrowed: NarrowedTaskReview): ReviewNarrowing {
  return Object.freeze({
    from: narrowed.from,
    change: narrowed.change,
    basis: Object.freeze({
      run_id: narrowed.basis.runId,
      authority_digest: narrowed.basis.authorityDigest,
      packet_id: narrowed.basis.packetId,
      head_sha: narrowed.basis.headSha,
    }),
  });
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
