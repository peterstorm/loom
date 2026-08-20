import { createHash } from "node:crypto";
import { compareStrings } from "./ordering";
import { frozenSet } from "./frozen";
import {
  canonicalRecord,
  parseArtifactDigest,
  parseArtifactRef,
  parseEffectId,
  parseOrchestrationRunId,
  reconcileEffectReceipt,
  type ArtifactDigest,
  type ArtifactRef,
  type ArtifactSetPublished,
  type DomainResult,
  type EffectId,
  type InstallVerifiedIndex,
  type OrchestrationRunId,
  type PublishArtifactSet,
  type VerifiedIndexInstalled,
} from "./orchestration-contract";
import {
  STANDALONE_RESULT_SLOT,
  serializeAdjudicatedStandaloneReview,
} from "./standalone-review";
import {
  isAuthoritativeStandaloneReviewResult,
  type AuthoritativeStandaloneReviewResult,
} from "./standalone-review-machine";
import { parseReviewPath } from "./review-packet";

const ok = <T, E = never>(value: T): DomainResult<T, E> => canonicalRecord({ ok: true, value });
const fail = <T = never, E = never>(error: E): DomainResult<T, E> => canonicalRecord({ ok: false, error });

const PRESENT_CHANGES = ["added", "modified", "renamed-to"] as const;
const ABSENT_CHANGES = ["renamed-from", "deleted", "absent"] as const;
const PATH_CHANGES = [...PRESENT_CHANGES, ...ABSENT_CHANGES] as const;
export type PresentRemediationPathChange = (typeof PRESENT_CHANGES)[number];
export type AbsentRemediationPathChange = (typeof ABSENT_CHANGES)[number];
export type RemediationPathChange = (typeof PATH_CHANGES)[number];

const PATH_NODE_KINDS = ["file", "missing", "symlink", "directory", "other"] as const;

const isPresentChange = (change: RemediationPathChange): change is PresentRemediationPathChange =>
  includes(PRESENT_CHANGES, change);

const isAbsentChange = (change: RemediationPathChange): change is AbsentRemediationPathChange =>
  includes(ABSENT_CHANGES, change);

/** Fixed policy data, never caller-extended or caller-reduced. */
export const REMEDIATION_EXCLUDED_LAYOUTS = Object.freeze([
  ".git metadata",
  ".claude/state",
  ".claude/reviews (packets, review runs, panel runs, and review-and-fix runs)",
  ".claude/specs/<spec>/panel-runs",
  ".claude/**/{panel-runs,review-runs,review-and-fix-runs,wave-gate-runs,orchestration-runs}",
] as const);

const includes = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

function immutableArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function digestBytes(bytes: Uint8Array): ArtifactDigest {
  const parsed = parseArtifactDigest(createHash("sha256").update(bytes).digest("hex"));
  if (!parsed.ok) throw new Error("internal SHA-256 construction failed");
  return parsed.value;
}

function digestText(value: string): ArtifactDigest {
  return digestBytes(Buffer.from(value, "utf8"));
}

function digestJson(value: unknown): ArtifactDigest {
  return digestText(JSON.stringify(value));
}

function exactRecord(
  raw: unknown,
  fields: readonly string[],
  label: string,
): DomainResult<Readonly<Record<string, unknown>>, string> {
  if (typeof raw !== "object" || raw === null) return fail(`${label} must be an object`);
  try {
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) {
      return fail(`${label} must be a plain own-data object`);
    }
    const keys = Reflect.ownKeys(raw);
    if (keys.some((key) => typeof key === "symbol")) return fail(`${label} must not contain symbol fields`);
    const stringKeys = keys as string[];
    const extras = stringKeys.filter((key) => !fields.includes(key)).sort(compareStrings);
    const missing = fields.filter((key) => !stringKeys.includes(key));
    if (extras.length > 0) return fail(`${label} contains unknown field(s): ${extras.join(", ")}`);
    if (missing.length > 0) return fail(`${label} is missing field(s): ${missing.join(", ")}`);
    const values = Object.create(null) as Record<string, unknown>;
    for (const key of stringKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return fail(`${label}.${key} must be an enumerable own data field`);
      }
      Object.defineProperty(values, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return ok(Object.freeze(values));
  } catch {
    return fail(`${label} could not be safely inspected`);
  }
}

function denseArray(raw: unknown, label: string): DomainResult<readonly unknown[], string> {
  try {
    if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) {
      return fail(`${label} must be a plain array`);
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(raw, "length");
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
        typeof lengthDescriptor.value !== "number" || !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 || lengthDescriptor.value > 1_048_576) {
      return fail(`${label} has an invalid or excessive length`);
    }
    const length = lengthDescriptor.value;
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== length + 1 || keys[length] !== "length") {
      return fail(`${label} must be a dense array without extra fields`);
    }
    const values: unknown[] = [];
    for (let index = 0; index < length; index++) {
      if (keys[index] !== String(index)) return fail(`${label} has a hole at index ${index}`);
      const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return fail(`${label}[${index}] must be an enumerable own data field`);
      }
      values.push(descriptor.value);
    }
    return ok(Object.freeze(values));
  } catch {
    return fail(`${label} could not be safely inspected`);
  }
}

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function pathIsWithin(path: CanonicalRepositoryRelativePath, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * The canonical directory names that hold Run Directories. ONE definition,
 * shared by every consumer: remediation exclusion policy uses it to keep run
 * evidence out of a staged set, and `grandfathered-spawn-model` uses it to
 * anchor a spawn-declared run directory. A second copy in either place is a
 * silent divergence between "this path is run evidence" and "this path may be
 * trusted as run evidence".
 */
export const RUN_LAYOUT_COMPONENTS: ReadonlySet<string> = frozenSet([
  "panel-runs",
  "review-runs",
  "review-and-fix-runs",
  "wave-gate-runs",
  "orchestration-runs",
]);

/** Canonical policy predicate — the ONE copy, shared by the freeze,
 *  registration, audit, replay, and temporary-index parsers. */
export function isExcludedRemediationPath(path: CanonicalRepositoryRelativePath): boolean {
  if (pathIsWithin(path, ".git") || pathIsWithin(path, ".claude/state") ||
      pathIsWithin(path, ".claude/reviews")) return true;
  const components = path.split("/");
  if (components[0] !== ".claude") return false;
  // `.some` already covers every component past the first, `panel-runs`
  // included — a narrower `components[3] === "panel-runs"` tail below it could
  // never be reached.
  return components.some((component, index) => index > 0 && RUN_LAYOUT_COMPONENTS.has(component));
}

const EXCLUSION_POLICY_DIGEST = digestJson(REMEDIATION_EXCLUDED_LAYOUTS);

declare const CANONICAL_REPOSITORY_RELATIVE_PATH: unique symbol;
export type CanonicalRepositoryRelativePath = string & {
  readonly [CANONICAL_REPOSITORY_RELATIVE_PATH]: true;
};

export type RemediationPathError = Readonly<{
  kind: "invalid-remediation-path";
  field: string;
  message: string;
}>;

/** Parses one canonical identity while preserving valid literal Git filename characters. */
export function parseCanonicalRepositoryRelativePath(
  raw: unknown,
  field = "path",
): DomainResult<CanonicalRepositoryRelativePath, RemediationPathError> {
  if (typeof raw === "string" && (raw.includes("\0") || raw.includes("\r") || raw.includes("\n"))) {
    return fail(canonicalRecord({
      kind: "invalid-remediation-path",
      field,
      message: `${field} must not contain NUL, CR, or LF`,
    }));
  }
  const parsed = parseReviewPath(raw, field);
  if (!parsed.ok) {
    return fail(canonicalRecord({
      kind: "invalid-remediation-path",
      field,
      message: parsed.errors.join("; "),
    }));
  }
  return ok(parsed.value as unknown as CanonicalRepositoryRelativePath);
}

export type RemediationPathSet = Readonly<{
  paths: readonly CanonicalRepositoryRelativePath[];
  digest: ArtifactDigest;
}>;

export type RemediationPathSetError = Readonly<{
  kind: "invalid-remediation-path-set";
  field: string;
  duplicates: readonly CanonicalRepositoryRelativePath[];
  errors: readonly RemediationPathError[];
  message: string;
}>;

const pathSetCache = new WeakSet<object>();

export function parseRemediationPathSet(
  raw: unknown,
  field = "paths",
  options: Readonly<{ nonEmpty?: boolean }> = {},
): DomainResult<RemediationPathSet, RemediationPathSetError> {
  const entries = denseArray(raw, field);
  if (!entries.ok) {
    return fail(canonicalRecord({
      kind: "invalid-remediation-path-set",
      field,
      duplicates: Object.freeze([]),
      errors: Object.freeze([]),
      message: entries.error,
    }));
  }
  const paths: CanonicalRepositoryRelativePath[] = [];
  const errors: RemediationPathError[] = [];
  for (let index = 0; index < entries.value.length; index++) {
    const parsed = parseCanonicalRepositoryRelativePath(entries.value[index], `${field}[${index}]`);
    if (parsed.ok) paths.push(parsed.value);
    else errors.push(parsed.error);
  }
  const counts = new Map<CanonicalRepositoryRelativePath, number>();
  for (const path of paths) counts.set(path, (counts.get(path) ?? 0) + 1);
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([path]) => path)
    .sort(compareStrings);
  if (options.nonEmpty && entries.value.length === 0) {
    errors.push(canonicalRecord({
      kind: "invalid-remediation-path",
      field,
      message: `${field} must be non-empty`,
    }));
  }
  if (errors.length > 0 || duplicates.length > 0) {
    return fail(canonicalRecord({
      kind: "invalid-remediation-path-set",
      field,
      duplicates: immutableArray(duplicates),
      errors: immutableArray(errors),
      message: [
        ...errors.map(({ message }) => message),
        ...duplicates.map((path) => `${field} repeats path '${path}'`),
      ].join("; "),
    }));
  }
  const canonical = immutableArray([...paths].sort(compareStrings));
  const result = canonicalRecord({ paths: canonical, digest: digestJson(canonical) });
  pathSetCache.add(result);
  return ok(result);
}

function parseDurablePathSet(raw: unknown, field: string): DomainResult<RemediationPathSet, string> {
  const record = exactRecord(raw, ["paths", "digest"], field);
  if (!record.ok) return record;
  const paths = parseRemediationPathSet(record.value.paths, `${field}.paths`);
  const digest = parseArtifactDigest(record.value.digest);
  if (!paths.ok) return fail(paths.error.message);
  if (!digest.ok) return fail(digest.error.message);
  if (digest.value !== paths.value.digest) return fail(`${field}.digest does not match canonical paths`);
  return ok(paths.value);
}

function combineDistinctPathSets(
  left: RemediationPathSet,
  right: RemediationPathSet,
  field = "authorizedPaths",
): DomainResult<RemediationPathSet, string> {
  const combined = parseRemediationPathSet([...left.paths, ...right.paths], field);
  return combined.ok ? combined : fail(combined.error.message);
}

declare class StandaloneResultPublicationAuthorityMembership {
  private readonly standaloneResultPublicationAuthorityMembership: true;
}

/** Durable LC-2 publication proof bound to the exact canonical result bytes. */
export type StandaloneResultPublicationAuthority =
  StandaloneResultPublicationAuthorityMembership & Readonly<{
    schemaVersion: 1;
    kind: "standalone-result-publication-authority";
    resultArtifact: ArtifactRef;
    publicationReceipt: ArtifactSetPublished;
    digest: ArtifactDigest;
  }>;

const standalonePublicationAuthorityCache = new WeakSet<object>();

export type StandaloneResultPublicationAuthorityLookup = Readonly<{
  schemaVersion: 1;
  kind: "standalone-result-publication-authority-lookup";
  runId: OrchestrationRunId;
  effectId: EffectId;
  resultArtifact: ArtifactRef;
}>;

export type StandaloneResultPublicationAuthorityResolutionError = Readonly<{
  kind: "standalone-result-publication-authority-unavailable";
  field?: string;
  message: string;
}>;

/** Shell trust seam: load LC-2's immutable result-publication receipt, never caller checkpoint data. */
export type TrustedStandaloneResultPublicationLoader = (
  lookup: StandaloneResultPublicationAuthorityLookup,
) => DomainResult<unknown, StandaloneResultPublicationAuthorityResolutionError>;

/** Parser-produced resolver accepted by remediation rehydration. */
export type StandaloneResultPublicationAuthorityResolver = (
  expectedPublication: PublishArtifactSet,
) => DomainResult<StandaloneResultPublicationAuthority, StandaloneResultPublicationAuthorityResolutionError>;

const standalonePublicationResolverCache = new WeakSet<object>();

function publicationResolutionFailure(
  message: string,
  field?: string,
): StandaloneResultPublicationAuthorityResolutionError {
  return field === undefined
    ? canonicalRecord({ kind: "standalone-result-publication-authority-unavailable", message })
    : canonicalRecord({ kind: "standalone-result-publication-authority-unavailable", field, message });
}

function expectedStandaloneResultPublication(
  runId: OrchestrationRunId,
  sourceResultJson: string,
): DomainResult<PublishArtifactSet, string> {
  const artifact = parseArtifactRef({
    runId,
    slot: STANDALONE_RESULT_SLOT,
    digest: digestText(sourceResultJson),
    byteLength: Buffer.byteLength(sourceResultJson, "utf8"),
  });
  if (!artifact.ok) return fail(artifact.error.message);
  const effectId = parseEffectId(`effect:standalone-result:${digestJson({ runId, artifact: artifact.value })}`);
  if (!effectId.ok) return fail(effectId.error.message);
  return ok(canonicalRecord({
    kind: "publish-artifact-set" as const,
    effectId: effectId.value,
    runId,
    artifacts: Object.freeze([artifact.value]) as readonly [ArtifactRef],
  }));
}

function mintStandaloneResultPublicationAuthorityFromIntent(
  intent: PublishArtifactSet,
  rawReceipt: unknown,
): DomainResult<StandaloneResultPublicationAuthority, string> {
  const reconciled = reconcileEffectReceipt(intent, rawReceipt);
  if (!reconciled.ok || reconciled.value.kind !== "artifact-set-published") {
    return fail(reconciled.ok
      ? "standalone result publication receipt has the wrong effect kind"
      : reconciled.error.message);
  }
  const fields = {
    resultArtifact: intent.artifacts[0],
    publicationReceipt: reconciled.value,
  };
  const authority = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "standalone-result-publication-authority" as const,
    ...fields,
    digest: digestJson(fields),
  }) as unknown as StandaloneResultPublicationAuthority;
  standalonePublicationAuthorityCache.add(authority);
  return ok(authority);
}

function mintStandaloneResultPublicationAuthority(
  runId: OrchestrationRunId,
  sourceResultJson: string,
  rawReceipt: unknown,
): DomainResult<StandaloneResultPublicationAuthority, string> {
  const intent = expectedStandaloneResultPublication(runId, sourceResultJson);
  return intent.ok
    ? mintStandaloneResultPublicationAuthorityFromIntent(intent.value, rawReceipt)
    : intent;
}

/**
 * Builds the only resolver remediation parsers trust after restart. The loader
 * is an imperative-shell capability keyed solely by parser-derived LC-2 identity.
 */
