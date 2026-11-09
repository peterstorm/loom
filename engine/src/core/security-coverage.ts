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
import { catalogProfileOfAgent } from "./model-profiles";
import { failure, success, type DomainResult } from "./orchestration-contract/identity";
import { parseSecurityFindings, type SecurityFinding } from "./security-findings";
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
  isWireRecord,
  parseCoverageRefs,
  parsePriorRecordFacts,
  wireStringList,
  wireViolation,
  type CoverageRefs,
  type PriorStatus,
  type SecurityIncompleteReason,
  type WireViolation,
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

const isTerminalDisposition = (value: unknown): value is TerminalDisposition =>
  typeof value === "string" && (TERMINAL_DISPOSITIONS as readonly string[]).includes(value);

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

/** The ledger's name for the shared wire diagnostic. */
export type CoverageViolation = WireViolation;

export type CoverageError = Readonly<{
  kind: "invalid-coverage-operation";
  violations: readonly CoverageViolation[];
}>;

/** A ledger arrives as `JSON.parse` output, so every field below can be any
 *  JSON value. `entriesOf` is the one shape guard: a non-array becomes a named
 *  violation and an empty list, so validation stays total instead of throwing
 *  on the document it was asked to judge. */
const entriesOf = (value: unknown, path: string, violations: CoverageViolation[]): readonly unknown[] => {
  if (Array.isArray(value)) return value;
  violations.push(wireViolation(path, "expected an array"));
  return [];
};

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
 * enter a ledger by accident. Every violation is reported at once, so a seed
 * with three defects is repaired in one pass rather than three.
 */
export function seedCoverageUnit(seed: CoverageSeed): DomainResult<CoverageUnit, CoverageError> {
  const violations: CoverageViolation[] = [];
  const refs = parseCoverageRefs(seed.refs);
  if (!refs.ok) {
    violations.push(wireViolation("canonical_refs", refs.error.message));
    return failure(invalid(violations));
  }
  const value = refs.value;
  if (value.lifecycle !== undefined && seed.lifecycle !== undefined && value.lifecycle !== seed.lifecycle) {
    violations.push(wireViolation("lifecycle", "lifecycle and canonical_refs.lifecycle disagree"));
  }
  checkSeedEvidence(seed, violations);
  const status = seed.status ?? "planned";
  const unresolved = seed.unresolved ?? [];
  checkSeedState(status, unresolved, violations);
  const wave = seed.wave ?? 1;
  if (!Number.isInteger(wave) || wave < 1) violations.push(wireViolation("wave", "expected a positive integer"));
  if (violations.length > 0) return failure(invalid(violations));

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
    wave,
    status,
    agent_id: null,
    reviewed_paths: [],
    local_checks: [],
    result_fingerprints: [],
    unresolved: [...unresolved],
  });
}

/** The seed's hunting material: safe starting paths, visible block references,
 *  and exclusions that never name a selected block. */
function checkSeedEvidence(seed: CoverageSeed, violations: CoverageViolation[]): void {
  if (seed.starting_paths.length === 0) {
    violations.push(wireViolation("starting_paths", "at least one starting path is required"));
  }
  for (const path of seed.starting_paths) {
    if (!isSafeSourcePath(path)) violations.push(wireViolation("starting_paths", `unsafe source path ${JSON.stringify(path)}`));
  }
  if (seed.ordinary_attack_class_block !== null && !isVisibleText(seed.ordinary_attack_class_block)) {
    violations.push(wireViolation("ordinary_attack_class_block", "expected null or visible text"));
  }
  for (const block of seed.selected_companion_blocks) {
    if (!isVisibleText(block)) violations.push(wireViolation("selected_companion_blocks", "invalid block reference"));
  }
  for (const entry of seed.excluded_blocks) {
    if (!isVisibleText(entry.block) || !isVisibleText(entry.reason)) {
      violations.push(wireViolation("excluded_blocks", "block and reason must be visible text"));
    }
  }
  const selected = new Set(seed.selected_companion_blocks);
  for (const entry of seed.excluded_blocks) {
    if (selected.has(entry.block)) violations.push(wireViolation("excluded_blocks", `block ${entry.block} is also selected`));
  }
}

/** The state rule `validateLedger` enforces, applied at CONSTRUCTION: a seeded
 *  unit that is already settled as a gap names why, and a planned one has
 *  nothing unresolved yet. Checked here so the refusal names the seed field,
 *  not a ledger index the caller never wrote. */
function checkSeedState(status: CoverageStatus, unresolved: readonly string[], violations: CoverageViolation[]): void {
  if (status !== "planned" && status !== "out_of_scope" && status !== "deferred" && status !== "not_applicable") {
    violations.push(wireViolation("status", "a seeded unit may only start planned, not_applicable, out_of_scope or deferred"));
  } else if (status === "planned" && unresolved.length > 0) {
    violations.push(wireViolation("unresolved", "a planned unit has nothing unresolved yet"));
  } else if (status !== "planned" && unresolved.length === 0) {
    violations.push(wireViolation("unresolved", `status ${status} requires the reason it is not hunted`));
  }
  checkEntryArray(unresolved, "unresolved", violations, "text", { allowEmpty: true });
}

// --- Sorting ---

/** Canonical order: lexicographic by canonical id. Every returned ledger is
 *  sorted, so two runs that produce the same units produce the same bytes. */
export const sortLedger = (ledger: CoverageLedger): CoverageLedger =>
  [...ledger].sort((left, right) => compareStrings(left.coverage_id, right.coverage_id));

// --- Validation ---

/** An artifact path under one owner's own artifacts root, parsed: the run-relative
 *  `agents/<owner>/artifacts/<file…>` and the owner id it names. */
export type OwnedArtifactPath = Readonly<{ path: string; owner: string }>;

/** The one reading of an owned artifact path: a safe run-relative path whose
 *  first three segments are `agents`, a canonical owner id and `artifacts`, with
 *  at least one segment below. Validation and nonce admission both read it here,
 *  so "whose artifact is this" has one answer. */
export function parseOwnedArtifactPath(value: unknown): OwnedArtifactPath | null {
  if (!isSafeSourcePath(value)) return null;
  const [root, owner, artifacts, ...below] = value.split("/");
  return root === "agents" && isSecurityAgentId(owner) && artifacts === "artifacts" && below.length > 0
    ? { path: value, owner }
    : null;
}

const isSafeOwnedArtifactPath = (value: unknown, agentId: unknown): boolean =>
  parseOwnedArtifactPath(value)?.owner === agentId;

/** The per-kind entry guard and the violation it reports. */
const ENTRY_RULES: Readonly<Record<"path" | "fingerprint" | "text", Readonly<{ valid: (entry: unknown) => boolean; message: string }>>> = {
  path: { valid: isSafeSourcePath, message: "unsafe source path" },
  fingerprint: { valid: isSecurityFingerprint, message: "invalid fingerprint" },
  text: { valid: isVisibleText, message: "invalid text" },
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
    violations.push(wireViolation(path, "expected an array"));
    return;
  }
  if (value.length > SECURITY_AUDIT_LIMITS.collectionItems) {
    violations.push(wireViolation(path, "too many entries"));
    return;
  }
  if (!options.allowEmpty && value.length === 0) violations.push(wireViolation(path, "requires at least one entry"));
  const seen = new Set<string>();
  const rule = ENTRY_RULES[kind];
  for (const entry of value) {
    if (!rule.valid(entry)) violations.push(wireViolation(path, rule.message));
    if (typeof entry === "string") {
      if (seen.has(entry)) violations.push(wireViolation(path, "duplicate entry"));
      seen.add(entry);
    }
  }
}

