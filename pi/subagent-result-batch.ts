/**
 * One Pi harness result batch, parsed per element, and the diagnostics that
 * describe a failed or silent result.
 *
 * Pure by construction: no state, no filesystem, no stderr. Settlement of a
 * parsed result lives in `subagent-settlement.ts` (decisions) and
 * `subagent-result.ts` (the locked shell); this module only answers "what did
 * the harness hand back, and what does its failure look like?".
 */

import { isRecord } from "../engine/src/core/plain-record";

/** One Pi subagent result, in the shape the appliers actually read. */
export type PiSubagentResult = Readonly<{
  agent: string;
  task: string;
  exitCode: number;
  stopReason?: string;
  /** Harness-supplied cause line; absent on pi versions that do not emit it. */
  errorMessage?: unknown;
  messages: unknown;
}>;

/**
 * One element of the harness's `details.results`, parsed rather than asserted.
 *
 * The batch was only ever checked with `Array.isArray` before being cast to
 * `PiSubagentResult[]`, so the required `agent`/`task`/`exitCode` fields were a
 * compile-time promise nothing established: a pi version that renamed or
 * dropped one of them reached `stripNamespace(result.agent)` typed as a
 * guaranteed string. That is the same per-element drift the array-level guard
 * one layer up already treats as a loud no-op, and it gets the same treatment
 * here.
 *
 * A rejected element keeps its INDEX rather than being filtered out: results
 * are positionally bound to reserved slots, so dropping one would silently
 * re-point every later result at the wrong slot.
 */
export type PiSubagentResultEntry =
  | Readonly<{ ok: true; result: PiSubagentResult }>
  | Readonly<{ ok: false; problem: string }>;

/**
 * The problem with an optional string field, or `null` when there is none.
 *
 * `null` therefore covers BOTH acceptable states — the field is absent (pi
 * versions differ on `stopReason`) and the field is a string. A non-null return
 * is the offending type name, for the caller's rejection message.
 */
const optionalString = (value: unknown): string | null =>
  value === undefined || typeof value === "string" ? null : `${typeof value}`;

export function parsePiSubagentResults(raw: readonly unknown[]): readonly PiSubagentResultEntry[] {
  return raw.map((entry, index): PiSubagentResultEntry => {
    const reject = (problem: string): PiSubagentResultEntry =>
      Object.freeze({
        ok: false as const,
        problem: `result ${index + 1} has an unrecognized shape (${problem}) — its evidence was not applied`,
      });
    if (entry === null || typeof entry !== "object") return reject(`expected an object, got ${entry === null ? "null" : typeof entry}`);
    const record = entry as Record<string, unknown>;
    if (typeof record.agent !== "string") return reject(`agent is ${typeof record.agent}, expected string`);
    if (typeof record.task !== "string") return reject(`task is ${typeof record.task}, expected string`);
    if (typeof record.exitCode !== "number" || !Number.isSafeInteger(record.exitCode)) {
      return reject(`exitCode must be a finite safe integer, got ${String(record.exitCode)}`);
    }
    if (!("messages" in record)) return reject("messages is missing, expected transcript evidence");
    const stopReasonProblem = optionalString(record.stopReason);
    if (stopReasonProblem !== null) return reject(`stopReason is ${stopReasonProblem}, expected string or absent`);
    return Object.freeze({
      ok: true as const,
      result: Object.freeze({
        agent: record.agent,
        task: record.task,
        exitCode: record.exitCode,
        ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason as string }),
        ...(record.errorMessage === undefined ? {} : { errorMessage: record.errorMessage }),
        messages: record.messages,
      }),
    });
  });
}

/** Pi result failure boundary. Missing/malformed exit codes fail closed. */
export function piSubagentResultFailed(result: {
  readonly exitCode?: unknown;
  readonly stopReason?: unknown;
}): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

/**
 * A failure that hit EVERY slot at once is consistent with shared
 * infrastructure rather than N independent agent faults — a hypothesis that
 * is invisible from inside any single slot's rejection. Reported once per
 * batch, beside the per-slot diagnostics,
 * so the operator reads the pattern where the symptoms are. `null` below two
 * results or when any slot survived: one slot is not a pattern, and a surviving
 * sibling removes the all-slot failure signature this helper reports. Partial or
 * intermittent shared infrastructure faults remain possible but are not inferred
 * from this batch-level heuristic.
 */
