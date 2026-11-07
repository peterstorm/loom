/**
 * Differential oracle: the TypeScript security parsers and the vendored
 * upstream validators must agree about a document's validity.
 *
 * Why this test exists: the vocabulary (`confirmed | needs_validation |
 * rejected`) is not ours. We ported it, so "we implemented the contract" has to
 * be checkable against the contract's own implementation. A silent divergence
 * would mean a record our program publishes is one upstream would reject (or
 * worse, a malformed record we accept as publishable).
 *
 * Limits deliberately outside this oracle (documented, not forgotten): upstream
 * enforces input byte ceilings, nesting depth and repeated-reference detection
 * before semantic validation. Those are transport guards for a JSON file read
 * from disk; our program validates parsed values it built itself.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseSecurityFindings } from "../../src/core/security-findings";

const require = createRequire(import.meta.url);
const FIXTURES = join(import.meta.dirname, "..", "fixtures", "security", "upstream");

type UpstreamFindingsValidator = {
  validateDocument: (findings: unknown, schema: unknown) => readonly string[];
};

const upstream = require(join(FIXTURES, "validate-findings.cjs")) as UpstreamFindingsValidator;
const schema = JSON.parse(readFileSync(join(FIXTURES, "report-schema.json"), "utf8")) as unknown;

const upstreamValid = (document: unknown): boolean => upstream.validateDocument(document, schema).length === 0;
const oursValid = (document: unknown): boolean => parseSecurityFindings(document).ok;

const traceStep = (kind: string) => ({
  kind,
  file: "src/auth/session.ts",
  line: 42,
  scope: "session issuance",
  description: "the step that matters",
});

const confirmed = () => ({
  verdict: "confirmed",
  fingerprint: "tenant-scope/cache-key-missing",
  title: "Tenant is not part of the cache key",
  description: "One tenant's cached response is served to another.",
  root_cause: "The cache key is derived from the path alone.",
  intended_behavior: "Cache lookups include the tenant identity.",
  trace: [traceStep("entrypoint"), traceStep("propagation"), traceStep("sink")],
  evidence: [{ file: "src/cache/key.ts", line: 12, description: "the key omits tenant" }],
  conditions: [{ kind: "authorization_role", description: "two tenants share a route" }],
  execution: {
    attacker_perspective: "an authenticated member of tenant B",
    payloads: ["GET /reports/2026"],
    instructions: ["seed a row as tenant A", "request the same path as tenant B"],
    observed_result: "tenant B received tenant A's row",
  },
  remediation: {
    strategy: "Include the tenant id in the cache key at the last trusted decision point.",
    code_changes: [{ file_name: "src/cache/key.ts", fixed_code: "return `${tenant}:${path}`" }],
  },
  severity: {
    likelihood: { score: "high", reason: "any authenticated caller can request it" },
    impact: { score: "high", reason: "cross-tenant disclosure of a report" },
    overall_severity: "high",
  },
  confidence: { score: "high", reason: "reproduced locally" },
});

const needsValidation = () => ({
  verdict: "needs_validation",
  fingerprint: "session-cookie/samesite-unset",
  title: "Session cookie may lack SameSite",
  description: "The cookie is written by a layer outside this repository.",
  claimed_root_cause: "Session cookie attributes are set by the edge proxy.",
  trace: [traceStep("entrypoint"), traceStep("sink")],
  evidence: [{ file: "src/auth/session.ts", line: 88, description: "cookie written without attributes" }],
  blockers: ["the proxy configuration is not in the repository"],
  validation_plan: { deployment: "an owner observes the Set-Cookie header on a staging route" },
});

const rejected = () => ({
  verdict: "rejected",
  fingerprint: "path-traversal/archive-entry",
  title: "Archive extraction escapes the target directory",
  description: "Claimed traversal during extraction.",
  claimed_root_cause: "Entry names are concatenated onto the target root.",
  trace: [traceStep("entrypoint"), traceStep("sink")],
  evidence: [{ file: "src/archive/extract.ts", line: 30, description: "join is used after a containment check" }],
  reason: "a preceding containment check rejects every traversal form",
});

const validDocument = () => [rejected(), needsValidation(), confirmed()];

describe("security findings: TS parser vs upstream validator", () => {
  it("accepts the document both implementations accept", () => {
    expect(upstreamValid(validDocument())).toBe(true);
    expect(oursValid(validDocument())).toBe(true);
  });

  it("agrees on hand-written edge cases", () => {
    const edgeCases: readonly { name: string; document: unknown }[] = [
      { name: "empty list", document: [] },
      { name: "not an array", document: {} },
      { name: "single-step trace as sink", document: [{ ...confirmed(), trace: [traceStep("sink")] }] },
      { name: "single-step trace as propagation", document: [{ ...confirmed(), trace: [traceStep("propagation")] }] },
      { name: "trace missing a sink", document: [{ ...confirmed(), trace: [traceStep("entrypoint"), traceStep("propagation")] }] },
      { name: "trace missing an entrypoint", document: [{ ...confirmed(), trace: [traceStep("propagation"), traceStep("sink")] }] },
      { name: "empty trace", document: [{ ...confirmed(), trace: [] }] },
      { name: "empty evidence", document: [{ ...confirmed(), evidence: [] }] },
      { name: "duplicate evidence", document: [{ ...confirmed(), evidence: [confirmed().evidence[0], confirmed().evidence[0]] }] },
      { name: "unsorted fingerprints", document: [rejected(), confirmed()] },
      { name: "duplicate fingerprints", document: [confirmed(), confirmed()] },
      { name: "severity above impact", document: [{ ...confirmed(), severity: { ...confirmed().severity, overall_severity: "critical" } }] },
      { name: "severity equal to impact", document: [{ ...confirmed(), severity: { ...confirmed().severity, overall_severity: "high" } }] },
      { name: "unknown condition kind", document: [{ ...confirmed(), conditions: [{ kind: "vibes", description: "x" }] }] },
      { name: "absolute evidence path", document: [{ ...confirmed(), evidence: [{ file: "/etc/passwd", line: 1, description: "x" }] }] },
      { name: "traversal evidence path", document: [{ ...confirmed(), evidence: [{ file: "src/../etc/passwd", line: 1, description: "x" }] }] },
      { name: "zero line", document: [{ ...confirmed(), trace: [{ ...traceStep("sink"), line: 0 }] }] },
      { name: "fractional line", document: [{ ...confirmed(), trace: [{ ...traceStep("sink"), line: 1.5 }] }] },
      { name: "needs_validation with severity", document: [{ ...needsValidation(), severity: confirmed().severity }] },
      { name: "needs_validation with root_cause", document: [{ ...needsValidation(), root_cause: "x" }] },
      { name: "needs_validation with no plan", document: [{ ...needsValidation(), validation_plan: {} }] },
      { name: "needs_validation local plan only", document: [{ ...needsValidation(), validation_plan: { local: "a bounded fixture" } }] },
      { name: "rejected with blockers", document: [{ ...rejected(), blockers: ["x"] }] },
      { name: "rejected with severity", document: [{ ...rejected(), severity: confirmed().severity }] },
      { name: "confirmed with reason", document: [{ ...confirmed(), reason: "x" }] },
      { name: "confirmed without observed result", document: [{ ...confirmed(), execution: { ...confirmed().execution, observed_result: " " } }] },
      { name: "confirmed with unlisted property", document: [{ ...confirmed(), extra: true }] },
      { name: "unknown verdict", document: [{ ...confirmed(), verdict: "maybe" }] },
      { name: "empty payloads", document: [{ ...confirmed(), execution: { ...confirmed().execution, payloads: [] } }] },
      { name: "empty blockers", document: [{ ...needsValidation(), blockers: [] }] },
      { name: "code_changes traversal path", document: [{ ...confirmed(), remediation: { strategy: "x", code_changes: [{ file_name: "../out.ts", fixed_code: "" }] } }] },
      { name: "zero-width only title", document: [{ ...confirmed(), title: "\u200b" }] },
    ];

    for (const edge of edgeCases) {
      const upstreamAnswer = upstreamValid(edge.document);
      const ourAnswer = oursValid(edge.document);
      expect({ name: edge.name, valid: ourAnswer }).toEqual({ name: edge.name, valid: upstreamAnswer });
    }
  });

  it("agrees under random structural mutation", () => {
    const base = confirmed();
    const keys = Object.keys(base);
    const mutation = fc.oneof(
      fc.record({ kind: fc.constant("delete" as const), key: fc.constantFrom(...keys) }),
      fc.record({ kind: fc.constant("add" as const), key: fc.constantFrom("extra", "severity_notes", "claimed_root_cause") }),
      fc.record({ kind: fc.constant("retitle" as const), value: fc.constantFrom("", " ", "\u200b", "ok", "  padded") }),
      fc.record({ kind: fc.constant("line" as const), value: fc.constantFrom(0, -1, 1.5, 1, 999) }),
    );

    fc.assert(
      fc.property(fc.array(mutation, { minLength: 1, maxLength: 4 }), (mutations) => {
        let candidate: Record<string, unknown> = { ...base };
        for (const change of mutations) {
          if (change.kind === "delete") {
            delete candidate[change.key];
          } else if (change.kind === "add") {
            candidate = { ...candidate, [change.key]: change.key === "claimed_root_cause" ? "x" : 1 };
          } else if (change.kind === "retitle") {
            candidate = { ...candidate, title: change.value };
          } else {
            candidate = { ...candidate, trace: [{ ...traceStep("sink"), line: change.value }] };
          }
        }
        const document = [candidate];
        expect({ mutations, valid: oursValid(document) }).toEqual({ mutations, valid: upstreamValid(document) });
      }),
      { numRuns: 400 },
    );
  });
});
