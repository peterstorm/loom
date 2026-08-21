/**
 * Remediation operation DAGs.
 *
 * Two static graphs: a path audit that turns frozen authority plus observed
 * repository state into an `AuditedPathSet`, and a staged-set check that
 * refuses to emit an installation intent unless the staged set is exactly the
 * audited one.
 *
 * The routing is the safety property. The only edge reaching the installation
 * intent is conditional on the equality check passing; every other outcome
 * takes the default edge to a blocked result. Staging therefore cannot be
 * reached by any path that skipped the audit, and the audit itself is what
 * establishes `audited == dirty` before this graph compares `audited ==
 * staged`.
 *
 * Nodes are pure transforms with `requires: []` — no filesystem, no process,
 * no State File. The domain parsers they call need a publication resolver, so
 * the DAGs are built once with that dependency bound rather than smuggling a
 * capability into a validation node.
 */

import { z } from "zod";
import { DAG_INPUT, createTransformNode, defineDag, ok, type DagDef } from "@fuguejs/framework";
import {
  auditRemediationPaths,
  compareExactPathSets,
  parseAuditedPathSet,
  parseRemediationPathAuthority,
  parseRemediationPathSet,
  parseRepositorySnapshotWitness,
  type StandaloneResultPublicationAuthorityResolver,
} from "../../core/remediation-machine";

const AUDIT_PATHS = "audit-paths";
const AUDIT_ROUTE = "audit-route";
const VERIFY_STAGED = "verify-staged-set";
const EMIT_INTENT = "emit-installation-intent";
const BLOCK = "blocked-installation";
const DECIDE = "installation-decision";

export type RemediationAuditInput = Readonly<{
  authority: unknown;
  expectedDirtyPaths: unknown;
  actualDirtyPaths: unknown;
  preexistingStagedPaths: unknown;
  repositoryWitness: unknown;
}>;

export type RemediationAuditOutcome =
  | Readonly<{ kind: "audited"; auditedPathSet: unknown; pathCount: number }>
  | Readonly<{ kind: "blocked"; reason: string }>;

const auditInputSchema = z.object({
  authority: z.unknown(),
  expectedDirtyPaths: z.unknown(),
  actualDirtyPaths: z.unknown(),
  preexistingStagedPaths: z.unknown(),
  repositoryWitness: z.unknown(),
}) as unknown as z.ZodType<RemediationAuditInput>;

const auditOutcomeSchema = z.union([
  z.object({ kind: z.literal("audited"), auditedPathSet: z.unknown(), pathCount: z.number().int().nonnegative() }),
  z.object({ kind: z.literal("blocked"), reason: z.string().min(1) }),
]) as unknown as z.ZodType<RemediationAuditOutcome>;

const blocked = (reason: string): RemediationAuditOutcome => ({ kind: "blocked", reason });

/**
 * Pure audit node. Every input is parsed before use, and a parse failure
 * blocks: re-running cannot make malformed authority valid, so this is a
 * terminal outcome rather than a retry.
 */
function auditPathsNode(resolver: StandaloneResultPublicationAuthorityResolver) {
  return createTransformNode<RemediationAuditInput, RemediationAuditOutcome>({
    id: AUDIT_PATHS,
    inputSchema: auditInputSchema,
    outputSchema: auditOutcomeSchema,
    transform: (input) => {
      const authority = parseRemediationPathAuthority(input.authority, resolver);
      if (!authority.ok) return ok(blocked(authority.error.message));
      const witness = parseRepositorySnapshotWitness(input.repositoryWitness);
      if (!witness.ok) return ok(blocked(witness.error.message));

      const audited = auditRemediationPaths(authority.value, {
        expectedDirtyPaths: input.expectedDirtyPaths,
        actualDirtyPaths: input.actualDirtyPaths,
        preexistingStagedPaths: input.preexistingStagedPaths,
        repositoryWitness: witness.value,
      });
      return audited.ok
        ? ok({ kind: "audited", auditedPathSet: audited.value, pathCount: audited.value.paths.paths.length })
        : ok(blocked(audited.error.message));
    },
  });
}

const auditRouteNode = createTransformNode<RemediationAuditOutcome, RemediationAuditOutcome>({
  id: AUDIT_ROUTE,
  inputSchema: auditOutcomeSchema,
  outputSchema: auditOutcomeSchema,
  transform: (outcome) => ok(outcome),
});