export function piAllSlotsFailedNote(
  results: readonly {
    readonly exitCode?: unknown;
    readonly stopReason?: unknown;
  }[],
): string | null {
  if (results.length < 2 || !results.every((result) => piSubagentResultFailed(result))) return null;
  const stopReasons = [...new Set(results.map(({ stopReason }) =>
    typeof stopReason === "string" ? stopReason : "n/a"))].sort();
  return `all ${results.length} slots in this batch failed (stopReason=${stopReasons.join("|")}) — ` +
    "a shared-infrastructure fault (endpoint, auth, memory) fits that signature better than " +
    "independent agent faults; consider re-spawning serially before treating it as an agent defect";
}

/**
 * The failure signals a diagnostic about a failed result must CARRY.
 *
 * "Exited without a successful result" is true of every failure mode there is:
 * a model-server drop, an OOM, an auth expiry, and an agent that ignored its
 * contract all read identically. Classifying them then costs a hand parse of
 * the parent session JSONL — where these discriminating fields were in scope at
 * the diagnostic site all along.
 *
 * `errorMessage` is typed `unknown` and read defensively rather than declared
 * as a string: it is the harness's own cause line ("Connection error."), the
 * single most diagnostic field when the transport is at fault, and a pi version
 * that stops emitting it must degrade to the exit/stop pair rather than print
 * `undefined`.
 */
export function piSubagentFailureSignals(result: {
  readonly exitCode?: unknown;
  readonly stopReason?: unknown;
  readonly errorMessage?: unknown;
}): string {
  const errorMessage = typeof result.errorMessage === "string" ? result.errorMessage.trim() : "";
  return [
    `exitCode=${typeof result.exitCode === "number" ? String(result.exitCode) : "n/a"}`,
    `stopReason=${typeof result.stopReason === "string" ? result.stopReason : "n/a"}`,
    ...(errorMessage === "" ? [] : [`errorMessage=${JSON.stringify(errorMessage)}`]),
  ].join(", ");
}

/** The non-empty text blocks of one unknown message's content, in order. */
const textBlocksOf = (message: unknown): readonly string[] => {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.flatMap((block) => {
    const text = isRecord(block) ? block.text : undefined;
    return typeof text === "string" && text.trim() !== "" ? [text] : [];
  });
};

/** Whether any assistant text block is observable in an unknown transcript. */
const assistantTextPresent = (messages: unknown): boolean => {
  if (!Array.isArray(messages)) return true;
  return messages.some((message) =>
    isRecord(message) && message.role === "assistant" && textBlocksOf(message).length > 0);
};

/** The last non-empty text lines of an unknown transcript, for a diagnostic tail. */
const transcriptTail = (messages: unknown): string => {
  if (!Array.isArray(messages)) return "n/a (unreadable transcript shape)";
  const texts = messages.flatMap((message) => textBlocksOf(message).map((text) => text.trim().slice(0, 160)));
  return texts.length === 0 ? "(empty transcript)" : texts.slice(-3).join(" | ");
};

/**
 * The diagnostic for a Pi subagent that exited CLEANLY but emitted no
 * assistant text — the "silent stop" failure mode observed in in-memory RPC
 * children: exitCode=0, a non-error stopReason, an empty transcript, and pi
 * rendering "(no output)". The appliers then parse the empty transcript and
 * report "not ready" or "no structured evidence" without surfacing the
 * stopReason that discriminates the mode; this note carries it beside the
 * transcript tail, so the operator reads the pattern where the symptoms are.
 *
 * Failed results return null: they already carry `piSubagentFailureSignals`
 * through `applyFailedPiResult`, and a second diagnostic would repeat them. A
 * result WITH assistant text also returns null — silence is positively
 * identified only when no assistant text block is observable, so this helper
 * reports only a case it can account for. `messages` is typed `unknown` and
 * read defensively: pi versions differ on transcript shape, and a shape this
 * helper cannot read degrades to "not provably silent" instead of a parse
 * crash at the diagnostic site.
 */
export function piSilentStopNote(result: PiSubagentResult): string | null {
  if (piSubagentResultFailed(result)) return null;
  if (assistantTextPresent(result.messages)) return null;
  const stopReason = typeof result.stopReason === "string" ? result.stopReason : "n/a";
  const errorMessage = typeof result.errorMessage === "string" ? result.errorMessage.trim() : "";
  return [
    `${result.agent} exited cleanly but emitted no assistant text (silent stop): ` +
      `exitCode=${result.exitCode}, stopReason=${stopReason}`,
    `transcript tail: ${transcriptTail(result.messages)}`,
    ...(errorMessage === "" ? [] : [`errorMessage=${JSON.stringify(errorMessage)}`]),
  ].join("; ") + " — the child ended without a final message; its evidence was not applied";
}