function validateLocalChecks(raw: unknown, path: string, violations: CoverageViolation[]): void {
  if (!Array.isArray(raw)) {
    violations.push(wireViolation(path, "expected an array of checks"));
    return;
  }
  const checks: readonly unknown[] = raw;
  if (checks.length > SECURITY_AUDIT_LIMITS.collectionItems) {
    violations.push(wireViolation(path, "too many checks"));
    return;
  }
  checks.forEach((check, index) => {
    const base = `${path}[${index}]`;
    if (!isWireRecord(check)) {
      violations.push(wireViolation(base, "expected an object"));
      return;
    }
    if (!isSecurityAgentId(check.agent_id)) violations.push(wireViolation(`${base}.agent_id`, "expected a canonical lowercase agent ID"));
    // Totality: `reviewed_paths` arrives as raw JSON, so a missing or
    // non-array value is a violation — never a `.length` on `undefined`.
    const reviewedPaths: readonly unknown[] = Array.isArray(check.reviewed_paths) ? check.reviewed_paths : [];
    if (!Array.isArray(check.reviewed_paths)) {
      violations.push(wireViolation(`${base}.reviewed_paths`, "expected an array of source paths"));
    } else if (reviewedPaths.length === 0) {
      violations.push(wireViolation(`${base}.reviewed_paths`, "a check must review at least one path"));
    }
    for (const reviewed of reviewedPaths) {
      if (!isSafeSourcePath(reviewed)) violations.push(wireViolation(`${base}.reviewed_paths`, `unsafe source path ${JSON.stringify(reviewed)}`));
    }
    if (!isVisibleText(check.invariant)) violations.push(wireViolation(`${base}.invariant`, "invalid text"));
    if (!isVisibleText(check.result)) violations.push(wireViolation(`${base}.result`, "invalid text"));
    if (check.method === "source" && check.artifact !== null) {
      violations.push(wireViolation(`${base}.artifact`, "a source check must use null"));
    }
    if (check.method === "local" && !isSafeOwnedArtifactPath(check.artifact, check.agent_id)) {
      violations.push(wireViolation(`${base}.artifact`, "a local check cites an artifact under its own agent's artifacts root"));
    }
  });
}

/** The unit's reviewed paths are exactly the union of its checks' owned paths:
 *  a claimed path without a check is an unreviewed claim. */
function validatePathOwnership(
  unit: Readonly<{ reviewed_paths?: unknown; local_checks?: unknown }>,
  path: string,
  violations: CoverageViolation[],
): void {
  const checks: readonly unknown[] = Array.isArray(unit.local_checks) ? unit.local_checks : [];
  const owned = new Set(checks.flatMap((check) => (isWireRecord(check) && Array.isArray(check.reviewed_paths) ? check.reviewed_paths : [])));
  const claimed = new Set(Array.isArray(unit.reviewed_paths) ? unit.reviewed_paths : []);
  for (const reviewed of claimed) {
    if (!owned.has(reviewed)) violations.push(wireViolation(`${path}.reviewed_paths`, `${JSON.stringify(reviewed)} has no check owner`));
  }
  for (const reviewed of owned) {
    if (!claimed.has(reviewed)) violations.push(wireViolation(`${path}.local_checks`, `owned path ${JSON.stringify(reviewed)} is absent from reviewed_paths`));
  }
}

function validateStateInvariants(
  unit: Readonly<{ status?: unknown; agent_id?: unknown; reviewed_paths?: unknown; local_checks?: unknown; result_fingerprints?: unknown; unresolved?: unknown }>,
  path: string,
  violations: CoverageViolation[],
): void {
  const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0);
  const requireOwner = (): void => {
    if (!isSecurityAgentId(unit.agent_id)) violations.push(wireViolation(`${path}.agent_id`, `status ${unit.status} requires an owner`));
  };
  const requireUnassigned = (): void => {
    if (unit.agent_id !== null) violations.push(wireViolation(`${path}.agent_id`, `status ${unit.status} must be unassigned`));
  };
  const requireEmptyEvidence = (): void => {
    if (count(unit.reviewed_paths) > 0) violations.push(wireViolation(`${path}.reviewed_paths`, `status ${unit.status} keeps this empty`));
    if (count(unit.local_checks) > 0) violations.push(wireViolation(`${path}.local_checks`, `status ${unit.status} keeps this empty`));
  };
  const requireEvidence = (): void => {
    if (count(unit.reviewed_paths) === 0) violations.push(wireViolation(`${path}.reviewed_paths`, `status ${unit.status} requires entries`));
    if (count(unit.local_checks) === 0) violations.push(wireViolation(`${path}.local_checks`, `status ${unit.status} requires entries`));
  };
  const requireUnresolved = (present: boolean): void => {
    if (present && count(unit.unresolved) === 0) violations.push(wireViolation(`${path}.unresolved`, `status ${unit.status} requires unresolved facts`));
    if (!present && count(unit.unresolved) > 0) violations.push(wireViolation(`${path}.unresolved`, `status ${unit.status} keeps this empty`));
  };

  if (unit.status !== "candidate" && count(unit.result_fingerprints) > 0) {
    violations.push(wireViolation(`${path}.result_fingerprints`, `status ${unit.status} keeps this empty`));
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
      if (count(unit.result_fingerprints) === 0) violations.push(wireViolation(`${path}.result_fingerprints`, "candidate requires fingerprints"));
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
    violations.push(wireViolation("$", "expected a top-level array"));
    return violations;
  }
  if (ledger.length > SECURITY_AUDIT_LIMITS.units) {
    violations.push(wireViolation("$", `exceeds ${SECURITY_AUDIT_LIMITS.units} coverage units`));
    return violations;
  }

  const placement: LedgerPlacement = { byId: new Map(), bySemantics: new Map(), previousId: null };
  ledger.forEach((unit, index) => {
    const base = `$[${index}]`;
    if (!isWireRecord(unit)) {
      violations.push(wireViolation(base, "expected an object"));
      return;
    }
    const semanticKey = checkUnitIdentity(unit, base, violations);
    checkUnitFields(unit, base, violations);
    validateLocalChecks(unit.local_checks, `${base}.local_checks`, violations);
    validatePathOwnership(unit, base, violations);
    validateStateInvariants(unit, base, violations);
    validateAttempts(unit, base, violations);
    checkUnitPlacement(placement, { unit, index, semanticKey }, violations);
  });

  return violations;
}

/** The unit's identity against its canonical refs. Returns the semantic key, or
 *  null when the refs did not parse: the key is derived from PARSED refs, and
 *  asking an unparsed unit for one is how totality leaked a throw. */
