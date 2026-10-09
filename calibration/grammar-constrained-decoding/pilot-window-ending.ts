/**
 * How a dispatched pilot window ends — PURE: the route fail-fast rule the
 * window runs between pairs, and the `WindowEnding` it records.
 *
 * - `routeHealthOf` maps the preflight's own route probe (`preflightRouteProbe`)
 *   into the window's `RouteHealth`: only an unreachable route is unhealthy;
 *   an unverified or unlisted model still answers. `observedRouteHealth` and
 *   `routeProbeFailed` are how the dispatch shell records what its
 *   `RouteHealthProbe` port answered (a blank reason is named, never written
 *   as an empty string the ending would refuse) or threw.
 * - `pairHealth` reads each landed pair, `judgePair` decides whether the
 *   window stops, and `judgesPair` says which pairs are judged at all: the
 *   last scheduled pair has nothing left to protect, so a schedule dispatched
 *   in full always ends `completed`.
 * - `WindowEnding` is parsed evidence keyed on the window's `schemaVersion`:
 *   `parseWindowEnding` is the one constructor of the ending this revision
 *   records (schemaVersion 2), and `parseRetainedWindowEnding` reads back a
 *   retained window's ending under the rules of the revision that wrote it.
 *
 * The dispatch shell (`pilot-window.ts`) runs this rule behind its ports; the
 * window record codec (`pilot-window-record.ts`) reads the ending back.
 */

import { z } from "zod";
import { match } from "ts-pattern";
import { err, ok, type Result } from "../kernel";
import { sampleTerminal, type SampleObservation } from "./pilot-observation";
import type { RouteProbe } from "./pilot-preflight";
import { issuesOf, text, type DeepReadonly } from "./pilot-vocabulary";

// ---------------------------------------------------------------------------
// Route health
// ---------------------------------------------------------------------------

/** The preregistered route re-observed mid-window (the preflight's own probe). */
export type RouteHealth = Readonly<{ kind: "reachable" }> | Readonly<{ kind: "unreachable"; reason: string }>;

const REACHABLE: RouteHealth = Object.freeze({ kind: "reachable" });

/** What an unreachable answer records when the probe gave no reason. */
export const UNEXPLAINED_UNREACHABLE_REASON = "the route probe reported the route unreachable without a reason";

/** An unreachable route; a blank reason is named, so the ending it stops the
 *  window with is always recordable (a recorded reason is never empty). */
const unreachableRoute = (reason: string): RouteHealth =>
  Object.freeze({ kind: "unreachable" as const, reason: reason.trim() === "" ? UNEXPLAINED_UNREACHABLE_REASON : reason });

/** What the `RouteHealthProbe` port answered, as the window records it. */
export const observedRouteHealth = (health: RouteHealth): RouteHealth =>
  health.kind === "unreachable" ? unreachableRoute(health.reason) : REACHABLE;

/** A probe that rejected or threw: the route failing to answer (fail CLOSED). */
export const routeProbeFailed = (message: string): RouteHealth => unreachableRoute(`the route probe failed: ${message}`);

/** The preflight's route fact read as the window's route health: only an
 *  unreachable route is unhealthy — an unverified or unlisted served model
 *  still answers, and the preflight already judged the model before dispatch. */
export const routeHealthOf = (probe: RouteProbe): RouteHealth => match(probe)
  .returnType<RouteHealth>()
  .with({ kind: "unreachable" }, ({ reason }) => unreachableRoute(reason))
  .with({ kind: "reachable" }, { kind: "served-model-unverified" }, () => REACHABLE)
  .exhaustive();

// ---------------------------------------------------------------------------
// The fail-fast rule
// ---------------------------------------------------------------------------

/** Consecutive all-outage pairs (`PairHealth` `all-outage`: every sample an
 *  infrastructure failure or a timeout) that stop the window even while the
 *  route still answers its listing — a server that is up but cannot serve,
 *  or hangs, inference. */
