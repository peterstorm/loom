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

import { match } from "ts-pattern";
import { compareStrings } from "./ordering";
import { catalogProfileOfAgent, type LlmProfileId } from "./model-profiles";
import { failure, success, type DomainResult } from "./orchestration-contract/identity";
import {
  SECURITY_AUDIT_LIMITS,
  SECURITY_INCOMPLETE_REASONS,
  PRIOR_STATUSES,
  canonicalCoverageId,
  coverageSemanticKey,
  derivePriorStatus,
  isSafeSourcePath,
  isSecurityAgentId,
  isSecurityFingerprint,
  isVisibleText,
  parseCoverageRefs,
  parsePriorRecordFacts,
  type CoverageRefs,
  type PriorStatus,
  type SecurityIncompleteReason,
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

/** The runtime membership guard. A wire document can carry any string, and
 *  `match(...).exhaustive()` THROWS on an unknown tag — so a validator checks
 *  membership first and ends its state analysis there, rather than crashing on
 *  the document it was asked to judge. */
export const isCoverageStatus = (value: unknown): value is CoverageStatus =>
  typeof value === "string" && (COVERAGE_STATUSES as readonly string[]).includes(value);

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

/** A ledger arrives as `JSON.parse` output, so every field below can be any
 *  JSON value. `entriesOf` is the one shape guard: a non-array becomes a named
 *  violation and an empty list, so validation stays total instead of throwing
 *  on the document it was asked to judge. */
const entriesOf = (value: unknown, path: string, violations: CoverageViolation[]): readonly unknown[] => {
  if (Array.isArray(value)) return value;
  violations.push(violation(path, "expected an array"));
  return [];
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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
  value: unknown,
  path: string,
  violations: CoverageViolation[],
  kind: "path" | "fingerprint" | "text",
  options: Readonly<{ allowEmpty?: boolean }> = {},
): void {
  if (!Array.isArray(value)) {
    violations.push(violation(path, "expected an array"));
    return;
  }
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

function validateLocalChecks(raw: unknown, path: string, violations: CoverageViolation[]): void {
  if (!Array.isArray(raw)) {
    violations.push(violation(path, "expected an array of checks"));
    return;
  }
  const checks = raw as readonly LocalCheck[];
  if (checks.length > SECURITY_AUDIT_LIMITS.collectionItems) {
    violations.push(violation(path, "too many checks"));
    return;
  }
  checks.forEach((check, index) => {
    const base = `${path}[${index}]`;
    if (!isRecord(check)) {
      violations.push(violation(base, "expected an object"));
      return;
    }
    if (!isSecurityAgentId(check.agent_id)) violations.push(violation(`${base}.agent_id`, "expected a canonical lowercase agent ID"));
    // Totality: `reviewed_paths` arrives as raw JSON, so a missing or
    // non-array value is a violation — never a `.length` on `undefined`.
    const reviewedPaths: readonly unknown[] = Array.isArray(check.reviewed_paths) ? check.reviewed_paths : [];
    if (!Array.isArray(check.reviewed_paths)) {
      violations.push(violation(`${base}.reviewed_paths`, "expected an array of source paths"));
    } else if (reviewedPaths.length === 0) {
      violations.push(violation(`${base}.reviewed_paths`, "a check must review at least one path"));
    }
    for (const reviewed of reviewedPaths) {
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
function validatePathOwnership(
  unit: Readonly<{ reviewed_paths: unknown; local_checks: unknown }>,
  path: string,
  violations: CoverageViolation[],
): void {
  const checks = Array.isArray(unit.local_checks) ? (unit.local_checks as readonly LocalCheck[]) : [];
  const owned = new Set(checks.flatMap((check) => (isRecord(check) && Array.isArray(check.reviewed_paths) ? check.reviewed_paths : [])));
  const claimed = new Set(Array.isArray(unit.reviewed_paths) ? unit.reviewed_paths : []);
  for (const reviewed of claimed) {
    if (!owned.has(reviewed)) violations.push(violation(`${path}.reviewed_paths`, `${JSON.stringify(reviewed)} has no check owner`));
  }
  for (const reviewed of owned) {
    if (!claimed.has(reviewed)) violations.push(violation(`${path}.local_checks`, `owned path ${JSON.stringify(reviewed)} is absent from reviewed_paths`));
  }
}

function validateStateInvariants(
  unit: Readonly<{ status: unknown; agent_id: unknown; reviewed_paths: unknown; local_checks: unknown; result_fingerprints: unknown; unresolved: unknown }>,
  path: string,
  violations: CoverageViolation[],
): void {
  const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
  const requireOwner = (): void => {
    if (!isSecurityAgentId(unit.agent_id)) violations.push(violation(`${path}.agent_id`, `status ${unit.status} requires an owner`));
  };
  const requireUnassigned = (): void => {
    if (unit.agent_id !== null) violations.push(violation(`${path}.agent_id`, `status ${unit.status} must be unassigned`));
  };
  const requireEmptyEvidence = (): void => {
    if (count(unit.reviewed_paths) > 0) violations.push(violation(`${path}.reviewed_paths`, `status ${unit.status} keeps this empty`));
    if (count(unit.local_checks) > 0) violations.push(violation(`${path}.local_checks`, `status ${unit.status} keeps this empty`));
  };
  const requireEvidence = (): void => {
    if (count(unit.reviewed_paths) === 0) violations.push(violation(`${path}.reviewed_paths`, `status ${unit.status} requires entries`));
    if (count(unit.local_checks) === 0) violations.push(violation(`${path}.local_checks`, `status ${unit.status} requires entries`));
  };
  const requireUnresolved = (present: boolean): void => {
    if (present && count(unit.unresolved) === 0) violations.push(violation(`${path}.unresolved`, `status ${unit.status} requires unresolved facts`));
    if (!present && count(unit.unresolved) > 0) violations.push(violation(`${path}.unresolved`, `status ${unit.status} keeps this empty`));
  };

  if (unit.status !== "candidate" && count(unit.result_fingerprints) > 0) {
    violations.push(violation(`${path}.result_fingerprints`, `status ${unit.status} keeps this empty`));
  }
  // Membership was reported by the caller; an unknown wire value would make the
  // exhaustive match below throw, so the state analysis ends here.
  if (!isCoverageStatus(unit.status)) return;

  match(unit.status)
    .with("planned", () => {
      requireUnassigned();
      requireEmptyEvidence();
      requireUnresolved(false);
    })
    .with("not_applicable", "out_of_scope", "deferred", () => {
      requireUnassigned();
      requireEmptyEvidence();
      requireUnresolved(true);
    })
    .with("in_progress", () => {
      requireOwner();
      requireEmptyEvidence();
      requireUnresolved(false);
    })
    .with("covered", () => {
      requireOwner();
      requireEvidence();
      requireUnresolved(false);
    })
    .with("candidate", () => {
      requireOwner();
      requireEvidence();
      if (count(unit.result_fingerprints) === 0) violations.push(violation(`${path}.result_fingerprints`, "candidate requires fingerprints"));
    })
    .with("blocked", () => {
      requireOwner();
      requireEvidence();
      requireUnresolved(true);
    })
    .exhaustive();
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
    if (!isRecord(unit)) {
      violations.push(violation(base, "expected an object"));
      return;
    }

    const parsed = parseCoverageRefs(unit.canonical_refs);
    // The semantic key is derived from PARSED refs: a unit whose refs did not
    // parse has no key, and asking for one is how totality leaked a throw.
    let semanticKey: string | null = null;
    if (!parsed.ok) {
      violations.push(violation(`${base}.canonical_refs`, parsed.error.message));
    } else {
      semanticKey = coverageSemanticKey(parsed.value);
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
    if (!isCoverageStatus(unit.status)) {
      violations.push(violation(`${base}.status`, `invalid value ${JSON.stringify(unit.status)}`));
    }
    checkEntryArray(unit.starting_paths, `${base}.starting_paths`, violations, "path");
    if (unit.ordinary_attack_class_block !== null && !isVisibleText(unit.ordinary_attack_class_block)) {
      violations.push(violation(`${base}.ordinary_attack_class_block`, "expected null or visible text"));
    }
    checkEntryArray(unit.selected_companion_blocks, `${base}.selected_companion_blocks`, violations, "text", { allowEmpty: true });
    const excludedBlocks = new Set<string>();
    const excluded = entriesOf(unit.excluded_blocks, `${base}.excluded_blocks`, violations);
    excluded.forEach((rawEntry, index) => {
      if (!isRecord(rawEntry)) {
        violations.push(violation(`${base}.excluded_blocks[${index}]`, "expected an object"));
        return;
      }
      const entry = rawEntry as unknown as ExcludedBlock;
      if (!isVisibleText(entry.block) || !isVisibleText(entry.reason)) {
        violations.push(violation(`${base}.excluded_blocks[${index}]`, "block and reason must be visible text"));
      }
      if (excludedBlocks.has(entry.block)) violations.push(violation(`${base}.excluded_blocks[${index}].block`, "duplicate block"));
      excludedBlocks.add(entry.block);
      const selected = Array.isArray(unit.selected_companion_blocks) ? unit.selected_companion_blocks : [];
      if (selected.includes(entry.block)) {
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

    const previous = semanticKey === null ? undefined : bySemantics.get(semanticKey);
    if (previous !== undefined && previous.id !== unit.coverage_id) {
      violations.push(violation(`${base}.canonical_refs`, `semantic tuple already uses ${JSON.stringify(previous.id)} at $[${previous.index}]`));
    } else if (previous === undefined && semanticKey !== null) {
      bySemantics.set(semanticKey, { id: unit.coverage_id, index });
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
  const attempts = entriesOf(unit.attempts, `${base}.attempts`, violations) as readonly CoverageAttempt[];
  if (attempts.length > SECURITY_AUDIT_LIMITS.attemptsPerUnit) {
    violations.push(violation(`${base}.attempts`, "too many archived attempts"));
    return;
  }
  const priorOwners = new Set<string>();
  const priorArtifacts = new Set<string>();
  let previousWave = 0;

  attempts.forEach((attempt, index) => {
    const path = `${base}.attempts[${index}]`;
    if (!isRecord(attempt)) {
      violations.push(violation(path, "expected an object"));
      return;
    }
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
    // Totality: these three reads used to run before their array guard, so a
    // wire attempt with no `reviewed_paths` threw instead of reporting it.
    const attemptPaths: readonly unknown[] = Array.isArray(attempt.reviewed_paths) ? attempt.reviewed_paths : [];
    for (const reviewed of attemptPaths) {
      if (!isSafeSourcePath(reviewed)) violations.push(violation(`${path}.reviewed_paths`, `unsafe source path ${JSON.stringify(reviewed)}`));
    }
    checkEntryArray(attempt.reviewed_paths, `${path}.reviewed_paths`, violations, "path", { allowEmpty: true });
    validateLocalChecks(attempt.local_checks, `${path}.local_checks`, violations);
    validatePathOwnership(attempt, path, violations);
    checkEntryArray(attempt.result_fingerprints, `${path}.result_fingerprints`, violations, "fingerprint", { allowEmpty: true });
    checkEntryArray(attempt.unresolved, `${path}.unresolved`, violations, "text", { allowEmpty: true });
    if (!isVisibleText(attempt.reassignment_reason)) violations.push(violation(`${path}.reassignment_reason`, "invalid text"));
    validateStateInvariants(attempt, path, violations);

    const attemptChecks: readonly unknown[] = Array.isArray(attempt.local_checks) ? attempt.local_checks : [];
    attemptChecks.forEach((rawCheck, checkIndex) => {
      if (!isRecord(rawCheck)) return;
      const priorOwner = isSecurityAgentId(rawCheck.agent_id) && priorOwners.has(rawCheck.agent_id);
      if (priorOwner) {
        violations.push(violation(`${path}.local_checks[${checkIndex}].agent_id`, "prior owner evidence belongs in its earlier attempt"));
      }
      if (typeof rawCheck.artifact === "string" && priorArtifacts.has(rawCheck.artifact)) {
        violations.push(violation(`${path}.local_checks[${checkIndex}].artifact`, "an archived artifact cannot be reused"));
      }
      if (rawCheck.method === "local" && typeof rawCheck.artifact === "string") priorArtifacts.add(rawCheck.artifact);
    });
    // The attempt's own owner joins the prior set only AFTER its checks are read:
    // an attempt's evidence is its own, not a prior owner's.
    if (hasFreshOwner) priorOwners.add(attempt.agent_id);
  });

  if (!Array.isArray(unit.attempts)) return;
  if (isSecurityAgentId(unit.agent_id) && priorOwners.has(unit.agent_id)) {
    violations.push(violation(`${base}.agent_id`, "the current owner must be fresh after a reassignment"));
  }
  const liveChecks = Array.isArray(unit.local_checks) ? (unit.local_checks as readonly LocalCheck[]) : [];
  liveChecks.forEach((rawCheck, index) => {
    if (!isRecord(rawCheck)) return;
    if (isSecurityAgentId(rawCheck.agent_id) && priorOwners.has(rawCheck.agent_id)) {
      violations.push(violation(`${base}.local_checks[${index}].agent_id`, "prior owner evidence must stay archived"));
    }
    if (typeof rawCheck.artifact === "string" && priorArtifacts.has(rawCheck.artifact)) {
      violations.push(violation(`${base}.local_checks[${index}].artifact`, "an archived artifact cannot be reused"));
    }
  });
}

// --- Assignment ---

export type Assignment = Readonly<{ coverageId: string; agentId: string; wave?: number }>;

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
 *
 * `wave` is optional: an assignment that names none keeps the unit's current
 * wave. The default lives HERE, with the transition it describes, so no caller
 * has to look the unit up to supply it.
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
      wave: assignment.wave ?? unit.wave,
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
  | Readonly<{ kind: "unit-not-in-flight"; coverageId: string; status: CoverageStatus }>
  | Readonly<{ kind: "wrong-owner"; coverageId: string; expected: string | null; actual: string }>
  | Readonly<{ kind: "wrong-wave"; coverageId: string; expected: number; actual: number }>
  | Readonly<{ kind: "settlement-invalid"; coverageId: string; violations: readonly CoverageViolation[] }>;

/**
 * Settle one in-flight unit with a hunter's structured result. The owner and
 * wave must match the assignment: a sibling cannot settle another hunter's
 * unit, and a stale attempt cannot settle the current wave. A unit settles
 * ONCE per wave: a second settlement is refused rather than allowed to
 * overwrite the first, because silently replacing a `blocked` disposition with
 * a `covered` one is how an incomplete run becomes a complete claim. A
 * reassignment goes through `mergeCritic`, which archives the prior attempt.
 */
export function recordUnitResult(
  ledger: CoverageLedger,
  result: UnitResult,
): DomainResult<CoverageLedger, SettlementError> {
  const unit = ledger.find((candidate) => candidate.coverage_id === result.coverageId);
  if (unit === undefined) return failure({ kind: "unknown-coverage-id" as const, coverageId: result.coverageId });
  if (unit.status !== "in_progress") {
    return failure({ kind: "unit-not-in-flight" as const, coverageId: unit.coverage_id, status: unit.status });
  }
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

export type CriticError =
  | CoverageError
  | Readonly<{ kind: "reassign-unit-has-no-evidence"; coverageId: string; status: CoverageStatus }>
  /** A resolution the engine cannot place is not a resolution: silently dropping
   *  it would let the run keep reporting a lead the critic considered settled. */
  | Readonly<{ kind: "unplaceable-resolution"; fingerprint: string; reason: string }>;

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
    if (ownerId === undefined) {
      return failure({ kind: "unplaceable-resolution" as const, fingerprint, reason: "no owning unit recorded" });
    }
    const unit = next.find((candidate) => candidate.coverage_id === ownerId);
    if (unit === undefined) {
      return failure({ kind: "unplaceable-resolution" as const, fingerprint, reason: `unknown coverage ID ${ownerId}` });
    }
    if (!unit.unresolved.includes(fingerprint)) {
      return failure({ kind: "unplaceable-resolution" as const, fingerprint, reason: `${ownerId} does not carry this lead` });
    }
    next = replaceUnit(next, { ...unit, unresolved: unit.unresolved.filter((entry) => entry !== fingerprint) });
    resolved.push(fingerprint);
  }

  const violations = validateLedger(next);
  if (violations.length > 0) return failure(invalid(violations));
  return success({ ledger: next, accepted, reassigned, resolved, collisions });
}

/** Units a budget could not reach become explicitly `deferred`. The reason is
 *  mandatory: a deferred unit without one is a silent gap wearing a label.
 *  Returns a `DomainResult` like every other transition, so a blank `--reason`
 *  is a refusal the caller can render rather than an escaped `TypeError`. */
export function deferPlannedUnits(
  ledger: CoverageLedger,
  reason: string,
): DomainResult<CoverageLedger, CoverageError> {
  if (!isVisibleText(reason)) return failure(invalid([violation("reason", "a deferred unit requires a visible reason")]));
  const next = sortLedger(
    ledger.map((unit) =>
      unit.status === "planned"
        ? { ...unit, status: "deferred" as const, agent_id: null, unresolved: [reason] }
        : unit,
    ),
  );
  const violations = validateLedger(next);
  return violations.length === 0 ? success(next) : failure(invalid(violations));
}

export type DeferralError =
  | CoverageError
  | Readonly<{ kind: "unknown-coverage-id"; coverageId: string }>
  | Readonly<{ kind: "unit-not-planned"; coverageId: string; status: CoverageStatus }>;

/**
 * Defer ONE unit — the case where a hunter reports a surface it could not reach.
 * Same rule as the bulk path: the reason lands in `unresolved`, so neither the
 * report nor a later run has to guess why the unit was never covered.
 *
 * Only a `planned` unit may be deferred. Deferring an in-flight unit would erase
 * the owner's live attempt without archiving it, and deferring a settled one
 * would rewrite a record that already has a disposition.
 */
export function deferUnit(
  ledger: CoverageLedger,
  coverageId: string,
  reason: string,
): DomainResult<CoverageLedger, DeferralError> {
  if (!isVisibleText(reason)) {
    return failure(invalid([violation("reason", "a deferred unit requires a visible reason")]));
  }
  const unit = ledger.find((candidate) => candidate.coverage_id === coverageId);
  if (unit === undefined) return failure({ kind: "unknown-coverage-id" as const, coverageId });
  if (unit.status !== "planned") {
    return failure({ kind: "unit-not-planned" as const, coverageId, status: unit.status });
  }
  const next = sortLedger(ledger.map((candidate) => (candidate.coverage_id === coverageId
    ? { ...candidate, status: "deferred" as const, agent_id: null, unresolved: [reason] }
    : candidate)));
  const violations = validateLedger(next);
  return violations.length === 0 ? success(next) : failure(invalid(violations));
}

// --- Wire parsing ---

/**
 * Parse the coverage units a run is seeded with.
 *
 * The seeding payload arrives from the parent — a lens pass or an operator —
 * as JSON, so it is parsed here rather than trusted: every field is checked,
 * the first violation names its index, and a seed list that names the same
 * semantic tuple twice is refused instead of silently deduped (a duplicate
 * seed means the enumeration produced the same cell twice, which is worth
 * seeing).
 */
export function parseCoverageSeeds(
  raw: unknown,
): DomainResult<readonly CoverageUnit[], CoverageError> {
  if (!Array.isArray(raw as unknown)) {
    return failure(invalid([violation("units", "expected a top-level array")]));
  }
  const entries = raw as readonly unknown[];
  if (entries.length === 0) return failure(invalid([violation("units", "a run must seed at least one unit")]));
  if (entries.length > SECURITY_AUDIT_LIMITS.units) {
    return failure(invalid([violation("units", `exceeds ${SECURITY_AUDIT_LIMITS.units} coverage units`)]));
  }

  const units: CoverageUnit[] = [];
  const violations: CoverageViolation[] = [];
  entries.forEach((entry, index) => {
    const base = `units[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      violations.push(violation(base, "expected an object"));
      return;
    }
    const record = entry as Record<string, unknown>;
    const local: CoverageViolation[] = [];
    /** A present-but-malformed field is a violation, never an empty list: a
     *  silently dropped exclusion shrinks the truth the ledger claims. */
    const strings = (value: unknown, path: string): readonly string[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
        local.push(violation(path, "expected an array of strings"));
        return [];
      }
      return [...(value as readonly string[])];
    };
    const blocks = (value: unknown, path: string): readonly ExcludedBlock[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value)) {
        local.push(violation(path, "expected an array of blocks"));
        return [];
      }
      const kept: ExcludedBlock[] = [];
      (value as readonly unknown[]).forEach((item, blockIndex) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          local.push(violation(`${path}[${blockIndex}]`, "expected an object with a block and a reason"));
          return;
        }
        const block = item as Record<string, unknown>;
        if (!isVisibleText(block.block) || !isVisibleText(block.reason)) {
          local.push(violation(`${path}[${blockIndex}]`, "block and reason must be visible text"));
          return;
        }
        kept.push({ block: block.block as string, reason: block.reason as string });
      });
      return kept;
    };
    const ordinaryBlock = record.ordinary_attack_class_block;
    if (ordinaryBlock !== undefined && ordinaryBlock !== null && !isVisibleText(ordinaryBlock)) {
      local.push(violation(`${base}.ordinary_attack_class_block`, "expected null or visible text"));
    }
    if (record.status !== undefined && !isCoverageStatus(record.status)) {
      local.push(violation(`${base}.status`, `invalid value ${JSON.stringify(record.status)}`));
    }
    // Parsed, not cast: `derivePriorStatus` matches the verdict exhaustively and
    // `.exhaustive()` throws on an unknown tag, so an unchecked `prior` aborted
    // `start` with a pattern-match error instead of a named violation.
    const prior = parsePriorRecordFacts(record.prior);
    if (!prior.ok) local.push(violation(`${base}.${prior.error.path}`, prior.error.message));
    const seeded = seedCoverageUnit({
      refs: record.refs as CoverageRefs,
      starting_paths: strings(record.starting_paths, `${base}.starting_paths`),
      ordinary_attack_class_block: typeof ordinaryBlock === "string" ? ordinaryBlock : null,
      selected_companion_blocks: strings(record.selected_companion_blocks, `${base}.selected_companion_blocks`),
      excluded_blocks: blocks(record.excluded_blocks, `${base}.excluded_blocks`),
      prior: prior.ok ? prior.value : null,
      unresolved: strings(record.unresolved, `${base}.unresolved`),
      ...(typeof record.lifecycle === "string" ? { lifecycle: record.lifecycle } : {}),
      ...(typeof record.wave === "number" ? { wave: record.wave } : {}),
      ...(isCoverageStatus(record.status) ? { status: record.status } : {}),
    });
    violations.push(...local);
    if (seeded.ok) units.push(seeded.value);
    else violations.push(...seeded.error.violations.map((entry) => violation(`${base}.${entry.path}`, entry.message)));
  });

  const seen = new Map<string, string>();
  for (const unit of units) {
    const key = coverageSemanticKey(unit.canonical_refs);
    if (seen.has(key)) {
      violations.push(violation("units", `duplicate coverage cell ${JSON.stringify(unit.coverage_id)}`));
    } else {
      seen.set(key, unit.coverage_id);
    }
  }
  if (violations.length > 0) return failure(invalid(violations));

  const ledger = sortLedger(units);
  const ledgerViolations = validateLedger(ledger);
  return ledgerViolations.length === 0 ? success(ledger) : failure(invalid(ledgerViolations));
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

/** A hunter the Agent Catalog cannot place: the run knows the id hunted but
 *  cannot say which model profile it ran under. */
export type HuntingProfileError = Readonly<{ kind: "unresolvable-hunter"; agentId: string }>;

/** The catalog profiles that actually hunted, derived from the ledger's owned
 *  and archived units. Adjudication compares a ballot's profile against this
 *  set, so "verified by a different model" is read from the run's own record of
 *  who ran rather than from a second, caller-supplied field. Empty means the
 *  ledger names no hunter — a state adjudication refuses to treat as verified.
 *
 *  Fail closed on an owner the catalog cannot place. The ledger admits any id
 *  matching the agent grammar, and this function used to FILTER unresolvable
 *  owners out — so a hunter with no catalog row hunted, contributed nothing to
 *  the independence set, and a verifier on that hunter's own model profile was
 *  then counted as independent. An unanswerable question is a refusal, not an
 *  empty answer. Archived attempts count too: their owners hunted in an earlier
 *  wave of this same run. */
export function huntingProfiles(ledger: CoverageLedger): DomainResult<readonly LlmProfileId[], HuntingProfileError> {
  const profiles = new Set<LlmProfileId>();
  for (const unit of ledger) {
    for (const agentId of [unit.agent_id, ...unit.attempts.map((attempt) => attempt.agent_id)]) {
      if (agentId === null) continue;
      const profile = catalogProfileOfAgent(agentId);
      if (profile === null) return failure({ kind: "unresolvable-hunter" as const, agentId });
      profiles.add(profile);
    }
  }
  return success([...profiles].sort(compareStrings));
}

/** The profile of a run, derived from its ledger in ONE place. `start` and
 *  `publish` both ask this question, and answering it twice produced two
 *  predicates that disagreed about the same ledger. */
export type RunStatusProjection = Readonly<{
  runStatus: "in_progress" | "complete" | "incomplete";
  incompleteReason: SecurityIncompleteReason | null;
}>;

/**
 * A run is `in_progress` until every unit is terminal, `complete` only when no
 * unit is a disclosed gap, and `incomplete` when settled coverage still holds
 * deferred units.
 *
 * The reason comes from the deferred units' own recorded reason when it names an
 * upstream token; otherwise it is the class a deferral belongs to — coverage
 * stopped before the remaining units were verified. Nothing here invents a
 * cause: the ledger's prose stays authoritative and the report prints it beside
 * the token.
 */
export function runStatusOf(ledger: CoverageLedger): RunStatusProjection {
  if (!coverageSettled(ledger)) return { runStatus: "in_progress", incompleteReason: null };
  if (coverageComplete(ledger)) return { runStatus: "complete", incompleteReason: null };
  const recorded = ledger
    .flatMap((unit) => (unit.status === "deferred" ? unit.unresolved : []))
    .find((reason): reason is SecurityIncompleteReason =>
      (SECURITY_INCOMPLETE_REASONS as readonly string[]).includes(reason));
  return { runStatus: "incomplete", incompleteReason: recorded ?? "validation_budget_exhausted" };
}

/** A run may claim COMPLETE coverage only when nothing is planned, in progress,
 *  blocked or deferred. `not_applicable` and `out_of_scope` are settled.
 *  An empty ledger claims nothing: `every` over `[]` would call it complete. */
export function coverageComplete(ledger: CoverageLedger): boolean {
  return ledger.length > 0 && ledger.every((unit) =>
    unit.status === "covered" || unit.status === "candidate" || unit.status === "not_applicable" || unit.status === "out_of_scope",
  );
}

/** SETTLED coverage allows disclosed deferrals: every unit reached a terminal
 *  state, but some are gaps with a reason. A settled run reports; a complete
 *  run claims. An empty ledger is not settled coverage of anything. */
export function coverageSettled(ledger: CoverageLedger): boolean {
  return ledger.length > 0 && ledger.every((unit) => unit.status !== "planned" && unit.status !== "in_progress" && unit.status !== "blocked");
}

/**
 * Parse the settlement payload a hunter's parent submits.
 *
 * `recordUnitResult` checks the SETTLEMENT (owner, wave, resulting ledger); this
 * checks the SHAPE, because a missing `checks` array would otherwise throw on
 * `.map` deep inside the ledger builder rather than naming the field. The two
 * are deliberately separate: the state machine is about one unit's transition,
 * this is about the wire.
 */
/** One check as it arrives on the wire, validated field by field. Split from
 *  `parseUnitResults` because a check's fields fail for different reasons than a
 *  unit's, and a violation naming `units[0].checks[1].artifact` is a shorter
 *  path to the defect than one naming the unit again. */
function parseChecks(raw: unknown, base: string, violations: CoverageViolation[]): readonly LocalCheck[] {
  if (!Array.isArray(raw as unknown)) {
    violations.push(violation(`${base}.checks`, "expected an array of local checks"));
    return [];
  }
  const checks: LocalCheck[] = [];
  (raw as readonly unknown[]).forEach((check, checkIndex) => {
    const path = `${base}.checks[${checkIndex}]`;
    if (check === null || typeof check !== "object" || Array.isArray(check)) {
      violations.push(violation(path, "expected an object"));
      return;
    }
    const item = check as Record<string, unknown>;
    const local: CoverageViolation[] = [];
    for (const key of Object.keys(item)) {
      if (!CHECK_KEYS.includes(key)) local.push(violation(`${path}.${key}`, "unknown field"));
    }
    if (!isSecurityAgentId(item.agent_id)) local.push(violation(`${path}.agent_id`, "expected a catalog agent id"));
    if (!Array.isArray(item.reviewed_paths as unknown) ||
        !(item.reviewed_paths as readonly unknown[]).every((entry) => typeof entry === "string")) {
      local.push(violation(`${path}.reviewed_paths`, "expected an array of source paths"));
    }
    if (!isVisibleText(item.invariant)) local.push(violation(`${path}.invariant`, "requires visible prose"));
    if (item.method !== "source" && item.method !== "local") local.push(violation(`${path}.method`, "expected source or local"));
    if (!isVisibleText(item.result)) local.push(violation(`${path}.result`, "requires visible prose"));
    if (item.artifact !== null && typeof item.artifact !== "string") {
      local.push(violation(`${path}.artifact`, "expected null or an artifacts path"));
    }
    // A local check is the one that claims something OBSERVED, so it must name
    // the receipt: `local` with `artifact: null` is a claim with no proof.
    if (item.method === "local" && typeof item.artifact !== "string") {
      local.push(violation(`${path}.artifact`, "a local check must name its receipt"));
    }
    if (local.length > 0) {
      violations.push(...local);
      return;
    }
    checks.push({
      agent_id: item.agent_id as string,
      reviewed_paths: [...(item.reviewed_paths as readonly string[])],
      invariant: item.invariant as string,
      method: item.method as LocalCheck["method"],
      result: item.result as string,
      artifact: item.artifact as string | null,
    });
  });
  return checks;
}

/** The keys a hunter's unit result may carry. Closed on purpose: an invented
 *  spelling (`unitStatus`, `localChecks`) would otherwise be IGNORED while the
 *  required fields happen to be present, and the run would record a status the
 *  hunter never wrote. */
/** The keys a hunter's unit result may carry. Closed on purpose: an invented
 *  spelling (`unitStatus`, `localChecks`) would otherwise be IGNORED while the
 *  required fields happen to be present, and the run would record a status the
 *  hunter never wrote. Exported so the docs test pins the docs to THIS list
 *  rather than to a hand-copied one. */
export const UNIT_RESULT_KEYS: readonly string[] = [
  "coverageId", "agentId", "wave", "status", "reviewedPaths", "checks", "fingerprints", "unresolved",
];

/** The keys one local check may carry, mirroring the ledger's own shape. */
export const CHECK_KEYS: readonly string[] = ["agent_id", "reviewed_paths", "invariant", "method", "result", "artifact"];

export function parseUnitResults(raw: unknown): DomainResult<readonly UnitResult[], CoverageError> {
  if (!Array.isArray(raw as unknown)) {
    return failure(invalid([violation("units", "expected a top-level array")]));
  }
  const violations: CoverageViolation[] = [];
  const results: UnitResult[] = [];

  (raw as readonly unknown[]).forEach((entry, index) => {
    const base = `units[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      violations.push(violation(base, "expected an object"));
      return;
    }
    const record = entry as Record<string, unknown>;
    const local: CoverageViolation[] = [];
    for (const key of Object.keys(record)) {
      if (!UNIT_RESULT_KEYS.includes(key)) local.push(violation(`${base}.${key}`, "unknown field"));
    }
    if (!isVisibleText(record.coverageId)) local.push(violation(`${base}.coverageId`, "expected the canonical coverage ID"));
    if (!isSecurityAgentId(record.agentId)) local.push(violation(`${base}.agentId`, "expected a catalog agent id"));
    if (typeof record.wave !== "number" || !Number.isInteger(record.wave) || record.wave < 1) {
      local.push(violation(`${base}.wave`, "expected a positive integer"));
    }
    if (!(TERMINAL_DISPOSITIONS as readonly string[]).includes(record.status as string)) {
      local.push(violation(`${base}.status`, "expected covered, candidate or blocked"));
    }
    if (!Array.isArray(record.reviewedPaths as unknown) ||
        !(record.reviewedPaths as readonly unknown[]).every((path) => typeof path === "string")) {
      local.push(violation(`${base}.reviewedPaths`, "expected an array of source paths"));
    }
    const checks = parseChecks(record.checks, base, local);
    if (local.length > 0) {
      violations.push(...local);
      return;
    }
    results.push({
      coverageId: record.coverageId as string,
      agentId: record.agentId as string,
      wave: record.wave as number,
      status: record.status as TerminalDisposition,
      reviewedPaths: [...(record.reviewedPaths as readonly string[])],
      checks,
      ...(Array.isArray(record.fingerprints as unknown) ? { fingerprints: [...(record.fingerprints as readonly string[])] } : {}),
      ...(Array.isArray(record.unresolved as unknown) ? { unresolved: [...(record.unresolved as readonly string[])] } : {}),
    });
  });

  return violations.length === 0 ? success(results) : failure(invalid(violations));
}

/**
 * Parse a coverage critic's proposal set. `mergeCritic` decides what each
 * proposal MEANS; this decides whether the payload is a critic result at all,
 * so a typo in `missingUnits` is a named violation rather than an empty merge
 * that looks like "the critic found nothing".
 *
 * Fail-closed on purpose: every key is allowlisted, the three collections are
 * required (a critic that sends `{}` has not said "nothing to report", it has
 * said nothing), and every element is checked before it is kept.
 */
export function parseCriticResult(raw: unknown): DomainResult<CoverageCriticResult, CoverageError> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return failure(invalid([violation("critic", "expected an object")]));
  }
  const record = raw as Record<string, unknown>;
  const violations: CoverageViolation[] = [];
  for (const key of Object.keys(record)) {
    if (!CRITIC_KEYS.includes(key)) violations.push(violation(`critic.${key}`, "unknown field"));
  }
  // Identity first: a document with no `kind` is a document the run cannot
  // prove came from the critic, and the critic's verdict is what licenses
  // `publish` to call a run complete.
  if (record.schemaVersion !== 1) violations.push(violation("critic.schemaVersion", "expected 1"));
  if (record.kind !== "security-coverage-critic") {
    violations.push(violation("critic.kind", "expected security-coverage-critic"));
  }
  for (const key of CRITIC_COLLECTIONS) {
    if (!Array.isArray(record[key])) violations.push(violation(`critic.${key}`, "expected an array"));
  }
  const proposals = parseProposals(record.missingUnits, violations);
  if (record.stop !== undefined && typeof record.stop !== "boolean") {
    violations.push(violation("critic.stop", "expected a boolean"));
  }
  const reassignIds = stringList(record.reassignIds, "critic.reassignIds", violations);
  const resolvedPriorLeads = stringList(record.resolvedPriorLeads, "critic.resolvedPriorLeads", violations);
  if (violations.length > 0) return failure(invalid(violations));
  return success({
    missingUnits: proposals,
    reassignIds,
    resolvedPriorLeads,
    stop: record.stop === true,
  });
}

/** A collection of strings, or the violation that says which one was not. */
function stringList(value: unknown, path: string, violations: CoverageViolation[]): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    violations.push(violation(path, "expected an array of strings"));
    return [];
  }
  return [...(value as readonly string[])];
}

/** The critic's proposed units: a cell the ledger is missing, with the evidence
 *  a hunter needs to hunt it. */
function parseProposals(raw: unknown, violations: CoverageViolation[]): readonly CoverageProposal[] {
  if (raw !== undefined && !Array.isArray(raw as unknown)) {
    violations.push(violation("critic.missingUnits", "expected an array of proposals"));
    return [];
  }
  const proposals: CoverageProposal[] = [];
  (Array.isArray(raw as unknown) ? raw as readonly unknown[] : []).forEach((entry, index) => {
    const base = `critic.missingUnits[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      violations.push(violation(base, "expected an object"));
      return;
    }
    const item = entry as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      if (!CRITIC_PROPOSAL_KEYS.includes(key)) violations.push(violation(`${base}.${key}`, "unknown field"));
    }
    proposals.push({
      refs: item.refs as CoverageRefs,
      startingPaths: stringList(item.startingPaths, `${base}.startingPaths`, violations),
      ordinaryAttackClassBlock: typeof item.ordinaryAttackClassBlock === "string" ? item.ordinaryAttackClassBlock : null,
      selectedCompanionBlocks: stringList(item.selectedCompanionBlocks, `${base}.selectedCompanionBlocks`, violations),
      excludedBlocks: parseExcludedBlocks(item.excludedBlocks, `${base}.excludedBlocks`, violations),
    });
  });
  return proposals;
}

export const CRITIC_KEYS: readonly string[] = ["schemaVersion", "kind", "missingUnits", "reassignIds", "resolvedPriorLeads", "stop"];
const CRITIC_COLLECTIONS: readonly string[] = ["missingUnits", "reassignIds", "resolvedPriorLeads"];

/** The keys one proposed unit may carry. Exported for the same reason as
 *  `UNIT_RESULT_KEYS`: a doc that names a key this list omits is an agent whose
 *  output the engine refuses. */
export const CRITIC_PROPOSAL_KEYS: readonly string[] = [
  "refs", "startingPaths", "ordinaryAttackClassBlock", "selectedCompanionBlocks", "excludedBlocks",
];

/** Exclusions are evidence, so a malformed entry is a violation rather than an
 *  entry that quietly never happened. */
function parseExcludedBlocks(raw: unknown, path: string, violations: CoverageViolation[]): readonly ExcludedBlock[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    violations.push(violation(path, "expected an array of blocks"));
    return [];
  }
  const kept: ExcludedBlock[] = [];
  (raw as readonly unknown[]).forEach((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      violations.push(violation(`${path}[${index}]`, "expected an object with a block and a reason"));
      return;
    }
    const block = item as Record<string, unknown>;
    if (!isVisibleText(block.block) || !isVisibleText(block.reason)) {
      violations.push(violation(`${path}[${index}]`, "block and reason must be visible text"));
      return;
    }
    kept.push({ block: block.block as string, reason: block.reason as string });
  });
  return kept;
}
