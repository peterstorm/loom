import {
  parseVerificationPolicy,
  requiresNewTests,
  requiresRegression,
  verificationPolicyFromLegacy,
  type VerificationPolicy,
} from "./verification-policy";

/** Pure result used by every parser in this module. */
export type ProofParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

const ok = <T>(value: T): ProofParseResult<T> => ({ ok: true, value });
const fail = <T>(errors: readonly string[]): ProofParseResult<T> => ({ ok: false, errors: [...errors] });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type NonEmpty<T> = readonly [T, ...T[]];

const nonEmpty = <T>(head: T, tail: readonly T[]): NonEmpty<T> => {
  const values: [T, ...T[]] = [head, ...tail];
  return Object.freeze(values);
};

const mapNonEmpty = <A, B>(values: NonEmpty<A>, f: (value: A, index: number) => B): NonEmpty<B> => {
  const [head, ...tail] = values;
  return nonEmpty(f(head, 0), tail.map((value, index) => f(value, index + 1)));
};

/** The engine-authored requirements for one implementation task. */
export type ProofObligation =
  | Readonly<{ kind: "task-completed" }>
  | Readonly<{ kind: "regression-test-pass" }>
  | Readonly<{ kind: "new-tests" }>
  | Readonly<{ kind: "declared-artifact-changed"; artifact: string }>;

/** Small decomposition-owned input from which obligations are deterministically derived. */
export type ProofObligationInput =
  | Readonly<{
      verificationPolicy: VerificationPolicy;
      newTestsRequired?: never;
      declaredArtifacts: readonly string[];
    }>
  | Readonly<{
      verificationPolicy?: never;
      /** Compatibility input for callers not yet holding a Task policy. */
      newTestsRequired: boolean;
      declaredArtifacts: readonly string[];
    }>;

/**
 * Where an untrusted regression verdict came from.
 *
 * `pi-structured` is the ONE provenance the Pi structured-evidence policy may
 * upgrade into a satisfied obligation, and it is a field rather than a
 * convention on `label` because `label` is free operator-facing text: a
 * `pi-structured:` prefix on it was a trust decision any producer could obtain
 * by spelling a string, and no reader could tell a real structured verdict from
 * a transcript-regex one that happened to be labelled that way. Everything else
 * is `unverified`, which is also what an older record with no provenance reads
 * as — absent evidence never upgrades.
 */
export type UntrustedTestProvenance = "pi-structured" | "unverified";

export type ProofTestResult =
  | { readonly verdict: "trusted-pass" }
  | { readonly verdict: "trusted-fail" }
  | {
      readonly verdict: "untrusted";
      readonly passed: boolean;
      readonly label: string;
      readonly provenance: UntrustedTestProvenance;
    };

/** Observations collected by the imperative shell and consumed by this pure core. */
export interface ObservedProofEvidence {
  readonly taskCompleted: boolean;
  readonly testResult?: ProofTestResult;
  readonly filesModified: readonly string[];
  readonly newTestsWritten?: boolean;
  readonly newTestEvidence?: string;
}

/**
 * The default admits only ledger-trusted regression passes. Pi may explicitly
 * select the structured-evidence policy at its boundary. That policy does not
 * relabel the source as ledger evidence: the resulting ProofEvidence retains
 * `provenance: "pi-structured"` and the original untrusted label.
 */
export type ProofEvaluationPolicy = Readonly<{
  untrustedPass: "reject" | "accept-pi-structured";
}>;

export const TRUSTED_LEDGER_ONLY_POLICY: ProofEvaluationPolicy = Object.freeze({
  untrustedPass: "reject",
});
export const PI_STRUCTURED_EVIDENCE_POLICY: ProofEvaluationPolicy = Object.freeze({
  untrustedPass: "accept-pi-structured",
});

/** Expected insufficiencies are values, never exceptions. */
export type ProofFailure =
  | Readonly<{ kind: "task-not-completed" }>
  | Readonly<{ kind: "test-result-missing" }>
  | Readonly<{ kind: "regression-tests-failed"; provenance: "ledger" }>
  | Readonly<{ kind: "untrusted-regression-tests-failed"; label: string }>
  | Readonly<{ kind: "untrusted-regression-pass"; label: string }>
  | Readonly<{ kind: "new-tests-not-observed" }>
  | Readonly<{ kind: "declared-artifact-not-changed"; artifact: string }>;

