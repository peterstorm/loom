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
import { nonEmpty, type NonEmpty, type Result } from "../kernel";
import type { Preregistration } from "./pilot-preregistration";
import { CELL_KEYS, hex64, parserOf, PILOT_CELLS, text, type CellKey, type DeepReadonly } from "./pilot-vocabulary";

const routeProbeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reachable"), servedModels: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal("unreachable"), reason: z.string() }).strict(),
]);
export type RouteProbe = DeepReadonly<z.infer<typeof routeProbeSchema>>;

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
    .with({ kind: "reachable" }, (route) => {
      if (!route.servedModels.includes(prereg.route.model)) {
        blocks.push({ kind: "served-model-absent", model: prereg.route.model, served: route.servedModels });
      }
    })
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
