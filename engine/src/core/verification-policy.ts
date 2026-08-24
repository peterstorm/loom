/** Pure verification-policy model and TaskGraph compatibility parser. */

const AUTHORED_REGRESSION_WAIVER_REASONS = [
  "documentation-only",
  "generated-artifact",
] as const;
export const REGRESSION_WAIVER_REASONS = [
  ...AUTHORED_REGRESSION_WAIVER_REASONS,
  "legacy-new-tests-required-false",
] as const;
export type RegressionWaiverReason = (typeof REGRESSION_WAIVER_REASONS)[number];

const AUTHORED_NEW_TEST_WAIVER_REASONS = [
  "existing-tests-sufficient",
  "documentation-only",
  "generated-artifact",
] as const;
export const NEW_TEST_WAIVER_REASONS = [
  ...AUTHORED_NEW_TEST_WAIVER_REASONS,
  "legacy-new-tests-required-false",
] as const;
export type NewTestWaiverReason = (typeof NEW_TEST_WAIVER_REASONS)[number];

export type VerificationRequirement<Reason extends string> =
  | Readonly<{ kind: "required" }>
  | Readonly<{ kind: "waived"; reason: Reason }>;

export type VerificationPolicy = Readonly<{
  regression: VerificationRequirement<RegressionWaiverReason>;
  newTests: VerificationRequirement<NewTestWaiverReason>;
}>;

export type StoredVerificationPolicy = Readonly<{
  regression: VerificationRequirement<RegressionWaiverReason>;
  new_tests: VerificationRequirement<NewTestWaiverReason>;
}>;

export type VerificationPolicyParseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

export type TaskVerificationPolicySource = Readonly<{
  verification_policy?: unknown;
  new_tests_required?: unknown;
}>;

export type ParsedTaskVerificationPolicy = Readonly<{
  policy: VerificationPolicy;
  source: "explicit" | "legacy" | "default";
}>;

const required = Object.freeze({ kind: "required" as const });
const legacyRegressionWaiver = Object.freeze({
  kind: "waived" as const,
  reason: "legacy-new-tests-required-false" as const,
});
const legacyNewTestWaiver = Object.freeze({
  kind: "waived" as const,
  reason: "legacy-new-tests-required-false" as const,
});

export const REQUIRED_VERIFICATION_POLICY: VerificationPolicy = Object.freeze({
  regression: required,
  newTests: required,
});

export const LEGACY_TESTS_WAIVED_POLICY: VerificationPolicy = Object.freeze({
  regression: legacyRegressionWaiver,
  newTests: legacyNewTestWaiver,
});

const success = <T>(value: T): VerificationPolicyParseResult<T> => Object.freeze({ ok: true, value });
const failure = <T>(errors: readonly string[]): VerificationPolicyParseResult<T> =>
  Object.freeze({ ok: false, errors: Object.freeze([...errors]) });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function exactKeys(raw: Record<string, unknown>, expected: readonly string[], path: string): readonly string[] {
  const allowed = new Set(expected);
  return Object.keys(raw)
    .filter((key) => !allowed.has(key))
    .map((key) => `${path}.${key} is not allowed`);
}

function parseRequirement<Reason extends string>(
  raw: unknown,
  reasons: readonly Reason[],
  path: string,
): VerificationPolicyParseResult<VerificationRequirement<Reason>> {
  if (!isRecord(raw)) return failure([`${path} must be an object`]);
  if (raw.kind === "required") {
    const errors = exactKeys(raw, ["kind"], path);
    return errors.length === 0 ? success(required) : failure(errors);
  }
  if (raw.kind !== "waived") {
    return failure([`${path}.kind must be required or waived`]);
  }
  const errors = [...exactKeys(raw, ["kind", "reason"], path)];
  const reason = reasons.find((candidate) => candidate === raw.reason);
  if (reason === undefined) {
    return failure([...errors, `${path}.reason must be one of ${reasons.join(", ")}`]);
  }
  return errors.length > 0
    ? failure(errors)
    : success(Object.freeze({ kind: "waived", reason }));
}

function parsePolicyWithReasons(
  raw: unknown,
  regressionReasons: readonly RegressionWaiverReason[],
  newTestReasons: readonly NewTestWaiverReason[],
  path: string,
): VerificationPolicyParseResult<VerificationPolicy> {
  if (!isRecord(raw)) return failure([`${path} must be an object`]);
  const errors = [...exactKeys(raw, ["regression", "new_tests"], path)];
  const regression = parseRequirement(raw.regression, regressionReasons, `${path}.regression`);
  const newTests = parseRequirement(raw.new_tests, newTestReasons, `${path}.new_tests`);
  if (!regression.ok) errors.push(...regression.errors);
  if (!newTests.ok) errors.push(...newTests.errors);
  return errors.length > 0 || !regression.ok || !newTests.ok
    ? failure(errors)
    : success(Object.freeze({ regression: regression.value, newTests: newTests.value }));
}