/** `path audit → audited set | blocked`. */
export function createRemediationAuditDag(
  resolver: StandaloneResultPublicationAuthorityResolver,
): DagDef {
  return defineDag({
    id: "remediation-path-audit",
    nodes: { [AUDIT_PATHS]: auditPathsNode(resolver), [AUDIT_ROUTE]: auditRouteNode },
    edges: [
      { from: DAG_INPUT, to: AUDIT_PATHS },
      { from: AUDIT_PATHS, to: AUDIT_ROUTE },
    ],
    outputNodeId: AUDIT_ROUTE,
  });
}

// ---------------------------------------------------------------------------
// Staged-set verification
// ---------------------------------------------------------------------------

export type StagedSetInput = Readonly<{
  auditedPathSet: unknown;
  stagedPaths: unknown;
}>;

export type StagedSetVerdict =
  | Readonly<{ kind: "verified"; paths: readonly string[]; digest: string }>
  | Readonly<{ kind: "blocked"; reason: string }>;

const stagedInputSchema = z.object({
  auditedPathSet: z.unknown(),
  stagedPaths: z.unknown(),
}) as unknown as z.ZodType<StagedSetInput>;

const stagedVerdictSchema = z.union([
  z.object({ kind: z.literal("verified"), paths: z.array(z.string()), digest: z.string() }),
  z.object({ kind: z.literal("blocked"), reason: z.string().min(1) }),
]) as unknown as z.ZodType<StagedSetVerdict>;

export type InstallationDecision =
  | Readonly<{ kind: "install-intent"; paths: readonly string[]; digest: string }>
  | Readonly<{ kind: "blocked"; reason: string }>;

const installationDecisionSchema = z.union([
  z.object({ kind: z.literal("install-intent"), paths: z.array(z.string()), digest: z.string() }),
  z.object({ kind: z.literal("blocked"), reason: z.string().min(1) }),
]) as unknown as z.ZodType<InstallationDecision>;

/**
 * `audited == staged`, compared as exact parser-produced sets. Staging a path
 * nobody authorised and omitting a path that was authorised are both failures,
 * and neither may reach an install. The audit upstream already established
 * `audited == dirty`, so passing here completes the three-way equality.
 */
function verifyStagedSetNode(resolver: StandaloneResultPublicationAuthorityResolver) {
  return createTransformNode<StagedSetInput, StagedSetVerdict>({
    id: VERIFY_STAGED,
    inputSchema: stagedInputSchema,
    outputSchema: stagedVerdictSchema,
    transform: (input) => {
      const audited = parseAuditedPathSet(input.auditedPathSet, resolver);
      if (!audited.ok) return ok({ kind: "blocked", reason: audited.error });
      const staged = parseRemediationPathSet(input.stagedPaths, "stagedPaths");
      if (!staged.ok) return ok({ kind: "blocked", reason: staged.error.message });

      const equality = compareExactPathSets(audited.value.paths, staged.value);
      return equality.ok
        ? ok({
          kind: "verified",
          paths: [...audited.value.paths.paths] as readonly string[],
          digest: audited.value.paths.digest as string,
        })
        : ok({ kind: "blocked", reason: `audited vs staged: ${equality.error.message}` });
    },
  });
}

/**
 * A conditional or default edge makes its source an OPTIONAL incoming source,
 * and any optional source switches Fugue's input shape from the bare upstream
 * value to an object keyed by source node id. Branch nodes therefore receive
 * an envelope whose single key may be absent when the branch was not taken.
 * Modelling that explicitly is what keeps the pruned branch representable
 * instead of surfacing as a schema failure at run time.
 */
type BranchEnvelope<K extends string, T> = Readonly<Partial<Record<K, T>>>;

// The branch envelopes validate their wrapped member with the REAL schema.
// Declaring it `z.unknown().optional()` behind an `as unknown as
// z.ZodType<Envelope>` cast made the static type assert a well-formed
// StagedSetVerdict/InstallationDecision while the runtime accepted any value at
// all — at the one boundary these DAGs exist to parse. The transforms below then
// read `.kind`, `.paths`, `.digest` and `.reason` off it with nothing having
// checked any of them. `satisfies` keeps the static type honest without
// silencing the runtime check, which is the form `panel-operations.ts` already
// carries for the identical defect.
const branchEnvelopeSchema = z.object({
  [VERIFY_STAGED]: stagedVerdictSchema.optional(),
}) satisfies z.ZodType<BranchEnvelope<typeof VERIFY_STAGED, StagedSetVerdict>>;