/** Evidence remains explicit about where a pass came from. */
export type ProofEvidence =
  | Readonly<{ kind: "task-completed" }>
  | Readonly<{
      kind: "regression-test-pass";
      provenance: "evidence-ledger";
      verdict: "trusted-pass";
    }>
  | Readonly<{
      kind: "regression-test-pass";
      provenance: "pi-structured";
      verdict: "untrusted-pass";
      label: string;
    }>
  | Readonly<{ kind: "new-tests"; detail: string | null }>
  | Readonly<{ kind: "declared-artifact-changed"; artifact: string }>;

export type PendingProofResult = Readonly<{
  state: "pending";
  obligation: ProofObligation;
}>;

export type EvaluatedProofResult =
  | Readonly<{
      state: "failed";
      obligation: ProofObligation;
      failure: ProofFailure;
    }>
  | Readonly<{
      state: "satisfied";
      obligation: ProofObligation;
      evidence: ProofEvidence;
    }>;

export type ProofObligationResult = PendingProofResult | EvaluatedProofResult;

/**
 * Immutable proof aggregate. `results` is deliberately present on every arm:
 * each obligation has exactly one result, in obligation order. Parsers re-prove
 * that correspondence whenever the aggregate comes back from unknown JSON.
 */
export type TaskProof =
  | Readonly<{
      state: "pending";
      obligations: NonEmpty<ProofObligation>;
      results: NonEmpty<PendingProofResult>;
    }>
  | Readonly<{
      state: "failed";
      obligations: NonEmpty<ProofObligation>;
      results: NonEmpty<EvaluatedProofResult>;
      failures: NonEmpty<ProofFailure>;
    }>
  | Readonly<{
      state: "satisfied";
      obligations: NonEmpty<ProofObligation>;
      results: NonEmpty<Extract<EvaluatedProofResult, { state: "satisfied" }>>;
      evidence: NonEmpty<ProofEvidence>;
    }>;

export type PendingTaskProof = Extract<TaskProof, { state: "pending" }>;
export type FailedTaskProof = Extract<TaskProof, { state: "failed" }>;
export type SatisfiedTaskProof = Extract<TaskProof, { state: "satisfied" }>;

const obligationKey = (obligation: ProofObligation): string =>
  obligation.kind === "declared-artifact-changed"
    ? `${obligation.kind}:${obligation.artifact}`
    : obligation.kind;

const freezeObligation = (obligation: ProofObligation): ProofObligation => Object.freeze({ ...obligation });
const normalizedPaths = (paths: readonly string[]): readonly string[] =>
  Object.freeze([...new Set(paths.map((path) => path.trim()).filter(Boolean))]);

/**
 * Completion is always observed. Verification Policy derives regression and
 * new-test obligations independently; either requirement may be explicitly waived.
 */
export function deriveProofObligations(input: ProofObligationInput): NonEmpty<ProofObligation> {
  const artifacts = normalizedPaths(input.declaredArtifacts);
  const policy = input.verificationPolicy ?? verificationPolicyFromLegacy(input.newTestsRequired);
  const tail: ProofObligation[] = [
    ...(requiresRegression(policy)
      ? [Object.freeze({ kind: "regression-test-pass" as const })]
      : []),
    ...(requiresNewTests(policy)
      ? [Object.freeze({ kind: "new-tests" as const })]
      : []),
    ...artifacts.map((artifact) => Object.freeze({ kind: "declared-artifact-changed" as const, artifact })),
  ];
  return nonEmpty(Object.freeze({ kind: "task-completed" }), tail);
}

/** Derive the initial aggregate; no observation has been interpreted yet. */
export function derivePendingTaskProof(input: ProofObligationInput): PendingTaskProof {
  const obligations = deriveProofObligations(input);
  const results = mapNonEmpty(obligations, (obligation): PendingProofResult =>
    Object.freeze({ state: "pending", obligation }),
  );
  return Object.freeze({ state: "pending", obligations, results });
}

