/**
 * The owner-verification wire parsers (G5b AD-1): the observation a
 * completion result or receipt carries, and the owed Invariant ids the
 * authorized owner check binds. They live beside the types they rebuild, so a
 * new verdict variant or infrastructure kind changes this one module; the
 * completion suite only calls `parseOwnerVerificationObservation` and
 * `parseOwedInvariantIds`.
 *
 * Pure and total over unknown input. Each parser rebuilds the value in its
 * canonical shape; a verified mutation run is minted only through
 * `verifiedMutationOf`, so its counts agree wherever it is read back.
 */

import { match } from "ts-pattern";

import { parseInvariantId, type InvariantId } from "../invariant-id";
import { parseArtifactDigest, type ArtifactDigest, type DomainResult, type NonEmpty } from "../orchestration-contract/identity";
import { collectDenseArray, exactRecordErrors, isPlainRecord, parseExactRecord, toElementResult, type UnknownRecord } from "../plain-record";
import { verifiedMutationOf } from "./outcome";
import type {
  CoverageVerdict,
  InvariantVerdict,
  MutationOperator,
  MutationVerdict,
  OwnerInfrastructureFailure,
  OwnerInfrastructureFailureKind,
  OwnerVerificationObservation,
  SurvivorDiagnostic,
} from "./types";

/** Why owner-verification wire data does not parse: one diagnostic per refused field, each naming its path. */
export type OwnerVerificationParseError = Readonly<{ errors: NonEmpty<string> }>;

type Parsed<T> = DomainResult<T, OwnerVerificationParseError>;

const freeze = <const T extends object>(value: T): Readonly<T> => Object.freeze(value);
const freezeArray = <T>(values: readonly T[]): readonly T[] => Object.freeze([...values]);
const success = <T>(value: T): Parsed<T> => freeze({ ok: true, value });
const failure = <T>(errors: readonly string[]): Parsed<T> => freeze({
  ok: false,
  error: freeze({ errors: freezeArray(errors.length === 0 ? ["owner verification is invalid"] : errors) as NonEmpty<string> }),
});
const errorsOf = (results: readonly Parsed<unknown>[]): string[] => results.flatMap((result) => result.ok ? [] : result.error.errors);

function exactRecord(raw: unknown, fields: readonly string[], path: string): Parsed<UnknownRecord> {
  const record = parseExactRecord(raw, fields, path);
  return record.ok ? success(record.value) : failure(exactRecordErrors(record, path, "an object"));
}

function collect<T>(results: readonly Parsed<T>[]): Parsed<readonly T[]> {
  const errors = errorsOf(results);
  return errors.length === 0
    ? success(freezeArray(results.flatMap((result) => result.ok ? [result.value] : [])))
    : failure(errors);
}

function parseDigest(raw: unknown, path: string): Parsed<ArtifactDigest> {
  const parsed = parseArtifactDigest(raw);
  return parsed.ok ? success(parsed.value) : failure([`${path}: ${parsed.error.message}`]);
}

/** Every infrastructure kind the owner check names; the record keeps the set exhaustive. */
const OWNER_INFRASTRUCTURE_KINDS = {
  "plan-unreadable": true, "plan-malformed": true, "plan-drift": true, "runner-missing": true,
  "worktree-failed": true, "spawn-failed": true, "report-missing": true, "report-unreadable": true,
  "matrix-test-not-collected": true, "exit-unexplained-by-report": true, "baseline-timed-out": true,
  "missing-wave-base": true, "coverage-bound-exceeded": true, "real-workspace-changed": true,
  "repository-file-unreadable": true, "unexpected-error": true, "owner-unparseable": true, "no-valid-mutants": true,
} as const satisfies Record<OwnerInfrastructureFailureKind, true>;

/** The fixed mutation operators; the record keeps the set exhaustive. */
const MUTATION_OPERATORS = {
  "condition-negation": true, "comparison-flip": true, "logical-swap": true,
  "boolean-literal-flip": true, "return-value-replacement": true, "statement-removal": true,
} as const satisfies Record<MutationOperator, true>;

const isKey = <K extends string>(keys: Readonly<Record<K, true>>, raw: unknown): raw is K =>
  typeof raw === "string" && Object.hasOwn(keys, raw);

function parseText(raw: unknown, path: string): Parsed<string> {
  return typeof raw === "string" && raw.trim().length > 0 ? success(raw) : failure([`${path} must be a non-blank string`]);
}

/** An Invariant id, minted through its one parser. */
function parseInvariantIdText(raw: unknown, path: string): Parsed<InvariantId> {
  const id = typeof raw === "string" ? parseInvariantId(raw) : null;
  return id !== null && id.ok ? success(id.value) : failure([`${path} must be an Invariant id (INV-N)`]);
}

