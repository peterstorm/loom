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
 * - The fail-fast is ONE step over an opaque `RouteBreaker`:
 *   `startSchedule` opens it, and `landPair` reads each landed pair
 *   (`pairHealth`) and returns where the schedule stands — still running,
 *   ended, or waiting on the route re-probe the pair called for (the probe
 *   I/O is the shell's; the step hands it a `judge` continuation). The
 *   last-pair exemption is internal: the last scheduled pair is never
 *   re-probed or judged, so a schedule dispatched in full always ends
 *   `completed`, and every ending the step returns is one
 *   `parseWindowEnding` admits — the shell carries no ordering obligation.
 * - `WindowEnding` is parsed evidence keyed on the window's `schemaVersion`:
 *   one per-version table (`WINDOW_VERSIONS`) says which abort reasons each
 *   version recorded and whether it judged the last pair, `parseWindowEnding`
 *   is the one constructor of the ending this revision records (schemaVersion
 *   2), and `parseRetainedWindowEnding` reads back a retained window's ending
 *   under the rules of the version that wrote it.
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

declare const routeBreakerBrand: unique symbol;

/**
 * The fail-fast state carried between the pairs of one schedule: how many of
 * its pairs have landed, and how many of those, ending the run, were
 * all-outage. Opaque — only `startSchedule` and `landPair` make one — so
 * `consecutiveOutagePairs ≤ dispatchedPairs < scheduledPairs` always holds:
 * the last scheduled pair never leaves a breaker behind, it ends the schedule.
 */
export type RouteBreaker = Readonly<{
  dispatchedPairs: number;
  scheduledPairs: number;
  consecutiveOutagePairs: number;
  [routeBreakerBrand]: true;
}>;

/** Where a schedule stands: still running (with the breaker for its next
 *  pair), or ended — completed, or aborted by the fail-fast. */
export type ScheduleProgress =
  | Readonly<{ kind: "running"; breaker: RouteBreaker }>
  | Readonly<{ kind: "ended"; ending: WindowEnding }>;

/** What a landed pair decided: where the schedule stands, or — for a pair
 *  that looked like an outage with pairs still to come — the re-probe it
 *  calls for, and the `judge` that decides once the route has answered. */
export type LandedPair =
  | ScheduleProgress
  | Readonly<{ kind: "probe-route"; judge: (route: RouteHealth) => ScheduleProgress }>;

/** The one construction site of the opaque breaker. */
const breakerOf = (dispatchedPairs: number, scheduledPairs: number, consecutiveOutagePairs: number): ScheduleProgress =>
  Object.freeze({
    kind: "running" as const,
    breaker: Object.freeze({ dispatchedPairs, scheduledPairs, consecutiveOutagePairs }) as RouteBreaker,
  });

/** An ending the step reached by construction; a refusal here is a defect in
 *  this module (the breaker's invariants failed), never in the evidence. */
function ended(raw: unknown): ScheduleProgress {
  const ending = parseWindowEnding(raw);
  if (!ending.ok) throw new Error(`the route fail-fast reached an inconsistent ending: ${ending.error}`);
  return Object.freeze({ kind: "ended" as const, ending: ending.value });
}

/** A schedule of `scheduledPairs` pairs before any has landed; an empty one
 *  (every cell extraction-only) has already completed. */
export function startSchedule(scheduledPairs: number): ScheduleProgress {
  if (!Number.isInteger(scheduledPairs) || scheduledPairs < 0) throw new Error(`a schedule has a whole number of pairs, not ${scheduledPairs}`);
  return scheduledPairs === 0 ? ended({ kind: "completed", pairs: 0 }) : breakerOf(0, scheduledPairs, 0);
}

/**
 * The fail-fast rule after one landed pair (its two samples). The last
 * scheduled pair has nothing left to protect: it is neither re-probed nor
 * judged, and the schedule ends `completed`. Any other pair with an
 * outage-like sample calls for a re-probe: an unreachable route stops the
 * window at once; otherwise the window stops on the
 * `CONSECUTIVE_OUTAGE_PAIR_LIMIT`-th consecutive `all-outage` pair.
 */
export function landPair(breaker: RouteBreaker, pair: readonly SampleObservation[]): LandedPair {
  const { scheduledPairs } = breaker;
  const dispatchedPairs = breaker.dispatchedPairs + 1;
  if (dispatchedPairs === scheduledPairs) return ended({ kind: "completed", pairs: scheduledPairs });
  const health = pairHealth(pair);
  const consecutiveOutagePairs = health.kind === "all-outage" ? breaker.consecutiveOutagePairs + 1 : 0;
  const aborted = (reason: WindowAbortReason): ScheduleProgress =>
    ended({ kind: "aborted", afterPairs: dispatchedPairs, scheduledPairs, reason });
  const byStreak = (): ScheduleProgress => consecutiveOutagePairs >= CONSECUTIVE_OUTAGE_PAIR_LIMIT
    ? aborted({ kind: "consecutive-outage-pairs", pairs: CONSECUTIVE_OUTAGE_PAIR_LIMIT })
    : breakerOf(dispatchedPairs, scheduledPairs, consecutiveOutagePairs);
  if (health.kind === "none") return byStreak();
  const judge = (route: RouteHealth): ScheduleProgress => {
    const observed = observedRouteHealth(route);
    return observed.kind === "unreachable" ? aborted({ kind: "route-unreachable", reason: observed.reason }) : byStreak();
  };
  return Object.freeze({ kind: "probe-route" as const, judge });
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

/** Every abort reason any window version recorded, one schema per kind — so
 *  a kind reads the same in every version that admits it. Which version
 *  admits which kind is `WINDOW_VERSIONS`' to say. */
const abortReasonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("route-unreachable"), reason: text }).strict(),
  z.object({ kind: z.literal("consecutive-outage-pairs"), pairs: z.literal(CONSECUTIVE_OUTAGE_PAIR_LIMIT) }).strict(),
  // Revision e8d688d8's fail-fast counted only all-infrastructure pairs, not timeouts.
  z.object({ kind: z.literal("consecutive-infrastructure-failures"), pairs: z.literal(LEGACY_CONSECUTIVE_INFRASTRUCTURE_PAIR_LIMIT) }).strict(),
]);
type AnyAbortReason = DeepReadonly<z.infer<typeof abortReasonSchema>>;
/** The closed set of abort-reason kinds, derived from the schema. */
type AbortReasonKind = AnyAbortReason["kind"];

