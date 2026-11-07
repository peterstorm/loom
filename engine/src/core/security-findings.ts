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
 * Provenance: this is a port of `report-schema.json` and
 * `validate-findings.cjs` from `cloudflare/security-audit-skill@c1c8a8c`.
 * `engine/tests/security/security-oracle.test.ts` runs both parsers over one
 * corpus and fails when they disagree about a document's validity.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { compareStrings } from "./ordering";
import { failure, success, type DomainResult } from "./orchestration-contract/identity";
import { SECURITY_AUDIT_LIMITS, hasVisibleProse, isSafeSourcePath, isSecurityFingerprint } from "./security-audit-contract";

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

export type TraceStep = Readonly<{
  kind: TraceKind;
  file: string;
  line: number;
  scope: string;
  description: string;
}>;

export type EvidenceEntry = Readonly<{ file: string; line: number; description: string }>;
export type Condition = Readonly<{ kind: ConditionKind; description: string }>;

export type Execution = Readonly<{
  attacker_perspective: string;
  payloads: readonly string[];
  instructions: readonly string[];
  observed_result: string;
}>;

export type CodeChange = Readonly<{ file_name: string; fixed_code: string }>;
export type Remediation = Readonly<{ strategy: string; code_changes?: readonly CodeChange[] }>;
export type ScoredReason = Readonly<{ score: SeverityScore; reason: string }>;
export type Severity = Readonly<{
  likelihood: ScoredReason;
  impact: ScoredReason;
  overall_severity: SeverityScore;
}>;
export type Confidence = Readonly<{ score: ConfidenceScore; reason: string }>;

export type ConfirmedFinding = Readonly<{
  verdict: "confirmed";
  fingerprint: string;
  title: string;
  description: string;
  root_cause: string;
  intended_behavior: string;
  trace: readonly TraceStep[];
  evidence: readonly EvidenceEntry[];
  conditions: readonly Condition[];
  execution: Execution;
  remediation: Remediation;
  severity: Severity;
  confidence: Confidence;
}>;

export type ValidationPlan = Readonly<{ local?: string; deployment?: string }>;

export type NeedsValidationFinding = Readonly<{
  verdict: "needs_validation";
  fingerprint: string;
  title: string;
  description: string;
  claimed_root_cause: string;
  trace: readonly TraceStep[];
  evidence: readonly EvidenceEntry[];
  blockers: readonly string[];
  validation_plan: ValidationPlan;
}>;

export type RejectedFinding = Readonly<{
  verdict: "rejected";
  fingerprint: string;
  title: string;
  description: string;
  claimed_root_cause: string;
  trace: readonly TraceStep[];
  evidence: readonly EvidenceEntry[];
  reason: string;
}>;

export type SecurityFinding = ConfirmedFinding | NeedsValidationFinding | RejectedFinding;

export type FindingViolation = Readonly<{ path: string; message: string }>;
export type FindingsError = Readonly<{ kind: "invalid-security-findings"; violations: readonly FindingViolation[] }>;

const violation = (path: string, message: string): FindingViolation => ({ path, message });
const invalid = (violations: readonly FindingViolation[]): FindingsError => ({
  kind: "invalid-security-findings",
  violations,
});

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Upstream's `visibleContent`: at least one character a reader can see. */
const isVisible = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && hasVisibleProse(value);

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

function checkKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
  violations: FindingViolation[],
): void {
  for (const key of required) {
    if (!(key in record)) violations.push(violation(`${path}.${key}`, "required"));
  }
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) violations.push(violation(`${path}.${key}`, "unexpected property"));
  }
}

function checkVisible(record: Record<string, unknown>, key: string, path: string, violations: FindingViolation[]): void {
  if (key in record && !isVisible(record[key])) violations.push(violation(`${path}.${key}`, "expected visible prose"));
}