const decisionEnvelopeSchema = z.object({
  [EMIT_INTENT]: installationDecisionSchema.optional(),
  [BLOCK]: installationDecisionSchema.optional(),
}) satisfies z.ZodType<Readonly<Partial<Record<string, InstallationDecision>>>>;

/**
 * Reached only by the conditional edge. The non-verified and pruned cases are
 * still handled rather than thrown: a total node keeps route totality true
 * even if the edges are ever rewired.
 */
const emitIntentNode = createTransformNode<
  BranchEnvelope<typeof VERIFY_STAGED, StagedSetVerdict>,
  InstallationDecision
>({
  id: EMIT_INTENT,
  inputSchema: branchEnvelopeSchema,
  outputSchema: installationDecisionSchema,
  transform: (envelope) => {
    const verdict = envelope[VERIFY_STAGED];
    if (verdict === undefined) return ok({ kind: "blocked", reason: "installation branch ran without a staged-set verdict" });
    return ok(verdict.kind === "verified"
      ? { kind: "install-intent", paths: verdict.paths, digest: verdict.digest }
      : { kind: "blocked", reason: "installation intent reached from a non-verified staged set" });
  },
});

/**
 * The default branch. It carries the block reason forward unchanged; only the
 * conditional branch can mint an install intent.
 */
const blockedNode = createTransformNode<
  BranchEnvelope<typeof VERIFY_STAGED, StagedSetVerdict>,
  InstallationDecision
>({
  id: BLOCK,
  inputSchema: branchEnvelopeSchema,
  outputSchema: installationDecisionSchema,
  transform: (envelope) => {
    const verdict = envelope[VERIFY_STAGED];
    if (verdict === undefined) return ok({ kind: "blocked", reason: "staged-set verification produced no verdict" });
    return ok({
      kind: "blocked",
      reason: verdict.kind === "verified"
        ? "verified staged set reached the blocked branch"
        : verdict.reason,
    });
  },
});

/**
 * Both branches converge here, and exactly one of them ran — the other was
 * pruned and arrives as `undefined`. Fugue requires the output node to be
 * reachable along unconditional and default edges, which forces the graph to
 * have one terminal decision rather than an output that exists only when a
 * predicate happened to match.
 */
const decideNode = createTransformNode<
  Readonly<Partial<Record<string, InstallationDecision>>>,
  InstallationDecision
>({
  id: DECIDE,
  inputSchema: decisionEnvelopeSchema,
  outputSchema: installationDecisionSchema,
  transform: (envelope) => {
    const decided = envelope[EMIT_INTENT] ?? envelope[BLOCK];
    return ok(decided ?? { kind: "blocked", reason: "neither remediation branch produced a decision" });
  },
});

/** `verify → (verified) install intent | (default) blocked → decision`. */
export function createRemediationStagedSetDag(
  resolver: StandaloneResultPublicationAuthorityResolver,
): DagDef {
  return defineDag({
    id: "remediation-staged-set",
    nodes: {
      [VERIFY_STAGED]: verifyStagedSetNode(resolver),
      [EMIT_INTENT]: emitIntentNode,
      [BLOCK]: blockedNode,
      [DECIDE]: decideNode,
    },
    edges: [
      { from: DAG_INPUT, to: VERIFY_STAGED },
      {
        from: VERIFY_STAGED,
        to: EMIT_INTENT,
        when: {
          label: "staged-set-verified",
          version: 1,
          check: (value): boolean => (value as StagedSetVerdict).kind === "verified",
        },
      },
      { from: VERIFY_STAGED, to: BLOCK, kind: "default" },
      { from: EMIT_INTENT, to: DECIDE },
      { from: BLOCK, to: DECIDE },
    ],
    outputNodeId: DECIDE,
  });
}

export const REMEDIATION_DAG_NODE_IDS = Object.freeze({
  auditPaths: AUDIT_PATHS,
  auditRoute: AUDIT_ROUTE,
  verifyStaged: VERIFY_STAGED,
  emitIntent: EMIT_INTENT,
  blocked: BLOCK,
  decide: DECIDE,
});
