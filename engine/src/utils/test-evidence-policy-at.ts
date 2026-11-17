/**
 * A TaskGraph's test-evidence admission policy at a repository root, by real
 * path (loom#198, Cause 1).
 *
 * `helper run-tests` binds its receipt to the canonical (real-path) git root,
 * while the settlement shells resolve the root through their own observers,
 * which do not follow symlinks. Admission compares the two as strings, so the
 * shell resolves the settlement root through every symlink once, here, before
 * the pure policy (`core/test-evidence-authority.ts`) sees it. A root that
 * cannot be resolved is kept as given: it then matches no canonical receipt,
 * so admission fails closed.
 */

import { realpathSync } from "node:fs";
import { testEvidencePolicyOf, type EngineRunTestEvidence } from "../core/test-evidence-authority";
import type { TestEvidencePolicy } from "../core/test-evidence-policy";

function realRoot(repositoryRoot: string): string {
  try {
    return realpathSync.native(repositoryRoot);
  } catch {
    return repositoryRoot;
  }
}

export function testEvidencePolicyAt(
  testEvidence: EngineRunTestEvidence | undefined,
  repositoryRoot: string,
): TestEvidencePolicy {
  // A graph with no engine-run mode admits every run, so its root is never compared.
  return testEvidencePolicyOf(testEvidence, testEvidence === undefined ? repositoryRoot : realRoot(repositoryRoot));
}