const evaluateRegression = (
  obligation: Extract<ProofObligation, { kind: "regression-test-pass" }>,
  result: ProofTestResult | undefined,
  policy: ProofEvaluationPolicy,
): EvaluatedProofResult => {
  if (result === undefined) {
    return Object.freeze({
      state: "failed",
      obligation,
      failure: Object.freeze({ kind: "test-result-missing" }),
    });
  }
  if (result.verdict === "trusted-pass") {
    return Object.freeze({
      state: "satisfied",
      obligation,
      evidence: Object.freeze({
        kind: "regression-test-pass",
        provenance: "evidence-ledger",
        verdict: "trusted-pass",
      }),
    });
  }
  if (result.verdict === "trusted-fail") {
    return Object.freeze({
      state: "failed",
      obligation,
      failure: Object.freeze({ kind: "regression-tests-failed", provenance: "ledger" }),
    });
  }
  if (!result.passed) {
    return Object.freeze({
      state: "failed",
      obligation,
      failure: Object.freeze({ kind: "untrusted-regression-tests-failed", label: result.label }),
    });
  }
  if (policy.untrustedPass === "accept-pi-structured" && result.provenance === "pi-structured") {
    return Object.freeze({
      state: "satisfied",
      obligation,
      evidence: Object.freeze({
        kind: "regression-test-pass",
        provenance: "pi-structured",
        verdict: "untrusted-pass",
        label: result.label,
      }),
    });
  }
  return Object.freeze({
    state: "failed",
    obligation,
    failure: Object.freeze({ kind: "untrusted-regression-pass", label: result.label }),
  });
};

const evaluateOne = (
  obligation: ProofObligation,
  observed: ObservedProofEvidence,
  policy: ProofEvaluationPolicy,
): EvaluatedProofResult => {
  switch (obligation.kind) {
    case "task-completed":
      return observed.taskCompleted
        ? Object.freeze({
            state: "satisfied",
            obligation,
            evidence: Object.freeze({ kind: "task-completed" }),
          })
        : Object.freeze({
            state: "failed",
            obligation,
            failure: Object.freeze({ kind: "task-not-completed" }),
          });
    case "regression-test-pass":
      return evaluateRegression(obligation, observed.testResult, policy);
    case "new-tests":
      return observed.newTestsWritten === true
        ? Object.freeze({
            state: "satisfied",
            obligation,
            evidence: Object.freeze({
              kind: "new-tests",
              detail: observed.newTestEvidence?.trim() || null,
            }),
          })
        : Object.freeze({
            state: "failed",
            obligation,
            failure: Object.freeze({ kind: "new-tests-not-observed" }),
          });
    case "declared-artifact-changed":
      return observed.filesModified.includes(obligation.artifact)
        ? Object.freeze({
            state: "satisfied",
            obligation,
            evidence: Object.freeze({ kind: "declared-artifact-changed", artifact: obligation.artifact }),
          })
        : Object.freeze({
            state: "failed",
            obligation,
            failure: Object.freeze({ kind: "declared-artifact-not-changed", artifact: obligation.artifact }),
          });
  }
};

type SatisfiedProofResult = Extract<EvaluatedProofResult, { state: "satisfied" }>;

type ResultStatePredicate<T extends ProofObligationResult> =
  (result: ProofObligationResult) => result is T;

function requireResultState<T extends ProofObligationResult>(
  results: NonEmpty<ProofObligationResult>,
  predicate: ResultStatePredicate<T>,
  invariantMessage: string,
): NonEmpty<T> {
  const [head, ...tail] = results;
  if (!predicate(head) || !tail.every(predicate)) throw new Error(invariantMessage);
  return nonEmpty(head, tail);
}

const isPendingResult = (result: ProofObligationResult): result is PendingProofResult =>
  result.state === "pending";
const isEvaluatedResult = (result: ProofObligationResult): result is EvaluatedProofResult =>
  result.state !== "pending";
const isSatisfiedResult = (result: ProofObligationResult): result is SatisfiedProofResult =>
  result.state === "satisfied";

function requireSatisfiedResults(results: NonEmpty<EvaluatedProofResult>): NonEmpty<SatisfiedProofResult> {
  return requireResultState(
    results,
    isSatisfiedResult,
    "proof evaluation invariant: failure-free result set contains a non-satisfied result",
  );
}

