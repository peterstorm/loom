/**
 * Pure Defect-Family Accounting kernel.
 *
 * The only semantic input is an explicitly DECLARED accounting document. Process,
 * report, Git, filesystem, and candidate observations are separate engine facts.
 * This module performs no I/O and never upgrades a declaration into semantic proof.
 */

import { compareStrings } from "./ordering";
import {
  canonicalRecord,
  parseArtifactDigest,
  parseOrchestrationRunId,
  type ArtifactDigest,
  type DomainResult,
  type NonEmpty,
  type OrchestrationRunId,
} from "./orchestration-contract";
import { readDenseDataArray, type DataBoundaryError } from "./orchestration-contract/bytes";
import {
  COMPLETION_REPORT_ROOT,
  isProtectedVerificationPath,
  parseCompletionCheckId,
  type CompletionCheckId,
  type CompletionTimeoutMs,
  type RepositoryRelativePath,
} from "./completion-suite";
import { canonicalStandaloneResultArtifact, serializeAdjudicatedStandaloneReview } from "./standalone-review-records";
import {
  isAuthoritativeStandaloneReviewResult,
  readStandaloneReviewPublication,
  type AuthoritativeStandaloneReviewResult,
} from "./standalone-review-machine";
import { parseFindingId as parseCanonicalFindingId, parseStoredFindings, type Finding, type RefutedFinding } from "./findings";
import { STANDALONE_LINEAGE_LIMITS } from "./standalone-lineage-contract";
import { parseReviewPath, type ReviewPath } from "./review-packet";
import { sha256Hex } from "./digest";
import {
  parseFrozenVerificationManifest,
  type FrozenVerificationManifest,
} from "./verification-manifest";
import { MAX_STRUCTURED_REPORT_BYTES, parseReportSummary, type TestReportSummary } from "./structured-test-report";

const REPAIR_GROUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

const success = <T, E = never>(value: T): DomainResult<T, E> => canonicalRecord({ ok: true, value });
const failure = <T = never, E = never>(error: E): DomainResult<T, E> => canonicalRecord({ ok: false, error });
const immutableArray = <T>(values: readonly T[]): readonly T[] => Object.freeze([...values]);

type DefectFamilyFailureCode =
  | "invalid-source-authority"
  | "critical-coverage-limited"
  | "invalid-declaration"
  | "source-declaration-mismatch"
  | "missing-critical-disposition"
  | "duplicate-critical-disposition"
  | "foreign-finding"
  | "advisory-finding"
  | "refuted-finding"
  | "invalid-repair-group"
  | "orphan-repair-group"
  | "group-membership-mismatch"
  | "duplicate-sibling-path"
  | "incompatible-sibling-disposition"
  | "protected-sibling-path"
  | "unresolved-critical"
  | "out-of-scope-critical"
  | "unresolved-sibling"
  | "out-of-scope-sibling"
  | "invalid-verification-authority"
  | "missing-repair-check"
  | "surplus-repair-check"
  | "duplicate-repair-check"
  | "report-required"
  | "duplicate-report-path"
  | "invalid-candidate-witness"
  | "candidate-drift"
  | "invalid-candidate-path-projection"
  | "missing-repaired-sibling"
  | "checked-unmodified-sibling-dirty"
  | "checked-unmodified-sibling-unobserved"
  | "invalid-remediation-scope"
  | "invalid-engine-observation"
  | "failed-repaired-check"
  | "forged-authority"
  | "unexpected-repair-evidence";

type DefectFamilyFailure = Readonly<{
  kind: "defect-family-accounting-blocked";
  code: DefectFamilyFailureCode;
  path: string;
  message: string;
}>;

type DefectFamilyAccountingError = Readonly<{
  kind: "invalid-defect-family-accounting";
  failures: NonEmpty<DefectFamilyFailure>;
}>;

function problem(code: DefectFamilyFailureCode, path: string, message: string): DefectFamilyFailure {
  return canonicalRecord({ kind: "defect-family-accounting-blocked" as const, code, path, message });
}

function accountingFailure<T>(failures: readonly DefectFamilyFailure[]): DomainResult<T, DefectFamilyAccountingError> {
  const [head, ...tail] = failures.length > 0
    ? failures
    : [problem("invalid-declaration", "defectFamily", "Defect-Family Accounting is invalid")];
  return failure(canonicalRecord({
    kind: "invalid-defect-family-accounting" as const,
    failures: Object.freeze([head!, ...tail]) as NonEmpty<DefectFamilyFailure>,
  }));
}

function digestJson(value: unknown): ArtifactDigest {
  const raw = sha256Hex(JSON.stringify(value));
  const parsed = parseArtifactDigest(raw);
  if (!parsed.ok) throw new Error("internal SHA-256 construction failed");
  return parsed.value;
}

type UnknownRecord = Readonly<Record<string, unknown>>;
type InternalParse<T> = DomainResult<T, readonly DefectFamilyFailure[]>;

function parsed<T>(value: T): InternalParse<T> {
  return success(value);
}

function rejected<T>(...failures: readonly DefectFamilyFailure[]): InternalParse<T> {
  return failure(immutableArray(failures));
}

/** Read an exact plain record without invoking accessor properties. */
function ownDataValue(raw: unknown, key: string): unknown {
  if (typeof raw !== "object" || raw === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function exactRecord(raw: unknown, fields: readonly string[], path: string): InternalParse<UnknownRecord> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return rejected(problem("invalid-declaration", path, `${path} must be a plain own-data object`));
  }
  try {
    const prototype: unknown = Object.getPrototypeOf(raw);
    if (prototype !== null && prototype !== Object.prototype) {
      return rejected(problem("invalid-declaration", path, `${path} must be a plain own-data object`));
    }
    const keys = Reflect.ownKeys(raw);
    if (keys.some((key) => typeof key !== "string")) {
      return rejected(problem("invalid-declaration", path, `${path} must not contain symbol fields`));
    }
    const ownKeys = keys as string[];
    const extras = ownKeys.filter((key) => !fields.includes(key)).sort(compareStrings);
    const missing = fields.filter((field) => !ownKeys.includes(field));
    const shapeFailures = [
      ...extras.map((key) => problem("invalid-declaration", `${path}.${key}`, `${path}.${key} is not allowed`)),
      ...missing.map((key) => problem("invalid-declaration", `${path}.${key}`, `${path}.${key} is required`)),
    ];
    if (shapeFailures.length > 0) return failure(immutableArray(shapeFailures));
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return rejected(problem(
          "invalid-declaration",
          `${path}.${key}`,
          `${path}.${key} must be an enumerable own data field`,
        ));
      }
      Object.defineProperty(copy, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return parsed(Object.freeze(copy));
  } catch {
    return rejected(problem("invalid-declaration", path, `${path} could not be safely inspected`));
  }
}

/** Dense own-data array boundary delegated to the shared kernel parser
 *  (orchestration-contract/bytes.ts). The kernel's enumerable/configurable
 *  own-data length rule is the canonical acceptance corner — one parser can no
 *  longer disagree with the kernel about which arrays it accepts. */
function denseArray(raw: unknown, path: string, nonEmpty = false): InternalParse<readonly unknown[]> {
  const result = readDenseDataArray(raw, path);
  if (!result.ok) return rejected(denseArrayProblem(path, result.error));
  if (nonEmpty && result.value.length === 0) {
    return rejected(problem("invalid-declaration", path, `${path} must be non-empty`));
  }
  return parsed(result.value);
}

/** Translate the kernel's typed boundary failure into this module's exact
 *  InternalParse vocabulary; callers here discriminate on these failures, not
 *  on DataBoundaryError. */
function denseArrayProblem(path: string, error: DataBoundaryError): DefectFamilyFailure {
  if (error.reason === "sparse-array" && error.index !== null) {
    return problem("invalid-declaration", `${path}[${error.index}]`, `${path} has a hole at index ${error.index}`);
  }
  if (error.reason === "accessor-field" || error.reason === "non-enumerable-field") {
    const at = `${path}[${error.index ?? 0}]`;
    return problem("invalid-declaration", at, `${at} must be own data`);
  }
  const message = error.reason === "not-array" ? `${path} must be a plain array`
    : error.reason === "invalid-array-length" ? `${path} has an invalid or excessive length`
    : error.reason === "symbol-field" || error.reason === "sparse-array"
      ? `${path} must be dense and contain no extra fields`
    : `${path} could not be safely inspected`;
  return problem("invalid-declaration", path, message);
}

function declaredText(raw: unknown, path: string): InternalParse<DeclaredText> {
  return typeof raw === "string" && raw.trim().length > 0
    ? parsed(raw as DeclaredText)
    : rejected(problem("invalid-declaration", path, `${path} must be a non-blank DECLARED statement`));
}

function artifactDigest(raw: unknown, path: string, code: DefectFamilyFailureCode): InternalParse<ArtifactDigest> {
  const result = parseArtifactDigest(raw);
  return result.ok
    ? parsed(result.value)
    : rejected(problem(code, path, `${path}: ${result.error.message}`));
}

function runId(raw: unknown, path: string): InternalParse<OrchestrationRunId> {
  const result = parseOrchestrationRunId(raw);
  return result.ok
    ? parsed(result.value)
    : rejected(problem("invalid-remediation-scope", path, `${path}: ${result.error.message}`));
}

function reviewPath(raw: unknown, path: string, code: DefectFamilyFailureCode): InternalParse<ReviewPath> {
  const result = parseReviewPath(raw, path);
  return result.ok
    ? parsed(result.value)
    : failure(Object.freeze(result.errors.map((message) => problem(code, path, message))));
}

function cloneFinding(finding: Finding): Finding {
  if (finding.protocolVersion === 2) {
    const [copy] = parseStoredFindings([finding]);
    if (copy === undefined) throw new Error("source inventory requires valid current Finding authority");
    return copy;
  }
  const legacy = {
    severity: finding.severity,
    file: finding.file,
    line: finding.line,
    claim: finding.claim,
    id: finding.id,
    agent: finding.agent,
  };
  return Object.freeze(finding.review_generation === undefined ? legacy : {
    ...legacy,
    review_generation: finding.review_generation,
    review_packet_id: finding.review_packet_id,
  });
}

function cloneRefutedFinding(record: RefutedFinding): RefutedFinding {
  const [first, ...rest] = record.refutations;
  return Object.freeze({
    finding: cloneFinding(record.finding),
    refutations: Object.freeze([
      Object.freeze({ lens: first.lens, reason: first.reason }),
      ...rest.map(({ lens, reason }) => Object.freeze({ lens, reason })),
    ]) as RefutedFinding["refutations"],
  });
}

