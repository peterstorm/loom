/**
 * The coverage-ledger state machine: the one place coverage is assigned,
 * settled, reassigned and archived.
 *
 * A ledger is a sorted array of coverage units. A unit is one cell of the
 * deterministic coverage matrix — `(surface, boundary, subsystem, attack_class
 * [, lifecycle])` — and it is settled exactly once per wave. The rules this
 * module enforces are the ones that make "we covered everything" a checkable
 * claim rather than a sentence:
 *
 * - a unit in flight has an owner, and the owner is fresh after every
 *   reassignment (an owner that keeps its own archived evidence is not fresh);
 * - a settled unit carries owned, non-empty reviewed paths whose union is
 *   exactly its checks' paths, so no path is claimed without a check;
 * - a local check cites an artifact under that check owner's own
 *   `agents/<agent_id>/artifacts/` root and never reuses an archived one;
 * - ids are canonical derivations of the semantic tuple, sorted, unique, and a
 *   collision between different semantics is an error rather than a merge;
 * - unassigned units that a budget cut short are `deferred` with a reason, not
 *   invisible.
 *
 * Provenance: this is a port of the coverage-ledger contract vendored from
 * `cloudflare/security-audit-skill@c1c8a8c` (`validate-coverage-ledger.cjs`).
 * The differential test in `engine/tests/security/security-oracle.test.ts`
 * pins agreement with that validator, so an intentional divergence has to be
 * a failing test rather than a silent drift.
 *
 * Pure module: no I/O, no clock, no randomness.
 */

import { compareStrings } from "./ordering";
import { failure, success, type DomainResult } from "./orchestration-contract/identity";
import {
  SECURITY_AUDIT_LIMITS,
  PRIOR_STATUSES,
  canonicalCoverageId,
  coverageSemanticKey,
  derivePriorStatus,
  isSafeSourcePath,
  isSecurityAgentId,
  isSecurityFingerprint,
  isVisibleText,
  parseCoverageRefs,
  type CoverageRefs,
  type PriorStatus,
} from "./security-audit-contract";

// --- Vocabulary ---

export const COVERAGE_STATUSES = [
  "planned",
  "not_applicable",
  "out_of_scope",
  "in_progress",
  "covered",
  "candidate",
  "blocked",
  "deferred",
] as const;
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];

/** The three ways an assigned unit can settle with evidence. */
export const TERMINAL_DISPOSITIONS = ["covered", "candidate", "blocked"] as const;
export type TerminalDisposition = (typeof TERMINAL_DISPOSITIONS)[number];

export type LocalCheck = Readonly<{
  agent_id: string;
  reviewed_paths: readonly string[];
  invariant: string;
  method: "source" | "local";
  result: string;
  /** `null` for a source check; an `agents/<agent_id>/artifacts/...` path for a
   *  local one, promoted by trusted parent-side code. */
  artifact: string | null;
}>;

export type ExcludedBlock = Readonly<{ block: string; reason: string }>;

export type CoverageAttempt = Readonly<{
  wave: number;
  status: TerminalDisposition;
  agent_id: string;
  reviewed_paths: readonly string[];
  local_checks: readonly LocalCheck[];
  result_fingerprints: readonly string[];
  unresolved: readonly string[];
  reassignment_reason: string;
}>;

export type CoverageUnit = Readonly<{
  coverage_id: string;
  canonical_refs: CoverageRefs;
  surface: string;
  boundary: string;
  subsystem: string;
  attack_class: string;
  lifecycle?: string;
  starting_paths: readonly string[];
  ordinary_attack_class_block: string | null;
  selected_companion_blocks: readonly string[];
  excluded_blocks: readonly ExcludedBlock[];
  prior_status: PriorStatus;
  attempts: readonly CoverageAttempt[];
  wave: number;
  status: CoverageStatus;
  agent_id: string | null;
  reviewed_paths: readonly string[];
  local_checks: readonly LocalCheck[];
  result_fingerprints: readonly string[];
  unresolved: readonly string[];
}>;

export type CoverageLedger = readonly CoverageUnit[];

export type CoverageViolation = Readonly<{ path: string; message: string }>;

export type CoverageError = Readonly<{
  kind: "invalid-coverage-operation";
  violations: readonly CoverageViolation[];
}>;

const violation = (path: string, message: string): CoverageViolation => ({ path, message });

const invalid = (violations: readonly CoverageViolation[]): CoverageError => ({
  kind: "invalid-coverage-operation",
  violations,
});

// --- Seeding ---

