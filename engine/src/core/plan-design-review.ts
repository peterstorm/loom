/**
 * Plan design review (ADR-0070): the State File record that says whether the
 * architecture plan's design was reviewed before decompose, the decision the
 * decompose gate makes from it, and the judgement that turns a completed
 * `plan-design` Standalone Review into an acceptance bound to the plan's bytes.
 *
 * The record is an ADT with no free text. `accepted` names the exact plan
 * bytes (`planSha256`) and the published result that reviewed them, so the
 * gate compares one digest and never opens a Run Directory: the coupling from
 * the phase gate to the review is one-way and digest-bound. An edit to the
 * plan after acceptance changes the digest and closes the gate again.
 *
 * Pure: no I/O. `handlers/helpers/accept-plan-design-review` gathers the
 * evidence and writes the record; `core/validate-phase-order` asks the gate.
 */
import { match } from "ts-pattern";
import {
  failure,
  parseArtifactDigest,
  parseOrchestrationRunId,
  success,
  type ArtifactDigest,
  type DomainResult,
  type OrchestrationRunId,
} from "./orchestration-contract/identity";
import { hasExactKeys, isRecord } from "./plain-record";

// ---------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------

/** The Standalone Review kind that reviews an architecture plan's design before decompose. */
export const PLAN_DESIGN_REVIEW_KIND = "plan-design";

/**
 * The plan design review's roster, in canonical spawn order. It belongs to the
 * kind, not to the scope: a Markdown plan changes no type and adds no
 * structure, so the scope facts that pick every other roster would never
 * select the type or architecture lens for it.
 */
export const PLAN_DESIGN_REVIEWERS = Object.freeze([
  "code-reviewer",
  "type-design-analyzer",
  "architecture-tech-lead",
] as const);
export type PlanDesignReviewer = (typeof PLAN_DESIGN_REVIEWERS)[number];

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** A completed plan design review, bound to the plan bytes it reviewed. */
export type AcceptedPlanDesignReview = Readonly<{
  status: "accepted";
  /** SHA-256 of the plan file's exact bytes as reviewed. */
  planSha256: ArtifactDigest;
  /** The Standalone Review Run that reviewed them. */
  runId: OrchestrationRunId;
  /** The digest of that Run's published result. */
  resultDigest: ArtifactDigest;
}>;

/** The record as the State File stores it under `plan_design_review`. */
export type RecordedPlanDesignReview =
  | Readonly<{ status: "not-required"; reason: "skipped" }>
  | Readonly<{ status: "required" }>
  | AcceptedPlanDesignReview;

/**
 * The record as the gate reads it. A State File with no `plan_design_review`
 * field was initialized before the review existed: it reads as `not-required`
 * for the reason `unrecorded`, which is never written back.
 */
export type PlanDesignReview =
  | RecordedPlanDesignReview
  | Readonly<{ status: "not-required"; reason: "unrecorded" }>;

export const PLAN_DESIGN_REVIEW_REQUIRED = Object.freeze({ status: "required" } as const);
export const PLAN_DESIGN_REVIEW_SKIPPED = Object.freeze({ status: "not-required", reason: "skipped" } as const);
const PLAN_DESIGN_REVIEW_UNRECORDED = Object.freeze({ status: "not-required", reason: "unrecorded" } as const);

/** The gate's reading of the stored field: an absent field is `unrecorded`. */
export const planDesignReviewOf = (recorded: RecordedPlanDesignReview | undefined): PlanDesignReview =>
  recorded ?? PLAN_DESIGN_REVIEW_UNRECORDED;

