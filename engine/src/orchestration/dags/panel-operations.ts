/**
 * Panel operation DAGs.
 *
 * Two static graphs, one per panel, each shaped the same way: prove the
 * roster is complete, then aggregate. The aggregation step is reachable only
 * from the proved branch, so a partial roster cannot produce a ranking or a
 * tally — which is the property `parseCompleteRoster` exists to guarantee and
 * this graph makes structural.
 *
 * Semantic Agents are NOT nodes. Their results arrive as values that the
 * roster proof consumes; the DAG only runs the deterministic work around
 * them. Every node here is a pure transform with `requires: []`.
 *
 * A conditional or default edge makes its source an optional incoming source,
 * which switches Fugue's input shape to an object keyed by source node id.
 * The branch nodes model that envelope explicitly.
 */

import { z } from "zod";
import { DAG_INPUT, createTransformNode, defineDag, ok, type DagDef } from "@fuguejs/framework";
import {
  aggregateArchitecturePanel,
  tallyRefutationPanel,
  type ArchitecturePanelAuthority,
  type RefutationPanelAuthority,
} from "../../core/panel-program";
import {
  parseCompleteRoster,
  type PublicationAuthorityResolver,
  type RosterViolation,
} from "../../core/orchestration-contract";

const PROVE_ROSTER = "prove-complete-roster";
const AGGREGATE = "aggregate";
const REJECT = "rejected-roster";
const RESULT = "panel-result";

export type PanelOperationInput = Readonly<{
  authority: unknown;
  results: unknown;
}>;

export type RosterProof =
  | Readonly<{ kind: "proved"; complete: unknown; slotCount: number }>
  | Readonly<{ kind: "rejected"; reason: string }>;

export type PanelOutcome =
  | Readonly<{ kind: "aggregated"; value: unknown }>
  | Readonly<{ kind: "rejected"; reason: string }>;

const panelInputSchema = z.object({
  authority: z.unknown(),
  results: z.unknown(),
}) as unknown as z.ZodType<PanelOperationInput>;

const rosterProofSchema = z.union([
  z.object({ kind: z.literal("proved"), complete: z.unknown(), slotCount: z.number().int().positive() }),
  z.object({ kind: z.literal("rejected"), reason: z.string().min(1) }),
]) as unknown as z.ZodType<RosterProof>;

const panelOutcomeSchema = z.union([
  z.object({ kind: z.literal("aggregated"), value: z.unknown() }),
  z.object({ kind: z.literal("rejected"), reason: z.string().min(1) }),
]) as unknown as z.ZodType<PanelOutcome>;

type ProofEnvelope = Readonly<Partial<Record<string, RosterProof>>>;
type OutcomeEnvelope = Readonly<Partial<Record<string, PanelOutcome>>>;

const proofEnvelopeSchema = z.object({
  [PROVE_ROSTER]: z.unknown().optional(),
}) as unknown as z.ZodType<ProofEnvelope>;

const outcomeEnvelopeSchema = z.object({
  [AGGREGATE]: z.unknown().optional(),
  [REJECT]: z.unknown().optional(),
}) as unknown as z.ZodType<OutcomeEnvelope>;

/**
 * The panel-specific pieces. Both panels share this graph shape and differ
 * only in how their authority parses and what aggregation means, so the shape
 * is written once and specialised rather than duplicated.
 */
export type PanelOperationSpec<A> = Readonly<{
  dagId: string;
  parseAuthority: (raw: unknown) => Readonly<{ ok: true; value: A }> | Readonly<{ ok: false; message: string }>;
  rosterOf: (authority: A) => Parameters<typeof parseCompleteRoster>[1];
  parsePayload: Parameters<typeof parseCompleteRoster>[3];
  aggregate: (authority: A, complete: never) => Readonly<{ ok: boolean }> & Record<string, unknown>;
}>;

function proveRosterNode<A>(
  spec: PanelOperationSpec<A>,
  resolver: PublicationAuthorityResolver,
) {
  return createTransformNode<PanelOperationInput, RosterProof>({
    id: PROVE_ROSTER,
    inputSchema: panelInputSchema,
    outputSchema: rosterProofSchema,
    transform: (input) => {
      const authority = spec.parseAuthority(input.authority);
      if (!authority.ok) return ok({ kind: "rejected", reason: authority.message });

      const complete = parseCompleteRoster(
        resolver,
        spec.rosterOf(authority.value),
        input.results,
        spec.parsePayload,
      );
      if (!complete.ok) {
        return ok({ kind: "rejected", reason: describeRosterViolations(complete.error.violations) });
      }
      return ok({
        kind: "proved",
        complete: { authority: authority.value, roster: complete.value },
        slotCount: complete.value.ordered.length,
      });
    },
  });
}

/**
 * Reached only from a proved roster. The unproved cases are still total: a
 * pruned branch or a rejected proof yields a rejection rather than an
 * exception, so route totality survives a future rewiring.
 */