/** What one window schemaVersion's writer recorded. */
type VersionRules = Readonly<{
  /** The abort reasons it recorded. */
  reasons: readonly AbortReasonKind[];
  /** Whether it judged the last scheduled pair too, so an abort after every
   *  pair is admitted (`e8d688d8` did; from schemaVersion 2 on, `landPair`
   *  never judges the last pair). */
  abortAfterLastPair: "admitted" | "refused";
}>;

/** A version table: exactly one entry per `WindowSchemaVersion` (a missing
 *  one does not compile), and every abort reason admitted by some version (a
 *  reason added to `abortReasonSchema` but to no version does not compile —
 *  the argument must then also name it as `unversionedReasons`). */
function versionTable<const T extends { readonly [V in WindowSchemaVersion]: VersionRules }>(
  table: T & ([Exclude<AbortReasonKind, T[WindowSchemaVersion]["reasons"][number]>] extends [never]
    ? unknown
    : Readonly<{ unversionedReasons: Exclude<AbortReasonKind, T[WindowSchemaVersion]["reasons"][number]> }>),
): T {
  return table;
}

/** The one per-version table of window endings, selected by `schemaVersion`. */
const WINDOW_VERSIONS = versionTable({
  1: { reasons: ["route-unreachable", "consecutive-infrastructure-failures"], abortAfterLastPair: "admitted" },
  2: { reasons: ["route-unreachable", "consecutive-outage-pairs"], abortAfterLastPair: "refused" },
});

type ReasonKindIn<V extends WindowSchemaVersion> = (typeof WINDOW_VERSIONS)[V]["reasons"][number];
type AbortReasonIn<V extends WindowSchemaVersion> = Extract<AnyAbortReason, Readonly<{ kind: ReasonKindIn<V> }>>;

/** Why the fail-fast stopped a window this revision dispatched. */
type WindowAbortReason = AbortReasonIn<typeof CURRENT_WINDOW_SCHEMA_VERSION>;

const atLeastOnePair = z.number().int().min(1);

/** Every ending any version recorded, by shape alone; what a version admits
 *  of it is `admittedUnder`'s to decide. */
const anyEndingSchema = z.discriminatedUnion("kind", [
  // An empty schedule (every cell extraction-only) completes after zero pairs.
  z.object({ kind: z.literal("completed"), pairs: z.number().int().min(0) }).strict(),
  z.object({ kind: z.literal("aborted"), afterPairs: atLeastOnePair, scheduledPairs: atLeastOnePair, reason: abortReasonSchema }).strict(),
]);
type AnyEnding = DeepReadonly<z.infer<typeof anyEndingSchema>>;
type CompletedEnding = Extract<AnyEnding, Readonly<{ kind: "completed" }>>;
type AbortedEnding<V extends WindowSchemaVersion> =
  Readonly<{ kind: "aborted"; afterPairs: number; scheduledPairs: number; reason: AbortReasonIn<V> }>;