export type SourceFindingInventory = Readonly<{
  sourceRunId: OrchestrationRunId;
  sourceResultDigest: ArtifactDigest;
  sourceResultByteLength: number;
  survivingCriticals: readonly Finding[];
  refutedCriticals: readonly RefutedFinding[];
  advisories: readonly Finding[];
}> & (
  | Readonly<{ sourceVersion?: never; sourceResultJson?: never }>
  | Readonly<{
      sourceVersion: 3;
      /** Exact canonical publication, including every origin, decision, assessment and prior generation. */
      sourceResultJson: string;
    }>
);

const sourceInventoryCache = new WeakSet<object>();

/** Derive source inventory only from the opaque, publication-checked LC-2 result. */
function createSourceFindingInventory(
  source: AuthoritativeStandaloneReviewResult,
): DomainResult<SourceFindingInventory, DefectFamilyAccountingError> {
  try {
    if (!isAuthoritativeStandaloneReviewResult(source)) {
      return accountingFailure([problem(
        "invalid-source-authority",
        "source",
        "source inventory requires the opaque authoritative Standalone Review result",
      )]);
    }
    if (source.schemaVersion === 3 && source.lineage.currentCriticalCoverage.kind === "limited") {
      return accountingFailure([problem("critical-coverage-limited", "source.lineage.currentCriticalCoverage",
        `current critical coverage is limited for origin(s): ${source.lineage.currentCriticalCoverage.origins.join(", ")}; remediation cannot authorize checks or installation`)]);
    }
    const artifact = source.schemaVersion === 3
      ? readStandaloneReviewPublication(source, STANDALONE_LINEAGE_LIMITS.retainedBytes)
      : canonicalStandaloneResultArtifact(source);
    if (!artifact.ok) {
      return accountingFailure([problem("invalid-source-authority", "source", artifact.error.message)]);
    }
    const survivingCriticals = source.survivingCriticals.map(cloneFinding).sort((a, b) => compareStrings(a.id, b.id));
    const advisories = source.advisories.map(cloneFinding).sort((a, b) => compareStrings(a.id, b.id));
    const refutedCriticals = source.refutedCriticals.map(cloneRefutedFinding)
      .sort((a, b) => compareStrings(a.finding.id, b.finding.id));
    const classified = [
      ...survivingCriticals.map(({ id }) => id),
      ...advisories.map(({ id }) => id),
      ...refutedCriticals.map(({ finding }) => finding.id),
    ];
    if (new Set(classified).size !== classified.length ||
        survivingCriticals.some(({ severity }) => severity !== "critical") ||
        advisories.some(({ severity }) => severity !== "advisory") ||
        refutedCriticals.some(({ finding }) => finding.severity !== "critical")) {
      return accountingFailure([problem(
        "invalid-source-authority",
        "source.findings",
        "authoritative Standalone Review finding classifications are inconsistent or overlap",
      )]);
    }
    const partitions = {
      sourceRunId: artifact.value.runId,
      sourceResultDigest: artifact.value.digest,
      sourceResultByteLength: artifact.value.byteLength,
      survivingCriticals: immutableArray(survivingCriticals),
      refutedCriticals: immutableArray(refutedCriticals),
      advisories: immutableArray(advisories),
    };
    const inventory: SourceFindingInventory = source.schemaVersion === 3
      ? canonicalRecord({ ...partitions, sourceVersion: 3, sourceResultJson: serializeAdjudicatedStandaloneReview(source) })
      : canonicalRecord(partitions);
    sourceInventoryCache.add(inventory);
    return success(inventory);
  } catch {
    return accountingFailure([problem(
      "invalid-source-authority",
      "source",
      "authoritative Standalone Review result could not be safely snapshotted",
    )]);
  }
}

declare const DECLARED_TEXT: unique symbol;
declare const REPAIR_GROUP_ID: unique symbol;
declare const FINDING_ID: unique symbol;
type DeclaredText = string & { readonly [DECLARED_TEXT]: true };
type RepairGroupId = string & { readonly [REPAIR_GROUP_ID]: true };
type FindingId = string & { readonly [FINDING_ID]: true };

/** Every disposition and repair-group join keys on the Finding id; branding it
 *  through the canonical parseFindingId shape extends the kernel's identity-branded
 *  pattern (OrchestrationRunId, RequestId, SlotId, RepairGroupId) to that id, so a
 *  RepairGroupId-shaped string is no longer silently assignable where a finding
 *  id is expected. */
function parseFindingId(raw: unknown, path: string): InternalParse<FindingId> {
  const canonical = parseCanonicalFindingId(raw);
  return canonical !== null
    ? parsed(canonical as FindingId)
    : rejected(problem("invalid-declaration", path, `${path} must be a non-empty exact source Finding id`));
}

type DeclaredSemanticClaim = Readonly<{
  provenance: "DECLARED";
  statement: DeclaredText;
}>;

type CriticalFindingDisposition =
  | Readonly<{ findingId: FindingId; status: "repaired"; repairGroupId: RepairGroupId }>
  | Readonly<{ findingId: FindingId; status: "unresolved"; reason: DeclaredText }>
  | Readonly<{ findingId: FindingId; status: "out-of-scope"; reason: DeclaredText }>;

type SiblingDisposition =
  | Readonly<{ path: ReviewPath; status: "repaired"; reason: DeclaredText }>
  | Readonly<{ path: ReviewPath; status: "checked-unmodified"; reason: DeclaredText }>
  | Readonly<{ path: ReviewPath; status: "unresolved"; reason: DeclaredText }>
  | Readonly<{ path: ReviewPath; status: "out-of-scope"; reason: DeclaredText }>;

type DeclaredSiblingAccounting =
  | Readonly<{ kind: "none-declared"; provenance: "DECLARED"; reason: DeclaredText }>
  | Readonly<{
      kind: "declared-siblings";
      provenance: "DECLARED";
      entries: NonEmpty<SiblingDisposition>;
    }>;

type DeclaredHistoricalRed = Readonly<{
  kind: "historical-red";
  provenance: "DECLARED";
  statement: DeclaredText;
  reference: DeclaredText | null;
}>;

type DeclaredRepairCheck = Readonly<{
  checkId: CompletionCheckId;
  historicalRed: DeclaredHistoricalRed;
}>;

type DeclaredRepairGroup = Readonly<{
  kind: "declared-repair-group";
  provenance: "DECLARED";
  repairGroupId: RepairGroupId;
  findingIds: NonEmpty<FindingId>;
  rootCause: DeclaredSemanticClaim;
  invariant: DeclaredSemanticClaim;
  siblings: DeclaredSiblingAccounting;
  checks: NonEmpty<DeclaredRepairCheck>;
}>;

export type DefectFamilyDeclaration =
  | Readonly<{ kind: "not-required" }>
  | Readonly<{
      kind: "declared-defect-family-accounting";
      provenance: "DECLARED";
      dispositions: NonEmpty<CriticalFindingDisposition>;
      /** Empty is valid only when every surviving critical is explicitly blocking. */
      groups: readonly DeclaredRepairGroup[];
    }>;

function parseRepairGroupId(raw: unknown, path: string): InternalParse<RepairGroupId> {
  return typeof raw === "string" && REPAIR_GROUP_ID_PATTERN.test(raw)
    ? parsed(raw as RepairGroupId)
    : rejected(problem("invalid-repair-group", path, `${path} must be a canonical repair group id`));
}

function parseClaim(raw: unknown, path: string): InternalParse<DeclaredSemanticClaim> {
  const record = exactRecord(raw, ["provenance", "statement"], path);
  if (!record.ok) return record;
  const statement = declaredText(record.value.statement, `${path}.statement`);
  const failures: DefectFamilyFailure[] = statement.ok ? [] : [...statement.error];
  if (record.value.provenance !== "DECLARED") {
    failures.push(problem("invalid-declaration", `${path}.provenance`, `${path}.provenance must equal DECLARED`));
  }
  return failures.length === 0 && statement.ok
    ? parsed(canonicalRecord({ provenance: "DECLARED" as const, statement: statement.value }))
    : failure(immutableArray(failures));
}

function parseHistoricalRed(raw: unknown, path: string): InternalParse<DeclaredHistoricalRed> {
  const record = exactRecord(raw, ["kind", "provenance", "statement", "reference"], path);
  if (!record.ok) return record;
  const failures: DefectFamilyFailure[] = [];
  if (record.value.kind !== "historical-red") {
    failures.push(problem("invalid-declaration", `${path}.kind`, `${path}.kind must equal historical-red`));
  }
  if (record.value.provenance !== "DECLARED") {
    failures.push(problem("invalid-declaration", `${path}.provenance`, `${path}.provenance must equal DECLARED`));
  }
  const statement = declaredText(record.value.statement, `${path}.statement`);
  if (!statement.ok) failures.push(...statement.error);
  const reference = record.value.reference === null
    ? parsed<DeclaredText | null>(null)
    : declaredText(record.value.reference, `${path}.reference`);
  if (!reference.ok) failures.push(...reference.error);
  return failures.length === 0 && statement.ok && reference.ok
    ? parsed(canonicalRecord({
        kind: "historical-red" as const,
        provenance: "DECLARED" as const,
        statement: statement.value,
        reference: reference.value,
      }))
    : failure(immutableArray(failures));
}

function parseRepairCheck(raw: unknown, path: string): InternalParse<DeclaredRepairCheck> {
  const record = exactRecord(raw, ["checkId", "historicalRed"], path);
  if (!record.ok) return record;
  const checkId = parseCompletionCheckId(record.value.checkId, `${path}.checkId`);
  const historicalRed = parseHistoricalRed(record.value.historicalRed, `${path}.historicalRed`);
  const failures = [
    ...(checkId.ok ? [] : checkId.error.errors.map((message) => problem("invalid-declaration", `${path}.checkId`, message))),
    ...(historicalRed.ok ? [] : historicalRed.error),
  ];
  return failures.length === 0 && checkId.ok && historicalRed.ok
    ? parsed(canonicalRecord({ checkId: checkId.value, historicalRed: historicalRed.value }))
    : failure(immutableArray(failures));
}

function isProtectedSiblingPath(path: ReviewPath): boolean {
  if (isProtectedVerificationPath(path)) return true;
  const protectedRoots = [".git", ".claude/state", ".pi/state", ".claude/reviews", ".pi/reviews"];
  if (protectedRoots.some((root) => path === root || path.startsWith(`${root}/`))) return true;
  const parts = path.split("/");
  return parts[0] === ".claude" && parts.some((part, index) => index > 0 && [
    "panel-runs", "review-runs", "review-and-fix-runs", "wave-gate-runs", "orchestration-runs",
  ].includes(part));
}