function checkUnitIdentity(unit: CoverageUnit, base: string, violations: CoverageViolation[]): string | null {
  const parsed = parseCoverageRefs(unit.canonical_refs);
  if (!parsed.ok) {
    violations.push(wireViolation(`${base}.canonical_refs`, parsed.error.message));
    return null;
  }
  const expected = canonicalCoverageId(parsed.value);
  if (unit.coverage_id !== expected) {
    violations.push(wireViolation(`${base}.coverage_id`, `expected canonical ID ${JSON.stringify(expected)}`));
  }
  if (unit.surface !== parsed.value.surface || unit.boundary !== parsed.value.boundary ||
      unit.subsystem !== parsed.value.subsystem || unit.attack_class !== parsed.value.attack_class ||
      unit.lifecycle !== parsed.value.lifecycle) {
    violations.push(wireViolation(`${base}`, "semantic fields must equal canonical_refs"));
  }
  return coverageSemanticKey(parsed.value);
}

/** Every per-unit scalar and collection field, checked as wire data. */
function checkUnitFields(unit: CoverageUnit, base: string, violations: CoverageViolation[]): void {
  if (!isSecurityAgentId(unit.agent_id) && unit.agent_id !== null) {
    violations.push(wireViolation(`${base}.agent_id`, "expected null or a canonical lowercase agent ID"));
  }
  if (!Number.isInteger(unit.wave) || unit.wave < 1) violations.push(wireViolation(`${base}.wave`, "expected a positive integer"));
  if (!(PRIOR_STATUSES as readonly string[]).includes(unit.prior_status)) {
    violations.push(wireViolation(`${base}.prior_status`, `invalid value ${JSON.stringify(unit.prior_status)}`));
  }
  if (!isCoverageStatus(unit.status)) {
    violations.push(wireViolation(`${base}.status`, `invalid value ${JSON.stringify(unit.status)}`));
  }
  checkEntryArray(unit.starting_paths, `${base}.starting_paths`, violations, "path");
  if (unit.ordinary_attack_class_block !== null && !isVisibleText(unit.ordinary_attack_class_block)) {
    violations.push(wireViolation(`${base}.ordinary_attack_class_block`, "expected null or visible text"));
  }
  checkEntryArray(unit.selected_companion_blocks, `${base}.selected_companion_blocks`, violations, "text", { allowEmpty: true });
  checkExcludedBlocks(unit, base, violations);
  checkEntryArray(unit.reviewed_paths, `${base}.reviewed_paths`, violations, "path", { allowEmpty: true });
  checkEntryArray(unit.result_fingerprints, `${base}.result_fingerprints`, violations, "fingerprint", { allowEmpty: true });
  checkEntryArray(unit.unresolved, `${base}.unresolved`, violations, "text", { allowEmpty: true });
}

/** Exclusions: visible, unique, and never also selected. Read as wire data, so
 *  the comparisons are over whatever the document holds. */
function checkExcludedBlocks(unit: CoverageUnit, base: string, violations: CoverageViolation[]): void {
  const seen = new Set<unknown>();
  const selected: readonly unknown[] = Array.isArray(unit.selected_companion_blocks) ? unit.selected_companion_blocks : [];
  entriesOf(unit.excluded_blocks, `${base}.excluded_blocks`, violations).forEach((entry, index) => {
    const path = `${base}.excluded_blocks[${index}]`;
    if (!isWireRecord(entry)) {
      violations.push(wireViolation(path, "expected an object"));
      return;
    }
    if (!isVisibleText(entry.block) || !isVisibleText(entry.reason)) {
      violations.push(wireViolation(path, "block and reason must be visible text"));
    }
    if (seen.has(entry.block)) violations.push(wireViolation(`${path}.block`, "duplicate block"));
    seen.add(entry.block);
    if (selected.includes(entry.block)) violations.push(wireViolation(`${path}.block`, "block is also selected"));
  });
}

/** What one `validateLedger` pass has seen so far: ids, semantic tuples, and the
 *  previous id for the sort check. Never escapes the call that owns it. */
type LedgerPlacement = {
  byId: Map<string, number>;
  bySemantics: Map<string, Readonly<{ id: string; index: number }>>;
  previousId: string | null;
};

/** One unit's place in the ledger: its semantic tuple and id are unique, and
 *  ids are sorted. */
function checkUnitPlacement(
  placement: LedgerPlacement,
  at: Readonly<{ unit: CoverageUnit; index: number; semanticKey: string | null }>,
  violations: CoverageViolation[],
): void {
  const { unit, index, semanticKey } = at;
  const base = `$[${index}]`;
  const previous = semanticKey === null ? undefined : placement.bySemantics.get(semanticKey);
  if (previous !== undefined && previous.id !== unit.coverage_id) {
    violations.push(wireViolation(`${base}.canonical_refs`, `semantic tuple already uses ${JSON.stringify(previous.id)} at $[${previous.index}]`));
  } else if (previous === undefined && semanticKey !== null) {
    placement.bySemantics.set(semanticKey, { id: unit.coverage_id, index });
  }
  if (placement.byId.has(unit.coverage_id)) {
    violations.push(wireViolation(`${base}.coverage_id`, `duplicate coverage ID at $[${placement.byId.get(unit.coverage_id)}]`));
  } else {
    placement.byId.set(unit.coverage_id, index);
  }
  if (placement.previousId !== null && compareStrings(placement.previousId, unit.coverage_id) > 0) {
    violations.push(wireViolation(`${base}.coverage_id`, "units must be sorted lexicographically"));
  }
  placement.previousId = unit.coverage_id;
}

/**
 * Parse a stored ledger document. The read path's one parser: a top-level
 * array, at least one unit (an empty ledger would make `every(...)` claim
 * complete coverage of nothing — the seed path refuses it, so the read path
 * must too), and every rule `validateLedger` enforces.
 *
 * `validateLedger` reads every field as wire data — it is total over any JSON —
 * so the array is handed to it as-is and returned only once it holds no
 * violation: the value a caller receives is the one the validator proved.
 */
export function parseLedger(raw: unknown): DomainResult<CoverageLedger, CoverageError> {
  if (!Array.isArray(raw)) return failure(invalid([wireViolation("ledger", "expected a top-level array")]));
  if (raw.length === 0) return failure(invalid([wireViolation("ledger", "a run always seeds at least one unit")]));
  const candidate: CoverageLedger = raw;
  const violations = validateLedger(candidate);
  return violations.length === 0 ? success(candidate) : failure(invalid(violations));
}

function validateAttempts(unit: CoverageUnit, base: string, violations: CoverageViolation[]): void {
  const attempts = entriesOf(unit.attempts, `${base}.attempts`, violations);
  if (attempts.length > SECURITY_AUDIT_LIMITS.attemptsPerUnit) {
    violations.push(wireViolation(`${base}.attempts`, "too many archived attempts"));
    return;
  }
  const history: AttemptHistory = { owners: new Set(), artifacts: new Set(), previousWave: 0 };
  attempts.forEach((attempt, index) => {
    const path = `${base}.attempts[${index}]`;
    if (!isWireRecord(attempt)) {
      violations.push(wireViolation(path, "expected an object"));
      return;
    }
    checkArchivedAttempt(attempt, { currentWave: unit.wave, path, history }, violations);
  });

  if (!Array.isArray(unit.attempts)) return;
  checkLiveEvidenceIsFresh(unit, base, history, violations);
}

/** What a unit's archived attempts have spent so far: their owners and their
 *  local artifacts, and the last archived wave. Local to one `validateAttempts`. */
