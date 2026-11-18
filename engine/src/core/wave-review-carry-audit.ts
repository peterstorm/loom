/**
 * The registration boundary of an issuance plan (ADR-0089, ADR-0091,
 * ADR-0093): the parsers that turn a stored restart carry, a fresh start's
 * succession or its narrowed reviews into the typed audit, and the one
 * comparison of two lineage runs.
 *
 * A leaf: the program-registration parser and the carry rule both depend on
 * it, and it depends on neither, so parsing a registration never loads the
 * carry rule.
 *
 * Pure: no I/O.
 */
import { isWaveReviewRunRetirement } from "../types";
import {
  ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS,
  BASE_WAVE_REVIEW_AGENTS,
  parseNarrowedWaveReviewRoster,
  type WaveReviewRoster,
} from "./agent-catalog-projections";
import { parseNarrowingChange, parseRoles } from "./review-narrowing";
import {
  canonicalStructuralEquals,
  isNonEmpty,
  parseArtifactDigest,
  parseOrchestrationRunId,
  type DomainResult,
  type NonEmpty,
} from "./orchestration-contract";
import type {
  AcceptedTaskCarry,
  CarriedReviewAuthority,
  NarrowedTaskReview,
  ReviewBasisAuthority,
  WaveGateSuccessionAudit,
  WaveReviewCarry,
  WaveReviewCarryAudit,
} from "./wave-gate-program";

/** The same run on a lineage: run and authority digest both match. */
export const sameAuthority = (left: CarriedReviewAuthority, right: CarriedReviewAuthority): boolean =>
  left.runId === right.runId && left.authorityDigest === right.authorityDigest;

const exactKeys = (raw: unknown, keys: readonly string[]): raw is Readonly<Record<string, unknown>> =>
  typeof raw === "object" && raw !== null && !Array.isArray(raw) &&
  Object.keys(raw).length === keys.length && keys.every((key) => Object.hasOwn(raw, key));

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
 * Parse a stored carry plan whose entries `admits` accepts. The lineage names
 * distinct runs; every carried Task appears once; an `accepted-task`
 * acceptance is on the lineage; each carried role list is a non-empty set.
 */
function parseCarryAudit<Entry extends WaveReviewCarry>(
  raw: unknown,
  label: string,
  admits: (entry: WaveReviewCarry) => entry is Entry,
): DomainResult<WaveReviewCarryAudit<Entry>, string> {
  const refused = (detail: string): DomainResult<never, string> => ({ ok: false, error: `${label} ${detail}` });
  if (!exactKeys(raw, ["lineage", "carried"]) || !Array.isArray(raw.lineage) || !Array.isArray(raw.carried)) {
    return refused("must contain exactly lineage and carried arrays");
  }
  const runs = allParsed(raw.lineage.map(parseAuthority));
  if (runs === null) return refused("lineage must name at least one exact run and authority digest");
  if (new Set(runs.map(({ runId }) => runId)).size !== runs.length) return refused("lineage repeats a run");
  const entries = allParsed(raw.carried.map((entry) => {
    const parsed = parseCarry(entry, runs);
    return parsed !== null && admits(parsed) ? parsed : null;
  }));
  if (entries === null) return refused("must list at least one well-formed carried Task whose acceptance is on the lineage");
  if (new Set(entries.map(({ taskId }) => taskId)).size !== entries.length) return refused("repeats a carried Task");
  return { ok: true, value: Object.freeze({ lineage: Object.freeze(runs), carried: Object.freeze(entries) }) };
}

const SHA256 = /^[0-9a-f]{64}$/;

/** The derived roster `raw` names exactly, or null. */
function parseDerivedRoster(raw: unknown): WaveReviewRoster | null {
  const rosters: readonly WaveReviewRoster[] = [BASE_WAVE_REVIEW_AGENTS, ARCHITECTURE_LENS_WAVE_REVIEW_AGENTS];
  return rosters.find((roster) => canonicalStructuralEquals(roster, raw)) ?? null;
}