function parseSibling(raw: unknown, path: string): InternalParse<SiblingDisposition> {
  const record = exactRecord(raw, ["path", "status", "reason"], path);
  if (!record.ok) return record;
  const siblingPath = reviewPath(record.value.path, `${path}.path`, "invalid-declaration");
  const reason = declaredText(record.value.reason, `${path}.reason`);
  const statuses = ["repaired", "checked-unmodified", "unresolved", "out-of-scope"] as const;
  const failures = [
    ...(siblingPath.ok ? [] : siblingPath.error),
    ...(reason.ok ? [] : reason.error),
  ];
  if (!statuses.includes(record.value.status as typeof statuses[number])) {
    failures.push(problem("invalid-declaration", `${path}.status`, `${path}.status is not a sibling disposition`));
  }
  if (siblingPath.ok && isProtectedSiblingPath(siblingPath.value)) {
    failures.push(problem("protected-sibling-path", `${path}.path`, `sibling path '${siblingPath.value}' is protected authority or evidence`));
  }
  return failures.length === 0 && siblingPath.ok && reason.ok
    ? parsed(canonicalRecord({
        path: siblingPath.value,
        status: record.value.status as SiblingDisposition["status"],
        reason: reason.value,
      }) as SiblingDisposition)
    : failure(immutableArray(failures));
}

function parseSiblingAccounting(raw: unknown, path: string): InternalParse<DeclaredSiblingAccounting> {
  const tag = exactRecord(raw, ownDataValue(raw, "kind") === "none-declared"
    ? ["kind", "provenance", "reason"]
    : ["kind", "provenance", "entries"], path);
  if (!tag.ok) return tag;
  const failures: DefectFamilyFailure[] = [];
  if (tag.value.provenance !== "DECLARED") {
    failures.push(problem("invalid-declaration", `${path}.provenance`, `${path}.provenance must equal DECLARED`));
  }
  if (tag.value.kind === "none-declared") {
    const reason = declaredText(tag.value.reason, `${path}.reason`);
    if (!reason.ok) failures.push(...reason.error);
    return failures.length === 0 && reason.ok
      ? parsed(canonicalRecord({ kind: "none-declared" as const, provenance: "DECLARED" as const, reason: reason.value }))
      : failure(immutableArray(failures));
  }
  if (tag.value.kind !== "declared-siblings") {
    failures.push(problem("invalid-declaration", `${path}.kind`, `${path}.kind must be none-declared or declared-siblings`));
  }
  const entries = denseArray(tag.value.entries, `${path}.entries`, true);
  if (!entries.ok) failures.push(...entries.error);
  const siblings: SiblingDisposition[] = [];
  if (entries.ok) {
    entries.value.forEach((entry, index) => {
      const sibling = parseSibling(entry, `${path}.entries[${index}]`);
      if (sibling.ok) siblings.push(sibling.value);
      else failures.push(...sibling.error);
    });
  }
  const counts = new Map<string, number>();
  siblings.forEach(({ path: siblingPath }) => counts.set(siblingPath, (counts.get(siblingPath) ?? 0) + 1));
  for (const [siblingPath, count] of counts) {
    if (count > 1) failures.push(problem(
      "duplicate-sibling-path",
      path,
      `${path} repeats sibling path '${siblingPath}' within one repair group`,
    ));
  }
  const [head, ...tail] = siblings.sort((a, b) => compareStrings(a.path, b.path));
  return failures.length === 0 && tag.value.kind === "declared-siblings" && head !== undefined
    ? parsed(canonicalRecord({
        kind: "declared-siblings" as const,
        provenance: "DECLARED" as const,
        entries: Object.freeze([head, ...tail]) as NonEmpty<SiblingDisposition>,
      }))
    : failure(immutableArray(failures));
}

function parseDisposition(raw: unknown, path: string): InternalParse<CriticalFindingDisposition> {
  const status = ownDataValue(raw, "status");
  const fields = status === "repaired"
    ? ["findingId", "status", "repairGroupId"]
    : ["findingId", "status", "reason"];
  const record = exactRecord(raw, fields, path);
  if (!record.ok) return record;
  const failures: DefectFamilyFailure[] = [];
  const findingId = parseFindingId(record.value.findingId, `${path}.findingId`);
  if (!findingId.ok) failures.push(...findingId.error);
  if (record.value.status === "repaired") {
    const groupId = parseRepairGroupId(record.value.repairGroupId, `${path}.repairGroupId`);
    if (!groupId.ok) failures.push(...groupId.error);
    return failures.length === 0 && groupId.ok && findingId.ok
      ? parsed(canonicalRecord({
          findingId: findingId.value,
          status: "repaired" as const,
          repairGroupId: groupId.value,
        }))
      : failure(immutableArray(failures));
  }
  if (record.value.status !== "unresolved" && record.value.status !== "out-of-scope") {
    failures.push(problem("invalid-declaration", `${path}.status`, `${path}.status is not a critical disposition`));
  }
  const reason = declaredText(record.value.reason, `${path}.reason`);
  if (!reason.ok) failures.push(...reason.error);
  return failures.length === 0 && reason.ok && findingId.ok &&
      (record.value.status === "unresolved" || record.value.status === "out-of-scope")
    ? parsed(canonicalRecord({
        findingId: findingId.value,
        status: record.value.status,
        reason: reason.value,
      }))
    : failure(immutableArray(failures));
}

function parseStringIds(raw: unknown, path: string): InternalParse<NonEmpty<FindingId>> {
  const entries = denseArray(raw, path, true);
  if (!entries.ok) return entries;
  const failures: DefectFamilyFailure[] = [];
  const ids = entries.value.flatMap((entry, index) => {
    const findingId = parseFindingId(entry, `${path}[${index}]`);
    if (findingId.ok) return [findingId.value];
    failures.push(...findingId.error);
    return [];
  });
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) failures.push(problem(
    "invalid-repair-group",
    path,
    `${path} repeats Finding id(s): ${[...new Set(duplicates)].sort(compareStrings).join(", ")}`,
  ));
  const [head, ...tail] = [...ids].sort(compareStrings);
  return failures.length === 0 && head !== undefined
    ? parsed(Object.freeze([head, ...tail]) as NonEmpty<FindingId>)
    : failure(immutableArray(failures));
}

function parseRepairGroup(raw: unknown, path: string): InternalParse<DeclaredRepairGroup> {
  const record = exactRecord(raw, [
    "kind", "provenance", "repairGroupId", "findingIds", "rootCause", "invariant", "siblings", "checks",
  ], path);
  if (!record.ok) return record;
  const failures: DefectFamilyFailure[] = [];
  if (record.value.kind !== "declared-repair-group") {
    failures.push(problem("invalid-repair-group", `${path}.kind`, `${path}.kind must equal declared-repair-group`));
  }
  if (record.value.provenance !== "DECLARED") {
    failures.push(problem("invalid-repair-group", `${path}.provenance`, `${path}.provenance must equal DECLARED`));
  }
  const groupId = parseRepairGroupId(record.value.repairGroupId, `${path}.repairGroupId`);
  const findingIds = parseStringIds(record.value.findingIds, `${path}.findingIds`);
  const rootCause = parseClaim(record.value.rootCause, `${path}.rootCause`);
  const invariant = parseClaim(record.value.invariant, `${path}.invariant`);
  const siblings = parseSiblingAccounting(record.value.siblings, `${path}.siblings`);
  const checkEntries = denseArray(record.value.checks, `${path}.checks`, true);
  for (const result of [groupId, findingIds, rootCause, invariant, siblings, checkEntries]) {
    if (!result.ok) failures.push(...result.error);
  }
  const checks: DeclaredRepairCheck[] = [];
  if (checkEntries.ok) {
    checkEntries.value.forEach((entry, index) => {
      const check = parseRepairCheck(entry, `${path}.checks[${index}]`);
      if (check.ok) checks.push(check.value);
      else failures.push(...check.error);
    });
  }
  const duplicateChecks = checks.filter((check, index) => checks.findIndex(({ checkId }) => checkId === check.checkId) !== index);
  if (duplicateChecks.length > 0) failures.push(problem(
    "duplicate-repair-check",
    `${path}.checks`,
    `${path}.checks repeats check id(s): ${[...new Set(duplicateChecks.map(({ checkId }) => checkId))].sort(compareStrings).join(", ")}`,
  ));
  checks.sort((a, b) => compareStrings(a.checkId, b.checkId));
  const [firstCheck, ...otherChecks] = checks;
  return failures.length === 0 && groupId.ok && findingIds.ok && rootCause.ok && invariant.ok &&
      siblings.ok && firstCheck !== undefined
    ? parsed(canonicalRecord({
        kind: "declared-repair-group" as const,
        provenance: "DECLARED" as const,
        repairGroupId: groupId.value,
        findingIds: findingIds.value,
        rootCause: rootCause.value,
        invariant: invariant.value,
        siblings: siblings.value,
        checks: Object.freeze([firstCheck, ...otherChecks]) as NonEmpty<DeclaredRepairCheck>,
      }))
    : failure(immutableArray(failures));
}

function classifyForeignFinding(
  inventory: SourceFindingInventory,
  id: string,
  path: string,
): DefectFamilyFailure | null {
  if (inventory.survivingCriticals.some((finding) => finding.id === id)) return null;
  if (inventory.advisories.some((finding) => finding.id === id)) {
    return problem("advisory-finding", path, `Finding '${id}' is advisory and cannot enter critical accounting`);
  }
  if (inventory.refutedCriticals.some(({ finding }) => finding.id === id)) {
    return problem("refuted-finding", path, `Finding '${id}' is refuted and cannot enter critical accounting`);
  }
  return problem("foreign-finding", path, `Finding '${id}' is not a surviving critical of source run ${inventory.sourceRunId}`);
}

