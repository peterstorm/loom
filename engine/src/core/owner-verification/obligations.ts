/**
 * INV-3 owner: which owned Invariants a Wave or Task owes is decided here, and
 * only here (AD-2, AD-4). Pure: every function is a function of the plan's
 * parsed Invariants or of an `OwnerScope`, the opaque view of a TaskGraph's
 * `owner_obligations` stamp and Task file lists that only this module builds.
 *
 * - `ownerObligationOf` is the one constructor of an Owner Obligation: the
 *   plan derivation and the State File parser both build through it, so a
 *   path playing two roles is refused wherever an obligation is made.
 * - `obligationsFromInvariants` derives the stamp population writes: one
 *   Owner Obligation per owned Invariant, in plan order, `[]` when none is
 *   owned; `obligationsFromPlan` reads the Invariants of whole plan models.
 * - `verifyOwed` is the one home of the owes-mutation rule: the obligations
 *   whose policy is `verify`. An exempt one owes coverage only.
 * - `obligationsDigest` / `obligationsAgree` are the stamp's identity.
 * - `ownerScopeOf` reads a graph into an `OwnerScope`. Callers never hold the
 *   raw stamp, so neither the absent-versus-empty distinction nor the
 *   gate/touch split can be re-encoded outside this module:
 *   - `ownerCheckAuthority` / `ownerVerificationOwed` are the gate scope: an
 *     obligation whose family (owner or a sibling, G5a's `changesFamily`) some
 *     Wave Task changes. A change to the matrix test alone does not trigger
 *     the checks. An absent stamp (a graph populated before owner
 *     verification) owes nothing and has no owner check; a present one, `[]`
 *     included, always has the check.
 *   - `obligationsTouchedBy` is the review-packet and brief scope: an
 *     obligation in which a file list plays any role, matrix test included.
 *   - `stampAgreement` is the gate's drift check: the stamp against the
 *     obligations re-derived from the plan.
 *
 * Roles are classified through `plan-paths.ts`, the one path rule plan
 * validation and the brief already share.
 */

import { match } from "ts-pattern";

import type { PlanInvariant, PlanModels, Task, TaskGraph } from "../../types";
import { canonicalDigest } from "../digest";
import { parseInvariantId, type InvariantId } from "../invariant-id";
import { canonicalStructuralEquals, failure, success, type ArtifactDigest, type DomainResult } from "../orchestration-contract/identity";
import { isPlaceholderExemptionReason } from "../parse-plan-models";
import { isRecord } from "../plain-record";
import { samePlanPath } from "../plan-path-match";
import { changesFamily, invariantRoles, type InvariantRoles, type OwnedInvariant } from "../plan-paths";
import type { SiblingEntryPoint } from "../sibling-entry-point";
import type {
  MutationOwed,
  MutationPolicy,
  OwnerObligation,
  OwnerObligationError,
  OwnerObligationFields,
  OwnerObligationOfFn,
} from "./types";

import type { OwnerCheckAuthority } from "../owner-check-authority";
export type { OwnerCheckAuthority } from "../owner-check-authority";

// ---------------------------------------------------------------------------
// The Owner Obligation constructor and its canonical form
// ---------------------------------------------------------------------------

const canonicalPolicy = (policy: MutationPolicy): MutationPolicy =>
  match(policy)
    .with({ kind: "verify" }, (): MutationPolicy => ({ kind: "verify" }))
    .with({ kind: "exempt" }, ({ reason }): MutationPolicy => ({ kind: "exempt", reason }))
    .exhaustive();

type ObligationField = keyof OwnerObligationFields;

/** One canonicaliser per field, mapped over every field of the type. */
type FieldCanonicalisers = { [Field in ObligationField]: (value: OwnerObligationFields[Field]) => OwnerObligationFields[Field] };

/** How each field is canonicalised. Keyed by every field, so a field added without one fails to compile. */
const CANONICAL_FIELDS: FieldCanonicalisers = {
  invariant: (invariant) => invariant,
  title: (title) => title,
  statement: (statement) => statement,
  owner: (owner) => owner,
  siblings: (siblings) => Object.freeze(siblings.map(({ path, note }) => Object.freeze({ path, note }))),
  matrixTest: (matrixTest) => matrixTest,
  mutation: canonicalPolicy,
};