export type CoverageSeed = Readonly<{
  refs: CoverageRefs;
  starting_paths: readonly string[];
  ordinary_attack_class_block: string | null;
  selected_companion_blocks: readonly string[];
  excluded_blocks: readonly ExcludedBlock[];
  /** Prior-run facts; the carry status is derived, never caller-supplied. */
  prior: Parameters<typeof derivePriorStatus>[0];
  lifecycle?: string;
  wave?: number;
  status?: CoverageStatus;
  unresolved?: readonly string[];
}>;

/**
 * A seeded unit is `planned` (or explicitly `out_of_scope`/`deferred` for a
 * scoped or budget-cut run) with no owner and no evidence. The identity is
 * derived from the refs, so two seeds with the same semantics cannot both
 * enter a ledger by accident.
 */
export function seedCoverageUnit(seed: CoverageSeed): DomainResult<CoverageUnit, CoverageError> {
  const violations: CoverageViolation[] = [];
  const refs = parseCoverageRefs(seed.refs);
  if (!refs.ok) {
    violations.push(violation("canonical_refs", refs.error.message));
    return failure(invalid(violations));
  }
  const value = refs.value;
  if (value.lifecycle !== undefined && seed.lifecycle !== undefined && value.lifecycle !== seed.lifecycle) {
    violations.push(violation("lifecycle", "lifecycle and canonical_refs.lifecycle disagree"));
  }

  if (seed.starting_paths.length === 0) {
    violations.push(violation("starting_paths", "at least one starting path is required"));
  }
  for (const path of seed.starting_paths) {
    if (!isSafeSourcePath(path)) violations.push(violation("starting_paths", `unsafe source path ${JSON.stringify(path)}`));
  }
  if (seed.ordinary_attack_class_block !== null && !isVisibleText(seed.ordinary_attack_class_block)) {
    violations.push(violation("ordinary_attack_class_block", "expected null or visible text"));
  }
  for (const block of seed.selected_companion_blocks) {
    if (!isVisibleText(block)) violations.push(violation("selected_companion_blocks", "invalid block reference"));
  }
  for (const entry of seed.excluded_blocks) {
    if (!isVisibleText(entry.block) || !isVisibleText(entry.reason)) {
      violations.push(violation("excluded_blocks", "block and reason must be visible text"));
    }
  }
  const selected = new Set(seed.selected_companion_blocks);
  for (const entry of seed.excluded_blocks) {
    if (selected.has(entry.block)) violations.push(violation("excluded_blocks", `block ${entry.block} is also selected`));
  }
  if (violations.length > 0) return failure(invalid(violations));

  const status = seed.status ?? "planned";
  if (status !== "planned" && status !== "out_of_scope" && status !== "deferred" && status !== "not_applicable") {
    violations.push(violation("status", "a seeded unit may only start planned, not_applicable, out_of_scope or deferred"));
    return failure(invalid(violations));
  }

  return success({
    coverage_id: canonicalCoverageId(value),
    canonical_refs: value,
    surface: value.surface,
    boundary: value.boundary,
    subsystem: value.subsystem,
    attack_class: value.attack_class,
    ...(value.lifecycle === undefined ? {} : { lifecycle: value.lifecycle }),
    starting_paths: [...seed.starting_paths],
    ordinary_attack_class_block: seed.ordinary_attack_class_block,
    selected_companion_blocks: [...seed.selected_companion_blocks],
    excluded_blocks: seed.excluded_blocks.map((entry) => ({ block: entry.block, reason: entry.reason })),
    prior_status: derivePriorStatus(seed.prior),
    attempts: [],
    wave: seed.wave ?? 1,
    status,
    agent_id: null,
    reviewed_paths: [],
    local_checks: [],
    result_fingerprints: [],
    unresolved: seed.unresolved === undefined ? [] : [...seed.unresolved],
  });
}

// --- Sorting ---

/** Canonical order: lexicographic by canonical id. Every returned ledger is
 *  sorted, so two runs that produce the same units produce the same bytes. */
export const sortLedger = (ledger: CoverageLedger): CoverageLedger =>
  [...ledger].sort((left, right) => compareStrings(left.coverage_id, right.coverage_id));

// --- Validation ---

const isSafeOwnedArtifactPath = (value: unknown, agentId: string): boolean => {
  if (!isSecurityAgentId(agentId) || !isSafeSourcePath(value)) return false;
  const prefix = `agents/${agentId}/artifacts/`;
  return value.startsWith(prefix) && value.length > prefix.length;
};

