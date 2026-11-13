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
 * is the shell around it: it reads the sources and the agent files, writes or
 * reports, and sets the exit code.
 *
 * Usage: bun scripts/stamp-wire-contract.ts [--check]
 *   --check  exit 1 if any stamped text differs from its source (no writes)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const readFragment = (name: string): string => readFileSync(join(ROOT, REVIEWER_WIRE_FRAGMENTS, name), "utf-8");

/** A file as this run found it: already equal to its source, or not. */
type Outcome = "current" | "drifted";

/** A file that cannot be stamped at all stops the run. */
function refuse(message: string): never {
  console.error(message);
  process.exit(1);
}

/** The generated fragment itself, rewritten from the executable contract. */
function stampWireContractFragment(wireContract: string): Outcome {
  const path = join(ROOT, REVIEWER_WIRE_FRAGMENTS, "wire-contract.md");
  if (readFileSync(path, "utf-8") === wireContract) return "current";
  if (check) console.error(`${REVIEWER_WIRE_FRAGMENTS}/wire-contract.md differs from the executable reviewer contract`);
  else writeFileSync(path, wireContract);
  return "drifted";
}

/** Stamp every catalogued agent of the sources' kind. */
function stampAgents(sources: StampSources): readonly Outcome[] {
  const stamps = stampsFor(sources);
  return agentsOfKind(sources.kind).map((agent): Outcome => {
    const path = join(ROOT, "agents", `${agent}.md`);
    const stamped = applyStamps(readFileSync(path, "utf-8"), stamps);
    if (!stamped.ok) return refuse(`${agent}: ${stamped.error.reason} (expected ${stamped.error.expected})`);
    if (stamped.differing.length === 0) return "current";
    if (check) {
      for (const difference of stamped.differing) console.error(`${agent}: ${difference}`);
    } else {
      writeFileSync(path, stamped.value);
      process.stdout.write(`stamped ${agent}\n`);
    }
    return "drifted";
  });
}

/** Read after the reviewers are stamped: a lens reference that does not
 *  document the selectable lenses stops the run here. */
function verifierSources(): StampSources {
  const lensSections = reviewLensSections(readFileSync(join(ROOT, REVIEW_LENS_REFERENCE), "utf-8"), REVIEW_LENSES);
  return lensSections.ok
    ? { kind: "review-verifier", lensSections: lensSections.value }
    : refuse(`${REVIEW_LENS_REFERENCE}: ${lensSections.error}`);
}

const wireContract = renderReviewerWireContract();
const outcomes: readonly Outcome[] = [
  stampWireContractFragment(wireContract),
  ...stampAgents({
    kind: "reviewer",
    bootstrap: readFragment("bootstrap.md"),
    preflight: readFragment("before-you-emit.md"),
    wireContract,
    readCoverage: readFragment("read-coverage.md"),
  }),
  ...stampAgents(verifierSources()),
];
const drifted = outcomes.filter((outcome) => outcome === "drifted").length;

if (check && drifted > 0) process.exit(1);
process.stdout.write(
  check ? "stamped regions and read-coverage bullets match their sources\n" : `done (${drifted} file(s) updated)\n`,
);
