/**
 * Pure decisions of one explicit standalone predecessor walk.
 *
 * The shell (`handlers/helpers/programs/standalone-source.ts`) opens Run
 * Directories and gathers bytes; every rule about the walk is decided here:
 * the 64-Run/cycle bound, the carried 64 MiB observed-byte budget, the exact
 * issued attempt roster each predecessor role must show, the retained-context
 * labels, the predecessor frozen-source projection, and the anchored Run
 * authority a source must still name after all of its reads.
 *
 * The traversal is an immutable value: each step returns the next traversal,
 * and a finished child walk hands its remaining budget back to its parent.
 */
import { canonicalStructuralEquals, type DomainResult, type NonEmpty } from "./orchestration-contract";
import type { StandalonePreviousSnapshot } from "./standalone-lineage-contract";
import type { PredecessorArchivePurpose, PredecessorArchiveRecord } from "./predecessor-archive";

export const PREDECESSOR_TRAVERSAL_LIMITS = Object.freeze({ runs: 64, bytes: 64 * 1024 * 1024 });

/** Run Directories already entered on this walk, and the bytes it may still observe. */
export type PredecessorTraversal = Readonly<{ visited: readonly string[]; remaining: number }>;

/** A walk that has entered `visited`; its budget never exceeds the carried 64 MiB control. */
export function predecessorTraversal(visited: readonly string[] = [],
  remaining: number = PREDECESSOR_TRAVERSAL_LIMITS.bytes): PredecessorTraversal {
  return Object.freeze({ visited: Object.freeze([...visited]),
    remaining: Math.max(0, Math.min(remaining, PREDECESSOR_TRAVERSAL_LIMITS.bytes)) });
}

/** Enter one more predecessor Run: refused on a cycle or past the 64-Run bound. */
export function enterPredecessorRun(traversal: PredecessorTraversal, runDirectory: string): DomainResult<PredecessorTraversal, string> {
  if (traversal.visited.length >= PREDECESSOR_TRAVERSAL_LIMITS.runs || traversal.visited.includes(runDirectory)) {
    return { ok: false, error: `predecessor traversal is cyclic or exceeds ${PREDECESSOR_TRAVERSAL_LIMITS.runs} Runs` };
  }
  return { ok: true, value: predecessorTraversal([...traversal.visited, runDirectory], traversal.remaining) };
}

/** The largest single read the walk can still afford under a per-read cap. */
export function predecessorReadBound(traversal: PredecessorTraversal, cap: number): number {
  return Math.min(cap, traversal.remaining);
}

/** Charge observed bytes to the walk; `subject` names what would overrun it. */
export function chargePredecessorBytes(traversal: PredecessorTraversal, observed: number,
  subject: string): DomainResult<PredecessorTraversal, string> {
  return Number.isSafeInteger(observed) && observed >= 0 && observed <= traversal.remaining
    ? { ok: true, value: predecessorTraversal(traversal.visited, traversal.remaining - observed) }
    : { ok: false, error: `${subject} exceeds the traversal byte budget` };
}

/** A finished child walk returns its remaining budget; the parent keeps its own visited chain. */
export function resumeAfterChildWalk(parent: PredecessorTraversal, child: PredecessorTraversal): PredecessorTraversal {
  return predecessorTraversal(parent.visited, Math.min(parent.remaining, child.remaining));
}

/** The issued-request fields the roster rule reads. */
export type PredecessorIssuedRequest = Readonly<{ program: string; role: string; attempt: number }>;
export type PredecessorRoleAttempts<R> = Readonly<{ role: string; attempts: NonEmpty<R> }>;

/**
 * Every predecessor reviewer role must show exactly attempt 1, or attempts 1
 * and 2, of issued standalone-review requests — never invented, never gapped.
 */
export function predecessorAttemptRoster<R extends PredecessorIssuedRequest>(requests: readonly R[],
  roles: readonly string[]): DomainResult<readonly PredecessorRoleAttempts<R>[], string> {
  const roster: PredecessorRoleAttempts<R>[] = [];
  for (const role of roles) {
    const candidates = requests.filter(request => request.program === "standalone-review" && request.role === role)
      .sort((left, right) => left.attempt - right.attempt);
    const [first, ...rest] = candidates;
    if (first === undefined || first.attempt !== 1 || rest.length > 1 || (rest.length === 1 && rest[0]!.attempt !== 2)) {
      return { ok: false, error: "predecessor context requires exact issued attempt roster" };
    }
    const attempts: NonEmpty<R> = Object.freeze([first, ...rest] as const);
    roster.push(Object.freeze({ role, attempts }));
  }
  return { ok: true, value: Object.freeze(roster) };
}

/** The retained-context section label of one issued predecessor attempt. */
export function predecessorContextLabel(role: string, attempt: number): string {
  return `predecessor-context:${role}${attempt === 2 ? ":attempt-2" : ""}`;
}

/**
 * The `predecessor-frozen-source` text. An inline gzip archive (earlier
 * issuance) carries its source in the packet itself: the exact frozen-source
 * section when there is one, else an honest historical-unknown snapshot. A
 * published reference tells the reader how to reach the original source.
 */
export function predecessorFrozenSourceText(record: PredecessorArchiveRecord, frozenSources: readonly Uint8Array[],
  snapshot: StandalonePreviousSnapshot, label: string, purpose: PredecessorArchivePurpose): string {
  if (record.encoding === "gzip-base64") {
    return frozenSources.length === 1 ? Buffer.from(frozenSources[0]!).toString("utf8")
      : JSON.stringify({ kind: "historical-unknown", snapshot });
  }
  return JSON.stringify({ kind: "published-source-reference", snapshot, archive: label, purpose,
    usage: "Use --archive with this label and --archive-purpose, then --file EXACT_PATH to read original source." });
}

/** The exact `authority.json` a source Run must still name after all of its receipt/context reads. */
export function admitAnchoredRunAuthority(observed: unknown,
  anchored: Readonly<{ runId: string; runsRoot: string; runDirectory: string }>): DomainResult<true, string> {
  return canonicalStructuralEquals(observed, { schemaVersion: 1, runId: anchored.runId,
    runsRoot: anchored.runsRoot, runDirectory: anchored.runDirectory })
    ? { ok: true, value: true } : { ok: false, error: "source Run authority changed during authentication" };
}