export const CONSECUTIVE_OUTAGE_PAIR_LIMIT = 3;

/**
 * What one landed pair says about the route — the one owner of what an
 * outage looks like from inside the window. An infrastructure failure and a
 * timeout are outage-like; a semantic rejection never is (the model
 * answered), so model behaviour never probes or stops the window.
 *
 * - `none`: no outage-like sample; no probe.
 * - `needs-probe`: some, not all, samples outage-like; re-probe the route.
 * - `all-outage`: every sample outage-like; re-probe, and the pair counts
 *   toward `CONSECUTIVE_OUTAGE_PAIR_LIMIT`.
 */
export type PairHealth = Readonly<{ kind: "none" }> | Readonly<{ kind: "needs-probe" }> | Readonly<{ kind: "all-outage" }>;

const isOutageLike = (sample: SampleObservation): boolean => {
  const terminal = sampleTerminal(sample);
  return terminal.kind === "terminal-failure" && (terminal.cause === "infrastructure" || terminal.cause === "timeout");
};

const PAIR_HEALTH = Object.freeze({
  none: Object.freeze({ kind: "none" as const }),
  needsProbe: Object.freeze({ kind: "needs-probe" as const }),
  allOutage: Object.freeze({ kind: "all-outage" as const }),
});

export function pairHealth(pair: readonly SampleObservation[]): PairHealth {
  const outageLike = pair.filter(isOutageLike).length;
  if (outageLike === 0) return PAIR_HEALTH.none;
  return outageLike === pair.length ? PAIR_HEALTH.allOutage : PAIR_HEALTH.needsProbe;
}

/** A pair's health with the re-probe it called for: a probe exists exactly
 *  when the pair called for one. */
export type JudgedPair =
  | Extract<PairHealth, { kind: "none" }>
  | (Exclude<PairHealth, { kind: "none" }> & Readonly<{ route: RouteHealth }>);

/** The fail-fast state carried between pairs. */
export type RouteBreaker = Readonly<{ consecutiveOutagePairs: number }>;

export const ROUTE_BREAKER_START: RouteBreaker = Object.freeze({ consecutiveOutagePairs: 0 });

/** Whether the fail-fast judges the pair that brought the window to
 *  `dispatchedPairs`: only a pair with pairs still to come. The last scheduled
 *  pair has nothing left to protect, so it is neither re-probed nor judged,
 *  and a schedule dispatched in full always ends `completed` — never
 *  `aborted` after every one of its pairs (which `parseWindowEnding` refuses). */
export const judgesPair = (dispatchedPairs: number, scheduledPairs: number): boolean => dispatchedPairs < scheduledPairs;

/**
 * The fail-fast rule after one judged pair: an unreachable route stops the
 * window at once; otherwise the window stops on the
 * `CONSECUTIVE_OUTAGE_PAIR_LIMIT`-th consecutive `all-outage` pair.
 */
export function judgePair(breaker: RouteBreaker, pair: JudgedPair): Readonly<{ breaker: RouteBreaker; abort: WindowAbortReason | null }> {
  const next: RouteBreaker = Object.freeze({ consecutiveOutagePairs: pair.kind === "all-outage" ? breaker.consecutiveOutagePairs + 1 : 0 });
  if (pair.kind !== "none" && pair.route.kind === "unreachable") {
    return { breaker: next, abort: Object.freeze({ kind: "route-unreachable" as const, reason: pair.route.reason }) };
  }
  if (next.consecutiveOutagePairs >= CONSECUTIVE_OUTAGE_PAIR_LIMIT) {
    return { breaker: next, abort: Object.freeze({ kind: "consecutive-outage-pairs" as const, pairs: CONSECUTIVE_OUTAGE_PAIR_LIMIT }) };
  }
  return { breaker: next, abort: null };
}

// ---------------------------------------------------------------------------
// The window ending (parsed evidence, keyed on the window's schemaVersion)
// ---------------------------------------------------------------------------