export function createStandaloneResultPublicationAuthorityResolver(
  loader: TrustedStandaloneResultPublicationLoader,
): StandaloneResultPublicationAuthorityResolver {
  const resolver: StandaloneResultPublicationAuthorityResolver = (expectedPublication) => {
    if (typeof loader !== "function") {
      return fail(publicationResolutionFailure("a trusted LC-2 result publication loader is required"));
    }
    const lookup = canonicalRecord({
      schemaVersion: 1 as const,
      kind: "standalone-result-publication-authority-lookup" as const,
      runId: expectedPublication.runId,
      effectId: expectedPublication.effectId,
      resultArtifact: expectedPublication.artifacts[0],
    });
    let loaded: unknown;
    try {
      loaded = loader(lookup);
    } catch (thrown) {
      const cause = boundedParserCause(thrown);
      return fail(publicationResolutionFailure(
        `trusted LC-2 result publication loader threw: ${cause.name}: ${cause.message}`,
      ));
    }
    const successEnvelope = exactRecord(loaded, ["ok", "value"], "LC-2 publication loader result");
    if (successEnvelope.ok && successEnvelope.value.ok === true) {
      const authority = mintStandaloneResultPublicationAuthorityFromIntent(
        expectedPublication,
        successEnvelope.value.value,
      );
      return authority.ok
        ? ok(authority.value)
        : fail(publicationResolutionFailure(authority.error, "publicationReceipt"));
    }
    const failureEnvelope = exactRecord(loaded, ["ok", "error"], "LC-2 publication loader result");
    if (!failureEnvelope.ok || failureEnvelope.value.ok !== false) {
      return fail(publicationResolutionFailure(
        "trusted LC-2 result publication loader returned an invalid DomainResult",
      ));
    }
    const resolutionErrorWithField = exactRecord(
      failureEnvelope.value.error,
      ["kind", "field", "message"],
      "LC-2 publication loader error",
    );
    const resolutionErrorWithoutField = resolutionErrorWithField.ok
      ? null
      : exactRecord(
          failureEnvelope.value.error,
          ["kind", "message"],
          "LC-2 publication loader error",
        );
    const resolutionError = resolutionErrorWithField.ok
      ? resolutionErrorWithField.value
      : resolutionErrorWithoutField?.ok === true
        ? resolutionErrorWithoutField.value
        : null;
    if (resolutionError === null ||
        resolutionError.kind !== "standalone-result-publication-authority-unavailable" ||
        typeof resolutionError.message !== "string" || resolutionError.message.trim() === "" ||
        (resolutionError.field !== undefined &&
          (typeof resolutionError.field !== "string" || resolutionError.field.trim() === ""))) {
      return fail(publicationResolutionFailure("trusted LC-2 result publication loader returned an invalid error"));
    }
    return fail(publicationResolutionFailure(
      resolutionError.message,
      typeof resolutionError.field === "string" ? resolutionError.field : undefined,
    ));
  };
  standalonePublicationResolverCache.add(resolver);
  return resolver;
}

function resolveStandaloneResultPublicationAuthority(
  resolver: StandaloneResultPublicationAuthorityResolver,
  expectedPublication: PublishArtifactSet,
): DomainResult<StandaloneResultPublicationAuthority, string> {
  if (typeof resolver !== "function" || !standalonePublicationResolverCache.has(resolver)) {
    return fail("rehydration requires a trusted parser-produced LC-2 publication authority resolver");
  }
  let resolved: unknown;
  try {
    resolved = resolver(expectedPublication);
  } catch (thrown) {
    const cause = boundedParserCause(thrown);
    return fail(`LC-2 publication authority resolver threw: ${cause.name}: ${cause.message}`);
  }
  const envelope = exactRecord(resolved, ["ok", "value"], "LC-2 publication authority resolution");
  if (!envelope.ok || envelope.value.ok !== true ||
      typeof envelope.value.value !== "object" || envelope.value.value === null ||
      !standalonePublicationAuthorityCache.has(envelope.value.value as object)) {
    const failureEnvelope = exactRecord(resolved, ["ok", "error"], "LC-2 publication authority resolution");
    if (failureEnvelope.ok && failureEnvelope.value.ok === false) {
      const errorWithField = exactRecord(
        failureEnvelope.value.error,
        ["kind", "field", "message"],
        "LC-2 publication authority resolution error",
      );
      const errorWithoutField = errorWithField.ok
        ? null
        : exactRecord(
            failureEnvelope.value.error,
            ["kind", "message"],
            "LC-2 publication authority resolution error",
          );
      const error = errorWithField.ok
        ? errorWithField.value
        : errorWithoutField?.ok === true
          ? errorWithoutField.value
          : null;
      if (error !== null && error.kind === "standalone-result-publication-authority-unavailable" &&
          typeof error.message === "string") return fail(error.message);
    }
    return fail("LC-2 publication authority resolver returned an untrusted or malformed authority");
  }
  return ok(envelope.value.value as unknown as StandaloneResultPublicationAuthority);
}

function parseStandaloneResultPublicationAuthority(
  raw: unknown,
  trusted: StandaloneResultPublicationAuthority,
): DomainResult<StandaloneResultPublicationAuthority, string> {
  const record = exactRecord(raw, [
    "schemaVersion", "kind", "resultArtifact", "publicationReceipt", "digest",
  ], "sourcePublicationAuthority");
  if (!record.ok) return record;
  if (record.value.schemaVersion !== 1 ||
      record.value.kind !== "standalone-result-publication-authority") {
    return fail("sourcePublicationAuthority schema or kind is invalid");
  }
  if (record.value.digest !== trusted.digest ||
      JSON.stringify(record.value.resultArtifact) !== JSON.stringify(trusted.resultArtifact) ||
      JSON.stringify(record.value.publicationReceipt) !== JSON.stringify(trusted.publicationReceipt)) {
    return fail("sourcePublicationAuthority does not match trusted LC-2 publication authority");
  }
  return ok(trusted);
}

interface PathAuthorityFields {
  readonly schemaVersion: 1;
  readonly runId: OrchestrationRunId;
  readonly sourceResultJson: string;
  readonly sourceResultDigest: ArtifactDigest;
  readonly sourcePublicationAuthority: StandaloneResultPublicationAuthority;
  readonly reviewedScope: RemediationPathSet;
  readonly registeredSupportPaths: RemediationPathSet;
  readonly authorizedPaths: RemediationPathSet;
  readonly exclusionPolicyDigest: ArtifactDigest;
  readonly digest: ArtifactDigest;
}

declare class FrozenPathAuthorityMembership { private readonly frozenPathAuthorityMembership: true }
declare class RegisteredPathAuthorityMembership { private readonly registeredPathAuthorityMembership: true }

export type FrozenPathAuthority = FrozenPathAuthorityMembership & Readonly<PathAuthorityFields & {
  kind: "frozen-path-authority";
}>;

export type RegisteredPathAuthority = RegisteredPathAuthorityMembership & Readonly<PathAuthorityFields & {
  kind: "registered-path-authority";
}>;

export type RemediationPathAuthority = FrozenPathAuthority | RegisteredPathAuthority;

export type PathAuthorityError = Readonly<{
  kind: "invalid-path-authority" | "support-path-registration-rejected";
  field: string;
  path: CanonicalRepositoryRelativePath | null;
  message: string;
}>;

const authorityCache = new WeakSet<object>();

function authorityDigest(fields: Omit<PathAuthorityFields, "schemaVersion" | "digest">): ArtifactDigest {
  return digestJson({
    runId: fields.runId,
    sourceResultDigest: fields.sourceResultDigest,
    sourcePublicationAuthorityDigest: fields.sourcePublicationAuthority.digest,
    reviewedScopeDigest: fields.reviewedScope.digest,
    registeredSupportPathsDigest: fields.registeredSupportPaths.digest,
    authorizedPathsDigest: fields.authorizedPaths.digest,
    exclusionPolicyDigest: fields.exclusionPolicyDigest,
  });
}

function parsedCanonicalStandaloneResult(
  sourceResultJson: string,
): DomainResult<Readonly<{
  runId: OrchestrationRunId;
  json: string;
  digest: ArtifactDigest;
  scope: RemediationPathSet;
}>, PathAuthorityError | RemediationPathSetError> {
  let raw: unknown;
  try {
    raw = JSON.parse(sourceResultJson);
  } catch {
    return fail(canonicalRecord({
      kind: "invalid-path-authority",
      field: "standaloneResult",
      path: null,
      message: "authoritative standalone result is not valid canonical JSON",
    }));
  }
  const record = exactRecord(raw, [
    "schema_version", "run_id", "subject_id", "scope", "reviewer_evidence",
    "surviving_critical_findings", "advisory_findings", "refuted_critical_findings", "panel",
  ], "standaloneResult");
  if (!record.ok || record.value.schema_version !== 1 || record.value.subject_id !== "standalone-review") {
    return fail(canonicalRecord({
      kind: "invalid-path-authority",
      field: "standaloneResult",
      path: null,
      message: record.ok
        ? "authoritative standalone result schema or subject is invalid"
        : record.error,
    }));
  }
  const reviewerEvidence = denseArray(record.value.reviewer_evidence, "standaloneResult.reviewer_evidence");
  const surviving = denseArray(record.value.surviving_critical_findings, "standaloneResult.surviving_critical_findings");
  const advisory = denseArray(record.value.advisory_findings, "standaloneResult.advisory_findings");
  const refuted = denseArray(record.value.refuted_critical_findings, "standaloneResult.refuted_critical_findings");
  if (!reviewerEvidence.ok || reviewerEvidence.value.length === 0 || !surviving.ok || !advisory.ok || !refuted.ok) {
    return fail(canonicalRecord({
      kind: "invalid-path-authority",
      field: "standaloneResult",
      path: null,
      message: "authoritative standalone result requires non-empty LC-2 reviewer evidence and finding arrays",
    }));
  }
  const runId = parseOrchestrationRunId(record.value.run_id);
  if (!runId.ok) {
    return fail(canonicalRecord({
      kind: "invalid-path-authority",
      field: "standaloneResult.run_id",
      path: null,
      message: runId.error.message,
    }));
  }
  const scope = parseRemediationPathSet(record.value.scope, "standaloneResult.scope", { nonEmpty: true });
  if (!scope.ok) return scope;
  const excluded = scope.value.paths.filter(isExcludedRemediationPath);
  if (excluded.length > 0) {
    return fail(canonicalRecord({
      kind: "invalid-path-authority",
      field: "standaloneResult.scope",
      path: excluded[0]!,
      message: `standalone result scope contains excluded Loom evidence path(s): ${excluded.join(", ")}`,
    }));
  }
  if (JSON.stringify(raw, null, 2) !== sourceResultJson) {
    return fail(canonicalRecord({
      kind: "invalid-path-authority",
      field: "standaloneResult",
      path: null,
      message: "authoritative standalone result JSON is not canonical",
    }));
  }
  return ok(canonicalRecord({
    runId: runId.value,
    json: sourceResultJson,
    digest: digestText(sourceResultJson),
    scope: scope.value,
  }));
}

function sourceResult(
  rawResult: unknown,
  rawPublicationReceipt: unknown,
): DomainResult<Readonly<{
  runId: OrchestrationRunId;
  json: string;
  digest: ArtifactDigest;
  publicationAuthority: StandaloneResultPublicationAuthority;
  scope: RemediationPathSet;
}>, PathAuthorityError | RemediationPathSetError> {
  if (!isAuthoritativeStandaloneReviewResult(rawResult as AuthoritativeStandaloneReviewResult)) {
    return fail(canonicalRecord({
      kind: "invalid-path-authority",
      field: "standaloneResult",
      path: null,
      message: "remediation requires an opaque LC-2 authoritative standalone result",
    }));
  }
  const json = serializeAdjudicatedStandaloneReview(rawResult as AuthoritativeStandaloneReviewResult);
  const parsed = parsedCanonicalStandaloneResult(json);
  if (!parsed.ok) return parsed;
  const publication = mintStandaloneResultPublicationAuthority(
    parsed.value.runId,
    parsed.value.json,
    rawPublicationReceipt,
  );
  if (!publication.ok) {
    return fail(canonicalRecord({
      kind: "invalid-path-authority",
      field: "publicationReceipt",
      path: null,
      message: publication.error,
    }));
  }
  return ok(canonicalRecord({
    ...parsed.value,
    publicationAuthority: publication.value,
  }));
}

export type StartRemediationInput = Readonly<{
  standaloneResult: AuthoritativeStandaloneReviewResult;
  publicationReceipt: ArtifactSetPublished;
}>;

/** The only initial authority constructor: caller-selected reviewedScope is not accepted. */
export function freezePathAuthority(
  raw: unknown,
): DomainResult<FrozenPathAuthority, PathAuthorityError | RemediationPathSetError> {
  const input = exactRecord(raw, ["standaloneResult", "publicationReceipt"], "remediation start");
  if (!input.ok) {
    return fail(canonicalRecord({
      kind: "invalid-path-authority",
      field: "start",
      path: null,
      message: input.error,
    }));
  }
  const source = sourceResult(input.value.standaloneResult, input.value.publicationReceipt);
  if (!source.ok) return source;
  const support = parseRemediationPathSet([], "registeredSupportPaths");
  if (!support.ok) return support;
  const fields = {
    runId: source.value.runId,
    sourceResultJson: source.value.json,
    sourceResultDigest: source.value.digest,
    sourcePublicationAuthority: source.value.publicationAuthority,
    reviewedScope: source.value.scope,
    registeredSupportPaths: support.value,
    authorizedPaths: source.value.scope,
    exclusionPolicyDigest: EXCLUSION_POLICY_DIGEST,
  };
  const authority = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "frozen-path-authority" as const,
    ...fields,
    digest: authorityDigest(fields),
  }) as unknown as FrozenPathAuthority;
  authorityCache.add(authority);
  return ok(authority);
}

