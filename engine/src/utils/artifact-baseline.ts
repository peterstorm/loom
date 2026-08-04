import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  changedDeclaredArtifacts,
  type ArtifactSnapshot,
  type DeclaredArtifactBaseline,
} from "../core/artifact-baseline";
import { inspectRepositoryPath } from "./repository-path";

function snapshotArtifact(root: string, artifact: string): ArtifactSnapshot {
  const inspected = inspectRepositoryPath(root, artifact, "declared artifact");
  if (!inspected.exists) return Object.freeze({ kind: "missing" });
  const bytes = readFileSync(inspected.absolute);
  return Object.freeze({
    kind: "sha256",
    digest: createHash("sha256").update(bytes).digest("hex"),
  });
}

/** Imperative shell: capture every declared artifact's exact start state. */
export function captureDeclaredArtifactBaseline(
  root: string,
  artifacts: readonly string[],
): readonly DeclaredArtifactBaseline[] {
  return Object.freeze([...new Set(artifacts)].map((artifact) => Object.freeze({
    artifact,
    snapshot: snapshotArtifact(root, artifact),
  })));
}

/** Imperative shell over the pure exact-set comparison. */
export function changedDeclaredArtifactsSince(
  root: string,
  baseline: readonly DeclaredArtifactBaseline[] | undefined,
): readonly string[] {
  // No start snapshot proves no change. This fail-closed value leaves every
  // declared-artifact obligation unsatisfied rather than trusting tool attempts.
  if (baseline === undefined) return Object.freeze([]);
  const current = captureDeclaredArtifactBaseline(root, baseline.map(({ artifact }) => artifact));
  const compared = changedDeclaredArtifacts(baseline, current);
  if (!compared.ok) throw new Error(compared.errors.join("; "));
  return compared.value;
}
