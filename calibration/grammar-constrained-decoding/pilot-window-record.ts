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
 *   `CURRENT_WINDOW_SCHEMA_VERSION`) and closes as `ClosedWindowRecord`, keyed
 *   on its dispatch plan: a dispatched window records how many samples it
 *   retained and its parsed `WindowEnding`; a window that never dispatched
 *   retained none and has no ending.
 * - `parseRetainedWindow` reads a retained record of either version back into
 *   `RetainedWindow`: its ending is parsed under the rules of the version that
 *   wrote it (`parseRetainedWindowEnding`), and a closed record's observation
 *   count must be exactly two samples per pair its ending dispatched.
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

/** `window.json` once the window has ended, keyed on its dispatch plan: a
 *  dispatched window records how many samples it retained and how its
 *  schedule ended (completed, or aborted by the route fail-fast and why); a
 *  window that never dispatched retained none and has no ending. */
export type ClosedWindowRecord =
  | (Omit<WindowRecord, "dispatch"> & Readonly<{ dispatch: Dispatched; endedAt: string; observations: number; ending: WindowEnding }>)
  | (Omit<WindowRecord, "dispatch"> & Readonly<{ dispatch: NotAttempted; endedAt: string; observations: 0 }>);

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

/** The retained ending, by closure, dispatch plan and schema version: an
 *  ending only on a closed dispatched window, required there from
 *  schemaVersion 2 on, and agreeing with the observation count recorded beside it. */
function retainedEnding(window: RetainedRecord, label: string): Result<RetainedEnding, string> {
  const { schemaVersion, dispatch, endedAt, observations, ending } = window;
  if (endedAt === undefined) return ending === undefined ? ok(OPEN) : err(`${label} records an ending but was never closed`);
  if (observations === undefined) return err(`${label} was closed without its observation count`);
  if (dispatch.kind === "not-attempted") {
    if (ending !== undefined) return err(`${label} never dispatched, yet records an ending`);
    return observations === 0 ? ok(NOT_DISPATCHED) : err(`${label} never dispatched, yet records ${observations} observations`);
  }
  if (ending === undefined) {
    return schemaVersion === 1 ? ok(DISPATCHED_UNRECORDED) : err(`${label} is a closed dispatched schemaVersion ${schemaVersion} window without its ending`);
  }
  const parsed = parseRetainedWindowEnding(ending, schemaVersion);
  if (!parsed.ok) return err(`${label} ${parsed.error}`);
  const pairs = dispatchedPairsOf(parsed.value);
  const samples = pairs * PILOT_ARMS.length;
  return observations === samples
    ? ok(Object.freeze({ kind: "dispatched" as const, ending: parsed.value }))
    : err(`${label} records ${observations} observations, but its ending dispatched ${pairs} pairs (${samples} samples)`);
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
