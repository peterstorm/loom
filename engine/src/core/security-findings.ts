/**
 * The vulnerability verdict vocabulary: `confirmed`, `needs_validation`,
 * `rejected` — and the consolidation rules that keep one root cause to one
 * record.
 *
 * The three verdicts have deliberately asymmetric contracts, and the
 * asymmetry is enforced here rather than described:
 *
 * - `confirmed` needs a bounded observed result, a demonstrated impact and a
 *   severity whose overall score never exceeds that impact;
 * - `needs_validation` is a source-grounded hypothesis blocked on an exact
 *   fact. It carries NO severity and no remediation: a lead with a severity is
 *   a finding wearing a disclaimer;
 * - `rejected` is retained with its reason so a later run must bring changed
 *   evidence rather than re-report a disproved claim.
 *
 * The schemas below are the one statement of each shape: the types are derived
 * from them, the key sets are theirs, and the cross-field rules (trace order,
 * severity-vs-impact, a plan to validate, fingerprint order) are refinements
 * attached to the smallest shape they constrain.
 *
 * Provenance: this is a port of `report-schema.json` and
 * `validate-findings.cjs` from `cloudflare/security-audit-skill@c1c8a8c`.
 * `engine/tests/security/security-oracle.test.ts` runs both parsers over one
 * corpus and fails when they disagree about a document's validity.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { z } from "zod/v4";
import { compareStrings } from "./ordering";
import { failure, success, type DomainResult } from "./orchestration-contract/identity";
import {
  SECURITY_AUDIT_LIMITS,
  expecting,
  fingerprintSchema,
  hasVisibleProse,
  isWireRecord,
  listOf,
  nonEmptyListOf,
  parseWire,
  positiveIntegerSchema,
  sourcePathSchema,
  type WireViolation,
} from "./security-audit-contract";

// --- Vocabulary ---

export const SEVERITY_SCORES = ["informational", "low", "medium", "high", "critical"] as const;
export type SeverityScore = (typeof SEVERITY_SCORES)[number];

const SEVERITY_RANK: Readonly<Record<SeverityScore, number>> = {
  informational: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const CONFIDENCE_SCORES = ["low", "medium", "high"] as const;
export type ConfidenceScore = (typeof CONFIDENCE_SCORES)[number];

export const CONDITION_KINDS = [
  "authentication_level",
  "authorization_role",
  "user_interaction",
  "system_configuration",
  "network_routing",
  "environmental_dependency",
  "data_state",
  "timing_dependency",
  "third_party_dependency",
] as const;
export type ConditionKind = (typeof CONDITION_KINDS)[number];

export const TRACE_KINDS = ["entrypoint", "propagation", "sink"] as const;
export type TraceKind = (typeof TRACE_KINDS)[number];

/** Stable canonical key for structural uniqueness: sorted keys, typed leaves. */
function canonicalKey(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalKey).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${canonicalKey(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// --- Field schemas ---

/** Upstream's `visibleContent`: at least one character a reader can see. Not
 *  trimmed and not length-bounded — upstream's report schema bounds neither. */
const proseSchema = z.custom<string>(
  (value) => typeof value === "string" && value.length > 0 && hasVisibleProse(value),
  expecting("expected visible prose"),
);

const enumOf = <const Values extends readonly [string, ...string[]]>(values: Values) =>
  z.enum(values, expecting(`expected one of ${values.join(", ")}`));

/** Upstream's unique array: within the collection limit, no two entries
 *  structurally equal — and, for every list but `conditions`, never empty. */
const uniqueList = <Entry extends z.ZodType>(entry: Entry) => listOf(entry, canonicalKey);
const uniqueNonEmptyList = <Entry extends z.ZodType>(entry: Entry) => nonEmptyListOf(entry, canonicalKey);

const traceStepSchema = z
  .strictObject({
    kind: z.enum(TRACE_KINDS, expecting("expected entrypoint, propagation or sink")),
    file: sourcePathSchema,
    line: positiveIntegerSchema,
    scope: proseSchema,
    description: proseSchema,
  })
  .readonly();
export type TraceStep = z.output<typeof traceStepSchema>;

/** A trace runs entrypoint → propagation… → sink. A one-step trace is the
 *  entrypoint or the sink itself. */
const traceSchema = uniqueNonEmptyList(traceStepSchema).superRefine((steps, ctx) => {
  if (steps.length === 1) {
    if (steps[0].kind === "propagation") {
      ctx.addIssue({ code: "custom", path: [0, "kind"], message: "a one-step trace must be entrypoint or sink" });
    }
    return;
  }
  steps.forEach((step, index) => {
    const expected: TraceKind = index === 0 ? "entrypoint" : index === steps.length - 1 ? "sink" : "propagation";
    if (step.kind !== expected) ctx.addIssue({ code: "custom", path: [index, "kind"], message: `must be ${expected}` });
  });
});

const evidenceEntrySchema = z.strictObject({ file: sourcePathSchema, line: positiveIntegerSchema, description: proseSchema }).readonly();
export type EvidenceEntry = z.output<typeof evidenceEntrySchema>;

const conditionSchema = z.strictObject({ kind: enumOf(CONDITION_KINDS), description: proseSchema }).readonly();
export type Condition = z.output<typeof conditionSchema>;

/** The bounded run that demonstrated the result: who attacked, with what, how,
 *  and what was observed. */
const executionSchema = z
  .strictObject({
    attacker_perspective: proseSchema,
    payloads: uniqueNonEmptyList(z.string(expecting("expected a string"))),
    instructions: uniqueNonEmptyList(proseSchema),
    observed_result: proseSchema,
  })
  .readonly();
export type Execution = z.output<typeof executionSchema>;

const codeChangeSchema = z.strictObject({ file_name: sourcePathSchema, fixed_code: z.string(expecting("expected a string")) }).readonly();
export type CodeChange = z.output<typeof codeChangeSchema>;

/** The fix strategy, with optional code changes that each name a safe file. */
const remediationSchema = z
  .strictObject({ strategy: proseSchema, code_changes: z.array(codeChangeSchema).readonly().optional() })
  .readonly();
export type Remediation = z.output<typeof remediationSchema>;

const scoredReason = <const Scores extends readonly [string, ...string[]]>(scores: Scores) =>
  z.strictObject({ score: enumOf(scores), reason: proseSchema }).readonly();
export type ScoredReason = z.output<ReturnType<typeof scoredReason<typeof SEVERITY_SCORES>>>;

/** Likelihood and impact with reasons, and an overall severity that never
 *  exceeds the demonstrated impact. */
const severitySchema = z
  .strictObject({
    likelihood: scoredReason(SEVERITY_SCORES),
    impact: scoredReason(SEVERITY_SCORES),
    overall_severity: enumOf(SEVERITY_SCORES),
  })
  .superRefine((severity, ctx) => {
    if (SEVERITY_RANK[severity.overall_severity] > SEVERITY_RANK[severity.impact.score]) {
      ctx.addIssue({ code: "custom", path: ["overall_severity"], message: `cannot exceed demonstrated impact ${severity.impact.score}` });
    }
  })
  .readonly();
export type Severity = z.output<typeof severitySchema>;

const confidenceSchema = scoredReason(CONFIDENCE_SCORES);
export type Confidence = z.output<typeof confidenceSchema>;

/** At least one way to settle the lead: locally, or in a deployment. */
const validationPlanSchema = z
  .strictObject({ local: proseSchema.optional(), deployment: proseSchema.optional() })
  .superRefine((plan, ctx) => {
    if (plan.local === undefined && plan.deployment === undefined) {
      ctx.addIssue({ code: "custom", message: "requires at least one local or deployment plan" });
    }
  })
  .readonly();
export type ValidationPlan = z.output<typeof validationPlanSchema>;

// --- The three verdicts ---

/** Each verdict's exact key set: every key required, no other allowed. A key
 *  another verdict carries (a lead with a `severity`) is refused by name: "not
 *  a field of a needs_validation finding". */
const verdictShape = <const Verdict extends string, const Shape extends z.ZodRawShape>(verdict: Verdict, shape: Shape) =>
  z.strictObject(
    { verdict: z.literal(verdict), fingerprint: fingerprintSchema, title: proseSchema, description: proseSchema, ...shape },
    { error: (issue) => (issue.code === "unrecognized_keys" ? `not a field of a ${verdict} finding` : undefined) },
  );

const confirmedFindingShape = verdictShape("confirmed", {
  root_cause: proseSchema,
  intended_behavior: proseSchema,
  trace: traceSchema,
  evidence: uniqueNonEmptyList(evidenceEntrySchema),
  conditions: uniqueList(conditionSchema),
  execution: executionSchema,
  remediation: remediationSchema,
  severity: severitySchema,
  confidence: confidenceSchema,
});

const needsValidationFindingShape = verdictShape("needs_validation", {
  claimed_root_cause: proseSchema,
  trace: traceSchema,
  evidence: uniqueNonEmptyList(evidenceEntrySchema),
  blockers: uniqueNonEmptyList(proseSchema),
  validation_plan: validationPlanSchema,
});

const rejectedFindingShape = verdictShape("rejected", {
  claimed_root_cause: proseSchema,
  trace: traceSchema,
  evidence: uniqueNonEmptyList(evidenceEntrySchema),
  reason: proseSchema,
});

const securityFindingSchema = z
  .discriminatedUnion("verdict", [confirmedFindingShape, needsValidationFindingShape, rejectedFindingShape], {
    error: (issue) => (isWireRecord(issue.input) ? "expected one of confirmed, needs_validation, rejected" : "expected an object"),
  })
  .readonly();

export type SecurityFinding = z.output<typeof securityFindingSchema>;
export type ConfirmedFinding = Extract<SecurityFinding, Readonly<{ verdict: "confirmed" }>>;
export type NeedsValidationFinding = Extract<SecurityFinding, Readonly<{ verdict: "needs_validation" }>>;
export type RejectedFinding = Extract<SecurityFinding, Readonly<{ verdict: "rejected" }>>;

/**
 * A `security-findings.json` document: at most `findings` records, each
 * fingerprint once, in lexicographic fingerprint order.
 */
export const securityFindingsSchema = z
  .array(securityFindingSchema, expecting("expected a top-level array"))
  .max(SECURITY_AUDIT_LIMITS.findings, `exceeds ${SECURITY_AUDIT_LIMITS.findings} findings`)
  .superRefine((findings, ctx) => {
    const first = new Map<string, number>();
    findings.forEach((finding, index) => {
      const previous = first.get(finding.fingerprint);
      if (previous === undefined) first.set(finding.fingerprint, index);
      else ctx.addIssue({ code: "custom", path: [index, "fingerprint"], message: `duplicate of the fingerprint at index ${previous}` });
      const before = findings[index - 1];
      if (before !== undefined && compareStrings(before.fingerprint, finding.fingerprint) > 0) {
        ctx.addIssue({ code: "custom", path: [index, "fingerprint"], message: "findings must be sorted lexicographically" });
      }
    });
  })
  .readonly();

/** The findings volume's name for the shared wire diagnostic. */
export type FindingViolation = WireViolation;
export type FindingsError = Readonly<{ kind: "invalid-security-findings"; violations: readonly FindingViolation[] }>;

/**
 * Parse and fully validate a `security-findings.json` document. Validity here
 * is exactly the document contract: shape, field semantics, trace ordering,
 * severity-vs-impact, per-verdict exclusion, sort and uniqueness. It says
 * nothing about whether the claims are true — that is what the refutation panel
 * is for. The value returned is the parser's own deep-frozen copy, never the
 * caller's document.
 */
export function parseSecurityFindings(raw: unknown): DomainResult<readonly SecurityFinding[], FindingsError> {
  const parsed = parseWire(securityFindingsSchema, raw);
  return parsed.ok ? parsed : failure({ kind: "invalid-security-findings", violations: parsed.error });
}

/** Records in canonical order: lexicographic by fingerprint. The one ordering
 *  every published document and adjudication result uses. */
export const sortByFingerprint = <T extends Readonly<{ fingerprint: string }>>(items: readonly T[]): readonly T[] =>
  [...items].sort((left, right) => compareStrings(left.fingerprint, right.fingerprint));

// --- Consolidation ---

/** The sink a finding lands on, as `file:line`: the one fact two hunters
 *  describing the same defect from different entry points cannot disagree about.
 *  `null` when the trace names no sink. */
const sinkOf = (finding: SecurityFinding): string | null => {
  const sink = finding.trace.find((step) => step.kind === "sink");
  return sink === undefined ? null : `${sink.file}:${sink.line}`;
};

/** How much standing a verdict has when two filings describe ONE defect (same
 *  sink, same root-cause sentence). A `confirmed` claim outranks a lead, and a
 *  lead outranks a rejection: the three verdicts are different claims about one
 *  defect, not versions of one claim — so "keep the longer trace" alone let a
 *  three-step `rejected` filing replace a confirmed vulnerability and drop its
 *  severity from the published set. */
const VERDICT_STRENGTH: Readonly<Record<SecurityFinding["verdict"], number>> = {
  confirmed: 2,
  needs_validation: 1,
  rejected: 0,
};

/** The keeper between two filings of one defect: the strongest verdict, then the
 *  most complete trace, then the earlier fingerprint (candidates arrive in
 *  fingerprint order, so the last tie-break keeps the first one seen). */
function outranks(candidate: SecurityFinding, existing: SecurityFinding): boolean {
  const strength = VERDICT_STRENGTH[candidate.verdict] - VERDICT_STRENGTH[existing.verdict];
  if (strength !== 0) return strength > 0;
  if (candidate.trace.length !== existing.trace.length) return candidate.trace.length > existing.trace.length;
  return compareStrings(candidate.fingerprint, existing.fingerprint) < 0;
}

/** The defect identity two filings share when they describe one defect from
 *  different entry points: the sink and the root-cause sentence. `null` when the
 *  trace names no sink — such a record is never merged away. */
const causeKey = (finding: SecurityFinding): string | null => {
  const sink = sinkOf(finding);
  if (sink === null) return null;
  const rootCause = "root_cause" in finding ? finding.root_cause : finding.claimed_root_cause;
  return `${sink}\u0000${rootCause}`;
};

/** A filing consolidation dropped because another record describes the same
 *  defect: the absorbed fingerprint and the fingerprint of the record that was
 *  kept in its place. */
export type Absorption = Readonly<{ fingerprint: string; keptAs: string }>;

/** What consolidation keeps, and every filing it absorbed into a kept record —
 *  so no caller can lose a claim without being able to say where it went. */
export type Consolidation<T> = Readonly<{ kept: readonly T[]; absorbed: readonly Absorption[] }>;

/** One root cause, one record — where "one root cause" is a fact, not a
 *  sentence. Fingerprints are the identity; the root-cause TEXT catches the case
 *  where two hunters described one defect from different entry points and earned
 *  different fingerprints. Text alone is not enough: a terse hunter can paste one
 *  root-cause sentence onto two different defects, and merging those would silently
 *  drop a finding from the published set. So a root-cause merge also requires the
 *  same SINK, and a trace that names no sink is never merged away. The keeper is
 *  the record with the strongest verdict, then the most complete trace, tie-broken
 *  by fingerprint so the choice is deterministic.
 *
 *  A `pinned` fingerprint is never merged away: it is a record the run already
 *  holds (and a verifier may already have balloted, a unit may already list), so
 *  a later filing of the same defect yields to it whatever its verdict or trace.
 *
 *  Every record merged away is reported in `absorbed` with the fingerprint that
 *  was kept for its defect (followed to the FINAL keeper when a later record
 *  displaced an earlier one), sorted by fingerprint. */
export function consolidateCandidates<T extends SecurityFinding>(
  candidates: readonly T[],
  pinned: ReadonlySet<string> = new Set(),
): Consolidation<T> {
  const byFingerprint = new Map<string, T>();
  for (const candidate of candidates) {
    if (!byFingerprint.has(candidate.fingerprint)) byFingerprint.set(candidate.fingerprint, candidate);
  }
  // Keyed by cause for a mergeable record, by fingerprint for one that is kept
  // whatever else shares its cause (no sink, or pinned). A cause key carries a
  // NUL, which no fingerprint can, so the two key spaces never collide.
  const kept = new Map<string, T>();
  const pinnedKeeper = new Map<string, string>();
  const absorbedInto = new Map<string, string>();
  for (const candidate of [...byFingerprint.values()].sort((left, right) => compareStrings(left.fingerprint, right.fingerprint))) {
    const cause = causeKey(candidate);
    if (cause === null) {
      kept.set(candidate.fingerprint, candidate);
      continue;
    }
    if (pinned.has(candidate.fingerprint)) {
      const displaced = kept.get(cause);
      if (displaced !== undefined) absorbedInto.set(displaced.fingerprint, candidate.fingerprint);
      kept.delete(cause);
      pinnedKeeper.set(cause, candidate.fingerprint);
      kept.set(candidate.fingerprint, candidate);
      continue;
    }
    const keeper = pinnedKeeper.get(cause);
    if (keeper !== undefined) {
      absorbedInto.set(candidate.fingerprint, keeper);
      continue;
    }
    const existing = kept.get(cause);
    if (existing === undefined) {
      kept.set(cause, candidate);
    } else if (outranks(candidate, existing)) {
      absorbedInto.set(existing.fingerprint, candidate.fingerprint);
      kept.set(cause, candidate);
    } else {
      absorbedInto.set(candidate.fingerprint, existing.fingerprint);
    }
  }
  const finalKeeper = (fingerprint: string): string => {
    const next = absorbedInto.get(fingerprint);
    return next === undefined ? fingerprint : finalKeeper(next);
  };
  return {
    kept: [...kept.values()].sort((left, right) => compareStrings(left.fingerprint, right.fingerprint)),
    absorbed: [...absorbedInto.keys()].sort(compareStrings).map((fingerprint) => ({ fingerprint, keptAs: finalKeeper(fingerprint) })),
  };
}

// --- Filing ---

/** A submit re-filed fingerprints the run already holds, with different
 *  content. Every conflicting fingerprint is named, so one correction fixes the
 *  whole submit. */
export type FindingConflict = Readonly<{
  kind: "conflicting-refiling";
  fingerprints: readonly string[];
  message: string;
}>;

export type FilingRefusal = FindingConflict | FindingsError;

/** The document a submit leaves the run holding, and every filed record that
 *  consolidation absorbed into a record the run already held (or into another
 *  filing) — reported, so a hunter learns its claim was absorbed, not recorded. */
export type FilingOutcome = Readonly<{ findings: readonly SecurityFinding[]; absorbed: readonly Absorption[] }>;

/**
 * Fold a hunter's filed records into the run's candidates, then consolidate.
 *
 * - A filed record the run already holds VERBATIM (same fields, whatever their
 *   key order) is kept once: a submit retried after a failed ledger write
 *   re-files exactly what the first attempt wrote, and must converge rather than
 *   be refused for a duplicate.
 * - A filed record whose fingerprint the run already holds with DIFFERENT
 *   content is REFUSED, naming every such fingerprint. The run's record is the
 *   one verification adjudicates; keeping it while dropping the new one would
 *   lose a hunter's claim without a word, and replacing it would let a later
 *   filing rewrite a claim a verifier may already have balloted.
 *
 * One root cause, one record: consolidation runs before the final parse, so the
 * returned document is exactly what the run will hold. The run's existing
 * records are PINNED in it: a fresh filing of the same defect (same sink, same
 * root cause) under a new fingerprint yields to the record the run already
 * holds, so the record verification adjudicates — and that a unit's
 * `result_fingerprints` may already list — is never displaced. Each such
 * filing comes back in `absorbed`, naming the record kept in its place.
 */
export function fileCandidates(
  existing: readonly SecurityFinding[],
  filed: readonly SecurityFinding[],
): DomainResult<FilingOutcome, FilingRefusal> {
  const held = new Map(existing.map((finding) => [finding.fingerprint, canonicalKey(finding)]));
  const conflicts = filed
    .filter((finding) => {
      const prior = held.get(finding.fingerprint);
      return prior !== undefined && prior !== canonicalKey(finding);
    })
    .map((finding) => finding.fingerprint);
  if (conflicts.length > 0) {
    return failure({
      kind: "conflicting-refiling" as const,
      fingerprints: conflicts,
      message:
        `the run already holds a different record for ${conflicts.join(", ")} — omit ${conflicts.length === 1 ? "it" : "them"} ` +
        "from this submit, or re-file byte-identical; verification adjudicates the record the run already holds",
    });
  }
  const fresh = filed.filter((finding) => !held.has(finding.fingerprint));
  const consolidated = consolidateCandidates(sortByFingerprint([...existing, ...fresh]), new Set(held.keys()));
  const findings = parseSecurityFindings(consolidated.kept);
  return findings.ok ? success({ findings: findings.value, absorbed: consolidated.absorbed }) : findings;
}
