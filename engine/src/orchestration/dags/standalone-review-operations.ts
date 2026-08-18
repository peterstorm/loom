/**
 * Standalone Review operation DAGs.
 *
 * Two static graphs, both about routing.
 *
 * Scope resolution: an explicit scope is used as given; an absent scope
 * becomes the canonical changed-path union. An empty scope blocks, and so does
 * an unsafe one — a leading `/` or any `..` segment, the two forms that escape
 * the repository. The derived branch is a DEFAULT edge rather than a
 * second predicate, so "no explicit scope" cannot fall through unhandled — a
 * review that silently scoped itself to nothing would report a clean result
 * having read no code.
 *
 * Critical routing: zero criticals goes straight to finalisation, and a
 * non-empty critical set routes to the refutation panel. Skipping the panel is
 * only correct when there is genuinely nothing to adjudicate, so that
 * condition is a predicate on the aggregate rather than a caller's assertion.
 */

import { z } from "zod";
import { DAG_INPUT, createTransformNode, defineDag, ok, type DagDef } from "@fuguejs/framework";

const RESOLVE_SCOPE = "resolve-scope";
const EXPLICIT_SCOPE = "explicit-scope";
const DERIVED_SCOPE = "derived-scope";
const SCOPE_RESULT = "scope-result";

const ROUTE_CRITICALS = "route-criticals";
const TO_REFUTATION = "route-to-refutation";
const TO_FINALIZE = "route-to-finalization";
const ROUTE_RESULT = "route-result";

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

export type ScopeInput = Readonly<{
  explicitScope: readonly string[] | null;
  changedPaths: readonly string[];
}>;

export type ScopeClassification =
  | Readonly<{ kind: "explicit"; paths: readonly string[] }>
  | Readonly<{ kind: "derived"; paths: readonly string[] }>
  | Readonly<{ kind: "blocked"; reason: string }>;

const scopeInputSchema = z.object({
  explicitScope: z.array(z.string()).nullable(),
  changedPaths: z.array(z.string()),
}) as unknown as z.ZodType<ScopeInput>;

const scopeClassificationSchema = z.union([
  z.object({ kind: z.literal("explicit"), paths: z.array(z.string()) }),
  z.object({ kind: z.literal("derived"), paths: z.array(z.string()) }),
  z.object({ kind: z.literal("blocked"), reason: z.string().min(1) }),
]) as unknown as z.ZodType<ScopeClassification>;

export type ResolvedScope =
  | Readonly<{ kind: "resolved"; origin: "explicit" | "derived"; paths: readonly string[] }>
  | Readonly<{ kind: "blocked"; reason: string }>;

const resolvedScopeSchema = z.union([
  z.object({ kind: z.literal("resolved"), origin: z.enum(["explicit", "derived"]), paths: z.array(z.string()) }),
  z.object({ kind: z.literal("blocked"), reason: z.string().min(1) }),
]) as unknown as z.ZodType<ResolvedScope>;

type ScopeEnvelope = Readonly<Partial<Record<string, ScopeClassification>>>;
type ScopeOutcomeEnvelope = Readonly<Partial<Record<string, ResolvedScope>>>;

const scopeEnvelopeSchema = z.object({
  [RESOLVE_SCOPE]: z.unknown().optional(),
}) as unknown as z.ZodType<ScopeEnvelope>;

const scopeOutcomeEnvelopeSchema = z.object({
  [EXPLICIT_SCOPE]: z.unknown().optional(),
  [DERIVED_SCOPE]: z.unknown().optional(),
}) as unknown as z.ZodType<ScopeOutcomeEnvelope>;

/** A path that escapes the repository or is empty is never reviewable. */
function unsafePath(path: string): boolean {
  return path.length === 0 || path.startsWith("/") || path.split("/").includes("..");
}

