import {
  authorizeRemediationChecks,
  createRemediationCheckScope,
  type AuthorizedRemediationCheck,
  type CandidateRepositoryWitness,
  type DefectFamilyDeclaration,
  type DefectFamilyVerificationPlan,
  type SourceFindingInventory,
} from "../../../core/defect-family-accounting";
import {
  parseArtifactDigest,
  parseOrchestrationRunId,
  type ArtifactDigest,
  type DomainResult,
  type NonEmpty,
  type OrchestrationRunId,
} from "../../../core/orchestration-contract";
import { sha256Hex } from "../../../core/digest";
import type { FrozenVerificationManifest } from "../../../core/verification-manifest";

export type RemediationStartInputV1 = Readonly<{
  sourceRunsRoot: string;
  sourceRun: string;
  supportPaths: readonly string[];
}>;

export type RemediationStartInputV2 = Readonly<{
  sourceRunsRoot: string;
  sourceRun: string;
  supportPaths: readonly string[];
  defectFamily: unknown;
}>;

export type RegisteredRemediationProgramV1 = Readonly<{
  schemaVersion: 1;
  kind: "remediation";
  input: RemediationStartInputV1;
}>;

export type RegisteredRemediationProgramV2 = Readonly<{
  schemaVersion: 2;
  kind: "remediation";
  input: Omit<RemediationStartInputV2, "defectFamily"> & Readonly<{ defectFamily: DefectFamilyDeclaration }>;
  source: Readonly<{
    runId: OrchestrationRunId;
    resultDigest: ArtifactDigest;
    inventory: SourceFindingInventory;
  }>;
  verification:
    | Readonly<{ kind: "not-required"; reason: "no-surviving-critical-findings" }>
    | Readonly<{
        kind: "selected-operator-checks";
        manifest: FrozenVerificationManifest;
        checks: NonEmpty<AuthorizedRemediationCheck>;
      }>;
  candidateBaseline: CandidateRepositoryWitness;
  registrationDigest: ArtifactDigest;
}>;

export type RegisteredRemediationProgram =
  | RegisteredRemediationProgramV1
  | RegisteredRemediationProgramV2;

export type RemediationRegistrationError = Readonly<{
  kind: "invalid-remediation-registration";
  message: string;
}>;

const success = <T>(value: T): DomainResult<T, RemediationRegistrationError> =>
  Object.freeze({ ok: true, value });
const failure = <T>(message: string): DomainResult<T, RemediationRegistrationError> =>
  Object.freeze({ ok: false, error: Object.freeze({ kind: "invalid-remediation-registration", message }) });

function exactDataRecord(raw: unknown, fields: readonly string[], label: string): DomainResult<Readonly<Record<string, unknown>>, RemediationRegistrationError> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return failure(`${label} must be a plain own-data object`);
  try {
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) return failure(`${label} must be a plain own-data object`);
    const keys = Reflect.ownKeys(raw);
    if (keys.some((key) => typeof key !== "string")) return failure(`${label} must not contain symbol fields`);
    const actual = keys as string[];
    const missing = fields.filter((field) => !actual.includes(field));
    const surplus = actual.filter((field) => !fields.includes(field));
    if (missing.length > 0 || surplus.length > 0) {
      return failure(`${label} must contain exactly ${fields.join(", ")}`);
    }
    const copy = Object.create(null) as Record<string, unknown>;
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, field);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        return failure(`${label}.${field} must be an enumerable own data field`);
      }
      Object.defineProperty(copy, field, { value: descriptor.value, enumerable: true });
    }
    return success(Object.freeze(copy));
  } catch {
    return failure(`${label} could not be safely inspected`);
  }
}

function stringArray(raw: unknown, label: string): DomainResult<readonly string[], RemediationRegistrationError> {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) return failure(`${label} must be a plain array`);
  const values: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "string" || descriptor.value.length === 0) {
      return failure(`${label}[${index}] must be a non-empty own-data string`);
    }
    values.push(descriptor.value);
  }
  return success(Object.freeze(values));
}

