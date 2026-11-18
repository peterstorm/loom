/**
 * The narrowing record and the Review Basis (ADR-0093): their shapes, their
 * parsers and the one rule for each.
 *
 * - `parseReviewNarrowing` reads back how a Review Run's roster was narrowed,
 *   which the run, its acceptance and the State File boundary all share;
 *   `narrowingOf` is the one reading of a run's narrowing.
 * - `narrowsRoster` is the one rule for a narrowed roster: a proper,
 *   non-empty, ordered part of the roster it was narrowed from.
 * - `reviewBasisOf` names the accepted review a re-review is judged against,
 *   and `retainedReviewBasis` keeps it when a reopening clears the acceptance.
 * - The basis has two spellings, the registration's (`ReviewBasisAuthority`)
 *   and the State File's (`ReviewBasisReference`); `basisAuthorityOf` and
 *   `basisReferenceOf` are the only conversions, and `holdsBasis` the one
 *   comparison of a Task with a basis.
 *
 * A leaf: findings, the State File boundary, the registration parser, the
 * reopenings and the start's planner read it, and it reads only shapes.
 *
 * Pure: no I/O.
 */
import type { Task } from "../types";
import { isSha256Hex } from "./digest";
import {
  NARROWING_CHANGE_CLASSES,
  type CurrentAcceptedReviewAuthority,
  type NarrowingChangeClass,
  type ReviewBasisReference,
  type ReviewNarrowing,
  type ReviewRun,
} from "./findings-shape";
import { parseOrchestrationRunId } from "./orchestration-contract";
import { isExactRecord } from "./plain-record";

/**
 * The accepted review a narrowed Task's change was measured against, as a
 * registration spells it: its run, authority digest, Review Packet and
 * reviewed workspace head.
 */
export type ReviewBasisAuthority = Readonly<{ runId: string; authorityDigest: string; packetId: string; headSha: string }>;

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

/** The basis's parts once parsed, in either spelling. */
function basisParts(runId: unknown, authorityDigest: unknown, packetId: unknown, headSha: unknown): ReviewBasisAuthority | null {
  return parseOrchestrationRunId(runId).ok && isSha256Hex(authorityDigest) && isSha256Hex(packetId) && isSha256Hex(headSha)
    ? Object.freeze({ runId: runId as string, authorityDigest, packetId, headSha })
    : null;
}

/** A registration's stored basis, or null when `raw` is not exactly one. */
export function parseBasisAuthority(raw: unknown): ReviewBasisAuthority | null {
  return isExactRecord(raw, ["runId", "authorityDigest", "packetId", "headSha"])
    ? basisParts(raw.runId, raw.authorityDigest, raw.packetId, raw.headSha)
    : null;
}

/** A State File's stored basis, or null when `raw` is not exactly one. */
function parseBasisReference(raw: unknown): ReviewBasisReference | null {
  const basis = isExactRecord(raw, ["run_id", "authority_digest", "packet_id", "head_sha"])
    ? basisParts(raw.run_id, raw.authority_digest, raw.packet_id, raw.head_sha)
    : null;
  return basis === null ? null : basisReferenceOf(basis);
}

/** The basis an acceptance names, as a registration spells it. */
export function basisAuthorityOf(accepted: CurrentAcceptedReviewAuthority): ReviewBasisAuthority {
  return Object.freeze({ runId: accepted.run_id, authorityDigest: accepted.authority_digest, packetId: accepted.packet_id, headSha: accepted.head_sha });
}

/** A registration's basis as the State File spells it. */
export function basisReferenceOf(basis: ReviewBasisAuthority): ReviewBasisReference {
  return Object.freeze({ run_id: basis.runId, authority_digest: basis.authorityDigest, packet_id: basis.packetId, head_sha: basis.headSha });
}

/** A stored narrowing record, or null when `raw` is not exactly one. */
export function parseReviewNarrowing(raw: unknown): ReviewNarrowing | null {
  if (!isExactRecord(raw, ["from", "change", "basis"])) return null;
  const from = parseRoles(raw.from);
  const change = parseNarrowingChange(raw.change);
  const basis = parseBasisReference(raw.basis);
  return from === null || change === null || basis === null ? null : Object.freeze({ from, change, basis });
}

/** How a Review Run's roster was narrowed; undefined for a whole roster or a legacy run, which cannot record one. */
export const narrowingOf = (run: ReviewRun): ReviewNarrowing | undefined =>
  run.reviewer_protocol === undefined ? undefined : run.narrowing;

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

/** Whether `basis` is still `task`'s Review Basis. */
export function holdsBasis(task: ReviewedTaskState, basis: ReviewBasisAuthority): boolean {
  const held = reviewBasisOf(task);
  return held !== undefined && held.run_id === basis.runId && held.authority_digest === basis.authorityDigest &&
    held.packet_id === basis.packetId && held.head_sha === basis.headSha;
}

/**
 * The `review_basis` a reopening that clears `task`'s acceptance keeps: its
 * Review Basis, or nothing, so a Task that never held one stays byte-identical.
 */
export function retainedReviewBasis(task: ReviewedTaskState): Pick<Task, "review_basis"> {
  const basis = reviewBasisOf(task);
  return basis === undefined ? {} : { review_basis: basis };
}