/** The `window.json` schema versions a retained window can carry; this
 *  revision writes `CURRENT_WINDOW_SCHEMA_VERSION`. */
export const WINDOW_SCHEMA_VERSIONS = [1, 2] as const;
export type WindowSchemaVersion = (typeof WINDOW_SCHEMA_VERSIONS)[number];
export const CURRENT_WINDOW_SCHEMA_VERSION = 2 satisfies WindowSchemaVersion;

/** The consecutive all-infrastructure pairs at which revision `e8d688d8`
 *  stopped a window (its `consecutive-infrastructure-failures` reason). */
const LEGACY_CONSECUTIVE_INFRASTRUCTURE_PAIR_LIMIT = 3;

const atLeastOnePair = z.number().int().min(1);
const completedSchema = z.object({ kind: z.literal("completed"), pairs: z.number().int().min(0) }).strict();
const routeUnreachableSchema = z.object({ kind: z.literal("route-unreachable"), reason: text }).strict();

const abortReasonSchema = z.discriminatedUnion("kind", [
  routeUnreachableSchema,
  z.object({ kind: z.literal("consecutive-outage-pairs"), pairs: z.literal(CONSECUTIVE_OUTAGE_PAIR_LIMIT) }).strict(),
]);
/** Why the fail-fast stopped a window this revision dispatched. */
export type WindowAbortReason = DeepReadonly<z.infer<typeof abortReasonSchema>>;

/** The abort reasons revision `e8d688d8` recorded (schemaVersion 1): its
 *  fail-fast counted only all-infrastructure pairs, not timeouts. */
const legacyAbortReasonSchema = z.discriminatedUnion("kind", [
  routeUnreachableSchema,
  z.object({ kind: z.literal("consecutive-infrastructure-failures"), pairs: z.literal(LEGACY_CONSECUTIVE_INFRASTRUCTURE_PAIR_LIMIT) }).strict(),
]);

/** Which window versions each abort reason exists in. */
const REASON_VERSIONS: Readonly<Record<string, readonly WindowSchemaVersion[]>> = Object.freeze({
  "route-unreachable": [1, 2],
  "consecutive-outage-pairs": [2],
  "consecutive-infrastructure-failures": [1],
});

type AbortedShape = Readonly<{ kind: "aborted"; afterPairs: number; scheduledPairs: number; reason: Readonly<{ kind: string; pairs?: number }> }>;

/**
 * An aborted ending's pair invariants: it stopped after `afterPairs` of
 * `scheduledPairs` — strictly fewer from schemaVersion 2 on (`judgesPair`),
 * at most all of them in a schemaVersion 1 window (`e8d688d8` judged the last
 * pair too) — and no more consecutive outage pairs than it dispatched.
 */
const abortedInvariants = (version: WindowSchemaVersion) => (ending: AbortedShape | Readonly<{ kind: "completed" }>, ctx: z.RefinementCtx): void => {
  if (ending.kind !== "aborted") return;
  const { afterPairs, scheduledPairs, reason } = ending;
  if (afterPairs > scheduledPairs) {
    ctx.addIssue({ code: "custom", message: `aborted after ${afterPairs} of ${scheduledPairs} scheduled pairs`, path: ["afterPairs"] });
  } else if (afterPairs === scheduledPairs && version !== 1) {
    ctx.addIssue({ code: "custom", message: `aborted after all ${scheduledPairs} scheduled pairs: a schedule dispatched in full ends completed`, path: ["afterPairs"] });
  }
  if (reason.pairs !== undefined && reason.pairs > afterPairs) {
    ctx.addIssue({ code: "custom", message: `${reason.pairs} consecutive pairs exceed the ${afterPairs} dispatched`, path: ["reason", "pairs"] });
  }
};

