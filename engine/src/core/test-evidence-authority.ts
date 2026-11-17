/**
 * The TaskGraph's frozen test-evidence mode (loom#198, Cause 1): the
 * protected `test_evidence` field, its parse, the operator's adoption of it,
 * and the policy it yields.
 *
 * Absent: a graph frozen before engine-run evidence. Every TestRun is
 * admitted, exactly as before (`agent-command` policy).
 *
 * Present: `{ kind: "engine-run", manifestDigest, adoptedBy }`. Only an engine
 * run (`helper run-tests`) bound to this graph's repository and to exactly
 * this frozen Verification Manifest is admitted. It is frozen by population
 * when the manifest declares an `affectedRunner` (`adoptedBy: "population"`),
 * or adopted later by the operator for a graph frozen before it existed
 * (`adoptedBy: "operator"`, with the operator's reason). It is a separate
 * field, not a manifest field, so adopting it never changes the manifest
 * digest every suite receipt is stamped with.
 *
 * Pure.
 */

import { parseErr, parseOk, type ParseResult } from "../machine/types";
import type { TaskGraph } from "../types";
import type { FrozenVerificationManifest } from "./verification-manifest";
import type { TestEvidencePolicy } from "./test-evidence-policy";
import { AGENT_COMMAND_EVIDENCE } from "./test-evidence-policy";

import type { EngineRunTestEvidence, TestEvidenceAdoption } from "./test-evidence-mode";

export type { EngineRunTestEvidence, TestEvidenceAdoption } from "./test-evidence-mode";

export const POPULATION_ADOPTION: TestEvidenceAdoption = Object.freeze({ adoptedBy: "population" });

/** The longest operator reason the field records. */
export const MAX_ADOPTION_REASON_LENGTH = 500;

const POPULATION_KEYS = ["adoptedBy", "kind", "manifestDigest"] as const;
const OPERATOR_KEYS = ["adoptedBy", "kind", "manifestDigest", "reason"] as const;

/**
 * Why `manifest` cannot carry engine-run evidence, or null when it can: it
 * must exist and declare the `affectedRunner` the helper runs.
 */
export function engineRunUnavailableReason(manifest: FrozenVerificationManifest | undefined): string | null {
  if (manifest === undefined) return "the TaskGraph froze no Verification Manifest";
  if (manifest.affectedRunner === undefined) return "the frozen Verification Manifest declares no affectedRunner";
  return null;
}

/** The engine-run mode for `manifest` under `adoption`, or why it cannot be. */
export function engineRunTestEvidence(
  manifest: FrozenVerificationManifest | undefined,
  adoption: TestEvidenceAdoption,
): ParseResult<EngineRunTestEvidence> {
  const unavailable = engineRunUnavailableReason(manifest);
  if (unavailable !== null || manifest === undefined) return parseErr(unavailable ?? "no manifest");
  return parseOk(Object.freeze({ kind: "engine-run", manifestDigest: manifest.manifestDigest, ...adoption }));
}

/** An operator's reason as the field records it: one trimmed, non-empty line of bounded length. */
export function parseAdoptionReason(raw: unknown): ParseResult<string> {
  if (typeof raw !== "string" || raw.trim() === "" || raw.trim() !== raw) {
    return parseErr("the adoption reason must be non-blank trimmed text");
  }
  if (/[\r\n]/.test(raw)) return parseErr("the adoption reason must be one line");
  if (raw.length > MAX_ADOPTION_REASON_LENGTH) {
    return parseErr(`the adoption reason is ${raw.length} characters; at most ${MAX_ADOPTION_REASON_LENGTH} are allowed`);
  }
  return parseOk(raw);
}

const hasExactKeys = (record: Record<string, unknown>, keys: readonly string[]): boolean => {
  const present = Object.keys(record).sort();
  return present.length === keys.length && present.every((key, index) => key === keys[index]);
};

