/**
 * What population needs before a Task may owe red-then-green (loom#198,
 * Cause 3): a frozen manifest that declares an `affectedRunner`.
 *
 * - `i6RunnerManifest`: the engine default's test-file classification plus
 *   the fixture affected runner, the Task mutation check off.
 * - `agentCommandGraph`: a populated graph as one frozen before engine-run
 *   evidence, which admits an agent's own test commands. Suites that pin how
 *   the judge reads agent-command facts use it; engine-run admission has its
 *   own suites.
 */

import { freezeVerificationManifest, type FrozenVerificationManifest } from "../../src/core/verification-manifest";
import { AFFECTED_RUNNER } from "./stop-check-runners";
import { mutationManifest } from "./task-mutation";

export function i6RunnerManifest(): FrozenVerificationManifest {
  return mutationManifest({ testFileSuffixes: undefined, taskMutationCheck: "off" });
}

export function agentCommandGraph<G extends Readonly<{ test_evidence?: unknown }>>(graph: G): G {
  const { test_evidence: _engineRunMode, ...admitsAgentCommands } = graph;
  return admitsAgentCommands as G;
}

/**
 * An operator `.loom/verification-manifest.json` with `document`'s fields,
 * frozen as population freezes it. A schema-2 document also declares the
 * fixture affected runner, which population needs before a Task may owe I6.
 */
export function operatorManifest(document: Readonly<Record<string, unknown>>): FrozenVerificationManifest {
  const frozen = freezeVerificationManifest(new TextEncoder().encode(JSON.stringify({
    kind: "loom-verification-manifest", checks: [], ...document,
    ...(document.schemaVersion === 2 ? { affectedRunner: AFFECTED_RUNNER, taskMutationCheck: "off" } : {}),
  })));
  if (!frozen.ok) throw new Error(frozen.error.errors.join("; "));
  return frozen.value;
}