const classifyScopeNode = createTransformNode<ScopeInput, ScopeClassification>({
  id: RESOLVE_SCOPE,
  inputSchema: scopeInputSchema,
  outputSchema: scopeClassificationSchema,
  transform: (input) => {
    const explicit = input.explicitScope;
    if (explicit !== null) {
      if (explicit.length === 0) return ok({ kind: "blocked", reason: "an explicit review scope must not be empty" });
      const unsafe = explicit.filter(unsafePath);
      if (unsafe.length > 0) return ok({ kind: "blocked", reason: `explicit scope contains unsafe paths: ${unsafe.join(", ")}` });
      return ok({ kind: "explicit", paths: [...new Set(explicit)].sort() });
    }
    if (input.changedPaths.length === 0) {
      return ok({ kind: "blocked", reason: "no explicit scope and no changed paths to derive one from" });
    }
    const unsafe = input.changedPaths.filter(unsafePath);
    if (unsafe.length > 0) return ok({ kind: "blocked", reason: `changed paths contain unsafe entries: ${unsafe.join(", ")}` });
    return ok({ kind: "derived", paths: [...new Set(input.changedPaths)].sort() });
  },
});

function scopeBranchNode(id: string, origin: "explicit" | "derived") {
  return createTransformNode<ScopeEnvelope, ResolvedScope>({
    id,
    inputSchema: scopeEnvelopeSchema,
    outputSchema: resolvedScopeSchema,
    transform: (envelope) => {
      const classification = envelope[RESOLVE_SCOPE];
      if (classification === undefined) return ok({ kind: "blocked", reason: "scope branch ran without a classification" });
      if (classification.kind === "blocked") return ok(classification);
      return ok(classification.kind === origin
        ? { kind: "resolved", origin, paths: classification.paths }
        : { kind: "blocked", reason: `${classification.kind} scope reached the ${origin} branch` });
    },
  });
}

const scopeResultNode = createTransformNode<ScopeOutcomeEnvelope, ResolvedScope>({
  id: SCOPE_RESULT,
  inputSchema: scopeOutcomeEnvelopeSchema,
  outputSchema: resolvedScopeSchema,
  transform: (envelope) => {
    const resolved = envelope[EXPLICIT_SCOPE] ?? envelope[DERIVED_SCOPE];
    return ok(resolved ?? { kind: "blocked", reason: "neither scope branch produced a result" });
  },
});

/** `classify → (explicit) explicit | (default) derived → resolved scope`. */
export const standaloneScopeDag: DagDef = defineDag({
  id: "standalone-review-scope",
  nodes: {
    [RESOLVE_SCOPE]: classifyScopeNode,
    [EXPLICIT_SCOPE]: scopeBranchNode(EXPLICIT_SCOPE, "explicit"),
    [DERIVED_SCOPE]: scopeBranchNode(DERIVED_SCOPE, "derived"),
    [SCOPE_RESULT]: scopeResultNode,
  },
  edges: [
    { from: DAG_INPUT, to: RESOLVE_SCOPE },
    {
      from: RESOLVE_SCOPE,
      to: EXPLICIT_SCOPE,
      when: {
        label: "scope-supplied-explicitly",
        version: 1,
        check: (value): boolean => (value as ScopeClassification).kind === "explicit",
      },
    },
    { from: RESOLVE_SCOPE, to: DERIVED_SCOPE, kind: "default" },
    { from: EXPLICIT_SCOPE, to: SCOPE_RESULT },
    { from: DERIVED_SCOPE, to: SCOPE_RESULT },
  ],
  outputNodeId: SCOPE_RESULT,
});

// ---------------------------------------------------------------------------
// Critical routing
// ---------------------------------------------------------------------------

export type AggregateSummary = Readonly<{
  criticalCount: number;
  advisoryCount: number;
}>;

export type CriticalRoute =
  | Readonly<{ kind: "refutation-required"; criticalCount: number }>
  | Readonly<{ kind: "finalize"; advisoryCount: number }>
  | Readonly<{ kind: "blocked"; reason: string }>;

const aggregateSummarySchema = z.object({
  criticalCount: z.number().int().nonnegative(),
  advisoryCount: z.number().int().nonnegative(),
}) as unknown as z.ZodType<AggregateSummary>;

const criticalRouteSchema = z.union([
  z.object({ kind: z.literal("refutation-required"), criticalCount: z.number().int().positive() }),
  z.object({ kind: z.literal("finalize"), advisoryCount: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("blocked"), reason: z.string().min(1) }),
]) as unknown as z.ZodType<CriticalRoute>;