/**
 * One array rule for every per-unit collection, matching the vendored
 * validator: entries are unique, and each entry is a visible bounded string or
 * a safe repository-relative path. Duplicates matter beyond tidiness — a
 * repeated path inflates the reviewed-path count a coverage claim rests on.
 */
function checkEntryArray(
  value: readonly unknown[],
  path: string,
  violations: CoverageViolation[],
  kind: "path" | "fingerprint" | "text",
  options: Readonly<{ allowEmpty?: boolean }> = {},
): void {
  if (value.length > SECURITY_AUDIT_LIMITS.collectionItems) {
    violations.push(violation(path, "too many entries"));
    return;
  }
  if (!options.allowEmpty && value.length === 0) violations.push(violation(path, "requires at least one entry"));
  const seen = new Set<string>();
  for (const entry of value) {
    const valid =
      kind === "path" ? isSafeSourcePath(entry) : kind === "fingerprint" ? isSecurityFingerprint(entry) : isVisibleText(entry);
    if (!valid) violations.push(violation(path, kind === "path" ? "unsafe source path" : `invalid ${kind}`));
    if (typeof entry === "string") {
      if (seen.has(entry)) violations.push(violation(path, "duplicate entry"));
      seen.add(entry);
    }
  }
}

function validateLocalChecks(checks: readonly LocalCheck[], path: string, violations: CoverageViolation[]): void {
  if (checks.length > SECURITY_AUDIT_LIMITS.collectionItems) {
    violations.push(violation(path, "too many checks"));
    return;
  }
  checks.forEach((check, index) => {
    const base = `${path}[${index}]`;
    if (!isSecurityAgentId(check.agent_id)) violations.push(violation(`${base}.agent_id`, "expected a canonical lowercase agent ID"));
    if (check.reviewed_paths.length === 0) violations.push(violation(`${base}.reviewed_paths`, "a check must review at least one path"));
    for (const reviewed of check.reviewed_paths) {
      if (!isSafeSourcePath(reviewed)) violations.push(violation(`${base}.reviewed_paths`, `unsafe source path ${JSON.stringify(reviewed)}`));
    }
    if (!isVisibleText(check.invariant)) violations.push(violation(`${base}.invariant`, "invalid text"));
    if (!isVisibleText(check.result)) violations.push(violation(`${base}.result`, "invalid text"));
    if (check.method === "source" && check.artifact !== null) {
      violations.push(violation(`${base}.artifact`, "a source check must use null"));
    }
    if (check.method === "local" && !isSafeOwnedArtifactPath(check.artifact, check.agent_id)) {
      violations.push(violation(`${base}.artifact`, "a local check cites an artifact under its own agent's artifacts root"));
    }
  });
}

/** The unit's reviewed paths are exactly the union of its checks' owned paths:
 *  a claimed path without a check is an unreviewed claim. */
function validatePathOwnership(unit: Pick<CoverageUnit, "reviewed_paths" | "local_checks">, path: string, violations: CoverageViolation[]): void {
  const owned = new Set(unit.local_checks.flatMap((check) => check.reviewed_paths));
  const claimed = new Set(unit.reviewed_paths);
  for (const reviewed of claimed) {
    if (!owned.has(reviewed)) violations.push(violation(`${path}.reviewed_paths`, `${JSON.stringify(reviewed)} has no check owner`));
  }
  for (const reviewed of owned) {
    if (!claimed.has(reviewed)) violations.push(violation(`${path}.local_checks`, `owned path ${JSON.stringify(reviewed)} is absent from reviewed_paths`));
  }
}