function checkUniqueArray(value: unknown, path: string, violations: FindingViolation[], minimum = 0): void {
  if (!Array.isArray(value)) {
    violations.push(violation(path, "expected an array"));
    return;
  }
  if (value.length > SECURITY_AUDIT_LIMITS.collectionItems) violations.push(violation(path, "too many entries"));
  if (value.length < minimum) violations.push(violation(path, `expected at least ${minimum} entry(ies)`));
  const seen = new Set<string>();
  for (const entry of value) {
    const key = canonicalKey(entry);
    if (seen.has(key)) violations.push(violation(path, "duplicate entry"));
    seen.add(key);
  }
}

function checkTrace(value: unknown, path: string, violations: FindingViolation[]): void {
  checkUniqueArray(value, path, violations, 1);
  if (!Array.isArray(value)) return;
  value.forEach((entry, index) => {
    const base = `${path}[${index}]`;
    if (!isRecord(entry)) {
      violations.push(violation(base, "expected an object"));
      return;
    }
    checkKeys(entry, ["kind", "file", "line", "scope", "description"], ["kind", "file", "line", "scope", "description"], base, violations);
    if (!isOneOf(TRACE_KINDS, entry.kind)) violations.push(violation(`${base}.kind`, "expected entrypoint, propagation or sink"));
    if (!isSafeSourcePath(entry.file)) violations.push(violation(`${base}.file`, "expected a repository-relative source path"));
    if (!Number.isInteger(entry.line) || (entry.line as number) < 1) violations.push(violation(`${base}.line`, "expected a positive integer"));
    checkVisible(entry, "scope", base, violations);
    checkVisible(entry, "description", base, violations);
  });

  const steps = value.filter(isRecord);
  if (steps.length === 1) {
    const only = steps[0].kind;
    if (only !== "entrypoint" && only !== "sink") {
      violations.push(violation(`${path}[0].kind`, "a one-step trace must be entrypoint or sink"));
    }
    return;
  }
  if (steps.length > 1) {
    if (steps[0].kind !== "entrypoint") violations.push(violation(`${path}[0].kind`, "must be entrypoint"));
    steps.slice(1).forEach((step, offset) => {
      if (offset === steps.length - 2) {
        if (step.kind !== "sink") violations.push(violation(`${path}[${offset + 1}].kind`, "must be sink"));
      } else if (step.kind !== "propagation") {
        violations.push(violation(`${path}[${offset + 1}].kind`, "must be propagation"));
      }
    });
  }
}

function checkEvidence(value: unknown, path: string, violations: FindingViolation[]): void {
  checkUniqueArray(value, path, violations, 1);
  if (!Array.isArray(value)) return;
  value.forEach((entry, index) => {
    const base = `${path}[${index}]`;
    if (!isRecord(entry)) {
      violations.push(violation(base, "expected an object"));
      return;
    }
    checkKeys(entry, ["file", "line", "description"], ["file", "line", "description"], base, violations);
    if (!isSafeSourcePath(entry.file)) violations.push(violation(`${base}.file`, "expected a repository-relative source path"));
    if (!Number.isInteger(entry.line) || (entry.line as number) < 1) violations.push(violation(`${base}.line`, "expected a positive integer"));
    checkVisible(entry, "description", base, violations);
  });
}

function checkConditions(value: unknown, path: string, violations: FindingViolation[]): void {
  checkUniqueArray(value, path, violations);
  if (!Array.isArray(value)) return;
  value.forEach((entry, index) => {
    const base = `${path}[${index}]`;
    if (!isRecord(entry)) {
      violations.push(violation(base, "expected an object"));
      return;
    }
    checkKeys(entry, ["kind", "description"], ["kind", "description"], base, violations);
    if (!isOneOf(CONDITION_KINDS, entry.kind)) violations.push(violation(`${base}.kind`, "unknown condition kind"));
    checkVisible(entry, "description", base, violations);
  });
}

function checkScoredReason(value: unknown, path: string, scores: readonly string[], violations: FindingViolation[]): void {
  if (!isRecord(value)) {
    violations.push(violation(path, "expected an object"));
    return;
  }
  checkKeys(value, ["score", "reason"], ["score", "reason"], path, violations);
  if (!isOneOf(scores, value.score)) violations.push(violation(`${path}.score`, `expected one of ${scores.join(", ")}`));
  checkVisible(value, "reason", path, violations);
}