const FIELD_ORDER = Object.keys(CANONICAL_FIELDS) as readonly ObligationField[];

function canonicalField<Field extends ObligationField>(fields: OwnerObligationFields, field: Field): OwnerObligationFields[Field] {
  const canonicalise: FieldCanonicalisers[Field] = CANONICAL_FIELDS[field];
  return canonicalise(fields[field]);
}

/**
 * A fresh frozen record in the one canonical key order, whatever order a
 * stamp was read back in. The brand's one minting point: callers reach it
 * only through `ownerObligationOf` or with an obligation it already built.
 */
const canonicalObligation = (fields: OwnerObligationFields): OwnerObligation =>
  Object.freeze(Object.fromEntries(FIELD_ORDER.map((field) => [field, canonicalField(fields, field)]))) as OwnerObligation;

/** The first path equal, under the one plan path rule, to an earlier one; undefined when all differ. */
const firstRepeated = (paths: readonly string[]): string | undefined =>
  paths.find((path, index) => paths.slice(0, index).some((earlier) => samePlanPath(earlier, path)));

/** The first path that plays two roles in the family, as the refusal naming it; null when each plays one. */
function roleConflict(fields: OwnerObligationFields): OwnerObligationError | null {
  const { invariant, owner, matrixTest } = fields;
  const siblings = fields.siblings.map(({ path }) => path);
  const ownerSibling = siblings.find((path) => samePlanPath(path, owner));
  if (ownerSibling !== undefined) return { kind: "owner-is-sibling", invariant, path: ownerSibling };
  if (samePlanPath(matrixTest, owner)) return { kind: "matrix-test-is-owner", invariant, path: matrixTest };
  if (siblings.some((path) => samePlanPath(path, matrixTest))) return { kind: "matrix-test-is-sibling", invariant, path: matrixTest };
  const repeated = firstRepeated(siblings);
  return repeated === undefined ? null : { kind: "duplicate-sibling", invariant, path: repeated };
}

export const ownerObligationOf: OwnerObligationOfFn = (fields) => {
  const conflict = roleConflict(fields);
  return conflict === null ? success(canonicalObligation(fields)) : failure(conflict);
};

/** One refusal as a sentence naming the Invariant and the path. */
export const renderOwnerObligationError = (error: OwnerObligationError): string =>
  match(error)
    .with({ kind: "owner-is-sibling" }, ({ invariant, path }) => `${invariant}: '${path}' is both the owner module and a sibling entry point`)
    .with({ kind: "matrix-test-is-owner" }, ({ invariant, path }) => `${invariant}: '${path}' is both the owner module and the matrix test`)
    .with({ kind: "matrix-test-is-sibling" }, ({ invariant, path }) => `${invariant}: '${path}' is both a sibling entry point and the matrix test`)
    .with({ kind: "duplicate-sibling" }, ({ invariant, path }) => `${invariant}: sibling entry point '${path}' is listed twice`)
    .exhaustive();

// ---------------------------------------------------------------------------
// The stamp's wire parser: untrusted JSON to Owner Obligations, through the constructor
// ---------------------------------------------------------------------------

type WireResult<T> = DomainResult<T, string>;

const SIBLING_ENTRY_POINT_FIELDS: readonly (keyof SiblingEntryPoint)[] = ["path", "note"];

/** Unknown fields first (sorted), then missing ones; null when the key set is exactly `fields`. */
function exactFieldsError(record: Readonly<Record<string, unknown>>, fields: readonly string[], label: string): string | null {
  const unknownFields = Object.keys(record).filter((field) => !fields.includes(field));
  if (unknownFields.length > 0) return `${label} contains unknown field(s): ${unknownFields.sort().join(", ")}`;
  const missingFields = fields.filter((field) => !(field in record));
  return missingFields.length > 0 ? `${label} is missing field(s): ${missingFields.join(", ")}` : null;
}

/** Text with a non-whitespace character: every name and path an obligation carries. */
function nonBlankText(raw: unknown, label: string): WireResult<string> {
  return typeof raw === "string" && raw.trim() !== "" ? success(raw) : failure(`${label} must be non-blank text`);
}