type AttemptHistory = { owners: Set<string>; artifacts: Set<string>; previousWave: number };

/** One archived attempt: a settled record with a fresh owner, earlier than the
 *  unit's current wave, whose evidence reuses nothing a prior attempt spent. */
function checkArchivedAttempt(
  attempt: Readonly<Record<string, unknown>>,
  at: Readonly<{ currentWave: number; path: string; history: AttemptHistory }>,
  violations: CoverageViolation[],
): void {
  const { currentWave, path, history } = at;
  const wave = attempt.wave;
  if (typeof wave !== "number" || !Number.isInteger(wave) || wave < 1) {
    violations.push(wireViolation(`${path}.wave`, "expected a positive integer"));
  } else {
    if (wave <= history.previousWave) violations.push(wireViolation(`${path}.wave`, "archived waves must strictly increase"));
    if (wave >= currentWave) violations.push(wireViolation(`${path}.wave`, `archived wave must precede current wave ${currentWave}`));
    history.previousWave = wave;
  }
  if (!isTerminalDisposition(attempt.status)) {
    violations.push(wireViolation(`${path}.status`, "archived attempts settle as covered, candidate or blocked"));
  }
  const freshOwner = checkAttemptOwner(attempt.agent_id, path, history, violations);
  checkAttemptEvidence(attempt, path, violations);
  checkSpentArtifacts(attempt.local_checks, path, history, violations);
  // The attempt's own owner joins the prior set only AFTER its checks are read:
  // an attempt's evidence is its own, not a prior owner's.
  if (freshOwner !== null) history.owners.add(freshOwner);
}

/** The archived owner, when it is canonical and fresh; null otherwise (and the
 *  violation is recorded). */
function checkAttemptOwner(
  agentId: unknown,
  path: string,
  history: AttemptHistory,
  violations: CoverageViolation[],
): string | null {
  if (!isSecurityAgentId(agentId)) {
    violations.push(wireViolation(`${path}.agent_id`, "archived attempt requires a canonical lowercase agent ID"));
    return null;
  }
  if (history.owners.has(agentId)) {
    violations.push(wireViolation(`${path}.agent_id`, "assignment owner must be fresh for each attempt"));
    return null;
  }
  return agentId;
}

/** The archived attempt's evidence, held to the same rules as a live unit's. */
function checkAttemptEvidence(attempt: Readonly<Record<string, unknown>>, path: string, violations: CoverageViolation[]): void {
  // One rule per collection, exactly as a live unit's: `checkEntryArray` reports
  // a non-array, an unsafe path and a duplicate once each.
  checkEntryArray(attempt.reviewed_paths, `${path}.reviewed_paths`, violations, "path", { allowEmpty: true });
  validateLocalChecks(attempt.local_checks, `${path}.local_checks`, violations);
  validatePathOwnership(attempt, path, violations);
  checkEntryArray(attempt.result_fingerprints, `${path}.result_fingerprints`, violations, "fingerprint", { allowEmpty: true });
  checkEntryArray(attempt.unresolved, `${path}.unresolved`, violations, "text", { allowEmpty: true });
  if (!isVisibleText(attempt.reassignment_reason)) violations.push(wireViolation(`${path}.reassignment_reason`, "invalid text"));
  validateStateInvariants(attempt, path, violations);
}

/** An archived attempt's checks cite no earlier owner and no artifact an earlier
 *  attempt already spent; its own local artifacts join the spent set. */
function checkSpentArtifacts(
  checks: unknown,
  path: string,
  history: AttemptHistory,
  violations: CoverageViolation[],
): void {
  const attemptChecks: readonly unknown[] = Array.isArray(checks) ? checks : [];
  attemptChecks.forEach((rawCheck, checkIndex) => {
    if (!isWireRecord(rawCheck)) return;
    if (isSecurityAgentId(rawCheck.agent_id) && history.owners.has(rawCheck.agent_id)) {
      violations.push(wireViolation(`${path}.local_checks[${checkIndex}].agent_id`, "prior owner evidence belongs in its earlier attempt"));
    }
    if (typeof rawCheck.artifact === "string" && history.artifacts.has(rawCheck.artifact)) {
      violations.push(wireViolation(`${path}.local_checks[${checkIndex}].artifact`, "an archived artifact cannot be reused"));
    }
    if (rawCheck.method === "local" && typeof rawCheck.artifact === "string") history.artifacts.add(rawCheck.artifact);
  });
}

/** The live attempt starts fresh: its owner and its checks belong to no
 *  archived attempt, and it cites no archived artifact. */
function checkLiveEvidenceIsFresh(
  unit: CoverageUnit,
  base: string,
  history: AttemptHistory,
  violations: CoverageViolation[],
): void {
  if (isSecurityAgentId(unit.agent_id) && history.owners.has(unit.agent_id)) {
    violations.push(wireViolation(`${base}.agent_id`, "the current owner must be fresh after a reassignment"));
  }
  const liveChecks: readonly unknown[] = Array.isArray(unit.local_checks) ? unit.local_checks : [];
  liveChecks.forEach((rawCheck, index) => {
    if (!isWireRecord(rawCheck)) return;
    if (isSecurityAgentId(rawCheck.agent_id) && history.owners.has(rawCheck.agent_id)) {
      violations.push(wireViolation(`${base}.local_checks[${index}].agent_id`, "prior owner evidence must stay archived"));
    }
    if (typeof rawCheck.artifact === "string" && history.artifacts.has(rawCheck.artifact)) {
      violations.push(wireViolation(`${base}.local_checks[${index}].artifact`, "an archived artifact cannot be reused"));
    }
  });
}

// --- Owner identity ---

/** Separates a catalog agent from the attempt it is running. No catalog agent
 *  name contains it (pinned by a test over the catalog), so the split is
 *  unambiguous. */
const OWNER_ATTEMPT_SEPARATOR = "--";
const OWNER_ATTEMPT_SUFFIX = /--([2-9]|[1-9][0-9]+)$/;

/**
 * The catalog agent an owner id names. An owner id is EITHER the catalog agent
 * itself (a unit's first attempt) OR `<catalog-agent>--<n>` for a later one.
 *
 * Two rules meet on `agent_id`: an owner must be fresh after every reassignment,
 * and every owner must resolve to a catalog profile so verifier independence
 * can be proved. One string cannot be both a fresh per-attempt identity and a
 * catalog name — a reassigned unit could be neither re-hunted under the catalog
 * name (not fresh) nor published under another one (unplaceable). The owner id
 * is therefore an attempt identity that CARRIES its catalog agent, and this is
 * the one place that reads it back.
 */
export const catalogAgentOfOwner = (ownerId: string): string => ownerId.replace(OWNER_ATTEMPT_SUFFIX, "");

/** The owner id a unit's next attempt runs under: the catalog agent for the
 *  first attempt, then the lowest `--<n>` no archived attempt has used. Minted
 *  HERE, from the unit's own history, so freshness holds by construction rather
 *  than by a caller remembering which names it already spent. */
