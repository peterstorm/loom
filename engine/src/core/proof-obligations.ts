import { canonicalStructuralEquals } from "./orchestration-contract";
import type { RedThenGreenGap, RedThenGreenObservation, RunRef } from "./red-then-green-types";
import type { FrozenTestFiles } from "./test-file-classification";
import type { FrozenVerificationManifest } from "./verification-manifest";
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

function parseExactRecordArm<T>(
  raw: Record<string, unknown>,
  path: string,
  allowedKeys: readonly string[],
  parse: () => ProofParseResult<T>,
): ProofParseResult<T> {
  const allowed = new Set(allowedKeys);
  const surplus = Object.keys(raw).filter((key) => !allowed.has(key)).sort();
  return surplus.length === 0
    ? parse()
    : fail([`${path} contains unexpected field(s): ${surplus.join(", ")}`]);
}

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
  | Readonly<{ kind: "red-then-green" }>
  | Readonly<{ kind: "attempt-scope-attested" }>
  | Readonly<{ kind: "declared-artifact-changed"; artifact: string }>
  | Readonly<{ kind: "declared-artifact-attested"; artifact: string }>;

/**
 * A TaskGraph's I6 era, with what the era brings. `owed-if-new-tests` marks a
 * TaskGraph populated after I6 existed and carries the test-file
 * classification its manifest froze, the one the judge and the brief split a
 * Task's `file_list` by (INV-2); `not-owed` marks one populated before, which
 * is never newly obligated (FR-005). The era and its classification are one
 * value, so no reader can see an I6-era graph without a classification. Only
 * `frozenRedThenGreenEra` mints it (INV-6).
 */
export type FrozenRedThenGreenEra =
  | Readonly<{ kind: "not-owed" }>
  | Readonly<{ kind: "owed-if-new-tests"; testFiles: FrozenTestFiles }>;

/** The era alone, as obligation derivation and the State File checks take it. */
export type RedThenGreenEra = FrozenRedThenGreenEra["kind"];

const PRE_I6_ERA: FrozenRedThenGreenEra = Object.freeze({ kind: "not-owed" });

/**
 * The one I6-era test (INV-6), and the one reader of a frozen manifest's
 * `testFiles` outside `verification-manifest.ts`, which parses, freezes and
 * digests it: a TaskGraph owes I6 exactly when its frozen verification
 * manifest carries the frozen test-file classification (ADR-0025). Every
 * post-feature freeze carries it (the post-feature freezers' return type
 * requires it), so only a TaskGraph frozen before this feature, or one
 * carrying no manifest at all, reads `not-owed`. The INV-6 lint rule is the
 * backstop against a second reader. Population, the State File obligation-match check
 * and revalidation ask through `redThenGreenEra`; settlement, the
 * stored-evidence reconcile and the brief ask through `redThenGreenDuty`,
 * which defers to a Task's frozen Proof and takes the classification from
 * here, so none of them can disagree.
 */
export function frozenRedThenGreenEra(manifest: FrozenVerificationManifest | undefined): FrozenRedThenGreenEra {
  const testFiles = manifest?.testFiles;
  return testFiles === undefined ? PRE_I6_ERA : Object.freeze({ kind: "owed-if-new-tests", testFiles });
}

/** `frozenRedThenGreenEra`'s era alone. */
export function redThenGreenEra(manifest: FrozenVerificationManifest | undefined): RedThenGreenEra {
  return frozenRedThenGreenEra(manifest).kind;
}

/** Which byte comparison each declared artifact owes.
 *
 * `changed` is the default: the dispatched child itself moves the bytes.
 * `attested` inverts the comparison for a Task whose work predates the
 * attempt: the child must leave the declared bytes EXACTLY as the attempt
 * baseline captured them, and a write is a failure, not a proof.
 */
export type DeclaredArtifactExpectation = "changed" | "attested";

/**
 * Small decomposition-owned input from which obligations are deterministically
 * derived. `redThenGreen` is the TaskGraph's I6 era, from `redThenGreenEra`;
 * absent reads as `not-owed`, exactly what every caller derived before I6.
 */
