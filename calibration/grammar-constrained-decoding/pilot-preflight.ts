/**
 * The pilot's preflight — PURE: the frozen runtime identity and route
 * reachability a window is gated on. The shell gathers the facts (the staged
 * registry is derived here, the Pi version, the loaded Runtime Revision and
 * the route probe are observed); this module parses retained facts back and
 * decides, so a re-decision re-derives the verdict instead of trusting a
 * stored one.
 */

import { z } from "zod";
import { match } from "ts-pattern";
import { sha256Hex } from "../../engine/src/core/digest";
import { decideProbedRoute, unreachableReason, type RouteProbe as RouteObservation } from "../../engine/src/core/route-reachability";
import { nonEmpty, type NonEmpty, type Result } from "../kernel";
import type { Preregistration } from "./pilot-preregistration";
import { CELL_KEYS, hex64, parserOf, PILOT_CELLS, text, type CellKey, type DeepReadonly } from "./pilot-vocabulary";

/** Why a retained window recorded before the explicit fact (gcd-ad11-pilot-2,
 *  2026-10-08) has an unverified served model: it wrote `servedModels: null`. */
export const LEGACY_UNVERIFIED_REASON =
  "recorded as servedModels null: the server answered, its model list was unobservable";

const routeProbeSchema = z.union([
  /** The server's list was read: `decidePreflight` checks the preregistered model is in it. */
  z.object({ kind: z.literal("reachable"), servedModels: z.array(z.string()) }).strict(),
  /** The server answered, but its model list is unobservable (listing needs
   *  credentials Loom never sends; Pi authenticates inference): the model
   *  identity was never confirmed, and the window's evidence says so. */
  z.object({ kind: z.literal("served-model-unverified"), reason: z.string() }).strict(),
  /** The pre-fact retained shape of the same observation, read as it. */
  z.object({ kind: z.literal("reachable"), servedModels: z.null() }).strict()
    .transform(() => ({ kind: "served-model-unverified" as const, reason: LEGACY_UNVERIFIED_REASON })),
  z.object({ kind: z.literal("unreachable"), reason: z.string() }).strict(),
]);
export type RouteProbe = DeepReadonly<z.infer<typeof routeProbeSchema>>;

/**
 * The preflight's route fact from the engine's one route probe
 * (`httpRouteProbe` observes `GET {baseUrl}/models`) as the engine's pure
 * `decideProbedRoute` judges it. This maps that closed union; it reads no
 * HTTP status itself.
 *
 * - the model listed, or a listing without it → `reachable` with everything
 *   served: whether the preregistered model is among them is
 *   `decidePreflight`'s check, so an absent model is recorded as
 *   `served-model-absent` with what is served;
 * - an authentication refusal → `served-model-unverified`: the server
 *   answers, its list is unobservable without credentials Loom never
 *   resolves or sends, and Pi authenticates the inference itself;
 * - a 2xx without a readable list → `unreachable`: unlike an auth refusal,
 *   nothing says this is the OpenAI-compatible server the window measures;
 * - any other unreachable answer → `unreachable`, with the engine's reason.
 */
export function preflightRouteProbe(route: Preregistration["route"], probe: RouteObservation): RouteProbe {
  const decision = decideProbedRoute(
    { provider: route.provider, model: route.model },
    { provider: route.provider, baseUrl: route.baseUrl },
    probe,
  );
  return Object.freeze(match(decision)
    .returnType<RouteProbe>()
    .with({ kind: "reachable", served: { kind: "listed" } }, ({ served }) => ({ kind: "reachable", servedModels: served.models }))
    .with({ kind: "reachable", served: { kind: "unlisted", cause: "auth-refused" } }, ({ url, served }) => ({
      kind: "served-model-unverified",
      reason: `GET ${url} answered HTTP ${served.status}: the model list needs credentials Loom never sends`,
    }))
    .with({ kind: "reachable", served: { kind: "unlisted", cause: "unreadable-listing" } }, ({ url }) => ({
      kind: "unreachable",
      reason: `GET ${url} answered without a readable model list`,
    }))
    .with({ kind: "unreachable", cause: { kind: "model-not-served" } }, ({ cause }) => ({ kind: "reachable", servedModels: cause.served }))
    .with({ kind: "unreachable" }, ({ url, cause }) => ({ kind: "unreachable", reason: `GET ${url}: ${unreachableReason(cause)}` }))
    .exhaustive());
}

/** Retained digests parse as strictly as the preregistered digests they are compared with. */
const registryCellSchema = z.object({ toolName: z.string(), schemaDigest: hex64 }).strict().nullable();

const preflightFactsSchema = z.object({
  /** Frozen registry cells as the staged runtime computes them (null = no cell), one per required cell. */
  registry: z.record(z.enum(CELL_KEYS), registryCellSchema),
  workloadFixturesDigest: hex64,
  piVersion: z.string().nullable(),
  /** Content-addressed Runtime Revision of the staged checkout children load. */
  stagedRuntimeRevision: text,
  /** Revision published by the operator's loaded Pi extension, when observable. */
  loadedRuntimeRevision: z.string().nullable(),
  route: routeProbeSchema,
}).strict();
export type PreflightFacts = DeepReadonly<z.infer<typeof preflightFactsSchema>>;

/** Retained facts are re-parsed, so a re-decision re-derives the preflight
 *  verdict instead of trusting a stored one. */