function validateAccounting(
  inventory: SourceFindingInventory,
  dispositions: readonly CriticalFindingDisposition[],
  groups: readonly DeclaredRepairGroup[],
): readonly DefectFamilyFailure[] {
  const failures: DefectFamilyFailure[] = [];
  // The inventory's surviving-critical ids are plain strings; comparisons
  // against them are string comparisons. The FindingId brand earns its keep at
  // the parse boundary and the repair-group join, not here.
  const dispositionIds: readonly string[] = dispositions.map(({ findingId }) => findingId);
  for (const id of dispositionIds) {
    const foreign = classifyForeignFinding(inventory, id, "defectFamily.dispositions");
    if (foreign !== null) failures.push(foreign);
  }
  const duplicateDispositions = dispositionIds.filter((id, index) => dispositionIds.indexOf(id) !== index);
  if (duplicateDispositions.length > 0) failures.push(problem(
    "duplicate-critical-disposition",
    "defectFamily.dispositions",
    `surviving critical disposition repeats: ${[...new Set(duplicateDispositions)].sort(compareStrings).join(", ")}`,
  ));
  const missing = inventory.survivingCriticals
    .map(({ id }) => id)
    .filter((id) => !dispositionIds.includes(id));
  if (missing.length > 0) failures.push(problem(
    "missing-critical-disposition",
    "defectFamily.dispositions",
    `surviving criticals missing a disposition: ${missing.join(", ")}`,
  ));

  const groupIds = groups.map(({ repairGroupId }) => repairGroupId);
  const duplicateGroups = groupIds.filter((id, index) => groupIds.indexOf(id) !== index);
  if (duplicateGroups.length > 0) failures.push(problem(
    "invalid-repair-group",
    "defectFamily.groups",
    `repair group ids must be unique: ${[...new Set(duplicateGroups)].sort(compareStrings).join(", ")}`,
  ));

  const allGroupFindingIds = groups.flatMap(({ findingIds }) => findingIds);
  const repeatedMembership = allGroupFindingIds.filter((id, index) => allGroupFindingIds.indexOf(id) !== index);
  if (repeatedMembership.length > 0) failures.push(problem(
    "group-membership-mismatch",
    "defectFamily.groups",
    `Finding ids may belong to only one group: ${[...new Set(repeatedMembership)].sort(compareStrings).join(", ")}`,
  ));
  for (const [groupIndex, group] of groups.entries()) {
    for (const findingId of group.findingIds) {
      const foreign = classifyForeignFinding(inventory, findingId, `defectFamily.groups[${groupIndex}].findingIds`);
      if (foreign !== null) failures.push(foreign);
      const disposition = dispositions.find((candidate) => candidate.findingId === findingId);
      if (disposition?.status !== "repaired" || disposition.repairGroupId !== group.repairGroupId) {
        failures.push(problem(
          "group-membership-mismatch",
          `defectFamily.groups[${groupIndex}].findingIds`,
          `Finding '${findingId}' is not repaired by group '${group.repairGroupId}' in dispositions`,
        ));
      }
    }
    const expected = dispositions
      .filter((candidate): candidate is Extract<CriticalFindingDisposition, { status: "repaired" }> =>
        candidate.status === "repaired" && candidate.repairGroupId === group.repairGroupId)
      .map(({ findingId }) => findingId)
      .sort(compareStrings);
    if (expected.length !== group.findingIds.length || expected.some((id, index) => id !== group.findingIds[index])) {
      failures.push(problem(
        "group-membership-mismatch",
        `defectFamily.groups[${groupIndex}].findingIds`,
        `group '${group.repairGroupId}' membership must exactly equal its repaired dispositions`,
      ));
    }
  }
  for (const disposition of dispositions) {
    if (disposition.status === "repaired" && !groups.some(({ repairGroupId }) => repairGroupId === disposition.repairGroupId)) {
      failures.push(problem(
        "orphan-repair-group",
        "defectFamily.dispositions",
        `repaired Finding '${disposition.findingId}' names absent group '${disposition.repairGroupId}'`,
      ));
    }
  }

  const siblingStatuses = new Map<ReviewPath, SiblingDisposition["status"]>();
  for (const group of groups) {
    if (group.siblings.kind === "none-declared") continue;
    for (const sibling of group.siblings.entries) {
      const prior = siblingStatuses.get(sibling.path);
      if (prior !== undefined && prior !== sibling.status) {
        failures.push(problem(
          "incompatible-sibling-disposition",
          "defectFamily.groups.siblings",
          `sibling path '${sibling.path}' has incompatible '${prior}' and '${sibling.status}' dispositions across groups`,
        ));
      } else {
        siblingStatuses.set(sibling.path, sibling.status);
      }
    }
  }
  return immutableArray(failures);
}

/** Exact-field declaration parser bound to one parser-minted source inventory. */
function parseDefectFamilyDeclaration(
  inventory: SourceFindingInventory,
  raw: unknown,
): DomainResult<DefectFamilyDeclaration, DefectFamilyAccountingError> {
  if (!sourceInventoryCache.has(inventory)) {
    return accountingFailure([problem("invalid-source-authority", "source", "declaration requires parser-minted source inventory")]);
  }
  const kind = ownDataValue(raw, "kind");
  if (kind === "not-required") {
    const record = exactRecord(raw, ["kind"], "defectFamily");
    const failures = record.ok ? [] : [...record.error];
    if (inventory.survivingCriticals.length !== 0) failures.push(problem(
      "source-declaration-mismatch",
      "defectFamily.kind",
      "not-required is valid only when the source has zero surviving critical Findings",
    ));
    if (failures.length > 0) return accountingFailure(failures);
    const declaration = canonicalRecord({ kind: "not-required" as const });
    return success(declaration);
  }

  const record = exactRecord(raw, ["kind", "provenance", "dispositions", "groups"], "defectFamily");
  if (!record.ok) return accountingFailure(record.error);
  const failures: DefectFamilyFailure[] = [];
  if (record.value.kind !== "declared-defect-family-accounting") {
    failures.push(problem("invalid-declaration", "defectFamily.kind", "defectFamily.kind must equal declared-defect-family-accounting"));
  }
  if (record.value.provenance !== "DECLARED") {
    failures.push(problem("invalid-declaration", "defectFamily.provenance", "defectFamily.provenance must equal DECLARED"));
  }
  if (inventory.survivingCriticals.length === 0) failures.push(problem(
    "source-declaration-mismatch",
    "defectFamily.kind",
    "a source with zero surviving critical Findings requires the explicit not-required declaration",
  ));
  const dispositionEntries = denseArray(record.value.dispositions, "defectFamily.dispositions", true);
  const groupEntries = denseArray(record.value.groups, "defectFamily.groups");
  if (!dispositionEntries.ok) failures.push(...dispositionEntries.error);
  if (!groupEntries.ok) failures.push(...groupEntries.error);
  const dispositions: CriticalFindingDisposition[] = [];
  if (dispositionEntries.ok) dispositionEntries.value.forEach((entry, index) => {
    const disposition = parseDisposition(entry, `defectFamily.dispositions[${index}]`);
    if (disposition.ok) dispositions.push(disposition.value);
    else failures.push(...disposition.error);
  });
  const groups: DeclaredRepairGroup[] = [];
  if (groupEntries.ok) groupEntries.value.forEach((entry, index) => {
    const group = parseRepairGroup(entry, `defectFamily.groups[${index}]`);
    if (group.ok) groups.push(group.value);
    else failures.push(...group.error);
  });
  dispositions.sort((a, b) => compareStrings(a.findingId, b.findingId));
  groups.sort((a, b) => compareStrings(a.repairGroupId, b.repairGroupId));
  failures.push(...validateAccounting(inventory, dispositions, groups));
  const [firstDisposition, ...otherDispositions] = dispositions;
  if (failures.length > 0 || firstDisposition === undefined) return accountingFailure(failures);
  const declaration = canonicalRecord({
    kind: "declared-defect-family-accounting" as const,
    provenance: "DECLARED" as const,
    dispositions: Object.freeze([firstDisposition, ...otherDispositions]) as NonEmpty<CriticalFindingDisposition>,
    groups: immutableArray(groups),
  });
  return success(declaration);
}

/** Canonical distinct union; one check may serve several groups and executes once. */
function selectedRepairCheckIds(declaration: DefectFamilyDeclaration): readonly CompletionCheckId[] {
  return declaration.kind === "not-required"
    ? Object.freeze([])
    : Object.freeze([...new Set(declaration.groups.flatMap(({ checks }) => checks.map(({ checkId }) => checkId)))]
      .sort(compareStrings));
}

export type ProjectCommandAuthority = Readonly<{
  kind: "project-command";
  checkId: CompletionCheckId;
  executable: string;
  args: readonly string[];
  cwd: RepositoryRelativePath;
  timeoutMs: CompletionTimeoutMs;
  reportPolicy: Readonly<{ kind: "required-file"; path: ReviewPath }>;
}>;

export type DefectFamilyVerificationPlan =
  | Readonly<{
      kind: "not-required";
      source: SourceFindingInventory;
      declaration: Extract<DefectFamilyDeclaration, { kind: "not-required" }>;
    }>
  | Readonly<{
      kind: "blocked-declaration";
      source: SourceFindingInventory;
      declaration: Extract<DefectFamilyDeclaration, { kind: "declared-defect-family-accounting" }>;
      failures: NonEmpty<DefectFamilyFailure>;
    }>
  | Readonly<{
      kind: "selected-operator-checks";
      source: SourceFindingInventory;
      declaration: Extract<DefectFamilyDeclaration, { kind: "declared-defect-family-accounting" }>;
      manifestDigest: ArtifactDigest;
      commands: NonEmpty<ProjectCommandAuthority>;
    }>;

const verificationPlanCache = new WeakSet<object>();

function declarationBlockers(
  declaration: Extract<DefectFamilyDeclaration, { kind: "declared-defect-family-accounting" }>,
): readonly DefectFamilyFailure[] {
  const failures: DefectFamilyFailure[] = [];
  declaration.dispositions.forEach((disposition) => {
    if (disposition.status === "unresolved") failures.push(problem(
      "unresolved-critical", "defectFamily.dispositions", `Finding '${disposition.findingId}' is unresolved`,
    ));
    if (disposition.status === "out-of-scope") failures.push(problem(
      "out-of-scope-critical", "defectFamily.dispositions", `Finding '${disposition.findingId}' is out of scope`,
    ));
  });
  declaration.groups.forEach((group) => {
    if (group.siblings.kind === "none-declared") return;
    group.siblings.entries.forEach((sibling) => {
      if (sibling.status === "unresolved") failures.push(problem(
        "unresolved-sibling", "defectFamily.groups.siblings", `sibling '${sibling.path}' is unresolved`,
      ));
      if (sibling.status === "out-of-scope") failures.push(problem(
        "out-of-scope-sibling", "defectFamily.groups.siblings", `sibling '${sibling.path}' is out of scope`,
      ));
    });
  });
  return immutableArray(failures);
}

export type PreparedDefectFamilyAccounting = Readonly<{
  source: SourceFindingInventory;
  declaration: DefectFamilyDeclaration;
  selectedCheckIds: readonly CompletionCheckId[];
  siblingPaths: readonly ReviewPath[];
}>;

const preparedAccountingCache = new WeakSet<object>();

/** Join the ordered authoritative Finding inventory and exact DECLARED accounting
 * before the shell observes operator command or candidate facts. */
