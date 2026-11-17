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
import { hasExactKeys, isRecord, type UnknownRecord } from "./plain-record";
import type { AffectedRunner, FrozenVerificationManifest } from "./verification-manifest";
import type { TestEvidencePolicy } from "./test-evidence-policy";
import { AGENT_COMMAND_EVIDENCE } from "./test-evidence-policy";
import type { EngineRunTestEvidence, TestEvidenceAdoption } from "./test-evidence-mode";

export type { EngineRunTestEvidence, TestEvidenceAdoption } from "./test-evidence-mode";

export const POPULATION_ADOPTION: TestEvidenceAdoption = Object.freeze({ adoptedBy: "population" });

/** The longest operator reason the field records. */
export const MAX_ADOPTION_REASON_LENGTH = 500;

const POPULATION_KEYS = ["adoptedBy", "kind", "manifestDigest"] as const;
const OPERATOR_KEYS = ["adoptedBy", "kind", "manifestDigest", "reason"] as const;

/** A frozen manifest together with the `affectedRunner` it declares: what an engine run needs. */
export type EngineRunnableManifest = Readonly<{ manifest: FrozenVerificationManifest; runner: AffectedRunner }>;

/**
 * The manifest and runner `helper run-tests` runs under, or why there are
 * none: the manifest must exist and declare an `affectedRunner`.
 */
export function engineRunnable(manifest: FrozenVerificationManifest | undefined): ParseResult<EngineRunnableManifest> {
  if (manifest === undefined) return parseErr("the TaskGraph froze no Verification Manifest");
  return manifest.affectedRunner === undefined
    ? parseErr("the frozen Verification Manifest declares no affectedRunner")
    : parseOk(Object.freeze({ manifest, runner: manifest.affectedRunner }));
}

/** The engine-run mode for `manifest` under `adoption`, or why it cannot be. */
export function engineRunTestEvidence(
  manifest: FrozenVerificationManifest | undefined,
  adoption: TestEvidenceAdoption,
): ParseResult<EngineRunTestEvidence> {
  const runnable = engineRunnable(manifest);
  return runnable.ok
    ? parseOk(Object.freeze({ kind: "engine-run", manifestDigest: runnable.value.manifest.manifestDigest, ...adoption }))
    : runnable;
}

/**
 * What a graph's test-evidence mode means, in one sentence population prints:
 * engine runs only, or agent commands admitted and why, so a manifest without
 * an `affectedRunner` never downgrades the evidence silently.
 */
export function testEvidenceModeNotice(
  testEvidence: EngineRunTestEvidence | undefined,
  manifest: FrozenVerificationManifest | undefined,
): string {
  if (testEvidence !== undefined) {
    return "Test evidence: only engine runs (`helper run-tests`) prove I6 and test verdicts in this TaskGraph.";
  }
  const runnable = engineRunnable(manifest);
  const why = runnable.ok ? "this TaskGraph has not adopted engine-run evidence" : runnable.error;
  return `Test evidence: agents' own test commands are admitted, because ${why}. ` +
    "Declare an affectedRunner in the verification manifest to require engine runs (`helper orchestration adopt-engine-run-tests` adopts them on a populated graph).";
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

/** The adoption a wire record names, with exactly the keys that adoption carries. */
function parseAdoption(record: Readonly<UnknownRecord>): ParseResult<TestEvidenceAdoption> {
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
  if (!isRecord(raw) || Array.isArray(raw)) return parseErr("test_evidence must be an object when present");
  if (raw.kind !== "engine-run") return parseErr("test_evidence.kind must be engine-run");
  const adoption = parseAdoption(raw);
  if (!adoption.ok) return adoption;
  const expected = engineRunTestEvidence(manifest, adoption.value);
  if (!expected.ok) return parseErr(`test_evidence: ${expected.error}`);
  if (raw.manifestDigest !== expected.value.manifestDigest) {
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

/**
 * The admission policy a graph's test-evidence mode yields at `repositoryRoot`.
 * The pure constructor: the receipt binds a real-path root, so production
 * callers go through the shell's `testEvidencePolicyAt`
 * (`utils/test-evidence-policy-at.ts`), which resolves the root first.
 */
export function testEvidencePolicyOf(
  testEvidence: EngineRunTestEvidence | undefined,
  repositoryRoot: string,
): TestEvidencePolicy {
  return testEvidence === undefined
    ? AGENT_COMMAND_EVIDENCE
    : Object.freeze({ kind: "engine-run", repositoryRoot, manifestDigest: testEvidence.manifestDigest });
}
