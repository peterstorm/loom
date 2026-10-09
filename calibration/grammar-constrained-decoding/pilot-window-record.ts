/**
 * `window.json` — the one codec of a pilot window's record (PURE).
 *
 * The writer (`recordWindow`, `pilot-retention.ts`) and the reader
 * (`--decide`, `parseRetainedWindow`) share one definition of every field
 * either side relies on: the zod schemas below, with the domain types derived
 * from them (`z.infer`), so the dispatch plan, the preregistration reference
 * and the ending cannot drift between what is written and what is read back.
 *
 * - The record opens as `WindowRecord` (schemaVersion
 *   `CURRENT_WINDOW_SCHEMA_VERSION`) and closes as `ClosedWindowRecord`, made
 *   only by `closeWindowRecord` from a `WindowClosing` (what the dispatch
 *   plan ran): a dispatched window records its parsed `WindowEnding` and the
 *   samples that ending retained — derived from it, two per dispatched pair
 *   (`retainedSamplesOf`) — and a window that never dispatched retained none
 *   and has no ending.
 * - `parseRetainedWindow` reads a retained record of either version back into
 *   `RetainedWindow` under the same rules: its ending is parsed under the
 *   rules of the version that wrote it (`parseRetainedWindowEnding`), a
 *   closed record's observation count must be the one `retainedSamplesOf`
 *   derives, and a record carrying any closing field without its end time is
 *   refused, never read as an interrupted window. A record the writer makes
 *   always reads back as the closing it was made from.
 * - `describeWindowEnding` is the operator-facing line for an aborted window.
 *
 * The recorded `preflight` verdict is written for the reader of the file but
 * never read back: a re-decision re-derives it from the retained facts.
 */

import { z } from "zod";
import { match } from "ts-pattern";
import { err, ok, type Result } from "../kernel";
import { preflightFactsSchema, type PreflightDecision, type PreflightFacts } from "./pilot-preflight";
import { issuesOf, jsonText, parseJsonText, PILOT_ARMS, text, type DeepReadonly } from "./pilot-vocabulary";
import {
  CURRENT_WINDOW_SCHEMA_VERSION,
  dispatchedPairsOf,
  parseRetainedWindowEnding,
  WINDOW_SCHEMA_VERSIONS,
  type RetainedWindowEnding,
  type WindowEnding,
} from "./pilot-window-ending";

// ---------------------------------------------------------------------------
// The record's fields (one schema each; the types are derived)
// ---------------------------------------------------------------------------

const preregistrationRefSchema = z.object({ path: text, digest: text, id: text });
/** The retained identity of a preregistration: its checkout path, content digest and id. */
export type PreregistrationRef = DeepReadonly<z.infer<typeof preregistrationRefSchema>>;

const dispatchPlanSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-attempted"), reason: text }).strict(),
  z.object({ kind: z.literal("dispatched") }).strict(),
]);
/** Whether the window dispatches: the one decision `planDispatch` makes. */
export type DispatchPlan = DeepReadonly<z.infer<typeof dispatchPlanSchema>>;
type Dispatched = Extract<DispatchPlan, { kind: "dispatched" }>;
export type NotAttempted = Extract<DispatchPlan, { kind: "not-attempted" }>;

/** The dispatched plan: one value, recorded at open and at close alike. */
export const DISPATCHED: Dispatched = Object.freeze({ kind: "dispatched" });