/** Owed Invariant ids: each an Invariant id, each once, in the authorized (plan) order. */
export function parseOwedInvariantIds(raw: unknown, path: string): Parsed<readonly InvariantId[]> {
  if (!Array.isArray(raw)) return failure([`${path} must be an array`]);
  const ids = collect(raw.map((id, index) => parseInvariantIdText(id, `${path}[${index}]`)));
  if (!ids.ok) return ids;
  return new Set(ids.value).size === ids.value.length ? ids : failure([`${path} names an Invariant more than once`]);
}

function parseTexts(raw: unknown, path: string): Parsed<NonEmpty<string>> {
  if (!Array.isArray(raw) || raw.length === 0) return failure([`${path} must be a non-empty array`]);
  const texts = collect(raw.map((entry, index) => parseText(entry, `${path}[${index}]`)));
  return texts.ok ? success(texts.value as NonEmpty<string>) : texts;
}

function parseCount(raw: unknown, path: string): Parsed<number> {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
    ? success(raw)
    : failure([`${path} must be a non-negative safe integer`]);
}

function parseOwnerInfrastructureFailure(raw: unknown, path: string): Parsed<OwnerInfrastructureFailure> {
  const record = exactRecord(raw, ["kind", "detail"], path);
  if (!record.ok) return record;
  const detail = parseText(record.value.detail, `${path}.detail`);
  if (!isKey(OWNER_INFRASTRUCTURE_KINDS, record.value.kind)) {
    return failure([`${path}.kind must be an owner-verification infrastructure kind`, ...errorsOf([detail])]);
  }
  return detail.ok ? success(freeze({ kind: record.value.kind, detail: detail.value })) : detail;
}

/** A `{ kind, <field> }` variant whose one field the given parser reads. */
function parseTagged<T, V extends object>(
  raw: UnknownRecord,
  path: string,
  field: string,
  parse: (raw: unknown, path: string) => Parsed<T>,
  build: (value: T) => V,
): Parsed<V> {
  const record = exactRecord(raw, ["kind", field], path);
  if (!record.ok) return record;
  const parsed = parse(record.value[field], `${path}.${field}`);
  return parsed.ok ? success(freeze(build(parsed.value))) : parsed;
}

function parseCoverageVerdict(raw: unknown, path: string): Parsed<CoverageVerdict> {
  if (!isPlainRecord(raw)) return failure([`${path} must be an object`]);
  if (raw.kind === "covered") {
    const record = exactRecord(raw, ["kind"], path);
    return record.ok ? success(freeze({ kind: "covered" })) : record;
  }
  if (raw.kind === "missing") return parseTagged(raw, path, "paths", parseTexts, (paths): CoverageVerdict => ({ kind: "missing", paths }));
  return raw.kind === "infrastructure"
    ? parseTagged(raw, path, "failure", parseOwnerInfrastructureFailure, (failure): CoverageVerdict => ({ kind: "infrastructure", failure }))
    : failure([`${path}.kind must be covered, missing or infrastructure`]);
}

function parseSurvivor(raw: unknown, path: string): Parsed<SurvivorDiagnostic> {
  const record = exactRecord(raw, ["mutantId", "operator", "line", "column", "original", "replacement"], path);
  if (!record.ok) return record;
  const { mutantId, operator, line, column, original, replacement } = record.value;
  const id = parseText(mutantId, `${path}.mutantId`);
  const errors = errorsOf([id]);
  if (!isKey(MUTATION_OPERATORS, operator)) errors.push(`${path}.operator must be one of the fixed mutation operators`);
  for (const [name, position] of [["line", line], ["column", column]] as const) {
    if (!(typeof position === "number" && Number.isSafeInteger(position) && position >= 1)) errors.push(`${path}.${name} must be a positive integer`);
  }
  if (typeof original !== "string" || typeof replacement !== "string") errors.push(`${path}.original and .replacement must be strings`);
  return errors.length === 0 && id.ok && isKey(MUTATION_OPERATORS, operator)
    ? success(freeze({
        mutantId: id.value, operator, line: line as number, column: column as number,
        original: original as string, replacement: replacement as string,
      }))
    : failure(errors);
}

const VERIFIED_MUTATION_FIELDS = ["kind", "generated", "killed", "timedOut", "invalid", "survivors", "unmutated", "ownerChangedInWave"] as const;