const freshOwnerId = (unit: CoverageUnit, catalogAgent: string): string => {
  const spent = new Set(unit.attempts.map((attempt) => attempt.agent_id));
  if (!spent.has(catalogAgent)) return catalogAgent;
  let attempt = unit.attempts.length + 1;
  while (spent.has(`${catalogAgent}${OWNER_ATTEMPT_SEPARATOR}${attempt}`)) attempt += 1;
  return `${catalogAgent}${OWNER_ATTEMPT_SEPARATOR}${attempt}`;
};

// --- Assignment ---

/** `agentId` names a CATALOG agent; the owner id the unit records is minted from
 *  it (see `catalogAgentOfOwner`). */
export type Assignment = Readonly<{ coverageId: string; agentId: string; wave?: number }>;

export type AssignmentError =
  | CoverageError
  | Readonly<{ kind: "unknown-coverage-id"; coverageId: string }>
  | Readonly<{ kind: "unit-not-planned"; coverageId: string; status: CoverageStatus }>
  /** The Agent Catalog cannot place the agent, so the run could not later say
   *  which model profile hunted — refused here, not at publish. */
  | Readonly<{ kind: "unknown-hunter"; coverageId: string; agentId: string }>;

export type AssignedUnit = Readonly<{ coverageId: string; ownerId: string; wave: number }>;

export type AssignmentResult = Readonly<{ ledger: CoverageLedger; assigned: readonly AssignedUnit[] }>;

const replaceUnit = (ledger: CoverageLedger, next: CoverageUnit): CoverageLedger =>
  sortLedger(ledger.map((unit) => (unit.coverage_id === next.coverage_id ? next : unit)));

/**
 * Assign planned units to a wave's hunters. A unit that is not `planned` cannot
 * be assigned — reassignment goes through `mergeCritic`, which archives the
 * prior attempt first.
 *
 * The caller names a catalog agent; the unit records a fresh owner id minted
 * from it, which the result reports so the hunter can be told the id it must
 * settle under.
 *
 * `wave` is optional: an assignment that names none keeps the unit's current
 * wave. The default lives HERE, with the transition it describes, so no caller
 * has to look the unit up to supply it.
 */