export function parseRemediationPathAuthority(
  raw: unknown,
  publicationResolver: StandaloneResultPublicationAuthorityResolver,
): DomainResult<RemediationPathAuthority, PathAuthorityError> {
  const record = exactRecord(raw, [
    "schemaVersion", "kind", "runId", "sourceResultJson", "sourceResultDigest", "sourcePublicationAuthority",
    "reviewedScope", "registeredSupportPaths", "authorizedPaths", "exclusionPolicyDigest", "digest",
  ], "pathAuthority");
  const invalid = (field: string, message: string, path: CanonicalRepositoryRelativePath | null = null) =>
    fail<RemediationPathAuthority, PathAuthorityError>(canonicalRecord({
      kind: "invalid-path-authority",
      field,
      path,
      message,
    }));
  if (!record.ok) return invalid("authority", record.error);
  if (record.value.schemaVersion !== 1) return invalid("schemaVersion", "pathAuthority.schemaVersion must be 1");
  if (record.value.kind !== "frozen-path-authority" && record.value.kind !== "registered-path-authority") {
    return invalid("kind", "pathAuthority.kind is invalid");
  }
  if (typeof record.value.sourceResultJson !== "string") {
    return invalid("sourceResultJson", "pathAuthority.sourceResultJson must be canonical JSON text");
  }
  try {
    JSON.parse(record.value.sourceResultJson);
  } catch {
    return invalid("sourceResultJson", "pathAuthority.sourceResultJson is not valid JSON");
  }
  const source = parsedCanonicalStandaloneResult(record.value.sourceResultJson);
  if (!source.ok) return invalid("sourceResultJson", source.error.message);
  const expectedPublication = expectedStandaloneResultPublication(source.value.runId, source.value.json);
  if (!expectedPublication.ok) return invalid("sourcePublicationAuthority", expectedPublication.error);
  const trustedPublicationAuthority = resolveStandaloneResultPublicationAuthority(
    publicationResolver,
    expectedPublication.value,
  );
  if (!trustedPublicationAuthority.ok) {
    return invalid("sourcePublicationAuthority", trustedPublicationAuthority.error);
  }
  const publicationAuthority = parseStandaloneResultPublicationAuthority(
    record.value.sourcePublicationAuthority,
    trustedPublicationAuthority.value,
  );
  if (!publicationAuthority.ok) return invalid("sourcePublicationAuthority", publicationAuthority.error);
  const runId = parseOrchestrationRunId(record.value.runId);
  const sourceDigest = parseArtifactDigest(record.value.sourceResultDigest);
  const exclusionDigest = parseArtifactDigest(record.value.exclusionPolicyDigest);
  const digest = parseArtifactDigest(record.value.digest);
  const reviewed = parseDurablePathSet(record.value.reviewedScope, "pathAuthority.reviewedScope");
  const support = parseDurablePathSet(record.value.registeredSupportPaths, "pathAuthority.registeredSupportPaths");
  const authorized = parseDurablePathSet(record.value.authorizedPaths, "pathAuthority.authorizedPaths");
  if (!runId.ok) return invalid("runId", runId.error.message);
  if (!sourceDigest.ok) return invalid("sourceResultDigest", sourceDigest.error.message);
  if (!exclusionDigest.ok) return invalid("exclusionPolicyDigest", exclusionDigest.error.message);
  if (!digest.ok) return invalid("digest", digest.error.message);
  if (!reviewed.ok) return invalid("reviewedScope", reviewed.error);
  if (!support.ok) return invalid("registeredSupportPaths", support.error);
  if (!authorized.ok) return invalid("authorizedPaths", authorized.error);
  if (runId.value !== source.value.runId || sourceDigest.value !== source.value.digest ||
      !sameArray(reviewed.value.paths, source.value.scope.paths)) {
    return invalid("sourceResultJson", "path authority does not match its standalone result run and exact scope");
  }
  const excluded = [...reviewed.value.paths, ...support.value.paths].filter(isExcludedRemediationPath);
  if (excluded.length > 0) return invalid("authorizedPaths", "path authority contains excluded Loom evidence", excluded[0]!);
  const combined = combineDistinctPathSets(reviewed.value, support.value);
  if (!combined.ok || !sameArray(combined.value.paths, authorized.value.paths)) {
    return invalid("authorizedPaths", combined.ok
      ? "authorized paths are not exactly reviewed scope plus registered support paths"
      : combined.error);
  }
  if (record.value.kind === "frozen-path-authority" && support.value.paths.length !== 0) {
    return invalid("registeredSupportPaths", "frozen authority cannot contain support paths");
  }
  if (record.value.kind === "registered-path-authority" && support.value.paths.length === 0) {
    return invalid("registeredSupportPaths", "registered authority must contain a support path");
  }
  if (exclusionDigest.value !== EXCLUSION_POLICY_DIGEST) {
    return invalid("exclusionPolicyDigest", "path authority exclusion policy has drifted");
  }
  const fields = {
    runId: runId.value,
    sourceResultJson: source.value.json,
    sourceResultDigest: sourceDigest.value,
    sourcePublicationAuthority: publicationAuthority.value,
    reviewedScope: reviewed.value,
    registeredSupportPaths: support.value,
    authorizedPaths: authorized.value,
    exclusionPolicyDigest: exclusionDigest.value,
  };
  const expectedDigest = authorityDigest(fields);
  if (digest.value !== expectedDigest) return invalid("digest", "path authority digest mismatch");
  const authority = canonicalRecord({
    schemaVersion: 1 as const,
    kind: record.value.kind,
    ...fields,
    digest: expectedDigest,
  }) as unknown as RemediationPathAuthority;
  authorityCache.add(authority);
  return ok(authority);
}

export function registerSupportPath(
  authority: RemediationPathAuthority,
  rawPath: unknown,
): DomainResult<RegisteredPathAuthority, PathAuthorityError> {
  if (!authorityCache.has(authority)) {
    return fail(canonicalRecord({
      kind: "invalid-path-authority",
      field: "authority",
      path: null,
      message: "support paths require parser-produced standalone result authority",
    }));
  }
  const path = parseCanonicalRepositoryRelativePath(rawPath, "supportPath");
  if (!path.ok) {
    return fail(canonicalRecord({
      kind: "support-path-registration-rejected",
      field: path.error.field,
      path: null,
      message: path.error.message,
    }));
  }
  if (isExcludedRemediationPath(path.value)) {
    return fail(canonicalRecord({
      kind: "support-path-registration-rejected",
      field: "supportPath",
      path: path.value,
      message: `support path '${path.value}' is inside an excluded Loom Run Directory, evidence, state, or Git metadata layout`,
    }));
  }
  if (authority.authorizedPaths.paths.includes(path.value)) {
    return fail(canonicalRecord({
      kind: "support-path-registration-rejected",
      field: "supportPath",
      path: path.value,
      message: `support path '${path.value}' is already authorized`,
    }));
  }
  const registered = parseRemediationPathSet(
    [...authority.registeredSupportPaths.paths, path.value],
    "registeredSupportPaths",
  );
  if (!registered.ok) {
    return fail(canonicalRecord({
      kind: "support-path-registration-rejected",
      field: "registeredSupportPaths",
      path: path.value,
      message: registered.error.message,
    }));
  }
  const authorized = combineDistinctPathSets(authority.reviewedScope, registered.value);
  if (!authorized.ok) {
    return fail(canonicalRecord({
      kind: "support-path-registration-rejected",
      field: "authorizedPaths",
      path: path.value,
      message: authorized.error,
    }));
  }
  const fields = {
    runId: authority.runId,
    sourceResultJson: authority.sourceResultJson,
    sourceResultDigest: authority.sourceResultDigest,
    sourcePublicationAuthority: authority.sourcePublicationAuthority,
    reviewedScope: authority.reviewedScope,
    registeredSupportPaths: registered.value,
    authorizedPaths: authorized.value,
    exclusionPolicyDigest: authority.exclusionPolicyDigest,
  };
  const result = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "registered-path-authority" as const,
    ...fields,
    digest: authorityDigest(fields),
  }) as unknown as RegisteredPathAuthority;
  authorityCache.add(result);
  return ok(result);
}

export type DirtyPathObservation =
  | Readonly<{
      path: CanonicalRepositoryRelativePath;
      change: PresentRemediationPathChange;
      nodeKind: "file";
    }>
  | Readonly<{
      path: CanonicalRepositoryRelativePath;
      change: AbsentRemediationPathChange;
      nodeKind: "missing";
    }>;

export type DirtyPathObservationError = Readonly<{
  kind: "invalid-dirty-path-observation";
  field: string;
  path: CanonicalRepositoryRelativePath | null;
  message: string;
}>;

export function parseDirtyPathObservation(
  raw: unknown,
  field = "dirtyPath",
): DomainResult<DirtyPathObservation, DirtyPathObservationError> {
  const record = exactRecord(raw, ["path", "change", "nodeKind"], field);
  const invalid = (invalidField: string, message: string, path: CanonicalRepositoryRelativePath | null = null) =>
    fail<DirtyPathObservation, DirtyPathObservationError>(canonicalRecord({
      kind: "invalid-dirty-path-observation",
      field: invalidField,
      path,
      message,
    }));
  if (!record.ok) return invalid(field, record.error);
  const path = parseCanonicalRepositoryRelativePath(record.value.path, `${field}.path`);
  if (!path.ok) return invalid(path.error.field, path.error.message);
  if (!includes(PATH_CHANGES, record.value.change)) {
    return invalid(`${field}.change`, `${field}.change is not a supported Git path change`, path.value);
  }
  if (!includes(PATH_NODE_KINDS, record.value.nodeKind)) {
    return invalid(`${field}.nodeKind`, `${field}.nodeKind is invalid`, path.value);
  }
  if (record.value.nodeKind === "symlink") {
    return invalid(`${field}.nodeKind`, `dirty path '${path.value}' is a symlink`, path.value);
  }
  if (record.value.nodeKind === "directory" || record.value.nodeKind === "other") {
    return invalid(`${field}.nodeKind`, `dirty path '${path.value}' must be a regular file or absent`, path.value);
  }
  const change = record.value.change;
  if (isPresentChange(change)) {
    return record.value.nodeKind === "file"
      ? ok(canonicalRecord({ path: path.value, change, nodeKind: "file" as const }))
      : invalid(`${field}.nodeKind`, `${change} path '${path.value}' must be a regular file`, path.value);
  }
  if (isAbsentChange(change)) {
    return record.value.nodeKind === "missing"
      ? ok(canonicalRecord({ path: path.value, change, nodeKind: "missing" as const }))
      : invalid(`${field}.nodeKind`, `${change} path '${path.value}' must be absent`, path.value);
  }
  return invalid(`${field}.change`, `${field}.change is not a supported Git path change`, path.value);
}

export type RepositorySnapshotWitness = Readonly<{
  baseTreeDigest: ArtifactDigest;
  indexDigest: ArtifactDigest;
  worktreeDigest: ArtifactDigest;
  digest: ArtifactDigest;
}>;

export type RepositorySnapshotWitnessError = Readonly<{
  kind: "invalid-repository-snapshot-witness";
  field: string;
  message: string;
}>;

const repositoryWitnessCache = new WeakSet<object>();

export function parseRepositorySnapshotWitness(
  raw: unknown,
  field = "repositoryWitness",
): DomainResult<RepositorySnapshotWitness, RepositorySnapshotWitnessError> {
  const invalid = (invalidField: string, message: string) => fail<RepositorySnapshotWitness, RepositorySnapshotWitnessError>(canonicalRecord({
    kind: "invalid-repository-snapshot-witness",
    field: invalidField,
    message,
  }));
  let hasDigest = false;
  if (typeof raw === "object" && raw !== null) {
    try {
      hasDigest = Object.hasOwn(raw, "digest");
    } catch {
      return invalid(field, `${field} could not be safely inspected`);
    }
  }
  const record = exactRecord(raw, hasDigest
    ? ["baseTreeDigest", "indexDigest", "worktreeDigest", "digest"]
    : ["baseTreeDigest", "indexDigest", "worktreeDigest"], field);
  if (!record.ok) return invalid(field, record.error);
  const baseTreeDigest = parseArtifactDigest(record.value.baseTreeDigest);
  const indexDigest = parseArtifactDigest(record.value.indexDigest);
  const worktreeDigest = parseArtifactDigest(record.value.worktreeDigest);
  if (!baseTreeDigest.ok) return invalid(`${field}.baseTreeDigest`, baseTreeDigest.error.message);
  if (!indexDigest.ok) return invalid(`${field}.indexDigest`, indexDigest.error.message);
  if (!worktreeDigest.ok) return invalid(`${field}.worktreeDigest`, worktreeDigest.error.message);
  const digest = digestJson({
    baseTreeDigest: baseTreeDigest.value,
    indexDigest: indexDigest.value,
    worktreeDigest: worktreeDigest.value,
  });
  if (hasDigest) {
    const supplied = parseArtifactDigest(record.value.digest);
    if (!supplied.ok || supplied.value !== digest) return invalid(`${field}.digest`, "repository witness digest mismatch");
  }
  const result = canonicalRecord({
    baseTreeDigest: baseTreeDigest.value,
    indexDigest: indexDigest.value,
    worktreeDigest: worktreeDigest.value,
    digest,
  });
  repositoryWitnessCache.add(result);
  return ok(result);
}

export type RepositoryWitnessMismatch = Readonly<{
  field: "baseTreeDigest" | "indexDigest" | "worktreeDigest";
  expected: ArtifactDigest;
  actual: ArtifactDigest;
}>;

export type RepositoryWitnessComparisonError = Readonly<{
  kind: "repository-witness-mismatch";
  mismatches: readonly RepositoryWitnessMismatch[];
  message: string;
}>;

export function compareRepositoryWitnesses(
  expected: RepositorySnapshotWitness,
  actual: RepositorySnapshotWitness,
): DomainResult<RepositorySnapshotWitness, RepositoryWitnessComparisonError> {
  const mismatches: RepositoryWitnessMismatch[] = [];
  if (!repositoryWitnessCache.has(expected) || !repositoryWitnessCache.has(actual)) {
    for (const field of ["baseTreeDigest", "indexDigest", "worktreeDigest"] as const) {
      mismatches.push(canonicalRecord({ field, expected: expected[field], actual: actual[field] }));
    }
    return fail(canonicalRecord({
      kind: "repository-witness-mismatch",
      mismatches: immutableArray(mismatches),
      message: "repository comparison requires parser-produced witnesses",
    }));
  }
  for (const field of ["baseTreeDigest", "indexDigest", "worktreeDigest"] as const) {
    if (expected[field] !== actual[field]) {
      mismatches.push(canonicalRecord({ field, expected: expected[field], actual: actual[field] }));
    }
  }
  return mismatches.length === 0
    ? ok(actual)
    : fail(canonicalRecord({
        kind: "repository-witness-mismatch",
        mismatches: immutableArray(mismatches),
        message: `repository witness drifted in: ${mismatches.map(({ field }) => field).join(", ")}`,
      }));
}

export type ExactPathSetWitness = Readonly<{
  kind: "exact-path-set-witness";
  expected: RemediationPathSet;
  actual: RemediationPathSet;
  expectedDigest: ArtifactDigest;
  actualDigest: ArtifactDigest;
}>;

export type PathSetComparisonError = Readonly<{
  kind: "path-set-mismatch";
  missing: readonly CanonicalRepositoryRelativePath[];
  unexpected: readonly CanonicalRepositoryRelativePath[];
  expectedDigest: ArtifactDigest;
  actualDigest: ArtifactDigest;
  message: string;
}>;

const exactPathSetWitnessCache = new WeakSet<object>();

export function compareExactPathSets(
  expected: RemediationPathSet,
  actual: RemediationPathSet,
): DomainResult<ExactPathSetWitness, PathSetComparisonError> {
  if (!pathSetCache.has(expected) || !pathSetCache.has(actual)) {
    return fail(canonicalRecord({
      kind: "path-set-mismatch",
      missing: Object.freeze([]),
      unexpected: Object.freeze([]),
      expectedDigest: expected.digest,
      actualDigest: actual.digest,
      message: "path comparison requires parser-produced path sets",
    }));
  }
  const expectedPaths = new Set(expected.paths);
  const actualPaths = new Set(actual.paths);
  const missing = expected.paths.filter((path) => !actualPaths.has(path));
  const unexpected = actual.paths.filter((path) => !expectedPaths.has(path));
  if (missing.length > 0 || unexpected.length > 0 || expected.digest !== actual.digest) {
    return fail(canonicalRecord({
      kind: "path-set-mismatch",
      missing: immutableArray(missing),
      unexpected: immutableArray(unexpected),
      expectedDigest: expected.digest,
      actualDigest: actual.digest,
      message: [
        missing.length === 0 ? null : `missing: ${missing.join(", ")}`,
        unexpected.length === 0 ? null : `unexpected: ${unexpected.join(", ")}`,
        expected.digest === actual.digest ? null : "path-set digest mismatch",
      ].filter((part): part is string => part !== null).join("; "),
    }));
  }
  const witness = canonicalRecord({
    kind: "exact-path-set-witness" as const,
    expected,
    actual,
    expectedDigest: expected.digest,
    actualDigest: actual.digest,
  });
  exactPathSetWitnessCache.add(witness);
  return ok(witness);
}