/**
 * Evaluate every obligation exactly once. A failed aggregate still retains the
 * satisfied results, so no result is lost merely because a sibling failed.
 */
export function evaluateProofObligations(
  obligations: NonEmpty<ProofObligation>,
  observed: ObservedProofEvidence,
  policy: ProofEvaluationPolicy = TRUSTED_LEDGER_ONLY_POLICY,
): FailedTaskProof | SatisfiedTaskProof {
  // Do not retain caller-owned object/array aliases in the proof aggregate.
  const authoredObligations = mapNonEmpty(obligations, freezeObligation);
  const normalizedObserved: ObservedProofEvidence = {
    ...observed,
    filesModified: normalizedPaths(observed.filesModified),
  };
  const results = mapNonEmpty(
    authoredObligations,
    (obligation) => evaluateOne(obligation, normalizedObserved, policy),
  );
  const failures = results.flatMap((result) => result.state === "failed" ? [result.failure] : []);
  if (failures.length > 0) {
    const [head, ...tail] = failures;
    return Object.freeze({
      state: "failed",
      obligations: authoredObligations,
      results,
      failures: nonEmpty(head, tail),
    });
  }

  const satisfiedResults = requireSatisfiedResults(results);
  return Object.freeze({
    state: "satisfied",
    obligations: authoredObligations,
    results: satisfiedResults,
    evidence: mapNonEmpty(satisfiedResults, (result) => result.evidence),
  });
}

/** Convenience composition for callers that have decomposition input rather than a stored proof. */
export function evaluateTaskProof(
  input: ProofObligationInput,
  observed: ObservedProofEvidence,
  policy: ProofEvaluationPolicy = TRUSTED_LEDGER_ONLY_POLICY,
): FailedTaskProof | SatisfiedTaskProof {
  return evaluateProofObligations(deriveProofObligations(input), observed, policy);
}

/** Re-evaluation depends only on the authored obligations, not the prior state. */
export function reevaluateTaskProof(
  proof: TaskProof,
  observed: ObservedProofEvidence,
  policy: ProofEvaluationPolicy = TRUSTED_LEDGER_ONLY_POLICY,
): FailedTaskProof | SatisfiedTaskProof {
  return evaluateProofObligations(proof.obligations, observed, policy);
}

export type ImplementationReadiness =
  | Readonly<{ state: "implementation-ready"; proof: SatisfiedTaskProof }>
  | Readonly<{ state: "blocked"; proof: PendingTaskProof | FailedTaskProof }>;

export function implementationReadiness(proof: TaskProof): ImplementationReadiness {
  return proof.state === "satisfied"
    ? Object.freeze({ state: "implementation-ready", proof })
    : Object.freeze({ state: "blocked", proof });
}

export function isImplementationReady(proof: TaskProof): proof is SatisfiedTaskProof {
  return proof.state === "satisfied";
}

// ---------------------------------------------------------------------------
// Unknown-input parsers
// ---------------------------------------------------------------------------

const parseNonEmptyString = (raw: unknown, path: string): ProofParseResult<string> =>
  typeof raw === "string" && raw.trim().length > 0
    ? ok(raw.trim())
    : fail([`${path} must be a non-empty string`]);

export function parseProofObligation(raw: unknown, path = "obligation"): ProofParseResult<ProofObligation> {
  if (!isRecord(raw)) return fail([`${path} must be an object`]);
  if (raw.kind === "task-completed") return ok(Object.freeze({ kind: "task-completed" }));
  if (raw.kind === "regression-test-pass") return ok(Object.freeze({ kind: "regression-test-pass" }));
  if (raw.kind === "new-tests") return ok(Object.freeze({ kind: "new-tests" }));
  if (raw.kind === "declared-artifact-changed") {
    const artifact = parseNonEmptyString(raw.artifact, `${path}.artifact`);
    return artifact.ok
      ? ok(Object.freeze({ kind: "declared-artifact-changed", artifact: artifact.value }))
      : artifact;
  }
  return fail([`${path}.kind must be task-completed, regression-test-pass, new-tests, or declared-artifact-changed`]);
}

