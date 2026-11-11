import { canonicalStructuralEquals, mapNonEmpty, nonEmpty, nonEmptyOf, type NonEmpty } from "./orchestration-contract";
import type { RedThenGreenGap, RedThenGreenObservation, RunRef } from "./red-then-green-types";
import {
  isViolationReason,
  type ConformanceViolation,
  type ContractConformance,
} from "./skeleton/conformance-verdict";
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

/** The engine-authored requirements for one implementation task. */
export type ProofObligation =
  | Readonly<{ kind: "task-completed" }>
  | Readonly<{ kind: "regression-test-pass" }>
  | Readonly<{ kind: "new-tests" }>
  | Readonly<{ kind: "red-then-green" }>
  | Readonly<{ kind: "attempt-scope-attested" }>
  | Readonly<{ kind: "declared-artifact-changed"; artifact: string }>
  | Readonly<{ kind: "declared-artifact-attested"; artifact: string }>
  | Readonly<{ kind: "behaviour-preserved" }>;

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
 * backstop against a second reader. Population, the State File obligation-match
 * check and the operator validator ask per Task through `taskRedThenGreenEra`,
 * which exempts Acceptance Contract writers from this era; revalidation and
 * `redThenGreenDuty`'s no-Proof arm take the graph era alone through
 * `redThenGreenEra` (see `taskRedThenGreenEra` for why that is sound);
 * settlement, the stored-evidence reconcile and the brief ask through
 * `redThenGreenDuty`, which defers to a Task's frozen Proof and takes the
 * classification from here, so none of them can disagree.
 */
export function frozenRedThenGreenEra(manifest: FrozenVerificationManifest | undefined): FrozenRedThenGreenEra {
  const testFiles = manifest?.testFiles;
  return testFiles === undefined ? PRE_I6_ERA : Object.freeze({ kind: "owed-if-new-tests", testFiles });
}

/** `frozenRedThenGreenEra`'s era alone. */
export function redThenGreenEra(manifest: FrozenVerificationManifest | undefined): RedThenGreenEra {
  return frozenRedThenGreenEra(manifest).kind;
}

/**
 * What decides one Task's I6 era: the TaskGraph's era and the Tasks that
 * write an Acceptance Contract, each mapped to the first contract (in
 * contract order) it writes. Built once per graph by `redThenGreenScope` and
 * asked per Task through `writtenContract` and `taskRedThenGreenEra`.
 */
export type RedThenGreenScope = Readonly<{ era: RedThenGreenEra; contractWriters: ReadonlyMap<string, string> }>;

/**
 * The graph's scope, from its frozen manifest and its Acceptance Contracts.
 * Structural on `id` and `contractTask` alone, so this module never imports
 * the acceptance-contract model (which imports from here).
 */
export function redThenGreenScope(
  manifest: FrozenVerificationManifest | undefined,
  contracts: readonly Readonly<{ id: string; contractTask: string }>[],
): RedThenGreenScope {
  // A later Map entry overwrites an earlier one, so reversing keeps each writer's first contract.
  const writers = [...contracts].reverse().map(({ id, contractTask }) => [contractTask, id] as const);
  return Object.freeze({ era: redThenGreenEra(manifest), contractWriters: new Map(writers) });
}

/**
 * The Acceptance Contract `taskId` writes (its first, in contract order), or
 * `undefined` for a Task writing none: the one reader of `contractWriters`,
 * so the exemption and the contract Red-Then-Green Status names cannot drift.
 */
export function writtenContract(scope: RedThenGreenScope, taskId: string): string | undefined {
  return scope.contractWriters.get(taskId);
}