function inputV1(raw: unknown): DomainResult<RemediationStartInputV1, RemediationRegistrationError> {
  const record = exactDataRecord(raw, ["sourceRunsRoot", "sourceRun", "supportPaths"], "remediation input");
  if (!record.ok) return record;
  const support = stringArray(record.value.supportPaths, "remediation input.supportPaths");
  if (typeof record.value.sourceRunsRoot !== "string" || record.value.sourceRunsRoot.length === 0 ||
      typeof record.value.sourceRun !== "string" || record.value.sourceRun.length === 0 || !support.ok) {
    return failure(support.ok
      ? "remediation input sourceRunsRoot and sourceRun must be non-empty strings"
      : support.error.message);
  }
  return success(Object.freeze({
    sourceRunsRoot: record.value.sourceRunsRoot,
    sourceRun: record.value.sourceRun,
    supportPaths: support.value,
  }));
}

export function parseRemediationStartInputV2(raw: unknown): DomainResult<RemediationStartInputV2, RemediationRegistrationError> {
  const record = exactDataRecord(raw, ["sourceRunsRoot", "sourceRun", "supportPaths", "defectFamily"], "remediation input");
  if (!record.ok) return record;
  const support = stringArray(record.value.supportPaths, "remediation input.supportPaths");
  if (typeof record.value.sourceRunsRoot !== "string" || record.value.sourceRunsRoot.length === 0 ||
      typeof record.value.sourceRun !== "string" || record.value.sourceRun.length === 0 || !support.ok) {
    return failure(support.ok
      ? "remediation input sourceRunsRoot and sourceRun must be non-empty strings"
      : support.error.message);
  }
  return success(Object.freeze({
    sourceRunsRoot: record.value.sourceRunsRoot,
    sourceRun: record.value.sourceRun,
    supportPaths: support.value,
    defectFamily: record.value.defectFamily,
  }));
}

function registrationIdentity(
  input: RegisteredRemediationProgramV2["input"],
  source: RegisteredRemediationProgramV2["source"],
  verification: DefectFamilyVerificationPlan,
  candidate: CandidateRepositoryWitness,
): unknown {
  return {
    schemaVersion: 2,
    kind: "remediation",
    input,
    source: { runId: source.runId, resultDigest: source.resultDigest, inventory: source.inventory },
    verification: verification.kind === "not-required"
      ? { kind: "not-required", reason: "no-surviving-critical-findings" }
      : { kind: verification.kind, manifestDigest: verification.kind === "selected-operator-checks" ? verification.manifestDigest : null },
    candidateBaselineDigest: candidate.digest,
  };
}

export type CreateRemediationRegistrationInput = Readonly<{
  remediationRunId: OrchestrationRunId;
  input: RegisteredRemediationProgramV2["input"];
  verification: Exclude<DefectFamilyVerificationPlan, { kind: "blocked-declaration" }>;
  manifest: FrozenVerificationManifest | null;
  candidateBaseline: CandidateRepositoryWitness;
}>;

export function createRegisteredRemediationProgramV2(
  input: CreateRemediationRegistrationInput,
): DomainResult<RegisteredRemediationProgramV2, RemediationRegistrationError> {
  if (input.verification.kind === "selected-operator-checks" && input.manifest === null) {
    return failure("selected remediation verification requires its frozen manifest");
  }
  if (input.verification.kind === "not-required" && input.manifest !== null) {
    return failure("not-required remediation must not retain manifest authority");
  }
  const source = Object.freeze({
    runId: input.verification.source.sourceRunId,
    resultDigest: input.verification.source.sourceResultDigest,
    inventory: input.verification.source,
  });
  const digest = parseArtifactDigest(sha256Hex(JSON.stringify(registrationIdentity(
    input.input,
    source,
    input.verification,
    input.candidateBaseline,
  ))));
  if (!digest.ok) return failure(digest.error.message);
  let registeredVerification: RegisteredRemediationProgramV2["verification"];
  if (input.verification.kind === "not-required") {
    registeredVerification = Object.freeze({ kind: "not-required", reason: "no-surviving-critical-findings" });
  } else {
    const scope = createRemediationCheckScope(input.verification.source, input.candidateBaseline, {
      kind: "standalone-remediation",
      remediationRunId: input.remediationRunId,
      sourceRunId: input.verification.source.sourceRunId,
      registrationDigest: digest.value,
      candidateWitnessDigest: input.candidateBaseline.digest,
    });
    if (!scope.ok) return failure(scope.error.failures.map(({ message }) => message).join("; "));
    const checks = authorizeRemediationChecks(input.verification, scope.value);
    if (!checks.ok) return failure(checks.error.failures.map(({ message }) => message).join("; "));
    registeredVerification = Object.freeze({
      kind: "selected-operator-checks",
      manifest: input.manifest!,
      checks: checks.value,
    });
  }
  return success(Object.freeze({
    schemaVersion: 2,
    kind: "remediation",
    input: input.input,
    source,
    verification: registeredVerification,
    candidateBaseline: input.candidateBaseline,
    registrationDigest: digest.value,
  }));
}