export function prepareDefectFamilyAccounting(
  source: AuthoritativeStandaloneReviewResult,
  rawDeclaration: unknown,
): DomainResult<PreparedDefectFamilyAccounting, DefectFamilyAccountingError> {
  const inventory = createSourceFindingInventory(source);
  if (!inventory.ok) return inventory;
  const declaration = parseDefectFamilyDeclaration(inventory.value, rawDeclaration);
  if (!declaration.ok) return declaration;
  const siblingPaths = declaration.value.kind === "not-required" ? [] : declaration.value.groups.flatMap((group) =>
    group.siblings.kind === "declared-siblings" ? group.siblings.entries.map(({ path }) => path) : []);
  const prepared = canonicalRecord({
    source: inventory.value,
    declaration: declaration.value,
    selectedCheckIds: selectedRepairCheckIds(declaration.value),
    siblingPaths: immutableArray([...new Set(siblingPaths)].sort(compareStrings)),
  });
  preparedAccountingCache.add(prepared);
  return success(prepared);
}

/** Select fixed operator-owned required-report commands, or preserve an already-blocked declaration without fake checks. */
export function prepareDefectFamilyVerification(
  accounting: PreparedDefectFamilyAccounting,
  rawManifest: FrozenVerificationManifest | null,
): DomainResult<DefectFamilyVerificationPlan, DefectFamilyAccountingError> {
  if (!preparedAccountingCache.has(accounting)) {
    return accountingFailure([problem("forged-authority", "verification", "verification requires prepared accounting")]);
  }
  const { source: inventory, declaration } = accounting;
  if (declaration.kind === "not-required") {
    const plan = canonicalRecord({ kind: "not-required" as const, source: inventory, declaration });
    verificationPlanCache.add(plan);
    return success(plan);
  }
  const blockers = declarationBlockers(declaration);
  if (blockers.length > 0) {
    const [head, ...tail] = blockers;
    const plan = canonicalRecord({
      kind: "blocked-declaration" as const,
      source: inventory,
      declaration,
      failures: Object.freeze([head!, ...tail]) as NonEmpty<DefectFamilyFailure>,
    });
    verificationPlanCache.add(plan);
    return success(plan);
  }
  if (rawManifest === null) {
    return accountingFailure([problem("invalid-verification-authority", "verification.manifest", "critical repairs require a frozen operator Verification Manifest")]);
  }
  const manifest = parseFrozenVerificationManifest(rawManifest);
  if (!manifest.ok || manifest.value.source.kind !== "operator-file") {
    return accountingFailure([problem(
      "invalid-verification-authority",
      "verification.manifest",
      manifest.ok
        ? "critical repairs require operator-file manifest authority"
        : manifest.error.errors.join("; "),
    )]);
  }
  const selectedIds = selectedRepairCheckIds(declaration);
  const failures: DefectFamilyFailure[] = [];
  const commands: ProjectCommandAuthority[] = [];
  for (const checkId of selectedIds) {
    const check = manifest.value.projectChecks.find((candidate) => candidate.checkId === checkId);
    if (check === undefined) {
      failures.push(problem("missing-repair-check", "verification.checks", `selected check '${checkId}' is absent from the frozen manifest`));
    } else if (check.reportPolicy.kind !== "required-file") {
      failures.push(problem("report-required", "verification.checks", `selected check '${checkId}' must require a structured report file`));
    } else {
      commands.push(canonicalRecord({
        kind: "project-command" as const,
        checkId: check.checkId,
        executable: check.executable,
        args: immutableArray(check.args),
        cwd: check.cwd,
        timeoutMs: check.timeoutMs,
        reportPolicy: canonicalRecord({ kind: "required-file" as const, path: check.reportPolicy.path }),
      }));
    }
  }
  const reportPaths = commands.map(({ reportPolicy }) => reportPolicy.path);
  const duplicateReports = reportPaths.filter((path, index) => reportPaths.indexOf(path) !== index);
  if (duplicateReports.length > 0) failures.push(problem(
    "duplicate-report-path",
    "verification.checks",
    `selected checks share report path(s): ${[...new Set(duplicateReports)].sort(compareStrings).join(", ")}`,
  ));
  const [firstCommand, ...otherCommands] = commands.sort((a, b) => compareStrings(a.checkId, b.checkId));
  if (failures.length > 0 || firstCommand === undefined) return accountingFailure(failures.length > 0 ? failures : [
    problem("missing-repair-check", "verification.checks", "critical repairs require at least one selected check"),
  ]);
  const plan = canonicalRecord({
    kind: "selected-operator-checks" as const,
    source: inventory,
    declaration,
    manifestDigest: manifest.value.manifestDigest,
    commands: Object.freeze([firstCommand, ...otherCommands]) as NonEmpty<ProjectCommandAuthority>,
  });
  verificationPlanCache.add(plan);
  return success(plan);
}

export type CandidateGitWitness = Readonly<{
  baseTreeDigest: ArtifactDigest;
  indexDigest: ArtifactDigest;
  worktreeDigest: ArtifactDigest;
  digest: ArtifactDigest;
}>;

export type CandidateRepositoryWitness = Readonly<{
  kind: "candidate-repository-witness";
  repositoryRoot: string;
  workspaceDigest: ArtifactDigest;
  pathCount: number;
  observedPaths: readonly ReviewPath[];
  gitWitness: CandidateGitWitness;
  generatedReportExclusions: readonly ReviewPath[];
  digest: ArtifactDigest;
}>;

const candidateWitnessCache = new WeakSet<object>();

function parseCandidateGitWitness(raw: unknown, path: string): InternalParse<CandidateGitWitness> {
  const record = exactRecord(raw, ["baseTreeDigest", "indexDigest", "worktreeDigest", "digest"], path);
  if (!record.ok) return record;
  const base = artifactDigest(record.value.baseTreeDigest, `${path}.baseTreeDigest`, "invalid-candidate-witness");
  const index = artifactDigest(record.value.indexDigest, `${path}.indexDigest`, "invalid-candidate-witness");
  const worktree = artifactDigest(record.value.worktreeDigest, `${path}.worktreeDigest`, "invalid-candidate-witness");
  const supplied = artifactDigest(record.value.digest, `${path}.digest`, "invalid-candidate-witness");
  const failures = [base, index, worktree, supplied].flatMap((result) => result.ok ? [] : result.error);
  if (!base.ok || !index.ok || !worktree.ok || !supplied.ok) return failure(immutableArray(failures));
  const expected = digestJson({
    baseTreeDigest: base.value,
    indexDigest: index.value,
    worktreeDigest: worktree.value,
  });
  if (supplied.value !== expected) return rejected(problem("invalid-candidate-witness", `${path}.digest`, `${path}.digest does not match its Git witness fields`));
  return parsed(canonicalRecord({
    baseTreeDigest: base.value,
    indexDigest: index.value,
    worktreeDigest: worktree.value,
    digest: expected,
  }));
}

function parseReportExclusions(raw: unknown, path: string): InternalParse<readonly ReviewPath[]> {
  const entries = denseArray(raw, path);
  if (!entries.ok) return entries;
  const failures: DefectFamilyFailure[] = [];
  const paths: ReviewPath[] = [];
  entries.value.forEach((entry, index) => {
    const candidate = reviewPath(entry, `${path}[${index}]`, "invalid-candidate-witness");
    if (!candidate.ok) failures.push(...candidate.error);
    else if (!candidate.value.startsWith(`${COMPLETION_REPORT_ROOT}/`)) failures.push(problem(
      "invalid-candidate-witness", `${path}[${index}]`, `${path}[${index}] must be beneath ${COMPLETION_REPORT_ROOT}/`,
    ));
    else paths.push(candidate.value);
  });
  const duplicate = paths.filter((candidate, index) => paths.indexOf(candidate) !== index);
  if (duplicate.length > 0) failures.push(problem("invalid-candidate-witness", path, `${path} must be distinct`));
  return failures.length === 0 ? parsed(immutableArray(paths.sort(compareStrings))) : failure(immutableArray(failures));
}

function parseObservedRoster(raw: unknown): InternalParse<readonly ReviewPath[]> {
  const entries = denseArray(raw, "candidateWitness.observedPaths");
  if (!entries.ok) return entries;
  const failures: DefectFamilyFailure[] = [];
  const paths: ReviewPath[] = [];
  entries.value.forEach((entry, index) => {
    const path = reviewPath(entry, `candidateWitness.observedPaths[${index}]`, "invalid-candidate-witness");
    if (path.ok) paths.push(path.value);
    else failures.push(...path.error);
  });
  if (new Set(paths).size !== paths.length) failures.push(problem(
    "invalid-candidate-witness",
    "candidateWitness.observedPaths",
    "candidate witness observed path roster must be distinct",
  ));
  return failures.length === 0
    ? parsed(immutableArray(paths.sort(compareStrings)))
    : failure(immutableArray(failures));
}

function canonicalAbsolutePath(raw: string): boolean {
  if (!raw.startsWith("/") || raw.includes("\0") || raw.includes("//")) return false;
  const parts = raw.split("/").slice(1);
  return parts.every((part, index) => part !== "." && part !== ".." && (part !== "" || index === parts.length - 1));
}

function candidateRepositoryWitness(
  raw: unknown,
  persisted: boolean,
): DomainResult<CandidateRepositoryWitness, DefectFamilyAccountingError> {
  const recordFields = [
    "kind", "repositoryRoot", "workspaceDigest", "pathCount", "observedPaths", "gitWitness", "generatedReportExclusions",
    ...(persisted ? ["digest"] : []),
  ];
  const record = exactRecord(raw, recordFields, "candidateWitness");
  if (!record.ok) return accountingFailure(record.error);
  const failures: DefectFamilyFailure[] = [];
  if (record.value.kind !== "candidate-repository-witness") failures.push(problem(
    "invalid-candidate-witness", "candidateWitness.kind", "candidateWitness.kind must equal candidate-repository-witness",
  ));
  const root = record.value.repositoryRoot;
  if (typeof root !== "string" || !canonicalAbsolutePath(root)) failures.push(problem(
    "invalid-candidate-witness", "candidateWitness.repositoryRoot", "candidate repository root must be a canonical absolute path collected by the shell",
  ));
  const workspace = artifactDigest(record.value.workspaceDigest, "candidateWitness.workspaceDigest", "invalid-candidate-witness");
  const observed = parseObservedRoster(record.value.observedPaths);
  const git = parseCandidateGitWitness(record.value.gitWitness, "candidateWitness.gitWitness");
  const exclusions = parseReportExclusions(record.value.generatedReportExclusions, "candidateWitness.generatedReportExclusions");
  const supplied = persisted
    ? artifactDigest(record.value.digest, "candidateWitness.digest", "invalid-candidate-witness")
    : null;
  for (const result of [workspace, observed, git, exclusions, ...(supplied === null ? [] : [supplied])]) {
    if (!result.ok) failures.push(...result.error);
  }
  if (typeof record.value.pathCount !== "number" || !Number.isSafeInteger(record.value.pathCount) ||
      record.value.pathCount < 0 || (observed.ok && record.value.pathCount !== observed.value.length)) {
    failures.push(problem("invalid-candidate-witness", "candidateWitness.pathCount", "candidateWitness.pathCount must equal the exact observed path roster length"));
  }
  if (failures.length > 0 || typeof root !== "string" || !workspace.ok || !observed.ok || !git.ok || !exclusions.ok ||
      (supplied !== null && !supplied.ok)) {
    return accountingFailure(failures);
  }
  const fields = {
    kind: "candidate-repository-witness" as const,
    repositoryRoot: root,
    workspaceDigest: workspace.value,
    pathCount: record.value.pathCount as number,
    observedPaths: observed.value,
    gitWitness: git.value,
    generatedReportExclusions: exclusions.value,
  };
  const expected = digestJson(fields);
  if (supplied !== null && supplied.ok && supplied.value !== expected) return accountingFailure([problem(
    "invalid-candidate-witness", "candidateWitness.digest", "candidateWitness.digest does not match its canonical identity",
  )]);
  const witness = canonicalRecord({ ...fields, digest: expected });
  candidateWitnessCache.add(witness);
  return success(witness);
}