/** Parse the persisted record: one of three exact shapes, digests and Run id proven. */
export function parsePlanDesignReview(raw: unknown): DomainResult<RecordedPlanDesignReview, string> {
  if (!isRecord(raw)) return failure("plan_design_review must be an object");
  if (raw.status === "required") {
    return hasExactKeys(raw, ["status"])
      ? success(PLAN_DESIGN_REVIEW_REQUIRED)
      : failure("plan_design_review required shape must be exactly {status}");
  }
  if (raw.status === "not-required") {
    return hasExactKeys(raw, ["status", "reason"]) && raw.reason === "skipped"
      ? success(PLAN_DESIGN_REVIEW_SKIPPED)
      : failure("plan_design_review not-required shape must be exactly {status, reason:'skipped'}");
  }
  if (raw.status !== "accepted") {
    return failure("plan_design_review status must be 'not-required', 'required' or 'accepted'");
  }
  if (!hasExactKeys(raw, ["status", "planSha256", "runId", "resultDigest"])) {
    return failure("plan_design_review accepted shape must be exactly {status, planSha256, runId, resultDigest}");
  }
  const planSha256 = parseArtifactDigest(raw.planSha256);
  if (!planSha256.ok) return failure(`plan_design_review.planSha256: ${planSha256.error.message}`);
  const runId = parseOrchestrationRunId(raw.runId);
  if (!runId.ok) return failure(`plan_design_review.runId: ${runId.error.message}`);
  const resultDigest = parseArtifactDigest(raw.resultDigest);
  if (!resultDigest.ok) return failure(`plan_design_review.resultDigest: ${resultDigest.error.message}`);
  return success(Object.freeze({
    status: "accepted" as const,
    planSha256: planSha256.value,
    runId: runId.value,
    resultDigest: resultDigest.value,
  }));
}

// ---------------------------------------------------------------------------
// The decompose gate
// ---------------------------------------------------------------------------

export type PlanDesignGate =
  | Readonly<{ kind: "open" }>
  | Readonly<{ kind: "review-required" }>
  | Readonly<{ kind: "plan-changed"; acceptedSha256: ArtifactDigest; currentSha256: string }>;

const GATE_OPEN: PlanDesignGate = Object.freeze({ kind: "open" });
const GATE_REVIEW_REQUIRED: PlanDesignGate = Object.freeze({ kind: "review-required" });

/**
 * Whether decompose may start. It may when no review is required, or when the
 * accepted review's digest is the digest of the plan as it is now.
 */
export function planDesignGate(review: PlanDesignReview, currentPlanSha256: string): PlanDesignGate {
  return match(review)
    .with({ status: "not-required" }, () => GATE_OPEN)
    .with({ status: "required" }, () => GATE_REVIEW_REQUIRED)
    .with({ status: "accepted" }, ({ planSha256 }): PlanDesignGate => planSha256 === currentPlanSha256
      ? GATE_OPEN
      : Object.freeze({ kind: "plan-changed", acceptedSha256: planSha256, currentSha256: currentPlanSha256 }))
    .exhaustive();
}

/** The helper that records an acceptance, as the gate and the docs name it. */
export const ACCEPT_PLAN_DESIGN_REVIEW_HELPER = "accept-plan-design-review";

const FIX =
  `run a ${PLAN_DESIGN_REVIEW_KIND} standalone review whose files are exactly that plan, then ` +
  `\`helper ${ACCEPT_PLAN_DESIGN_REVIEW_HELPER} --runs-root <runs root> --run <run>\` (/loom Phase 3.6)`;

/** What a closed gate requires, naming the plan and the way to open it. */
export function renderPlanDesignRequirement(gate: Exclude<PlanDesignGate, Readonly<{ kind: "open" }>>, planPath: string): string {
  return match(gate)
    .with({ kind: "review-required" }, () => `plan-design-review (${planPath} has no accepted design review: ${FIX})`)
    .with({ kind: "plan-changed" }, ({ acceptedSha256, currentSha256 }) =>
      `plan-design-review (${planPath} changed after its design review was accepted: reviewed sha256 ` +
      `${acceptedSha256}, now ${currentSha256}; the acceptance covers the reviewed bytes only: ${FIX})`)
    .exhaustive();
}

// ---------------------------------------------------------------------------
// Judging a completed review
// ---------------------------------------------------------------------------

/**
 * What an authenticated, published Standalone Review says about itself. Every
 * field is read from the Run Directory by the shell; nothing is self-reported
 * by the caller of the helper.
 */
export type PlanDesignEvidence = Readonly<{
  runId: OrchestrationRunId;
  resultDigest: ArtifactDigest;
  requestedKinds: readonly string[];
  /** The frozen scope in order, each path with the SHA-256 of its frozen bytes, or null when no bytes were frozen. */
  scope: readonly Readonly<{ path: string; sha256: string | null }>[];
  reviewers: readonly string[];
  /** Whether the Run was registered with the read obligation, so every reviewer was observed reading the whole plan. */
  readObligated: boolean;
  /** The Finding ids of the criticals the Refutation Panel left standing. */
  survivingCriticals: readonly string[];
  advisoryCount: number;
  /** Whether a published Advisory Disposition covering every advisory was presented. */
  dispositionPublished: boolean;
}>;

