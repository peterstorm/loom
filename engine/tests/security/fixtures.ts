/**
 * Builders for the security-audit tests.
 *
 * Every security document is a strict, fail-closed contract: an unknown key, a
 * missing field, or a trace out of order is refused. Hand-rolling literals in
 * ten test files means one schema change lands as ten unrelated failures, and
 * means each test's *actual* subject is buried under boilerplate that must be
 * re-derived every time. These builders produce documents the parsers accept,
 * so a test that overrides one field is testing exactly that field.
 *
 * All builders are pure and return fresh objects, so a test may mutate what it
 * is given without disturbing a sibling.
 */

import { canonicalCoverageId, type CoverageRefs } from "../../src/core/security-audit-contract";
import type { CoverageSeed } from "../../src/core/security-coverage";
import type { ConfirmedFinding, NeedsValidationFinding, RejectedFinding } from "../../src/core/security-findings";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// --- Coverage ---

/** A complete canonical-ref tuple. Two calls give the same cell, so a test
 *  that wants a second unit overrides a coordinate. */
export function aRefs(overrides: Partial<CoverageRefs> = {}): CoverageRefs {
  return {
    surface: "http-ingress",
    boundary: "api-edge",
    subsystem: "auth",
    attack_class: "injection",
    ...clone(overrides),
  };
}

/** A seed as it arrives on the wire (`start`'s `units` payload). */
export function aSeed(overrides: Partial<CoverageSeed> = {}): Record<string, unknown> {
  return {
    refs: aRefs(),
    starting_paths: ["src/api/login.ts"],
    ordinary_attack_class_block: "Injection: untrusted input reaching an interpreter without parameterisation.",
    // A unit always names at least one selected block: a unit with no lens
    // behind it is a unit nobody chose, so the ledger requires the choice.
    selected_companion_blocks: ["WEB-PROTOCOL-AND-AUTH.md#authentication-and-session-handling"],
    excluded_blocks: [],
    prior: null,
    ...clone(overrides),
  } as Record<string, unknown>;
}

/** `count` seeds in distinct cells, so a test can seed a multi-unit run without
 *  colliding on the canonical coverage identity. */
export function nSeeds(count: number): readonly Record<string, unknown>[] {
  return Array.from({ length: count }, (_unused, index) =>
    aSeed({
      refs: aRefs({ subsystem: `subsystem-${index}` }),
      starting_paths: [`src/subsystem-${index}/entry.ts`],
    }));
}

// --- Findings ---

const TRACE: ConfirmedFinding["trace"] = [
  { kind: "entrypoint", file: "src/api/login.ts", line: 12, scope: "HTTP handler", description: "Reads `email` from the request body." },
  { kind: "sink", file: "src/db/users.ts", line: 40, scope: "SQL builder", description: "Interpolates the value into a query string." },
];

const EVIDENCE: ConfirmedFinding["evidence"] = [
  { file: "src/api/login.ts", line: 12, description: "`const { email } = req.body` with no validation." },
  { file: "src/db/users.ts", line: 40, description: "`SELECT * FROM users WHERE email = '${email}'`." },
];

const EXECUTION: ConfirmedFinding["execution"] = {
  attacker_perspective: "An unauthenticated client controls the whole `email` field.",
  payloads: ["' OR 1=1 --"],
  instructions: ["Run the sandbox harness against the target's dev database."],
  observed_result: "The payload returned the whole users table, including the admin row.",
};

const REMEDIATION: ConfirmedFinding["remediation"] = {
  strategy: "Bind the value as a query parameter instead of interpolating it.",
};

const SEVERITY: ConfirmedFinding["severity"] = {
  likelihood: { score: "high", reason: "Only a request body field is required." },
  impact: { score: "high", reason: "The query reads the entire user table." },
  overall_severity: "high",
};