function parseExactPathSetWitness(raw: unknown, field: string): DomainResult<ExactPathSetWitness, string> {
  const record = exactRecord(raw, ["kind", "expected", "actual", "expectedDigest", "actualDigest"], field);
  if (!record.ok) return record;
  if (record.value.kind !== "exact-path-set-witness") return fail(`${field}.kind is invalid`);
  const expected = parseDurablePathSet(record.value.expected, `${field}.expected`);
  const actual = parseDurablePathSet(record.value.actual, `${field}.actual`);
  if (!expected.ok) return expected;
  if (!actual.ok) return actual;
  const compared = compareExactPathSets(expected.value, actual.value);
  if (!compared.ok) return fail(compared.error.message);
  if (record.value.expectedDigest !== compared.value.expectedDigest ||
      record.value.actualDigest !== compared.value.actualDigest) return fail(`${field} digest fields mismatch`);
  return ok(compared.value);
}

export type PathSetSubsetWitness = Readonly<{
  kind: "path-set-subset-witness";
  subset: RemediationPathSet;
  superset: RemediationPathSet;
  subsetDigest: ArtifactDigest;
  supersetDigest: ArtifactDigest;
}>;

const pathSetSubsetWitnessCache = new WeakSet<object>();

function provePathSetSubset(
  subset: RemediationPathSet,
  superset: RemediationPathSet,
): DomainResult<PathSetSubsetWitness, PathSetComparisonError> {
  const supersetPaths = new Set(superset.paths);
  const unexpected = subset.paths.filter((path) => !supersetPaths.has(path));
  if (!pathSetCache.has(subset) || !pathSetCache.has(superset) || unexpected.length > 0) {
    return fail(canonicalRecord({
      kind: "path-set-mismatch",
      missing: Object.freeze([]),
      unexpected: immutableArray(unexpected),
      expectedDigest: superset.digest,
      actualDigest: subset.digest,
      message: pathSetCache.has(subset) && pathSetCache.has(superset)
        ? `paths outside audited set: ${unexpected.join(", ")}`
        : "path subset proof requires parser-produced path sets",
    }));
  }
  const witness = canonicalRecord({
    kind: "path-set-subset-witness" as const,
    subset,
    superset,
    subsetDigest: subset.digest,
    supersetDigest: superset.digest,
  });
  pathSetSubsetWitnessCache.add(witness);
  return ok(witness);
}

function parsePathSetSubsetWitness(raw: unknown, field: string): DomainResult<PathSetSubsetWitness, string> {
  const record = exactRecord(raw, ["kind", "subset", "superset", "subsetDigest", "supersetDigest"], field);
  if (!record.ok) return record;
  if (record.value.kind !== "path-set-subset-witness") return fail(`${field}.kind is invalid`);
  const subset = parseDurablePathSet(record.value.subset, `${field}.subset`);
  const superset = parseDurablePathSet(record.value.superset, `${field}.superset`);
  if (!subset.ok) return subset;
  if (!superset.ok) return superset;
  const proved = provePathSetSubset(subset.value, superset.value);
  if (!proved.ok) return fail(proved.error.message);
  if (record.value.subsetDigest !== proved.value.subsetDigest ||
      record.value.supersetDigest !== proved.value.supersetDigest) return fail(`${field} digest fields mismatch`);
  return ok(proved.value);
}

declare class AuditedDirtyEvidenceMembership { private readonly auditedDirtyEvidenceMembership: true }
declare class ExactStagingEvidenceMembership { private readonly exactStagingEvidenceMembership: true }

export type AuditedDirtyEvidencePublication = AuditedDirtyEvidenceMembership & Readonly<{
  schemaVersion: 1;
  kind: "audited-dirty-evidence";
  auditedPaths: RemediationPathSet;
  dirtyPaths: RemediationPathSet;
  preexistingStagedPaths: RemediationPathSet;
  auditedEqualsDirty: ExactPathSetWitness;
  preexistingStagedWithinAudited: PathSetSubsetWitness;
  digest: ArtifactDigest;
}>;

export type ExactStagingEvidencePublication = ExactStagingEvidenceMembership & Readonly<{
  schemaVersion: 1;
  kind: "audited-dirty-temporary-index-evidence";
  auditedPaths: RemediationPathSet;
  dirtyPaths: RemediationPathSet;
  preexistingStagedPaths: RemediationPathSet;
  temporaryIndexStagedPaths: RemediationPathSet;
  auditedEqualsDirty: ExactPathSetWitness;
  preexistingStagedWithinAudited: PathSetSubsetWitness;
  auditedEqualsTemporaryIndexStaged: ExactPathSetWitness;
  digest: ArtifactDigest;
}>;

const auditedEvidenceCache = new WeakSet<object>();
const exactStagingEvidenceCache = new WeakSet<object>();

function createAuditedEvidence(
  auditedPaths: RemediationPathSet,
  dirtyPaths: RemediationPathSet,
  preexistingStagedPaths: RemediationPathSet,
  exact: ExactPathSetWitness,
  stagedWithinAudited: PathSetSubsetWitness,
): AuditedDirtyEvidencePublication {
  const evidence = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "audited-dirty-evidence" as const,
    auditedPaths,
    dirtyPaths,
    preexistingStagedPaths,
    auditedEqualsDirty: exact,
    preexistingStagedWithinAudited: stagedWithinAudited,
    digest: digestJson({
      auditedPaths: auditedPaths.digest,
      dirtyPaths: dirtyPaths.digest,
      preexistingStagedPaths: preexistingStagedPaths.digest,
      exact: exact.actualDigest,
      stagedWithinAudited: stagedWithinAudited.subsetDigest,
    }),
  }) as unknown as AuditedDirtyEvidencePublication;
  auditedEvidenceCache.add(evidence);
  return evidence;
}

function parseAuditedEvidence(raw: unknown, field: string): DomainResult<AuditedDirtyEvidencePublication, string> {
  const record = exactRecord(raw, [
    "schemaVersion", "kind", "auditedPaths", "dirtyPaths", "preexistingStagedPaths",
    "auditedEqualsDirty", "preexistingStagedWithinAudited", "digest",
  ], field);
  if (!record.ok) return record;
  if (record.value.schemaVersion !== 1 || record.value.kind !== "audited-dirty-evidence") {
    return fail(`${field} schema or kind is invalid`);
  }
  const auditedPaths = parseDurablePathSet(record.value.auditedPaths, `${field}.auditedPaths`);
  const dirtyPaths = parseDurablePathSet(record.value.dirtyPaths, `${field}.dirtyPaths`);
  const preexisting = parseDurablePathSet(record.value.preexistingStagedPaths, `${field}.preexistingStagedPaths`);
  const exact = parseExactPathSetWitness(record.value.auditedEqualsDirty, `${field}.auditedEqualsDirty`);
  const stagedWithinAudited = parsePathSetSubsetWitness(
    record.value.preexistingStagedWithinAudited,
    `${field}.preexistingStagedWithinAudited`,
  );
  if (!auditedPaths.ok) return auditedPaths;
  if (!dirtyPaths.ok) return dirtyPaths;
  if (!preexisting.ok) return preexisting;
  if (!exact.ok) return exact;
  if (!stagedWithinAudited.ok) return stagedWithinAudited;
  if (!sameArray(exact.value.expected.paths, auditedPaths.value.paths) ||
      !sameArray(exact.value.actual.paths, dirtyPaths.value.paths) ||
      !sameArray(stagedWithinAudited.value.subset.paths, preexisting.value.paths) ||
      !sameArray(stagedWithinAudited.value.superset.paths, auditedPaths.value.paths)) {
    return fail(`${field} exact relationship mismatch`);
  }
  const evidence = createAuditedEvidence(
    auditedPaths.value,
    dirtyPaths.value,
    preexisting.value,
    exact.value,
    stagedWithinAudited.value,
  );
  if (record.value.digest !== evidence.digest) return fail(`${field}.digest mismatch`);
  return ok(evidence);
}

declare class AuditedPathSetMembership { private readonly auditedPathSetMembership: true }

export type AuditedPathSet = AuditedPathSetMembership & Readonly<{
  schemaVersion: 1;
  kind: "audited-path-set";
  runId: OrchestrationRunId;
  authority: RemediationPathAuthority;
  authorityDigest: ArtifactDigest;
  paths: RemediationPathSet;
  observations: readonly DirtyPathObservation[];
  pathSetWitness: ExactPathSetWitness;
  preexistingStagedPaths: RemediationPathSet;
  repositoryWitness: RepositorySnapshotWitness;
  evidence: AuditedDirtyEvidencePublication;
  digest: ArtifactDigest;
}>;

export type RemediationAuditError = Readonly<{
  kind: "remediation-audit-failed";
  field: string;
  unauthorizedDirtyPaths: readonly CanonicalRepositoryRelativePath[];
  unauthorizedPreexistingStagedPaths: readonly CanonicalRepositoryRelativePath[];
  preexistingStagedPathsOutsideAudited: readonly CanonicalRepositoryRelativePath[];
  excludedEvidencePaths: readonly CanonicalRepositoryRelativePath[];
  missingPaths: readonly CanonicalRepositoryRelativePath[];
  unexpectedPaths: readonly CanonicalRepositoryRelativePath[];
  observationErrors: readonly DirtyPathObservationError[];
  message: string;
}>;

const auditedPathSetCache = new WeakSet<object>();

function auditFailure(
  field: string,
  details: Omit<RemediationAuditError, "kind" | "field" | "message">,
  messages: readonly string[],
): DomainResult<AuditedPathSet, RemediationAuditError> {
  return fail(canonicalRecord({
    kind: "remediation-audit-failed",
    field,
    unauthorizedDirtyPaths: immutableArray(details.unauthorizedDirtyPaths),
    unauthorizedPreexistingStagedPaths: immutableArray(details.unauthorizedPreexistingStagedPaths),
    preexistingStagedPathsOutsideAudited: immutableArray(details.preexistingStagedPathsOutsideAudited),
    excludedEvidencePaths: immutableArray(details.excludedEvidencePaths),
    missingPaths: immutableArray(details.missingPaths),
    unexpectedPaths: immutableArray(details.unexpectedPaths),
    observationErrors: immutableArray(details.observationErrors),
    message: messages.join("; "),
  }));
}

export function auditRemediationPaths(
  authority: RemediationPathAuthority,
  input: Readonly<{
    expectedDirtyPaths: unknown;
    actualDirtyPaths: unknown;
    preexistingStagedPaths: unknown;
    repositoryWitness: RepositorySnapshotWitness;
  }>,
): DomainResult<AuditedPathSet, RemediationAuditError> {
  const empty = {
    unauthorizedDirtyPaths: [] as CanonicalRepositoryRelativePath[],
    unauthorizedPreexistingStagedPaths: [] as CanonicalRepositoryRelativePath[],
    preexistingStagedPathsOutsideAudited: [] as CanonicalRepositoryRelativePath[],
    excludedEvidencePaths: [] as CanonicalRepositoryRelativePath[],
    missingPaths: [] as CanonicalRepositoryRelativePath[],
    unexpectedPaths: [] as CanonicalRepositoryRelativePath[],
    observationErrors: [] as DirtyPathObservationError[],
  };
  if (!authorityCache.has(authority) || !repositoryWitnessCache.has(input.repositoryWitness)) {
    return auditFailure("authority", empty, ["audit requires parser-produced authority and repository witness"]);
  }
  const expected = parseRemediationPathSet(input.expectedDirtyPaths, "expectedDirtyPaths");
  const staged = parseRemediationPathSet(input.preexistingStagedPaths, "preexistingStagedPaths");
  const rawObservations = denseArray(input.actualDirtyPaths, "actualDirtyPaths");
  if (!expected.ok || !staged.ok || !rawObservations.ok) {
    return auditFailure("paths", empty, [
      expected.ok ? "" : expected.error.message,
      staged.ok ? "" : staged.error.message,
      rawObservations.ok ? "" : rawObservations.error,
    ].filter((message) => message !== ""));
  }
  const observations: DirtyPathObservation[] = [];
  const observationErrors: DirtyPathObservationError[] = [];
  for (let index = 0; index < rawObservations.value.length; index++) {
    const parsed = parseDirtyPathObservation(rawObservations.value[index], `actualDirtyPaths[${index}]`);
    if (parsed.ok) observations.push(parsed.value);
    else observationErrors.push(parsed.error);
  }
  const actual = parseRemediationPathSet(observations.map(({ path }) => path), "actualDirtyPathSet");
  if (!actual.ok) return auditFailure("actualDirtyPaths", { ...empty, observationErrors }, [actual.error.message]);
  const authorized = new Set(authority.authorizedPaths.paths);
  const unauthorizedDirtyPaths = actual.value.paths.filter((path) => !authorized.has(path));
  const unauthorizedPreexistingStagedPaths = staged.value.paths.filter((path) => !authorized.has(path));
  const auditedDirty = new Set(actual.value.paths);
  const preexistingStagedPathsOutsideAudited = staged.value.paths.filter((path) => !auditedDirty.has(path));
  const excludedEvidencePaths = [...new Set([
    ...expected.value.paths,
    ...actual.value.paths,
    ...staged.value.paths,
  ].filter(isExcludedRemediationPath))].sort(compareStrings);
  const comparison = compareExactPathSets(expected.value, actual.value);
  const stagedWithinAudited = provePathSetSubset(staged.value, actual.value);
  const missingPaths = comparison.ok ? [] : [...comparison.error.missing];
  const unexpectedPaths = comparison.ok ? [] : [...comparison.error.unexpected];
  if (observationErrors.length > 0 || unauthorizedDirtyPaths.length > 0 ||
      unauthorizedPreexistingStagedPaths.length > 0 || preexistingStagedPathsOutsideAudited.length > 0 ||
      excludedEvidencePaths.length > 0 || !comparison.ok || !stagedWithinAudited.ok) {
    return auditFailure("paths", {
      unauthorizedDirtyPaths,
      unauthorizedPreexistingStagedPaths,
      preexistingStagedPathsOutsideAudited,
      excludedEvidencePaths,
      missingPaths,
      unexpectedPaths,
      observationErrors,
    }, [
      ...observationErrors.map(({ message }) => message),
      unauthorizedDirtyPaths.length === 0 ? "" : `unauthorized dirty paths: ${unauthorizedDirtyPaths.join(", ")}`,
      unauthorizedPreexistingStagedPaths.length === 0
        ? ""
        : `unauthorized pre-existing staged paths: ${unauthorizedPreexistingStagedPaths.join(", ")}`,
      preexistingStagedPathsOutsideAudited.length === 0
        ? ""
        : `pre-existing staged paths outside audited dirty set: ${preexistingStagedPathsOutsideAudited.join(", ")}`,
      excludedEvidencePaths.length === 0 ? "" : `excluded evidence paths: ${excludedEvidencePaths.join(", ")}`,
      comparison.ok ? "" : comparison.error.message,
    ].filter((message) => message !== ""));
  }
  const canonicalObservations = immutableArray([...observations].sort((left, right) => compareStrings(left.path, right.path)));
  const evidence = createAuditedEvidence(
    expected.value,
    actual.value,
    staged.value,
    comparison.value,
    stagedWithinAudited.value,
  );
  const audited = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "audited-path-set" as const,
    runId: authority.runId,
    authority,
    authorityDigest: authority.digest,
    paths: actual.value,
    observations: canonicalObservations,
    pathSetWitness: comparison.value,
    preexistingStagedPaths: staged.value,
    repositoryWitness: input.repositoryWitness,
    evidence,
    digest: digestJson({
      runId: authority.runId,
      authorityDigest: authority.digest,
      paths: actual.value.digest,
      observations: canonicalObservations,
      preexistingStagedPaths: staged.value.digest,
      repositoryWitness: input.repositoryWitness.digest,
      evidence: evidence.digest,
    }),
  }) as unknown as AuditedPathSet;
  auditedPathSetCache.add(audited);
  return ok(audited);
}

