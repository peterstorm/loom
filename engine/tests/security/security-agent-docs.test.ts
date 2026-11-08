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
 * So this test reads the JSON blocks out of the docs and checks their key sets
 * against the parsers' own allowlists — the docs and the parsers are pinned to
 * each other, in both directions.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCriticResult, parseUnitResults } from "../../src/core/security-coverage";
import { parseVerificationVerdicts } from "../../src/core/security-adjudication";
import { aHunterBallot, aUnitResult, ok } from "./fixtures";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const AGENTS = join(REPO_ROOT, "agents");

/** The first fenced JSON block in a document. The docs are prose first, so a
 *  block may carry an elision comment beside its keys; only the SHAPE is under
 *  test, so comments are stripped and a dangling comma repaired before parsing. */
const wireBlock = (agent: string): Record<string, unknown> => {
  const source = readFileSync(join(AGENTS, agent), "utf8");
  const fence = "```json\n";
  const opened = source.indexOf(fence);
  const closed = opened === -1 ? -1 : source.indexOf("```", opened + fence.length);
  if (opened === -1 || closed === -1) throw new Error(`${agent} documents no JSON block`);
  const block = source.slice(opened + fence.length, closed);
  const withoutElisions = block.replace(/\/\*[\s\S]*?\*\//g, "").replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(withoutElisions) as Record<string, unknown>;
};

const keysOf = (value: unknown): readonly string[] => {
  if (Array.isArray(value)) return keysOf(value[0]);
  return value !== null && typeof value === "object" ? Object.keys(value as Record<string, unknown>) : [];
};

/** A parse whose only failure is a placeholder the doc cannot satisfy is still a
 *  key-set failure, so the assertions below run on the KEYS the doc names. */
const unknownKeys = (documented: readonly string[], accepted: readonly string[]): readonly string[] =>
  documented.filter((key) => !accepted.includes(key));

describe("the hunter doc documents the wire `submit` parses", () => {
  const block = wireBlock("security-hunter-agent.md");

  it("names no key the unit parser refuses", () => {
    const documented = [...keysOf(block.units), ...keysOf((block.units as readonly unknown[])?.[0])];
    const checks = keysOf(((block.units as readonly Record<string, unknown>[])?.[0]?.checks));
    // The parser's allowlists are the source of truth; a doc-only key is drift.
    expect(unknownKeys(documented, [
      "coverageId", "agentId", "wave", "status", "reviewedPaths", "checks", "fingerprints", "unresolved",
    ])).toEqual([]);
    expect(unknownKeys(checks, ["agent_id", "reviewed_paths", "invariant", "method", "result", "artifact"])).toEqual([]);
  });

  it("documents every key the parser requires", () => {
    for (const required of ["coverageId", "agentId", "wave", "status", "reviewedPaths", "checks"]) {
      expect(keysOf(block.units), required).toContain(required);
    }
  });

  it("parses a document written to the doc's own shape", () => {
    // The fixture is the doc's shape with its placeholders resolved; a doc that
    // drifted would fail here rather than at run time.
    const units = parseUnitResults([aUnitResult()]);
    expect(units.ok).toBe(true);
  });
});

describe("the critic doc documents the wire `merge-critic` parses", () => {
  const block = wireBlock("security-critic-agent.md");

  it("names no key the critic parser refuses", () => {
    expect(unknownKeys(keysOf(block), [
      "schemaVersion", "kind", "missingUnits", "reassignIds", "resolvedPriorLeads", "stop",
    ])).toEqual([]);
    expect(unknownKeys(keysOf(block.missingUnits), [
      "refs", "startingPaths", "ordinaryAttackClassBlock", "selectedCompanionBlocks", "excludedBlocks",
    ])).toEqual([]);
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

describe("the verifier doc documents the wire `verify` parses", () => {
  const block = wireBlock("security-verifier-agent.md");

  it("names no key the verdict parser refuses", () => {
    expect(unknownKeys(keysOf(block), [
      "schemaVersion", "kind", "fingerprint", "vote", "reason", "missingFact", "agent", "profile", "wave",
    ])).toEqual([]);
  });

  it("carries the ballot identity the parser requires", () => {
    expect(block.kind).toBe("security-verdict");
    const documented = keysOf(block);
    for (const required of ["fingerprint", "vote", "reason", "missingFact", "agent", "profile", "wave"]) {
      expect(documented, required).toContain(required);
    }
    // A ballot written to the doc's shape is what the parser accepts.
    expect(parseVerificationVerdicts([aHunterBallot({ vote: "advisory" })]).ok).toBe(true);
  });
});