export function assignUnits(
  ledger: CoverageLedger,
  assignments: readonly Assignment[],
): DomainResult<AssignmentResult, AssignmentError> {
  let next = ledger;
  const assigned: AssignedUnit[] = [];
  for (const assignment of assignments) {
    const unit = next.find((candidate) => candidate.coverage_id === assignment.coverageId);
    if (unit === undefined) return failure({ kind: "unknown-coverage-id" as const, coverageId: assignment.coverageId });
    if (unit.status !== "planned") {
      return failure({ kind: "unit-not-planned" as const, coverageId: unit.coverage_id, status: unit.status });
    }
    if (!isSecurityAgentId(assignment.agentId) || catalogProfileOfAgent(assignment.agentId) === null) {
      return failure({ kind: "unknown-hunter" as const, coverageId: unit.coverage_id, agentId: assignment.agentId });
    }
    const ownerId = freshOwnerId(unit, assignment.agentId);
    const wave = assignment.wave ?? unit.wave;
    next = replaceUnit(next, { ...unit, status: "in_progress", agent_id: ownerId, wave });
    assigned.push({ coverageId: unit.coverage_id, ownerId, wave });
  }
  const violations = validateLedger(next);
  return violations.length === 0 ? success({ ledger: next, assigned }) : failure(invalid(violations));
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
  const next = replaceUnit(ledger, settled);
  const violations = validateLedger(next);
  if (violations.length > 0) {
    return failure({ kind: "settlement-invalid" as const, coverageId: unit.coverage_id, violations });
  }
  return success(next);
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
    if (!refs.ok) return failure(invalid([wireViolation("missingUnits", refs.error.message)]));
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
    if (unit === undefined) return failure(invalid([wireViolation("reassignIds", `unknown coverage ID ${coverageId}`)]));
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

/** A ledger a transition produced, returned only once `validateLedger` holds
 *  no violation against it. */
const checkedLedger = (next: CoverageLedger): DomainResult<CoverageLedger, CoverageError> => {
  const violations = validateLedger(next);
  return violations.length === 0 ? success(next) : failure(invalid(violations));
};

/** One unit deferred: unassigned, with the reason as its one unresolved fact. */
const asDeferred = (unit: CoverageUnit, reason: string): CoverageUnit =>
  ({ ...unit, status: "deferred" as const, agent_id: null, unresolved: [reason] });

/** Units a budget could not reach become explicitly `deferred`. The reason is
 *  mandatory: a deferred unit without one is a silent gap wearing a label.
 *  Returns a `DomainResult` like every other transition, so a blank `--reason`
 *  is a refusal the caller can render rather than an escaped `TypeError`. */
export function deferPlannedUnits(
  ledger: CoverageLedger,
  reason: string,
): DomainResult<CoverageLedger, CoverageError> {
  if (!isVisibleText(reason)) return failure(invalid([wireViolation("reason", "a deferred unit requires a visible reason")]));
  return checkedLedger(sortLedger(ledger.map((unit) => (unit.status === "planned" ? asDeferred(unit, reason) : unit))));
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
    return failure(invalid([wireViolation("reason", "a deferred unit requires a visible reason")]));
  }
  const unit = ledger.find((candidate) => candidate.coverage_id === coverageId);
  if (unit === undefined) return failure({ kind: "unknown-coverage-id" as const, coverageId });
  if (unit.status !== "planned") {
    return failure({ kind: "unit-not-planned" as const, coverageId, status: unit.status });
  }
  return checkedLedger(sortLedger(ledger.map((candidate) =>
    (candidate.coverage_id === coverageId ? asDeferred(candidate, reason) : candidate))));
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
  if (!Array.isArray(raw)) {
    return failure(invalid([wireViolation("units", "expected a top-level array")]));
  }
  const entries: readonly unknown[] = raw;
  if (entries.length === 0) return failure(invalid([wireViolation("units", "a run must seed at least one unit")]));
  if (entries.length > SECURITY_AUDIT_LIMITS.units) {
    return failure(invalid([wireViolation("units", `exceeds ${SECURITY_AUDIT_LIMITS.units} coverage units`)]));
  }

  const units: CoverageUnit[] = [];
  const violations: CoverageViolation[] = [];
  entries.forEach((entry, index) => {
    const base = `units[${index}]`;
    if (!isWireRecord(entry)) {
      violations.push(wireViolation(base, "expected an object"));
      return;
    }
    const record = entry;
    // Parsed, not cast: a seed whose refs are not a canonical tuple has no
    // identity, so nothing else about it can be checked against a cell.
    const refs = parseCoverageRefs(record.refs);
    if (!refs.ok) {
      violations.push(wireViolation(`${base}.canonical_refs`, refs.error.message));
      return;
    }
    // A present-but-malformed optional field is a violation, never an omission:
    // a dropped `wave` or `lifecycle` would seed a different cell than the one
    // the enumeration wrote, and the document would still parse.
    const local: CoverageViolation[] = [];
    const ordinaryBlock = record.ordinary_attack_class_block;
    if (ordinaryBlock !== undefined && ordinaryBlock !== null && !isVisibleText(ordinaryBlock)) {
      local.push(wireViolation(`${base}.ordinary_attack_class_block`, "expected null or visible text"));
    }
    if (record.status !== undefined && !isCoverageStatus(record.status)) {
      local.push(wireViolation(`${base}.status`, `invalid value ${JSON.stringify(record.status)}`));
    }
    if (record.lifecycle !== undefined && typeof record.lifecycle !== "string") {
      local.push(wireViolation(`${base}.lifecycle`, "expected a string"));
    }
    if (record.wave !== undefined && typeof record.wave !== "number") {
      local.push(wireViolation(`${base}.wave`, "expected a positive integer"));
    }
    // Parsed, not cast: `derivePriorStatus` matches the verdict exhaustively and
    // `.exhaustive()` throws on an unknown tag, so an unchecked `prior` aborted
    // `start` with a pattern-match error instead of a named violation.
    const prior = parsePriorRecordFacts(record.prior);
    if (!prior.ok) local.push(wireViolation(`${base}.${prior.error.path}`, prior.error.message));
    const seeded = seedCoverageUnit({
      refs: refs.value,
      starting_paths: wireStringList(record.starting_paths, `${base}.starting_paths`, local),
      ordinary_attack_class_block: typeof ordinaryBlock === "string" ? ordinaryBlock : null,
      selected_companion_blocks: wireStringList(record.selected_companion_blocks, `${base}.selected_companion_blocks`, local),
      excluded_blocks: parseExcludedBlocks(record.excluded_blocks, `${base}.excluded_blocks`, local),
      prior: prior.ok ? prior.value : null,
      unresolved: wireStringList(record.unresolved, `${base}.unresolved`, local),
      ...(typeof record.lifecycle === "string" ? { lifecycle: record.lifecycle } : {}),
      ...(typeof record.wave === "number" ? { wave: record.wave } : {}),
      ...(isCoverageStatus(record.status) ? { status: record.status } : {}),
    });
    violations.push(...local);
    if (seeded.ok) units.push(seeded.value);
    else violations.push(...seeded.error.violations.map((entry) => wireViolation(`${base}.${entry.path}`, entry.message)));
  });

  const seen = new Map<string, string>();
  for (const unit of units) {
    const key = coverageSemanticKey(unit.canonical_refs);
    if (seen.has(key)) {
      violations.push(wireViolation("units", `duplicate coverage cell ${JSON.stringify(unit.coverage_id)}`));
    } else {
      seen.set(key, unit.coverage_id);
    }
  }
  if (violations.length > 0) return failure(invalid(violations));

  return checkedLedger(sortLedger(units));
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

// --- Field parsers: each one narrows, so a parsed record holds no cast ---

/** A list of strings, or null. */
const parseStringArray = (value: unknown): readonly string[] | null =>
  Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string") ? [...value] : null;

/** A positive integer, or null. */
const parsePositiveInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;

/** A check method, or null. */
const parseCheckMethod = (value: unknown): LocalCheck["method"] | null =>
  value === "source" || value === "local" ? value : null;

/** `null`, a string, or `undefined` for any other value. */
function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

/** Visible prose, or null. */
const visibleText = (value: unknown): string | null => (isVisibleText(value) ? value : null);

/** A canonical agent id, or null. */
const agentId = (value: unknown): string | null => (isSecurityAgentId(value) ? value : null);

/** Every key a record carries that the allowlist does not name. */
const unknownFields = (record: Readonly<Record<string, unknown>>, allowed: readonly string[], base: string): readonly CoverageViolation[] =>
  Object.keys(record).filter((key) => !allowed.includes(key)).map((key) => wireViolation(`${base}.${key}`, "unknown field"));

/** One check as it arrives on the wire, validated field by field. Split from
 *  `parseUnitResults` because a check's fields fail for different reasons than a
 *  unit's, and a violation naming `units[0].checks[1].artifact` is a shorter
 *  path to the defect than one naming the unit again. */
function parseCheck(item: Readonly<Record<string, unknown>>, path: string, violations: CoverageViolation[]): LocalCheck | null {
  const local: CoverageViolation[] = [...unknownFields(item, CHECK_KEYS, path)];
  const owner = agentId(item.agent_id);
  if (owner === null) local.push(wireViolation(`${path}.agent_id`, "expected a catalog agent id"));
  const reviewedPaths = parseStringArray(item.reviewed_paths);
  if (reviewedPaths === null) local.push(wireViolation(`${path}.reviewed_paths`, "expected an array of source paths"));
  const invariant = visibleText(item.invariant);
  if (invariant === null) local.push(wireViolation(`${path}.invariant`, "requires visible prose"));
  const method = parseCheckMethod(item.method);
  if (method === null) local.push(wireViolation(`${path}.method`, "expected source or local"));
  const result = visibleText(item.result);
  if (result === null) local.push(wireViolation(`${path}.result`, "requires visible prose"));
  const artifact = nullableString(item.artifact);
  if (artifact === undefined) local.push(wireViolation(`${path}.artifact`, "expected null or an artifacts path"));
  // A local check is the one that claims something OBSERVED, so it must name
  // the receipt: `local` with `artifact: null` is a claim with no proof.
  if (item.method === "local" && typeof item.artifact !== "string") {
    local.push(wireViolation(`${path}.artifact`, "a local check must name its receipt"));
  }
  violations.push(...local);
  if (local.length > 0 || owner === null || reviewedPaths === null || invariant === null || method === null ||
      result === null || artifact === undefined) {
    return null;
  }
  return { agent_id: owner, reviewed_paths: reviewedPaths, invariant, method, result, artifact };
}

/** A unit result's checks: an array of check objects, each parsed in place. */
function parseChecks(raw: unknown, base: string, violations: CoverageViolation[]): readonly LocalCheck[] {
  if (!Array.isArray(raw)) {
    violations.push(wireViolation(`${base}.checks`, "expected an array of local checks"));
    return [];
  }
  return raw.flatMap((check: unknown, checkIndex) => {
    const path = `${base}.checks[${checkIndex}]`;
    if (!isWireRecord(check)) {
      violations.push(wireViolation(path, "expected an object"));
      return [];
    }
    const parsed = parseCheck(check, path, violations);
    return parsed === null ? [] : [parsed];
  });
}

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

/** One unit result, every field produced by a parser that narrows. */
function parseUnitResult(record: Readonly<Record<string, unknown>>, base: string, violations: CoverageViolation[]): UnitResult | null {
  const local: CoverageViolation[] = [...unknownFields(record, UNIT_RESULT_KEYS, base)];
  const coverageId = visibleText(record.coverageId);
  if (coverageId === null) local.push(wireViolation(`${base}.coverageId`, "expected the canonical coverage ID"));
  const owner = agentId(record.agentId);
  if (owner === null) local.push(wireViolation(`${base}.agentId`, "expected a catalog agent id"));
  const wave = parsePositiveInteger(record.wave);
  if (wave === null) local.push(wireViolation(`${base}.wave`, "expected a positive integer"));
  const status = isTerminalDisposition(record.status) ? record.status : null;
  if (status === null) local.push(wireViolation(`${base}.status`, "expected covered, candidate or blocked"));
  const reviewedPaths = parseStringArray(record.reviewedPaths);
  if (reviewedPaths === null) local.push(wireViolation(`${base}.reviewedPaths`, "expected an array of source paths"));
  const checks = parseChecks(record.checks, base, local);
  const fingerprints = wireStringList(record.fingerprints, `${base}.fingerprints`, local);
  const unresolved = wireStringList(record.unresolved, `${base}.unresolved`, local);
  violations.push(...local);
  if (local.length > 0 || coverageId === null || owner === null || wave === null || status === null || reviewedPaths === null) {
    return null;
  }
  return {
    coverageId,
    agentId: owner,
    wave,
    status,
    reviewedPaths,
    checks,
    ...(record.fingerprints === undefined ? {} : { fingerprints }),
    ...(record.unresolved === undefined ? {} : { unresolved }),
  };
}

/**
 * Parse the settlement payload a hunter's parent submits.
 *
 * `recordUnitResult` checks the SETTLEMENT (owner, wave, resulting ledger); this
 * checks the SHAPE, because a missing `checks` array would otherwise throw on
 * `.map` deep inside the ledger builder rather than naming the field. The two
 * are deliberately separate: the state machine is about one unit's transition,
 * this is about the wire.
 *
 * The optional `fingerprints` and `unresolved` lists are absent or well-formed:
 * a present-but-malformed one is a violation, because dropping a candidate's
 * fingerprints silently turns a filed claim into a settlement with none.
 */
export function parseUnitResults(raw: unknown): DomainResult<readonly UnitResult[], CoverageError> {
  if (!Array.isArray(raw)) {
    return failure(invalid([wireViolation("units", "expected a top-level array")]));
  }
  const violations: CoverageViolation[] = [];
  const results = raw.flatMap((entry: unknown, index) => {
    const base = `units[${index}]`;
    if (!isWireRecord(entry)) {
      violations.push(wireViolation(base, "expected an object"));
      return [];
    }
    const parsed = parseUnitResult(entry, base, violations);
    return parsed === null ? [] : [parsed];
  });
  return violations.length === 0 ? success(results) : failure(invalid(violations));
}

// --- The hunter's envelope ---

/** The hunter result's own identity. It is NOT a reviewer payload: it carries
 *  unit settlements and upstream report records, and a label borrowed from the
 *  reviewer wire claimed a conformance it never had (ADR-0064 D2, amended). */
export const HUNTER_RESULT_KIND = "security-hunter-result";
export const HUNTER_RESULT_SCHEMA_VERSION = 1;

/** The keys a hunter result may carry. Exported so the docs test pins the
 *  hunter doc's block to THIS list. */
export const HUNTER_RESULT_KEYS: readonly string[] = ["schemaVersion", "kind", "units", "findings"];

export type HunterResult = Readonly<{ units: readonly UnitResult[]; findings: readonly SecurityFinding[] }>;

export type HunterResultError = Readonly<{ kind: "invalid-hunter-result"; violations: readonly WireViolation[] }>;

/** Sort a hunter's RAW findings list into fingerprint order before it is parsed,
 *  so a hunter is not refused for its filing order. Same order as
 *  `sortByFingerprint`; entries with no fingerprint compare equal, so the parser
 *  — not a comparator returning NaN — names the actual violation. A non-list
 *  passes through untouched so the parser sees the shape it was sent. */
function sortWireByFingerprint(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  const fingerprintOf = (entry: unknown): string | null =>
    isWireRecord(entry) && typeof entry.fingerprint === "string" ? entry.fingerprint : null;
  return [...raw].sort((left: unknown, right: unknown) => {
    const a = fingerprintOf(left);
    const b = fingerprintOf(right);
    return a === null || b === null ? 0 : compareStrings(a, b);
  });
}

/** The envelope's identity and closed key set, checked before its body: a
 *  document that is not a hunter result is refused for being the wrong document,
 *  naming the kind the run expects. */
function hunterEnvelopeViolations(record: Readonly<Record<string, unknown>>): readonly WireViolation[] {
  const violations = [...unknownFields(record, HUNTER_RESULT_KEYS, "$")];
  if (record.schemaVersion !== HUNTER_RESULT_SCHEMA_VERSION) {
    violations.push(wireViolation("schemaVersion", `expected ${HUNTER_RESULT_SCHEMA_VERSION}`));
  }
  if (record.kind !== HUNTER_RESULT_KIND) {
    violations.push(wireViolation("kind", `expected ${JSON.stringify(HUNTER_RESULT_KIND)}, got ${JSON.stringify(record.kind)} — ` +
      "a hunter returns its own envelope, not a reviewer payload"));
  }
  if (!Array.isArray(record.units)) violations.push(wireViolation("units", "required: an array of unit results (empty when only filing findings)"));
  return violations;
}

/**
 * Parse what `submit` reads: `{ schemaVersion: 1, kind: "security-hunter-result",
 * units: [...], findings?: [...] }`. Strict on purpose — an unknown top-level key
 * is refused rather than ignored, and a payload in another program's envelope is
 * refused by its kind. `findings` are the upstream report records, sorted by
 * fingerprint before the parse (filing order is not a defect; a duplicate still
 * is). A result that carries neither a unit nor a finding says nothing.
 */
export function parseHunterResult(raw: unknown): DomainResult<HunterResult, HunterResultError> {
  const refuse = (violations: readonly WireViolation[]) => failure({ kind: "invalid-hunter-result" as const, violations });
  if (!isWireRecord(raw)) return refuse([wireViolation("$", `expected a ${HUNTER_RESULT_KIND} object`)]);
  const envelope = hunterEnvelopeViolations(raw);
  if (envelope.length > 0) return refuse(envelope);
  const units = parseUnitResults(raw.units);
  const findings = raw.findings === undefined ? success([]) : parseSecurityFindings(sortWireByFingerprint(raw.findings));
  const violations = [
    ...(units.ok ? [] : units.error.violations),
    ...(findings.ok ? [] : findings.error.violations.map((entry) => wireViolation(entry.path.replace(/^\$/, "findings"), entry.message))),
  ];
  if (!units.ok || !findings.ok) return refuse(violations);
  if (units.value.length === 0 && findings.value.length === 0) {
    return refuse([wireViolation("$", "the hunter result carries neither unit results nor findings")]);
  }
  return success({ units: units.value, findings: findings.value });
}

// --- Nonce admission ---

export type ArtifactAdmission = Readonly<{
  artifact: OwnedArtifactPath;
  /** The in-flight units the owner holds — the hunts this receipt may serve. */
  coverageIds: readonly string[];
}>;

export type ArtifactAdmissionRefusal =
  | Readonly<{ kind: "malformed-artifact-path"; artifact: string; message: string }>
  | Readonly<{ kind: "no-in-flight-unit"; artifact: string; owner: string; message: string }>
  | Readonly<{ kind: "archived-artifact"; artifact: string; coverageId: string; message: string }>;

/**
 * May the engine hand out the sandbox nonce for this artifact path? Only for a
 * path under the artifacts root of an owner the ledger currently has hunting:
 * a nonce is a binding a hunter copies into one sandbox run, so it is issued for
 * a live hunt, never for a guessed owner, a settled one, or an artifact an
 * archived attempt already cited (an archived artifact can never be cited again,
 * so its receipt could never count).
 */
export function admitArtifactNonce(
  ledger: CoverageLedger,
  artifact: string,
): DomainResult<ArtifactAdmission, ArtifactAdmissionRefusal> {
  const owned = parseOwnedArtifactPath(artifact);
  if (owned === null) {
    return failure({
      kind: "malformed-artifact-path" as const,
      artifact,
      message: `${JSON.stringify(artifact)} is not an owned artifact path — expected agents/<owner-id>/artifacts/<file>, run-relative`,
    });
  }
  const coverageIds = ledger
    .filter((unit) => unit.status === "in_progress" && unit.agent_id === owned.owner)
    .map((unit) => unit.coverage_id);
  if (coverageIds.length === 0) {
    return failure({
      kind: "no-in-flight-unit" as const,
      artifact,
      owner: owned.owner,
      message: `no in_progress unit is owned by ${owned.owner} — a nonce is issued only to the current owner of a unit in flight (the owner id \`assign\` printed)`,
    });
  }
  const archived = ledger.find((unit) =>
    unit.attempts.some((attempt) => attempt.local_checks.some((check) => check.artifact === artifact)));
  if (archived !== undefined) {
    return failure({
      kind: "archived-artifact" as const,
      artifact,
      coverageId: archived.coverage_id,
      message: `${artifact} is already cited by an archived attempt of ${archived.coverage_id} — an archived artifact cannot be reused; name a new file`,
    });
  }
  return success({ artifact: owned, coverageIds });
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
  if (!isWireRecord(raw)) {
    return failure(invalid([wireViolation("critic", "expected an object")]));
  }
  const record = raw;
  const violations: CoverageViolation[] = [];
  for (const key of Object.keys(record)) {
    if (!CRITIC_KEYS.includes(key)) violations.push(wireViolation(`critic.${key}`, "unknown field"));
  }
  // Identity first: a document with no `kind` is a document the run cannot
  // prove came from the critic, and the critic's verdict is what licenses
  // `publish` to call a run complete.
  if (record.schemaVersion !== 1) violations.push(wireViolation("critic.schemaVersion", "expected 1"));
  if (record.kind !== "security-coverage-critic") {
    violations.push(wireViolation("critic.kind", "expected security-coverage-critic"));
  }
  // Required here; SHAPED by each collection's own parser below. A present
  // non-array is that parser's to report, so it is reported once.
  for (const key of CRITIC_COLLECTIONS) {
    if (record[key] === undefined) violations.push(wireViolation(`critic.${key}`, "required: expected an array"));
  }
  const proposals = parseProposals(record.missingUnits, violations);
  if (record.stop !== undefined && typeof record.stop !== "boolean") {
    violations.push(wireViolation("critic.stop", "expected a boolean"));
  }
  const reassignIds = wireStringList(record.reassignIds, "critic.reassignIds", violations);
  const resolvedPriorLeads = wireStringList(record.resolvedPriorLeads, "critic.resolvedPriorLeads", violations);
  if (violations.length > 0) return failure(invalid(violations));
  return success({
    missingUnits: proposals,
    reassignIds,
    resolvedPriorLeads,
    stop: record.stop === true,
  });
}

/** The critic's proposed units: a cell the ledger is missing, with the evidence
 *  a hunter needs to hunt it. */
function parseProposals(raw: unknown, violations: CoverageViolation[]): readonly CoverageProposal[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    violations.push(wireViolation("critic.missingUnits", "expected an array of proposals"));
    return [];
  }
  return raw.flatMap((entry: unknown, index) => {
    const base = `critic.missingUnits[${index}]`;
    if (!isWireRecord(entry)) {
      violations.push(wireViolation(base, "expected an object"));
      return [];
    }
    violations.push(...unknownFields(entry, CRITIC_PROPOSAL_KEYS, base));
    // Parsed, not cast: a proposal whose refs are not a canonical tuple names no
    // cell, so it is refused here with its own path rather than at the merge.
    const refs = parseCoverageRefs(entry.refs);
    if (!refs.ok) violations.push(wireViolation(`${base}.refs`, refs.error.message));
    const startingPaths = wireStringList(entry.startingPaths, `${base}.startingPaths`, violations);
    const selectedCompanionBlocks = wireStringList(entry.selectedCompanionBlocks, `${base}.selectedCompanionBlocks`, violations);
    const excludedBlocks = parseExcludedBlocks(entry.excludedBlocks, `${base}.excludedBlocks`, violations);
    if (!refs.ok) return [];
    const ordinaryAttackClassBlock = typeof entry.ordinaryAttackClassBlock === "string" ? entry.ordinaryAttackClassBlock : null;
    return [{ refs: refs.value, startingPaths, ordinaryAttackClassBlock, selectedCompanionBlocks, excludedBlocks }];
  });
}