type RouteEnvelope = Readonly<Partial<Record<string, AggregateSummary>>>;
type RouteOutcomeEnvelope = Readonly<Partial<Record<string, CriticalRoute>>>;

const routeEnvelopeSchema = z.object({
  [ROUTE_CRITICALS]: z.unknown().optional(),
}) as unknown as z.ZodType<RouteEnvelope>;

const routeOutcomeEnvelopeSchema = z.object({
  [TO_REFUTATION]: z.unknown().optional(),
  [TO_FINALIZE]: z.unknown().optional(),
}) as unknown as z.ZodType<RouteOutcomeEnvelope>;

const summarizeNode = createTransformNode<AggregateSummary, AggregateSummary>({
  id: ROUTE_CRITICALS,
  inputSchema: aggregateSummarySchema,
  outputSchema: aggregateSummarySchema,
  transform: (summary) => ok(summary),
});

/**
 * Reached only when the aggregate carries at least one critical. A zero count
 * here would mean the panel was convened with nothing to adjudicate, which
 * reports "0 refuted, 0 survived" — indistinguishable from a panel that upheld
 * everything — so it routes to finalisation instead. A *missing* summary is a
 * different thing: the branch fired without its predecessor's output, which is a
 * reconciliation failure, and blocks rather than routing anywhere.
 */
const toRefutationNode = createTransformNode<RouteEnvelope, CriticalRoute>({
  id: TO_REFUTATION,
  inputSchema: routeEnvelopeSchema,
  outputSchema: criticalRouteSchema,
  transform: (envelope) => {
    const summary = envelope[ROUTE_CRITICALS];
    if (summary === undefined) return ok({ kind: "blocked", reason: "the refutation branch ran without an aggregate summary" });
    if (summary.criticalCount === 0) return ok({ kind: "finalize", advisoryCount: summary.advisoryCount });
    return ok({ kind: "refutation-required", criticalCount: summary.criticalCount });
  },
});

const toFinalizeNode = createTransformNode<RouteEnvelope, CriticalRoute>({
  id: TO_FINALIZE,
  inputSchema: routeEnvelopeSchema,
  outputSchema: criticalRouteSchema,
  transform: (envelope) => {
    const summary = envelope[ROUTE_CRITICALS];
    if (summary === undefined) return ok({ kind: "blocked", reason: "the finalize branch ran without an aggregate summary" });
    if (summary.criticalCount > 0) {
      return ok({ kind: "refutation-required", criticalCount: summary.criticalCount });
    }
    return ok({ kind: "finalize", advisoryCount: summary.advisoryCount });
  },
});

const routeResultNode = createTransformNode<RouteOutcomeEnvelope, CriticalRoute>({
  id: ROUTE_RESULT,
  inputSchema: routeOutcomeEnvelopeSchema,
  outputSchema: criticalRouteSchema,
  transform: (envelope) => {
    const routed = envelope[TO_REFUTATION] ?? envelope[TO_FINALIZE];
    return ok(routed ?? { kind: "blocked", reason: "neither routing branch produced a result" });
  },
});

/** `summarize → (criticals) refutation | (default) finalize → route`. */
export const standaloneCriticalRouteDag: DagDef = defineDag({
  id: "standalone-review-critical-route",
  nodes: {
    [ROUTE_CRITICALS]: summarizeNode,
    [TO_REFUTATION]: toRefutationNode,
    [TO_FINALIZE]: toFinalizeNode,
    [ROUTE_RESULT]: routeResultNode,
  },
  edges: [
    { from: DAG_INPUT, to: ROUTE_CRITICALS },
    {
      from: ROUTE_CRITICALS,
      to: TO_REFUTATION,
      when: {
        label: "aggregate-has-criticals",
        version: 1,
        check: (value): boolean => (value as AggregateSummary).criticalCount > 0,
      },
    },
    { from: ROUTE_CRITICALS, to: TO_FINALIZE, kind: "default" },
    { from: TO_REFUTATION, to: ROUTE_RESULT },
    { from: TO_FINALIZE, to: ROUTE_RESULT },
  ],
  outputNodeId: ROUTE_RESULT,
});
