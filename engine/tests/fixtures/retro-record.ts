/**
 * Retro records for fixtures (ADR-0083): a finished run owes a run-scope
 * retro before it completes, so a fixture that means "finished" records one.
 */
import type { RetroRecord } from "../../src/types";

/** The run's retro deliberately skipped, as `helper record-retro --skip` records it. */
export const RUN_RETRO_SKIPPED: readonly RetroRecord[] = Object.freeze([
  Object.freeze({ schemaVersion: 1, kind: "retro-skipped", scope: Object.freeze({ kind: "run" }), reason: "fixture run" }),
]);
