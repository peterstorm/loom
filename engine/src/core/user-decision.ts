/**
 * The user decision `helper orchestration decide` reads from stdin, and what
 * the docs teach as the `wave-gate-decision` wire example (ADR-0073).
 *
 * Pure: a refusal is returned as data, and the handler renders it.
 */

import type { DomainResult } from "./orchestration-contract";
import { isRecord, type UnknownRecord } from "./plain-record";

/**
 * Whose decision is being recorded: a registered Wave Gate's, whose only
 * decision is approval of its advisories, or a run with no program
 * registration, which records any JSON object as given.
 */
export type DecisionRecipient = "wave-gate" | "unregistered-run";

export type UserDecision = Readonly<UnknownRecord>;

const refused = (message: string): DomainResult<UserDecision, string> => ({ ok: false, error: message });

/** A JSON object, and for a registered Wave Gate exactly `{"kind":"approve"}`. */
export function parseUserDecision(stdin: string, recipient: DecisionRecipient): DomainResult<UserDecision, string> {
  if (stdin.trim().length === 0) return refused("a decision must be supplied on stdin");
  let decision: unknown;
  try {
    decision = JSON.parse(stdin);
  } catch (error) {
    return refused(`decision must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(decision)) return refused("decision must be a JSON object");
  if (recipient === "wave-gate" && (Object.keys(decision).length !== 1 || decision.kind !== "approve")) {
    return refused("Wave advisory decision must be exactly {\"kind\":\"approve\"}");
  }
  return { ok: true, value: decision };
}