function validateStateInvariants(
  unit: Pick<CoverageUnit, "status" | "agent_id" | "reviewed_paths" | "local_checks" | "result_fingerprints" | "unresolved">,
  path: string,
  violations: CoverageViolation[],
): void {
  const requireOwner = (): void => {
    if (!isSecurityAgentId(unit.agent_id)) violations.push(violation(`${path}.agent_id`, `status ${unit.status} requires an owner`));
  };
  const requireUnassigned = (): void => {
    if (unit.agent_id !== null) violations.push(violation(`${path}.agent_id`, `status ${unit.status} must be unassigned`));
  };
  const requireEmptyEvidence = (): void => {
    if (unit.reviewed_paths.length > 0) violations.push(violation(`${path}.reviewed_paths`, `status ${unit.status} keeps this empty`));
    if (unit.local_checks.length > 0) violations.push(violation(`${path}.local_checks`, `status ${unit.status} keeps this empty`));
  };
  const requireEvidence = (): void => {
    if (unit.reviewed_paths.length === 0) violations.push(violation(`${path}.reviewed_paths`, `status ${unit.status} requires entries`));
    if (unit.local_checks.length === 0) violations.push(violation(`${path}.local_checks`, `status ${unit.status} requires entries`));
  };
  const requireUnresolved = (present: boolean): void => {
    if (present && unit.unresolved.length === 0) violations.push(violation(`${path}.unresolved`, `status ${unit.status} requires unresolved facts`));
    if (!present && unit.unresolved.length > 0) violations.push(violation(`${path}.unresolved`, `status ${unit.status} keeps this empty`));
  };

  if (unit.status !== "candidate" && unit.result_fingerprints.length > 0) {
    violations.push(violation(`${path}.result_fingerprints`, `status ${unit.status} keeps this empty`));
  }

  switch (unit.status) {
    case "planned":
      requireUnassigned();
      requireEmptyEvidence();
      requireUnresolved(false);
      return;
    case "not_applicable":
    case "out_of_scope":
    case "deferred":
      requireUnassigned();
      requireEmptyEvidence();
      requireUnresolved(true);
      return;
    case "in_progress":
      requireOwner();
      requireEmptyEvidence();
      requireUnresolved(false);
      return;
    case "covered":
      requireOwner();
      requireEvidence();
      requireUnresolved(false);
      return;
    case "candidate":
      requireOwner();
      requireEvidence();
      if (unit.result_fingerprints.length === 0) violations.push(violation(`${path}.result_fingerprints`, "candidate requires fingerprints"));
      return;
    case "blocked":
      requireOwner();
      requireEvidence();
      requireUnresolved(true);
      return;
  }
}

/**
 * Full ledger validation. Deterministic and total: every check runs, and the
 * violations come back in a stable order so a failing run prints the same
 * diagnostics twice.
 */
export function validateLedger(ledger: CoverageLedger): readonly CoverageViolation[] {
  const violations: CoverageViolation[] = [];
  if (!Array.isArray(ledger as unknown)) {
    violations.push(violation("$", "expected a top-level array"));
    return violations;
  }
  if (ledger.length > SECURITY_AUDIT_LIMITS.units) {
    violations.push(violation("$", `exceeds ${SECURITY_AUDIT_LIMITS.units} coverage units`));
    return violations;
  }

  const byId = new Map<string, number>();
  const bySemantics = new Map<string, { id: string; index: number }>();
  let previousId: string | null = null;

  ledger.forEach((unit, index) => {
    const base = `$[${index}]`;

    const parsed = parseCoverageRefs(unit.canonical_refs);
    if (!parsed.ok) {
      violations.push(violation(`${base}.canonical_refs`, parsed.error.message));
    } else {
      const expected = canonicalCoverageId(parsed.value);
      if (unit.coverage_id !== expected) {
        violations.push(violation(`${base}.coverage_id`, `expected canonical ID ${JSON.stringify(expected)}`));
      }
      if (unit.surface !== parsed.value.surface || unit.boundary !== parsed.value.boundary ||
          unit.subsystem !== parsed.value.subsystem || unit.attack_class !== parsed.value.attack_class ||
          unit.lifecycle !== parsed.value.lifecycle) {
        violations.push(violation(`${base}`, "semantic fields must equal canonical_refs"));
      }
    }

    if (!isSecurityAgentId(unit.agent_id) && unit.agent_id !== null) {
      violations.push(violation(`${base}.agent_id`, "expected null or a canonical lowercase agent ID"));
    }
    if (!Number.isInteger(unit.wave) || unit.wave < 1) violations.push(violation(`${base}.wave`, "expected a positive integer"));
    if (!(PRIOR_STATUSES as readonly string[]).includes(unit.prior_status)) {
      violations.push(violation(`${base}.prior_status`, `invalid value ${JSON.stringify(unit.prior_status)}`));
    }
    if (!(COVERAGE_STATUSES as readonly string[]).includes(unit.status)) {
      violations.push(violation(`${base}.status`, `invalid value ${JSON.stringify(unit.status)}`));
    }
    checkEntryArray(unit.starting_paths, `${base}.starting_paths`, violations, "path");
    if (unit.ordinary_attack_class_block !== null && !isVisibleText(unit.ordinary_attack_class_block)) {
      violations.push(violation(`${base}.ordinary_attack_class_block`, "expected null or visible text"));
    }
    checkEntryArray(unit.selected_companion_blocks, `${base}.selected_companion_blocks`, violations, "text");
    const excludedBlocks = new Set<string>();
    unit.excluded_blocks.forEach((entry, index) => {
      if (!isVisibleText(entry.block) || !isVisibleText(entry.reason)) {
        violations.push(violation(`${base}.excluded_blocks[${index}]`, "block and reason must be visible text"));
      }
      if (excludedBlocks.has(entry.block)) violations.push(violation(`${base}.excluded_blocks[${index}].block`, "duplicate block"));
      excludedBlocks.add(entry.block);
      if (unit.selected_companion_blocks.includes(entry.block)) {
        violations.push(violation(`${base}.excluded_blocks[${index}].block`, "block is also selected"));
      }
    });
    checkEntryArray(unit.reviewed_paths, `${base}.reviewed_paths`, violations, "path", { allowEmpty: true });
    checkEntryArray(unit.result_fingerprints, `${base}.result_fingerprints`, violations, "fingerprint", { allowEmpty: true });
    checkEntryArray(unit.unresolved, `${base}.unresolved`, violations, "text", { allowEmpty: true });
    validateLocalChecks(unit.local_checks, `${base}.local_checks`, violations);
    validatePathOwnership(unit, base, violations);
    validateStateInvariants(unit, base, violations);
    validateAttempts(unit, base, violations);

    const key = coverageSemanticKey(unit.canonical_refs);
    const previous = bySemantics.get(key);
    if (previous !== undefined && previous.id !== unit.coverage_id) {
      violations.push(violation(`${base}.canonical_refs`, `semantic tuple already uses ${JSON.stringify(previous.id)} at $[${previous.index}]`));
    } else if (previous === undefined) {
      bySemantics.set(key, { id: unit.coverage_id, index });
    }
    if (byId.has(unit.coverage_id)) {
      violations.push(violation(`${base}.coverage_id`, `duplicate coverage ID at $[${byId.get(unit.coverage_id)}]`));
    } else {
      byId.set(unit.coverage_id, index);
    }
    if (previousId !== null && compareStrings(previousId, unit.coverage_id) > 0) {
      violations.push(violation(`${base}.coverage_id`, "units must be sorted lexicographically"));
    }
    previousId = unit.coverage_id;
  });

  return violations;
}