/** An Invariant id, minted through its one parser. */
function invariantIdText(raw: unknown, label: string): WireResult<InvariantId> {
  const id = typeof raw === "string" ? parseInvariantId(raw) : null;
  return id !== null && id.ok ? success(id.value) : failure(`${label} must be an Invariant id (INV-N)`);
}

function nullableText(raw: unknown, label: string): WireResult<string | null> {
  return raw === null || typeof raw === "string" ? success(raw) : failure(`${label} must be a string or null`);
}

/** `verify`, or `exempt` with a stated reason: the plan grammar's two states,
 *  so a hand-edited blank or placeholder exemption (`none`, `n/a`, ...) never
 *  loads as a silent opt-out. */
function parseMutationPolicy(raw: unknown, label: string): WireResult<MutationPolicy> {
  if (!isRecord(raw)) return failure(`${label} must be an object`);
  if (raw.kind === "verify") {
    const fieldsError = exactFieldsError(raw, ["kind"], label);
    return fieldsError === null ? success(Object.freeze({ kind: "verify" as const })) : failure(fieldsError);
  }
  if (raw.kind === "exempt") {
    const fieldsError = exactFieldsError(raw, ["kind", "reason"], label);
    if (fieldsError !== null) return failure(fieldsError);
    const reason = nonBlankText(raw.reason, `${label}.reason`);
    if (!reason.ok) return reason;
    if (isPlaceholderExemptionReason(reason.value)) {
      return failure(`${label}.reason must state why the owner is exempt, not a placeholder`);
    }
    return success(Object.freeze({ kind: "exempt" as const, reason: reason.value }));
  }
  return failure(`${label}.kind must be verify or exempt`);
}

function parseSiblingEntryPoint(raw: unknown, label: string): WireResult<SiblingEntryPoint> {
  if (!isRecord(raw)) return failure(`${label} must be an object`);
  const fieldsError = exactFieldsError(raw, SIBLING_ENTRY_POINT_FIELDS, label);
  if (fieldsError !== null) return failure(fieldsError);
  const path = nonBlankText(raw.path, `${label}.path`);
  if (!path.ok) return path;
  const note = nullableText(raw.note, `${label}.note`);
  return note.ok ? success(Object.freeze({ path: path.value, note: note.value })) : note;
}

function parseSiblingEntryPoints(raw: unknown, label: string): WireResult<readonly SiblingEntryPoint[]> {
  if (!Array.isArray(raw)) return failure(`${label} must be an array`);
  const siblings: SiblingEntryPoint[] = [];
  for (const [index, entry] of raw.entries()) {
    const sibling = parseSiblingEntryPoint(entry, `${label}[${index}]`);
    if (!sibling.ok) return sibling;
    siblings.push(sibling.value);
  }
  return success(Object.freeze(siblings));
}

/**
 * One stamped Owner Obligation as an exact, fresh, frozen record, built
 * through `ownerObligationOf`: a stamp the plan grammar could never derive (a
 * path playing two roles) is refused here, not first noticed at the gate.
 */
function parseOwnerObligation(raw: unknown, label: string): WireResult<OwnerObligation> {
  if (!isRecord(raw)) return failure(`${label} must be an object`);
  // The exact key set is `FIELD_ORDER`, the type's own fields: a field added to the type fails to compile here until it is parsed.
  const fieldsError = exactFieldsError(raw, FIELD_ORDER, label);
  if (fieldsError !== null) return failure(fieldsError);
  const invariant = invariantIdText(raw.invariant, `${label}.invariant`);
  if (!invariant.ok) return invariant;
  const title = nonBlankText(raw.title, `${label}.title`);
  if (!title.ok) return title;
  const statement = nullableText(raw.statement, `${label}.statement`);
  if (!statement.ok) return statement;
  const owner = nonBlankText(raw.owner, `${label}.owner`);
  if (!owner.ok) return owner;
  const siblings = parseSiblingEntryPoints(raw.siblings, `${label}.siblings`);
  if (!siblings.ok) return siblings;
  const matrixTest = nonBlankText(raw.matrixTest, `${label}.matrixTest`);
  if (!matrixTest.ok) return matrixTest;
  const mutation = parseMutationPolicy(raw.mutation, `${label}.mutation`);
  if (!mutation.ok) return mutation;
  const obligation = ownerObligationOf({
    invariant: invariant.value,
    title: title.value,
    statement: statement.value,
    owner: owner.value,
    siblings: siblings.value,
    matrixTest: matrixTest.value,
    mutation: mutation.value,
  });
  return obligation.ok ? obligation : failure(`${label}: ${renderOwnerObligationError(obligation.error)}`);
}

