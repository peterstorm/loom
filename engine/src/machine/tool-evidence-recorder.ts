/**
 * The shared evidence minting shell (INV-4 owner, AD-8).
 *
 * Both harness entry points normalize their tool event into a
 * `HarnessToolCall` and hand it here:
 * - Claude Code: `handlers/post-tool-use/record-evidence.ts`;
 * - Pi: `pi/evidence-recorder.ts`.
 * This module is the only production caller of `extractEvidence` and of the
 * registry's evidence append, so one tool call mints the same facts on both
 * harnesses.
 *
 * It owns the I/O around the pure rule:
 * - report discovery (`findReport`), with the call-start stamp read from
 *   `target.stamps` (call-scoped freshness) and the agent-authored-artifact
 *   veto: the target epoch's FileWrites plus this call's own write targets;
 * - FileWrite paths resolved at mint time against `call.cwd` (a later
 *   reader's cwd may differ, and a wrong base would let a staged artifact
 *   slip past the veto);
 * - the append to `target.ledger` under `target.epoch`, keyed by the call id.
 */

import { resolve } from "node:path";
import { eventsForEpoch } from "./evidence";
import { extractEvidence } from "./extract-evidence";
import type { RecordToolEvidenceFn } from "./harness-tool-call-types";
import { findReport } from "./report-discovery";
import type { Evidence } from "./types";

export const recordToolEvidence: RecordToolEvidenceFn = (target, call, { registry, nowMs }) => {
  const minted = extractEvidence(call, (segment, stdout, currentCallWrites) => {
    // Computed lazily: discovery runs only for classified test commands. The
    // read-time resolve is a no-op for records minted absolute and covers
    // old relative-path records.
    const vetoed = new Set([
      ...eventsForEpoch(registry.readEvidence(target.ledger), target.epoch).flatMap((event) =>
        event.kind === "FileWrite" ? [resolve(call.cwd, event.path)] : [],
      ),
      ...currentCallWrites.map((path) => resolve(call.cwd, path)),
    ]);
    // No call id or no stamp → null, and findReport fails closed on the
    // artifact-backed sources.
    const callStartMs = call.callId === null ? null : registry.callStartFor(target.stamps, call.callId);
    return findReport(segment, call.cwd, stdout, { nowMs: nowMs(), callStartMs }, (path) => vetoed.has(path));
  });
  const events: readonly Evidence[] = minted.map((event) =>
    event.kind === "FileWrite" ? { ...event, path: resolve(call.cwd, event.path) } : event,
  );
  registry.appendEvidence(target.ledger, target.epoch, events, call.callId ?? undefined);
  return events;
};
