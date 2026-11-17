/**
 * Which TestRun facts a TaskGraph accepts as a Task's test evidence
 * (loom#198, Cause 1). The one admission rule: the I6 judge, implementation
 * settlement and the I6 status view all read it, so the three can never
 * disagree about which runs count.
 *
 * - `agent-command`: a graph frozen before engine-run evidence existed (no
 *   `test_evidence` field). Every TestRun is admitted, exactly as before.
 * - `engine-run`: the graph froze engine-run evidence. Only a TestRun the
 *   engine ran is admitted, and only one bound to THIS graph: the canonical
 *   repository root its settlement resolves and the digest of the
 *   Verification Manifest it froze. An agent's own command still reaches the
 *   ledger for the record, but it is never admitted.
 *
 * Pure.
 */

import type { Evidence } from "../machine/types";

type TestRunFact = Extract<Evidence, { kind: "TestRun" }>;

export type TestEvidencePolicy =
  | Readonly<{ kind: "agent-command" }>
  | Readonly<{ kind: "engine-run"; repositoryRoot: string; manifestDigest: string }>;

export const AGENT_COMMAND_EVIDENCE: TestEvidencePolicy = Object.freeze({ kind: "agent-command" });

/** Whether `policy` admits `run` as a Task's test evidence. */
export function admitsTestRun(policy: TestEvidencePolicy, run: TestRunFact): boolean {
  if (policy.kind === "agent-command") return true;
  return run.origin.kind === "engine-run" &&
    run.origin.repositoryRoot === policy.repositoryRoot &&
    run.origin.manifestDigest === policy.manifestDigest;
}
