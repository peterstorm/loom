/**
 * Reading a restart's carry plan (ADR-0089): which entry a Task has, and what
 * a replacement run still issues for it. Batch preparation, the locked
 * install, the carried-run rebinding, resume classification and completed-run
 * verification all ask here, so "issued = roster minus carried" has one
 * definition.
 *
 * A leaf below both Wave review authority and the carry rule, so neither has
 * to import the other to read a plan.
 *
 * Pure: no I/O.
 */
import type { WaveReviewCarry, WaveReviewCarryAudit } from "./wave-gate-program";

/** The plan entry of `taskId` in a registration's carry audit, if it carries. */
export function waveReviewCarryOf(carry: WaveReviewCarryAudit | undefined, taskId: string): WaveReviewCarry | undefined {
  return carry?.carried.find((entry) => entry.taskId === taskId);
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

function assertNever(entry: never): never {
  throw new Error(`unknown Wave review carry ${JSON.stringify(entry)}`);
}