/**
 * A present population stamp (AD-2), `[]` included, parsed from untrusted
 * JSON entry by entry; an Invariant appears at most once, since every
 * selection reads it by id. Whether an absent stamp is allowed is the State
 * File's call (FR-004), so absence never reaches here. Each refusal is one
 * indexed `owner_obligations[...]` sentence.
 */
export function parseOwnerObligations(raw: unknown): WireResult<readonly OwnerObligation[]> {
  if (!Array.isArray(raw)) return failure("owner_obligations must be an array");
  const obligations: OwnerObligation[] = [];
  for (const [index, entry] of raw.entries()) {
    const obligation = parseOwnerObligation(entry, `owner_obligations[${index}]`);
    if (!obligation.ok) return obligation;
    if (obligations.some(({ invariant }) => invariant === obligation.value.invariant)) {
      return failure(`owner_obligations names ${obligation.value.invariant} more than once`);
    }
    obligations.push(obligation.value);
  }
  return success(Object.freeze(obligations));
}

// ---------------------------------------------------------------------------
// Derivation from the plan, the owes-mutation rule and the stamp's identity
// ---------------------------------------------------------------------------

/** Why the plan's owned Invariants do not derive a stamp: an obligation refused, or an Invariant owned twice. */
export type ObligationsError = OwnerObligationError | Readonly<{ kind: "duplicate-invariant"; invariant: InvariantId }>;

export const renderObligationsError = (error: ObligationsError): string =>
  error.kind === "duplicate-invariant" ? `${error.invariant} is declared more than once` : renderOwnerObligationError(error);

/** One Owner Obligation per owned Invariant, in plan order; unowned and malformed ones owe nothing. */
export function obligationsFromInvariants(invariants: readonly PlanInvariant[]): DomainResult<readonly OwnerObligation[], ObligationsError> {
  const obligations: OwnerObligation[] = [];
  for (const { id, title, statement, ownership } of invariants) {
    if (ownership.kind !== "owned") continue;
    if (obligations.some(({ invariant }) => invariant === id)) return failure({ kind: "duplicate-invariant", invariant: id });
    const { owner, siblings, matrixTest, mutation } = ownership;
    const built = ownerObligationOf({ invariant: id, title, statement, owner, siblings, matrixTest, mutation });
    if (!built.ok) return built;
    obligations.push(built.value);
  }
  return success(Object.freeze(obligations));
}

/** `obligationsFromInvariants` over the Invariants of a plan's models. */
export const obligationsFromPlan = (models: Pick<PlanModels, "invariants">): DomainResult<readonly OwnerObligation[], ObligationsError> =>
  obligationsFromInvariants(models.invariants);

/** The obligations that owe mutation verification, in order: every one whose policy is `verify`. The brand's one minting point. */
export const verifyOwed = (obligations: readonly OwnerObligation[]): MutationOwed =>
  Object.freeze(obligations.filter(({ mutation }) => mutation.kind === "verify")) as MutationOwed;

/** The stamp's content identity: sha256 over its canonical JSON. */
export function obligationsDigest(obligations: readonly OwnerObligation[]): ArtifactDigest {
  return canonicalDigest(obligations.map(canonicalObligation));
}

/** Whether a stamp and the obligations re-derived from the plan are the same, in the same order. */
export function obligationsAgree(stamped: readonly OwnerObligation[], fromPlan: readonly OwnerObligation[]): boolean {
  return canonicalStructuralEquals(stamped.map(canonicalObligation), fromPlan.map(canonicalObligation));
}

// ---------------------------------------------------------------------------
// The Owner Scope: the stamp as callers see it
// ---------------------------------------------------------------------------