/** A verified run, re-minted through its one constructor: `generated` must be the count its tallies derive. */
function parseVerifiedMutation(raw: unknown, path: string): Parsed<MutationVerdict> {
  const record = exactRecord(raw, VERIFIED_MUTATION_FIELDS, path);
  if (!record.ok) return record;
  const counts = collect((["generated", "killed", "timedOut", "invalid", "unmutated"] as const)
    .map((field) => parseCount(record.value[field], `${path}.${field}`)));
  const survivors = collectDenseArray(record.value.survivors, `${path}.survivors`, (entry, entryPath) =>
    toElementResult(parseSurvivor(entry, entryPath)));
  const errors = errorsOf([counts]);
  if (survivors.kind === "not-array") errors.push(`${path}.survivors must be an array`);
  else errors.push(...survivors.errors);
  if (typeof record.value.ownerChangedInWave !== "boolean") errors.push(`${path}.ownerChangedInWave must be a boolean`);
  if (errors.length > 0 || !counts.ok || survivors.kind === "not-array") return failure(errors);
  const [generated, killed, timedOut, invalid, unmutated] = counts.value as readonly number[];
  const built = verifiedMutationOf({
    killed: killed!, timedOut: timedOut!, invalid: invalid!, survivors: freezeArray(survivors.values),
    unmutated: unmutated!, ownerChangedInWave: record.value.ownerChangedInWave as boolean,
  });
  if (!built.ok) return failure([`${path} is not a verified mutation run: ${built.error.kind}`]);
  return built.value.generated === generated ? success(built.value) : failure([`${path}.generated must equal the mutants its tallies count`]);
}

function parseMutationVerdict(raw: unknown, path: string): Parsed<MutationVerdict> {
  if (!isPlainRecord(raw)) return failure([`${path} must be an object`]);
  return match(raw.kind)
    .with("exempt", () => parseTagged(raw, path, "reason", parseText, (reason): MutationVerdict => ({ kind: "exempt", reason })))
    .with("red-baseline", () => parseTagged(raw, path, "failures", parseTexts, (failures): MutationVerdict => ({ kind: "red-baseline", failures })))
    .with("infrastructure", () => parseTagged(raw, path, "failure", parseOwnerInfrastructureFailure, (failure): MutationVerdict => ({ kind: "infrastructure", failure })))
    .with("verified", () => parseVerifiedMutation(raw, path))
    .otherwise(() => failure([`${path}.kind must be exempt, red-baseline, verified or infrastructure`]));
}

function parseInvariantVerdict(raw: unknown, path: string): Parsed<InvariantVerdict> {
  const record = exactRecord(raw, ["invariant", "title", "owner", "matrixTest", "coverage", "mutation"], path);
  if (!record.ok) return record;
  const invariant = parseInvariantIdText(record.value.invariant, `${path}.invariant`);
  const title = parseText(record.value.title, `${path}.title`);
  const owner = parseText(record.value.owner, `${path}.owner`);
  const matrixTest = parseText(record.value.matrixTest, `${path}.matrixTest`);
  const coverage = parseCoverageVerdict(record.value.coverage, `${path}.coverage`);
  const mutation = parseMutationVerdict(record.value.mutation, `${path}.mutation`);
  const errors = errorsOf([invariant, title, owner, matrixTest, coverage, mutation]);
  return errors.length === 0 && invariant.ok && title.ok && owner.ok && matrixTest.ok && coverage.ok && mutation.ok
    ? success(freeze({
        invariant: invariant.value, title: title.value, owner: owner.value, matrixTest: matrixTest.value,
        coverage: coverage.value, mutation: mutation.value,
      }))
    : failure(errors);
}

function parseVerifiedObservation(raw: UnknownRecord, path: string): Parsed<OwnerVerificationObservation> {
  const record = exactRecord(raw, ["kind", "obligationsDigest", "boundMs", "verdicts"], path);
  if (!record.ok) return record;
  const obligations = parseDigest(record.value.obligationsDigest, `${path}.obligationsDigest`);
  const boundMs = parseCount(record.value.boundMs, `${path}.boundMs`);
  const verdicts = collectDenseArray(record.value.verdicts, `${path}.verdicts`, (entry, entryPath) =>
    toElementResult(parseInvariantVerdict(entry, entryPath)));
  const errors = errorsOf([obligations, boundMs]);
  if (verdicts.kind === "not-array") errors.push(`${path}.verdicts must be an array`);
  else errors.push(...verdicts.errors);
  if (errors.length > 0 || !obligations.ok || !boundMs.ok || verdicts.kind === "not-array") return failure(errors);
  const ids = verdicts.values.map(({ invariant }) => invariant);
  if (new Set(ids).size !== ids.length) return failure([`${path}.verdicts names an Invariant more than once`]);
  return success(freeze({
    kind: "verified", obligationsDigest: obligations.value, boundMs: boundMs.value, verdicts: freezeArray(verdicts.values),
  }));
}

/** The owner-verification observation at `path`, rebuilt in its canonical shape: `verified` or `unavailable`. */
export function parseOwnerVerificationObservation(raw: unknown, path: string): Parsed<OwnerVerificationObservation> {
  if (!isPlainRecord(raw)) return failure([`${path} must be an object`]);
  if (raw.kind === "verified") return parseVerifiedObservation(raw, path);
  return raw.kind === "unavailable"
    ? parseTagged(raw, path, "failure", parseOwnerInfrastructureFailure, (failure): OwnerVerificationObservation => ({ kind: "unavailable", failure }))
    : failure([`${path}.kind must be verified or unavailable`]);
}