/** The plan as it is now: its repository-relative path and the SHA-256 of its bytes. */
export type CurrentPlan = Readonly<{ path: string; sha256: ArtifactDigest }>;

export type PlanDesignRefusal =
  | Readonly<{ kind: "wrong-kind"; requestedKinds: readonly string[] }>
  | Readonly<{ kind: "scope-mismatch"; scope: readonly string[]; planPath: string }>
  | Readonly<{ kind: "roster-incomplete"; missing: readonly PlanDesignReviewer[] }>
  | Readonly<{ kind: "read-not-obligated" }>
  | Readonly<{ kind: "plan-unobserved"; planPath: string }>
  | Readonly<{ kind: "plan-changed-since-review"; reviewedSha256: string; currentSha256: ArtifactDigest }>
  | Readonly<{ kind: "surviving-criticals"; findingIds: readonly string[] }>
  | Readonly<{ kind: "advisories-undisposed"; advisoryCount: number }>;

/**
 * Accept a completed review as the plan's design review, or say why not.
 *
 * It is accepted when it is a `plan-design` review of exactly the plan, by the
 * whole plan design roster under the read obligation, of the bytes the plan has now; no critical
 * survived refutation; and every advisory has a published disposition. A
 * surviving critical is resolved by editing the plan and reviewing it afresh,
 * so a result that still carries one is never accepted. Advisories do not
 * block: they need only a published decision.
 */
export function judgePlanDesignEvidence(
  evidence: PlanDesignEvidence,
  plan: CurrentPlan,
): DomainResult<AcceptedPlanDesignReview, PlanDesignRefusal> {
  if (evidence.requestedKinds.length !== 1 || evidence.requestedKinds[0] !== PLAN_DESIGN_REVIEW_KIND) {
    return failure({ kind: "wrong-kind", requestedKinds: evidence.requestedKinds });
  }
  const [reviewed, ...others] = evidence.scope;
  if (reviewed === undefined || others.length > 0 || reviewed.path !== plan.path) {
    return failure({ kind: "scope-mismatch", scope: evidence.scope.map(({ path }) => path), planPath: plan.path });
  }
  const missing = PLAN_DESIGN_REVIEWERS.filter((role) => !evidence.reviewers.includes(role));
  if (missing.length > 0) return failure({ kind: "roster-incomplete", missing });
  if (!evidence.readObligated) return failure({ kind: "read-not-obligated" });
  if (reviewed.sha256 === null) return failure({ kind: "plan-unobserved", planPath: plan.path });
  if (reviewed.sha256 !== plan.sha256) {
    return failure({ kind: "plan-changed-since-review", reviewedSha256: reviewed.sha256, currentSha256: plan.sha256 });
  }
  if (evidence.survivingCriticals.length > 0) {
    return failure({ kind: "surviving-criticals", findingIds: evidence.survivingCriticals });
  }
  if (evidence.advisoryCount > 0 && !evidence.dispositionPublished) {
    return failure({ kind: "advisories-undisposed", advisoryCount: evidence.advisoryCount });
  }
  return success(Object.freeze({
    status: "accepted" as const,
    planSha256: plan.sha256,
    runId: evidence.runId,
    resultDigest: evidence.resultDigest,
  }));
}