function checkConfirmed(record: Record<string, unknown>, path: string, violations: FindingViolation[]): void {
  const forbidden = ["claimed_root_cause", "blockers", "validation_plan", "reason"];
  for (const key of forbidden) {
    if (key in record) violations.push(violation(`${path}.${key}`, "confirmed findings must not carry this field"));
  }
  for (const key of ["title", "description", "root_cause", "intended_behavior"]) {
    checkVisible(record, key, path, violations);
  }
  checkTrace(record.trace, `${path}.trace`, violations);
  checkEvidence(record.evidence, `${path}.evidence`, violations);
  checkConditions(record.conditions, `${path}.conditions`, violations);

  const execution = record.execution;
  if (!isRecord(execution)) {
    violations.push(violation(`${path}.execution`, "expected an object"));
  } else {
    checkKeys(
      execution,
      ["attacker_perspective", "payloads", "instructions", "observed_result"],
      ["attacker_perspective", "payloads", "instructions", "observed_result"],
      `${path}.execution`,
      violations,
    );
    checkVisible(execution, "attacker_perspective", `${path}.execution`, violations);
    checkVisible(execution, "observed_result", `${path}.execution`, violations);
    checkUniqueArray(execution.payloads, `${path}.execution.payloads`, violations, 1);
    if (Array.isArray(execution.payloads)) {
      execution.payloads.forEach((payload, index) => {
        if (typeof payload !== "string") violations.push(violation(`${path}.execution.payloads[${index}]`, "expected a string"));
      });
    }
    checkUniqueArray(execution.instructions, `${path}.execution.instructions`, violations, 1);
    if (Array.isArray(execution.instructions)) {
      execution.instructions.forEach((instruction, index) => {
        if (!isVisible(instruction)) violations.push(violation(`${path}.execution.instructions[${index}]`, "expected visible prose"));
      });
    }
  }

  const remediation = record.remediation;
  if (!isRecord(remediation)) {
    violations.push(violation(`${path}.remediation`, "expected an object"));
  } else {
    checkKeys(remediation, ["strategy", "code_changes"], ["strategy"], `${path}.remediation`, violations);
    checkVisible(remediation, "strategy", `${path}.remediation`, violations);
    if ("code_changes" in remediation) {
      const changes = remediation.code_changes;
      if (!Array.isArray(changes)) {
        violations.push(violation(`${path}.remediation.code_changes`, "expected an array"));
      } else {
        changes.forEach((change, index) => {
          const base = `${path}.remediation.code_changes[${index}]`;
          if (!isRecord(change)) {
            violations.push(violation(base, "expected an object"));
            return;
          }
          checkKeys(change, ["file_name", "fixed_code"], ["file_name", "fixed_code"], base, violations);
          if (!isSafeSourcePath(change.file_name)) violations.push(violation(`${base}.file_name`, "expected a repository-relative source path"));
          if (typeof change.fixed_code !== "string") violations.push(violation(`${base}.fixed_code`, "expected a string"));
        });
      }
    }
  }

  const severity = record.severity;
  if (!isRecord(severity)) {
    violations.push(violation(`${path}.severity`, "expected an object"));
  } else {
    checkKeys(severity, ["likelihood", "impact", "overall_severity"], ["likelihood", "impact", "overall_severity"], `${path}.severity`, violations);
    checkScoredReason(severity.likelihood, `${path}.severity.likelihood`, SEVERITY_SCORES, violations);
    checkScoredReason(severity.impact, `${path}.severity.impact`, SEVERITY_SCORES, violations);
    if (!isOneOf(SEVERITY_SCORES, severity.overall_severity)) {
      violations.push(violation(`${path}.severity.overall_severity`, `expected one of ${SEVERITY_SCORES.join(", ")}`));
    } else {
      const impact = isRecord(severity.impact) && isOneOf(SEVERITY_SCORES, severity.impact.score) ? severity.impact.score : null;
      if (impact !== null && SEVERITY_RANK[severity.overall_severity] > SEVERITY_RANK[impact]) {
        violations.push(violation(`${path}.severity.overall_severity`, `cannot exceed demonstrated impact ${impact}`));
      }
    }
  }

  const confidence = record.confidence;
  if (!isRecord(confidence)) {
    violations.push(violation(`${path}.confidence`, "expected an object"));
  } else {
    checkScoredReason(confidence, `${path}.confidence`, CONFIDENCE_SCORES, violations);
  }
}