export function parseAuditedPathSet(
  raw: unknown,
  publicationResolver: StandaloneResultPublicationAuthorityResolver,
): DomainResult<AuditedPathSet, string> {
  const record = exactRecord(raw, [
    "schemaVersion", "kind", "runId", "authority", "authorityDigest", "paths", "observations",
    "pathSetWitness", "preexistingStagedPaths", "repositoryWitness", "evidence", "digest",
  ], "auditedPathSet");
  if (!record.ok) return record;
  if (record.value.schemaVersion !== 1 || record.value.kind !== "audited-path-set") return fail("auditedPathSet schema or kind is invalid");
  const authority = parseRemediationPathAuthority(record.value.authority, publicationResolver);
  const witness = parseRepositorySnapshotWitness(record.value.repositoryWitness, "auditedPathSet.repositoryWitness");
  const observations = denseArray(record.value.observations, "auditedPathSet.observations");
  const paths = parseDurablePathSet(record.value.paths, "auditedPathSet.paths");
  const preexisting = parseDurablePathSet(record.value.preexistingStagedPaths, "auditedPathSet.preexistingStagedPaths");
  const pathWitness = parseExactPathSetWitness(record.value.pathSetWitness, "auditedPathSet.pathSetWitness");
  const evidence = parseAuditedEvidence(record.value.evidence, "auditedPathSet.evidence");
  if (!authority.ok) return fail(authority.error.message);
  if (!witness.ok) return fail(witness.error.message);
  if (!observations.ok) return observations;
  if (!paths.ok) return paths;
  if (!preexisting.ok) return preexisting;
  if (!pathWitness.ok) return pathWitness;
  if (!evidence.ok) return evidence;
  const reconstructed = auditRemediationPaths(authority.value, {
    expectedDirtyPaths: pathWitness.value.expected.paths,
    actualDirtyPaths: observations.value,
    preexistingStagedPaths: preexisting.value.paths,
    repositoryWitness: witness.value,
  });
  if (!reconstructed.ok) return fail(reconstructed.error.message);
  if (record.value.runId !== reconstructed.value.runId ||
      record.value.authorityDigest !== reconstructed.value.authorityDigest ||
      record.value.digest !== reconstructed.value.digest ||
      !sameArray(paths.value.paths, reconstructed.value.paths.paths) ||
      pathWitness.value.actualDigest !== reconstructed.value.pathSetWitness.actualDigest ||
      evidence.value.digest !== reconstructed.value.evidence.digest ||
      JSON.stringify(observations.value) !== JSON.stringify(reconstructed.value.observations)) {
    return fail("auditedPathSet nested relationship or digest mismatch");
  }
  return ok(reconstructed.value);
}

declare class LiteralNulPathManifestMembership { private readonly literalNulPathManifestMembership: true }
declare class FixedGitPathspecContractMembership { private readonly fixedGitPathspecContractMembership: true }

export type LiteralNulPathManifest = LiteralNulPathManifestMembership & Readonly<{
  schemaVersion: 1;
  kind: "literal-nul-path-manifest";
  paths: RemediationPathSet;
  bytes: readonly number[];
  byteLength: number;
  contentDigest: ArtifactDigest;
  digest: ArtifactDigest;
}>;

export type FixedGitPathspecContract = FixedGitPathspecContractMembership & Readonly<{
  schemaVersion: 1;
  kind: "fixed-git-pathspec-contract";
  globalArgs: readonly ["--literal-pathspecs"];
  pathspecArgs: readonly ["--pathspec-from-file=-", "--pathspec-file-nul"];
  manifest: LiteralNulPathManifest;
  digest: ArtifactDigest;
}>;

const literalManifestCache = new WeakSet<object>();
const fixedGitPathspecCache = new WeakSet<object>();

function literalManifest(paths: RemediationPathSet): LiteralNulPathManifest {
  const bytes = paths.paths.flatMap((path) => [...Buffer.from(path, "utf8"), 0]);
  const frozenBytes = immutableArray(bytes);
  const contentDigest = digestBytes(Uint8Array.from(frozenBytes));
  const manifest = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "literal-nul-path-manifest" as const,
    paths,
    bytes: frozenBytes,
    byteLength: frozenBytes.length,
    contentDigest,
    digest: digestJson({ paths: paths.digest, byteLength: frozenBytes.length, contentDigest }),
  }) as unknown as LiteralNulPathManifest;
  literalManifestCache.add(manifest);
  return manifest;
}

function fixedGitPathspec(paths: RemediationPathSet): FixedGitPathspecContract {
  const manifest = literalManifest(paths);
  const globalArgs = Object.freeze(["--literal-pathspecs"] as const);
  const pathspecArgs = Object.freeze(["--pathspec-from-file=-", "--pathspec-file-nul"] as const);
  const contract = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "fixed-git-pathspec-contract" as const,
    globalArgs,
    pathspecArgs,
    manifest,
    digest: digestJson({ globalArgs, pathspecArgs, manifest: manifest.digest }),
  }) as unknown as FixedGitPathspecContract;
  fixedGitPathspecCache.add(contract);
  return contract;
}

function parseLiteralManifest(raw: unknown, field: string): DomainResult<LiteralNulPathManifest, string> {
  const record = exactRecord(raw, [
    "schemaVersion", "kind", "paths", "bytes", "byteLength", "contentDigest", "digest",
  ], field);
  if (!record.ok) return record;
  if (record.value.schemaVersion !== 1 || record.value.kind !== "literal-nul-path-manifest") return fail(`${field} schema or kind is invalid`);
  const paths = parseDurablePathSet(record.value.paths, `${field}.paths`);
  const bytes = denseArray(record.value.bytes, `${field}.bytes`);
  if (!paths.ok) return paths;
  if (!bytes.ok) return bytes;
  if (bytes.value.some((byte) => typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    return fail(`${field}.bytes contains a non-byte value`);
  }
  const expected = literalManifest(paths.value);
  if (record.value.byteLength !== expected.byteLength || record.value.contentDigest !== expected.contentDigest ||
      record.value.digest !== expected.digest || !sameArray(bytes.value, expected.bytes)) return fail(`${field} bytes or digest mismatch`);
  return ok(expected);
}

export function parseFixedGitPathspecContract(raw: unknown): DomainResult<FixedGitPathspecContract, string> {
  const record = exactRecord(raw, ["schemaVersion", "kind", "globalArgs", "pathspecArgs", "manifest", "digest"], "gitPathspec");
  if (!record.ok) return record;
  if (record.value.schemaVersion !== 1 || record.value.kind !== "fixed-git-pathspec-contract") return fail("gitPathspec schema or kind is invalid");
  const globalArgs = denseArray(record.value.globalArgs, "gitPathspec.globalArgs");
  const pathspecArgs = denseArray(record.value.pathspecArgs, "gitPathspec.pathspecArgs");
  const manifest = parseLiteralManifest(record.value.manifest, "gitPathspec.manifest");
  if (!globalArgs.ok) return globalArgs;
  if (!pathspecArgs.ok) return pathspecArgs;
  if (!manifest.ok) return manifest;
  if (!sameArray(globalArgs.value, ["--literal-pathspecs"]) ||
      !sameArray(pathspecArgs.value, ["--pathspec-from-file=-", "--pathspec-file-nul"])) {
    return fail("gitPathspec fixed Git arguments were changed");
  }
  const expected = fixedGitPathspec(manifest.value.paths);
  if (record.value.digest !== expected.digest) return fail("gitPathspec digest mismatch");
  return ok(expected);
}

/** T9 boundary: raw paths exist only in a NUL manifest, never as Git selector arguments. */
export function prepareLiteralGitPathspec(
  audited: AuditedPathSet,
): DomainResult<FixedGitPathspecContract, TemporaryIndexError> {
  return auditedPathSetCache.has(audited)
    ? ok(fixedGitPathspec(audited.paths))
    : fail(canonicalRecord({
        kind: "temporary-index-rejected",
        field: "audited",
        message: "Git staging pathspec requires a parser-produced AuditedPathSet",
      }));
}

declare class StagedTemporaryIndexMembership { private readonly stagedTemporaryIndexMembership: true }

export type StagedTemporaryIndex = StagedTemporaryIndexMembership & Readonly<{
  schemaVersion: 1;
  kind: "staged-temporary-index";
  runId: OrchestrationRunId;
  audited: AuditedPathSet;
  expectedPaths: RemediationPathSet;
  gitPathspec: FixedGitPathspecContract;
  temporaryIndexDigest: ArtifactDigest;
  repositoryWitness: RepositorySnapshotWitness;
  digest: ArtifactDigest;
}>;

export type TemporaryIndexError = Readonly<{
  kind: "temporary-index-rejected";
  field: string;
  message: string;
  pathMismatch?: PathSetComparisonError;
  repositoryMismatch?: RepositoryWitnessComparisonError;
}>;

const stagedTemporaryIndexCache = new WeakSet<object>();

export function stageTemporaryIndex(
  audited: AuditedPathSet,
  rawTemporaryIndexDigest: unknown,
  currentRepositoryWitness: RepositorySnapshotWitness,
): DomainResult<StagedTemporaryIndex, TemporaryIndexError> {
  if (!auditedPathSetCache.has(audited)) {
    return fail(canonicalRecord({
      kind: "temporary-index-rejected",
      field: "audited",
      message: "temporary staging accepts only a parser-produced nominal AuditedPathSet",
    }));
  }
  if (!repositoryWitnessCache.has(currentRepositoryWitness)) {
    return fail(canonicalRecord({
      kind: "temporary-index-rejected",
      field: "currentRepositoryWitness",
      message: "current repository witness is not parser-produced",
    }));
  }
  const unchanged = compareRepositoryWitnesses(audited.repositoryWitness, currentRepositoryWitness);
  if (!unchanged.ok) {
    return fail(canonicalRecord({
      kind: "temporary-index-rejected",
      field: "currentRepositoryWitness",
      message: unchanged.error.message,
      repositoryMismatch: unchanged.error,
    }));
  }
  const indexDigest = parseArtifactDigest(rawTemporaryIndexDigest);
  if (!indexDigest.ok) {
    return fail(canonicalRecord({
      kind: "temporary-index-rejected",
      field: "temporaryIndexDigest",
      message: indexDigest.error.message,
    }));
  }
  const gitPathspec = fixedGitPathspec(audited.paths);
  const staged = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "staged-temporary-index" as const,
    runId: audited.runId,
    audited,
    expectedPaths: audited.paths,
    gitPathspec,
    temporaryIndexDigest: indexDigest.value,
    repositoryWitness: currentRepositoryWitness,
    digest: digestJson({
      runId: audited.runId,
      auditedDigest: audited.digest,
      expectedPathsDigest: audited.paths.digest,
      gitPathspec: gitPathspec.digest,
      temporaryIndexDigest: indexDigest.value,
      repositoryWitness: currentRepositoryWitness.digest,
    }),
  }) as unknown as StagedTemporaryIndex;
  stagedTemporaryIndexCache.add(staged);
  return ok(staged);
}

export function parseStagedTemporaryIndex(
  raw: unknown,
  publicationResolver: StandaloneResultPublicationAuthorityResolver,
): DomainResult<StagedTemporaryIndex, string> {
  const record = exactRecord(raw, [
    "schemaVersion", "kind", "runId", "audited", "expectedPaths", "gitPathspec",
    "temporaryIndexDigest", "repositoryWitness", "digest",
  ], "stagedTemporaryIndex");
  if (!record.ok) return record;
  if (record.value.schemaVersion !== 1 || record.value.kind !== "staged-temporary-index") return fail("stagedTemporaryIndex schema or kind is invalid");
  const audited = parseAuditedPathSet(record.value.audited, publicationResolver);
  const expected = parseDurablePathSet(record.value.expectedPaths, "stagedTemporaryIndex.expectedPaths");
  const pathspec = parseFixedGitPathspecContract(record.value.gitPathspec);
  const witness = parseRepositorySnapshotWitness(record.value.repositoryWitness, "stagedTemporaryIndex.repositoryWitness");
  if (!audited.ok) return audited;
  if (!expected.ok) return expected;
  if (!pathspec.ok) return pathspec;
  if (!witness.ok) return fail(witness.error.message);
  const reconstructed = stageTemporaryIndex(audited.value, record.value.temporaryIndexDigest, witness.value);
  if (!reconstructed.ok) return fail(reconstructed.error.message);
  if (record.value.runId !== reconstructed.value.runId || record.value.digest !== reconstructed.value.digest ||
      !sameArray(expected.value.paths, reconstructed.value.expectedPaths.paths) ||
      pathspec.value.digest !== reconstructed.value.gitPathspec.digest) return fail("stagedTemporaryIndex nested relationship or digest mismatch");
  return ok(reconstructed.value);
}

function createExactStagingEvidence(
  auditedPaths: RemediationPathSet,
  dirtyPaths: RemediationPathSet,
  preexistingStagedPaths: RemediationPathSet,
  temporaryIndexStagedPaths: RemediationPathSet,
  auditedEqualsDirty: ExactPathSetWitness,
  stagedWithinAudited: PathSetSubsetWitness,
  auditedEqualsTemporaryIndexStaged: ExactPathSetWitness,
): ExactStagingEvidencePublication {
  const evidence = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "audited-dirty-temporary-index-evidence" as const,
    auditedPaths,
    dirtyPaths,
    preexistingStagedPaths,
    temporaryIndexStagedPaths,
    auditedEqualsDirty,
    preexistingStagedWithinAudited: stagedWithinAudited,
    auditedEqualsTemporaryIndexStaged,
    digest: digestJson({
      audited: auditedPaths.digest,
      dirty: dirtyPaths.digest,
      preexistingStaged: preexistingStagedPaths.digest,
      temporaryIndexStaged: temporaryIndexStagedPaths.digest,
      auditedEqualsDirty: auditedEqualsDirty.actualDigest,
      stagedWithinAudited: stagedWithinAudited.subsetDigest,
      auditedEqualsTemporaryIndexStaged: auditedEqualsTemporaryIndexStaged.actualDigest,
    }),
  }) as unknown as ExactStagingEvidencePublication;
  exactStagingEvidenceCache.add(evidence);
  return evidence;
}

