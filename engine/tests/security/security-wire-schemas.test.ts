/**
 * The security wire schemas, as properties over every field they declare.
 *
 *   INV-W1  a well-formed payload parses;
 *   INV-W2  any field of it set to a value of the wrong type is refused, and
 *           the refusal names that field's own path;
 *   INV-W3  any object of it given a key its schema does not declare is
 *           refused, and the refusal names the new key's path.
 *
 * Each shape is exercised through the parser production calls, at the root that
 * parser names its paths from, so the path in a diagnostic is the path a hunter
 * or operator is told. The fields are not listed by hand: every node of the
 * generated payload is a candidate, so a field a schema forgets to close or to
 * type is found without a test naming it.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { wirePath, type WireViolation } from "../../src/core/security-audit-contract";
import { parseVerificationVerdicts } from "../../src/core/security-adjudication";
import { parseSecurityAuditStart } from "../../src/core/security-audit-start";
import {
  assignUnits,
  mergeCritic,
  parseCriticResult,
  parseHunterResult,
  parseLedger,
  recordUnitResult,
  seedCoverageUnit,
  sortLedger,
} from "../../src/core/security-coverage";
import { parseVerificationResultWire, VERIFICATION_RESULT_KIND } from "../../src/core/security-verification";
import { HUNTER_AGENT, HUNTER_ENVELOPE, aConfirmedFinding, aRefs, aSeed, aUnitResult, aVerdict, ok } from "./fixtures";

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type Segment = string | number;

/** One shape under test: how to build a valid payload from generated prose,
 *  and the production parser's violations for any document (`[]` = parsed). */
type WireShape = Readonly<{
  name: string;
  root: string;
  build: (prose: string) => Json;
  violations: (raw: unknown) => readonly WireViolation[];
}>;

const violationsOf = <T>(result: Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: Readonly<{ violations: readonly WireViolation[] }> }>) =>
  result.ok ? [] : result.error.violations;

/** A JSON copy: what a payload is once it has crossed the wire. */
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;

/** A ledger with a planned unit and a reassigned unit whose archived attempt
 *  and live settlement both carry a local check — every unit field, an attempt
 *  and both check methods are present to mutate. */
function aStoredLedger(prose: string): Json {
  const planned = ok(seedCoverageUnit(aSeed({ refs: aRefs({ surface: "http:POST /export" }) })));
  const hunted = ok(seedCoverageUnit(aSeed()));
  const settle = (ledger: ReturnType<typeof sortLedger>, owner: string, wave: number) => {
    const assigned = ok(assignUnits(ledger, [{ coverageId: hunted.coverage_id, agentId: HUNTER_AGENT, wave }]));
    const ownerId = assigned.assigned[0]!.ownerId;
    return ok(recordUnitResult(assigned.ledger, {
      coverageId: hunted.coverage_id,
      agentId: ownerId,
      wave,
      status: "candidate",
      reviewedPaths: ["src/api/login.ts"],
      checks: [{
        agent_id: ownerId,
        reviewed_paths: ["src/api/login.ts"],
        invariant: prose,
        method: "local",
        result: prose,
        artifact: `agents/${ownerId}/artifacts/${owner}.txt`,
      }],
      fingerprints: [`api/login:${owner}`],
      unresolved: [prose],
    }));
  };
  const first = settle(sortLedger([planned, hunted]), "first", 1);
  const reassigned = ok(mergeCritic(first, { missingUnits: [], reassignIds: [hunted.coverage_id], resolvedPriorLeads: [], stop: false },
    { wave: 2, reassignmentReasons: { [hunted.coverage_id]: prose } })).ledger;
  return json(settle(reassigned, "second", 2));
}

const SHAPES: readonly WireShape[] = [
  {
    name: "hunter result",
    root: "",
    build: (prose) => json({
      ...HUNTER_ENVELOPE,
      units: [aUnitResult({ fingerprints: ["api/login:sqli-email"], unresolved: [prose] })],
      findings: [aConfirmedFinding({ title: prose })],
    }),
    violations: (raw) => violationsOf(parseHunterResult(raw)),
  },
  {
    name: "stored ledger",
    root: "$",
    build: aStoredLedger,
    violations: (raw) => violationsOf(parseLedger(raw)),
  },
  {
    name: "recorded ballots",
    root: "verdicts",
    build: (prose) => json([aVerdict({ reason: prose, missingFact: prose })]),
    violations: (raw) => violationsOf(parseVerificationVerdicts(raw)),
  },
  {
    name: "verifier result",
    root: "$",
    build: (prose) => json({
      schemaVersion: 1,
      kind: VERIFICATION_RESULT_KIND,
      verdicts: [{ fingerprint: "api/login:sqli-email", vote: "advisory", reason: prose, missingFact: prose }],
    }),
    violations: (raw) => {
      const parsed = parseVerificationResultWire(raw);
      return parsed.ok ? [] : parsed.error;
    },
  },
  {
    name: "critic result",
    root: "critic",
    build: (prose) => json({
      schemaVersion: 1,
      kind: "security-coverage-critic",
      missingUnits: [{
        refs: aRefs({ surface: "http:DELETE /export" }),
        startingPaths: ["src/api/export.ts"],
        ordinaryAttackClassBlock: prose,
        selectedCompanionBlocks: [prose],
        excludedBlocks: [{ block: "CLIENT-SIDE.md#dom", reason: prose }],
      }],
      reassignIds: ["unit"],
      resolvedPriorLeads: ["lead"],
      stop: false,
    }),
    violations: (raw) => violationsOf(parseCriticResult(raw)),
  },
  {
    name: "start payload",
    root: "",
    build: (prose) => json({
      units: [],
      scope: { kind: "diff", baseRef: "a".repeat(40), headRef: "b".repeat(40) },
      signals: { languages: [prose], servesHttp: true },
    }),
    violations: (raw) => violationsOf(parseSecurityAuditStart(raw)),
  },
];