const endingSchema = z.discriminatedUnion("kind", [
  // An empty schedule (every cell extraction-only) completes after zero pairs.
  completedSchema,
  z.object({ kind: z.literal("aborted"), afterPairs: atLeastOnePair, scheduledPairs: atLeastOnePair, reason: abortReasonSchema }).strict(),
]).superRefine(abortedInvariants(2));

const legacyEndingSchema = z.discriminatedUnion("kind", [
  completedSchema,
  z.object({ kind: z.literal("aborted"), afterPairs: atLeastOnePair, scheduledPairs: atLeastOnePair, reason: legacyAbortReasonSchema }).strict(),
]).superRefine(abortedInvariants(1));

declare const windowEndingBrand: unique symbol;
type Branded<T> = T & Readonly<{ [windowEndingBrand]: true }>;

/**
 * How a dispatched window's schedule ended. An aborted window keeps every
 * sample that landed; the pairs it never dispatched are simply unmeasured, so
 * its decision is `incomplete` — never a fabricated or censored sample.
 * Branded: only `parseWindowEnding` makes one, so its invariants hold — a
 * completed window ran its whole schedule (`pairs` is the scheduled pair
 * count, 0 for an empty schedule of extraction-only cells); an aborted one
 * stopped between pairs (1 ≤ `afterPairs` < `scheduledPairs`), on an
 * unreachable route (with a non-empty reason) or on exactly
 * `CONSECUTIVE_OUTAGE_PAIR_LIMIT` consecutive outage pairs.
 */
export type WindowEnding = Branded<DeepReadonly<z.infer<typeof endingSchema>>>;

/** An ending read back from a retained window, under its own version's rules:
 *  a schemaVersion 1 window may carry `e8d688d8`'s legacy reason, and may have
 *  been recorded aborted after its last pair. */
export type RetainedWindowEnding = WindowEnding | Branded<DeepReadonly<z.infer<typeof legacyEndingSchema>>>;

const invalid = (problem: string): Result<never, string> => err(`invalid window ending: ${problem}`);

/** An abort reason the window's version never wrote, named as such. */
function reasonOutsideVersion(raw: unknown, version: WindowSchemaVersion): string | null {
  const peek = z.object({ kind: z.literal("aborted"), reason: z.object({ kind: z.string() }) }).safeParse(raw);
  if (!peek.success) return null;
  const { kind } = peek.data.reason;
  const versions = REASON_VERSIONS[kind];
  return versions === undefined || versions.includes(version)
    ? null
    : `the ${kind} reason exists only in a schemaVersion ${versions.join(" or ")} window`;
}

function parseEndingUnder<S extends z.ZodType>(schema: S, raw: unknown, version: WindowSchemaVersion): Result<Branded<DeepReadonly<z.infer<S>>>, string> {
  const outside = reasonOutsideVersion(raw, version);
  if (outside !== null) return invalid(outside);
  const parsed = schema.safeParse(raw);
  // The brand is this module's proof that the schema admitted the value.
  return parsed.success ? ok(Object.freeze(parsed.data) as Branded<DeepReadonly<z.infer<S>>>) : invalid(issuesOf(parsed.error).join("; "));
}

/** The one constructor of the `WindowEnding` this revision records. */
export const parseWindowEnding = (raw: unknown): Result<WindowEnding, string> =>
  parseEndingUnder(endingSchema, raw, CURRENT_WINDOW_SCHEMA_VERSION);

/** A retained window's recorded ending, under the rules of the version that wrote it. */
export const parseRetainedWindowEnding = (raw: unknown, version: WindowSchemaVersion): Result<RetainedWindowEnding, string> =>
  version === CURRENT_WINDOW_SCHEMA_VERSION ? parseWindowEnding(raw) : parseEndingUnder(legacyEndingSchema, raw, version);

/** The pairs a window dispatched before its ending: two samples each (one per arm). */
export const dispatchedPairsOf = (ending: RetainedWindowEnding): number =>
  ending.kind === "completed" ? ending.pairs : ending.afterPairs;