function checkNeedsValidation(record: Record<string, unknown>, path: string, violations: FindingViolation[]): void {
  for (const key of ["severity", "execution", "remediation", "reason", "root_cause"]) {
    if (key in record) violations.push(violation(`${path}.${key}`, "needs_validation findings must not carry this field"));
  }
  for (const key of ["title", "description", "claimed_root_cause"]) checkVisible(record, key, path, violations);
  checkTrace(record.trace, `${path}.trace`, violations);
  checkEvidence(record.evidence, `${path}.evidence`, violations);
  checkUniqueArray(record.blockers, `${path}.blockers`, violations, 1);
  if (Array.isArray(record.blockers)) {
    record.blockers.forEach((blocker, index) => {
      if (!isVisible(blocker)) violations.push(violation(`${path}.blockers[${index}]`, "expected visible prose"));
    });
  }
  const plan = record.validation_plan;
  if (!isRecord(plan)) {
    violations.push(violation(`${path}.validation_plan`, "expected an object"));
    return;
  }
  checkKeys(plan, ["local", "deployment"], [], `${path}.validation_plan`, violations);
  const hasLocal = isVisible(plan.local);
  const hasDeployment = isVisible(plan.deployment);
  for (const key of ["local", "deployment"]) {
    if (key in plan && !isVisible(plan[key])) violations.push(violation(`${path}.validation_plan.${key}`, "expected visible prose"));
  }
  if (!hasLocal && !hasDeployment) {
    violations.push(violation(`${path}.validation_plan`, "requires at least one local or deployment plan"));
  }
}

function checkRejected(record: Record<string, unknown>, path: string, violations: FindingViolation[]): void {
  for (const key of ["severity", "execution", "remediation", "blockers", "validation_plan", "root_cause"]) {
    if (key in record) violations.push(violation(`${path}.${key}`, "rejected findings must not carry this field"));
  }
  for (const key of ["title", "description", "claimed_root_cause", "reason"]) checkVisible(record, key, path, violations);
  checkTrace(record.trace, `${path}.trace`, violations);
  checkEvidence(record.evidence, `${path}.evidence`, violations);
}

const VERDICT_KEYS: Readonly<Record<SecurityFinding["verdict"], { allowed: readonly string[]; required: readonly string[] }>> = {
  confirmed: {
    allowed: [
      "verdict", "fingerprint", "title", "description", "root_cause", "intended_behavior", "trace", "evidence",
      "conditions", "execution", "remediation", "severity", "confidence",
    ],
    required: [
      "verdict", "fingerprint", "title", "description", "root_cause", "intended_behavior", "trace", "evidence",
      "conditions", "execution", "remediation", "severity", "confidence",
    ],
  },
  needs_validation: {
    allowed: ["verdict", "fingerprint", "title", "description", "claimed_root_cause", "trace", "evidence", "blockers", "validation_plan"],
    required: ["verdict", "fingerprint", "title", "description", "claimed_root_cause", "trace", "evidence", "blockers", "validation_plan"],
  },
  rejected: {
    allowed: ["verdict", "fingerprint", "title", "description", "claimed_root_cause", "trace", "evidence", "reason"],
    required: ["verdict", "fingerprint", "title", "description", "claimed_root_cause", "trace", "evidence", "reason"],
  },
};

/**
 * Parse and fully validate a `security-findings.json` document. Validity here
 * is exactly the document contract: shape, field semantics, trace ordering,
 * severity-vs-impact, per-verdict exclusion, sort and uniqueness. It says
 * nothing about whether the claims are true — that is what the refutation panel
 * is for.
 */