function parseExactStagingEvidence(raw: unknown, field: string): DomainResult<ExactStagingEvidencePublication, string> {
  const record = exactRecord(raw, [
    "schemaVersion", "kind", "auditedPaths", "dirtyPaths", "preexistingStagedPaths",
    "temporaryIndexStagedPaths", "auditedEqualsDirty", "preexistingStagedWithinAudited",
    "auditedEqualsTemporaryIndexStaged", "digest",
  ], field);
  if (!record.ok) return record;
  if (record.value.schemaVersion !== 1 || record.value.kind !== "audited-dirty-temporary-index-evidence") {
    return fail(`${field} schema or kind is invalid`);
  }
  const audited = parseDurablePathSet(record.value.auditedPaths, `${field}.auditedPaths`);
  const dirty = parseDurablePathSet(record.value.dirtyPaths, `${field}.dirtyPaths`);
  const preexisting = parseDurablePathSet(record.value.preexistingStagedPaths, `${field}.preexistingStagedPaths`);
  const temporaryIndex = parseDurablePathSet(record.value.temporaryIndexStagedPaths, `${field}.temporaryIndexStagedPaths`);
  const auditedDirty = parseExactPathSetWitness(record.value.auditedEqualsDirty, `${field}.auditedEqualsDirty`);
  const stagedWithinAudited = parsePathSetSubsetWitness(
    record.value.preexistingStagedWithinAudited,
    `${field}.preexistingStagedWithinAudited`,
  );
  const auditedTemporaryIndex = parseExactPathSetWitness(
    record.value.auditedEqualsTemporaryIndexStaged,
    `${field}.auditedEqualsTemporaryIndexStaged`,
  );
  if (!audited.ok) return audited;
  if (!dirty.ok) return dirty;
  if (!preexisting.ok) return preexisting;
  if (!temporaryIndex.ok) return temporaryIndex;
  if (!auditedDirty.ok) return auditedDirty;
  if (!stagedWithinAudited.ok) return stagedWithinAudited;
  if (!auditedTemporaryIndex.ok) return auditedTemporaryIndex;
  if (!sameArray(auditedDirty.value.expected.paths, audited.value.paths) ||
      !sameArray(auditedDirty.value.actual.paths, dirty.value.paths) ||
      !sameArray(stagedWithinAudited.value.subset.paths, preexisting.value.paths) ||
      !sameArray(stagedWithinAudited.value.superset.paths, audited.value.paths) ||
      !sameArray(auditedTemporaryIndex.value.expected.paths, audited.value.paths) ||
      !sameArray(auditedTemporaryIndex.value.actual.paths, temporaryIndex.value.paths)) {
    return fail(`${field} exact set relationship mismatch`);
  }
  const evidence = createExactStagingEvidence(
    audited.value,
    dirty.value,
    preexisting.value,
    temporaryIndex.value,
    auditedDirty.value,
    stagedWithinAudited.value,
    auditedTemporaryIndex.value,
  );
  if (record.value.digest !== evidence.digest) return fail(`${field}.digest mismatch`);
  return ok(evidence);
}

declare class VerifiedTemporaryIndexMembership { private readonly verifiedTemporaryIndexMembership: true }

export type VerifiedTemporaryIndex = VerifiedTemporaryIndexMembership & Readonly<{
  schemaVersion: 1;
  kind: "verified-temporary-index";
  runId: OrchestrationRunId;
  staged: StagedTemporaryIndex;
  exactPaths: ExactPathSetWitness;
  evidence: ExactStagingEvidencePublication;
  indexDigest: ArtifactDigest;
  repositoryWitness: RepositorySnapshotWitness;
  witnessDigest: ArtifactDigest;
  digest: ArtifactDigest;
}>;

export type VerifyTemporaryIndexInput = Readonly<{
  actualTemporaryIndexStagedPaths: unknown;
  actualIndexDigest: unknown;
  currentRepositoryWitness: RepositorySnapshotWitness;
}>;

const verifiedTemporaryIndexCache = new WeakSet<object>();

export function verifyTemporaryIndex(
  staged: StagedTemporaryIndex,
  input: VerifyTemporaryIndexInput,
): DomainResult<VerifiedTemporaryIndex, TemporaryIndexError> {
  if (!stagedTemporaryIndexCache.has(staged)) {
    return fail(canonicalRecord({
      kind: "temporary-index-rejected",
      field: "staged",
      message: "verification accepts only a nominal temporary index staged from AuditedPathSet authority",
    }));
  }
  const actualTemporaryIndex = parseRemediationPathSet(
    input.actualTemporaryIndexStagedPaths,
    "actualTemporaryIndexStagedPaths",
  );
  if (!actualTemporaryIndex.ok) {
    return fail(canonicalRecord({
      kind: "temporary-index-rejected",
      field: "actualTemporaryIndexStagedPaths",
      message: actualTemporaryIndex.error.message,
    }));
  }
  const exactPaths = compareExactPathSets(staged.expectedPaths, actualTemporaryIndex.value);
  if (!exactPaths.ok) {
    return fail(canonicalRecord({
      kind: "temporary-index-rejected",
      field: "actualTemporaryIndexStagedPaths",
      message: exactPaths.error.message,
      pathMismatch: exactPaths.error,
    }));
  }
  if (actualTemporaryIndex.value.paths.some(isExcludedRemediationPath)) {
    return fail(canonicalRecord({
      kind: "temporary-index-rejected",
      field: "actualTemporaryIndexStagedPaths",
      message: "temporary remediation index contains excluded Loom evidence",
    }));
  }
  const actualIndexDigest = parseArtifactDigest(input.actualIndexDigest);
  if (!actualIndexDigest.ok) return fail(canonicalRecord({ kind: "temporary-index-rejected", field: "actualIndexDigest", message: actualIndexDigest.error.message }));
  if (actualIndexDigest.value !== staged.temporaryIndexDigest) {
    return fail(canonicalRecord({ kind: "temporary-index-rejected", field: "actualIndexDigest", message: "temporary index digest does not match staged witness" }));
  }
  const unchanged = compareRepositoryWitnesses(staged.repositoryWitness, input.currentRepositoryWitness);
  if (!unchanged.ok) {
    return fail(canonicalRecord({
      kind: "temporary-index-rejected",
      field: "currentRepositoryWitness",
      message: unchanged.error.message,
      repositoryMismatch: unchanged.error,
    }));
  }
  const evidence = createExactStagingEvidence(
    staged.audited.evidence.auditedPaths,
    staged.audited.evidence.dirtyPaths,
    staged.audited.preexistingStagedPaths,
    actualTemporaryIndex.value,
    staged.audited.pathSetWitness,
    staged.audited.evidence.preexistingStagedWithinAudited,
    exactPaths.value,
  );
  const witnessDigest = digestJson({
    repositoryWitness: input.currentRepositoryWitness.digest,
    evidence: evidence.digest,
    indexDigest: actualIndexDigest.value,
  });
  const verified = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "verified-temporary-index" as const,
    runId: staged.runId,
    staged,
    exactPaths: exactPaths.value,
    evidence,
    indexDigest: actualIndexDigest.value,
    repositoryWitness: input.currentRepositoryWitness,
    witnessDigest,
    digest: digestJson({
      runId: staged.runId,
      stagedDigest: staged.digest,
      evidence: evidence.digest,
      indexDigest: actualIndexDigest.value,
      witnessDigest,
    }),
  }) as unknown as VerifiedTemporaryIndex;
  verifiedTemporaryIndexCache.add(verified);
  return ok(verified);
}

export function parseVerifiedTemporaryIndex(
  raw: unknown,
  publicationResolver: StandaloneResultPublicationAuthorityResolver,
): DomainResult<VerifiedTemporaryIndex, string> {
  const record = exactRecord(raw, [
    "schemaVersion", "kind", "runId", "staged", "exactPaths", "evidence", "indexDigest",
    "repositoryWitness", "witnessDigest", "digest",
  ], "verifiedTemporaryIndex");
  if (!record.ok) return record;
  if (record.value.schemaVersion !== 1 || record.value.kind !== "verified-temporary-index") return fail("verifiedTemporaryIndex schema or kind is invalid");
  const staged = parseStagedTemporaryIndex(record.value.staged, publicationResolver);
  const exactPaths = parseExactPathSetWitness(record.value.exactPaths, "verifiedTemporaryIndex.exactPaths");
  const evidence = parseExactStagingEvidence(record.value.evidence, "verifiedTemporaryIndex.evidence");
  const witness = parseRepositorySnapshotWitness(record.value.repositoryWitness, "verifiedTemporaryIndex.repositoryWitness");
  if (!staged.ok) return staged;
  if (!exactPaths.ok) return exactPaths;
  if (!evidence.ok) return evidence;
  if (!witness.ok) return fail(witness.error.message);
  const reconstructed = verifyTemporaryIndex(staged.value, {
    actualTemporaryIndexStagedPaths: evidence.value.temporaryIndexStagedPaths.paths,
    actualIndexDigest: record.value.indexDigest,
    currentRepositoryWitness: witness.value,
  });
  if (!reconstructed.ok) return fail(reconstructed.error.message);
  if (record.value.runId !== reconstructed.value.runId || record.value.witnessDigest !== reconstructed.value.witnessDigest ||
      record.value.digest !== reconstructed.value.digest || exactPaths.value.actualDigest !== reconstructed.value.exactPaths.actualDigest ||
      evidence.value.digest !== reconstructed.value.evidence.digest) return fail("verifiedTemporaryIndex nested relationship or digest mismatch");
  return ok(reconstructed.value);
}

declare class VerifiedIndexInstallationMembership { private readonly verifiedIndexInstallationMembership: true }

export type VerifiedIndexInstallation = VerifiedIndexInstallationMembership & Readonly<{
  schemaVersion: 1;
  kind: "verified-index-installation";
  verified: VerifiedTemporaryIndex;
  verifiedIndexDigest: ArtifactDigest;
  intent: InstallVerifiedIndex;
  digest: ArtifactDigest;
}>;

const verifiedInstallationCache = new WeakSet<object>();

export function prepareVerifiedIndexInstallation(
  verified: VerifiedTemporaryIndex,
  rawEffectId: unknown,
  currentRepositoryWitness: RepositorySnapshotWitness,
): DomainResult<VerifiedIndexInstallation, TemporaryIndexError> {
  if (!verifiedTemporaryIndexCache.has(verified)) {
    return fail(canonicalRecord({ kind: "temporary-index-rejected", field: "verified", message: "installation accepts only a nominal verified temporary index" }));
  }
  const effectId = parseEffectId(rawEffectId);
  if (!effectId.ok) return fail(canonicalRecord({ kind: "temporary-index-rejected", field: "effectId", message: effectId.error.message }));
  const unchanged = compareRepositoryWitnesses(verified.repositoryWitness, currentRepositoryWitness);
  if (!unchanged.ok) {
    return fail(canonicalRecord({
      kind: "temporary-index-rejected",
      field: "currentRepositoryWitness",
      message: unchanged.error.message,
      repositoryMismatch: unchanged.error,
    }));
  }
  const intent: InstallVerifiedIndex = canonicalRecord({
    kind: "install-verified-index",
    effectId: effectId.value,
    runId: verified.runId,
    indexDigest: verified.indexDigest,
    witnessDigest: verified.witnessDigest,
  });
  const installation = canonicalRecord({
    schemaVersion: 1 as const,
    kind: "verified-index-installation" as const,
    verified,
    verifiedIndexDigest: verified.digest,
    intent,
    digest: digestJson({ verifiedIndexDigest: verified.digest, intent }),
  }) as unknown as VerifiedIndexInstallation;
  verifiedInstallationCache.add(installation);
  return ok(installation);
}

export function parseVerifiedIndexInstallation(
  raw: unknown,
  publicationResolver: StandaloneResultPublicationAuthorityResolver,
): DomainResult<VerifiedIndexInstallation, string> {
  const record = exactRecord(raw, ["schemaVersion", "kind", "verified", "verifiedIndexDigest", "intent", "digest"], "installation");
  if (!record.ok) return record;
  if (record.value.schemaVersion !== 1 || record.value.kind !== "verified-index-installation") return fail("installation schema or kind is invalid");
  const verified = parseVerifiedTemporaryIndex(record.value.verified, publicationResolver);
  const intent = exactRecord(record.value.intent, ["kind", "effectId", "runId", "indexDigest", "witnessDigest"], "installation.intent");
  if (!verified.ok) return verified;
  if (!intent.ok) return intent;
  if (intent.value.kind !== "install-verified-index") return fail("installation.intent.kind is invalid");
  const reconstructed = prepareVerifiedIndexInstallation(verified.value, intent.value.effectId, verified.value.repositoryWitness);
  if (!reconstructed.ok) return fail(reconstructed.error.message);
  if (record.value.verifiedIndexDigest !== reconstructed.value.verifiedIndexDigest ||
      record.value.digest !== reconstructed.value.digest ||
      intent.value.runId !== reconstructed.value.intent.runId || intent.value.indexDigest !== reconstructed.value.intent.indexDigest ||
      intent.value.witnessDigest !== reconstructed.value.intent.witnessDigest) return fail("installation nested relationship or digest mismatch");
  return ok(reconstructed.value);
}

declare const RECOVERY_ATTEMPT_ID: unique symbol;
declare const RECOVERY_RECEIPT_ID: unique symbol;
export type RecoveryAttemptId = string & { readonly [RECOVERY_ATTEMPT_ID]: true };
export type RecoveryReceiptId = string & { readonly [RECOVERY_RECEIPT_ID]: true };

function parseRecoveryIdentity<T extends RecoveryAttemptId | RecoveryReceiptId>(raw: unknown, field: string): DomainResult<T, string> {
  const parsed = parseEffectId(raw);
  return parsed.ok ? ok(parsed.value as unknown as T) : fail(`${field}: ${parsed.error.message}`);
}

export const parseRecoveryAttemptId = (raw: unknown): DomainResult<RecoveryAttemptId, string> =>
  parseRecoveryIdentity(raw, "recoveryAttemptId");
export const parseRecoveryReceiptId = (raw: unknown): DomainResult<RecoveryReceiptId, string> =>
  parseRecoveryIdentity(raw, "recoveryReceiptId");

type RecoveryHistory = Readonly<{
  recoveryAttemptIds: readonly RecoveryAttemptId[];
  consumedRecoveryReceiptIds: readonly RecoveryReceiptId[];
}>;

interface RemediationStateBase extends RecoveryHistory {
  readonly authority: RemediationPathAuthority;
}

export type ActiveRemediationState =
  | Readonly<RemediationStateBase & { state: "authority-frozen"; authority: FrozenPathAuthority }>
  | Readonly<RemediationStateBase & { state: "paths-registered"; authority: RegisteredPathAuthority }>
  | Readonly<RemediationStateBase & { state: "audited"; audited: AuditedPathSet }>
  | Readonly<RemediationStateBase & {
      state: "staged-temporary-index";
      audited: AuditedPathSet;
      staged: StagedTemporaryIndex;
    }>
  | Readonly<RemediationStateBase & {
      state: "verified";
      audited: AuditedPathSet;
      staged: StagedTemporaryIndex;
      verified: VerifiedTemporaryIndex;
    }>;

export type RemediationRecoveryFailure = Readonly<{
  recoveryAttemptId: RecoveryAttemptId;
  effectId: EffectId;
  predecessorState: ActiveRemediationState["state"];
  witnessDigest: ArtifactDigest;
  message: string;
  digest: ArtifactDigest;
}>;

export type RecoverableBlockedRemediationState = Readonly<RemediationStateBase & {
  state: "recoverable-blocked";
  predecessor: ActiveRemediationState;
  failure: RemediationRecoveryFailure;
}>;

export type DoneRemediationState = Readonly<RemediationStateBase & {
  state: "done";
  verified: VerifiedTemporaryIndex;
  installation: VerifiedIndexInstallation;
  receipt: VerifiedIndexInstalled;
}>;

export type RemediationState = ActiveRemediationState | RecoverableBlockedRemediationState | DoneRemediationState;

export type RemediationRecoveryReceipt = Readonly<{
  kind: "remediation-recovery-receipt";
  receiptId: RecoveryReceiptId;
  recoveryAttemptId: RecoveryAttemptId;
  runId: OrchestrationRunId;
  effectId: EffectId;
  predecessorState: ActiveRemediationState["state"];
  witnessDigest: ArtifactDigest;
  digest: ArtifactDigest;
}>;

export type RemediationEvent =
  | Readonly<{ kind: "support-path-registered"; path: unknown }>
  | Readonly<{ kind: "audit-succeeded"; audited: AuditedPathSet }>
  | Readonly<{ kind: "temporary-index-staged"; staged: StagedTemporaryIndex }>
  | Readonly<{ kind: "staged-set-verified"; verified: VerifiedTemporaryIndex }>
  | Readonly<{ kind: "index-installed"; installation: VerifiedIndexInstallation; receipt: unknown }>
  | Readonly<{ kind: "recoverable-effect-failed"; recoveryAttemptId: unknown; effectId: unknown; message: unknown }>
  | Readonly<{ kind: "recovery-receipt-accepted"; receipt: unknown }>;