export const parsePreflightFacts: (raw: unknown) => Result<PreflightFacts, readonly string[]> = parserOf(preflightFactsSchema);

/** The staged runtime's frozen registry cells: every required cell's tool
 *  name and the digest of its frozen schema bytes. */
export function stagedRegistryFacts(): PreflightFacts["registry"] {
  // `Object.fromEntries` cannot carry its keys' type; CELL_KEYS enumerates every CellKey exactly once.
  return Object.freeze(Object.fromEntries(CELL_KEYS.map((cell) => [cell, Object.freeze({
    toolName: PILOT_CELLS[cell].toolName,
    schemaDigest: sha256Hex(PILOT_CELLS[cell].schemaBytes),
  })])) as Record<CellKey, Readonly<{ toolName: string; schemaDigest: string }>>);
}

export type PreflightBlock =
  | Readonly<{ kind: "schema-digest-mismatch"; cell: CellKey; preregistered: string; staged: string | null }>
  | Readonly<{ kind: "tool-name-mismatch"; cell: CellKey; preregistered: string; staged: string | null }>
  | Readonly<{ kind: "workload-fixtures-changed"; preregistered: string; observed: string }>
  | Readonly<{ kind: "pi-version-mismatch"; preregistered: string; observed: string | null }>
  | Readonly<{ kind: "route-unreachable"; reason: string }>
  | Readonly<{ kind: "served-model-absent"; model: string; served: readonly string[] }>
  | Readonly<{ kind: "loaded-runtime-mismatch"; staged: string; loaded: string }>;

export type RuntimeIdentityRecord = Readonly<{
  stagedRuntimeRevision: string;
  /** Staging and the loaded runtime stay distinct: `unobserved` is never a match. */
  loadedRuntime:
    | Readonly<{ kind: "unobserved" }>
    | Readonly<{ kind: "matches-staged"; revision: string }>
    | Readonly<{ kind: "differs"; revision: string }>;
  piVersion: string | null;
}>;

export type PreflightDecision =
  | Readonly<{ kind: "ready"; runtime: RuntimeIdentityRecord }>
  | Readonly<{ kind: "blocked"; blocks: NonEmpty<PreflightBlock>; runtime: RuntimeIdentityRecord }>;

/** Staging and the loaded runtime stay distinct: `unobserved` is never a
 *  match. A loaded revision the shell could not read proves nothing about
 *  what the operator's Pi extension runs, so the null branch records
 *  `unobserved` — it never borrows the staged revision as `matches-staged`. */
function loadedRuntimeRecord(loaded: string | null, staged: string): RuntimeIdentityRecord["loadedRuntime"] {
  if (loaded === null) return Object.freeze({ kind: "unobserved" as const });
  if (loaded === staged) return Object.freeze({ kind: "matches-staged" as const, revision: loaded });
  return Object.freeze({ kind: "differs" as const, revision: loaded });
}

export function decidePreflight(prereg: Preregistration, facts: PreflightFacts): PreflightDecision {
  const blocks: PreflightBlock[] = [];
  for (const cell of prereg.cells) {
    const staged = facts.registry[cell.cell];
    if (staged?.schemaDigest !== cell.schemaDigest) {
      blocks.push({ kind: "schema-digest-mismatch", cell: cell.cell, preregistered: cell.schemaDigest, staged: staged?.schemaDigest ?? null });
    }
    if (staged?.toolName !== cell.toolName) {
      blocks.push({ kind: "tool-name-mismatch", cell: cell.cell, preregistered: cell.toolName, staged: staged?.toolName ?? null });
    }
  }
  if (facts.workloadFixturesDigest !== prereg.workloadFixturesDigest) {
    blocks.push({ kind: "workload-fixtures-changed", preregistered: prereg.workloadFixturesDigest, observed: facts.workloadFixturesDigest });
  }
  if (facts.piVersion !== prereg.route.piVersion) {
    blocks.push({ kind: "pi-version-mismatch", preregistered: prereg.route.piVersion, observed: facts.piVersion });
  }
  match(facts.route)
    .with({ kind: "unreachable" }, (route) => { blocks.push({ kind: "route-unreachable", reason: route.reason }); })
    .with({ kind: "reachable" }, ({ servedModels }) => {
      if (!servedModels.includes(prereg.route.model)) {
        blocks.push({ kind: "served-model-absent", model: prereg.route.model, served: servedModels });
      }
    })
    // An unobservable list records no block — it proves nothing absent — and
    // the retained fact itself records that the model was never confirmed.
    .with({ kind: "served-model-unverified" }, () => undefined)
    .exhaustive();
  const loaded = facts.loadedRuntimeRevision;
  if (loaded !== null && loaded !== facts.stagedRuntimeRevision) {
    blocks.push({ kind: "loaded-runtime-mismatch", staged: facts.stagedRuntimeRevision, loaded });
  }
  const runtime: RuntimeIdentityRecord = Object.freeze({
    stagedRuntimeRevision: facts.stagedRuntimeRevision,
    loadedRuntime: loadedRuntimeRecord(loaded, facts.stagedRuntimeRevision),
    piVersion: facts.piVersion,
  });
  const blocked = nonEmpty(blocks.map((block) => Object.freeze(block)));
  return blocked === null
    ? Object.freeze({ kind: "ready" as const, runtime })
    : Object.freeze({ kind: "blocked" as const, blocks: blocked, runtime });
}