/** What a window records when it opens, and what a re-decision reads back of it. */
const windowOpeningSchema = z.object({
  windowId: text,
  preregistration: preregistrationRefSchema,
  workloadFixtures: z.object({ path: text, digest: text }),
  startedAt: text,
  preflightFacts: preflightFactsSchema,
  dispatch: dispatchPlanSchema,
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** `window.json` as written when the window opens. */
export type WindowRecord = DeepReadonly<z.infer<typeof windowOpeningSchema>> & Readonly<{
  schemaVersion: typeof CURRENT_WINDOW_SCHEMA_VERSION;
  /** The preflight verdict at open; a re-decision re-derives it from `preflightFacts`. */
  preflight: PreflightDecision;
}>;

/** How a window closed — what its dispatch plan ran: nothing, or a schedule
 *  that ended (completed, or aborted by the route fail-fast and why). The
 *  one closing both sides of the codec share: `closeWindowRecord` encodes it,
 *  `parseRetainedWindow` decodes it back. */
export type WindowClosing =
  | Readonly<{ kind: "not-attempted"; plan: NotAttempted }>
  | Readonly<{ kind: "dispatched"; ending: WindowEnding }>;

/** The samples a window retained: two per pair its ending dispatched (one per
 *  arm), none for a window that never dispatched — the one count the writer
 *  records and the reader checks. */
const retainedSamplesOf = (ending: RetainedWindowEnding | null): number =>
  ending === null ? 0 : dispatchedPairsOf(ending) * PILOT_ARMS.length;

declare const closedByCodec: unique symbol;

/** `window.json` once the window has ended, keyed on its dispatch plan: a
 *  dispatched window records how many samples it retained and how its
 *  schedule ended; a window that never dispatched retained none and has no
 *  ending. Branded: only `closeWindowRecord` makes one, so its observation
 *  count is the one its ending implies — a record the reader would refuse
 *  cannot be written. */
export type ClosedWindowRecord = Readonly<{ [closedByCodec]: true }> & (
  | (Omit<WindowRecord, "dispatch"> & Readonly<{ dispatch: Dispatched; endedAt: string; observations: number; ending: WindowEnding }>)
  | (Omit<WindowRecord, "dispatch"> & Readonly<{ dispatch: NotAttempted; endedAt: string; observations: 0 }>)
);

/** The one constructor of a closed record: its dispatch plan and observation
 *  count are derived from how it closed, never passed alongside it. */
export function closeWindowRecord(record: WindowRecord, closing: WindowClosing, endedAt: string): ClosedWindowRecord {
  const closed = match(closing)
    .with({ kind: "not-attempted" }, ({ plan }) => ({ ...record, dispatch: plan, endedAt, observations: 0 as const }))
    .with({ kind: "dispatched" }, ({ ending }) => ({ ...record, dispatch: DISPATCHED, endedAt, observations: retainedSamplesOf(ending), ending }))
    .exhaustive();
  // The brand is this module's proof that the count was derived from the closing.
  return Object.freeze(closed) as ClosedWindowRecord;
}

/** `window.json`'s text, open or closed. */
export const encodeWindowRecord = (record: WindowRecord | ClosedWindowRecord): string => jsonText(record);

/** The operator-facing line for a window the route fail-fast stopped; null for
 *  a completed schedule or a window that never dispatched (its decision says the rest). */
export const describeWindowEnding = (window: ClosedWindowRecord): string | null => match(window)
  .returnType<string | null>()
  .with({ dispatch: { kind: "dispatched" }, ending: { kind: "aborted" } }, ({ ending }) => {
    const why = match(ending.reason)
      .with({ kind: "route-unreachable" }, ({ reason }) => `the route stopped answering: ${reason}`)
      .with({ kind: "consecutive-outage-pairs" }, ({ pairs }) => `${pairs} consecutive pairs failed at the infrastructure or timed out`)
      .exhaustive();
    return `pilot window ABORTED after ${ending.afterPairs}/${ending.scheduledPairs} pairs: ${why}. Every landed sample is retained; the rest are unmeasured.`;
  })
  .otherwise(() => null);

// ---------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------

/** A retained record of either version: the opening, plus whatever closed it. */
const retainedWindowSchema = windowOpeningSchema.extend({
  schemaVersion: z.literal(WINDOW_SCHEMA_VERSIONS),
  endedAt: text.optional(),
  observations: z.number().int().min(0).optional(),
  ending: z.unknown().optional(),
});
type RetainedRecord = DeepReadonly<z.infer<typeof retainedWindowSchema>>;

/** How a re-decision reads a retained window's ending back. */
export type RetainedEnding =
  /** Opened and never closed: the run was interrupted mid-window. */
  | Readonly<{ kind: "open" }>
  | Readonly<{ kind: "not-dispatched" }>
  | Readonly<{ kind: "dispatched"; ending: RetainedWindowEnding }>
  /** A schemaVersion 1 dispatched window closed before endings were recorded. */
  | Readonly<{ kind: "dispatched-unrecorded" }>;

/** What a re-decision reads back from a retained `window.json`. */
export type RetainedWindow = Readonly<{
  preregistration: PreregistrationRef;
  facts: PreflightFacts;
  ending: RetainedEnding;
}>;

const OPEN: RetainedEnding = Object.freeze({ kind: "open" });
const NOT_DISPATCHED: RetainedEnding = Object.freeze({ kind: "not-dispatched" });
const DISPATCHED_UNRECORDED: RetainedEnding = Object.freeze({ kind: "dispatched-unrecorded" });

/** The retained closing, decoded under the rules `closeWindowRecord` encodes:
 *  every closing field (end time, observation count, ending) only on a closed
 *  window; an ending only on a dispatched one, required there from
 *  schemaVersion 2 on; and the observation count the closing implies. */
function retainedEnding(window: RetainedRecord, label: string): Result<RetainedEnding, string> {
  const { schemaVersion, dispatch, endedAt, observations, ending } = window;
  if (endedAt === undefined) {
    // The writer records every closing field with the end time: one without it is corrupt, not open.
    if (ending !== undefined) return err(`${label} records an ending but was never closed`);
    if (observations !== undefined) return err(`${label} records ${observations} observations but was never closed`);
    return ok(OPEN);
  }
  if (observations === undefined) return err(`${label} was closed without its observation count`);
  if (dispatch.kind === "not-attempted") {
    if (ending !== undefined) return err(`${label} never dispatched, yet records an ending`);
    return observations === retainedSamplesOf(null) ? ok(NOT_DISPATCHED) : err(`${label} never dispatched, yet records ${observations} observations`);
  }
  if (ending === undefined) {
    return schemaVersion === 1 ? ok(DISPATCHED_UNRECORDED) : err(`${label} is a closed dispatched schemaVersion ${schemaVersion} window without its ending`);
  }
  const parsed = parseRetainedWindowEnding(ending, schemaVersion);
  if (!parsed.ok) return err(`${label} ${parsed.error}`);
  const samples = retainedSamplesOf(parsed.value);
  return observations === samples
    ? ok(Object.freeze({ kind: "dispatched" as const, ending: parsed.value }))
    : err(`${label} records ${observations} observations, but its ending dispatched ${dispatchedPairsOf(parsed.value)} pairs (${samples} samples)`);
}

/** A refused record, named by what is missing first: its preregistration, its
 *  preflight facts, then anything else of its version's shape. */
function refusal(error: z.ZodError, label: string): string {
  const under = (field: string) => error.issues.filter((issue) => issue.path[0] === field);
  if (under("preregistration").length > 0) return `${label} carries no preregistration record`;
  const facts = under("preflightFacts");
  if (facts.length > 0) {
    return `${label} preflight facts: ${facts.map((issue) => `${issue.path.slice(1).join(".") || "<root>"}: ${issue.message}`).join("; ")}`;
  }
  return `${label} is not a schemaVersion ${WINDOW_SCHEMA_VERSIONS.join(" or ")} window record: ${issuesOf(error).join("; ")}`;
}

export function parseRetainedWindow(text: string, label: string): Result<RetainedWindow, string> {
  const raw = parseJsonText(text, label);
  if (!raw.ok) return raw;
  const parsed = retainedWindowSchema.safeParse(raw.value);
  if (!parsed.success) return err(refusal(parsed.error, label));
  const window: RetainedRecord = parsed.data;
  const ending = retainedEnding(window, label);
  if (!ending.ok) return ending;
  return ok(Object.freeze({ preregistration: window.preregistration, facts: window.preflightFacts, ending: ending.value }));
}
