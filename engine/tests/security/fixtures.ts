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

import {
  canonicalCoverageId,
  parseSecurityRunMetadata,
  type CoverageRefs,
  type SecurityRunMetadata,
} from "../../src/core/security-audit-contract";
import type { DomainResult } from "../../src/core/orchestration-contract/identity";
import type { CoverageSeed } from "../../src/core/security-coverage";
import type { ConfirmedFinding, NeedsValidationFinding, RejectedFinding } from "../../src/core/security-findings";
import type { StackSignals } from "../../src/core/security-lens-select";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Unwrap a `DomainResult` in a test: a refusal here means the fixture is
 *  wrong, not that the case under test is interesting. */
export function ok<T>(result: DomainResult<T, unknown>): T {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
}

/** The catalog hunter. `assignUnits` refuses an agent the Agent Catalog cannot
 *  place, so a placeholder id cannot stand in for it. */
export const HUNTER_AGENT = "security-hunter-agent";

// --- Run ---

/** Run metadata the strict schema accepts. Parsed, not cast: an override that
 *  produces an illegal document (a complete run with a reason) fails HERE, in
 *  the fixture, rather than in whichever assertion happens to read it. */
export function aRunMetadata(overrides: Partial<SecurityRunMetadata> = {}): SecurityRunMetadata {
  return ok(parseSecurityRunMetadata({
    schemaVersion: 1,
    runId: "audit-1",
    repo: "/repo",
    target: "/repo",
    profile: "standard",
    scope: { paths: ["src/api/login.ts"], kind: "tree", baseRef: null, headRef: null },
    scopePaths: ["src/api/login.ts"],
    sourceRef: { commit: "0".repeat(40), worktreeDirty: false },
    budget: null,
    executionPolicy: "sandboxed-source-and-local-only",
    selectedCompanions: [],
    priorRuns: [],
    runStatus: "complete",
    incompleteReason: null,
    published: false,
    ...clone(overrides),
  }));
}

/** Repository facts with every signal off: a test turns on exactly the ones it
 *  is about. */
export function aSignals(overrides: Partial<StackSignals> = {}): StackSignals {
  return {
    languages: [],
    manifests: [],
    servesHttp: false,
    rendersClientSide: false,
    drivesModelsOrTools: false,
    usesQueuesOrRpc: false,
    isolatesTenants: false,
    deploysInfrastructure: false,
    hasNativeMemory: false,
    hasAppOrLocalIpc: false,
    hasReleasePipelines: false,
    hasSharedResourcePressure: false,
    ...clone(overrides),
  };
}

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

/** A seed as it arrives on the wire (`start`'s `units` payload). Typed as the
 *  seed it is, so a test hands it to `seedCoverageUnit` without a cast and to
 *  `parseCoverageSeeds` as the JSON it serialises to. */
export function aSeed(overrides: Partial<CoverageSeed> = {}): CoverageSeed {
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
  };
}

/** `count` seeds in distinct cells, so a test can seed a multi-unit run without
 *  colliding on the canonical coverage identity. */
export function nSeeds(count: number): readonly CoverageSeed[] {
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

/** The catalog profile a security ballot may carry: `refutation` is where the verifier
 *  and the critic sit, `focused-review` is where the hunter sits. These are the
 *  two axes adjudication compares — the run's BUDGET profile (`quick | standard |
 *  deep`) is a different vocabulary and never a ballot's profile. */
export const HUNT_PROFILE = "focused-review" as const;
export const REFUTATION_PROFILE = "refutation" as const;

/** A ballot's binding as a verification run publishes it (ADR-0065 D3): the
 *  minted request it answered and its capture digest. The default request is
 *  a refutation-profile verifier's attempt 1. */
export function aBallotBinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const slotId = `security-verification-slot:${"0".repeat(32)}`;
  return {
    program: "security-verification",
    runId: "run.verify-w2-000000000000",
    requestId: `${slotId}:1`,
    slotId,
    attempt: 1,
    role: "security-verifier-agent",
    profile: REFUTATION_PROFILE,
    captureDigest: "a".repeat(64),
    ...clone(overrides),
  };
}

/** A bound refutation ballot as `verdicts.json` holds it. The default is a
 *  `critical` vote from a verifier minted on a catalog profile that did not
 *  hunt, which is the only shape that confirms a claim — a test that wants a
 *  demotion, a rejection, or a same-profile ballot says so explicitly.
 *  `profile` and `requestId` overrides land in the binding. */
export function aVerdict(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { profile, requestId, binding, ...rest } = clone(overrides);
  return {
    fingerprint: "api/login:sqli-email",
    vote: "critical",
    reason: "The sandbox payload returned the admin row, so the claim survives.",
    missingFact: null,
    wave: 2,
    binding: aBallotBinding({
      ...(profile === undefined ? {} : { profile }),
      ...(requestId === undefined ? {} : { requestId }),
      ...(typeof binding === "object" && binding !== null ? binding : {}),
    }),
    ...rest,
  } as Record<string, unknown>;
}

/** A ballot whose binding names the HUNT profile: the shape INV-S3 refuses to
 *  count — the vote of a model agreeing with itself. */
export function aHunterBallot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return aVerdict({ profile: HUNT_PROFILE, wave: 1, ...clone(overrides) });
}

/** The identity every hunter result carries — spread into a submit payload. */
export const HUNTER_ENVELOPE = Object.freeze({ schemaVersion: 1, kind: "security-hunter-result" });

/** The envelope `submit` reads: the hunter's own kind around its unit results
 *  and filed records. `units` is required (empty when only filing findings). */
export function aHunterResult(
  units: readonly unknown[],
  findings?: readonly unknown[],
): Record<string, unknown> {
  return {
    ...HUNTER_ENVELOPE,
    units: clone(units),
    ...(findings === undefined ? {} : { findings: clone(findings) }),
  };
}

/** A hunter's settlement for one unit (an entry of `aHunterResult`'s `units`),
 *  matching the default seed from `aSeed()`. */
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