export function parseProofObligationInput(raw: unknown): ProofParseResult<ProofObligationInput> {
  if (!isRecord(raw)) return fail(["proof obligation input must be an object"]);
  const errors: string[] = [];
  const hasLegacy = raw.newTestsRequired !== undefined;
  if (hasLegacy && typeof raw.newTestsRequired !== "boolean") {
    errors.push("newTestsRequired must be a boolean when present");
  }
  const explicit = raw.verificationPolicy === undefined
    ? undefined
    : parseVerificationPolicy(raw.verificationPolicy, "verificationPolicy");
  if (explicit !== undefined && !explicit.ok) errors.push(...explicit.errors);
  if (!hasLegacy && explicit === undefined) {
    errors.push("verificationPolicy or newTestsRequired must be present");
  }
  if (explicit !== undefined && hasLegacy) {
    errors.push("verificationPolicy and newTestsRequired are mutually exclusive");
  }
  if (!Array.isArray(raw.declaredArtifacts)) errors.push("declaredArtifacts must be an array");

  const artifacts: string[] = [];
  if (Array.isArray(raw.declaredArtifacts)) {
    raw.declaredArtifacts.forEach((value, index) => {
      const parsed = parseNonEmptyString(value, `declaredArtifacts[${index}]`);
      if (parsed.ok) artifacts.push(parsed.value);
      else errors.push(...parsed.errors);
    });
    if (new Set(artifacts).size !== artifacts.length) errors.push("declaredArtifacts must be unique");
  }
  if (errors.length > 0) return fail(errors);
  const declaredArtifacts = Object.freeze([...artifacts]);
  return explicit?.ok
    ? ok(Object.freeze({ verificationPolicy: explicit.value, declaredArtifacts }))
    : ok(Object.freeze({ newTestsRequired: raw.newTestsRequired === true, declaredArtifacts }));
}

function parseUntrustedTestProvenance(
  raw: unknown,
  path: string,
): ProofParseResult<UntrustedTestProvenance> {
  if (raw === undefined || raw === "unverified") return ok("unverified");
  if (raw === "pi-structured") return ok("pi-structured");
  return fail([`${path}.provenance must be pi-structured or unverified`]);
}

export function parseTaskTestResult(raw: unknown, path = "testResult"): ProofParseResult<ProofTestResult> {
  if (!isRecord(raw)) return fail([`${path} must be an object`]);
  if (raw.verdict === "trusted-pass") return ok(Object.freeze({ verdict: "trusted-pass" }));
  if (raw.verdict === "trusted-fail") return ok(Object.freeze({ verdict: "trusted-fail" }));
  if (raw.verdict === "untrusted") {
    const passed = typeof raw.passed === "boolean"
      ? ok(raw.passed)
      : fail<boolean>([`${path}.passed must be a boolean`]);
    const label = parseNonEmptyString(raw.label, `${path}.label`);
    // Absent provenance reads as `unverified`, never as structured evidence:
    // records written before the field existed must not acquire a trust
    // upgrade by omission. An unrecognized value is a refusal, not a default.
    const provenance = parseUntrustedTestProvenance(raw.provenance, path);
    const errors = [passed, label, provenance]
      .flatMap((parsed) => parsed.ok ? [] : parsed.errors);
    if (!passed.ok || !label.ok || !provenance.ok) return fail(errors);
    return ok(Object.freeze({
      verdict: "untrusted",
      passed: passed.value,
      label: label.value,
      provenance: provenance.value,
    }));
  }
  return fail([`${path}.verdict must be trusted-pass, trusted-fail, or untrusted`]);
}

