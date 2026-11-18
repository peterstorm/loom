/**
 * The narrowing record and the Review Basis (ADR-0093) at the State File
 * boundary.
 *
 * - `parseReviewNarrowing` reads back how a Review Run's roster was narrowed,
 *   which the run, its acceptance and the State File boundary all share.
 * - `narrowsRoster` is the one rule for a narrowed roster: a proper,
 *   non-empty, ordered part of the roster it was narrowed from.
 * - `reviewBasisOf` names the accepted review a re-review is judged against,
 *   and `retainedReviewBasis` keeps it when a reopening clears the acceptance.
 *
 * A leaf: findings, the State File boundary, the reopenings and the start's
 * planner read it, and it reads only shapes.
 *
 * Pure: no I/O.
 */
import type { Task } from "../types";
import {
  NARROWING_CHANGE_CLASSES,
  type CurrentAcceptedReviewAuthority,
  type NarrowingChangeClass,
  type ReviewBasisReference,
  type ReviewNarrowing,
} from "./findings-shape";
import { parseOrchestrationRunId } from "./orchestration-contract";
import { isRecord } from "./plain-record";

const SHA256 = /^[0-9a-f]{64}$/;

const exactKeys = (raw: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(raw).length === keys.length && keys.every((key) => Object.hasOwn(raw, key));

/** A non-empty list of distinct non-blank strings, or null: a stored role list (a roster, carried agents, a narrowing's `from`). */
export function parseRoles(raw: unknown): readonly [string, ...string[]] | null {
  if (!Array.isArray(raw) || raw.some((role) => typeof role !== "string" || role.trim() === "")) return null;
  const [first, ...rest] = raw as string[];
  return first === undefined || new Set(raw).size !== raw.length ? null : Object.freeze([first, ...rest]);
}

/** Distinct narrowing change classes in their canonical order, or null. The run, acceptance and registration all read it. */
export function parseNarrowingChange(raw: unknown): readonly [NarrowingChangeClass, ...NarrowingChangeClass[]] | null {
  if (!Array.isArray(raw)) return null;
  const classes = NARROWING_CHANGE_CLASSES.filter((changeClass) => raw.includes(changeClass));
  const [first, ...rest] = classes;
  return first === undefined || classes.length !== raw.length || classes.some((changeClass, index) => raw[index] !== changeClass)
    ? null
    : Object.freeze([first, ...rest]);
}

function parseBasis(raw: unknown): ReviewBasisReference | null {
  if (!isRecord(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!exactKeys(record, ["run_id", "authority_digest", "packet_id", "head_sha"]) || !parseOrchestrationRunId(record.run_id).ok) {
    return null;
  }
  const { authority_digest: authority, packet_id: packet, head_sha: head } = record;
  return typeof authority === "string" && SHA256.test(authority) && typeof packet === "string" && SHA256.test(packet) &&
      typeof head === "string" && SHA256.test(head)
    ? Object.freeze({ run_id: record.run_id as string, authority_digest: authority, packet_id: packet, head_sha: head })
    : null;
}

/** A stored narrowing record, or null when `raw` is not exactly one. */
export function parseReviewNarrowing(raw: unknown): ReviewNarrowing | null {
  if (!isRecord(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (!exactKeys(record, ["from", "change", "basis"])) return null;
  const from = parseRoles(record.from);
  const change = parseNarrowingChange(record.change);
  const basis = parseBasis(record.basis);
  return from === null || change === null || basis === null ? null : Object.freeze({ from, change, basis });
}

/** Whether `roster` is a proper, non-empty, ordered part of `from`, each role once. */
export function narrowsRoster(from: readonly string[], roster: readonly string[]): boolean {
  if (roster.length === 0 || roster.length >= from.length || new Set(roster).size !== roster.length) return false;
  let next = 0;
  for (const role of from) if (role === roster[next]) next += 1;
  return next === roster.length;
}

/** What a Task holds of its accepted reviews. */
type ReviewedTaskState = Pick<Task, "accepted_review_authority" | "review_basis">;

/**
 * The accepted review a re-review of `task` is judged against (its Review
 * Basis): its current-protocol acceptance, otherwise the basis a reopening
 * kept. A legacy acceptance names no reviewer protocol or run and is no basis.
 */
export function reviewBasisOf(task: ReviewedTaskState): CurrentAcceptedReviewAuthority | undefined {
  const accepted = task.accepted_review_authority;
  return accepted?.reviewer_protocol === undefined ? task.review_basis : accepted;
}

/**
 * The `review_basis` a reopening that clears `task`'s acceptance keeps: its
 * Review Basis, or nothing, so a Task that never held one stays byte-identical.
 */
export function retainedReviewBasis(task: ReviewedTaskState): Pick<Task, "review_basis"> {
  const basis = reviewBasisOf(task);
  return basis === undefined ? {} : { review_basis: basis };
}