function aggregateNode<A>(spec: PanelOperationSpec<A>) {
  return createTransformNode<ProofEnvelope, PanelOutcome>({
    id: AGGREGATE,
    inputSchema: proofEnvelopeSchema,
    outputSchema: panelOutcomeSchema,
    transform: (envelope) => {
      const proof = envelope[PROVE_ROSTER];
      if (proof === undefined) return ok({ kind: "rejected", reason: "aggregation ran without a roster proof" });
      if (proof.kind !== "proved") return ok({ kind: "rejected", reason: proof.reason });

      const { authority, roster } = proof.complete as Readonly<{ authority: A; roster: never }>;
      const aggregated = spec.aggregate(authority, roster);
      return ok(aggregated.ok
        ? { kind: "aggregated", value: (aggregated as Record<string, unknown>)["value"] }
        : { kind: "rejected", reason: describeAggregateFailure(aggregated) });
    },
  });
}

/**
 * Render every roster violation, not just the first. A partial roster usually
 * fails for more than one reason, and reporting one of them sends the operator
 * round the loop once per missing slot.
 */
function describeRosterViolations(violations: readonly RosterViolation[]): string {
  return violations
    .map((violation) => {
      const detail = Object.entries(violation)
        .filter(([key]) => key !== "kind")
        .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`)
        .join(", ");
      return detail.length === 0 ? violation.kind : `${violation.kind} (${detail})`;
    })
    .join("; ");
}

function describeAggregateFailure(aggregated: Record<string, unknown>): string {
  const error = aggregated["error"];
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>)["message"];
    if (typeof message === "string") return message;
  }
  return "panel aggregation was refused";
}

const rejectNode = createTransformNode<ProofEnvelope, PanelOutcome>({
  id: REJECT,
  inputSchema: proofEnvelopeSchema,
  outputSchema: panelOutcomeSchema,
  transform: (envelope) => {
    const proof = envelope[PROVE_ROSTER];
    if (proof === undefined) return ok({ kind: "rejected", reason: "roster proof produced no result" });
    return ok({
      kind: "rejected",
      reason: proof.kind === "proved" ? "a proved roster reached the rejection branch" : proof.reason,
    });
  },
});

const resultNode = createTransformNode<OutcomeEnvelope, PanelOutcome>({
  id: RESULT,
  inputSchema: outcomeEnvelopeSchema,
  outputSchema: panelOutcomeSchema,
  transform: (envelope) => {
    const decided = envelope[AGGREGATE] ?? envelope[REJECT];
    return ok(decided ?? { kind: "rejected", reason: "neither panel branch produced an outcome" });
  },
});

/** `prove roster → (proved) aggregate | (default) reject → result`. */
export function createPanelOperationDag<A>(
  spec: PanelOperationSpec<A>,
  resolver: PublicationAuthorityResolver,
): DagDef {
  return defineDag({
    id: spec.dagId,
    nodes: {
      [PROVE_ROSTER]: proveRosterNode(spec, resolver),
      [AGGREGATE]: aggregateNode(spec),
      [REJECT]: rejectNode,
      [RESULT]: resultNode,
    },
    edges: [
      { from: DAG_INPUT, to: PROVE_ROSTER },
      {
        from: PROVE_ROSTER,
        to: AGGREGATE,
        when: {
          label: "complete-roster-proved",
          version: 1,
          check: (value): boolean => (value as RosterProof).kind === "proved",
        },
      },
      { from: PROVE_ROSTER, to: REJECT, kind: "default" },
      { from: AGGREGATE, to: RESULT },
      { from: REJECT, to: RESULT },
    ],
    outputNodeId: RESULT,
  });
}

/** Architecture: complete judge roster → candidate ranking. */
export function createArchitecturePanelDag(
  input: Readonly<{
    parseAuthority: PanelOperationSpec<ArchitecturePanelAuthority>["parseAuthority"];
    parsePayload: PanelOperationSpec<ArchitecturePanelAuthority>["parsePayload"];
    resolver: PublicationAuthorityResolver;
  }>,
): DagDef {
  return createPanelOperationDag<ArchitecturePanelAuthority>({
    dagId: "architecture-panel-operations",
    parseAuthority: input.parseAuthority,
    rosterOf: (authority) => authority.judgeRoster as Parameters<typeof parseCompleteRoster>[1],
    parsePayload: input.parsePayload,
    aggregate: (authority, complete) =>
      aggregateArchitecturePanel(authority, complete) as Readonly<{ ok: boolean }> & Record<string, unknown>,
  }, input.resolver);
}

/** Refutation: complete verifier roster → strict-majority tally. */
export function createRefutationPanelDag(
  input: Readonly<{
    parseAuthority: PanelOperationSpec<RefutationPanelAuthority>["parseAuthority"];
    parsePayload: PanelOperationSpec<RefutationPanelAuthority>["parsePayload"];
    resolver: PublicationAuthorityResolver;
  }>,
): DagDef {
  return createPanelOperationDag<RefutationPanelAuthority>({
    dagId: "refutation-panel-operations",
    parseAuthority: input.parseAuthority,
    rosterOf: (authority) => authority.verifierRoster as Parameters<typeof parseCompleteRoster>[1],
    parsePayload: input.parsePayload,
    aggregate: (authority, complete) =>
      tallyRefutationPanel(authority, complete) as Readonly<{ ok: boolean }> & Record<string, unknown>,
  }, input.resolver);
}

export const PANEL_DAG_NODE_IDS = Object.freeze({
  proveRoster: PROVE_ROSTER,
  aggregate: AGGREGATE,
  reject: REJECT,
  result: RESULT,
});