export function parseObservedProofEvidence(raw: unknown): ProofParseResult<ObservedProofEvidence> {
  if (!isRecord(raw)) return fail(["observed proof evidence must be an object"]);
  const errors: string[] = [];
  let testResult: ProofTestResult | undefined;
  if (raw.testResult !== undefined) {
    const parsed = parseTaskTestResult(raw.testResult);
    if (parsed.ok) testResult = parsed.value;
    else errors.push(...parsed.errors);
  }

  if (typeof raw.taskCompleted !== "boolean") errors.push("taskCompleted must be a boolean");
  const files: string[] = [];
  if (raw.filesModified !== undefined && !Array.isArray(raw.filesModified)) {
    errors.push("filesModified must be an array when present");
  } else if (Array.isArray(raw.filesModified)) {
    raw.filesModified.forEach((value, index) => {
      const parsed = parseNonEmptyString(value, `filesModified[${index}]`);
      if (parsed.ok) files.push(parsed.value);
      else errors.push(...parsed.errors);
    });
  }
  if (raw.newTestsWritten !== undefined && typeof raw.newTestsWritten !== "boolean") {
    errors.push("newTestsWritten must be a boolean when present");
  }
  if (raw.newTestEvidence !== undefined && typeof raw.newTestEvidence !== "string") {
    errors.push("newTestEvidence must be a string when present");
  }

  if (errors.length > 0) return fail(errors);
  return ok(Object.freeze({
    taskCompleted: raw.taskCompleted === true,
    ...(testResult === undefined ? {} : { testResult }),
    filesModified: Object.freeze([...new Set(files)]),
    ...(typeof raw.newTestsWritten === "boolean" ? { newTestsWritten: raw.newTestsWritten } : {}),
    ...(typeof raw.newTestEvidence === "string" ? { newTestEvidence: raw.newTestEvidence } : {}),
  }));
}

export function parseProofEvaluationPolicy(raw: unknown): ProofParseResult<ProofEvaluationPolicy> {
  if (!isRecord(raw)) return fail(["proof evaluation policy must be an object"]);
  return raw.untrustedPass === "reject" || raw.untrustedPass === "accept-pi-structured"
    ? ok(Object.freeze({ untrustedPass: raw.untrustedPass }))
    : fail(["proof evaluation policy.untrustedPass must be reject or accept-pi-structured"]);
}

export function parseProofFailure(raw: unknown, path = "failure"): ProofParseResult<ProofFailure> {
  if (!isRecord(raw)) return fail([`${path} must be an object`]);
  switch (raw.kind) {
    case "task-not-completed":
    case "test-result-missing":
    case "new-tests-not-observed":
      return ok(Object.freeze({ kind: raw.kind }));
    case "regression-tests-failed":
      return raw.provenance === "ledger"
        ? ok(Object.freeze({ kind: raw.kind, provenance: "ledger" }))
        : fail([`${path}.provenance must be ledger`]);
    case "untrusted-regression-tests-failed":
    case "untrusted-regression-pass": {
      const label = parseNonEmptyString(raw.label, `${path}.label`);
      return label.ok ? ok(Object.freeze({ kind: raw.kind, label: label.value })) : label;
    }
    case "declared-artifact-not-changed": {
      const artifact = parseNonEmptyString(raw.artifact, `${path}.artifact`);
      return artifact.ok ? ok(Object.freeze({ kind: raw.kind, artifact: artifact.value })) : artifact;
    }
    default:
      return fail([`${path}.kind is not a recognized proof failure`]);
  }
}

export function parseProofEvidence(raw: unknown, path = "evidence"): ProofParseResult<ProofEvidence> {
  if (!isRecord(raw)) return fail([`${path} must be an object`]);
  if (raw.kind === "task-completed") return ok(Object.freeze({ kind: "task-completed" }));
  if (raw.kind === "regression-test-pass") {
    if (raw.provenance === "evidence-ledger" && raw.verdict === "trusted-pass") {
      return ok(Object.freeze({ kind: raw.kind, provenance: raw.provenance, verdict: raw.verdict }));
    }
    if (raw.provenance === "pi-structured" && raw.verdict === "untrusted-pass") {
      const label = parseNonEmptyString(raw.label, `${path}.label`);
      return label.ok
        ? ok(Object.freeze({ kind: raw.kind, provenance: raw.provenance, verdict: raw.verdict, label: label.value }))
        : label;
    }
    return fail([`${path} has an invalid regression evidence provenance/verdict combination`]);
  }
  if (raw.kind === "new-tests") {
    if (raw.detail !== null && typeof raw.detail !== "string") {
      return fail([`${path}.detail must be a string or null`]);
    }
    return ok(Object.freeze({ kind: "new-tests", detail: raw.detail === null ? null : raw.detail }));
  }
  if (raw.kind === "declared-artifact-changed") {
    const artifact = parseNonEmptyString(raw.artifact, `${path}.artifact`);
    return artifact.ok ? ok(Object.freeze({ kind: raw.kind, artifact: artifact.value })) : artifact;
  }
  return fail([`${path}.kind is not recognized proof evidence`]);
}