export function parseSecurityFindings(raw: unknown): DomainResult<readonly SecurityFinding[], FindingsError> {
  const violations: FindingViolation[] = [];
  if (!Array.isArray(raw)) {
    violations.push(violation("$", "expected a top-level array"));
    return failure(invalid(violations));
  }
  if (raw.length > SECURITY_AUDIT_LIMITS.findings) {
    violations.push(violation("$", `exceeds ${SECURITY_AUDIT_LIMITS.findings} findings`));
    return failure(invalid(violations));
  }

  const fingerprints = new Map<string, number>();
  let previousFingerprint: string | null = null;

  raw.forEach((entry, index) => {
    const path = `$[${index}]`;
    if (!isRecord(entry)) {
      violations.push(violation(path, "expected an object"));
      return;
    }
    if (!isOneOf(["confirmed", "needs_validation", "rejected"] as const, entry.verdict)) {
      violations.push(violation(`${path}.verdict`, "expected confirmed, needs_validation or rejected"));
      return;
    }
    const keys = VERDICT_KEYS[entry.verdict];
    checkKeys(entry, keys.allowed, keys.required, path, violations);

    if (!isSecurityFingerprint(entry.fingerprint)) {
      violations.push(violation(`${path}.fingerprint`, "expected a stable source-derived fingerprint"));
    } else {
      const previous = fingerprints.get(entry.fingerprint);
      if (previous !== undefined) violations.push(violation(`${path}.fingerprint`, `duplicate of $[${previous}].fingerprint`));
      else fingerprints.set(entry.fingerprint, index);
      if (previousFingerprint !== null && compareStrings(previousFingerprint, entry.fingerprint) > 0) {
        violations.push(violation(`${path}.fingerprint`, "findings must be sorted lexicographically"));
      }
      previousFingerprint = entry.fingerprint;
    }

    switch (entry.verdict) {
      case "confirmed":
        checkConfirmed(entry, path, violations);
        return;
      case "needs_validation":
        checkNeedsValidation(entry, path, violations);
        return;
      case "rejected":
        checkRejected(entry, path, violations);
        return;
    }
  });

  return violations.length === 0
    ? success(raw as readonly SecurityFinding[])
    : failure(invalid(violations));
}

// --- Consolidation ---

/** One root cause, one record. Fingerprints are the identity; the root-cause
 *  text catches the case where two hunters described the same defect from
 *  different entry points and earned different fingerprints. The keeper is the
 *  record with the most complete trace, tie-broken by fingerprint so the choice
 *  is deterministic. */
export function consolidateCandidates<T extends SecurityFinding>(candidates: readonly T[]): readonly T[] {
  const byFingerprint = new Map<string, T>();
  for (const candidate of candidates) {
    if (!byFingerprint.has(candidate.fingerprint)) byFingerprint.set(candidate.fingerprint, candidate);
  }
  const byRootCause = new Map<string, T>();
  for (const candidate of [...byFingerprint.values()].sort((left, right) => compareStrings(left.fingerprint, right.fingerprint))) {
    const rootCause = "root_cause" in candidate ? candidate.root_cause : candidate.claimed_root_cause;
    const existing = byRootCause.get(rootCause);
    if (existing === undefined || candidate.trace.length > existing.trace.length) byRootCause.set(rootCause, candidate);
  }
  return [...byRootCause.values()].sort((left, right) => compareStrings(left.fingerprint, right.fingerprint));
}

/** The adjudication ballot: loom's two levels, with the five-level ladder kept
 *  as recorded context. `null` means "no severity recorded" (needs_validation). */
export function overallSeverity(finding: SecurityFinding): SeverityScore | null {
  return finding.verdict === "confirmed" ? finding.severity.overall_severity : null;
}

export function severityAtLeast(score: SeverityScore, floor: SeverityScore): boolean {
  return SEVERITY_RANK[score] >= SEVERITY_RANK[floor];
}