/**
 * One Task's I6 era: `not-owed` for an Acceptance Contract writer, the graph's
 * era for every other Task (issue 127).
 *
 * A contract Task writes the contract's frozen acceptance tests, and any types
 * file and stubs, and the contract Wave Gate requires every acceptance
 * testcase collected and FAILING. Its new tests must stay red by contract, so
 * green never happens in its attempt; a test-only contract has no
 * implementation file to write at all. The contract gate's observed RED
 * window is the writer's red evidence, and the claimants that turn the
 * testcases green owe no I6 either (FR-010's covered-by-acceptance-contract
 * waiver). The writer keeps its `new-tests` obligation.
 *
 * Population, the State File obligation-match check (`taskUnionError`, and
 * through it the operator validator) and the proof-less pending migration ask
 * here. Revalidation and `redThenGreenDuty`'s no-Proof arm take the graph era
 * alone: Acceptance Contracts exist only in TaskGraphs whose population froze
 * every Task's Proof, so a Task reaching those no-Proof paths is never a
 * contract writer.
 */
export function taskRedThenGreenEra(scope: RedThenGreenScope, taskId: string): RedThenGreenEra {
  return writtenContract(scope, taskId) === undefined ? scope.era : "not-owed";
}

/** Which byte comparison each declared artifact owes.
 *
 * `changed` is the default: the dispatched child itself moves the bytes.
 * `attested` inverts the comparison for a Task whose work predates the
 * attempt: the child must leave the declared bytes EXACTLY as the attempt
 * baseline captured them, and a write is a failure, not a proof.
 * `preserved` is a Distill Task's (ADR-0068): the child may change the
 * declared bytes or leave them alone, and owes one `behaviour-preserved`
 * obligation over the whole scope instead of one obligation per artifact.
 */
export const DECLARED_ARTIFACT_EXPECTATIONS = ["changed", "attested", "preserved"] as const;
export type DeclaredArtifactExpectation = (typeof DECLARED_ARTIFACT_EXPECTATIONS)[number];

const isDeclaredArtifactExpectation = (value: unknown): value is DeclaredArtifactExpectation =>
  DECLARED_ARTIFACT_EXPECTATIONS.some((expectation) => expectation === value);

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
  /**
   * The completion conformance judgment (AD-5): `not-owed`, or every
   * violation of the Task's in-scope files by artifact. Required: every
   * settlement path decides it — the exact settlement and reconcile through
   * `observeContractConformance`, the authority-free legacy stop as
   * `not-owed` — so no path can skip the contract check by omission.
   */
  readonly contractConformance: ContractConformance;
  /**
   * Why the settlement shell wrote a Distill Task's snapshot back before this
   * observation was taken (ADR-0068): the failures the attempt's own bytes
   * would have settled with. Absent when nothing was restored.
   */
  readonly restoredAfter?: NonEmpty<string>;
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
  | Readonly<{ kind: "declared-artifact-contract-violated"; artifact: string; violations: NonEmpty<ConformanceViolation> }>
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

const ATTESTATION_DRIFT_FAILURE_KINDS: NonEmpty<AttestationDriftFailureKind> = mapNonEmpty(
  ATTESTATION_DRIFT_BASE_KINDS,
  (kind) => `proof:${kind}` as AttestationDriftFailureKind,
);

export const isAttestationDriftFailureKind = (kind: string): kind is AttestationDriftFailureKind =>
  (ATTESTATION_DRIFT_FAILURE_KINDS as readonly string[]).includes(kind);

type ContractViolatedFailure = Extract<ProofFailure, { kind: "declared-artifact-contract-violated" }>;

/** The label every contract-violated receipt failure kind starts with; the
 *  canonical JSON body of {@link ContractViolatedReceiptEntry} follows it. */
export const CONTRACT_VIOLATED_FAILURE_KIND_PREFIX =
  "proof:declared-artifact-contract-violated " as const satisfies `proof:${ContractViolatedFailure["kind"]} `;

/**
 * What a settlement receipt keeps of one contract-violated failure (FR-021):
 * the artifact, the longest prefix of its violations that fits the receipt's
 * failure-kind bound, and how many it leaves out. `shown.length + omitted` is
 * the failure's violation count, at least one; the stored Proof keeps them all.
 */