function validateAttempts(unit: CoverageUnit, base: string, violations: CoverageViolation[]): void {
  if (unit.attempts.length > SECURITY_AUDIT_LIMITS.attemptsPerUnit) {
    violations.push(violation(`${base}.attempts`, "too many archived attempts"));
    return;
  }
  const priorOwners = new Set<string>();
  const priorArtifacts = new Set<string>();
  let previousWave = 0;

  unit.attempts.forEach((attempt, index) => {
    const path = `${base}.attempts[${index}]`;
    if (!Number.isInteger(attempt.wave) || attempt.wave < 1) {
      violations.push(violation(`${path}.wave`, "expected a positive integer"));
    } else {
      if (attempt.wave <= previousWave) violations.push(violation(`${path}.wave`, "archived waves must strictly increase"));
      if (attempt.wave >= unit.wave) violations.push(violation(`${path}.wave`, `archived wave must precede current wave ${unit.wave}`));
      previousWave = attempt.wave;
    }
    if (!(TERMINAL_DISPOSITIONS as readonly string[]).includes(attempt.status)) {
      violations.push(violation(`${path}.status`, "archived attempts settle as covered, candidate or blocked"));
    }
    let hasFreshOwner = false;
    if (!isSecurityAgentId(attempt.agent_id)) {
      violations.push(violation(`${path}.agent_id`, "archived attempt requires a canonical lowercase agent ID"));
    } else if (priorOwners.has(attempt.agent_id)) {
      violations.push(violation(`${path}.agent_id`, "assignment owner must be fresh for each attempt"));
    } else {
      hasFreshOwner = true;
    }
    for (const reviewed of attempt.reviewed_paths) {
      if (!isSafeSourcePath(reviewed)) violations.push(violation(`${path}.reviewed_paths`, `unsafe source path ${JSON.stringify(reviewed)}`));
    }
    checkEntryArray(attempt.reviewed_paths, `${path}.reviewed_paths`, violations, "path", { allowEmpty: true });
    validateLocalChecks(attempt.local_checks, `${path}.local_checks`, violations);
    validatePathOwnership(attempt, path, violations);
    checkEntryArray(attempt.result_fingerprints, `${path}.result_fingerprints`, violations, "fingerprint", { allowEmpty: true });
    checkEntryArray(attempt.unresolved, `${path}.unresolved`, violations, "text", { allowEmpty: true });
    if (!isVisibleText(attempt.reassignment_reason)) violations.push(violation(`${path}.reassignment_reason`, "invalid text"));
    validateStateInvariants(attempt, path, violations);

    attempt.local_checks.forEach((check, checkIndex) => {
      if (priorOwners.has(check.agent_id)) {
        violations.push(violation(`${path}.local_checks[${checkIndex}].agent_id`, "prior owner evidence belongs in its earlier attempt"));
      }
      if (check.artifact !== null && priorArtifacts.has(check.artifact)) {
        violations.push(violation(`${path}.local_checks[${checkIndex}].artifact`, "an archived artifact cannot be reused"));
      }
      if (check.method === "local" && check.artifact !== null) priorArtifacts.add(check.artifact);
    });
    // The attempt's own owner joins the prior set only AFTER its checks are read:
    // an attempt's evidence is its own, not a prior owner's.
    if (hasFreshOwner) priorOwners.add(attempt.agent_id);
  });

  if (isSecurityAgentId(unit.agent_id) && priorOwners.has(unit.agent_id)) {
    violations.push(violation(`${base}.agent_id`, "the current owner must be fresh after a reassignment"));
  }
  unit.local_checks.forEach((check, index) => {
    if (priorOwners.has(check.agent_id)) {
      violations.push(violation(`${base}.local_checks[${index}].agent_id`, "prior owner evidence must stay archived"));
    }
    if (check.artifact !== null && priorArtifacts.has(check.artifact)) {
      violations.push(violation(`${base}.local_checks[${index}].artifact`, "an archived artifact cannot be reused"));
    }
  });
}

