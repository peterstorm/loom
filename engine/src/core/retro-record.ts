/**
 * Retro records (ADR-0083, loom#200): the audit that a retrospective was
 * written, or deliberately skipped, for a Wave or for the whole run. A run
 * completes only once it has a run-scope record (`judgeOrchestrationCompletion`).
 *
 * This leaf is the one home of a record's invariants: `helper record-retro`
 * and the State File parser both build one through `retroRecordEntry`, so
 * neither can hold a value the other would refuse.
 *
 * Pure.
 */

import type { DomainResult } from "./orchestration-contract";
import { parsePlanEditReason } from "./wave-plan-edit";
import { parseReviewPath } from "./review-packet";
import type { RetroRecord, RetroScope } from "../types";

const freeze = Object.freeze;
const fail = (error: string) => freeze({ ok: false as const, error });
const SHA256 = /^[0-9a-f]{64}$/;

/** Where retro documents live, relative to the repository root. */
export const RETRO_DIRECTORY = ".claude/retros";

export type RetroRecordInput =
  | Readonly<{ kind: "retro-recorded"; scope: RetroScope; path: string; digest: string }>
  | Readonly<{ kind: "retro-skipped"; reason: string }>;

/** A scope: the whole run, or one Wave of at least 1. */
function parseScope(scope: RetroScope): DomainResult<RetroScope, string> {
  if (scope.kind === "run") return freeze({ ok: true as const, value: freeze({ kind: "run" as const }) });
  return Number.isSafeInteger(scope.wave) && scope.wave >= 1
    ? freeze({ ok: true as const, value: freeze({ kind: "wave" as const, wave: scope.wave }) })
    : fail("scope.wave must be an integer >= 1");
}

/** A retro document's repository-relative path: a review path to a Markdown file under `RETRO_DIRECTORY`. */
export function parseRetroPath(raw: string): DomainResult<string, string> {
  const path = parseReviewPath(raw, "path");
  if (!path.ok) return fail(path.errors.join("; "));
  return path.value.startsWith(`${RETRO_DIRECTORY}/`) && path.value.endsWith(".md")
    ? freeze({ ok: true as const, value: path.value })
    : fail(`path must be a Markdown file under ${RETRO_DIRECTORY}/`);
}

/**
 * A retro record, or why it is not one. A written retro names a review path
 * under `RETRO_DIRECTORY` ending in `.md` and the sha256 of its bytes. A skip
 * covers the whole run and gives a reason `parsePlanEditReason` admits.
 */
export function retroRecordEntry(input: RetroRecordInput): DomainResult<RetroRecord, string> {
  if (input.kind === "retro-skipped") {
    const reason = parsePlanEditReason(input.reason);
    if (!reason.ok) return fail(`reason ${reason.error}`);
    return freeze({
      ok: true as const,
      value: freeze({ schemaVersion: 1 as const, kind: "retro-skipped" as const, scope: freeze({ kind: "run" as const }), reason: reason.value }),
    });
  }
  const scope = parseScope(input.scope);
  if (!scope.ok) return scope;
  const path = parseRetroPath(input.path);
  if (!path.ok) return path;
  if (!SHA256.test(input.digest)) return fail("digest must be a lowercase sha256 hex digest");
  return freeze({
    ok: true as const,
    value: freeze({ schemaVersion: 1 as const, kind: "retro-recorded" as const, scope: scope.value, path: path.value, digest: input.digest }),
  });
}

/** Whether the records cover the whole run: a run-scope retro, written or skipped. */
export const runRetroRecorded = (records: readonly RetroRecord[] | undefined): boolean =>
  (records ?? []).some(({ scope }) => scope.kind === "run");

/** Whether `records` already holds an entry equal to `entry`. */
export const retroRecordPresent = (records: readonly RetroRecord[] | undefined, entry: RetroRecord): boolean =>
  (records ?? []).some((record) => JSON.stringify(record) === JSON.stringify(entry));