export type ContractViolatedReceiptEntry = Readonly<{
  artifact: string;
  shown: readonly ConformanceViolation[];
  omitted: number;
}>;

const encodeContractViolated = (artifact: string, shown: readonly ConformanceViolation[], omitted: number): string =>
  `${CONTRACT_VIOLATED_FAILURE_KIND_PREFIX}${JSON.stringify({
    artifact,
    omitted,
    violations: shown.map(({ subject, reason, remedy }) => ({ subject, reason, remedy })),
  })}`;

/**
 * The receipt failure kind of one contract-violated failure, at most
 * `maxLength` characters: every violation that fits, in judge order, and the
 * count of the rest. Only an artifact path longer than the bound itself
 * yields a kind cut short, which {@link parseContractViolatedFailureKind}
 * then refuses rather than misreads.
 */
export function contractViolatedFailureKind(failure: ContractViolatedFailure, maxLength: number): string {
  const total = failure.violations.length;
  let shown = total;
  let kind = encodeContractViolated(failure.artifact, failure.violations, 0);
  while (shown > 0 && kind.length > maxLength) {
    shown -= 1;
    kind = encodeContractViolated(failure.artifact, failure.violations.slice(0, shown), total - shown);
  }
  return kind.slice(0, maxLength);
}

/** Parse a receipt failure kind minted by {@link contractViolatedFailureKind}. */
export function parseContractViolatedFailureKind(kind: string): ProofParseResult<ContractViolatedReceiptEntry> {
  const path = "contract-violated failure kind";
  if (!kind.startsWith(CONTRACT_VIOLATED_FAILURE_KIND_PREFIX)) {
    return fail([`${path} must start with ${CONTRACT_VIOLATED_FAILURE_KIND_PREFIX.trim()}`]);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(kind.slice(CONTRACT_VIOLATED_FAILURE_KIND_PREFIX.length));
  } catch (cause) {
    return fail([`${path} body is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`]);
  }
  if (!isRecord(raw)) return fail([`${path} body must be an object`]);
  return parseExactRecordArm<ContractViolatedReceiptEntry>(raw, path, ["artifact", "omitted", "violations"], () => {
    const artifact = parseNonEmptyString(raw.artifact, `${path}.artifact`);
    const omitted = raw.omitted;
    const omittedValid = typeof omitted === "number" && Number.isSafeInteger(omitted) && omitted >= 0;
    const shown = Array.isArray(raw.violations)
      ? raw.violations.map((value: unknown, index) => parseConformanceViolation(value, `${path}.violations[${index}]`))
      : null;
    const errors = [
      ...(artifact.ok ? [] : artifact.errors),
      ...(omittedValid ? [] : [`${path}.omitted must be a non-negative integer`]),
      ...(shown === null ? [`${path}.violations must be an array`] : shown.flatMap((result) => (result.ok ? [] : result.errors))),
    ];
    if (errors.length > 0 || !artifact.ok || !omittedValid || shown === null) return fail(errors);
    const violations = Object.freeze(shown.flatMap((result) => (result.ok ? [result.value] : [])));
    return violations.length + omitted === 0
      ? fail([`${path} must account for at least one violation`])
      : ok(Object.freeze({ artifact: artifact.value, shown: violations, omitted }));
  });
}

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
  | Readonly<{ kind: "declared-artifact-attested"; artifact: string }>
  | Readonly<{ kind: "behaviour-preserved"; basis: BehaviourPreservedBasis }>;

/**
 * Why a Distill Task's attempt is known to have preserved behaviour
 * (ADR-0068). `unchanged`: it left every scope path as its attempt baseline
 * captured it. `restored`: it changed them, could not prove the change, and
 * the engine wrote the snapshot back; `after` keeps what it would have
 * failed with. `tests-passed`: it changed them and the regression verdict is
 * a pass the evaluation policy admits, with the provenance that pass had.
 */