// --- Assignment ---

export type Assignment = Readonly<{ coverageId: string; agentId: string; wave: number }>;

export type AssignmentError =
  | CoverageError
  | Readonly<{ kind: "unknown-coverage-id"; coverageId: string }>
  | Readonly<{ kind: "unit-not-planned"; coverageId: string; status: CoverageStatus }>
  | Readonly<{ kind: "owner-not-fresh"; coverageId: string; agentId: string }>;

const replaceUnit = (ledger: CoverageLedger, next: CoverageUnit): CoverageLedger =>
  sortLedger(ledger.map((unit) => (unit.coverage_id === next.coverage_id ? next : unit)));

/**
 * Assign planned units to a wave's hunters. A unit that is not `planned` cannot
 * be assigned — reassignment goes through `mergeCritic`, which archives the
 * prior attempt first.
 */
export function assignUnits(
  ledger: CoverageLedger,
  assignments: readonly Assignment[],
): DomainResult<CoverageLedger, AssignmentError> {
  let next = ledger;
  for (const assignment of assignments) {
    const unit = next.find((candidate) => candidate.coverage_id === assignment.coverageId);
    if (unit === undefined) return failure({ kind: "unknown-coverage-id" as const, coverageId: assignment.coverageId });
    if (unit.status !== "planned") {
      return failure({ kind: "unit-not-planned" as const, coverageId: unit.coverage_id, status: unit.status });
    }
    if (!isSecurityAgentId(assignment.agentId)) {
      return failure({ kind: "owner-not-fresh" as const, coverageId: unit.coverage_id, agentId: assignment.agentId });
    }
    if (unit.attempts.some((attempt) => attempt.agent_id === assignment.agentId)) {
      return failure({ kind: "owner-not-fresh" as const, coverageId: unit.coverage_id, agentId: assignment.agentId });
    }
    next = replaceUnit(next, {
      ...unit,
      status: "in_progress",
      agent_id: assignment.agentId,
      wave: assignment.wave,
    });
  }
  const violations = validateLedger(next);
  return violations.length === 0 ? success(next) : failure(invalid(violations));
}

// --- Settlement ---

export type UnitResult = Readonly<{
  coverageId: string;
  agentId: string;
  wave: number;
  status: TerminalDisposition;
  reviewedPaths: readonly string[];
  checks: readonly LocalCheck[];
  fingerprints?: readonly string[];
  unresolved?: readonly string[];
}>;

export type SettlementError =
  | CoverageError
  | Readonly<{ kind: "unknown-coverage-id"; coverageId: string }>
  | Readonly<{ kind: "wrong-owner"; coverageId: string; expected: string | null; actual: string }>
  | Readonly<{ kind: "wrong-wave"; coverageId: string; expected: number; actual: number }>
  | Readonly<{ kind: "settlement-invalid"; coverageId: string; violations: readonly CoverageViolation[] }>;