/** The two maps a critic merge is given beside the critic's own document. */
export type CriticMergeMaps = Readonly<{
  /** coverage id → why the critic reassigned it (archived on the attempt). */
  reassignmentReasons: Readonly<Record<string, string>>;
  /** lead fingerprint → the coverage id of the unit that carries it. */
  priorLeadOwners: Readonly<Record<string, string>>;
}>;

/** One `string → string` map, or a named violation. Absent is `{}`; anything
 *  else that is not an object of strings is refused — dropping a malformed map
 *  would archive a reassignment under a generic reason, or make a resolution
 *  unplaceable, while the payload still parsed. */
function parseStringMap(raw: unknown, path: string, violations: CoverageViolation[]): Readonly<Record<string, string>> {
  if (raw === undefined) return {};
  if (!isWireRecord(raw)) {
    violations.push(wireViolation(path, "expected an object of string values"));
    return {};
  }
  const entries = Object.entries(raw);
  const malformed = entries.filter(([, value]) => typeof value !== "string").map(([key]) => key).sort(compareStrings);
  for (const key of malformed) violations.push(wireViolation(`${path}.${key}`, "expected a string"));
  return Object.fromEntries(entries.flatMap(([key, value]) => (typeof value === "string" ? [[key, value]] : [])));
}