export type BehaviourPreservedBasis =
  | Readonly<{ kind: "unchanged" }>
  | Readonly<{ kind: "restored"; after: NonEmpty<string> }>
  | Readonly<{ kind: "tests-passed"; provenance: "evidence-ledger" | "pi-structured" }>;

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
    ...scopeObligations(expectation, artifacts),
  ];
  return nonEmptyOf(Object.freeze({ kind: "task-completed" }), ...tail);
}

/** The obligations the declared artifacts owe under one expectation, in artifact order. */
function scopeObligations(expectation: DeclaredArtifactExpectation, artifacts: readonly string[]): readonly ProofObligation[] {
  switch (expectation) {
    case "changed":
      return artifacts.map((artifact) => Object.freeze({ kind: "declared-artifact-changed" as const, artifact }));
    case "attested":
      return [
        Object.freeze({ kind: "attempt-scope-attested" as const }),
        ...artifacts.map((artifact) => Object.freeze({ kind: "declared-artifact-attested" as const, artifact })),
      ];
    case "preserved":
      return [Object.freeze({ kind: "behaviour-preserved" as const })];
    default: {
      const unreachable: never = expectation;
      return unreachable;
    }
  }
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

/** The violations the conformance judgment found in one artifact, or none. */
const violationsOf = (conformance: ContractConformance, artifact: string): NonEmpty<ConformanceViolation> | undefined =>
  conformance.kind === "judged" ? conformance.violations.get(artifact) : undefined;

/**
 * The `declared-artifact-changed` arm (AD-5): a contract violation is
 * reported ahead of the changed test, so an untouched engine skeleton is
 * refused as `still unimplemented` rather than as `not-changed`. Then the
 * artifact is satisfied exactly when it changed (engine bytes were already
 * subtracted from `filesModified`, FR-012).
 */
const evaluateDeclaredArtifactChanged = (
  obligation: Extract<ProofObligation, { kind: "declared-artifact-changed" }>,
  observed: ObservedProofEvidence,
): EvaluatedProofResult => {
  const violations = violationsOf(observed.contractConformance, obligation.artifact);
  if (violations !== undefined) {
    return Object.freeze({
      state: "failed",
      obligation,
      failure: Object.freeze({
        kind: "declared-artifact-contract-violated",
        artifact: obligation.artifact,
        violations: mapNonEmpty(violations, (violation) => Object.freeze({ ...violation })),
      }),
    });
  }
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
};

const REGRESSION_OBLIGATION = Object.freeze({ kind: "regression-test-pass" as const });

/**
 * The `behaviour-preserved` arm (ADR-0068). An attempt that left the scope as
 * its baseline captured it preserved behaviour trivially, whether it never
 * wrote or the engine restored it. One that changed the scope owes what an
 * implementation attempt owes for the same bytes: no contract violation in a
 * changed path, then a regression pass the policy admits. It fails with those
 * obligations' own failures, so a reader meets no second vocabulary.
 */
const evaluateBehaviourPreserved = (
  obligation: Extract<ProofObligation, { kind: "behaviour-preserved" }>,
  observed: ObservedProofEvidence,
  policy: ProofEvaluationPolicy,
): EvaluatedProofResult => {
  const satisfied = (basis: BehaviourPreservedBasis): EvaluatedProofResult => Object.freeze({
    state: "satisfied",
    obligation,
    evidence: Object.freeze({ kind: "behaviour-preserved", basis: Object.freeze(basis) }),
  });
  if (observed.filesModified.length === 0) {
    return satisfied(observed.restoredAfter === undefined
      ? { kind: "unchanged" }
      : { kind: "restored", after: mapNonEmpty(observed.restoredAfter, (reason) => reason) });
  }
  const violated = observed.filesModified.flatMap((artifact) => {
    const violations = violationsOf(observed.contractConformance, artifact);
    return violations === undefined ? [] : [{ artifact, violations }];
  }).at(0);
  if (violated !== undefined) {
    return Object.freeze({
      state: "failed",
      obligation,
      failure: Object.freeze({
        kind: "declared-artifact-contract-violated",
        artifact: violated.artifact,
        violations: mapNonEmpty(violated.violations, (violation) => Object.freeze({ ...violation })),
      }),
    });
  }
  const regression = evaluateRegression(REGRESSION_OBLIGATION, observed.testResult, policy);
  if (regression.state === "failed") return Object.freeze({ state: "failed", obligation, failure: regression.failure });
  return satisfied({
    kind: "tests-passed",
    provenance: regression.evidence.kind === "regression-test-pass" ? regression.evidence.provenance : "evidence-ledger",
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
      return evaluateDeclaredArtifactChanged(obligation, observed);
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
    case "behaviour-preserved":
      return evaluateBehaviourPreserved(obligation, observed, policy);
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
  return nonEmptyOf(head, ...tail);
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
      failures: nonEmptyOf(head, ...tail),
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
      raw.kind === "red-then-green" || raw.kind === "attempt-scope-attested" || raw.kind === "behaviour-preserved") {
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
  return fail([`${path}.kind must be task-completed, regression-test-pass, new-tests, red-then-green, attempt-scope-attested, declared-artifact-changed, declared-artifact-attested, or behaviour-preserved`]);
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
    ...(raw.declaredArtifactExpectation !== undefined && !isDeclaredArtifactExpectation(raw.declaredArtifactExpectation)
      ? [`declaredArtifactExpectation must be one of ${DECLARED_ARTIFACT_EXPECTATIONS.join(", ")}`]
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

function parseConformanceViolation(raw: unknown, path: string): ProofParseResult<ConformanceViolation> {
  if (!isRecord(raw)) return fail([`${path} must be an object`]);
  return parseExactRecordArm(raw, path, ["subject", "reason", "remedy"], () => {
    const subject = parseNonEmptyString(raw.subject, `${path}.subject`);
    const errors = [
      ...(subject.ok ? [] : subject.errors),
      ...(isViolationReason(raw.reason) ? [] : [`${path}.reason must be a conformance violation reason`]),
      ...(raw.remedy === null || typeof raw.remedy === "string" ? [] : [`${path}.remedy must be a string or null`]),
    ];
    return errors.length > 0 || !subject.ok || !isViolationReason(raw.reason)
      ? fail(errors)
      : ok(Object.freeze({ subject: subject.value, reason: raw.reason, remedy: typeof raw.remedy === "string" ? raw.remedy : null }));
  });
}

function parseViolations(raw: unknown, path: string): ProofParseResult<NonEmpty<ConformanceViolation>> {
  if (!Array.isArray(raw) || raw.length === 0) return fail([`${path} must be a non-empty array`]);
  const parsed = raw.map((value: unknown, index) => parseConformanceViolation(value, `${path}[${index}]`));
  const errors = parsed.flatMap((result) => (result.ok ? [] : result.errors));
  const violations = nonEmpty(parsed.flatMap((result) => (result.ok ? [result.value] : [])));
  return errors.length > 0 || violations === null ? fail(errors) : ok(violations);
}

/** The in-memory observation the settlement shell decided: `not-owed`, or a
 *  Map of every violated artifact to its non-empty violations. */
function parseContractConformance(raw: unknown, path = "contractConformance"): ProofParseResult<ContractConformance> {
  if (!isRecord(raw)) return fail([`${path} must be decided as not-owed or judged`]);
  if (raw.kind === "not-owed") {
    return parseExactRecordArm<ContractConformance>(raw, path, ["kind"], () => ok(Object.freeze({ kind: "not-owed" })));
  }
  if (raw.kind !== "judged") return fail([`${path}.kind must be not-owed or judged`]);
  return parseExactRecordArm<ContractConformance>(raw, path, ["kind", "violations"], () => {
    if (!(raw.violations instanceof Map)) return fail([`${path}.violations must be a Map of artifact to violations`]);
    const entries = [...(raw.violations as ReadonlyMap<unknown, unknown>)].map(([artifact, violations], index) => {
      const parsedArtifact = parseNonEmptyString(artifact, `${path}.violations[${index}].artifact`);
      const parsedViolations = parseViolations(violations, `${path}.violations[${index}].violations`);
      return parsedArtifact.ok && parsedViolations.ok
        ? ok([parsedArtifact.value, parsedViolations.value] as const)
        : fail<readonly [string, NonEmpty<ConformanceViolation>]>([
            ...(parsedArtifact.ok ? [] : parsedArtifact.errors),
            ...(parsedViolations.ok ? [] : parsedViolations.errors),
          ]);
    });
    const errors = entries.flatMap((entry) => (entry.ok ? [] : entry.errors));
    return errors.length > 0
      ? fail(errors)
      : ok(Object.freeze({
          kind: "judged",
          violations: new Map(entries.flatMap((entry) => (entry.ok ? [entry.value] : []))),
        }));
  });
}

/** The observed changed paths in order, with every element error; absent reads as none. */
function parseModifiedFiles(raw: unknown): Readonly<{ files: readonly string[]; errors: readonly string[] }> {
  if (raw === undefined) return { files: [], errors: [] };
  if (!Array.isArray(raw)) return { files: [], errors: ["filesModified must be an array when present"] };
  const parsed = raw.map((value: unknown, index) => parseNonEmptyString(value, `filesModified[${index}]`));
  return {
    files: parsed.flatMap((entry) => (entry.ok ? [entry.value] : [])),
    errors: parsed.flatMap((entry) => (entry.ok ? [] : entry.errors)),
  };
}

export function parseObservedProofEvidence(raw: unknown): ProofParseResult<ObservedProofEvidence> {
  if (!isRecord(raw)) return fail(["observed proof evidence must be an object"]);
  const exact = parseExactRecordArm(
    raw,
    "observed proof evidence",
    ["taskCompleted", "testResult", "filesModified", "newTestsWritten", "newTestEvidence", "redThenGreen", "contractConformance", "restoredAfter"],
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
  // Required: an observation that has not decided conformance is refused,
  // never read as judging nothing (AD-5).
  const contractConformance = parseContractConformance(raw.contractConformance);
  if (!contractConformance.ok) errors.push(...contractConformance.errors);

  const restoredAfter = raw.restoredAfter === undefined
    ? undefined
    : parseNonEmptyArray(raw.restoredAfter, "restoredAfter", parseNonEmptyString);
  if (restoredAfter !== undefined && !restoredAfter.ok) errors.push(...restoredAfter.errors);

  if (typeof raw.taskCompleted !== "boolean") errors.push("taskCompleted must be a boolean");
  const modified = parseModifiedFiles(raw.filesModified);
  errors.push(...modified.errors);
  if (raw.newTestsWritten !== undefined && typeof raw.newTestsWritten !== "boolean") {
    errors.push("newTestsWritten must be a boolean when present");
  }
  if (raw.newTestEvidence !== undefined && typeof raw.newTestEvidence !== "string") {
    errors.push("newTestEvidence must be a string when present");
  }

  if (errors.length > 0 || !contractConformance.ok) return fail(errors);
  return ok(Object.freeze({
    taskCompleted: raw.taskCompleted === true,
    ...(testResult === undefined ? {} : { testResult }),
    filesModified: Object.freeze([...new Set(modified.files)]),
    ...(typeof raw.newTestsWritten === "boolean" ? { newTestsWritten: raw.newTestsWritten } : {}),
    ...(typeof raw.newTestEvidence === "string" ? { newTestEvidence: raw.newTestEvidence } : {}),
    ...(redThenGreen?.ok ? { redThenGreen: redThenGreen.value } : {}),
    contractConformance: contractConformance.value,
    ...(restoredAfter?.ok ? { restoredAfter: restoredAfter.value } : {}),
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
    case "declared-artifact-contract-violated":
      return parseExactRecordArm<ProofFailure>(raw, path, ["kind", "artifact", "violations"], () => {
        const artifact = parseNonEmptyString(raw.artifact, `${path}.artifact`);
        const violations = parseViolations(raw.violations, `${path}.violations`);
        return artifact.ok && violations.ok
          ? ok(Object.freeze({ kind: "declared-artifact-contract-violated", artifact: artifact.value, violations: violations.value }))
          : fail([...(artifact.ok ? [] : artifact.errors), ...(violations.ok ? [] : violations.errors)]);
      });
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

function parseBehaviourPreservedBasis(raw: unknown, path: string): ProofParseResult<BehaviourPreservedBasis> {
  if (!isRecord(raw)) return fail([`${path} must be an object`]);
  if (raw.kind === "unchanged") {
    return parseExactRecordArm<BehaviourPreservedBasis>(raw, path, ["kind"], () => ok(Object.freeze({ kind: "unchanged" })));
  }
  if (raw.kind === "restored") {
    return parseExactRecordArm<BehaviourPreservedBasis>(raw, path, ["kind", "after"], () => {
      const after = parseNonEmptyArray(raw.after, `${path}.after`, parseNonEmptyString);
      return after.ok ? ok(Object.freeze({ kind: "restored", after: after.value })) : after;
    });
  }
  if (raw.kind === "tests-passed") {
    return parseExactRecordArm<BehaviourPreservedBasis>(raw, path, ["kind", "provenance"], () =>
      raw.provenance === "evidence-ledger" || raw.provenance === "pi-structured"
        ? ok(Object.freeze({ kind: "tests-passed", provenance: raw.provenance }))
        : fail([`${path}.provenance must be evidence-ledger or pi-structured`]));
  }
  return fail([`${path}.kind must be unchanged, restored, or tests-passed`]);
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
  if (raw.kind === "behaviour-preserved") {
    return parseExactRecordArm<ProofEvidence>(raw, path, ["kind", "basis"], () => {
      const basis = parseBehaviourPreservedBasis(raw.basis, `${path}.basis`);
      return basis.ok ? ok(Object.freeze({ kind: "behaviour-preserved", basis: basis.value })) : basis;
    });
  }
  return fail([`${path}.kind is not recognized proof evidence`]);
}

/** Every failure the regression verdict can produce, for the two obligations that judge it. */
const REGRESSION_FAILURE_KINDS: readonly ProofFailure["kind"][] = Object.freeze([
  "test-result-missing",
  "regression-tests-failed",
  "untrusted-regression-tests-failed",
  "untrusted-regression-pass",
]);

const resultMatchesObligation = (result: ProofObligationResult): boolean => {
  if (result.state === "failed") {
    switch (result.obligation.kind) {
      case "task-completed":
        return result.failure.kind === "task-not-completed";
      case "regression-test-pass":
        return REGRESSION_FAILURE_KINDS.includes(result.failure.kind);
      case "new-tests":
        return result.failure.kind === "new-tests-not-observed";
      case "red-then-green":
        return result.failure.kind === "red-then-green-unproven";
      case "attempt-scope-attested":
        return result.failure.kind === "attempt-scope-drifted";
      case "declared-artifact-changed":
        return (result.failure.kind === "declared-artifact-not-changed" ||
            result.failure.kind === "declared-artifact-contract-violated")
          && result.failure.artifact === result.obligation.artifact;
      case "declared-artifact-attested":
        return result.failure.kind === "declared-artifact-drifted"
          && result.failure.artifact === result.obligation.artifact;
      case "behaviour-preserved":
        return REGRESSION_FAILURE_KINDS.includes(result.failure.kind) ||
          result.failure.kind === "declared-artifact-contract-violated";
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
  const proven = nonEmpty(values);
  return proven === null ? fail([`${path} must be a non-empty array`]) : ok(proven);
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