/** Construct identity from shell-collected facts without performing repository I/O. */
export function createCandidateRepositoryWitness(
  raw: unknown,
): DomainResult<CandidateRepositoryWitness, DefectFamilyAccountingError> {
  return candidateRepositoryWitness(raw, false);
}

/** Rehydrate a persisted witness only when its declared digest remains exact. */
export function parseCandidateRepositoryWitness(
  raw: unknown,
): DomainResult<CandidateRepositoryWitness, DefectFamilyAccountingError> {
  return candidateRepositoryWitness(raw, true);
}

export function compareCandidateRepositoryWitnesses(
  expected: CandidateRepositoryWitness,
  actual: CandidateRepositoryWitness,
): DomainResult<CandidateRepositoryWitness, DefectFamilyAccountingError> {
  if (!candidateWitnessCache.has(expected) || !candidateWitnessCache.has(actual)) {
    return accountingFailure([problem("forged-authority", "candidateWitness", "candidate comparison requires parser-minted witnesses")]);
  }
  return expected.digest === actual.digest
    ? success(actual)
    : accountingFailure([problem("candidate-drift", "candidateWitness", `candidate changed from ${expected.digest} to ${actual.digest}`)]);
}

type RepairCandidatePathProjection = Readonly<{
  kind: "repair-candidate-path-projection";
  candidateWitnessDigest: ArtifactDigest;
  observedPaths: readonly ReviewPath[];
  auditedInstalledPaths: readonly ReviewPath[];
  dirtyOrStagedPaths: readonly ReviewPath[];
  digest: ArtifactDigest;
}>;

const candidateProjectionWitnesses = new WeakMap<object, CandidateRepositoryWitness>();

function parseCanonicalPathSet(raw: unknown, path: string): InternalParse<readonly ReviewPath[]> {
  const entries = denseArray(raw, path);
  if (!entries.ok) return entries;
  const failures: DefectFamilyFailure[] = [];
  const paths: ReviewPath[] = [];
  entries.value.forEach((entry, index) => {
    const candidate = reviewPath(entry, `${path}[${index}]`, "invalid-candidate-path-projection");
    if (candidate.ok) paths.push(candidate.value);
    else failures.push(...candidate.error);
  });
  if (new Set(paths).size !== paths.length) failures.push(problem(
    "invalid-candidate-path-projection", path, `${path} must contain distinct canonical paths`,
  ));
  return failures.length === 0 ? parsed(immutableArray(paths.sort(compareStrings))) : failure(immutableArray(failures));
}

/** Bind shell-produced path facts to one exact candidate witness. */
function parseRepairCandidatePathProjection(
  candidate: CandidateRepositoryWitness,
  raw: unknown,
): DomainResult<RepairCandidatePathProjection, DefectFamilyAccountingError> {
  if (!candidateWitnessCache.has(candidate)) {
    return accountingFailure([problem("forged-authority", "candidatePaths", "candidate path projection requires a parser-minted candidate witness")]);
  }
  const record = exactRecord(raw, [
    "kind", "candidateWitnessDigest", "observedPaths", "auditedInstalledPaths", "dirtyOrStagedPaths",
  ], "candidatePaths");
  if (!record.ok) return accountingFailure(record.error);
  const failures: DefectFamilyFailure[] = [];
  if (record.value.kind !== "repair-candidate-path-projection") failures.push(problem(
    "invalid-candidate-path-projection", "candidatePaths.kind", "candidatePaths.kind must equal repair-candidate-path-projection",
  ));
  const candidateDigest = artifactDigest(record.value.candidateWitnessDigest, "candidatePaths.candidateWitnessDigest", "invalid-candidate-path-projection");
  const observed = parseCanonicalPathSet(record.value.observedPaths, "candidatePaths.observedPaths");
  const installed = parseCanonicalPathSet(record.value.auditedInstalledPaths, "candidatePaths.auditedInstalledPaths");
  const dirty = parseCanonicalPathSet(record.value.dirtyOrStagedPaths, "candidatePaths.dirtyOrStagedPaths");
  for (const result of [candidateDigest, observed, installed, dirty]) if (!result.ok) failures.push(...result.error);
  if (candidateDigest.ok && candidateDigest.value !== candidate.digest) failures.push(problem(
    "candidate-drift", "candidatePaths.candidateWitnessDigest", "candidate path projection is stale for this candidate witness",
  ));
  if (failures.length > 0 || !candidateDigest.ok || !observed.ok || !installed.ok || !dirty.ok) return accountingFailure(failures);
  const fields = {
    kind: "repair-candidate-path-projection" as const,
    candidateWitnessDigest: candidateDigest.value,
    observedPaths: observed.value,
    auditedInstalledPaths: installed.value,
    dirtyOrStagedPaths: dirty.value,
  };
  const projection = canonicalRecord({ ...fields, digest: digestJson(fields) });
  candidateProjectionWitnesses.set(projection, candidate);
  return success(projection);
}

export type RemediationCheckScope = Readonly<{
  kind: "standalone-remediation";
  remediationRunId: OrchestrationRunId;
  sourceRunId: OrchestrationRunId;
  registrationDigest: ArtifactDigest;
  candidateWitnessDigest: ArtifactDigest;
}>;

const scopeBindings = new WeakMap<object, Readonly<{ source: SourceFindingInventory; candidate: CandidateRepositoryWitness }>>();

export function createRemediationCheckScope(
  source: SourceFindingInventory,
  candidate: CandidateRepositoryWitness,
  raw: unknown,
): DomainResult<RemediationCheckScope, DefectFamilyAccountingError> {
  if (!sourceInventoryCache.has(source) || !candidateWitnessCache.has(candidate)) {
    return accountingFailure([problem("forged-authority", "checkScope", "scope requires parser-minted source and candidate authority")]);
  }
  const record = exactRecord(raw, [
    "kind", "remediationRunId", "sourceRunId", "registrationDigest", "candidateWitnessDigest",
  ], "checkScope");
  if (!record.ok) return accountingFailure(record.error);
  const failures: DefectFamilyFailure[] = [];
  if (record.value.kind !== "standalone-remediation") failures.push(problem(
    "invalid-remediation-scope", "checkScope.kind", "checkScope.kind must equal standalone-remediation",
  ));
  const remediation = runId(record.value.remediationRunId, "checkScope.remediationRunId");
  const sourceRun = runId(record.value.sourceRunId, "checkScope.sourceRunId");
  const registration = artifactDigest(record.value.registrationDigest, "checkScope.registrationDigest", "invalid-remediation-scope");
  const candidateDigest = artifactDigest(record.value.candidateWitnessDigest, "checkScope.candidateWitnessDigest", "invalid-remediation-scope");
  for (const result of [remediation, sourceRun, registration, candidateDigest]) if (!result.ok) failures.push(...result.error);
  if (sourceRun.ok && sourceRun.value !== source.sourceRunId) failures.push(problem(
    "invalid-remediation-scope", "checkScope.sourceRunId", "check scope source run does not match the authoritative inventory",
  ));
  if (remediation.ok && remediation.value === source.sourceRunId) failures.push(problem(
    "invalid-remediation-scope", "checkScope.remediationRunId", "remediation and source runs must have distinct identities",
  ));
  if (candidateDigest.ok && candidateDigest.value !== candidate.digest) failures.push(problem(
    "candidate-drift", "checkScope.candidateWitnessDigest", "check scope candidate digest is stale",
  ));
  if (failures.length > 0 || !remediation.ok || !sourceRun.ok || !registration.ok || !candidateDigest.ok) return accountingFailure(failures);
  const scope = canonicalRecord({
    kind: "standalone-remediation" as const,
    remediationRunId: remediation.value,
    sourceRunId: sourceRun.value,
    registrationDigest: registration.value,
    candidateWitnessDigest: candidateDigest.value,
  });
  scopeBindings.set(scope, canonicalRecord({ source, candidate }));
  return success(scope);
}

export type AuthorizedRemediationCheck = Readonly<{
  kind: "authorized-remediation-check";
  scope: RemediationCheckScope;
  manifestDigest: ArtifactDigest;
  command: ProjectCommandAuthority;
  authorityDigest: ArtifactDigest;
}>;

const authorizedCheckBindings = new WeakMap<object, Readonly<{
  plan: Extract<DefectFamilyVerificationPlan, { kind: "selected-operator-checks" }>;
  candidate: CandidateRepositoryWitness;
}>>();

export function authorizeRemediationChecks(
  plan: Extract<DefectFamilyVerificationPlan, { kind: "selected-operator-checks" }>,
  scope: RemediationCheckScope,
): DomainResult<NonEmpty<AuthorizedRemediationCheck>, DefectFamilyAccountingError> {
  const binding = scopeBindings.get(scope);
  if (!verificationPlanCache.has(plan) || binding === undefined || binding.source !== plan.source) {
    return accountingFailure([problem("forged-authority", "authorizedChecks", "check authorization requires matching parser-minted plan and scope")]);
  }
  const expectedReports = plan.commands.map(({ reportPolicy }) => reportPolicy.path).sort(compareStrings);
  if (expectedReports.length !== binding.candidate.generatedReportExclusions.length ||
      expectedReports.some((path, index) => path !== binding.candidate.generatedReportExclusions[index])) {
    return accountingFailure([problem(
      "invalid-candidate-witness",
      "authorizedChecks.generatedReportExclusions",
      "candidate report exclusions must exactly equal selected frozen report paths",
    )]);
  }
  const checks = plan.commands.map((command) => {
    const fields = {
      kind: "authorized-remediation-check" as const,
      scope,
      manifestDigest: plan.manifestDigest,
      command,
    };
    const check = canonicalRecord({ ...fields, authorityDigest: digestJson(fields) });
    authorizedCheckBindings.set(check, canonicalRecord({ plan, candidate: binding.candidate }));
    return check;
  });
  const [head, ...tail] = checks;
  return success(Object.freeze([head, ...tail]) as NonEmpty<AuthorizedRemediationCheck>);
}

