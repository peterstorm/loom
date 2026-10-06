/**
 * The committed baseline repository the artifact-change suites
 * (`declared-artifact-snapshot.test.ts`, `repository-change-baseline.test.ts`)
 * diff against: one binary leaf under `assets/` and one text leaf, committed
 * as a single baseline revision. Both suites used to carry byte-identical
 * private copies; one definition keeps their baseline the same tree.
 *
 * Git runs through the shared `git-repository` fixture, so the baseline never
 * inherits the developer's global config (signing, hooks, identity).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalTempDir } from "./canonical-temp-dir";
import { git, gitResult, write } from "./git-repository";

export type ArtifactBaselineRepository = Readonly<{ root: string; revision: string }>;

/** A fresh temp repository holding `assets/icon.bin` (bytes 00 ff 01) and
 *  `unchanged.txt` ("same\n") at its one commit. The caller owns cleanup. */
export function artifactBaselineRepository(): ArtifactBaselineRepository {
  const root = canonicalTempDir("loom-artifact-revision-");
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "loom@example.invalid"]);
  git(root, ["config", "user.name", "Loom Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "icon.bin"), Buffer.from([0x00, 0xff, 0x01]));
  write(root, "unchanged.txt", "same\n");
  git(root, ["add", "."]);
  git(root, ["commit", "--quiet", "-m", "baseline"]);
  const revision = gitResult(root, ["rev-parse", "HEAD"]).stdout.trim();
  return Object.freeze({ root, revision });
}