/** Parse the merge maps that travel beside a critic document. */
export function parseCriticMergeMaps(
  raw: Readonly<{ reassignmentReasons?: unknown; priorLeadOwners?: unknown }>,
): DomainResult<CriticMergeMaps, CoverageError> {
  const violations: CoverageViolation[] = [];
  const reassignmentReasons = parseStringMap(raw.reassignmentReasons, "reassignmentReasons", violations);
  const priorLeadOwners = parseStringMap(raw.priorLeadOwners, "priorLeadOwners", violations);
  return violations.length === 0 ? success({ reassignmentReasons, priorLeadOwners }) : failure(invalid(violations));
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
 *  entry that quietly never happened. The one exclusion parser: seeds and
 *  critic proposals both read their exclusions here. */
function parseExcludedBlocks(raw: unknown, path: string, violations: CoverageViolation[]): readonly ExcludedBlock[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    violations.push(wireViolation(path, "expected an array of blocks"));
    return [];
  }
  const kept: ExcludedBlock[] = [];
  raw.forEach((item: unknown, index) => {
    if (!isWireRecord(item)) {
      violations.push(wireViolation(`${path}[${index}]`, "expected an object with a block and a reason"));
      return;
    }
    const { block, reason } = item;
    if (!isVisibleText(block) || !isVisibleText(reason)) {
      violations.push(wireViolation(`${path}[${index}]`, "block and reason must be visible text"));
      return;
    }
    kept.push({ block, reason });
  });
  return kept;
}