const resultMatchesObligation = (result: ProofObligationResult): boolean => {
  if (result.state === "failed") {
    switch (result.obligation.kind) {
      case "task-completed":
        return result.failure.kind === "task-not-completed";
      case "regression-test-pass":
        return [
          "test-result-missing",
          "regression-tests-failed",
          "untrusted-regression-tests-failed",
          "untrusted-regression-pass",
        ].includes(result.failure.kind);
      case "new-tests":
        return result.failure.kind === "new-tests-not-observed";
      case "declared-artifact-changed":
        return result.failure.kind === "declared-artifact-not-changed"
          && result.failure.artifact === result.obligation.artifact;
    }
  }
  if (result.state === "satisfied") {
    if (result.obligation.kind !== result.evidence.kind) return false;
    return result.obligation.kind !== "declared-artifact-changed"
      || (result.evidence.kind === "declared-artifact-changed"
        && result.obligation.artifact === result.evidence.artifact);
  }
  // `pending` — no evidence and no failure to disagree with the obligation, so
  // the pair matches vacuously. Named explicitly: as a bare trailing `return
  // true` this also caught any `failed` result whose obligation kind the switch
  // above did not cover, ACCEPTING it. A new obligation kind would have been
  // admitted with an unrelated failure attached rather than refused.
  return result.state === "pending";
};

export function parseProofObligationResult(
  raw: unknown,
  path = "result",
): ProofParseResult<ProofObligationResult> {
  if (!isRecord(raw)) return fail([`${path} must be an object`]);
  const obligation = parseProofObligation(raw.obligation, `${path}.obligation`);
  if (!obligation.ok) return obligation;

  let result: ProofObligationResult;
  if (raw.state === "pending") {
    result = Object.freeze({ state: "pending", obligation: obligation.value });
  } else if (raw.state === "failed") {
    const failure = parseProofFailure(raw.failure, `${path}.failure`);
    if (!failure.ok) return failure;
    result = Object.freeze({ state: "failed", obligation: obligation.value, failure: failure.value });
  } else if (raw.state === "satisfied") {
    const evidence = parseProofEvidence(raw.evidence, `${path}.evidence`);
    if (!evidence.ok) return evidence;
    result = Object.freeze({ state: "satisfied", obligation: obligation.value, evidence: evidence.value });
  } else {
    return fail([`${path}.state must be pending, failed, or satisfied`]);
  }
  return resultMatchesObligation(result)
    ? ok(result)
    : fail([`${path} payload does not satisfy its obligation kind`]);
}

const parseNonEmptyArray = <T>(
  raw: unknown,
  path: string,
  parser: (value: unknown, path: string) => ProofParseResult<T>,
): ProofParseResult<NonEmpty<T>> => {
  if (!Array.isArray(raw) || raw.length === 0) return fail([`${path} must be a non-empty array`]);
  const values: T[] = [];
  const errors: string[] = [];
  raw.forEach((value, index) => {
    const parsed = parser(value, `${path}[${index}]`);
    if (parsed.ok) values.push(parsed.value);
    else errors.push(...parsed.errors);
  });
  if (errors.length > 0) return fail(errors);
  const [head, ...tail] = values;
  return head === undefined ? fail([`${path} must be a non-empty array`]) : ok(nonEmpty(head, tail));
};

const sameValue = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

type ParsedProofParts = {
  readonly obligations: NonEmpty<ProofObligation>;
  readonly results: NonEmpty<ProofObligationResult>;
};

function parseProofParts(raw: Record<string, unknown>): ProofParseResult<ParsedProofParts> {
  const obligations = parseNonEmptyArray(raw.obligations, "proof.obligations", parseProofObligation);
  const results = parseNonEmptyArray(raw.results, "proof.results", parseProofObligationResult);
  const errors = [...(obligations.ok ? [] : obligations.errors), ...(results.ok ? [] : results.errors)];
  if (errors.length > 0 || !obligations.ok || !results.ok) return fail(errors);
  const keys = obligations.value.map(obligationKey);
  if (new Set(keys).size !== keys.length) errors.push("proof obligations must be unique");
  if (results.value.length !== obligations.value.length) errors.push("proof must contain exactly one result per obligation");
  else results.value.forEach((result, index) => {
    if (obligationKey(result.obligation) !== keys[index]) {
      errors.push(`proof.results[${index}] must correspond to proof.obligations[${index}]`);
    }
  });
  return errors.length > 0
    ? fail(errors)
    : ok({ obligations: obligations.value, results: results.value });
}