type RemediationProcessObservation = Readonly<{
  exitCode: number;
  timedOut: boolean;
  signal: null;
}>;

type ParsedStructuredReportFacts = Readonly<{
  path: ReviewPath;
  digest: ArtifactDigest;
  byteLength: number;
  mode: number;
  summary: TestReportSummary;
}>;

declare class EngineObservedRepairedCheckMembership {
  private readonly engineObservedRepairedCheckMembership: true;
}

export type EngineObservedRepairedCheck = EngineObservedRepairedCheckMembership & Readonly<{
  kind: "engine-observed-repaired-check";
  checkId: CompletionCheckId;
  scope: RemediationCheckScope;
  manifestDigest: ArtifactDigest;
  authorityDigest: ArtifactDigest;
  process: RemediationProcessObservation;
  report: ParsedStructuredReportFacts;
  beforeCandidateDigest: ArtifactDigest;
  afterCandidateDigest: ArtifactDigest;
  digest: ArtifactDigest;
}>;

const observedCheckBindings = new WeakMap<object, Readonly<{
  authorized: AuthorizedRemediationCheck;
  candidate: CandidateRepositoryWitness;
}>>();

/**
 * Rebuild one registered engine event into opaque repaired-check evidence.
 * The imperative shell owns event registration and report-byte parsing; this
 * parser is intentionally not part of any declaration/CLI input surface.
 */
export function parseRegisteredRemediationCheckObservation(
  authorized: AuthorizedRemediationCheck,
  beforeCandidate: CandidateRepositoryWitness,
  afterCandidate: CandidateRepositoryWitness,
  raw: unknown,
): DomainResult<EngineObservedRepairedCheck, DefectFamilyAccountingError> {
  const authorization = authorizedCheckBindings.get(authorized);
  if (authorization === undefined || !candidateWitnessCache.has(beforeCandidate) || !candidateWitnessCache.has(afterCandidate)) {
    return accountingFailure([problem("forged-authority", "observation", "registered observation requires engine-authorized check and parser-minted candidates")]);
  }
  const record = exactRecord(raw, [
    "kind", "checkId", "registrationDigest", "authorityDigest", "candidateWitnessDigest",
    "process", "report", "beforeCandidateDigest", "afterCandidateDigest",
  ], "observation");
  if (!record.ok) return accountingFailure(record.error);
  const processRecord = exactRecord(record.value.process, ["exitCode", "timedOut", "signal"], "observation.process");
  const reportRecord = exactRecord(record.value.report, ["path", "digest", "byteLength", "mode", "summary"], "observation.report");
  const failures: DefectFamilyFailure[] = [];
  if (!processRecord.ok) failures.push(...processRecord.error);
  if (!reportRecord.ok) failures.push(...reportRecord.error);
  if (record.value.kind !== "remediation-check-observed") failures.push(problem(
    "invalid-engine-observation", "observation.kind", "observation.kind must equal remediation-check-observed",
  ));
  if (record.value.checkId !== authorized.command.checkId) failures.push(problem(
    "invalid-engine-observation", "observation.checkId", "observation check id does not match frozen command authority",
  ));
  if (record.value.registrationDigest !== authorized.scope.registrationDigest) failures.push(problem(
    "invalid-engine-observation", "observation.registrationDigest", "observation registration digest is stale or foreign",
  ));
  if (record.value.authorityDigest !== authorized.authorityDigest) failures.push(problem(
    "invalid-engine-observation", "observation.authorityDigest", "observation authority digest is stale or foreign",
  ));
  if (record.value.candidateWitnessDigest !== authorized.scope.candidateWitnessDigest) failures.push(problem(
    "candidate-drift", "observation.candidateWitnessDigest", "observation candidate digest does not match check scope",
  ));
  if (beforeCandidate.digest !== authorized.scope.candidateWitnessDigest ||
      afterCandidate.digest !== authorized.scope.candidateWitnessDigest ||
      record.value.beforeCandidateDigest !== beforeCandidate.digest ||
      record.value.afterCandidateDigest !== afterCandidate.digest) {
    failures.push(problem("candidate-drift", "observation.candidate", "candidate changed before or after repaired check execution"));
  }
  if (processRecord.ok && (processRecord.value.exitCode !== 0 || processRecord.value.timedOut !== false || processRecord.value.signal !== null)) {
    failures.push(problem("failed-repaired-check", "observation.process", "repaired check requires exit 0, no timeout, and no signal"));
  }
  let report: ParsedStructuredReportFacts | null = null;
  if (reportRecord.ok) {
    const reportPath = reviewPath(reportRecord.value.path, "observation.report.path", "invalid-engine-observation");
    const reportDigest = artifactDigest(reportRecord.value.digest, "observation.report.digest", "invalid-engine-observation");
    const summaryRecord = exactRecord(reportRecord.value.summary, ["total", "failed", "source"], "observation.report.summary");
    if (!reportPath.ok) failures.push(...reportPath.error);
    if (!reportDigest.ok) failures.push(...reportDigest.error);
    if (!summaryRecord.ok) failures.push(...summaryRecord.error);
    if (reportPath.ok && reportPath.value !== authorized.command.reportPolicy.path) failures.push(problem(
      "invalid-engine-observation", "observation.report.path", "report path does not match frozen command authority",
    ));
    const byteLength = reportRecord.value.byteLength;
    const mode = reportRecord.value.mode;
    if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength <= 0 || byteLength > MAX_STRUCTURED_REPORT_BYTES) failures.push(problem(
      "invalid-engine-observation", "observation.report.byteLength", `report byteLength must be positive and within ${MAX_STRUCTURED_REPORT_BYTES} byte limit`,
    ));
    if (typeof mode !== "number" || !Number.isSafeInteger(mode) || mode < 0) failures.push(problem(
      "invalid-engine-observation", "observation.report.mode", "report mode must be a non-negative safe integer",
    ));
    let summary: TestReportSummary | null = null;
    if (summaryRecord.ok &&
        (summaryRecord.value.source === "vitest-json" || summaryRecord.value.source === "junit-xml")) {
      const reparsed = parseReportSummary(
        summaryRecord.value.total,
        summaryRecord.value.failed,
        summaryRecord.value.source,
      );
      summary = reparsed === null ? null : Object.freeze(reparsed);
    }
    if (summary === null || summary.total <= 0 || summary.failed !== 0) failures.push(problem(
      "failed-repaired-check", "observation.report.summary", "repaired check requires a parsed structured report with positive total and zero failures",
    ));
    if (reportPath.ok && reportDigest.ok && summary !== null &&
        typeof byteLength === "number" && Number.isSafeInteger(byteLength) && byteLength > 0 && byteLength <= MAX_STRUCTURED_REPORT_BYTES &&
        typeof mode === "number" && Number.isSafeInteger(mode) && mode >= 0) {
      report = canonicalRecord({
        path: reportPath.value,
        digest: reportDigest.value,
        byteLength,
        mode,
        summary,
      });
    }
  }
  if (failures.length > 0 || !processRecord.ok || report === null) return accountingFailure(failures);
  const fields = {
    kind: "engine-observed-repaired-check" as const,
    checkId: authorized.command.checkId,
    scope: authorized.scope,
    manifestDigest: authorized.manifestDigest,
    authorityDigest: authorized.authorityDigest,
    process: canonicalRecord({ exitCode: 0, timedOut: false, signal: null }),
    report,
    beforeCandidateDigest: beforeCandidate.digest,
    afterCandidateDigest: afterCandidate.digest,
  };
  const observation = canonicalRecord({ ...fields, digest: digestJson(fields) }) as EngineObservedRepairedCheck;
  observedCheckBindings.set(observation, canonicalRecord({ authorized, candidate: beforeCandidate }));
  return success(observation);
}

type DefectFamilyAssessment =
  | Readonly<{
      status: "not-required";
      reason: "no-surviving-critical-findings";
      source: SourceFindingInventory;
      digest: ArtifactDigest;
    }>
  | Readonly<{
      status: "repair-checked";
      source: SourceFindingInventory;
      declaration: Extract<DefectFamilyDeclaration, { kind: "declared-defect-family-accounting" }>;
      candidateWitnessDigest: ArtifactDigest;
      candidatePaths: RepairCandidatePathProjection;
      repairedChecks: NonEmpty<EngineObservedRepairedCheck>;
      provenance: Readonly<{
        grouping: "DECLARED";
        rootCause: "DECLARED";
        invariant: "DECLARED";
        siblingAccounting: "DECLARED";
        historicalRed: "DECLARED";
        repairedTests: "ENGINE_OBSERVED";
      }>;
      digest: ArtifactDigest;
    }>
  | Readonly<{
      status: "blocked";
      source: SourceFindingInventory;
      declaration: DefectFamilyDeclaration;
      failures: NonEmpty<DefectFamilyFailure>;
      digest: ArtifactDigest;
    }>
  | Readonly<{
      status: "historical-unknown";
      reason: "legacy-remediation-has-no-p3-accounting";
    }>;

type DefectFamilyEvaluationEvidence =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "repair-observations";
      candidatePaths: RepairCandidatePathProjection;
      repairedChecks: readonly EngineObservedRepairedCheck[];
    }>;

const assessmentCache = new WeakSet<object>();

function blockedAssessment(
  plan: DefectFamilyVerificationPlan,
  failures: readonly DefectFamilyFailure[],
): Extract<DefectFamilyAssessment, { status: "blocked" }> {
  const [head, ...tail] = failures.length > 0
    ? failures
    : [problem("invalid-declaration", "assessment", "Defect-Family Accounting is blocked")];
  const fields = {
    status: "blocked" as const,
    source: plan.source,
    declaration: plan.declaration,
    failures: Object.freeze([head!, ...tail]) as NonEmpty<DefectFamilyFailure>,
  };
  const assessment = canonicalRecord({ ...fields, digest: digestJson(fields) });
  assessmentCache.add(assessment);
  return assessment;
}