export type RemediationTransitionError = Readonly<{
  kind:
    | "invalid-remediation-transition"
    | "remediation-authority-mismatch"
    | "invalid-recovery-receipt"
    | "index-installation-receipt-mismatch";
  state: RemediationState["state"];
  event: RemediationEvent["kind"];
  field: string;
  message: string;
}>;

function transitionFailure(
  state: RemediationState,
  event: RemediationEvent,
  kind: RemediationTransitionError["kind"],
  field: string,
  message: string,
): DomainResult<RemediationState, RemediationTransitionError> {
  return fail(canonicalRecord({ kind, state: state.state, event: event.kind, field, message }));
}

function activeStateDigest(state: ActiveRemediationState): ArtifactDigest {
  switch (state.state) {
    case "authority-frozen":
    case "paths-registered": return state.authority.digest;
    case "audited": return state.audited.digest;
    case "staged-temporary-index": return state.staged.digest;
    case "verified": return state.verified.digest;
  }
}

function recoveryReceiptDigest(fields: Omit<RemediationRecoveryReceipt, "kind" | "digest">): ArtifactDigest {
  return digestJson(fields);
}

function parseRecoveryReceipt(raw: unknown): DomainResult<RemediationRecoveryReceipt, string> {
  const record = exactRecord(raw, [
    "kind", "receiptId", "recoveryAttemptId", "runId", "effectId", "predecessorState", "witnessDigest", "digest",
  ], "recoveryReceipt");
  if (!record.ok) return record;
  if (record.value.kind !== "remediation-recovery-receipt") return fail("recoveryReceipt.kind is invalid");
  const receiptId = parseRecoveryReceiptId(record.value.receiptId);
  const attemptId = parseRecoveryAttemptId(record.value.recoveryAttemptId);
  const runId = parseOrchestrationRunId(record.value.runId);
  const effectId = parseEffectId(record.value.effectId);
  const witnessDigest = parseArtifactDigest(record.value.witnessDigest);
  const digest = parseArtifactDigest(record.value.digest);
  const predecessorStates: readonly ActiveRemediationState["state"][] = [
    "authority-frozen", "paths-registered", "audited", "staged-temporary-index", "verified",
  ];
  if (!receiptId.ok) return receiptId;
  if (!attemptId.ok) return attemptId;
  if (!runId.ok) return fail(runId.error.message);
  if (!effectId.ok) return fail(effectId.error.message);
  if (!witnessDigest.ok) return fail(witnessDigest.error.message);
  if (!digest.ok) return fail(digest.error.message);
  if (!includes(predecessorStates, record.value.predecessorState)) return fail("recoveryReceipt.predecessorState is invalid");
  const fields = {
    receiptId: receiptId.value,
    recoveryAttemptId: attemptId.value,
    runId: runId.value,
    effectId: effectId.value,
    predecessorState: record.value.predecessorState,
    witnessDigest: witnessDigest.value,
  };
  const expectedDigest = recoveryReceiptDigest(fields);
  if (digest.value !== expectedDigest) return fail("recoveryReceipt.digest mismatch");
  return ok(canonicalRecord({ kind: "remediation-recovery-receipt", ...fields, digest: expectedDigest }));
}

export function recoveryReceiptFor(
  state: RecoverableBlockedRemediationState,
  rawReceiptId: unknown,
): DomainResult<RemediationRecoveryReceipt, string> {
  const receiptId = parseRecoveryReceiptId(rawReceiptId);
  if (!receiptId.ok) return receiptId;
  if (state.consumedRecoveryReceiptIds.includes(receiptId.value)) return fail("recovery receipt identity was already consumed");
  const fields = {
    receiptId: receiptId.value,
    recoveryAttemptId: state.failure.recoveryAttemptId,
    runId: state.authority.runId,
    effectId: state.failure.effectId,
    predecessorState: state.failure.predecessorState,
    witnessDigest: state.failure.witnessDigest,
  };
  return ok(canonicalRecord({ kind: "remediation-recovery-receipt", ...fields, digest: recoveryReceiptDigest(fields) }));
}

function history(raw: Readonly<Record<string, unknown>>, label: string): DomainResult<RecoveryHistory, string> {
  const attempts = denseArray(raw.recoveryAttemptIds, `${label}.recoveryAttemptIds`);
  const receipts = denseArray(raw.consumedRecoveryReceiptIds, `${label}.consumedRecoveryReceiptIds`);
  if (!attempts.ok) return attempts;
  if (!receipts.ok) return receipts;
  const parsedAttempts: RecoveryAttemptId[] = [];
  const parsedReceipts: RecoveryReceiptId[] = [];
  for (let index = 0; index < attempts.value.length; index++) {
    const parsed = parseRecoveryAttemptId(attempts.value[index]);
    if (!parsed.ok) return fail(`${label}.recoveryAttemptIds[${index}]: ${parsed.error}`);
    parsedAttempts.push(parsed.value);
  }
  for (let index = 0; index < receipts.value.length; index++) {
    const parsed = parseRecoveryReceiptId(receipts.value[index]);
    if (!parsed.ok) return fail(`${label}.consumedRecoveryReceiptIds[${index}]: ${parsed.error}`);
    parsedReceipts.push(parsed.value);
  }
  if (new Set(parsedAttempts).size !== parsedAttempts.length) return fail(`${label}.recoveryAttemptIds contains a reused attempt`);
  if (new Set(parsedReceipts).size !== parsedReceipts.length) return fail(`${label}.consumedRecoveryReceiptIds contains a reused receipt`);
  return ok(canonicalRecord({ recoveryAttemptIds: immutableArray(parsedAttempts), consumedRecoveryReceiptIds: immutableArray(parsedReceipts) }));
}

type RecoveryHistoryLifecycle = "active" | "recoverable-blocked" | "done";

function enforceRecoveryHistoryLifecycle(
  recoveryHistory: RecoveryHistory,
  lifecycle: RecoveryHistoryLifecycle,
  label: string,
): DomainResult<RecoveryHistory, string> {
  const attemptCount = recoveryHistory.recoveryAttemptIds.length;
  const receiptCount = recoveryHistory.consumedRecoveryReceiptIds.length;
  if (receiptCount > attemptCount) {
    return fail(`${label} has more consumed recovery receipts than recovery attempts`);
  }
  if (lifecycle === "recoverable-blocked") {
    return receiptCount < attemptCount
      ? ok(recoveryHistory)
      : fail(`${label} recoverable-blocked history requires an outstanding recovery attempt`);
  }
  // A resolved lifecycle needs SOME receipt, not one per attempt. Repeated
  // failures while already blocked append an attempt id and replace
  // `state.failure`, and `recovery-receipt-accepted` only ever matches the
  // latest attempt — so one receipt discharges the block however many attempts
  // preceded it, and `0 < receiptCount < attemptCount` is a state the reducer
  // itself produces. Only a resolved history with NO receipt at all is forged.
  if (attemptCount > 0 && receiptCount === 0) {
    return fail(`${label} ${lifecycle} history cannot contain recovery attempts before any recovery receipt was accepted`);
  }
  return ok(recoveryHistory);
}

function withHistory<T extends ActiveRemediationState>(
  state: T,
  recoveryAttemptIds: readonly RecoveryAttemptId[],
  consumedRecoveryReceiptIds: readonly RecoveryReceiptId[],
): T {
  return canonicalRecord({ ...state, recoveryAttemptIds: immutableArray(recoveryAttemptIds), consumedRecoveryReceiptIds: immutableArray(consumedRecoveryReceiptIds) }) as T;
}

const remediationStateCache = new WeakSet<object>();

function mintRemediationState<T extends RemediationState>(state: T): T {
  remediationStateCache.add(state);
  return state;
}

export function startRemediation(
  input: StartRemediationInput,
): DomainResult<RemediationState, PathAuthorityError | RemediationPathSetError> {
  const authority = freezePathAuthority(input);
  return authority.ok
    ? ok(mintRemediationState(canonicalRecord({
        state: "authority-frozen" as const,
        authority: authority.value,
        recoveryAttemptIds: Object.freeze([]) as readonly RecoveryAttemptId[],
        consumedRecoveryReceiptIds: Object.freeze([]) as readonly RecoveryReceiptId[],
      })))
    : authority;
}

function reduceParserMintedRemediation(
  state: RemediationState,
  event: RemediationEvent,
): DomainResult<RemediationState, RemediationTransitionError> {
  if (event.kind === "recoverable-effect-failed") {
    if (state.state === "done") return transitionFailure(state, event, "invalid-remediation-transition", "event", "done remediation is terminal");
    const effectId = parseEffectId(event.effectId);
    const attemptId = parseRecoveryAttemptId(event.recoveryAttemptId);
    if (!effectId.ok) return transitionFailure(state, event, "invalid-recovery-receipt", "effectId", effectId.error.message);
    if (!attemptId.ok) return transitionFailure(state, event, "invalid-recovery-receipt", "recoveryAttemptId", attemptId.error);
    if (state.recoveryAttemptIds.includes(attemptId.value)) {
      return transitionFailure(state, event, "invalid-recovery-receipt", "recoveryAttemptId", "recovery failure attempt identity is stale or reused");
    }
    if (typeof event.message !== "string" || event.message.trim() === "") {
      return transitionFailure(state, event, "invalid-recovery-receipt", "message", "recoverable failure message must be non-empty");
    }
    const predecessor = state.state === "recoverable-blocked"
      ? state.predecessor
      : state;
    const failureFields = {
      recoveryAttemptId: attemptId.value,
      effectId: effectId.value,
      predecessorState: predecessor.state,
      witnessDigest: activeStateDigest(predecessor),
      message: event.message,
    };
    return ok(canonicalRecord({
      state: "recoverable-blocked" as const,
      authority: predecessor.authority,
      predecessor,
      recoveryAttemptIds: immutableArray([...state.recoveryAttemptIds, attemptId.value]),
      consumedRecoveryReceiptIds: state.consumedRecoveryReceiptIds,
      failure: canonicalRecord({ ...failureFields, digest: digestJson(failureFields) }),
    }));
  }

  if (event.kind === "recovery-receipt-accepted") {
    if (state.state !== "recoverable-blocked") {
      return transitionFailure(state, event, "invalid-remediation-transition", "event", "recovery is permitted only from recoverable-blocked");
    }
    const receipt = parseRecoveryReceipt(event.receipt);
    if (!receipt.ok) return transitionFailure(state, event, "invalid-recovery-receipt", "receipt", receipt.error);
    if (state.consumedRecoveryReceiptIds.includes(receipt.value.receiptId)) {
      return transitionFailure(state, event, "invalid-recovery-receipt", "receipt.receiptId", "recovery receipt is stale or already consumed");
    }
    const mismatch = receipt.value.runId !== state.authority.runId ? "runId"
      : receipt.value.recoveryAttemptId !== state.failure.recoveryAttemptId ? "recoveryAttemptId"
      : receipt.value.effectId !== state.failure.effectId ? "effectId"
      : receipt.value.predecessorState !== state.failure.predecessorState ? "predecessorState"
      : receipt.value.witnessDigest !== state.failure.witnessDigest ? "witnessDigest"
      : null;
    if (mismatch !== null) {
      return transitionFailure(state, event, "invalid-recovery-receipt", `receipt.${mismatch}`, `recovery receipt is stale or foreign: ${mismatch} mismatch`);
    }
    return ok(withHistory(
      state.predecessor,
      state.recoveryAttemptIds,
      [...state.consumedRecoveryReceiptIds, receipt.value.receiptId],
    ));
  }

  switch (state.state) {
    case "authority-frozen":
    case "paths-registered": {
      if (event.kind === "support-path-registered") {
        const registered = registerSupportPath(state.authority, event.path);
        return registered.ok
          ? ok(canonicalRecord({ ...state, state: "paths-registered" as const, authority: registered.value }))
          : transitionFailure(state, event, "remediation-authority-mismatch", registered.error.field, registered.error.message);
      }
      if (event.kind === "audit-succeeded") {
        if (!auditedPathSetCache.has(event.audited) || event.audited.runId !== state.authority.runId ||
            event.audited.authorityDigest !== state.authority.digest) {
          return transitionFailure(state, event, "remediation-authority-mismatch", "audited", "audit proof is stale, foreign, or not parser-produced for current authority");
        }
        return ok(canonicalRecord({ ...state, state: "audited" as const, audited: event.audited }));
      }
      return transitionFailure(state, event, "invalid-remediation-transition", "event", `event ${event.kind} is not declared from ${state.state}`);
    }
    case "audited":
      if (event.kind !== "temporary-index-staged") return transitionFailure(state, event, "invalid-remediation-transition", "event", `event ${event.kind} is not declared from audited`);
      if (!stagedTemporaryIndexCache.has(event.staged) || event.staged.audited.digest !== state.audited.digest) {
        return transitionFailure(state, event, "remediation-authority-mismatch", "staged", "temporary index is stale, foreign, or not staged from this AuditedPathSet");
      }
      return ok(canonicalRecord({ ...state, state: "staged-temporary-index" as const, staged: event.staged }));
    case "staged-temporary-index":
      if (event.kind !== "staged-set-verified") return transitionFailure(state, event, "invalid-remediation-transition", "event", `event ${event.kind} is not declared from staged-temporary-index`);
      if (!verifiedTemporaryIndexCache.has(event.verified) || event.verified.staged.digest !== state.staged.digest) {
        return transitionFailure(state, event, "remediation-authority-mismatch", "verified", "verified index is stale, foreign, or not verified from this temporary index");
      }
      return ok(canonicalRecord({ ...state, state: "verified" as const, verified: event.verified }));
    case "verified": {
      if (event.kind !== "index-installed") return transitionFailure(state, event, "invalid-remediation-transition", "event", `event ${event.kind} is not declared from verified`);
      if (!verifiedInstallationCache.has(event.installation) || event.installation.verifiedIndexDigest !== state.verified.digest) {
        return transitionFailure(state, event, "remediation-authority-mismatch", "installation", "installation is stale, foreign, or not prepared from this verified index");
      }
      const reconciled = reconcileEffectReceipt(event.installation.intent, event.receipt);
      if (!reconciled.ok || reconciled.value.kind !== "verified-index-installed") {
        return transitionFailure(
          state,
          event,
          "index-installation-receipt-mismatch",
          reconciled.ok ? "receipt.kind" : reconciled.error.field,
          reconciled.ok ? "installation receipt has the wrong kind" : reconciled.error.message,
        );
      }
      return ok(canonicalRecord({
        state: "done" as const,
        authority: state.authority,
        recoveryAttemptIds: state.recoveryAttemptIds,
        consumedRecoveryReceiptIds: state.consumedRecoveryReceiptIds,
        verified: state.verified,
        installation: event.installation,
        receipt: reconciled.value,
      }));
    }
    case "recoverable-blocked":
      return transitionFailure(state, event, "invalid-remediation-transition", "event", `event ${event.kind} is not declared from recoverable-blocked`);
    case "done":
      return transitionFailure(state, event, "invalid-remediation-transition", "event", "done remediation is terminal");
  }
}

export type RemediationStateParserCause = Readonly<{
  name: string;
  message: string;
}>;

export type RemediationStateParseError = Readonly<{
  kind: "invalid-remediation-state";
  state: string | null;
  field: string;
  message: string;
  cause: RemediationStateParserCause | null;
}>;

const MAX_STATE_ERROR_TEXT = 256;