function parseBasisAuthority(raw: unknown): ReviewBasisAuthority | null {
  if (!exactKeys(raw, ["runId", "authorityDigest", "packetId", "headSha"])) return null;
  const authority = parseAuthority({ runId: raw.runId, authorityDigest: raw.authorityDigest });
  return authority !== null && typeof raw.packetId === "string" && SHA256.test(raw.packetId) &&
      typeof raw.headSha === "string" && SHA256.test(raw.headSha)
    ? Object.freeze({ ...authority, packetId: raw.packetId, headSha: raw.headSha })
    : null;
}

function parseNarrowedTaskReview(raw: unknown): NarrowedTaskReview | null {
  if (!exactKeys(raw, ["taskId", "roster", "from", "change", "basis"])) return null;
  const taskId = parseTaskId(raw.taskId);
  const from = parseDerivedRoster(raw.from);
  const roster = parseRoles(raw.roster);
  const change = parseNarrowingChange(raw.change);
  const basis = parseBasisAuthority(raw.basis);
  return taskId === null || from === null || roster === null || change === null || basis === null ||
      parseNarrowedWaveReviewRoster(from, roster) === null
    ? null
    : Object.freeze({ taskId, roster, from, change, basis });
}

/**
 * Parse a registration's stored narrowed reviews (ADR-0093): a non-empty list
 * naming each Task once, each with its derived roster, a proper ordered part
 * of it, its change classes and its basis.
 */
export function parseNarrowedReviews(raw: unknown): DomainResult<NonEmpty<NarrowedTaskReview>, string> {
  const entries = Array.isArray(raw) ? allParsed(raw.map(parseNarrowedTaskReview)) : null;
  if (entries === null) {
    return { ok: false, error: "wave-gate registration narrowedReviews must list at least one well-formed narrowed Task review" };
  }
  return new Set(entries.map(({ taskId }) => taskId)).size === entries.length
    ? { ok: true, value: entries }
    : { ok: false, error: "wave-gate registration narrowedReviews repeats a Task" };
}

/** A restart may carry either kind of entry. */
const anyCarry = (_entry: WaveReviewCarry): _entry is WaveReviewCarry => true;
const acceptedTaskOnly = (entry: WaveReviewCarry): entry is AcceptedTaskCarry => entry.kind === "accepted-task";

/** Parse a restart registration's stored carry plan (ADR-0089). */
export function parseWaveReviewCarryAudit(raw: unknown): DomainResult<WaveReviewCarryAudit, string> {
  return parseCarryAudit(raw, "wave-gate registration restart carry", anyCarry);
}

/**
 * Parse a fresh start's stored succession (ADR-0091): the run it succeeded,
 * how that run ended, and a carry of whole-roster acceptances whose lineage
 * ends with that run.
 */
export function parseWaveGateSuccessionAudit(raw: unknown): DomainResult<WaveGateSuccessionAudit, string> {
  const refused = (detail: string): DomainResult<never, string> => ({ ok: false, error: `wave-gate registration succession ${detail}` });
  if (!exactKeys(raw, ["previousRunId", "previousAuthorityDigest", "kind", "carry"])) {
    return refused("must contain exactly previousRunId, previousAuthorityDigest, kind and carry");
  }
  const previous = parseAuthority({ runId: raw.previousRunId, authorityDigest: raw.previousAuthorityDigest });
  if (previous === null) return refused("must name an exact previous run and authority digest");
  if (!isWaveReviewRunRetirement(raw.kind)) return refused("kind must be abandoned or completed-reopened");
  const carry = parseCarryAudit(raw.carry, "wave-gate registration succession carry", acceptedTaskOnly);
  if (!carry.ok) return carry;
  const last = carry.value.lineage.at(-1);
  if (last === undefined || !sameAuthority(last, previous)) return refused("carry lineage must end with the previous run");
  return { ok: true, value: Object.freeze({
    previousRunId: previous.runId,
    previousAuthorityDigest: previous.authorityDigest,
    kind: raw.kind,
    carry: carry.value,
  }) };
}