/** Parse persisted policy, including the migration-only legacy reason. */
export function parseVerificationPolicy(
  raw: unknown,
  path = "verification_policy",
): VerificationPolicyParseResult<VerificationPolicy> {
  return parsePolicyWithReasons(raw, REGRESSION_WAIVER_REASONS, NEW_TEST_WAIVER_REASONS, path);
}

/** Agent-authored policy cannot claim migration provenance. */
function parseAuthoredVerificationPolicy(
  raw: unknown,
  path = "verification_policy",
): VerificationPolicyParseResult<VerificationPolicy> {
  return parsePolicyWithReasons(
    raw,
    AUTHORED_REGRESSION_WAIVER_REASONS,
    AUTHORED_NEW_TEST_WAIVER_REASONS,
    path,
  );
}

/** Historical boolean translation. Absent meant true throughout the existing protocol. */
export function verificationPolicyFromLegacy(newTestsRequired: boolean | undefined): VerificationPolicy {
  return newTestsRequired === false ? LEGACY_TESTS_WAIVED_POLICY : REQUIRED_VERIFICATION_POLICY;
}

export function requiresRegression(policy: VerificationPolicy): boolean {
  return policy.regression.kind === "required";
}

export function requiresNewTests(policy: VerificationPolicy): boolean {
  return policy.newTests.kind === "required";
}

/** Legacy compatibility compares semantics, not waiver-reason spelling. */
export function verificationPolicyMatchesLegacy(
  policy: VerificationPolicy,
  newTestsRequired: boolean | undefined,
): boolean {
  const legacy = verificationPolicyFromLegacy(newTestsRequired);
  return requiresRegression(policy) === requiresRegression(legacy) &&
    requiresNewTests(policy) === requiresNewTests(legacy);
}

/**
 * Parse policy from one unknown Task record. Explicit policy is authoritative,
 * but a coexisting legacy field must express identical required/waived semantics.
 */
export function parseTaskVerificationPolicy(
  raw: TaskVerificationPolicySource,
  path = "task",
  source: "stored" | "authored" = "stored",
): VerificationPolicyParseResult<ParsedTaskVerificationPolicy> {
  const legacy = raw.new_tests_required;
  if (legacy !== undefined && typeof legacy !== "boolean") {
    return failure([`${path}.new_tests_required must be a boolean when present`]);
  }
  if (raw.verification_policy === undefined) {
    if (source === "authored") {
      return failure([`${path}.verification_policy is required for authored task payloads`]);
    }
    return success(Object.freeze({
      policy: verificationPolicyFromLegacy(legacy as boolean | undefined),
      source: legacy === undefined ? "default" : "legacy",
    }));
  }
  const explicit = source === "authored"
    ? parseAuthoredVerificationPolicy(raw.verification_policy, `${path}.verification_policy`)
    : parseVerificationPolicy(raw.verification_policy, `${path}.verification_policy`);
  if (!explicit.ok) return explicit;
  if (legacy !== undefined && !verificationPolicyMatchesLegacy(explicit.value, legacy as boolean)) {
    return failure([
      `${path}.verification_policy conflicts with ${path}.new_tests_required`,
    ]);
  }
  return success(Object.freeze({ policy: explicit.value, source: "explicit" }));
}

/** Trusted in-memory projection after the TaskGraph load boundary proved compatibility. */
export function taskVerificationPolicy(source: TaskVerificationPolicySource): VerificationPolicy {
  if (source.verification_policy !== undefined) {
    const parsed = parseVerificationPolicy(source.verification_policy);
    if (!parsed.ok) {
      throw new Error(`trusted Task carries malformed verification_policy: ${parsed.errors.join("; ")}`);
    }
    return parsed.value;
  }
  return verificationPolicyFromLegacy(
    typeof source.new_tests_required === "boolean" ? source.new_tests_required : undefined,
  );
}

/** Stable persisted shape; field spelling follows TaskGraph snake_case. */
export function serializeVerificationPolicy(policy: VerificationPolicy): StoredVerificationPolicy {
  return Object.freeze({
    regression: Object.freeze({ ...policy.regression }),
    new_tests: Object.freeze({ ...policy.newTests }),
  });
}