/** One refusal as the operator reads it, naming what to do next. */
export function renderPlanDesignRefusal(refusal: PlanDesignRefusal): string {
  return match(refusal)
    .with({ kind: "wrong-kind" }, ({ requestedKinds }) =>
      `the review's kind is ${JSON.stringify(requestedKinds)}, not exactly ["${PLAN_DESIGN_REVIEW_KIND}"]; ` +
      `start a ${PLAN_DESIGN_REVIEW_KIND} standalone review of the plan`)
    .with({ kind: "scope-mismatch" }, ({ scope, planPath }) =>
      `the review's frozen scope is ${JSON.stringify(scope)}, not exactly the plan ["${planPath}"]; ` +
      `start a ${PLAN_DESIGN_REVIEW_KIND} standalone review whose files are exactly that plan`)
    .with({ kind: "roster-incomplete" }, ({ missing }) =>
      `the review ran without ${missing.join(", ")}; a plan design review needs ${PLAN_DESIGN_REVIEWERS.join(", ")}: ` +
      `start a fresh ${PLAN_DESIGN_REVIEW_KIND} standalone review`)
    .with({ kind: "read-not-obligated" }, () =>
      "the review was registered without the read obligation, so no reviewer was observed reading the plan; " +
      `start a fresh ${PLAN_DESIGN_REVIEW_KIND} standalone review`)
    .with({ kind: "plan-unobserved" }, ({ planPath }) =>
      `the review froze no bytes for ${planPath}; review the plan as it exists on disk`)
    .with({ kind: "plan-changed-since-review" }, ({ reviewedSha256, currentSha256 }) =>
      `the plan changed after it was reviewed (reviewed sha256 ${reviewedSha256}, now ${currentSha256}); ` +
      `start a fresh ${PLAN_DESIGN_REVIEW_KIND} standalone review of the edited plan`)
    .with({ kind: "surviving-criticals" }, ({ findingIds }) =>
      `${findingIds.length} critical finding(s) survived refutation (${findingIds.join(", ")}); ` +
      `edit the plan to resolve them and start a fresh ${PLAN_DESIGN_REVIEW_KIND} standalone review`)
    .with({ kind: "advisories-undisposed" }, ({ advisoryCount }) =>
      `${advisoryCount} advisory finding(s) have no published disposition; publish a standalone-disposition ` +
      "for this review and pass --disposition, --disposition-run and --disposition-digest")
    .exhaustive();
}

// ---------------------------------------------------------------------------
// The reviewer lens
// ---------------------------------------------------------------------------

/** The byte-section label of the plan design lens in a `plan-design` review packet. */
export const PLAN_DESIGN_LENS_SECTION = "plan-design-lens";

const LENS_QUESTIONS = {
  "code-reviewer": [
    "Does the plan contradict itself, the specification it implements, or the project's stated rules and glossary?",
    "Does every requirement the plan claims to cover have a named component, and every component a requirement?",
    "Is each failure path decided (what is refused, by whom, with what result), or left to the implementer?",
    "Does a decision rest on a fact about the existing code that the code does not bear out?",
  ],
  "type-design-analyzer": [
    "Can the declared types represent a state the plan calls impossible? Name the illegal value.",
    "Is each invariant carried by a type (an ADT, a branded value, a parser's result) or only by a comment or a convention?",
    "Where does untrusted data become a typed value, and does every such boundary parse rather than validate and cast?",
    "Does a lifecycle the plan describes have one closed set of states and transitions, or loose flags that can disagree?",
  ],
  "architecture-tech-lead": [
    "Is the decision logic a pure core with I/O at the boundary, or does a rule sit inside a shell where only an integration test reaches it?",
    "Does each rule have exactly one owner module? Name any rule the plan implements in two places.",
    "Are the modules deep (a small interface over real behaviour), with dependencies pointing one way?",
    "Is shared state written by one writer, and is each concurrent or resumed path safe to repeat?",
    "Can each component be tested through its interface without mocks?",
  ],
} as const satisfies Readonly<Record<PlanDesignReviewer, readonly string[]>>;

const isPlanDesignReviewer = (role: string): role is PlanDesignReviewer =>
  (PLAN_DESIGN_REVIEWERS as readonly string[]).includes(role);

/** The lens section text for one plan design reviewer. */
export function renderPlanDesignLens(role: PlanDesignReviewer): string {
  return [
    "## Plan design review (engine-issued)",
    "The frozen scope is an architecture plan: a design that has no code yet. Review the design it commits the " +
      "implementation to, before Tasks are cut from it. Wording, formatting and document structure are not findings.",
    `### Your lens: ${role}`,
    LENS_QUESTIONS[role].map((question) => `- ${question}`).join("\n"),
    "### Severity",
    "Rate a finding critical when the plan, built as written, yields an implementation that is wrong, unsafe or cannot " +
      "be built: name the plan section and the concrete consequence. Rate it advisory when the design works but a better " +
      "one is available. The existing severity rubric and the Refutation Panel apply unchanged.",
    "Locate every finding in the plan file, at the line of the decision it concerns.",
  ].join("\n\n") + "\n";
}

/**
 * The lens section a reviewer's packet carries, or null when the review is not
 * a plan design review or the role is outside its roster.
 */
export function planDesignLens(requestedKinds: readonly string[], role: string): string | null {
  return requestedKinds.includes(PLAN_DESIGN_REVIEW_KIND) && isPlanDesignReviewer(role)
    ? renderPlanDesignLens(role)
    : null;
}