/** Strict version dispatch: a malformed v2 can never fall back to v1. */
export function parseRegisteredRemediationProgram(raw: unknown): DomainResult<RegisteredRemediationProgram, RemediationRegistrationError> {
  const versionDescriptor = typeof raw === "object" && raw !== null
    ? Object.getOwnPropertyDescriptor(raw, "schemaVersion")
    : undefined;
  const version = versionDescriptor !== undefined && "value" in versionDescriptor ? versionDescriptor.value : null;
  if (version === 1) {
    const record = exactDataRecord(raw, ["schemaVersion", "kind", "input"], "remediation registration v1");
    if (!record.ok || record.value.kind !== "remediation") return failure(record.ok ? "remediation registration v1 kind is invalid" : record.error.message);
    const parsed = inputV1(record.value.input);
    return parsed.ok
      ? success(Object.freeze({ schemaVersion: 1, kind: "remediation", input: parsed.value }))
      : parsed;
  }
  if (version !== 2) return failure("remediation registration schemaVersion must equal 1 or 2");
  const record = exactDataRecord(raw, [
    "schemaVersion", "kind", "input", "source", "verification", "candidateBaseline", "registrationDigest",
  ], "remediation registration v2");
  if (!record.ok || record.value.kind !== "remediation") return failure(record.ok ? "remediation registration v2 kind is invalid" : record.error.message);
  const parsedInput = parseRemediationStartInputV2(record.value.input);
  const source = exactDataRecord(record.value.source, ["runId", "resultDigest", "inventory"], "remediation registration v2 source");
  const verificationKind = typeof record.value.verification === "object" && record.value.verification !== null
    ? Object.getOwnPropertyDescriptor(record.value.verification, "kind")
    : undefined;
  const verificationFields = verificationKind !== undefined && "value" in verificationKind && verificationKind.value === "not-required"
    ? ["kind", "reason"]
    : ["kind", "manifest", "checks"];
  const verification = exactDataRecord(record.value.verification, verificationFields, "remediation registration v2 verification");
  if (!parsedInput.ok) return failure(parsedInput.error.message);
  if (!source.ok) return failure(source.error.message);
  if (!verification.ok) return failure(verification.error.message);
  const runId = parseOrchestrationRunId(source.value.runId);
  if (!runId.ok) return failure(runId.error.message);
  const resultDigest = parseArtifactDigest(source.value.resultDigest);
  if (!resultDigest.ok) return failure(resultDigest.error.message);
  const registrationDigest = parseArtifactDigest(record.value.registrationDigest);
  if (!registrationDigest.ok) return failure(registrationDigest.error.message);
  if (verification.value.kind === "not-required" && verification.value.reason !== "no-surviving-critical-findings") {
    return failure("remediation registration v2 not-required reason is invalid");
  }
  if (verification.value.kind !== "not-required" && verification.value.kind !== "selected-operator-checks") {
    return failure("remediation registration v2 verification kind is invalid");
  }
  return success(Object.freeze({
    schemaVersion: 2,
    kind: "remediation",
    input: parsedInput.value as RegisteredRemediationProgramV2["input"],
    source: Object.freeze({ runId: runId.value, resultDigest: resultDigest.value, inventory: source.value.inventory as SourceFindingInventory }),
    verification: verification.value as RegisteredRemediationProgramV2["verification"],
    candidateBaseline: record.value.candidateBaseline as CandidateRepositoryWitness,
    registrationDigest: registrationDigest.value,
  }));
}