/**
 * Settle one in-flight unit with a hunter's structured result. The owner and
 * wave must match the assignment: a sibling cannot settle another hunter's
 * unit, and a stale attempt cannot settle the current wave.
 */
export function recordUnitResult(
  ledger: CoverageLedger,
  result: UnitResult,
): DomainResult<CoverageLedger, SettlementError> {
  const unit = ledger.find((candidate) => candidate.coverage_id === result.coverageId);
  if (unit === undefined) return failure({ kind: "unknown-coverage-id" as const, coverageId: result.coverageId });
  if (unit.agent_id !== result.agentId) {
    return failure({ kind: "wrong-owner" as const, coverageId: unit.coverage_id, expected: unit.agent_id, actual: result.agentId });
  }
  if (unit.wave !== result.wave) {
    return failure({ kind: "wrong-wave" as const, coverageId: unit.coverage_id, expected: unit.wave, actual: result.wave });
  }

  const settled: CoverageUnit = {
    ...unit,
    status: result.status,
    reviewed_paths: [...result.reviewedPaths],
    local_checks: result.checks.map((check) => ({ ...check, reviewed_paths: [...check.reviewed_paths] })),
    result_fingerprints: [...(result.fingerprints ?? [])],
    unresolved: [...(result.unresolved ?? [])],
  };
  const violations = validateLedger(replaceUnit(ledger, settled));
  if (violations.length > 0) {
    return failure({ kind: "settlement-invalid" as const, coverageId: unit.coverage_id, violations });
  }
  return success(replaceUnit(ledger, settled));
}

// --- Critics ---

export type CoverageProposal = Readonly<{
  refs: CoverageRefs;
  startingPaths: readonly string[];
  ordinaryAttackClassBlock: string | null;
  selectedCompanionBlocks: readonly string[];
  excludedBlocks: readonly ExcludedBlock[];
}>;

export type CoverageCriticResult = Readonly<{
  missingUnits: readonly CoverageProposal[];
  reassignIds: readonly string[];
  resolvedPriorLeads: readonly string[];
  stop: boolean;
}>;

export type CriticMerge = Readonly<{
  ledger: CoverageLedger;
  accepted: readonly string[];
  reassigned: readonly string[];
  resolved: readonly string[];
  /** Proposals whose canonical ID already exists with different semantics. */
  collisions: readonly string[];
}>;

export type CriticError = CoverageError | Readonly<{ kind: "reassign-unit-has-no-evidence"; coverageId: string; status: CoverageStatus }>;

/**
 * Merge a coverage critic's proposals. Three effects, each mechanical:
 *
 * - a proposal enters as `planned` unless its semantic tuple is already present
 *   (dedupe) — an existing canonical ID with *different* semantics is a
 *   collision the run reports rather than merges;
 * - a reassigned unit archives its live evidence into `attempts` with the
 *   critic's reason, increments its wave, and clears the live evidence, so the
 *   next hunter starts fresh by construction;
 * - a resolved prior lead is recorded on the unit that owns it.
 */