export type ProofObligationInput =
  | Readonly<{
      verificationPolicy: VerificationPolicy;
      newTestsRequired?: never;
      declaredArtifacts: readonly string[];
      declaredArtifactExpectation?: DeclaredArtifactExpectation;
      redThenGreen?: RedThenGreenEra;
    }>
  | Readonly<{
      verificationPolicy?: never;
      /** Compatibility input for callers not yet holding a Task policy. */
      newTestsRequired: boolean;
      declaredArtifacts: readonly string[];
      declaredArtifactExpectation?: DeclaredArtifactExpectation;
      redThenGreen?: RedThenGreenEra;
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
  /**
   * The I6 judgment over the attempt epoch's ledger. Absent when no ledger
   * observation reached proof (the stored-evidence reconcile with nothing to
   * carry forward): a `red-then-green` obligation then fails as
   * `ledger-unavailable`.
   */
  readonly redThenGreen?: RedThenGreenObservation;
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
  | Readonly<{ kind: "red-then-green-unproven"; gap: RedThenGreenGap }>
  | Readonly<{ kind: "attempt-scope-drifted" }>
  | Readonly<{ kind: "declared-artifact-not-changed"; artifact: string }>
  | Readonly<{ kind: "declared-artifact-drifted"; artifact: string }>;

/** The base ProofFailure kinds whose minted `proof:` labels mark a retry
 *  receipt as terminal attestation drift. `satisfies` binds each entry to a
 *  real ProofFailure kind, so a rename in the union fails here instead of
 *  silently disconnecting the matchers below. */
const ATTESTATION_DRIFT_BASE_KINDS = Object.freeze([
  "attempt-scope-drifted",
  "declared-artifact-drifted",
] as const satisfies readonly ProofFailure["kind"][]);

/** The `proof:`-prefixed failure kinds implementation-completion's
 *  `proofFailureKind` mints and every attestation-drift matcher consumes.
 *  One membership list: the attestation lineage walk and the escalation
 *  message selector cannot disagree about what counts as drift. Both kinds
 *  co-occur by construction — any declared-artifact write makes the
 *  attempt-scope delta non-empty — but that invariant is now code, not
 *  folklore. */
export type AttestationDriftFailureKind = Extract<
  `proof:${ProofFailure["kind"]}`,
  `proof:${(typeof ATTESTATION_DRIFT_BASE_KINDS)[number]}`
>;

const ATTESTATION_DRIFT_FAILURE_KINDS = Object.freeze(
  ATTESTATION_DRIFT_BASE_KINDS.map((kind) => `proof:${kind}` as AttestationDriftFailureKind),
) as readonly [AttestationDriftFailureKind, ...AttestationDriftFailureKind[]];

export const isAttestationDriftFailureKind = (kind: string): kind is AttestationDriftFailureKind =>
  (ATTESTATION_DRIFT_FAILURE_KINDS as readonly string[]).includes(kind);

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
  | Readonly<{ kind: "red-then-green"; red: RunRef; implementationWrite: string; green: RunRef }>
  | Readonly<{ kind: "attempt-scope-attested" }>
  | Readonly<{ kind: "declared-artifact-changed"; artifact: string }>
  | Readonly<{ kind: "declared-artifact-attested"; artifact: string }>;

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
  obligation.kind === "declared-artifact-changed" || obligation.kind === "declared-artifact-attested"
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
  const expectation = input.declaredArtifactExpectation ?? "changed";
  const tail: ProofObligation[] = [
    ...(requiresRegression(policy)
      ? [Object.freeze({ kind: "regression-test-pass" as const })]
      : []),
    ...(requiresNewTests(policy)
      ? [Object.freeze({ kind: "new-tests" as const })]
      : []),
    ...(requiresNewTests(policy) && input.redThenGreen === "owed-if-new-tests"
      ? [Object.freeze({ kind: "red-then-green" as const })]
      : []),
    ...(expectation === "attested"
      ? [Object.freeze({ kind: "attempt-scope-attested" as const })]
      : []),
    ...artifacts.map((artifact) => Object.freeze(expectation === "attested"
      ? { kind: "declared-artifact-attested" as const, artifact }
      : { kind: "declared-artifact-changed" as const, artifact })),
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

const LEDGER_UNAVAILABLE: RedThenGreenObservation = Object.freeze({
  kind: "unproven",
  gap: Object.freeze({ kind: "ledger-unavailable" }),
});

const evaluateRedThenGreen = (
  obligation: Extract<ProofObligation, { kind: "red-then-green" }>,
  observation: RedThenGreenObservation = LEDGER_UNAVAILABLE,
): EvaluatedProofResult =>
  observation.kind === "shown"
    ? Object.freeze({
        state: "satisfied",
        obligation,
        evidence: Object.freeze({
          kind: "red-then-green",
          red: observation.red,
          implementationWrite: observation.implementationWrite,
          green: observation.green,
        }),
      })
    : Object.freeze({
        state: "failed",
        obligation,
        failure: Object.freeze({ kind: "red-then-green-unproven", gap: observation.gap }),
      });

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
    case "red-then-green":
      return evaluateRedThenGreen(obligation, observed.redThenGreen);
    case "attempt-scope-attested":
      return observed.filesModified.length === 0
        ? Object.freeze({
            state: "satisfied",
            obligation,
            evidence: Object.freeze({ kind: "attempt-scope-attested" }),
          })
        : Object.freeze({
            state: "failed",
            obligation,
            failure: Object.freeze({ kind: "attempt-scope-drifted" }),
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
    case "declared-artifact-attested":
      // The attested arm reads the same write observation as the changed arm,
      // inverted: a verify-only child leaves the declared bytes untouched, so
      // the artifact's absence from the changed set is the satisfaction. A
      // write during an attestation attempt is drift, never evidence.
      return observed.filesModified.includes(obligation.artifact)
        ? Object.freeze({
            state: "failed",
            obligation,
            failure: Object.freeze({ kind: "declared-artifact-drifted", artifact: obligation.artifact }),
          })
        : Object.freeze({
            state: "satisfied",
            obligation,
            evidence: Object.freeze({ kind: "declared-artifact-attested", artifact: obligation.artifact }),
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

// ---------------------------------------------------------------------------
// Unknown-input parsers
// ---------------------------------------------------------------------------

const parseNonEmptyString = (raw: unknown, path: string): ProofParseResult<string> =>
  typeof raw === "string" && raw.trim().length > 0
    ? ok(raw.trim())
    : fail([`${path} must be a non-empty string`]);

export function parseProofObligation(raw: unknown, path = "obligation"): ProofParseResult<ProofObligation> {
  if (!isRecord(raw)) return fail([`${path} must be an object`]);
  if (raw.kind === "task-completed" || raw.kind === "regression-test-pass" || raw.kind === "new-tests" ||
      raw.kind === "red-then-green" || raw.kind === "attempt-scope-attested") {
    const kind = raw.kind;
    return parseExactRecordArm<ProofObligation>(raw, path, ["kind"], () =>
      ok(Object.freeze({ kind })));
  }
  if (raw.kind === "declared-artifact-changed" || raw.kind === "declared-artifact-attested") {
    const kind = raw.kind;
    return parseExactRecordArm<ProofObligation>(raw, path, ["kind", "artifact"], () => {
      const artifact = parseNonEmptyString(raw.artifact, `${path}.artifact`);
      return artifact.ok ? ok(Object.freeze({ kind, artifact: artifact.value })) : artifact;
    });
  }
  return fail([`${path}.kind must be task-completed, regression-test-pass, new-tests, red-then-green, attempt-scope-attested, declared-artifact-changed, or declared-artifact-attested`]);
}

type VerificationPolicySelection = Readonly<{
  explicit: ReturnType<typeof parseVerificationPolicy> | undefined;
  errors: readonly string[];
}>;

/** Exactly one of the explicit policy and the legacy `newTestsRequired` flag must be present. */
function selectVerificationPolicy(raw: Record<string, unknown>): VerificationPolicySelection {
  const hasLegacy = raw.newTestsRequired !== undefined;
  const explicit = raw.verificationPolicy === undefined
    ? undefined
    : parseVerificationPolicy(raw.verificationPolicy, "verificationPolicy");
  const errors = [
    ...(hasLegacy && typeof raw.newTestsRequired !== "boolean" ? ["newTestsRequired must be a boolean when present"] : []),
    ...(explicit !== undefined && !explicit.ok ? explicit.errors : []),
    ...(!hasLegacy && explicit === undefined ? ["verificationPolicy or newTestsRequired must be present"] : []),
    ...(explicit !== undefined && hasLegacy ? ["verificationPolicy and newTestsRequired are mutually exclusive"] : []),
  ];
  return { explicit, errors };
}

/** Shape errors of the declared-artifact and era fields, before their elements are read. */
function proofInputShapeErrors(raw: Record<string, unknown>): readonly string[] {
  return [
    ...(Array.isArray(raw.declaredArtifacts) ? [] : ["declaredArtifacts must be an array"]),
    ...(raw.declaredArtifactExpectation !== undefined &&
        raw.declaredArtifactExpectation !== "changed" && raw.declaredArtifactExpectation !== "attested"
      ? ["declaredArtifactExpectation must be changed or attested"]
      : []),
    ...(raw.redThenGreen !== undefined && raw.redThenGreen !== "owed-if-new-tests" && raw.redThenGreen !== "not-owed"
      ? ["redThenGreen must be owed-if-new-tests or not-owed"]
      : []),
  ];
}

type DeclaredArtifactList = Readonly<{ artifacts: readonly string[]; errors: readonly string[] }>;

/** Element errors in index order, then the uniqueness error; a non-array yields neither. */
function parseDeclaredArtifactList(raw: unknown): DeclaredArtifactList {
  if (!Array.isArray(raw)) return { artifacts: [], errors: [] };
  const parsed = raw.map((value, index) => parseNonEmptyString(value, `declaredArtifacts[${index}]`));
  const artifacts = parsed.flatMap((entry) => entry.ok ? [entry.value] : []);
  const errors = [
    ...parsed.flatMap((entry) => entry.ok ? [] : entry.errors),
    ...(new Set(artifacts).size !== artifacts.length ? ["declaredArtifacts must be unique"] : []),
  ];
  return { artifacts, errors };
}

/** Optional fields already proven by `proofInputShapeErrors`; absent fields stay absent. */
const optionalProofInputFields = (raw: Record<string, unknown>) => ({
  ...(raw.declaredArtifactExpectation === undefined
    ? {}
    : { declaredArtifactExpectation: raw.declaredArtifactExpectation as DeclaredArtifactExpectation }),
  ...(raw.redThenGreen === undefined ? {} : { redThenGreen: raw.redThenGreen as RedThenGreenEra }),
});

export function parseProofObligationInput(raw: unknown): ProofParseResult<ProofObligationInput> {
  if (!isRecord(raw)) return fail(["proof obligation input must be an object"]);
  const exact = parseExactRecordArm(
    raw,
    "proof obligation input",
    ["verificationPolicy", "newTestsRequired", "declaredArtifacts", "declaredArtifactExpectation", "redThenGreen"],
    () => ok(true),
  );
  if (!exact.ok) return fail(exact.errors);
  const { explicit, errors: policyErrors } = selectVerificationPolicy(raw);
  const artifactList = parseDeclaredArtifactList(raw.declaredArtifacts);
  const errors = [...policyErrors, ...proofInputShapeErrors(raw), ...artifactList.errors];
  if (errors.length > 0) return fail(errors);
  const declaredArtifacts = Object.freeze([...artifactList.artifacts]);
  const optional = optionalProofInputFields(raw);
  return explicit?.ok
    ? ok(Object.freeze({ verificationPolicy: explicit.value, declaredArtifacts, ...optional }))
    : ok(Object.freeze({ newTestsRequired: raw.newTestsRequired === true, declaredArtifacts, ...optional }));
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
  if (raw.verdict === "trusted-pass") {
    return parseExactRecordArm(raw, path, ["verdict"], () =>
      ok(Object.freeze({ verdict: "trusted-pass" })));
  }
  if (raw.verdict === "trusted-fail") {
    return parseExactRecordArm(raw, path, ["verdict"], () =>
      ok(Object.freeze({ verdict: "trusted-fail" })));
  }
  if (raw.verdict === "untrusted") {
    return parseExactRecordArm(raw, path, ["verdict", "passed", "label", "provenance"], () => {
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
    });
  }
  return fail([`${path}.verdict must be trusted-pass, trusted-fail, or untrusted`]);
}

function parseRunRef(raw: unknown, path: string): ProofParseResult<RunRef> {
  if (!isRecord(raw)) return fail([`${path} must be an object`]);
  return parseExactRecordArm(raw, path, ["index", "command"], () => {
    const errors = [
      ...(typeof raw.index === "number" && Number.isSafeInteger(raw.index) && raw.index >= 0
        ? []
        : [`${path}.index must be a non-negative safe integer`]),
      ...(typeof raw.command === "string" && raw.command.trim().length > 0
        ? []
        : [`${path}.command must be a non-empty string`]),
    ];
    return errors.length > 0
      ? fail(errors)
      : ok(Object.freeze({ index: raw.index as number, command: raw.command as string }));
  });
}

type RedThenGreenFacts = Readonly<{ red: RunRef; implementationWrite: string; green: RunRef }>;

/** The three ordered I6 facts: a red run, an implementation write, then a later green run. */
function parseRedThenGreenFacts(raw: Record<string, unknown>, path: string): ProofParseResult<RedThenGreenFacts> {
  const red = parseRunRef(raw.red, `${path}.red`);
  const implementationWrite = parseNonEmptyString(raw.implementationWrite, `${path}.implementationWrite`);
  const green = parseRunRef(raw.green, `${path}.green`);
  if (!red.ok || !implementationWrite.ok || !green.ok) {
    return fail([red, implementationWrite, green].flatMap((parsed) => parsed.ok ? [] : parsed.errors));
  }
  return red.value.index < green.value.index
    ? ok(Object.freeze({ red: red.value, implementationWrite: implementationWrite.value, green: green.value }))
    : fail([`${path}.red must precede ${path}.green`]);
}

function parseRedThenGreenGap(raw: unknown, path = "gap"): ProofParseResult<RedThenGreenGap> {
  if (!isRecord(raw)) return fail([`${path} must be an object`]);
  switch (raw.kind) {
    case "no-test-files":
    case "implementation-write-missing":
    case "red-after-first-implementation-write":
    case "ledger-unavailable": {
      const kind = raw.kind;
      return parseExactRecordArm<RedThenGreenGap>(raw, path, ["kind"], () => ok(Object.freeze({ kind })));
    }
    case "red-missing":
    case "green-missing": {
      const kind = raw.kind;
      return parseExactRecordArm<RedThenGreenGap>(raw, path, ["kind", "untrustedOnly"], () =>
        typeof raw.untrustedOnly === "boolean"
          ? ok(Object.freeze({ kind, untrustedOnly: raw.untrustedOnly }))
          : fail([`${path}.untrustedOnly must be a boolean`]));
    }
    default:
      return fail([`${path}.kind is not a recognized red-then-green gap`]);
  }
}

function parseRedThenGreenObservation(
  raw: unknown,
  path = "redThenGreen",
): ProofParseResult<RedThenGreenObservation> {
  if (!isRecord(raw)) return fail([`${path} must be an object`]);
  if (raw.kind === "shown") {
    return parseExactRecordArm<RedThenGreenObservation>(raw, path, ["kind", "red", "implementationWrite", "green"], () => {
      const facts = parseRedThenGreenFacts(raw, path);
      return facts.ok ? ok(Object.freeze({ kind: "shown", ...facts.value })) : facts;
    });
  }
  if (raw.kind === "unproven") {
    return parseExactRecordArm<RedThenGreenObservation>(raw, path, ["kind", "gap"], () => {
      const gap = parseRedThenGreenGap(raw.gap, `${path}.gap`);
      return gap.ok ? ok(Object.freeze({ kind: "unproven", gap: gap.value })) : gap;
    });
  }
  return fail([`${path}.kind must be shown or unproven`]);
}

export function parseObservedProofEvidence(raw: unknown): ProofParseResult<ObservedProofEvidence> {
  if (!isRecord(raw)) return fail(["observed proof evidence must be an object"]);
  const exact = parseExactRecordArm(
    raw,
    "observed proof evidence",
    ["taskCompleted", "testResult", "filesModified", "newTestsWritten", "newTestEvidence", "redThenGreen"],
    () => ok(true),
  );
  if (!exact.ok) return fail(exact.errors);
  const errors: string[] = [];
  let testResult: ProofTestResult | undefined;
  if (raw.testResult !== undefined) {
    const parsed = parseTaskTestResult(raw.testResult);
    if (parsed.ok) testResult = parsed.value;
    else errors.push(...parsed.errors);
  }
  const redThenGreen = raw.redThenGreen === undefined ? undefined : parseRedThenGreenObservation(raw.redThenGreen);
  if (redThenGreen !== undefined && !redThenGreen.ok) errors.push(...redThenGreen.errors);

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
    ...(redThenGreen?.ok ? { redThenGreen: redThenGreen.value } : {}),
  }));
}

export function parseProofEvaluationPolicy(raw: unknown): ProofParseResult<ProofEvaluationPolicy> {
  if (!isRecord(raw)) return fail(["proof evaluation policy must be an object"]);
  return parseExactRecordArm(raw, "proof evaluation policy", ["untrustedPass"], () =>
    raw.untrustedPass === "reject" || raw.untrustedPass === "accept-pi-structured"
      ? ok(Object.freeze({ untrustedPass: raw.untrustedPass }))
      : fail(["proof evaluation policy.untrustedPass must be reject or accept-pi-structured"]));
}

export function parseProofFailure(raw: unknown, path = "failure"): ProofParseResult<ProofFailure> {
  if (!isRecord(raw)) return fail([`${path} must be an object`]);
  switch (raw.kind) {
    case "task-not-completed":
    case "test-result-missing":
    case "new-tests-not-observed":
    case "attempt-scope-drifted": {
      const kind = raw.kind;
      return parseExactRecordArm<ProofFailure>(raw, path, ["kind"], () =>
        ok(Object.freeze({ kind })));
    }
    case "regression-tests-failed":
      return parseExactRecordArm<ProofFailure>(raw, path, ["kind", "provenance"], () =>
        raw.provenance === "ledger"
          ? ok(Object.freeze({ kind: "regression-tests-failed", provenance: "ledger" }))
          : fail([`${path}.provenance must be ledger`]));
    case "untrusted-regression-tests-failed":
    case "untrusted-regression-pass": {
      const kind = raw.kind;
      return parseExactRecordArm<ProofFailure>(raw, path, ["kind", "label"], () => {
        const label = parseNonEmptyString(raw.label, `${path}.label`);
        return label.ok ? ok(Object.freeze({ kind, label: label.value })) : label;
      });
    }
    case "declared-artifact-not-changed":
    case "declared-artifact-drifted": {
      const kind = raw.kind;
      return parseExactRecordArm<ProofFailure>(raw, path, ["kind", "artifact"], () => {
        const artifact = parseNonEmptyString(raw.artifact, `${path}.artifact`);
        return artifact.ok ? ok(Object.freeze({ kind, artifact: artifact.value })) : artifact;
      });
    }
    case "red-then-green-unproven":
      return parseExactRecordArm<ProofFailure>(raw, path, ["kind", "gap"], () => {
        const gap = parseRedThenGreenGap(raw.gap, `${path}.gap`);
        return gap.ok ? ok(Object.freeze({ kind: "red-then-green-unproven", gap: gap.value })) : gap;
      });
    default:
      return fail([`${path}.kind is not a recognized proof failure`]);
  }
}

/** The `regression-test-pass` arm: trusted ledger evidence, or a labelled Pi-structured untrusted pass. */
function parseRegressionPassEvidence(raw: Record<string, unknown>, path: string): ProofParseResult<ProofEvidence> {
  const allowed = raw.provenance === "pi-structured"
    ? ["kind", "provenance", "verdict", "label"]
    : ["kind", "provenance", "verdict"];
  return parseExactRecordArm<ProofEvidence>(raw, path, allowed, () => {
    if (raw.provenance === "evidence-ledger" && raw.verdict === "trusted-pass") {
      return ok(Object.freeze({
        kind: "regression-test-pass", provenance: "evidence-ledger", verdict: "trusted-pass",
      }));
    }
    if (raw.provenance === "pi-structured" && raw.verdict === "untrusted-pass") {
      const label = parseNonEmptyString(raw.label, `${path}.label`);
      return label.ok
        ? ok(Object.freeze({
            kind: "regression-test-pass",
            provenance: "pi-structured",
            verdict: "untrusted-pass",
            label: label.value,
          }))
        : label;
    }
    return fail([`${path} has an invalid regression evidence provenance/verdict combination`]);
  });
}

export function parseProofEvidence(raw: unknown, path = "evidence"): ProofParseResult<ProofEvidence> {
  if (!isRecord(raw)) return fail([`${path} must be an object`]);
  if (raw.kind === "task-completed" || raw.kind === "attempt-scope-attested") {
    const kind = raw.kind;
    return parseExactRecordArm<ProofEvidence>(raw, path, ["kind"], () => ok(Object.freeze({ kind })));
  }
  if (raw.kind === "regression-test-pass") return parseRegressionPassEvidence(raw, path);
  if (raw.kind === "new-tests") {
    return parseExactRecordArm(raw, path, ["kind", "detail"], () => {
      if (raw.detail !== null && typeof raw.detail !== "string") {
        return fail([`${path}.detail must be a string or null`]);
      }
      return ok(Object.freeze({ kind: "new-tests", detail: raw.detail === null ? null : raw.detail }));
    });
  }
  if (raw.kind === "declared-artifact-changed" || raw.kind === "declared-artifact-attested") {
    const kind = raw.kind;
    return parseExactRecordArm<ProofEvidence>(raw, path, ["kind", "artifact"], () => {
      const artifact = parseNonEmptyString(raw.artifact, `${path}.artifact`);
      return artifact.ok ? ok(Object.freeze({ kind, artifact: artifact.value })) : artifact;
    });
  }
  if (raw.kind === "red-then-green") {
    return parseExactRecordArm<ProofEvidence>(raw, path, ["kind", "red", "implementationWrite", "green"], () => {
      const facts = parseRedThenGreenFacts(raw, path);
      return facts.ok ? ok(Object.freeze({ kind: "red-then-green", ...facts.value })) : facts;
    });
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
      case "red-then-green":
        return result.failure.kind === "red-then-green-unproven";
      case "attempt-scope-attested":
        return result.failure.kind === "attempt-scope-drifted";
      case "declared-artifact-changed":
        return result.failure.kind === "declared-artifact-not-changed"
          && result.failure.artifact === result.obligation.artifact;
      case "declared-artifact-attested":
        return result.failure.kind === "declared-artifact-drifted"
          && result.failure.artifact === result.obligation.artifact;
    }
  }
  if (result.state === "satisfied") {
    if (result.obligation.kind !== result.evidence.kind) return false;
    return (result.obligation.kind !== "declared-artifact-changed" &&
        result.obligation.kind !== "declared-artifact-attested")
      || (result.evidence.kind === result.obligation.kind
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
  let allowed: readonly string[] | null = null;
  if (raw.state === "pending") allowed = ["state", "obligation"];
  if (raw.state === "failed") allowed = ["state", "obligation", "failure"];
  if (raw.state === "satisfied") allowed = ["state", "obligation", "evidence"];
  if (allowed === null) return fail([`${path}.state must be pending, failed, or satisfied`]);
  return parseExactRecordArm(raw, path, allowed, () => {
    const obligation = parseProofObligation(raw.obligation, `${path}.obligation`);
    if (!obligation.ok) return obligation;

    let result: ProofObligationResult;
    if (raw.state === "pending") {
      result = Object.freeze({ state: "pending", obligation: obligation.value });
    } else if (raw.state === "failed") {
      const failure = parseProofFailure(raw.failure, `${path}.failure`);
      if (!failure.ok) return failure;
      result = Object.freeze({ state: "failed", obligation: obligation.value, failure: failure.value });
    } else {
      const evidence = parseProofEvidence(raw.evidence, `${path}.evidence`);
      if (!evidence.ok) return evidence;
      result = Object.freeze({ state: "satisfied", obligation: obligation.value, evidence: evidence.value });
    }
    return resultMatchesObligation(result)
      ? ok(result)
      : fail([`${path} payload does not satisfy its obligation kind`]);
  });
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
  if (parts.results.some((result) => result.state !== "pending")) {
    return fail(["pending proof may contain only pending results"]);
  }
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
  if (parts.results.some((result) => result.state === "pending")) {
    return fail(["evaluated proof may not contain pending results"]);
  }
  return ok(requireResultState(
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
  // Agreement is structural, not textual: JSON.stringify equality was
  // key-order-sensitive and undefined-dropping, where the engine's canonical
  // equality kernel is the exact-fit primitive (silent-failure-hunter-2). Arrays
  // stay order-sensitive, so positional drift is still refused.
  if (evaluated.ok && failures.ok && !canonicalStructuralEquals(failures.value, derived)) {
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
  if (evaluated.ok && evidence.ok && !canonicalStructuralEquals(evidence.value, derived)) {
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
  let allowed: readonly string[] | null = null;
  if (raw.state === "pending") allowed = ["state", "obligations", "results"];
  if (raw.state === "failed") allowed = ["state", "obligations", "results", "failures"];
  if (raw.state === "satisfied") allowed = ["state", "obligations", "results", "evidence"];
  if (allowed === null) return fail(["proof.state must be pending, failed, or satisfied"]);
  return parseExactRecordArm<TaskProof>(raw, "proof", allowed, () => {
    const parts = parseProofParts(raw);
    if (!parts.ok) return parts;
    if (raw.state === "pending") return parsePendingProof(parts.value);
    if (raw.state === "failed") return parseFailedProof(raw, parts.value);
    return parseSatisfiedProof(raw, parts.value);
  });
}