function boundedErrorText(value: string): string {
  return value.length <= MAX_STATE_ERROR_TEXT
    ? value
    : `${value.slice(0, MAX_STATE_ERROR_TEXT - 1)}…`;
}

function boundedParserCause(thrown: unknown): RemediationStateParserCause {
  try {
    if (thrown instanceof Error) {
      return canonicalRecord({
        name: boundedErrorText(typeof thrown.name === "string" && thrown.name !== "" ? thrown.name : "Error"),
        message: boundedErrorText(typeof thrown.message === "string" ? thrown.message : "parser inspection failed"),
      });
    }
    return canonicalRecord({
      name: "NonErrorThrown",
      message: boundedErrorText(typeof thrown === "string" ? thrown : "parser inspection failed with a non-Error cause"),
    });
  } catch {
    return canonicalRecord({ name: "UninspectableCause", message: "parser inspection failed with an uninspectable cause" });
  }
}

type StateDiscriminant = Readonly<{ state: string | null }>;
type StateDiscriminantError = Readonly<{ message: string; cause: RemediationStateParserCause | null }>;

function guardStateRecordInspection(raw: unknown): DomainResult<true, StateDiscriminantError> {
  if (typeof raw !== "object" || raw === null) {
    return fail(canonicalRecord({ message: "remediation state must be an object", cause: null }));
  }
  try {
    Object.getPrototypeOf(raw);
    const keys = Reflect.ownKeys(raw);
    if (keys.length > 32) {
      return fail(canonicalRecord({ message: "remediation state contains too many fields", cause: null }));
    }
    for (const key of keys) Object.getOwnPropertyDescriptor(raw, key);
    return ok(true);
  } catch (thrown) {
    return fail(canonicalRecord({
      message: "remediation state could not be safely inspected",
      cause: boundedParserCause(thrown),
    }));
  }
}

/** The sole guarded descriptor parser used to select an LC-3 state variant. */
function parseStateDiscriminant(raw: unknown): DomainResult<StateDiscriminant, StateDiscriminantError> {
  if (typeof raw !== "object" || raw === null) {
    return fail(canonicalRecord({ message: "remediation state must be an object", cause: null }));
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(raw, "state");
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      return fail(canonicalRecord({
        message: "remediationState.state must be an enumerable own data field",
        cause: null,
      }));
    }
    return ok(canonicalRecord({
      state: typeof descriptor.value === "string" ? boundedErrorText(descriptor.value) : null,
    }));
  } catch (thrown) {
    return fail(canonicalRecord({
      message: "remediationState.state could not be safely inspected",
      cause: boundedParserCause(thrown),
    }));
  }
}

function stateParseFailure(
  state: string | null,
  field: string,
  message: string,
  cause: RemediationStateParserCause | null = null,
): DomainResult<RemediationState, RemediationStateParseError> {
  return fail(canonicalRecord({
    kind: "invalid-remediation-state",
    state,
    field,
    message: boundedErrorText(message),
    cause,
  }));
}

type ActiveStateParseError = Readonly<{
  field: string;
  message: string;
  cause: RemediationStateParserCause | null;
}>;

function activeStateParseFailure(
  field: string,
  message: string,
  cause: RemediationStateParserCause | null = null,
): DomainResult<ActiveRemediationState, ActiveStateParseError> {
  return fail(canonicalRecord({ field, message, cause }));
}

function parseActiveState(
  raw: unknown,
  publicationResolver: StandaloneResultPublicationAuthorityResolver,
): DomainResult<ActiveRemediationState, ActiveStateParseError> {
  const discriminant = parseStateDiscriminant(raw);
  if (!discriminant.ok) {
    return activeStateParseFailure("state", discriminant.error.message, discriminant.error.cause);
  }
  const state = discriminant.value.state;
  const common = ["state", "authority", "recoveryAttemptIds", "consumedRecoveryReceiptIds"];
  const fields = state === "audited" ? [...common, "audited"]
    : state === "staged-temporary-index" ? [...common, "audited", "staged"]
    : state === "verified" ? [...common, "audited", "staged", "verified"]
    : common;
  const record = exactRecord(raw, fields, "remediationState");
  if (!record.ok) return activeStateParseFailure("state", record.error);
  if (!["authority-frozen", "paths-registered", "audited", "staged-temporary-index", "verified"].includes(String(state))) {
    return activeStateParseFailure("state", "remediationState.state is not active");
  }
  const authorityInspection = guardStateRecordInspection(record.value.authority);
  if (!authorityInspection.ok) {
    return activeStateParseFailure(
      "authority",
      authorityInspection.error.message,
      authorityInspection.error.cause,
    );
  }
  const authority = parseRemediationPathAuthority(record.value.authority, publicationResolver);
  const parsedHistory = history(record.value, "remediationState");
  if (!authority.ok) return activeStateParseFailure("authority", authority.error.message);
  if (!parsedHistory.ok) return activeStateParseFailure("history", parsedHistory.error);
  const lifecycleHistory = enforceRecoveryHistoryLifecycle(parsedHistory.value, "active", "remediationState");
  if (!lifecycleHistory.ok) return activeStateParseFailure("history", lifecycleHistory.error);
  if (state === "authority-frozen") {
    if (authority.value.kind !== "frozen-path-authority") {
      return activeStateParseFailure("authority", "authority-frozen requires frozen path authority");
    }
    return ok(canonicalRecord({ state, authority: authority.value, ...parsedHistory.value }));
  }
  if (state === "paths-registered") {
    if (authority.value.kind !== "registered-path-authority") {
      return activeStateParseFailure("authority", "paths-registered requires registered path authority");
    }
    return ok(canonicalRecord({ state, authority: authority.value, ...parsedHistory.value }));
  }
  const audited = parseAuditedPathSet(record.value.audited, publicationResolver);
  if (!audited.ok) return activeStateParseFailure("audited", audited.error);
  if (audited.value.authorityDigest !== authority.value.digest) {
    return activeStateParseFailure("audited", "state audited proof does not match authority");
  }
  if (state === "audited") {
    return ok(canonicalRecord({ state, authority: authority.value, ...parsedHistory.value, audited: audited.value }));
  }
  const staged = parseStagedTemporaryIndex(record.value.staged, publicationResolver);
  if (!staged.ok) return activeStateParseFailure("staged", staged.error);
  if (staged.value.audited.digest !== audited.value.digest) {
    return activeStateParseFailure("staged", "state staged proof does not match audited proof");
  }
  if (state === "staged-temporary-index") {
    return ok(canonicalRecord({ state, authority: authority.value, ...parsedHistory.value, audited: audited.value, staged: staged.value }));
  }
  const verified = parseVerifiedTemporaryIndex(record.value.verified, publicationResolver);
  if (!verified.ok) return activeStateParseFailure("verified", verified.error);
  if (verified.value.staged.digest !== staged.value.digest) {
    return activeStateParseFailure("verified", "state verified proof does not match staged proof");
  }
  return ok(canonicalRecord({ state: "verified", authority: authority.value, ...parsedHistory.value, audited: audited.value, staged: staged.value, verified: verified.value }));
}

function parseRemediationStateVariant(
  raw: unknown,
  state: string | null,
  publicationResolver: StandaloneResultPublicationAuthorityResolver,
): DomainResult<RemediationState, RemediationStateParseError> {
  if (state !== "recoverable-blocked" && state !== "done") {
    const active = parseActiveState(raw, publicationResolver);
    return active.ok
      ? ok(active.value)
      : stateParseFailure(state, active.error.field, active.error.message, active.error.cause);
  }
  if (state === "recoverable-blocked") {
    const record = exactRecord(raw, [
      "state", "authority", "recoveryAttemptIds", "consumedRecoveryReceiptIds", "predecessor", "failure",
    ], "remediationState");
    if (!record.ok) return stateParseFailure(state, "state", record.error);
    const authorityInspection = guardStateRecordInspection(record.value.authority);
    if (!authorityInspection.ok) {
      return stateParseFailure(
        state,
        "authority",
        authorityInspection.error.message,
        authorityInspection.error.cause,
      );
    }
    const authority = parseRemediationPathAuthority(record.value.authority, publicationResolver);
    const parsedHistory = history(record.value, "remediationState");
    const predecessorInspection = guardStateRecordInspection(record.value.predecessor);
    if (!predecessorInspection.ok) {
      return stateParseFailure(
        state,
        "predecessor",
        predecessorInspection.error.message,
        predecessorInspection.error.cause,
      );
    }
    const predecessorDiscriminant = parseStateDiscriminant(record.value.predecessor);
    if (!predecessorDiscriminant.ok) {
      return stateParseFailure(
        state,
        "predecessor",
        predecessorDiscriminant.error.message,
        predecessorDiscriminant.error.cause,
      );
    }
    const predecessor = parseActiveState(record.value.predecessor, publicationResolver);
    const failureRecord = exactRecord(record.value.failure, [
      "recoveryAttemptId", "effectId", "predecessorState", "witnessDigest", "message", "digest",
    ], "remediationState.failure");
    if (!authority.ok) return stateParseFailure(state, "authority", authority.error.message);
    if (!parsedHistory.ok) return stateParseFailure(state, "history", parsedHistory.error);
    const lifecycleHistory = enforceRecoveryHistoryLifecycle(
      parsedHistory.value,
      "recoverable-blocked",
      "remediationState",
    );
    if (!lifecycleHistory.ok) return stateParseFailure(state, "history", lifecycleHistory.error);
    if (!predecessor.ok) {
      return stateParseFailure(
        state,
        `predecessor.${predecessor.error.field}`,
        predecessor.error.message,
        predecessor.error.cause,
      );
    }
    if (!failureRecord.ok) return stateParseFailure(state, "failure", failureRecord.error);
    const attemptId = parseRecoveryAttemptId(failureRecord.value.recoveryAttemptId);
    const effectId = parseEffectId(failureRecord.value.effectId);
    const witness = parseArtifactDigest(failureRecord.value.witnessDigest);
    const digest = parseArtifactDigest(failureRecord.value.digest);
    if (!attemptId.ok) return stateParseFailure(state, "failure.recoveryAttemptId", attemptId.error);
    if (!effectId.ok) return stateParseFailure(state, "failure.effectId", effectId.error.message);
    if (!witness.ok) return stateParseFailure(state, "failure.witnessDigest", witness.error.message);
    if (!digest.ok) return stateParseFailure(state, "failure.digest", digest.error.message);
    if (typeof failureRecord.value.message !== "string" || failureRecord.value.message.trim() === "") {
      return stateParseFailure(state, "failure.message", "failure message must be non-empty");
    }
    const failureFields = {
      recoveryAttemptId: attemptId.value,
      effectId: effectId.value,
      predecessorState: predecessor.value.state,
      witnessDigest: activeStateDigest(predecessor.value),
      message: failureRecord.value.message,
    };
    if (failureRecord.value.predecessorState !== predecessor.value.state || witness.value !== failureFields.witnessDigest ||
        digest.value !== digestJson(failureFields) || authority.value.digest !== predecessor.value.authority.digest ||
        parsedHistory.value.recoveryAttemptIds.at(-1) !== attemptId.value ||
        !sameArray(
          parsedHistory.value.recoveryAttemptIds.slice(0, predecessor.value.recoveryAttemptIds.length),
          predecessor.value.recoveryAttemptIds,
        ) ||
        parsedHistory.value.recoveryAttemptIds.length <= predecessor.value.recoveryAttemptIds.length ||
        !sameArray(predecessor.value.consumedRecoveryReceiptIds, parsedHistory.value.consumedRecoveryReceiptIds)) {
      return stateParseFailure(state, "failure", "recoverable state nested authority, history, or failure digest mismatch");
    }
    return ok(canonicalRecord({
      state: "recoverable-blocked",
      authority: authority.value,
      ...parsedHistory.value,
      predecessor: predecessor.value,
      failure: canonicalRecord({ ...failureFields, digest: digest.value }),
    }));
  }
  const record = exactRecord(raw, [
    "state", "authority", "recoveryAttemptIds", "consumedRecoveryReceiptIds", "verified", "installation", "receipt",
  ], "remediationState");
  if (!record.ok) return stateParseFailure(state, "state", record.error);
  const authorityInspection = guardStateRecordInspection(record.value.authority);
  if (!authorityInspection.ok) {
    return stateParseFailure(
      state,
      "authority",
      authorityInspection.error.message,
      authorityInspection.error.cause,
    );
  }
  const authority = parseRemediationPathAuthority(record.value.authority, publicationResolver);
  const parsedHistory = history(record.value, "remediationState");
  const verified = parseVerifiedTemporaryIndex(record.value.verified, publicationResolver);
  const installation = parseVerifiedIndexInstallation(record.value.installation, publicationResolver);
  if (!authority.ok) return stateParseFailure(state, "authority", authority.error.message);
  if (!parsedHistory.ok) return stateParseFailure(state, "history", parsedHistory.error);
  const lifecycleHistory = enforceRecoveryHistoryLifecycle(parsedHistory.value, "done", "remediationState");
  if (!lifecycleHistory.ok) return stateParseFailure(state, "history", lifecycleHistory.error);
  if (!verified.ok) return stateParseFailure(state, "verified", verified.error);
  if (!installation.ok) return stateParseFailure(state, "installation", installation.error);
  if (verified.value.runId !== authority.value.runId ||
      verified.value.staged.audited.authorityDigest !== authority.value.digest ||
      installation.value.verifiedIndexDigest !== verified.value.digest) {
    return stateParseFailure(state, "installation", "done installation does not match exact verified authority");
  }
  const receipt = reconcileEffectReceipt(installation.value.intent, record.value.receipt);
  if (!receipt.ok || receipt.value.kind !== "verified-index-installed") {
    return stateParseFailure(state, "receipt", receipt.ok ? "receipt kind is invalid" : receipt.error.message);
  }
  return ok(canonicalRecord({
    state: "done",
    authority: authority.value,
    ...parsedHistory.value,
    verified: verified.value,
    installation: installation.value,
    receipt: receipt.value,
  }));
}

/** Strict durable LC-3 parser. It re-mints every nominal proof only after recomputation. */
export function parseRemediationState(
  raw: unknown,
  publicationResolver: StandaloneResultPublicationAuthorityResolver,
): DomainResult<RemediationState, RemediationStateParseError> {
  const inspection = guardStateRecordInspection(raw);
  if (!inspection.ok) {
    return stateParseFailure(null, "state", inspection.error.message, inspection.error.cause);
  }
  const discriminant = parseStateDiscriminant(raw);
  if (!discriminant.ok) {
    return stateParseFailure(null, "state", discriminant.error.message, discriminant.error.cause);
  }
  try {
    const parsed = parseRemediationStateVariant(raw, discriminant.value.state, publicationResolver);
    return parsed.ok ? ok(mintRemediationState(parsed.value)) : parsed;
  } catch (thrown) {
    return stateParseFailure(
      discriminant.value.state,
      "state",
      "remediation state parser failed while inspecting hostile input",
      boundedParserCause(thrown),
    );
  }
}

/** Closed aggregate boundary: only constructor/parser-produced states may transition. */
export function reduceRemediation(
  state: RemediationState,
  event: RemediationEvent,
): DomainResult<RemediationState, RemediationTransitionError> {
  if (!remediationStateCache.has(state)) {
    return transitionFailure(
      state,
      event,
      "invalid-remediation-transition",
      "state",
      "remediation transition requires a constructor- or parser-produced state",
    );
  }
  const reduced = reduceParserMintedRemediation(state, event);
  return reduced.ok ? ok(mintRemediationState(reduced.value)) : reduced;
}