/** The adoption a wire record names, with exactly the keys that adoption carries. */
function parseAdoption(record: Record<string, unknown>): ParseResult<TestEvidenceAdoption> {
  if (record.adoptedBy === "population") {
    return hasExactKeys(record, POPULATION_KEYS)
      ? parseOk(POPULATION_ADOPTION)
      : parseErr(`test_evidence adopted by population must carry exactly ${POPULATION_KEYS.join(", ")}`);
  }
  if (record.adoptedBy === "operator") {
    if (!hasExactKeys(record, OPERATOR_KEYS)) {
      return parseErr(`test_evidence adopted by the operator must carry exactly ${OPERATOR_KEYS.join(", ")}`);
    }
    const reason = parseAdoptionReason(record.reason);
    return reason.ok
      ? parseOk(Object.freeze({ adoptedBy: "operator", reason: reason.value }))
      : parseErr(`test_evidence.reason: ${reason.error}`);
  }
  return parseErr("test_evidence.adoptedBy must be population or operator");
}

/**
 * Parse the wire field against the graph's already-parsed frozen manifest.
 * Absent is `undefined`. Present must carry exactly the keys its adoption
 * carries and match the frozen manifest's digest, which must declare an
 * `affectedRunner`: a mode the graph's own manifest cannot run is refused
 * rather than read as legacy.
 */
export function parseTestEvidenceField(
  raw: unknown,
  manifest: FrozenVerificationManifest | undefined,
): ParseResult<EngineRunTestEvidence | undefined> {
  if (raw === undefined) return parseOk(undefined);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return parseErr("test_evidence must be an object when present");
  const record = raw as Record<string, unknown>;
  if (record.kind !== "engine-run") return parseErr("test_evidence.kind must be engine-run");
  const adoption = parseAdoption(record);
  if (!adoption.ok) return adoption;
  const expected = engineRunTestEvidence(manifest, adoption.value);
  if (!expected.ok) return parseErr(`test_evidence: ${expected.error}`);
  if (record.manifestDigest !== expected.value.manifestDigest) {
    return parseErr("test_evidence.manifestDigest does not match the frozen Verification Manifest");
  }
  return parseOk(expected.value);
}

/** What the operator's adoption did: installed the mode, or found it already there. */
export type EngineRunAdoption =
  | Readonly<{ kind: "adopted"; graph: TaskGraph; testEvidence: EngineRunTestEvidence }>
  | Readonly<{ kind: "already-adopted"; testEvidence: EngineRunTestEvidence }>;

/**
 * The operator's adoption of engine-run evidence on a graph populated before
 * it existed. Idempotent: a graph already in the mode is left as it is,
 * whoever adopted it. Refused outside execute, when the frozen manifest has
 * no `affectedRunner` to run, and while any implementation attempt is
 * reserved: an attempt's evidence must be judged under the mode it ran under.
 */
export function adoptEngineRunTestEvidence(graph: TaskGraph, rawReason: string): ParseResult<EngineRunAdoption> {
  if (graph.test_evidence !== undefined) {
    return parseOk(Object.freeze({ kind: "already-adopted", testEvidence: graph.test_evidence }));
  }
  const reason = parseAdoptionReason(rawReason);
  if (!reason.ok) return reason;
  if (graph.current_phase !== "execute") {
    return parseErr(`engine-run test evidence is adopted during execute, and the TaskGraph is in ${graph.current_phase}`);
  }
  const executing = graph.executing_tasks ?? [];
  if (executing.length > 0) {
    return parseErr(`implementation attempts are reserved for ${executing.join(", ")}; adopt once they settle, so each is judged under one mode`);
  }
  const testEvidence = engineRunTestEvidence(graph.verification_manifest, { adoptedBy: "operator", reason: reason.value });
  if (!testEvidence.ok) return testEvidence;
  return parseOk(Object.freeze({
    kind: "adopted",
    graph: Object.freeze({ ...graph, test_evidence: testEvidence.value }),
    testEvidence: testEvidence.value,
  }));
}

/** The admission policy a graph's test-evidence mode yields at `repositoryRoot`. */
export function testEvidencePolicyOf(
  testEvidence: EngineRunTestEvidence | undefined,
  repositoryRoot: string,
): TestEvidencePolicy {
  return testEvidence === undefined
    ? AGENT_COMMAND_EVIDENCE
    : Object.freeze({ kind: "engine-run", repositoryRoot, manifestDigest: testEvidence.manifestDigest });
}
