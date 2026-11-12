/**
 * The agent docs are the CONTRACT a hunter, critic and verifier follow. A key
 * they document and the parser does not accept is not a typo — it is an agent
 * whose output the engine refuses, discovered at run time by the operator rather
 * than by the suite.
 *
 * The review found three such documents drifting at once: the hunter documented
 * `unitStatus`/`localChecks`, the critic documented `requeue`/`unprovenClaims`,
 * and the verifier documented `kind: "security-refundation"` with a `refutation`
 * block and no `agent`/`profile`/`wave`. Every one of them would have been
 * refused by the real parser while the suite stayed green.
 *
 * So this test reads the JSON blocks out of the docs and checks them against the
 * parsers in both directions: their key sets against the parsers' own
 * allowlists, and the blocks THEMSELVES — placeholders resolved to valid values
 * — through the real parsers. A fixture written to the doc's shape would prove
 * only that the fixture parses.
 *
 * The blocks are the docs' marked wire examples (`tests/support/doc-wire-examples.ts`),
 * read and resolved by the same code that puts every documented example through
 * its parser; what this file adds is the key-set and identity checks.
 */

import { describe, expect, it } from "vitest";
import { isWireRecord } from "../../src/core/security-audit-contract";
import {
  HUNTER_RESULT_KEYS,
  HUNTER_RESULT_KIND,
  HUNTER_RESULT_SCHEMA_VERSION,
  parseCriticResult,
  parseHunterResult,
  parseUnitResults,
  CHECK_KEYS,
  CRITIC_KEYS,
  CRITIC_PROPOSAL_KEYS,
  UNIT_RESULT_KEYS,
} from "../../src/core/security-coverage";
import {
  parseVerificationResultWire,
  VERIFICATION_RESULT_KEYS,
  VERIFICATION_RESULT_KIND,
  VERIFIER_VOTE_KEYS,
} from "../../src/core/security-verification";
import { isJsonArray } from "../fixtures/json-wire";
import { documentedJson, keysOf, readGovernedDocs, resolvePlaceholders as resolveWith } from "../support/doc-wire-examples";
import type { WireShapeId } from "../support/doc-wire-shape-ids";
import { SECURITY_PLACEHOLDERS } from "../support/doc-wire-shapes";
import { ok } from "./fixtures";

const docs = readGovernedDocs();

/** The one example of `shapeId` an agent doc carries. */
const wireBlock = (agent: string, shapeId: WireShapeId): Readonly<Record<string, unknown>> => {
  const block = documentedJson(docs, `agents/${agent}`, shapeId);
  if (!isWireRecord(block)) throw new Error(`${agent} documents a ${shapeId} that is not an object`);
  return block;
};

/** A documented value with its placeholders resolved by the table the three
 *  security shapes share; `key` is the field the value sits under. */
const resolvePlaceholders = (value: unknown, key = "$"): unknown =>
  resolveWith(value, SECURITY_PLACEHOLDERS, key);

/** The first item of a documented list, or a failure naming the list: a doc
 *  restructured so the list is gone must fail HERE, not turn every key-set
 *  check below into a comparison of two empty lists. */
const firstItem = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  const first: unknown = isJsonArray(value) ? value[0] : undefined;
  if (!isWireRecord(first)) throw new Error(`${label} documents no object item`);
  return first;
};

/** A parse whose only failure is a placeholder the doc cannot satisfy is still a
 *  key-set failure, so the assertions below run on the KEYS the doc names. */
const unknownKeys = (documented: readonly string[], accepted: readonly string[]): readonly string[] =>
  documented.filter((key) => !accepted.includes(key));

