/**
 * The registration boundary of a carry plan (ADR-0089, ADR-0091): the parsers
 * that turn a stored restart carry or a fresh start's succession into the
 * typed audit, and the one comparison of two lineage runs.
 *
 * A leaf: the program-registration parser and the carry rule both depend on
 * it, and it depends on neither, so parsing a registration never loads the
 * carry rule.
 *
 * Pure: no I/O.
 */
import { isWaveReviewRunRetirement } from "../types";
import {
  isNonEmpty,
  parseArtifactDigest,
  parseOrchestrationRunId,
  type DomainResult,
  type NonEmpty,
} from "./orchestration-contract";
import type {
  AcceptedTaskCarry,
  CarriedReviewAuthority,
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

/** A non-empty array of distinct non-blank strings. */
function parseRoles(raw: unknown): NonEmpty<string> | null {
  if (!Array.isArray(raw) || raw.some((role) => typeof role !== "string" || role.trim() === "")) return null;
  const roles: readonly string[] = raw;
  return isNonEmpty(roles) && new Set(roles).size === roles.length ? Object.freeze(roles) : null;
}

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