function siblingEvidenceFailures(
  declaration: Extract<DefectFamilyDeclaration, { kind: "declared-defect-family-accounting" }>,
  paths: RepairCandidatePathProjection,
): readonly DefectFamilyFailure[] {
  const installed = new Set(paths.auditedInstalledPaths);
  const observed = new Set(paths.observedPaths);
  const dirty = new Set(paths.dirtyOrStagedPaths);
  const failures: DefectFamilyFailure[] = [];
  for (const group of declaration.groups) {
    if (group.siblings.kind === "none-declared") continue;
    for (const sibling of group.siblings.entries) {
      if (sibling.status === "repaired" && !installed.has(sibling.path)) failures.push(problem(
        "missing-repaired-sibling", "candidatePaths.auditedInstalledPaths", `repaired sibling '${sibling.path}' is absent from the audited installed path set`,
      ));
      if (sibling.status === "checked-unmodified" && !observed.has(sibling.path)) failures.push(problem(
        "checked-unmodified-sibling-unobserved", "candidatePaths.observedPaths", `checked-unmodified sibling '${sibling.path}' was not observed by the candidate witness`,
      ));
      if (sibling.status === "checked-unmodified" && dirty.has(sibling.path)) failures.push(problem(
        "checked-unmodified-sibling-dirty", "candidatePaths.dirtyOrStagedPaths", `checked-unmodified sibling '${sibling.path}' is dirty or staged`,
      ));
    }
  }
  return immutableArray(failures);
}

/** Pure evaluator. Only opaque registered observations can mint repair-checked. */
function evaluateDefectFamilyAccounting(
  plan: DefectFamilyVerificationPlan,
  evidence: DefectFamilyEvaluationEvidence,
): DefectFamilyAssessment {
  if (!verificationPlanCache.has(plan)) {
    return blockedAssessment(plan, [problem("forged-authority", "assessment", "assessment requires a parser-minted verification plan")]);
  }
  if (plan.kind === "not-required") {
    if (evidence.kind !== "none") return blockedAssessment(plan, [problem(
      "unexpected-repair-evidence", "assessment.evidence", "not-required assessment must not carry repair observations",
    )]);
    const fields = {
      status: "not-required" as const,
      reason: "no-surviving-critical-findings" as const,
      source: plan.source,
    };
    const assessment = canonicalRecord({ ...fields, digest: digestJson(fields) });
    assessmentCache.add(assessment);
    return assessment;
  }
  if (plan.kind === "blocked-declaration") return blockedAssessment(plan, plan.failures);
  if (evidence.kind !== "repair-observations") return blockedAssessment(plan, [problem(
    "missing-repair-check", "assessment.evidence", "repair observations are required for critical repairs",
  )]);
  const candidate = candidateProjectionWitnesses.get(evidence.candidatePaths);
  const failures: DefectFamilyFailure[] = [];
  if (candidate === undefined) failures.push(problem(
    "forged-authority", "assessment.candidatePaths", "assessment requires a candidate-bound path projection",
  ));
  const counts = new Map<string, number>();
  evidence.repairedChecks.forEach((check) => counts.set(check.checkId, (counts.get(check.checkId) ?? 0) + 1));
  const expectedIds = plan.commands.map(({ checkId }) => checkId);
  const missing = expectedIds.filter((checkId) => !counts.has(checkId));
  const surplus = [...counts.keys()].filter((checkId) => !expectedIds.includes(checkId as CompletionCheckId)).sort(compareStrings);
  const duplicate = [...counts.entries()].filter(([, count]) => count > 1).map(([checkId]) => checkId).sort(compareStrings);
  if (missing.length > 0) failures.push(problem("missing-repair-check", "assessment.repairedChecks", `missing repaired check(s): ${missing.join(", ")}`));
  if (surplus.length > 0) failures.push(problem("surplus-repair-check", "assessment.repairedChecks", `surplus repaired check(s): ${surplus.join(", ")}`));
  if (duplicate.length > 0) failures.push(problem("duplicate-repair-check", "assessment.repairedChecks", `duplicate repaired check(s): ${duplicate.join(", ")}`));
  for (const check of evidence.repairedChecks) {
    const binding = observedCheckBindings.get(check);
    const expectedCommand = plan.commands.find(({ checkId }) => checkId === check.checkId);
    if (binding === undefined || expectedCommand === undefined ||
        authorizedCheckBindings.get(binding.authorized)?.plan !== plan ||
        binding.authorized.command !== expectedCommand ||
        binding.candidate.digest !== candidate?.digest ||
        check.scope.candidateWitnessDigest !== evidence.candidatePaths.candidateWitnessDigest) {
      failures.push(problem("forged-authority", "assessment.repairedChecks", `check '${check.checkId}' is stale, foreign, or not engine-observed for this plan and candidate`));
    }
  }
  failures.push(...siblingEvidenceFailures(plan.declaration, evidence.candidatePaths));
  if (failures.length > 0 || candidate === undefined) return blockedAssessment(plan, failures);
  const repairedChecks = [...evidence.repairedChecks].sort((a, b) => compareStrings(a.checkId, b.checkId));
  const [firstCheck, ...otherChecks] = repairedChecks;
  if (firstCheck === undefined) return blockedAssessment(plan, [problem(
    "missing-repair-check", "assessment.repairedChecks", "repair-checked requires at least one observed repaired check",
  )]);
  const fields = {
    status: "repair-checked" as const,
    source: plan.source,
    declaration: plan.declaration,
    candidateWitnessDigest: candidate.digest,
    candidatePaths: evidence.candidatePaths,
    repairedChecks: Object.freeze([firstCheck, ...otherChecks]) as NonEmpty<EngineObservedRepairedCheck>,
    provenance: canonicalRecord({
      grouping: "DECLARED" as const,
      rootCause: "DECLARED" as const,
      invariant: "DECLARED" as const,
      siblingAccounting: "DECLARED" as const,
      historicalRed: "DECLARED" as const,
      repairedTests: "ENGINE_OBSERVED" as const,
    }),
  };
  const assessment = canonicalRecord({ ...fields, digest: digestJson(fields) });
  assessmentCache.add(assessment);
  return assessment;
}

declare class InstallableDefectFamilyAssessmentMembership {
  private readonly installableDefectFamilyAssessmentMembership: true;
}

export type InstallableDefectFamilyAssessment = InstallableDefectFamilyAssessmentMembership &
  (Extract<DefectFamilyAssessment, { status: "not-required" }> |
   Extract<DefectFamilyAssessment, { status: "repair-checked" }>);

export type InstallableDefectFamilyAssessmentProjection = Readonly<{
  status: "not-required" | "repair-checked";
  sourceRunId: OrchestrationRunId;
  sourceResultDigest: ArtifactDigest;
  assessmentDigest: ArtifactDigest;
  candidateWitnessDigest: ArtifactDigest | null;
  candidatePathProjectionDigest: ArtifactDigest | null;
  assessment: Extract<DefectFamilyAssessment, { status: "not-required" | "repair-checked" }>;
}>;

const installableAssessmentCache = new WeakMap<object, InstallableDefectFamilyAssessmentProjection>();

/** The sole constructor that narrows assessments to installation authority. */
function mintInstallableDefectFamilyAssessment(
  assessment: DefectFamilyAssessment,
): DomainResult<InstallableDefectFamilyAssessment, DefectFamilyAccountingError> {
  if (!assessmentCache.has(assessment) || (assessment.status !== "not-required" && assessment.status !== "repair-checked")) {
    return accountingFailure([problem("forged-authority", "assessment", "only parser-evaluated not-required or repair-checked assessments are installable")]);
  }
  const installable = assessment as InstallableDefectFamilyAssessment;
  installableAssessmentCache.set(installable, canonicalRecord({
    status: assessment.status,
    sourceRunId: assessment.source.sourceRunId,
    sourceResultDigest: assessment.source.sourceResultDigest,
    assessmentDigest: assessment.digest,
    candidateWitnessDigest: assessment.status === "repair-checked" ? assessment.candidateWitnessDigest : null,
    candidatePathProjectionDigest: assessment.status === "repair-checked" ? assessment.candidatePaths.digest : null,
    assessment,
  }));
  return success(installable);
}

/** Own path projection, check evaluation and installability as one command.
 * Audit facts are parsed even for not-required: absent evidence is not an empty audit. */
export function evaluateInstallableDefectFamilyAccounting(
  plan: DefectFamilyVerificationPlan,
  candidate: CandidateRepositoryWitness,
  rawAuditFacts: unknown,
  observations: readonly EngineObservedRepairedCheck[],
): DomainResult<InstallableDefectFamilyAssessment, DefectFamilyAccountingError> {
  if (!verificationPlanCache.has(plan) || !candidateWitnessCache.has(candidate)) {
    return accountingFailure([problem("forged-authority", "assessment", "assessment requires parser-minted plan and candidate")]);
  }
  const checks = denseArray(observations, "observations");
  if (!checks.ok) return accountingFailure(checks.error);
  if (checks.value.some(check => typeof check !== "object" || check === null || !observedCheckBindings.has(check))) {
    return accountingFailure([problem("forged-authority", "observations", "assessment requires registered engine observations")]);
  }
  const audit = exactRecord(rawAuditFacts, ["auditedInstalledPaths", "dirtyOrStagedPaths"], "auditFacts");
  if (!audit.ok) return accountingFailure(audit.error);
  const paths = parseRepairCandidatePathProjection(candidate, {
    kind: "repair-candidate-path-projection",
    candidateWitnessDigest: candidate.digest,
    observedPaths: candidate.observedPaths,
    auditedInstalledPaths: audit.value.auditedInstalledPaths,
    dirtyOrStagedPaths: audit.value.dirtyOrStagedPaths,
  });
  if (!paths.ok) return paths;
  if (plan.kind === "not-required" && observations.length !== 0) {
    return accountingFailure([problem("unexpected-repair-evidence", "assessment.evidence", "not-required assessment must not carry repair observations")]);
  }
  const assessment = evaluateDefectFamilyAccounting(plan, plan.kind === "not-required"
    ? { kind: "none" }
    : { kind: "repair-observations", candidatePaths: paths.value, repairedChecks: observations });
  if (assessment.status === "blocked") return accountingFailure(assessment.failures);
  return mintInstallableDefectFamilyAssessment(assessment);
}

/** Runtime membership accessor consumed by the installation seam. */
export function inspectInstallableDefectFamilyAssessment(
  assessment: InstallableDefectFamilyAssessment,
): DomainResult<InstallableDefectFamilyAssessmentProjection, DefectFamilyAccountingError> {
  const projection = typeof assessment === "object" && assessment !== null
    ? installableAssessmentCache.get(assessment)
    : undefined;
  return projection === undefined
    ? accountingFailure([problem("forged-authority", "assessment", "installable assessment membership is absent")])
    : success(projection);
}