export function mergeCritic(
  ledger: CoverageLedger,
  critic: CoverageCriticResult,
  options: Readonly<{ wave: number; reassignmentReasons: Readonly<Record<string, string>>; priorLeadOwners?: Readonly<Record<string, string>> }>,
): DomainResult<CriticMerge, CriticError> {
  let next = ledger;
  const accepted: string[] = [];
  const reassigned: string[] = [];
  const resolved: string[] = [];
  const collisions: string[] = [];
  const bySemantics = new Map(ledger.map((unit) => [coverageSemanticKey(unit.canonical_refs), unit.coverage_id]));

  for (const proposal of critic.missingUnits) {
    const refs = parseCoverageRefs(proposal.refs);
    if (!refs.ok) return failure(invalid([violation("missingUnits", refs.error.message)]));
    const id = canonicalCoverageId(refs.value);
    const existingId = bySemantics.get(coverageSemanticKey(refs.value));
    if (existingId !== undefined) {
      if (existingId !== id) collisions.push(id);
      continue;
    }
    const seeded = seedCoverageUnit({
      refs: refs.value,
      starting_paths: proposal.startingPaths,
      ordinary_attack_class_block: proposal.ordinaryAttackClassBlock,
      selected_companion_blocks: proposal.selectedCompanionBlocks,
      excluded_blocks: proposal.excludedBlocks,
      prior: null,
      wave: options.wave,
    });
    if (!seeded.ok) return failure(invalid(seeded.error.violations));
    next = sortLedger([...next, seeded.value]);
    bySemantics.set(coverageSemanticKey(refs.value), id);
    accepted.push(id);
  }

  for (const coverageId of critic.reassignIds) {
    const unit = next.find((candidate) => candidate.coverage_id === coverageId);
    if (unit === undefined) return failure({ ...invalid([violation("reassignIds", `unknown coverage ID ${coverageId}`)]), kind: "invalid-coverage-operation" });
    if (unit.status !== "covered" && unit.status !== "candidate" && unit.status !== "blocked") {
      return failure({ kind: "reassign-unit-has-no-evidence" as const, coverageId, status: unit.status });
    }
    const reason = options.reassignmentReasons[coverageId];
    const archived: CoverageAttempt = {
      wave: unit.wave,
      status: unit.status,
      agent_id: unit.agent_id ?? "unknown-owner",
      reviewed_paths: unit.reviewed_paths,
      local_checks: unit.local_checks,
      result_fingerprints: unit.result_fingerprints,
      unresolved: unit.unresolved,
      reassignment_reason: isVisibleText(reason) ? reason : `critic reassignment at wave ${options.wave}`,
    };
    next = replaceUnit(next, {
      ...unit,
      attempts: [...unit.attempts, archived],
      wave: unit.wave + 1,
      status: "planned",
      agent_id: null,
      reviewed_paths: [],
      local_checks: [],
      result_fingerprints: [],
      unresolved: [],
    });
    reassigned.push(coverageId);
  }

  for (const fingerprint of critic.resolvedPriorLeads) {
    const ownerId = options.priorLeadOwners?.[fingerprint];
    const unit = ownerId === undefined ? undefined : next.find((candidate) => candidate.coverage_id === ownerId);
    if (unit === undefined) continue;
    if (unit.unresolved.includes(fingerprint)) {
      next = replaceUnit(next, { ...unit, unresolved: unit.unresolved.filter((entry) => entry !== fingerprint) });
      resolved.push(fingerprint);
    }
  }

  const violations = validateLedger(next);
  if (violations.length > 0) return failure(invalid(violations));
  return success({ ledger: next, accepted, reassigned, resolved, collisions });
}

/** Units a budget could not reach become explicitly `deferred`. The reason is
 *  mandatory: a deferred unit without one is a silent gap wearing a label. */
export function deferPlannedUnits(ledger: CoverageLedger, reason: string): CoverageLedger {
  if (!isVisibleText(reason)) throw new TypeError("a deferred unit requires a visible reason");
  return sortLedger(
    ledger.map((unit) =>
      unit.status === "planned"
        ? { ...unit, status: "deferred" as const, agent_id: null, unresolved: [reason] }
        : unit,
    ),
  );
}

// --- Reporting ---

export type CoverageSummary = Readonly<{
  total: number;
  byStatus: Readonly<Record<CoverageStatus, number>>;
  candidates: readonly string[];
  deferred: readonly string[];
  blocked: readonly string[];
}>;

export function summarizeCoverage(ledger: CoverageLedger): CoverageSummary {
  const byStatus: Record<CoverageStatus, number> = {
    planned: 0,
    not_applicable: 0,
    out_of_scope: 0,
    in_progress: 0,
    covered: 0,
    candidate: 0,
    blocked: 0,
    deferred: 0,
  };
  for (const unit of ledger) byStatus[unit.status] += 1;
  return {
    total: ledger.length,
    byStatus,
    candidates: ledger.filter((unit) => unit.status === "candidate").map((unit) => unit.coverage_id),
    deferred: ledger.filter((unit) => unit.status === "deferred").map((unit) => unit.coverage_id),
    blocked: ledger.filter((unit) => unit.status === "blocked").map((unit) => unit.coverage_id),
  };
}

/** A run may claim COMPLETE coverage only when nothing is planned, in progress,
 *  blocked or deferred. `not_applicable` and `out_of_scope` are settled. */
export function coverageComplete(ledger: CoverageLedger): boolean {
  return ledger.every((unit) =>
    unit.status === "covered" || unit.status === "candidate" || unit.status === "not_applicable" || unit.status === "out_of_scope",
  );
}

/** SETTLED coverage allows disclosed deferrals: every unit reached a terminal
 *  state, but some are gaps with a reason. A settled run reports; a complete
 *  run claims. */
export function coverageSettled(ledger: CoverageLedger): boolean {
  return ledger.every((unit) => unit.status !== "planned" && unit.status !== "in_progress" && unit.status !== "blocked");
}