/** Every node of a document below its root, as segments. */
function nodesOf(value: Json, at: readonly Segment[] = []): readonly (readonly Segment[])[] {
  const children: readonly (readonly [Segment, Json])[] = Array.isArray(value)
    ? value.map((entry, index) => [index, entry] as const)
    : value !== null && typeof value === "object"
      ? Object.entries(value)
      : [];
  return children.flatMap(([key, child]) => [[...at, key], ...nodesOf(child, [...at, key])]);
}

const objectNodesOf = (document: Json): readonly (readonly Segment[])[] =>
  [[], ...nodesOf(document)].filter((path) => {
    const node = valueAt(document, path);
    return node !== null && typeof node === "object" && !Array.isArray(node);
  });

function valueAt(document: Json, path: readonly Segment[]): Json {
  return path.reduce<Json>((node, key) => (node as Record<Segment, Json>)[key]!, document);
}

function withValueAt(document: Json, path: readonly Segment[], value: Json): Json {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  const copy = (Array.isArray(document) ? [...document] : { ...(document as Record<string, Json>) }) as Record<Segment, Json>;
  copy[head!] = withValueAt(copy[head!]!, rest, value);
  return copy as Json;
}

/** A value of a different JSON type than `value`. */
const wrongTypeFor = (value: Json): Json =>
  typeof value === "string" ? 42 : typeof value === "number" ? "42" : typeof value === "boolean" ? "true" : value === null ? 42 : "x";

/** Coverage refs are one value: their parser reads the tuple whole and names
 *  the field that holds it, so a defect inside them is named there. */
const ATOMIC_FIELDS: ReadonlySet<Segment> = new Set(["refs", "canonical_refs"]);
const namedAt = (path: readonly Segment[]): readonly Segment[] => {
  const atomic = path.findIndex((segment) => ATOMIC_FIELDS.has(segment));
  return atomic === -1 ? path : path.slice(0, atomic + 1);
};

const prose = fc.stringMatching(/^[A-Za-z][A-Za-z ]{0,24}[A-Za-z]$/);

describe.each(SHAPES)("the $name schema", (shape) => {
  const describeViolations = (violations: readonly WireViolation[]) => violations.map((entry) => `${entry.path}: ${entry.message}`);

  it("parses every well-formed payload (INV-W1)", () => {
    fc.assert(fc.property(prose, (text) => {
      expect(describeViolations(shape.violations(shape.build(text)))).toEqual([]);
    }), { numRuns: 25 });
  });

  it("names the field when any field holds a value of the wrong type (INV-W2)", () => {
    const nodes = nodesOf(shape.build("A visible sentence"));
    expect(nodes.length).toBeGreaterThan(0);
    fc.assert(fc.property(prose, fc.constantFrom(...nodes), (text, path) => {
      const document = shape.build(text);
      const mutated = withValueAt(document, path, wrongTypeFor(valueAt(document, path)));
      const expected = wirePath(shape.root, namedAt(path));
      expect(shape.violations(mutated).map((entry) => entry.path), `${expected} set to the wrong type`).toContain(expected);
    }), { numRuns: 200 });
  });

  it("names the key when any object gains a key its schema does not declare (INV-W3)", () => {
    const objects = objectNodesOf(shape.build("A visible sentence"));
    fc.assert(fc.property(prose, fc.constantFrom(...objects), (text, path) => {
      const document = shape.build(text);
      const extended = withValueAt(document, path, { ...(valueAt(document, path) as Record<string, Json>), undeclared: true });
      const expected = wirePath(shape.root, namedAt([...path, "undeclared"]));
      expect(shape.violations(extended).map((entry) => entry.path), `${expected} added`).toContain(expected);
    }), { numRuns: 100 });
  });
});