/** The Tasks a selection reads: only their Wave and file list matter. */
type ScopedTask = Pick<Task, "wave" | "file_list">;

/** The graph a scope reads: its Tasks and the stamp. */
type StampedGraph = Readonly<{ tasks: readonly ScopedTask[]; owner_obligations?: TaskGraph["owner_obligations"] }>;

type ScopeState =
  | Readonly<{ kind: "unstamped" }>
  | Readonly<{ kind: "stamped"; obligations: readonly OwnerObligation[]; tasks: readonly ScopedTask[] }>;

const OWNER_SCOPE = Symbol("OwnerScope");

/**
 * A TaskGraph's Owner Obligations as every selection reads them. Opaque: its
 * one key is private to this module, so a caller can only hand it back to
 * the selections here, never filter the stamp itself.
 */
export type OwnerScope = Readonly<{ [OWNER_SCOPE]: ScopeState }>;

export function ownerScopeOf(graph: StampedGraph): OwnerScope {
  const stamp = graph.owner_obligations;
  const state: ScopeState = stamp === undefined
    ? { kind: "unstamped" }
    : { kind: "stamped", obligations: stamp, tasks: graph.tasks };
  return Object.freeze({ [OWNER_SCOPE]: Object.freeze(state) });
}

const familyOf = (obligation: OwnerObligation): OwnedInvariant => ({
  kind: "owned",
  owner: obligation.owner,
  siblings: obligation.siblings,
  matrixTest: obligation.matrixTest,
  mutation: obligation.mutation,
});

const rolesIn = (fileList: readonly string[], obligation: OwnerObligation): InvariantRoles =>
  invariantRoles(fileList, familyOf(obligation));

/** The obligations the Wave owes coverage and mutation for, in stamp order; `[]` without a stamp. */
export function ownerVerificationOwed(scope: OwnerScope, wave: number): readonly OwnerObligation[] {
  const state = scope[OWNER_SCOPE];
  if (state.kind === "unstamped") return [];
  const waveTasks = state.tasks.filter((task) => task.wave === wave);
  return state.obligations.filter((obligation) =>
    waveTasks.some(({ file_list }) => changesFamily(rolesIn(file_list ?? [], obligation))));
}

/**
 * The owner check the Wave's suite carries: `null` exactly when the graph has
 * no stamp; otherwise the stamp's digest and the owed ids, possibly none.
 */
export function ownerCheckAuthority(scope: OwnerScope, wave: number): OwnerCheckAuthority | null {
  const state = scope[OWNER_SCOPE];
  if (state.kind === "unstamped") return null;
  return {
    obligationsDigest: obligationsDigest(state.obligations),
    owed: ownerVerificationOwed(scope, wave).map(({ invariant }) => invariant),
  };
}

/** The touch scope: obligations in which the file list plays any role, matrix test included, in stamp order; `[]` without a stamp. */
export function obligationsTouchedBy(scope: OwnerScope, fileList: readonly string[]): readonly OwnerObligation[] {
  const state = scope[OWNER_SCOPE];
  if (state.kind === "unstamped") return [];
  return state.obligations.filter((obligation) => {
    const roles = rolesIn(fileList, obligation);
    return changesFamily(roles) || roles.matrixTest;
  });
}

/**
 * The stamp against the obligations the plan derives now: `agrees`,
 * `drifted` (any difference, in content or order), `unstamped` (no stamp to
 * agree with), or `underivable` when the plan no longer derives obligations.
 */
export type StampAgreement =
  | Readonly<{ kind: "agrees" }>
  | Readonly<{ kind: "drifted" }>
  | Readonly<{ kind: "unstamped" }>
  | Readonly<{ kind: "underivable"; error: ObligationsError }>;

export function stampAgreement(scope: OwnerScope, models: Pick<PlanModels, "invariants">): StampAgreement {
  const state = scope[OWNER_SCOPE];
  if (state.kind === "unstamped") return { kind: "unstamped" };
  const fromPlan = obligationsFromPlan(models);
  if (!fromPlan.ok) return { kind: "underivable", error: fromPlan.error };
  return obligationsAgree(state.obligations, fromPlan.value) ? { kind: "agrees" } : { kind: "drifted" };
}