export function aConfirmedFinding(overrides: Partial<ConfirmedFinding> = {}): Record<string, unknown> {
  return {
    verdict: "confirmed",
    fingerprint: "api/login:sqli-email",
    title: "SQL injection through the login `email` field",
    description: "The login handler interpolates an unvalidated `email` into a SQL string.",
    root_cause: "The query is assembled by string concatenation rather than a bound parameter.",
    intended_behavior: "Values are compared as data, so a quote in the input cannot change the query.",
    trace: clone(TRACE),
    evidence: clone(EVIDENCE),
    conditions: [{ kind: "authentication_level", description: "No authentication is required to reach the handler." }],
    execution: clone(EXECUTION),
    remediation: clone(REMEDIATION),
    severity: clone(SEVERITY),
    confidence: { score: "high", reason: "The trace is two steps and the payload was observed." },
    ...clone(overrides),
  } as Record<string, unknown>;
}

export function aNeedsValidationFinding(overrides: Partial<NeedsValidationFinding> = {}): Record<string, unknown> {
  return {
    verdict: "needs_validation",
    fingerprint: "api/export:sqli-filter",
    title: "Possible injection in the export filter",
    description: "The filter is interpolated, but the deployment may bind it upstream.",
    claimed_root_cause: "String interpolation of the caller-supplied filter.",
    trace: [
      { kind: "entrypoint", file: "src/api/login.ts", line: 20, scope: "HTTP handler", description: "Reads the `filter` query parameter." },
      { kind: "sink", file: "src/db/users.ts", line: 55, scope: "Query builder", description: "Concatenates the filter into the query." },
    ],
    evidence: [{ file: "src/db/users.ts", line: 55, description: "`query += ' AND ' + filter`." }],
    blockers: ["The deployment behind the proxy may sanitise the parameter."],
    validation_plan: { local: "Run the harness with the proxy disabled." },
    ...clone(overrides),
  } as Record<string, unknown>;
}

export function aRejectedFinding(overrides: Partial<RejectedFinding> = {}): Record<string, unknown> {
  return {
    verdict: "rejected",
    fingerprint: "api/search:sqli-terms",
    title: "Injection in the search terms",
    description: "The terms look interpolated but are escaped twice.",
    claimed_root_cause: "Interpolation of `terms` into the query.",
    trace: [{ kind: "sink", file: "src/db/users.ts", line: 60, scope: "Query builder", description: "Builds the clause." }],
    evidence: [{ file: "src/db/users.ts", line: 60, description: "`escape(escape(terms))`." }],
    reason: "Double escaping makes the quote inert; the sandbox payload did not change the result set.",
    ...clone(overrides),
  } as Record<string, unknown>;
}

// --- Verdicts ---

/** A refutation ballot. The default is a `critical` vote from a profile other
 *  than the hunt profile (`standard`), which is the only shape that confirms a
 *  claim — a test that wants a demotion or a rejection says so. */
export function aVerdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "security-verdict",
    fingerprint: "api/login:sqli-email",
    vote: "critical",
    reason: "The sandbox payload returned the admin row, so the claim survives.",
    missingFact: null,
    agent: "security-verifier-agent",
    profile: "deep",
    wave: 2,
    ...clone(overrides),
  } as Record<string, unknown>;
}

/** A hunter's settlement payload for one unit (what `submit` reads), matching
 *  the default seed from `aSeed()`. */
export function aUnitResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    coverageId: canonicalCoverageId(aRefs()),
    agentId: "security-hunter-agent",
    wave: 1,
    status: "covered",
    reviewedPaths: ["src/api/login.ts"],
    checks: [{
      agent_id: "security-hunter-agent",
      reviewed_paths: ["src/api/login.ts"],
      invariant: "Every request field reaches the query as a bound parameter.",
      method: "source",
      result: "The `email` field is interpolated into the query string.",
      artifact: null,
    }],
    ...clone(overrides),
  } as Record<string, unknown>;
}
