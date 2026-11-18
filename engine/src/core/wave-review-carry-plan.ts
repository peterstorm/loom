/**
 * Reading a registration's carry plan (ADR-0089, ADR-0090): the plan itself,
 * which entry a Task has, and what a run still issues for it. Batch
 * preparation, the locked install, the carried-run rebinding, resume
 * classification, completion admission and completed-run verification all
 * ask here, so "issued = roster minus carried" has one definition.
 *
 * A leaf below both Wave review authority and the carry rule, so neither has
 * to import the other to read a plan.
 *
 * Pure: no I/O.
 */
import {
  waveGateOriginOf,
  type AcceptedTaskCarry,
  type WaveGateOriginAudit,
  type WaveReviewCarry,
  type WaveReviewCarryAudit,
} from "./wave-gate-program";

/**
 * The carry plan a registration froze, with what froze it: a restart's
 * (ADR-0089), which may carry slots, or a fresh start's Successor Carry
 * (ADR-0090), which carries whole-roster acceptances only. The kind decides
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