describe("the hunter doc documents the wire `submit` parses", () => {
  const block = wireBlock("security-hunter-agent.md", "security-hunter-result");
  const unit = firstItem(block.units, "units");
  const check = firstItem(unit.checks, "units[0].checks");

  it("names no key the unit parser refuses", () => {
    const documented = keysOf(block.units);
    const checks = keysOf(unit.checks);
    // The vacuity guard: a doc that lost its unit or check shape would make the
    // allowlist comparisons below pass on two empty lists.
    expect(documented.length).toBeGreaterThan(0);
    expect(checks.length).toBeGreaterThan(0);
    expect(Object.keys(check)).toEqual(checks);
    // The parser's allowlists are the source of truth — IMPORTED, not re-typed.
    // A hand-copied list would keep passing after the parser's own list changed,
    // which is exactly the drift this test exists to catch.
    expect(unknownKeys(documented, UNIT_RESULT_KEYS)).toEqual([]);
    expect(unknownKeys(checks, CHECK_KEYS)).toEqual([]);
    expect(UNIT_RESULT_KEYS.length).toBeGreaterThan(0);
    expect(CHECK_KEYS.length).toBeGreaterThan(0);
  });

  it("documents every key the parser requires", () => {
    for (const required of ["coverageId", "agentId", "wave", "status", "reviewedPaths", "checks"]) {
      expect(keysOf(block.units), required).toContain(required);
    }
  });

  it("parses the doc's own block, placeholders resolved", () => {
    const units = parseUnitResults(resolvePlaceholders(block.units, "units"));
    expect(units.ok ? [] : units.error.violations).toEqual([]);
    expect(ok(units)).toHaveLength(1);
  });

  it("documents the hunter's OWN envelope, which the submit parser accepts whole", () => {
    // The hunter used to borrow `kind: "standalone-review"`/`schemaVersion: 2`
    // from the reviewer payload, claiming a conformance it never had. The doc's
    // identity is now the parser's, imported rather than re-typed.
    expect(block.kind).toBe(HUNTER_RESULT_KIND);
    expect(block.schemaVersion).toBe(HUNTER_RESULT_SCHEMA_VERSION);
    expect(unknownKeys(keysOf(block), HUNTER_RESULT_KEYS)).toEqual([]);
    const parsed = parseHunterResult(resolvePlaceholders(block));
    expect(parsed.ok ? [] : parsed.error.violations).toEqual([]);
    expect(ok(parsed).units).toHaveLength(1);
  });

  it("refuses the borrowed reviewer label the doc used to teach", () => {
    const resolved = resolvePlaceholders(block);
    if (!isWireRecord(resolved)) throw new Error("the hunter doc's block is not an object");
    const refused = parseHunterResult({ ...resolved, schemaVersion: 2, kind: "standalone-review" });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? [] : refused.error.violations.map((entry) => entry.path).sort()).toEqual(["kind", "schemaVersion"]);
  });
});

describe("the critic doc documents the wire `merge-critic` parses", () => {
  const block = wireBlock("security-critic-agent.md", "security-critic-result");

  it("names no key the critic parser refuses", () => {
    expect(keysOf(block).length).toBeGreaterThan(0);
    expect(keysOf(block.missingUnits).length).toBeGreaterThan(0);
    expect(unknownKeys(keysOf(block), CRITIC_KEYS)).toEqual([]);
    expect(unknownKeys(keysOf(block.missingUnits), CRITIC_PROPOSAL_KEYS)).toEqual([]);
    expect(CRITIC_KEYS.length).toBeGreaterThan(0);
    expect(CRITIC_PROPOSAL_KEYS.length).toBeGreaterThan(0);
  });

  it("parses the doc's own block, placeholders resolved", () => {
    const parsed = parseCriticResult(resolvePlaceholders(block));
    expect(parsed.ok ? [] : parsed.error.violations).toEqual([]);
    expect(ok(parsed).missingUnits).toHaveLength(1);
  });

  it("refuses a proposal carrying a key the doc does not name", () => {
    // The proposal allowlist is load-bearing, not decoration: before it existed
    // `parseProposals` cast `refs` and kept everything else on the floor, so a
    // critic could send `requeue` and the merge silently ignored it.
    const proposal = firstItem(block.missingUnits, "missingUnits");
    const refused = parseCriticResult({
      ...block,
      missingUnits: [{ ...proposal, requeue: true }],
      reassignIds: [],
      resolvedPriorLeads: [],
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? [] : refused.error.violations.map((entry) => entry.path))
      .toContain("critic.missingUnits[0].requeue");
  });

  it("carries the identity the parser requires, and the parser enforces it", () => {
    expect(block.kind).toBe("security-coverage-critic");
    expect(block.schemaVersion).toBe(1);
    const accepted = ok(parseCriticResult({ ...block, missingUnits: [], reassignIds: [], resolvedPriorLeads: [], stop: true }));
    expect(accepted.stop).toBe(true);
    expect(parseCriticResult({ ...block, kind: "coverage-critic" }).ok).toBe(false);
    expect(parseCriticResult({ ...block, schemaVersion: 2 }).ok).toBe(false);
  });
});

describe("the verifier doc documents the result wire the verification program admits", () => {
  const block = wireBlock("security-verifier-agent.md", "security-verification-result");
  const vote = firstItem(block.verdicts, "verdicts");

  it("names no key the result parser refuses", () => {
    expect(keysOf(block).length).toBeGreaterThan(0);
    expect(unknownKeys(keysOf(block), VERIFICATION_RESULT_KEYS)).toEqual([]);
    expect(unknownKeys(Object.keys(vote), VERIFIER_VOTE_KEYS)).toEqual([]);
  });

  it("documents every key and the result kind, and no self-reported identity (ADR-0067 D2)", () => {
    expect(block.kind).toBe(VERIFICATION_RESULT_KIND);
    expect(keysOf(block)).toEqual([...VERIFICATION_RESULT_KEYS]);
    expect(Object.keys(vote)).toEqual([...VERIFIER_VOTE_KEYS]);
    for (const identity of ["agent", "profile", "wave"]) expect(Object.keys(vote), identity).not.toContain(identity);
  });

  it("parses the doc's own block, placeholders resolved", () => {
    const votes = parseVerificationResultWire(resolvePlaceholders(block));
    expect(votes.ok ? [] : votes.error).toEqual([]);
    expect(ok(votes)).toHaveLength(1);
  });
});