function parsePendingProof(parts: ParsedProofParts): ProofParseResult<PendingTaskProof> {
  const errors: string[] = [];
  if (parts.results.some((result) => result.state !== "pending")) errors.push("pending proof may contain only pending results");
  if (errors.length > 0) return fail(errors);
  return ok(Object.freeze({
    state: "pending",
    obligations: parts.obligations,
    results: requireResultState(
      parts.results,
      isPendingResult,
      "proof parser invariant: validated pending proof contains an evaluated result",
    ),
  }));
}

function evaluatedResults(parts: ParsedProofParts): ProofParseResult<NonEmpty<EvaluatedProofResult>> {
  const errors: string[] = [];
  if (parts.results.some((result) => result.state === "pending")) errors.push("evaluated proof may not contain pending results");
  return errors.length > 0
    ? fail(errors)
    : ok(requireResultState(
        parts.results,
        isEvaluatedResult,
        "proof parser invariant: validated evaluated proof contains a pending result",
      ));
}

function parseFailedProof(raw: Record<string, unknown>, parts: ParsedProofParts): ProofParseResult<FailedTaskProof> {
  const evaluated = evaluatedResults(parts);
  const errors = evaluated.ok ? [] : [...evaluated.errors];
  const failures = parseNonEmptyArray(raw.failures, "proof.failures", parseProofFailure);
  if (!failures.ok) errors.push(...failures.errors);
  const derived = evaluated.ok
    ? evaluated.value.flatMap((result) => result.state === "failed" ? [result.failure] : [])
    : [];
  if (evaluated.ok && derived.length === 0) errors.push("failed proof must contain at least one failed result");
  if (evaluated.ok && failures.ok && !sameValue(failures.value, derived)) {
    errors.push("proof.failures must equal the failures derived from proof.results");
  }
  return errors.length > 0 || !failures.ok || !evaluated.ok ? fail(errors) : ok(Object.freeze({
    state: "failed", obligations: parts.obligations, results: evaluated.value, failures: failures.value,
  }));
}

function parseSatisfiedProof(raw: Record<string, unknown>, parts: ParsedProofParts): ProofParseResult<SatisfiedTaskProof> {
  const evaluated = evaluatedResults(parts);
  const errors = evaluated.ok ? [] : [...evaluated.errors];
  const evidence = parseNonEmptyArray(raw.evidence, "proof.evidence", parseProofEvidence);
  if (!evidence.ok) errors.push(...evidence.errors);
  if (evaluated.ok && evaluated.value.some((result) => result.state !== "satisfied")) {
    errors.push("satisfied proof may contain only satisfied results");
  }
  const derived = evaluated.ok
    ? evaluated.value.flatMap((result) => result.state === "satisfied" ? [result.evidence] : [])
    : [];
  if (evaluated.ok && evidence.ok && !sameValue(evidence.value, derived)) {
    errors.push("proof.evidence must equal the evidence derived from proof.results");
  }
  if (errors.length > 0 || !evidence.ok || !evaluated.ok) return fail(errors);
  const satisfiedResults = requireSatisfiedResults(evaluated.value);
  return ok(Object.freeze({
    state: "satisfied", obligations: parts.obligations,
    results: satisfiedResults,
    evidence: evidence.value,
  }));
}

/** Parse and re-prove exact obligation/result coverage and state lockstep. */
export function parseTaskProof(raw: unknown): ProofParseResult<TaskProof> {
  if (!isRecord(raw)) return fail(["task proof must be an object"]);
  const parts = parseProofParts(raw);
  if (!parts.ok) return parts;
  if (raw.state === "pending") return parsePendingProof(parts.value);
  if (raw.state === "failed") return parseFailedProof(raw, parts.value);
  if (raw.state === "satisfied") return parseSatisfiedProof(raw, parts.value);
  return fail(["proof.state must be pending, failed, or satisfied"]);
}