type EndingIn<V extends WindowSchemaVersion> = CompletedEnding | AbortedEnding<V>;

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
export type WindowEnding = Branded<EndingIn<typeof CURRENT_WINDOW_SCHEMA_VERSION>>;

/** An ending read back from a retained window, under its own version's rules:
 *  a schemaVersion 1 window may carry `e8d688d8`'s legacy reason, and may have
 *  been recorded aborted after its last pair. */
export type RetainedWindowEnding = Branded<EndingIn<WindowSchemaVersion>>;

const invalid = (problem: string): Result<never, string> => err(`invalid window ending: ${problem}`);

/** The brand is this module's proof that `admittedUnder` admitted the value. */
const branded = <T>(ending: T): Branded<T> => Object.freeze(ending) as Branded<T>;

/** The abort reasons window version `version`'s writer recorded. */
const reasonsOf = (version: WindowSchemaVersion): readonly AbortReasonKind[] => WINDOW_VERSIONS[version].reasons;

const admits = <V extends WindowSchemaVersion>(version: V, reason: AnyAbortReason): reason is AbortReasonIn<V> =>
  reasonsOf(version).includes(reason.kind);

/** The versions whose writer recorded `kind`. */
const versionsRecording = (kind: AbortReasonKind): readonly WindowSchemaVersion[] =>
  WINDOW_SCHEMA_VERSIONS.filter((version) => reasonsOf(version).includes(kind));

/**
 * An aborted ending's pair invariants under its version's rules: it stopped
 * after `afterPairs` of `scheduledPairs` — strictly fewer where the version
 * never judged the last pair, at most all of them where it did — and after
 * no more consecutive outage pairs than it dispatched.
 */
function abortedProblems(rules: VersionRules, ending: Readonly<{ afterPairs: number; scheduledPairs: number; reason: AnyAbortReason }>): readonly string[] {
  const { afterPairs, scheduledPairs, reason } = ending;
  const problems: string[] = [];
  if (afterPairs > scheduledPairs) {
    problems.push(`afterPairs: aborted after ${afterPairs} of ${scheduledPairs} scheduled pairs`);
  } else if (afterPairs === scheduledPairs && rules.abortAfterLastPair === "refused") {
    problems.push(`afterPairs: aborted after all ${scheduledPairs} scheduled pairs: a schedule dispatched in full ends completed`);
  }
  if (reason.kind !== "route-unreachable" && reason.pairs > afterPairs) {
    problems.push(`reason.pairs: ${reason.pairs} consecutive pairs exceed the ${afterPairs} dispatched`);
  }
  return problems;
}

/** An ending under the rules of window version `version`: its shape, then
 *  whether that version recorded its reason, then its pair invariants. */
function admittedUnder<V extends WindowSchemaVersion>(version: V, raw: unknown): Result<Branded<EndingIn<V>>, string> {
  const parsed = anyEndingSchema.safeParse(raw);
  if (!parsed.success) return invalid(issuesOf(parsed.error).join("; "));
  const ending: AnyEnding = parsed.data;
  if (ending.kind === "completed") return ok(branded(ending));
  const { reason } = ending;
  if (!admits(version, reason)) {
    return invalid(`the ${reason.kind} reason exists only in a schemaVersion ${versionsRecording(reason.kind).join(" or ")} window`);
  }
  const problems = abortedProblems(WINDOW_VERSIONS[version], ending);
  return problems.length === 0 ? ok(branded({ ...ending, reason })) : invalid(problems.join("; "));
}

/** The one constructor of the `WindowEnding` this revision records. */
export const parseWindowEnding = (raw: unknown): Result<WindowEnding, string> => admittedUnder(CURRENT_WINDOW_SCHEMA_VERSION, raw);

/** A retained window's recorded ending, under the rules of the version that wrote it. */
export const parseRetainedWindowEnding = (raw: unknown, version: WindowSchemaVersion): Result<RetainedWindowEnding, string> =>
  admittedUnder(version, raw);

/** The pairs a window dispatched before its ending: two samples each (one per arm). */
export const dispatchedPairsOf = (ending: RetainedWindowEnding): number =>
  ending.kind === "completed" ? ending.pairs : ending.afterPairs;
