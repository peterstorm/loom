#!/usr/bin/env bun
/**
 * Stamp the shared reviewer text (see CONTEXT.md: Wire Contract) into every
 * finding-producing reviewer agent file.
 *
 * The fragments live in references/reviewer-wire/:
 *
 * - `wire-contract.md` is generated from renderReviewerWireContract(), the
 *   executable codec; a schema/rubric change requires an explicit supported
 *   contract revision. This script rewrites the fragment itself, then stamps
 *   it between each reviewer's wire-contract markers.
 * - `bootstrap.md` and `before-you-emit.md` are hand-written and stamped
 *   between their own markers.
 * - `read-coverage.md` is one hand-written bullet, stamped over each
 *   reviewer's one line that opens with the `LOOM_READ_COVERAGE` anchor.
 *
 * The reviewer roster is derived from the Agent Catalog (kind `reviewer`), so
 * a new reviewer is stamped the moment it is catalogued; a reviewer file
 * missing a marker or the anchored bullet fails loudly here and in
 * engine/tests/wire-contract.test.ts.
 *
 * The refutation verifier (kind `review-verifier`) carries one region of its
 * own: the lens sections of references/review-lenses.md, between the
 * review-lenses markers. It is issued its lens by name, so the definitions
 * travel in its own file.
 *
 * Which stamps a kind carries and how they are applied to a file is
 * engine/src/core/wire-contract.ts (`stampsFor`, `applyStamps`). This script
 * is the shell around it: `runStamping` reads the sources and the agent files
 * under a root, writes or reports, and returns what it printed with the exit
 * code; the entry point at the bottom runs it on this package and hands that
 * to the process.
 *
 * Usage: bun scripts/stamp-wire-contract.ts [--check]
 *   --check  exit 1 if any stamped text differs from its source (no writes)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentsOfKind } from "../engine/src/core/agent-catalog-projections";
import { renderReviewerWireContract } from "../engine/src/core/reviewer-protocol";
import { REVIEW_LENSES } from "../engine/src/core/review-panel";
import {
  REVIEW_LENS_REFERENCE,
  REVIEWER_WIRE_FRAGMENTS,
  applyStamps,
  reviewLensSections,
  stampsFor,
  type StampSources,
} from "../engine/src/core/wire-contract";

/** What one run printed, stream by stream, and the exit code it ends with. */
export type StampingRun = Readonly<{ status: 0 | 1; stdout: string; stderr: string }>;

/** One run: the package root it stamps under, whether it only checks, and what it has printed so far. */
type Shell = Readonly<{ root: string; check: boolean; stdout: string[]; stderr: string[] }>;

/** A step that went on, or a file that cannot be stamped at all, which stops the run. */
type Step<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; refusal: string }>;

/** A file as this run found it: already equal to its source, or not. */
type Outcome = "current" | "drifted";

/** The generated fragment itself, rewritten from the executable contract. */
function stampWireContractFragment(shell: Shell, wireContract: string): Outcome {
  const path = join(shell.root, REVIEWER_WIRE_FRAGMENTS, "wire-contract.md");
  if (readFileSync(path, "utf-8") === wireContract) return "current";
  if (shell.check) shell.stderr.push(`${REVIEWER_WIRE_FRAGMENTS}/wire-contract.md differs from the executable reviewer contract\n`);
  else writeFileSync(path, wireContract);
  return "drifted";
}

/** Stamp every catalogued agent of the sources' kind, in catalog order; the first that cannot be stamped stops the run. */
function stampAgents(shell: Shell, sources: StampSources): Step<readonly Outcome[]> {
  const stamps = stampsFor(sources);
  const outcomes: Outcome[] = [];
  for (const agent of agentsOfKind(sources.kind)) {
    const path = join(shell.root, "agents", `${agent}.md`);
    const stamped = applyStamps(readFileSync(path, "utf-8"), stamps);
    if (!stamped.ok) return { ok: false, refusal: `${agent}: ${stamped.error.reason} (expected ${stamped.error.expected})` };
    if (stamped.differing.length === 0) {
      outcomes.push("current");
      continue;
    }
    if (shell.check) {
      for (const difference of stamped.differing) shell.stderr.push(`${agent}: ${difference}\n`);
    } else {
      writeFileSync(path, stamped.value);
      shell.stdout.push(`stamped ${agent}\n`);
    }
    outcomes.push("drifted");
  }
  return { ok: true, value: outcomes };
}

/** Read after the reviewers are stamped: a lens reference that does not
 *  document the selectable lenses stops the run here. */
function verifierSources(root: string): Step<StampSources> {
  const lensSections = reviewLensSections(readFileSync(join(root, REVIEW_LENS_REFERENCE), "utf-8"), REVIEW_LENSES);
  return lensSections.ok
    ? { ok: true, value: { kind: "review-verifier", lensSections: lensSections.value } }
    : { ok: false, refusal: `${REVIEW_LENS_REFERENCE}: ${lensSections.error}` };
}

/** Stamp (or, with `--check`, compare) every stamped file under `root`. */
export function runStamping(root: string, args: readonly string[]): StampingRun {
  const shell: Shell = { root, check: args.includes("--check"), stdout: [], stderr: [] };
  const ended = (status: 0 | 1): StampingRun => ({ status, stdout: shell.stdout.join(""), stderr: shell.stderr.join("") });
  const refused = (refusal: string): StampingRun => {
    shell.stderr.push(`${refusal}\n`);
    return ended(1);
  };
  const readFragment = (name: string): string => readFileSync(join(root, REVIEWER_WIRE_FRAGMENTS, name), "utf-8");

  const wireContract = renderReviewerWireContract();
  const fragment = stampWireContractFragment(shell, wireContract);
  const reviewers = stampAgents(shell, {
    kind: "reviewer",
    bootstrap: readFragment("bootstrap.md"),
    preflight: readFragment("before-you-emit.md"),
    wireContract,
    readCoverage: readFragment("read-coverage.md"),
  });
  if (!reviewers.ok) return refused(reviewers.refusal);
  const verifier = verifierSources(root);
  if (!verifier.ok) return refused(verifier.refusal);
  const verifiers = stampAgents(shell, verifier.value);
  if (!verifiers.ok) return refused(verifiers.refusal);

  const drifted = [fragment, ...reviewers.value, ...verifiers.value].filter((outcome) => outcome === "drifted").length;
  if (shell.check && drifted > 0) return ended(1);
  shell.stdout.push(shell.check ? "stamped regions and read-coverage bullets match their sources\n" : `done (${drifted} file(s) updated)\n`);
  return ended(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const run = runStamping(join(dirname(fileURLToPath(import.meta.url)), ".."), process.argv.slice(2));
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  process.exitCode = run.status;
}
