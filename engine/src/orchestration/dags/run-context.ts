/**
 * Building the Fugue node context for an operation DAG.
 *
 * Fugue ids are constrained to `[A-Za-z0-9_:-]` and reject the `.` that every
 * Loom run id carries (`run.RIzvYedN0m`). The two id spaces are therefore not
 * interchangeable, and the mapping between them has to be explicit: a lowering
 * that silently dropped or replaced characters could map two distinct Loom
 * runs onto one Fugue run id and cross their traces.
 *
 * `.` becomes `:` — a character Fugue permits and Loom's own run ids never
 * contain, so the lowering is injective and reversible. Anything else outside
 * the permitted set is rejected rather than scrubbed.
 */

import { makeNodeContext, type NodeContext } from "@fuguejs/framework";
import { canonicalRecord, type DomainResult, type OrchestrationRunId } from "../../core/orchestration-contract";

/** Characters Fugue accepts in an id. */
const FUGUE_SAFE = /^[A-Za-z0-9_:-]{1,128}$/;
/**
 * Loom run ids: the Fugue-safe set plus `.`, and deliberately WITHOUT `:`.
 * Excluding the target separator is what makes the lowering injective — if a
 * source id could already contain `:`, then `run.a:b` and `run:a.b` would both
 * lower to `run:a:b` and two distinct runs would share one Fugue identity.
 */
const LOOM_RUN_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export type FugueRunId = string & { readonly __brand: "FugueRunId" };

export type RunContextError = Readonly<{
  kind: "invalid-fugue-run-context";
  field: string;
  message: string;
}>;

const failure = <T>(field: string, message: string): DomainResult<T, RunContextError> =>
  ({ ok: false, error: canonicalRecord({ kind: "invalid-fugue-run-context" as const, field, message }) });

/**
 * Lower a Loom run id into Fugue's id space. Injective: `.` → `:` is the only
 * substitution, and a run id already containing `:` keeps it, so two different
 * Loom ids cannot collide on one Fugue id.
 */
export function lowerRunId(runId: OrchestrationRunId): DomainResult<FugueRunId, RunContextError> {
  if (!LOOM_RUN_ID.test(runId)) {
    return failure("runId", `run id carries characters Fugue cannot represent: ${runId}`);
  }
  const lowered = runId.replaceAll(".", ":");
  return FUGUE_SAFE.test(lowered)
    ? { ok: true, value: lowered as FugueRunId }
    : failure("runId", `lowered run id is not a valid Fugue id: ${lowered}`);
}

/**
 * Build the node context an operation DAG runs under. Capabilities are passed
 * through unchanged: a node still only receives what it declares in
 * `requires`, so handing the context a capability does not widen any node that
 * did not ask for it.
 */
export function createOperationContext(input: Readonly<{
  runId: OrchestrationRunId;
  dagId: string;
  capabilities?: Readonly<Record<string, unknown>>;
}>): DomainResult<NodeContext, RunContextError> {
  const lowered = lowerRunId(input.runId);
  if (!lowered.ok) return lowered;
  if (!FUGUE_SAFE.test(input.dagId)) {
    return failure("dagId", `dag id is not a valid Fugue id: ${input.dagId}`);
  }
  return {
    ok: true,
    value: makeNodeContext({
      runId: lowered.value,
      dagId: input.dagId,
      ...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
    }),
  };
}
